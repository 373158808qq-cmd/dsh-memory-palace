// ★2026-09-16 从 `<工作区>/memory/tools/budget.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// **入口预算**：一条命令说清"每一轮到底有哪些东西在往提示里塞、各占多少、上限多少、超没超"。
//
// ★为什么要有它★（2026-09-13 用户点名）：
//   讨论"这条规矩该放哪一层"时，我们一直在**猜**每份文件的上限 —— 而同一个"上限"其实是**两套不同机制**：
//     · `dsh-persist-local`（DSH 自带记忆）按**行数**卡：USER/MEMORY/对话/项目记忆
//     · `dsh-memory-palace`（我们的插件）按**字符数**卡：AGENTS.md / PROJECT_LEDGER.md / inject.json
//   拿字符尺子去量行数上限，数字再准也没意义。
//   **不量清楚就搬内容 = 在赌它不会被截断**（而截断是静默的）。
//
// ★每个上限都必须能追到出处★：下面每条 cap 都标了 `src`（文件:行）。
//   脚本会去源码里**核对**这些数字还在不在 —— 源码改了而这里没改，它会喊出来
//   （对抗"快照式索引必然变谎话"）。
//
// 用法：
//   node memory/tools/budget.mjs
//   node memory/tools/budget.mjs --json
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
function findRoot() {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'plugins', 'dsh-memory-palace', 'lib', 'index.js'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}
const argOf = function (name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
// ★--root / --memdir 是为了**可测**★（2026-09-14 加）：这个工具每轮都被引用来当证据
//   （"上限出处 7/7 一致"），**它要是假绿，证据全是废纸** → 必须有夹具证明"源码一改它就红"。
const ROOT_ARG = argOf('--root', null)
const ROOT = ROOT_ARG !== null ? ROOT_ARG : findRoot()
if (ROOT === null || !existsSync(ROOT)) { console.log('✗ 找不到工作区根（可用 --root 指定）'); process.exit(1) }

const MEM = argOf('--memdir', join(homedir(), '.dsh-memory'))
const PERSIST = join(ROOT, 'plugins', 'dsh-persist-local', 'lib', 'index.js')   // DSH 自带记忆（本地分叉）
const APP = join(ROOT, 'plugins', 'dsh-memory-palace', 'lib', 'index.js')         // 我们的压缩守卫

// ── 预算表：谁注入、量什么尺子、上限多少、上限出处在哪 ──────────────────────
// «尺子» `line` = 行数（按 \n 切）；`char` = JS 字符串长度（text.length）
const SOURCES = [
  { label: 'USER.md（用户画像）', by: 'dsh-persist', path: join(MEM, 'USER.md'), unit: 'line', cap: 100, src: PERSIST + ':702' },
  { label: 'MEMORY.md（长期记忆）', by: 'dsh-persist', path: join(MEM, 'MEMORY.md'), unit: 'line', cap: 100, src: PERSIST + ':703' },
  { label: '本对话记忆', by: 'dsh-persist', path: null, unit: 'line', cap: 60, src: PERSIST + ':657', note: '（运行时生成，没有对应文件）' },
  { label: '项目记忆', by: 'dsh-persist', path: null, unit: 'line', cap: 100, src: PERSIST + ':715', note: '（运行时生成）' },
  { label: 'AGENTS.md（当前目录）', by: 'dsh-memory-palace', path: join(ROOT, 'AGENTS.md'), unit: 'char', cap: 4000, src: APP + ':1082' },
  { label: 'PROJECT_LEDGER.md（当前目录）', by: 'dsh-memory-palace', path: join(ROOT, 'PROJECT_LEDGER.md'), unit: 'char', cap: 8000, src: APP + ':1083' },
  { label: '★SOP.md（协作 SOP）', by: 'dsh-memory-palace', path: join(MEM, 'SOP.md'), unit: 'char', cap: 8000, src: APP + ':1048 SOP_CAP', manual: ['memory/AGENTS.md', 'memory/PROJECT_LEDGER.md', 'memory/INDEX.md'] },
  { label: 'Vault（语义库）', by: '设计如此', path: null, unit: 'char', cap: 0, src: PERSIST + ':640', note: '无静态注入：只按需语义检索，不整份塞进提示' },
]

/** 这些是通过 inject.json 的额外注入清单进来的 —— 逐个量，别漏 */
function extraInjected() {
  const p = join(MEM, 'inject.json')
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(j.files) ? j.files : []
  } catch (_e) { return [] }
}

