/**
 * 本插件的领域类型。
 *
 * 数据来自 bangumi-data（本地依赖：作品清单、译名、条目 ID、周期时刻）与
 * Bangumi API（按条目 ID 取封面、评分、开播日）。
 */

/** 推送类型：每日更新表 / 深夜档 / 本周更新表 / 本季新番表 / 单部番剧订阅 */
export type DigestKind = 'daily' | 'night' | 'weekly' | 'season' | 'sub'

/** 推送渲染出的最终形态 */
export type DigestFormat = 'text' | 'image'

/** 图片排版：`table` 时间表（单日时间轴 / 七日周历），`list` 卡片列表长图 */
export type ImageLayout = 'table' | 'list'

/** 界面语言 */
export type PluginLocale = 'zh-CN' | 'ja-JP' | 'en-US'

/** 可选时区，与配置页的下拉选项保持一致 */
export type TimeZone = 'Asia/Shanghai' | 'Asia/Tokyo' | 'Asia/Hong_Kong' | 'Asia/Taipei' | 'UTC'

/** 标题展示方式 */
export type TitleStyle = 'localized' | 'original' | 'both'

/** 数据库里的频道推送开关 */
export interface AnimeChannel {
  id: number
  platform: string
  channelId: string
  guildId: string
  botId: string
  dailyEnabled: boolean
  nightEnabled: boolean
  weeklyEnabled: boolean
  seasonEnabled: boolean
  /** 频道整体开关，关闭后不再接收定时推送（订阅提醒不受影响） */
  enabled: boolean
}

/**
 * 数据库里的单部番剧订阅，`platform + channelId + tid` 唯一。
 *
 * `tid` 形如 `bgm:<条目 ID>`：既是 bangumi-data 的稳定键，也能直接查封面与评分。
 */
export interface AnimeSubscription {
  id: number
  platform: string
  channelId: string
  /** 形如 `bgm:253104` */
  tid: string
  /** 订阅时的作品名，仅用于展示，推送时按 ID 重新解析 */
  title: string
  /** 取消订阅只置为 false，保留历史记录 */
  enabled: boolean
}

/** 数据库里的推送记录，用于幂等去重 */
export interface AnimeDispatch {
  id: number
  platform: string
  channelId: string
  digestKind: DigestKind
  dedupeKey: string
  /** 记录产生的时间戳，用于过期清理 */
  dispatchedAt: number
}

declare module 'koishi' {
  interface Tables {
    anime_channel: AnimeChannel
    anime_subscription: AnimeSubscription
    anime_dispatch: AnimeDispatch
  }
}

/** 本地化缓存的一条记录（按 Bangumi 条目 ID 索引） */
export interface LocalizeCacheEntry {
  /** Bangumi 条目 ID */
  subjectId: number
  /** 中文名，缺失时回落为日文原名 */
  title: string
  coverUrl: string
  /**
   * 评分，两位小数。
   *
   * 由 `rating.count`（各分数段人数）算出的**算术平均**，而不是 Bangumi 直接给的
   * `rating.score`——后者只保留一位小数（实测 60 个条目里带两位小数的为 0），
   * 自己算才有第二位。四舍五入到一位后与网站显示一致，不会造成「对不上」的观感。
   * `rating.count` 缺失时退回 `rating.score`。
   */
  score: number | null
  ratingTotal: number | null
  /**
   * 评分与 `ratingTotal` 的取回时刻。
   *
   * 与 `cachedAt` 分开，因为两者保质期差很多：标题与封面几乎不变（`cacheTtlDays`，
   * 默认 30 天），而**新番的评分在开播头几周会剧烈变化**（样本量从个位数涨到几百），
   * 用 30 天缓存会一直显示「只有十几个人投票」时的噪声值。见 `localize.scoreTtlHours`。
   *
   * 旧缓存没有这个字段，按 `cachedAt` 处理（即可能立刻被刷新一次）。
   */
  scoreCachedAt?: number
  /**
   * Bangumi 给出的总集数，仅作缓存留档。
   *
   * 不要用它判断是否已播完：它统计的是**本季**集数，长期番按季重置，
   * 与从首播累计的集数不可比。真正的依据是 `lastAirDate`。
   */
  totalEpisodes: number | null
  /**
   * 是否已经取过逐集档期。
   *
   * 逐集档期是一个**额外请求**（`/v0/episodes`），而且只有「判断是否已播完」和
   * 「校准订正表 since」用得到它。因此本季表与关键词检索这类只做展示的路径会跳过它，
   * `firstAirMs` / `lastAirMs` 随之留空。
   *
   * 留空**不等于**「没有逐集档期」。用这个标记而不是直接看那两个字段，是为了让
   * `isFresh` 能区分「没取过 → 该取」与「取过了但没有 → 不必重试」。
   */
  hasEpisodeTimes?: boolean
  /**
   * 首个正规集的播出日（该日期的 UTC 0 点），用于把订正表的 since 定死。
   *
   * `undefined` 表示**本次没有取**逐集档期（见 `hasEpisodeTimes`），`null` 表示取过但
   * 该条目没有可用的集数日期。
   */
  firstAirMs?: number | null
  /** 最后一个正规集的播出日（该日期的 UTC 0 点），用于判断是否已播完；语义同 `firstAirMs` */
  lastAirMs?: number | null
  /** 开播日期 `YYYY-MM-DD`，未知时为 null */
  airDate: string | null
  /**
   * 该条目在 Bangumi 上**不存在**（接口返回 404）。
   *
   * 记下来避免每次构建都重新请求——`アイドリッシュセブン` 那类只在 AniList 有条目、
   * Bangumi 还没建立的 OVA 会一直 404，每次都要走完超时与重试。
   * 这类条目仍然可以出现在表里（排期来自 AniList），只是拿不到中文名与封面。
   */
  missing?: boolean
  /** 写入时间（毫秒时间戳） */
  cachedAt: number
}

