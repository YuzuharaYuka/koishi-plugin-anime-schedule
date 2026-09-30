import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { dirname, resolve } from 'path'
import { createCanvas, Image, type Canvas } from '@napi-rs/canvas'
import type { Context, Logger } from 'koishi'
import {
  COVER_CACHE_DIR,
  COVER_CACHE_MAX_FILES,
  COVER_CACHE_TTL_MS,
  COVER_MAX_BYTES,
  COVER_TIMEOUT_MS,
} from '../constants'
import type { DigestItem } from '../types'
import { mapLimit } from '../utils'
import { HttpClient } from '../services/network'

/** 等待一张封面解码完成的最长时间 */
const DECODE_WAIT_MS = 5000

/**
 * 同一张封面的备用地址。
 *
 * Bangumi 图床按尺寸分目录（`/pic/cover/l|c|m|s/`），个别条目会缺其中某一个尺寸，
 * 因此逐个回退比只试一个地址稳得多。
 */
function coverUrlCandidates(url: string): string[] {
  const matched = /^(https?:\/\/[^/]+\/pic\/cover\/)([a-z]+)(\/.*)$/i.exec(url)
  if (!matched) return [url]
  const [, prefix, , suffix] = matched
  const order = ['c', 'l', 'm', 's', '']
  return [...new Set(order.map((size) => `${prefix}${size}${suffix}`))]
}

/** 取出响应里的二进制；Koishi 的 http 返回响应体，axios 调用方会拿到完整响应对象 */
function toBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    return toBuffer((raw as Record<string, unknown>).data)
  }
  return null
}

/**
 * 把图片字节解码成可绘制的画布。
 *
 * 给 `Image.src` 赋 Buffer 后 `width/height/complete` 会立刻可用，但位图解码是异步的，
 * 此时直接 `drawImage` 只会得到全透明的空画布，必须等解码完成。
 */
async function decodeToCanvas(buffer: Buffer): Promise<Canvas | null> {
  if (!buffer.length) return null
  const image = new Image()
  try {
    image.src = buffer
  } catch {
    return null
  }

  const loaded = await waitForLoad(image)
  if (!loaded) return null

  if (!image.width || !image.height) return null
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas
}

