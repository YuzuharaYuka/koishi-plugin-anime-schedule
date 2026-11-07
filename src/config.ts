import { Schema } from 'koishi'
import {
  COVER_CONCURRENCY,
  COVER_MAX_EDGE_DEFAULT,
  COVER_MAX_EDGE_MAX,
  COVER_MAX_EDGE_MIN,
  DEFAULT_FONT_FAMILY,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SCORE_TTL_HOURS,
  DAILY_OFFSET_MAX,
  DAILY_OFFSET_MIN,
  DEFAULT_NIGHT_RANGE,
  DEFAULT_SUPERSAMPLE,
  LOCALIZE_TIMEOUT_SECONDS,
  MAX_COVER_CONCURRENCY,
  MAX_REQUEST_TIMEOUT_SECONDS,
  MAX_RETRIES,
  MAX_SUPERSAMPLE,
  MAX_UPDATE_LOOKAHEAD_MINUTES,
} from './constants'
import type { DigestFormat, ImageLayout, PluginLocale, TimeZone, TitleStyle } from './types'
import { parseClock, resolveTimeZone } from './utils/time'

export interface Config {
  timeZone: TimeZone
  locale: PluginLocale

  /** 定时推送的总开关；具体时刻在 `schedule` */
  push: {
    dailyEnabled: boolean
    nightEnabled: boolean
    weeklyEnabled: boolean
    seasonEnabled: boolean
    updateReminderEnabled: boolean
  }

  schedule: {
    dailyTime: string
    /** 深夜档起止时间：开始于当天，结束于次日 */
    nightRange: [string, string]
    nightTime: string
    weeklyTime: string
    seasonTime: string
    weeklyWeekday: 0 | 1 | 2 | 3 | 4 | 5 | 6
    dailyOffsetDays: number
    /** 开播提醒的提前量（分钟） */
    updateLookaheadMinutes: number
    /** 开播提醒的检查间隔（分钟），不会超过提前量 */
    updatePollMinutes: number
  }

  range: {
    /** 单个群或私聊最多订阅的番剧数量，0 表示不限制 */
    maxPerChannel: number
    /** 单个番组表最多展示的作品数，0 表示不限制 */
    maxItems: number
    /** 当前话数达到该值的作品不展示，0 表示不过滤 */
    longRunningThreshold: number
  }

  output: {
    format: DigestFormat
    layout: ImageLayout
    /** `anime.info` 按关键词查询时最多出几部，`0` 表示不限制 */
    infoKeywordLimit: number
    showCover: boolean
    showScore: boolean
    useForward: boolean
  }

  render: {
    fontFamily: string
    /** 封面解码与磁盘缩略图的最大边长（像素） */
    coverMaxEdge: number
    /** 单张番组表图最多加载几张封面，0 表示不限制 */
    coverLimit: number
    coverConcurrency: number
    /** 封面磁盘缓存天数，0 表示不写磁盘 */
    coverCacheDays: number
    /** JPEG 编码质量（1-100） */
    jpegQuality: number
    /** 超采样倍数：画布按「逻辑尺寸 × 该值」建立后再等比缩放，小字笔画更锐利，体积与耗时随之上升 */
    supersample: number
  }

  localize: {
    enabled: boolean
    titleStyle: TitleStyle
    /** 标题与封面地址的缓存天数 */
    cacheTtlDays: number
    /** 评分与评价人数的刷新间隔（小时） */
    scoreTtlHours: number
    /** AniList 播出状态的缓存有效期，单位小时 */
    airingTtlHours: number
  }

