/**
 * 校验脚本（不进构建产物）：确认调度器每天每种推送只真正尝试一次。
 *
 * 复现原来的问题：`dueKinds` 只判断「时刻已过」，于是从推送时刻到当天结束的
 * 每一分钟都会重新查一遍频道表；这里用计数数据库验证现在只查一次。
 *
 * 用法: npx tsx external/anime-schedule/scripts/diag-scheduler.ts
 */
import { Logger } from 'koishi'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { Scheduler } from '../src/services/scheduler'
import { setupDebug } from '../src/utils'

setupDebug(false, new Logger('diag-scheduler'))

let channelQueries = 0
let dispatchQueries = 0
let builds = 0

const ctx: any = {
  database: {
    get: async (name: string) => {
      if (name === 'anime_channel') { channelQueries++; return [] }
      if (name === 'anime_dispatch') { dispatchQueries++; return [] }
      return []
    },
    set: async () => ({ modified: 0 }),
    upsert: async () => [],
    remove: async () => ({ removed: 0 }),
  },
  setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
  setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); return () => clearInterval(t) },
  bots: [],
}

async function main() {
  const config: Config = normalizeConfig(ConfigSchema({} as never) as unknown as Config)
  const digest: any = {
    build: async () => { builds++; return { kind: 'daily', header: '', summary: '', groups: [], seasonLabel: '', generatedAt: Date.now() } },
    getChannel: async () => null,
  }
  const dispatcher: any = { deliver: async () => undefined }
  const guard: any = { reserve: async () => true, release: async () => undefined, cleanup: async () => undefined }

  const scheduler = new Scheduler(ctx, config, new Logger('diag-scheduler'), digest, dispatcher, guard, async () => undefined)
  const kind = 'daily' as const

  console.log('连续调用 pushKind 5 次（模拟同一分钟内被反复触发）:')
  for (let i = 0; i < 5; i++) await scheduler.pushKind(kind, Date.now())
  console.log(`  频道表查询 ${channelQueries} 次 / 构建 ${builds} 次 / 去重表查询 ${dispatchQueries} 次`)
  if (channelQueries !== 1) throw new Error('频道表被查询了多次，仍会每分钟重复执行')
  if (builds !== 0) throw new Error('没有目标时不应构建内容')

  console.log('\n换一个类型（night）:')
  await scheduler.pushKind('night', Date.now())
  await scheduler.pushKind('night', Date.now())
  console.log(`  频道表查询累计 ${channelQueries} 次`)

  console.log('\n跨天后再调用（应重新允许一次）:')
  await scheduler.pushKind(kind, Date.now() + 86400000)
  console.log(`  频道表查询累计 ${channelQueries} 次`)

  console.log('\n通过')
}

main().catch((error) => { console.error(error); process.exit(1) })