/** 本地化缓存文件的整体结构 */
export interface LocalizeCacheFile {
  version: number
  entries: Record<string, LocalizeCacheEntry>
}

/** 一次构建完成、等待渲染或发送的推送 */
export interface Digest {
  kind: DigestKind
  /** 列表头，例如 `今日番剧更新 (9月22日 周二)` */
  header: string
  /** 统计行，例如 `共 12 部作品，其中 3 部为深夜档` */
  summary: string
  groups: DigestGroup[]
  /** 季度文案，仅本季表会填充 */
  seasonLabel: string
  /** 副标题，仅周历表与季表会填 */
  rangeLabel?: string
  generatedAt: number
}

export interface DigestGroup {
  label: string
  items: DigestItem[]
  /** 该分组对应的播出日 `YYYY-MM-DD`，表格排版按它决定列位置 */
  date?: string
  /** 本地星期序号，0 为周日 */
  weekday?: number
  isToday?: boolean
}

/** 一条待渲染的播出记录 */
export interface DigestItem {
  /** 形如 `bgm:253104` */
  tid: string
  /** Bangumi 条目 ID，展示在卡片上供用户订阅；缺失时为 null */
  bgmId: number | null
  /** 本地时区下的播出日 `YYYY-MM-DD` */
  date: string
  /** 本地时区下的播出时刻 `HH:mm` */
  time: string
  /** 集数：首次播出为 1，之后按周期递推 */
  episodeCount: number
  /** 集数文本，例如 `#5` */
  episode: string
  /**
   * 该作品是否有可重复的周期规则。
   *
   * `false` 表示一次性放送（剧场版、特别篇、整季一次放出），此时 `episodeCount` 恒为 1
   * 但没有「第几话」的概念，卡片上不应显示集数。
   */
  recurring: boolean
  /** 展示用名字，例如 `无职转生 (無職転生)` */
  name: string
  /** 封面图 URL，未取到条目详情时为空 */
  coverUrl: string
  scoreValue: number | null
  /** 评分文本，例如 `7.9`，无评分时为空 */
  score: string
  /** 首播年份，未知时为 null */
  firstYear: number | null
  /** 首播月份，未知时为 null */
  firstMonth: number | null
  /** 是否在本群的订阅列表里 */
  subscribed: boolean
  /** 日期文案，例如 `9月24日周四 22:30` */
  airLabel: string
  /** 作品形态：tv / web / ova / movie 等 */
  type: string
  /** 播出时刻（UTC 毫秒），用于排序与去重 */
  atMs: number
}

/** 渲染图片所需的可绘制内容 */
export interface RenderPayload {
  /** 决定使用哪一种排版 */
  kind: DigestKind
  header: string
  summary: string
  groups: DigestGroup[]
  seasonLabel: string
  rangeLabel: string
  footer: string
}

/** AniList 的播出状态 */
export type AniListStatus = 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS' | 'UNKNOWN'

/** 一話的播出时刻 */
export interface ScheduledEpisode {
  /** 话数，从 1 起 */
  episode: number
  /** 播出时刻（绝对 UTC 毫秒） */
  atMs: number
}

/**
 * AniList 给出的播出数据。
 *
 * 只在内存中缓存、不落盘——AniList 的使用条款禁止把它当作「数据存储服务」。
 */
export interface AiringState {
  /** AniList 条目 ID */
  aniListId: number
  status: AniListStatus
  /** 总话数，未知为 null */
  episodes: number | null
  /** 首播日期 `YYYY-MM-DD`，未知为 null；用于校验这条记录与我们是同一季 */
  startDate: string | null
  /** 终映日期 `YYYY-MM-DD`，未知为 null */
  endDate: string | null
  /**
   * 逐話播出时刻，按话数升序；含已播出与未播出。
   *
   * 这是排期的**直接依据**：不再靠「首播 + 周期 × (话数-1)」推算，因此首周多集连播、
   * 中途停播、档位变更都能自动正确。
   */
  schedule: ScheduledEpisode[]
  /** 已播出到第几話，无排期数据时为 null */
  airedEpisodes: number | null
  /** 已播出的最后一話的时刻，无排期数据时为 null */
  lastAiredMs: number | null
  /** 下一話；已播完或未知时为 null */
  nextEpisode: ScheduledEpisode | null
  /**
   * 封面图 URL（AniList 的 `extraLarge`，缺失时 `large`）。
   *
   * 与 Bangumi 的封面并存：渲染时**优先用这张**——AniList 的图床在国内一般可直连，
   * 而 Bangumi 的 `lain.bgm.tv` 需要代理。取不到时回退 Bangumi。
   */
  coverUrl: string
  /** 取回时刻，用于判断缓存是否过期 */
  cachedAt: number
}
