import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type { Context, Logger } from 'koishi'
import {
  EPISODE_QUERY_LIMIT,
  BANGUMI_API_HOST,
  LOCALIZE_CACHE_FILE,
  LOCALIZE_CACHE_MAX_ENTRIES,
  LOCALIZE_CACHE_VERSION,
  LOCALIZE_CONCURRENCY,
} from '../constants'
import type { Config } from '../config'
import type { LocalizeCacheEntry, LocalizeCacheFile } from '../types'
import { debugLog, errorMessage, errorStatus, mapLimit, unwrapPayload } from '../utils'
import { HttpClient } from './network'

/** Bangumi `GET /v0/subjects/{id}` 的响应中我们用到的字段 */
interface BangumiSubject {
  id: number
  name: string
  name_cn: string
  date: string | null
  /** 总集数：连载中为预定集数，已完结为实际集数；插件只作留档，不参与判定 */
  eps?: number
  total_episodes?: number
  images: { large?: string; common?: string } | null
  rating: { score?: number; total?: number; count?: Record<string, number> } | null
}

/**
 * 取条目的总集数，仅写入缓存留档。
 * 已完结的条目两者都会给，因此优先 `total_episodes`，取不到再退回 `eps`。
 */
function resolveEpisodeTotal(subject: BangumiSubject): number | null {
  const total = Number(subject.total_episodes)
  if (Number.isFinite(total) && total > 0) return total
  const eps = Number(subject.eps)
  if (Number.isFinite(eps) && eps > 0) return eps
  return null
}

/**
 * 算评分，保留两位小数。
 *
 * **不用 `rating.score`**：Bangumi 只保留一位小数。API 同时给了 `rating.count`（各分数段人数），
 * 据此算**算术平均**即可拿到真实精度，四舍五入到一位后与网站显示一致；`count` 缺失时退回 `score`。
 *
 * 详情卡（`services/info.ts`）复用同一份，避免同一套算法写两处。
 */
export function computeScore(rating: BangumiSubject['rating'] | undefined): number | null {
  const count = rating?.count
  if (count && typeof count === 'object') {
    let sum = 0
    let votes = 0
    for (const [key, value] of Object.entries(count)) {
      const score = Number(key)
      const people = Number(value)
      if (!Number.isFinite(score) || !Number.isFinite(people) || people <= 0) continue
      sum += score * people
      votes += people
    }
    if (votes > 0) return Math.round((sum / votes) * 100) / 100
  }
  return typeof rating?.score === 'number' ? rating.score : null
}

/**
 * 按 Bangumi 条目 ID 取作品详情。这里**不做任何标题匹配**：bangumi-data 已给出每部作品的
 * 条目 ID，直接按 ID 请求即可，没有误配风险。结果写入内存与磁盘缓存，命中缓存时不发请求。
 */
