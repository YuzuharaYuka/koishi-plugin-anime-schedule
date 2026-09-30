/**
 * 结构快照脚本（不进构建产物）。
 *
 * 改动构建管线时用它确认「输出没被意外改动」：
 *
 * ```powershell
 * npx tsx scripts/snapshot.ts before
 * # … 改源码 …
 * npx tsx scripts/snapshot.ts after
 * npx tsx scripts/snapshot-diff.ts before after
 * ```
 *
 * 输出写到 `target/anime-snapshot/<label>.json`。
 *
 * 两个要点：
 * - **参考时刻固定**（`ANIME_SNAPSHOT_NOW`，默认 2026-09-29 12:00 UTC+8）。不固定的话
 *   跨天跑两次结果必然不同，比对没有意义。**每个构建都要显式传它**——周表与订阅排期的
 *   窗口是「今天起 N 天」，漏传就会用真实时钟，跨过午夜后两次运行落在不同的七天里；
 * - **只记结构性字段**（名称、时刻、集数、排序、分组、首播年月）。封面 URL 与评分会被
 *   Bangumi 侧的实时变动带偏，与被重构的逻辑无关，因此只记「有没有」。
 */
import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Logger } from 'koishi'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { createContext } from './context'
import { DigestService } from '../src/services/digest'
import { AiringStatusService } from '../src/services/airing'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import type { Digest, DigestItem } from '../src/types'

const PACKAGE_ROOT = resolve(__dirname, '..')
const label = process.argv[2] ?? 'snapshot'

/** 固定参考时刻：2026-09-29 12:00 UTC+8，与开发时的当季对齐 */
const FIXED_NOW = Number(process.env.ANIME_SNAPSHOT_NOW ?? Date.UTC(2026, 8, 29, 4, 0, 0))

/** 订阅排期用的样本作品：当季在播、长期番、剧场版各取一部 */
const SAMPLE_TIDS = ['bgm:607043', 'bgm:501963', 'bgm:633836', 'bgm:515594']
const SEARCH_KEYWORDS = ['転生', '無職', '黄泉', 'ラブライブ']

/** 只保留结构性字段：封面与评分只记「有没有」，避免实时变动干扰比对 */
function slimItem(item: DigestItem) {
  return {
    tid: item.tid,
    bgmId: item.bgmId,
    name: item.name,
    date: item.date,
    time: item.time,
    episode: item.episode,
    episodeCount: item.episodeCount,
    recurring: item.recurring,
    subscribed: item.subscribed,
    firstYear: item.firstYear,
    firstMonth: item.firstMonth,
    type: item.type,
    hasCover: !!item.coverUrl,
    hasScore: item.scoreValue !== null,
    atMs: item.atMs,
  }
}

function slimDigest(digest: Digest) {
  return {
    header: digest.header,
    summary: digest.summary,
    seasonLabel: digest.seasonLabel,
    rangeLabel: digest.rangeLabel,
    groups: digest.groups.map((group) => ({
      label: group.label,
      date: group.date,
      items: group.items.map(slimItem),
    })),
  }
}

function makeCtx(): any {
  const ctx = createContext()
  ctx.database = {
    get: async (name: string) => (name === 'anime_subscription'
      ? SAMPLE_TIDS.map((tid, index) => ({
        id: index + 1,
        platform: 'sandbox',
        channelId: 'snapshot',
        tid,
        title: tid,
        enabled: true,
      }))
      : []),
    set: async () => undefined,
    upsert: async () => undefined,
    remove: async () => ({ removed: 0 }),
  }
  return ctx
}

async function main(): Promise<void> {
  const ctx = makeCtx()
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({ ...base, timeZone: 'Asia/Shanghai' })
  const logger = new Logger('snapshot')

  const index = new BangumiDataIndex(ctx, logger)
  const airing = new AiringStatusService(ctx, logger)
  const digest: any = new DigestService(ctx, config, logger, index, airing)

  await index.load()

  const out: Record<string, unknown> = {
    label,
    fixedNow: new Date(FIXED_NOW).toISOString(),
    indexSize: index.size,
    timeZone: config.timeZone,
    daily: null,
    night: null,
    weekly: null,
    season: null,
    seasonPrev: null,
    upcoming: null,
    search: null,
    timings: {} as Record<string, number>,
  }
  const timings = out.timings as Record<string, number>

  const run = async (name: string, task: () => Promise<unknown>) => {
    const at = Date.now()
    out[name] = await task()
    timings[name] = Date.now() - at
    console.log(`${name.padEnd(12)} ${String(Date.now() - at).padStart(7)}ms`)
  }

  await run('daily', async () => slimDigest(await digest.buildDaily(0, new Set(), FIXED_NOW)))
  await run('night', async () => slimDigest(await digest.buildNight(new Set(), FIXED_NOW)))
  // 周表与订阅排期也必须传固定时刻，否则窗口跟着真实时钟走
  await run('weekly', async () => slimDigest(await digest.buildWeekly(new Set(), FIXED_NOW)))
  await run('season', async () => slimDigest(await digest.buildSeason(0, new Set(), FIXED_NOW)))
  await run('seasonPrev', async () => slimDigest(await digest.buildSeason(-1, new Set(), FIXED_NOW)))
  await run('upcoming', async () => (await digest.upcomingAirings(SAMPLE_TIDS, 7, FIXED_NOW)).map(slimItem))
  await run('search', async () => {
    const result: Record<string, unknown> = {}
    for (const keyword of SEARCH_KEYWORDS) {
      result[keyword] = (await digest.search(keyword, 10)).map((item: DigestItem) => ({
        name: item.name,
        firstYear: item.firstYear,
        firstMonth: item.firstMonth,
        time: item.time,
        hasCover: !!item.coverUrl,
      }))
    }
    return result
  })

  const dir = resolve(PACKAGE_ROOT, 'target/anime-snapshot')
  await fs.mkdir(dir, { recursive: true })
  const file = resolve(dir, `${label}.json`)
  await fs.writeFile(file, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\n已写入 ${file}`)
}

main().catch((error) => { console.error('快照失败:', error); process.exit(1) })
