import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { HttpClient } from '../services/network'
import type { Context, Logger } from 'koishi'
import { IMAGE_LIST_TWO_COLUMN_AT, IMAGE_LAYOUT, IMAGE_MAX_CARDS, LATE_NIGHT_END_HOUR, getMessages } from '../constants'
import type { Config } from '../config'
import type { DigestGroup, DigestItem, RenderPayload } from '../types'
import { font, FONT_SIZE, registerFonts } from './fonts'
import { CoverStore } from './covers'
import { getTimeZoneOffsetMs } from '../utils/time'
import {
  drawCard,
  drawContainImage,
  drawCoverPlaceholder,
  drawPill,
  fillRoundRect,
  fitText,
  THEME,
  type Theme,
} from './canvas'

/** 行卡片里的一块文字（时刻 / 标题 / 次要信息） */
interface CardLine {
  text: string
  color: string
  size: number
  bold?: boolean
}

/**
 * 风格化图片渲染器。
 *
 * 四种版面共用同一套版式规则：页眉是标题 + 副标题 + 统计 + 时区，页脚是数据来源；
 * 卡片文字顺序与配色统一为「标题 → 时间 → `ID:xxx` → 评分」。
 *
 * | 版面 | 用于 |
 * | :--- | :--- |
 * | 单日时间轴 | 每日 / 深夜档 |
 * | 七日周历 | 本周 |
 * | 卡片列表 | `output.layout = list` |
 * | 封面网格 | 本季，固定每行 10 部 |
 *
 * 封面统一按 `1 : 1.4` 等比完整显示，文字块的竖直位置只由版式常量决定，
 * 因此同一版面的每一条都对齐在同一条基线上。
 */
export class Renderer {
  private readonly covers: CoverStore
  private ready = false

  constructor(
    ctx: Context,
    private config: Config,
    private logger: Logger,
    /** 出网客户端（含代理），用于下载封面 */
    http: HttpClient,
  ) {
    this.covers = new CoverStore(ctx, logger, config.render.coverConcurrency, config.render.coverCacheDays, http)
  }

  /** 注册中文字体并清理过期的封面缓存，进程内只执行一次 */
  init(): void {
    if (this.ready) return
    this.ready = true
    registerFonts(this.config.render.fontFamily, this.logger)
    void this.covers.prune()
  }

  private get messages() {
    return getMessages(this.config.locale)
  }

  async render(payload: RenderPayload): Promise<Buffer> {
    this.init()
    const started = Date.now()
    const canvas = await this.draw(payload)
    const encoded = await canvas.encode('jpeg', this.config.render.jpegQuality)
    this.logger.debug(
      '[render] %s 出图完成 (%dms)，尺寸 %dx%d，%d bytes (jpeg q=%d)',
      payload.kind,
      Date.now() - started,
      canvas.width,
      canvas.height,
      encoded.length,
      this.config.render.jpegQuality,
    )
    return encoded
  }

  private async draw(payload: RenderPayload): Promise<Canvas> {
    if (payload.kind === 'season' && this.config.output.layout !== 'list') return this.drawSeason(payload)
    if (this.config.output.layout === 'list') return this.drawList(payload)
    if (payload.kind === 'weekly') return this.drawWeekGrid(payload)
    return this.drawTimeline(payload)
  }

  // #region 通用绘制

  /** 空白画布：统一底色 */
  private createSurface(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = THEME.background
    ctx.fillRect(0, 0, width, height)
    return { canvas, ctx }
  }

  /**
   * 行卡片内容块：封面在左、文字在右。
   *
   * `left` 是内容块左边缘，`centreY` 是竖直中心；封面高度与行距都由版式常量决定，
   * 因此不同条目的标题、时间、ID、评分落在同一条基线上。
   */
  private drawCardBody(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    left: number,
    centreY: number,
    width: number,
    lines: CardLine[],
  ): void {
    const L = IMAGE_LAYOUT
    const mediaHeight = L.mediaHeight
    const mediaWidth = Math.round(mediaHeight * L.seasonCoverRatio)
    const top = centreY - mediaHeight / 2

    if (this.config.output.showCover) {
      if (cover) drawContainImage(ctx, cover, left, top, mediaWidth, mediaHeight, { radius: L.mediaRadius })
      else drawCoverPlaceholder(ctx, item.name, left, top, mediaWidth, mediaHeight, L.mediaRadius)
    }

    const textX = this.config.output.showCover ? left + mediaWidth + L.mediaGap : left
    this.drawCardLines(ctx, textX, centreY, Math.max(24, left + width - textX), lines)
  }

