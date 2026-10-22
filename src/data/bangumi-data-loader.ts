/**
 * bangumi-data 的取数层。数据来自 npm 包 `bangumi-data`（随插件一起安装、无需联网），
 * 只有包缺失时才依次回退到磁盘缓存与 CDN 镜像。
 * 这一层只负责「把 item 列表拿回来」，不解析、不建索引。
 */
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type { Context, Logger } from 'koishi'
import { BANGUMI_DATA_FALLBACK_URLS, BANGUMI_DATA_FILE, DATA_DIR } from '../constants'
import { errorMessage, unwrapText } from '../utils'
import type { BangumiDataItem } from './bangumi-data-source'
import { HttpClient } from '../services/network'

/** 一次载入的结果 */
export interface LoadedData {
  items: BangumiDataItem[]
  /** 来源描述，用于 `anime.status` 与日志 */
  source: string
}

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

  /** 依次尝试：npm 依赖包 → 磁盘缓存 → CDN 镜像 */
  async load(): Promise<LoadedData | null> {
    const fromPackage = this.loadFromPackage()
    if (fromPackage) return { items: fromPackage, source: '本地依赖包' }

    const fromCache = await this.loadFromCache()
    if (fromCache) return { items: fromCache, source: '磁盘缓存' }

    const fromNetwork = await this.loadFromNetwork()
    if (fromNetwork) {
      await this.writeCache(fromNetwork)
      return { items: fromNetwork, source: 'CDN 镜像' }
    }

    return null
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

  private async loadFromCache(): Promise<BangumiDataItem[] | null> {
    try {
      const text = await fs.readFile(this.cachePath, 'utf8')
      const parsed = JSON.parse(text) as { items?: BangumiDataItem[] }
      if (Array.isArray(parsed.items) && parsed.items.length) return parsed.items
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger.debug('[index] 读取缓存失败: %s', errorMessage(error))
      }
    }
    return null
  }

  private async writeCache(items: BangumiDataItem[]): Promise<void> {
    const temp = `${this.cachePath}.tmp`
    try {
      await fs.mkdir(dirname(this.cachePath), { recursive: true })
      const slim = items.map((item) => {
        const picked: Record<string, unknown> = {}
        for (const key of CACHED_FIELDS) if (item[key] !== undefined) picked[key] = item[key]
        return picked
      })
      await fs.writeFile(temp, JSON.stringify({ items: slim }), 'utf8')
      await fs.rename(temp, this.cachePath)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      this.logger.debug('[index] 写入缓存失败: %s', errorMessage(error))
    }
  }

  /** CDN 镜像回退（GitHub raw 在部分网络下不可达） */
  private async loadFromNetwork(): Promise<BangumiDataItem[] | null> {
    for (const url of BANGUMI_DATA_FALLBACK_URLS) {
      try {
        const raw = await this.http.get<unknown>(url, { timeout: 60000, responseType: 'text' })
        const text = unwrapText(raw)
        if (!text) continue
        const parsed = JSON.parse(text) as { items?: BangumiDataItem[] }
        if (Array.isArray(parsed.items) && parsed.items.length) return parsed.items
      } catch (error) {
        this.logger.debug('[index] 镜像 %s 获取失败: %s', url, errorMessage(error))
        this.http.hintOnFailure(error)
      }
    }
    return null
  }
}
