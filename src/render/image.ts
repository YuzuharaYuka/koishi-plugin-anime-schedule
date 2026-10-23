import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { HttpClient } from '../services/network'
import type { Context, Logger } from 'koishi'
import { IMAGE_LIST_TWO_COLUMN_AT, IMAGE_LAYOUT, IMAGE_MAX_CARDS, LATE_NIGHT_END_HOUR, getMessages } from '../constants'
import type { Messages } from '../constants'
import type { Config } from '../config'
import type { Digest, DigestGroup, DigestItem, RenderPayload } from '../types'
import { font, FONT_SIZE, registerFonts } from './fonts'
import { CoverStore } from './covers'
import { formatClock, formatMoment, getTimeZoneOffsetMs } from '../utils/time'
import type { SubjectInfo } from '../services/info'
import { renderInfoCard } from './info'
import {
  drawCard,
  drawContainImage,
  drawCoverPlaceholder,
  drawPill,
  fillRoundRect,
  fitText,
  THEME,
} from './canvas'


/** 「现在」分界线占用的高度，与 drawNowMarker 保持一致 */
const NOW_MARKER_HEIGHT = 26

/**
 * encode 之后立刻释放画布的原生表面。
 *
 * 画布是 JS 对象，像素缓冲在 Skia 里；仅仅让它变成垃圾并不会马上归还内存，进程会一直占着
 * 那个高水位。周表在 3 倍超采样下是 5040×10920，一块就是 220MB——实测不释放时常驻 870MB，
 * 释放后 415MB，且反复出图不再增长。给 `width` 赋值会重建表面，置成 1×1 即等价于归还。
 */
function releaseSurface(canvas: Canvas): void {
  canvas.width = 1
  canvas.height = 1
}

/**
 * 把一次构建结果转成渲染输入。
 *
 * 推送（`index.ts`）、指令（`handlers.ts`）与基准脚本都走这里，避免同一组字段写三遍——
 * 之前基准脚本就因为漏了 `now` 直接抛 `RangeError`，而 `as never` 让类型检查也发现不了。
 */
export function toRenderPayload(digest: Digest, messages: Messages): RenderPayload {
  return {
    kind: digest.kind,
    // 用构建时刻而非渲染时刻：「现在」分界线与列表内容自洽，同一份数据反复出图不漂移
    now: digest.generatedAt,
    header: digest.header,
    summary: digest.summary,
    groups: digest.groups,
    seasonLabel: digest.seasonLabel,
    rangeLabel: digest.rangeLabel ?? '',
    footer: messages.footer,
  }
}

/**
 * 风格化图片渲染器。四种版面共用页眉（标题 + 副标题 + 统计 + 时区）与页脚（数据来源），
 * 卡片文字顺序与配色统一为「标题 → 时间 → `ID:xxx` → 评分」。
 * 封面统一按 `1 : 1.4` 等比完整显示，文字块的竖直位置只由版式常量决定，故同一版面基线一致。
 */
export class Renderer {
  private readonly covers: CoverStore
  private ready = false
  /**
   * 超采样倍数。画布按「逻辑尺寸 × 该值」建立并在上下文上等比 `scale`，各版面坐标
   * 无需改动；文字按更高像素密度栅格化，缩回目标尺寸后笔画更锐利。
   */
  private readonly scale: number

