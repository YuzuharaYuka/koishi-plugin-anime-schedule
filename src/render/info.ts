import type { SKRSContext2D } from '@napi-rs/canvas'
import { createCanvas } from '@napi-rs/canvas'
import { THEME, drawCard, drawContainImage, drawCoverPlaceholder, drawPill, fillRoundRect, fitText } from './canvas'
import { FONT_SIZE, font } from './fonts'
import type { SubjectInfo } from '../services/info'
import type { Messages } from '../constants'

/**
 * 作品详情卡的排版常量。
 *
 * 与推送表的 `IMAGE_LAYOUT` 分开：那张是「一次列很多部」，这张是「一部讲清楚」，
 * 因此字号更大、留白更多，宽度也窄一些（详情卡不需要横向铺开）。
 */
const L = {
  width: 880,
  padding: 24,
  radius: 18,
  /** 封面：3:4 是动画海报的常见比例，比 1:1 少留白 */
  posterWidth: 196,
  posterRatio: 3 / 4,
  /** 封面与右侧文字之间的间距 */
  gap: 22,
  titleSize: 27,
  originalSize: 14,
  scoreSize: 40,
  chipHeight: 26,
  chipGap: 8,
  chipSize: 12,
  sectionGap: 18,
  sectionTitleSize: 14,
  bodySize: 13.5,
  bodyLineHeight: 22,
  /** 简介最多画多少行，超出截断 */
  summaryLines: 5,
  /** 逐集进度 */
  epCell: 30,
  epGap: 5,
  /** 一格最小宽度，再小数字就挤了 */
  epCellMin: 15,
  /** 话数超过这个值就不铺格子，改为一行文字说明（长期连载番会有几百话） */
  epGridMax: 60,
  /**
   * 底部两栏的基准高度。
   *
   * 逐集方格与评分柱共用这条带：方块从顶部往下排，柱子**从底部往上长**。
   * 早先柱子也从顶部往下长，长柱会顶到方格那一行，看起来像多出来的格子。
   *
   * 方格只排一行时用这个值；话数多到必须两行时按实际高度撑开（见 `renderInfoCard`）。
   */
  bandHeight: 72,
  footerHeight: 30,
} as const

/** 卡片需要的全部素材 */
export interface InfoCard {
  info: SubjectInfo
  messages: Messages
  cover: { width: number; height: number } | null
  /** 页脚的时间戳文案，如 `数据更新于 2026/10/12 20:00` */
  footer: string
}

/**
 * 作品详情卡。
 *
 * ## 布局
 *
 * ```
 * ┌────────┬──────────────────────────────────────┐
 * │        │ 葬送的芙莉莲              [已订阅]    │
 * │ 封面   │ 葬送のフリーレン                      │
 * │        │ ★ 8.52   36553 人评分                │
 * │        │ [TV] [2023/9/29周五] [已完结]         │
 * ├────────┴──────────────────────────────────────┤
 * │ 简介                                          │
 * │ 魔法使芙莉莲和勇者辛美尔……                    │
 * ├───────────────────┬───────────────────────────┤
 * │ 放送进度  28/28   │ 评分分布                  │
 * │ ①②③④⑤⑥…        │         ▂▅▇▆▃             │
 * └───────────────────┴───────────────────────────┘
 * ```
 *
 * 几个刻意的取舍：
 *
 * - **右栏有多少内容算多少**，不钉死高度——卡片整体高度由封面与右栏较高者决定。
 *   参考图那版右栏下方留了一大片空白，是因为把右栏高度也写死了。
 * - **逐集进度用带底色的方格**而不是大圆角按钮：一季 12 话只需一行，半年番 24 话两行，
 *   纵向占用少很多。已播用强调色实心，未播用浅灰。
 * - **评分分布与逐集进度并排**，共用 `bandHeight` 这条基线，省掉一个垂直区块。
 * - 话数超过 `epGridMax`（长期连载番）时**不铺格子**，只给一行 `已播 N 话` 文案，
 *   否则 2852 话会画出上百行。
 */
