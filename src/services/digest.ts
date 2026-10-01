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
import { LATE_NIGHT_END_HOUR, getMessages } from '../constants'
import type { AiringState, ScheduledEpisode } from '../types'
import type { AiringStatusService } from './airing'
import { Localizer } from './localizer'
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
 *
 * 起点取 21:00 而不是更晚，是为了把「今晚这一档」整段收进来；终点取 06:00 而不是 05:00，
 * 是为了覆盖凌晨 5 点档的场次。
 */
const EVENING_START_HOUR = 21

/**
 * 季表匹配 AniList 首播时刻时允许的偏差（天）。
 *
 * 超过这个跨度说明那条 AniList 记录讲的是别的季度，此时回退索引层的时刻。
 * 取 45 天：季表窗口有 10 天提前量，而「季末提前放送」与「延期开播」都可能偏出两周。
 */
const SEASON_AIR_MATCH_DAYS = 45

/**
 * 单次构建里最多按标题搜索多少条 AniList 补 ID。
 *
 * 按标题搜索只能一次一个请求，实测放开发送会让周表构建从数秒涨到三分多钟。
 * 这里限制**单次构建**的条数，优先处理近期播出的条目，其余的留到后续构建。
 * 更硬的总额度由 `AiringStatusService` 按进程控制。
 */
const TITLE_SEARCH_LIMIT = 8

/** 订阅表的 tid 形如 `bgm:<Bangumi 条目 ID>` */
const BGM_TID_RE = /^bgm:(\d+)$/

/**
 * 采信逐集档期的**末集日期**前，允许它与「第 total 集」推算位置相差的周期数。
 *
 * 预播、停播周都会让末集偏出推算位置一两个周期，因此容差取 2 个周期；
 * 而跨季乱序（长期番按季拆分、共用一个 Bangumi ID）会差出十几个周期，能被挡下。
 */
const FINAL_EPISODE_TOLERANCE_PERIODS = 2

/**
 * 判定「已播完」时，本场的 JST 日期最多可以在终映日之后几天。
 *
 * 取 0 天：**一旦终映日过去就不再出现**。AniList 只在整季播完时才给出 FINISHED，
 * 它自己就是权威，加余量只会让已完结的作品多留几周。终映当天仍保留（当天的场次
 * 可能还没播出）。
 */
const FINAL_EPISODE_DAY_GRACE = 0

/**
 * 采信 AniList 状态前，允许它的首播日期与我们的排期相差的天数。
 *
 * 用于挡下「bangumi-data 的 `aniList` ID 指向别的季度」——例如《クマーバ シーズン3》
 * 被映射到 2024 年的第一季，若直接采信会把在播番误杀。
 */
const ANILIST_ANCHOR_TOLERANCE_DAYS = 92

/**
 * 判定「上游开播日期写错」的阈值（天）。
 *
 * bangumi-data 偶尔会把新一季挂到旧条目上（`begin` 是新的，Bangumi ID 与 AniList ID
 * 却指向几年前的同一部作品）。此时逐集档期的首集与我们的开播日期会相差数年，
 * 而同季校验只会「不采信」并放行，因此需要这条兜底。
 * 取 180 天：正常的跨季条目、早期配信与延后开播都在这个范围内。
 */
const STALE_SEASON_GAP_DAYS = 180

/**
 * 逐集档期跨度相对最小跨度允许多出的天数。
 *
 * `末集日期 - 首集日期` 应在 `(total - 1) × 周期` 附近，多出的部分即停播周。
 * 超出这个额度说明逐集列表与当前排期不是同一季。
 */
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
 *
 * 播出时刻与集数全部由 bangumi-data 的周期规则推算，构建过程不产生番组表请求，
 * 耗时只剩 Bangumi 条目详情与封面下载。
 */
export class DigestService {
  readonly localizer: Localizer

