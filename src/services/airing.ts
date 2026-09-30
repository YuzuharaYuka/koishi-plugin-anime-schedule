/**
 * AniList 播出数据查询。
 *
 * 「这部番还在播吗」「第几話什么时候播」两个问题都需要**外部权威数据**：靠 bangumi-data
 * 的周期规则推算无法区分「已完结」与「停更一周」，也无法表达首周多集连播。
 *
 * AniList 直接给出：
 * - `airingSchedule`：**已播出与未播出的每一話及其时刻**（默认含未来场次）；
 * - `nextAiringEpisode`：下一話；
 * - `status` / `episodes` / `startDate` / `endDate`。
 *
 * 而 bangumi-data 自带 `aniList` 的条目 ID（约 8300 部），因此可以按 ID 精确查询、
 * 完全避开标题匹配的歧义。
 *
 * ## 缓存策略：只在内存里
 *
 * AniList 的[使用条款](https://docs.anilist.co/guide/terms-of-use)明确禁止把它当作
 * 「备份或数据存储服务」，也禁止批量囤积数据。因此**不落盘**：缓存只存在于进程内存中，
 * 重启即失效。代价很小——一次整季查询只需 3 次请求，日常一轮推送 2~4 次。
 *
 * ## 速率限制
 *
 * 官方文档写 90 次/分钟，但**实测响应头是 `x-ratelimit-limit: 30`**（文档也标注 API
 * 处于降级状态）。另有突发限流。超限会 429 并封禁 1 分钟，严重故障时整个 API 会返回
 * 403。因此这里做两件事：**串行 + 最小间隔**地发请求，以及收到 429 后**进入冷却**，
 * 冷却期内直接返回已有缓存，不再发请求。
 */
import type { Context, Logger } from 'koishi'
import type { AiringState, AniListStatus } from '../types'
import { ANILIST_API_URL, ANILIST_BATCH_SIZE, ANILIST_MIN_INTERVAL_MS } from '../constants'
import { debugLog, errorMessage, unwrapPayload } from '../utils'
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
 *
 * 返回的字段比按 ID 查询多出 `title` 与 `synonyms`，因为匹配要靠标题；
 * `startDate` 与 `airingSchedule` 用来做双重校验，避免匹配到同名的不同季。
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
 * 每个进程最多按标题搜索多少次。
 *
 * 按标题搜索只能一次一个请求（AniList 没有批量接口），而一次构建会调用
 * `airingStatesOf` 多次（每个构建入口一次），若只按「每次调用」限量，
 * 一次构建就可能发出几十个请求。这里改成按**进程**限量：搜过的结果（含
 * 「搜不到」）会一直留在内存里，因此这个额度是「整季总共要新认识多少部作品」，
 * 而不是「每次构建多少」。发布版自带离线映射表，正常运行时用不到这么多。
 */
const TITLE_SEARCH_BUDGET = 24

/**
 * 播出数据查询器。
 *
 * 只负责「按 ID 取数据并缓存」；「据此决定怎么排期」由 `DigestService` 负责。
 */
export class AiringStatusService {
  /** 进程内缓存；按 AniList 条款不落盘 */
  private readonly memory = new Map<number, AiringState>()
  /**
   * 标题 → AniList 条目 ID 的补映射结果。
   *
   * 也是进程内缓存：bangumi-data 大约三分之一的条目没带 `aniList` ID，其中一部分
   * 能在 AniList 按标题搜到。搜到之后记录下来，同一进程内不再重复搜索。
   */
  private readonly idByTitle = new Map<string, number | null>()
  /** 已经用掉的标题搜索次数，见 `TITLE_SEARCH_BUDGET` */
  private titleSearches = 0
  private readonly http: HttpClient
  /** 冷却截止时刻：收到 429 后到这时刻之前不再发请求 */
  private cooldownUntil = 0
  /** 上一次请求结束的时刻，用于保证最小间隔 */
  private lastRequestAt = 0
  /** 请求串行化，避免并发触发突发限流 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private ctx: Context,
    private logger: Logger,
  ) {
    this.http = new HttpClient(ctx, logger)
  }

  /** 当前是否处于限流冷却中 */
  get coolingDown(): boolean {
    return Date.now() < this.cooldownUntil
  }

  /** 无需预热（缓存只在内存里），保留此方法让调用方写法统一 */
  ensure(): Promise<void> {
    return Promise.resolve()
  }

  /** 条款要求不落盘，因此没有持久化动作；保留此方法兼容调用方 */
  async save(): Promise<void> {}

  private isFresh(entry: AiringState, ttlDays: number): boolean {
    return Date.now() - entry.cachedAt < ttlDays * 24 * 60 * 60 * 1000
  }

  /**
   * 按标题给缺失 `aniList` ID 的条目补一个 ID。
   *
   * bangumi-data 大约三分之一的条目没带该 ID，其中一部分能在 AniList 按标题搜到。
   * 搜到就用 AniList 的逐話時刻排期，搜不到就返回 null，让调用方退回周期规则的推算。
   *
   * 结果（含「搜不到」）在进程内缓存，同一部作品只搜一次。
   * 校验交给 `matchByTitle`：标题相等 + 首播日期相近，两者缺一不可。
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
   * 批量取回数据，返回「AniList 条目 ID → 数据」。
   *
   * 未命中的 ID 不会出现在结果里；调用方按「取不到就不判定」处理。
   */
  async resolve(aniListIds: number[], ttlDays: number): Promise<Map<number, AiringState>> {
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
        const entry = this.toState(item)
        if (!entry) continue
        ok++
        this.memory.set(entry.aniListId, entry)
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

  private toState(media: AniListMedia): AiringState | null {
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

    const now = Date.now()
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
   * 处理一次失败的请求。
   *
   * 返回 `true` 表示「进入了冷却，调用方应当停止本次查询」（限流或服务被停用）；
   * `false` 表示普通失败，调用方按「取不到就跳过」处理。
   */
  private handleRequestError(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response?.status
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
   * 取一批数据。
   *
   * 返回 `null` 表示「这次不该继续请求」（限流冷却或服务不可用），
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

/** 收到 429 / 403 后的冷却时长 */
const ANILIST_COOLDOWN_MS = 5 * 60 * 1000
