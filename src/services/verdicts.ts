import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type { Context, Logger } from 'koishi'
import {
  ANILIST_VERDICT_TTL_MS,
  DATA_DIR,
  EPISODE_VERDICT_TTL_MS,
  VERDICT_CACHE_FILE,
  VERDICT_CACHE_MAX_ENTRIES,
  VERDICT_CACHE_VERSION,
} from '../constants'
import type { IndexEntry } from '../data/bangumi-data'
import { debugLog, errorMessage } from '../utils'

/**
 * 判定缓存记录的原因。只保存**下次构建仍会得出同一结论**的判定：
 *
 * - `anilist-mismatch`：AniList 记录指向别季，不应再拿它的状态做完结判断；
 * - `anilist-finished`：AniList 已确认完结，且给出了最后一集的时刻；
 * - `episode-mismatch`：bangumi-data 的开播日期与 Bangumi 逐集档期首集相差数年，
 *   这个条目已不可信；
 * - `episode-untrusted`：Bangumi 逐集档期的末集与开播日期推算差得太远，不能拿来完结判断，
 *   但作品本身仍应保留；
 * - `episode-finished`：Bangumi 逐集档期确认末集已过去。
 *
 * 与「本次窗口」有关的判定（例如 AniList 排期没覆盖本周）不写入缓存，否则会挡住后续
 * 真正的更新。
 */
export type VerdictReason =
  | 'anilist-mismatch'
  | 'anilist-finished'
  | 'episode-mismatch'
  | 'episode-untrusted'
  | 'episode-finished'

export interface VerdictRecord {
  key: string
  title: string
  reason: VerdictReason
  /** 判定作出时条目的 AniList ID；AniList ID 变了就作废 */
  aniListId: number | null
  /** 精确时刻判定：`atMs` 晚于它才剔除（用于 AniList 的末集时刻） */
  dropAfterMs: number | null
  /** 按日判定：场次的 JST 日期晚于它才剔除（用于 Bangumi 的末集日期） */
  dropAfterDay: number | null
  at: number
  expiresAt: number
}

interface VerdictCacheFile {
  version: number
  entries: Record<string, VerdictRecord>
}

const VERDICT_REASONS: ReadonlySet<VerdictReason> = new Set([
  'anilist-mismatch',
  'anilist-finished',
  'episode-mismatch',
  'episode-untrusted',
  'episode-finished',
])

const DAY_MS = 86400000

/** AniList 与 Bangumi 的末集日期都是 UTC 零点，判断「同一场」时必须换算成 JST 日期 */
function jstDay(ms: number): number {
  return Math.floor((ms + 9 * 3600000) / DAY_MS)
}

function isDropReason(reason: VerdictReason): boolean {
  return reason === 'anilist-finished'
    || reason === 'episode-mismatch'
    || reason === 'episode-finished'
}

/**
 * 「不采信 / 已剔除」判定的本地持久化缓存。
 *
 * 这些判定的输入（bangumi-data 的 `aniList` ID、逐集档期）很少变化，但原实现每次构建
 * 都会重新查 AniList、重新算一遍，然后再次得出「这条记录不是这一季」或「这部已经播完」。
 * 周表一次构建要为此多发几十个请求、多打几十行日志。
 *
 * 缓存只影响 daily / night / weekly / sub 的完结闸门，**不影响本季表**：季表本来就要
 * 展示整季作品，不能因为「已完结」把它们藏起来。
 */
export class VerdictCache {
  private readonly records = new Map<string, VerdictRecord>()
  private readonly cachePath: string
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private dirty = false
  private flushTimer: (() => void) | null = null
  private flushing: Promise<void> | null = null
  private writeFailed = false

  constructor(
    private ctx: Context,
    private logger: Logger,
  ) {
    this.cachePath = resolve(ctx.baseDir, ...DATA_DIR, VERDICT_CACHE_FILE)
  }