/** 等待图片解码完成，超时或失败返回 false */
function waitForLoad(image: Image): Promise<boolean> {
  if (typeof image.decode === 'function') {
    return image.decode().then(() => true, () => false)
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), DECODE_WAIT_MS)
    image.onload = () => {
      clearTimeout(timer)
      resolve(true)
    }
    image.onerror = () => {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

/**
 * 封面加载器。
 *
 * 三级缓存（内存 → 磁盘 → 网络）加并发下载：一次推送里同一张封面只下载一次，
 * 之后复用内存与磁盘副本，定时推送的耗时基本只剩绘制。
 */
export class CoverStore {
  private readonly memory = new Map<string, Canvas | null>()
  private readonly inflight = new Map<string, Promise<Canvas | null>>()
  private readonly cacheRoot: string
  private cacheReady = false
  private cacheDisabled = false

  constructor(
    private ctx: Context,
    private logger: Logger,
    private concurrency: number,
    private cacheDays: number,
    /** 出网客户端（含代理） */
    private http: HttpClient,
  ) {
    this.cacheRoot = resolve(ctx.baseDir, ...COVER_CACHE_DIR)
  }

  get enabled(): boolean {
    return this.cacheDays > 0
  }

  /**
   * 批量加载，返回「URL → 画布」，取不到的为 null。
   *
   * `limit` 为 0 表示**不限制**，与「不加载」含义相反，因此早退判断只看 `items` 是否为空。
   */
  async load(items: DigestItem[], limit: number): Promise<Map<string, Canvas | null>> {
    const result = new Map<string, Canvas | null>()
    if (!items.length) return result
    const capped = limit > 0

    const urls: string[] = []
    for (const item of items) {
      if (!item.coverUrl || result.has(item.coverUrl)) continue
      result.set(item.coverUrl, null)
      urls.push(item.coverUrl)
      if (capped && urls.length >= limit) break
    }
    if (!urls.length) return result

    const started = Date.now()
    let downloaded = 0
    let fromDisk = 0
    const entries = await mapLimit(urls, this.concurrency, async (url) => {
      const hadMemory = this.memory.has(url)
      const canvas = await this.loadOne(url)
      if (canvas) {
        if (hadMemory) fromDisk++
        else downloaded++
      }
      return { url, canvas }
    })
    for (const entry of entries) result.set(entry.url, entry.canvas)
    const ok = entries.filter((entry) => entry.canvas).length
    this.logger.debug('[render] 封面就绪 %d/%d 张 (%dms)', ok, urls.length, Date.now() - started)
    // 封面缺失会直接影响版面观感，失败比例高时给一条 info 级别的提示，便于定位
    if (ok < urls.length) {
      this.logger.info(
        '[render] 封面 %d/%d 张可用（内存或磁盘命中 %d，新下载 %d，失败 %d）',
        ok,
        urls.length,
        fromDisk,
        downloaded,
        urls.length - ok,
      )
    }
    return result
  }

  /** 单个封面：内存缓存 → 磁盘缓存 → 网络 */
  private loadOne(url: string): Promise<Canvas | null> {
    const cached = this.memory.get(url)
    if (cached !== undefined) return Promise.resolve(cached)

    const running = this.inflight.get(url)
    if (running) return running

    const task = this.fetchAndDecode(url)
      .then((canvas) => {
        this.memory.set(url, canvas)
        return canvas
      })
      .finally(() => {
        this.inflight.delete(url)
      })
    this.inflight.set(url, task)
    return task
  }

  private async fetchAndDecode(url: string): Promise<Canvas | null> {
    const cachedFile = await this.readDiskCache(url)
    if (cachedFile) {
      const canvas = await decodeToCanvas(cachedFile)
      if (canvas) return canvas
      // 磁盘上的文件损坏时删掉，重新下载
      await fs.rm(this.filePath(url), { force: true }).catch(() => undefined)
    }

    // 逐个候选地址尝试：Bangumi 的图床偶尔会缺某个尺寸的图，
    // 只试一个地址的话整张封面就变成占位块了
    for (const candidate of coverUrlCandidates(url)) {
      const buffer = await this.download(candidate)
      if (!buffer) continue
      const canvas = await decodeToCanvas(buffer)
      if (!canvas) {
        this.logger.debug('[render] 封面解码失败: %s', candidate)
        continue
      }
      // 一律按原始地址落盘，下次直接用缓存，不再重试备用地址
      void this.writeDiskCache(url, buffer)
      if (candidate !== url) this.logger.debug('[render] 封面改用备用地址成功: %s', candidate)
      return canvas
    }
    this.logger.debug('[render] 封面全部候选地址都失败: %s', url)
    return null
  }

  private async download(url: string): Promise<Buffer | null> {
    try {
      const buffer = toBuffer(await this.http.get<unknown>(url, {
        timeout: COVER_TIMEOUT_MS,
        responseType: 'arraybuffer',
      }))
      if (!buffer) {
        this.logger.debug('[render] 封面响应不是二进制数据，使用占位块: %s', url)
        return null
      }
      if (buffer.byteLength > COVER_MAX_BYTES) {
        this.logger.debug('[render] 封面体积超过上限 (%d bytes)，使用占位块: %s', buffer.byteLength, url)
        return null
      }
      return buffer
    } catch (error) {
      this.logger.debug('[render] 封面下载失败，改用占位块 (%s): %s', url, String(error))
      this.http.hintOnFailure(error)
      return null
    }
  }

  // #region 磁盘缓存

  private filePath(url: string): string {
    const hash = createHash('sha1').update(url).digest('hex')
    return resolve(this.cacheRoot, hash.slice(0, 2), `${hash}.img`)
  }

  private async readDiskCache(url: string): Promise<Buffer | null> {
    if (!this.enabled) return null
    const path = this.filePath(url)
    try {
      const stat = await fs.stat(path)
      const ttl = this.cacheDays * 24 * 60 * 60 * 1000
      if (Date.now() - stat.mtimeMs > Math.min(ttl, COVER_CACHE_TTL_MS)) return null
      return await fs.readFile(path)
    } catch {
      return null
    }
  }

  private async writeDiskCache(url: string, buffer: Buffer): Promise<void> {
    if (!this.enabled) return
    const path = this.filePath(url)
    const temp = `${path}.tmp`
    try {
      if (!this.cacheReady) {
        await fs.mkdir(this.cacheRoot, { recursive: true })
        this.cacheReady = true
      }
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.writeFile(temp, buffer)
      await fs.rename(temp, path)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      if (!this.cacheDisabled) {
        this.cacheDisabled = true
        this.logger.debug('[render] 封面磁盘缓存不可用，仅使用内存缓存: %s', String(error))
      }
    }
  }

  /** 清理过期的封面缓存，插件启动时调用一次即可 */
  async prune(): Promise<void> {
    if (!this.enabled) return
    try {
      const ttl = Math.min(this.cacheDays * 24 * 60 * 60 * 1000, COVER_CACHE_TTL_MS)
      const files: { path: string; mtimeMs: number }[] = []
      const buckets = await fs.readdir(this.cacheRoot, { withFileTypes: true })
      for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue
        const dir = resolve(this.cacheRoot, bucket.name)
        for (const file of await fs.readdir(dir)) {
          if (!file.endsWith('.img')) continue
          const path = resolve(dir, file)
          const stat = await fs.stat(path).catch(() => null)
          if (!stat) continue
          if (Date.now() - stat.mtimeMs > ttl) {
            await fs.rm(path, { force: true }).catch(() => undefined)
            continue
          }
          files.push({ path, mtimeMs: stat.mtimeMs })
        }
      }
      if (files.length > COVER_CACHE_MAX_FILES) {
        files.sort((a, b) => a.mtimeMs - b.mtimeMs)
        for (const file of files.slice(0, files.length - COVER_CACHE_MAX_FILES)) {
          await fs.rm(file.path, { force: true }).catch(() => undefined)
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger.debug('[render] 清理封面缓存失败: %s', String(error))
      }
    }
  }

  // #endregion
}
