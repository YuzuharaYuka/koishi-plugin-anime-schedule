import { Context, Logger } from 'koishi'
import { Config as ConfigSchema, normalizeConfig, type Config } from './config'
import { PLUGIN_NAME, getMessages } from './constants'
import type { Digest } from './types'
import { BangumiDataIndex } from './data/bangumi-data'
import { AiringStatusService } from './services/airing'
import { HttpClient } from './services/network'
import { DigestService } from './services/digest'
import { Dispatcher, DispatchGuard } from './services/dispatch'
import { Scheduler } from './services/scheduler'
import { Renderer } from './render/image'
import {
  commandNext,
  commandNight,
  commandOff,
  commandOn,
  commandPush,
  commandSearch,
  commandSeason,
  commandSubAdd,
  commandSubClear,
  commandSubList,
  commandSubRemove,
  commandStatus,
  commandToday,
  commandWeekly,
  type HandlerContext,
} from './handlers'
import { clamp, errorMessage, setupDebug } from './utils'
import { getTimeZoneOffsetMs, resolveTimeZone } from './utils/time'

/** 把时区偏移写成 `+8` / `-3` 这样的短文本，用于日志与图片页眉 */
function formatOffset(timeZone: string): string {
  const hours = getTimeZoneOffsetMs(Date.now(), timeZone) / 3600000
  return hours >= 0 ? `+${hours}` : `${hours}`
}

export const name = PLUGIN_NAME
export const inject = { required: ['database', 'http'] }
export { ConfigSchema as Config }

export const usage = `
番剧更新表与订阅提醒。作品清单来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)，
排期、封面查询 [AniList](https://anilist.co/)，中文标题、封面与评分取自 [Bangumi](https://bgm.tv/)。

在群聊里执行一次 \`anime.on\` 后开始接收定时推送。

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| \`anime.today\` | 今日新番 | 今日更新表，\`-o -1\` 看前一天 |
| \`anime.night\` | 深夜新番 | 今晚 21:00 至次日 06:00 |
| \`anime.week\` | 本周新番 | 今天起七天 |
| \`anime.season [季度]\` | 本季新番 | 本季一览，也可查往季 |
| \`anime.search <关键词>\` | 番剧搜索 | 中日英文标题都能搜 |
| \`anime.sub <ID>\` | 番剧订阅 | 用 Bangumi 条目 ID 订阅 |
| \`anime.remove <ID>\` | 取消订阅 | 也接受订阅列表里的序号 |
| \`anime.list\` | 订阅列表 | 本群订阅的番剧 |
| \`anime.clear\` | 清空订阅 | 清空本群订阅 |
| \`anime.next [天数]\` | 追番计划 | 订阅作品未来排期 |
| \`anime.on\` / \`anime.off\` | 开启推送 / 关闭推送 | 本群定时推送开关 |
| \`anime.status\` | 推送状态 | 本群推送状态 |
| \`anime.push <类型>\` | 立即推送 | 手动发一次推送 |

每日、深夜档与本周只列还在播的作品，本季表收录该季首播的全部 TV / WEB 动画。
卡片上的 \`ID:xxx\` 可直接用于订阅。

若无法获取封面图和评分，请尝试配置 proxy-agent 代理设置。
`

const logger = new Logger(PLUGIN_NAME)

