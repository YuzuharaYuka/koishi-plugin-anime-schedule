import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { dirname, resolve } from 'path'
import { createCanvas, Image, type Canvas } from '@napi-rs/canvas'
import type { Context, Logger } from 'koishi'
import {
  COVER_CACHE_DIR,
  COVER_CACHE_MAX_FILES,
  COVER_MAX_BYTES,
  COVER_MEMORY_MAX_BYTES,
  COVER_TIMEOUT_MS,
} from '../constants'
import type { CoverRequest } from '../types'
import { errorMessage, mapLimit, sanitizeUrl } from '../utils'
import { HttpClient } from '../services/network'

/** 等待一张封面解码完成的最长时间 */
const DECODE_WAIT_MS = 5000

/**
 * 磁盘缩略图的 JPEG 质量。
 *
 * 缩略图只在首次下载/解码时生成一次，之后反复参与整图编码；这里固定 q100，避免
 * 封面先被压一次再被整图编码，清晰度只由 `render.jpegQuality` 决定。代价是 1024px
 * 封面单张可能接近 1MB，但这是用户显式选择清晰度后的预期成本。
 */
const COVER_THUMB_QUALITY = 100

/**
 * 磁盘缓存键的版本号。
 *
 * 缓存格式变更后必须改它：v2 及以前存的是接口原图，v3 起只存插件生成的缩略图，
 * v4 起缩略图边长由用户配置决定并参与键计算，v5 起缩略图质量提高到 95，v6 起用 q100，
 * v7 起缓存文件改用 `.jpg` 扩展名（内容本来就是 JPEG，不再伪装成光盘映像 `.img`）。
 * 旧文件由 `prune()` 按 TTL 与数量上限清掉。
 */
const COVER_CACHE_VERSION = 7

/**
 * 单张封面的总时间预算（含多候选地址）。
 *
 * 未命中缓存的封面要按候选地址逐个试，每个都等满 8s 的话，一张图就能拖住整批；
 * 封面缺失只是退化成占位块，不值得为它耗更多时间。
 */
const COVER_TOTAL_BUDGET_MS = 12000

/**
 * 同一张封面的备用地址：Bangumi 图床按尺寸分目录（`/pic/cover/l|c|m|s/`），
 * 个别条目会缺某个尺寸，需逐个回退。
 *
 * **原地址必须排第一**：调用方传进来的就是 `large`，而 `c` 只有 150×212，
 * 超采样下要放大数倍，明显发糊。
 */
function coverUrlCandidates(url: string): string[] {
  const matched = /^(https?:\/\/[^/]+\/pic\/cover\/)([a-z]+)(\/.*)$/i.exec(url)
  if (!matched) return [url]
  const [, prefix, , suffix] = matched
  const sizes = ['l', 'c', 'm', 's']
  return [...new Set([url, ...sizes.map((size) => `${prefix}${size}${suffix}`)])]
}

/** 画布占用的近似字节数（RGBA 每像素 4 字节） */
function canvasBytes(canvas: Canvas): number {
  return canvas.width * canvas.height * 4
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
 * 赋 `Image.src` 后 `width/height` 立刻可用，但位图解码是异步的，直接 `drawImage` 只会得到全透明的空画布。
 */
async function decodeToCanvas(buffer: Buffer, maxEdge: number): Promise<Canvas | null> {
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
  // 一次性缩到配置的最大边长以内：高分辨率原图留在内存里既占地方，绘制时还要再缩放一遍
  const ratio = Math.min(1, maxEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * ratio))
  const height = Math.max(1, Math.round(image.height * ratio))
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ratio < 1) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
  }
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

