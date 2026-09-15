// tools/check-vault-truth.mjs —— 「状态不许撒谎」的机械检查：逐分区核对
// （Vault 里真有几行 vs `vault-sync.json` 声称几块）。
//
// ★2026-09-16 从 `memory/tools/check_vault_truth.mjs` 搬进插件★：
//   这七个维护工具原来都住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检/备份/裁决台账"这些维护能力只在我这台机器上存在。搬进插件后
//   **`memory/tools/` 里只留薄壳**（同一份实现，不是两份）。
//
// 用法（薄壳 / maintain-cli / 设置页按钮都走 `run()`）：
//   node <插件>/lib/tools/check-vault-truth.mjs [--memdir <记忆库>]
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { resolveMemDir, argOf } from './root.mjs'

/**
 * @param {{memDir?:string, log?:(s:string)=>void}} opts
 * @returns {{ok:boolean, exit:number, text:string, stats:object}}
 */
export function run(opts) {
  const o = opts || {}
  const log = o.log || function () {}
  const MEM = resolveMemDir(o.memDir)
  const out = []
  const say = function (s) { out.push(s); log(s) }

  let state = null
  try { state = JSON.parse(readFileSync(join(MEM, 'vault-sync.json'), 'utf8')) } catch (e) {
    return { ok: false, exit: 1, text: '✗ 读不了状态文件：' + join(MEM, 'vault-sync.json') + '（' + String((e && e.message) || e) + '）', stats: {} }
  }
  let db = null
  try { db = new DatabaseSync(join(MEM, 'vault.db'), { readOnly: true }) } catch (e) {
    return { ok: false, exit: 1, text: '✗ 打不开库：' + join(MEM, 'vault.db') + '（' + String((e && e.message) || e) + '）', stats: {} }
  }

  const real = new Map()
  for (const r of db.prepare('SELECT namespace ns, COUNT(*) n FROM memos GROUP BY namespace').all()) {
    real.set(String(r.ns), Number(r.n))
  }

  const claimed = []
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith('__')) continue
    if (v && typeof v === 'object' && typeof v.chunks === 'number') claimed.push([k, v.chunks, v.label])
  }

  say('分区名                状态声称   真实   判定')
  say('-'.repeat(64))
  let bad = 0, total = 0
  const seenNs = new Set()
  for (const [ns, n, label] of claimed.sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = real.get(ns)
    seenNs.add(ns)
    total += r === undefined ? 0 : r
    const ok = r === n
    if (!ok) bad++
    say('  ' + ns.padEnd(18) + String(n).padStart(8) + String(r === undefined ? '—' : r).padStart(7) + '   ' + (ok ? '✓' : '★ 对不上 ★') + '  ' + label)
  }
  // 库里有没有"状态不知道"的分区
  for (const [ns, n] of real) {
    if (!seenNs.has(ns)) { say('  ' + ns.padEnd(18) + '（状态里没有）'.padStart(8) + String(n).padStart(7) + '   ★ 野分区 ★'); bad++ }
  }
  say('-'.repeat(64))
  say('分区数 ' + claimed.length + ' ／ 全库 ' + total + ' 行 ／ 对不上 ' + bad + ' 个')

  // 同分区内重复内容
  const dups = db.prepare('SELECT namespace ns, COUNT(*) - COUNT(DISTINCT content) d FROM memos GROUP BY namespace HAVING d > 0').all()
  say('同分区内重复块：' + (dups.length === 0 ? '0 ✓' : JSON.stringify(dups.map(function (d) { return { ns: String(d.ns), dup: Number(d.d) } }))))
  db.close()

  return {
    ok: bad === 0, exit: bad === 0 ? 0 : 1, text: out.join('\n'),
    stats: { partitions: claimed.length, rows: total, mismatches: bad, dups: dups.length },
  }
}

/** 直接运行（薄壳就是调它）：打印 + 按结果决定退出码 */
export function main(argv) {
  const a = argv || process.argv.slice(2)
  const r = run({ memDir: argOf(a, 'memdir', undefined), log: function (s) { console.log(s) } })
  if (r.ok === false && r.text.startsWith('✗')) console.log(r.text)
  process.exitCode = r.exit
  return r
}

// ★导入 ≠ 运行★（这条踩过：顶层 CLI 代码被连带执行 → 末尾的 process.exit 抢在断言之前 = 假绿）
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href
if (isMain) main(process.argv.slice(2))
