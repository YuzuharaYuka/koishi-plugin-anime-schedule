import { Schema } from 'koishi'
import {
  COVER_CONCURRENCY,
  DEFAULT_FONT_FAMILY,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SCORE_TTL_HOURS,
  DAILY_OFFSET_MAX,
  DAILY_OFFSET_MIN,
  DEFAULT_SUPERSAMPLE,
  LOCALIZE_TIMEOUT_SECONDS,
  MAX_SUPERSAMPLE,
} from './constants'
import type { DigestFormat, ImageLayout, PluginLocale, TimeZone, TitleStyle } from './types'
import { resolveTimeZone } from './utils/time'

export interface Config {
  timeZone: TimeZone
  locale: PluginLocale

  push: {
    dailyEnabled: boolean
    dailyTime: string
    dailyOffsetDays: number
    nightEnabled: boolean
    nightTime: string
    weeklyEnabled: boolean
    weeklyWeekday: 0 | 1 | 2 | 3 | 4 | 5 | 6
    weeklyTime: string
    seasonEnabled: boolean
    seasonTime: string
    updateReminderEnabled: boolean
    updateLookaheadMinutes: number
    updatePollMinutes: number
  }

  content: {
    /** 单次推送最多展示的作品数，0 表示不限制 */
    maxItems: number
    /** 超长期连载番的话数阈值，0 表示不过滤 */
    longRunningThreshold: number
  }

  output: {
    format: DigestFormat
    layout: ImageLayout
    coverLimit: number
    /** `anime.info` 按关键词查询时最多出几部，`0` 表示不限制 */
    infoKeywordLimit: number
    showCover: boolean
    showScore: boolean
    useForward: boolean
  }

  localize: {
    enabled: boolean
    titleStyle: TitleStyle
    /** 标题与封面的缓存天数 */
    cacheTtlDays: number
    /** 评分与评价人数的缓存小时数 */
    scoreTtlHours: number
    /** 播出状态（是否已完结）的缓存有效期，单位小时 */
    airingTtlHours: number
  }

  render: {
    fontFamily: string
    coverConcurrency: number
    coverCacheDays: number
    /** JPEG 编码质量（1-100） */
    jpegQuality: number
    /** 超采样倍数：画布按「逻辑尺寸 × 该值」建立后再等比缩放，小字笔画更锐利，体积与耗时随之上升 */
    supersample: number
  }

