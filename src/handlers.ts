import { Context, h, Logger, Session } from 'koishi'
import { DIGEST_LABELS, RESPONSES, getMessages } from './constants'
import type { Config } from './config'
import type { Digest, DigestItem, DigestKind } from './types'
import type { DigestService } from './services/digest'
import { sendTextDigest } from './services/dispatch'
import type { Renderer } from './render/image'
import { formatDate, getDayStartMs, getLocalWeekday, getSeasonStartMonth, today } from './utils/time'
import { clamp, formatNetworkError, truncate } from './utils'

const KIND_ALIASES: Record<string, DigestKind> = {
  daily: 'daily',
  每日: 'daily',
  today: 'daily',
  night: 'night',
  深夜: 'night',
  今晚: 'night',
  late: 'night',
  weekly: 'weekly',
  本周: 'weekly',
  week: 'weekly',
  season: 'season',
  本季: 'season',
}

/** 指令层依赖集合 */
export interface HandlerContext {
  ctx: Context
  config: Config
  logger: Logger
  digest: DigestService
  renderer: Renderer
}

/** 订阅表里的 tid 形如 `bgm:<Bangumi 条目 ID>` */
const BGM_TID = /^bgm:(\d+)$/

/** 用户直接给出的 Bangumi 条目 ID */
const BGM_ID = /^\d+$/

/** `anime.status` 里显示推送时刻用的星期名，与配置页的下拉选项一致 */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一次检索的结果，供 `anime.sub <序号>` 复用 */
const searchCache = new Map<string, { at: number; items: DigestItem[] }>()
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 500

function cacheKey(session: Session): string {
  return `${platformOf(session)}:${channelOf(session)}:${session.userId}`
}

function readSearchCache(session: Session): DigestItem[] {
  const key = cacheKey(session)
  const cached = searchCache.get(key)
  if (!cached) return []
  if (Date.now() - cached.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return []
  }
  return cached.items
}

function writeSearchCache(session: Session, items: DigestItem[]): void {
  searchCache.set(cacheKey(session), { at: Date.now(), items })
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200)
    for (const [key] of oldest) searchCache.delete(key)
  }
}

/** `Event.channelId` 与 `platform` 在类型上是可选的，这里统一收口 */
function channelOf(session: Session): string {
  return session.channelId ?? ''
}

function platformOf(session: Session): string {
  return session.platform ?? ''
}

// #region 推送内容指令

/** 构建一次推送内容并回复当前会话 */
async function replyDigest(deps: HandlerContext, session: Session, digest: Digest): Promise<void> {
  const { config, renderer, logger } = deps

  if (!digest.groups.length) {
    await session.send([digest.header, digest.summary].filter(Boolean).join('\n'))
    return
  }

  if (config.output.format === 'image') {
    try {
      const buffer = await renderer.render({
        kind: digest.kind,
        header: digest.header,
        summary: digest.summary,
        groups: digest.groups,
        seasonLabel: digest.seasonLabel,
        rangeLabel: digest.rangeLabel ?? '',
        footer: getMessages(config.locale).footer,
      })
      await session.send(h.image(buffer, 'image/jpeg'))
      return
    } catch (error) {
      logger.warn('[command] %s', RESPONSES.renderFailed, error)
    }
  }

  const content = await sendTextDigest(session.bot, session.guildId ?? '', config, digest)
  await session.send(content)
}

/**
 * 取当前频道已订阅的作品，用于让手动触发的图片也带「已订阅」气泡。
 *
 * 定时推送走 `DigestService.build()`，它内部会查订阅；指令层直接调 `buildDaily()`
 * 之类的入口，默认拿不到订阅集合，因此这里统一补上。
 */
function subscribedOf(deps: HandlerContext, session: Session): Promise<Set<string>> {
  return deps.digest.subscribedKeys(platformOf(session), channelOf(session))
}

/** 手动查看当日更新表，`offset` 为相对今天的日期偏移 */
export async function commandToday(deps: HandlerContext, session: Session, offset = 0): Promise<void> {
  await withProgress(deps, session, async () => {
    const subscribed = await subscribedOf(deps, session)
    await replyDigest(deps, session, await deps.digest.buildDaily(offset, subscribed))
  })
}