  constructor(
    ctx: Context,
    private config: Config,
    private logger: Logger,
    /** 出网客户端（含代理），用于下载封面 */
    http: HttpClient,
  ) {
    this.scale = Math.max(1, config.render.supersample)
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
      '[render] %s 出图完成 (%dms)，尺寸 %dx%d (超采样 %dx)，%d bytes (jpeg q=%d)',
      payload.kind,
      Date.now() - started,
      canvas.width,
      canvas.height,
      encoded.length,
      this.config.render.jpegQuality,
    )
    releaseSurface(canvas)
    return encoded
  }

  /**
   * 渲染单部作品的详情卡（`anime.info`）：与推送表共用封面缓存与字体，但排版完全独立
   * （见 `render/info.ts`），封面单独取一张、不复用推送表的批量加载。
   */
  async renderInfo(info: SubjectInfo): Promise<Buffer> {
    this.init()
    const started = Date.now()
    const covers = await this.covers.load([info], 1)
    const cover = covers.get(info.coverUrl) ?? null
    const card = renderInfoCard({
      info,
      messages: this.messages,
      cover,
      footer: this.messages.infoUpdated(formatMoment(Date.now(), this.config.timeZone, this.messages.weekdayNames)),
    })
    const { canvas, ctx } = this.createSurface(card.width, card.height)
    card.draw(ctx)
    const encoded = await canvas.encode('jpeg', this.config.render.jpegQuality)
    this.logger.debug(
      '[render] info 出图完成 (%dms)，尺寸 %dx%d，%d bytes',
      Date.now() - started, card.width, card.height, encoded.length,
    )
    releaseSurface(canvas)
    return encoded
  }

  private async draw(payload: RenderPayload): Promise<Canvas> {
    if (payload.kind === 'season' && this.config.output.layout !== 'list') return this.drawSeason(payload)
    if (this.config.output.layout === 'list') return this.drawList(payload)
    if (payload.kind === 'weekly') return this.drawWeekGrid(payload)
    return this.drawTimeline(payload)
  }

  // #region 通用绘制

  /**
   * 空白画布：统一底色，并按超采样倍数放大物理尺寸。
   *
   * `width` / `height` 仍是逻辑尺寸，各版面照旧用逻辑坐标排版，由 `ctx.scale` 映射到实际像素。
   */
  private createSurface(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
    const s = this.scale
    const canvas = createCanvas(Math.round(width * s), Math.round(height * s))
    const ctx = canvas.getContext('2d')
    if (s !== 1) ctx.scale(s, s)
    ctx.fillStyle = THEME.background
    ctx.fillRect(0, 0, width, height)
    return { canvas, ctx }
  }

  /** 评分文本，未开启评分展示时为空 */
  private scoreText(item: DigestItem): string {
    if (!this.config.output.showScore || !item.score) return ''
    return item.score
  }

  /** `ID:400602`，与 `anime.sub <ID>` 的参数写法一致 */
  private idText(item: DigestItem): string {
    return item.bgmId === null ? '' : `ID:${item.bgmId}`
  }

  /**
   * 条目的「已订阅」气泡，各版面共用。调用方给的是**气泡右边缘**，气泡向左展开，
   * 不会盖住右侧的 ID 或标题；`bottom` 为 `true` 时 `y` 视为底边，用于贴在卡片右下角。
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
    // 列表排版优先：它的画布宽度只由版式决定，与表种无关（weekly + list 也走 900）
    if (this.config.output.layout === 'list') return L.listWidth
    if (payload.kind === 'weekly') return L.weekWidth
    return L.timelineWidth
  }

  // #endregion

  // #region 单日时间轴

  /**
   * 单日时间轴：左侧一条竖直轨道，右侧行卡片按播出时刻自上而下排列。
   * 深夜档覆盖「今晚 + 次日凌晨」，凌晨场次用 24 小时制续写（次日 01:00 记作 25:00）。
   */
  private async drawTimeline(payload: RenderPayload): Promise<Canvas> {
    const L = IMAGE_LAYOUT
    const night = payload.kind === 'night'
    const groups = payload.groups.filter((group) => group.items.length > 0)
    const all = groups.flatMap((group) => group.items)
    if (!all.length) return this.drawEmpty(payload)

    const covers = await this.loadCovers(all)
    const width = L.timelineWidth
    // 只有一组时不画日期节点
    const showDayHeader = groups.length > 1
    const spineX = L.padding + L.timelineLabelWidth

    // 先排出各元素的中线：主轴连线、圆点与「现在」标记都以它定位，必须算完再画
    type Element =
      | { kind: 'day'; group: DigestGroup; centre: number }
      | { kind: 'item'; item: DigestItem; centre: number }
      | { kind: 'now'; centre: number }

    const elements: Element[] = []
    const dayGap = showDayHeader ? L.timelineDayHeaderHeight : 0
    const separatorGap = L.rowGap * 3
    let cursor = L.headerHeight + L.rowGap
    let nowPlaced = false

    for (const group of groups) {
      if (showDayHeader) {
        elements.push({ kind: 'day', group, centre: cursor + L.timelineDayHeaderHeight / 2 })
        cursor += dayGap
      }
      for (const item of group.items) {
        // 「现在」插在第一条未播出的条目之前
        if (!nowPlaced && item.atMs > payload.now) {
          nowPlaced = true
          elements.push({ kind: 'now', centre: cursor + NOW_MARKER_HEIGHT / 2 })
          cursor += NOW_MARKER_HEIGHT + separatorGap
        }
        elements.push({ kind: 'item', item, centre: cursor + L.rowHeight / 2 })
        cursor += L.rowHeight + L.rowGap
      }
    }
    // 全部已播时「现在」落在末尾，与末条留出间距
    if (!nowPlaced) {
      cursor += separatorGap
      elements.push({ kind: 'now', centre: cursor + NOW_MARKER_HEIGHT / 2 })
      cursor += NOW_MARKER_HEIGHT
    }

    const height = cursor + L.footerHeight
    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)

    // 主轴：首尾元素中心之间连续绘制，中途不断开
    const centres = elements.map((element) => element.centre)
    const first = centres[0] ?? 0
    const last = centres[centres.length - 1] ?? first
    ctx.strokeStyle = L.timelineLine
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(spineX, first)
    ctx.lineTo(spineX, last)
    ctx.stroke()

    // 主轴之上绘制各元素（圆点覆盖主轴）
    for (const element of elements) {
      if (element.kind === 'day') {
        this.drawTimelineDayHeader(ctx, element.group, spineX, element.centre, width - L.padding - spineX)
      } else if (element.kind === 'now') {
        this.drawNowMarker(ctx, payload.now, spineX, element.centre, width)
      } else {
        this.drawTimelineEntry(
          ctx, element.item, covers.get(element.item.coverUrl) ?? null,
          spineX, element.centre - L.rowHeight / 2, night,
        )
      }
    }

    this.drawFooter(ctx, payload, width, height)
    return canvas
  }

  /**
   * 时间轴上的「现在」分界线。
   *
   * 圆点位于主轴（`x = spineX`），虚线由圆点右侧引至内容区右缘（即卡片右缘）。
   * 时刻无底框，右对齐于主轴左侧，与各条目时刻同列同右边界。
   */
  private drawNowMarker(
    ctx: SKRSContext2D,
    now: number,
    spineX: number,
    centreY: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT

    // 圆点带白色描边，覆盖主轴后仍可辨识为同一轴上的节点
    ctx.beginPath()
    ctx.arc(spineX, centreY, L.timelineDot + 1, 0, Math.PI * 2)
    ctx.fillStyle = THEME.accent
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = THEME.surface
    ctx.stroke()

    // 虚线：圆点右侧至内容区右缘（即卡片右缘）
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = THEME.accent
    ctx.beginPath()
    ctx.moveTo(spineX + 12, centreY)
    ctx.lineTo(width - L.padding, centreY)
    ctx.stroke()
    ctx.restore()

    // 时刻：与条目时刻同右边界（贴主轴左侧），不加底框
    ctx.font = font(FONT_SIZE.cardTime, true)
    ctx.fillStyle = THEME.accent
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(this.messages.nowLabel(formatClock(now, this.config.timeZone)), spineX - L.timelineTimeGap, centreY)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
  }

  /** 时间轴日期节点：圆点 + 日期 + 条目数。`centreY` 由调用方给定，保证落在主轴上 */
  private drawTimelineDayHeader(
    ctx: SKRSContext2D,
    group: DigestGroup,
    spineX: number,
    centreY: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT

    ctx.beginPath()
    ctx.arc(spineX, centreY, L.timelineDot + 2, 0, Math.PI * 2)
    ctx.fillStyle = THEME.accent
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = THEME.surface
    ctx.stroke()

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

  /**
   * 时间轴上的单个条目：时刻 + 圆点 + 卡片。
   *
   * 卡片内部是**两行流式布局**，而不是每个属性各占一行：
   *
   * ```
   * ┌──────┬──────────────────────────────────────────┐
   * │      │ 葬送的芙莉莲                    [已订阅]  │
   * │ 封面 │ 第 3 话 · ID:529935 ·              8.52  │
   * └──────┴──────────────────────────────────────────┘
   * ```
   *
   * 文字区**顶部对齐**（不是垂直居中）：标题首行基线因此在所有卡片上一致，
   * 与有没有评分、集数是否显示都无关。
   */
  private drawTimelineEntry(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    spineX: number,
    y: number,
    night: boolean,
  ): void {
    const L = IMAGE_LAYOUT
    const centreY = y + L.rowHeight / 2
    const cardLeft = spineX + L.timelineTimeGap + L.timelineCardGap
    const cardWidth = L.rowCardWidth

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

    const inner = cardWidth - L.rowPadding * 2
    const mediaHeight = L.mediaHeight
    const mediaWidth = Math.round(mediaHeight * L.seasonCoverRatio)
    const coverTop = y + (L.rowHeight - mediaHeight) / 2

    if (this.config.output.showCover) {
      if (cover) drawContainImage(ctx, cover, cardLeft + L.rowPadding, coverTop, mediaWidth, mediaHeight, { radius: L.mediaRadius })
      else drawCoverPlaceholder(ctx, item.name, cardLeft + L.rowPadding, coverTop, mediaWidth, mediaHeight, L.mediaRadius)
    }

    const textX = this.config.output.showCover ? cardLeft + L.rowPadding + mediaWidth + L.mediaGap : cardLeft + L.rowPadding
    const textRight = cardLeft + L.rowPadding + inner
    this.drawRowCardText(ctx, item, textX, y + L.rowPadding, textRight - textX)
  }

  /**
   * 行卡片的标题与元信息。时间轴与列表排版共用。
   *
   * 行数由是否双语决定，两种情况下标题区都是两行，元信息行位置因此固定：
   *
   * | 样式 | 版位 |
   * | :--- | :--- |
   * | 单语（`localized` / `original`） | 标题占两行、可折行；元信息在第 3 行 |
   * | 双语（`both`） | 中文一行、原名一行，均不折行，超出补省略号；元信息在第 3 行 |
   */
  private drawRowCardText(
    ctx: SKRSContext2D,
    item: DigestItem,
    left: number,
    top: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    const titleRight = left + width
    const badgeWidth = item.subscribed ? this.measure(ctx, this.messages.subscribedBadge, FONT_SIZE.badge, true) + 14 : 0
    // 订阅标记占右上角，标题首行需避让
    const firstLineWidth = width - badgeWidth - (badgeWidth ? 8 : 0)
    const dual = Boolean(item.titleOriginal)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    // ── 标题 ──
    // 字体必须先设：`wrapText` 用当前 `ctx.font` 量宽度，否则会按上一段残留的字号折行
    ctx.font = font(FONT_SIZE.cardTitle, true)
    const titleLines = this.wrapText(ctx, item.name, firstLineWidth, dual ? 1 : L.cardTitleLines)
    ctx.fillStyle = THEME.title
    titleLines.forEach((line, index) => {
      ctx.fillText(line, left, top + index * L.cardTitleLineHeight)
    })

    if (item.subscribed) {
      drawPill(ctx, this.messages.subscribedBadge, titleRight - badgeWidth, top + 1, {
        font: font(FONT_SIZE.badge, true),
        color: THEME.accent,
        background: THEME.accentSoft,
        height: 20,
        paddingX: 7,
      })
    }

    // 双语时原名独占第二行，不与中文标题共用横向空间
    if (dual) {
      ctx.font = font(FONT_SIZE.cardMeta)
      ctx.fillStyle = THEME.muted
      ctx.fillText(fitText(ctx, item.titleOriginal, width), left, top + L.cardTitleLineHeight + 3)
    }

    // 元信息行：集数 → ID → 评分，依次排开，不加底框
    const titleBlockHeight = (dual ? 2 : L.cardTitleLines) * L.cardTitleLineHeight
    const metaTop = top + titleBlockHeight + L.cardLineGap
    const metaCentre = metaTop + 9
    let cursor = left
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    const episode = this.episodeText(item)
    if (episode) {
      ctx.font = font(FONT_SIZE.cardMeta, true)
      ctx.fillStyle = THEME.accent
      ctx.fillText(episode, cursor, metaCentre)
      cursor += ctx.measureText(episode).width + 8
    }
    const id = this.idText(item)
    if (id) {
      ctx.font = font(FONT_SIZE.cardMeta)
      ctx.fillStyle = THEME.muted
      const text = fitText(ctx, id, Math.max(0, titleRight - cursor))
      ctx.fillText(text, cursor, metaCentre)
      cursor += ctx.measureText(text).width + 8
    }
    const score = this.scoreText(item)
    if (score) {
      ctx.font = font(FONT_SIZE.cardMeta, true)
      ctx.fillStyle = THEME.score
      ctx.fillText(score, cursor, metaCentre)
    }

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
  }


  /** 量一段文字的像素宽度（用于给右侧元素让位） */
  private measure(ctx: SKRSContext2D, text: string, size: number, bold = false): number {
    ctx.font = font(size, bold)
    return ctx.measureText(text).width
  }


  /**
   * 集数文本（`第 5 话`）。首播（第 1 话）也照常显示——新番开播是读者最关心的信息之一。
   * 只有两类不显示：一次性放送（`recurring === false`，没有「第几话」的概念）与集数未知（`episodeCount <= 0`）。
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
   * 周历表条目：底色块 + 小封面 + 三行文字。每格只有约 200px 宽（并排七天），因此
   * 文字行占满整行宽度不做右侧预留，第一行是时刻 +「已订阅」气泡，末行是 `ID:xxx`，且不显示评分。
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

    // 第一行：时刻 + 集数 + 气泡（气泡同行，不占标题宽度）。日期就是列头，这里不再重复
    let cursor = textX
    ctx.font = font(FONT_SIZE.weekTime, true)
    ctx.fillStyle = THEME.accent
    ctx.fillText(item.time, cursor, y + 18)
    const episode = this.episodeText(item)
    if (episode) {
      cursor += ctx.measureText(item.time).width + 8
      ctx.font = font(FONT_SIZE.weekTime)
      ctx.fillText(fitText(ctx, episode, Math.max(20, x + width - 8 - cursor)), cursor, y + 18)
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

    // 气泡最后画，贴在**右下角**：顶部那条「时刻 + 集数」的窄行挤不下（会把集数挤掉），
    // 右下角既不挡文字，也不与封面争空间
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
      + rows.reduce((sum, row) => sum + (row.header ? L.sectionHeaderHeight : 0) + L.rowHeight + L.cardGap, 0)
      + L.footerHeight
      + L.rowGap

    const { canvas, ctx } = this.createSurface(width, height)
    this.drawHeader(ctx, payload, width)

    const available = Math.floor((width - L.padding * 2 - L.cardColumnGap * (columns - 1)) / columns)
    const cardWidth = Math.min(L.rowCardWidth, available)
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
      y += L.rowHeight + L.cardGap
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

  /** 列表卡片：与时间轴条目共用同一套两行排版 */
  private drawListCard(
    ctx: SKRSContext2D,
    item: DigestItem,
    cover: Canvas | null,
    x: number,
    y: number,
    width: number,
  ): void {
    const L = IMAGE_LAYOUT
    drawCard(ctx, x, y, width, L.rowHeight, L.rowRadius, { shadow: true })

    const inner = width - L.rowPadding * 2
    const mediaHeight = L.mediaHeight
    const mediaWidth = Math.round(mediaHeight * L.seasonCoverRatio)
    const coverTop = y + (L.rowHeight - mediaHeight) / 2

    if (this.config.output.showCover) {
      if (cover) drawContainImage(ctx, cover, x + L.rowPadding, coverTop, mediaWidth, mediaHeight, { radius: L.mediaRadius })
      else drawCoverPlaceholder(ctx, item.name, x + L.rowPadding, coverTop, mediaWidth, mediaHeight, L.mediaRadius)
    }

    const textX = this.config.output.showCover ? x + L.rowPadding + mediaWidth + L.mediaGap : x + L.rowPadding
    const textRight = x + L.rowPadding + inner
    this.drawRowCardText(ctx, item, textX, y + L.rowPadding, textRight - textX)
  }

  // #endregion

  // #region 本季封面网格

  /**
   * 本季封面网格：每行 10 部。卡片高度固定，标题固定占两行、评分与首播都放在固定位置，
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
   * 页眉：所有版面共用。左侧强调条 + 标题 + 副标题，右上角是统计行与时区，底部一条分隔线。
   * 窄版面（单日时间轴与列表）右上角放不下两行，就把统计行挪到副标题后面、时区单独占第三行。
   * **数据来源只在页脚出现一次**，这里只写时区。
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
   * 页眉右上角的一行小字：标明时刻所用的时区。bangumi-data 的周期时刻是 UTC，
   * 写明时区可避免读者把时刻误读成日本时间；数据来源由页脚统一给出，这里不再重复。
   */
  private timeZoneNotice(): string {
    const hours = getTimeZoneOffsetMs(Date.now(), this.config.timeZone) / 3600000
    const offset = hours >= 0 ? `+${hours}` : `${hours}`
    return `时刻为 ${this.config.timeZone} (UTC${offset})`
  }

  /**
   * 周历表要按列分配封面额度：设了 `coverLimit` 时若直接按顺序截断，前两天的额度就会用光、
   * 后面几天的封面整片缺失，因此按列均分。返回 `null` 表示**不限制**。
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
