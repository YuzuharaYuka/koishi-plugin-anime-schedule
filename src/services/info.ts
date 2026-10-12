import type { Context, Logger } from 'koishi'
import {
  ANILIST_API_URL,
  ANILIST_BATCH_SIZE,
  ANILIST_MIN_INTERVAL_MS,
  BANGUMI_API_HOST,
} from '../constants'
import type { HttpClient } from './network'
import type { Localizer } from './localizer'
import { debugLog, errorMessage, errorStatus, mapLimit, unwrapPayload } from '../utils'

/** nime.info 里 AniList 状态的缓存时长；详情页的状态不需要秒级新鲜 */
const INFO_ANILIST_TTL_MS = 10 * 60 * 1000

/** 详情卡的取数并发。Bangumi 文档限 1 请求/秒，不宜更高 */
export const INFO_FETCH_CONCURRENCY = 4

/** AniList 收到 429/403 后的冷却时长，与 `airing.ts` 同策略 */
const ANILIST_COOLDOWN_MS = 5 * 60 * 1000

/** 等待若干毫秒；用于批次之间保持最小间隔 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** AniList 状态的缓存键：有 ID 用 ID，否则退回标题 */
function anilistKey(aniListId: number | string): string {
  return typeof aniListId === 'number' ? `id:${aniListId}` : aniListId
}

/**
 * 单部作品的详情，供 `anime.info` 展示。与 `DigestItem`（「某一场播出」的条目）不同，这里是
 * **作品本身**，因此带上简介、标签、逐集进度这些只在详情页才有意义的信息。
 */
export interface SubjectInfo {
  /** Bangumi 条目 ID；从关键词查到而没有 ID 时为 null */
  bgmId: number | null
  /** 主标题：中文名优先，缺失回落日文原名 */
  name: string
  /** 副标题：日文原名（与主标题相同时为空） */
  original: string
  coverUrl: string
  /** 简介，已按段落拍平成单段 */
  summary: string
  /** 类型，如 TV / OVA / WEB */
  type: string
  /** 首播日期 `YYYY-MM-DD`，未知为 null */
  date: string | null
  /** 首播时刻的本地化文案，如 `2023/9/29周五 23:00` */
  airLabel: string
  /** 评分（两位小数）与评价人数 */
  score: number | null
  ratingTotal: number | null
  /** 1~10 各分数段人数，用于画评分分布 */
  scoreCount: Record<string, number> | null
  /** 标签，已按热度排序 */
  tags: string[]
  /** 总话数（本季），null 表示未知 */
  totalEpisodes: number | null
  /** 已播出话数 */
  airedEpisodes: number | null
  /** 最终话播出日 `YYYY-MM-DD`，未知为 null */
  endDate: string | null
  /**
   * 连载状态。判定优先用 AniList（它对在播作品给 `RELEASING`），AniList 没有时按首末集日期推算。
   */
  status: 'airing' | 'finished' | 'upcoming' | 'unknown'
  /** 下一话的时刻（本地化文案）与话数，仅在连载中时有值 */
  nextEpisode: { label: string; episode: number } | null
  /** 逐集的播出日，索引 0 对应第 1 话；拿不到逐集档期时为空数组 */
  episodeDates: (string | null)[]
  /** 订阅该作品的群数，用于「已订阅」提示 */
  subscribed: boolean
}

/** Bangumi `/v0/subjects/{id}` 的响应 */
interface BgmSubject {
  id: number
  name: string
  name_cn?: string
  date?: string
  platform?: string
  eps?: number
  total_episodes?: number
  summary?: string
  tags?: { name: string; count: number }[]
  rating?: { score?: number; total?: number; count?: Record<string, number> }
  images?: { large?: string; common?: string; medium?: string } | null
  type?: number
}

/** 详情卡最多展示几个题材标签 */
const MAX_TAGS = 10

