import type { Context, Logger } from 'koishi'
import type { Config } from '../config'
import type {
  AnimeChannel,
  AnimeSubscription,
  Digest,
  DigestGroup,
  DigestItem,
  DigestKind,
  LocalizeCacheEntry,
} from '../types'
import {
  DAILY_OFFSET_MAX,
  DAILY_OFFSET_MIN,
  LATE_NIGHT_END_HOUR,
  MIN_SCORE_VOTES,
  getMessages,
} from '../constants'
import type { AiringState, ScheduledEpisode } from '../types'
import type { AiringStatusService } from './airing'
import { Localizer } from './localizer'
import type { HttpClient } from './network'
import { BangumiDataIndex, type AirCandidate, type IndexEntry } from '../data/bangumi-data'
import {
  SEASON_NAMES,
  addDays,
  formatClock,
  formatDate,
  formatDayLabel,
  getDayStartMs,
  getLocalWeekday,
  getSeasonStartMonth,
  today,
} from '../utils/time'
import { clamp, debugLog, errorMessage } from '../utils'

/** 「本周表」向后覆盖的天数 */
const FOLLOWING_WINDOW_DAYS = 14

/**
 * 「深夜档」的窗口：当晚 21:00 ~ 次日 06:00（按配置时区）。
 * 起点 21:00 是为了收全「今晚这一档」，终点 06:00 是为了覆盖凌晨 5 点档。
 */
const EVENING_START_HOUR = 21

/** 季表匹配 AniList 首播时刻的容差（天）；超出说明那条记录讲的是别的季度，回退索引层时刻。
 *  取 45 天：季表窗口有 10 天提前量，季末提前放送与延期开播都可能偏出两周。 */
const SEASON_AIR_MATCH_DAYS = 45

/** 单次构建最多按标题搜多少条 AniList 补 ID（按标题搜一次只能一个请求，放开会把周表构建
 *  从数秒拖到三分多钟）；只限单次构建，更硬的总额度由 `AiringStatusService` 按进程控制。 */
const TITLE_SEARCH_LIMIT = 8

/** 订阅表的 tid 形如 `bgm:<Bangumi 条目 ID>` */
const BGM_TID_RE = /^bgm:(\d+)$/

/** 采信逐集档期末集日期前，允许它与「第 total 集」推算位置相差的周期数。
 *  预播与停播周偏 1~2 个周期，而跨季乱序会差十几个周期，故取 2。 */
const FINAL_EPISODE_TOLERANCE_PERIODS = 2

/** 判定「已播完」时本场的 JST 日期最多可在终映日之后几天。取 0：一旦终映日过去就不再出现
 *  （终映当天仍保留，当天的场次可能还没播）；AniList 的 FINISHED 本身是权威，加余量只会多留几周。 */
const FINAL_EPISODE_DAY_GRACE = 0

/** 采信 AniList 状态前，允许它的首播日期与我们的排期相差的天数。
 *  用于挡下「`aniList` ID 指向别的季度」的记录，否则会把在播番误杀。 */
const ANILIST_ANCHOR_TOLERANCE_DAYS = 92

/** 判定「上游开播日期写错」的阈值（天）：新一季被挂到旧条目上时，逐集首集与我们的开播
 *  日期会相差数年，而同季校验只会「不采信」并放行。取 180 天覆盖正常跨季与延后开播。 */
const STALE_SEASON_GAP_DAYS = 180

/** 逐集档期跨度相对最小跨度（`(total - 1) × 周期`）允许多出的天数，即停播周的额度；
 *  超出说明逐集列表与当前排期不是同一季。 */
const FINAL_EPISODE_SPAN_SLACK_DAYS = 30

/** 用户也可以直接给纯数字的 Bangumi 条目 ID */
const BGM_ID_RE = /^(\d+)$/

/** 未提供订阅集合时的空集合，避免每处都新建 */
const EMPTY_SETS = new Set<string>()

/** 索引场次对外暴露的 tid；没有 Bangumi 条目 ID 的条目无法订阅 */
function defaultTidOf(entry: IndexEntry): string | null {
  return entry.bangumiId === null ? null : `bgm:${entry.bangumiId}`
}

/** 一次排期查询的取用方式 */
interface AiringsOptions {
  /** 查询区间（UTC 毫秒，左闭右开） */
  fromMs: number
  toMs: number
  /** 是否套用「还在播」过滤，默认开启 */
  activeOnly?: boolean
  /** 每部作品只保留最早的一场 */
  onePerTitle?: boolean
  /** 参考时刻（默认取 `fromMs`），用于判断是否已播完 */
  now?: number
  /** 逐场次的预筛条件，在去重之前生效 */
  filter?: (candidate: AirCandidate) => boolean
}

/**
 * 推送内容构建服务。
 * 播出时刻与集数全部由 bangumi-data 的周期规则推算，构建过程不产生番组表请求。
 */
export class DigestService {
  readonly localizer: Localizer

  constructor(
    private ctx: Context,
    private config: Config,
    logger: Logger,
    readonly index: BangumiDataIndex,
    http: HttpClient,
    /** AniList 播出状态查询；未注入时退化为「按 Bangumi 逐集档期判断」 */
    private airing?: AiringStatusService,
  ) {
    this.localizer = new Localizer(ctx, config, logger, http)
  }

  get timeZone(): string {
    return this.config.timeZone
  }

  private get messages() {
    return getMessages(this.config.locale)
  }

  /** 等索引与本地化缓存就绪 */
  private async prepare(): Promise<void> {
    await Promise.all([this.index.ensure(), this.localizer.ensure()])
  }

  // #region 排期推算

  /**
   * 把索引里的周期规则展开成区间内的播出场次。所有表的唯一数据入口。
   * `filter` 在**去重之前、逐场次**调用，用于把大范围查询先收敛到小集合。
   */
  private airingsIn(options: AiringsOptions): AirCandidate[] {
    const { fromMs, toMs } = options
    const activeOnly = options.activeOnly !== false
    const now = options.now ?? fromMs

    let candidates = this.index.schedule(fromMs, toMs)
    if (options.filter) {
      const before = candidates.length
      const filter = options.filter
      candidates = candidates.filter((candidate) => filter(candidate))
      if (before !== candidates.length) {
        debugLog('[digest] 按条件预筛: %d 场 → %d 场', before, candidates.length)
      }
    }
    if (activeOnly) {
      // 第一道：丢掉「已过最终回」的场次。不可省——`index.schedule()` 把放送周期当**无限重复的
      // 规则**用、不看 `endMs`，一部 1995 年的番在任意窗口里都能推算出一场，不做这道筛就会先造出
      // 上万个注定被丢弃的候选。`endMs` 取自 bangumi-data 的 `end`（最终回实际播出时刻），判断是
      // 精确的、不需要额外余量；`endMs` 为空（长期番、当季新番）的条目整条保留，交给后面几道闸门。
      const before = candidates.length
      candidates = candidates.filter((candidate) => (
        candidate.entry.endMs === null || candidate.atMs <= candidate.entry.endMs
      ))
      debugLog('[digest] 按最终回预筛: %d 场 → %d 场', before, candidates.length)
    }
    return this.finalizeCandidates(candidates, options)
  }

  /** 时间窗截断 + 每部只留最早一场 + 按时刻排序 */
  private finalizeCandidates(candidates: AirCandidate[], options: AiringsOptions): AirCandidate[] {
    let result = candidates.filter((candidate) => candidate.atMs >= options.fromMs && candidate.atMs <= options.toMs)
    if (options.onePerTitle) {
      const firstByTitle = new Map<string, AirCandidate>()
      for (const candidate of result) {
        const current = firstByTitle.get(candidate.entry.key)
        if (!current || candidate.atMs < current.atMs) firstByTitle.set(candidate.entry.key, candidate)
      }
      result = [...firstByTitle.values()]
    }
    return result.sort((a, b) => a.atMs - b.atMs)
  }