/** 等待图片解码完成，超时或失败返回 false */
async function waitForLoad(image: Image): Promise<boolean> {
  // `decode()` 自己不带超时：一张图卡住就会永久占着 `inflight`，因此与计时器赛跑。
  // @napi-rs/canvas 的 Image 一定有 `decode`，不再保留 onload 回退。
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), DECODE_WAIT_MS)
  })
  try {
    return await Promise.race([image.decode().then(() => true, () => false), guarded])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 封面加载器：内存 → 磁盘 → 网络三级缓存 + 并发下载，同一张封面一次推送只下载一次 */
export class CoverStore {
  /**
   * 内存缓存。值只能是解码成功的画布——下载或解码失败的结果**不入缓存**，
   * 否则一次瞬时超时会让这张封面在进程重启前一直显示占位块。
   */
  private readonly memory = new Map<string, Canvas>()
  /** `memory` 中画布占用的字节数，用于淘汰 */
  private memoryBytes = 0
  private readonly inflight = new Map<string, Promise<Canvas | null>>()
  private readonly cacheRoot: string
  private readonly versionPath: string
  private cacheReady = false
  private cacheDisabled = false
  private versionReady: Promise<void> | null = null

  constructor(
    ctx: Context,
    private logger: Logger,
    private concurrency: number,
    private cacheDays: number,
    /** 出网客户端（含代理） */
    private http: HttpClient,
    /** 封面解码与磁盘缩略图的最大边长（像素） */
    private maxEdge: number,
  ) {
    this.cacheRoot = resolve(ctx.baseDir, ...COVER_CACHE_DIR)
    this.versionPath = resolve(this.cacheRoot, '.version')
  }

  get enabled(): boolean {
    return this.cacheDays > 0
  }

  /**
   * 批量加载，返回「URL → 画布」，取不到的为 null。
   * `limit` 为 0 表示不限制（与「不加载」含义相反），故早退判断只看 `items` 是否为空。
   */
  async load(items: CoverRequest[], limit: number): Promise<Map<string, Canvas | null>> {
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
    let fromMemory = 0
    const entries = await mapLimit(urls, this.concurrency, async (url) => {
      // 内存命中多半来自「取详情时的预热」；磁盘命中说明缓存生效；两者都不是才是真下载。
      // 三个数分开统计，才能从日志判断预热有没有起作用。
      const hadMemory = this.memory.has(url)
      const canvas = await this.loadOne(url)
      if (canvas) {
        if (hadMemory) fromMemory++
        else if (await this.isOnDisk(url)) fromDisk++
        else downloaded++
      }
      return { url, canvas }
    })
    for (const entry of entries) result.set(entry.url, entry.canvas)
    const ok = entries.filter((entry) => entry.canvas).length
    // 一行统计：有失败时升到 info（封面缺失会在图上显示为占位块，需要能被看见），
    // 全部命中时只是调试细节
    const detail = `预热命中 ${fromMemory} / 磁盘命中 ${fromDisk} / 新下载 ${downloaded} / 失败 ${urls.length - ok}`
    const elapsed = Date.now() - started
    if (ok < urls.length) {
      this.logger.info('[render] 封面 %d/%d 张可用（%s，%dms）', ok, urls.length, detail, elapsed)
    } else {
      this.logger.debug('[render] 封面 %d/%d 张就绪（%s，%dms）', ok, urls.length, detail, elapsed)
    }
    return result
  }

  /** 单个封面：内存缓存 → 磁盘缓存 → 网络 */
  private loadOne(url: string): Promise<Canvas | null> {
    const cached = this.memory.get(url)
    if (cached) {
      // 命中即视为「刚用过」：移到 Map 末尾，淘汰时从最早插入的那端开始
      this.memory.delete(url)
      this.memory.set(url, cached)
      return Promise.resolve(cached)
    }

    const running = this.inflight.get(url)
    if (running) return running

    const task = this.fetchAndDecode(url)
      .then((canvas) => {
        if (canvas) this.remember(url, canvas)
        return canvas
      })
      .finally(() => {
        this.inflight.delete(url)
      })
    this.inflight.set(url, task)
    return task
  }

  /**
   * 记入内存缓存，超出总量上限时淘汰最久未使用的。
   *
   * 按字节而不是按张数：封面尺寸差距很大（150px 的缩略图与 800px 的原图差 20 倍），
   * 按张数算会让上限形同虚设。
   */
  private remember(url: string, canvas: Canvas): void {
    const existing = this.memory.get(url)
    if (existing) this.memoryBytes -= canvasBytes(existing)
    // 先删再插，位置才会移到末尾（`Map.set` 对已存在的键不改顺序）
    this.memory.delete(url)
    this.memory.set(url, canvas)
    this.memoryBytes += canvasBytes(canvas)
    for (const [key, value] of this.memory) {
      if (this.memoryBytes <= COVER_MEMORY_MAX_BYTES) break
      if (key === url) break
      this.memory.delete(key)
      this.memoryBytes -= canvasBytes(value)
    }
  }

  private async fetchAndDecode(url: string): Promise<Canvas | null> {
    const cachedFile = await this.readDiskCache(url)
    if (cachedFile) {
      const canvas = await decodeToCanvas(cachedFile, this.maxEdge)
      if (canvas) return canvas
      // 磁盘上的文件损坏时删掉，重新下载
      await fs.rm(this.filePath(url), { force: true }).catch(() => undefined)
    }

    // 逐个候选地址尝试：图床偶尔缺某个尺寸的图，只试一个地址整张封面就变成占位块了。
    // 总耗时受 `COVER_TOTAL_BUDGET_MS` 约束，避免多个候选叠加成十几秒。
    const deadline = Date.now() + COVER_TOTAL_BUDGET_MS
    for (const candidate of coverUrlCandidates(url)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this.logger.debug('[render] 封面超出时间预算，使用占位块: %s', sanitizeUrl(url))
        break
      }
      const buffer = await this.download(candidate, Math.min(COVER_TIMEOUT_MS, remaining))
      if (!buffer) continue
      const canvas = await decodeToCanvas(buffer, this.maxEdge)
      if (!canvas) {
        this.logger.debug('[render] 封面解码失败: %s', sanitizeUrl(candidate))
        continue
      }
      // 一律按原始地址落盘缩略图，下次直接用缓存，不再重试备用地址
      void this.writeThumbnail(url, canvas)
      if (candidate !== url) this.logger.debug('[render] 封面改用备用地址成功: %s', sanitizeUrl(candidate))
      return canvas
    }
    this.logger.debug('[render] 封面全部候选地址都失败: %s', sanitizeUrl(url))
    return null
  }

  private async download(url: string, timeout = COVER_TIMEOUT_MS): Promise<Buffer | null> {
    try {
      const buffer = toBuffer(await this.http.get<unknown>(url, {
        timeout,
        responseType: 'arraybuffer',
        // 封面已有候选地址回退，重试同一地址只会把单次超时叠成数倍
        retries: 0,
      }))
      if (!buffer) {
        this.logger.debug('[render] 封面响应不是二进制数据，使用占位块: %s', sanitizeUrl(url))
        return null
      }
      if (buffer.byteLength > COVER_MAX_BYTES) {
        this.logger.debug('[render] 封面体积超过上限（%d bytes），使用占位块: %s', buffer.byteLength, sanitizeUrl(url))
        return null
      }
      return buffer
    } catch (error) {
      this.logger.debug('[render] 封面下载失败，改用占位块（%s）: %s', sanitizeUrl(url), errorMessage(error))
      this.http.hintOnFailure(error)
      return null
    }
  }

  // #region 磁盘缓存

  /**
   * 版本迁移：旧版缓存存的是接口原图，v3 起只存缩略图。
   *
   * 用缓存目录里的 `.version` 标记判断；版本变化时整目录清空，避免旧原图继续占空间。
   * 所有读写都先等待这个 Promise，避免清理与首次写入并发。
   */
  private ensureCacheVersion(): Promise<void> {
    if (this.versionReady) return this.versionReady
    this.versionReady = (async () => {
      try {
        const marker = await fs.readFile(this.versionPath, 'utf8').catch(() => null)
        if (marker?.trim() === String(COVER_CACHE_VERSION)) return
        await fs.rm(this.cacheRoot, { recursive: true, force: true }).catch(() => undefined)
        await fs.mkdir(this.cacheRoot, { recursive: true })
        await fs.writeFile(this.versionPath, String(COVER_CACHE_VERSION))
        this.cacheReady = true
      } catch (error) {
        this.logger.debug('[render] 封面缓存版本迁移失败: %s', errorMessage(error))
      }
    })()
    return this.versionReady
  }

  private filePath(url: string): string {
    // 键里带上版本与边长：不同清晰度不共享缓存，切换配置后不会误读旧缩略图
    const hash = createHash('sha1').update(`v${COVER_CACHE_VERSION}|${this.maxEdge}|${url}`).digest('hex')
    return resolve(this.cacheRoot, hash.slice(0, 2), `${hash}.jpg`)
  }

  /** 该封面是否命中磁盘缓存（仅用于统计，不参与加载流程） */
  private async isOnDisk(url: string): Promise<boolean> {
    if (!this.enabled) return false
    try {
      await fs.access(this.filePath(url))
      return true
    } catch {
      return false
    }
  }

  private async readDiskCache(url: string): Promise<Buffer | null> {
    if (!this.enabled) return null
    await this.ensureCacheVersion()
    const path = this.filePath(url)
    try {
      const stat = await fs.stat(path)
      const ttl = this.cacheDays * 24 * 60 * 60 * 1000
      if (Date.now() - stat.mtimeMs > ttl) return null
      return await fs.readFile(path)
    } catch {
      return null
    }
  }

  /** 把已缩到配置边长的画布编码成 JPEG 落盘；失败只影响下次冷加载，不影响本次出图 */
  private async writeThumbnail(url: string, canvas: Canvas): Promise<void> {
    try {
      const thumbnail = await canvas.encode('jpeg', COVER_THUMB_QUALITY)
      await this.writeDiskCache(url, thumbnail)
    } catch (error) {
      this.logger.debug('[render] 封面缩略图编码失败，本次仅用内存缓存: %s', errorMessage(error))
    }
  }

  private async writeDiskCache(url: string, buffer: Buffer): Promise<void> {
    if (!this.enabled) return
    await this.ensureCacheVersion()
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
        this.logger.debug('[render] 封面磁盘缓存不可用，仅用内存缓存: %s', errorMessage(error))
      }
    }
  }

  /** 清理过期的封面缓存，插件启动时调用一次即可 */
  async prune(): Promise<void> {
    if (!this.enabled) return
    await this.ensureCacheVersion()
    try {
      const ttl = this.cacheDays * 24 * 60 * 60 * 1000
      const files: { path: string; mtimeMs: number }[] = []
      const buckets = await fs.readdir(this.cacheRoot, { withFileTypes: true })
      for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue
        const dir = resolve(this.cacheRoot, bucket.name)
        for (const file of await fs.readdir(dir)) {
          if (!file.endsWith('.jpg')) continue
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
        this.logger.debug('[render] 清理封面缓存失败: %s', errorMessage(error))
      }
    }
  }

  // #endregion
}
