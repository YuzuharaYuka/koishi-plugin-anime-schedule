/**
 * 维护脚本共用的最小 Koishi 上下文。
 *
 * 插件的全部出网请求都走 `ctx.http`，而 `ctx.http` 在 Koishi 里既是**可调用的**
 * （`ctx.http(method, url, config)`），又带 `config` / `get` / `post`。脚本里手工拼的
 * `http: null` 或 `http: { get }` 都不满足它，会以
 * `this.ctx.http is not a function` 失败——所以统一用这里的 `createContext()`。
 *
 * 代理交给 `scripts/http.ts` 的 `createHttpShim()`：它认 `ANIME_PROXY`，也认
 * `HTTP(S)_PROXY` 环境变量（仅限 http(s) 代理，undici 不支持 SOCKS）。
 */
import { resolve } from 'path'
import { Logger } from 'koishi'
import { createHttpShim } from './http'

/** 插件根目录（scripts 的上一级） */
export const PACKAGE_ROOT = resolve(__dirname, '..')

export interface DevContextOptions {
  /** 覆盖 `baseDir`（默认插件根目录） */
  baseDir?: string
  /** 数据库桩的返回值；默认全部返回空 */
  database?: Record<string, unknown>
}

/** 造一个够用的 `ctx`：只实现插件实际会碰到的部分 */
export function createContext(options: DevContextOptions = {}): any {
  return {
    baseDir: options.baseDir ?? PACKAGE_ROOT,
    http: createHttpShim(),
    database: {
      get: async () => [],
      set: async () => undefined,
      upsert: async () => undefined,
      remove: async () => ({ removed: 0 }),
      ...options.database,
    },
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
    logger: (name: string) => new Logger(name),
    root: { config: {} },
  }
}
