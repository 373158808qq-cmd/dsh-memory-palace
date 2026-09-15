// ★2026-09-16 从 `<工作区>/memory/tools/findings.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// 裁决台账（⑤ 校验层的第 ③ 层）—— 把体检发现**存下来、跟踪到清零**。
//
// ★为什么必须存在★：体检器每次跑完只打印一份清单，**跑完就没了**。于是
//   · 同一个问题每次都被"重新发现"，看不出它是新毛病还是老毛病；
//   · V8 那条验收判据「**矛盾 100% 标出并裁决留档**」没法回答（没有"档"）；
//   · 也就没有**清零率**这个唯一能用的量化指标。
//   这跟 `embeddings.json` 烂掉是同一个病：**没有触发器的快照，必然变成谎话**。
//
// ★指纹（fp）设计★ —— **绝不用数据库 id、也不用行号**（重跑 ingest / 动一行就全变）：
//   A: A|<文件>|<路径>|<该行内容哈希>
//   B: B|<文件>|<退役物>|<该行内容哈希>
//   C: C|<分区>|<两块开头文本的哈希>        ← 块 id 每次 ingest 都变，只能拿内容当身份
//   D: D|<短文件>|<长文件>|<前缀哈希>
//   E: E|<文件>|<相对路径>|<该行内容哈希>
//   F: F|<快照文件>|<目标台账>|<问题种类>          ← **不含行号**（见下面 F 那段注释）
//   **行内容带进指纹是有意的**：正文改对了 → 这一行变了 → 这条发现**自动变"已消失"**，
//   闭环自己闭上，不靠人记得去勾。
//
// 状态：`待裁决` ／ `已改` ／ `保留`(看过决定不动) ／ `作废`(发现本身是误报) ／ `已消失`(不再报)
//   **清零率 = (已改 + 保留 + 作废) ÷ (总数 − 已消失)**
//
// ★它只写自己那个文件★：`<记忆库>/corrections/`，**不碰台账/档案/Vault/任何正文**。
//
// 用法：
//   node memory/tools/findings.mjs                    # 跑体检 → 合并进台账 → 打印
//   node memory/tools/findings.mjs --status           # 只看台账（不跑体检）
//   node memory/tools/findings.mjs --list             # 列出待裁决的
//   node memory/tools/findings.mjs --verdict <fp> <已改|保留|作废> [说明]
//   （换环境/测试用：--registry <路径> --report <体检json> --root <目录> --memdir <目录> --vault <库>）
// 退出码：0 = 没有待裁决；1 = 还有待裁决（**不表示工具坏了**）
//
// ★被别的工具复用（2026-09-14 起）★：`semantic_import.mjs`（语义判官的结果并进本台账）要
//   造**形状与指纹完全一致**的条目 —— 唯一写者原则不能破，所以这里把指纹工厂 `mk` 与
//   `loadReg / saveReg / merge / stats` **导出**给它用，而不是让它自己抄一份（抄一份 = 两个写者）。
//   ⚠️ 代价：本文件从此会被 **import**（而不只是被运行）—— 所以下面那段 CLI 主流程必须用
//      `isMain` 守住（**导入 ≠ 运行**）。这条教训项目里已经踩过一次：`sync_real.mjs` 的顶层
//      `process.exit(0)` 抢在断言前把验证脚本杀掉 → **退出码 0、一句断言都没打 = 假绿**。
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
let ROOT = HERE
for (let i = 0; i < 8; i++) {
  if (existsSync(join(ROOT, 'plugins', 'dsh-memory-app', 'lib', 'index.js'))) break
  ROOT = dirname(ROOT)
}
const DOCTOR = join(ROOT, 'memory', 'tools', 'memory_doctor.mjs')