  /** 确保缓存已从磁盘读取；重复调用只读一次 */
  ensure(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    return this.load()
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      try {
        const text = await fs.readFile(this.cachePath, 'utf8')
        const parsed = JSON.parse(text) as VerdictCacheFile
        if (parsed?.version !== VERDICT_CACHE_VERSION || !parsed.entries) {
          this.logger.info(
            '[verdict] 缓存版本 %s 与当前 %d 不符，本次重新构建',
            parsed?.version ?? '(无)',
            VERDICT_CACHE_VERSION,
          )
          return
        }
        for (const record of Object.values(parsed.entries)) {
          if (!record || typeof record.key !== 'string' || !VERDICT_REASONS.has(record.reason)) continue
          if (typeof record.expiresAt !== 'number' || typeof record.at !== 'number') continue
          if (record.expiresAt <= Date.now()) continue
          this.records.set(record.key, record)
        }
        debugLog('[verdict] 判定缓存载入完成，条目数: %d', this.records.size)
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          this.logger.warn('[verdict] 读取判定缓存失败，将从空缓存开始:', error)
        }
      } finally {
        this.loaded = true
      }
    })()
    return this.loadPromise
  }

  /** 这条场次是否已被缓存判定为「应当剔除」 */
  shouldDrop(entry: IndexEntry, atMs: number): boolean {
    const record = this.active(entry)
    if (!record) return false
    if (record.reason === 'episode-mismatch') return true
    if (record.reason === 'anilist-finished') {
      return record.dropAfterMs !== null && atMs > record.dropAfterMs
    }
    if (record.reason === 'episode-finished') {
      return record.dropAfterDay !== null && jstDay(atMs) > record.dropAfterDay
    }
    return false
  }

  /** 是否应跳过这条条目的 AniList 状态请求（记录指向别季） */
  shouldSkipAniList(entry: IndexEntry): boolean {
    return this.active(entry)?.reason === 'anilist-mismatch'
  }

  /**
   * 是否应跳过这条条目的逐集档期完结判断。
   *
   * 与 AniList 判定分开存：一部作品可能同时「AniList 指向别季」和「Bangumi 逐集档期不可信」，
   * 两条判定都要保留，不能互相覆盖，所以逐集档期用独立的 `#episodes` 键。
   */
  shouldSkipEpisodeDates(entry: IndexEntry): boolean {
    const record = this.records.get(this.episodeKey(entry))
    return record?.reason === 'episode-untrusted' && record.expiresAt > Date.now()
  }

  /** 记录一次判定；同一部作品后出现的「剔除」记录可以覆盖较轻的「不采信」 */
  record(
    entry: IndexEntry,
    reason: VerdictReason,
    patch: { dropAfterMs?: number | null; dropAfterDay?: number | null } = {},
  ): void {
    this.put(entry.key, entry, reason, patch)
  }

  /** Bangumi 逐集档期不可信：只影响闸门 3，不影响是否剔除作品 */
  markEpisodeUntrusted(entry: IndexEntry): void {
    this.put(this.episodeKey(entry), entry, 'episode-untrusted')
  }

  private episodeKey(entry: IndexEntry): string {
    return `${entry.key}#episodes`
  }

  private put(
    cacheKey: string,
    entry: IndexEntry,
    reason: VerdictReason,
    patch: { dropAfterMs?: number | null; dropAfterDay?: number | null } = {},
  ): void {
    const now = Date.now()
    const previous = this.records.get(cacheKey)
    if (previous && previous.expiresAt > now) {
      // 已经确认剔除的作品，不要再被一次「不采信」降级；反过来则可以
      if (isDropReason(previous.reason) && !isDropReason(reason)) return
      // 相同内容不重复写盘
      if (previous.reason === reason
        && previous.aniListId === entry.aniListId
        && previous.dropAfterMs === (patch.dropAfterMs ?? null)
        && previous.dropAfterDay === (patch.dropAfterDay ?? null)) {
        return
      }
    }

    const ttl = reason === 'anilist-mismatch' || reason === 'anilist-finished'
      ? ANILIST_VERDICT_TTL_MS
      : EPISODE_VERDICT_TTL_MS
    this.records.set(cacheKey, {
      key: cacheKey,
      title: entry.title,
      reason,
      aniListId: entry.aniListId,
      dropAfterMs: patch.dropAfterMs ?? null,
      dropAfterDay: patch.dropAfterDay ?? null,
      at: now,
      expiresAt: now + ttl,
    })
    this.dirty = true
    debugLog('[verdict] 记录判定: %s → %s', entry.title, reason)
    this.scheduleFlush()
  }

  /** 取出仍在有效期内的记录；AniList 判定还要求 ID 没变 */
  private active(entry: IndexEntry): VerdictRecord | undefined {
    const record = this.records.get(entry.key)
    if (!record || record.expiresAt <= Date.now()) return undefined
    if ((record.reason === 'anilist-mismatch' || record.reason === 'anilist-finished')
      && record.aniListId !== entry.aniListId) {
      return undefined
    }
    return record
  }

  /** 主动落盘，插件卸载与调度结束时调用 */
  async save(): Promise<void> {
    if (this.flushTimer) {
      this.flushTimer()
      this.flushTimer = null
    }
    await this.flush()
    if (this.dirty && !this.flushing) await this.flush()
  }

  /** 同 Localizer：串行写盘，失败时保留 dirty 供下次重试 */
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (!this.dirty) return Promise.resolve()
    this.flushing = this.writeCache().finally(() => {
      this.flushing = null
      if (this.dirty && !this.writeFailed) this.scheduleFlush()
    })
    return this.flushing
  }

  private async writeCache(): Promise<void> {
    this.dirty = false
    this.prune()
    if (this.records.size > VERDICT_CACHE_MAX_ENTRIES) {
      const sorted = [...this.records.values()].sort((a, b) => a.expiresAt - b.expiresAt)
      const drop = sorted.slice(0, sorted.length - Math.floor(VERDICT_CACHE_MAX_ENTRIES / 2))
      for (const record of drop) this.records.delete(record.key)
    }

    const payload: VerdictCacheFile = { version: VERDICT_CACHE_VERSION, entries: {} }
    for (const [key, record] of this.records) payload.entries[key] = record

    const temp = `${this.cachePath}.tmp`
    try {
      await fs.mkdir(dirname(this.cachePath), { recursive: true })
      await fs.writeFile(temp, JSON.stringify(payload), 'utf8')
      await fs.rename(temp, this.cachePath)
      this.writeFailed = false
    } catch (error) {
      this.dirty = true
      this.writeFailed = true
      this.logger.warn('[verdict] 写入判定缓存失败:', errorMessage(error))
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key)
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = this.ctx.setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 3000)
  }
}
