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
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type { Context, Logger } from 'koishi'
import type { AiringState, AniListStatus } from '../types'
import {
  ANILIST_API_URL,
  ANILIST_BATCH_SIZE,
  ANILIST_COOLDOWN_MS,
  ANILIST_ID_CACHE_FILE,
  ANILIST_ID_CACHE_VERSION,
  ANILIST_MIN_INTERVAL_MS,
  DATA_DIR,
} from '../constants'
import { errorMessage, errorStatus, unwrapPayload } from '../utils'
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

const MEDIA_FIELDS = `
      id
      status
      episodes
      startDate { year month day }
      endDate { year month day }
      airingSchedule(perPage: 50) { nodes { episode airingAt } }
      nextAiringEpisode { episode airingAt }
      coverImage { extraLarge large }
`

const QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: ${ANILIST_BATCH_SIZE}) {
    media(id_in: $ids, type: ANIME) {
      ${MEDIA_FIELDS}
    }
  }
}`

/**
 * 按标题搜索候选，用于给「bangumi-data 没带 `aniList` ID」的条目补 ID。
 * 多出的 `title` 与 `synonyms` 供匹配使用，`startDate` 与 `airingSchedule` 用于双重校验。
 * 带上与状态查询相同的字段，命中后可以直接构出 `AiringState`，不必再单独查一次。
 */
const SEARCH_FIELDS = `
      ${MEDIA_FIELDS}
      title { native romaji english }
      synonyms