  /**
   * 用 AniList 的**逐話时刻**替换推算场次。采信只看「数据覆不覆盖本窗口」，**不看首播日期
   * 是否同期**（长期番的记录挂在第一季上；错配到别季的记录在本窗口内没有话数，会被自然排除）。
   * **订正表命中的作品不替换**：订正表记的是日本电视档期，而 `airingAt` 可能取自配信平台。
   */
  private applyAiringSchedule(
    candidates: AirCandidate[],
    states: Map<number, AiringState>,
    options: AiringsOptions,
  ): AirCandidate[] {
    if (!states.size) return candidates

    // 按条目归类：有可用的 AniList 逐話時刻的走 AniList，其余保留推算结果
    const fromAniList = new Map<string, { entry: IndexEntry; schedule: ScheduledEpisode[] }>()
    /** 被 AniList 明确否定、连推算结果也不该保留的作品键 */
    const suppressed = new Set<string>()
    const predicted: AirCandidate[] = []
    let stale = 0
    for (const candidate of candidates) {
      const key = candidate.entry.key
      if (candidate.entry.aniListId === null || fromAniList.has(key)) continue
      const state = states.get(candidate.entry.aniListId)
      if (!state) continue

      // ⓪ **首播时刻以 AniList 为准**：AniList 说第 1 话在窗口之后，本窗口内就一场都没有，连推算结果也要丢掉。
      //
      // 只在 `nextEpisode.episode === 1` 时启用：这时 AniList 说的是「这部还没开播，首播在某时刻」，
      // 断言可靠。**绝不推广到 episode > 1**——长期番的 AniList 排期常常滞后几个月，拿「下一话之前
      // 没有场次」去否决它们，会把在播番整季清空。
      if (state.nextEpisode?.episode === 1 && state.nextEpisode.atMs > options.toMs) {
        suppressed.add(key)
        debugLog(
          '[digest] 舍弃 %s 的推算场次：AniList 的首播 %s 在本窗口之后',
          candidate.entry.title,
          new Date(state.nextEpisode.atMs).toISOString().slice(0, 16),
        )
        continue
      }

      // ① 优先用完整逐話表：它含已播与未播的每一話，是最完整的来源
      let schedule: ScheduledEpisode[] | null = null
      if (state.schedule.length && this.coversWindow(state.schedule, options)) {
        schedule = state.schedule
      } else if (state.nextEpisode) {
        // ② 逐話表没覆盖窗口时，退回 `nextAiringEpisode`：AniList 对**大量在播作品只回填历史
        // 场次**，`airingSchedule` 停在几个月前，但 `nextAiringEpisode` 依然准确。
        //
        // 这里**不要求**「本季内已经有过场次」：`nextAiringEpisode` 是 AniList 对「下一話」的
        // 明确断言，可信度比可能属于上一季的历史场次更高。
        schedule = this.extendFromNext(state.nextEpisode, candidate.entry, options)
        if (schedule) {
          debugLog(
            '[digest] %s 的逐話表未覆盖窗口，改用 nextAiringEpisode 外推（ep%d @ %s）',
            candidate.entry.title,
            state.nextEpisode.episode,
            new Date(state.nextEpisode.atMs).toISOString().slice(0, 16),
          )
        }
      }
      if (!schedule?.length) {
        stale++
        const last = state.schedule[state.schedule.length - 1]
        debugLog(
          '[digest] %s 的 AniList 排期未覆盖 %s ~ %s（逐話表最新 %s），改用推算',
          candidate.entry.title,
          new Date(options.fromMs).toISOString().slice(0, 10),
          new Date(options.toMs).toISOString().slice(0, 10),
          last ? new Date(last.atMs).toISOString().slice(0, 10) : '无',
        )
        continue
      }
      fromAniList.set(key, { entry: candidate.entry, schedule })
    }
    if (stale > 0) {
      debugLog('[digest] %d 部作品的 AniList 排期未覆盖本窗口，改用周期推算', stale)
    }

    const replaced: AirCandidate[] = []
    const now = options.now ?? options.fromMs
    for (const { entry, schedule } of fromAniList.values()) {
      for (const item of schedule) {
        // 上一話仍保留（当天已播的也要显示），更早的丢掉
        if (item.atMs < now - 86400000) continue
        replaced.push({ entry, episode: item.episode, atMs: item.atMs })
      }
    }
    for (const candidate of candidates) {
      if (fromAniList.has(candidate.entry.key)) continue
      // 被 AniList 明确否定首播的作品连推算结果也不保留
      if (suppressed.has(candidate.entry.key)) continue
      predicted.push(candidate)
    }

    const merged = this.finalizeCandidates([...replaced, ...predicted], options)
    if (fromAniList.size) {
      debugLog('[digest] 采用 AniList 逐話時刻: %d 部作品 → %d 場（推算共 %d 場）', fromAniList.size, replaced.length, candidates.length)
    }
    if (suppressed.size) {
      debugLog('[digest] 因 AniList 首播在窗口之后而舍弃推算场次: %d 部', suppressed.size)
    }
    return merged
  }

  /**
   * 可选闸门：剔除「超长期连载番」。判据只有**展示话数 ≥ 阈值**，因此不依赖网络。
   * **必须在条目构建之后调用**（`applyAiringSchedule` 会按作品去重，话数可能不同）。
   * 阈值 `content.longRunningThreshold`，**默认 0 表示不过滤**。
   */
  private dropLongRunning(items: DigestItem[]): DigestItem[] {
    const threshold = this.config.content.longRunningThreshold
    if (!threshold || threshold <= 0) return items

    const kept: DigestItem[] = []
    const dropped: string[] = []
    for (const item of items) {
      if (item.episodeCount >= threshold) {
        if (dropped.length < 12) dropped.push(`${item.name}(第${item.episodeCount}话)`)
        continue
      }
      kept.push(item)
    }
    if (dropped.length) {
      debugLog(
        '[digest] 剔除超长期连载番 %d 部（第 %d 话以上）: %s',
        items.length - kept.length,
        threshold,
        dropped.join('、'),
      )
    }
    return kept
  }

  /**
   * 一份排期是否覆盖了本次要展示的窗口。判据是「窗口内至少有一場」而不是「有未来話数」：
   * 一部当天播出、今天之后没有场次的作品恰恰**应该**被采纳。窗口截断由 `finalizeCandidates` 负责。
   */
  private coversWindow(schedule: ScheduledEpisode[], options: AiringsOptions): boolean {
    return schedule.some((item) => item.atMs >= options.fromMs && item.atMs <= options.toMs)
  }

  /**
   * 把 `nextAiringEpisode` 外推成覆盖窗口的排期：以它为锚点、按本条周期向后铺到越过窗口末尾。
   * 只用锚点、不掺历史场次（可能是上一季的，会算出错误的集数）。返回 `null` 表示结果落在窗口外。
   */
  private extendFromNext(
    next: ScheduledEpisode,
    entry: IndexEntry,
    options: AiringsOptions,
  ): ScheduledEpisode[] | null {
    const periodDays = entry.periodDays
    // 没有周期可依（一次性放送）时无法外推，只能用锚点本身
    if (periodDays === null || periodDays <= 0) {
      return next.atMs >= options.fromMs && next.atMs <= options.toMs ? [next] : null
    }
    // 锚点已经越过窗口末尾 → 本窗口内没有任何场次
    if (next.atMs > options.toMs) return null

    const period = periodDays * 86400000
    const out: ScheduledEpisode[] = []
    // 锚点落在窗口之前时，先补到窗口内（例如窗口是下周，而下一話在本周）
    let step = next.atMs < options.fromMs ? Math.ceil((options.fromMs - next.atMs) / period) : 0
    for (; step < 64; step++) {
      const atMs = next.atMs + step * period
      if (atMs > options.toMs) break
      if (atMs >= options.fromMs) out.push({ episode: next.episode + step, atMs })
    }
    return out.length ? out : null
  }

  /**
   * 「接下来 14 天内排得上场次」的作品键集合，用于判断作品是否仍在连载：判据只看 `endMs`
   * （`schedule()` 把周期当无限重复规则用，「有场次」不足以说明在播；改用「首播在 400 天内」
   * 这类判据会误杀长期番）。
   *
   * **缓存必须按窗口起点 `fromMs` 索引，不能按日期**：`fromMs` 因调用方而异（日表当天 0 点、
   * 周表今天 0 点、调度器传 `Date.now()`），按日期缓存会让先跑的调用方决定后面所有调用方的
   * 窗口（`-o -1` 跑过之后周表会漏掉前一天的场次）。
   */
  private readonly followingCache = new Map<number, Set<string>>()
  /** 上限只是防止 `-o -7..7` 这类连续查询把缓存撑大 */
  private static readonly FOLLOWING_CACHE_MAX = 32

