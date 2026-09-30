/**
 * 判定用两级标准：
 *
 * - **标题**归一化后完全相等（含 AniList 的 synonyms）——这是硬条件；
 * - **首播日期**相差不超过 `MAX_DAY_GAP` 天——硬条件，用来排除同名的不同季；
 * - **播出时刻**相差不超过 `MAX_HOUR_GAP` 小时——**软条件**。
 *
 * 时刻留作软条件的原因：AniList 记的是「某一时刻可以看」，与日本电视档期本来就可能
 * 差几小时甚至一天（配信早于电视时）。时刻对不上只说明**档期需要订正**，不代表映射错了；
 * 这类条目应当同时填进 `src/schedule/overrides.ts`。脚本会在输出里标出这类条目。
 */
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { Logger } from 'koishi'
import { ANILIST_ID_MAP } from '../src/schedule/anilist-ids'
import { matchByTitle, normalizeTitle, type MatchCandidate } from '../src/data/anilist-match'
import { fetchUrl } from './http'

const PACKAGE_ROOT = resolve(__dirname, '..')
const TABLE_FILE = resolve(PACKAGE_ROOT, 'src/schedule/anilist-ids.ts')

/** 首播日期允许的偏差（天） */
const MAX_DAY_GAP = 30
/** 播出时刻允许的偏差（小时）；AniList 记录的是「可看时刻」，与配信档有时差 */
const MAX_HOUR_GAP = 6
/** 两次请求之间的间隔，避开 AniList 的突发限流 */
const REQUEST_GAP_MS = 2500
/** 一次搜索最多看几个候选 */
const SEARCH_LIMIT = 8

const HOUR = 3600000
const DAY = 86400000

// #region 标题归一化

// #endregion

// #region AniList 查询

interface AniListMedia {
  id: number
  title?: { native?: string | null; romaji?: string | null; english?: string | null } | null
  synonyms?: string[] | null
  format?: string | null
  episodes?: number | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  airingSchedule?: { nodes?: { episode?: number | null; airingAt?: number | null }[] | null } | null
}

const MEDIA_FIELDS = `id title { native romaji english } synonyms format episodes
  startDate { year month day } airingSchedule(perPage: 50) { nodes { episode airingAt } }`

const sleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms) })

let lastRequestAt = 0

/** 发一次 GraphQL 请求，遇 429 退避重试 */
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    try {
      return await fetchUrl<T>('https://graphql.anilist.co', { as: 'json', method: 'POST', body: { query, variables } })
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 429) {
        console.log('  遇到限流，等待 25 秒后重试…')
        await sleep(25000)
        continue
      }
      throw error
    }
  }
  return null
}

async function searchByTitle(title: string): Promise<AniListMedia[]> {
  const payload = await graphql<{ data?: { Page?: { media?: AniListMedia[] } } }>(
    `query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) { media(search: $search, type: ANIME) { ${MEDIA_FIELDS} } }
    }`,
    { search: title, perPage: SEARCH_LIMIT },
  )
  return payload?.data?.Page?.media ?? []
}

// #endregion

// #region 评分

// #endregion

// #region 写入映射表

/** 把映射并回 `anilist-ids.ts`，保留文件头部说明 */
function writeTable(next: Record<number, number>): void {
  const source = readFileSync(TABLE_FILE, 'utf8')
  const marker = 'export const ANILIST_ID_MAP: Record<number, number> = {'
  const head = source.slice(0, source.indexOf(marker))
  const sorted = Object.entries(next)
    .map(([bgm, aniList]) => [Number(bgm), aniList] as const)
    .sort((a, b) => b[0] - a[0])
  const body = sorted
    .map(([bgm, aniList]) => `  ${bgm}: ${aniList},`)
    .join('\n')
  writeFileSync(TABLE_FILE, `${head}${marker}\n${body}\n}\n`, 'utf8')
}

// #endregion