`

/** 一次标题搜索最多看几个候选 */
const SEARCH_LIMIT = 8

/**
 * 用 GraphQL alias 把多个标题搜索塞进一次请求。
 *
 * AniList 的 `Page.media(search:)` 一次只能搜一个标题；逐部调用时，排队最小间隔
 * （`ANILIST_MIN_INTERVAL_MS`）会把 8 部作品拖成约 10 秒。alias 让它们共享一次请求和
 * 一次排队等待，请求数从 N 降到 1。
 */
function buildSearchQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, index) => `$s${index}: String`).join(', ')
  const pages = Array.from({ length: count }, (_, index) => (
    `q${index}: Page(page: 1, perPage: ${SEARCH_LIMIT}) { media(search: $s${index}, type: ANIME) { ${SEARCH_FIELDS} } }`
  )).join('\n  ')
  return `query (${variables}) {\n  ${pages}\n}`
}

/** 状态查询与标题搜索合并成一次请求，前者用 `statuses` alias，后者用 `q0...` */
function buildCombinedQuery(titleCount: number, withStatus: boolean): string {
  const variables: string[] = []
  if (withStatus) variables.push('$ids: [Int]')
  for (let index = 0; index < titleCount; index++) variables.push(`$s${index}: String`)
  const parts: string[] = []
  if (withStatus) {
    parts.push(
      `statuses: Page(page: 1, perPage: ${ANILIST_BATCH_SIZE}) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } }`,
    )
  }
  for (let index = 0; index < titleCount; index++) {
    parts.push(
      `q${index}: Page(page: 1, perPage: ${SEARCH_LIMIT}) { media(search: $s${index}, type: ANIME) { ${SEARCH_FIELDS} } }`,
    )
  }
  return `query (${variables.join(', ')}) {\n  ${parts.join('\n  ')}\n}`
}

/**
 * 每个进程最多按标题搜索多少部作品。额度按**作品数**而不是请求数计：现在一次 GraphQL
 * 请求可带多个 alias，但「整季总共要新认识多少部」才是真正需要控制的量。
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
  /** 标题 → ID 映射的落盘路径 */
  private readonly idCachePath: string
  private idLoaded = false
  private idLoadPromise: Promise<void> | null = null
  private idDirty = false
  private idSavePromise: Promise<void> | null = null
  private idSaveTimer: (() => void) | null = null
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
  ) {
    this.idCachePath = resolve(ctx.baseDir, ...DATA_DIR, ANILIST_ID_CACHE_FILE)
  }

  /** 当前是否处于限流冷却中 */
  get coolingDown(): boolean {
    return Date.now() < this.cooldownUntil
  }

  /** 载入标题 → ID 映射；只读一次，供标题搜索复用 */
  ensure(): Promise<void> {
    if (this.idLoaded) return Promise.resolve()
    if (!this.idLoadPromise) this.idLoadPromise = this.loadIds()
    return this.idLoadPromise
  }

  /**
   * 只持久化「标题键 → 数字 ID」，不落盘 AniList 状态、排期或封面。
   * 这样重启后不必重新做标题搜索，同时不把 AniList 当数据存储服务使用。
   */
  private async loadIds(): Promise<void> {
    try {
      const text = await fs.readFile(this.idCachePath, 'utf8')
      const parsed = JSON.parse(text) as { version?: number; entries?: Record<string, unknown> }
      if (parsed?.version === ANILIST_ID_CACHE_VERSION && parsed.entries) {
        for (const [key, value] of Object.entries(parsed.entries)) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            this.idByTitle.set(key, Math.trunc(value))
          }
        }
        this.logger.debug('[airing] 标题 ID 映射载入完成，条目数: %d', this.idByTitle.size)
      } else if (parsed) {
        this.logger.info('[airing] 标题 ID 映射版本 %s 与当前 %d 不符，重新收集', parsed.version ?? '(无)', ANILIST_ID_CACHE_VERSION)
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger.warn('[airing] 读取标题 ID 映射失败，将重新收集:', error)
      }
    } finally {
      this.idLoaded = true
    }
  }

  /** 记录一次标题匹配；只有命中时标记脏数据并延迟落盘 */
  private rememberId(key: string, id: number | null): void {
    this.idByTitle.set(key, id)
    if (id !== null) {
      this.idDirty = true
      this.scheduleSave()
    }
  }

  private scheduleSave(): void {
    if (this.idSaveTimer) return
    this.idSaveTimer = this.ctx.setTimeout(() => {
      this.idSaveTimer = null
      void this.save()
    }, 3000)
  }

  /** 把标题映射写回磁盘；dispose 时会再调用一次 */
  async save(): Promise<void> {
    if (!this.idDirty) return
    if (this.idSavePromise) return this.idSavePromise
    this.idDirty = false
    this.idSavePromise = (async () => {
      try {
        const entries: Record<string, number> = {}
        for (const [key, id] of this.idByTitle) {
          if (id !== null) entries[key] = id
        }
        await fs.mkdir(dirname(this.idCachePath), { recursive: true })
        const tmp = `${this.idCachePath}.tmp`
        await fs.writeFile(tmp, JSON.stringify({ version: ANILIST_ID_CACHE_VERSION, entries }), 'utf8')
        await fs.rename(tmp, this.idCachePath)
      } catch (error) {
        this.idDirty = true
        this.logger.debug('[airing] 保存标题 ID 映射失败: %s', errorMessage(error))
      } finally {
        this.idSavePromise = null
      }
    })()
    return this.idSavePromise
  }

  private isFresh(entry: AiringState, ttlDays: number, now = Date.now()): boolean {
    return now - entry.cachedAt < Math.max(0, ttlDays) * 24 * 60 * 60 * 1000
  }

  /**
   * 标题缓存键。
   *
   * 不能只用折叠标题：`normalizeTitle` 会删掉「第 2 期」这类季别，不同季的同名作品
   * 会命中同一个 ID。把开播日期（取 `beginMs`，缺失时用 `broadcastMs`）按天拼进去，
   * 同名但不同季/不同年的作品就能区分开。
   */
  private titleKey(target: MatchTarget): string {
    const title = normalizeTitle(target.title)
    if (!title) return ''
    const anchor = target.beginMs ?? target.broadcastMs ?? null
    return anchor === null ? title : `${title}@${Math.floor(anchor / 86400000)}`
  }

  /**
   * 按标题给缺失 `aniList` ID 的条目补一个 ID：补上就用 AniList 的逐話時刻排期，搜不到返回
   * null 让调用方退回周期推算。结果（含「搜不到」）在进程内缓存。
   * 校验交给 `matchByTitle`：标题相等 + 首播日期相近，缺一不可。
   */
  async resolveByTitle(target: MatchTarget): Promise<number | null> {
    const [id] = await this.resolveByTitleBatch([target])
    return id ?? null
  }

  /**
   * 批量按标题补 AniList ID。返回值与 `targets` 等长；缓存命中、额度耗尽或请求失败的位置为 null。
   * 一次 GraphQL 请求最多处理本次构建的 `TITLE_SEARCH_LIMIT` 部，见 `buildSearchQuery`。
   */
  async resolveByTitleBatch(targets: MatchTarget[]): Promise<(number | null)[]> {
    await this.ensure()
    const keys = targets.map((target) => this.titleKey(target))
    const readCache = () => keys.map((key) => (key ? this.idByTitle.get(key) ?? null : null))
    const result = readCache()
    if (!targets.length || this.coolingDown) return result

    const pending: { key: string; target: MatchTarget }[] = []
    const seen = new Set<string>()
    for (let index = 0; index < targets.length; index++) {
      const key = keys[index]
      if (!key || this.idByTitle.has(key) || seen.has(key)) continue
      if (this.titleSearches + pending.length >= TITLE_SEARCH_BUDGET) break
      seen.add(key)
      pending.push({ key, target: targets[index] })
    }
    if (!pending.length) return result
    this.titleSearches += pending.length

    const started = Date.now()
    const media = await this.enqueue(() => this.searchByTitleBatch(pending.map((item) => item.target.title)))
    if (!media) return result // 限流或服务不可用，本次不补

    let hits = 0
    pending.forEach((item, index) => {
      const candidates = media[index]
      // 整批失败或单个 alias 缺失时保持未缓存，留给后续构建重试
      if (candidates === null) return
      const matched = matchByTitle(item.target, candidates)
      const id = matched?.candidate.id ?? null
      this.rememberId(item.key, id)
      if (id !== null) {
        hits++
        this.logger.debug(
          '[airing] 按标题补上 AniList ID: %s → #%d（首播差 %s 天，时刻差 %s 小时）',
          item.target.title,
          id,
          matched?.dayGap?.toFixed(0) ?? '?',
          matched?.hourGap?.toFixed(1) ?? '?',
        )
      }
    })
    this.logger.debug(
      '[airing] 标题搜索: 请求 %d 部，命中 %d 部（%dms）',
      pending.length,
      hits,
      Date.now() - started,
    )
    return readCache()
  }

  /**
   * 一次请求搜多个标题；成功但没有候选的 alias 返回 []，请求/解析失败返回 null。
   * 部分 alias 缺失（GraphQL 局部错误）也返回 null，避免把临时失败当成「确定搜不到」缓存。
   */
  private async searchByTitleBatch(titles: string[]): Promise<(MatchCandidate[] | null)[] | null> {
    try {
      const variables = Object.fromEntries(titles.map((title, index) => [`s${index}`, title]))
      const raw = await this.http.post<unknown>(ANILIST_API_URL, {
        query: buildSearchQuery(titles.length),
        variables,
      }, { timeout: 20000 })
      const payload = unwrapPayload(raw) as {
        data?: Record<string, { media?: MatchCandidate[] }> | null
      } | null
      const data = payload?.data
      if (!data) return null
      return titles.map((_, index) => {
        const page = data[`q${index}`]
        if (!page) return null
        return Array.isArray(page.media) ? page.media : []
      })
    } catch (error) {
      this.handleRequestError(error)
      return null
    }
  }

  /**
   * 批量取 AniList 状态，未命中的 ID 不会出现在结果里（调用方按「取不到就不判定」处理）。
   *
   * @param now 判定「已播出到第几话」的基准时刻。由调用方注入而非就地取 `Date.now()`，
   *   否则同一份数据在两次构建之间会得到不同的 `airedEpisodes`，快照无法复现。
   */
  /** 把 ID 分成「已有缓存」与「需要请求」两组；过期条目也先返回旧值 */
  private collectStates(
    aniListIds: number[],
    ttlDays: number,
    now: number,
  ): { result: Map<number, AiringState>; wanted: number[] } {
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
      result.set(id, cached)
      if (!this.isFresh(cached, ttlDays, now)) wanted.push(id)
    }
    return { result, wanted }
  }

  /**
   * 批量取 AniList 状态，未命中的 ID 不会出现在结果里（调用方按「取不到就不判定」处理）。
   *
   * @param now 判定「已播出到第几话」的基准时刻。由调用方注入而非就地取 `Date.now()`，
   *   否则同一份数据在两次构建之间会得到不同的 `airedEpisodes`，快照无法复现。
   */
  async resolve(aniListIds: number[], ttlDays: number, now = Date.now()): Promise<Map<number, AiringState>> {
    await this.ensure()
    const { result, wanted } = this.collectStates(aniListIds, ttlDays, now)
    if (!wanted.length) return result

    if (this.coolingDown) {
      this.logger.debug('[airing] 处于限流冷却中，本次不查询（复用已有缓存 %d 条）', result.size)
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
    this.logger.debug(
      '[airing] 拉取 AniList 数据: 请求 %d 部，成功 %d 部，缓存命中 %d 部 (%dms)',
      wanted.length,
      ok,
      result.size - ok,
      Date.now() - started,
    )
    return result
  }

  /**
   * 一次请求同时完成：已知 ID 的状态查询 + 缺失 ID 的标题搜索。
   *
   * 返回 `titleIds` 与 `targets` 等长，供调用方把新 ID 写回索引条目；`states` 包含
   * 已知 ID 与搜索命中 ID 的状态。超过 50 部的状态会退回普通 `resolve()` 再补一批。
   */
  async resolveWithTitleSearch(
    aniListIds: number[],
    targets: MatchTarget[],
    ttlDays: number,
    now = Date.now(),
  ): Promise<{ states: Map<number, AiringState>; titleIds: (number | null)[] }> {
    await this.ensure()
    const keys = targets.map((target) => this.titleKey(target))
    const readTitleIds = () => keys.map((key) => (key ? this.idByTitle.get(key) ?? null : null))
    const cachedTitleIds = readTitleIds().filter((id): id is number => id !== null)
    // 已落盘的标题映射也要一起取状态，否则条目只有 ID 没有状态，闸门 2 无法判定
    const allIds = [...new Set([...aniListIds, ...cachedTitleIds])]
    const { result: states, wanted } = this.collectStates(allIds, ttlDays, now)

    const pending: { key: string; target: MatchTarget }[] = []
    const seen = new Set<string>()
    for (let index = 0; index < targets.length; index++) {
      const key = keys[index]
      if (!key || this.idByTitle.has(key) || seen.has(key)) continue
      if (this.titleSearches + pending.length >= TITLE_SEARCH_BUDGET) break
      seen.add(key)
      pending.push({ key, target: targets[index] })
    }
    if (!wanted.length && !pending.length) return { states, titleIds: readTitleIds() }
    if (this.coolingDown) return { states, titleIds: readTitleIds() }
    if (!pending.length) {
      return { states: await this.resolve(allIds, ttlDays, now), titleIds: readTitleIds() }
    }
    this.titleSearches += pending.length

    const first = wanted.slice(0, ANILIST_BATCH_SIZE)
    const rest = wanted.slice(ANILIST_BATCH_SIZE)
    const started = Date.now()
    const payload = await this.enqueue(() => this.fetchCombined(first, pending.map((item) => item.target.title)))
    if (!payload) return { states, titleIds: readTitleIds() }

    for (const item of payload.statuses) {
      const entry = this.toState(item, now)
      if (!entry) continue
      this.remember(entry)
      states.set(entry.aniListId, entry)
    }

    let hits = 0
    const needStatus: number[] = []
    pending.forEach((item, index) => {
      const candidates = payload.titles[index]
      if (candidates === null) return
      const matched = matchByTitle(item.target, candidates)
      const id = matched?.candidate.id ?? null
      this.rememberId(item.key, id)
      if (id === null) return
      hits++
      // 搜索字段与状态查询字段一致，命中后可以直接构状态；个别解析失败再补查一次
      const state = matched?.candidate ? this.toState(matched.candidate as unknown as AniListMedia, now) : null
      if (state) {
        this.remember(state)
        states.set(state.aniListId, state)
      } else if (!states.has(id)) {
        needStatus.push(id)
      }
    })
    this.logger.debug(
      '[airing] 合并查询: 状态 %d 部，标题 %d 部，命中 %d 部（%dms）',
      first.length,
      pending.length,
      hits,
      Date.now() - started,
    )

    const followup = [...new Set([...rest, ...needStatus])].filter((id) => !states.has(id))
    if (followup.length) {
      const extra = await this.resolve(followup, ttlDays, now)
      for (const [id, state] of extra) states.set(id, state)
    }
    return { states, titleIds: readTitleIds() }
  }

  /** 合并查询：statuses alias + 每个标题一个 qN alias；返回原始 media 列表 */
  private async fetchCombined(
    ids: number[],
    titles: string[],
  ): Promise<{ statuses: AniListMedia[]; titles: (MatchCandidate[] | null)[] } | null> {
    try {
      const variables: Record<string, unknown> = {}
      if (ids.length) variables.ids = ids
      titles.forEach((title, index) => { variables[`s${index}`] = title })
      const raw = await this.http.post<unknown>(ANILIST_API_URL, {
        query: buildCombinedQuery(titles.length, ids.length > 0),
        variables,
      }, { timeout: 20000 })
      const payload = unwrapPayload(raw) as {
        data?: Record<string, { media?: MatchCandidate[] | AniListMedia[] }> | null
      } | null
      const data = payload?.data
      if (!data) return null
      return {
        statuses: (data.statuses?.media as AniListMedia[] | undefined) ?? [],
        titles: titles.map((_, index) => {
          const page = data[`q${index}`]
          if (!page) return null
          return Array.isArray(page.media) ? page.media as MatchCandidate[] : []
        }),
      }
    } catch (error) {
      this.handleRequestError(error)
      return null
    }
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

