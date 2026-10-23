import type { Logger } from 'koishi'

/** 取单个错误值的可读文案，带上 `code`；对象上两者都没有时返回空串，避免 `[object Object]` 混进日志 */
function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const { message, code } = error as { message?: unknown; code?: unknown }
    const text = typeof message === 'string' ? message : ''
    const hasCode = typeof code === 'string' && code !== ''
    // `Error` 实例（如 undici 的 `UND_ERR_SOCKET`）也有 `code`，不能因为它不是普通对象就丢掉
    const suffix = hasCode && !text.includes(code as string) ? ` (${String(code)})` : ''
    if (text) return `${text}${suffix}`
    if (hasCode) return String(code)
  }
  return ''
}

/** `cause` 链最多展开几层，够覆盖 undici 的 `TypeError → Error(code)` 结构 */
const MAX_CAUSE_DEPTH = 3

/**
 * 从 catch 到的未知值中安全取出错误信息，并展开 `cause` 链。
 *
 * undici 的 `fetch` 只把失败包装成 `TypeError: fetch failed`，真正的
 * `UND_ERR_CONNECT_TIMEOUT` / `ECONNRESET` / `ENOTFOUND` 都在 `error.cause` 里。
 * 不展开就只能看到「fetch failed」，无法判断是 DNS、连接超时还是被重置。
 */
export function errorMessage(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const text = describeError(current)
    if (text && !parts.includes(text)) parts.push(text)
    if (!current || typeof current !== 'object') break
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' ← ') || String(error)
}

/** 从 catch 到的未知值中安全取出错误名 */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name?: unknown }).name ?? '')
  return ''
}

/** 读取 HTTP 错误的状态码，取不到时返回 null */
export function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const response = (error as { response?: { status?: unknown } }).response
  const status = response?.status
  return typeof status === 'number' ? status : null
}

/**
 * 这个错误是不是「超时」（包括 undici 的连接超时与响应超时）。
 *
 * 超时与「连不上」要分开：前者说明链路通但太慢，调大超时或重试即可，
 * 后者才需要查 DNS / 代理。
 */
export function isTimeoutError(error: unknown, name = errorName(error), detail = ''): boolean {
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const text = detail || errorMessage(error)
  return /timeout|timed out|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/i.test(text)
}

/**
 * 把网络异常转换成可读提示。
 * 不向用户暴露异常栈与内部类名，只保留判断所需的类别。
 */
export function formatNetworkError(error: unknown): string {
  const name = errorName(error)
  const status = errorStatus(error)
  if (status === 429) return '请求过于频繁，站点已触发限流，请稍后再试。'
  if (status === 403) return '站点拒绝了本次请求 (可能触发了风控)，请稍后再试。'
  if (status === 404) return '站点上不存在该资源，请检查输入。'
  if (status && status >= 500) return '站点服务器暂时不可用，请稍后再试。'
  const detail = errorMessage(error)
  if (isTimeoutError(error, name, detail)) {
    return '请求超时，请检查网络或代理配置后重试。'
  }
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|socket hang up|other side closed|UND_ERR/i.test(detail)) {
    return '网络连接失败，若站点需要代理请在插件配置中设置。'
  }
  return `请求失败: ${detail}`
}

/** 按显示宽度截断文本，超出部分用省略号补齐 */
export function truncate(value: string, max: number): string {
  const text = value ?? ''
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 带并发上限的 map，保持输入顺序 */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 指数退避的重试间隔，第 attempt 次（从 0 开始）失败后的等待时间 */
export function retryDelay(attempt: number, base = 800, cap = 8000): number {
  return Math.min(cap, base * 2 ** attempt)
}

/**
 * 调试日志开关。
 *
 * 打开 `advanced.debug` 后，插件的每一步操作都会打到日志里：
 * 请求的 URL 与耗时、本地化命中情况、排期推算与过滤结果、失败原因等。
 * 各服务共享同一个开关，避免到处写 `if (config.advanced.debug)`。
 */
let debugEnabled = false
let debugLogger: Logger | null = null

/**
 * 开启 / 关闭调试日志。
 *
 * 调试输出走 `logger.debug`，级别不够时会被直接丢掉，因此开启时把该 logger 的级别提到 3。
 * 关掉时恢复默认的 2（info），避免别处仍在输出调试细节。
 */
export function setupDebug(enabled: boolean, logger: Logger): void {
  debugEnabled = enabled
  debugLogger = logger
  // 只抬高、不压低：关闭时若用户自己在控制台设过更细的级别，不该被我们改掉
  if (enabled) logger.level = 3
}

/** 打印一条调试日志；未开启调试时是空操作 */
export function debugLog(message: string, ...args: unknown[]): void {
  if (!debugEnabled || !debugLogger) return
  debugLogger.debug(message, ...args)
}

/** 把毫秒数限制在给定区间内 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * 取出 HTTP 响应体。
 *
 * 各个 http 适配器的返回值形状不同：Koishi 的 `http` 服务直接返回响应体，
 * 而 axios 客户端返回的是带 `status` / `headers` 的响应对象。两者都以 `data`
 * 作为响应体的字段名，因此按「是否存在 status + headers」区分。
 */
export function unwrapPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const record = raw as Record<string, unknown>
  if ('status' in record && 'headers' in record && 'data' in record) return record.data
  return raw
}

/**
 * 取出文本响应体。
 *
 * 各个 http 适配器给的东西形状不同：可能是字符串、Buffer、ArrayBuffer、Uint8Array，
 * 也可能把响应体包在 `data` 里。这里逐层兼容，最后兜底为 JSON 序列化。
 */
export function unwrapText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === null || raw === undefined) return ''
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8')
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if ('data' in record && record.data !== raw) return unwrapText(record.data)
    return JSON.stringify(raw)
  }
  return String(raw)
}
