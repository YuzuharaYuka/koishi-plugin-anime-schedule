/**
 * 作品索引：把 bangumi-data 的原始清单展开成可直接使用的条目，并提供季度清单、排期推算、
 * 按 Bangumi 条目 ID 查找、关键词检索四件事。解析交给 `bangumi-data-source.ts`，取数交给
 * `bangumi-data-loader.ts`，本文件只负责建立索引并提供查询。
 */
import type { Context, Logger } from 'koishi'
import { ANILIST_ID_MAP } from '../schedule/anilist-ids'
import type { HttpClient } from '../services/network'
import { debugLog } from '../utils'
import { foldTitle } from '../utils/fold'
import type { BangumiDataItem, BroadcastSource } from './bangumi-data-source'
import { resolveBroadcast, malIdOf, siteIdOf } from './bangumi-data-source'
import { BangumiDataLoader } from './bangumi-data-loader'

/** 索引层对外暴露的一条作品 */
export interface IndexEntry {
  /** 作品键：有 Bangumi 条目 ID 时为 `bgm:<ID>`，否则为「标题 + 开播时刻」 */
  key: string
  title: string
  zhHans: string
  zhHant: string
  en: string
  bangumiId: number | null
  /**
   * AniList 条目 ID（bangumi-data 的 `sites` 里带），用于查询「是否还在播」与每一話的播出时刻：
   * 按 ID 查询可以完全避开标题匹配的歧义。缺失时退回周期规则的推算。
   */
  aniListId: number | null
  /**
   * MyAnimeList 条目 ID（bangumi-data 的 `sites` 里带）。它是**跨库稳定键**：AniList 支持
   * `Page.media(idMal_in: [...])` 批量反查，可用它把上游缺失的 `aniList` ID 自动补上。
   */
  malId: number | null
  officialSite: string
  /** 作品形态：tv / web / ova / movie 等 */
  type: string
  /** 开播日期（`begin`），不一定等于首次播出时刻 */
  beginMs: number | null
  /** 首次播出时刻（UTC 毫秒）；null 表示没有可用的周期规则 */
  broadcastMs: number | null
  /** 周期天数；`broadcastMs` 为 null 时也是 null */
  periodDays: number | null
  /**
   * 首次播出时刻来自哪里：`top`（顶层 `broadcast`，JP TV 档期）、`site`（顶层缺失，用平台
   * 自己的 `broadcast` 兜底）、`none`（没有周期规则，按 `begin` 当一次性播出）。
   */
  broadcastSource: BroadcastSource
  /**
   * 是否有可重复的周期规则；`false` 表示只有 `begin` 一个时刻
   * （一次性放送：剧场版、特别篇、整季一次放出），只能出现在 `begin` 当天。
   */
  recurring: boolean
  /** 最终回播出时刻，历史条目多半有，当季通常为空 */
  endMs: number | null
}

/** 一次推算出来的播出场次 */
export interface AirCandidate {
  entry: IndexEntry
  atMs: number
  /** 按周期递推的话数，从 1 开始 */
  episode: number
}

/** 关键词的字符是否按顺序出现在标题里（允许中间夹杂其他字符） */
function isSubsequence(chars: string[], value: string): boolean {
  let cursor = 0
  for (const char of value) {
    if (char === chars[cursor]) cursor++
    if (cursor === chars.length) return true
  }
  return false
}

export class BangumiDataIndex {
  private entries: IndexEntry[] = []
  private entryBySubject = new Map<number, IndexEntry>()
  private sourceLabel = ''
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private readonly loader: BangumiDataLoader
  /** 补充映射命中的条数，用于日志 */
  private mappedCount = 0

  constructor(ctx: Context, private logger: Logger, http: HttpClient) {
    this.loader = new BangumiDataLoader(ctx, logger, http)
  }

  get ready(): boolean {
    return this.entries.length > 0
  }

  get size(): number {
    return this.entries.length
  }

  /**
   * 全部索引条目（只读用途）。
   * 供 `followingKeys` 这类需要遍历全库、但走不了 `schedule()` 时间窗的场景使用。
   */
  get all(): readonly IndexEntry[] {
    return this.entries
  }

  /** 数据来源描述，用于日志与状态指令 */
  get source(): string {
    return this.sourceLabel
  }

  /**
   * 确保索引已载入；`apply()` 启动时先调一次让读取与插件启动并行，指令与推送构建前也会 await 它。
   */
  ensure(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    return this.load()
  }

  /** 载入索引：本地依赖包 → 磁盘缓存 → CDN 镜像 */
  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise

