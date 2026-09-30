/**
 * 单部作品核对脚本（不进构建产物）：输入 Bangumi 条目 ID 或关键词，
 * 依次打印它的索引周期、Bangumi 逐集档期、**AniList 逐話时刻与完结状态**，
 * 以及插件最终会做出的判定——用来排查「某部作品为什么出现 / 为什么消失」。
 *
 * 用法（先 `cd external/anime-schedule`，命令在插件目录里执行）:
 *   npx tsx scripts/inspect.ts 515594
 *   npx tsx scripts/inspect.ts 黄泉
 *   npx tsx scripts/inspect.ts 転生スライム --season 2026-07
 *
 * 手工订正表已废弃并移除，正常情况下不需要人工干预：
 * 完结判定交给 AniList，AniList 没有的条目退回 Bangumi 逐集档期。
 */
import { Logger } from 'koishi'
import { createContext } from './context'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { BangumiDataIndex, type IndexEntry } from '../src/data/bangumi-data'
import { AiringStatusService } from '../src/services/airing'
import { getDayStartMs, getSeasonStartMonth } from '../src/utils/time'
import { fetchUrl } from './http'

const args = process.argv.slice(2)
const query = args.find((value) => !value.startsWith('--')) ?? ''
const seasonArg = args.includes('--season') ? args[args.indexOf('--season') + 1] : undefined

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const ctx = createContext()

/** 把毫秒格式化成 `YYYY-MM-DD HH:mm`（按 +08:00） */
function stamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '（无）'
  const date = new Date(ms + 8 * 3600000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function describeEntry(entry: IndexEntry): void {
  console.log(`\n── 索引条目`)
  console.log(`  标题      ${entry.title}`)
  console.log(`  译名      ${entry.zhHans || '（无）'}`)
  console.log(`  bangumiId ${entry.bangumiId ?? '（无）'}`)
  console.log(`  aniListId ${entry.aniListId ?? '（无）'}`)
  console.log(`  类型/周期 ${entry.type} / ${entry.recurring ? `${entry.periodDays} 天` : '一次性'}`)
  console.log(`  首播      ${stamp(entry.broadcastMs ?? entry.beginMs)}`)
  console.log(`  最终回    ${stamp(entry.endMs)}`)
}

async function inspectAniList(entry: IndexEntry, airing: AiringStatusService): Promise<void> {
  if (entry.aniListId === null) {
    console.log(`\n── AniList：该条目没有 aniListId，插件将退回 Bangumi 逐集档期判定`)
    return
  }
  console.log(`\n── AniList 状态`)
  const states = await airing.resolve([entry.aniListId], 0)
  const state = states.get(entry.aniListId)
  if (!state) {
    console.log(`  未能取到（可能限流或该 ID 不存在）`)
    return
  }
  console.log(`  status    ${state.status}`)
  console.log(`  总话数    ${state.episodes ?? '（未给，视为无限连载番）'}`)
  console.log(`  首播/终映 ${state.startDate ?? '?'} ~ ${state.endDate ?? '?'}`)
  console.log(`  已播到    ${state.airedEpisodes ?? '?'}（最终回 ${stamp(state.lastAiredMs)}）`)
  console.log(`  下一話    ${state.nextEpisode ? `第 ${state.nextEpisode.episode} 話 @ ${stamp(state.nextEpisode.atMs)}` : '（无）'}`)
  const upcoming = state.schedule.filter((item) => item.atMs > Date.now()).slice(0, 5)
  console.log(`  未来场次  ${upcoming.length ? upcoming.map((item) => `ep${item.episode}@${stamp(item.atMs)}`).join('  ') : '（无）'}`)
}

async function inspectBangumiEpisodes(entry: IndexEntry): Promise<void> {
  if (entry.bangumiId === null) return
  console.log(`\n── Bangumi 逐集档期`)
  try {
    const raw = await fetchUrl<any>(
      `https://api.bgm.tv/v0/episodes?subject_id=${entry.bangumiId}&type=0&limit=100`,
      { as: 'json' },
    )
    const list: any[] = raw?.data ?? []
    if (!list.length) { console.log(`  （无逐集数据）`); return }
    const dated = list.filter((item) => item.airdate)
    console.log(`  共 ${list.length} 集，其中有档期 ${dated.length} 集`)
    const first = dated[0]
    const last = dated[dated.length - 1]
    if (first) console.log(`  首集 ${first.airdate}`)
    if (last) console.log(`  末集 ${last.airdate}（第 ${last.sort ?? last.ep ?? '?'} 集）`)
  } catch (error) {
    console.log(`  取失败：${String(error).slice(0, 140)}`)
  }
}

async function main(): Promise<void> {
  if (!query) {
    console.log('用法: npx tsx scripts/inspect.ts <条目ID|关键词> [--season 2026-07]')
    process.exit(1)
  }

  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({ ...base, timeZone: 'Asia/Shanghai' })
  const logger = new Logger('inspect')

  const index = new BangumiDataIndex(ctx, logger)
  const airing = new AiringStatusService(ctx, logger)
  await index.load()

  const matched: IndexEntry[] = /^\d+$/.test(query)
    ? [index.bySubjectId(Number(query))].filter(Boolean) as IndexEntry[]
    : index.search(query, 5)

  if (!matched.length) {
    console.log(`没有匹配「${query}」的条目`)
    process.exit(1)
  }

  console.log(`查询「${query}」命中 ${matched.length} 部`)

  if (seasonArg) {
    const [year, month] = seasonArg.split('-').map(Number)
    const startMonth = getSeasonStartMonth(month)
    const { startMs, endMs } = index.seasonWindow(year, startMonth)
    console.log(`该季窗口（${year} 年 ${startMonth} 月起）: ${stamp(startMs)} ~ ${stamp(endMs)}`)
    const now = getDayStartMs(new Date().toISOString().slice(0, 10), config.timeZone)
    for (const entry of matched) {
      const base = entry.broadcastMs
      const period = (entry.periodDays ?? 7) * 86400000
      const next = entry.recurring && base !== null && period > 0 && base < now
        ? base + Math.ceil((now - base) / period) * period
        : base
      const weekday = next === null ? '?' : WEEKDAY_ZH[new Date(next + 8 * 3600000).getUTCDay()]
      console.log(`  ${entry.title.slice(0, 30).padEnd(32)} 下一次 ${stamp(next)} ${weekday}`)
    }
  }

  for (const entry of matched) {
    console.log(`\n════ ${entry.title}`)
    describeEntry(entry)
    await inspectAniList(entry, airing)
    await inspectBangumiEpisodes(entry)
  }

  console.log('\n提示：手工订正表已废弃；若判定不符合预期，先看上面的 AniList 状态。')
}

main().catch((error) => { console.error(error); process.exit(1) })