  private followingKeys(fromMs = Date.now()): Set<string> {
    const cached = this.followingCache.get(fromMs)
    if (cached) return cached

    const until = fromMs + FOLLOWING_WINDOW_DAYS * 86400000
    const keys = new Set<string>()

    // ① 首播已越过窗口、但没有最终回的条目（长期番）。它们不在窗口内开播、扫不出场次，
    // 必须单独按 `nextAirMs` 判断——好在数量极小，代价可以忽略。
    for (const entry of this.index.all) {
      if (entry.endMs !== null || entry.broadcastMs === null) continue
      const next = this.nextAirMs(entry, fromMs)
      if (next < until) keys.add(entry.key)
    }

    // ② 最近开播、且接下来两周仍有场次的条目：只需扫「近 14 天开播」这一段（更早且有最终回的
    // 必然越过 `endMs`），真正还在播的那批已由 ① 收齐。这里**不能**用 `nextAirMs` 代替扫场次——
    // 它不看 `endMs`，对早已完结的条目会算出荒谬的未来时刻。
    for (const candidate of this.index.schedule(fromMs - FOLLOWING_WINDOW_DAYS * 86400000, until)) {
      const entry = candidate.entry
      if (candidate.atMs >= until) continue
      // 越过最终回的场次是周期规则的余波，不算「还有排期」
      if (entry.endMs !== null && candidate.atMs > entry.endMs) continue
      keys.add(entry.key)
    }

    // 超出上限时丢掉最早插入的那一项（Map 保持插入顺序）
    if (this.followingCache.size >= DigestService.FOLLOWING_CACHE_MAX) {
      const oldest = this.followingCache.keys().next().value
      if (oldest !== undefined) this.followingCache.delete(oldest)
    }
    this.followingCache.set(fromMs, keys)
    debugLog(
      '[digest] 近期开播且后续 %d 天内仍有排期的作品: %d 部（窗口起点 %s）',
      FOLLOWING_WINDOW_DAYS,
      keys.size,
      new Date(fromMs).toISOString(),
    )
    return keys
  }

  /**
   * 「是否已播完」由三道具名闸门回答，**从便宜到昂贵**依次执行：
   * 1. `dropLocallyFinished`（`endMs` 与「近期开播且后续仍有排期」，**零请求**）
   * 2. `dropFinishedByAniList`（AniList 的 `status` / 话数 / 终映日，已随 `airingStatesOf` 取回）
   * 3. `dropFinishedByEpisodeDates`（Bangumi 逐集档期的末話日期，需 `/v0/subjects` + `/v0/episodes`）
   * 顺序很重要：1、2 不新增请求，先把大部分候选挡掉，3 于是只为**幸存者**付出代价。
   */

  /**
   * 闸门 1：只看本地索引就能判定「已播完」，**不产生任何请求**。依据是 bangumi-data 的 `end`
   * 与「近期开播且后续仍有排期」（当季条目 `end` 几乎为空，靠这条兜住）。
   */
  private dropLocallyFinished(
    candidates: AirCandidate[],
    now: number,
    followingKeys?: Set<string>,
  ): AirCandidate[] {
    let concluded = 0
    const kept = candidates.filter((candidate) => {
      if (!this.isConcluded(candidate.entry, now, followingKeys)) return true
      concluded++
      return false
    })
    if (concluded > 0) debugLog('[digest] 剔除已播完的作品 %d 部（本地依据）', concluded)
    return kept
  }

  /**
   * 闸门 2：AniList 的完结判定。采信前必须先确认这条记录**和我们算的是同一季**（少数条目的
   * `aniList` ID 指向别季），不同季或取不到时一律保留。AniList 是权威值：周期规则算的是播出
   * 周数，同日连播两话时周数与话数永远对不上。
   */
  private dropFinishedByAniList(
    candidates: AirCandidate[],
    now: number,
    airing?: Map<number, AiringState>,
  ): AirCandidate[] {
    if (!airing?.size) return candidates
    let dropped = 0
    const kept = candidates.filter((candidate) => {
      const state = candidate.entry.aniListId === null ? undefined : airing.get(candidate.entry.aniListId)
      // 以「这一场的播出时刻」为准。无法判定（不是同季、终映日异常）时一律保留：
      // 表格里多留一部只是不好看，误删一部会让用户以为没更新。
      const finished = this.aniListFinished(state, candidate.entry.broadcastMs, now, candidate.atMs)
      if (finished !== true) return true
      debugLog(
        '[digest] 剔除 %s：AniList 状态 %s，已播 %s / %s 集，终映 %s',
        candidate.entry.title,
        state?.status ?? '?',
        state?.airedEpisodes ?? '?',
        state?.episodes ?? '?',
        state?.endDate ?? '?',
      )
      dropped++
      return false
    })
    if (dropped > 0) debugLog('[digest] 剔除已播完的作品 %d 部（AniList）', dropped)
    return kept
  }

  /**
   * 根据 AniList 状态判断「已经播完」。出表闸门（`dropFinishedByAniList`）与订阅清理
   * （`isEntryFinished`）共用这一份，避免两处判据各写一遍而漂移。
   *
   * 返回 `null` 表示**无法判定**：记录指的不是这一季、或字段不足以判断。退化方式交给调用方
   * ——出表闸门保留，订阅清理退回本地 `end`。
   *
   * @param fromMs 以哪个时刻为准：出表闸门用该场的播出时刻，订阅清理用当前时刻。
   */
  private aniListFinished(
    state: AiringState | undefined,
    base: number | null,
    now: number,
    fromMs: number,
  ): boolean | null {
    if (!state || !this.isSameAniListSeason(state, base)) return null
    // 还在连载或还没开播，一律不算完结
    if (state.status === 'RELEASING' || state.status === 'NOT_YET_RELEASED') return false
    // 还有没播的一话，说明没完结
    if (state.nextEpisode && state.nextEpisode.atMs > now) return false

    // 话数已知：只有「话数已够」且「最终话时刻确实过去了」才算完结。只看话数会在最终话当天
    // 就提前判完结（AniList 把当天的集也算作已播）。
    if (state.episodes !== null && state.airedEpisodes !== null) {
      return state.airedEpisodes >= state.episodes
        && state.lastAiredMs !== null
        && state.lastAiredMs <= now
    }

    // 话数未知时退回终映日。终映日缺失或格式异常时不敢判完结，交回调用方。
    if (state.endDate) {
      const endMs = Date.parse(`${state.endDate}T00:00:00Z`)
      if (!Number.isFinite(endMs)) return null
      return fromMs > endMs + FINAL_EPISODE_DAY_GRACE * 86400000
    }

    return null
  }

  /**
   * 这条 AniList 记录与 `base` 是不是同一季。**只用于「是否已播完」，不用于排期**（`status`
   * 一旦采信就会把作品从各表里剔除）。取逐話时刻时故意不做这个校验，见 `applyAiringSchedule`。
   */
  private isSameAniListSeason(state: AiringState, base: number | null): boolean {
    // 没有首播日期时无法校验，采信 AniList 的状态（该字段可靠性高）
    if (!state.startDate) return true
    if (base === null) return true
    const startMs = Date.parse(`${state.startDate}T00:00:00Z`)
    if (!Number.isFinite(startMs)) return true
    // 首播日期相差超过 `ANILIST_ANCHOR_TOLERANCE_DAYS` 天，说明这条记录是别的季度
    const gapDays = Math.abs(base - startMs) / 86400000
    if (gapDays > ANILIST_ANCHOR_TOLERANCE_DAYS) {
      debugLog(
        '[digest] 不采信 %s 的 AniList 状态：该记录首播 %s，与我们算的首播相差 %d 天',
        state.aniListId,
        state.startDate,
        Math.round(gapDays),
      )
      return false
    }
    return true
  }

  /**
   * 按 AniList 条目 ID 批量取播出状态，并先给没有 `aniList` ID 的条目按标题补一个 ID。
   * 必须限量：按标题搜索一次一个请求，放开会让周表构建从数秒涨到数分钟并有触发限流的风险。
   */
  private async airingStatesOf(candidates: AirCandidate[], now: number): Promise<Map<number, AiringState>> {
    if (!this.airing) return new Map()

    // 需要补 ID 的条目：按播出时刻升序，先处理近期要播的
    const missing = new Map<string, { entry: IndexEntry; atMs: number }>()
    for (const candidate of candidates) {
      const entry = candidate.entry
      if (entry.aniListId !== null) continue
      const current = missing.get(entry.key)
      if (!current || candidate.atMs < current.atMs) missing.set(entry.key, { entry, atMs: candidate.atMs })
    }
    const pending = [...missing.values()].sort((a, b) => a.atMs - b.atMs).slice(0, TITLE_SEARCH_LIMIT)

    const resolved: number[] = []
    for (const { entry } of pending) {
      const id = await this.airing.resolveByTitle({
        title: entry.title,
        beginMs: entry.beginMs,
        broadcastMs: entry.broadcastMs,
      })
      if (id === null) continue
      entry.aniListId = id
      resolved.push(id)
    }
    if (resolved.length) debugLog('[digest] 按标题补上 %d 个 AniList ID', resolved.length)
    if (missing.size > pending.length) {
      debugLog('[digest] 还有 %d 部缺 AniList ID 的条目未处理，留待后续构建', missing.size - pending.length)
    }

    const ids = candidates
      .map((candidate) => candidate.entry.aniListId)
      .filter((id): id is number => id !== null)
    if (!ids.length) return new Map()
    await this.airing.ensure()
    try {
      return await this.airing.resolve(ids, this.config.localize.airingTtlHours / 24, now)
    } catch (error) {
      debugLog('[digest] AniList 状态查询失败，本次按逐集档期判定: %s', errorMessage(error))
      return new Map()
    }
  }

