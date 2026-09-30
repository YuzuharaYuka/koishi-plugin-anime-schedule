import { IMAGE_THEME } from '../constants'
import type { SKRSContext2D } from '@napi-rs/canvas'
import { font } from './fonts'

export type Theme = typeof IMAGE_THEME

/** 主题别名，渲染层统一用 `theme.xxx` 取色 */
export const THEME = IMAGE_THEME

/** 圆角矩形路径 */
export function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, Math.max(0, Math.min(radius, Math.min(width, height) / 2)))
}

/** 填充圆角矩形 */
export function fillRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color
  roundRect(ctx, x, y, width, height, radius)
  ctx.fill()
}

/** 描边圆角矩形 */
export function strokeRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
  lineWidth = 1,
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  roundRect(ctx, x, y, width, height, radius)
  ctx.stroke()
}

/** 白色卡片：底色 + 细边框，可选一层柔和投影 */
export function drawCard(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  options: { background?: string; border?: string; shadow?: boolean } = {},
): void {
  if (options.shadow) {
    ctx.save()
    ctx.shadowColor = THEME.shadow
    ctx.shadowBlur = 14
    ctx.shadowOffsetY = 3
    fillRoundRect(ctx, x, y, width, height, radius, options.background ?? THEME.surface)
    ctx.restore()
  } else {
    fillRoundRect(ctx, x, y, width, height, radius, options.background ?? THEME.surface)
  }
  if (options.border !== 'none') {
    strokeRoundRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, radius, options.border ?? THEME.cardBorder)
  }
}

/** 绘制一个胶囊标签 */
export function drawPill(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  options: { font: string; color: string; background?: string; paddingX?: number; height?: number },
): number {
  const paddingX = options.paddingX ?? 8
  ctx.font = options.font
  const width = ctx.measureText(text).width + paddingX * 2
  const height = options.height ?? 18
  if (options.background) {
    fillRoundRect(ctx, x, y, width, height, height / 2, options.background)
  }
  ctx.fillStyle = options.color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + paddingX, y + height / 2 + 0.5)
  return width
}

/**
 * 按像素宽度截断文本，超出时补省略号。
 * 二分查找测量次数为 O(log n)，比逐字拼接快得多。
 */
export function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (!text) return ''
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text

  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid
    else high = mid - 1
  }
  return low > 0 ? `${text.slice(0, low)}…` : ''
}

/** 判断一个字符是否属于中日韩文字，用于挑选首字占位块的字体大小 */export function isCjk(value: string): boolean {
  return /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(value)
}

/** 取作品名首字，作为没有封面时的占位符号 */
export function initialOf(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  // 跳过书名号与引号，直接取第一个有意义的字符
  const meaningful = trimmed.replace(/^[《「『【(\[]+/, '')
  return (meaningful || trimmed).charAt(0)
}

/** 无封面时的占位块：浅色底 + 首字。
 * 比直接留白更整齐，也不会让整列看起来像缺图。
 */
export function drawCoverPlaceholder(
  ctx: SKRSContext2D,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 6,
): void {
  fillRoundRect(ctx, x, y, width, height, radius, THEME.badge)
  const initial = initialOf(name)
  const size = Math.round(Math.min(width, height) * (isCjk(initial) ? 0.46 : 0.54))
  ctx.fillStyle = THEME.accent
  ctx.font = font(Math.max(12, size), true)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initial.toUpperCase(), x + width / 2, y + height / 2 + 1)
  ctx.textAlign = 'left'
}

/**
 * 按原始比例把封面完整装进给定区域（contain）。
 *
 * 时间表的缩略图比例与 Bangumi 原图不完全一致，用 cover 裁切会切掉标题或人脸，
 * 因此这里等比缩放后居中，空出来的部分留浅色底。返回实际绘制的尺寸。
 */
export function drawContainImage(
  ctx: SKRSContext2D,
  image: { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
  options: { radius?: number; background?: string; border?: boolean } = {},
): { width: number; height: number } {
  const radius = options.radius ?? 6
  fillRoundRect(ctx, x, y, width, height, radius, options.background ?? THEME.badge)
  if (!image.width || !image.height) return { width: 0, height: 0 }

  const scale = Math.min(width / image.width, height / image.height)
  const drawWidth = Math.max(1, Math.floor(image.width * scale))
  const drawHeight = Math.max(1, Math.floor(image.height * scale))
  const offsetX = x + Math.floor((width - drawWidth) / 2)
  const offsetY = y + Math.floor((height - drawHeight) / 2)

  ctx.save()
  roundRect(ctx, x, y, width, height, radius)
  ctx.clip()
  ctx.drawImage(image as never, offsetX, offsetY, drawWidth, drawHeight)
  ctx.restore()
  if (options.border !== false) {
    strokeRoundRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, radius, THEME.cardBorder)
  }
  return { width: drawWidth, height: drawHeight }
}