/** 手动查看今晚深夜档 */
export async function commandNight(deps: HandlerContext, session: Session): Promise<void> {
  await withProgress(deps, session, async () => {
    const subscribed = await subscribedOf(deps, session)
    await replyDigest(deps, session, await deps.digest.buildNight(subscribed))
  })
}

/** 手动查看本周更新表 */
export async function commandWeekly(deps: HandlerContext, session: Session): Promise<void> {
  await withProgress(deps, session, async () => {
    const subscribed = await subscribedOf(deps, session)
    await replyDigest(deps, session, await deps.digest.buildWeekly(subscribed))
  })
}

/**
 * 手动查看新番表。
 *
 * 不带参数看当季；带参数可以查往季或未来的下一季：
 * - `anime.season 2025-04` / `2025年4月` / `25春` → 指定年月
 * - `anime.season -1` → 上一季；`anime.season +1` / `26秋` → 下一季
 *
 * 允许往后看：bangumi-data 通常已经收录下一季的部分作品（先行公布的首播时间）。
 */
export async function commandSeason(
  deps: HandlerContext,
  session: Session,
  target?: string,
  offsetOption?: number,
): Promise<string | void> {
  const { digest } = deps
  // 「相对偏移」用 `-o` 传：`anime.season -1` 里的 `-1` 会被 CLI 当成选项而不是参数，
  // 因此不能指望位置参数收到它。位置参数留给「指定季度」这类写不清是偏移的写法。
  const parsed = parseSeasonTarget(target, digest.timeZone)
  if (parsed.error) return parsed.error
  const offset = offsetOption ?? parsed.offset
  if (offset !== undefined && (offset > SEASON_FUTURE_LIMIT || offset < -40)) {
    return offset > 0
      ? `最多往后查 ${SEASON_FUTURE_LIMIT} 季——更远的季度还没公布。`
      : '可查询的季度范围最多往前 40 季（约 10 年）。'
  }
  await withProgress(deps, session, async () => {
    const subscribed = await subscribedOf(deps, session)
    await replyDigest(deps, session, await digest.buildSeason(offset ?? 0, subscribed))
  })
}

/** 允许往后查询的季度数：bangumi-data 一般已收录下一季，再往后多为空白 */
const SEASON_FUTURE_LIMIT = 2

/** 季度参数的解析结果 */
interface SeasonTarget {
  offset?: number
  error?: string
}

const SEASON_WORDS: Record<string, number> = { 冬: 1, 春: 4, 夏: 7, 秋: 10 }

/**
 * 解析季度参数。
 *
 * 支持 `2025-04`、`2025/4`、`2025年4月`、`25春`（中文季名）以及纯数字偏移
 * （`-1` 上一季、`0` 当季、`+1` 下一季）。不传时返回当季。
 */
function parseSeasonTarget(raw: string | undefined, timeZone: string): SeasonTarget {
  const text = (raw ?? '').trim()
  if (!text) return {}

  // 纯数字：相对当前季度的偏移
  if (/^[+-]?\d+$/.test(text)) return { offset: Number(text) }

  // 年 + 季名，例如 25春 / 2025夏
  const named = /^(\d{2,4})\s*([冬春夏秋])$/.exec(text)
  if (named) {
    const year = normalizeYear(Number(named[1]))
    if (year === null) return { error: `无法识别年份: ${named[1]}` }
    return { offset: seasonOffsetOf(year, SEASON_WORDS[named[2]], timeZone) }
  }

  // 年 + 月，例如 2025-04 / 2025/4 / 2025年4月
  const dated = /^(\d{2,4})\s*[-/年.]\s*(\d{1,2})\s*月?$/.exec(text)
  if (dated) {
    const year = normalizeYear(Number(dated[1]))
    if (year === null) return { error: `无法识别年份: ${dated[1]}` }
    const month = Number(dated[2])
    if (month < 1 || month > 12) return { error: `月份 ${month} 不合法，应为 1-12。` }
    return { offset: seasonOffsetOf(year, getSeasonStartMonth(month), timeZone) }
  }

  return { error: `无法识别的季度: ${text}，可用 \`2025-04\`、\`25春\` 或偏移量（如 \`-1\`）。` }
}