  advanced: {
    requestTimeout: number
    retries: number
    debug: boolean
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

const WEEKDAYS = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
] as const

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    timeZone: Schema.union([
      Schema.const('Asia/Shanghai').description('Asia/Shanghai (UTC+8)'),
      Schema.const('Asia/Tokyo').description('Asia/Tokyo (UTC+9)'),
      Schema.const('Asia/Hong_Kong').description('Asia/Hong_Kong (UTC+8)'),
      Schema.const('Asia/Taipei').description('Asia/Taipei (UTC+8)'),
      Schema.const('UTC').description('UTC'),
    ])
      .description('日期与时刻的换算时区')
      .default('Asia/Shanghai'),
    locale: Schema.union([
      Schema.const('zh-CN').description('简体中文'),
      Schema.const('ja-JP').description('日本語'),
      Schema.const('en-US').description('English'),
    ])
      .description('界面文案语言，不影响标题')
      .default('zh-CN'),
  }).description('基础'),

  Schema.object({
    push: Schema.object({
      dailyEnabled: Schema.boolean().description('开启后每天推送更新表').default(true),
      nightEnabled: Schema.boolean().description('开启后推送深夜档更新表').default(true),
      weeklyEnabled: Schema.boolean().description('开启后每周推送更新表').default(true),
      seasonEnabled: Schema.boolean().description('开启后每季首日推送新番表').default(true),
      updateReminderEnabled: Schema.boolean().description('开启后推送订阅开播提醒').default(true),
    }),
  }).description('推送'),

  Schema.object({
    schedule: Schema.object({
      dailyTime: Schema.string()
        .pattern(TIME_PATTERN)
        .description('每日推送时刻（HH:mm）')
        .default('08:00'),
      nightRange: Schema.tuple([
        Schema.string().pattern(TIME_PATTERN).required(),
        Schema.string().pattern(TIME_PATTERN).required(),
      ])
        // tuple 的推断类型是可变长数组，这里收窄成固定两元组
        .description('深夜档起止时间（HH:mm，开始→次日结束）')
        .default([...DEFAULT_NIGHT_RANGE]) as Schema<[string, string]>,
      nightTime: Schema.string()
        .pattern(TIME_PATTERN)
        .description('深夜档推送时刻（HH:mm）')
        .default('21:00'),
      weeklyTime: Schema.string()
        .pattern(TIME_PATTERN)
        .description('周表推送时刻（HH:mm）')
        .default('08:00'),
      seasonTime: Schema.string()
        .pattern(TIME_PATTERN)
        .description('季度首日推送时刻（HH:mm）')
        .default('08:00'),
      weeklyWeekday: Schema.union(WEEKDAYS.map((item) => Schema.const(item.value).description(item.label)))
        .description('周表推送星期')
        .default(1),
      dailyOffsetDays: Schema.number()
        .min(DAILY_OFFSET_MIN).max(DAILY_OFFSET_MAX).step(1)
        .description('每日推送日期偏移，负数往前')
        .default(0),
      updateLookaheadMinutes: Schema.number()
        .min(1).max(MAX_UPDATE_LOOKAHEAD_MINUTES).step(1)
        .description('开播提醒提前分钟数')
        .default(30),
      updatePollMinutes: Schema.number()
        .min(1).step(1)
        .description('开播提醒检查间隔')
        .default(10),
    }),
  }).description('时间'),

  Schema.object({
    range: Schema.object({
      maxPerChannel: Schema.number()
        .min(0).step(1)
        .description('单个会话订阅上限，0 不限')
        .default(0),
      maxItems: Schema.number()
        .min(0).step(1)
        .description('单个番组表作品上限，0 不限')
        .default(0),
      longRunningThreshold: Schema.number()
        .min(0).step(1)
        .description('更新表过滤话数阈值，0 关闭')
        .default(0),
    }),
  }).description('范围'),

  Schema.object({
    output: Schema.object({
      format: Schema.union([
        Schema.const('image').description('图片'),
        Schema.const('text').description('文本'),
      ])
        .description('番组表与详情的输出形态')
        .default('image'),
      layout: Schema.union([
        Schema.const('table').description('时间表'),
        Schema.const('list').description('卡片列表'),
      ])
        .description('番组表图片排版')
        .default('table'),

      showCover: Schema.boolean().description('图片中显示封面').default(true),
      showScore: Schema.boolean()
        .description('显示 Bangumi 评分')
        .default(true),
      useForward: Schema.boolean()
        .description('多段文本使用合并转发')
        .default(true),

      infoKeywordLimit: Schema.number()
        .min(0).step(1)
        .description('关键词详情最多显示几部，0 不限')
        .default(20),
    }),
  }).description('输出'),

  Schema.object({
    render: Schema.object({
      fontFamily: Schema.string()
        .description('图片字体，可填本机字体')
        .default(DEFAULT_FONT_FAMILY),
      coverMaxEdge: Schema.number()
        .min(COVER_MAX_EDGE_MIN).max(COVER_MAX_EDGE_MAX).step(32)
        .description('封面解码边长（像素）')
        .default(COVER_MAX_EDGE_DEFAULT),
      coverLimit: Schema.number()
        .min(0).step(1)
        .description('单张图最多加载几张封面，0 不限')
        .default(0),
      coverConcurrency: Schema.number()
        .min(1).max(MAX_COVER_CONCURRENCY).step(1)
        .description('封面下载并发数')
        .default(COVER_CONCURRENCY),
      coverCacheDays: Schema.number()
        .min(0).step(1)
        .description('封面缓存天数，0 不缓存')
        .default(21),
      jpegQuality: Schema.number()
        .min(1).max(100).step(1)
        .role('slider')
        .description('JPEG 编码质量（1–100）')
        .default(DEFAULT_JPEG_QUALITY),
      supersample: Schema.number()
        .min(1).max(MAX_SUPERSAMPLE).step(0.01)
        .role('slider')
        .description('超采样倍数（1–5）')
        .default(DEFAULT_SUPERSAMPLE),
    }),
  }).description('图片'),

  Schema.object({
    localize: Schema.object({
      enabled: Schema.boolean()
        .description('开启后使用中文标题与评分')
        .default(true),
      titleStyle: Schema.union([
        Schema.const('localized').description('仅中文'),
        Schema.const('both').description('中文（日文原名）'),
        Schema.const('original').description('仅日文原名'),
      ])
        .description('标题展示方式')
        .default('localized'),

      cacheTtlDays: Schema.number()
        .min(1).step(1)
        .description('标题与封面地址缓存天数')
        .default(30),
      scoreTtlHours: Schema.number()
        .min(1).step(1)
        .description('评分刷新间隔（小时）')
        .default(DEFAULT_SCORE_TTL_HOURS),
      airingTtlHours: Schema.number()
        .min(1).step(1)
        .description('播出状态缓存（小时）')
        .default(6),
    }),
  }).description('本地化'),

  Schema.object({
    advanced: Schema.object({
      requestTimeout: Schema.number()
        .min(1).max(MAX_REQUEST_TIMEOUT_SECONDS)
        .description('默认请求超时（秒）')
        .default(LOCALIZE_TIMEOUT_SECONDS),
      retries: Schema.number()
        .min(0).max(MAX_RETRIES).step(1)
        .description('请求失败重试次数')
        .default(2),
      debug: Schema.boolean()
        .description('开启后输出调试日志')
        .default(false),
    }),
  }).description('高级'),
])