  /**
   * 闸门 3：Bangumi 逐集档期的末話日期，**只为闸门 1、2 的幸存者执行**。闸门 2 一旦确认
   * 「同一季」并表态就不再插手：逐集档期经常属于上一季度，其「上游数据不一致」检查会误杀在播作品。
   */
  private dropFinishedByEpisodeDates(
    candidates: AirCandidate[],
    now: number,
    subjects?: Map<number, LocalizeCacheEntry>,
    airing?: Map<number, AiringState>,
  ): AirCandidate[] {
    if (!subjects?.size) return candidates
    let dropped = 0
    let skipped = 0
    const kept = candidates.filter((candidate) => {
      const id = candidate.entry.bangumiId
      const base = candidate.entry.broadcastMs

      // AniList 已经对这部作品表态（同一季）→ 由它说了算，逐集档期不得推翻
      const state = candidate.entry.aniListId === null ? undefined : airing?.get(candidate.entry.aniListId)
      if (state && this.isSameAniListSeason(state, base)) {
        skipped++
        return true
      }

      const entry = id === null ? undefined : subjects!.get(id)
      const total = entry?.totalEpisodes ?? 0
      const stated = entry?.lastAirMs ?? null
      if (stated === null || total <= 0 || base === null) return true
      // 上游数据错配校验：`begin` 与逐集档期的首集相差数年时，这个条目的开播日期是错的
      // （新一季被挂到了几年前已完结的同一部作品上）。
      const apiFirst = entry?.firstAirMs ?? null
      if (apiFirst !== null && Math.abs(base - apiFirst) > STALE_SEASON_GAP_DAYS * 86400000) {
        debugLog('[digest] 剔除 %s：开播日期 %s 与逐集档期首集 %s 相差 %d 天，上游数据不一致',
          candidate.entry.title, new Date(base).toISOString().slice(0, 10), new Date(apiFirst).toISOString().slice(0, 10), Math.round((base - apiFirst) / 86400000))
        dropped++
        return false
      }

      // 同季校验：末集必须落在「第 total 集」推算位置附近，逐集列表才算覆盖了这一季。
      // 跨度检查兜住「长期番按季拆分、共用一个 Bangumi ID」的情况。
      const periodDays = candidate.entry.periodDays ?? 7
      const period = periodDays * 86400000
      const lastLabel = new Date(stated).toISOString().slice(0, 10)
      const expectedLast = base + (total - 1) * period
      const offsetPeriods = (stated - expectedLast) / period
      if (Math.abs(offsetPeriods) > FINAL_EPISODE_TOLERANCE_PERIODS) {
        debugLog('[digest] 不采信 %s 的逐集档期：第 %d 集推算 %s，档期给出 %s（差 %s 个周期）', candidate.entry.title, total, new Date(expectedLast).toISOString().slice(0, 10), lastLabel, offsetPeriods.toFixed(1))
        return true
      }
      const spanDays = (stated - base) / 86400000
      if (spanDays > (total - 1) * periodDays + FINAL_EPISODE_SPAN_SLACK_DAYS) {
        debugLog('[digest] 不采信 %s 的逐集档期：跨度 %d 天超出 %d 集的最小跨度', candidate.entry.title, Math.round(spanDays), total)
        return true
      }

      // 判据：**这一场的 JST 日期已越过末集一天以上**。
      //
      // 必须按「日」比较：`lastAirMs` 是末集那一天的 0 点，而场次带有具体时刻，直接相减会把
      // 同一天深夜的场次误判为「已过」。
      const candidateDay = Math.floor((candidate.atMs + 9 * 3600000) / 86400000)
      const lastDay = Math.floor(stated / 86400000)
      if (candidateDay - lastDay <= FINAL_EPISODE_DAY_GRACE) return true
      debugLog('[digest] 剔除 %s：末集 %s，本场已在其后 %d 天', candidate.entry.title, lastLabel, candidateDay - lastDay)
      dropped++
      return false
    })
    if (dropped > 0) debugLog('[digest] 剔除已播完的作品 %d 部（Bangumi 逐集档期）', dropped)
    if (skipped > 0) debugLog('[digest] %d 部由 AniList 判定，逐集档期未参与', skipped)
    return kept
  }

  /**
   * 作品是否已经播完（**只看本地索引，不产生请求**）。依据是 bangumi-data 的 `end` 与
   * 「近期开播且后续仍有排期」；两者都判断不出来时依次交给 AniList 与逐集档期。
   */
  private isConcluded(entry: IndexEntry, now: number, followingKeys?: Set<string>): boolean {
    // `end` 必须排在「还有排期」之前：周期规则无限重复，最终回之后照样能推算出场次，
    // 只看「有排期」会被这些余波骗过去
    if (entry.endMs !== null) return this.hasEnded(entry, now)
    return !followingKeys?.has(entry.key)
  }

  /** 作品是否已经越过 bangumi-data 给出的最终回（留一个周期的余量） */
  private hasEnded(entry: IndexEntry, now: number): boolean {
    if (entry.endMs === null) return false
    return entry.endMs + (entry.periodDays ?? 7) * 86400000 < now
  }

  /** 按 Bangumi 条目 ID 批量取详情 */
  private async subjectsOf(candidates: AirCandidate[]): Promise<Map<number, LocalizeCacheEntry>> {
    const ids = candidates
      .map((candidate) => candidate.entry.bangumiId)
      .filter((id): id is number => id !== null)
    return this.localizer.localizeByIds(ids)
  }

  /**
   * 只为「闸门 3 真的要判」的作品取详情：闸门 3 一开头就跳过 AniList 已确认同季的条目，
   * 那部分详情取来也用不上。条件必须与 `dropFinishedByEpisodeDates` 里的短路保持一致，
   * 否则会出现「这里不取、那里要用」的空判定。
   */
  private async subjectsForEpisodeDates(
    candidates: AirCandidate[],
    airing?: Map<number, AiringState>,
  ): Promise<Map<number, LocalizeCacheEntry>> {
    const wanted = candidates.filter((candidate) => {
      const state = candidate.entry.aniListId === null ? undefined : airing?.get(candidate.entry.aniListId)
      // AniList 已表态（同一季）→ 闸门 3 不参与，详情不必取
      return !(state && this.isSameAniListSeason(state, candidate.entry.broadcastMs))
    })
    if (wanted.length === candidates.length) return this.subjectsOf(candidates)
    const subjects = await this.subjectsOf(wanted)
    debugLog(
      '[digest] 闸门 3：%d 部幸存者中只有 %d 部需要 Bangumi 逐集档期（其余由 AniList 定论）',
      candidates.length,
      wanted.length,
    )
    return subjects
  }

  /**
   * 推算某部作品在 `fromMs` 之后的下一场播出。一次性放送没有周期可递推，直接返回它自己的
   * 首播时刻（即使已经过去），否则会返回 `fromMs` 这个假时刻。
   */
  private nextAirMs(entry: IndexEntry, fromMs: number): number {
    const base = entry.broadcastMs
    if (base === null) return fromMs
    if (!entry.recurring) return base
    const period = (entry.periodDays ?? 7) * 86400000
    if (period <= 0) return base
    if (base >= fromMs) return base
    const steps = Math.ceil((fromMs - base) / period)
    return base + steps * period
  }

  /** 某个时刻对应第几集（首次播出为第 1 集；一次性放送固定为第 1 集） */
  private episodeAt(entry: IndexEntry, atMs: number): number {
    const base = entry.broadcastMs
    if (base === null || !entry.recurring) return 1
    const period = (entry.periodDays ?? 7) * 86400000
    if (period <= 0) return 1
    return Math.max(1, Math.round((atMs - base) / period) + 1)
  }

  // #endregion

  // #region 条目构建