  subscription: {
    /** 单个群最多订阅的番剧数量，0 表示不限制 */
    maxPerChannel: number
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
      .description('时刻与日期换算时区')
      .default('Asia/Shanghai'),
    locale: Schema.union([
      Schema.const('zh-CN').description('简体中文'),
      Schema.const('ja-JP').description('日本語'),
      Schema.const('en-US').description('English'),
    ])
      .description('界面语言')
      .default('zh-CN'),
  }),

  Schema.object({
    push: Schema.object({
      dailyEnabled: Schema.boolean().description('每日更新表').default(true),
      dailyTime: Schema.string().pattern(TIME_PATTERN).description('推送时刻').default('08:00'),
      dailyOffsetDays: Schema.number()
        .min(DAILY_OFFSET_MIN).max(DAILY_OFFSET_MAX).step(1)
        .description('日期偏移，0 当天、-1 前一天、1 后一天')
        .default(0),
      nightEnabled: Schema.boolean().description('深夜档，当晚 21:00 至次日 06:00').default(true),
      nightTime: Schema.string().pattern(TIME_PATTERN).description('推送时刻').default('21:00'),
      weeklyEnabled: Schema.boolean().description('本周更新表').default(true),
      weeklyWeekday: Schema.union(WEEKDAYS.map((item) => Schema.const(item.value).description(item.label)))
        .description('周表的推送星期')
        .default(1),
      weeklyTime: Schema.string().pattern(TIME_PATTERN).description('推送时刻').default('08:00'),
      seasonEnabled: Schema.boolean().description('本季新番表').default(true),
      seasonTime: Schema.string().pattern(TIME_PATTERN).description('季度首日的推送时刻').default('08:00'),
      updateReminderEnabled: Schema.boolean().description('订阅作品的开播提醒').default(true),
      updateLookaheadMinutes: Schema.number()
        .min(1).step(1)
        .description('提前多少分钟提醒')
        .default(30),
      updatePollMinutes: Schema.number()
        .min(1).step(1)
        .description('检查间隔（分钟）')
        .default(10),
    }),
  }).description('推送设置'),

  Schema.object({
    content: Schema.object({
      maxItems: Schema.number()
        .min(0).step(1)
        .description('单次推送最多显示多少部，0 不限制')
        .default(0),
      longRunningThreshold: Schema.number()
        .min(0).step(1)
        .description('剔除长期连载番的话数阈值，0 不过滤')
        .default(0),
    }),
  }).description('推送内容'),

  Schema.object({
    output: Schema.object({
      format: Schema.union([
        Schema.const('image').description('风格化图片'),
        Schema.const('text').description('纯文本'),
      ])
        .description('推送形态，图片渲染失败时自动改用文本')
        .default('image'),
      layout: Schema.union([
        Schema.const('table').description('时间表'),
        Schema.const('list').description('卡片列表'),
      ])
        .description('图片排版')
        .default('table'),
      coverLimit: Schema.number()
        .min(0)
        .description('单张图片最多加载多少张封面，0 不限制')
        .default(0),
      infoKeywordLimit: Schema.number()
        .min(0)
        .description('anime.info 按关键词查询番剧时显示数量上限，0 不限制')
        .default(20),
      showCover: Schema.boolean().description('显示封面').default(true),
      showScore: Schema.boolean().description('显示评分，评价不足 10 条时隐藏').default(true),
      useForward: Schema.boolean()
        .description('纯文本模式用合并转发，避免刷屏')
        .default(true),
    }),
  }).description('输出设置'),

  Schema.object({
    localize: Schema.object({
      enabled: Schema.boolean()
        .description('使用中文标题与评分')
        .default(true),
      titleStyle: Schema.union([
        Schema.const('localized').description('仅中文'),
        Schema.const('both').description('中文（日文原名）'),
        Schema.const('original').description('仅日文原名'),
      ])
        .description('标题展示方式')
        .default('localized'),
      scoreTtlHours: Schema.number()
        .min(1).step(1)
        .description('评分多久后台补取一次（小时），到期不阻塞构建')
        .default(DEFAULT_SCORE_TTL_HOURS),
      cacheTtlDays: Schema.number()
        .min(1).step(1)
        .description('标题与封面的缓存天数')
        .default(30),
      airingTtlHours: Schema.number()
        .min(1).step(1)
        .description('是否已播完的缓存小时数')
        .default(6),
    }),
  }).description('本地化'),

  Schema.object({
    render: Schema.object({
      fontFamily: Schema.string()
        .description('字体族，留空则自动寻找系统中文字体')
        .default(DEFAULT_FONT_FAMILY),
      coverConcurrency: Schema.number()
        .min(1)
        .description('封面下载并发数')
        .default(COVER_CONCURRENCY),
      coverCacheDays: Schema.number()
        .min(0)
        .description('封面缓存天数，0 不写磁盘')
        .default(21),
      jpegQuality: Schema.number()
        .min(1).max(100).step(1)
        .description('编码质量')
        .default(DEFAULT_JPEG_QUALITY),
      supersample: Schema.number()
        .min(1).max(MAX_SUPERSAMPLE).step(1)
        .description('超采样倍数')
        .default(DEFAULT_SUPERSAMPLE),
    }),
  }).description('图片'),

  Schema.object({
    subscription: Schema.object({
      maxPerChannel: Schema.number()
        .min(0).step(1)
        .description('单个群最多订阅多少部，0 不限制')
        .default(0),
    }),
  }).description('订阅'),

  Schema.object({
    advanced: Schema.object({
      requestTimeout: Schema.number()
        .min(1)
        .description('单次请求超时（秒）')
        .default(LOCALIZE_TIMEOUT_SECONDS),
      retries: Schema.number()
        .min(0)
        .description('请求失败重试次数')
        .default(2),
      debug: Schema.boolean()
        .description('输出调试日志')
        .default(false),
    }),
  }).description('其他'),
])