async function main() {
  const args = process.argv.slice(2)
  const shouldWrite = args.includes('--write')
  const checkOnly = args.includes('--check')
  const scanAll = args.includes('--all')

  const mod = require('bangumi-data') as { items: BangumiDataItemLike[] }
  const now = Date.now()
  const targets: BangumiDataItemLike[] = []
  for (const item of mod.items) {
    if (item.type !== 'tv' && item.type !== 'web') continue
    const aniList = siteOf(item, 'aniList')
    if (aniList !== null) continue
    if (checkOnly) {
      if (siteOf(item, 'bangumi') !== null && ANILIST_ID_MAP[siteOf(item, 'bangumi') as number] !== undefined) targets.push(item)
      continue
    }
    const begin = item.begin ? Date.parse(item.begin) : NaN
    if (!scanAll && (!Number.isFinite(begin) || begin < now - 730 * DAY || begin > now + 180 * DAY)) continue
    targets.push(item)
  }

  console.log(checkOnly
    ? `复核映射表里的 ${targets.length} 部作品`
    : `待匹配的 tv/web 条目：${targets.length} 部${scanAll ? '（全库）' : '（近两年）'}`)
  console.log('')

  const accepted: Record<number, number> = {}
  const rejected: string[] = []
  const needOverride: string[] = []
  for (const item of targets) {
    const bgm = siteOf(item, 'bangumi')
    if (bgm === null) { rejected.push(`${item.title}（无 Bangumi 条目 ID）`); continue }
    const hits = await searchByTitle(item.title)
    const matched = matchByTitle(
      {
        title: item.title,
        beginMs: item.begin ? Date.parse(item.begin) : null,
        broadcastMs: firstMsOf(item.broadcast),
      },
      hits,
    )
    const gapText = matched
      ? `日期差 ${matched.dayGap === null ? '?' : matched.dayGap.toFixed(0)} 天 / 时刻差 ${matched.hourGap === null ? '?' : matched.hourGap.toFixed(1)} 小时`
      : '无候选'
    if (!matched) {
      if (checkOnly) rejected.push(`${item.title}  [${gapText}]`)
      continue
    }
    accepted[bgm] = matched.candidate.id
    if (!matched.timeAgrees) needOverride.push(`${String(item.title).slice(0, 40)}  [${gapText}]`)
    console.log(`${matched.timeAgrees ? '✓' : '△'} ${String(item.title).slice(0, 40).padEnd(42)} → #${String(matched.candidate.id).padEnd(8)} ${gapText}`)
  }

  if (checkOnly) {
    console.log(rejected.length
      ? `\n✗ 有 ${rejected.length} 条现有映射不再成立：\n  ${rejected.join('\n  ')}`
      : '\n✓ 表里所有映射仍然成立')
    if (rejected.length) process.exit(1)
    return
  }

  console.log(`\n可用映射 ${Object.keys(accepted).length} 部`)
  if (rejected.length) console.log(`跳过 ${rejected.length} 部（标题或日期对不上）：\n  ${rejected.join('\n  ')}`)
  if (needOverride.length) {
    console.log(`\n△ ${needOverride.length} 部的播出时刻与顶层值相差较大。手工订正表已废弃，`
      + `这些条目以 AniList 的时刻为准：\n  ${needOverride.join('\n  ')}`)
  }

  if (!shouldWrite) {
    console.log('\n（未写入。确认无误后加 --write）')
    return
  }
  // 上游已有的映射不覆盖；新增与更新都只在补充表里进行
  const merged = { ...ANILIST_ID_MAP, ...accepted }
  writeTable(merged)
  console.log(`\n✓ 已写入 src/schedule/anilist-ids.ts（共 ${Object.keys(merged).length} 条）`)
}

/** bangumi-data 里我们只用到这几个字段 */
interface BangumiDataItemLike {
  title: string
  type?: string
  begin?: string
  broadcast?: string
  sites?: { site?: string; id?: string }[]
}

function siteOf(item: BangumiDataItemLike, site: string): number | null {
  const raw = item.sites?.find((entry) => entry.site === site)?.id
  return raw && /^\d+$/.test(raw) ? Number(raw) : null
}

/** 从 `R/<首次时刻>/P7D` 里取出首次时刻；无法解析时返回 null */
function firstMsOf(broadcast: string | undefined): number | null {
  const matched = broadcast ? /^R\/([^/]+)\//.exec(broadcast) : null
  if (!matched) return null
  const ms = Date.parse(matched[1])
  return Number.isFinite(ms) ? ms : null
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