  /**
   * 把一条场次变成可渲染条目。译名回退链：bangumi-data 简中 → 繁中 → 日文原名。
   *
   * @param aniList 该条目的 AniList 状态；给了就用它的封面（见 `AiringState.coverUrl`）
   */
  private toItem(
    candidate: AirCandidate,
    subject: LocalizeCacheEntry | undefined,
    subscribed: Set<string> = EMPTY_SETS,
    aniList?: AiringState,
  ): DigestItem {
    const { output } = this.config
    const entry = candidate.entry
    const original = entry.title
    const localized = this.localizer.enabled ? (entry.zhHans || entry.zhHant || '') : ''
    const style = this.config.localize.titleStyle
    const hasOriginal = Boolean(localized) && localized !== original
    /**
     * 日文原名（仅 `both`）。
     *
     * 不拼进 `name`：拼接后的 `中文 (原名)` 会被折行规则视为一个整体，
     * 长标题折成两行后原名占掉半行、还和中文同样醒目。拆成独立字段后，图片版面
     * 可以用浅灰小字跟在标题后，纯文本版面没有字号/颜色，再由它自己拼。
     */
    const titleOriginal = style === 'both' && hasOriginal ? original : ''
    const name = !localized || style === 'original'
      ? original
      : style === 'localized' ? localized : localized

    // 样本太少时评分没有参考价值：新番刚开播可能只有一两个人投票，那个数字会随样本增加
    // 剧烈变化。留空优于给出误导性的数字。
    const votes = subject?.ratingTotal ?? 0
    const scoreValue = this.localizer.enabled && output.showScore
      && typeof subject?.score === 'number' && subject.score > 0
      && votes >= MIN_SCORE_VOTES
      ? subject.score
      : null
    const time = formatClock(candidate.atMs, this.timeZone)
    const date = formatDate(candidate.atMs, this.timeZone)
    const firstDate = entry.beginMs !== null ? formatDate(entry.beginMs, this.timeZone) : ''

    return {
      tid: entry.bangumiId !== null ? `bgm:${entry.bangumiId}` : entry.key,
      bgmId: entry.bangumiId,
      aniListId: entry.aniListId,
      date,
      time,
      atMs: candidate.atMs,
      episodeCount: candidate.episode,
      episode: this.messages.episodeShort(candidate.episode),
      // 一次性放送（剧场版等）没有「第几话」的概念，渲染层据此隐藏集数
      recurring: entry.recurring,
      name,
      titleOriginal,
      // 封面优先用 AniList：它的图床在国内一般可直连，而 Bangumi 的 lain.bgm.tv 需要代理。
      // 取不到时回退 Bangumi。
      coverUrl: aniList?.coverUrl || (entry.bangumiId !== null ? (subject?.coverUrl ?? '') : ''),
      scoreValue,
      // 两位小数：`score` 由 `rating.count` 算出的算术平均得来，比 Bangumi 自己给的一位小数
      // 更有区分度；四舍五入到一位后与网站显示一致
      score: scoreValue !== null ? scoreValue.toFixed(2) : '',
      firstYear: firstDate ? Number(firstDate.slice(0, 4)) : null,
      firstMonth: firstDate ? Number(firstDate.slice(5, 7)) : null,
      subscribed: entry.bangumiId !== null && subscribed.has(`bgm:${entry.bangumiId}`),
      airLabel: `${this.describeDate(candidate.atMs)} ${time}`.trim(),
      type: entry.type,
      endMs: entry.endMs,
    }
  }

  /** 先按 Bangumi 条目 ID 批量取详情，再逐条组装；已取过详情时直接传入避免重复请求 */
  private async buildItems(
    candidates: AirCandidate[],
    subscribed?: Set<string>,
    subjects?: Map<number, LocalizeCacheEntry>,
    airing?: Map<number, AiringState>,
  ): Promise<DigestItem[]> {
    const resolved = subjects ?? await this.subjectsOf(candidates)
    return candidates.map((candidate) => this.toItem(
      candidate,
      candidate.entry.bangumiId !== null ? resolved.get(candidate.entry.bangumiId) : undefined,
      subscribed,
      this.airingStateOf(candidate.entry, airing),
    ))
  }

  /** 取该条目的 AniList 状态（没有 aniListId 或没查到时为 undefined） */
  private airingStateOf(entry: IndexEntry, airing?: Map<number, AiringState>): AiringState | undefined {
    if (!airing?.size || entry.aniListId === null) return undefined
    return airing.get(entry.aniListId)
  }

  /**
   * 取某个频道已订阅的 tid 集合（订阅是频道级的），用于标「已订阅」气泡。`build()` 内部会调；
   * 指令层手动查看时也要自己调一次，否则手动触发的图片里看不到气泡。
   */
  async subscribedKeys(platform: string, channelId: string): Promise<Set<string>> {
    const rows = await this.ctx.database.get('anime_subscription', { platform, channelId, enabled: true })
    return new Set(rows.map((row) => row.tid))
  }

  /** 按播出日分组，并补上表头所需的日期与星期 */
  private toDayGroup(date: string, label: string, items: DigestItem[]): DigestGroup {
    const startMs = getDayStartMs(date, this.timeZone)
    return {
      label,
      date,
      weekday: getLocalWeekday(startMs, this.timeZone),
      isToday: date === today(this.timeZone),
      items: [...items].sort(this.compareByClock),
    }
  }

  /**
   * 按**各自的实际播出日**分组。分组日期必须来自条目自己：本季表的场次横跨几十天，
   * 统一贴上「第一条的日期」会让周历排版把它们全塞进同一列。
   */
  private groupByDay(items: DigestItem[]): DigestGroup[] {
    const byDay = new Map<string, DigestItem[]>()
    for (const item of items) {
      const list = byDay.get(item.date)
      if (list) list.push(item)
      else byDay.set(item.date, [item])
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => this.toDayGroup(date, this.describeDate(getDayStartMs(date, this.timeZone)), list))
  }

  /** 按自然时刻排序（00:00 → 23:59） */
  private compareByClock = (a: DigestItem, b: DigestItem): number => (
    a.time.localeCompare(b.time) || a.tid.localeCompare(b.tid)
  )

  // #endregion

  // #region 对外构建入口

  /**
   * 所有「按播出时刻列作品」的表共用的唯一管线（取场次 → 补 AniList ID → 取详情 →
   * 换用 AniList 逐話時刻 → 剔除已播完 → 组装条目）。
   *
   * @param buildWindow 调用方给出窗口与可选预筛；预筛在**去重与判定之前**生效（订阅表靠它按 tid 收窄）
   * @param groupOverride 覆盖默认分组（订阅表要把「今天」与「次日凌晨」分成两组）
   */
  private async buildAirings(
    kind: DigestKind,
    subscribed: Set<string>,
    now: number,
    buildWindow: (now: number) => AiringsOptions,
    groupOverride?: (items: DigestItem[]) => DigestGroup[],
  ): Promise<Digest> {
    await this.prepare()
    const options = buildWindow(now)
    const window = this.windowMeta(kind, now, options.fromMs)

    const predicted = this.airingsIn(options)
    debugLog('[digest] %s: 推算 %d 场', kind, predicted.length)

    // ── 闸门 1 + 2：都不需要新增请求，先把大部分候选挡掉 ──
    //
    // bangumi-data 的 `end` 与「近期仍有排期」是纯本地判定，AniList 状态本来就要取，
    // 因此下面只为幸存者请求 Bangumi 详情。
    const following = this.followingKeys(now)
    const locallyKept = this.dropLocallyFinished(predicted, options.fromMs, following)
    const airingStates = await this.airingStatesOf(locallyKept, now)
    const survived = this.dropFinishedByAniList(locallyKept, options.fromMs, airingStates)

    // ── 闸门 3：只为**真正要判的**作品取 Bangumi 详情 ──
    //
    // 闸门 3 一开头就短路「AniList 已确认同季」的条目，这类占了绝大多数；这里先算出真正
    // 需要的 ID，只取它们，避免为几十部白跑请求。
    const concluded = this.dropFinishedByEpisodeDates(
      survived,
      options.fromMs,
      await this.subjectsForEpisodeDates(survived, airingStates),
      airingStates,
    )

    // 展示用的详情（标题、封面、评分）另行批量取：闸门 3 里取过的会命中缓存，
    // 没取过的才发请求，因此不会重复。
    const subjects = await this.subjectsOf(concluded)
    const scheduled = this.applyAiringSchedule(concluded, airingStates, options)
    const built = await this.buildItems(scheduled, subscribed, subjects, airingStates)
    // 可选：剔除超长期番（默认关闭，见 `content.longRunningThreshold`）。
    //
    // 必须在**条目构建之后**做：`applyAiringSchedule` 内部会按作品去重，去重前后的「第几话」
    // 可能不是同一个值。判据要落在**最终展示的话数**上，否则会出现「明明显示第 53 话却按
    // 第 49 话判定」这种错位。
    const items = this.dropLongRunning(built)

    return this.finish(
      kind,
      this.headerOf(kind, window),
      '',
      groupOverride ? groupOverride(items) : this.groupOf(kind, window, items),
      kind === 'sub' ? this.messages.noAiringSub(subscribed.size) : this.emptyTextOf(kind),
      now,
    )
  }

