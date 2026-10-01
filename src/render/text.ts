/**
 * 纯文本形态的渲染。
 *
 * 与图片形态共用同一份 `Digest`，因此两者列出的作品、时刻、集数完全一致；
 * 差别只在**信息的排布**上——图片能靠颜色与留白分区，文本只能靠符号与缩进。
 *
 * ## 版式约定
 *
 * ```
 * 今日番剧更新 (10/1周四)
 * 共 7 部作品，其中 3 部为深夜档
 *
 * 【今日播出】
 * 00:00 第 53 话
 *   考拉绘日记
 *   ID:564980  评分 5.0
 *
 * 00:15 第 12 话
 *   盗墓王
 *   ID:621835  评分 4.5
 * ```
 *
 * 四条规则：
 *
 * 1. **一行放一个语义块**。时刻与集数留在首行（信息最密、最需要对齐），标题单独占一行
 *    并缩进两格——中文标题动辄二三十字，和时刻挤在一行必然折行，折行后时刻就淹没在
 *    文字里了。ID 与评分再缩进一层，便于扫读时跳过。
 * 2. **集数走 `episodeUnit`**（`第 53 话`），不再用 `#53`。整个界面的其它地方都是中文，
 *    `#` 是英文记法，混在一起不好读。
 * 3. **一次性放送不显示集数**：剧场版、特别篇没有「第几话」的概念，`episodeCount` 恒为 1，
 *    写出来是噪声。这与图片卡片的处理保持一致。
 * 4. **条目之间空一行**。三条一组的块状结构如果首尾相连，读者分不清哪一行属于哪一部；
 *    空行是最省字符的分隔手段，一屏仍能放下四五部。
 *
 * 季表用同一套版式，只把首行的时刻换成**完整日期**（`7/7周二 23:00`）——它是一览，
 * 读者最先想知道「什么时候开播」，而条目散在整个季度里，光有时刻没法定位。相应地季表
 * **不套分组标题**：日期已经在首行，再套一层 `【10/11周日】` 是重复信息，还会出现
 * 「首播在 9/27 的条目落在 `【10/2周五】` 组里」（因为它下次播出在那天）这种对不上的情况。
 */
import { h } from 'koishi'
import { DIGEST_LABELS, getMessages } from '../constants'
import type { Config } from '../config'
import type { Digest, DigestGroup, DigestItem } from '../types'
import { truncate } from '../utils'

/** 标题最多显示多少个字，超出补省略号（与命令里 `anime.next` 的宽度保持一致） */
const TITLE_MAX = 60

function formatItem(item: DigestItem, season: boolean, config: Config): string {
  const messages = getMessages(config.locale)
  const episode = item.recurring && item.episodeCount > 0 ? messages.episodeUnit(item.episodeCount) : ''
  // 季表是一览，读者最先想知道「什么时候开播」，因此首行给完整日期；其余三张表按天分组，
  // 日期已经在分组标题上，首行只留时刻。
  const lead = season ? (item.airLabel || item.time) : item.time
  const lines = [episode ? `${lead} ${episode}` : lead, `  ${truncate(item.name, TITLE_MAX)}`]

  const parts: string[] = []
  if (item.bgmId !== null) parts.push(`ID:${item.bgmId}`)
  if (item.score) parts.push(`评分 ${item.score}`)
  if (item.subscribed) parts.push(messages.subscribedBadge)
  if (parts.length) lines.push(`  ${parts.join('  ')}`)

  return lines.join('\n')
}

/**
 * 分组。
 *
 * 季表**不再按天分组**：它的条目本来就散在整个季度里，而首行已经带了完整日期，
 * 再套一层 `【10/11周日】` 是重复信息，还会让标签与条目日期对不上（如首播在 9/27 的
 * 条目落在 `【10/2周五】` 组里，因为它「下次播出」在那天）。
 */
function formatGroup(group: DigestGroup, config: Config, season: boolean): string {
  const body = group.items.map((item) => formatItem(item, season, config)).join('\n\n')
  if (season || !group.label) return body
  return `【${group.label}】\n${body}`
}

/**
 * 文本形态的推送渲染。
 *
 * 返回消息元素数组，调用方按平台能力选择直接发送或合并转发：
 * 第一项是列表头 + 统计行，之后每一项是一个分组，最后是数据来源。
 * 相邻元素之间插入换行，否则平台会把它们首尾拼在同一行。
 */
export function renderText(config: Config, digest: Digest): h[] {
  const messages = getMessages(config.locale)
  const season = digest.kind === 'season'

  if (!digest.groups.length) {
    return [h.text([digest.header, digest.summary, messages.footer].filter(Boolean).join('\n'))]
  }

  const elements: h[] = [
    h.text([digest.header, digest.summary].filter(Boolean).join('\n')),
  ]
  for (const group of digest.groups) {
    elements.push(h.text(`\n${formatGroup(group, config, season)}`))
  }
  if (messages.footer) elements.push(h.text(`\n${messages.footer}`))
  return elements
}

/**
 * 合并转发：整体作为一条可展开的聊天记录。
 *
 * 第一条是概览，之后每个分组一条，避免长列表在群里一条条刷屏。
 * 平台或适配器不支持 `message.forward` 时由调用方退回普通文本。
 */
export function buildForward(config: Config, digest: Digest): h {
  const messages = getMessages(config.locale)
  const season = digest.kind === 'season'
  const nodes: h[] = [
    h('message', { nickname: DIGEST_LABELS[digest.kind] }, h.text([digest.header, digest.summary].filter(Boolean).join('\n'))),
  ]
  for (const group of digest.groups) {
    nodes.push(h('message', { nickname: group.label || digest.header }, h.text(formatGroup(group, config, season))))
  }
  if (messages.footer) nodes.push(h('message', { nickname: '数据来源' }, h.text(messages.footer)))
  return h('figure', nodes)
}
