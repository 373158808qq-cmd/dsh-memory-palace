// Vault 同步（普适版）—— 让"索引永不过期"，跑在插件里，跟着插件走。
//
// ★为什么需要★：索引是快照，**没有重建触发器就必然变成谎话、而且不报错**
//   （`embeddings.json` 就是这么烂掉的：改文件从没重建 → 一直喂过期文本）。
//
// ★普适性铁律（本文件不许违反）★
//   1. **不写死任何用户路径** —— 源码里不出现具体工作区路径、不出现用户名（可被 grep 审计：
//      这个文件的正文里除了这里，不该有任何盘符路径）。
//   2. 固定位置靠 `memDir`（由调用方给，插件自己知道在哪）；**其它一律靠"扫"**。
//   3. **没有台账的工作区也要能正常工作** —— 扫不到就跳过并如实报告，**不报错、不崩**。
//   4. 只重建**变了**的（哈希比对），省算力、也避免无谓重写。
//
// 发现规则（对任何用户都成立）：
//   固定：<memDir>/USER.md + MEMORY.md      → 分区 `core`
//         <memDir>/SOP.md                    → 分区 `规则`
//         <memDir>/corpus/INDEX_CARDS.md     → 分区 `会话`
//   扫描：<cwd>/**/PROJECT_LEDGER.md          → 合并进分区 `台账`
//         <cwd>/**/PROJECT_LEDGER_ARCHIVE.md → 每个进**它所在文件夹名**的分区（如 voice）
//         <cwd>/knowledge/**/*.md            → 合并进分区 `知识`
//         <memDir>/impressions/*.md          → 合并进分区 `impressions`（⑥ 懂你层，见下面 impressionsText）
//   目录：<cwd>/memory/VAULT_INDEX.md 存在 → 直接用（方案 B 的手写部分）
//         不存在 → **自动生成一份兜底目录**（方案 B 的兜底部分）
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'

const SKIP = /(^|[\\/])(node_modules|\.git|pylibs|pylibs312|runtime|logs|backups|_trash|\.ptmp|\.npm-cache|\.ollama-models|产出物|\.venv|venv|dist|build)([\\/]|$)/i
const MAX_DEPTH = 4

function sha(text) { return createHash('sha256').update(text).digest('hex').slice(0, 16) }

/** 档案该进哪个分区？—— **用"它所在的文件夹名"**。
 *
 *  ★这里走过一次弯路，记下来别重蹈★：我一开始想"从同目录台账的标题行读项目名"（`# PROJECT_LEDGER — X`），
 *    以为更准。实测**不可靠**：标题是给人看的中文（`桌面启动脚本`、`DSH 升级与插件适配`、`PPT / 生图 / 海报`），
 *    跟分区名（`desktop-scripts` / `dsh-upgrade` / `ppt`）对不上 —— 修好一个、弄坏四个。
 *  **正解：分区名 = 文件夹名**。理由：① 可预测、不用维护映射表；② 任何用户的目录命名都能直接成立；
 *    ③ 跟已有分区（voice/ppt/upload/dsh-upgrade/desktop-scripts）一致。
 *  ⚠️ 遗留：本项目文件夹叫 `memory`，而它的档案以前进的是 `记忆系统` 分区 → 需要把旧的 `记忆系统` 删掉，
 *     让内容统一到 `memory`（**同一份内容两个分区名 = 重复，会把正确那块挤出检索前列**）。 */
function nsForArchive(archivePath) {
  return dirname(archivePath).split(/[\\/]/).pop() || '档案'
}