  /**
   * 窗口的补充信息：只有「分组」与「表头」需要，且必须与 `AiringsOptions` 用同一个 `now`
   * 算出来。标题里已经带了日期，副标题因此留空。
   */
  private windowMeta(kind: DigestKind, now: number, fromMs: number): {
    /** 单日表与订阅表的日期，深夜档是「今晚」那一天 */
    date: string
    fromMs: number
    /** 深夜档：次日 0 点，用于把凌晨场次分到第二组 */
    tomorrowStartMs: number
    /** 周表：七天里最后一天的 23:59:59.999 */
    lastDayEndMs: number
  } {
    const date = today(this.timeZone, now)
    if (kind === 'night') {
      const tomorrowStartMs = getDayStartMs(addDays(date, 1, this.timeZone), this.timeZone)
      return { date, fromMs, tomorrowStartMs, lastDayEndMs: 0 }
    }
    if (kind === 'weekly') {
      return {
        date,
        fromMs,
        tomorrowStartMs: 0,
        lastDayEndMs: getDayStartMs(addDays(date, 7, this.timeZone), this.timeZone) - 86400000,
      }
    }
    // 日表与订阅表：`fromMs` 就是那一天 0 点，直接反推日期
    return { date: formatDate(fromMs, this.timeZone), fromMs, tomorrowStartMs: 0, lastDayEndMs: 0 }
  }

  /** 每种表的表头 */
  private headerOf(kind: DigestKind, window: { fromMs: number; lastDayEndMs: number }): string {
    if (kind === 'night') return this.messages.nightHeader(this.describeDate(window.fromMs))
    if (kind === 'weekly') {
      return this.messages.weeklyHeader(
        this.describeDate(window.fromMs),
        this.describeDate(window.lastDayEndMs),
      )
    }
    return this.messages.dailyHeader(this.describeDate(window.fromMs))
  }

  /** 每种表的分组方式 */
  private groupOf(
    kind: DigestKind,
    window: { date: string; fromMs: number; tomorrowStartMs: number },
    items: DigestItem[],
  ): DigestGroup[] {
    if (kind === 'night') {
      const evening = items.filter((item) => item.atMs < window.tomorrowStartMs)
      const dawn = items.filter((item) => item.atMs >= window.tomorrowStartMs)
      const groups: DigestGroup[] = []
      if (evening.length) {
        groups.push(this.toDayGroup(
          window.date,
          this.messages.tonightGroup(this.describeDate(window.fromMs)),
          evening,
        ))
      }
      if (dawn.length) {
        const tomorrow = addDays(window.date, 1, this.timeZone)
        groups.push(this.toDayGroup(
          tomorrow,
          this.messages.tomorrowDawnGroup(this.describeDate(window.tomorrowStartMs)),
          dawn,
        ))
      }
      return groups
    }
    if (kind === 'weekly') return this.groupByDay(items)
    return [this.toDayGroup(window.date, this.messages.daytimeGroup, items)]
  }

  private emptyTextOf(kind: DigestKind): string {
    if (kind === 'night') return this.messages.emptyNight
    if (kind === 'weekly') return this.messages.emptyWeekly
    return this.messages.emptyDaily
  }

  /**
   * 每日更新表，`offset` 为相对今天的日期偏移（-1 表示前一天）。
   *
   * 传入 `subscribed` 时，已订阅的作品会在条目上带「已订阅」标记。
   */
  async buildDaily(
    offset = this.config.push.dailyOffsetDays,
    subscribed: Set<string> = EMPTY_SETS,
    now = Date.now(),
  ): Promise<Digest> {
    // 与配置项 `.min()/.max()` 共用同一对边界，避免「配置页能填、这里又被夹一次」
    const days = clamp(offset, DAILY_OFFSET_MIN, DAILY_OFFSET_MAX)
    return this.buildAirings('daily', subscribed, now, (at) => {
      const startMs = getDayStartMs(addDays(today(this.timeZone, at), days, this.timeZone), this.timeZone)
      return { fromMs: startMs, toMs: startMs + 86400000 - 1, now: startMs }
    })
  }

  /**
   * 深夜档更新表：覆盖「今晚 21:00 之后」与「次日 6:00 之前」两段。凌晨场次按实际播出时刻
   * 展示，因此熬夜追更时一眼就能看到现在之后还有什么可看。
   */
  async buildNight(subscribed: Set<string> = EMPTY_SETS, now = Date.now()): Promise<Digest> {
    return this.buildAirings('night', subscribed, now, (at) => {
      const date = today(this.timeZone, at)
      const eveningStartMs = getDayStartMs(date, this.timeZone) + EVENING_START_HOUR * 3600000
      const tomorrowStartMs = getDayStartMs(addDays(date, 1, this.timeZone), this.timeZone)
      return {
        fromMs: eveningStartMs,
        toMs: tomorrowStartMs + LATE_NIGHT_END_HOUR * 3600000 - 1,
        onePerTitle: true,
        now: eveningStartMs,
      }
    })
  }

  /** 本周更新表，覆盖今天起七天，每部作品只占一条 */
  async buildWeekly(subscribed: Set<string> = EMPTY_SETS, now = Date.now()): Promise<Digest> {
    return this.buildAirings('weekly', subscribed, now, (at) => {
      const start = today(this.timeZone, at)
      const startMs = getDayStartMs(start, this.timeZone)
      // 七天整：到「第 8 天 0 点」为止
      const endMs = getDayStartMs(addDays(start, 7, this.timeZone), this.timeZone)
      return { fromMs: startMs, toMs: endMs - 1, onePerTitle: true, now: startMs }
    })
  }

  /**
   * 本季（或指定季度）的新番概览：收录该季首播的全部 TV / WEB 动画，不剔除已播完的作品，
   * 卡片给的是首播时间（收录窗口见 `BangumiDataIndex.seasonWindow`）。
   *
   * @param seasonOffset 相对当前季度的偏移：0 当季、-1 上一季
   */
  async buildSeason(seasonOffset = 0, subscribed: Set<string> = EMPTY_SETS, now = Date.now()): Promise<Digest> {
    await this.prepare()
    const { year, startMonth } = this.resolveSeason(seasonOffset, now)
    return this.buildSeasonOf(year, startMonth, subscribed, now)
  }

  /** 由「相对当前季度的偏移」算出目标季度 */
  private resolveSeason(offset: number, now: number): { year: number; startMonth: number } {
    const date = today(this.timeZone, now)
    const currentYear = Number(date.slice(0, 4))
    const currentStart = getSeasonStartMonth(Number(date.slice(5, 7)))
    // 季度以 3 个月为一步，起点月份固定为 1 / 4 / 7 / 10
    const index = (currentYear * 4 + (currentStart - 1) / 3) + offset
    return { year: Math.floor(index / 4), startMonth: ((index % 4) + 4) % 4 * 3 + 1 }
  }

