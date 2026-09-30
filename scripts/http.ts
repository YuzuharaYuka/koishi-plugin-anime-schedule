/**
 * 维护脚本共用的 HTTP 工具。
 *
 * 本机常常挂着代理，而代理在 TLS 握手上的表现并不稳定（典型症状是
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate`，
 * 同一地址重试一次又能成功）。这里统一处理：
 *
 * - 自动重试，间隔递增；
 * - 走代理失败时**改直连**重试一次；
 * - 可用 `ANIME_INSECURE_TLS=1` 跳过证书校验（代理做 TLS 拦截、又不想装根证书时用）；
 * - 失败时给出中文说明，而不是把整段堆栈甩给用户。
 *
 * 全部基于 Node 内置的 `fetch` 与 `undici`，**不引入 axios**：这个文件只在维护脚本里用，
 * 不该为它给插件添运行时依赖。
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** 证书类错误：这类问题重试或改直连通常能过 */
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export interface FetchOptions {
  /** 返回文本、JSON 对象还是原始字节 */
  as?: 'text' | 'json' | 'arraybuffer'
  /** 请求方法，默认 GET */
  method?: 'GET' | 'POST'
  /** POST 时的请求体（会被 JSON 序列化） */
  body?: unknown
  /** 附加请求头 */
  headers?: Record<string, string>
  /** 超时（毫秒），默认 30 秒 */
  timeout?: number
}

/** `ANIME_PROXY` 优先；否则交给 undici 读 `HTTP(S)_PROXY` 环境变量 */
const explicitProxy = process.env.ANIME_PROXY ?? ''

/**
 * 造一个 undici dispatcher。
 *
 * **注意**：undici 的 `ProxyAgent` 只支持 HTTP(S) 代理，不认 `socks5://`——传 SOCKS 地址
 * 会直接抛 `Invalid URL protocol`。因此维护脚本要用 SOCKS 时请改用
 * `HTTPS_PROXY=http://...` 形式，或让代理客户端开一个 HTTP 端口。
 * 插件本身不受这个限制：它走 Koishi 的 `http` 服务，由 `@koishijs/plugin-proxy-agent`
 * 处理 SOCKS（它内部用 `socks-proxy-agent`）。
 */
function makeDispatcher(useProxy: boolean, insecure: boolean): unknown {
  // 运行时才 require，避免没有代理需求时也加载 undici
  const { Agent, EnvHttpProxyAgent, ProxyAgent } = require('undici') as typeof import('undici')
  const tls = insecure ? { connect: { rejectUnauthorized: false } } : {}
  if (!useProxy) {
    return insecure ? new Agent(tls) : undefined
  }
  // 只把 http(s) 的地址交给 ProxyAgent；SOCKS 或其它协议留给环境变量分支
  if (/^https?:\/\//i.test(explicitProxy)) {
    return new ProxyAgent({ uri: explicitProxy, ...tls } as never)
  }
  return new EnvHttpProxyAgent(tls as never)
}

function isTlsError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code
    ?? ''
  const message = describe(error)
  return TLS_ERROR_CODES.has(code) || /certificate|self.signed|unable to verify/i.test(message)
}

function describe(error: unknown): string {
  const record = error as { code?: string; message?: string; cause?: { message?: string; code?: string } }
  return record?.cause?.message ?? record?.message ?? String(error)
}

/** 抓取一个地址；先按代理设置走，证书类问题再改直连。 */
export async function fetchUrl<T = string>(url: string, options: FetchOptions = {}): Promise<T> {
  const as = options.as ?? 'text'
  const method = options.method ?? 'GET'
  const insecure = process.env.ANIME_INSECURE_TLS === '1'
  const timeout = options.timeout ?? 30000
  const attempts = [
    { label: '经代理', dispatcher: makeDispatcher(true, insecure) },
    { label: '直连', dispatcher: makeDispatcher(false, insecure) },
  ]

  const errors: string[] = []
  for (const { label, dispatcher } of attempts) {
    for (let round = 0; round < 2; round++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'User-Agent': USER_AGENT,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(timeout),
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit)
        if (!response.ok) {
          throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), { status: response.status })
        }
        if (as === 'json') return await response.json() as T
        if (as === 'arraybuffer') return await response.arrayBuffer() as T
        return await response.text() as T
      } catch (error) {
        const detail = describe(error)
        // 收到 HTTP 响应说明链路是通的，不必再换直连或重试
        if ((error as { status?: number })?.status) throw new Error(`抓取失败: ${url} → ${detail}`)
        errors.push(`${label} ${round + 1}: ${detail}`)
        if (isTlsError(error) && label === '经代理') break
        if (round === 0) await new Promise((done) => setTimeout(done, 800))
      }
    }
  }

  throw new Error([
    `抓取失败: ${url}`,
    ...errors.map((line) => `  ${line}`),
    '',
    '如果错误里含 certificate / unable to verify，说明本机代理做了 TLS 拦截而 Node 不信任它的证书。',
    '三种办法：',
    '  1) 临时清掉代理再跑：$env:HTTPS_PROXY=""; $env:HTTP_PROXY=""',
    '  2) 导入代理根证书后设置 $env:NODE_EXTRA_CA_CERTS="<证书.pem>"',
    '  3) 只跳过本校验：$env:ANIME_INSECURE_TLS=1（不建议长期使用）',
  ].join('\n'))
}

/**
 * 造一个足够像 `ctx.http` 的对象，供维护脚本里直接构造服务用。
 *
 * 只需满足 `HttpClient` 的用法：可调用、带 `config`、带 `get` / `post`。
 */
export function createHttpShim(): {
  (url: string, config?: Record<string, unknown>): Promise<{ data: unknown; status: number }>
  config: Record<string, unknown>
  get: (url: string, config?: Record<string, unknown>) => Promise<{ data: unknown; status: number }>
  post: (url: string, data: unknown, config?: Record<string, unknown>) => Promise<{ data: unknown; status: number }>
} {
  const call = async (url: string, config: Record<string, unknown> = {}) => {
    const method = (config.method as string) ?? 'GET'
    const responseType = (config.responseType as string) ?? 'json'
    const as = responseType === 'arraybuffer' ? 'arraybuffer' : responseType === 'text' ? 'text' : 'json'
    const data = await fetchUrl(url, {
      as,
      method: method.toUpperCase() as 'GET' | 'POST',
      body: config.data,
      headers: config.headers as Record<string, string>,
      timeout: config.timeout as number,
    })
    return { data, status: 200 }
  }
  const shim: any = call
  shim.config = {}
  shim.get = (url: string, config?: Record<string, unknown>) => call(url, { ...config, method: 'GET' })
  shim.post = (url: string, data: unknown, config?: Record<string, unknown>) => call(url, { ...config, method: 'POST', data })
  return shim
}