  /**
   * 卡片文字块：与封面一起整体居中，行距固定。
   *
   * 行数与行距都由版式常量给定，因此每张卡片的标题、评分、ID、集数
   * 都落在同样的基线上，与标题长短、有没有评分无关。
   */
  private drawCardLines(
    ctx: SKRSContext2D,
    left: number,
    centreY: number,
    width: number,
    lines: CardLine[],
  ): void {
    if (!lines.length) return
    const gap = IMAGE_LAYOUT.cardLineGap
    const total = lines.reduce((sum, line) => sum + line.size + gap, 0) - gap
    let cursor = centreY - total / 2

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (const line of lines) {
      ctx.font = font(line.size, line.bold)
      ctx.fillStyle = line.color
      ctx.fillText(fitText(ctx, line.text, width), left, cursor + line.size / 2)
      cursor += line.size + gap
    }
  }

  /** 评分文本，未开启评分展示时为空 */
  private scoreText(item: DigestItem): string {
    if (!this.config.output.showScore || !item.score) return ''
    return item.score
  }

  /** `ID:253104`，与 `anime.sub <ID>` 的参数写法一致 */
  private idText(item: DigestItem): string {
    return item.bgmId === null ? '' : `ID:${item.bgmId}`
  }

  /**
   * 条目的「已订阅」气泡。
   *
   * 各版面共用；调用方给的是**气泡右边缘**的位置，因此气泡向左展开，
   * 不会盖住右侧的 ID 或标题。`bottom` 为 `true` 时 `y` 视为气泡底边，
   * 用于把气泡贴在卡片右下角。
   */
  private drawSubscribedBadge(
    ctx: SKRSContext2D,
    item: DigestItem,
    right: number,
    y: number,
    cardWidth: number,
    bottom = false,
  ): void {
    if (!item.subscribed) return
    const size = cardWidth < 200 ? FONT_SIZE.badge : FONT_SIZE.badge + 1
    const height = size + 10
    const paddingX = 7
    const top = bottom ? y - height : y
    ctx.font = font(size, true)
    const width = ctx.measureText(this.messages.subscribedBadge).width + paddingX * 2
    drawPill(ctx, this.messages.subscribedBadge, right - width, top, {
      font: font(size, true),
      color: THEME.onAccent,
      background: THEME.accent,
      height,
      paddingX,
    })
  }

  /** 批量加载本次绘制用到的封面；`limit` 为 0 时表示不限制 */
  private async loadCovers(items: DigestItem[], limit = this.config.output.coverLimit): Promise<Map<string, Canvas | null>> {
    if (!this.config.output.showCover) return new Map()
    return this.covers.load(items, limit)
  }

  /** 没有条目时的兜底：只画页眉与一行空提示，避免出现 NaN 高度的画布 */
  private drawEmpty(payload: RenderPayload): Canvas {
    const L = IMAGE_LAYOUT
    const width = this.canvasWidth(payload)
    const height = L.headerHeight + 140 + L.footerHeight
    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)
    ctx.font = font(FONT_SIZE.cardTime)
    ctx.fillStyle = THEME.muted
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(fitText(ctx, payload.summary || this.messages.emptyDaily, width - L.padding * 2), L.padding, L.headerHeight + 40)
    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  /** 选画布宽度：各版面在常量里各有固定宽度，保证同一版面每次出图尺寸一致 */
  private canvasWidth(payload: RenderPayload): number {
    const L = IMAGE_LAYOUT
    if (payload.kind === 'season' && this.config.output.layout !== 'list') return L.seasonWidth
    if (payload.kind === 'weekly') return L.weekWidth
    if (this.config.output.layout === 'list') return L.listWidth
    return L.timelineWidth
  }

  // #endregion

  // #region 单日时间轴

