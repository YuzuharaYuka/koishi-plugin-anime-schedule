/**
 * 季度范围校验脚本（不进构建产物）：确认各偏移的季度都能构建出内容。
 *
 * 用法（先 `cd external/anime-schedule`）: npx tsx scripts/check-season.ts
 */
import { resolve } from 'path'
import { Logger } from 'koishi'
import { createContext } from './context'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { DigestService } from '../src/services/digest'

const PACKAGE_ROOT = resolve(__dirname, '..')

const ctx = createContext()

async function main(): Promise<void> {
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({ ...base, timeZone: 'Asia/Shanghai' })
  const logger = new Logger('check')

  const index = new BangumiDataIndex(ctx, logger)
  const digest: any = new DigestService(ctx, config, logger, index)
  await index.load()

  const offsets = [-2, -1, 0, 1, 2, 3]
  const counts = new Map<number, number>()
  for (const offset of offsets) {
    const result = await digest.buildSeason(offset)
    const count = result.groups.flatMap((group: any) => group.items).length
    counts.set(offset, count)
    const first = result.groups[0]?.items[0]
    console.log(
      `偏移 ${String(offset).padStart(2)} → ${(result.seasonLabel || '（无）').padEnd(12)}`,
      `| ${(result.summary || '（空）').padEnd(30)}`,
      `| 条目 ${String(count).padStart(3)}`,
      first ? `| 首项 ${first.airLabel} ${first.name.slice(0, 20)}` : '',
    )
  }

  const failures: string[] = []
  if (!counts.get(0)) failures.push('当季为空')
  if (!counts.get(-1)) failures.push('上一季为空')

  // 下一季只看「bangumi-data 有没有收录」，不当作硬性要求：季末时它常常还是空的
  // （2026-09-30 实测 2027 冬窗口内 0 部）。没数据就明确报告是数据未收录。
  if (!counts.get(1)) {
    console.log('\n（下一季为空：bundled bangumi-data 尚未收录该季，属正常情况）')
  }

  console.log(`\n${failures.length ? `✗ ${failures.join('；')}` : '✓ 当季与上一季均可构建'}`)
  if (failures.length) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(1) })