/** 扫出工作区里所有 PROJECT_LEDGER*.md（不写死路径，任何用户的工作区都能扫） */
function findLedgers(cwd) {
  const out = { ledgers: [], archives: [] }
  const walk = function (dir, depth) {
    if (depth > MAX_DEPTH) return
    let items = []
    try { items = readdirSync(dir) } catch (_e) { return }
    for (const it of items) {
      const p = join(dir, it)
      if (SKIP.test(p)) continue
      let st
      try { st = statSync(p) } catch (_e) { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (it === 'PROJECT_LEDGER.md') out.ledgers.push(p)
      else if (it === 'PROJECT_LEDGER_ARCHIVE.md') out.archives.push(p)
    }
  }
  walk(cwd, 0)
  return out
}

/** 自动生成兜底目录（方案 B 的兜底部分：手写的那份不存在时才用） */
function autoIndex(dir, found) {
  const L = []
  L.push('# VAULT_INDEX（自动生成）')
  L.push('')
  L.push('> 这份是**扫出来的兜底目录**（工作区里没有手写的 `memory/VAULT_INDEX.md`）。')
  L.push('> 每条 = 一个可检索的位置。')
  L.push('')
  L.push('## 核心记忆')
  L.push('- **USER.md**（用户画像，每轮注入）：他是谁、他怎么判断事情。拿不准该怎么做时按它推断。')
  L.push('- **MEMORY.md**（长期记忆，每轮注入）：跨项目的环境事实与最痛的教训。踩坑前先看。')
  L.push('- **SOP.md**（协作规则，设置页勾选后每轮注入）：怎么干活、交付门槛。规矩不明时查它。')
  L.push('')
  L.push('## 项目台账（进度：到哪了、还有什么没做）')
  for (const p of found.ledgers) {
    L.push('- **' + relative(dir, p).replace(/\\/g, '/') + '**：这个项目的台账 —— 当前状态 / 待办 / 铁律 / 关键位置。')
  }
  if (found.ledgers.length === 0) L.push('- （这个工作区没发现台账 —— 正常，不是所有用户都用台账）')
  L.push('')
  L.push('## 项目档案（细节：怎么做的、证据）')
  for (const p of found.archives) {
    L.push('- **' + relative(dir, p).replace(/\\/g, '/') + '**：这个项目的档案 —— 每次修复的根因、实测数字、证据全文。')
  }
  if (found.archives.length === 0) L.push('- （没发现档案）')
  L.push('')
  L.push('## 会话原文（最底层兜底：当时到底说了什么）')
  L.push('- **`~/.dsh-memory/corpus/<uuid>.md`**：单份会话的人可读全文。先靠会话卡定位再读它。')
  L.push('- **`<DSH_HOME>/sessions/<workspace>/<UUID>/session.jsonl.zstd`**：★最底层兜底★ 原始日志（多帧 zstd，需 Python `zstandard.stream_reader`；**Node 自带 zstd 解不了多帧**）。')
  return L.join('\n')
}

/**
 * 主入口。只重建**变了**的；返回状态供 UI 显示。
 * @param {{cwd:string, memDir:string, ingest:Function, log?:Function, dryRun?:boolean, force?:boolean}} o
 *
 * ★`dryRun` 必须由本函数负责"别写状态"★（2026-09-12 踩出来的）：
 *   状态文件是"这个分区的这个哈希已经进库了"的**断言**。我一开始让调用方自己传一个"不落库的 ingest"，
 *   结果 syncVault 照样把状态写了 → **状态说"已同步 88 块"，库里却还是旧的 123 行**。
 *   这正是我们一直在防的病：**快照式索引一旦不再反映真实，就会变成无声的谎话**。
 *   → 所以"要不要落库"和"要不要写状态"必须由**同一个开关**控制，不能一个归调用方、一个归本函数。
 */
export async function syncVault(o) {
  const cwd = o.cwd
  const memDir = o.memDir
  const ingest = o.ingest
  const log = o.log || function () {}
  const dryRun = o.dryRun === true      // 只算不写：不进库、**也不写状态**
  const force = o.force === true        // 忽略哈希，全部当"变了"（库被改乱后推倒重来用）
  const stateFile = join(memDir, 'vault-sync.json')

  // ── ★跨进程写库闸★（2026-09-14 真事故后加的）────────────────────────────
  // 事故：分区写入是"**先 DELETE 整个分区、再逐块 INSERT**"。同一个进程里早有 `withNsLock` 串行化，
  //   但**插件（跑在 DSH 里）与 CLI（我手跑）是两个进程** —— 用户重启 DSH 后插件 6 秒开跑 boot 同步，
  //   我同一时间手跑 `resync_vault --force`，两个进程同时 DELETE/INSERT 同一个分区 →
  //   **部分块被写了两份**：实测 `memory` **914 行只有 473 唯一**、`会话` 156/94、`台账` 122/77。
  //   而重复块会把正确那条**挤出检索前列**（用户此前就因重复吃过检索变差的亏）。
  // → 闸摆到**进程外面**：一个锁文件，谁先拿到谁写，另一个**等**（等比拒绝更符合"我就是想同步一下"）。
  // ★认主人规则（与 Ollama PID 文件同一条教训）★：锁里记 pid，**主人已死 = 陈锁 → 直接接管**，
  //   否则一次强杀会留下永远解不开的锁，把后续同步全堵死。
  const wantLock = !dryRun && o.noLock !== true
  let locked = false
  let waitedMs = 0
  if (wantLock) {
    const waitMs = typeof o.lockWaitMs === 'number' ? o.lockWaitMs : 5 * 60 * 1000
    let got = tryTakeLock(memDir, o.lockLabel || 'syncVault')
    while (!got.ok && waitedMs < waitMs) {
      await new Promise(function (r) { setTimeout(r, 2000) })
      waitedMs += 2000
      got = tryTakeLock(memDir, o.lockLabel || 'syncVault')
    }
    if (!got.ok) {
      const holder = got.holder || {}
      log('[vault-sync] ⏳ 另一个同步正在写库（pid ' + holder.pid + '，已等 ' + Math.round(waitedMs / 1000) + ' 秒）' +
        ' → **本次一个字节都不写**（同时写会把块写重）')
      return {
        ok: false, busy: true, total: 0, changed: 0, skipped: [], rebuilt: [], failed: [],
        holder: holder, waitedMs: waitedMs, at: new Date().toISOString(),
        discovered: { cwd: cwd, ledgers: [], archives: [], handIndex: false, namespaces: [] }
      }
    }
    locked = true
  }

  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch (_e) { state = {} }

  const found = findLedgers(cwd)

  // ── 组装"每个分区要入档什么" ──
  const jobs = []
  const coreParts = []
  for (const f of ['USER.md', 'MEMORY.md']) {
    const p = join(memDir, f)
    if (existsSync(p)) coreParts.push(readFileSync(p, 'utf8').trim())
  }
  if (coreParts.length) jobs.push({ ns: 'core', label: 'USER.md + MEMORY.md', text: coreParts.join('\n\n') })

  const sop = join(memDir, 'SOP.md')
  if (existsSync(sop)) jobs.push({ ns: '规则', label: 'SOP.md', text: readFileSync(sop, 'utf8') })

  const cards = join(memDir, 'corpus', 'INDEX_CARDS.md')
  if (existsSync(cards)) jobs.push({ ns: '会话', label: 'corpus/INDEX_CARDS.md', text: readFileSync(cards, 'utf8') })

  // 项目卡片（②目录层的项目卡）—— 工作区里若有就一起同步进 `index` 分区
  const projCards = join(cwd, 'memory', 'INDEX_CARDS.md')
  if (existsSync(projCards)) jobs.push({ ns: 'index', label: 'memory/INDEX_CARDS.md', text: readFileSync(projCards, 'utf8') })

  // ── 知识库：`knowledge/` 下所有 .md → `知识` 分区 ──────────────────────────
  // ★为什么必须进 Vault★：用户要的是"我需要时能查到我这有没有这个能力"。文件躺在磁盘上**检索不到**；
  //   切块入库后才进得了 `memory_search` —— 这是"把能力装进我里面"的最后一步。
  // ★与 checkVault 共用同一个 `knowledgeText()`★：免得"同步走一套、检查走另一套"（切块器那次的教训）。
  const kb = knowledgeText(cwd)
  if (kb) jobs.push({ ns: '知识', label: 'knowledge/ 下 ' + kb.files + ' 份', text: kb.text })

  // ── ⑥ 懂你档案：`<memDir>/impressions/*.md` → `impressions` 分区 ────────────
  // ★为什么必须在插件里★：它原来只有手跑的 CLI（`do_ingest_impressions.mjs`）—— 用户改一条"懂你"，
  //   没有触发器重建，**过期了也不报错**。接进来之后 boot 同步 + `checkVault` 都覆盖它。
  // ★空源 = 不建作业（`impressionsText` 返回 null）★：宁可不做，也不能拿空文本把分区清掉。
  const impr = impressionsText(memDir)
  if (impr) jobs.push({ ns: 'impressions', label: 'impressions/ 下 ' + impr.files + ' 份', text: impr.text })

  if (found.ledgers.length) {
    jobs.push({
      ns: '台账', label: found.ledgers.length + ' 份台账',
      text: found.ledgers.map(function (p) { return '<!-- ' + relative(cwd, p).replace(/\\/g, '/') + ' -->\n' + readFileSync(p, 'utf8').trim() }).join('\n\n\n')
    })
  }
  for (const p of found.archives) {
    const ns = nsForArchive(p)   // ★从台账标题读项目名，别用文件夹名（见 nsForArchive 注释）
    jobs.push({ ns: ns, label: relative(cwd, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
  }

  // ── 目录（方案 B）──
  const handIdx = join(cwd, 'memory', 'VAULT_INDEX.md')
  const idxText = existsSync(handIdx) ? readFileSync(handIdx, 'utf8') : autoIndex(cwd, found)
  jobs.push({ ns: '目录', label: existsSync(handIdx) ? 'memory/VAULT_INDEX.md（手写）' : '自动生成', text: idxText })

  // ── 只重建变了的 ──
  const changed = []
  const skipped = []
  for (const j of jobs) {
    const h = sha(j.text)
    if (!force && state[j.ns] && state[j.ns].hash === h) { skipped.push(j.ns); continue }
    changed.push({ job: j, hash: h })
  }

  const result = { ok: true, dryRun: dryRun, force: force, total: jobs.length, changed: changed.length, skipped: skipped, rebuilt: [], failed: [], at: new Date().toISOString() }
  for (const c of changed) {
    try {
      // dryRun 透传给 ingest —— 由它保证"只切块、不落库"；状态写入由本函数统一跳过
      const r = await ingest({ text: c.job.text, namespace: c.job.ns, maxChars: 500, dryRun: dryRun })
      result.rebuilt.push({ ns: c.job.ns, label: c.job.label, chunks: r.chunks, embedded: r.embedded })
      if (!dryRun) state[c.job.ns] = { hash: c.hash, label: c.job.label, chunks: r.chunks, at: result.at }
      log('[vault-sync] ' + (dryRun ? '（试算）' : '') + '重建 ' + c.job.ns + ' ← ' + c.job.label + '：' + r.chunks + ' 块')
    } catch (e) {
      // ★ 嵌入失败**不写状态**，这样下次还会重试；也**不删库**（ingestToVault 自己保证先清后写且失败不动库）
      result.ok = false
      result.failed.push({ ns: c.job.ns, label: c.job.label, error: String((e && e.message) || e) })
      log('[vault-sync] ✗ ' + c.job.ns + ' 失败：' + result.failed[result.failed.length - 1].error)
    }
  }
  if (!dryRun) {
    if (changed.length === 0) state.__lastNoop = result.at
    try { mkdirSync(memDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8') } catch (_e) {}
  }

  // ── 给 UI 的状态（含"发现"情况，让用户看得见它到底认出了什么）──
  result.discovered = {
    cwd: cwd,
    ledgers: found.ledgers.map(function (p) { return relative(cwd, p).replace(/\\/g, '/') }),
    archives: found.archives.map(function (p) { return relative(cwd, p).replace(/\\/g, '/') }),
    handIndex: existsSync(handIdx),
    namespaces: Object.keys(state).filter(function (k) { return k !== '__lastNoop' })
  }
  if (locked) releaseLock(memDir)
  return result
}

// ── 跨进程锁：一个文件 + "认主人" ─────────────────────────────────────────
/** 锁最长认 10 分钟：超时就算主人还活着也接管（一次同步实测最慢 5 分钟，10 分钟足够宽松） */
const LOCK_TTL_MS = 10 * 60 * 1000
function lockFile(memDir) { return join(memDir, 'vault-sync.lock') }
function lockOwnerAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}
/** 尝试拿锁：陈锁（主人已死 / 超过 TTL）直接接管；拿不到就把持有者报回去 */
export function tryTakeLock(memDir, label) {
  const p = lockFile(memDir)
  let cur = null
  try { cur = JSON.parse(readFileSync(p, 'utf8')) } catch (_e) { cur = null }
  if (cur && typeof cur.pid === 'number' && cur.pid !== process.pid) {
    const age = Date.now() - Number(cur.at || 0)
    if (age < LOCK_TTL_MS && lockOwnerAlive(cur.pid)) return { ok: false, holder: cur }
  }
  try {
    mkdirSync(memDir, { recursive: true })
    writeFileSync(p, JSON.stringify({ pid: process.pid, at: Date.now(), label: label || '' }), 'utf8')
  } catch (_e) {
    return { ok: true }   // 写不了锁文件就别假装锁上了 —— 宁可不锁，也别把同步永久堵死
  }
  return { ok: true }
}
/** 只释放**自己的**锁（别人接管过就不许删） */
export function releaseLock(memDir) {
  try {
    const cur = JSON.parse(readFileSync(lockFile(memDir), 'utf8'))
    if (cur && cur.pid === process.pid) rmSync(lockFile(memDir), { force: true })
  } catch (_e) {}
}

/** 只读检查：跟 syncVault 同一套发现逻辑，但不写库 —— 用来在 UI 上显示"过期了没"
 *
 * ★2026-09-12 加：状态不能只"自称"、还要**对得上库**★
 *   状态文件记的是"这个分区的这个哈希，已经以 N 块的形式进库了"。原来只比哈希，
 *   于是出过一次**状态说已同步、其实库里是旧的**：我用一个"不落库的 ingest"跑试算，
 *   syncVault 照样把状态写了 → 之后所有检查都被骗过去，脏数据一直躺在库里没人发现。
 *   现在多一道：`counts`（调用方从库里数出来的真实行数）跟状态里记的块数**必须相等**，
 *   不等就报 `stale` 并给出 `mismatched` 明细。**能自己发现自己在撒谎。**
 * @param {{cwd:string, memDir:string, counts?:Object}} o
 */
export function checkVault(o) {
  const stateFile = join(o.memDir, 'vault-sync.json')
  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch (_e) { state = {} }
  const found = findLedgers(o.cwd)
  const stale = []
  const mismatched = []
  const counts = o.counts || null
  const checkOne = function (ns, text) {
    if (!text) return
    const h = sha(text)
    if (!state[ns] || state[ns].hash !== h) { stale.push(ns); return }
    // 哈希对得上 ≠ 内容真在库里 —— 还要核块数
    if (counts && typeof counts[ns] === 'number' && typeof state[ns].chunks === 'number' && counts[ns] !== state[ns].chunks) {
      stale.push(ns)
      mismatched.push({ ns: ns, claimed: state[ns].chunks, actual: counts[ns] })
    }
  }
  const coreParts = []
  for (const f of ['USER.md', 'MEMORY.md']) {
    const p = join(o.memDir, f)
    if (existsSync(p)) coreParts.push(readFileSync(p, 'utf8').trim())
  }
  if (coreParts.length) checkOne('core', coreParts.join('\n\n'))
  const sop = join(o.memDir, 'SOP.md')
  if (existsSync(sop)) checkOne('规则', readFileSync(sop, 'utf8'))
  const cards = join(o.memDir, 'corpus', 'INDEX_CARDS.md')
  if (existsSync(cards)) checkOne('会话', readFileSync(cards, 'utf8'))
  const projCards = join(o.cwd, 'memory', 'INDEX_CARDS.md')
  if (existsSync(projCards)) checkOne('index', readFileSync(projCards, 'utf8'))
  const kb = knowledgeText(o.cwd)
  if (kb) checkOne('知识', kb.text)
  // ★⑥ 懂你档案也要"过期检测"覆盖★ —— 只接写入不接检查 = 过期了没人知道（那正是这一项要治的病）
  const impr = impressionsText(o.memDir)
  if (impr) checkOne('impressions', impr.text)
  if (found.ledgers.length) {
    checkOne('台账', found.ledgers.map(function (p) { return '<!-- ' + relative(o.cwd, p).replace(/\\/g, '/') + ' -->\n' + readFileSync(p, 'utf8').trim() }).join('\n\n\n'))
  }
  for (const p of found.archives) {
    const ns = nsForArchive(p)   // ★同上：从台账标题读项目名
    checkOne(ns, readFileSync(p, 'utf8'))
  }
  const s = Object.keys(state).filter(function (k) { return k !== '__lastNoop' }).map(function (k) { return { ns: k, at: state[k].at, chunks: state[k].chunks } })
  const kbN = knowledgeText(o.cwd)
  return { synced: s, stale: stale, staleCount: stale.length, mismatched: mismatched, counts: counts, lastAt: state.__lastNoop || (s.length ? s.map(function (x) { return x.at }).sort().pop() : null), discovered: { cwd: o.cwd, ledgers: found.ledgers.length, archives: found.archives.length, knowledge: kbN ? kbN.files : 0 } }
}

/** 把工作区 `knowledge/` 下**所有** `.md` 拼成一份文本（带 `<!-- 相对路径 -->` 来源行）+ 份数 + 清单。
 *  ★`syncVault`（写入）、`checkVault`（核对）、`build-view`（入口页那节）**共用这一个实现**★ ——
 *    三处各写一套"哪些文件算知识库"是必然漂开的（这个项目已经为"两份实现"付过代价）。
 *  没有 `knowledge/` 目录（别人不一定用）→ 返回 null，一切照常，不报错。 */
export function knowledgeText(cwd) {
  const root = join(cwd, 'knowledge')
  if (!existsSync(root)) return null
  const files = []
  const walk = function (dir) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (_e) { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue          // 跳过 .obsidian 这类
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (/\.md$/i.test(e.name)) files.push(p)
    }
  }
  walk(root)
  if (!files.length) return null
  files.sort()
  const list = files.map(function (p) { return relative(cwd, p).replace(/\\/g, '/') })
  const text = files.map(function (p, i) {
    return '<!-- ' + list[i] + ' -->\n' + readFileSync(p, 'utf8').trim()
  }).join('\n\n\n')
  return { text: text, files: files.length, list: list }
}

/** 把「懂你档案」（`<memDir>/impressions/*.md`，⑥ 懂你层）拼成一份文本 + 份数 + 清单。
 *
 *  ★为什么它必须住在插件里（而不是只留一个 CLI 脚本）★（2026-09-15）：
 *    `impressions/` 原先只靠手跑 `memory/tools/do_ingest_impressions.mjs` 入档 —— 也就是
 *    **"生成即会过期"的快照**：用户改了一条"懂你"，没有任何触发器重建它，过期了也不报错。
 *    这正是本文件开头那条铁律要治的病（`embeddings.json` 就是这么烂掉的）。
 *    → 接进 boot 同步 + `checkVault` 之后，它跟 core/规则/知识 一样**有自己的重建触发器**。
 *
 *  ★"同一份文件两种切法 = 会切出两种库"★：`syncVault`（boot 写入）、`checkVault`（核对）、
 *    `do_ingest_impressions.mjs`（CLI）**共用这一个实现**（跟 `knowledgeText` 同一条纪律）。
 *    拼法**逐字保持** CLI 原来那套：`<!-- 来源：impressions/<文件名> -->\n<正文 trim>` + `\n\n\n` 连接
 *    —— 换一个字节，哈希就变、全分区会被无谓重切（实测该拼法与已入库那份哈希一致）。
 *
 *  ★源空/缺失才返回 null（= 不建这个作业）—— 口径与 `knowledgeText`、台账、档案**逐一相同**★：
 *    没有 `impressions/` 目录、或目录里一份 .md 都没有 → 返回 null → 分区**一个字节都不动**
 *    （ingest 是"先清后写"，**给一个空文本等于把分区清空**）。
 *
 *  ★2026-09-15（用户拍板）删掉了那条"总量 <100 字就冻结"的特殊保护★：
 *    它单给 impressions 加了一条**别处都没有的**闸 —— 后果是源一小，分区就**静默冻结**：
 *    不重建、不清空、**也不报过期**（`syncVault` 不建作业、`checkVault` 同样看不到它）。
 *    这正是本项目最恨的那类"无声区"：状态看着没问题，内容其实是旧的。
 *    现在与台账/档案那些作业完全同款：**只要有 .md 就一定建作业**（50 字的画像也该进库），
 *    只有"源真的没有了"才不动 —— 那一条不是保护，是"别拿空文本清库"。
 *  ⚠️ 只读：本函数**绝不写** `impressions/` 下的任何文件（那是用户的东西）。 */
export function impressionsText(memDir) {
  const root = join(memDir, 'impressions')
  if (!existsSync(root)) return null
  let names = []
  try { names = readdirSync(root) } catch (_e) { return null }
  const files = names.filter(function (f) { return /\.md$/i.test(f) && f[0] !== '.' }).sort()
  if (files.length === 0) return null
  const parts = files.map(function (f) {
    return '<!-- 来源：impressions/' + f + ' -->\n' + readFileSync(join(root, f), 'utf8').trim()
  })
  const text = parts.join('\n\n\n')
  // ⚠️ 这里**不再有**"总量 <100 字就返回 null"那条特例（2026-09-15 删，理由见上面函数头）。
  // `parts` 也一起给出去：CLI 要"逐文件切块报数"，**别让它在外面再拼一遍**（那就又是两份实现）
  return { text: text, files: files.length, list: files, parts: parts }
}
