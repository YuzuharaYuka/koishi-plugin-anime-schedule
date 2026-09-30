/**
 * 性能基准（不进构建产物）。
 *
 * 依次构建四张表并渲染成图，打印各阶段耗时，用于发现性能退化。
 *
 * ```bash
 * cd external/anime-schedule
 * npx tsx scripts/bench.ts              # 冷 + 热两轮
 * npx tsx scripts/bench.ts --render     # 额外测生图耗时
 * ```
 *
 * 读法：
 * - **冷**：进程刚起来，AniList 缓存是空的（本地化缓存仍在磁盘上，那是持久的）；
 * - **热**：同一进程再跑一遍，反映「缓存都命中」时的真实推送开销。
 *
 * 注意别反复连着跑：脚本会真的去 Bangumi 与 AniList 拉数据，连续多次可能触发限流，
 * 那时冷启动耗时会明显偏高。
 */
import { resolve } from 'path'
import { Logger } from 'koishi'
import { createContext } from './context'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { DigestService } from '../src/services/digest'
import { AiringStatusService } from '../src/services/airing'
import { Renderer } from '../src/render/image'
import { HttpClient } from '../src/services/network'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { getMessages } from '../src/constants'

const PACKAGE_ROOT = resolve(__dirname, '..')
const withRender = process.argv.includes('--render')

const ctx = createContext()

async function main() {
  const config: Config = normalizeConfig(ConfigSchema({} as never) as unknown as Config)

  const logger = new Logger('bench')
  const index = new BangumiDataIndex(ctx, logger)
  const airing = new AiringStatusService(ctx, logger)
  const digest = new DigestService(ctx, config, logger, index, airing)
  const renderer = new Renderer(ctx, config, logger, new HttpClient(ctx, logger))
  const messages = getMessages(config.locale)

  const run = async (label: string, task: () => Promise<unknown>) => {
    const started = Date.now()
    await task()
    console.log(`  ${label.padEnd(16)} ${String(Date.now() - started).padStart(7)}ms`)
  }

  let started = Date.now()
  await index.load()
  console.log(`索引载入（${index.size} 部）  ${Date.now() - started}ms\n`)

  const builds: [string, () => Promise<unknown>][] = [
    ['日表', () => digest.buildDaily(0, new Set())],
    ['深夜档', () => digest.buildNight(new Set())],
    ['周表', () => digest.buildWeekly()],
    ['本季表', () => digest.buildSeason(0, new Set())],
  ]

  for (const [pass, note] of [['冷', 'AniList 缓存为空'], ['热', '缓存全部命中']] as const) {
    console.log(`=== ${pass}启动（${note}）===`)
    for (const [label, task] of builds) await run(label, task)
    console.log('')
  }

  if (withRender) {
    console.log('=== 生图 ===')
    for (const [label, kind] of [['日表', 'daily'], ['深夜档', 'night'], ['周表', 'weekly'], ['本季表', 'season']] as const) {
      const built = kind === 'daily' ? await digest.buildDaily(0, new Set())
        : kind === 'night' ? await digest.buildNight(new Set())
        : kind === 'weekly' ? await digest.buildWeekly()
        : await digest.buildSeason(0, new Set())
      await run(label, () => renderer.render({ ...built, messages } as never))
    }
    console.log('')
  }

  await digest.localizer.save()
}

main().catch((error) => { console.error(error); process.exit(1) })