/** Bangumi `/v0/episodes` 的响应 */
interface BgmEpisodes {
  total?: number
  data?: { sort?: number; airdate?: string; type?: number }[]
}

/** AniList 的状态查询结果，只取判定连载需要的字段 */
interface AniListState {
  status?: string
  episodes?: number | null
  nextAiringEpisode?: { episode?: number; airingAt?: number } | null
  endDate?: { year?: number; month?: number; day?: number } | null
  format?: string
}

/** AniList 对「在播」的表态，与 `airing.ts` 的枚举保持一致 */
const RELEASING = 'RELEASING'

/**
 * 单部作品的详情查询。
 *
 * 与 `DigestService` 分开是因为它服务于**交互式查询**：这里只取一部，值得发
 * `/v0/subjects/{id}` + `/v0/episodes` + 一次 AniList 查询——逐集档期换来的「已播到第几话」与
 * 「最终话是哪天」只在详情里有意义。
 */
export class InfoService {
  /**
   * 按标题缓存的 AniList 状态。
   *
   * 详情卡每次查询都要问一次 AniList，而它是全流程最慢、最容易触发限流的一环
   * （`anime.info <关键词>` 一次可能问几十部）。缓存按标题而不是条目 ID 键控，
   * 因为 AniList 那侧只有标题可查。
   */
  private readonly aniListCache = new Map<string, { at: number; state: AniListState | null }>()

  /** AniList 判定超限后的冷却截止时刻，与 `airing.ts` 同一策略 */
  private aniListCooldownUntil = 0

  constructor(
    private ctx: Context,
    private logger: Logger,
    private http: HttpClient,
    private localizer: Localizer,
    private timeZone: string,
    private messages: { weekdayNames: string[] },
  ) {}

  /**
   * 查一部作品。
   *
   * 条目详情必须最先取（拿不到就直接返回），其余两个数据源互相独立，并发请求：
   * 串行时单部约 1.6s，并发后取决于最慢的一个。
   *
   * @param bgmId Bangumi 条目 ID，由调用方从搜索索引里取得
   * @param subscribed 是否已在订阅列表里
   * @param aniListId 索引里记录的 AniList ID；给出时按 ID 精确查询，省掉一次标题搜索
   */
  async fetch(bgmId: number, subscribed = false, aniListId: number | null = null): Promise<SubjectInfo | null> {
    const subject = await this.fetchSubject(bgmId)
    if (!subject) return null

    const [episodes, state] = await Promise.all([
      this.fetchEpisodes(bgmId),
      this.fetchAniListState(subject.name, aniListId),
    ])

    return this.build(subject, episodes, state, subscribed)
  }

  /**
   * 批量把条目里的 AniList ID 解析成状态，供 `anime.info <关键词>` 一次性补齐。
   *
   * 与逐部 `fetch()` 的差别只在 AniList 这一环：ID 是既定的，可以按 `id_in` 一次问完
   * （每批 `ANILIST_BATCH_SIZE` 个），而不是每部各搜一次标题——后者既慢又容易命中同名作品。
   * 结果写入同一份缓存，随后逐部 `fetch()` 直接命中。
   *
   * @returns AniList ID → 状态；查不到的不在表内
   */
  async prefetchAniListStates(aniListIds: number[]): Promise<void> {
    const wanted = [...new Set(aniListIds.filter((id) => Number.isFinite(id)))]
      .filter((id) => {
        const cached = this.aniListCache.get(anilistKey(id))
        return !cached || Date.now() - cached.at >= INFO_ANILIST_TTL_MS
      })
    if (!wanted.length) return

    for (let offset = 0; offset < wanted.length; offset += ANILIST_BATCH_SIZE) {
      const batch = wanted.slice(offset, offset + ANILIST_BATCH_SIZE)
      // 与 `airing.ts` 同步：AniList 限 30 次/分钟，批次之间留间隔，超限时冷却
      if (offset > 0) await wait(ANILIST_MIN_INTERVAL_MS)
      const query = `query ($ids: [Int]) {
        Page(page: 1, perPage: ${batch.length}) {
          media(id_in: $ids, type: ANIME) {
            id
            status episodes format
            nextAiringEpisode { episode airingAt }
            endDate { year month day }
          }
        }
      }`
      try {
        const raw = await this.http.post<unknown>(ANILIST_API_URL, { query, variables: { ids: batch } })
        const payload = unwrapPayload(raw) as { data?: { Page?: { media?: (AniListState & { id?: number })[] } } } | null
        const media = payload?.data?.Page?.media ?? []
        for (const item of media) {
          if (Number.isFinite(item.id)) this.aniListCache.set(anilistKey(item.id as number), { at: Date.now(), state: item })
        }
        // 没返回的也记一笔，避免同一批里反复重问
        for (const id of batch) {
          if (!this.aniListCache.has(anilistKey(id))) this.aniListCache.set(anilistKey(id), { at: Date.now(), state: null })
        }
      } catch (error) {
        debugLog('[info] AniList 批量查询 %d 个 ID 失败: %s', batch.length, errorMessage(error))
        this.aniListCooldownUntil = Date.now() + ANILIST_COOLDOWN_MS
        return
      }
    }
  }