export function renderInfoCard(card: InfoCard): { width: number; height: number; draw: (ctx: SKRSContext2D) => void } {
  const { info, messages, cover } = card
  const inner = L.width - L.padding * 2
  const posterHeight = Math.round(L.posterWidth / L.posterRatio)
  const textWidth = inner - L.posterWidth - L.gap

  // 卡片高度取决于折行结果，而折行需要 measureText，因此先量一遍再画。
  // 用与成品同宽的临时画布，量出的宽度与实际绘制完全一致。
  const measure = createCanvas(L.width, 10).getContext('2d')
  const titleLines = wrapText(measure, info.name, textWidth, L.titleSize, 2, true)
  const chips = buildChips(info, messages)
  const chipRows = layoutChips(measure, chips, textWidth)
  const summaryLines = info.summary
    ? wrapText(measure, info.summary, inner, L.bodySize, L.summaryLines, false)
    : []
  const hasSummary = summaryLines.length > 0

  // 右栏高度：标题 + 原名 + 评分 + 标签行
  const rightHeight = titleLines.length * (L.titleSize + 6)
    + (info.original ? L.originalSize + 8 : 0)
    + L.scoreSize + 12
    + chipRows.length * (L.chipHeight + L.chipGap)
  const headerHeight = Math.max(posterHeight, rightHeight)

  const summaryHeight = hasSummary
    ? L.sectionGap + L.sectionTitleSize + 10 + summaryLines.length * L.bodyLineHeight
    : 0

  const progressWidth = Math.round((inner - L.gap) * 0.56)
  const scoreWidth = inner - progressWidth - L.gap
  const bandTop = L.padding + headerHeight + summaryHeight + L.sectionGap + L.sectionTitleSize + 10
  const band = bandMetrics(bandTop, info.totalEpisodes, progressWidth, true)
  const height = bandTop + band.height + L.padding + L.footerHeight

  const draw = (ctx: SKRSContext2D): void => {
    ctx.fillStyle = THEME.background
    ctx.fillRect(0, 0, L.width, height)
    drawCard(ctx, L.padding, L.padding, inner, height - L.padding * 2, L.radius, { shadow: true })

    const left = L.padding * 2
    const top = L.padding * 2

    // ── 封面 ──
    if (cover) drawContainImage(ctx, cover, left, top, L.posterWidth, posterHeight, { radius: 12 })
    else drawCoverPlaceholder(ctx, info.name, left, top, L.posterWidth, posterHeight, 12)

    // ── 右栏 ──
    const textLeft = left + L.posterWidth + L.gap
    let cursor = top

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = font(L.titleSize, true)
    ctx.fillStyle = THEME.title
    for (const line of titleLines) {
      ctx.fillText(line, textLeft, cursor)
      cursor += L.titleSize + 6
    }
    // 「已订阅」贴在标题行右侧
    if (info.subscribed) {
      ctx.font = font(L.chipSize, true)
      const width = ctx.measureText(messages.subscribedBadge).width + 18
      drawPill(ctx, messages.subscribedBadge, textLeft + textWidth - width, top - 2, {
        font: font(L.chipSize, true), color: THEME.onAccent, background: THEME.accent, height: 22, paddingX: 9,
      })
    }

    if (info.original) {
      ctx.font = font(L.originalSize)
      ctx.fillStyle = THEME.muted
      ctx.fillText(fitText(ctx, info.original, textWidth), textLeft, cursor)
      cursor += L.originalSize + 8
    }

    // 评分：大号数字 + 人数。票数不足时只给一句占位，不给会误导人的分数
    if (info.score !== null) {
      ctx.font = font(L.scoreSize, true)
      ctx.fillStyle = THEME.score
      ctx.fillText(String(info.score), textLeft, cursor)
      const scoreWidth = ctx.measureText(String(info.score)).width
      ctx.font = font(L.bodySize)
      ctx.fillStyle = THEME.muted
      const votes = info.ratingTotal !== null ? `${info.ratingTotal} ${messages.infoVotes}` : ''
      ctx.fillText(votes, textLeft + scoreWidth + 12, cursor + L.scoreSize - L.bodySize - 3)
    } else {
      ctx.font = font(L.bodySize)
      ctx.fillStyle = THEME.muted
      ctx.fillText(messages.infoNoScore, textLeft, cursor + L.scoreSize - L.bodySize - 6)
    }
    cursor += L.scoreSize + 12

    drawChips(ctx, chipRows, textLeft, cursor)

    // ── 简介 ──
    if (hasSummary) {
      let y = L.padding + headerHeight + L.sectionGap
      drawSectionTitle(ctx, messages.infoSummary, left, y)
      y += L.sectionTitleSize + 10
      ctx.font = font(L.bodySize)
      ctx.fillStyle = THEME.body
      for (const line of summaryLines) {
        ctx.fillText(line, left, y)
        y += L.bodyLineHeight
      }
    }

    // ── 底块：放送进度 + 评分分布，共用同一条底线 ──
    const titleY = bandTop - L.sectionTitleSize - 10
    drawProgressTile(ctx, info, messages, left, titleY, band.baseline, progressWidth, band.grid)
    drawScoreTile(ctx, info, messages, left + progressWidth + L.gap, titleY, band.baseline, scoreWidth, band.grid?.height ?? 0)

    // ── 页脚 ──
    ctx.font = font(FONT_SIZE.footer)
    ctx.fillStyle = THEME.muted
    ctx.textAlign = 'right'
    ctx.fillText(card.footer, L.width - L.padding * 2, height - L.padding - L.footerHeight / 2 - 4)
    ctx.textAlign = 'left'
  }

  return { width: L.width, height, draw }
}

