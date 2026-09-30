import { GlobalFonts } from '@napi-rs/canvas'
import type { Logger } from 'koishi'
import { BOLD_FONT_CANDIDATES, DEFAULT_FONT_FAMILY, FONT_CANDIDATES } from '../constants'

let regularFamily = DEFAULT_FONT_FAMILY
let boldFamily = `${DEFAULT_FONT_FAMILY} Bold`
let initialized = false

/**
 * 注册中文字体。
 *
 * 常规字重与粗体分开注册；找不到独立粗体文件时回退到常规字体族，
 * 由 canvas 自行合成，至少不会显示成方块。
 */
export function registerFonts(requestedFamily: string, logger: Logger): void {
  if (initialized) return
  initialized = true

  regularFamily = requestedFamily || DEFAULT_FONT_FAMILY
  boldFamily = `${regularFamily} Bold`

  if (!registerFirst(FONT_CANDIDATES, regularFamily)) {
    logger.warn('[render] 未找到可用的中文字体，图片中的中文可能显示为方块')
    logger.warn('[render] 请安装 Noto Sans CJK 等中文字体，或确认系统字体目录中有 msyh.ttc / simhei.ttf')
  }

  if (!registerFirst(BOLD_FONT_CANDIDATES, boldFamily)) {
    boldFamily = regularFamily
    logger.debug('[render] 未找到独立的粗体字体，粗体将由常规字体合成')
  }
}

function registerFirst(paths: string[], family: string): boolean {
  for (const path of paths) {
    try {
      if (GlobalFonts.registerFromPath(path, family)) return true
    } catch {
      // 路径不存在或字体不受支持，继续尝试下一个候选
    }
  }
  return false
}

/** 生成 canvas 的 font 简写，family 部分带常见中文字体兜底 */
export function font(size: number, bold = false): string {
  const family = bold ? boldFamily : regularFamily
  const weight = bold && boldFamily === regularFamily ? 'bold ' : ''
  return `${weight}${size}px "${family}", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif`
}

/**
 * 常用字号。
 *
 * 行卡片、周历、本季网格各自一套，同一套内部只用一个尺寸，
 * 保证相同层级的信息在全图里大小一致。
 */
export const FONT_SIZE = {
  /** 页眉 */
  title: 34,
  subtitle: 15,
  /** 列表排版的分组标题 */
  sectionTitle: 15,
  /** 时间轴的日期节点 */
  dayHeader: 20,
  /** 行卡片：标题 / 时间 / 次要信息 */
  cardTitle: 17,
  cardTime: 15,
  cardMeta: 13,
  /** 周历条目 */
  weekTime: 13,
  weekTitle: 13,
  /** 本季网格：标题 / 时间与评分 */
  gridTitle: 13,
  gridMeta: 11,
  /** 气泡角标 */
  badge: 10,
  /** 页脚与页眉右上角小字 */
  footer: 12,
  itemMeta: 11,
} as const
