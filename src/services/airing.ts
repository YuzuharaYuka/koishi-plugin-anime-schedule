/**
 * AniList 播出数据查询。
 *
 * 「这部番还在播吗」「第几話什么时候播」需要**外部权威数据**：周期规则推算无法区分「已完结」
 * 与「停更一周」，也无法表达首周多集连播。AniList 直接给出逐話时刻与 `status`，且
 * bangumi-data 自带条目 ID，可按 ID 精确查询。
 *
 * 缓存只在内存里（[使用条款](https://docs.anilist.co/guide/terms-of-use)禁止把它当数据存储
 * 服务）。速率限制：文档写 90 次/分钟，**实测响应头是 `x-ratelimit-limit: 30`**，超限会 429
 * 封禁 1 分钟、严重故障时 403，因此请求**串行 + 最小间隔**，429/403 后进入冷却、期间只返回缓存。
 */
import type { Context, Logger } from 'koishi'
import type { AiringState, AniListStatus } from '../types'
import {
  ANILIST_API_URL,
  ANILIST_BATCH_SIZE,
  ANILIST_COOLDOWN_MS,
  ANILIST_MIN_INTERVAL_MS,
} from '../constants'
import { debugLog, errorMessage, errorStatus, unwrapPayload } from '../utils'
import type { MatchCandidate, MatchTarget } from '../data/anilist-match'
import { matchByTitle, normalizeTitle } from '../data/anilist-match'
import { HttpClient } from './network'

/** AniList 响应里我们用到的字段 */
interface AniListMedia {
  id: number
  status?: string
  episodes?: number | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  /** 已播出与未播出的每一話（`notYetAired` 默认为 false，但实测仍会返回未来场次） */
  airingSchedule?: { nodes?: { episode?: number | null; airingAt?: number | null }[] | null } | null
  nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null
  coverImage?: { extraLarge?: string | null; large?: string | null } | null
}

const QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      status
      episodes
      startDate { year month day }
      endDate { year month day }
      airingSchedule(perPage: 50) { nodes { episode airingAt } }
      nextAiringEpisode { episode airingAt }
      coverImage { extraLarge large }
    }
  }
}`

/**
 * 按标题搜索候选，用于给「bangumi-data 没带 `aniList` ID」的条目补 ID。
 * 多出的 `title` 与 `synonyms` 供匹配使用，`startDate` 与 `airingSchedule` 用于双重校验。
 */
const SEARCH_QUERY = `query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME) {
      id
      title { native romaji english }
      synonyms
      startDate { year month day }
      airingSchedule(perPage: 50) { nodes { episode airingAt } }
    }
  }
}`

/** 一次标题搜索最多看几个候选 */
const SEARCH_LIMIT = 8

/**
 * 每个进程最多按标题搜索多少次。按标题搜索只能一次一个请求，而一次构建会多次调用
 * `airingStatesOf`，因此按**进程**限量——它是「整季总共要新认识多少部作品」，而非「每次构建多少」。
 * 搜过的结果（含「搜不到」）一直留在内存里。
 */
const TITLE_SEARCH_BUDGET = 24

/**
 * 播出数据查询器。
 * 只负责「按 ID 取数据并缓存」；「据此决定怎么排期」由 `DigestService` 负责。
 */
export class AiringStatusService {
  /** 进程内缓存；按 AniList 条款不落盘。上限见 `MEMORY_MAX` */
  private readonly memory = new Map<number, AiringState>()
  /** 条目数上限：一部作品一条，正常一年也用不到，只为兜住「跑遍整个番剧库」的情况 */
  private static readonly MEMORY_MAX = 3000
  /**
   * 标题 → AniList 条目 ID 的补映射结果。
   * 也是进程内缓存：bangumi-data 约三分之一的条目没带 `aniList` ID，搜到之后同一进程内不再重复搜索。
   */
  private readonly idByTitle = new Map<string, number | null>()
  /** 已经用掉的标题搜索次数，见 `TITLE_SEARCH_BUDGET` */
  private titleSearches = 0
  /** 冷却截止时刻：收到 429 后到这时刻之前不再发请求 */
  private cooldownUntil = 0
  /** 上一次请求结束的时刻，用于保证最小间隔 */
  private lastRequestAt = 0
  /** 请求串行化，避免并发触发突发限流 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private ctx: Context,
    private logger: Logger,
    private http: HttpClient,
  ) {}

  /** 当前是否处于限流冷却中 */
  get coolingDown(): boolean {
    return Date.now() < this.cooldownUntil
  }

  /** 无需预热（缓存只在内存里），保留此方法让调用方写法统一 */
  ensure(): Promise<void> {
    return Promise.resolve()
  }

  private isFresh(entry: AiringState, ttlDays: number): boolean {
    return Date.now() - entry.cachedAt < ttlDays * 24 * 60 * 60 * 1000
  }

  /**
   * 按标题给缺失 `aniList` ID 的条目补一个 ID：补上就用 AniList 的逐話時刻排期，搜不到返回
   * null 让调用方退回周期推算。结果（含「搜不到」）在进程内缓存。
   * 校验交给 `matchByTitle`：标题相等 + 首播日期相近，缺一不可。
   */
  async resolveByTitle(target: MatchTarget): Promise<number | null> {
    const key = normalizeTitle(target.title)
    if (!key) return null
    const cached = this.idByTitle.get(key)
    if (cached !== undefined) return cached
    if (this.coolingDown) return null
    if (this.titleSearches >= TITLE_SEARCH_BUDGET) {
      debugLog('[airing] 标题搜索额度已用完（%d 次），%s 本次按推算排期', TITLE_SEARCH_BUDGET, target.title)
      return null
    }
    this.titleSearches++

    const media = await this.enqueue(() => this.searchByTitle(target.title))
    if (media === null) return null // 限流或服务不可用，本次不补
    const matched = matchByTitle(target, media)
    const id = matched?.candidate.id ?? null
    this.idByTitle.set(key, id)
    if (id !== null) {
      debugLog(
        '[airing] 按标题补上 AniList ID: %s → #%d（首播差 %s 天，时刻差 %s 小时）',
        target.title,
        id,
        matched?.dayGap?.toFixed(0) ?? '?',
        matched?.hourGap?.toFixed(1) ?? '?',
      )
    }
    return id
  }

  /** 按标题搜候选；失败返回 null（与「搜不到」区分开，后者是空数组） */
  private async searchByTitle(title: string): Promise<MatchCandidate[] | null> {
    try {
      const raw = await this.http.post<unknown>(ANILIST_API_URL, {
        query: SEARCH_QUERY,
        variables: { search: title, perPage: SEARCH_LIMIT },
      }, { timeout: 20000 })
      const payload = unwrapPayload(raw) as { data?: { Page?: { media?: MatchCandidate[] } } } | null
      return payload?.data?.Page?.media ?? []
    } catch (error) {
      return this.handleRequestError(error) ? null : []
    }
  }

  /**
   * 批量取 AniList 状态，未命中的 ID 不会出现在结果里（调用方按「取不到就不判定」处理）。
   *
   * @param now 判定「已播出到第几话」的基准时刻。由调用方注入而非就地取 `Date.now()`，
   *   否则同一份数据在两次构建之间会得到不同的 `airedEpisodes`，快照无法复现。
   */
  async resolve(aniListIds: number[], ttlDays: number, now = Date.now()): Promise<Map<number, AiringState>> {
    const result = new Map<number, AiringState>()
    const wanted: number[] = []
    const seen = new Set<number>()

    for (const id of aniListIds) {
      if (!Number.isFinite(id) || seen.has(id)) continue
      seen.add(id)
      const cached = this.memory.get(id)
      if (!cached) {
        wanted.push(id)
        continue
      }
      // 过期条目先返回旧值，避免一次请求失败就没有数据可用
      result.set(id, cached)
      if (!this.isFresh(cached, ttlDays)) wanted.push(id)
    }
    if (!wanted.length) return result

    if (this.coolingDown) {
      debugLog('[airing] 处于限流冷却中，本次不查询（复用已有缓存 %d 条）', result.size)
      return result
    }

    const started = Date.now()
    let ok = 0
    for (let offset = 0; offset < wanted.length; offset += ANILIST_BATCH_SIZE) {
      const batch = wanted.slice(offset, offset + ANILIST_BATCH_SIZE)
      const media = await this.enqueue(() => this.fetchBatch(batch))
      if (media === null) break // 限流或服务不可用，停止后续批次
      for (const item of media) {
        const entry = this.toState(item, now)
        if (!entry) continue
        ok++
        this.remember(entry)
        result.set(entry.aniListId, entry)
      }
    }
    debugLog(
      '[airing] 拉取 AniList 数据: 请求 %d 部，成功 %d 部，缓存命中 %d 部 (%dms)',
      wanted.length,
      ok,
      result.size - ok,
      Date.now() - started,
    )
    return result
  }

  /**
   * 写入进程内缓存并维持上限。
   *
   * 缓存键是 AniList 条目 ID，随查询过的作品数增长；不设上限时长时间运行会一直涨。
   * 超出后按插入顺序淘汰最早的一批（Map 保持插入顺序）。
   */
  private remember(entry: AiringState): void {
    this.memory.delete(entry.aniListId)
    this.memory.set(entry.aniListId, entry)
    let over = this.memory.size - AiringStatusService.MEMORY_MAX
    if (over <= 0) return
    for (const key of this.memory.keys()) {
      if (over-- <= 0) break
      this.memory.delete(key)
    }
  }

  /** 串行执行，并在两次请求之间留出最小间隔 */
  private enqueue<T>(task: () => Promise<T>): Promise<T | null> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + ANILIST_MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await new Promise<void>((resolve) => { this.ctx.setTimeout(() => resolve(), wait) })
      try {
        return await task()
      } finally {
        this.lastRequestAt = Date.now()
      }
    })
    // 队列自身不因单个失败而断掉
    this.queue = run.catch(() => undefined)
    return run.catch(() => null)
  }

  private toState(media: AniListMedia, now: number): AiringState | null {
    if (!Number.isFinite(media?.id)) return null
    const toIso = (value?: { year?: number | null; month?: number | null; day?: number | null } | null) => (
      value?.year && value?.month && value?.day
        ? `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
        : null
    )

    // 逐話时刻：同时收集已播出与未播出的，按话数排序
    const episodes: { episode: number; atMs: number }[] = []
    for (const node of media.airingSchedule?.nodes ?? []) {
      const episode = typeof node?.episode === 'number' ? node.episode : null
      const atMs = typeof node?.airingAt === 'number' ? node.airingAt * 1000 : null
      if (episode === null || atMs === null || episode < 1) continue
      episodes.push({ episode, atMs })
    }
    episodes.sort((a, b) => a.episode - b.episode)

    // 同一話出现多条时保留最早的那条（重播会追加节点）
    const deduped: { episode: number; atMs: number }[] = []
    for (const item of episodes) {
      const last = deduped[deduped.length - 1]
      if (last && last.episode === item.episode) {
        if (item.atMs < last.atMs) deduped[deduped.length - 1] = item
        continue
      }
      deduped.push(item)
    }

    const aired = deduped.filter((item) => item.atMs <= now)
    const lastAired = aired[aired.length - 1] ?? null

    const next = media.nextAiringEpisode
    const nextEpisode = typeof next?.episode === 'number' && typeof next?.airingAt === 'number'
      ? { episode: next.episode, atMs: next.airingAt * 1000 }
      : null

    return {
      aniListId: media.id,
      status: (media.status ?? 'UNKNOWN') as AniListStatus,
      episodes: typeof media.episodes === 'number' ? media.episodes : null,
      startDate: toIso(media.startDate),
      endDate: toIso(media.endDate),
      // 逐話时刻：排期直接取用，不再靠周期规则推算
      schedule: deduped,
      airedEpisodes: lastAired?.episode ?? null,
      lastAiredMs: lastAired?.atMs ?? null,
      nextEpisode,
      coverUrl: media.coverImage?.extraLarge ?? media.coverImage?.large ?? '',
      cachedAt: now,
    }
  }

  /**
   * 处理一次失败的请求。返回 `true` 表示「进入了冷却，调用方应当停止本次查询」（限流或
   * 服务被停用）；`false` 表示普通失败，调用方按「取不到就跳过」处理。
   */
  private handleRequestError(error: unknown): boolean {
    const status = errorStatus(error)
    if (status === 429 || status === 403) {
      // 429：超限封禁 1 分钟；403：API 被临时停用。两种情况都进入冷却
      this.cooldownUntil = Date.now() + ANILIST_COOLDOWN_MS
      this.logger.warn(
        '[airing] AniList 返回 %d（%s），暂停查询 %d 分钟，期间沿用已有数据',
        status,
        status === 429 ? '超出速率限制' : 'API 被临时停用',
        ANILIST_COOLDOWN_MS / 60000,
      )
      return true
    }
    this.logger.debug('[airing] AniList 查询失败（本次不判定完结）: %s', errorMessage(error))
    this.http.hintOnFailure(error)
    return false
  }

  /**
   * 取一批数据。返回 `null` 表示「这次不该继续请求」（限流冷却或服务不可用），
   * 空数组表示「请求成功但没有匹配的条目」。
   */
  private async fetchBatch(ids: number[]): Promise<AniListMedia[] | null> {
    try {
      const raw = await this.http.post<unknown>(ANILIST_API_URL, {
        query: QUERY,
        variables: { ids },
      }, { timeout: 20000 })
      const payload = unwrapPayload(raw) as { data?: { Page?: { media?: AniListMedia[] } } } | null
      return payload?.data?.Page?.media ?? []
    } catch (error) {
      return this.handleRequestError(error) ? null : []
    }
  }
}

