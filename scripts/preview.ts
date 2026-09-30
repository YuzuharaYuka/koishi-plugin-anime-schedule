/**
 * 图片预览脚本：拉取真实数据并把各排版的图片写到 target/anime-preview 下，用于人工检查版面。
 *
 * 用法:
 *   npx tsx scripts/preview.ts [--no-network] [--no-cover]
 * 出图写到 target/anime-preview（该目录已在 .gitignore 中）
 */
import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Logger } from 'koishi'
import { createContext } from './context'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { DigestService } from '../src/services/digest'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { Renderer } from '../src/render/image'
import { HttpClient } from '../src/services/network'
import type { Digest, ImageLayout, RenderPayload } from '../src/types'
import { getMessages } from '../src/constants'
import { setupDebug } from '../src/utils'

const args = process.argv.slice(2)
const proxyIndex = args.indexOf('--proxy')
// 维护脚本用 undici 的 ProxyAgent，**只支持 http(s) 代理**（不认 socks5）。
// 默认留空 = 直连；需要代理时显式传 --proxy http://127.0.0.1:7890。
const proxy = proxyIndex >= 0 ? args[proxyIndex + 1] : ''
const skipCover = args.includes('--no-cover')
const target = resolve(process.cwd(), 'target/anime-preview')

function makeCtx(): any {
  if (proxy) process.env.ANIME_PROXY = proxy
  return createContext({ baseDir: resolve(process.cwd(), 'target/anime-smoke') })
}

async function main() {
  const ctx = makeCtx()
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig({
    ...base,
    output: {
      ...base.output,
      showCover: !skipCover,
      // 预览要看到真实的封面密度，因此不设上限
      coverLimit: 0,
    },
    advanced: { ...base.advanced, debug: true },
  })
  const logger = new Logger('preview')
  setupDebug(true, logger)
  const index = new BangumiDataIndex(ctx, logger)
  await index.load()
  const digest = new DigestService(ctx, config, logger, index)

  const renderer = new Renderer(ctx, config, logger, new HttpClient(ctx, logger))
  renderer.init()

  // 让预览里能看到「已订阅」气泡：把今日表中的一部分作品当作已订阅
  const dailyForSubs = await digest.buildDaily(0)
  const subscribed = new Set(
    dailyForSubs.groups
      .flatMap((group) => group.items)
      .filter((_, index) => index % 4 === 0)
      .map((item) => item.tid),
  )
  const seasonForSubs = await digest.buildSeason(0)
  for (const item of seasonForSubs.groups.flatMap((group) => group.items).slice(0, 3)) subscribed.add(item.tid)
  console.log('预览用已订阅集合:', [...subscribed].join(' '))

  await fs.mkdir(target, { recursive: true })

  const payloadOf = (item: Digest): RenderPayload => ({
    kind: item.kind,
    header: item.header,
    summary: item.summary,
    groups: item.groups,
    seasonLabel: item.seasonLabel,
    rangeLabel: item.rangeLabel ?? '',
    footer: getMessages(config.locale).footer,
  })

  const jobs: { name: string; build: () => Promise<Digest> }[] = [
    { name: 'daily', build: () => digest.buildDaily(0, subscribed) },
    { name: 'night', build: () => digest.buildNight(subscribed) },
    { name: 'weekly', build: () => digest.buildWeekly(subscribed) },
    { name: 'season', build: () => digest.buildSeason(0, subscribed) },
  ]

  const built: Digest[] = []
  for (const job of jobs) {
    const started = Date.now()
    const item = await job.build()
    built.push(item)
    console.log(
      `${job.name}: ${item.header} | ${item.summary} | 分组 ${item.groups.length} 项 ${item.groups.reduce((sum, group) => sum + group.items.length, 0)} (构建 ${Date.now() - started}ms)`,
    )
  }

  await digest.localizer.save()

  const layouts: { layout: ImageLayout; kinds: string[] }[] = [
    { layout: 'table', kinds: ['daily', 'night', 'weekly'] },
    { layout: 'list', kinds: ['daily'] },
  ]

  for (const entry of layouts) {
    config.output.layout = entry.layout
    for (const name of entry.kinds) {
      const item = built.find((value) => value.kind === name)
      if (!item) continue
      if (name === 'season' && entry.layout === 'list') continue
      const started = Date.now()
      const buffer = await renderer.render(payloadOf(item))
      const file = resolve(target, `${name}-${entry.layout}.jpg`)
      await fs.writeFile(file, buffer)
      console.log(`${name}-${entry.layout}: ${buffer.length} bytes (${Date.now() - started}ms)`)
    }
  }

  // 本季固定用封面网格
  config.output.layout = 'table'
  const season = built.find((value) => value.kind === 'season')
  if (season) {
    const started = Date.now()
    const buffer = await renderer.render(payloadOf(season))
    await fs.writeFile(resolve(target, 'season-grid.jpg'), buffer)
    console.log(`season-grid: ${buffer.length} bytes (${Date.now() - started}ms)`)
  }

  console.log('完成，输出目录:', target)
}

main().catch((error) => {
  console.error('预览失败:', error)
  process.exit(1)
})
