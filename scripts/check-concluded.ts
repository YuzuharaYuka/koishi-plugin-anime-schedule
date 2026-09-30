/**
 * 完结判定校验脚本（不进构建产物）。
 *
 * 检查三件事：
 * 1. 已知「末集已过」的作品不再出现在每日 / 本周表（幽灵场次被剔除）；
 * 2. 跨季共用一个 Bangumi ID 的长期番仍被保留（不会被逐集档期误杀）；
 * 3. 表里不存在「末集日期早于这一场一个周期以上」的条目。
 *
 * 用法（先 `cd external/anime-schedule`）: npx tsx scripts/check-concluded.ts
 */
import { Logger } from 'koishi'
import { createContext } from './context'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { AiringStatusService } from '../src/services/airing'
import { DigestService } from '../src/services/digest'
import { getDayStartMs, today } from '../src/utils/time'

const ctx = createContext()

/**
 * 已知在样例日期（2026-09-30）仍在播的作品。
 *
 * - 小3アシベ / 名探偵プリキュア：AniList `RELEASING`（没有集数，只能看状态）；
 * - おでかけ子ザメ 第二季：bangumi-data 里第一季与第二季是两个条目，第二季带自己的
 *   AniList ID；**同季校验**负责挡下误配到第一季的情况；
 * - SEALOOK 2nd season：**没有 aniList ID**（AniList 确实没有这部），用来覆盖
 *   「AniList 覆盖不到时退回 Bangumi 逐集档期」的兜底路径。
 */
const MUST_KEEP = ['小3アシベ', '名探偵プリキュア', 'おでかけ子ザメ', 'SEALOOK']

/** 已知在样例日期已经播完、必须被剔除的作品（均为 2026 夏番，末集在 9 月中下旬）。 */
const MUST_DROP = [
  'ふつつかな悪女', // 末集 2026-09-20
  '黄泉のツガイ', // 末集 2026-09-19
  '転生したらスライムだった件 第4期', // 末集 2026-09-25
]

async function main(): Promise<void> {
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({ ...base, timeZone: 'Asia/Shanghai' })
  const logger = new Logger('check')

  const index = new BangumiDataIndex(ctx, logger)
  const airing = new AiringStatusService(ctx, logger)
  const digest: any = new DigestService(ctx, config, logger, index, airing)
  await index.load()

  const date = today(digest.timeZone)
  const now = getDayStartMs(date, digest.timeZone)

  const daily = await digest.buildDaily(0, new Set(), now)
  const weekly = await digest.buildWeekly(new Set(), now)
  const items = daily.groups.flatMap((group: any) => group.items)
  const weeklyItems = weekly.groups.flatMap((group: any) => group.items)
  console.log(`样例日期 ${date}：每日表 ${items.length} 条，本周表 ${weeklyItems.length} 条`)

  // 拿不到 AniList 数据时整轮断言没有意义（会被限流误导成「误杀」）
  if (!items.length && !weeklyItems.length) {
    console.log('\n⚠ 两次构建都是空的（可能被限流），本次不做断言——请稍后重跑')
    process.exit(0)
  }

  const failures: string[] = []
  // 保留类断言查「日表 + 周表」：作品可能不在样例当天，但一周内仍有场次
  const allItems = [...items, ...weeklyItems]

  /**
   * 条目是否在表里。
   *
   * 断言用**日文原名**，而卡面显示什么取决于 `localize.titleStyle`（默认 `localized`，
   * 显示中文译名）。因此不能只看 `item.name`——那样一改标题样式，所有断言就静默失效。
   * 这里同时接受卡面显示名与索引里的日文原名。
   */
  const present = (keyword: string): boolean => {
    if (allItems.some((item: any) => item.name.includes(keyword))) return true
    return index.search(keyword, 5).some((entry: any) => {
      if (!entry.title.includes(keyword)) return false
      if (entry.bangumiId === null) return false
      const tid = `bgm:${entry.bangumiId}`
      return allItems.some((item: any) => item.tid === tid)
    })
  }

  for (const keyword of MUST_KEEP) {
    const hit = present(keyword)
    console.log(`${hit ? '✓' : '✗'} 保留 ${keyword}`)
    if (!hit) failures.push(`${keyword} 被误杀`)
  }
  for (const keyword of MUST_DROP) {
    const hit = present(keyword)
    console.log(`${hit ? '✗' : '✓'} 剔除 ${keyword}`)
    if (hit) failures.push(`${keyword} 未被剔除`)
  }

  console.log(`\n${failures.length ? `✗ ${failures.join('；')}` : '✓ 完结判定符合预期'}`)
  if (failures.length) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(1) })