/** 顶部的标签胶囊：类型、首播、状态、题材 */
function buildChips(info: SubjectInfo, messages: Messages): string[] {
  const chips: string[] = []
  if (info.type) chips.push(info.type)
  if (info.airLabel) chips.push(info.airLabel)
  chips.push(statusText(info.status, messages))
  for (const tag of info.tags.slice(0, 3)) chips.push(tag)
  return chips.filter(Boolean)
}

function statusText(status: SubjectInfo['status'], messages: Messages): string {
  if (status === 'airing') return messages.infoAiring
  if (status === 'finished') return messages.infoFinished
  if (status === 'upcoming') return messages.infoUpcoming
  return messages.infoUnknown
}

/** 标签按可用宽度折行 */
function layoutChips(ctx: SKRSContext2D, chips: string[], maxWidth: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let used = 0
  for (const chip of chips) {
    ctx.font = font(L.chipSize)
    const width = ctx.measureText(chip).width + 20
    if (row.length && used + L.chipGap + width > maxWidth) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(chip)
    used += (row.length > 1 ? L.chipGap : 0) + width
  }
  if (row.length) rows.push(row)
  return rows
}

function drawChips(ctx: SKRSContext2D, rows: string[][], x: number, y: number): void {
  let top = y
  for (const row of rows) {
    let left = x
    for (const chip of row) {
      ctx.font = font(L.chipSize)
      const width = drawPill(ctx, chip, left, top, {
        font: font(L.chipSize),
        color: THEME.body,
        background: THEME.badge,
        height: L.chipHeight,
        paddingX: 10,
      })
      left += width + L.chipGap
    }
    top += L.chipHeight + L.chipGap
  }
}

function drawSectionTitle(ctx: SKRSContext2D, text: string, x: number, y: number): void {
  // 左侧一根强调色小竖条，与推送表的分组标题同一套视觉语言
  fillRoundRect(ctx, x, y + 2, 3, L.sectionTitleSize - 2, 1.5, THEME.accent)
  ctx.font = font(L.sectionTitleSize, true)
  ctx.fillStyle = THEME.title
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(text, x + 11, y)
}

/**
 * 算出逐集方格的排列方式。
 *
 * **尽量排成一行**——一季 12~24 话是绝大多数，排成一行时纵向只占 30px，
 * 与评分柱并排非常紧凑。格子宽到能放下全部话数时就用一行，否则按最小宽度折行。
 */
function gridMetrics(total: number, width: number): { cell: number; gap: number; cols: number; rows: number; height: number } {
  const gap = L.epGap
  // 排成一行时需要的最小格子宽度
  const oneRowCell = Math.floor((width - gap * (total - 1)) / total)
  if (oneRowCell >= L.epCellMin) {
    const cell = Math.min(L.epCell, oneRowCell)
    return { cell, gap, cols: total, rows: 1, height: cell }
  }
  // 放不下就按最小宽度折行，格子用基准尺寸保持可读
  const cols = Math.max(1, Math.floor((width + gap) / (L.epCellMin + gap)))
  const rows = Math.ceil(total / cols)
  return { cell: L.epCell, gap, cols, rows, height: rows * L.epCell + (rows - 1) * gap }
}

/**
 * 底部整条带的几何：进度方格与评分柱**共用同一条底线**。
 *
 * 之前只让两栏共用起点、各自向下或向上延伸，结果柱子从带内往上涨时会顶到方格。
 * 这里把"底线"显式算出来传给两边：方格从底线往上排，柱子也从底线往上长，
 * 并且柱高上限不超过方格总高，两者因此永远不会相交。
 */
function bandMetrics(
  bandTop: number,
  total: number | null,
  width: number,
  showGrid: boolean,
): { height: number; baseline: number; grid: ReturnType<typeof gridMetrics> | null } {
  const grid = showGrid && total !== null && total > 0 && total <= L.epGridMax
    ? gridMetrics(total, width)
    : null
  // 底部留 16px 画 1/10 刻度
  const scaleRoom = L.bandHeight - 16
  const gridHeight = grid?.height ?? 0
  // 带高要同时容下"方格 + 刻度"和"柱子 + 刻度"；柱高上限不超过方格，避免喧宾夺主
  const height = Math.max(L.bandHeight, gridHeight + 16)
  return { height, baseline: bandTop + height - 16, grid }
}

