/**
 * bangumi-data 的原始数据结构，以及从它的 `broadcast` 字段解析排期规则的逻辑。
 * 这一层只跟 bangumi-data 自己的格式打交道，不涉及索引、检索或网络。
 */

/** bangumi-data 里的一条作品（没有顶层 id 字段） */
export interface BangumiDataItem {
  /** 日文原名 */
  title: string
  /** 多语言译名，键为 zh-Hans / zh-Hant / en 等 */
  titleTranslate?: Record<string, string[]>
  type?: string
  officialSite?: string
  /** 开播日期（ISO 时刻） */
  begin?: string
  /** 周期时刻，形如 `R/2026-07-01T13:00:00.000Z/P7D` */
  broadcast?: string
  /** 最终回播出时刻，当季条目大多为空 */
  end?: string
  sites?: BangumiDataSite[]
}

/** `sites` 里的一项：作品在某个平台的索引 */
export interface BangumiDataSite {
  site?: string
  id?: string
  begin?: string
  broadcast?: string
  comment?: string
}

/**
 * 首次播出时刻的来源。
 * 手工订正表已废弃（相关模块已删除），因此不再有 `override` 这一项；
 * 实际展示哪个时刻由 `DigestService.applyAiringSchedule` 用 AniList 决定。
 */
export type BroadcastSource = 'top' | 'site' | 'none'

/** 解析 ISO 8601 重复周期，形如 `R/<首次时刻>/P7D` */
const PERIOD_RE = /^R\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\/P(\d+)([DWM])$/

/** 解析一条 `broadcast` 字符串；无法解析时返回 null */
export function parsePeriod(broadcast: string | undefined): { firstMs: number; periodDays: number } | null {
  if (!broadcast) return null
  const matched = PERIOD_RE.exec(broadcast)
  if (!matched) return null
  const firstMs = Date.parse(matched[1])
  if (!Number.isFinite(firstMs)) return null
  const value = Number(matched[2])
  const unit = matched[3]
  const periodDays = unit === 'D' ? value : unit === 'W' ? value * 7 : value * 30
  // P0D 在数据里出现过（个别平台把它当「一次放出」）；周期为 0 无法递推，按周更处理
  return { firstMs, periodDays: periodDays > 0 ? periodDays : 7 }
}

/** 兜底用的平台：这些是自己排周期的正规渠道，不会给出与作品无关的时刻 */
const TRUSTED_SITES = new Set([
  'danime', 'unext', 'netflix', 'prime', 'disneyplus', 'crunchyroll', 'abema', 'nicovideo',
  'gamer', 'gamer_hk', 'muse_tw', 'muse_hk', 'ani_one', 'ani_one_asia',
  'bilibili', 'bilibili_hk_mo_tw', 'viu', 'mytv', 'iqiyi', 'youku', 'qq', 'mgtv',
])

/**
 * 决定一条作品的排期来源：顶层 `broadcast`（JP TV 档期，最权威）→ 可信平台里最早的一个站点级
 * `broadcast` → 两边都没有时**不伪造周期**，把 `begin` 当一次性播出时刻（`recurring = false`）。
 *
 * 不在顶层存在时改用站点级：各平台首次时刻差异极大，混用会导致播出时刻不可预期。
 * 这一层给的是 bangumi-data 记录的档期（配信优先），AniList 有逐話时刻时会覆盖它。
 */
export function resolveBroadcast(item: BangumiDataItem, beginMs: number | null): {
  firstMs: number | null
  periodDays: number | null
  source: BroadcastSource
  recurring: boolean
} {
  const top = parsePeriod(item.broadcast)
  if (top) return { firstMs: top.firstMs, periodDays: top.periodDays, source: 'top', recurring: true }

  let earliest: { firstMs: number; periodDays: number } | null = null
  for (const site of item.sites ?? []) {
    if (!site.site || !TRUSTED_SITES.has(site.site)) continue
    const parsed = parsePeriod(site.broadcast)
    if (!parsed) continue
    if (!earliest || parsed.firstMs < earliest.firstMs) earliest = parsed
  }
  if (earliest) return { firstMs: earliest.firstMs, periodDays: earliest.periodDays, source: 'site', recurring: true }

  // 没有周期规则：只记 `begin` 一个时刻，标为一次性
  return { firstMs: beginMs, periodDays: null, source: 'none', recurring: false }
}

/** 取作品在某个平台上的条目 ID；没有或非数字时返回 null */
export function siteIdOf(item: BangumiDataItem, site: string): number | null {
  const raw = item.sites?.find((entry) => entry.site === site)?.id
  return raw && /^\d+$/.test(raw) ? Number(raw) : null
}

/**
 * 取作品的 MyAnimeList 条目 ID。单独开一个函数是因为 MAL 是**跨库稳定键**：AniList 支持按
 * `idMal_in` 批量反查，可以把 bangumi-data 里缺失的 `aniList` ID 自动补上。
 */
export function malIdOf(item: BangumiDataItem): number | null {
  return siteIdOf(item, 'mal')
}
