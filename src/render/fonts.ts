import { GlobalFonts } from '@napi-rs/canvas'
import type { Logger } from 'koishi'
import { BOLD_FONT_CANDIDATES, DEFAULT_FONT_FAMILY, FONT_CANDIDATES } from '../constants'

let regularFamily = DEFAULT_FONT_FAMILY
let boldFamily = `${DEFAULT_FONT_FAMILY} Bold`
let initialized = false

/** 兜底字体族：注册成固定名字供 `font()` 拼进字体栈，顺序即回退顺序 */
const FALLBACK_FAMILIES: { path: string; family: string }[] = [
  // 日文汉字与假名的字形覆盖最全，优先兜底
  { path: 'C:/Windows/Fonts/YuGothR.ttc', family: 'Yu Gothic' },
  { path: 'C:/Windows/Fonts/msgothic.ttc', family: 'MS Gothic' },
  { path: 'C:/Windows/Fonts/simsun.ttc', family: 'SimSun' },
  { path: 'C:/Windows/Fonts/NotoSansSC-VF.ttf', family: 'Noto Sans SC' },
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK JP' },
]

/**
 * 注册中文字体：常规与粗体分开注册，找不到独立粗体文件时回退常规族（由 canvas 合成）。
 * `@napi-rs/canvas` 的字体回退只在「族不存在」时生效——族存在但缺字形会直接画豆腐块，
 * 因此必须把含 CJK 的兜底族一并拼进 `font()` 的字体栈，缺字时才有东西可退。
 */
export function registerFonts(requestedFamily: string, logger: Logger): void {
  if (initialized) return
  initialized = true

  regularFamily = requestedFamily || DEFAULT_FONT_FAMILY
  boldFamily = `${regularFamily} Bold`

  if (!registerFirst(FONT_CANDIDATES, regularFamily)) {
    logger.warn(
      '[render] 未找到可用的中文字体，图片中的中文会显示为方块。'
      + '请安装 Noto Sans CJK，或确认系统字体目录中存在 msyh.ttc / simhei.ttf',
    )
  }

  if (!registerFirst(BOLD_FONT_CANDIDATES, boldFamily)) {
    boldFamily = regularFamily
    logger.debug('[render] 未找到独立的粗体字体，粗体将由常规字体合成')
  }

  const fallbacks = registerFallbacks()
  debugLogFallbacks(fallbacks, logger)
}

/** 注册兜底字体族，返回成功注册的名字 */
function registerFallbacks(): string[] {
  const ok: string[] = []
  for (const candidate of FALLBACK_FAMILIES) {
    if (GlobalFonts.has(candidate.family)) { ok.push(candidate.family); continue }
    try {
      if (GlobalFonts.registerFromPath(candidate.path, candidate.family)) ok.push(candidate.family)
    } catch {
      // 路径不存在或字体不受支持，跳过
    }
  }
  return ok
}

function debugLogFallbacks(families: string[], logger: Logger): void {
  if (families.length) logger.debug('[render] 兜底字体已注册: %s', families.join('、'))
  else logger.debug('[render] 没有可用的兜底字体，个别生僻字形可能显示为方块')
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

/** 生成 canvas 的 font 简写：主字体在前、兜底族在后，顺序即回退顺序 */
export function font(size: number, bold = false): string {
  const family = bold ? boldFamily : regularFamily
  const weight = bold && boldFamily === regularFamily ? 'bold ' : ''
  const stack = [family, ...FALLBACK_FAMILIES.map((item) => item.family)]
    .map((name) => (name.includes(' ') ? `"${name}"` : name))
  return `${weight}${size}px ${stack.join(', ')}, sans-serif`
}

/** 常用字号：每套版式内部只用一个尺寸，保证同层级信息在全图里大小一致 */
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
