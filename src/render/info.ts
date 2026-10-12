import type { SKRSContext2D } from '@napi-rs/canvas'
import { createCanvas } from '@napi-rs/canvas'
import { THEME, drawCard, drawContainImage, drawCoverPlaceholder, drawPill, fillRoundRect, fitText, strokeRoundRect } from './canvas'
import { FONT_SIZE, font } from './fonts'
import type { SubjectInfo } from '../services/info'
import type { Messages } from '../constants'

/** 作品详情卡的排版常量，与推送表的 `IMAGE_LAYOUT` 分开：那张列很多部，这张讲清一部 */
const L = {
  width: 880,
  padding: 24,
  radius: 16,
  gap: 20,

  /** 封面高度基本固定，宽度随图片比例伸缩，使 header 高度由右侧文字区决定 */
  posterHeight: 168,
  posterRatio: 3 / 4,
  posterMaxWidth: 160,

  titleSize: 26,
  originalSize: 13,
  scoreSize: 34,
  chipHeight: 22,
  chipGap: 6,
  chipSize: 11,
  sectionGap: 16,
  sectionTitleSize: 14,
  bodySize: 13,
  bodyLineHeight: 22,
  summaryLines: 4,

  /** 逐集胶囊：圆角方形，固定尺寸，一行最多 12 个 */
  epMinWidth: 26,
  epHeight: 26,
  epRadius: 4,
  epGap: 8,
  epPerRow: 12,
  /** 超过此数就不铺胶囊，只给一行文字（长期连载番有几百话） */
  epGridMax: 60,

  /** 标签栏最多显示几个题材标签，多出的丢弃 */
  maxTags: 10,

  sectionTitleGap: 8,
  /** Meta 标签组与正文之间的留白 */
  summaryGap: 14,

  /** 评分图表：10 柱 × (柱宽 + 间距)，另留 10 个刻度数字的位置 */
  scoreChartWidth: 240,
  footerGapColumns: 24,
  scoreChartHeight: 60,
  scoreAxisHeight: 18,
  scoreBarWidth: 18,
  scoreBarGap: 7,

  footerGap: 14,
  footerHeight: 26,
  coverRadius: 6,
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
 * 作品详情卡：三段式（header 封面 + 右栏信息 / body 全宽简介 / footer 两列）。
 * 封面只与 header 并排，不向下穿透；底部两列顶部对齐、各自决定高度。
 */
export function renderInfoCard(card: InfoCard): { width: number; height: number; draw: (ctx: SKRSContext2D) => void } {
  const { info, messages, cover } = card
  // 卡片画在 x=padding、宽 width-padding*2；内容再各让 padding，故内容区为 width-padding*4
  const cardWidth = L.width - L.padding * 2
  const inner = L.width - L.padding * 4
  const posterHeight = L.posterHeight
  const posterWidth = Math.round(
    Math.min(L.posterMaxWidth, Math.max(96, cover ? posterHeight * (cover.width / cover.height) : posterHeight * L.posterRatio)),
  )
  const textWidth = inner - posterWidth - L.gap

    // 高度取决于折行结果，先用同宽临时画布量一遍
  const measure = createCanvas(L.width, 10).getContext('2d')
  const titleLines = wrapText(measure, info.name, textWidth, L.titleSize, 2, true)
  const chips = buildChips(info, messages)
  const chipRows = layoutChips(measure, chips, textWidth)
  const cleanSummary = stripSummaryNoise(info.summary)
  const summaryLines = cleanSummary
    ? wrapText(measure, cleanSummary, inner, L.bodySize, L.summaryLines, false)
    : []
  const hasSummary = summaryLines.length > 0

  // 右栏高度：标题 + 原名 + 评分 + 标签行
  const rightHeight = titleLines.length * (L.titleSize + 6)
    + (info.original ? L.originalSize + 8 : 0)
    + L.scoreSize + 12
    + chipRows.length * (L.chipHeight + L.chipGap)
    // 再留 gap 余量，保证正文区始终在封面之下（右栏比封面矮时会被压住）
  const headerHeight = Math.max(posterHeight, rightHeight) + L.gap

  const summaryHeight = hasSummary
    ? L.summaryGap + L.sectionTitleSize + L.sectionTitleGap + summaryLines.length * L.bodyLineHeight
    : 0

    // 左列按 12 个胶囊精确算宽，右列固定宽度；中间空隙由剩余空间吸收
  const scoreColumnWidth = L.scoreChartWidth
  const scoreColumnX = L.padding + inner - scoreColumnWidth
  const progressColumnWidth = L.epPerRow * L.epMinWidth + (L.epPerRow - 1) * L.epGap
  const footerTop = L.padding + headerHeight + summaryHeight + L.sectionGap
  const bandTop = footerTop + L.sectionTitleSize + L.sectionTitleGap
  const band = bandMetrics(bandTop, info.totalEpisodes, progressColumnWidth, scoreColumnWidth)
  // 两列顶部对齐、各自决定高度，取较高者作为底块高度
  const footerHeight = Math.max(band.progressHeight, band.scoreHeight)
  const height = bandTop + footerHeight + L.footerGap + L.padding + L.footerHeight

  const draw = (ctx: SKRSContext2D): void => {
    ctx.fillStyle = THEME.background
    ctx.fillRect(0, 0, L.width, height)
    drawCard(ctx, L.padding, L.padding, cardWidth, height - L.padding * 2, L.radius, { shadow: true })

    const left = L.padding * 2
    const top = L.padding * 2

    // ── 封面 ──
    if (cover) drawContainImage(ctx, cover, left, top, posterWidth, posterHeight, { radius: L.coverRadius, shadow: true })
    else drawCoverPlaceholder(ctx, info.name, left, top, posterWidth, posterHeight, L.coverRadius)

    // ── 右栏 ──
    const textLeft = left + posterWidth + L.gap
    let cursor = top

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = font(L.titleSize, true)
    ctx.fillStyle = THEME.title
    for (const line of titleLines) {
      ctx.fillText(line, textLeft, cursor)
      cursor += L.titleSize + 6
    }
    // 「已订阅」贴标题行右侧，右边缘与卡片内边距对齐。用低饱和软胶囊而非实心色块：
    // 详情卡只有一个状态标记，实心色块会与标题争视觉重心
    if (info.subscribed) {
      const badgeFont = font(L.chipSize, true)
      ctx.font = badgeFont
      const width = ctx.measureText(messages.subscribedBadge).width + 20
      drawPill(ctx, messages.subscribedBadge, textLeft + textWidth - width, top, {
        font: badgeFont,
        color: THEME.accent,
        background: THEME.accentSoft,
        height: 24,
        paddingX: 10,
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

    // 底块：两列独立布局，顶部对齐
    const titleLine = bandTop - L.sectionTitleSize - L.sectionTitleGap
    drawProgressTile(ctx, info, messages, left, progressColumnWidth, titleLine, bandTop, band.grid)
    drawScoreTile(
      ctx, info, messages,
      scoreColumnX,
      scoreColumnWidth, titleLine, band.baseline,
    )

    // ── 页脚：左边条目 ID（供 `anime.sub` / `anime.info` 直接抄），右边数据更新时间 ──
    ctx.font = font(FONT_SIZE.footer)
    ctx.textBaseline = 'top'
    const footerY = height - L.padding - L.footerHeight + 4
    if (info.bgmId !== null) {
      ctx.fillStyle = THEME.muted
      ctx.textAlign = 'left'
      ctx.fillText(`ID:${info.bgmId}`, left, footerY)
    }
    ctx.fillStyle = THEME.muted
    ctx.textAlign = 'right'
    ctx.fillText(card.footer, L.width - L.padding * 2, footerY)
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
  for (const tag of info.tags.slice(0, L.maxTags)) chips.push(tag)
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

/** 算出逐集胶囊的排列：尺寸固定、一行最多 `epPerRow` 个，超出折行——不压缩宽度去凑一行（那会让数字挤在一起，且尺寸随话数变化） */
function gridMetrics(total: number, width: number, perRow: number): { cols: number; rows: number; height: number } {
  // 受可用宽度限制，一行放的个数不会超过 (width + gap) / (minWidth + gap)
  const fit = Math.max(1, Math.floor((width + L.epGap) / (L.epMinWidth + L.epGap)))
  const cols = Math.max(1, Math.min(total, perRow, fit))
  const rows = Math.ceil(total / cols)
  return { cols, rows, height: rows * L.epHeight + (rows - 1) * L.epGap }
}

/** 底部两列的几何：两列顶部对齐、各自决定高度互不拉伸；柱区不超过左列高度，避免柱子顶到上一行胶囊 */
function bandMetrics(
  bandTop: number,
  total: number | null,
  progressWidth: number,
  scoreWidth: number,
): { progressHeight: number; scoreHeight: number; baseline: number; grid: ReturnType<typeof gridMetrics> | null } {
  void scoreWidth
  const grid = total !== null && total > 0 && total <= L.epGridMax
    ? gridMetrics(total, progressWidth, L.epPerRow)
    : null
  const progressHeight = grid?.height ?? L.bodySize
  // 柱区固定高度；同时不超过左列高度，避免柱子从基线往上长时压到上一行胶囊
  const barRoom = Math.max(14, Math.min(L.scoreChartHeight, progressHeight))
  const scoreHeight = barRoom + L.scoreAxisHeight
  return { progressHeight, scoreHeight, baseline: bandTop + barRoom, grid }
}

/** 放送进度：标题行（标题 + 数值）+ 逐集胶囊（圆角方形，一行最多 12 个） */
function drawProgressTile(
  ctx: SKRSContext2D,
  info: SubjectInfo,
  messages: Messages,
  x: number,
  columnWidth: number,
  lineY: number,
  top: number,
  grid: { cols: number; rows: number; height: number } | null,
): void {
  // 标题行：数值紧跟标题右侧，不推到栏位最右，避免与胶囊网格错位
  drawSectionTitle(ctx, messages.infoProgress, x, lineY)
  const total = info.totalEpisodes
  const aired = info.airedEpisodes
  const value = total !== null
    ? (aired !== null ? `${aired} / ${total}` : `${total} ${messages.infoEpisodes}`)
    : messages.infoUnknown
  ctx.font = font(L.sectionTitleSize, true)
  const titleWidth = ctx.measureText(messages.infoProgress).width + 14
  ctx.font = font(L.bodySize, true)
  ctx.fillStyle = THEME.muted
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(value, x + titleWidth, lineY + 1)
  void columnWidth

  if (!grid) {
    // 长期连载番或话数未知：只给一行说明，不铺胶囊，否则几百话会画出上百行
    ctx.font = font(L.bodySize)
    ctx.fillStyle = THEME.muted
    const text = aired !== null
      ? `${messages.infoAired} ${aired} ${messages.infoEpisodes}`
      : messages.infoNoSchedule
    ctx.fillText(fitText(ctx, text, columnWidth), x, top + 2)
    return
  }

  // ── 胶囊：从 top 往下排，文字在方块内居中 ──
  const radius = L.epRadius
  ctx.font = font(11, false)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let index = 0; index < (total ?? 0); index++) {
    const col = index % grid.cols
    const row = Math.floor(index / grid.cols)
    const pillX = x + col * (L.epMinWidth + L.epGap)
    const pillY = top + row * (L.epHeight + L.epGap)
    const isAired = aired !== null && index < aired
    if (isAired) {
      // 已播：实心珊瑚红 + 白字（与列表里「已订阅」气泡同色）
      fillRoundRect(ctx, pillX, pillY, L.epMinWidth, L.epHeight, radius, THEME.accent)
      ctx.fillStyle = THEME.onAccent
    } else {
      // 未播：浅灰底 + 浅灰字 + 更浅的描边勾出轮廓；仅靠底色时与白色卡片难以区分
      fillRoundRect(ctx, pillX, pillY, L.epMinWidth, L.epHeight, radius, THEME.inert)
      strokeRoundRect(ctx, pillX + 0.5, pillY + 0.5, L.epMinWidth - 1, L.epHeight - 1, radius, THEME.inertBorder)
      ctx.fillStyle = THEME.inertText
    }
    ctx.fillText(String(index + 1), pillX + L.epMinWidth / 2, pillY + L.epHeight / 2 + 0.5)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
}

/**
 * 评分分布：1~10 各分数段的人数。固定宽度与柱区高度，紧贴标题下方不拉伸，
 * 柱区高度固定才能体现高度差。非峰值浅红，峰值珊瑚红。
 *
 * @param baseline 柱子底边，刻度画在它下面
 */
function drawScoreTile(
  ctx: SKRSContext2D,
  info: SubjectInfo,
  messages: Messages,
  x: number,
  columnWidth: number,
  titleY: number,
  baseline: number,
): void {
  drawSectionTitle(ctx, messages.infoScoreBoard, x, titleY)

  const count = info.scoreCount
  if (!count) {
    ctx.font = font(L.bodySize)
    ctx.fillStyle = THEME.muted
    ctx.fillText(messages.infoNoScore, x, baseline - L.bodySize)
    return
  }

  const values = Array.from({ length: 10 }, (_, index) => Number(count[String(index + 1)] ?? 0))
  const max = Math.max(...values, 1)
  const slot = L.scoreBarWidth + L.scoreBarGap
  const chartWidth = 9 * slot + L.scoreBarWidth
  const barRoom = baseline - (titleY + L.sectionTitleSize + L.sectionTitleGap)
  const centreOf = (index: number) => x + index * slot + L.scoreBarWidth / 2

  for (let index = 0; index < 10; index++) {
    const value = values[index] ?? 0
    // 高度按人数占比映射；0 人也留 2px，以区分"这一档没人"与"没有这一档"
    const barHeight = value === 0 ? 2 : Math.max(3, Math.round((value / max) * barRoom))
    const barX = x + index * slot
    const hot = value === max && value > 0
    // 顶部圆角 2px（`fillRoundRect` 的半径会被高度限制住，所以矮柱也不会变成圆点）
    fillRoundRect(ctx, barX, baseline - barHeight, L.scoreBarWidth,
      barHeight, 2, hot ? THEME.accent : THEME.scoreBar)
  }

  // 基线：把柱子与刻度连起来
  ctx.strokeStyle = THEME.divider
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, baseline + 0.5)
  ctx.lineTo(x + chartWidth, baseline + 0.5)
  ctx.stroke()

  // 刻度全标并压在对应柱子中线上：仅凭柱子无法分辨各档分数
  ctx.font = font(10)
  ctx.fillStyle = THEME.inertText
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  const axisY = baseline + 4
  for (let index = 0; index < 10; index++) {
    ctx.fillText(String(index + 1), centreOf(index), axisY)
  }
  ctx.textAlign = 'left'
}

/** 去掉简介噪声：部分条目把「中文简介 + `[简介原文]` + 日文原文」拼在一起，截到标记为止 */
function stripSummaryNoise(summary: string): string {
  return (summary ?? '').split(/\[(?:简介原文|内容简介|原文简介)\]/i)[0].trim()
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
  let rest = ''
  // 中文无词边界，逐字累加；英文单词被拆开不影响可读性
  for (const char of value) {
    const next = current + char
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = char
      if (lines.length === maxLines) {
        // 第 maxLines 行填满后仍有剩余，记下待补省略号。不可将 `current` 整段拼回：
        // 它此时可能已很长，`fitText` 遇「整串超宽」会返回空串并画出界
        rest = current
        current = ''
        break
      }
    } else {
      current = next
    }
  }
  if (lines.length < maxLines && current) lines.push(current)
  else if (rest) lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]}${rest}`, maxWidth)
  if (lines.length > maxLines) lines.length = maxLines
  return lines
}