  /** 构建某个具体季度的新番概览 */
  private async buildSeasonOf(year: number, startMonth: number, subscribed: Set<string>, now: number): Promise<Digest> {
    const seasonName = SEASON_NAMES[startMonth] ?? ''
    const label = this.messages.seasonLabel(year, startMonth)
    const header = this.messages.seasonHeader(label)
    const prefix = seasonName ? `${seasonName}番 ` : ''
    // 副标题写清收录窗口：季末提前放送的作品也算进这一季
    const window = this.index.seasonWindow(year, startMonth)
    const rangeLabel = this.messages.rangeLabel(
      this.describeDate(window.startMs),
      this.describeDate(window.endMs - 86400000),
    )

    const premieres = this.index.season(year, startMonth)
    if (!premieres.length) {
      return { ...this.finish('season', header, prefix, [], this.messages.emptySeason, now, label), rangeLabel }
    }

    // 季表只展示「首播那一场」，不判断完结，因此不必取逐集档期（省掉每部一个请求）
    const subjects = await this.localizer.localizeByIds(
      premieres.map((entry) => entry.bangumiId).filter((id): id is number => id !== null),
      false,
    )
    // 首播时刻同样以 AniList 为准，取不到才回退索引层
    const states = await this.resolveAiringStates(premieres, now)

    // 每条定位到首播那一场：集数恒为第 1 集
    const rows = premieres.map((entry) => {
      const expected = entry.broadcastMs ?? entry.beginMs ?? 0
      const at = this.seasonAirMs(entry, expected, states)
      const candidate: AirCandidate = { entry, atMs: at, episode: 1 }
      const subject = entry.bangumiId !== null ? subjects.get(entry.bangumiId) : undefined
      return { at, item: this.toItem(candidate, subject, subscribed, this.airingStateOf(entry, states)) }
    })
    rows.sort((a, b) => (a.at - b.at) || a.item.name.localeCompare(b.item.name))

    const items = rows.map((row) => row.item)
    debugLog(
      '[digest] 季表 %d 年 %d 月: 该季首播 %d 部，封面 %d 张，评分 %d 个',
      year,
      startMonth,
      items.length,
      items.filter((item) => item.coverUrl).length,
      items.filter((item) => item.scoreValue !== null).length,
    )

    return {
      ...this.finish('season', header, prefix, this.groupByDay(items), this.messages.emptySeason, now, label),
      rangeLabel,
    }
  }

  /** 单群订阅更新表：今天播出的订阅作品 */
  async buildSubscription(platform: string, channelId: string, now = Date.now()): Promise<Digest> {
    await this.prepare()
    const subscriptions = await this.ctx.database.get('anime_subscription', { platform, channelId, enabled: true })
    // 一封订阅都没有时连索引都不用碰，直接给出引导文案
    if (!subscriptions.length) {
      return {
        kind: 'sub',
        header: this.messages.subHeader(0),
        summary: this.messages.emptySub,
        groups: [],
        seasonLabel: '',
        generatedAt: now,
      }
    }

    const wanted = new Set(subscriptions.map((item) => item.tid))
    const select = (candidate: AirCandidate) => wanted.has(defaultTidOf(candidate.entry) ?? candidate.entry.key)
    const digest = await this.buildAirings('sub', wanted, now, (at) => {
      const startMs = getDayStartMs(today(this.timeZone, at), this.timeZone)
      return {
        fromMs: startMs,
        toMs: startMs + 86400000 - 1,
        now: startMs,
        // 先按 tid 收窄再判断是否播完，避免为无关作品请求详情
        filter: select,
      }
    }, (items) => this.splitOvernight(items, now))

    debugLog('[digest] 订阅表 %s/%s: %d 条订阅 → 今日 %d 部',
      platform, channelId, subscriptions.length,
      digest.groups.reduce((sum, group) => sum + group.items.length, 0))
    return { ...digest, header: this.messages.subHeader(subscriptions.length) }
  }

  /** 把「今天」与「次日凌晨」分开，凌晨那组的标题改用更好读的「次日凌晨」 */
  private splitOvernight(items: DigestItem[], now: number): DigestGroup[] {
    const date = today(this.timeZone, now)
    return this.groupByDay(items).map((group) => {
      const day = group.date
      if (!day || day === date) return group
      return { ...group, label: this.messages.tomorrowDawnGroup(this.describeDate(getDayStartMs(day, this.timeZone))) }
    })
  }

  /**
   * 订阅作品未来若干天的排期，按时刻升序。与排期表的区别是不做「还在播」过滤（订阅是用户
   * 主动指定的），但已播完的必须滤掉：周期规则无限重复，旧季番照样能推算出「第 287 集」。
   */
  async upcomingAirings(tids: string[], days: number, now = Date.now()): Promise<DigestItem[]> {
    await this.prepare()
    const wanted = new Set(tids)
    if (!wanted.size) return []

    const startMs = getDayStartMs(today(this.timeZone, now), this.timeZone)
    const endMs = startMs + days * 86400000
    // 这里只做预筛：把无关作品去掉，避免为它们请求详情；完结判定统一交给下面三道闸门
    const candidates = this.airingsIn({
      fromMs: startMs,
      toMs: endMs - 1,
      activeOnly: false,
      onePerTitle: true,
    }).filter((candidate) => wanted.has(defaultTidOf(candidate.entry) ?? candidate.entry.key))

    // 与 buildAirings 同一套三段闸门：先本地、再 AniList、最后才为幸存者取 Bangumi 逐集档期
    const following = this.followingKeys(startMs)
    const locallyKept = this.dropLocallyFinished(candidates, startMs, following)
    const airingStates = await this.airingStatesOf(locallyKept, now)
    const survived = this.dropFinishedByAniList(locallyKept, startMs, airingStates)
    // 与 `buildAirings` 同一套做法：只为闸门 3 真正要判的作品取详情
    const airing = this.dropFinishedByEpisodeDates(
      survived,
      startMs,
      await this.subjectsForEpisodeDates(survived, airingStates),
      airingStates,
    )
    const subjects = await this.subjectsOf(airing)

    const items = await this.buildItems(airing, wanted, subjects, airingStates)
    debugLog('[digest] 订阅排期: %d 条订阅 → 未来 %d 天内 %d 场', tids.length, days, items.length)
    return items.sort((a, b) => a.atMs - b.atMs)
  }

  /** 按类型构建，供调度器与指令共用；订阅标记按目标频道计算 */
  async build(kind: DigestKind, platform: string, channelId: string, now = Date.now()): Promise<Digest> {
    const subscribed = await this.subscribedKeys(platform, channelId)
    if (kind === 'daily') return this.buildDaily(this.config.push.dailyOffsetDays, subscribed, now)
    if (kind === 'night') return this.buildNight(subscribed, now)
    if (kind === 'weekly') return this.buildWeekly(subscribed)
    if (kind === 'season') return this.buildSeason(0, subscribed, now)
    return this.buildSubscription(platform, channelId, now)
  }

  // #endregion

  // #region 摘要与截断

  /**
   * 收尾：套上上限、算统计行、拼出最终 `Digest`。`now` 必须由调用方传入而**不能取
   * `Date.now()`**：时间轴的分界线与条目时刻都由它推算，换成真实时间会落在不对应的一天上。
   */
  private finish(
    kind: DigestKind,
    header: string,
    summaryPrefix: string,
    groups: DigestGroup[],
    emptyText: string,
    now: number,
    seasonLabel = '',
  ): Digest {
    if (!groups.length) {
      debugLog('[digest] %s 无内容 (%s)', kind, emptyText)
      return { kind, header, summary: emptyText, groups: [], seasonLabel, generatedAt: now }
    }
    const limited = this.applyLimit(groups)
    const items = groups.flatMap((group) => group.items)
    const lateNight = items.filter((item) => Number(item.time.slice(0, 2)) < LATE_NIGHT_END_HOUR).length
    const base = `${summaryPrefix}${this.messages.summaryOf(items.length, lateNight)}`
    debugLog('[digest] %s 构建完成: %d 组 / %d 部 (深夜 %d)%s',
      kind, limited.groups.length, items.length, lateNight, limited.truncated ? `，${limited.truncated}` : '')
    return {
      kind,
      header,
      summary: limited.truncated ? `${base}，${limited.truncated}` : base,
      groups: limited.groups,
      seasonLabel,
      generatedAt: now,
    }
  }

  /**
   * 超出上限时截断，并给出剩余数量的提示。按「轮转」而不是「填满一组再下一组」分配额度：
   * 否则本周表前几天的列会用光全部额度，后面的日期整列消失。
   */
  private applyLimit(groups: DigestGroup[]): { groups: DigestGroup[]; truncated: string } {
    const max = this.config.content.maxItems
    const total = groups.reduce((sum, group) => sum + group.items.length, 0)
    // 0 表示不限制
    if (max <= 0 || total <= max) return { groups, truncated: '' }

    const budget = Math.max(1, Math.floor(max / groups.length))
    const taken = groups.map((group) => Math.min(group.items.length, budget))
    let used = taken.reduce((sum, value) => sum + value, 0)
    while (used < max) {
      let progressed = false
      for (let index = 0; index < groups.length && used < max; index++) {
        if (taken[index] >= groups[index].items.length) continue
        taken[index]++
        used++
        progressed = true
      }
      if (!progressed) break
    }

    const limited = groups.map((group, index) => ({ ...group, items: group.items.slice(0, taken[index]) }))
    return { groups: limited, truncated: this.messages.truncated(used, total) }
  }

  /** 展示用日期文案，例如 `9月24日周四`，写法随 `locale` 变化 */
  private describeDate(ms: number): string {
    return formatDayLabel(ms, this.timeZone, this.config.locale)
  }

