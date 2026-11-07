/**
 * bangumi-data 的取数层。
 *
 * 数据来源优先级：
 * 1. 磁盘缓存：上次从 CDN 拉取的数据，启动最快；
 * 2. npm 依赖包：离线基线，保证首次安装或缓存损坏时仍有数据；
 * 3. CDN 镜像：依赖包缺失时的同步兜底。
 *
 * 启动后 `BangumiDataIndex` 会按 `advanced.dataRefreshHours` 调用 `refresh()`，
 * 从官方推荐地址异步更新并写回缓存；npm 依赖版本不再决定数据新鲜度。
 * 这一层只负责「把 item 列表拿回来」，不解析、不建索引。
 */
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type { Context, Logger } from 'koishi'
import { BANGUMI_DATA_FALLBACK_URLS, BANGUMI_DATA_FILE, DATA_DIR } from '../constants'
import { errorMessage, sanitizeUrl, unwrapText } from '../utils'
import type { BangumiDataItem } from './bangumi-data-source'
import { HttpClient } from '../services/network'

/** 一次载入的结果 */
export interface LoadedData {
  items: BangumiDataItem[]
  /** 来源描述，用于 `anime.status` 与日志 */
  source: string
  /** 这份数据写入缓存的时间；npm 包基线为 0，表示需要尽快刷新 */
  fetchedAt: number
}

/** 缓存文件格式；`version` 只用于将来格式迁移 */
interface CacheFile {
  version?: number
  fetchedAt?: number
  source?: string
  items?: BangumiDataItem[]
}

const CACHE_VERSION = 1

/** 只在缓存里保留用得到的字段，避免把整个包写一遍 */
const CACHED_FIELDS: (keyof BangumiDataItem)[] = [
  'title', 'titleTranslate', 'type', 'officialSite', 'begin', 'broadcast', 'end', 'sites',
]

export class BangumiDataLoader {
  private readonly http: HttpClient

  constructor(
    private ctx: Context,
    private logger: Logger,
    http: HttpClient,
  ) {
    this.http = http
  }

  private get cachePath(): string {
    return resolve(this.ctx.baseDir, ...DATA_DIR, BANGUMI_DATA_FILE)
  }

  /** 启动路径：缓存 → npm 包 → CDN；不主动刷新，避免阻塞启动 */
  async load(): Promise<LoadedData | null> {
    const fromCache = await this.loadFromCache()
    if (fromCache) return fromCache

    const fromPackage = this.loadFromPackage()
    if (fromPackage) return { items: fromPackage, source: '本地依赖包', fetchedAt: 0 }

    const fromNetwork = await this.loadFromNetwork()
    if (fromNetwork) {
      await this.writeCache(fromNetwork)
      return fromNetwork
    }

    return null
  }

  /**
   * 按 TTL 异步刷新。缓存仍新鲜时返回 null；CDN 全部失败时保留现有数据。
   * 不在这里调用 `apply`，由索引层统一替换条目，保证查询侧看到完整快照。
   */
  async refresh(maxAgeMs: number): Promise<LoadedData | null> {
    const cached = await this.loadFromCache()
    if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return null

    const fromNetwork = await this.loadFromNetwork()
    if (!fromNetwork) return null
    await this.writeCache(fromNetwork)
    return fromNetwork
  }

  /** 从 npm 依赖读取 */
  private loadFromPackage(): BangumiDataItem[] | null {
    try {
      const mod = require('bangumi-data') as { items?: BangumiDataItem[] } | BangumiDataItem[]
      const items = Array.isArray(mod) ? mod : mod?.items
      if (Array.isArray(items) && items.length) return items
    } catch (error) {
      this.logger.debug('[index] 本地依赖包不可用: %s', errorMessage(error))
    }
    return null
  }

  private async loadFromCache(): Promise<LoadedData | null> {
    try {
      const [text, stat] = await Promise.all([
        fs.readFile(this.cachePath, 'utf8'),
        fs.stat(this.cachePath),
      ])
      const parsed = JSON.parse(text) as CacheFile
      if (!Array.isArray(parsed.items) || !parsed.items.length) return null
      const fetchedAt = typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt)
        ? parsed.fetchedAt
        : stat.mtimeMs
      return { items: parsed.items, source: '磁盘缓存', fetchedAt }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger.debug('[index] 读取缓存失败: %s', errorMessage(error))
      }
    }
    return null
  }

  private async writeCache(data: LoadedData): Promise<void> {
    const temp = `${this.cachePath}.tmp`
    try {
      await fs.mkdir(dirname(this.cachePath), { recursive: true })
      const slim = data.items.map((item) => {
        const picked: Record<string, unknown> = {}
        for (const key of CACHED_FIELDS) if (item[key] !== undefined) picked[key] = item[key]
        return picked
      })
      const payload: CacheFile = {
        version: CACHE_VERSION,
        fetchedAt: data.fetchedAt,
        source: data.source,
        items: slim as unknown as BangumiDataItem[],
      }
      await fs.writeFile(temp, JSON.stringify(payload), 'utf8')
      await fs.rename(temp, this.cachePath)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      this.logger.debug('[index] 写入缓存失败: %s', errorMessage(error))
    }
  }

  /** CDN 镜像（官方 README 推荐 unpkg；jsDelivr 与 GitHub raw 作为备用） */
  private async loadFromNetwork(): Promise<LoadedData | null> {
    for (const url of BANGUMI_DATA_FALLBACK_URLS) {
      try {
        const raw = await this.http.get<unknown>(url, { timeout: 60000, responseType: 'text' })
        const text = unwrapText(raw)
        if (!text) continue
        const parsed = JSON.parse(text) as { items?: BangumiDataItem[] }
        if (Array.isArray(parsed.items) && parsed.items.length) {
          return { items: parsed.items, source: 'CDN 镜像', fetchedAt: Date.now() }
        }
      } catch (error) {
        this.logger.debug('[index] 镜像 %s 获取失败: %s', sanitizeUrl(url), errorMessage(error))
        this.http.hintOnFailure(error)
      }
    }
    return null
  }
}