  private async fetchSubject(id: number): Promise<BgmSubject | null> {
    try {
      return await this.http.get<BgmSubject>(`${BANGUMI_API_HOST}/v0/subjects/${id}`)
    } catch (error) {
      debugLog('[info] 取条目 %d 失败: %s', id, errorMessage(error))
      return null
    }
  }

  private async fetchEpisodes(id: number): Promise<BgmEpisodes | null> {
    try {
      // `type=0` 只要正规集，排除 OP/ED 与 SP
      return await this.http.get<BgmEpisodes>(`${BANGUMI_API_HOST}/v0/episodes?subject_id=${id}&type=0&limit=200`)
    } catch (error) {
      debugLog('[info] 取条目 %d 的逐集档期失败: %s', id, errorMessage(error))
      return null
    }
  }

  /**
   * 取一部作品的 AniList 状态（在播状态与下一话时刻）。
   *
   * 有索引记录的 AniList ID 时按 ID 精确查询，否则退回按标题搜索——后者可能命中
   * 同名的第 2 季或剧场版，只在索引没给 ID 时才用。
   *
   * 结果按「ID 或标题」缓存 `INFO_ANILIST_TTL_MS`，失败结果同样缓存，
   * 避免限流期间反复重试把额度耗尽。
   */
  private async fetchAniListState(title: string, aniListId: number | null = null): Promise<AniListState | null> {
    const key = aniListId === null ? title : anilistKey(aniListId)
    const cached = this.aniListCache.get(key)
    if (cached && Date.now() - cached.at < INFO_ANILIST_TTL_MS) return cached.state

    const fields = `status episodes format
        nextAiringEpisode { episode airingAt }
        endDate { year month day }`
    const byId = aniListId !== null
    const query = byId
      ? `query ($id: Int) { Media(id: $id, type: ANIME) { ${fields} } }`
      : `query ($search: String) { Media(search: $search, type: ANIME) { ${fields} } }`

    let state: AniListState | null = null
    try {
      // 上一批刚被判超限，短时间内不再打，直接退化
      if (Date.now() < this.aniListCooldownUntil) {
        this.aniListCache.set(key, { at: Date.now(), state: null })
        return null
      }
      const raw = await this.http.post<unknown>(ANILIST_API_URL, {
        query,
        variables: byId ? { id: aniListId } : { search: title },
      })
      // GraphQL 的响应体是 `{ data: { Media } }`，与 `airing.ts` 同样要下探两层
      const payload = unwrapPayload(raw) as { data?: { Media?: AniListState } } | null
      state = payload?.data?.Media ?? null
      if (!state) this.logger.warn('[info] AniList 未匹配到「%s」', title)
    } catch (error) {
      // AniList 取不到不影响主体信息，状态退化为按日期推算
      this.logger.warn('[info] AniList 查询「%s」失败: %s', title, errorMessage(error))
      const status = errorStatus(error)
      if (status === 429 || status === 403) this.aniListCooldownUntil = Date.now() + ANILIST_COOLDOWN_MS
    }
    this.aniListCache.set(key, { at: Date.now(), state })
    return state
  }