  // #endregion

  // #region 频道与订阅读写

  async getChannel(platform: string, channelId: string): Promise<AnimeChannel | null> {
    const rows = await this.ctx.database.get('anime_channel', { platform, channelId })
    return rows[0] ?? null
  }

  async ensureChannel(channel: Omit<AnimeChannel, 'id'>): Promise<void> {
    await this.ctx.database.upsert('anime_channel', [channel], ['platform', 'channelId'])
  }

  async setKinds(
    platform: string,
    channelId: string,
    patch: Partial<Pick<AnimeChannel, 'dailyEnabled' | 'nightEnabled' | 'weeklyEnabled' | 'seasonEnabled'>>,
  ): Promise<void> {
    await this.ctx.database.set('anime_channel', { platform, channelId }, patch)
  }

  async listSubscriptions(platform: string, channelId: string): Promise<AnimeSubscription[]> {
    return this.ctx.database.get('anime_subscription', { platform, channelId, enabled: true })
  }

  async addSubscription(platform: string, channelId: string, tid: string, title: string): Promise<void> {
    await this.ctx.database.upsert('anime_subscription', [{
      platform,
      channelId,
      tid,
      title,
      enabled: true,
    }], ['platform', 'channelId', 'tid'])
  }

  /** 取消订阅：只把记录置为停用，保留历史名以便再次订阅时复用 */
  async removeSubscriptions(platform: string, channelId: string, tids: string[]): Promise<void> {
    if (!tids.length) return
    await this.ctx.database.set('anime_subscription', {
      platform,
      channelId,
      tid: { $in: tids },
    } as never, { enabled: false })
  }

  async clearSubscriptions(platform: string, channelId: string): Promise<number> {
    const rows = await this.listSubscriptions(platform, channelId)
    await this.ctx.database.set('anime_subscription', { platform, channelId }, { enabled: false })
    return rows.length
  }

  /** 上次清理已完结订阅的本地日期，用于「一天只跑一次」 */
  private lastPruneDate = ''

  /**
   * 取出这批订阅里已经播完的 tid，供 `anime.list` 标注「已播完」与自动清理共用；
   * 判定见 `isEntryFinished`。
   */
  async finishedSubscriptionTids(tids: string[], now = Date.now()): Promise<string[]> {
    if (!tids.length) return []
    await this.prepare()
    const entries = new Map<string, IndexEntry>()
    for (const tid of tids) {
      const matched = BGM_TID_RE.exec(tid)
      if (!matched) continue
      const entry = this.index.bySubjectId(Number(matched[1]))
      if (entry) entries.set(tid, entry)
    }
    if (!entries.size) return []

    const states = await this.resolveAiringStates([...entries.values()], now)
    return [...entries].filter(([, entry]) => this.isEntryFinished(entry, states, now)).map(([tid]) => tid)
  }


  /** 批量取这批条目对应的 AniList 状态；取不到时返回空表（调用方会退回本地依据） */
  private async resolveAiringStates(entries: IndexEntry[], now: number): Promise<Map<number, AiringState>> {
    if (!this.airing) return new Map()
    const ids = entries
      .map((entry) => entry.aniListId)
      .filter((id): id is number => id !== null)
    if (!ids.length) return new Map()
    try {
      return await this.airing.resolve(ids, this.config.localize.airingTtlHours / 24, now)
    } catch (error) {
      debugLog('[digest] 取 AniList 状态失败，改用本地依据: %s', errorMessage(error))
      return new Map()
    }
  }

  /**
   * 取这部作品在 AniList 记录里的首播时刻，用于季表。
   *
   * 季表窗口是整季三个月、一部作品在窗口内有几十场，不能用 `coversWindow`（季表几乎必然为真）。
   * 这里找**离我们算的首播最近的一场**并限定容差：差得远说明那条记录讲的是别的季度，回退索引层。
   */
  private seasonAirMs(entry: IndexEntry, fallback: number, states: Map<number, AiringState>): number {
    const state = entry.aniListId === null ? undefined : states.get(entry.aniListId)
    if (!state?.schedule.length) return fallback

    let nearest: ScheduledEpisode | null = null
    for (const episode of state.schedule) {
      if (!nearest || Math.abs(episode.atMs - fallback) < Math.abs(nearest.atMs - fallback)) nearest = episode
    }
    if (!nearest) return fallback
    if (Math.abs(nearest.atMs - fallback) > SEASON_AIR_MATCH_DAYS * 86400000) return fallback
    return nearest.atMs
  }

  /**
   * 把已经播完的订阅标记为停用，让它们从 `anime.list` 里消失。判定复用排期表**同一套依据**，
   * 因此不会把在播的作品清掉。只置 `enabled: false` 而不删行：用户重新订阅时 upsert 会改回
   * `true`。每天只跑一次（按本地日期去重），失败不影响推送。
   */
  async pruneFinishedSubscriptions(now = Date.now()): Promise<number> {
    const day = today(this.timeZone, now)
    if (this.lastPruneDate === day) return 0
    this.lastPruneDate = day

    await this.prepare()
    // 只查启用的订阅；不限频道，一次把全库待清理的都拿到
    let rows: AnimeSubscription[]
    try {
      rows = await this.ctx.database.get('anime_subscription', { enabled: true })
    } catch (error) {
      debugLog('[digest] 读取订阅失败，跳过清理: %s', errorMessage(error))
      return 0
    }
    if (!rows.length) return 0

    const finished = await this.finishedSubscriptionTids(rows.map((row) => row.tid), now)
    if (!finished.length) return 0

    try {
      await this.ctx.database.set(
        'anime_subscription',
        { tid: { $in: finished } } as never,
        { enabled: false },
      )
    } catch (error) {
      debugLog('[digest] 停用已完结订阅失败: %s', errorMessage(error))
      return 0
    }
    debugLog('[digest] 已完结的订阅 %d 部已从列表移除: %s', finished.length, finished.join(', '))
    return finished.length
  }

  /**
   * 这部作品是否已经播完。判据与出表闸门共用 `aniListFinished`，只在退化方式上不同：
   * 无法判定时退回本地 `end`（含一个周期的余量）。
   *
   * 比出表闸门多留一天（`fromMs = now - 86400000`）：AniList 在最终话当天就置 `FINISHED`，
   * 而那一话要到晚上才播，当天就停用订阅会让用户以为漏了最后一集。
   */
  private isEntryFinished(
    entry: IndexEntry,
    states: Map<number, AiringState>,
    now: number,
  ): boolean {
    const state = entry.aniListId === null ? undefined : states.get(entry.aniListId)
    const finished = this.aniListFinished(state, entry.broadcastMs, now, now - 86400000)
    if (finished !== null) return finished
    // AniList 没有该条目、或记录指的不是这一季时，退回本地 `end`（含一个周期的余量）
    return this.hasEnded(entry, now)
  }

  // #endregion

  // #region 检索

  /**
   * 按关键词检索作品；本地索引，不产生网络请求。
   *
   * @param limit 返回条数上限，`<= 0` 表示不限制
   */
  async search(keyword: string, limit = 10): Promise<DigestItem[]> {
    await this.prepare()
    const entries = this.index.search(keyword, limit)
    if (!entries.length) return []
    // 检索结果只展示名称 / 封面 / 评分 / 档期，不判断完结，因此不取逐集档期
    const subjects = await this.localizer.localizeByIds(
      entries.map((entry) => entry.bangumiId).filter((id): id is number => id !== null),
      false,
    )
    const now = Date.now()
    return entries.map((entry) => {
      const at = this.nextAirMs(entry, now)
      const candidate: AirCandidate = { entry, atMs: at, episode: this.episodeAt(entry, at) }
      return this.toItem(candidate, entry.bangumiId !== null ? subjects.get(entry.bangumiId) : undefined)
    })
  }

  /** 按条目 ID 解析作品名；同时接受 `253104` 与 `bgm:253104` 两种写法 */
  async resolveSubscriptionName(tid: string): Promise<string | null> {
    await this.prepare()
    const matched = BGM_TID_RE.exec(tid) ?? BGM_ID_RE.exec(tid)
    if (!matched) return null
    const id = Number(matched[1])
    const entry = this.index.bySubjectId(id)
    if (!entry) return null
    // 只是为了拿一个展示用的名字，不需要逐集档期
    const subjects = await this.localizer.localizeByIds([id])
    return this.toItem(
      { entry, atMs: this.nextAirMs(entry, Date.now()), episode: 1 },
      subjects.get(id),
    ).name
  }

  // #endregion
}