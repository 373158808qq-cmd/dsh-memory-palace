// ★2026-09-16 从 `<工作区>/memory/tools/lint_layers.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// **分层纪律检查器 v2**：机械地查出"放错层 / 重复 / 不该有的东西 / 指针失效 / 超预算"。
//
// ★为什么必须做成脚本★（用户要求"更严格地规定每个仓库放什么，不要再出现台账里有重复"）：
//   写一份《分层规矩》贴在文档里 = **规则写在纸上 ≠ 会被执行**。规矩必须能**被一条命令查出来**。
//
// ★v2 的关键修正：**"注入了哪些文件"要按"你在哪个目录开会话"推导**★
//   守卫只注入 **当前目录** 下的 `AGENTS.md` / `PROJECT_LEDGER.md`；另外几份（USER/MEMORY/SOP/INDEX清单）
//   是**常驻**的。所以：
//     · 在 `voice/` 开会话 → 注入的是 voice 的台账+规则 + 常驻那几份
//     · 在根目录开会话   → 注入的是根的 AGENTS.md + 常驻那几份
//   v1 把注入集写死成 `memory/` 那一套 —— **在别的项目里跑就会得出错的结论**。
//
// 检查项：
//   L1 跨注入文件重复（同一句话住在两份**同时注入**的文件里 = 双倍占窗口）
//   L2 台账里有"历史流水"（按时间排的修复记录属于档案）
//   L3 台账里有"长解释"（单行过长 = 那是原因/过程）
//   L4 台账里有"代码/表格块"
//   L5 指针失效（`file:<路径>#<标题>` / `vault:<分区>#<标题>` 指不到东西）
//   L6 全工作区逐项目体检（上面几项 + 预算：台账 8000 字符 / 规则 4000 字符）
//      ★2026-09-14★：L6 以前**只把问题打印出来、从不计入 fail/warn**（退出码永远 0）→ "超上限"这种
//      硬毛病照样报绿（我自己的 `memory/AGENTS.md` 涨到 4312/4000 = **注入时被静默截断**，就是这么溜过去的）。
//      现在判据**与第一部分 L1–L4 逐项对齐**（同一件事在哪个目录都得是同一个颜色）：
//        硬（fail）：超上限（4000/8000 = 会静默截断）｜ 按日期流水（= L2 红）｜ 跨注入重复句（= L1 红）
//        软（warn）：长行 >360（= L3 只警告）｜ 代码块/表格（= L4 只警告）
//      注意：**别拿"打印了"当"算了"** —— 一个永远不会让退出码变红的检查，比没有更坏。
//
// 用法：node memory/tools/lint_layers.mjs       退出码 0=全过 1=有问题
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
function findRoot() {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'plugins', 'dsh-memory-app', 'lib', 'index.js'))) return dir
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
// ★--root / --memdir 是为了**可测**★（2026-09-14 加）：闸门自己没有回归 = 假阴性没人知道。
//   默认行为一字不变；夹具测试用这两个开关指向假工作区/假记忆库。
const ROOT_ARG = argOf('--root', null)
const ROOT = ROOT_ARG !== null ? ROOT_ARG : findRoot()
const MEM = argOf('--memdir', join(homedir(), '.dsh-memory'))
if (ROOT === null) { console.log('✗ 找不到工作区根（可用 --root 指定）'); process.exit(1) }
const read = function (p) { try { return readFileSync(p, 'utf8') } catch (_e) { return null } }

const fail = []
const warn = []
const details = []   // 明细（给 --json 用：只报"有 3 个指针失效"而说不出是哪三个 = 没法排查）
const say = function (ok, msg) { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fail.push(msg) }
const note = function (msg) { console.log('  ⚠ ' + msg); warn.push(msg) }

/** 归一化一行用于"是不是同一句话"的比较；返回 null 表示这行是结构行、不参与 */
function normLine(raw) {
  const l = raw.trim()
  if (l === '') return null
  if (l.startsWith('#') || l.startsWith('---') || l.startsWith('|') || l.startsWith('>')) return null
  return l.replace(/\s+/g, ' ').replace(/^[-*+]\s*/, '').toLowerCase()
}

