import { h } from 'koishi'
import type { Context, Logger } from 'koishi'
import { DIGEST_LABELS, getMessages } from '../constants'
import type { Config } from '../config'
import type { Digest, DigestItem, DigestKind, AnimeChannel } from '../types'
import type { DigestService } from './digest'
import type { Dispatcher, DispatchGuard } from './dispatch'
import { digestKey, updateKey } from './dispatch'
import { formatClock, formatDate, getSeasonStartMonth, parseClock, resolveClockMs, today } from '../utils/time'

/** 一次调度里单个推送类型的结果，用于日志汇总 */
interface PushResult {
  kind: DigestKind
  targets: number
  sent: number
  skipped: number
  failed: number
}

/**
 * 定时推送调度。
 *
 * 每分钟对表一次而不是用长定时器：所有时刻按配置时区换算，服务器时区、夏令时与
 * 休眠都不会让推送漂移。判定条件只要求「当天该时刻已过」，因此进程在推送时刻之后
 * 启动也能补上；当天是否真的发过由 `DispatchGuard` 的唯一键决定。
 */
export class Scheduler {
  private timer: (() => void) | null = null
  private running = false
  private lastMinuteKey = ''
  private lastReminderAt = 0
  /** 当天已经处理过的推送类型，避免「时刻已过」被每分钟重复执行 */
  private handled: { date: string; kinds: Set<DigestKind> } = { date: '', kinds: new Set() }

  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private digest: DigestService,
    private dispatcher: Dispatcher,
    private guard: DispatchGuard,
    private onIdle: () => Promise<void>,
  ) {}

  start(): void {
    this.timer = this.ctx.setInterval(() => void this.tick(), 30 * 1000)
    this.logger.info('[scheduler] 调度已启动，推送时刻按 %s 计算', this.config.timeZone)
  }

  stop(): void {
    if (this.timer) {
      this.timer()
      this.timer = null
    }
  }

  /** 每 30 秒对表一次，同一分钟内只跑一轮 */
  private async tick(): Promise<void> {
    const now = Date.now()
    const minuteKey = `${formatDate(now, this.config.timeZone)} ${formatClock(now, this.config.timeZone)}`
    if (minuteKey === this.lastMinuteKey) return
    this.lastMinuteKey = minuteKey
    await this.runDue(now)
  }

  private async runDue(now: number): Promise<void> {
    if (this.running) {
      this.logger.debug('[scheduler] 上一轮调度尚未结束，跳过本次触发')
      return
    }
    this.running = true
    try {
      const due = this.dueKinds(now)
      for (const kind of due) await this.pushKind(kind, now)
      if (this.config.push.updateReminderEnabled && this.reminderDue(now)) await this.pushUpdateReminders(now)
      await this.guard.cleanup()
      await this.onIdle()
    } catch (error) {
      this.logger.error('[scheduler] 调度执行失败:', error)
    } finally {
      this.running = false
    }
  }

  /**
   * 开播提醒的独立轮询间隔。
   *
   * 调度器每 30 秒对表一次，但提醒没必要这么频繁——由 `updatePollMinutes`
   * 控制实际频率（默认 10 分钟）。
   */
  private reminderDue(now: number): boolean {
    const interval = this.config.push.updatePollMinutes * 60 * 1000
    if (this.lastReminderAt !== 0 && now - this.lastReminderAt < interval) return false
    this.lastReminderAt = now
    return true
  }

  /**
   * 当前时刻已经过了哪些配置好的推送时刻。
   *
   * 只要求「已过」而不是「正好在这一分钟内」：否则进程在 08:00 之后启动、
   * 或服务器休眠错过那一分钟，当天的推送就永远不会发生。
   * 当天是否已经发过由 `DispatchGuard` 在逐频道发送时判断。
   */
  private dueKinds(now: number): DigestKind[] {
    const kinds: DigestKind[] = []
    const date = today(this.config.timeZone, now)

    const passed = (clockText: string): boolean => {
      const clock = parseClock(clockText)
      if (!clock) return false
      return now >= resolveClockMs(date, clock, this.config.timeZone)
    }

    if (this.config.push.dailyEnabled && passed(this.config.push.dailyTime)) kinds.push('daily')
    if (this.config.push.nightEnabled && passed(this.config.push.nightTime)) kinds.push('night')
    // 本季表只在季度首日发一次：1 / 4 / 7 / 10 月的 1 日
    if (this.config.push.seasonEnabled && this.isSeasonStart(date) && passed(this.config.push.seasonTime)) {
      kinds.push('season')
    }
    if (this.config.push.weeklyEnabled && passed(this.config.push.weeklyTime)) {
      const weekday = this.localWeekday(date)
      if (weekday === this.config.push.weeklyWeekday) kinds.push('weekly')
    }
    return kinds
  }

  /** 本地日期是否是季度首日（1 / 4 / 7 / 10 月的 1 日） */
  private isSeasonStart(date: string): boolean {
    const [year, month, day] = date.split('-').map(Number)
    return day === 1 && getSeasonStartMonth(month) === month && year > 0
  }

  /** 记录「这一天的这个类型已处理」，跨天自动重置；返回 false 表示今天已处理过 */
  private markHandled(kind: DigestKind, date: string): boolean {
    if (this.handled.date !== date) this.handled = { date, kinds: new Set() }
    if (this.handled.kinds.has(kind)) return false
    this.handled.kinds.add(kind)
    return true
  }

  /** 按本地时区算某天是星期几 */
  private localWeekday(date: string): number {
    const [year, month, day] = date.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  }

  /**
   * 向所有开启了该类型的频道推送。
   *
   * 每种类型每天只真正尝试一次，否则「时刻已过」会让它从推送时刻到当天结束
   * 每分钟重复查库与构建。当天是否真的发过仍由逐频道的 `DispatchGuard` 决定。
   */
  async pushKind(kind: DigestKind, now = Date.now()): Promise<PushResult> {
    const result: PushResult = { kind, targets: 0, sent: 0, skipped: 0, failed: 0 }
    const date = today(this.config.timeZone, now)
    if (!this.markHandled(kind, date)) return result

    const channels = await this.enabledChannels(kind)
    if (!channels.length) {
      this.logger.info('[push] %s: 没有启用的推送目标，跳过本次推送', DIGEST_LABELS[kind])
      return result
    }
    result.targets = channels.length

    let content: Digest | null = null
    // 订阅表的内容按群算，必须逐群构建；其余类型全群共用一份
    const perChannel = kind === 'sub'
    const cache = new Map<string, Digest>()
    const key = digestKey(kind, date)

    for (const channel of channels) {
      try {
        const cacheKey = `${channel.platform}:${channel.channelId}`
        let current: Digest | null = perChannel ? cache.get(cacheKey) ?? null : content
        if (!current) {
          current = await this.digest.build(kind, channel.platform, channel.channelId, now)
          if (perChannel) cache.set(cacheKey, current)
          else content = current
        }
        if (!current.groups.length) {
          result.skipped++
          this.logger.debug('[push] %s: %s:%s 本次没有符合条件的作品，跳过', DIGEST_LABELS[kind], channel.platform, channel.channelId)
          continue
        }
        this.logger.debug('[push] 准备发送 %s 给 %s:%s', DIGEST_LABELS[kind], channel.platform, channel.channelId)
        if (!(await this.guard.reserve(channel.platform, channel.channelId, kind, key))) {
          result.skipped++
          continue
        }
        await this.dispatcher.deliver(channel, current)
        result.sent++
      } catch (error) {
        result.failed++
        await this.guard.release(channel.platform, channel.channelId, kind, key)
        this.logger.warn('[push] 向 %s:%s 发送 %s 失败:', channel.platform, channel.channelId, DIGEST_LABELS[kind], error)
      }
    }

    if (result.sent === 0 && result.failed === 0) {
      this.logger.info('[push] %s: 本次没有符合条件的作品，未发送任何消息', DIGEST_LABELS[kind])
      return result
    }

    this.logger.info(
      '[push] %s 完成，目标 %d 个，成功 %d，跳过 %d，失败 %d',
      DIGEST_LABELS[kind],
      result.targets,
      result.sent,
      result.skipped,
      result.failed,
    )
    return result
  }

  private async enabledChannels(kind: DigestKind): Promise<AnimeChannel[]> {
    const field = kind === 'daily' ? 'dailyEnabled'
      : kind === 'night' ? 'nightEnabled'
        : kind === 'weekly' ? 'weeklyEnabled'
          : 'seasonEnabled'
    return this.ctx.database.get('anime_channel', { [field]: true } as never)
  }

  /**
   * 订阅作品的开播提醒。
   *
   * 场次由周期规则推算，与定时列表推送面向不同时间点，也不受频道的列表开关影响：
   * 只要订阅作品的开播时刻落进提前量窗口，就提醒一次。
   */
  async pushUpdateReminders(now = Date.now()): Promise<PushResult> {
    const result: PushResult = { kind: 'sub', targets: 0, sent: 0, skipped: 0, failed: 0 }
    const lookaheadMs = this.config.push.updateLookaheadMinutes * 60 * 1000
    const windowEnd = now + lookaheadMs

    const subscriptions = await this.ctx.database.get('anime_subscription', { enabled: true })
    if (!subscriptions.length) return result

    // 取 2 天是为了覆盖「次日凌晨」的场次，随后再按提前量收敛
    const airings = (await this.digest.upcomingAirings(
      [...new Set(subscriptions.map((item) => item.tid))],
      2,
    )).filter((item) => item.atMs > now && item.atMs <= windowEnd)
    if (!airings.length) return result

    const byTid = new Map(airings.map((item) => [item.tid, item]))
    const byChannel = new Map<string, { platform: string; channelId: string; items: Map<string, DigestItem> }>()
    for (const subscription of subscriptions) {
      const airing = byTid.get(subscription.tid)
      if (!airing) continue
      const key = `${subscription.platform}:${subscription.channelId}`
      let bucket = byChannel.get(key)
      if (!bucket) {
        bucket = { platform: subscription.platform, channelId: subscription.channelId, items: new Map() }
        byChannel.set(key, bucket)
      }
      bucket.items.set(airing.tid, airing)
    }

    for (const bucket of byChannel.values()) {
      const channel = await this.digest.getChannel(bucket.platform, bucket.channelId)
      if (!channel) continue
      result.targets++

      const fresh: DigestItem[] = []
      const sorted = [...bucket.items.values()].sort((a, b) => a.atMs - b.atMs)
      for (const item of sorted) {
        if (await this.guard.reserve(bucket.platform, bucket.channelId, 'sub', updateKey(item.tid, item.atMs))) {
          fresh.push(item)
        }
      }
      if (!fresh.length) {
        result.skipped++
        continue
      }

      try {
        // 与推送表同一套版式：首行时刻 + 集数，标题与提示各占一行
        const lines = fresh.map((item) => {
          const inMinutes = Math.max(0, Math.round((item.atMs - now) / 60000))
          const episode = item.recurring && item.episodeCount > 0
            ? getMessages(this.config.locale).episodeUnit(item.episodeCount)
            : ''
          const lead = episode ? `${item.time} ${episode}` : item.time
          return `${lead}\n  ${item.name}\n  还有约 ${inMinutes} 分钟开播`
        })
        const message = h.text([
          `即将开播 (${formatDate(now, this.config.timeZone)})`,
          ...lines,
        ].join('\n\n'))

        const bot = this.ctx.bots.find((entry) => entry.selfId === channel.botId)
        if (bot) await bot.sendMessage(channel.channelId, message)
        else await this.ctx.broadcast([`${channel.platform}:${channel.channelId}`], message)
        result.sent++
      } catch (error) {
        result.failed++
        for (const item of fresh) {
          await this.guard.release(bucket.platform, bucket.channelId, 'sub', updateKey(item.tid, item.atMs))
        }
        this.logger.warn('[push] 向 %s:%s 发送开播提醒失败:', bucket.platform, bucket.channelId, error)
      }
    }

    if (result.sent || result.failed) {
      this.logger.info(
        '[push] 开播提醒完成，目标 %d 个，成功 %d，跳过 %d，失败 %d',
        result.targets,
        result.sent,
        result.skipped,
        result.failed,
      )
    }
    return result
  }
}