export function apply(ctx: Context, rawConfig: Config) {
  const config = normalizeConfig({
    ...rawConfig,
    timeZone: resolveTimeZone(rawConfig.timeZone, 'Asia/Shanghai' as const),
  })

  ctx.model.extend('anime_channel', {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    guildId: 'string',
    botId: 'string',
    dailyEnabled: 'boolean',
    nightEnabled: 'boolean',
    weeklyEnabled: 'boolean',
    seasonEnabled: 'boolean',
    enabled: 'boolean',
  }, { autoInc: true })

  ctx.model.extend('anime_subscription', {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    tid: 'string',
    title: 'string',
    enabled: 'boolean',
  }, { autoInc: true })

  ctx.model.extend('anime_dispatch', {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    digestKind: 'string',
    dedupeKey: 'string',
    dispatchedAt: 'unsigned',
  }, { autoInc: true })

  // 调试日志开关：打开后会把 API 请求、索引命中、条目匹配等细节打进日志
  setupDebug(config.advanced.debug, logger)
  if (config.advanced.debug) {
    logger.info('[debug] 调试日志已开启，将输出请求 URL、索引命中与条目匹配细节')
  }

  // 出网客户端：Bangumi 接口与图床在国内无法直连，代理在这里统一生效
  const http = new HttpClient(ctx, logger)
  // bangumi-data 索引层：作品清单、中文译名、Bangumi 条目 ID 与周期时刻都来自这里
  const index = new BangumiDataIndex(ctx, logger)
  // AniList 播出状态：判断「这部番是否还在播」的权威依据
  const airing = new AiringStatusService(ctx, logger)
  const digest = new DigestService(ctx, config, logger, index, airing)
  const renderer = new Renderer(ctx, config, logger, http)
  const guard = new DispatchGuard(ctx, logger)

  // 立刻开始载入：读的是本地依赖包，通常几十毫秒；
  // 与插件启动并行，指令和推送在构建前会 await 它，不会出现「索引还没好」的空窗。
  const indexReady = index.ensure()
  const localizeReady = digest.localizer.load()
  const airingReady = airing.ensure()
  // 免去「未处理的 Promise 拒绝」告警，真实错误在 ready 与构建路径里各自上报
  Promise.all([indexReady, localizeReady, airingReady]).catch(() => undefined)

  const dispatcher = new Dispatcher(
    ctx,
    config,
    logger,
    (payload: Digest) => renderer.render({
      kind: payload.kind,
      header: payload.header,
      summary: payload.summary,
      groups: payload.groups,
      seasonLabel: payload.seasonLabel,
      rangeLabel: payload.rangeLabel ?? '',
      footer: getMessages(config.locale).footer,
    }),
  )

  const scheduler = new Scheduler(ctx, config, logger, digest, dispatcher, guard, async () => {
    await digest.localizer.save()
    // 顺手把已完结的订阅清掉；`pruneFinishedSubscriptions` 自己按天去重
    await digest.pruneFinishedSubscriptions().catch((error) => {
      logger.debug('[lifecycle] 清理已完结订阅失败: %s', errorMessage(error))
    })
  })

  const deps: HandlerContext = { ctx, config, logger, digest, renderer }

  registerCommands(ctx, deps)

  ctx.on('ready', async () => {
    try {
      renderer.init()
      await Promise.all([localizeReady, indexReady])
      const anyPushEnabled = config.push.dailyEnabled
        || config.push.nightEnabled
        || config.push.weeklyEnabled
        || config.push.seasonEnabled
        || config.push.updateReminderEnabled
      if (anyPushEnabled) scheduler.start()
      else logger.info('[lifecycle] 所有定时推送均已关闭，调度未启动')

      logger.info(
        '[lifecycle] %s 已启用 (时区: %s，推送形态: %s，本地化: %s，索引: %s)',
        name,
        config.timeZone,
        config.output.format,
        config.localize.enabled ? '开' : '关',
        index.ready ? `${index.size} 部 (${index.source})` : '不可用',
      )
      logger.info('[lifecycle] 时间表内的时刻均按 %s 显示 (UTC%s)', config.timeZone, formatOffset(config.timeZone))
    } catch (error) {
      logger.error('[lifecycle] 插件初始化失败，定时推送将不可用:', error)
      logger.error('[lifecycle] 请检查日志并报告问题到: https://github.com/YuzuharaYuka/koishi-plugin-anime-schedule/issues')
    }
  })

  ctx.on('dispose', async () => {
    scheduler.stop()
    await digest.localizer.save().catch((error) => {
      logger.debug('[lifecycle] 保存本地化缓存失败: %s', errorMessage(error))
    })
  })
}