const argOf = function (name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const MEM = argOf('--memdir', join(homedir(), '.dsh-memory'))
const DIR = join(MEM, 'corrections')
const REG = argOf('--registry', join(DIR, 'findings.json'))
const LAST = join(DIR, 'latest-report.json')

const h = function (s) { return createHash('sha256').update(String(s)).digest('hex').slice(0, 12) }
const nowISO = function () { return new Date().toISOString() }
const isVerdict = function (s) { return ['已改', '保留', '作废'].indexOf(s) >= 0 }

// ── ★指纹工厂：本台账的"唯一身份"就在这里，别的工具必须复用它（不许自己抄一份）★ ──
// ★指纹 = 哈希(检查项 | 目标 | 该行内容) + 人类可读的四个字段★
//   为什么把 `check|target` 也算进哈希：**同一行被 A 和 B 各报一次时，光哈希"行内容"会撞**，
//   于是 `--verdict <前8位>` 会一次匹配两条（实测撞到过）→ 把检查项和目标一起算进去就唯一了。
//   ⚠️ `target` 必须是**稳定**的：A 用路径、B 用退役物名、C 用分区名（**绝不能用块 id**，
//      块 id 每次 ingest 都变）、D 用那对文件、E 用相对路径。
//   哈希算的是"这一行的内容"，所以**正文改对了 → 指纹变了 → 老条目自动变"已消失"**。
export function mk(check, file, target, raw, lineSeed, extra) {
  const x = extra || {}
  return {
    fp: h(check + '|' + target + '|' + lineSeed) + '|' + check + '|' + file + '|' + target,
    check: check,
    file: file,
    target: target,
    detail: String(raw.line || raw.detail || '').slice(0, 160),
    zone: x.zone || '',
    confidence: x.confidence || ''
  }
}

// ── 把体检报告拆成"带稳定指纹的条目" ────────────────────────────────
// ★只收"值得看"的那些★：体检器会把历史区/低置信的也一并报出来（那是给人看的上下文），
//   但**台账里收它们 = 让清零率失去意义**（实测第一次收进来 25 条，真问题只有 6 条）。
// ★指纹种子必须用 `lineKey`（稳定身份），不能用 `line`（给人看的窗口文本）★
//   2026-09-14 踩过：体检器把 `line` 从"从头截 96 字"改成"以命中点为中心开窗口"（为了让裁决时
//   看得见 needle），结果**所有 A/B 条目的指纹全变** → 老裁决档案集体转"已消失"、又冒一批"新增"。
//   **显示格式不是身份。** 体检器现在同时给 `lineKey`（= 老截法，恒定）和 `line`（显示）。
function entriesFrom(R) {
  const out = []
  const ran = []
  if (Array.isArray(R.A)) {
    ran.push('A')
    for (const x of R.A) {
      if (x.zone !== '现状区' || x.retiredSay) continue     // 历史区 / 已说明退役 → 不是问题
      out.push(mk('A', x.file, x.path, x, x.lineKey || x.line, { zone: x.zone, confidence: '高（路径实测不存在）' }))
    }
  }
  if (Array.isArray(R.B)) {
    ran.push('B')
    for (const x of R.B) {
      if (x.zone !== '现状区') continue
      out.push(mk('B', x.file, x.needle, x, x.lineKey || x.line, { zone: x.zone, confidence: x.confidence }))
    }
  }
  if (R.C && !R.C.error) {
    ran.push('C')
    for (const tier of ['high', 'mid']) {
      for (const p of (R.C[tier] || [])) {
        // target 只用分区名（**稳定**，进指纹）；块 id 只放在给人看的 detail 里
        //（块 id 每次 ingest 都变 —— 拿它当身份 = 台账每天都在"发现新问题"）
        const disp = p.ns + '  #' + p.a + ' ↔ #' + p.b + '（相似度 ' + p.sim + '，共同开头 ' + p.sharedHead + ' 字）'
        out.push(mk('C', p.ns, p.ns, { line: disp, detail: disp }, (p.head || '') + '||' + (p.headB || ''), { zone: tier === 'high' ? '高度疑似' : '疑似', confidence: String(p.sim) }))
      }
    }
  }
  if (Array.isArray(R.D)) {
    ran.push('D')
    for (const x of R.D) out.push(mk('D', x.shortFile, x.shortFile + ':' + x.shortLine + ' ⊆ ' + x.longFile + ':' + x.longLine, x, x.prefix, { zone: '现状区', confidence: '' }))
  }
  if (Array.isArray(R.E)) {
    ran.push('E')
    for (const x of R.E) out.push(mk('E', x.file, String(x.rel), x, x.lineKey || x.line, { zone: x.zone, confidence: '高（机械可证）' }))
  }
  if (R.F && Array.isArray(R.F.hits)) {
    ran.push('F')
    for (const x of R.F.hits) {
      // ★指纹的种子**不能带行号**★（`x.where` = `memory\INDEX.md:9` —— 台账一动行号就变，
      //   于是同一条问题会被"重新发现"，正是这个工具存在的意义所要防的）。
      //   所以只用「快照文件 | 目标台账 | 问题种类」当种子：
      //     · 落后 5 个阶段 → 落后 2 个阶段：同一条问题，**种子不变、detail 更新** ✓
      //     · 改对之后：这条发现从上报里消失 → **自动转「已消失」**，闭环自己闭上 ✓
      //   `kind` 也要进种子：同一个快照/台账对上可能同时有"落后"和"没写进度"两种问题。
      const disp = '[' + x.kind + '] ' + x.detail
      out.push(mk('F', x.snap, x.snap + '|' + x.target + '|' + x.kind,
        { line: disp, detail: disp }, x.target + '|' + x.kind,
        { zone: '机械可证', confidence: x.kind }))
    }
  }
  if (R.G && Array.isArray(R.G.hits)) {
    ran.push('G')
    for (const x of R.G.hits) {
      // 种子 = 「会话 uuid | 问题种类」：**不含 mtime/时长**（那些每次跑都在变 → 会天天"重新发现"）
      const disp = '[' + x.kind + '] ' + x.detail
      out.push(mk('G', 'corpus', x.target + '|' + x.kind, { line: disp, detail: disp },
        x.target + '|' + x.kind, { zone: '机械可证', confidence: x.kind }))
    }
  }
  if (R.H && Array.isArray(R.H.hits)) {
    ran.push('H')
    for (const x of R.H.hits) {
      // 种子 = 「文档 | 问题种类 | 哪个探针」：**不含行号、不含具体数字**（都会变）
      const disp = '[' + x.kind + '] ' + x.detail
      out.push(mk('H', x.file, x.target, { line: disp, detail: disp }, x.target, { zone: '机械可证', confidence: x.kind }))
    }
  }
  return { entries: out, ran: ran }
}

// ── 读/写台账 ───────────────────────────────────────────────────────
// file 参数是给**别的工具/夹具**用的（临时台账）；不传就写默认那份 —— CLI 行为一字不变。
export function loadReg(file) {
  try { return JSON.parse(readFileSync(file || REG, 'utf8')) } catch (_e) { return { version: 1, updatedAt: null, entries: [] } }
}
export function saveReg(reg, file) {
  const f = file || REG
  mkdirSync(dirname(f), { recursive: true })
  reg.updatedAt = nowISO()
  writeFileSync(f, JSON.stringify(reg, null, 1), 'utf8')
}

// ── 合并（本工具的核心逻辑）─────────────────────────────────────────
export function merge(reg, incoming, ranChecks) {
  const byFp = new Map(reg.entries.map(function (e) { return [e.fp, e] }))
  const seen = new Set()
  const t = nowISO()
  let added = 0, back = 0
  for (const it of incoming) {
    seen.add(it.fp)
    const prev = byFp.get(it.fp)
    if (prev) {
      prev.lastSeen = t
      prev.seenCount = (prev.seenCount || 1) + 1
      prev.detail = it.detail
      if (prev.status === '已消失') { prev.status = '待裁决'; prev.reappear = (prev.reappear || 0) + 1; back++ }
    } else {
      byFp.set(it.fp, Object.assign({}, it, { firstSeen: t, lastSeen: t, seenCount: 1, status: '待裁决', verdictNote: null, verdictAt: null }))
      added++
    }
  }
  // ★只在"这个检查本次真的跑成功了"时才把没出现的标成已消失★
  //   （否则 C 因为读不到 Vault 而跳过 → 把它全部标消失 = **台账在撒谎**，正是要防的病）
  let gone = 0
  for (const e of byFp.values()) {
    if (seen.has(e.fp)) continue
    if (e.status === '已消失') continue
    if (ranChecks.indexOf(e.check) < 0) continue
    e.status = '已消失'
    e.lastSeen = t
    gone++
  }
  reg.entries = [...byFp.values()].sort(function (a, b) {
    const order = { '待裁决': 0, '已改': 1, '保留': 2, '作废': 3, '已消失': 4 }
    const d = (order[a.status] || 9) - (order[b.status] || 9)
    return d !== 0 ? d : String(a.fp).localeCompare(String(b.fp))
  })
  return { added: added, back: back, gone: gone }
}

// ── 统计 ────────────────────────────────────────────────────────────
export function stats(reg) {
  const live = reg.entries.filter(function (e) { return e.status !== '已消失' })
  const pend = live.filter(function (e) { return e.status === '待裁决' })
  const done = live.filter(function (e) { return isVerdict(e.status) })
  return {
    total: reg.entries.length,
    live: live.length,
    pend: pend,
    pendCount: pend.length,
    done: done.length,
    gone: reg.entries.filter(function (e) { return e.status === '已消失' }).length,
    rate: live.length === 0 ? 1 : done.length / live.length
  }
}

function printStatus(reg, verbose) {
  const s = stats(reg)
  console.log('═'.repeat(78))
  console.log('  ⑤校验层 · 裁决台账')
  console.log('═'.repeat(78))
  console.log('  台账文件 ' + REG)
  console.log('  条目 ' + s.total + ' ｜ **在报的 ' + s.live + '** ｜ 待裁决 ' + s.pendCount + ' ｜ 已裁决 ' + s.done + ' ｜ 已消失 ' + s.gone)
  console.log('  ★清零率 ' + (s.rate * 100).toFixed(0) + '%  = ' + s.done + ' ÷ ' + s.live + '（V8 判据：矛盾 100% 标出并裁决留档）')
  if (s.pendCount) {
    console.log('')
    console.log('  ── 待裁决 ' + s.pendCount + ' 条 ──')
    for (const e of (verbose ? s.pend : s.pend.slice(0, 12))) {
      console.log('   [' + e.fp.slice(0, 8) + '] ' + e.check + ' · ' + e.zone + (e.confidence ? ' · ' + e.confidence : ''))
      console.log('        ' + e.file + '  →  ' + e.target)
      console.log('        ' + e.detail)
    }
    console.log('')
    console.log('  裁决：node memory/tools/findings.mjs --verdict <前8位> <已改|保留|作废> [说明]')
  } else {
    console.log('  ✓ 没有待裁决的（清零率 100%）')
  }
  console.log('═'.repeat(78))
}

// ══════════════════ 主流程（★只在"直接运行本文件"时才跑★）══════════════════
// 本文件现在会被 `semantic_import.mjs` import（复用指纹工厂与合并逻辑）。
// 如果 import 也跑主流程，就会：① 读真台账 ② 甚至**跑体检 + 写台账** —— "导入 = 悄悄做事"，
// 正是 `sync_real.mjs` 那次假绿事故（顶层 `process.exit(0)` 抢在断言前杀进程）的同一个根因。
// 所以用 isMain 守住：**导入 ≠ 运行**。
const isMain = (function () {
  try {
    if (process.argv[1] === undefined || process.argv[1] === null) return false
    const self = realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    const main = realpathSync(process.argv[1]).toLowerCase()
    return self === main
  } catch (_e) { return false }
})()

function main() {
  const VI = process.argv.indexOf('--verdict')
  const VERDICT_FP = VI >= 0 ? process.argv[VI + 1] : null

  if (VI >= 0) {
    const status = process.argv[VI + 2]
    const note = process.argv[VI + 3] || null
    if (!VERDICT_FP) { console.log('用法：--verdict <指纹前几位> <已改|保留|作废> [说明]'); process.exit(1) }
    if (!isVerdict(status)) { console.log('✗ 状态只能是 已改 / 保留 / 作废'); process.exit(1) }
    const reg = loadReg()
    const hit = reg.entries.filter(function (e) { return e.fp.indexOf(VERDICT_FP) === 0 })
    if (hit.length === 0) { console.log('✗ 找不到指纹以「' + VERDICT_FP + '」开头的条目'); process.exit(1) }
    if (hit.length > 1) { console.log('✗ 前 8 位撞了 ' + hit.length + ' 条，请多给几位'); process.exit(1) }
    hit[0].status = status
    hit[0].verdictAt = nowISO()
    hit[0].verdictNote = note
    saveReg(reg)
    console.log('✓ 已落档：[' + hit[0].fp.slice(0, 8) + '] → ' + status + (note ? '（' + note + '）' : ''))
    console.log('  （注意：**台账只记录裁决，不会去改任何正文** —— 改不改、怎么改，仍由你定）')
    printStatus(reg, true)
    process.exit(0)
  }

  if (process.argv.indexOf('--status') >= 0 || process.argv.indexOf('--list') >= 0) {
    const reg = loadReg()
    if (!existsSync(REG)) { console.log('（台账还不存在：' + REG + '）'); process.exit(0) }
    printStatus(reg, process.argv.indexOf('--list') >= 0)
    process.exit(stats(reg).pendCount === 0 ? 0 : 1)
  }

  // 跑体检（走文件，不走管道 —— 免得撞沙箱的命名管道限制），然后合并
  mkdirSync(DIR, { recursive: true })
  const reportPath = argOf('--report', LAST)
  if (argOf('--report', null) === null) {
    const args = [DOCTOR, '--json', reportPath]
    for (const f of ['--root', '--memdir', '--vault']) {
      const v = argOf(f, null)
      if (v !== null) args.push(f, v)
    }
    try {
      execFileSync(process.execPath, args, { stdio: 'ignore' })
    } catch (e) {
      const code = (e && typeof e.status === 'number') ? e.status : 1
      if (code !== 1) { console.log('✗ 体检器没跑起来（退出码 ' + code + '）'); process.exit(1) }
      // 退出码 1 = "有发现"，是**正常**的，不是失败
    }
  }
  if (!existsSync(reportPath)) { console.log('✗ 没有体检报告：' + reportPath); process.exit(1) }

  const R = JSON.parse(readFileSync(reportPath, 'utf8'))
  const parsed = entriesFrom(R)
  const reg = loadReg()
  const m = merge(reg, parsed.entries, parsed.ran)
  saveReg(reg)

  console.log('  本次体检：本次上报 ' + parsed.entries.length + ' 条（检查项 ' + parsed.ran.join('/') + '）')
  console.log('  台账变化：新增 ' + m.added + ' ｜ 复发 ' + m.back + ' ｜ 转为已消失 ' + m.gone)
  printStatus(reg, false)
  process.exit(stats(reg).pendCount === 0 ? 0 : 1)
}

if (isMain) main()
