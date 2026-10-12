/**
 * 出网封装。全部请求都走 Koishi 的 `ctx.http`，插件自己**不处理代理**：代理支持由
 * `@koishijs/plugin-proxy-agent` 以中间件方式注入（监听 `http/fetch-init`），用户启用它并
 * 填好地址即可，**无需在本插件配置里再填一遍**。
 *
 * Bangumi 的接口与图床（`lain.bgm.tv`）在中国大陆**无法直连**，因此官方部署下必须启用
 * `@koishijs/plugin-proxy-agent`；见 `hintOnFailure` 的提示。
 */
import type { Context, Logger } from 'koishi'
import { buildUserAgent } from '../constants'
import { debugLog, errorMessage, errorStatus, retryDelay } from '../utils'

/** 这个错误是否值得重试：429、5xx 与网络层错误可以，其余 4xx 立即失败 */
function isRetriable(error: unknown): boolean {
  const status = errorStatus(error)
  if (status === null) return true
  if (status === 429) return true
  return status >= 500
}

/** 这个错误是不是「已经收到 HTTP 响应」——收到就说明链路通，与代理无关 */
function hasHttpResponse(error: unknown): boolean {
  const status = (error as { status?: number; response?: { status?: number } })?.status
    ?? (error as { response?: { status?: number } })?.response?.status
  return typeof status === 'number'
}

/** Koishi http 服务把代理地址放在这里（由 `@koishijs/plugin-proxy-agent` 注入） */
interface HttpWithProxyConfig {
  config?: { proxyAgent?: string | null }
}

/** 一次出网请求的可选参数 */
export interface RequestOptions {
  /** 附加请求头 */
  headers?: Record<string, string>
  /** 超时（毫秒） */
  timeout?: number
  /** `POST` 时的请求体（会被 JSON 序列化） */
  body?: unknown
  /** 响应类型：`json`（默认）/ `text` / `arraybuffer` */
  responseType?: 'json' | 'text' | 'arraybuffer'
}

/**
 * 出网客户端。
 * 只做三件事：拼请求头、转发给 `ctx.http`、失败时给一次可操作的提示。
 */
export class HttpClient {
  private readonly userAgent = buildUserAgent()
  /** 缺代理的提示只发一次，避免每个条目刷一条 */
  private hintsGiven = 0
  private loggedProxy: string | null = null

  constructor(
    private ctx: Context,
    private logger: Logger,
    /** 失败后的最大重试次数，见 `advanced.retries` */
    private retries = 1,
  ) {}

  /** Koishi http 服务上配置的代理地址（未启用 proxy-agent 插件时为空） */
  get koishiProxy(): string {
    const configured = (this.ctx.http as unknown as HttpWithProxyConfig)?.config?.proxyAgent
    return typeof configured === 'string' ? configured : ''
  }

  /** 是否「完全没有代理」——这种部署在中国大陆必然拉不到 Bangumi */
  get withoutAnyProxy(): boolean {
    return !this.koishiProxy
  }

  /**
   * 请求失败时给出可操作的提示，只提示一次（网络不通会让每个条目都失败，逐条刷日志没有意义）。
   * **收到 HTTP 响应就不提示**：404、429、5xx 都说明链路是通的，提示只会误导排查方向。
   */
  hintOnFailure(error: unknown): void {
    if (this.hintsGiven > 0) return
    if (hasHttpResponse(error)) return
    if (!this.withoutAnyProxy) return
    this.hintsGiven++
    this.logger.warn(
      '[network] 出网请求失败（%s）。Bangumi 接口与图床（lain.bgm.tv）在中国大陆无法直连，'
      + '请安装并启用 `@koishijs/plugin-proxy-agent`，在它的配置里填写代理地址'
      + '（如 `http://127.0.0.1:7890` 或 `socks5h://127.0.0.1:1080`）。',
      errorMessage(error),
    )
  }

  /** 记录一次生效的代理来源，便于排查（每个地址只记一次） */
  private noteProxy(): void {
    const proxy = this.koishiProxy
    if (!proxy || this.loggedProxy === proxy) return
    this.loggedProxy = proxy
    this.logger.info('[network] 出网代理: %s（来自 Koishi http 服务）', proxy)
  }

  /** GET，返回响应体 */
  async get<T>(url: string, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('get', url, options)
  }

  /** POST JSON，返回响应体 */
  async post<T>(url: string, body: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('post', url, { ...options, body })
  }

  /**
   * 发一次请求，失败时按指数退避重试。
   *
   * 重试与否由状态码决定，不是所有失败都值得重试：
   *
   * - **4xx（404/400 等）**：请求本身有问题，重试只会重复失败，立即抛出；
   * - **429 / 5xx 与网络错误**：多半是临时的，退避后重试。
   *
   * 这里统一处理，是为了让各服务不必各写一套——此前 `localizer` 有重试、
   * `airing` 有限流、而 `info` 完全没有。
   */
  private async request<T>(method: 'get' | 'post', url: string, options: RequestOptions): Promise<T> {
    this.noteProxy()
    const config = {
      method: method.toUpperCase() as 'GET' | 'POST',
      data: options.body,
      timeout: options.timeout,
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json', ...options.headers },
      responseType: options.responseType,
    }
    const maxAttempt = Math.max(0, this.retries)
    for (let attempt = 0; ; attempt++) {
      try {
        // 用 `ctx.http(method, url, config)` 这个统一入口，返回的是带 `data` 的响应对象；
        // 调用方按「响应体」使用返回值，因此这里统一剥掉外壳。
        const response = await this.ctx.http<T>(url, config as never)
        return response.data
      } catch (error) {
        if (attempt >= maxAttempt || !isRetriable(error)) throw error
        const delay = retryDelay(attempt)
        debugLog('[network] %s 失败（%s），%dms 后重试', url, errorMessage(error), delay)
        await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
      }
    }
  }
}