  /**
   * 单日时间轴：左侧一条竖直轨道，右侧行卡片按播出时刻自上而下排列。
   *
   * 深夜档覆盖「今晚 + 次日凌晨」，凌晨场次用 24 小时制续写（次日 01:00 记作 25:00），
   * 跨过午夜时在轨道上插一个日期节点，读者不会把凌晨场次误认成当天上午。
   */
  private async drawTimeline(payload: RenderPayload): Promise<Canvas> {
    const L = IMAGE_LAYOUT
    const night = payload.kind === 'night'
    const groups = payload.groups.filter((group) => group.items.length > 0)
    const all = groups.flatMap((group) => group.items)
    if (!all.length) return this.drawEmpty(payload)

    const covers = await this.loadCovers(all)
    const width = L.timelineWidth
    // 只有一组时不画日期节点，高度按实际结构计算
    const showDayHeader = groups.length > 1
    const height = L.headerHeight
      + all.length * (L.rowHeight + L.rowGap)
      + (showDayHeader ? groups.length * L.timelineDayHeaderHeight : 0)
      + L.footerHeight

    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)

    const spineX = L.padding + L.timelineSpine
    let cursor = L.headerHeight + L.rowGap
    let index = 0

    for (const group of groups) {
      if (showDayHeader) {
        this.drawTimelineDayHeader(ctx, group, spineX, cursor, width - L.padding - spineX)
        cursor += L.timelineDayHeaderHeight
      }
      for (const item of group.items) {
        const y = cursor
        this.drawTimelineSpine(ctx, spineX, y - L.rowGap, y + L.rowHeight, index === 0)
        this.drawTimelineEntry(ctx, item, covers.get(item.coverUrl) ?? null, spineX, y, width, night)
        cursor += L.rowHeight + L.rowGap
        index++
      }
    }

    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  /** 时间轴上的日期节点：圆点 + 日期 + 条目数 */
  private drawTimelineDayHeader(
    ctx: SKRSContext2D,
    group: DigestGroup,
    spineX: number,
    y: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    const centreY = y + L.timelineDayHeaderHeight / 2

    ctx.beginPath()
    ctx.arc(spineX, centreY, L.timelineDot + 2, 0, Math.PI * 2)
    ctx.fillStyle = THEME.accent
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(FONT_SIZE.dayHeader, true)
    ctx.fillStyle = THEME.title
    ctx.fillText(fitText(ctx, group.label, width - 90), spineX + L.mediaGap + 6, centreY)

    ctx.font = font(FONT_SIZE.cardMeta)
    ctx.fillStyle = THEME.muted
    ctx.textAlign = 'right'
    ctx.fillText(`${group.items.length}${this.messages.countUnit}`, spineX + width, centreY)
    ctx.textAlign = 'left'
  }

