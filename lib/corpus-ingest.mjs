// 会话日志摄取核心 —— **放在插件里**（这样别人装了插件就自带，不依赖我的工作区目录）。
//
// 一次产出四样（都在输出目录，默认 `~/.dsh-memory/corpus/`）：
//   1. <uuid>.md            每份会话的人可读全文（**开头带折叠摘要**）
//   2. index.json           程序用的索引（id/标题/工作区/预设/字节/字符）——**老契约，形状不变**
//   3. INDEX_CARDS.md       ★会话索引卡★（目录层，切块进 Vault 的 `会话` 分区供语义检索）
//   4. .ingest-state.json   ★幂等"出生证"★（每份会话：源日志 size/mtime/最大 seq/折叠次数/卡片原文）
//
// ★三条设计依据（2026-09-14 定，都有实测）★
//   ① **纯 Node 解多帧 zstd**：按帧切（magic 28 B5 2F FD）逐帧解，107913 帧 0 失败。
//      当年注释里"必须用 Python"是错的（那是"整份丢给解压器"试出来的结论）。
//   ② **幂等靠"出生证"**：源日志的 `size + mtime` 没变 → **连文件都不碰**（不重写、不重新嵌入）。
//      实测：老版本没有这个判断，跑一次 = 89 份全量重写。
//   ③ **折叠摘要是白捡的**：DSH 折叠时本来就让模型写了一份结构化摘要（`compaction/summary`，
//      实测 9071~10394 字、`llmStreamCall: true`）。**直接拿来用，零额外模型调用、零外发。**
//      它写进正文开头（正文不限长）+ 卡片从它抽定位句（卡片 ≤500 字符的铁律照旧）。
//
// ★卡片格式铁律（2026-09-12 踩出来的，别改）★
//   每张卡 = 「`## 会话卡 <短id> · <日期> · <标题>` 标题 + 一整段正文」，
//   **≤500 字符、正文里不许出现 `- ` 项目符号** —— 切块器在每个 `- ` 处强制分块，
//   多条目卡会被切成 2-3 块，只有第一块带得上标题，其余碎片"没有主语"。
//
// ⚠️ **别在别处再写一份**：本文件是唯一实现。CLI（`memory/tools/ingest_corpus.mjs`）只是薄壳。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

export const CARD_MAX = 500
export const STATE_FILE = '.ingest-state.json'
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// ── ★入库打码（2026-09-16 用户拍板）★ ─────────────────────────────────────
// 起因：**真事** —— 用户把 GitHub token 贴进聊天，转写落盘后 token 就**明文躺在
//   `<记忆库>/corpus/*.md` 里**，还顺带进了会话卡、进了备份、进了 Vault 的检索面。
//   记忆系统的本职就是"把会话留下来"，所以**它得自己负责不让密钥跟着留下来**。
// ★打码发生在"落盘之前"★（不是检索时才过滤）—— 没落盘 = 备份里没有、Vault 里也没有。
// ★不许静默★：打了几处要回报（`redacted` 计数），否则这就是"不报错的谎"。
// ★只打"一眼就是密钥"的形状★：宁可漏掉像密码的普通词，也别把正常内容吃掉。
export const REDACT_RULES = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_［已打码］'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, 'gh?_［已打码］'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-［已打码］'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-［已打码］'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA［已打码］'],
  [/xox[baprse]-[A-Za-z0-9-]{10,}/g, 'xox?［已打码］'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '［已打码：私钥块］']
]

// ★打码规则换代号★：**改了 REDACT_RULES 就 +1**。它进 `.ingest-state.json`，
//   一变就把**已落盘的旧正文全部重转一遍**（否则老文件里那批密钥永远留在那儿 ——
//   这正是"快照式索引必须有重建触发器"那条：没有触发器，索引必然变成谎话、而且不报错）。
export const REDACT_VERSION = 1