function registerCommands(ctx: Context, deps: HandlerContext) {
  // 主指令：`anime`，各子指令都带中文别名。
  const cmd = ctx.command('anime', '番剧更新提醒与订阅')
    .alias('番剧', '新番')
    .usage('数据来源: bangumi-data (作品清单与周期时刻) / Bangumi (封面与评分)。')
    .example('anime.today   # 今日新番')
    .example('anime.week    # 本周新番')
    .example('anime.search 転生   # 搜索作品')
    .example('anime.sub 253104   # 按 Bangumi 条目 ID 订阅')
    .example('anime.sub add 1   # 订阅搜索结果第 1 条')

  cmd.action(async ({ session }) => {
    if (!session) return
    await session.execute('anime.today')
  })

  cmd.subcommand('.today', '获取今日番剧更新表')
    .alias('今日新番', '今日番剧', '每日新番')
    .option('offset', '-o <value:number> 日期偏移，-1 为前一天、1 为后一天 (范围 -7 到 7)')
    .usage('按配置的时区计算「今日」，返回当日所有符合条件的播出。')
    .example('anime.today')
    .example('anime.today -o -1   # 查看前一天的更新表')
    .action(async ({ session, options }) => {
      if (!session) return
      await commandToday(deps, session, clamp(options?.offset ?? 0, -7, 7))
    })

  cmd.subcommand('.night', '获取今晚深夜档')
    .alias('深夜新番', '今晚新番', '深夜档')
    .usage('返回今晚 21:00 之后与次日 6:00 之前的场次，凌晨场次按实际播出时刻展示。')
    .example('anime.night')
    .action(async ({ session }) => {
      if (!session) return
      await commandNight(deps, session)
    })

  cmd.subcommand('.week', '获取本周番剧更新表')
    .alias('本周新番', '本周番剧', '一周新番')
    .usage('返回今天起 7 天内按日期分组的播出计划。')
    .example('anime.week')
    .action(async ({ session }) => {
      if (!session) return
      await commandWeekly(deps, session)
    })

  cmd.subcommand('.season [target:string]', '获取新番表（可指定季度）')
    .alias('本季新番', '本季番剧', '新番表')
    .option('offset', '-o <value:number> 相对偏移，-1 为上一季、1 为下一季')
    .usage('列出该季首播的 TV / WEB 动画。不带参数看当季；可指定季度 `2026-07`、`2026年7月`、'
      + '`26夏`，或用 `-o` 查相对偏移（-1 上一季、1 下一季）。')
    .example('anime.season')
    .example('anime.season 2026-07   # 2026 年 7 月新番')
    .example('anime.season 26夏      # 同样查 2026 年 7 月')
    .example('anime.season -o -1     # 上一季')
    .example('anime.season -o 1      # 下一季')
    .action(async ({ session, options }, target) => {
      if (!session) return
      await commandSeason(deps, session, target, options?.offset)
    })

  cmd.subcommand('.search <keyword:text>', '搜索番剧作品')
    .alias('番剧搜索', '搜索新番', '番剧查找')
    .option('limit', '-l <value:number> 返回的结果数量 (1-50，默认 10)')
    .usage('先在本地 bangumi-data 索引里按标题检索（含中文译名）。结果中的序号或 ID 可直接用于 `anime.sub add`。')
    .example('anime.search 転生したら剣でした')
    .example('anime.search 無職転生 -l 5')
    .action(async ({ session, options }, keyword) => {
      if (!session) return
      return commandSearch(deps, session, keyword ?? '', { limit: options?.limit })
    })

  cmd.subcommand('.sub <target:string>', '订阅一部番剧')
    .alias('番剧订阅', '订阅番剧', '订阅添加', '添加订阅')
    .usage('参数是 Bangumi 条目 ID（季表卡片上的 `ID:253104`），也可以是 `anime.search` 结果中的序号。')
    .example('anime.sub 253104   # 按 Bangumi 条目 ID 订阅')
    .example('anime.sub 1        # 订阅搜索结果中的第 1 项')
    .action(async ({ session }, target) => {
      if (!session) return
      return commandSubAdd(deps, session, target ?? '')
    })

  cmd.subcommand('.remove <target:string>', '取消订阅')
    .alias('取消订阅', '订阅取消', '退订')
    .usage('参数是 Bangumi 条目 ID，也可以是 `anime.list` 中的序号。')
    .example('anime.remove 253104')
    .example('anime.remove 1')
    .action(async ({ session }, target) => {
      if (!session) return
      return commandSubRemove(deps, session, target ?? '')
    })

  cmd.subcommand('.clear', '清空本群的全部订阅')
    .alias('清空订阅', '订阅清空')
    .example('anime.clear')
    .action(async ({ session }) => {
      if (!session) return
      return commandSubClear(deps, session)
    })

  cmd.subcommand('.list', '查看本群订阅的番剧')
    .alias('订阅列表', '番剧订阅列表', '追番列表')
    .example('anime.list')
    .action(async ({ session }) => {
      if (!session) return
      return commandSubList(deps, session)
    })

  cmd.subcommand('.next [days:number]', '查看订阅作品未来若干天的播出计划')
    .alias('追番计划', '订阅计划')
    .usage('天数取值范围 1-31，默认为 7。')
    .example('anime.next')
    .example('anime.next 14')
    .action(async ({ session }, days) => {
      if (!session) return
      return commandNext(deps, session, days ? String(days) : undefined)
    })

  cmd.subcommand('.on [kind:string]', '开启本群的定时推送')
    .alias('开启推送', '开启新番推送')
    .usage('不填类型时同时开启每日、深夜档、本周与本季四种推送；类型支持 `daily` `night` `weekly` `season`。')
    .example('anime.on')
    .example('anime.on daily')
    .action(async ({ session }, kind) => {
      if (!session) return
      return commandOn(deps, session, kind)
    })

  cmd.subcommand('.off [kind:string]', '关闭本群的定时推送')
    .alias('关闭推送', '关闭新番推送')
    .usage('不填类型时同时关闭四种推送；关闭后订阅作品的开播提醒仍然有效。')
    .example('anime.off weekly')
    .action(async ({ session }, kind) => {
      if (!session) return
      return commandOff(deps, session, kind)
    })

  cmd.subcommand('.status', '查看本群的推送状态')
    .alias('推送状态', '新番状态')
    .example('anime.status')
    .action(async ({ session }) => {
      if (!session) return
      return commandStatus(deps, session)
    })

  cmd.subcommand('.push <kind:string>', '手动触发一次定时推送的内容')
    .alias('立即推送', '手动推送')
    .usage('类型支持 `daily` `night` `weekly` `season`，内容与定时推送完全一致。')
    .example('anime.push season')
    .action(async ({ session }, kind) => {
      if (!session) return
      return commandPush(deps, session, kind ?? '')
    })
}
