/**
 * 纯文本形态的渲染，与图片形态共用同一份 `Digest`，差别只在排布——文本只能靠符号与缩进分区。
 *
 * 一行放一个语义块（时刻与集数留首行，标题单独缩进一行，ID 与评分再缩进一层）；
 * 集数走 `episodeUnit`（`第 53 话`）；一次性放送不显示集数；条目之间空一行。
 * 季表首行换成完整日期，且不再套 `【10/11周日】` 分组标题——日期已在首行，套了还会与条目日期对不上。
 */
import { h } from 'koishi'
import { DIGEST_LABELS, getMessages } from '../constants'
import type { Config } from '../config'
import type { Digest, DigestGroup, DigestItem } from '../types'
import type { SubjectInfo } from '../services/info'
import { truncate } from '../utils'

/** 标题最多显示多少个字，超出补省略号（与命令里 `anime.next` 的宽度一致） */
const TITLE_MAX = 60

/** 作品详情卡的纯文本形态：信息与图片版一致，排布改用缩进与分隔线 */
export function renderInfoText(info: SubjectInfo, config: Config): string {
  const messages = getMessages(config.locale)
  const status = info.status === 'airing' ? messages.infoAiring
    : info.status === 'finished' ? messages.infoFinished
    : info.status === 'upcoming' ? messages.infoUpcoming
    : messages.infoUnknown

  const lines: string[] = [info.name]
  if (info.original) lines.push(info.original)

  const facts: string[] = [info.type, status]
  if (info.airLabel) facts.push(info.airLabel)
  lines.push(facts.filter(Boolean).join(' · '))

  if (info.score !== null) {
    const votes = info.ratingTotal !== null ? `  ${info.ratingTotal} ${messages.infoVotes}` : ''
    lines.push(`★ ${info.score}${votes}`)
  } else {
    lines.push(messages.infoNoScore)
  }

  if (info.totalEpisodes !== null) {
    const aired = info.airedEpisodes !== null ? `${info.airedEpisodes}/${info.totalEpisodes}` : `${info.totalEpisodes}`
    lines.push(`${messages.infoProgress}: ${aired} ${messages.infoEpisodes}`)
  }
  if (info.nextEpisode) {
    lines.push(`${messages.infoNext}: ${info.nextEpisode.label} ${messages.episodeUnit(info.nextEpisode.episode)}`)
  }
  if (info.tags.length) lines.push(info.tags.join(' · '))
  if (info.summary) lines.push('', info.summary)
  if (info.bgmId !== null) lines.push('', `ID:${info.bgmId}`)

  return lines.join('\n')
}

/**
 * 搜索结果的文本形态：每条带评分与「已完结」标记，读者不必逐个点进去就能判断值不值得订阅。
 *
 * @param now 判定「已完结」的基准时刻。不取 `Date.now()`，以便调用方钉住时钟。
 */
export function renderSearchText(items: DigestItem[], keyword: string, config: Config, now = Date.now()): string {
  const messages = getMessages(config.locale)
  const lines = items.map((item, index) => {
    const when = item.firstYear ? `${item.firstYear}-${String(item.firstMonth ?? 1).padStart(2, '0')}` : ''
    const meta = [
      when,
      item.type ? item.type.toUpperCase() : '',
      item.score ? `★ ${item.score}` : '',
      // 索引里给了结束日期且已经过去 → 已完结；没有结束日期的是长期番或在播
      item.endMs !== null && item.endMs < now ? messages.infoFinished : '',
    ].filter(Boolean).join(' · ')
    const head = `${index + 1}. [ID:${item.bgmId ?? '-'}] ${truncate(titleOf(item), TITLE_MAX)}`
    return meta ? `${head}\n    ${meta}` : head
  })
  return [messages.searchHeader(items.length, keyword), ...lines].join('\n')
}

/**
 * 纯文本标题。`both` 时把原名拼回括号：文本无字号与颜色之分，
 * 不能像图片那样用浅灰小字区分。
 */
function titleOf(item: DigestItem): string {
  return item.titleOriginal ? `${item.name} (${item.titleOriginal})` : item.name
}

function formatItem(item: DigestItem, season: boolean, config: Config): string {
  const messages = getMessages(config.locale)
  const episode = item.recurring && item.episodeCount > 0 ? messages.episodeUnit(item.episodeCount) : ''
  // 季表首行给完整日期（读者最先想知道「什么时候开播」）；其余表按天分组，日期已在分组标题上，只留时刻
  const lead = season ? (item.airLabel || item.time) : item.time
  const lines = [episode ? `${lead} ${episode}` : lead, `  ${truncate(titleOf(item), TITLE_MAX)}`]

  const parts: string[] = []
  if (item.bgmId !== null) parts.push(`ID:${item.bgmId}`)
  if (item.score) parts.push(`评分 ${item.score}`)
  if (item.subscribed) parts.push(messages.subscribedBadge)
  if (parts.length) lines.push(`  ${parts.join('  ')}`)

  return lines.join('\n')
}

/** 分组；季表不按天分组：首行已带完整日期，再套一层 `【10/11周日】` 是重复信息，还会与条目日期对不上 */
function formatGroup(group: DigestGroup, config: Config, season: boolean): string {
  const body = group.items.map((item) => formatItem(item, season, config)).join('\n\n')
  if (season || !group.label) return body
  return `【${group.label}】\n${body}`
}

/**
 * 文本形态的推送渲染：返回消息元素数组（列表头 + 统计行，之后每个分组一项，最后是数据来源）。
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

/** 合并转发：第一条概览、之后每个分组一条，避免长列表刷屏；平台不支持 `message.forward` 时由调用方退回普通文本 */
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