/** 返回 { text, hits }。hits > 0 必须回报给人看，不许静默。 */
export function redactText(s) {
  if (typeof s !== 'string' || s === '') return { text: s, hits: 0 }
  let text = s, hits = 0
  for (const pair of REDACT_RULES) {
    text = text.replace(pair[0], function () { hits++; return pair[1] })
  }
  return { text: text, hits: hits }
}

/** 多帧 zstd 解压 —— ★这就是当年被判定"Node 做不到"的那一步★ */
export function decompressMultiFrame(buf) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  if (offs.length === 0) throw new Error('这不是 zstd 数据（找不到帧头）')
  const parts = []
  let failed = 0
  for (let k = 0; k < offs.length; k++) {
    const end = (k + 1 < offs.length) ? offs[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))) } catch (_e) { failed++ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offs.length, failed: failed }
}

// ★码点安全，但**不许把整串铺成数组**★（2026-09-15 真事故，来源：用户一份会话日志长到 71 MB）
//   原来这里是 `Array.from(s)`：对齐 Python 的 `len()` 语义**是对的**，**做法是错的** ——
//   日志解出来是 **1.37 亿字符**，`Array.from` 要先建一个 1.37 亿元素的数组 →
//   抛 `RangeError: Invalid array length` → **正文写了、卡片条目没建** → 会话卡**无声地少一张**。
//   现在改成**逐字符增量数**：时间仍是 O(n)，额外内存从 O(n) 降到 **O(1)**。
//   ⚠️ 判据（码点语义）**一个字没变**：`lenCP('𝄞') === 1`，`truncate` 不会把代理对劈成半个。
function cpIndex(s, n) {
  // 返回"前 n 个码点"在 UTF-16 里的下标；不足 n 个码点就返回 s.length
  let i = 0, count = 0
  while (i < s.length && count < n) {
    const c = s.charCodeAt(i)
    const pair = c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF
    i += pair ? 2 : 1
    count++
  }
  return i
}
function lenCP(s) {
  const t = String(s)
  let n = 0, i = 0
  while (i < t.length) {
    const c = t.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < t.length) {
      const d = t.charCodeAt(i + 1)
      if (d >= 0xDC00 && d <= 0xDFFF) i++
    }
    i++; n++
  }
  return n
}
function truncate(s, n) {
  s = String(s).replace(/\x00/g, '')
  const total = lenCP(s)
  return total <= n ? s : s.slice(0, cpIndex(s, n)) + '\n…[截断 ' + (total - n) + ' 字符]…'
}
function oneline(s, n) {
  const one = String(s).replace(/\x00/g, '').split(/\s+/).filter(Boolean).join(' ')
  const total = lenCP(one)
  return total <= n ? one : one.slice(0, cpIndex(one, n)) + '…'
}

function extractText(blocks) {
  const out = []
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text') { if (b.text) out.push(b.text) }
    else if (b.type === 'tool-result') out.push.apply(out, extractText(b.content))
  }
  return out
}