  constructor(
    private ctx: Context,
    private config: Config,
    logger: Logger,
    readonly index: BangumiDataIndex,
    /** AniList 播出状态查询；未注入时退化为「按 Bangumi 逐集档期判断」 */
    private airing?: AiringStatusService,
  ) {
    this.localizer = new Localizer(ctx, config, logger)
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
   * 把索引里的周期规则展开成区间内的播出场次。
   *
   * 所有表的唯一数据入口：日表取一天，周表取七天，深夜档取一个跨夜的窗口。
   *
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
      // 第一道：丢掉「已过最终回」的场次。
      //
      // 这一步不可省，因为 `index.schedule()` 把放送周期当成**无限重复的规则**用，不看 `endMs`：
      // 一部 1995 年的番，只要周期是 7 天，在任意窗口里都能推算出一场。索引里 8897 部作品
      // 跨 1943 年至今，不做这道筛就会先造出上万个注定被丢弃的候选——实测周表 7760 场里
      // 7610 场来自已播完的旧番。
      //
      // `endMs` 取自 bangumi-data 的 `end`（最终回的实际播出时刻），因此判断是精确的，
      // 不需要额外余量：真正还在播的作品，其未来场次必然晚于任何已过去的 `endMs`，
      // 不会被误伤；反之 `endMs` 之后推算出的场次一定是周期规则的余波。
      // `endMs` 为空（长期番、当季新番）的条目整条保留，交给后面三道闸门。
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
   * 用 AniList 的**逐話时刻**替换推算出来的场次。
   *
   * AniList 的 `airingSchedule` 同时给出已播出与未播出的每一話，因此首周多集连播、
   * 中途停播、档位变更都不再需要额外机制，是目前最完整的排期来源。
   *
   * ## 采信条件只看「数据覆不覆盖我们这个窗口」
   *
   * **不看首播日期是否同期。** 长期番的 AniList 记录挂在第一季上，首播日期与我们算的
   * 当季可能差几百天，但它的 `airingSchedule` 里照样有本周的话数。以前这里要求
   * 「同期」（±92 天）才采信，于是当季 56 部里只有 1 部真正用上了 AniList 的时刻，
   * 其余全部退回周期推算，白白丢掉连播与停播信息。
   *
   * 安全性由**窗口判定**保证：只有 AniList 确实有落在本窗口内的话数时才替换，错配到
   * 别季的记录在本窗口里没有任何话数，自然被排除、仍得推算结果。判断「是否已播完」
   * 是另一回事，那道闸门要严得多，见 `isSameAniListSeason`。
   *
   * **例外：订正表命中的作品不替换。** 订正表记录的是日本电视档期，而 AniList 的
   * `airingAt` 是「某一时刻可以看」（可能取自 AT-X、配信平台等），两者实测有差异，
   * 例如《天幕のジャードゥーガル》顶层 07-09 05:30 而 AniList 07-04 23:00。排期表要的是
   * 电视首播，因此这种情况下以订正表为准。
   *
   * 没有 AniList 数据的条目（约三分之一，多为小众 / 短篇）保留周期规则的推算结果。
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

      // ⓪ **首播时刻以 AniList 为准**：AniList 说第 1 话在窗口之后，那本窗口内就一场都没有，
      // 连推算结果也要丢掉。
      //
      // 实例：《探偵はもう、死んでいる。 Season2》bangumi-data 的 `begin`/`broadcast` 都写
      // 2026-10-06 13:30Z，而 AniList 的首播是 10-07 12:30Z——真实首播推迟一天，落在周窗口
      // 之外。此时 `coversWindow` 判定未覆盖而退回推算，就会在窗口内**凭空多出一场**。
      //
      // 只在 `nextEpisode.episode === 1` 时启用：这时 AniList 说的是「这部还没开播，首播在
      // 某时刻」，断言可靠。**绝不推广到 episode > 1**——长期番的 AniList 排期常常滞后几
      // 个月（`BLEACH` 的下一话在 10-26、`小3アシベ` 停在 9/19 却每周都在播），拿「下一话
      // 之前没有场次」去否决它们，会把在播番整季清空。
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
        // ② 逐話表没覆盖窗口时，退回 `nextAiringEpisode`
        //
        // AniList 对**大量在播作品只回填历史场次**，`airingSchedule` 停在几个月前，
        // 但 `nextAiringEpisode` 依然准确。实测当周 513 部候选里，逐話表覆盖窗口的只有
        // 50 部，而另有 6 部正是「逐話表没覆盖、下一話却落在窗口内」——
        // 例如 `mofusatus`（逐話表停在 6/23，下一話 ep39 在 9/29）、
        // `名探偵プリキュア`（逐話表停在 7/18，下一話 ep36 在 10/3）。
        //
        // 退避策略与前几轮相反：这里**不要求**「本季内已经有过场次」，因为
        // `nextAiringEpisode` 是 AniList 对「下一話」的明确断言，可信度比历史场次更高。
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
   * 可选闸门：剔除「超长期连载番」。
   *
   * 这类作品（海螺小姐、樱桃小丸子、宝可梦 地平线、巧虎、战斗陀螺 X…）确实每周都在播，
   * 收录它们并不算错，但很多人不把它们当作「本季新番」，任其出现会让表格变得嘈杂。
   *
   * 判据只有一条：**展示话数 ≥ 阈值**。长期连载番的本集数自然会涨得很高，而一季 12～24
   * 话的当季番永远达不到阈值，因此不需要再引入别的条件。
   *
   * 早先这里还叠加了「AniList 未给出总话数（`episodes === null`）」作为前提，但那条实际
   * 上没有生效：大部分条目在闸门 2 之前就被筛掉，取不到 AniList 状态，于是「有状态」
   * 这个前提直接为假，该剔的长期番反而漏剔（实测 `キラキラADらっこちゃん` 第 239 话、
   * `ギャビーのドールハウス` 第 131 话都因此留在表里）。去掉它之后判据不再依赖网络，
   * 行为更可预测，也不会再被限流影响。
   *
   * **必须在条目构建之后调用**：`applyAiringSchedule` 内部会按作品去重，去重前后的
   * 「第几话」可能不同。判据要落在**最终展示的话数**上。
   *
   * 阈值由 `content.longRunningThreshold` 决定，**默认 0 表示不过滤**。
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
   * 一份排期是否覆盖了本次要展示的窗口。
   *
   * 判据是「窗口内至少有一場」，而不是「有未来話数」：日表与订阅表的窗口就是今天，
   * 一部当天播出、今天之后没有场次的作品，恰恰**应该**被采纳——按「有未来話数」判定
   * 会把它误判为滞后，于是退回推算时刻。窗口截断由 `finalizeCandidates` 负责，
   * 这里只回答「有没有可用的数据」。
   */
  private coversWindow(schedule: ScheduledEpisode[], options: AiringsOptions): boolean {
    return schedule.some((item) => item.atMs >= options.fromMs && item.atMs <= options.toMs)
  }

  /**
   * 把 `nextAiringEpisode` 外推成覆盖窗口的排期。
   *
   * AniList 只给出**下一話**，而窗口可能有 1～7 天甚至一整个季度，因此以它为锚点、
   * 用本条的周期天数向后铺，直到越过窗口末尾。
   *
   * 只用 `nextAiringEpisode` 本身、不掺入历史场次：历史场次可能是上一季的（长期番挂在
   * 第一季的条目上），混进来会算出错误的集数。锚点取 AniList 明确的「下一話」，集数从
   * 它开始递增，因此比「首播 + 周期 × N」的推算更贴近真实进度。
   *
   * 返回 `null` 表示外推结果落在窗口之外——此时调用方应保留推算结果。
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
   * 「接下来 14 天内排得上场次」的作品键集合，用于判断作品是否仍在连载。
   *
   * 条件只有一个：未来 `FOLLOWING_WINDOW_DAYS` 天内有场次，**且该场次没越过最终回**。
   *
   * `index.schedule()` 把放送周期当无限重复的规则用，所以「有场次」本身不足以说明在播——
   * 一部 1987 年的番将来两周里同样「有排期」。以前这里靠「首播是否在 400 天之内」来挡，
   * 但那会**误杀长期番**：海螺小姐、名侦探柯南、蜡笔小新、面包超人、哆啦A梦这类作品
   * 首播都在 400 天以前，于是被静默排除在表格之外。
   *
   * 现在改用与 `airingsIn` 同一套判据：只看 `endMs`。`endMs` 为空（长期番与当季新番）
   * 或尚未越过最终回的，就算还在播。这个判据是精确的，不再有魔法数字。
   *
   * ## 缓存必须按**窗口起点**索引，不能按日期
   *
   * 扫描区间是 `[fromMs, fromMs + 14 天)`，而 `fromMs` 因调用方而异：日表用当天 0 点
   * （`-o -1` 时是前一天 0 点）、周表用今天 0 点、调度器传 `Date.now()`。
   * 早先这里按「本地日期」缓存，于是**先跑的调用方决定了后面所有调用方的窗口**：
   * `anime.today -o -1` 先跑过之后，`anime.week` 会复用「以昨天为起点」的集合，
   * 把它前面那一天的场次漏掉。实测这会让周表的收录数在 62～73 之间跳变，
   * 取决于哪个指令先被调用。
   *
   * 现在按 `fromMs` 精确记忆：窗口一致才复用。同一轮构建里各表的 `fromMs` 本就相同，
   * 因此仍然只扫一遍。
   */
  private readonly followingCache = new Map<number, Set<string>>()
  /** 上限只是防止 `-o -7..7` 这类连续查询把缓存撑大 */
  private static readonly FOLLOWING_CACHE_MAX = 32

  private followingKeys(fromMs = Date.now()): Set<string> {
    const cached = this.followingCache.get(fromMs)
    if (cached) return cached

    const until = fromMs + FOLLOWING_WINDOW_DAYS * 86400000
    const keys = new Set<string>()

    // ① 首播已越过窗口、但没有最终回的条目（长期番）。
    //
    // 这类只有 183 部，却正是会被「首播窗口」误杀的那批。它们不在窗口内开播，所以扫不出
    // 场次，必须单独按 `nextAirMs` 判断——好在数量极小，代价可以忽略。
    for (const entry of this.index.all) {
      if (entry.endMs !== null || entry.broadcastMs === null) continue
      const next = this.nextAirMs(entry, fromMs)
      if (next < until) keys.add(entry.key)
    }

    // ② 最近开播、且接下来两周仍有场次的条目。
    //
    // 只需扫「近 `FOLLOWING_WINDOW_DAYS` 天开播」这一段：更早开播且有最终回的条目，
    // 其场次必然已越过 `endMs`（会被下面的判断丢掉），而真正还在播的那批已由 ① 收齐。
    // 这样扫描量从七千多降到几十。
    //
    // 这里**不能**用 `nextAirMs` 代替「扫场次」：它只往前推、不看 `endMs`，对最终回在
    // 很久以前的条目会算出一个荒谬的未来时刻（实测把海螺小姐推到第 2975 话，并把真正的
    // 当季新番挤出周表）。判定「还有排期」必须落在真实场次上。
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
   *
   * | 顺序 | 闸门 | 依据 | 代价 |
   * | :--- | :--- | :--- | :--- |
   * | 1 | `dropLocallyFinished` | `endMs` 与「近期开播且后续仍有排期」 | **零请求** |
   * | 2 | `dropFinishedByAniList` | AniList 的 `status` / 话数 / 终映日 | 已随 `airingStatesOf` 取回 |
   * | 3 | `dropFinishedByEpisodeDates` | Bangumi 逐集档期的末話日期 | 需要 `/v0/subjects` + `/v0/episodes` |
   *
   * 顺序很重要：闸门 1、2 都不需要新增请求，先跑它们能把大部分候选挡掉，闸门 3 于是
   * 只为**幸存者**付出代价。实测周表 547 场里 403 场在闸门 1/2 就被剔除，Bangumi 侧的
   * 请求量随之大幅下降（见 `buildAirings` 里的分段取详情）。
   *
   * 调用方按同一顺序串联三者，见 `buildAirings` 与 `upcomingAirings`。
   */

  /**
   * 闸门 1：只看本地索引就能判定「已播完」的作品，**不产生任何请求**。
   *
   * 依据是 bangumi-data 的 `end`（已有最终回时刻的旧番）与「近期开播且后续仍有排期」
   * （当季条目 `end` 几乎为空，靠这条兜住）。
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
   * 闸门 2：AniList 的完结判定。
   *
   * 采信前必须先确认这条 AniList 记录**和我们算的是同一季**：bangumi-data 里少数条目的
   * `aniList` ID 指向别的季度（例如《クマーバ シーズン3》被映射到 2024 年的第一季），
   * 直接采信会把在播番误杀。不同季或取不到记录时一律保留，交给闸门 3 或直接放行。
   *
   * AniList 是权威值，理由是：周期规则算的是**播出周数**，而周数并不等于话数——
   * 同日连播两话的作品（《無職転生Ⅲ》第 1・2 话连播）会让两者相差若干，「第几周」永远
   * 对不上「第几话」。AniList 直接给出「已播到第几话」与「共几话」，一比即可。
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
      if (!state || !this.isSameAniListSeason(state, candidate.entry.broadcastMs)) return true

      if (state.status === 'RELEASING' || state.status === 'NOT_YET_RELEASED') return true
      // 还有没播的集，说明仍在播（例如同季条目仍在追番进度）
      if (state.nextEpisode && state.nextEpisode.atMs > now) return true

      // 判据一：已经播完（集数够到，且最终回的播出时刻确实已经过去）
      //
      // 只看集数会在最终回当天就提前剔除（AniList 把当天的集也算作已播），
      // 因此还要比较时刻：`lastAiredMs <= now` 才算真的播过。
      if (state.episodes !== null && state.airedEpisodes !== null) {
        if (state.airedEpisodes >= state.episodes && state.lastAiredMs !== null && state.lastAiredMs <= now) {
          debugLog('[digest] 剔除 %s：AniList 已播 %d / %d 集，最终回 %s 已过', candidate.entry.title, state.airedEpisodes, state.episodes, new Date(state.lastAiredMs).toISOString().slice(0, 16))
          dropped++
          return false
        }
        return true
      }

      // 判据二：没有集数时退回终映日
      if (state.endDate) {
        const endMs = Date.parse(`${state.endDate}T00:00:00Z`)
        if (candidate.atMs - endMs <= FINAL_EPISODE_DAY_GRACE * 86400000) return true
        debugLog('[digest] 剔除 %s：AniList 状态 %s，终映 %s（共 %s 集）', candidate.entry.title, state.status, state.endDate, state.episodes ?? '?')
        dropped++
        return false
      }
      return true
    })
    if (dropped > 0) debugLog('[digest] 剔除已播完的作品 %d 部（AniList）', dropped)
    return kept
  }

  /**
   * 这条 AniList 记录与 `base`（我们的首播时刻）是不是同一季。
   *
   * **只用于「是否已播完」的判定，不用于排期。** AniList 的 `status` 与「已播話数 ≥
   * 总话数」是绝对的「完结」事实，一旦采信就会把作品从各表里剔除，因此必须确认这条
   * 记录确实是我们这一季：bangumi-data 里少数条目的 `aniList` ID 指向别的季度
   * （例如《クマーバ シーズン3》被映射到 2024 年的第一季），直接采信会把在播番误杀。
   *
   * 反过来，**取逐話時刻时故意不做这个校验**（见 `applyAiringSchedule`）：长期番的记录
   * 挂在第一季上，首播日期天然差很远，但它的排期依然有用，靠「窗口内有没有话数」
   * 即可安全判断。
   */
  private isSameAniListSeason(state: AiringState, base: number | null): boolean {
    // 没有首播日期时无法校验；宁可采信（AniList 的状态本身很可靠）
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
   * 按 AniList 条目 ID 批量取播出状态。
   *
   * 对**没有 `aniList` ID 的条目**先尝试按标题补一个 ID：bangumi-data 约三分之一的
   * 条目缺该 ID，其中一部分能在 AniList 搜到。补上之后这些条目也能用 AniList 的逐話
   * 時刻排期，而不必退回周期规则的推算。
   *
   * ## 为什么要限量
   *
   * 按标题搜索是**一次一个请求**（AniList 没有批量按标题查的接口），而一次构建可能有
   * 几十条缺 ID 的条目。实测放开发送会让周表构建从数秒涨到三分多钟，还有触发限流的
   * 风险。因此每次构建最多搜 `TITLE_SEARCH_LIMIT` 条，优先处理**近期播出**的
   * （它们在表里最显眼），其余的留到后续构建——搜过的结果（含「搜不到」）都记在
   * `AiringStatusService` 的进程内缓存里，因此整体仍是「每部作品一次」，只是分摊开来。
   */
  private async airingStatesOf(candidates: AirCandidate[]): Promise<Map<number, AiringState>> {
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
      return await this.airing.resolve(ids, this.config.localize.airingTtlHours / 24)
    } catch (error) {
      debugLog('[digest] AniList 状态查询失败，本次按逐集档期判定: %s', errorMessage(error))
      return new Map()
    }
  }

  /**
   * 闸门 3：Bangumi 逐集档期的末話日期。**只为闸门 1、2 的幸存者执行。**
   *
   * ## 不能越过 AniList 已给出的判断
   *
   * 闸门 2 只要确认了「同一季」并给出结论（无论保留还是剔除），闸门 3 就**不再插手**。
   * 这不是可有可无的顺序问题：Bangumi 的逐集档期经常属于**上一个季度**，而 bangumi-data
   * 的 `begin` 指向当季，两者天然差一个周期年，于是闸门 3 的「上游数据不一致」检查会
   * 误杀正在播的作品。
   *
   * 实例：《おでかけ子ザメ シーズン2》——AniList 明确 `RELEASING`（25/72 話、下一話
   * 尚有排期），但它的 Bangumi 逐集档期是 2025-04 起、2026-10 止的**上一季**记录，
   * `begin` 却是 2026-04-11，相差正好 365 天。逐集档期一旦越权，这部在播番就会从
   * 各表里消失。因此 AniList 的结论优先，逐集档期只负责 AniList 覆盖不到的部分。
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

      // 上游数据错配校验：`begin` 与逐集档期的首集相差数年时，这个条目的开播日期是错的。
      //
      // 实例：《仙王的日常生活 第四季》在 bangumi-data 里 `begin` 被写成 2026-07-01，
      // 而它的 Bangumi ID 与 AniList ID 都指向 2024-02-25 就已完结的那一季。
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
      // 必须按「日」比较：`lastAirMs` 是末集那一天的 0 点，而场次带有具体时刻，
      // 直接相减会把同一天深夜的场次误判为「已过」（09-27 09:00 与 09-27 23:30 差 14.5 小时）。
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
   * 作品是否已经播完（**只看本地索引，不产生请求**）。
   *
   * 依据是 bangumi-data 的 `end`，以及「近期开播且后续仍有排期」。两者都判断不出来时
   * 依次交给 `dropFinishedByAniList` 与 `dropFinishedByEpisodeDates`。
   */
  private isConcluded(entry: IndexEntry, now: number, followingKeys?: Set<string>): boolean {
    // `end` 必须排在「还有排期」之前：周期规则无限重复，最终回之后照样能推算出
    // 场次，只看「有排期」会被这些余波骗过去
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
   * 推算某部作品在 `fromMs` 之后的下一场播出。
   *
   * 一次性放送（特别篇、剧场版、整季一次放出）没有周期可递推，直接返回它自己的
   * 首播时刻，即使已经过去——否则会返回 `fromMs` 这个假时刻。
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
   * 把一条场次变成可渲染条目。
   *
   * 译名回退链：bangumi-data 简中 → 繁中 → 日文原名。
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
    const name = !localized || style === 'original'
      ? original
      : style === 'localized' ? localized
        : localized === original ? original : `${localized} (${original})`

    const scoreValue = this.localizer.enabled && output.showScore
      && typeof subject?.score === 'number' && subject.score > 0
      ? subject.score
      : null
    const time = formatClock(candidate.atMs, this.timeZone)
    const date = formatDate(candidate.atMs, this.timeZone)
    const firstDate = entry.beginMs !== null ? formatDate(entry.beginMs, this.timeZone) : ''

    return {
      tid: entry.bangumiId !== null ? `bgm:${entry.bangumiId}` : entry.key,
      bgmId: entry.bangumiId,
      date,
      time,
      episodeCount: candidate.episode,
      episode: this.messages.episodeShort(candidate.episode),
      // 一次性放送（剧场版等）没有「第几话」的概念，渲染层据此隐藏集数
      recurring: entry.recurring,
      name,
      // 封面优先用 AniList：它的图床在国内一般可直连，而 Bangumi 的 lain.bgm.tv 需要代理。
      // 取不到（无 aniListId、没查到状态、或那条没给图）时回退 Bangumi。
      coverUrl: aniList?.coverUrl || (entry.bangumiId !== null ? (subject?.coverUrl ?? '') : ''),
      scoreValue,
      score: scoreValue !== null ? scoreValue.toFixed(1) : '',
      firstYear: firstDate ? Number(firstDate.slice(0, 4)) : null,
      firstMonth: firstDate ? Number(firstDate.slice(5, 7)) : null,
      subscribed: entry.bangumiId !== null && subscribed.has(`bgm:${entry.bangumiId}`),
      airLabel: `${this.describeDate(candidate.atMs)} ${time}`.trim(),
      type: entry.type,
      atMs: candidate.atMs,
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

  /** 本群已订阅的作品键集合；订阅是频道级的，因此逐频道查询 */
  /**
   * 取某个频道已订阅的作品 tid 集合，用于在条目上标「已订阅」气泡。
   *
   * `build()`（定时推送）内部会调它；指令层手动查看时也要自己调一次，否则手动触发的
   * 图片里看不到气泡。
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
   * 按**各自的实际播出日**分组。
   *
   * 分组日期必须来自条目自己：本季表的场次横跨几十天，统一贴上「第一条的日期」
   * 会让周历排版把它们全塞进同一列。
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
   * 所有「按播出时刻列作品」的表共用的唯一管线。
   *
   * 日表、深夜档、周表与订阅表以前各写了一遍这段编排（取场次 → 补 AniList ID →
   * 取详情 → 换用 AniList 逐話時刻 → 剔除已播完 → 组装条目），四份代码只差参数。
   * 收敛到一处之后，「取详情的顺序」「完结判定用哪个参考时刻」这类容易改错的细节
   * 只有一份。
   *
   * @param buildWindow 由调用方给出窗口（以及可选的预筛）。预筛在**去重与判定之前**
   *   生效，订阅表靠它先按 tid 收窄，避免为无关作品请求详情。
   * @param groupOverride 覆盖默认分组。订阅表要把「今天」与「次日凌晨」分成两组，
   *   与四种固定表的分组方式都不同，因此由调用方给出。
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
    // bangumi-data 的 `end` 与「近期仍有排期」是纯本地判定；AniList 状态本来就要取。
    // 实测周表 547 场里 403 场在这一步就被剔除，于是下面只为幸存者请求 Bangumi 详情。
    const following = this.followingKeys(now)
    const locallyKept = this.dropLocallyFinished(predicted, options.fromMs, following)
    const airingStates = await this.airingStatesOf(locallyKept)
    const survived = this.dropFinishedByAniList(locallyKept, options.fromMs, airingStates)

    // ── 闸门 3：只对幸存者取 Bangumi 详情与逐集档期 ──
    const subjects = await this.subjectsOf(survived)
    const concluded = this.dropFinishedByEpisodeDates(survived, options.fromMs, subjects, airingStates)

    const scheduled = this.applyAiringSchedule(concluded, airingStates, options)
    const built = await this.buildItems(scheduled, subscribed, subjects, airingStates)
    // 可选：剔除超长期番（默认关闭，见 `content.longRunningThreshold`）。
    //
    // 必须在**条目构建之后**做：`applyAiringSchedule` 内部会按作品去重，去重前后的
    // 「第几话」可能不是同一个值（同一部作品在窗口内有多场时，保留的那一场未必是话数最大
    // 的那一场）。判据要落在**最终展示的话数**上，否则会出现「明明显示第 53 话却按第 49
    // 话判定」这种错位，导致该剔的没剔掉。
    const items = this.dropLongRunning(built)

    return this.finish(
      kind,
      this.headerOf(kind, window),
      '',
      groupOverride ? groupOverride(items) : this.groupOf(kind, window, items),
      kind === 'sub' ? this.messages.noAiringSub(subscribed.size) : this.emptyTextOf(kind),
    )
  }

  /**
   * 窗口的补充信息：只有「分组」与「表头」需要，且必须与 `AiringsOptions` 用同一个
   * `now` 算出来，因此集中在一处。标题里已经带了日期，副标题因此留空。
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
    const days = clamp(offset, -32, 32)
    return this.buildAirings('daily', subscribed, now, (at) => {
      const startMs = getDayStartMs(addDays(today(this.timeZone, at), days, this.timeZone), this.timeZone)
      return { fromMs: startMs, toMs: startMs + 86400000 - 1, now: startMs }
    })
  }

  /**
   * 深夜档更新表：覆盖「今晚 21:00 之后」与「次日 6:00 之前」两段。
   *
   * 凌晨场次按实际播出时刻展示，因此熬夜追更时一眼就能看到现在之后还有什么可看。
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
   * 本季（或指定季度）的新番概览。
   *
   * 概览而非排期：收录该季首播的全部 TV / WEB 动画，不剔除已播完的作品，
   * 卡片给的是首播时间。收录窗口见 `BangumiDataIndex.seasonWindow`。
   *
   * @param seasonOffset 相对当前季度的偏移：0 当季、-1 上一季
   */
  async buildSeason(seasonOffset = 0, subscribed: Set<string> = EMPTY_SETS, now = Date.now()): Promise<Digest> {
    await this.prepare()
    const { year, startMonth } = this.resolveSeason(seasonOffset, now)
    return this.buildSeasonOf(year, startMonth, subscribed)
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
  private async buildSeasonOf(year: number, startMonth: number, subscribed: Set<string>): Promise<Digest> {
    const seasonName = SEASON_NAMES[startMonth] ?? ''
    const label = this.messages.seasonLabel(year, startMonth)
    const header = this.messages.seasonHeader(label)
    const prefix = seasonName ? `${seasonName}番 ` : ''
    // 副标题写清收录窗口：季末提前放送的作品也算进这一季，读者需要知道边界
    const window = this.index.seasonWindow(year, startMonth)
    const rangeLabel = this.messages.rangeLabel(
      this.describeDate(window.startMs),
      this.describeDate(window.endMs - 86400000),
    )

    const premieres = this.index.season(year, startMonth)
    if (!premieres.length) {
      return { ...this.finish('season', header, prefix, [], this.messages.emptySeason, label), rangeLabel }
    }

    // 季表只展示「首播那一场」，不判断完结，因此不必取逐集档期（省掉每部一个请求）
    const subjects = await this.localizer.localizeByIds(
      premieres.map((entry) => entry.bangumiId).filter((id): id is number => id !== null),
      false,
    )
    // 首播时刻同样以 AniList 为准，取不到才回退索引层
    const states = await this.resolveAiringStates(premieres)

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
      ...this.finish('season', header, prefix, this.groupByDay(items), this.messages.emptySeason, label),
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
   * 订阅作品未来若干天的排期，按时刻升序。
   *
   * 与排期表的区别是不做「还在播」过滤——订阅是用户主动指定的作品。但已播完的
   * 必须滤掉：周期规则无限重复，一部 2021 年的季番今天照样能推算出「第 287 集」。
   */
  async upcomingAirings(tids: string[], days: number, now = Date.now()): Promise<DigestItem[]> {
    await this.prepare()
    const wanted = new Set(tids)
    if (!wanted.size) return []

    const startMs = getDayStartMs(today(this.timeZone, now), this.timeZone)
    const endMs = startMs + days * 86400000
    // 这里只做预筛：把无关作品去掉，避免为它们请求详情。
    // 完结判定统一交给下面三道闸门，不必在此重复一遍。
    const candidates = this.airingsIn({
      fromMs: startMs,
      toMs: endMs - 1,
      activeOnly: false,
      onePerTitle: true,
    }).filter((candidate) => wanted.has(defaultTidOf(candidate.entry) ?? candidate.entry.key))

    // 与 buildAirings 同一套三段闸门：先本地、再 AniList、最后才为幸存者取 Bangumi 逐集档期
    const following = this.followingKeys(startMs)
    const locallyKept = this.dropLocallyFinished(candidates, startMs, following)
    const airingStates = await this.airingStatesOf(locallyKept)
    const survived = this.dropFinishedByAniList(locallyKept, startMs, airingStates)
    const subjects = await this.subjectsOf(survived)
    const airing = this.dropFinishedByEpisodeDates(survived, startMs, subjects, airingStates)

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

  /** 收尾：统计、截断与摘要文案 */
  private finish(
    kind: DigestKind,
    header: string,
    summaryPrefix: string,
    groups: DigestGroup[],
    emptyText: string,
    seasonLabel = '',
  ): Digest {
    if (!groups.length) {
      debugLog('[digest] %s 无内容 (%s)', kind, emptyText)
      return { kind, header, summary: emptyText, groups: [], seasonLabel, generatedAt: Date.now() }
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
      generatedAt: Date.now(),
    }
  }

  /**
   * 超出上限时截断，并给出剩余数量的提示。
   *
   * 按「轮转」而不是「填满一组再下一组」分配额度：否则本周表的前几天会用光
   * 全部额度，后面的日期整列消失。
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
   * 取出这批订阅里已经播完的 tid。
   *
   * 供 `anime.list` 标注「已播完」与自动清理共用；判定见 `isEntryFinished`。
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

    const states = await this.resolveAiringStates([...entries.values()])
    return [...entries].filter(([, entry]) => this.isEntryFinished(entry, states, now)).map(([tid]) => tid)
  }


  /** 批量取这批条目对应的 AniList 状态；取不到时返回空表（调用方会退回本地依据） */
  private async resolveAiringStates(entries: IndexEntry[]): Promise<Map<number, AiringState>> {
    if (!this.airing) return new Map()
    const ids = entries
      .map((entry) => entry.aniListId)
      .filter((id): id is number => id !== null)
    if (!ids.length) return new Map()
    try {
      return await this.airing.resolve(ids, this.config.localize.airingTtlHours / 24)
    } catch (error) {
      debugLog('[digest] 取 AniList 状态失败，改用本地依据: %s', errorMessage(error))
      return new Map()
    }
  }

  /**
   * 取这部作品在 AniList 记录里的首播时刻，用于季表。
   *
   * 与日 / 周表共用「AniList 优先」的原则，但匹配方式不同：季表的窗口是整季三个月，
   * 一部作品在窗口内有几十场，所以不能用 `coversWindow`（季表几乎必然为真，等于没判断）。
   * 这里改成找**离我们算的首播最近的一场**并限定容差——合得上就用它；差得远说明那条
   * AniList 记录讲的是别的季度（长期番会把记录挂在第一季上），此时回退索引层更可靠。
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
   * 把已经播完的订阅标记为停用，让它们从 `anime.list` 里消失。
   *
   * 订阅是用户主动指定的，播完之后再留着只会让列表越积越长。判定复用与排期表**同一套
   * 依据**（AniList 的完结事实优先，否则看 bangumi-data 的 `end`），因此不会把在播的作品
   * 清掉。只置 `enabled: false` 而不删行：与 `anime.remove` 一致，用户重新订阅时
   * `addSubscription` 的 upsert 会把同一行的 `enabled` 改回 `true`。
   *
   * 每天只跑一次（按本地日期去重），失败不影响推送。
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
   * 这部作品是否已经播完。
   *
   * **必须与展示逻辑同源**，否则会把在播的作品清掉。两个容易踩的坑：
   *
   * 1. **先做同季校验**。bangumi-data 里长期番的记录会挂在较早的一季上
   *    （`Re:ゼロ 4th 奪還編` 的 `begin` 是 2026-08-12，而 AniList 记录的首播是 04-08，
   *    差 127 天）。此时 AniList 的 `FINISHED` 说的是别的内容，不能采信；展示逻辑遇到
   *    这种情况会退回本地 `end`，清理也必须照做。
   * 2. **最终话当天不算播完**。AniList 在最终话开播当天就把状态置为 `FINISHED`，
   *    而那一话要到晚上才播（`クレバテスⅡ` 的 ep13 排在 9/30 20:00）。只看
   *    「已播话数 ≥ 总话数」会把当天还在播的作品提前清掉。
   */
  private isEntryFinished(
    entry: IndexEntry,
    states: Map<number, AiringState>,
    now: number,
  ): boolean {
    const state = entry.aniListId === null ? undefined : states.get(entry.aniListId)
    if (state && this.isSameAniListSeason(state, entry.broadcastMs)) {
      // 还在连载或还没开播，一律保留
      if (state.status === 'RELEASING' || state.status === 'NOT_YET_RELEASED') return false
      // 还有没播的一话，说明没完结
      if (state.nextEpisode && state.nextEpisode.atMs > now) return false

      if (state.episodes !== null && state.airedEpisodes !== null) {
        // 只有「话数已够」且「最终话时刻确实过去了」才算完结
        return state.airedEpisodes >= state.episodes
          && state.lastAiredMs !== null
          && state.lastAiredMs <= now
      }
      // 没有话数时退回终映日；取不到就不敢清
      if (state.endDate) {
        const endMs = Date.parse(`${state.endDate}T00:00:00Z`)
        return Number.isFinite(endMs) && now > endMs + 86400000
      }
      return false
    }
    // AniList 没有该条目、或记录指的不是这一季时，退回本地 `end`（含一个周期的余量）
    return this.hasEnded(entry, now)
  }

  // #endregion

  // #region 检索

  /** 按关键词检索作品；本地索引，不产生网络请求 */
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