// ── 注入集模型 ────────────────────────────────────────────────────
// ① 常驻：不管在哪个目录开会话都会被注入
const ALWAYS = [
  { label: 'MEMORY.md', path: join(MEM, 'MEMORY.md') },
  { label: 'USER.md', path: join(MEM, 'USER.md') },
  { label: 'SOP.md', path: join(MEM, 'SOP.md') },
]
// inject.json 里的"额外注入清单"也是常驻
try {
  const j = JSON.parse(read(join(MEM, 'inject.json')) || '{}')
  for (const f of (Array.isArray(j.files) ? j.files : [])) {
    ALWAYS.push({ label: '额外注入:' + f.split(/[\\/]/).pop(), path: f })
  }
} catch (_e) { /* 没配就算了 */ }

/** ② 随 cwd：该目录下的 AGENTS.md / PROJECT_LEDGER.md（守卫只认**当前目录**，不递归） */
function injectedFor(dir) {
  const out = ALWAYS.slice()
  for (const n of ['AGENTS.md', 'PROJECT_LEDGER.md']) {
    const p = join(dir, n)
    if (existsSync(p)) out.push({ label: n + '(' + (dir === ROOT ? '根' : dir.split(/[\\/]/).pop()) + ')', path: p })
  }
  // ★按"真实路径"去重 —— 同一份文件被算两次会造出**假重复**★
  //   实测踩过：`inject.json` 里列了 `memory/PROJECT_LEDGER.md`，而如果会话目录恰好也是 `memory`，
  //   守卫那条 `<cwd>/PROJECT_LEDGER.md` 又会加一次同一份 → 工具报出 44 句"重复"，**全是假的**。
  //   （反过来这条检查本身有价值：真出现"同一路径被注入两次"，那就是**真浪费一倍窗口**，必须报出来。）
  const seen = new Map()
  const uniq = []
  for (const f of out) {
    const key = f.path.replace(/[\\/]+/g, '/').toLowerCase()
    if (seen.has(key)) { seen.get(key).dupOf = f.label; continue }
    seen.set(key, f)
    uniq.push(f)
  }
  return uniq
}

/** 扫出工作区里所有"项目文件夹"（含 PROJECT_LEDGER.md 的目录，深度 ≤2） */
function findProjects() {
  const out = []
  const skip = /(^|[\\/])(node_modules|\.git|pylibs|pylibs312|runtime|logs|backups|_trash|\.ptmp|\.npm-cache|\.ollama-models|产出物|\.venv|venv|dist|build)([\\/]|$)/i
  const walk = function (dir, depth) {
    if (depth > 2) return
    let items = []
    try { items = readdirSync(dir) } catch (_e) { return }
    for (const it of items) {
      const p = join(dir, it)
      // ★SKIP 必须按"相对工作区根"判，不能拿绝对路径判★（2026-09-14 夹具测试抓出来的，
      //   **跟体检器是同一个 bug**）：工作区一旦嵌在 `.ptmp/`、`logs/` 这类目录下，
      //   绝对路径里就含那个名字 → **整棵树被跳过、一个项目都不体检**。
      if (skip.test(relative(ROOT, p))) continue
      let st
      try { st = statSync(p) } catch (_e) { continue }
      if (!st.isDirectory()) continue
      if (existsSync(join(p, 'PROJECT_LEDGER.md'))) out.push(p)
      else walk(p, depth + 1)
    }
  }
  walk(ROOT, 0)
  return out
}