  /** 把三份响应合成展示用的结构 */
  private build(
    subject: BgmSubject,
    episodes: BgmEpisodes | null,
    state: AniListState | null,
    subscribed: boolean,
  ): SubjectInfo {
    const totalEpisodes = this.resolveTotal(subject, episodes)
    const episodeDates = this.resolveEpisodeDates(episodes)
    const airedEpisodes = this.countAired(episodeDates)
    const endDate = episodeDates.length ? (episodeDates[episodeDates.length - 1] ?? null) : null

    return {
      bgmId: subject.id,
      name: subject.name_cn?.trim() || subject.name,
      original: subject.name_cn?.trim() && subject.name_cn.trim() !== subject.name ? subject.name : '',
      coverUrl: subject.images?.large ?? subject.images?.common ?? subject.images?.medium ?? '',
      summary: flattenSummary(subject.summary),
      type: (subject.platform || this.platformOf(subject.type)).toUpperCase(),
      date: subject.date ?? null,
      airLabel: this.airLabelOf(subject.date),
      score: this.resolveScore(subject),
      ratingTotal: subject.rating?.total ?? null,
      scoreCount: subject.rating?.count ?? null,
      tags: this.pickTags(subject),
      totalEpisodes,
      airedEpisodes,
      endDate,
      status: this.resolveStatus(subject, airedEpisodes, totalEpisodes, endDate, state),
      nextEpisode: this.resolveNext(state, subject.date),
      episodeDates,
      subscribed,
    }
  }

  /**
   * 总话数。**优先用逐集列表的实际长度**：`total_episodes` 统计的是整部作品（含后续季），
   * 而 `eps` 是 Bangumi 维护者填的预期话数，两者都可能与逐集列表对不上。
   */
  private resolveTotal(subject: BgmSubject, episodes: BgmEpisodes | null): number | null {
    const listed = episodes?.data?.length ?? 0
    if (listed > 1) return listed
    const eps = Number(subject.eps)
    if (Number.isFinite(eps) && eps > 0) return eps
    const total = Number(subject.total_episodes)
    if (Number.isFinite(total) && total > 0) return total
    return null
  }

  /** 逐集播出日，按话数排序后取 `airdate` */
  private resolveEpisodeDates(episodes: BgmEpisodes | null): (string | null)[] {
    const list = (episodes?.data ?? [])
      .filter((item) => typeof item.sort === 'number' && (item.sort ?? 0) > 0)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    return list.map((item) => item.airdate?.trim() || null)
  }

  /** 已播出话数：播出日不晚于今天的最后一集 */
  private countAired(dates: (string | null)[]): number | null {
    if (!dates.length) return null
    const today = new Date().toISOString().slice(0, 10)
    let aired = 0
    for (const date of dates) {
      if (date && date <= today) aired++
    }
    return aired
  }

