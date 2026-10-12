import type { Context, Logger } from 'koishi'
import { ANILIST_API_URL, BANGUMI_API_HOST } from '../constants'
import type { HttpClient } from './network'
import type { Localizer } from './localizer'
import { debugLog, errorMessage, unwrapPayload } from '../utils'

/**
 * 单部作品的详情，供 `anime.info` 展示。
 *
 * 与 `DigestItem` 的区别：那个是「某一场播出」的条目，这里是**作品本身**，
 * 因此带上简介、标签、逐集进度这些只在详情页才有意义的信息。
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
   * 连载状态。
   *
   * 判定优先用 AniList（它对在播作品给 `RELEASING`），AniList 没有时按首末集日期推算。
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
 * 与 `DigestService` 分开是因为它服务于**交互式查询**（用户主动查一部），
 * 而推送表走的是批量路径，两者的取数策略不同：这里只取一部，值得发
 * `/v0/subjects/{id}` + `/v0/episodes` + 一次 AniList 查询。
 *
 * ## 为什么逐集档期值得单独取
 *
 * 它是第三个请求，但换来的信息只在详情里有意义：**已播到第几话**、**最终话是哪天**。
 * 推送表可以靠推算，而用户主动查一部时，"播完了没有""还剩几话"正是最想知道的。
 */
export class InfoService {
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
   * @param bgmId Bangumi 条目 ID，由调用方从搜索索引里取得
   */
  async fetch(bgmId: number, subscribed = false): Promise<SubjectInfo | null> {
    const subject = await this.fetchSubject(bgmId)
    if (!subject) return null

    const episodes = await this.fetchEpisodes(bgmId)
    const state = await this.fetchAniListState(subject.name)

    return this.build(subject, episodes, state, subscribed)
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

  /** 按标题问一次 AniList，主要为了拿到在播状态与下一话时刻 */
  private async fetchAniListState(title: string): Promise<AniListState | null> {
    const query = `query ($search: String) {
      Media(search: $search, type: ANIME) {
        status episodes format
        nextAiringEpisode { episode airingAt }
        endDate { year month day }
      }
    }`
    try {
      const raw = await this.http.post<unknown>(ANILIST_API_URL, { query, variables: { search: title } })
      // GraphQL 的响应体是 `{ data: { Media } }`，与 `airing.ts` 同样要下探两层
      const payload = unwrapPayload(raw) as { data?: { Media?: AniListState } } | null
      const media = payload?.data?.Media
      if (!media) {
        this.logger.warn('[info] AniList 未匹配到「%s」', title)
        return null
      }
      return media
    } catch (error) {
      // AniList 取不到不影响主体信息，状态退化为按日期推算
      this.logger.warn('[info] AniList 查询「%s」失败: %s', title, errorMessage(error))
      return null
    }
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
   * 总话数。
   *
   * **优先用逐集列表的实际长度**：`total_episodes` 统计的是整部作品（含后续季），
   * 而 `eps` 是 Bangumi 维护者填的预期话数，两者都可能与逐集列表对不上。
   * 逐集列表是"确实存在这些集"，最可信。
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
   * 评分：与推送表同一套算法（由 `rating.count` 算算术平均，两位小数）。
   *
   * 复算而不是共用 `computeScore`，是因为那个函数在 `localizer.ts` 里是私有的；
   * 逻辑只有几行，重复比把私有实现导出更干净。
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
   * 连载状态。
   *
   * AniList 优先——它对在播作品会给 `RELEASING`，比按日期推算可靠（延期、停播都能反映）。
   * 没有 AniList 数据时退回日期推算：末集已过就是完结，首集未到就是未开播。
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
   * 挑展示用的标签。
   *
   * Bangumi 的热门标签里常混着「TV」「2026」这类**与类型/首播重复**的项——这两条
   * 已经在标签行里单独给出了，再出现一次只是占位置。年份标签（`2026年10月`）保留，
   * 它比纯数字更能说明档期。按原始热度顺序取前 6 个。
   */
  private pickTags(subject: BgmSubject): string[] {
    const type = (subject.platform || this.platformOf(subject.type)).toUpperCase()
    const out: string[] = []
    for (const tag of subject.tags ?? []) {
      const name = tag.name?.trim()
      if (!name) continue
      if (name.toUpperCase() === type) continue
      if (/^\d{4}$/.test(name)) continue
      if (!out.includes(name)) out.push(name)
      if (out.length >= 6) break
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
 * 简介拍平成单段。
 *
 * Bangumi 的简介里常有换行与全角空格缩进，直接画到卡片上会出现长短不一的空行；
 * 折行交给渲染层按像素宽度处理。
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