// ── 通用检查（对任意一份台账都能跑）────────────────────────────────
function checkLines(label, text, out) {
  const lines = text.split('\n')
  const dated = lines.map(function (l, i) { return { l: l, i: i + 1 } })
    .filter(function (x) { return /^\s*[-*]?\s*\**\s*20\d\d-\d\d-\d\d/.test(x.l) })
  const longs = lines.map(function (l, i) { return { l: l.trim(), i: i + 1 } })
    .filter(function (x) { return x.l.length > 360 && !x.l.startsWith('#') })
  const fences = (text.match(/```/g) || []).length
  const tableRows = lines.filter(function (l) { return l.trim().startsWith('|') }).length
  out.push({ label: label, dated: dated, longs: longs, fences: fences, tableRows: tableRows })
  return { dated: dated, longs: longs, fences: fences, tableRows: tableRows }
}

// ══════════════════ 第一部分：当前设定的详细检查 ══════════════════
// ★"当前会话目录"默认取工作区根★ —— 实测：用户的会话就跑在工作区根（不是 `memory/`）。
//   我第一版写死成 `memory/`，结果 `inject.json` 里的 `memory/PROJECT_LEDGER.md`
//   和 `<cwd>/PROJECT_LEDGER.md` 被当成两份不同文件 → **报出 44 句假重复**。
//   要检查别的目录用 `--cwd <目录>`。
const cwdArg = process.argv.indexOf('--cwd')
const HERE_DIR = cwdArg >= 0 && process.argv[cwdArg + 1] ? process.argv[cwdArg + 1] : ROOT
const INJECTED = injectedFor(HERE_DIR)

console.log('═'.repeat(78))
console.log('  分层纪律检查 v2')
console.log('═'.repeat(78))
console.log('  会话目录 ' + HERE_DIR + (cwdArg >= 0 ? '' : '（默认工作区根；换目录用 --cwd）'))
console.log('  注入集（' + INJECTED.length + ' 份）：' + INJECTED.map(function (f) { return f.label }).join('、'))

// L1
console.log('\nL1 跨注入文件重复（同一句话住在两份**同时注入**的文件里 = 双倍占窗口）')
{
  const where = new Map()
  for (const f of INJECTED) {
    const t = read(f.path)
    if (t === null) continue
    let inFence = false
    t.split('\n').forEach(function (raw, i) {
      if (raw.trim().startsWith('```')) { inFence = !inFence; return }
      if (inFence) return
      const k = normLine(raw)
      if (k === null || k.length < 12) return
      if (!where.has(k)) where.set(k, [])
      where.get(k).push({ label: f.label, line: i + 1, raw: raw.trim() })
    })
  }
  const dup = [...where.entries()].filter(function (e) { return e[1].length > 1 })
  if (dup.length === 0) say(true, '没有跨注入文件的重复句')
  else {
    say(false, '★有 ' + dup.length + ' 句同时住在多份注入文件里★')
    for (const [, hits] of dup.slice(0, 10)) {
      const line = hits.map(function (h) { return h.label + ':' + h.line }).join('  ／  ')
      console.log('      ' + line)
      console.log('        「' + hits[0].raw.slice(0, 76) + '」')
      details.push('L1 重复句 ' + line + ' 「' + hits[0].raw.slice(0, 60) + '」')
    }
  }
}

// L2/L3/L4 on 当前目录的台账
{
  const lp = join(HERE_DIR, 'PROJECT_LEDGER.md')
  const t = read(lp)
  // ⚠️ 这里用 console.log 而不是 note()：**"工作区根没有台账"是正常情况**（台账都在项目文件夹里），
  //    当成"警告"会让每次跑都挂一条假警告 —— 而**常驻的假警告会让真警告也被忽略**。
  if (t === null) console.log('  · 会话目录没有台账（正常：台账在各项目文件夹里，见下面 L6 的逐项目体检）')
  else {
    const r = checkLines('memory', t, [])
    console.log('\nL2 台账里的"历史流水"（按时间排的修复记录属于档案）')
    if (r.dated.length <= 2) say(true, '没有成规模的按日期流水（' + r.dated.length + ' 行）')
    else say(false, '★有 ' + r.dated.length + ' 行按日期的流水★ 例：' + r.dated[0].l.trim().slice(0, 66))
    console.log('\nL3 台账里的"长解释"（单行 >360 字符 = 那是原因/过程）')
    if (r.longs.length === 0) say(true, '没有超长行')
    else note('有 ' + r.longs.length + ' 行超 360（最长 ' + Math.max.apply(null, r.longs.map(function (x) { return x.l.length })) +
      '）：行 ' + r.longs.map(function (x) { return x.i }).join('、'))
    console.log('\nL4 台账里的"代码/表格块"')
    if (r.fences === 0 && r.tableRows <= 12) say(true, '无代码块，表格行 ' + r.tableRows + '（未验收表是允许的）')
    else note('代码围栏 ' + (r.fences / 2) + ' 块 / 表格行 ' + r.tableRows)
  }
}

/** 指针锚点没命中时，帮忙找"最像的那个标题"。
 *  ★加它的原因★：2026-09-14 一天之内我**三次**写出对不上的锚点（凭记忆写标题、而档案里
 *  标题措辞略有不同）。lint 每次都能抓到，但每次要多花一轮才知道"那到底该写什么"。
 *  有了它，把最接近的标题直接摆出来，一轮就能改对。 */
