/**
 * 比较两份回归快照的结构性差异（忽略耗时与封面/评分的「有没有」）。
 *
 * 用法: npx tsx scripts/snapshot-diff.ts before after
 */
import { promises as fs } from 'fs'
import { resolve } from 'path'

const PACKAGE_ROOT = resolve(__dirname, '..')
const KEYS = ['daily', 'night', 'weekly', 'season', 'seasonPrev', 'upcoming', 'search']

/** 只保留值得比对的结构字段 */
function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === 'ms' || key === 'totalMs' || key === 'fixedNow') continue
      if (key === 'hasCover' || key === 'hasScore') continue
      out[key] = normalize(value[key])
    }
    return out
  }
  return value
}

/** 把两棵树摊平成「路径 → 值」，便于逐条报告差异 */
function flatten(value: any, path = '', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) flatten(value[key], path ? `${path}.${key}` : key, out)
    return out
  }
  out.set(path, JSON.stringify(value))
  return out
}

async function main() {
  const [left, right] = process.argv.slice(2)
  if (!left || !right) {
    console.error('用法: npx tsx scripts/snapshot-diff.ts <baseline> <candidate>')
    process.exit(1)
  }
  const read = async (name: string) => JSON.parse(
    await fs.readFile(resolve(PACKAGE_ROOT, 'target/anime-snapshot', `${name}.json`), 'utf8'),
  )
  const a = await read(left)
  const b = await read(right)

  console.log(`比对 ${left} vs ${right}`)
  console.log(`  索引: ${a.indexSize} → ${b.indexSize}   时区: ${a.timeZone} → ${b.timeZone}\n`)

  let total = 0
  for (const key of KEYS) {
    const fa = flatten(normalize(a[key]))
    const fb = flatten(normalize(b[key]))
    const paths = new Set([...fa.keys(), ...fb.keys()])
    const diffs: string[] = []
    for (const path of [...paths].sort()) {
      const va = fa.get(path)
      const vb = fb.get(path)
      if (va !== vb) diffs.push(`    ${path}\n      ${left}: ${va}\n      ${right}: ${vb}`)
    }
    total += diffs.length
    console.log(`${key.padEnd(11)} ${diffs.length === 0 ? '一致' : `${diffs.length} 处差异`}`)
    for (const line of diffs.slice(0, 25)) console.log(line)
    if (diffs.length > 25) console.log(`    …另有 ${diffs.length - 25} 处`)
  }

  console.log(`\n${total === 0 ? '✓ 结构性输出完全一致' : `✗ 共 ${total} 处结构性差异`}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