  /**
   * 评分：与推送表同一套算法（由 `rating.count` 算算术平均，两位小数）。这里复算而不是共用
   * `computeScore`，是因为那个函数在 `localizer.ts` 里是私有的，逻辑只有几行。
   */
  private resolveScore(subject: BgmSubject): number | null {
    const count = subject.rating?.count
    if (count) {
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
    return typeof subject.rating?.score === 'number' ? subject.rating.score : null
  }

  /**
   * 连载状态。AniList 优先——它对在播作品会给 `RELEASING`，比按日期推算可靠（延期、停播都能
   * 反映）；没有 AniList 数据时退回日期推算：末集已过就是完结，首集未到就是未开播。
   */
  private resolveStatus(
    subject: BgmSubject,
    aired: number | null,
    total: number | null,
    endDate: string | null,
    state: AniListState | null,
  ): SubjectInfo['status'] {
    if (state?.status === RELEASING) return 'airing'
    if (state?.status === 'FINISHED') return 'finished'
    if (state?.status === 'NOT_YET_RELEASED') return 'upcoming'

    const first = subject.date ?? null
    const today = new Date().toISOString().slice(0, 10)
    if (first && first > today) return 'upcoming'
    if (endDate && endDate < today) return 'finished'
    if (total !== null && aired !== null && aired >= total) return 'finished'
    if (first && first <= today) return 'airing'
    return 'unknown'
  }

  /** 下一话：AniList 给的是 epoch 秒，转成本地时区的文案 */
  private resolveNext(state: AniListState | null, fallbackDate?: string): SubjectInfo['nextEpisode'] {
    const next = state?.nextAiringEpisode
    if (typeof next?.airingAt === 'number' && typeof next.episode === 'number') {
      const ms = next.airingAt * 1000
      return { label: this.formatMoment(ms), episode: next.episode }
    }
    return null
  }

  private formatMoment(ms: number): string {
    const date = new Date(ms + this.offsetMs(ms))
    const weekday = this.messages.weekdayNames[date.getUTCDay()] ?? ''
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}${weekday} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  }

  /** 首播时刻的文案，只有日期没有时刻时去掉了时间部分 */
  private airLabelOf(date?: string): string {
    if (!date) return ''
    const ms = Date.parse(`${date}T00:00:00Z`)
    if (!Number.isFinite(ms)) return date
    const local = new Date(ms + this.offsetMs(ms))
    const weekday = this.messages.weekdayNames[local.getUTCDay()] ?? ''
    return `${local.getUTCFullYear()}/${local.getUTCMonth() + 1}/${local.getUTCDate()}${weekday}`
  }

  /** 时区偏移，用来把 UTC 毫秒转成本地日历字段 */
  private offsetMs(ms: number): number {
    try {
      const text = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date(ms))
      const parsed = Date.parse(`${text.replace(',', '')} UTC`)
      return Number.isFinite(parsed) ? parsed - ms : 0
    } catch {
      return 0
    }
  }

  /**
   * 挑展示用的标签。先剔掉**与已展示信息重复**的项，再按原始热度取前几个：
   * `TV` 这类与类型重复（类型已在标签行首位单独给出），纯年份与 `2026年10月` 这类档期标签
   * 与首播时间重复且更模糊。
   */
  private pickTags(subject: BgmSubject): string[] {
    const type = (subject.platform || this.platformOf(subject.type)).toUpperCase()
    const out: string[] = []
    for (const tag of subject.tags ?? []) {
      const name = tag.name?.trim()
      if (!name) continue
      if (name.toUpperCase() === type) continue
      // 纯年份，或 `2026年10月` / `2026年` 这类档期标签
      if (/^\d{4}(年\d{1,2}月?)?$/.test(name)) continue
      if (!out.includes(name)) out.push(name)
      if (out.length >= MAX_TAGS) break
    }
    return out
  }

  /** Bangumi 的 `type` 数字编码，仅在 `platform` 缺失时兜底 */
  private platformOf(type?: number): string {
    switch (type) {
      case 1: return 'book'
      case 2: return 'anime'
      case 3: return 'music'
      case 4: return 'game'
      case 6: return 'real'
      default: return ''
    }
  }
}

/**
 * 简介拍平成单段。Bangumi 的简介里常有换行与全角空格缩进，直接画到卡片上会出现长短不一的
 * 空行；折行交给渲染层按像素宽度处理。
 */
function flattenSummary(summary?: string): string {
  if (!summary) return ''
  return summary
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('')
}
