import { h } from 'koishi'
import { DIGEST_LABELS, getMessages } from '../constants'
import type { Config } from '../config'
import type { Digest, DigestGroup, DigestItem } from '../types'
import { truncate } from '../utils'

/**
 * 文本形态的推送渲染。
 *
 * 返回消息元素数组，调用方按平台能力选择直接发送或合并转发：
 * 第一项是列表头 + 统计行与数据来源，其余每一项是一个分组。
 * 相邻元素之间插入换行，否则平台会把它们首尾拼在同一行。
 */
export function renderText(config: Config, digest: Digest): h[] {
  const footer = getMessages(config.locale).footer
  const head = [digest.header, digest.summary, footer].filter(Boolean).join('\n')

  if (!digest.groups.length) return [h.text(head)]

  const elements: h[] = [h.text(head)]
  for (const group of digest.groups) {
    elements.push(h.text(`\n${formatGroup(group, config)}`))
  }
  return elements
}

/**
 * 合并转发：整体作为一条可展开的聊天记录。
 *
 * 第一条是概览，之后每个分组一条，避免长列表在群里一条条刷屏。
 * 平台或适配器不支持 `message.forward` 时由调用方退回普通文本。
 */
export function buildForward(config: Config, digest: Digest): h {
  const messages: h[] = [
    h('message', { nickname: DIGEST_LABELS[digest.kind] }, h.text([digest.header, digest.summary].filter(Boolean).join('\n'))),
  ]
  for (const group of digest.groups) {
    messages.push(h('message', { nickname: group.label || digest.header }, h.text(formatGroup(group, config))))
  }
  const footer = getMessages(config.locale).footer
  if (footer) messages.push(h('message', { nickname: '数据来源' }, h.text(footer)))
  return h('figure', messages)
}

function formatGroup(group: DigestGroup, config: Config): string {
  const lines: string[] = []
  if (group.label) lines.push(`【${group.label}】`)
  for (const item of group.items) lines.push(formatItem(item, config))
  return lines.join('\n')
}

function formatItem(item: DigestItem, config: Config): string {
  void config
  const score = item.score ? ` [${item.score}]` : ''
  const id = item.bgmId === null ? '' : ` ID:${item.bgmId}`
  return `· ${truncate(`${item.time} ${item.name} (${item.episode})${score}${id}`, 140)}`
}