/** `25` → `2025`（两位年份按 2000 年后解释） */
function normalizeYear(value: number): number | null {
  if (value >= 1000) return value
  if (value >= 70 && value <= 99) return 1900 + value
  if (value >= 0 && value <= 69) return 2000 + value
  return null
}

/** 目标季度相对当前季度的偏移 */
function seasonOffsetOf(year: number, startMonth: number, timeZone: string): number {
  const date = today(timeZone)
  const currentYear = Number(date.slice(0, 4))
  const currentStart = getSeasonStartMonth(Number(date.slice(5, 7)))
  const current = currentYear * 4 + (currentStart - 1) / 3
  const target = year * 4 + (startMonth - 1) / 3
  return target - current
}

/** 手动触发一次与定时推送完全一致的内容 */
export async function commandPush(deps: HandlerContext, session: Session, kindText: string): Promise<string | void> {
  const kind = KIND_ALIASES[(kindText ?? '').trim().toLowerCase()]
  if (!kind) return RESPONSES.invalidDigest(kindText ?? '')
  await withProgress(deps, session, async () => {
    await replyDigest(deps, session, await deps.digest.build(kind, platformOf(session), channelOf(session)))
  })
}

/** 检索作品并缓存结果，便于随后订阅 */
export async function commandSearch(
  deps: HandlerContext,
  session: Session,
  keyword: string,
  options: { limit?: number } = {},
): Promise<string | void> {
  const { digest } = deps
  const query = (keyword ?? '').trim()
  if (!query) return '请输入要搜索的关键词。'
  const limit = clamp(options.limit ?? 10, 1, 50)

  await session.send(h('quote', { id: session.messageId }) + `正在搜索 "${query}"...`)

  try {
    // 索引层是本地数据，检索不产生任何网络请求
    const items = await digest.search(query, limit)
    if (!items.length) return RESPONSES.emptySearch(query)
    writeSearchCache(session, items)

    const lines = items.map((item, index) => {
      const when = item.firstYear
        ? `${item.firstYear}-${String(item.firstMonth ?? 1).padStart(2, '0')}`
        : '档期未知'
      const meta = [when, item.type ? item.type.toUpperCase() : ''].filter(Boolean).join(' · ')
      // 显示纯数字 ID，与 `anime.sub <ID>` 的写法一致，便于直接复制
      return `${index + 1}. [ID:${item.bgmId ?? '-'}] ${truncate(item.name, 60)}\n    ${meta}`
    })
    return [
      `找到 ${items.length} 部与 "${query}" 相关的作品，使用 \`anime.sub <ID>\` 或结果序号订阅:`,
      ...lines,
    ].join('\n')
  } catch (error) {
    deps.logger.warn('[command] 搜索失败:', error)
    return `搜索失败。${formatNetworkError(error)}`
  }
}

// #endregion

// #region 订阅管理

/**
 * 查看本群订阅列表。
 *
 * 每条的「状态」按优先级取：
 * 今日有播出 → 显示时刻与集数；否则显示下一次播出的日期；
 * 已经播完 → 明确写出来（调度器会把它自动移除）；都取不到 → 暂无排期。
 */