/**
 * 1.1.x 及更早版本的配置布局。
 *
 * 旧版把时间字段放在 `push` 下、订阅上限放在 `subscription` 下、封面上限放在 `output` 下。
 * 升级后这些值仍可能留在 koishi.yml 里，读取一次并搬到新分组，避免升级后静默回到默认值。
 */
interface LegacyConfig {
  push?: {
    dailyTime?: string
    nightTime?: string
    weeklyTime?: string
    seasonTime?: string
    weeklyWeekday?: number
    dailyOffsetDays?: number
    updateLookaheadMinutes?: number
    updatePollMinutes?: number
  }
  content?: {
    maxItems?: number
    longRunningThreshold?: number
  }
  subscription?: {
    maxPerChannel?: number
  }
  output?: {
    coverLimit?: number
  }
}

/** 校验深夜档范围：必须跨午夜，返回补零后的 [开始, 结束] */
function normalizeNightRange(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return [...DEFAULT_NIGHT_RANGE]
  const start = typeof value[0] === 'string' ? parseClock(value[0]) : null
  const end = typeof value[1] === 'string' ? parseClock(value[1]) : null
  if (!start || !end) return [...DEFAULT_NIGHT_RANGE]
  const startMinutes = start.hour * 60 + start.minute
  const endMinutes = end.hour * 60 + end.minute
  // 开始必须在中午之后、结束在次日中午之前，且确实跨过午夜；否则会得到当天或超长窗口
  if (startMinutes < 12 * 60 || endMinutes >= 12 * 60 || startMinutes <= endMinutes) {
    return [...DEFAULT_NIGHT_RANGE]
  }
  const clock = (item: { hour: number; minute: number }) => (
    `${String(item.hour).padStart(2, '0')}:${String(item.minute).padStart(2, '0')}`
  )
  return [clock(start), clock(end)]
}