export class Localizer {
  private readonly memory = new Map<number, LocalizeCacheEntry>()
  private readonly cachePath: string
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private dirty = false
  private flushTimer: (() => void) | null = null

  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private http: HttpClient,
  ) {
    this.cachePath = resolve(ctx.baseDir, 'data', 'anime-schedule', LOCALIZE_CACHE_FILE)
  }

  /** 是否使用中文名与评分展示（详情本身始终获取，用于判断是否已播完） */
  get enabled(): boolean {
    return this.config.localize.enabled
  }

  /** 确保磁盘缓存已读取（重复调用只读一次） */
  ensure(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    return this.load()
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      try {
        const text = await fs.readFile(this.cachePath, 'utf8')
        const parsed = JSON.parse(text) as LocalizeCacheFile
        if (parsed?.version === LOCALIZE_CACHE_VERSION && parsed.entries) {
          for (const [key, entry] of Object.entries(parsed.entries)) {
            const id = Number(key.replace(/^#/, ''))
            if (Number.isFinite(id) && entry && typeof entry.cachedAt === 'number') {
              this.memory.set(id, { ...entry, subjectId: id })
            }
          }
        } else if (parsed) {
          // 版本不符时整份缓存都不采信。这里必须留一条日志：否则「缓存忽然变空、
          // 下一次写入又把旧数据覆盖掉」会完全无声，只能靠条目数异常缩小去猜
          this.logger.info(
            '[localize] 缓存版本 %s 与当前 %d 不符，本次重新构建',
            parsed.version ?? '(无)',
            LOCALIZE_CACHE_VERSION,
          )
        }
        debugLog('[localize] 缓存载入完成，条目数: %d', this.memory.size)
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          this.logger.warn('[localize] 读取本地化缓存失败，将重新构建:', error)
        }
      } finally {
        this.loaded = true
      }
    })()
    return this.loadPromise
  }

  /** 把缓存写回磁盘，写入前按时间淘汰最旧的一半 */
  private async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    if (this.memory.size > LOCALIZE_CACHE_MAX_ENTRIES) {
      const sorted = [...this.memory.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)
      const drop = sorted.slice(0, sorted.length - Math.floor(LOCALIZE_CACHE_MAX_ENTRIES / 2))
      for (const [id] of drop) this.memory.delete(id)
    }

    const payload: LocalizeCacheFile = { version: LOCALIZE_CACHE_VERSION, entries: {} }
    for (const [id, entry] of this.memory) payload.entries[`#${id}`] = entry

    const temp = `${this.cachePath}.tmp`
    try {
      await fs.mkdir(dirname(this.cachePath), { recursive: true })
      await fs.writeFile(temp, JSON.stringify(payload), 'utf8')
      await fs.rename(temp, this.cachePath)
    } catch (error) {
      this.logger.warn('[localize] 写入本地化缓存失败:', error)
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /** 延迟合并写入，避免每次命中都落盘 */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = this.ctx.setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 3000)
  }

  /** 主动落盘，插件卸载与调度结束后调用 */
  async save(): Promise<void> {
    if (this.flushTimer) {
      this.flushTimer()
      this.flushTimer = null
    }
    await this.flush()
  }

  /**
   * 这一条缓存是否还够用。标题封面与评分分开计保质期：前者几乎不变（`cacheTtlDays`），后者在
   * 新番开播头几周天天在变（`scoreTtlHours`）。
   *
   * @param wantEpisodeTimes 需要逐集档期时，缺档期的条目即使标题还新鲜也得重取一次。
   */
  private isFresh(entry: LocalizeCacheEntry, wantEpisodeTimes: boolean): boolean {
    if (entry.missing) {
      // 「不存在」也是有效结果：同一季内不必反复去问一个不会出现的条目
      return Date.now() - entry.cachedAt < this.config.localize.cacheTtlDays * 24 * 60 * 60 * 1000
    }

    // 取过条目详情、却没取逐集档期，而这次需要档期 → 必须重取。旧版缓存没有 hasEpisodeTimes 字段，按「取过」处理。
    if (wantEpisodeTimes && entry.hasEpisodeTimes === false) return false

    // 评分单独算保质期：到期就重取详情，重取时仍按调用方的需要决定要不要连档期一起取
    const scoreAt = entry.scoreCachedAt ?? entry.cachedAt
    if (Date.now() - scoreAt >= this.config.localize.scoreTtlHours * 60 * 60 * 1000) return false

    return Date.now() - entry.cachedAt < this.config.localize.cacheTtlDays * 24 * 60 * 60 * 1000
  }

  /**
   * 批量取回条目详情，返回「条目 ID → 详情」。未命中的条目不会出现在结果里，调用方按
   * 「取不到就退化为日文原名」处理。
   *
   * @param wantEpisodeTimes 是否顺带取逐集档期（额外请求 `/v0/episodes`）。本季表与检索只展示
   *   首播时刻与封面评分，传 `false` 可省掉每部一个请求；跳过的条目在缓存里标记
   *   `hasEpisodeTimes: false`，日后真有需要时会自动补取。
   */
  async localizeByIds(ids: number[], wantEpisodeTimes = true): Promise<Map<number, LocalizeCacheEntry>> {
    const result = new Map<number, LocalizeCacheEntry>()
    if (!ids.length) return result
    await this.load()

    const wanted: number[] = []
    /** 这次要重取的条目里，缓存中已有的那一份；用于判断是否还需要补逐集档期 */
    const previous = new Map<number, LocalizeCacheEntry>()
    const seen = new Set<number>()
    for (const id of ids) {
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      const cached = this.memory.get(id)
      if (!cached) {
        wanted.push(id)
        continue
      }
      // 过期条目也先返回，避免一次请求失败就让整张表掉封面
      result.set(id, cached)
      if (!this.isFresh(cached, wantEpisodeTimes)) {
        wanted.push(id)
        previous.set(id, cached)
      }
    }
    if (!wanted.length) return result

    const started = Date.now()
    const looked = await mapLimit(wanted, LOCALIZE_CONCURRENCY, async (id) => {
      const stale = previous.get(id)
      // 逐集档期只在「调用方要」且「有正规集数」时才值得请求：用它拿首末集日期。
      //
      // 已经取过档期的条目**不重复取**——评分每天刷新，而档期是另一笔请求，跟着一起重发
      // 会让请求量凭空翻倍。只有「没取过」或「这次确实缺它」才补。
      const needsTimes = wantEpisodeTimes && !(stale && stale.hasEpisodeTimes !== false)
      const subject = await this.fetchSubject(id)
      const times = needsTimes && subject && resolveEpisodeTotal(subject)
        ? await this.fetchEpisodeTimes(id)
        : null
      return { id, subject, times }
    })

    let ok = 0
    for (const { id, subject, times } of looked) {
      if (!subject) continue
      ok++
      const stale = previous.get(id)
      // 这次没重新取档期（评分刷新）时，沿用上一次的结果，别把它当「没有档期」
      const hasTimes = times !== null || stale?.hasEpisodeTimes === true
      const entry: LocalizeCacheEntry = {
        subjectId: subject.id,
        title: subject.name_cn?.trim() || subject.name,
        coverUrl: subject.images?.large ?? subject.images?.common ?? '',
        score: computeScore(subject.rating),
        ratingTotal: typeof subject.rating?.total === 'number' ? subject.rating.total : null,
        totalEpisodes: resolveEpisodeTotal(subject),
        hasEpisodeTimes: hasTimes,
        firstAirMs: times?.first ?? stale?.firstAirMs ?? null,
        lastAirMs: times?.last ?? stale?.lastAirMs ?? null,
        airDate: subject.date ?? null,
        // 标题、封面与评分都来自本次 `GET /v0/subjects/{id}`，因此 `cachedAt` 一并推进。
        // 旧实现只在「取了逐集档期」时推进，导致超过 `cacheTtlDays` 的条目永远判过期：
        // 评分刷新不会补取档期，于是 `cachedAt` 再也不动，每次调用都重新请求一次。
        cachedAt: Date.now(),
        scoreCachedAt: Date.now(),
      }
      this.memory.set(id, entry)
      this.scheduleFlush()
      result.set(id, entry)
    }

    const missing = looked.filter((item) => !item.subject)
    debugLog(
      '[localize] 取条目详情: 请求 %d 部，成功 %d 部，缓存命中 %d 部 (%dms)',
      wanted.length,
      ok,
      result.size - ok,
      Date.now() - started,
    )
    for (const { id } of missing) debugLog('[localize] 条目 %d 未取到详情 (可能尚未建立或接口失败)', id)
    return result
  }

  /** 按条目 ID 取单个条目详情；条目不存在（404）或请求失败时返回 null */
  private async fetchSubject(id: number): Promise<BangumiSubject | null> {
    const url = `${BANGUMI_API_HOST}/v0/subjects/${id}`
    const outcome = await this.request<BangumiSubject>(url, id, (payload) => Boolean(payload?.id))
    // 404 说明 Bangumi 上没有这个条目（例如只在 AniList 有的 OVA），记下来别再问
    if (outcome.notFound) this.rememberMissing(id)
    return outcome.value
  }

  /**
   * 取该条目的首集与末集播出时刻（`airdate` 是 JST 日期，按日本时间 0 点算）。
   *
   * `lastAirMs` 用于判断「是否已播完」（bangumi-data 的 `end` 在当季条目上几乎为空，而总集数
   * 只统计本季集数）；`firstAirMs` 用于把订正表的 `since` 定死到真实首播那一天（站点的「周几」
   * 有时是放送日标签、有时是日历日）。只有这两处用得到，因此它是**额外请求**：调用方传
   * `localizeByIds(ids, false)` 时就不发。
   */
  private async fetchEpisodeTimes(id: number): Promise<{ first: number | null; last: number | null }> {
    const url = `${BANGUMI_API_HOST}/v0/episodes?subject_id=${id}&type=0&limit=${EPISODE_QUERY_LIMIT}`
    const outcome = await this.request<{ data?: { type?: number; airdate?: string }[] }>(url, id, (value) => Array.isArray(value?.data))
    let first: number | null = null
    let last: number | null = null
    for (const episode of outcome.value?.data ?? []) {
      if (episode.type !== 0) continue
      const raw = episode.airdate
      if (typeof raw !== 'string') continue
      const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
      if (!matched) continue
      // `airdate` 是 JST 日期，换算成该日 0 点（JST）的 UTC 毫秒
      const ms = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
      if (first === null || ms < first) first = ms
      if (last === null || ms > last) last = ms
    }
    return { first, last }
  }

  /**
   * 取一个条目的响应，把三种结果分开：拿到值、站点明确说「没有这个条目」（404）、其他失败。
   *
   * 重试与退避已由 `HttpClient` 统一处理，这里只负责归类——404 要记负缓存，
   * 而「失败」若也记进去，会把临时故障当成「条目不存在」缓存一整个 TTL。
   */
  private async request<T>(
    url: string,
    id: number,
    valid: (payload: T) => boolean,
  ): Promise<{ value: T | null; notFound: boolean }> {
    try {
      const raw = await this.http.get<unknown>(url, {
        timeout: this.config.advanced.requestTimeout * 1000,
      })
      const payload = unwrapPayload(raw) as T | null
      if (!payload || !valid(payload)) return { value: null, notFound: false }
      return { value: payload, notFound: false }
    } catch (error) {
      const status = errorStatus(error)
      if (status === 404) {
        debugLog('[localize] 条目 %d 在 Bangumi 上不存在 (404)', id)
        return { value: null, notFound: true }
      }
      if (status === 429) this.logger.debug('[localize] 条目 %d 被限流 (%s)', id, status)
      else {
        this.logger.debug('[localize] 条目 %d 获取失败: %s', id, errorMessage(error))
        this.http.hintOnFailure(error)
      }
      return { value: null, notFound: false }
    }
  }

  /**
   * 记下「这个条目在 Bangumi 上不存在」：存成一条只有 `missing` 标记的缓存，`isFresh` 会按
   * 正常 TTL 认为它有效，于是同一季内不再重复请求；到期后会自动重试一次。
   */
  private rememberMissing(id: number): void {
    this.memory.set(id, {
      subjectId: id,
      title: '',
      coverUrl: '',
      score: null,
      ratingTotal: null,
      totalEpisodes: null,
      hasEpisodeTimes: false,
      firstAirMs: null,
      lastAirMs: null,
      airDate: null,
      missing: true,
      cachedAt: Date.now(),
    })
    this.scheduleFlush()
  }
}