function closestHeading(rows, anchor) {
  const bigrams = function (s) { const g = new Set(); for (let i = 0; i + 2 <= s.length; i++) g.add(s.slice(i, i + 2)); return g }
  const A = bigrams(anchor)
  if (A.size === 0) return null
  let best = null, bestScore = 0
  for (const r of rows) {
    for (const line of String(r.content).split('\n')) {
      const h = /^#{2,4}\s+(.*)$/.exec(line)
      if (!h) continue
      const t = h[1].replace(/[*`]/g, '')
      const B = bigrams(t)
      let inter = 0
      for (const g of A) if (B.has(g)) inter++
      const score = inter / A.size
      if (score > bestScore) { bestScore = score; best = t }
    }
  }
  return bestScore >= 0.4 ? best : null
}

// L5
console.log('\nL5 指针是否还指得到（失效的指针 = 无声的谎话）')
{
  let db = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(join(MEM, 'vault.db'), { readOnly: true })
  } catch (_e) { note('读不到 Vault（跳过 vault: 指针检查）') }
  const scanned = []
  for (const f of INJECTED) { const t = read(f.path); if (t !== null) scanned.push({ label: f.label, text: t }) }
  {
    const arch = read(join(HERE_DIR, 'PROJECT_LEDGER_ARCHIVE.md'))
    if (arch !== null) scanned.push({ label: '档案(仅头部 20 行)', text: arch.split('\n').slice(0, 20).join('\n') })
  }
  const ptrs = []
  for (const f of scanned) {
    const re = /`?(file|vault):([^#`\s]+)#([^`\s]+)`?/g
    let m
    while ((m = re.exec(f.text)) !== null) ptrs.push({ kind: m[1], target: m[2], anchor: m[3], from: f.label })
  }
  const isTpl = function (s) { return /[<>|]/.test(s) }
  const bad = []
  for (const p of ptrs) {
    if (p.kind === 'file') {
      if (isTpl(p.target)) continue
      const hit = [p.target, join(ROOT, p.target), join(ROOT, 'memory', p.target)].filter(function (c) { return existsSync(c) })[0]
      if (hit === undefined) { bad.push({ ...p, why: '文件不存在' }); continue }
      if (isTpl(p.anchor)) continue
      if ((read(hit) || '').indexOf(p.anchor) < 0) bad.push({ ...p, why: '文件在，但没有「' + p.anchor + '」这个标题' })
    } else if (p.kind === 'vault') {
      if (db === null || isTpl(p.target)) continue
      const rows = db.prepare('SELECT content FROM memos WHERE namespace = ?').all(p.target)
      if (rows.length === 0) { bad.push({ ...p, why: '★Vault 里没有「' + p.target + '」这个分区★（多半是改名前的旧名）' }); continue }
      if (isTpl(p.anchor)) continue
      if (!rows.some(function (r) { return String(r.content).indexOf(p.anchor) >= 0 })) {
        const near = closestHeading(rows, p.anchor)
        bad.push({ ...p, why: '分区在，但没有块含「' + p.anchor + '」' + (near ? '  ★最接近的标题是「' + near + '」—— 锚点要跟标题逐字一致（从档案里**复制**，别凭记忆写）★' : '') })
      }
    }
  }
  if (db !== null) {
    const live = new Set(db.prepare('SELECT DISTINCT namespace FROM memos').all().map(function (r) { return r.namespace }))
    for (const f of scanned) {
      if (f.text.indexOf('vault:记忆系统') >= 0 && !live.has('记忆系统')) {
        bad.push({ kind: 'doc', target: '记忆系统', why: '★文档还在教人用已退役的分区名（现在叫 `memory`）★', from: f.label })
      }
    }
    db.close()
  }
  if (bad.length === 0) say(true, '所有指针都还指得到')
  else {
    say(false, '★有 ' + bad.length + ' 个指针失效★')
    bad.slice(0, 10).forEach(function (b) {
      console.log('        ' + b.kind + ':' + b.target + '#' + (b.anchor || '') + '  —— ' + b.why + '（' + b.from + '）')
      details.push('L5 指针失效 ' + b.kind + ':' + b.target + '#' + (b.anchor || '') + ' —— ' + b.why + '（' + b.from + '）')
    })
  }
}

// ══════════════════ 第二部分：全工作区逐项目体检（L6）══════════════════
console.log('\n' + '═'.repeat(78))
console.log('  L6 全工作区逐项目体检（每个项目在自己的目录开会话时，注入的就是它这几份）')
console.log('═'.repeat(78))
const projects = findProjects()
console.log('  发现项目文件夹 ' + projects.length + ' 个')
console.log('')
console.log('  ' + '项目'.padEnd(18) + '台账'.padStart(14) + '规则'.padStart(12) + '  流水/长行/代码块  重复句  指针坏')
console.log('  ' + '-'.repeat(84))

const projIssues = []
for (const dir of projects) {
  const name = dir === ROOT ? '(根)' : dir.split(/[\\/]/).pop()
  const lp = join(dir, 'PROJECT_LEDGER.md')
  const ap = join(dir, 'AGENTS.md')
  const lt = read(lp) || ''
  const at = read(ap)
  const lInfo = checkLines(name, lt, [])
  // 该项目注入集内的重复
  const inj = injectedFor(dir)
  const where = new Map()
  for (const f of inj) {
    const t = read(f.path)
    if (t === null) continue
    let inFence = false
    t.split('\n').forEach(function (raw) {
      if (raw.trim().startsWith('```')) { inFence = !inFence; return }
      if (inFence) return
      const k = normLine(raw)
      if (k === null || k.length < 12) return
      if (!where.has(k)) where.set(k, [])
      where.get(k).push(f.label)
    })
  }
  const dups = [...where.entries()].filter(function (e) { return e[1].length > 1 })

  const sizeTxt = lt.length + '/' + 8000
  const sizeAg = at === null ? '（无）' : at.length + '/4000'
  const hard = []   // 该红：硬上限（静默截断）／与 L1、L2 同级的"放错层"
  const soft = []   // 只警告：与 L3、L4 同级的风格项
  if (lt.length > 8000) hard.push('★台账超上限★ ' + lt.length + '/8000')
  if (at !== null && at.length > 4000) hard.push('★规则超上限★ ' + at.length + '/4000')
  if (lInfo.dated.length > 2) hard.push('流水' + lInfo.dated.length)
  if (dups.length > 0) hard.push('重复句' + dups.length)
  if (lInfo.longs.length > 0) soft.push('长行' + lInfo.longs.length)
  if (lInfo.fences > 0) soft.push('代码块' + (lInfo.fences / 2))
  console.log('  ' + name.padEnd(16) + sizeTxt.padStart(14) + sizeAg.padStart(12) + '  ' +
    (lInfo.dated.length + '/' + lInfo.longs.length + '/' + (lInfo.fences / 2)).padEnd(18) +
    String(dups.length).padStart(4) + '   ' + '—')
  if (hard.length || soft.length) projIssues.push({ name: name, hard: hard, soft: soft, dups: dups, info: lInfo, dir: dir })
  if (hard.length) fail.push('L6 [' + name + '] ' + hard.join('、'))
  if (soft.length) warn.push('L6 [' + name + '] ' + soft.join('、'))
}

// 指针：把每个项目的台账+规则也扫一遍（它们在自己的目录开会话时会注入）
console.log('\n  逐项目的"放错层"明细（✗ = 计入失败 ／ ⚠ = 只警告）')
if (projIssues.length === 0) say(true, '所有项目的台账都干净（超上限 / 流水 / 重复句 / 长行 / 代码块 全无）')
else {
  for (const p of projIssues) {
    console.log('    ' + (p.hard.length ? '✗ ' : '⚠ ') + p.name + '：' + p.hard.concat(p.soft).join('、'))
    p.dups.slice(0, 4).forEach(function (e) {
      console.log('        重复句 [' + e[1].join(' ／ ') + '] 「' + e[0].slice(0, 60) + '」')
    })
    if (p.info.longs.length) {
      const worst = p.info.longs.sort(function (a, b) { return b.l.length - a.l.length })[0]
      console.log('        最长行 ' + worst.l.length + ' 字符（行 ' + worst.i +'）：' + worst.l.slice(0, 60) + '…')
    }
    if (p.info.dated.length > 2) console.log('        日期流水首行：' + p.info.dated[0].l.trim().slice(0, 60))
  }
}

console.log('\n' + '═'.repeat(78))
console.log('  失败 ' + fail.length + ' 项 ／ 警告 ' + warn.length + ' 项')
if (fail.length === 0) console.log('  ✓ 分层纪律：过（警告项也请逐轮压下去）')
else console.log('  ✗ 分层纪律：不过 —— 按上面每条的"哪一行、为什么"去改')
console.log('═'.repeat(78))

// 机器可读出口（给夹具回归、以后也能接进流水线）
const JSON_OUT = argOf('--json', null)
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    at: new Date().toISOString(),
    root: ROOT, cwd: HERE_DIR, memDir: MEM,
    failures: fail, warnings: warn, details: details,
    projects: projIssues.map(function (p) { return { name: p.name, hard: p.hard, soft: p.soft, flags: p.hard.concat(p.soft), dups: p.dups.length } })
  }, null, 1), 'utf8')
  console.log('  已写报告 ' + JSON_OUT)
}
process.exit(fail.length === 0 ? 0 : 1)