const pad = function (n) { return String(n).padStart(2, '0') }
function fmtLocal(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 一条"用户发言"其实是系统注入（不是人说的话）→ 做卡片时要跳过 */
function isNoise(msg) {
  const s = String(msg).replace(/^\s+/, '')
  if (s.startsWith('<system-reminder>')) return true
  const head = s.slice(0, 200)
  for (const pat of ['Current runtime context', 'This snapshot supersedes',
    'This is an automatically generated checkpoint', 'The following workspace instructions']) {
    if (head.indexOf(pat) >= 0) return true
  }
  return false
}

/** 从折叠摘要里抽"定位句"：压成一段、去掉 markdown 记号与项目符号（卡片不许有 `- `） */
function summaryLede(summary, n) {
  const flat = String(summary).split(/\r?\n/).map(function (l) {
    return l.replace(/^#{1,6}\s*/, '').replace(/^\s*[-*+]\s*/, '').replace(/^\s*\d+\.\s*/, '').trim()
  }).filter(Boolean).join(' ')
  return oneline(flat, n)
}

/** 把一段日志渲染成转写正文 + 元信息（含最大 seq / 折叠次数 / 最后一次折叠摘要） */
export function renderSession(sid, lines) {
  const meta = { cwd: '', preset: '', created: null }
  let title = ''
  const events = []
  const userMsgs = []
  let toolCalls = 0
  let maxSeq = 0
  let compactions = 0
  let summary = ''
  for (const ln of lines) {
    let o
    try { o = JSON.parse(ln) } catch (_e) { continue }
    if (typeof o.seq === 'number' && o.seq > maxSeq) maxSeq = o.seq
    const t = o.type
    if (t === 'session') { meta.cwd = o.cwd || ''; meta.preset = o.agentPreset || ''; meta.created = o.createdAt }
    else if (t === 'session/title') { title = (o.data && o.data.title) || '' }
    else if (t === 'compaction/end') { compactions++ }
    else if (t === 'compaction/summary') {
      // ★白捡的那份摘要★：DSH 折叠时让模型写的结构化浓缩，最后一份 = 到最新折叠点为止的全貌
      const txts = extractText(o.data && o.data.summary)
      if (txts.length) summary = txts.join('\n\n')
      if (!txts.length && o.data && typeof o.data.rawOutput === 'string') summary = o.data.rawOutput
    } else if (t === 'user/message') {
      const txts = extractText(o.data && o.data.content)
      if (txts.length) { const joined = txts.join('\n'); events.push(['用户', joined]); userMsgs.push(joined) }
    } else if (t === 'assistant/message') {
      const txts = extractText(o.data && o.data.message && o.data.message.content)
      if (txts.length) events.push(['助手', txts.join('\n')])
    } else if (t === 'tool/call') {
      const d = o.data || {}
      toolCalls++
      events.push(['工具调用', '`' + (d.name || '?') + '`\n' + truncate(d.arguments || '', 1200)])
    } else if (t === 'tool/result') {
      const txts = extractText(o.data && o.data.message && o.data.message.content)
      if (txts.length) events.push(['工具结果', truncate(txts.join('\n'), 3000)])
    }
  }
  const created = meta.created ? fmtLocal(meta.created) : ''
  const md = ['# 会话转写 ' + sid, '',
    '- 标题: ' + (title || '(无)'),
    '- 工作区: ' + (meta.cwd || ''),
    '- 预设: ' + (meta.preset || ''),
    '- 创建时间: ' + created,
    '- 折叠: ' + compactions + ' 次' + (summary ? '（最后一份摘要 ' + lenCP(summary) + ' 字）' : ''),
    '', '---', '']
  if (summary) {
    md.push('## 折叠摘要（DSH 自动生成 · 本会话最新一次折叠的全貌）', '', summary, '', '---', '')
  }
  for (const [kind, txt] of events) { md.push('## ' + kind, '', txt, '') }
  // ★入库打码★：渲染完、交出去之前先过一遍 —— md / 标题 / 摘要 / 用户发言都会进语料或卡片
  const rMd = redactText(md.join('\n'))
  const rTitle = redactText(title)
  const rSum = redactText(summary)
  const rMsgs = userMsgs.map(function (m) { return redactText(m) })
  const redacted = rMd.hits + rTitle.hits + rSum.hits + rMsgs.reduce(function (a, x) { return a + x.hits }, 0)
  return {
    md: rMd.text, title: rTitle.text, meta: meta, maxSeq: maxSeq, compactions: compactions, summary: rSum.text,
    redacted: redacted,
    stats: { userMsgs: rMsgs.map(function (x) { return x.text }), turns: userMsgs.length, tools: toolCalls }
  }
}

/** 造一张卡（**必须 ≤ CARD_MAX 且正文无 `- ` 项目符号**） */
export function buildCard(sid, title, meta, stats, created, chars, summary, compactions) {
  const short = sid.replace('session-', '').slice(0, 8)
  const day = created ? created.split(' ')[0] : '?'
  const head = '## 会话卡 ' + short + ' · ' + day + ' · ' + oneline(title || '(无标题)', 40)
  const tail = '工作区 ' + oneline(meta.cwd || '', 40) + '。规模 ' + stats.turns + ' 轮用户发言 / ' +
    stats.tools + ' 次工具调用 / ' + chars + ' 字符。' +
    (summary ? '折叠 ' + compactions + ' 次，摘要 ' + lenCP(summary) + ' 字。' : '') +
    '全文 `corpus/' + sid + '.md`（直接 read/grep 即可）。'
  // 正文长度 = 总量 - 标题 - 固定尾巴，留给"定位句"；不够就再收
  let lede
  if (summary) {
    lede = summaryLede(summary, 170)
    for (let n = 170; n > 20; n -= 20) {
      const body = '会话 ' + sid + '：' + lede + '。' + tail
      if (lenCP(head) + 1 + lenCP(body) <= CARD_MAX) break
      lede = summaryLede(summary, n)
    }
  } else {
    const real = stats.userMsgs.filter(function (m) { return !isNoise(m) })
    const parts = []
    real.slice(0, 3).forEach(function (m, i) { const s = oneline(m, i === 0 ? 95 : 70); if (s) parts.push('「' + s + '」') })
    lede = parts.join('／')
  }
  let body = '会话 ' + sid + '：' + (lede || '（无用户发言）') + '。' + tail
  if (lenCP(head) + 1 + lenCP(body) > CARD_MAX) {
    const keep = CARD_MAX - lenCP(head) - 1 - lenCP(body) - 1
    body = '会话 ' + sid + '：' + oneline(String(lede).slice(0, Math.max(10, 160 + keep)), 160) + '。' + tail
  }
  return head + '\n' + body
}

function readState(outDir) {
  const p = join(outDir, STATE_FILE)
  if (!existsSync(p)) return { version: 1, sessions: {} }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    if (!s || typeof s !== 'object' || typeof s.sessions !== 'object' || s.sessions === null) return { version: 1, sessions: {} }
    return s
  } catch (_e) { return { version: 1, sessions: {} } }
}

/**
 * ★"这份日志有没有变过"的唯一判据（出生证比较）★
 *   `entry` = `.ingest-state.json` 里上次登记的那条；`stat` = 源日志现在的 stat；`mdPath` = 转写正文路径。
 *   三者对得上（登记过 + 正文还在 + size 相同 + mtime 取整秒相同）→ 视为**没变过**，连文件都不碰。
 *
 * ★为什么必须抽成一个函数，不许各写一份★（2026-09-14 拿真事故换来的）：
 *   这条判据原先在 `ingestCorpus`（真处理）和 `planCorpus`（只问不做）里**各写了一遍**，
 *   而回归夹具又自己写了第三套（`size:round(mtimeMs)`）。**三份实现 = 三种答案**。
 *   实测后果：夹具把"正在被写入的活会话"当成"没变过" → **随机报红**，而且两次红点名的
 *   会话**每次都不一样**（`d1ac246d` / `c7d234f2`）—— 正是"活会话"的特征，不是代码坏。
 *   ★判据只能有一份实现★：产品两条路径、回归夹具、以后任何新调用方，**都调这个函数**。
 */
export function isFresh(entry, stat, mdPath) {
  return !!(entry && stat && existsSync(mdPath) &&
    entry.size === stat.size && entry.mtime === Math.floor(stat.mtimeMs))
}

/** 列扫描目标：[{ws, id, log}] */
export function scanTargets(sessionsRoot, wsFilter, only) {
  const out = []
  if (!existsSync(sessionsRoot)) return out
  for (const ws of readdirSync(sessionsRoot).sort()) {
    const wsDir = join(sessionsRoot, ws)
    try { if (!statSync(wsDir).isDirectory()) continue } catch (_e) { continue }
    if (wsFilter && ws.indexOf(wsFilter) < 0) continue
    for (const id of readdirSync(wsDir).sort()) {
      if (only && id.indexOf(only) < 0) continue
      const log = join(wsDir, id, 'session.jsonl.zstd')
      if (existsSync(log)) out.push({ ws: ws, id: id, log: log })
    }
  }
  return out
}

/**
 * 摄取（幂等）。返回一份报告，不抛（单份出错记进 problems）。
 * @param {object} o
 *   sessionsRoot 会话日志根（默认 ~/.dsh/sessions）
 *   outDir       输出目录（默认 ~/.dsh-memory/corpus）
 *   wsFilter     只取工作区名含该子串的
 *   only         只处理 id 含该子串的会话（插件折叠时用）
 *   max          本次最多真处理几份（0 = 不限）；**扫描永远全扫，只是限量"动手"**
 *   dry          不写任何文件
 */
export function ingestCorpus(o) {
  const opt = o || {}
  const SESS_ROOT = opt.sessionsRoot || join(homedir(), '.dsh', 'sessions')
  const OUT_DIR = opt.outDir || join(homedir(), '.dsh-memory', 'corpus')
  const only = opt.only || null
  const max = typeof opt.max === 'number' ? opt.max : 0
  const dry = !!opt.dry

  const t0 = Date.now()
  const targets = scanTargets(SESS_ROOT, opt.wsFilter || null, only)
  // ★目录必须先建★：第一版把 mkdirSync 写在后面（写索引那一段），于是**每份都 ENOENT** ——
  //   夹具/试跑当场抓到。顺序错了不报"目录不存在"，而是每份都失败一遍，很难看出来。
  if (!dry) mkdirSync(OUT_DIR, { recursive: true })
  const state = readState(OUT_DIR)
  // ★打码规则换代 → 已落盘的旧正文全部重转★（只多跑一次，之后状态里就记上了）
  const redactStale = (state.redactVersion || 0) !== REDACT_VERSION
  const problems = []

  // ① 先只看元数据（stat 是几微秒的事）—— 这就是"看一眼不动手"
  const need = []
  for (const t of targets) {
    let st
    try { st = statSync(t.log) } catch (_e) { continue }
    const prev = state.sessions[t.id]
    const mdPath = join(OUT_DIR, t.id + '.md')
    if (redactStale || !isFresh(prev, st, mdPath)) need.push({ t: t, st: st, prev: prev })
  }
  need.sort(function (a, b) { return b.st.mtimeMs - a.st.mtimeMs })   // 新的先做
  const deferred = max > 0 && need.length > max
  const work = max > 0 ? need.slice(0, max) : need

  let written = 0, frames = 0, chars = 0, redacted = 0
  const next = Object.assign({}, state.sessions)
  for (const w of work) {
    try {
      const buf = readFileSync(w.t.log)
      const dec = decompressMultiFrame(buf)
      if (dec.failed > 0) problems.push([w.t.id, '有 ' + dec.failed + ' 帧解不开'])
      frames += dec.frames
      const lines = dec.text.split('\n').filter(function (x) { return x.trim() !== '' })
      const r = renderSession(w.t.id, lines)
      redacted += r.redacted || 0
      const created = r.meta.created ? fmtLocal(r.meta.created) : ''
      const card = buildCard(w.t.id, r.title, r.meta, r.stats, created, lenCP(r.md), r.summary, r.compactions)
      if (!dry) writeFileSync(join(OUT_DIR, w.t.id + '.md'), r.md, 'utf8')
      chars += lenCP(r.md)
      written++
      next[w.t.id] = {
        ws: w.t.ws, size: w.st.size, mtime: Math.floor(w.st.mtimeMs), maxSeq: r.maxSeq,
        compactions: r.compactions, summaryChars: lenCP(r.summary), card: card, title: r.title,
        cwd: r.meta.cwd, preset: r.meta.preset, created: r.meta.created,
        bytes: lenCP(dec.text), chars: lenCP(r.md), frames: dec.frames,
        generatedAt: new Date().toISOString()
      }
    } catch (e) {
      problems.push([w.t.id, 'ERR:' + ((e && e.message) || e)])
    }
  }

  // ② 索引与卡片：**内容没变就不写**（避免 mtime 抖动 → 避免白白触发重新嵌入）
  const ids = Object.keys(next).sort()
  const index = ids.map(function (id) {
    const s = next[id]
    return { session: id, title: s.title, cwd: s.cwd, preset: s.preset, bytes: s.bytes, chars: s.chars, frames: s.frames, ws: s.ws }
  })
  const cardsText = ids.map(function (id) { return next[id].card }).join('\n\n') + '\n'
  let wroteIndex = false, wroteCards = false
  // ★安全闸：全失败时**绝不动索引与卡片**★
  //   第一版没这道闸：试跑时 3 份全 ENOENT，它照样把 `INDEX_CARDS.md` 写成**空文件** ——
  //   等于"一次出错把真语料的目录层清了"。**宁可什么都不写，也不能用空结果覆盖好的结果。**
  const allFailed = need.length > 0 && written === 0
  if (!dry && !allFailed) {
    mkdirSync(OUT_DIR, { recursive: true })
    const same = function (p, text) { try { return existsSync(p) && readFileSync(p, 'utf8') === text } catch (_e) { return false } }
    const ip = join(OUT_DIR, 'index.json'), cp = join(OUT_DIR, 'INDEX_CARDS.md'), sp = join(OUT_DIR, STATE_FILE)
    const iText = JSON.stringify(index, null, 1)
    if (!same(ip, iText)) { writeAtomic(ip, iText); wroteIndex = true }
    if (!same(cp, cardsText)) { writeAtomic(cp, cardsText); wroteCards = true }
    // 状态文件也一样**内容没变就不写**：它每次跑都会被"看"，没必要每次都动 mtime
    const sText = JSON.stringify({ version: 1, redactVersion: REDACT_VERSION, updatedAt: new Date().toISOString(), sessions: next }, null, 1)
    if (!same(sp, sText)) writeAtomic(sp, sText)
  }

  return {
    sessionsRoot: SESS_ROOT, outDir: OUT_DIR, scanned: targets.length, needed: need.length,
    processed: written, skipped: targets.length - need.length, deferred: deferred ? need.length - work.length : 0,
    wroteIndex: wroteIndex, wroteCards: wroteCards, allFailed: allFailed, problems: problems, frames: frames, chars: chars, redacted: redacted, redactStale: redactStale,
    seconds: Math.round((Date.now() - t0) / 100) / 10, dry: dry
  }
}

/** 原子写：先写 .tmp 再改名（避免插件与 CLI 同时跑时读到半截文件） */
function writeAtomic(p, text) {
  const tmp = p + '.tmp' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, p)
}

/** 只回答"有哪些需要转写"（不写任何东西）—— 设置页按钮 / 开机补扫用它先问一句 */
export function planCorpus(o) {
  const opt = o || {}
  const SESS_ROOT = opt.sessionsRoot || join(homedir(), '.dsh', 'sessions')
  const OUT_DIR = opt.outDir || join(homedir(), '.dsh-memory', 'corpus')
  const state = readState(OUT_DIR)
  const targets = scanTargets(SESS_ROOT, opt.wsFilter || null, opt.only || null)
  const need = []
  for (const t of targets) {
    let st
    try { st = statSync(t.log) } catch (_e) { continue }
    const prev = state.sessions[t.id]
    const mdPath = join(OUT_DIR, t.id + '.md')
    if (!isFresh(prev, st, mdPath)) {
      need.push({ id: t.id, ws: t.ws, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  need.sort(function (a, b) { return b.mtimeMs - a.mtimeMs })
  return { scanned: targets.length, need: need }
}