const measure = function (row) {
  if (row.path === null) return { n: null, exists: null }
  if (!existsSync(row.path)) return { n: null, exists: false }
  const t = readFileSync(row.path, 'utf8')
  return { n: row.unit === 'line' ? t.split('\n').length : t.length, exists: true, text: t }
}

/** 去源码里核对上限还在不在（防"这里写的是旧数字"） */
function verifyCaps() {
  const out = []
  const check = function (file, pattern, expect, what) {
    if (!existsSync(file)) { out.push({ what, ok: false, why: '源码文件不在：' + file }); return }
    const src = readFileSync(file, 'utf8')
    const m = src.match(pattern)
    const got = m ? m[0] : null
    const ok = got !== null && String(got).indexOf(String(expect)) >= 0
    out.push({ what, ok, why: ok ? '' : '源码里找不到「' + expect + '」（实际匹配：' + got + '）' })
  }
  // capText(user, 100, …) / capText(longTerm, 100, …)
  check(PERSIST, /capText\(user,\s*100/, 100, 'USER.md 上限 100 行')
  check(PERSIST, /capText\(longTerm,\s*100/, 100, 'MEMORY.md 上限 100 行')
  check(PERSIST, /CONVERSATION_CAP_LINES\s*=\s*60/, 60, '本对话记忆上限 60 行')
  check(APP, /cap\(agents,\s*4000\)/, 4000, 'AGENTS.md 上限 4000 字符')
  check(APP, /cap\(ledger,\s*8000\)/, 8000, '台账上限 8000 字符')
  // SOP 有没有 cap（2026-09-13 之前**没有**，是唯一裸着 readFileSync 的注入文件）
  const appSrc = readFileSync(APP, 'utf8')
  const sopAt = appSrc.indexOf("name: 'dsh-memory-palace-sop'")
  const sopBlock = appSrc.slice(sopAt, sopAt + 900)
  const sopCapped = sopBlock.indexOf('SOP_CAP') >= 0
  check(APP, /SOP_CAP\s*=\s*8000/, 8000, 'SOP.md 上限 8000 字符')
  out.push({
    what: 'SOP.md 有上限（2026-09-13 之前是裸的 → 无上限膨胀）',
    ok: sopCapped,
    why: sopCapped ? '' : '★它又变回裸的 readFileSync 了 → 无上限★',
  })
  return out
}

const rows = SOURCES.slice()
for (const f of extraInjected()) {
  const abs = f.replace(/\//g, require_isWin() ? '\\' : '/')
  rows.push({ label: '额外注入：' + f.split(/[\\/]/).pop(), by: 'dsh-memory-palace (inject.json)', path: abs, unit: 'char', cap: 8000, src: APP + ':1104' })
}
function require_isWin() { return process.platform === 'win32' }

const report = []
// ★2026-09-14：以前"超上限 / 没有上限"**只打在行的状态列里、从不影响退出码**（退出码只看出处核对）
//   → 一个 4312/4000 的文件照样报"过"（那个文件就是我自己的 `memory/AGENTS.md`）。
//   现在分开记：超上限 = **硬**（注入时静默截断）；没有上限 = **软**（无上限膨胀风险，先提示）。
const capOver = []
const capNone = []
console.log('═'.repeat(78))
console.log('  入口预算 —— 每轮有哪些东西在占用提示')
console.log('  工作区 ' + ROOT)
console.log('═'.repeat(78))
console.log('')
console.log('  ' + '来源'.padEnd(30) + '谁注入'.padEnd(22) + '用量'.padStart(10) + '上限'.padStart(10) + '  状态')
console.log('  ' + '-'.repeat(92))
for (const r of rows) {
  const m = measure(r)
  let usage, capTxt, status
  if (r.path === null) { usage = '—'; capTxt = r.cap ? r.cap + ' ' + r.unit : '无'; status = '· ' + (r.note || '') }
  else if (!m.exists) { usage = '（不存在）'; capTxt = r.cap + ' ' + r.unit; status = '· 跳过' }
  else {
    usage = m.n + ' ' + r.unit
    capTxt = r.cap === null ? '★无★' : r.cap + ' ' + r.unit
    if (r.cap === null) { status = '★没有上限★'; capNone.push(r.label) }
    else {
      const pct = m.n * 100 / r.cap
      if (pct > 100) capOver.push(r.label + ' ' + m.n + '/' + r.cap + '（超 ' + Math.round(pct - 100) + '%）')
      status = pct > 100 ? '★超了 ' + Math.round(pct) + '%★' : pct > 85 ? '⚠ ' + Math.round(pct) + '%' : '✓ ' + Math.round(pct) + '%'
    }
  }
  console.log('  ' + r.label.padEnd(28) + String(r.by).padEnd(22) + usage.padStart(12) + capTxt.padStart(12) + '  ' + status)
  report.push({ ...r, n: m.n, exists: m.exists })
}
console.log('')
console.log('  ★尺子说明★：`line` = 行数（按换行切）／`char` = JS 的 `text.length`（**量它必须用 Node，PowerShell 读 UTF-8 中文会虚高约 20%**）')
console.log('')

console.log('  上限出处核对（源码改了而预算表没改 → 这里会红）')
console.log('  ' + '-'.repeat(72))
// ★2026-09-16★ 插件源码**不一定在工作区里**：朋友装的是 tarball，插件躺在
//   `~/.dsh/profiles/web/node_modules/dsh-memory-palace/`，`<工作区>/plugins/` 根本不存在
//   → 旧版在这里 `readFileSync(APP)` 直接 ENOENT 崩掉（空夹具自测当场抓到）。
//   现在：**没有源码就明说"这几项跳过"** —— 跳过的**不渲染成绿、也不算失败**（本项目铁律）。
const SRC_PRESENT = existsSync(APP) || existsSync(PERSIST)
let vFail = 0
if (!SRC_PRESENT) {
  console.log('  · 跳过：这台机器上 `<工作区>/plugins/dsh-memory-palace/lib/index.js` 不存在（插件是装在 profile 里的，正常）')
  console.log('     → 「上限出处核对」这几项**既不通过也不失败**（要看它们，就在插件源码目录里跑一次）')
} else {
  for (const v of verifyCaps()) {
    if (!v.ok) vFail++
    console.log('  ' + (v.ok ? '✓ 一致  ' : '✗ 不一致') + '  ' + v.what + (v.why ? '  —— ' + v.why : ''))
  }
}
console.log('')
console.log('  预算结论（★这块决定退出码★）')
console.log('  ' + '-'.repeat(72))
console.log('  超上限 ' + capOver.length + ' 项 ／ 没有上限 ' + capNone.length + ' 项 ／ 上限出处不一致 ' + vFail + ' 项' +
  (SRC_PRESENT ? '' : '（出处核对本轮跳过）'))
if (capOver.length) {
  console.log('  ✗ 超上限（**注入时会被静默截断**，先把文档压回去再谈别的）：')
  for (const x of capOver) console.log('      · ' + x)
}
if (capNone.length) console.log('  ⚠ 没有上限（没被卡住 = 会无限膨胀；这是软项，只提示）：' + capNone.join('、'))
const bad = vFail + capOver.length
console.log('  ' + (bad === 0 ? '✓ 预算：全部在上限内' + (SRC_PRESENT ? '，上限出处也核对一致' : '（上限出处本轮跳过）') : '✗ 预算：不过 —— 上面 ' + bad + ' 项要先处理'))
console.log('')

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows: report, verify: SRC_PRESENT ? verifyCaps() : null, verifySkipped: !SRC_PRESENT, capOver: capOver, capNone: capNone, over: capOver.length, sourceMismatch: vFail }, null, 1))
}
process.exit(bad > 0 ? 1 : 0)
