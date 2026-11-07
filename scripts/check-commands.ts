import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Logger } from 'koishi'
import { createContext } from './context'
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { BangumiDataIndex } from '../src/data/bangumi-data'
import { AiringStatusService } from '../src/services/airing'
import { DigestService } from '../src/services/digest'
import { HttpClient } from '../src/services/network'
import { InfoService } from '../src/services/info'
import { Renderer } from '../src/render/image'
import { getMessages } from '../src/constants'
import {
  commandInfo,
  commandNight,
  commandPush,
  commandSearch,
  commandSeason,
  commandToday,
  commandWeekly,
  type HandlerContext,
} from '../src/handlers'

const target = resolve(process.cwd(), 'target/command-tests')

/** 从 h 元素里递归取出 img 的 data URL 并解码 */
function collectImages(content: any): Buffer[] {
  const result: Buffer[] = []
  const visit = (element: any) => {
    if (!element || typeof element !== 'object') return
    if (element.type === 'img' && typeof element.attrs?.src === 'string') {
      const matched = /^data:image\/[^;]+;base64,(.+)$/.exec(element.attrs.src)
      if (matched) result.push(Buffer.from(matched[1], 'base64'))
    }
    for (const child of element.children ?? []) visit(child)
  }
  for (const element of Array.isArray(content) ? content : [content]) visit(element)
  return result
}

function collectText(content: any): string[] {
  if (typeof content === 'string') return [content]
  if (!content || typeof content !== 'object') return []
  if (content.type === 'text' && typeof content.attrs?.content === 'string') return [content.attrs.content]
  return (content.children ?? []).flatMap(collectText)
}

async function main() {
  await fs.mkdir(target, { recursive: true })
  const ctx: any = createContext({ baseDir: process.cwd() })
  const base = ConfigSchema({} as never) as unknown as Config
  const config = normalizeConfig(base)
  const logger = new Logger('check-commands')
  const http = new HttpClient(ctx, logger)
  const index = new BangumiDataIndex(ctx, logger, http)
  const airing = new AiringStatusService(ctx, logger, http)
  const digest = new DigestService(ctx, config, logger, index, http, airing)
  const renderer = new Renderer(ctx, config, logger, new HttpClient(ctx, logger))
  const info = new InfoService(ctx, logger, http, digest.localizer, config.timeZone, getMessages(config.locale))
  const deps: HandlerContext = { ctx, config, logger, digest, renderer, info }

  const images: { name: string; bytes: Buffer }[] = []
  let pendingText: string[] = []
  const session: any = {
    platform: 'test',
    channelId: 'channel-1',
    guildId: 'guild-1',
    userId: 'user-1',
    selfId: 'bot-1',
    messageId: 'message-1',
    bot: { supports: () => true },
    send: async (content: any) => {
      for (const image of collectImages(content)) {
        images.push({ name: `image-${images.length + 1}.jpg`, bytes: image })
      }
      pendingText.push(...collectText(content))
    },
    execute: async () => undefined,
  }

  await index.load()
  const run = async (name: string, fn: () => Promise<any>) => {
    pendingText = []
    const started = Date.now()
    const result = await fn()
    if (result) await session.send(result)
    await fs.writeFile(resolve(target, `${name}.txt`), pendingText.join('\n'), 'utf8')
    console.log(`${name}: ${Date.now() - started}ms, 文本 ${pendingText.length} 段, 图片 ${images.length}`)
  }

  await run('anime-today', () => commandToday(deps, session, 0))
  await run('anime-today-offset', () => commandToday(deps, session, -1))
  await run('anime-night', () => commandNight(deps, session))
  await run('anime-week', () => commandWeekly(deps, session))
  await run('anime-season-2020', () => commandSeason(deps, session, '2020春'))
  await run('anime-push-daily', () => commandPush(deps, session, 'daily'))
  await run('anime-info-id', () => commandInfo(deps, session, '400602'))
  await run('anime-info-search', () => commandInfo(deps, session, '转生'))
  await run('anime-search', () => commandSearch(deps, session, '转生'))

  for (const image of images) {
    await fs.writeFile(resolve(target, image.name), image.bytes)
  }
  console.log(`图片文件 ${images.length} 张 → ${target}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
