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
import { debugLog, errorMessage, errorStatus, mapLimit, retryDelay, unwrapPayload } from '../utils'
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
  rating: { score?: number; total?: number } | null
}

/**
 * 取条目的总集数，仅写入缓存留档。
 *
 * 连载中的条目只有 `eps`（预定集数），已完结的条目两者都会给，
 * 因此优先用 `total_episodes`，取不到再退回 `eps`。
 */
function resolveEpisodeTotal(subject: BangumiSubject): number | null {
  const total = Number(subject.total_episodes)
  if (Number.isFinite(total) && total > 0) return total
  const eps = Number(subject.eps)
  if (Number.isFinite(eps) && eps > 0) return eps
  return null
}

/**
 * 兼容不同的 http 适配器：Koishi 的 http 服务返回响应体本身，
 * 而直接使用 axios 的调用方会拿到完整的响应对象。
 */
/**
 * 按 Bangumi 条目 ID 取作品详情。
 *
 * 这里**不做任何标题匹配**：bangumi-data 已经给出每部作品的 Bangumi 条目 ID，
 * 直接按 ID 请求即可拿到中文名、封面、评分与开播日，
 * 既没有误配风险，也不需要维护相似度阈值。
 *
 * 结果按「条目 ID → 详情」写入内存与磁盘缓存，命中缓存时不发任何请求。
 */
export class Localizer {
  private readonly memory = new Map<number, LocalizeCacheEntry>()
  private readonly cachePath: string
  private readonly http: HttpClient
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private dirty = false
  private flushTimer: (() => void) | null = null

  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
  ) {
    this.http = new HttpClient(ctx, logger)
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

  private isFresh(entry: LocalizeCacheEntry): boolean {
    // 「不存在」也是有效结果：同一季内不必反复去问一个不会出现的条目
    if (entry.missing) return Date.now() - entry.cachedAt < this.config.localize.cacheTtlDays * 24 * 60 * 60 * 1000
    // 取过条目详情、却没取逐集档期（本季表与检索这两条路径会这样），
    // 而完结判定需要逐集档期时，必须重新取一次而不是当作新鲜数据用。
    // 旧版缓存没有 hasEpisodeTimes 字段，按「取过」处理。
    if (entry.hasEpisodeTimes === false) return false
    return Date.now() - entry.cachedAt < this.config.localize.cacheTtlDays * 24 * 60 * 60 * 1000
  }

  /**
   * 批量取回条目详情，返回「条目 ID → 详情」。
   *
   * 未命中的条目不会出现在结果里；调用方按「取不到就退化为日文原名」处理。
   *
   * @param wantEpisodeTimes 是否顺带取逐集档期。只有「判断是否已播完」与「校准订正表
   *   since」需要它，而它是一个额外请求（`/v0/episodes`）。本季表与关键词检索只展示
   *   首播时刻与封面评分，因此传 `false`：当季 82 部能因此少发 82 个请求。
   *   跳过的条目会在缓存里标记 `hasEpisodeTimes: false`，日后真有需要时会自动补取。
   */
  async localizeByIds(ids: number[], wantEpisodeTimes = true): Promise<Map<number, LocalizeCacheEntry>> {
    const result = new Map<number, LocalizeCacheEntry>()
    if (!ids.length) return result
    await this.load()

    const wanted: number[] = []
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
      if (!this.isFresh(cached)) wanted.push(id)
    }
    if (!wanted.length) return result

    const started = Date.now()
    const looked = await mapLimit(wanted, LOCALIZE_CONCURRENCY, async (id) => {
      const subject = await this.fetchSubject(id)
      // 逐集档期只在「调用方要」且「有正规集数」时才值得请求：用它拿首末集日期
      const times = wantEpisodeTimes && subject && resolveEpisodeTotal(subject)
        ? await this.fetchEpisodeTimes(id)
        : null
      return { id, subject, times }
    })

    let ok = 0
    for (const { id, subject, times } of looked) {
      if (!subject) continue
      ok++
      const entry: LocalizeCacheEntry = {
        subjectId: subject.id,
        title: subject.name_cn?.trim() || subject.name,
        coverUrl: subject.images?.large ?? subject.images?.common ?? '',
        score: typeof subject.rating?.score === 'number' ? subject.rating.score : null,
        ratingTotal: typeof subject.rating?.total === 'number' ? subject.rating.total : null,
        totalEpisodes: resolveEpisodeTotal(subject),
        hasEpisodeTimes: times !== null,
        firstAirMs: times?.first ?? null,
        lastAirMs: times?.last ?? null,
        airDate: subject.date ?? null,
        cachedAt: Date.now(),
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
   * 取该条目的首集与末集播出时刻（`airdate` 是 JST 日期，这里按日本时间 0 点算）。
   *
   * 这两个时刻是判断排期是否准确的两个锚点：
   * - `lastAirMs` 用于判断「是否已播完」——bangumi-data 的 `end` 在当季条目上几乎为空，
   *   而总集数只统计本季集数（长期番按季重置），拿它和累计集数比较必然误判；
   * - `firstAirMs` 用于把订正表的 `since` 定死到真实首播那一天：站点的「周几」有时是
   *   放送日标签、有时是日历日，光靠标签会算错一天。
   *
   * 因为只有上面两件事用得到，本方法是一个**额外请求**：调用方通过
   * `localizeByIds(ids, false)` 明确表示不需要时就不发（见那里的说明）。
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
   * 统一的请求 + 重试。
   *
   * 返回 `{ value, notFound }`：`value` 是响应体（不可用或失败时为 null），
   * `notFound` 表示站点明确回答「没有这个条目」（404），调用方据此记负缓存。
   * 两者分开是因为「失败」值得重试、「不存在」不值得——但都不该每次都重问一遍。
   */
  private async request<T>(
    url: string,
    id: number,
    valid: (payload: T) => boolean,
  ): Promise<{ value: T | null; notFound: boolean }> {
    const maxAttempt = Math.min(1, this.config.advanced.retries)
    for (let attempt = 0; attempt <= maxAttempt; attempt++) {
      try {
        const raw = await this.http.get<unknown>(url, {
          timeout: this.config.advanced.requestTimeout * 1000,
        })
        const payload = unwrapPayload(raw) as T | null
        if (!payload || !valid(payload)) return { value: null, notFound: false }
        return { value: payload, notFound: false }
      } catch (error) {
        const status = errorStatus(error)
        // 404：条目不存在，重试没有意义，也不必再问
        if (status === 404) {
          debugLog('[localize] 条目 %d 在 Bangumi 上不存在 (404)', id)
          return { value: null, notFound: true }
        }
        if (attempt < maxAttempt) {
          const delay = retryDelay(attempt)
          debugLog('[localize] 条目 %d 请求失败，%dms 后重试: %s', id, delay, errorMessage(error))
          await new Promise<void>((resolve) => { this.ctx.setTimeout(() => resolve(), delay) })
          continue
        }
        if (status === 429) this.logger.debug('[localize] 条目 %d 被限流 (%s)', id, status)
        else {
          this.logger.debug('[localize] 条目 %d 获取失败: %s', id, errorMessage(error))
          this.http.hintOnFailure(error)
        }
        return { value: null, notFound: false }
      }
    }
    return { value: null, notFound: false }
  }

  /**
   * 记下「这个条目在 Bangumi 上不存在」。
   *
   * 存成一条只有 `missing` 标记的缓存，`isFresh` 会按正常 TTL 认为它有效，
   * 于是同一季内不再重复请求。到期后会自动重试一次——那时 Bangumi 可能已经建好条目。
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