/** 把配置夹到安全区间：只保证类型正确且不小于最小值，不设人为上限 */
export function normalizeConfig(config: Config): Config {
  const legacy = config as Config & LegacyConfig
  const legacyPush = legacy.push ?? {}
  const legacyContent = legacy.content ?? {}
  const legacySubscription = legacy.subscription ?? {}
  const legacyOutput = legacy.output ?? {}

  /** 取整并夹到不小于 `min`（默认 0）。允许负值的字段不能走这个默认值 */
  const int = (value: number | undefined, fallback: number, min = 0): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.round(value))
  }
  /** 取整并夹到 `[min, max]`；用于允许负值的字段，如 `dailyOffsetDays` */
  const intBetween = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  /** 保留两位小数并夹到 `[min, max]`，用于超采样倍率等连续值 */
  const decimal = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value * 100) / 100))
  }
  const bool = (value: boolean | undefined, fallback: boolean): boolean => (
    typeof value === 'boolean' ? value : fallback
  )
  const time = (value: string | undefined, fallback: string): string => (
    typeof value === 'string' && TIME_PATTERN.test(value) ? value : fallback
  )

  // 旧版本的 `both` 形态已移除：非 `text` 一律按图片处理
  const format: DigestFormat = config.output?.format === 'text' ? 'text' : 'image'
  const titleStyle: TitleStyle = config.localize?.titleStyle === 'both' || config.localize?.titleStyle === 'original'
    ? config.localize.titleStyle
    : 'localized'

  // 旧版字段若还在 yaml 里，优先取旧值：schema 会先把新字段填成默认值，
  // 直接读新字段会把升级前的设置静默覆盖掉
  const lookahead = Math.min(
    MAX_UPDATE_LOOKAHEAD_MINUTES,
    int(legacyPush.updateLookaheadMinutes ?? config.schedule?.updateLookaheadMinutes, 30, 1),
  )
  const poll = int(legacyPush.updatePollMinutes ?? config.schedule?.updatePollMinutes, 10, 1)

  return {
    ...config,
    timeZone: resolveTimeZone(config.timeZone, 'Asia/Shanghai' as TimeZone),
    push: {
      dailyEnabled: bool(config.push?.dailyEnabled, true),
      nightEnabled: bool(config.push?.nightEnabled, true),
      weeklyEnabled: bool(config.push?.weeklyEnabled, true),
      seasonEnabled: bool(config.push?.seasonEnabled, true),
      updateReminderEnabled: bool(config.push?.updateReminderEnabled, true),
    },
    schedule: {
      dailyTime: time(legacyPush.dailyTime ?? config.schedule?.dailyTime, '08:00'),
      nightRange: normalizeNightRange(config.schedule?.nightRange),
      nightTime: time(legacyPush.nightTime ?? config.schedule?.nightTime, '21:00'),
      weeklyTime: time(legacyPush.weeklyTime ?? config.schedule?.weeklyTime, '08:00'),
      seasonTime: time(legacyPush.seasonTime ?? config.schedule?.seasonTime, '08:00'),
      weeklyWeekday: Math.max(0, Math.min(6,
        int(legacyPush.weeklyWeekday ?? config.schedule?.weeklyWeekday, 1),
      )) as Config['schedule']['weeklyWeekday'],
      dailyOffsetDays: intBetween(
        legacyPush.dailyOffsetDays ?? config.schedule?.dailyOffsetDays,
        0,
        DAILY_OFFSET_MIN,
        DAILY_OFFSET_MAX,
      ),
      updateLookaheadMinutes: lookahead,
      updatePollMinutes: Math.min(poll, lookahead),
    },
    range: {
      maxPerChannel: int(legacySubscription.maxPerChannel ?? config.range?.maxPerChannel, 0),
      maxItems: int(legacyContent.maxItems ?? config.range?.maxItems, 0),
      longRunningThreshold: int(legacyContent.longRunningThreshold ?? config.range?.longRunningThreshold, 0),
    },
    output: {
      format,
      layout: config.output?.layout === 'list' ? 'list' : 'table',
      infoKeywordLimit: int(config.output?.infoKeywordLimit, 20),
      showCover: bool(config.output?.showCover, true),
      showScore: bool(config.output?.showScore, true),
      useForward: bool(config.output?.useForward, true),
    },
    render: {
      fontFamily: config.render?.fontFamily?.trim() || DEFAULT_FONT_FAMILY,
      coverMaxEdge: Math.min(
        COVER_MAX_EDGE_MAX,
        int(config.render?.coverMaxEdge, COVER_MAX_EDGE_DEFAULT, COVER_MAX_EDGE_MIN),
      ),
      coverLimit: int(legacyOutput.coverLimit ?? config.render?.coverLimit, 0),
      coverConcurrency: Math.min(
        MAX_COVER_CONCURRENCY,
        int(config.render?.coverConcurrency, COVER_CONCURRENCY, 1),
      ),
      coverCacheDays: int(config.render?.coverCacheDays, 21),
      jpegQuality: Math.min(100, int(config.render?.jpegQuality, DEFAULT_JPEG_QUALITY, 1)),
      supersample: decimal(config.render?.supersample, DEFAULT_SUPERSAMPLE, 1, MAX_SUPERSAMPLE),
    },
    localize: {
      enabled: bool(config.localize?.enabled, true),
      titleStyle,
      cacheTtlDays: int(config.localize?.cacheTtlDays, 30, 1),
      scoreTtlHours: int(config.localize?.scoreTtlHours, DEFAULT_SCORE_TTL_HOURS, 1),
      airingTtlHours: int(config.localize?.airingTtlHours, 6, 1),
    },
    advanced: {
      requestTimeout: Math.min(
        MAX_REQUEST_TIMEOUT_SECONDS,
        int(config.advanced?.requestTimeout, LOCALIZE_TIMEOUT_SECONDS, 1),
      ),
      retries: Math.min(MAX_RETRIES, int(config.advanced?.retries, 2)),
      debug: bool(config.advanced?.debug, false),
    },
  }
}
