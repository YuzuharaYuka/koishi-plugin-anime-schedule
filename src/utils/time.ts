/**
 * 时区与日期工具。
 *
 * 所有「哪一天 / 几点」的判断都必须走这里：bangumi-data 的周期时刻是 UTC，
 * 而用户按自己配置的时区理解「今天」，直接使用 `Date` 的本地方法会算错。
 */

const PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>()
const LABEL_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PARTS_FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

/**
 * 展示用日期格式器。
 * 语言与日期写法都交给 `Intl`，避免在中文文案里硬编码 `M月D日` 而
 * 让 en-US / ja-JP 界面出现混排。
 */
function getLabelFormatter(timeZone: string, locale: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`
  let formatter = LABEL_FORMATTERS.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    })
    LABEL_FORMATTERS.set(key, formatter)
  }
  return formatter
}

/** 验证一个时区名是否可用，不可用时回退到默认时区 */
export function resolveTimeZone<T extends string>(timeZone: string, fallback: T): T {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return timeZone as T
  } catch {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: fallback }).format(0)
      return fallback
    } catch {
      return 'UTC' as T
    }
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

function readParts(ms: number, timeZone: string): ZonedParts {
  const parts = getPartsFormatter(timeZone).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  // en-CA 的 hour 在 24 小时制下会把午夜给出 24，需要归一
  const hour = read('hour') % 24
  const year = read('year')
  const month = read('month')
  const day = read('day')
  const date = new Date(Date.UTC(year, month - 1, day))
  return { year, month, day, hour, minute: read('minute'), second: read('second'), weekday: date.getUTCDay() }
}

/** 该时区在指定时刻相对 UTC 的偏移（毫秒） */
export function getTimeZoneOffsetMs(ms: number, timeZone: string): number {
  const parts = getPartsFormatter(timeZone).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour') % 24, read('minute'), read('second'))
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** 把 YYYY-MM-DD 解析为日期各部分，格式非法时返回 null */
export function parseDateString(value: string): { year: number; month: number; day: number } | null {
  const matched = ISO_DATE.exec(value)
  if (!matched) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

/** 本地日期字符串（YYYY-MM-DD） */
export function formatDate(ms: number, timeZone: string): string {
  const { year, month, day } = readParts(ms, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 本地时刻（HH:mm） */
export function formatClock(ms: number, timeZone: string): string {
  const { hour, minute } = readParts(ms, timeZone)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 本地星期，0 表示周日 */
export function getLocalWeekday(ms: number, timeZone: string): number {
  return readParts(ms, timeZone).weekday
}

/** 某一日在本地的 0 点对应的 UTC 毫秒 */
export function getDayStartMs(date: string, timeZone: string): number {
  const parsed = parseDateString(date)
  if (!parsed) return Number.NaN
  const guess = Date.UTC(parsed.year, parsed.month - 1, parsed.day)
  // 先按猜测值取一次偏移，再用该偏移回推；跨夏令时切换时需要第二次修正
  let result = guess - getTimeZoneOffsetMs(guess, timeZone)
  const offset = getTimeZoneOffsetMs(result, timeZone)
  result = guess - offset
  return result
}

/** 在本地日期上偏移若干天，返回 YYYY-MM-DD */
export function addDays(date: string, days: number, timeZone: string): string {
  const start = getDayStartMs(date, timeZone)
  if (Number.isNaN(start)) return date
  return formatDate(start + days * 86400000, timeZone)
}

/** 本地时区下今天的日期 */
export function today(timeZone: string, now = Date.now()): string {
  return formatDate(now, timeZone)
}

/** 展示用日期文案，例如 `9月27日周日` / `Sep 27, Sun` */
export function formatDayLabel(ms: number, timeZone: string, locale: string): string {
  return getLabelFormatter(timeZone, locale).format(new Date(ms)).replace(/\s+/g, '')
}

/** 把 HH:mm 解析为当天的毫秒偏移，格式非法时返回 null */
export function parseClock(value: string): { hour: number; minute: number } | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 某个本地日期 + HH:mm 对应的 UTC 毫秒 */
export function resolveClockMs(date: string, clock: { hour: number; minute: number }, timeZone: string): number {
  const dayStart = getDayStartMs(date, timeZone)
  if (Number.isNaN(dayStart)) return Number.NaN
  return dayStart + (clock.hour * 60 + clock.minute) * 60000
}

/** 4 月 / 7 月 / 10 月 / 1 月划分的季度，返回该季度的起始月 */
export function getSeasonStartMonth(month: number): number {
  if (month <= 3) return 1
  if (month <= 6) return 4
  if (month <= 9) return 7
  return 10
}

/** 季度起始月与中文季名，同时用于配置解析与文案 */
export const SEASON_NAMES: Record<number, string> = {
  1: '冬',
  4: '春',
  7: '夏',
  10: '秋',
}
