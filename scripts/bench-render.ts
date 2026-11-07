/**
 * 生图性能基准（不进构建产物）。
 *
 * 只测渲染：索引与四张表先构建好，再重复出图，记录墙钟、CPU、RSS 峰值与输出体积。
 *
 * ```bash
 * cd external/anime-schedule
 * npx tsx scripts/bench-render.ts                 # 默认配置（超采样 2）
 * npx tsx scripts/bench-render.ts --supersample=3 # 对比更高倍率
 * npx tsx scripts/bench-render.ts --quality=90    # 对比 JPEG 质量
 * npx tsx scripts/bench-render.ts --cover-limit=40
 * npx tsx scripts/bench-render.ts --no-cover
 * npx tsx scripts/bench-render.ts --iters=5
 * ```
 *
 * 冷/热构建耗时看 `scripts/bench.ts`；这里关注图片本身的资源占用。
 */
import { Logger } from 'koishi'
import { createContext } from './context'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { DigestService } from '../src/services/digest'
import { AiringStatusService } from '../src/services/airing'
import { Renderer, toRenderPayload } from '../src/render/image'
import { HttpClient } from '../src/services/network'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { getMessages } from '../src/constants'
import type { Digest } from '../src/types'

const args = process.argv.slice(2)
const readNumber = (name: string, fallback: number): number => {
  const prefix = `--${name}=`
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  const parsed = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const supersample = Math.max(1, Math.min(5, Math.round(readNumber('supersample', 2))))
const quality = Math.max(1, Math.min(100, Math.round(readNumber('quality', 90))))
const iters = Math.max(1, Math.round(readNumber('iters', 3)))
const withCover = !args.includes('--no-cover')
const coverLimit = Math.max(0, Math.round(readNumber('cover-limit', 0)))
const ctx = createContext()

/** 采样 RSS 峰值：Canvas 的像素缓冲在原生侧，只能在出图期间轮询整进程 RSS */
async function samplePeakRss<T>(task: () => Promise<T>): Promise<{ result: T; peakRss: number }> {
  let peakRss = process.memoryUsage().rss
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 10)
  try {
    const result = await task()
    return { result, peakRss }
  } finally {
    clearInterval(timer)
  }
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

async function main(): Promise<void> {
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({
    ...base,
    advanced: { ...base.advanced, debug: false },
    output: { ...base.output, showCover: withCover },
    render: { ...base.render, supersample, jpegQuality: quality, coverLimit },
  })

  const logger = new Logger('bench-render')
  const http = new HttpClient(ctx, logger)
  const index = new BangumiDataIndex(ctx, logger, http)
  const airing = new AiringStatusService(ctx, logger, http)
  const digest = new DigestService(ctx, config, logger, index, http, airing)
  const renderer = new Renderer(ctx, config, logger, new HttpClient(ctx, logger))
  const messages = getMessages(config.locale)

  const started = Date.now()
  await index.load()
  console.log(`索引载入（${index.size} 部） ${Date.now() - started}ms`)
  console.log(`超采样 ${supersample}x / JPEG q=${quality} / 封面 ${withCover ? (coverLimit ? `最多 ${coverLimit} 张` : '开') : '关'} / 每张预热 1 次、采样 ${iters} 次\n`)

  const builds: [string, () => Promise<Digest>][] = [
    ['daily-table', () => digest.buildDaily(0, new Set())],
    ['night-table', () => digest.buildNight(new Set())],
    ['weekly-table', () => digest.buildWeekly()],
    ['season-table', () => digest.buildSeason(0, new Set())],
  ]

  console.log('类别            墙钟(ms)   CPU(ms)   峰值RSS增量   输出')
  for (const [label, build] of builds) {
    const payload = toRenderPayload(await build(), messages)
    // 预热：字体、封面、JPEG 编码器与 Canvas 原生库的首次调用不参与采样
    await renderer.render(payload)

    let wall = 0
    let cpu = 0
    let peakDelta = 0
    let bytes = 0
    for (let i = 0; i < iters; i++) {
      if (typeof global.gc === 'function') global.gc()
      const rssBefore = process.memoryUsage().rss
      const cpuBefore = process.cpuUsage()
      const wallBefore = performance.now()
      const sampled = await samplePeakRss(() => renderer.render(payload))
      wall += performance.now() - wallBefore
      const used = process.cpuUsage(cpuBefore)
      cpu += (used.user + used.system) / 1000
      peakDelta += Math.max(0, sampled.peakRss - rssBefore)
      bytes = sampled.result.length
    }
    console.log(
      `${label.padEnd(14)} ${(wall / iters).toFixed(0).padStart(8)}`
      + ` ${(cpu / iters).toFixed(0).padStart(8)}`
      + ` ${mb(peakDelta / iters).padStart(10)}MB`
      + ` ${(bytes / 1024).toFixed(0).padStart(8)}KB`,
    )
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
