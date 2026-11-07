/**
 * 深夜档时间范围校验（不进构建产物）。
 *
 * ```bash
 * cd external/anime-schedule
 * npx tsx scripts/check-night-range.ts
 * ```
 */
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'
import { getMessages } from '../src/constants'
import { formatClock, resolveNightWindow } from '../src/utils/time'

const base = ConfigSchema({} as never) as unknown as Config
const custom = normalizeConfig({
  ...base,
  timeZone: 'Asia/Shanghai',
  schedule: { ...base.schedule, nightRange: ['22:30', '05:15'] },
})

const date = '2026-11-09'
const window = resolveNightWindow(date, custom.schedule.nightRange, custom.timeZone)
const fromClock = formatClock(window.fromMs, custom.timeZone)
const toClock = formatClock(window.toMs + 1, custom.timeZone)
console.log(`自定义范围: ${fromClock} → ${toClock}`)
if (fromClock !== '22:30' || toClock !== '05:15') throw new Error('自定义深夜档窗口计算错误')

const invalid = normalizeConfig({
  ...base,
  schedule: { ...base.schedule, nightRange: ['01:00', '05:00'] },
})
console.log(`非法范围回退: ${invalid.schedule.nightRange.join(' → ')}`)
if (invalid.schedule.nightRange.join('|') !== '21:00|06:00') throw new Error('非法范围未回退到默认值')

const messages = getMessages('zh-CN')
console.log(messages.nightHeader(date, custom.schedule.nightRange[0], custom.schedule.nightRange[1]))
console.log(messages.tonightGroup(date, custom.schedule.nightRange[0]))
console.log('通过')
