import type { Bot, Context, Logger } from 'koishi'
import { h } from 'koishi'
import { LOG_MESSAGES, RESPONSES } from '../constants'
import type { Config } from '../config'
import type { AnimeChannel, Digest, DigestKind } from '../types'
import { buildForward, renderText } from '../render/text'
import { errorMessage } from '../utils'

/** 推送记录的保留时间，超过后可以被清理 */
export const DISPATCH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** 去重键：同一目标、同一通知类型下唯一 */
export function digestKey(kind: DigestKind, date: string): string {
  return `digest:${kind}:${date}`
}

/** 开播提醒的去重键：同一部作品的同一场次只提醒一次 */
export function updateKey(tid: string, atMs: number): string {
  return `update:${tid}:${atMs}`
}

/**
 * 文本形态的投递，按平台能力选择普通文本或合并转发。
 *
 * 合并转发的判断依据是适配器是否声明 `message.forward`，同时要求处于群聊：
 * 私聊里合并转发没有意义，QQ 上也会被降级成普通消息。
 */
export async function sendTextDigest(
  bot: Bot | undefined,
  guildId: string,
  config: Config,
  digest: Digest,
): Promise<h.Fragment> {
  const canForward = config.output.useForward && !!guildId && !!bot?.supports('message.forward')
  if (!canForward) return renderText(config, digest)
  return buildForward(config, digest)
}

/**
 * 推送去重。
 *
 * `anime_dispatch` 的 `(platform, channelId, digestKind, dedupeKey)` 唯一，抢到记录
 * 才算「本次推送归我发」。
 *
 * 不能只做 `upsert`：唯一键被命中时数据库只更新既有行，于是每次调用都会「成功」，
 * 重启或重复调度就会重发。因此这里先查后写，并用按 key 串行的队列避免同进程内的
 * 并发插队（跨进程由数据库唯一键负责）。
 */
export class DispatchGuard {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private ctx: Context,
    private logger: Logger,
  ) {}

  private async has(platform: string, channelId: string, kind: DigestKind, key: string): Promise<boolean> {
    const rows = await this.ctx.database.get('anime_dispatch', {
      platform,
      channelId,
      digestKind: kind,
      dedupeKey: key,
    })
    return rows.length > 0
  }

  /** 抢占一条记录，返回是否抢到 */
  reserve(platform: string, channelId: string, kind: DigestKind, key: string): Promise<boolean> {
    const queueKey = `${platform}:${channelId}:${kind}:${key}`
    const previous = this.queues.get(queueKey) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => this.claim(platform, channelId, kind, key))
    this.queues.set(queueKey, task)
    void task.catch(() => undefined).finally(() => {
      if (this.queues.get(queueKey) === task) this.queues.delete(queueKey)
    })
    return task
  }

  private async claim(platform: string, channelId: string, kind: DigestKind, key: string): Promise<boolean> {
    try {
      if (await this.has(platform, channelId, kind, key)) return false
      await this.ctx.database.upsert('anime_dispatch', [{
        platform,
        channelId,
        digestKind: kind,
        dedupeKey: key,
        dispatchedAt: Date.now(),
      }], ['platform', 'channelId', 'digestKind', 'dedupeKey'])
      return true
    } catch (error) {
      this.logger.debug('[dispatch] 写入去重记录失败，本次按未发送处理: %s', errorMessage(error))
      return false
    }
  }

  /** 释放占用，发送失败时调用以便下次重试 */
  async release(platform: string, channelId: string, kind: DigestKind, key: string): Promise<void> {
    try {
      await this.ctx.database.remove('anime_dispatch', { platform, channelId, digestKind: kind, dedupeKey: key })
    } catch (error) {
      this.logger.debug('[dispatch] 回滚去重记录失败: %s', errorMessage(error))
    }
  }

  /** 清理过期记录，避免表无限增长 */
  async cleanup(): Promise<void> {
    try {
      const removed = await this.ctx.database.remove('anime_dispatch', {
        dispatchedAt: { $lt: Date.now() - DISPATCH_RETENTION_MS },
      })
      if (removed.removed) this.logger.debug('[dispatch] 已清理过期推送记录: %d 条', removed.removed)
    } catch (error) {
      this.logger.warn('[dispatch] %s', LOG_MESSAGES.cleanupFailed, error)
    }
  }
}

/** 把构建好的推送投递到指定频道，图片渲染失败时降级为文本 */
export class Dispatcher {
  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private renderDigest: (digest: Digest) => Promise<Buffer>,
  ) {}

  async deliver(channel: AnimeChannel, digest: Digest): Promise<void> {
    const bot = this.findBot(channel)
    if (this.config.output.format === 'image') {
      try {
        const buffer = await this.renderDigest(digest)
        await this.send(channel, h.image(buffer, 'image/jpeg'), bot)
        return
      } catch (error) {
        this.logger.warn('[dispatch] %s %s', RESPONSES.renderFailed, errorMessage(error))
      }
    }
    const content = await sendTextDigest(bot, channel.guildId, this.config, digest)
    await this.send(channel, content, bot)
  }

  /**
   * 投递一条消息。
   *
   * 受理机器人找不到时（记录里的 `botId` 已下线、换了账号）本来就走广播；此外
   * `sendMessage` 自身失败也要退到广播一次：适配器与平台的连接可能只是暂时不可用
   * （例如 NapCat / OneBot 端没起来，`bot._request` 还没初始化），此时同一频道上
   * 其它已连接的分身仍能把消息发出去。两条路都失败才向上抛，由调用方释放去重记录。
   */
  private async send(channel: AnimeChannel, content: h.Fragment, bot: Bot | undefined): Promise<void> {
    const scope = [`${channel.platform}:${channel.channelId}`]
    if (bot) {
      try {
        await bot.sendMessage(channel.channelId, content)
        return
      } catch (error) {
        this.logger.debug(
          '[dispatch] 受理机器人 (%s) 发送失败，改用广播: %s',
          channel.botId,
          errorMessage(error),
        )
      }
    } else {
      this.logger.debug('[dispatch] 找不到受理机器人 (%s)，改用广播发送', channel.botId)
    }
    await this.ctx.broadcast(scope, content)
  }

  private findBot(channel: AnimeChannel): Bot | undefined {
    return this.ctx.bots.find((item) => item.selfId === channel.botId)
  }
}
