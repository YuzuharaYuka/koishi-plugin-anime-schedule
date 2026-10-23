import { Context, h, Logger, Session } from 'koishi'
import { DIGEST_LABELS, RESPONSES, getMessages } from './constants'
import type { Config } from './config'
import type { Digest, DigestItem, DigestKind } from './types'
import type { DigestService } from './services/digest'
import { INFO_FETCH_CONCURRENCY, type InfoService, type SubjectInfo } from './services/info'
import { sendTextDigest } from './services/dispatch'
import { toRenderPayload, type Renderer } from './render/image'
import { renderInfoText, renderSearchText } from './render/text'
import { formatDate, getDayStartMs, getLocalWeekday, getSeasonStartMonth, today } from './utils/time'
import { clamp, formatNetworkError, mapLimit, truncate } from './utils'

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
  /** 单部作品详情（`anime.info`），与推送路径无关，只服务交互查询 */
  info: InfoService
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

/**
 * 把索引层面向日志的来源词翻成用户能读的短句：正常情况是"随插件内置"，
 * 出现磁盘缓存或 CDN 镜像才值得看一眼。
 */
function describeIndexSource(source: string): string {
  switch (source) {
    case '本地依赖包': return '随插件内置 (bangumi-data)'
    case '磁盘缓存': return '本地磁盘缓存 (bangumi-data)'
    case 'CDN 镜像': return '已从远程更新 (bangumi-data)'
    default: return source || '未知'
  }
}

function platformOf(session: Session): string {
  return session.platform ?? ''
}

// #region 推送内容指令

/** 构建一次推送内容并回复当前会话 */
async function replyDigest(deps: HandlerContext, session: Session, digest: Digest): Promise<void> {
  const { config, renderer, logger } = deps

  // 内容已经拿到手，评分过期的条目趁出图这段时间在后台补，不占用这次指令的等待
  deps.digest.localizer.kickScoreRefresh()

  if (!digest.groups.length) {
    await session.send([digest.header, digest.summary].filter(Boolean).join('\n'))
    return
  }

  if (config.output.format === 'image') {
    try {
      const buffer = await renderer.render(toRenderPayload(digest, getMessages(config.locale)))
      await session.send(h.image(buffer, 'image/jpeg'))
      return
    } catch (error) {
      logger.warn('[command] 出图失败，改用文本发送:', error)
    }
  }

  const content = await sendTextDigest(session.bot, session.guildId ?? '', config, digest)
  await session.send(content)
}

/** 取当前频道已订阅的作品：指令层直接调 `buildDaily()` 等入口默认不带订阅集合，这里统一补上 */
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
 * 手动查看新番表：不带参数看当季，带参数可查往季或下一季。允许往后看——
 * bangumi-data 通常已收录下一季的部分作品（先行公布的首播时间）。
 */