    const task = (async () => {
      const started = Date.now()
      const loaded = await this.loader.load()
      if (loaded) this.apply(loaded.items, loaded.source)

      this.loaded = true
      if (!this.ready) {
        this.logger.warn('[index] bangumi-data 不可用，本次推送与检索都没有作品数据')
        return
      }
      const withBroadcast = this.entries.filter((entry) => entry.broadcastMs !== null).length
      const withId = this.entries.filter((entry) => entry.bangumiId !== null).length
      const translated = this.entries.filter((entry) => entry.zhHans).length
      this.logger.info('[index] bangumi-data 已载入 %d 部作品 (来源: %s)', this.entries.length, this.sourceLabel)
      debugLog(
        '[index] 载入耗时 %dms | 带周期时刻 %d | 带 Bangumi 条目 ID %d | 带简中译名 %d',
        Date.now() - started,
        withBroadcast,
        withId,
        translated,
      )
    })()

    // 载入失败时清掉缓存，下一次调用可以重试，而不是一直拿到同一个被拒绝的 Promise
    this.loadPromise = task.catch((error) => {
      this.loadPromise = null
      throw error
    })
    return this.loadPromise
  }

  /**
   * 该季度的收录窗口：**上季末月的 21 日 ~ 本季末月的 20 日**（例如 7 月季为 `6/21 ~ 9/20`）。
   * 两端各挪十天是为了照顾季末提前放送的番：官方归季看的是首播批次，
   * 9 月 26 日首播的 10 月番因此留在 10 月季。
   */
  seasonWindow(year: number, month: number): { startMs: number; endMs: number } {
    // 起点在上一个月的 20 日之后：1 月季从去年 12/21 开始
    const startMs = month === 1 ? Date.UTC(year - 1, 11, 21) : Date.UTC(year, month - 2, 21)
    // 终点在本季末月的 20 日之后。注意 `Date.UTC` 的月份下标比自然月小 1：
    // 起始月 M 的末月是 M+2，对应下标 M+1（10 月季用 11 表示 12 月）
    const endMs = month === 10 ? Date.UTC(year, 11, 21) : Date.UTC(year, month + 1, 21)
    return { startMs, endMs }
  }

  /** 取某个季度的清单；`month` 为该季起始月（1 / 4 / 7 / 10），窗口见 `seasonWindow` */
  season(year: number, month: number): IndexEntry[] {
    if (!this.ready) return []
    const { startMs, endMs } = this.seasonWindow(year, month)
    // 只收 TV 与 WEB：OVA 与剧场版不属于新番表的收录范围
    const list = this.entries.filter((entry) => {
      if (entry.type !== 'tv' && entry.type !== 'web') return false
      if (entry.beginMs === null) return false
      return entry.beginMs >= startMs && entry.beginMs < endMs
    })
    debugLog(
      '[index] 季度 %d-%d: %d 部 (仅 TV / WEB，首播 %s ~ %s)',
      year,
      month,
      list.length,
      new Date(startMs).toISOString().slice(0, 10),
      new Date(endMs - 86400000).toISOString().slice(0, 10),
    )
    return list
  }

  /**
   * 推算一段时间内的全部播出场次：有周期规则的按 `broadcast` 逐次展开（周期无限，不设话数
   * 上限，「是否还在播」由调用方判断）；只有 `begin` 的一次性放送只在那一刻算一场，否则一部
   * 剧场版会被按周铺满整张表。这只是**推算**，AniList 有逐話时刻时会被换成真实时刻。
   */
  schedule(fromMs: number, toMs: number): AirCandidate[] {
    if (!this.ready || toMs < fromMs) return []
    const result: AirCandidate[] = []
    let recurring = 0
    let oneShot = 0

    for (const entry of this.entries) {
      const base = entry.broadcastMs
      if (base === null) continue

      if (!entry.recurring) {
        if (base >= fromMs && base <= toMs) {
          oneShot++
          result.push({ entry, atMs: base, episode: 1 })
        }
        continue
      }

      const period = (entry.periodDays ?? 7) * 86400000
      if (!Number.isFinite(period) || period <= 0 || base > toMs) continue
      recurring++

      // 直接算出窗口内的首末次，避免从作品开播那一年开始逐周空转
      const first = fromMs > base ? Math.ceil((fromMs - base) / period) : 0
      const last = Math.floor((toMs - base) / period)
      for (let step = first; step <= last; step++) {
        result.push({ entry, atMs: base + step * period, episode: step + 1 })
      }
    }

    result.sort((a, b) => a.atMs - b.atMs || a.entry.title.localeCompare(b.entry.title))
    debugLog(
      '[index] 推算 %s ~ %s: 周期作品 %d 部 / 一次性 %d 部，命中场次 %d 条',
      new Date(fromMs).toISOString(),
      new Date(toMs).toISOString(),
      recurring,
      oneShot,
      result.length,
    )
    return result
  }

  /** 按 Bangumi 条目 ID 取索引条目 */
  bySubjectId(id: number): IndexEntry | null {
    return this.entryBySubject.get(id) ?? null
  }

  /**
   * 按关键词检索索引层。打分规则（高到低）：完整标题完全相等（折叠后）→ 标题以关键词开头 →
   * 标题包含关键词 → 关键词的每个字符都按顺序出现在标题里（子序列，用于容忍译名与原文的
   * 字序差异）。除完全相等外，越短的标题得分越高。
   */
  /**
   * 按标题检索，按相关度降序返回。
   *
   * @param limit 返回条数上限，`<= 0` 表示不限制
   */
  search(keyword: string, limit = 10): IndexEntry[] {
    const folded = foldTitle(keyword)
    if (!folded) return []
    const chars = [...folded]

    const scored: { entry: IndexEntry; score: number }[] = []
    for (const entry of this.entries) {
      let best = 0
      for (const name of this.namesOf(entry)) {
        const value = foldTitle(name)
        if (!value) continue
        let score = 0
        if (value === folded) score = 1000
        else if (value.startsWith(folded)) score = 800
        else if (value.includes(folded)) score = 600
        else if (chars.length >= 2 && isSubsequence(chars, value)) score = 300
        if (score > 0) score += Math.max(0, 200 - value.length)
        if (score > best) best = score
      }
      if (best > 0) scored.push({ entry, score: best })
    }

    scored.sort((a, b) => b.score - a.score || (a.entry.beginMs ?? 0) - (b.entry.beginMs ?? 0))
    const limited = limit > 0 ? scored.slice(0, limit) : scored
    debugLog('[index] 检索「%s」命中 %d 条，返回 %d 条', keyword, scored.length, limited.length)
    return limited.map((item) => item.entry)
  }

  /** 一条作品的全部可检索名称 */
  private namesOf(entry: IndexEntry): string[] {
    return [entry.title, entry.zhHans, entry.zhHant, entry.en].filter(Boolean)
  }

  /** 把原始清单展开成索引条目 */
  private apply(items: BangumiDataItem[], source: string): void {
    this.sourceLabel = source
    const entries: IndexEntry[] = []
    const sourceCount = { top: 0, site: 0, none: 0 }
    let recurringCount = 0
    let mapped = 0

    for (const item of items) {
      if (!item?.title) continue
      const beginMs = item.begin ? Date.parse(item.begin) : Number.NaN
      const normalizedBegin = Number.isFinite(beginMs) ? beginMs : null
      const schedule = resolveBroadcast(item, normalizedBegin)
      if (schedule.recurring) recurringCount++

      const bangumiId = siteIdOf(item, 'bangumi')
      // MAL 条目 ID：跨库稳定键，用于反查 AniList（见 anilist-ids.ts 的自动补全）
      const malId = malIdOf(item)
      sourceCount[schedule.source]++

      // AniList 条目 ID：上游 `sites` 优先，缺失时用补充映射兜底
      let aniListId = siteIdOf(item, 'aniList')
      if (aniListId === null && bangumiId !== null) {
        const fallback = ANILIST_ID_MAP[bangumiId]
        if (fallback !== undefined) {
          aniListId = fallback
          mapped++
        }
      }

      // 首播时刻直接取周期规则的结果：电视档期的手工订正表已废弃，
      // 实际展示哪个时刻由 `DigestService.applyAiringSchedule` 用 AniList 决定
      const endMs = item.end ? Date.parse(item.end) : Number.NaN
      const broadcastMs = schedule.firstMs
      const finalEndMs = Number.isFinite(endMs) ? endMs : null

      entries.push({
        // bangumi-data 没有顶层 id，用 Bangumi 条目 ID 或「标题 + 开播时刻」作为稳定键
        key: bangumiId !== null ? `bgm:${bangumiId}` : `${item.title}|${item.begin ?? ''}`,
        title: item.title,
        zhHans: item.titleTranslate?.['zh-Hans']?.[0]?.trim() ?? '',
        zhHant: item.titleTranslate?.['zh-Hant']?.[0]?.trim() ?? '',
        en: item.titleTranslate?.en?.[0]?.trim() ?? '',
        bangumiId,
        aniListId,
        malId,
        officialSite: item.officialSite ?? '',
        type: item.type ?? '',
        beginMs: normalizedBegin,
        broadcastMs,
        periodDays: schedule.periodDays,
        broadcastSource: schedule.source,
        recurring: schedule.recurring,
        endMs: finalEndMs,
      })
    }

    this.entries = entries
    this.entryBySubject = new Map()
    for (const entry of entries) {
      if (entry.bangumiId !== null && !this.entryBySubject.has(entry.bangumiId)) {
        this.entryBySubject.set(entry.bangumiId, entry)
      }
    }
    debugLog(
      '[index] 排期来源: 顶层 %d / 站点补齐 %d / 仅一次性 %d；可重复推算 %d 部',
      sourceCount.top,
      sourceCount.site,
      sourceCount.none,
      recurringCount,
    )
    if (mapped > 0) debugLog('[index] AniList ID 补充映射命中 %d 部', mapped)
  }
}