/** 放送进度：已播/总话数 + 逐集方格（从基线往上排） */
function drawProgressTile(
  ctx: SKRSContext2D,
  info: SubjectInfo,
  messages: Messages,
  x: number,
  titleY: number,
  baseline: number,
  width: number,
  grid: { cell: number; gap: number; cols: number; rows: number; height: number } | null,
): void {
  drawSectionTitle(ctx, messages.infoProgress, x, titleY)

  const total = info.totalEpisodes
  const aired = info.airedEpisodes
  ctx.font = font(L.bodySize, true)
  ctx.fillStyle = THEME.title
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillText(
    total !== null ? (aired !== null ? `${aired}/${total}` : `${total} ${messages.infoEpisodes}`) : messages.infoUnknown,
    x + width,
    titleY + 1,
  )
  ctx.textAlign = 'left'

  if (!grid) {
    // 长期连载番或话数未知：只给一行说明，不铺格子，否则 2852 话会画出上百行
    ctx.font = font(L.bodySize)
    ctx.fillStyle = THEME.muted
    const text = aired !== null
      ? `${messages.infoAired} ${aired} ${messages.infoEpisodes}`
      : messages.infoNoSchedule
    ctx.fillText(fitText(ctx, text, width), x, baseline - L.bodySize - 4)
    return
  }

  // 方格整体贴基线：最后一行底边落在 baseline 上
  const gridTop = baseline - grid.height
  for (let index = 0; index < (total ?? 0); index++) {
    const col = index % grid.cols
    const row = Math.floor(index / grid.cols)
    const cellX = x + col * (grid.cell + grid.gap)
    const cellY = gridTop + row * (grid.cell + grid.gap)
    const isAired = aired !== null && index < aired
    if (isAired) {
      fillRoundRect(ctx, cellX, cellY, grid.cell, grid.cell, 7, THEME.accent)
      ctx.fillStyle = THEME.onAccent
    } else {
      fillRoundRect(ctx, cellX, cellY, grid.cell, grid.cell, 7, THEME.badge)
      ctx.fillStyle = THEME.muted
    }
    ctx.font = font(11, true)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(index + 1), cellX + grid.cell / 2, cellY + grid.cell / 2 + 0.5)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
}

/**
 * 评分分布：1~10 各分数段的人数。
 *
 * 柱子从 `baseline` 往上长，高度上限为左侧方格的总高（`maxBar`），
 * 因此无论方格排几行，两者都不会相交。最高的那一段用强调色，其余淡化。
 */
function drawScoreTile(
  ctx: SKRSContext2D,
  info: SubjectInfo,
  messages: Messages,
  x: number,
  titleY: number,
  baseline: number,
  width: number,
  maxBar: number,
): void {
  drawSectionTitle(ctx, messages.infoScoreBoard, x, titleY)

  const count = info.scoreCount
  if (!count) {
    ctx.font = font(L.bodySize)
    ctx.fillStyle = THEME.muted
    ctx.fillText(messages.infoNoScore, x, baseline - L.bodySize - 4)
    return
  }

  const values = Array.from({ length: 10 }, (_, index) => Number(count[String(index + 1)] ?? 0))
  const max = Math.max(...values, 1)
  const barGap = 4
  const barWidth = Math.max(4, Math.floor((width - barGap * 9) / 10))
  // 柱高上限取方格总高，再留一点余量；没有方格时用整条带的高度
  const ceiling = Math.max(18, Math.min(maxBar || L.bandHeight, L.bandHeight) - 6)

  // 不画 1/10 刻度：柱子从基线往上长，刻度放在基线下方会紧贴卡片底边，
  // 放在上方又会与柱顶打架。10 根柱子本身已经表达了"1 到 10 分"的分布。
  for (let index = 0; index < 10; index++) {
    const value = values[index] ?? 0
    const barHeight = Math.max(3, Math.round((value / max) * ceiling))
    const barX = x + index * (barWidth + barGap)
    fillRoundRect(ctx, barX, baseline - barHeight, barWidth, barHeight, 3, value === max && value > 0 ? THEME.accent : '#f6cfcc')
  }
}

/** 按像素宽度折行，最多 `maxLines` 行，最后一行超出时补省略号 */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number,
  bold: boolean,
): string[] {
  const value = (text ?? '').trim()
  if (!value || maxWidth <= 0 || maxLines < 1) return []
  ctx.font = font(size, bold)
  if (ctx.measureText(value).width <= maxWidth) return [value]

  const lines: string[] = []
  let current = ''
  // 中文没有词边界，逐字累加即可；英文单词被拆开也不影响可读性
  for (const char of value) {
    const next = current + char
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = char
      if (lines.length === maxLines) break
    } else {
      current = next
    }
  }
  if (lines.length < maxLines && current) lines.push(current)
  else if (lines.length === maxLines && current) {
    lines[maxLines - 1] = fitText(ctx, lines[maxLines - 1] + current, maxWidth)
  }
  if (lines.length > maxLines) lines.length = maxLines
  return lines
}