export async function commandSeason(
  deps: HandlerContext,
  session: Session,
  target?: string,
  offsetOption?: number,
): Promise<string | void> {
  const { digest } = deps
  // 相对偏移必须用 `-o` 传：`anime.season -1` 里的 `-1` 会被 CLI 当成选项，位置参数收不到
  const parsed = parseSeasonTarget(target, digest.timeZone)
  if (parsed.error) return parsed.error
  // `-o` 走 Koishi 的 number 域，`1.5` 也能进来；季度偏移必须是整数，否则会算出「2.5 月新番」
  const offset = offsetOption === undefined ? parsed.offset : Math.trunc(offsetOption)
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

/** 允许往后查询的季度数：再往后多为空白 */
const SEASON_FUTURE_LIMIT = 2

/** 季度参数的解析结果 */
interface SeasonTarget {
  offset?: number
  error?: string
}

const SEASON_WORDS: Record<string, number> = { 冬: 1, 春: 4, 夏: 7, 秋: 10 }

/**
 * 解析季度参数：`2025-04` / `2025/4` / `2025年4月` / `25春` 等年月写法，
 * 或纯数字偏移（`-1` 上一季、`0` 当季、`+1` 下一季）。不传时返回当季。
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

    // 仅输出文本列表（含评分与档期）：十余条结果逐条出详情卡会刷屏且难以分辨，
    // 查看详情用 `anime.info <序号>` 或直接点 ID
    return renderSearchText(items, query, deps.config)
  } catch (error) {
    deps.logger.warn('[command] 搜索失败:', error)
    return `搜索失败。${formatNetworkError(error)}`
  }
}

/**
 * 番剧详情。按目标类型分两条路径：
 *
 * - **唯一一部**：`anime.info 253104`（Bangumi 条目 ID）或 `anime.info 3`（上次搜索结果序号），出单张详情卡。
 * - **关键词**：`anime.info 芙莉莲`，命中各部各出一张卡，多张时走合并转发。
 *   上限由 `output.infoKeywordLimit` 控制，`0` 表示不限制。
 */
export async function commandInfo(
  deps: HandlerContext,
  session: Session,
  target: string,
): Promise<string | h | void> {
  const raw = (target ?? '').trim()
  if (!raw) return '用法: anime.info <Bangumi 条目 ID / 搜索结果序号 / 标题关键词>'

  // ── 唯一一部：条目 ID / 搜索结果序号 ──
  const id = resolveInfoId(deps, session, raw)
  if (id !== null) return sendInfoDetail(deps, session, id)

  // ── 关键词：命中几部就出几张卡，0 表示不限制 ──
  const keyword = raw.replace(/^bgm:/i, '')
  let found: DigestItem[]
  try {
    found = await deps.digest.search(keyword, deps.config.output.infoKeywordLimit)
  } catch (error) {
    deps.logger.warn('[command] 详情检索失败:', error)
    return `查询失败。${formatNetworkError(error)}`
  }
  if (!found.length) return RESPONSES.emptySearch(keyword)

  const picks = found
    .map((item) => ({ bgmId: item.bgmId, aniListId: item.aniListId }))
    .filter((pick): pick is { bgmId: number; aniListId: number | null } => pick.bgmId !== null)
  if (!picks.length) return RESPONSES.notFound

  try {
    const subscribed = await subscribedIds(deps, session)
    // 先用索引里的 AniList ID 一次问完状态（按 id_in 批量，而不是逐部搜标题）
    await deps.info.prefetchAniListStates(
      picks.map((pick) => pick.aniListId).filter((id): id is number => id !== null),
    )
    // 逐部取详情：串行时 20 部要 20 多秒，故按 INFO_FETCH_CONCURRENCY 并发。
    // 结果保持输入顺序，详情卡顺序才与检索相关度一致。
    const nodes = await mapLimit(picks, INFO_FETCH_CONCURRENCY, async ({ bgmId, aniListId }) => {
      const detail = await deps.info.fetch(bgmId, subscribed.has(`bgm:${bgmId}`), aniListId)
      return detail ? renderInfoNode(deps, detail) : null
    })
    const details = nodes.filter((node): node is h => node !== null)
    if (!details.length) return RESPONSES.notFound

    // 单条直接发；多条走合并转发，每条为一个完整详情卡
    if (details.length === 1) return details[0]

    // 与推送同一判据：配置开启**且**适配器声明支持，否则合并转发会被平台拒绝
    const canForward = deps.config.output.useForward && session.bot?.supports('message.forward')
    if (!canForward) {
      // 不能平铺多张卡，只发首张并提示其余数量
      await session.send(details[0])
      return `另有 ${details.length - 1} 部，用 \`anime.search ${keyword}\` 查看全部，或 \`anime.info <ID>\` 单独查看。`
    }
    return h('figure', [...details])
  } catch (error) {
    deps.logger.warn('[command] 查询作品详情失败:', error)
    return `查询失败。${formatNetworkError(error)}`
  }
}

/**
 * 解析出唯一的 Bangumi 条目 ID；非唯一目标返回 `null`，交给关键词检索。
 *
 * 纯数字优先按搜索结果序号解释，序号越界或无搜索结果时才作为条目 ID，与 `anime.sub` 规则一致。
 */
function resolveInfoId(deps: HandlerContext, session: Session, raw: string): number | null {
  const tid = BGM_TID.exec(raw)
  if (tid) return Number(tid[1])
  if (!BGM_ID.test(raw)) return null

  const picked = readSearchCache(session)[Number(raw) - 1]
  if (picked?.bgmId != null) return picked.bgmId
  return Number(raw)
}

/** 查询并发送单部作品的详情卡 */
async function sendInfoDetail(deps: HandlerContext, session: Session, bgmId: number): Promise<string | h> {
  await session.send(h('quote', { id: session.messageId }) + `正在查询 ID:${bgmId}...`)
  try {
    const subscribed = await isSubscribed(deps, session, `bgm:${bgmId}`)
    const detail = await deps.info.fetch(bgmId, subscribed)
    if (!detail) return RESPONSES.notFound
    return (await renderInfoNode(deps, detail)) ?? renderInfoText(detail, deps.config)
  } catch (error) {
    deps.logger.warn('[command] 查询作品详情失败:', error)
    return `查询失败。${formatNetworkError(error)}`
  }
}

/** 出图，失败时退回文本；两者都不可用时返回 `null` */
async function renderInfoNode(deps: HandlerContext, detail: SubjectInfo): Promise<h | null> {
  if (deps.config.output.format !== 'image') return h.text(renderInfoText(detail, deps.config))
  try {
    const buffer = await deps.renderer.renderInfo(detail)
    return h.image(buffer, 'image/jpeg')
  } catch (error) {
    // 与推送表同样兜底：出图失败退回文本
    deps.logger.warn('[command] 详情出图失败，改用文本:', error)
    return h.text(renderInfoText(detail, deps.config))
  }
}

/** 本群已订阅的 tid 集合，用于在详情卡上标「已订阅」 */
async function subscribedIds(deps: HandlerContext, session: Session): Promise<Set<string>> {
  const rows = await deps.digest.listSubscriptions(platformOf(session), channelOf(session))
  return new Set(rows.map((row) => row.tid))
}

/** 该作品是否已被本群订阅 */
async function isSubscribed(deps: HandlerContext, session: Session, tid: string): Promise<boolean> {
  const rows = await deps.digest.listSubscriptions(platformOf(session), channelOf(session))
  return rows.some((row) => row.tid === tid)
}

// #endregion

// #region 订阅管理

/**
 * 查看本群订阅列表。每条的「状态」按优先级取：今日有播出 → 时刻与集数；
 * 否则下一次播出的日期；已播完 → 明确写出（调度器会自动移除）；都取不到 → 暂无排期。
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
    // `upcomingAirings` 会滤掉已播完的作品，故单独查询一次用于标注「已播完」
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
 * 订阅一部作品：参数可以是 Bangumi 条目 ID（`253104`，即季表卡片上的 `ID:253104`），
 * 也可以是 `anime.search` 结果里的序号。
 */
export async function commandSubAdd(deps: HandlerContext, session: Session, target: string): Promise<string | void> {
  const { config, digest } = deps
  const raw = (target ?? '').trim()
  if (!raw) return '请提供要订阅的作品 ID 或搜索结果中的序号。'
  const numeric = BGM_ID.test(raw)
  if (!numeric && !BGM_TID.test(raw)) return RESPONSES.invalidTid(raw)

  try {
    const cached = readSearchCache(session)
    // 纯数字优先按「搜索结果序号」解释（先搜索再 `anime.sub 1`）；序号越界或无搜索结果时当作 Bangumi 条目 ID
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

/**
 * 取消订阅。参数可以是订阅列表序号、Bangumi 条目 ID，或 `bgm:253104` 形式的 tid。
 *
 * 纯数字**先按序号、再按条目 ID** 解释：序号在范围内就取该行，否则当作条目 ID。
 * 与 `anime.info` / `anime.sub` 同一套规则。
 */
export async function commandSubRemove(deps: HandlerContext, session: Session, target: string): Promise<string | void> {
  const { digest } = deps
  const raw = (target ?? '').trim()
  if (!raw) return '请提供要取消订阅的作品 ID 或订阅列表中的序号。'

  try {
    const rows = await digest.listSubscriptions(platformOf(session), channelOf(session))
    if (!rows.length) return RESPONSES.noSubscription

    // 订阅记录里的 tid 是 `bgm:<id>`，裸 ID 必须先补齐前缀才能比对
    const explicit = BGM_TID.test(raw) ? raw : null
    const numeric = BGM_ID.test(raw) ? Number(raw) : null
    const picked = explicit
      ? rows.find((row) => row.tid === explicit)
      : numeric === null
        ? rows.find((row) => row.tid === raw)
        : rows[numeric - 1] ?? rows.find((row) => row.tid === `bgm:${numeric}`)
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

    const messages = getMessages(config.locale)
    const lines: string[] = []
    let currentDate = ''
    for (const item of airings) {
      if (item.date !== currentDate) {
        currentDate = item.date
        const weekday = messages.weekdayNames[getLocalWeekday(getDayStartMs(item.date, digest.timeZone), digest.timeZone)] ?? ''
        // 分组标题前留一个空行，与推送表的分组样式一致
        lines.push(`${lines.length ? '\n' : ''}【${item.date} ${weekday}】`.trimEnd())
      }
      const episode = item.recurring && item.episodeCount > 0 ? messages.episodeUnit(item.episodeCount) : ''
      lines.push(`${episode ? `${item.time} ${episode}` : item.time}\n  ${truncate(item.name, 60)}`)
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
    // 首次为本群建记录时，四种推送一律先关：`anime.on weekly` 只该开本周表，
    // 若默认给 `true`，新群里执行一次 `anime.off weekly` 反而会静默打开另外三种
    const existing = await digest.getChannel(platformOf(session), channelOf(session))
    if (!existing) {
      await digest.ensureChannel({
        platform: platformOf(session),
        channelId: channelOf(session),
        guildId: session.guildId,
        botId: session.selfId,
        dailyEnabled: false,
        nightEnabled: false,
        weeklyEnabled: false,
        seasonEnabled: false,
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
    const dayStart = getDayStartMs(today(digest.timeZone), digest.timeZone)
    const formatText = config.output.format === 'image'
      ? `图片 (${config.output.layout === 'list' ? '卡片列表' : '时间表'})`
      : `纯文本${config.output.useForward ? ' (合并转发)' : ''}`

    return [
      `时区: ${config.timeZone} (当前 ${formatDate(Date.now(), config.timeZone)})`,
      `推送形态: ${formatText}`,
      `本地化: ${digest.localizer.enabled ? `已开启 (${config.localize.titleStyle})` : '已关闭'}`,
      // 用索引层的真实来源而非写死：`bangumi-data` 取不到时会退化为远程拉取，状态页正是用来诊断这种情况的
      `数据来源: ${describeIndexSource(digest.index.source)} (${digest.index.size} 部) / Bangumi`,
      `推送时刻: ${describeTimes(config)}`,
      `开关状态: 每日 ${channel?.dailyEnabled ? '开' : '关'} / 深夜档 ${channel?.nightEnabled ? '开' : '关'} / 本周 ${channel?.weeklyEnabled ? '开' : '关'} / 本季 ${channel?.seasonEnabled ? '开' : '关'}`,
      `订阅番剧: ${subscriptions.length} 部${config.subscription.maxPerChannel > 0 ? ` (上限 ${config.subscription.maxPerChannel})` : ''}`,
      `开播提醒: ${config.push.updateReminderEnabled ? `开，提前 ${config.push.updateLookaheadMinutes} 分钟` : '关'}`,
      // 按记录时间统计：`sub`（开播提醒）的去重键里带的是时刻而不是日期，不能靠键判断
      `今日推送记录: ${dispatches.filter((row) => row.dispatchedAt >= dayStart && row.dispatchedAt < dayStart + 86400000).length} 条`,
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