export async function commandSubList(deps: HandlerContext, session: Session): Promise<string | void> {
  const { config, digest } = deps
  try {
    const rows = await digest.listSubscriptions(platformOf(session), channelOf(session))
    if (!rows.length) return RESPONSES.noSubscription

    const messages = getMessages(config.locale)
    const date = today(digest.timeZone)

    // 一次问 31 天，够覆盖「下次播出」；同时按条目 ID 重新解析名字（订阅时记的会过时）
    const tids = rows.map((row) => row.tid)
    const upcoming = await digest.upcomingAirings(tids, 31)
    // `upcomingAirings` 会把已播完的作品滤掉，因此单独问一次，用来标注「已播完」
    const finished = new Set(await digest.finishedSubscriptionTids(tids))
    const names = new Map<string, string>()
    const nextOf = new Map<string, DigestItem>()
    const todayOf = new Map<string, DigestItem>()
    for (const row of rows) {
      const resolved = await digest.resolveSubscriptionName(row.tid)
      names.set(row.tid, resolved ?? row.title ?? row.tid)
    }
    for (const item of upcoming) {
      if (!nextOf.has(item.tid)) nextOf.set(item.tid, item)
      if (item.date === date && !todayOf.has(item.tid)) todayOf.set(item.tid, item)
    }

    const lines = rows.map((row, index) => {
      const name = names.get(row.tid) ?? row.tid
      const id = /^bgm:(\d+)$/.exec(row.tid)?.[1] ?? row.tid
      const todayItem = todayOf.get(row.tid)
      const nextItem = todayItem ?? nextOf.get(row.tid)
      let status: string
      if (todayItem) {
        status = `今日 ${todayItem.time} · ${messages.episodeUnit(todayItem.episodeCount)}`
      } else if (nextItem) {
        status = `下次 ${nextItem.date} ${nextItem.time} · ${messages.episodeUnit(nextItem.episodeCount)}`
      } else if (finished.has(row.tid)) {
        status = '已播完，稍后自动移除'
      } else {
        status = '暂无排期'
      }
      return `${index + 1}. [ID:${id}] ${truncate(name, 50)}\n    ${status}`
    })
    return [`本群订阅的番剧 (${rows.length} 部):`, ...lines].join('\n')
  } catch (error) {
    deps.logger.warn('[command] 读取订阅列表失败:', error)
    return RESPONSES.databaseFailed
  }
}

/**
 * 订阅一部作品。
 *
 * 参数可以是 Bangumi 条目 ID（`253104`，就是季表卡片上的 `ID:253104`），
 * 也可以是搜索结果里的序号（需要先 `anime.search`）。
 */
export async function commandSubAdd(deps: HandlerContext, session: Session, target: string): Promise<string | void> {
  const { config, digest } = deps
  const raw = (target ?? '').trim()
  if (!raw) return '请提供要订阅的作品 ID 或搜索结果中的序号。'
  const numeric = BGM_ID.test(raw)
  if (!numeric && !BGM_TID.test(raw)) return RESPONSES.invalidTid(raw)

  try {
    const cached = readSearchCache(session)
    // 纯数字优先按「搜索结果序号」解释（先搜索再 `anime.sub 1` 的用法）；
    // 序号越界或没有搜索结果时，就当它是 Bangumi 条目 ID
    const picked = numeric ? cached[Number(raw) - 1] : cached.find((item) => item.tid === `bgm:${raw}`)
    const tid = picked?.tid ?? (numeric ? `bgm:${raw}` : raw)
    if (!BGM_TID.test(tid)) return RESPONSES.invalidTid(raw)

    // 索引层是权威来源：既能给出名称，也能确认这部作品确实存在
    const titleText = await digest.resolveSubscriptionName(tid)
    if (!titleText) return RESPONSES.notFound

    const subscriptions = await digest.listSubscriptions(platformOf(session), channelOf(session))
    if (subscriptions.some((row) => row.tid === tid)) return RESPONSES.alreadySubscribed(titleText)

    const limit = config.subscription.maxPerChannel
    // 上限为 0 表示不限制订阅数量
    if (limit > 0 && subscriptions.length >= limit) return RESPONSES.subscribeLimit(limit)

    await digest.addSubscription(platformOf(session), channelOf(session), tid, titleText)
    return `已订阅 ${titleText}，开播前会推送提醒。\n使用 \`anime.list\` 查看全部订阅。`
  } catch (error) {
    deps.logger.warn('[command] 订阅失败:', error)
    return RESPONSES.subscribeFailed
  }
}

