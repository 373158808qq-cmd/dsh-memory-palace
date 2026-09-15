#!/usr/bin/env node
// maintain-cli.mjs —— 维护作业的命令行入口（给会话里的 agent / 人手敲用）。
//
// 和 `init-cli.mjs` 的分工：那个管**初始化**（把"没有"变成"有"），这个管**维护**（体检、核对、备份）。
// 作业的实现在 `lib/tools/` 里（本项目的 `memory/tools/*` 只是薄壳）。
//
// 用法：
//   node <插件>/lib/maintain-cli.mjs list                      列出所有作业（含各自"非 0 退出码是什么意思"）
//   node <插件>/lib/maintain-cli.mjs run <作业id> [--root <p>] [--memdir <p>]
//   node <插件>/lib/maintain-cli.mjs run all                    逐个跑一遍（小结 + 每个作业的完整输出）
//   node <插件>/lib/maintain-cli.mjs where                      这台机器上"根目录/记忆库"定成了哪、怎么定的
// 退出码：0 = 作业通过；1 = 作业报红（或有待裁决条目）；2 = 用法/参数不对。
import { JOBS, runJob, jobList } from './maintain.mjs'
import { resolveMemDir, resolveRoot, argOf } from './tools/root.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const root = argOf(argv, 'root', undefined)
const memDir = argOf(argv, 'memdir', undefined)

const show = function (r) {
  if (r.text) process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n')
  if (r.error) process.stderr.write('✗ ' + r.error + '\n')
}

let exit = 0
if (cmd === 'list') {
  const l = jobList({ root: root, memDir: memDir })
  console.log('维护作业（实现在插件 lib/tools/ 里）：')
  for (const j of JOBS) {
    console.log('  ' + j.id.padEnd(14) + j.name + (j.needsRoot ? '' : '（不需要根目录）'))
    console.log('      ' + j.what)
    console.log('      退出码：' + j.exitMeans)
  }
  console.log('\n这台机器：记忆库=' + l.memDir)
  console.log('          根目录=' + (l.root || '（还不知道）') + '（来源：' + l.rootHow + '）')
  if (l.rootWarn) console.log('          ⚠ ' + l.rootWarn)
} else if (cmd === 'where') {
  const m = resolveMemDir(memDir)
  const r = resolveRoot(root, m)
  console.log(JSON.stringify({ memDir: m, root: r.root, how: r.how, warn: r.warn || null }, null, 2))
  if (!r.root) exit = 1
} else if (cmd === 'run') {
  const which = argv[1] && !argv[1].startsWith('--') ? argv[1] : null
  const ids = which === 'all' ? JOBS.map(function (j) { return j.id }) : (which ? [which] : [])
  if (ids.length === 0) { process.stderr.write('用法：run <作业id|all> [--root <p>] [--memdir <p>]\n作业：' + JOBS.map(function (j) { return j.id }).join(' / ') + '\n'); process.exit(2) }
  const results = []
  for (const id of ids) {
    const r = await runJob(id, { root: root, memDir: memDir })
    results.push(r)
    if (ids.length > 1) console.log('\n══════ ' + (r.name || id) + '（' + id + '）exit=' + r.exit + '  ' + r.ms + 'ms ══════')
    show(r)
    if (!r.ok) exit = 1
  }
  if (ids.length > 1) {
    console.log('\n────── 小结 ──────')
    for (const r of results) console.log('  ' + (r.ok ? '✓ 过  ' : '✗ 红  ') + (r.name || r.id).padEnd(16) + 'exit=' + r.exit + '  ' + r.ms + 'ms')
    console.log('（非 0 不一定是"坏了"：体检器/裁决台账/状态核对是"有待你看的条目"，各自含义见 `list`）')
  }
} else {
  process.stderr.write('用法：list | where | run <作业id|all> [--root <p>] [--memdir <p>]\n')
  exit = 2
}
process.exitCode = exit
