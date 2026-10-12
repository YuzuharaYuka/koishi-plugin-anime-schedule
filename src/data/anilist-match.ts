/**
 * 按标题把条目匹配到 AniList。用于运行时给「没带 `aniList` ID」的条目补 ID
 * （`services/airing.ts`），以及维护脚本 `scripts/match-anilist.ts` 生成离线映射表。
 *
 * **硬条件**（决定匹配是否成立）：标题归一化后相等（含 `synonyms`）且首播日期相差不超过
 * `MAX_DAY_GAP` 天。**软条件**：播出时刻相差不超过 `MAX_HOUR_GAP` 小时——AniList 记的是
 * 「某一时刻可以看」，与电视档期可能差几小时，只用于提示「档期需订正」。
 */

/** 首播日期允许的偏差（天） */
export const MAX_DAY_GAP = 30

/** 播出时刻允许的偏差（小时）；仅用于判断档期是否需订正 */
export const MAX_HOUR_GAP = 6

const HOUR = 3600000
const DAY = 86400000

/**
 * 归一化标题：去空白与标点、全角转半角、罗马数字统一、去季度后缀。
 * 目的是让「転生貴族、鑑定スキルで成り上がる(第3期)」与「… 第3期」这类写法差异不影响匹配。
 */
export function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000_\-–—~～·・:：!！?？.,，。'"“”'‘’()（）[\]【】〈〉《》☆★]/g, '')
    .replace(/[ⅠⅡⅢⅣⅤ]/g, (char) => 'I'.repeat('ⅠⅡⅢⅣⅤ'.indexOf(char) + 1))
    .replace(/第(\d+)期|第(\d+)季|第(\d+)クール|シーズン\d+|season\d+|\d+(st|nd|rd|th)season/g, '')
}

/** 一条待匹配的作品信息 */
export interface MatchTarget {
  title: string
  /** 开播日期（UTC 毫秒，来自 bangumi-data 的 `begin`） */
  beginMs?: number | null
  /** 首次播出时刻（UTC 毫秒，来自周期规则或订正表） */
  broadcastMs?: number | null
}

/** AniList 候选里用得上的字段 */
export interface MatchCandidate {
  id: number
  title?: { native?: string | null; romaji?: string | null; english?: string | null } | null
  synonyms?: string[] | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  airingSchedule?: { nodes?: { episode?: number | null; airingAt?: number | null }[] | null } | null
}

/** 匹配结果 */
export interface TitleMatch {
  candidate: MatchCandidate
  /** 首播日期相差的天数；任一侧缺失时为 null */
  dayGap: number | null
  /** 播出时刻相差的小时数；任一侧缺失时为 null */
  hourGap: number | null
  /** 时刻是否也对得上——对不上说明档期需要订正 */
  timeAgrees: boolean
}

/** `FuzzyDate` → UTC 毫秒；不完整时返回 null */
function startMsOf(candidate: MatchCandidate): number | null {
  const date = candidate.startDate
  if (!date?.year) return null
  return Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1)
}

/**
 * 在候选里挑出与目标最匹配的一个。
 * 返回 null 表示没有候选满足硬条件——此时应当**放弃匹配**，退回周期规则的推算，
 * 而不是猜一个近似的候选。
 */
export function matchByTitle(target: MatchTarget, candidates: MatchCandidate[]): TitleMatch | null {
  const wanted = normalizeTitle(target.title)
  if (!wanted) return null
  const beginMs = target.beginMs ?? null
  const topMs = target.broadcastMs ?? Number.NaN

  let best: TitleMatch | null = null
  for (const candidate of candidates) {
    const names = [
      candidate.title?.native,
      candidate.title?.romaji,
      candidate.title?.english,
      ...(candidate.synonyms ?? []),
    ]
    if (!names.some((name) => name && normalizeTitle(name) === wanted)) continue

    const startMs = startMsOf(candidate)
    const dayGap = startMs !== null && beginMs !== null ? Math.abs(startMs - beginMs) / DAY : null
    if (dayGap !== null && dayGap > MAX_DAY_GAP) continue

    const nodes = (candidate.airingSchedule?.nodes ?? []).filter((node) => typeof node.airingAt === 'number')
    const first = nodes.length
      ? nodes.reduce((a, b) => ((a.airingAt ?? 0) < (b.airingAt ?? 0) ? a : b))
      : null
    const hourGap = first && Number.isFinite(topMs)
      ? Math.abs((first.airingAt as number) * 1000 - topMs) / HOUR
      : null
    const timeAgrees = hourGap === null || hourGap <= MAX_HOUR_GAP

    const current: TitleMatch = { candidate, dayGap, hourGap, timeAgrees }
    // 优先取「时刻也对得上」的候选；同类则取首播日期更接近的
    const better = !best
      || (current.timeAgrees && !best.timeAgrees)
      || (current.timeAgrees === best.timeAgrees && (dayGap ?? 9999) < (best.dayGap ?? 9999))
    if (better) best = current
  }
  return best
}