  /** 时间轴主线，首条之上不画线 */
  private drawTimelineSpine(ctx: SKRSContext2D, x: number, from: number, to: number, first: boolean): void {
    ctx.strokeStyle = IMAGE_LAYOUT.timelineLine
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, first ? (from + to) / 2 : from)
    ctx.lineTo(x, to)
    ctx.stroke()
  }

  /** 时间轴上的单个条目：时刻 + 圆点 + 封面 + 标题 + 评分 / ID / 集数 */
  private drawTimelineEntry(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    spineX: number,
    y: number,
    canvasWidth: number,
    night: boolean,
  ): void {
    const L = IMAGE_LAYOUT
    const centreY = y + L.rowHeight / 2
    const cardLeft = spineX + L.timelineTimeGap + L.timelineCardGap
    const cardWidth = canvasWidth - L.padding - cardLeft
    const lines = this.cardLines(item, false)

    drawCard(ctx, cardLeft, y, cardWidth, L.rowHeight, L.rowRadius, { shadow: true })

    // 时刻：贴在轨道左侧右对齐，与卡片中线对齐
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.font = font(FONT_SIZE.cardTime, true)
    ctx.fillStyle = THEME.accent
    ctx.fillText(this.displayTime(item, night), spineX - L.timelineTimeGap, centreY)

    ctx.beginPath()
    ctx.arc(spineX, centreY, L.timelineDot, 0, Math.PI * 2)
    ctx.fillStyle = THEME.accent
    ctx.fill()

    this.drawCardBody(ctx, item, cover, cardLeft + L.rowPadding, centreY, cardWidth - L.rowPadding * 2, lines)
    this.drawSubscribedBadge(ctx, item, cardLeft + cardWidth - 8, y + 8, cardWidth)
  }

  /**
   * 条目卡片里的文字行。
   *
   * 顺序固定为：标题 → 时间/集数 → `ID:xxx` → 评分，配色与季表一致
   * （主色加粗 / 强调色 / 弱化色 / 评分色），几个版面因此长得一样。
   *
   * @param showTime 是否显示日期时刻。
   *   **单日时间轴（每日 / 深夜档）传 `false`**：左侧轨道已经把时刻写在卡片旁边了，
   *   卡片里再写一遍是重复信息；那个位置改放集数，读者一眼就知道今晚是第几话。
   *   列表排版没有轨道，日期与时刻都有用，因此保持原样。
   */
  private cardLines(item: DigestItem, showTime = true): CardLine[] {
    const lines: CardLine[] = [
      { text: item.name, color: THEME.title, size: FONT_SIZE.cardTitle, bold: true },
      // 单日时间轴把时刻画在卡片左侧的轨道上，卡片里不再重复
      ...(showTime ? [{ text: item.airLabel, color: THEME.accent, size: FONT_SIZE.cardMeta }] : []),
      { text: this.episodeText(item), color: THEME.accent, size: FONT_SIZE.cardMeta },
      { text: this.idText(item), color: THEME.muted, size: FONT_SIZE.cardMeta },
      { text: this.scoreText(item), color: THEME.score, size: FONT_SIZE.cardMeta, bold: true },
    ]
    return lines.filter((line) => line.text)
  }

  /**
   * 集数文本，例如 `第 5 话`。
   *
   * 首播（第 1 话）**也照常显示**：新番开播是读者最关心的信息之一。
   *
   * 只有两类不显示：
   * - **一次性放送**（`recurring === false`：剧场版、特别篇、整季一次放出）——它们没有
   *   「第几话」的概念，`episodeCount` 恒为 1，写出来是噪声；
   * - 集数未知（`episodeCount <= 0`）。
   */
  private episodeText(item: DigestItem): string {
    if (!item.recurring) return ''
    if (!item.episodeCount || item.episodeCount <= 0) return ''
    return this.messages.episodeUnit(item.episodeCount)
  }

  /** 时间轴上显示的时刻：深夜档把次日凌晨写成 24 小时制续写 */
  private displayTime(item: DigestItem, night: boolean): string {
    if (!night) return item.time
    const hour = Number(item.time.slice(0, 2))
    if (hour >= LATE_NIGHT_END_HOUR) return item.time
    return `${String(hour + 24).padStart(2, '0')}:${item.time.slice(3)}`
  }

  // #endregion

  // #region 七日周历

  /** 七日周历：一张卡里并排七天，列间用竖直分隔线，一屏看完一周 */
  private async drawWeekGrid(payload: RenderPayload): Promise<Canvas> {
    const L = IMAGE_LAYOUT
    const groups = payload.groups.filter((group) => group.items.length > 0)
    const covers = await this.loadCovers(this.coverDrawOrder(groups) ?? groups.flatMap((group) => group.items))

    const columns = Math.max(1, groups.length)
    const width = L.weekWidth
    const contentWidth = width - L.padding * 2 - L.weekCardPadding * 2
    const columnWidth = Math.floor((contentWidth - L.weekColumnGap * (columns - 1)) / columns)
    const rows = Math.max(...groups.map((group) => group.items.length), 1)
    const cardTop = L.headerHeight
    const cardHeight = L.weekHeaderHeight + rows * (L.weekRowHeight + L.weekRowGap) + L.weekCardPadding
    const height = cardTop + cardHeight + L.footerHeight

    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)
    drawCard(ctx, L.padding, cardTop, width - L.padding * 2, cardHeight, 18, { shadow: true })

    const left = L.padding + L.weekCardPadding
    groups.forEach((group, index) => {
      const x = left + index * (columnWidth + L.weekColumnGap)
      this.drawWeekDay(ctx, group, x, cardTop, columnWidth, covers)
      if (index > 0) {
        const dividerX = x - L.weekColumnGap / 2
        ctx.strokeStyle = THEME.divider
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(dividerX, cardTop + 18)
        ctx.lineTo(dividerX, cardTop + cardHeight - 18)
        ctx.stroke()
      }
    })

    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  /** 周历表的一个日期列：列头（日期 + 星期 + 条目数）与下面的条目 */
  private drawWeekDay(
    ctx: SKRSContext2D,
    group: DigestGroup,
    x: number,
    top: number,
    width: number,
    covers: Map<string, Canvas | null>,
  ): void {
    const L = IMAGE_LAYOUT
    const today = !!group.isToday
    const headerY = top + 34

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(FONT_SIZE.cardTime, true)
    ctx.fillStyle = today ? THEME.accent : THEME.title
    const headline = this.dayHeadline(group)
    ctx.fillText(fitText(ctx, headline, width - 40), x, headerY)

    ctx.font = font(FONT_SIZE.itemMeta)
    ctx.fillStyle = THEME.muted
    ctx.textAlign = 'right'
    ctx.fillText(`${group.items.length}${this.messages.countUnit}`, x + width - 4, headerY)
    ctx.textAlign = 'left'

    ctx.strokeStyle = today ? THEME.accent : THEME.divider
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, headerY + 20)
    ctx.lineTo(x + width - 4, headerY + 20)
    ctx.stroke()

    const startY = top + L.weekHeaderHeight
    const rowWidth = width - 6
    group.items.forEach((item, index) => {
      this.drawWeekEntry(
        ctx,
        item,
        covers.get(item.coverUrl) ?? null,
        x,
        startY + index * (L.weekRowHeight + L.weekRowGap),
        rowWidth,
      )
    })
  }

  /**
   * 周历表条目：底色块 + 小封面 + 三行文字。
   *
   * 每格只有约 200px 宽（并排七天），因此：
   * - 文字行占满整行宽度，不做右侧预留；
   * - 第一行是时刻 +「已订阅」气泡，第二、三行是标题（最多两行），末行是 `ID:xxx`；
   * - **不显示评分**，给封面和标题留出空间。
   */
  private drawWeekEntry(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    x: number,
    y: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    const centreY = y + L.weekRowHeight / 2

    fillRoundRect(ctx, x, y, width, L.weekRowHeight, 10, THEME.background)

    const showCover = this.config.output.showCover
    const mediaHeight = L.weekMediaHeight
    const mediaWidth = Math.round(mediaHeight * L.seasonCoverRatio)
    const mediaX = x + 8
    if (showCover) {
      const mediaY = centreY - mediaHeight / 2
      if (cover) drawContainImage(ctx, cover, mediaX, mediaY, mediaWidth, mediaHeight, { radius: 5 })
      else drawCoverPlaceholder(ctx, item.name, mediaX, mediaY, mediaWidth, mediaHeight, 5)
    }

    const textX = showCover ? mediaX + mediaWidth + 8 : x + 10
    const maxWidth = Math.max(30, x + width - 8 - textX)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // 第一行：时刻 + 集数 + 气泡（气泡与它们同行，不占标题的宽度）
    //
    // 周历每格只有约 200px 宽，放不下「日期」——日期就是列头，因此这里只写时刻。
    // 集数紧跟在时刻后面，读者一眼看到「几点、第几话」。
    let cursor = textX
    ctx.font = font(FONT_SIZE.weekTime, true)
    ctx.fillStyle = THEME.accent
    ctx.fillText(item.time, cursor, y + 18)
    const episode = this.episodeText(item)
    if (episode) {
      cursor += ctx.measureText(item.time).width + 8
      ctx.font = font(FONT_SIZE.weekTime)
      ctx.fillText(fitText(ctx, episode, Math.max(20, x + width - 8 - cursor)), cursor, y + 18)
      cursor += ctx.measureText(episode).width + 7
    } else {
      cursor += ctx.measureText(item.time).width + 7
    }
    // 第二行起：标题（最多两行）
    ctx.font = font(FONT_SIZE.weekTitle, true)
    ctx.fillStyle = THEME.title
    const lines = this.wrapText(ctx, item.name, maxWidth, L.weekTitleLines)
    let titleY = y + 44
    for (let index = 0; index < L.weekTitleLines; index++) {
      if (lines[index]) ctx.fillText(lines[index], textX, titleY)
      titleY += L.weekTitleLineHeight
    }

    // 末行：条目 ID
    const id = this.idText(item)
    if (id) {
      ctx.font = font(FONT_SIZE.itemMeta)
      ctx.fillStyle = THEME.muted
      ctx.fillText(fitText(ctx, id, maxWidth), textX, titleY + 1)
    }

    // 气泡最后画，贴在**右下角**：顶部只有一条「时刻 + 集数」的窄行，气泡挤在同一行会把
    // 集数挤掉；右下角既不挡文字，也不与封面争空间。
    this.drawSubscribedBadge(ctx, item, x + width - 8, y + L.weekRowHeight - 8, width, true)
  }

  // #endregion

  // #region 卡片列表

  /** 卡片列表：逐条铺开的长图，条目多时折成两栏 */
  private async drawList(payload: RenderPayload): Promise<Canvas> {
    const L = IMAGE_LAYOUT
    const flat: { item: DigestItem; label: string; first: boolean }[] = []
    for (const group of payload.groups) {
      group.items.forEach((item, index) => flat.push({ item, label: group.label, first: index === 0 }))
    }
    const drawable = flat.slice(0, IMAGE_MAX_CARDS)
    const covers = await this.loadCovers(drawable.map((entry) => entry.item))
    const width = this.canvasWidth(payload)

    // 条目较多时折成两栏，否则长图会被平台压得看不清
    const columns = drawable.length > IMAGE_LIST_TWO_COLUMN_AT ? 2 : 1
    const rows: { header: string; entries: typeof drawable }[] = []
    let cursor = 0
    while (cursor < drawable.length) {
      const slice = drawable.slice(cursor, cursor + columns)
      rows.push({ header: slice[0]?.first ? slice[0].label : '', entries: slice })
      cursor += columns
    }

    const height = L.headerHeight
      + rows.reduce((sum, row) => sum + (row.header ? L.sectionHeaderHeight : 0) + L.cardHeight + L.cardGap, 0)
      + L.footerHeight
      + L.rowGap

    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)

    const cardWidth = Math.floor((width - L.padding * 2 - L.cardColumnGap * (columns - 1)) / columns)
    let y = L.headerHeight + L.rowGap
    for (const row of rows) {
      if (row.header) {
        this.drawSectionHeader(ctx, row.header, y, width)
        y += L.sectionHeaderHeight
      }
      row.entries.forEach((entry, index) => {
        const x = L.padding + index * (cardWidth + L.cardColumnGap)
        this.drawListCard(ctx, entry.item, covers.get(entry.item.coverUrl) ?? null, x, y, cardWidth)
      })
      y += L.cardHeight + L.cardGap
    }

    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  /** 列表排版的分组标题：左对齐标题 + 一条延伸到右边的细线 */
  private drawSectionHeader(ctx: SKRSContext2D, label: string, y: number, width: number): void {
    const L = IMAGE_LAYOUT
    const baseline = y + L.sectionHeaderHeight / 2 + 2
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(FONT_SIZE.sectionTitle, true)
    ctx.fillStyle = THEME.title
    const text = fitText(ctx, label, width - L.padding * 4)
    ctx.fillText(text, L.padding, baseline)

    ctx.strokeStyle = THEME.divider
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(L.padding + ctx.measureText(text).width + 12, baseline)
    ctx.lineTo(width - L.padding, baseline)
    ctx.stroke()
  }

  /** 列表卡片：与时间轴条目同一套排版 */
  private drawListCard(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    x: number,
    y: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    const centreY = y + L.cardHeight / 2
    drawCard(ctx, x, y, width, L.cardHeight, L.rowRadius, { shadow: true })
    this.drawCardBody(ctx, item, cover, x + L.rowPadding, centreY, width - L.rowPadding * 2, this.cardLines(item))
    this.drawSubscribedBadge(ctx, item, x + width - 8, y + 8, width)
  }

  // #endregion

  // #region 本季封面网格

  /**
   * 本季封面网格：每行 10 部，一季一百多部也就十来行。
   *
   * 卡片高度固定，标题固定占两行、评分与首播/下一场都放在固定位置，
   * 因此整片网格横向与纵向都对齐。
   */
  private async drawSeason(payload: RenderPayload): Promise<Canvas> {
    const L = IMAGE_LAYOUT
    const items = payload.groups.flatMap((group) => group.items)
    const covers = await this.loadCovers(items)

    const columns = L.seasonColumns
    const width = L.seasonWidth
    const cardWidth = Math.floor(
      (width - L.padding * 2 - L.seasonColumnGap * (columns - 1)) / columns,
    )
    const rows = Math.ceil(items.length / columns)
    const gridHeight = rows > 0 ? rows * L.seasonCardHeight + (rows - 1) * L.seasonRowGap : 0
    const height = L.headerHeight + gridHeight + L.footerHeight + L.rowGap

    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)

    items.forEach((item, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const x = L.padding + column * (cardWidth + L.seasonColumnGap)
      const y = L.headerHeight + row * (L.seasonCardHeight + L.seasonRowGap)
      this.drawSeasonCard(ctx, item, covers.get(item.coverUrl) ?? null, x, y, cardWidth)
    })

    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  private drawSeasonCard(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    x: number,
    y: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    drawCard(ctx, x, y, width, L.seasonCardHeight, L.rowRadius, { shadow: true })

    const inner = L.seasonPadding
    const coverWidth = width - inner * 2
    const coverHeight = Math.round(coverWidth / L.seasonCoverRatio)
    // 封面在卡片内水平居中，标题与评分再与封面中线对齐
    const centreX = x + width / 2
    const coverX = centreX - coverWidth / 2
    const coverY = y + inner
    if (cover) {
      // 等比完整显示，不裁切原图
      drawContainImage(ctx, cover, coverX, coverY, coverWidth, coverHeight, { radius: 6 })
    } else {
      drawCoverPlaceholder(ctx, item.name, coverX, coverY, coverWidth, coverHeight, 6)
    }

    const textWidth = coverWidth
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // 标题固定两行占位，长短标题的后续行因此落在同一基线上
    ctx.font = font(FONT_SIZE.gridTitle, true)
    ctx.fillStyle = THEME.title
    const lines = this.wrapText(ctx, item.name, textWidth, L.seasonTitleLines)
    let cursor = coverY + coverHeight + L.seasonTitleLineHeight / 2 + 2
    for (let index = 0; index < L.seasonTitleLines; index++) {
      if (lines[index]) ctx.fillText(lines[index], centreX, cursor)
      cursor += L.seasonTitleLineHeight
    }
    cursor += 1

    // 首播时间：概览里读者最关心「什么时候开播」，用强调色
    if (item.airLabel) {
      ctx.font = font(FONT_SIZE.gridMeta)
      ctx.fillStyle = THEME.accent
      ctx.fillText(fitText(ctx, item.airLabel, textWidth), centreX, cursor + L.gridMetaLineHeight / 2)
    }
    cursor += L.gridMetaLineHeight

    // Bangumi 条目 ID：与 `anime.sub <ID>` 的参数写法一致
    const id = this.idText(item)
    if (id) {
      ctx.font = font(FONT_SIZE.gridMeta)
      ctx.fillStyle = THEME.muted
      ctx.fillText(id, centreX, cursor + L.gridMetaLineHeight / 2)
    }
    cursor += L.gridMetaLineHeight

    // 评分放最下一行
    const score = this.scoreText(item)
    if (score) {
      ctx.fillStyle = THEME.score
      ctx.font = font(FONT_SIZE.gridMeta + 1, true)
      ctx.fillText(score, centreX, cursor + L.gridMetaLineHeight / 2)
    }

    ctx.textAlign = 'left'
    this.drawSubscribedBadge(ctx, item, x + width - 6, y + 6, width)
  }

  /**
   * 按像素宽度把标题折成最多 `maxLines` 行，放不下时在最后一行补省略号。
   * 中文没有词边界，按字符逐个累加即可。
   */
  private wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
    const value = (text ?? '').trim()
    if (!value || maxWidth <= 0 || maxLines < 1) return []
    if (ctx.measureText(value).width <= maxWidth) return [value]

    const lines: string[] = []
    let cursor = 0
    while (cursor < value.length && lines.length < maxLines) {
      const isLast = lines.length === maxLines - 1
      // 最后一行要留出省略号的位置
      const budget = isLast ? maxWidth - ctx.measureText('…').width : maxWidth
      let line = ''
      while (cursor < value.length) {
        const next = line + value[cursor]
        if (line && ctx.measureText(next).width > budget) break
        line = next
        cursor++
      }
      lines.push(line)
    }

    if (cursor < value.length && lines.length) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}…`
    }
    return lines
  }

  // #endregion

  // #region 页眉与页脚

  /**
   * 页眉：所有版面共用。
   *
   * 左侧强调条 + 标题（第一行）、副标题（第二行），右上角是统计行与时区，
   * 底部一条分隔线。窄版面（单日时间轴与列表）的右上角放不下两行，就把统计行
   * 挪到副标题后面，时区单独占第三行，位置依旧固定。
   *
   * **数据来源只在页脚出现一次**，页眉这里只写时区。
   */
  private drawHeader(ctx: SKRSContext2D, payload: RenderPayload, width: number): void {
    const L = IMAGE_LAYOUT
    const left = L.padding
    const top = 22
    const narrow = width < 1200
    const textLeft = left + 20

    fillRoundRect(ctx, left, top + 2, 6, 34, 3, THEME.accent)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = THEME.title
    ctx.font = font(FONT_SIZE.title, true)
    const titleWidth = narrow ? width - textLeft - L.padding : width - textLeft - 320
    ctx.fillText(fitText(ctx, payload.header, titleWidth), textLeft, top + 19)

    // 标题本身通常已经带了日期，副标题只在季表这类需要补充区间的版面才出现
    const subtitle = payload.rangeLabel || payload.seasonLabel || ''
    ctx.fillStyle = THEME.body
    ctx.font = font(FONT_SIZE.subtitle)
    const subtitleWidth = narrow ? width - textLeft - L.padding : 640
    if (subtitle) ctx.fillText(fitText(ctx, subtitle, subtitleWidth), textLeft, top + 48)

    const notice = this.timeZoneNotice()
    if (narrow) {
      ctx.fillStyle = THEME.muted
      ctx.font = font(FONT_SIZE.itemMeta)
      const line = payload.summary ? `${payload.summary} · ${notice}` : notice
      ctx.fillText(fitText(ctx, line, width - textLeft - L.padding), textLeft, top + 74)
    } else {
      ctx.textAlign = 'right'
      ctx.fillStyle = THEME.body
      ctx.font = font(FONT_SIZE.subtitle)
      ctx.fillText(fitText(ctx, payload.summary, 520), width - left, top + 18)
      ctx.fillStyle = THEME.muted
      ctx.font = font(FONT_SIZE.itemMeta)
      ctx.fillText(fitText(ctx, notice, 520), width - left, top + 44)
      ctx.textAlign = 'left'
    }

    ctx.strokeStyle = THEME.divider
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(left, L.headerHeight - 10)
    ctx.lineTo(width - left, L.headerHeight - 10)
    ctx.stroke()
  }

  private drawFooter(ctx: SKRSContext2D, payload: RenderPayload, width: number, height: number): void {
    const L = IMAGE_LAYOUT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = THEME.muted
    ctx.font = font(FONT_SIZE.footer)
    ctx.fillText(fitText(ctx, payload.footer, width - L.padding * 2), L.padding, height - L.footerHeight / 2 - 4)
  }

  /**
   * 页眉右上角的一行小字：标明时刻所用的时区。
   * bangumi-data 的周期时刻是 UTC，写明时区可以避免读者把时刻误读成日本时间。
   * 数据来源由页脚统一给出，这里不再重复。
   */
  private timeZoneNotice(): string {
    const hours = getTimeZoneOffsetMs(Date.now(), this.config.timeZone) / 3600000
    const offset = hours >= 0 ? `+${hours}` : `${hours}`
    return `时刻为 ${this.config.timeZone} (UTC${offset})`
  }

  /**
   * 周历表要按列分配封面额度。
   *
   * 设了 `coverLimit` 上限时，如果直接按顺序截断，前两天的额度就会用光、
   * 后面几天的封面整片缺失。因此按列均分。
   *
   * 返回 `null` 表示**不限制**（加载本次绘制用到的全部封面）。
   */
  private coverDrawOrder(groups: DigestGroup[]): DigestItem[] | null {
    if (!this.config.output.showCover) return []
    const limit = this.config.output.coverLimit
    const all = groups.flatMap((group) => group.items).filter((item) => !!item.coverUrl)
    if (limit <= 0) return null
    if (groups.length <= 1) return all
    const perColumn = Math.max(1, Math.floor(limit / groups.length))
    const ordered: DigestItem[] = []
    for (const group of groups) {
      ordered.push(...group.items.filter((item) => !!item.coverUrl).slice(0, perColumn))
    }
    return ordered
  }

  /** 周历表列头的日期，例如 `9/23 周三` */
  private dayHeadline(group: DigestGroup): string {
    const date = group.date ? this.formatDateLabel(group.date) : ''
    const weekday = this.messages.weekdayNames[group.weekday ?? 0] ?? ''
    return [date, weekday].filter(Boolean).join(' ')
  }

  /** 把 `YYYY-MM-DD` 格式化为 `M/D` */
  private formatDateLabel(date: string | undefined): string {
    if (!date) return ''
    const parts = date.split('-')
    if (parts.length < 3) return ''
    return `${Number(parts[1])}/${Number(parts[2])}`
  }

  // #endregion
}