/** 取消订阅，参数可以是订阅列表序号或作品 ID */
export async function commandSubRemove(deps: HandlerContext, session: Session, target: string): Promise<string | void> {
  const { digest } = deps
  const raw = (target ?? '').trim()
  if (!raw) return '请提供要取消订阅的作品 ID 或订阅列表中的序号。'

  try {
    const rows = await digest.listSubscriptions(platformOf(session), channelOf(session))
    if (!rows.length) return RESPONSES.noSubscription

    let picked = rows.find((row) => row.tid === raw)
    if (!picked && /^\d+$/.test(raw)) picked = rows[Number(raw) - 1]
    if (!picked) return RESPONSES.invalidIndex(raw)

    await digest.removeSubscriptions(platformOf(session), channelOf(session), [picked.tid])
    return `已取消订阅 ${picked.title || picked.tid}。`
  } catch (error) {
    deps.logger.warn('[command] 取消订阅失败:', error)
    return RESPONSES.databaseFailed
  }
}

/** 清空本群的全部订阅 */
export async function commandSubClear(deps: HandlerContext, session: Session): Promise<string | void> {
  const { digest } = deps
  try {
    const count = await digest.clearSubscriptions(platformOf(session), channelOf(session))
    if (!count) return RESPONSES.noSubscription
    return `已清空本群的 ${count} 部订阅。`
  } catch (error) {
    deps.logger.warn('[command] 清空订阅失败:', error)
    return RESPONSES.databaseFailed
  }
}

/** 查询订阅作品未来若干天的播出计划 */
export async function commandNext(deps: HandlerContext, session: Session, daysText?: string): Promise<string | void> {
  const { config, digest } = deps
  const days = clamp(Number.parseInt(daysText ?? '7', 10) || 7, 1, 31)
  try {
    const rows = await digest.listSubscriptions(platformOf(session), channelOf(session))
    if (!rows.length) return RESPONSES.noSubscription

    const airings = await digest.upcomingAirings(rows.map((row) => row.tid), days)
    if (!airings.length) return `未来 ${days} 天内订阅的作品没有播出计划。`

    const weekdayNames = getMessages(config.locale).weekdayNames
    const lines: string[] = []
    let currentDate = ''
    for (const item of airings) {
      if (item.date !== currentDate) {
        currentDate = item.date
        const weekday = weekdayNames[getLocalWeekday(getDayStartMs(item.date, digest.timeZone), digest.timeZone)] ?? ''
        lines.push(`【${item.date} ${weekday}】`.trimEnd())
      }
      lines.push(`· ${item.time} ${truncate(item.name, 60)} (${item.episode})`)
    }

    return [`未来 ${days} 天内订阅作品的播出计划:`, ...lines].join('\n')
  } catch (error) {
    deps.logger.warn('[command] 查询订阅计划失败:', error)
    return `查询失败。${formatNetworkError(error)}`
  }
}

// #endregion

// #region 推送开关

export function commandOn(deps: HandlerContext, session: Session, kindText?: string): Promise<string | void> {
  return togglePush(deps, session, kindText, true)
}

export function commandOff(deps: HandlerContext, session: Session, kindText?: string): Promise<string | void> {
  return togglePush(deps, session, kindText, false)
}

async function togglePush(
  deps: HandlerContext,
  session: Session,
  kindText: string | undefined,
  enabled: boolean,
): Promise<string | void> {
  const { config, digest } = deps
  if (!session.guildId) return RESPONSES.needGuild

  const raw = (kindText ?? '').trim().toLowerCase()
  const kind = raw ? KIND_ALIASES[raw] : null
  if (raw && !kind) return RESPONSES.invalidKind(kindText ?? '')

  try {
    // 只在首次为本群建记录时写入默认开关，避免 upsert 把已有的开关重置回默认值
    const existing = await digest.getChannel(platformOf(session), channelOf(session))
    if (!existing) {
      await digest.ensureChannel({
        platform: platformOf(session),
        channelId: channelOf(session),
        guildId: session.guildId,
        botId: session.selfId,
        dailyEnabled: true,
        nightEnabled: true,
        weeklyEnabled: true,
        seasonEnabled: true,
        enabled: true,
      })
    }
    await digest.setKinds(
      platformOf(session),
      channelOf(session),
      kind === 'daily' ? { dailyEnabled: enabled }
        : kind === 'night' ? { nightEnabled: enabled }
          : kind === 'weekly' ? { weeklyEnabled: enabled }
            : kind === 'season' ? { seasonEnabled: enabled }
              : { dailyEnabled: enabled, nightEnabled: enabled, weeklyEnabled: enabled, seasonEnabled: enabled },
    )

    const scope = kind ? DIGEST_LABELS[kind] : '全部定时推送'
    return enabled
      ? `已开启本群的${scope}。\n推送时刻: ${describeTimes(config)} (${config.timeZone})`
      : `已关闭本群的${scope}。`
  } catch (error) {
    deps.logger.warn('[command] 更新推送开关失败:', error)
    return RESPONSES.databaseFailed
  }
}