/** 把配置夹到安全区间：只保证类型正确且不小于最小值，不设人为上限 */
export function normalizeConfig(config: Config): Config {
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
  const time = (value: string | undefined, fallback: string): string => (
    typeof value === 'string' && TIME_PATTERN.test(value) ? value : fallback
  )

  // 旧版本的 `both` 形态已移除：非 `text` 一律按图片处理
  const format: DigestFormat = config.output?.format === 'text' ? 'text' : 'image'

  // 轮询间隔不能大于提前量：调度器每 poll 分钟检查一次 [now, now+lookahead] 窗口，
  // 间隔更大时两次检查之间会留下覆盖不到的空档，场次静默漏发
  const lookahead = int(config.push?.updateLookaheadMinutes, 30, 1)
  const poll = int(config.push?.updatePollMinutes, 10, 1)

  return {
    ...config,
    timeZone: resolveTimeZone(config.timeZone, 'Asia/Shanghai' as TimeZone),
    push: {
      ...config.push,
      dailyTime: time(config.push?.dailyTime, '08:00'),
      dailyOffsetDays: intBetween(config.push?.dailyOffsetDays, 0, DAILY_OFFSET_MIN, DAILY_OFFSET_MAX),
      weeklyWeekday: Math.max(0, Math.min(6, int(config.push?.weeklyWeekday, 1))) as Config['push']['weeklyWeekday'],
      nightTime: time(config.push?.nightTime, '21:00'),
      weeklyTime: time(config.push?.weeklyTime, '08:00'),
      seasonTime: time(config.push?.seasonTime, '08:00'),
      updateLookaheadMinutes: lookahead,
      updatePollMinutes: Math.min(poll, lookahead),
    },
    content: {
      maxItems: int(config.content?.maxItems, 0),
      longRunningThreshold: int(config.content?.longRunningThreshold, 0),
    },
    output: {
      ...config.output,
      format,
      layout: config.output?.layout === 'list' ? 'list' : 'table',
      coverLimit: int(config.output?.coverLimit, 0),
      infoKeywordLimit: int(config.output?.infoKeywordLimit, 20),
    },
    localize: {
      ...config.localize,
      cacheTtlDays: int(config.localize?.cacheTtlDays, 30, 1),
      scoreTtlHours: int(config.localize?.scoreTtlHours, DEFAULT_SCORE_TTL_HOURS, 1),
      airingTtlHours: int(config.localize?.airingTtlHours, 6, 1),
    },
    render: {
      ...config.render,
      fontFamily: config.render?.fontFamily?.trim() || DEFAULT_FONT_FAMILY,
      coverConcurrency: int(config.render?.coverConcurrency, COVER_CONCURRENCY, 1),
      coverCacheDays: int(config.render?.coverCacheDays, 21),
      jpegQuality: Math.min(100, int(config.render?.jpegQuality, DEFAULT_JPEG_QUALITY, 1)),
      supersample: Math.min(MAX_SUPERSAMPLE, int(config.render?.supersample, DEFAULT_SUPERSAMPLE, 1)),
    },
    subscription: {
      ...config.subscription,
      maxPerChannel: int(config.subscription?.maxPerChannel, 0),
    },
    advanced: {
      ...config.advanced,
      requestTimeout: int(config.advanced?.requestTimeout, LOCALIZE_TIMEOUT_SECONDS, 1),
      retries: int(config.advanced?.retries, 2),
    },
  }
}