/** 查看本群的推送状态 */
export async function commandStatus(deps: HandlerContext, session: Session): Promise<string | void> {
  const { ctx, config, digest } = deps
  if (!session.guildId) return RESPONSES.needGuild

  try {
    const channel = await digest.getChannel(platformOf(session), channelOf(session))
    const subscriptions = await digest.listSubscriptions(platformOf(session), channelOf(session))
    const dispatches = await ctx.database.get('anime_dispatch', {
      platform: platformOf(session),
      channelId: channelOf(session),
    })
    const date = today(digest.timeZone)
    const formatText = config.output.format === 'image'
      ? `图片 (${config.output.layout === 'list' ? '卡片列表' : '时间表'})`
      : `纯文本${config.output.useForward ? ' (合并转发)' : ''}`

    return [
      `时区: ${config.timeZone} (当前 ${formatDate(Date.now(), config.timeZone)})`,
      `推送形态: ${formatText}`,
      `本地化: ${digest.localizer.enabled ? `已开启 (${config.localize.titleStyle})` : '已关闭'}`,
      `数据来源: bangumi-data (${digest.index.size} 部) / Bangumi`,
      `推送时刻: ${describeTimes(config)}`,
      `开关状态: 每日 ${channel?.dailyEnabled ? '开' : '关'} / 深夜档 ${channel?.nightEnabled ? '开' : '关'} / 本周 ${channel?.weeklyEnabled ? '开' : '关'} / 本季 ${channel?.seasonEnabled ? '开' : '关'}`,
      `订阅番剧: ${subscriptions.length} 部${config.subscription.maxPerChannel > 0 ? ` (上限 ${config.subscription.maxPerChannel})` : ''}`,
      `开播提醒: ${config.push.updateReminderEnabled ? `开，提前 ${config.push.updateLookaheadMinutes} 分钟` : '关'}`,
      `今日推送记录: ${dispatches.filter((row) => row.digestKind !== 'sub' ? row.dedupeKey.endsWith(date) : true).length} 条`,
    ].join('\n')
  } catch (error) {
    deps.logger.warn('[command] 查询状态失败:', error)
    return RESPONSES.databaseFailed
  }
}

function describeTimes(config: Config): string {
  const weekday = WEEKDAY_NAMES[config.push.weeklyWeekday] ?? '周一'
  const parts: string[] = []
  if (config.push.dailyEnabled) parts.push(`每日 ${config.push.dailyTime}`)
  if (config.push.nightEnabled) parts.push(`深夜档 ${config.push.nightTime}`)
  if (config.push.weeklyEnabled) parts.push(`${weekday} ${config.push.weeklyTime}`)
  if (config.push.seasonEnabled) parts.push(`季度首日 ${config.push.seasonTime}`)
  return parts.join(' / ') || '未启用'
}

// #endregion

/** 耗时操作先回执，再给结果 */
async function withProgress(deps: HandlerContext, session: Session, task: () => Promise<void>): Promise<void> {
  await session.send(h('quote', { id: session.messageId }) + '正在获取番组数据...')
  try {
    await task()
  } catch (error) {
    deps.logger.warn('[command] 获取番组数据失败:', error)
    await session.send(`获取番组数据失败。${formatNetworkError(error)}`)
  }
}
