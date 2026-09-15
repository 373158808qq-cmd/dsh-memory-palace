// 懂你记忆系统：压缩守卫 + 台账纪律 + 本地语义检索 + 抽查考试（host 插件）
// ① systemPrompt.context 每步装配时同步读 AGENTS.md + PROJECT_LEDGER.md 注入（每步刷新不累积）。
// ② systemPrompt.section 台账维护纪律（所有预设每轮注入）。
// ③ memory_search 工具：本地 Ollama 嵌入 + 余弦 topK，零外发语义检索。
// ④ memory_quiz 工具：抽查考试记分 + 成绩回读（错题进纠错闭环）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { execFile, spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { syncVault, checkVault } from './vault-sync.mjs'
// ⑧ 显示层：记忆视图生成器（**与 CLI 共用同一份实现** —— `memory/tools/build_view.mjs` 是薄壳）
//   ★为什么插件要调它★：DSH 启动时那次自动同步走的是**插件侧这条路**，它只重建 Vault 分区、
//   不刷视图 → 重启一次「记忆视图」就停在旧版（这是 2026-09-14 留下的最后一个技术缺口）。
import { buildView } from './build-view.mjs'
import { ingestCorpus, planCorpus } from './corpus-ingest.mjs'
// ⑤ 校验层 · 语义判官：机械测不出的那类矛盾，用"现在这个模型"判（只读 Vault、只写结果文件）
import { runSemanticScan } from './semantic-judge.mjs'
import { registerInitRoutes, writeInit as initWizardWriteInit } from './init-wizard.mjs'
// 维护作业（体检/裁决台账/分层/预算/状态核对/能力清单/备份）—— 实现在 `lib/tools/`，
// 2026-09-16 随插件发布（原来只住在本项目的 `memory/tools/`，换台电脑就没有了；那边现在只剩薄壳）。
import { registerMaintainRoutes } from './maintain.mjs'

export const name = 'dsh-memory-app'
export const inject = ['systemPrompt', 'tools', 'webServer']

const OLLAMA = 'http://127.0.0.1:11434/api/embeddings'
const MODEL = 'qwen3-embedding:0.6b'

function cap(text, n) {
  if (text.length <= n) return text
  return text.slice(0, n) + '\n…[截断]…'
}

function readFile(cwd, fname) {
  try {
    const p = join(cwd, fname)
    if (!existsSync(p)) return ''
    return readFileSync(p, 'utf8')
  } catch (_e) { return '' }
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function norm(v) {
  const n = Math.sqrt(dot(v, v)) || 1
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

let indexCache = null
function loadIndex() {
  if (indexCache !== null) return indexCache
  try {
    const raw = readFileSync(join(homedir(), '.dsh-memory', 'embeddings.json'), 'utf8')
    indexCache = JSON.parse(raw).records || []
  } catch (_e) { indexCache = [] }
  return indexCache
}

// 走统一配置（设置页改的就是它）；失败返回空数组，让调用方走"没嵌入"的分支。
async function embed(text) {
  try { return await embedText(effectiveEmbedder(), text) } catch (_e) { return [] }
}

function quizFile() {
  return join(homedir(), '.dsh-memory', 'quiz', 'quiz.jsonl')
}

function sopFile() {
  return join(homedir(), '.dsh-memory', 'SOP.md')
}

function sopFlagFile() {
  return join(homedir(), '.dsh-memory', 'sop.enabled')
}

// ── ⑨ 自动转写（会话 → 转写 + 卡片）：开关与运行 ────────────────────────────
// ★开关方向为什么和 `sop.enabled` 相反★：SOP 是**可选叠加层**（默认关、装了才有），
//   而"会话转写"是这个记忆系统的**核心功能**（默认开、装了就该工作）。
//   所以这里用**反向标记**：存在 `corpus.disabled` 才关。不想用的人有一个明确的关法。
function corpusDisabledFile() {
  return join(homedir(), '.dsh-memory', 'corpus.disabled')
}
function corpusAutoLogFile() {
  return join(homedir(), '.dsh-memory', 'corpus-auto.log')
}
function corpusAutoEnabled() {
  return !existsSync(corpusDisabledFile())
}
/** 触发日志（只留最近 200 行）—— 唯一的"它到底跑没跑"的证据，出问题全靠它 */
function logCorpusAuto(line) {
  try {
    const p = corpusAutoLogFile()
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const lines = prev.split('\n').filter(function (x) { return x.trim() !== '' })
    lines.push(new Date().toISOString() + '  ' + line)
    writeFileSync(p, lines.slice(-200).join('\n') + '\n', 'utf8')
  } catch (_e) {}
}

let corpusRunning = false
let corpusPending = false
let corpusSyncTimer = null

/** 转写完（卡片真的变了）之后，**延迟**重建 Vault 的 `会话` 分区 —— 防抖，别每次折叠都嵌一遍 */
function scheduleVaultSyncAfterCorpus() {
  if (corpusSyncTimer !== null) return
  corpusSyncTimer = setTimeout(function () {
    corpusSyncTimer = null
    runVaultSync('corpus').catch(function () {})
  }, 30000)
}

/**
 * 自动转写（串行 + 合并重复请求）。
 * @param {string} reason boot / compaction / manual / pending
 * @param {string|null} only 只处理这个会话（折叠时用）
 * @param {number} max 本次最多处理几份（0 = 不限）
 */
async function runAutoTranscribe(reason, only, max) {
  if (!corpusAutoEnabled()) return { ok: false, skipped: 'disabled' }
  if (corpusRunning) { corpusPending = true; return { ok: false, skipped: 'busy' } }
  corpusRunning = true
  try {
    const r = ingestCorpus({ only: only || null, max: typeof max === 'number' ? max : (only ? 1 : 5) })
    logCorpusAuto(reason + (only ? ' [' + only + ']' : '') + ' → 扫 ' + r.scanned + ' ／ 需 ' + r.needed +
      ' ／ 写 ' + r.processed + (r.wroteCards ? ' ／ 卡片已更新' : '') + (r.problems.length ? ' ／ 问题 ' + r.problems.length : ''))
    if (r.wroteCards) scheduleVaultSyncAfterCorpus()
    return { ok: true, report: r }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    logCorpusAuto(reason + ' 失败：' + msg)
    return { ok: false, error: msg }
  } finally {
    corpusRunning = false
    if (corpusPending) {
      corpusPending = false
      setTimeout(function () { runAutoTranscribe('pending').catch(function () {}) }, 5000)
    }
  }
}

/** GET /dsh-memory-app/corpus/status —— 只读：开关状态 + 待转写清单 + 最近触发记录 */
async function corpusStatusHandler(req, res) {
  try {
    const p = planCorpus({})
    let tail = []
    try {
      const f = corpusAutoLogFile()
      if (existsSync(f)) tail = readFileSync(f, 'utf8').split('\n').filter(function (x) { return x.trim() !== '' }).slice(-5)
    } catch (_e) {}
    sendJson(res, 200, {
      ok: true,
      enabled: corpusAutoEnabled(),
      disabledBy: corpusAutoEnabled() ? null : corpusDisabledFile(),
      scanned: p.scanned,
      needCount: p.need.length,
      need: p.need.slice(0, 10).map(function (x) { return { id: x.id, kb: Math.round(x.size / 1024) } }),
      recent: tail
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

/** POST /dsh-memory-app/corpus/run —— 手动补转写。默认最多 5 份；带 `{"all":true}` 则不限 */
async function corpusRunHandler(req, res) {
  try {
    // ★读请求体必须**一定会结束**★：只在 `end` 上 resolve 的话，客户端断连/不发 end 会让这个
    //   处理器永远挂着（2026-09-14 桩测试当场卡住 → `Detected unsettled top-level await`）。
    //   所以 end / error / close 三者任一都算"读完了"，再加 2 秒兜底。
    const body = await new Promise(function (resolve) {
      let done = false
      const finish = function (v) { if (!done) { done = true; resolve(v) } }
      let buf = ''
      try {
        req.on('data', function (c) { buf += c })
        req.on('end', function () { finish(buf) })
        req.on('error', function () { finish(buf) })
        req.on('close', function () { finish(buf) })
      } catch (_e) { finish('') }
      setTimeout(function () { finish(buf) }, 2000)
    })
    let all = false
    try { all = !!(JSON.parse(body || '{}').all) } catch (_e) {}
    const r = await runAutoTranscribe('manual', null, all ? 0 : 5)
    sendJson(res, 200, r)
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

function defaultSopText() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), 'default-sop.md')
    if (existsSync(p)) return readFileSync(p, 'utf8')
  } catch (_e) {}
  return '# 协作 SOP + 工程规范（默认）\n\n（默认 SOP 文件缺失，请手动完善）\n'
}

function sopHandler(req, res) {
  try {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ on: existsSync(sopFlagFile()) }))
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {}
          if (parsed.on) {
            // 开：SOP.md 只存内容、永久保留；缺内容时才用默认模板补一份
            if (!existsSync(sopFile())) writeFileSync(sopFile(), defaultSopText(), 'utf8')
            writeFileSync(sopFlagFile(), '1', 'utf8')
          } else {
            // 关：只删开关标志，不删 SOP.md 内容
            rmSync(sopFlagFile(), { force: true })
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ on: existsSync(sopFlagFile()) }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: String((e && e.message) || e) }))
        }
      })
      return
    }
    res.statusCode = 405
    res.end()
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String((e && e.message) || e) }))
  }
}

// ═══════════ 嵌入器配置（与 dsh-persist 本地分叉共用同一个文件）═══════════
// 默认值/推导必须与分叉的 resolveEmbedder() 保持一致，否则设置页显示 ≠ 引擎实际使用。
function memDir() { return join(homedir(), '.dsh-memory') }
function embedderFile() { return join(memDir(), 'embedder.json') }

/** 「额外注入清单」：`~/.dsh-memory/inject.json` = `{ "files": ["<绝对路径>", ...] }`
 *  为什么需要：压缩守卫只注入【当前目录】下的 AGENTS.md / PROJECT_LEDGER.md，
 *  而项目住在子文件夹里 —— 在根目录开会话就看不到了。把要盯的文件列进来即可。
 *  每轮重读（改完下一次调用即生效，不用重启）。 */
function injectFiles() {
  try {
    const p = join(memDir(), 'inject.json')
    if (!existsSync(p)) return []
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j === null || typeof j !== 'object' || !Array.isArray(j.files)) return []
    return j.files
      .filter(function (x) { return typeof x === 'string' && x.trim() !== '' })
      .map(function (x) { return x.trim() })
  } catch (_e) { return [] }
}

// ★2026-09-16★ 默认值 / isLocal / configured 这段判断搬到 `./embedder-cfg.mjs`（**一份实现**）——
//   初始化向导也要判"嵌入器配好没有"，两处各写一份迟早不一致，而这类不一致的表现就是**假绿/假红**。
//   注：ESM 的 `import` 声明会被提升，写在文件中间同样合法（所以能在原位置直接换成 import）。
import { effectiveEmbedderFrom } from './embedder-cfg.mjs'

function readEmbedderCfg() {
  try {
    const p = embedderFile()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) || {}
  } catch (_e) {}
  return {}
}

function effectiveEmbedder() { return effectiveEmbedderFrom(readEmbedderCfg()) }

async function fetchJson(url, ms, init) {
  let res
  try {
    res = await fetch(url, Object.assign({}, init || {}, { signal: AbortSignal.timeout(ms) }))
  } catch (e) {
    // 只说 "fetch failed" 等于没说：把地址与底层原因（ECONNREFUSED / 超时）一并报出来
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : ''
    throw new Error('连不上 ' + url + '（' + ((e && e.message) || e) + (cause ? ' / ' + cause : '') + '）')
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url)
  return res.json()
}

/** 按配置嵌入一段文字：本地走 Ollama 原生接口（带 options 控制设备/上下文），云端走 OpenAI 格式。 */
async function embedText(cfg, text) {
  if (cfg.isLocal) {
    const options = { num_ctx: cfg.numCtx }
    if (cfg.device === 'cpu') {
      options.num_gpu = 0
    } else if (cfg.device !== '' && cfg.device !== 'auto') {
      const i = Number(cfg.device)
      if (Number.isInteger(i) && i >= 0) options.main_gpu = i
    }
    const j = await fetchJson(cfg.endpoint + '/api/embeddings', 120000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt: text, options })
    })
    return Array.isArray(j.embedding) ? j.embedding : []
  }
  if (cfg.key === '') throw new Error('云端模式未填 API Key')
  const j = await fetchJson(cfg.endpoint, 30000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ model: cfg.model, input: [text] })
  })
  return (j.data && j.data[0] && j.data[0].embedding) || []
}

function cosine(a, b) {
  if (!a.length || a.length !== b.length) return 0
  return dot(norm(a), norm(b))
}

/** 显卡列表（给下拉写具体卡名用）。拿不到就返回空数组，前端会退回"#0/#1"。 */
let gpuCache = null;
function listGpus() {
  const now = Date.now();
  if (gpuCache !== null && now - gpuCache.at < 15000) return Promise.resolve(gpuCache.list);
  return new Promise(function (resolve) {
    try {
      execFile('nvidia-smi',
        ['--query-gpu=index,name,memory.total,memory.used', '--format=csv,noheader,nounits'],
        { timeout: 6000, windowsHide: true },
        function (err, stdout) {
          if (err || !stdout) { resolve([]); return; }
          const list = String(stdout).trim().split(/\r?\n/).filter(Boolean).map(function (line) {
            const p = line.split(',').map(function (s) { return s.trim(); });
            return { id: p[0], name: p[1] || ('GPU ' + p[0]), totalMiB: Number(p[2]) || 0, usedMiB: Number(p[3]) || 0 };
          });
          gpuCache = { at: Date.now(), list: list };
          resolve(list);
        });
    } catch (_e) { resolve([]); }
  });
}

/** 状态：让用户一眼看到"它现在到底在不在工作、降级了没有"。 */
async function embedderStatus() {
  const cfg = effectiveEmbedder()
  const out = { config: cfg, ollamaUp: null, models: [], modelPresent: null, loaded: null, gpus: [], hint: '', pull: pullState, warming: warmState }
  if (cfg.isLocal) out.gpus = await listGpus()
  if (!cfg.isLocal) {
    out.hint = cfg.key === '' ? '云端模式但还没填 API Key → 会退化成关键词检索' : '云端模式：记忆内容会发到这个服务'
    return out
  }
  try {
    const tags = await fetchJson(cfg.endpoint + '/api/tags', 4000)
    out.ollamaUp = true
    out.models = (tags.models || []).map(function (m) { return m.name })
    out.modelPresent = out.models.indexOf(cfg.model) >= 0
    if (!out.modelPresent) {
      out.hint = (pullState !== null && pullState.model === cfg.model && pullState.done === false)
        ? '正在拉取模型…'
        : '模型不在本机 → 点下面的「拉取该模型」下载它'
    }
  } catch (e) {
    out.ollamaUp = false
    out.modelPresent = false
    out.hint = 'Ollama 没在运行（' + cfg.endpoint + '）→ 现在退化成关键词检索'
    await noteOrphanRunners(out)
    return out
  }
  try {
    const ps = await fetchJson(cfg.endpoint + '/api/ps', 4000)
    const m = (ps.models || [])[0]
    if (m) out.loaded = { name: m.name, sizeMiB: Math.round(m.size / 1048576), vramMiB: Math.round(m.size_vram / 1048576) }
  } catch (_e) {}
  out.orphanRunners = { count: 0, pids: [] }
  await noteOllamaOwner(out)
  return out
}

/** 残留检测：Ollama 服务没在应答，但 "跑模型的子进程" llama-server.exe 还在 → 显存没还。
 *  这件事必须说出来：否则用户会看到"设置页说没运行、任务管理器却占着 2 GB"的矛盾画面。
 *  （2026-09-12 用户就是这么发现的；根因是退出时只杀了直接子进程，见 process.on('exit') 的注释。） */
async function noteOrphanRunners(out) {
  const runners = await listProcessPids('llama-server.exe')
  out.orphanRunners = { count: runners.length, pids: runners.map(function (r) { return r.pid }) }
  if (runners.length > 0) {
    out.hint = 'Ollama 服务没在运行，但检测到 ' + runners.length +
      ' 个本地模型进程（llama-server）仍占着显存 —— 多半是上次没退干净的残留。点下面「清理残留进程」可以收掉。'
  }
  return out
}

/** 判断"这个 Ollama 是不是本 DSH 启动的"，并在"不是"时给前端一条**明确警告**。
 *
 *  ★ 为什么必须说出来（2026-09-12 用户实测反馈）★：
 *    Ollama 可能不是 DSH 启动的 —— 而是**托盘程序 / 开机自启**启动的（实测：`ollama app.exe` 是它的父进程）。
 *    那种情况下 DSH **故意不收它**（这条规矩是用户教的：多实例共用一份记忆库时，
 *    "清理"必须先认出"这是谁的"，否则会抢着杀别人的 Ollama）。
 *    于是用户看到的现象就是：**关掉 DSH，显存没还回来** —— 而设置页什么都不说，等于骗人。
 *    所以：认出来 → **说清楚"关 DSH 不会收它"** → 给一个**要用户自己点**的按钮（不做自动收）。
 */
async function noteOllamaOwner(out) {
  out.externalOllama = { mine: true, count: 0, pids: [] }
  try {
    const rec = readPidRecord()
    const mine = rec !== null && Number(rec.owner) === process.pid
    const procs = await listProcessPids('ollama.exe')
    out.externalOllama = { mine: mine, count: procs.length, pids: procs.map(function (p) { return p.pid }) }
    if (!mine && procs.length > 0) {
      out.externalOllama.warn =
        '这个 Ollama 不是 DSH 启动的（多半是 Ollama 托盘程序或开机自启）。' +
        'DSH 不会去动"不是自己启动的" Ollama —— 所以关掉 DSH 之后，它和它加载的模型会继续占着显存。' +
        '要现在就收掉，点下面「收掉这个 Ollama」。'
    }
  } catch (_e) {}
  return out
}

/** 自检：只测嵌入器本身，不写 Vault、不留任何痕迹。 */
async function embedderSelftest() {
  const cfg = effectiveEmbedder()
  if (!cfg.configured) return { ok: false, message: '还没配置（云端模式要填 API Key）' }
  const A = '会议决定把新品发布的日子挪到十月十五号，因为要等包装先到位。'
  const B = '新品什么时候上线'
  const C = '服务器日志保留七天，超过期限自动清理。'
  const t0 = Date.now()
  let va, vb, vc
  try {
    va = await embedText(cfg, A)
    vb = await embedText(cfg, B)
    vc = await embedText(cfg, C)
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: '嵌入失败：' + String((e && e.message) || e) }
  }
  const ms = Date.now() - t0
  if (!va.length || !vb.length || !vc.length) return { ok: false, ms: ms, message: '拿不到向量（看状态提示）' }
  const sameThing = Math.round(cosine(va, vb) * 1000) / 1000
  const unrelated = Math.round(cosine(va, vc) * 1000) / 1000
  const gap = Math.round((sameThing - unrelated) * 1000) / 1000
  return {
    ok: gap >= 0.06,
    dims: va.length,
    sameThing: sameThing,
    unrelated: unrelated,
    gap: gap,
    ms: ms,
    message: gap >= 0.06
      ? '语义检索可用：换种说法能对上（' + sameThing + '），跟无关内容拉得开（' + unrelated + '）'
      : '可疑：「换说法」(' + sameThing + ') 不比「无关」(' + unrelated + ') 高多少 —— 模型多半没配对'
  }
}

function readBody(req) {
  return new Promise(function (resolve) {
    let body = ''
    req.on('data', function (c) { body += c })
    req.on('end', function () { resolve(body) })
  })
}

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

async function embedderHandler(req, res) {
  try {
    if (req.method === 'GET') { sendJson(res, 200, await embedderStatus()); return }
    if (req.method === 'POST') {
      const p = JSON.parse((await readBody(req)) || '{}')
      // 只接受白名单字段，整份重写（不做增量合并，避免残留脏字段）
      const next = {}
      next.mode = String(p.mode || 'cloud') === 'local' ? 'local' : 'cloud'
      next.endpoint = String(p.endpoint || '').trim()
      next.model = String(p.model || '').trim()
      next.key = String(p.key || '')
      next.device = String(p.device === undefined || p.device === null ? 'auto' : p.device)
      next.numCtx = Math.floor(Number(p.numCtx)) > 0 ? Math.floor(Number(p.numCtx)) : 1024
      mkdirSync(memDir(), { recursive: true })
      const before = effectiveEmbedder()
      writeFileSync(embedderFile(), JSON.stringify(next, null, 2), 'utf8')
      const after = effectiveEmbedder()
      // 换了设备/模型/上下文 → 后台预热到新位置（别让用户在下一次真实检索时干等 20~30 秒）
      const changed = before.device !== after.device || before.model !== after.model ||
        before.numCtx !== after.numCtx || before.mode !== after.mode
      if (changed) warmUp('config')
      sendJson(res, 200, Object.assign({ saved: true, warmed: changed }, await embedderStatus()))
      return
    }
    sendJson(res, 405, { error: 'method not allowed' })
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

async function embedderSelftestHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    sendJson(res, 200, await embedderSelftest())
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

// ───────── Ollama 进程：检测 / 启动 / 停止 / 拉取模型 ─────────
// 生命周期（用户定案 2026-09-11）：
//   · **不自动启动** —— 用户在设置里自己走「选择 → 测试 → 启动」这一遍，它才起来；
//   · **但可以跟着 DSH 一起被杀掉** —— 所以不用 detached，并在退出时收掉；
//   · 另写 PID 文件，下次 DSH 启动时清掉上一轮被强杀可能残留的孤儿。
let ollamaChild = null;
let pullState = null;

function ollamaPidFile() { return join(memDir(), 'ollama.pid'); }

/** 进程还活着吗（Windows 上 signal 0 可用；EPERM 也表示存在，只是不归我们管）。 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

/** 读 PID 记录（新格式是 JSON；旧格式纯文本一律当"不认"）。 */
function readPidRecord() {
  try {
    if (!existsSync(ollamaPidFile())) return null;
    const rec = JSON.parse(readFileSync(ollamaPidFile(), 'utf8'));
    return rec !== null && typeof rec === 'object' ? rec : null;
  } catch (_e) { return null; }
}

/** 杀【一整棵】进程树（异步版）。 */
function killTree(pid, cb) {
  const done = cb || function () {};
  execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 8000, windowsHide: true }, function () { done(); });
}

/** 杀【一整棵】进程树（同步版，只能在 process.on('exit') 里用）。 */
function killTreeSync(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'],
      { timeout: 5000, windowsHide: true, stdio: 'ignore' });
  } catch (_e) {}
}

/** 按可执行名列出 pid（tasklist；取不到就返回空数组）。 */
function listProcessPids(imageName) {
  return new Promise(function (resolve) {
    try {
      execFile('tasklist', ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'],
        { timeout: 6000, windowsHide: true },
        function (err, stdout) {
          if (err || !stdout) { resolve([]); return; }
          const out = [];
          for (const line of String(stdout).split(/\r?\n/)) {
            const m = line.match(/^"([^"]+)","(\d+)"/);
            if (m) out.push({ name: m[1], pid: Number(m[2]) });
          }
          resolve(out);
        });
    } catch (_e) { resolve([]); }
  });
}

function watchDogFile() { return join(dirname(fileURLToPath(import.meta.url)), 'ollama-watchdog.mjs'); }

function startOllama() {
  return new Promise(function (resolve) {
    try {
      // POSIX 上让 ollama serve 当"进程组组长"，看门狗就能一次收掉整个组（带上跑模型的子孙）
      const child = spawn('ollama', ['serve'], {
        stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32'
      });
      ollamaChild = child;
      child.on('exit', function () { if (ollamaChild === child) ollamaChild = null; });
      try {
        mkdirSync(memDir(), { recursive: true });
        // 记【pid + 主人 DSH 进程】—— 只记 pid 的话，别的 DSH 实例启动时会误杀这个 Ollama（实测踩过）
        writeFileSync(ollamaPidFile(),
          JSON.stringify({ pid: child.pid, owner: process.pid, startedAt: Date.now() }), 'utf8');
      } catch (_e) {}
      // ★ 派一个"遗言执行人"（独立进程）：DSH 一死，**不论怎么死的**（Ctrl+C／关窗口／强杀／崩溃），
      //   它都会把 Ollama 整棵树收掉。这是"跟着 DSH 一起被杀"的**普适**保证 ——
      //   不依赖 DSH 能优雅退出，也不依赖任何启动/停止脚本怎么写（换电脑、别人拿去用一样成立）。
      try {
        const wd = spawn(process.execPath, [watchDogFile(), String(process.pid), String(child.pid)], {
          detached: true, stdio: 'ignore', windowsHide: true
        });
        wd.unref();
      } catch (_e) {}
      resolve({ started: true, pid: child.pid });
    } catch (e) {
      resolve({ started: false, error: String((e && e.message) || e) });
    }
  });
}

// DSH 正常退出时收掉我们起的 Ollama —— **必须杀整棵树**。
// ★ 2026-09-12 实测踩坑：原来用 `ollamaChild.kill()`，它只杀【直接子进程】。而 Ollama 是三代进程：
//   `ollama serve`（我们起的）→ `llama-server.exe`（模型真正跑在这里，占显存的就是它）。
//   结果：DSH 退出后 serve 没了、llama-server 变成孤儿，**显存一直占着不还**，
//   而设置页探 11434 只看到"服务没在运行" —— 用户看到"说没运行、显卡却占 2.1 GB"的矛盾画面。
//   修法：taskkill /PID <pid> /T /F（带 /T = 连子孙一起）。
try {
  process.on('exit', function () {
    try { if (ollamaChild !== null && Number(ollamaChild.pid) > 0) killTreeSync(Number(ollamaChild.pid)); } catch (_e) {}
    try {
      const rec = readPidRecord();
      if (rec !== null && Number(rec.owner) === process.pid && Number(rec.pid) > 0) {
        killTreeSync(Number(rec.pid));                 // 兜底：只要记录上写着"主人是我"，就一起收
      }
    } catch (_e) {}
  });
} catch (_e) {}

/** 清掉【真正的孤儿】Ollama：只有当 PID 文件里记的"主人 DSH 进程"已经死了，才杀它起过的 Ollama。
 *  ★ 2026-09-11 实测踩坑：原先只存 pid、启动就杀 —— 结果起了个 3081 测试实例，它 boot 时把
 *    用户在 3080 设置页里启动的 Ollama 一起杀了（抢别人的孩子）。多实例共用同一个记忆库，必须靠 owner 区分。 */
function reapOllamaOrphan() {
  return new Promise(function (resolve) {
    try {
      if (!existsSync(ollamaPidFile())) { resolve({ reaped: false }); return; }
      let rec = null;
      try { rec = JSON.parse(readFileSync(ollamaPidFile(), 'utf8')); } catch (_e) { rec = null; }
      if (rec === null || typeof rec !== 'object') {            // 旧格式（纯 pid 文本）→ 不认，别乱杀
        rmSync(ollamaPidFile(), { force: true });
        resolve({ reaped: false, reason: 'legacy-format' });
        return;
      }
      const pid = Number(rec.pid);
      const owner = Number(rec.owner);
      if (owner === process.pid) { resolve({ reaped: false, reason: 'own' }); return; }
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        resolve({ reaped: false, reason: 'owner-alive', owner: owner, ownerPid: pid });  // 别人的 Ollama，别动
        return;
      }
      rmSync(ollamaPidFile(), { force: true });
      if (!Number.isInteger(pid) || pid <= 0) { resolve({ reaped: false }); return; }
      execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 6000, windowsHide: true },
        function () { resolve({ reaped: true, pid: pid, owner: owner, reason: 'owner-dead' }); });
    } catch (_e) { resolve({ reaped: false }); }
  });
}

/** 停止本机 Ollama：按进程名杀 + 再按记录里的 pid 杀一次树（两条路都走，免得漏下跑模型的孙进程）。 */
function stopOllama() {
  return new Promise(function (resolve) {
    const rec = readPidRecord();
    const kill = (name, next) => {
      execFile('taskkill', ['/IM', name, '/F', '/T'], { timeout: 8000, windowsHide: true }, function () { next(); });
    };
    kill('ollama.exe', function () {
      kill('ollama app.exe', function () {
        const done = async function () {
          ollamaChild = null;
          // ★ 收尾：ollama 停掉之后，常常还剩"父进程已死"的**孤儿 llama-server**（占着显存）。
          //   它**不在 ollama.exe 的进程树里**，所以上面那条 /T 够不着它 —— 2026-09-12 实测就有这么一个
          //   （PID 8016，父进程 35708 已死），按钮按了显存还是没全还。此时服务已停，
          //   cleanOrphanRunners 的"服务在跑就拒止"条件不成立，调用是安全的。
          await sleep(700);
          let swept = null;
          try { swept = await cleanOrphanRunners(); } catch (_e) { swept = null; }
          try { rmSync(ollamaPidFile(), { force: true }); } catch (_e) {}
          resolve({ stopped: true, sweptRunners: swept });
        };
        if (rec !== null && Number(rec.pid) > 0) killTree(Number(rec.pid), function () { done(); }); else done();
      });
    });
  });
}

/** 收掉【残留】的本地模型进程：Ollama 服务已经没了，但 llama-server.exe 还占着显存。
 *  ★ 重要的拒止：只在"服务确实没在应答"时才清 —— Ollama 正常跑着的时候，
 *    llama-server 是它的【合法子进程】，杀了会把正在用的模型打掉。（前端本来也只在残留时显示这个按钮，
 *    但路由可能被别的东西调到，所以守卫必须做在服务端。） */
async function cleanOrphanRunners() {
  const cfg = effectiveEmbedder();
  try {
    await fetchJson(cfg.endpoint + '/api/tags', 3000);
    const left = await listProcessPids('llama-server.exe');
    return { cleaned: 0, left: left.length, refused: 'Ollama 正在运行，llama-server 是它的合法子进程，不动它' };
  } catch (_e) { /* 服务没应答 → 才继续清理 */ }
  const before = await listProcessPids('llama-server.exe');
  for (const p of before) await new Promise(function (r) { killTree(p.pid, r); });
  await sleep(1000);
  const after = await listProcessPids('llama-server.exe');
  return { cleaned: before.length, left: after.length, pids: before.map(function (p) { return p.pid; }) };
}

/** 按【身份】清残留：nvidia-smi 能给出占用显存的进程的**完整路径**，
 *  落在 Ollama 目录下的 `llama-server.exe` 才是它的 —— **不按文件名乱杀**（别人的 llama.cpp 不能误伤）。
 *  ★ 为什么必须有这一条：DSH 被【强杀】时（比如停止脚本里 `taskkill /F` 不带 `/T`），
 *    代码里的退出清理（process.on('exit')）**根本没机会跑**；而"按 PID 记录里那个 pid 杀"也救不了 ——
 *    那个 pid 早就没了，它的子孙会被系统【改嫁】、`/T` 够不着
 *    （2026-09-12 实测：孤儿 llama-server 的父进程 10952 早已不存在）。 */
async function cleanOllamaRunnersByPath() {
  const apps = await new Promise(function (resolve) {
    try {
      execFile('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'],
        { timeout: 8000, windowsHide: true },
        function (err, stdout) {
          if (err || !stdout) { resolve([]); return }
          const out = []
          for (const line of String(stdout).split(/\r?\n/)) {
            const i = line.indexOf(',')
            if (i < 0) continue
            const pid = Number(line.slice(0, i).trim())
            const path = line.slice(i + 1).trim()
            if (Number.isInteger(pid) && pid > 0) out.push({ pid: pid, path: path })
          }
          resolve(out)
        })
    } catch (_e) { resolve([]) }
  })
  const killed = []
  for (const a of apps) {
    // 只认 Ollama 自己那份：路径里有 ollama 目录 + 文件名是 llama-server（.exe）。
    // **不按文件名乱杀** —— 用户自己跑的 llama.cpp 不能被误伤（2026-09-12 实测过这点）。
    if (/ollama/i.test(a.path) && /llama-server(\.exe)?$/i.test(a.path)) {
      await new Promise(function (r) { killTree(a.pid, r) })
      killed.push(a.pid)
    }
  }
  return { killed: killed, scanned: apps.length }
}

/** 启动时的统一清理（两步，互补）：
 *  ① 按 PID 记录（认 owner）—— 正常退出没跑成时的兜底；
 *  ② 按身份（路径）清 Ollama 残留的跑模型进程 —— **强杀场景下只有这条管用**。
 *  ②的闸：**只在 Ollama 没在应答时**才动手（应答了就说明有活着的服务，那 runner 是合法的）。
 *  这道闸够用：服务一起来 11434 就应答（此时模型可能还在加载），所以"另一个实例正在加载"不会被误杀。 */
async function bootCleanup() {
  const reap = await reapOllamaOrphan();
  let runners = { killed: [], scanned: 0 };
  try {
    const cfg = effectiveEmbedder();
    if (cfg.isLocal) {
      let up = false;
      try { await fetchJson(cfg.endpoint + '/api/tags', 3000); up = true; } catch (_e) {}
      if (!up) runners = await cleanOllamaRunnersByPath();
    }
  } catch (_e) {}
  if (runners.killed.length > 0) {
    console.log('[dsh-memory-app] 启动清理：收掉了 ' + runners.killed.length +
      ' 个残留的 Ollama 跑模型进程（pid ' + runners.killed.join(', ') + '）—— 多半是上次 DSH 被强杀留下的');
  }
  return { reap: reap, runners: runners };
}

/** 拉取模型（后台跑，状态里能看到进度尾巴）。 */
function startPull(model) {
  if (pullState !== null && pullState.done === false && pullState.model === model) return pullState;
  pullState = { model: model, startedAt: Date.now(), done: false, ok: false, tail: '' };
  try {
    const child = spawn('ollama', ['pull', model], { windowsHide: true });
    const onData = function (d) { pullState.tail = String(d).trim().split(/\r?\n/).pop() || pullState.tail; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', function (code) { pullState.done = true; pullState.ok = code === 0; });
    child.on('error', function (e) { pullState.done = true; pullState.ok = false; pullState.tail = String((e && e.message) || e); });
  } catch (e) {
    pullState.done = true; pullState.ok = false; pullState.tail = String((e && e.message) || e);
  }
  return pullState;
}

// ───────── 预热 / 卸载：别让用户干等那 20~30 秒的冷启动 ─────────
let warmState = null;

/** 主动把模型按当前设置加载到位。已在预热中就不重复触发。 */
function warmUp(reason) {
  if (warmState !== null && warmState.done === false) return warmState;
  const cfg = effectiveEmbedder();
  if (cfg.isLocal === false && cfg.key === '') return null;
  const t0 = Date.now();
  warmState = { reason: reason, startedAt: t0, done: false, ok: false, ms: 0 };
  embedText(cfg, 'warmup')
    .then(function () { warmState.done = true; warmState.ok = true; warmState.ms = Date.now() - t0; })
    .catch(function (e) {
      warmState.done = true; warmState.ok = false; warmState.ms = Date.now() - t0;
      warmState.error = String((e && e.message) || e);
    });
  return warmState;
}

/** 把模型从显存/内存里卸掉（想立刻腾地方时用）。 */
function unloadModel() {
  return new Promise(function (resolve) {
    const model = effectiveEmbedder().model;
    execFile('ollama', ['stop', model], { timeout: 20000, windowsHide: true }, function (e, o) {
      warmState = null;
      resolve({ unloaded: e ? false : true, model: model, output: String(o || '').trim().slice(0, 200) });
    });
  });
}

const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });

/** 启动 / 停止 Ollama，或拉取模型；做完顺手把最新状态一起回给前端。 */
async function ollamaActionHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    const url = String(req.url || '');
    const endpoint = effectiveEmbedder().endpoint;
    let result = {};
    if (url.indexOf('/start') >= 0) {
      result = await startOllama();
      // 等它就绪（最多 ~12 秒），这样前端拿到状态时已经是"运行中"
      for (let i = 0; i < 30; i++) {
        await sleep(400)
        try { await fetchJson(endpoint + '/api/tags', 1500); result.ready = true; break } catch (_e) {}
      }
      // 起来了就立刻预热（用户说的"初始加载也要预热"）：后台把模型按设置加载到位
      if (result.ready === true) warmUp('start');
    } else if (url.indexOf('/stop') >= 0) {
      result = await stopOllama();
      await sleep(1200);
    } else if (url.indexOf('/pull') >= 0) {
      const p = JSON.parse((await readBody(req)) || '{}');
      const model = String(p.model || effectiveEmbedder().model);
      startPull(model);
      result = { pulling: true, model: model };
    } else if (url.indexOf('/warm') >= 0) {
      const w = warmUp('manual');
      result = { warming: w !== null };
    } else if (url.indexOf('/clean') >= 0) {
      result = await cleanOrphanRunners();
    } else if (url.indexOf('/unload') >= 0) {
      result = await unloadModel();
    } else {
      sendJson(res, 404, { error: 'unknown action' });
      return;
    }
    sendJson(res, 200, Object.assign({ action: url.split('/').pop() }, result, await embedderStatus()));
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

// ═══════════ 骨架：把核心记忆切块"下沉"进 Vault（写入流）═══════════
// 设计要点（2026-09-11 定案）：
//   · 按【结构】切块（`##` 小节 / `- ` 条目 / 空行段优先），不按字数硬切；
//   · 单块仍超长才按句末切，并留 80 字重叠（跨边界的信息两边都盖得住）；
//   · 复用分叉自己的 VaultStore：同一份 schema、它自己的嵌入与 vault.md 镜像同步，
//     指纹也由它的 resolveEmbedder() 出 —— 保证与检索侧完全一致，不各写一套；
//   · 同一 namespace【先清后写】，重复跑不会堆积；
//   · 先探一次嵌入，失败就中止、**不动库**（绝不把库清空）。
let vaultStoreCache = null

async function getVaultStore() {
  if (vaultStoreCache !== null) return vaultStoreCache
  const mod = await import('./vendor/dsh-persist/index.js')
  if (typeof mod.VaultStore !== 'function') throw new Error('dsh-persist 没导出 VaultStore（分叉版本不对？）')
  vaultStoreCache = new mod.VaultStore(memDir())
  return vaultStoreCache
}

/** 句末切分 + 重叠（只在单块仍超长时才用）。兜底保证每块 <= max。 */
function splitBySentence(text, max, overlap) {
  const out = []
  let buf = ''
  const flush = function () { const s = buf.trim(); if (s !== '') out.push(s); buf = '' }
  for (const p of String(text).split(/(?<=[。！？；.!?;])/)) {
    let rest = p
    while (rest.length > max) {          // 这一段本身超上限（整段没有句读）→ 硬切兜底
      flush()
      out.push(rest.slice(0, max).trim())
      rest = rest.slice(max - overlap)
    }
    if (buf.length > 0 && buf.length + rest.length > max) {
      // ★回带（overlap）不许把下一句顶过上限★ —— 2026-09-14 实测出来的真 bug：
      //   输入「470 字一句 + 480 字一句」（各自都 ≤ max=500）→ 回带 80 字后拼成 **560 字**，
      //   超过本函数声明的 max。最小复现 `.ptmp/probe_chunk_overflow.mjs`；夹具见 verify_ingest
      //   的「回带不许把块顶过上限」。**上限是承诺**（下游按它估预算），破了就是无声的谎。
      //   修法：回带最多留到"够填满剩余余量"，留不下就不留。
      //   ⚠️ `room >= overlap` 时行为与改动前**逐字节相同** —— 所以这个修法只动"本来就会超限"的情形。
      //   ⚠️ **carry 必须在 flush() 之前算**：`flush()` 会把 `buf` 置空，
      //      先 flush 后 slice = 回带永远是空串 = **无声地把重叠功能整个关掉**
      //      （我第一版就这么写的，是 `.ptmp/probe_chunker_divergence.mjs` 当场抓出来的：
      //        真库 3 个文件、460 块输出变了 —— 而按设计只该在"本来会超限"时才变）。
      const room = max - rest.length
      const carry = room > 0 ? buf.slice(Math.max(0, buf.length - Math.min(overlap, room))) : ''
      flush()
      buf = carry
    }
    buf += rest
  }
  flush()
  return out
}

// ── 父标题链（breadcrumb）★2026-09-14 阶段42：P2 的第一关★ ──────────────────
// 真库实测（`memory/tools/probe_subjectless.mjs`，842 块）：**580 块（69%）"没有主语"** ——
// 块首是一句光秃秃的话，看不出它属于哪份文档、哪一节（`memory` 分区最严重 82%；
// `会话`/`index` 是 0%，因为卡片本来就是"标题 + 一整段"）。
// 做法：按 Markdown 标题层级维护一条**标题栈**，把当前这条链缀在块首：
//     `# 【父标题链】# 文档抬头 → ## 小节 → ### 子节\n<块内容>`
// 链上每一项都是**原文里的标题行**（去掉首尾空白）—— 所以链上写的每句都有出处，
// 不是给块"编"一个抬头；`probe_subjectless.mjs` 会逐项回原文核对（0 例违例才算数）。
//
// ★前缀行故意做成"标题行"（以 `# ` 开头）★：显示层／人眼／旧口径（"首行是 `#` 就算有主语"）
//   都能直接认它，不用各自再学一套格式。
const CRUMB_MARK = '# 【父标题链】'
const CRUMB_SEP = ' → '
const CRUMB_ELLIPSIS = '…'        // 中间层被省掉时的占位（`# 抬头 → … → #### 最近一节`）
const CRUMB_ELEM_MAX = 44         // 单个标题最多留多少字（超出截断加 `…`）—— 让前缀不至于吃掉半个块
const CRUMB_HARD_MAX = 200        // 前缀绝对上限（字）
const CRUMB_RATIO = 0.4           // 前缀最多吃掉 max 的 40%（正文至少留 60%）
const CRUMB_MIN_BUDGET = 20       // 重切时正文至少要有的预算，低于它宁可这块没主语

/** 链元素的**规范化**（造与解析共用同一条规则，别在两处各写一遍）：
 *  ① 标题里真有 ` → ` 就先改写成 `->` —— **由构造保证**"链上的 ` → ` 一定是分隔符"，解析的人不用猜；
 *  ② 超长就截断（末尾 `…`），层级标记 `### ` 留着（便于回原文里搜）。 */
export function crumbElement(line) {
  const m = /^(#{1,6}\s+)/.exec(String(line).trim())
  const lvl = m === null ? '' : m[1]
  const body = String(line).trim().slice(lvl.length).replace(/\s*→\s*/g, '->')
  return lvl + (body.length > CRUMB_ELEM_MAX ? body.slice(0, CRUMB_ELEM_MAX) + '…' : body)
}

/** 造父标题链前缀（**带结尾换行**）；造不出来返回 null —— 宁可不加，也绝不把块顶过上限。
 *
 *  ★链最多留"文档根 + 最近一节"，中间层省成 `…`★ —— 这是**量出来的**：
 *    真库 `memory` 档案的链深到 3–5 层，全留平均 **129 字/块**（吃掉上限的 26%）
 *    → 块被挤得更容易触发重切（+84 块）。砍掉中间层后平均约 84 字，
 *    "这是哪份文档"与"这是哪一节"两个问题都还答得上。
 *  阶梯（逐级降级，确定性）：① 根 + … + 最近一节 → ② 仍保根、把最近一节再砍短 → ③ 只留最近一节。
 *  `limit` = 前缀允许的最大长度（含换行）。 */
function crumbFor(chain, limit) {
  if (!Array.isArray(chain) || chain.length === 0) return null
  const deep = chain.map(crumbElement)
  const parts = deep.length > 2 ? [deep[0], CRUMB_ELLIPSIS, deep[deep.length - 1]] : deep
  const build = function (p) { return CRUMB_MARK + p.join(CRUMB_SEP) }
  const fit = function (s) { return s.length + 1 <= limit }
  const full = build(parts)
  if (fit(full)) return full + '\n'
  const last = parts[parts.length - 1]
  const m = /^(#{1,6}\s+)/.exec(last)
  const lvl = m === null ? '' : m[1]
  const body = last.slice(lvl.length)
  const headParts = parts.slice(0, parts.length - 1)
  const head = build(headParts) + (headParts.length > 0 ? CRUMB_SEP : '')
  for (let keep = body.length - 1; keep >= 4; keep--) {      // ② 保住"文档是谁"，砍最近一节
    const s = head + lvl + body.slice(0, keep) + '…'
    if (fit(s)) return s + '\n'
  }
  const only = CRUMB_MARK + CRUMB_ELLIPSIS + CRUMB_SEP + last   // ③ 只留最近一节
  if (fit(only)) return only + '\n'
  return null
}

/** 前缀的**逆运算**：把块首那行父标题链解析出来（没有就返回 null）。
 *  形状：`{ chain: ['# 抬头', '#### 最近一节'], elided: 有没有把中间层省掉 }`
 *  （元素已规范化、可能带 `…` 截断尾巴；`…` 占位符不算元素。） */
export function breadcrumbOf(block) {
  const s = String(block)
  if (s.slice(0, CRUMB_MARK.length) !== CRUMB_MARK) return null
  const i = s.indexOf('\n')
  const parts = (i < 0 ? s : s.slice(0, i)).slice(CRUMB_MARK.length).split(CRUMB_SEP)
  return {
    chain: parts.filter(function (p) { return p !== CRUMB_ELLIPSIS }),
    elided: parts.indexOf(CRUMB_ELLIPSIS) >= 0,
  }
}

/** 剥掉块首那行父标题链（没有就原样返回）。
 *  ★不是装饰品★：四条不变量里的"内容不丢"，判据就是"剥掉前缀后、拼接能还原原文"。 */
export function stripBreadcrumb(block) {
  const s = String(block)
  if (breadcrumbOf(s) === null) return s
  const i = s.indexOf('\n')
  return i < 0 ? '' : s.slice(i + 1)
}

/** 按结构切块：小节/条目优先，超长才按句末切并重叠，最后把小碎块并回去；每块带上父标题链。
 *
 * ★四条不变量（阶段35/36 装过牙的，一条都不许破）★
 *   ① 每块 ≤ max ② 不产生空块 ③ 内容不丢（**剥掉前缀**后拼接能还原原文）④ 确定性（同输入同输出）
 * ★前缀会让块变长 → 所以是"**先定前缀、再按剩余预算判上限**"★：合并的尺寸门槛算上前缀；
 *   单块放不下就先缩短链（`crumbFor` 的阶梯），还放不下才按"max − 前缀"减预算重切。
 *   （阶段34 那个 bug 的同类：**先算尺寸再决定内容**，别反过来。）
 *
 * ★`{breadcrumb:false}` 可关掉前缀（老行为逐字节保留），但**默认必须是开**★：
 *   若"给不给前缀"由调用点决定，CLI（用源码）与 boot（用已装副本）会各自切出**不同的库**，
 *   而 `check_chunker_parity.mjs` 只比 `chunkByStructure(text,max,ov)` 这一种调用 ——
 *   它会报"一致"，实际两边早已分叉。**默认开 = 那个对比工具才看得见真相。**
 */
export function chunkByStructure(text, maxChars, overlap, opts) {
  const max = maxChars > 0 ? maxChars : 500
  // ★回带不许 ≥ 上限★（防御）：`splitBySentence` 里硬切用 `slice(max - overlap)`，
  //   负下标会切出"尾部 N 字"并**原地打转（死循环）**。真调用都是 500/80，这儿只是把坑堵上。
  const ovRaw = overlap > 0 ? overlap : 80
  const ov = Math.min(ovRaw, Math.max(1, Math.floor(max / 2)))
  const o = opts || {}
  const crumbOn = o.breadcrumb !== false
  const crumbCap = Math.max(0, Math.min(Math.floor(max * CRUMB_RATIO), CRUMB_HARD_MAX))
  // 下限：太小的块（如 `## 待办` 这种纯标题）单独成块时向量没信息量，会稀释索引
  const min = Math.min(Math.max(80, Math.round(max * 0.25)), max)
  const parts = String(text).split(/\r?\n/)
  const out = []
  const chains = []                     // 与 out 一一对应：这块是从哪条标题链上下来的
  const stack = []                      // 标题栈（只有 Markdown 标题进栈；`- ` 条目不进）
  let cur = []
  let curChain = []

  const push = function (s, chain) { out.push(s); chains.push(chain) }
  const snap = function () { return stack.map(function (h) { return h.line }) }
  const flush = function () {
    const s = cur.join('\n').trim()
    const chain = curChain
    cur = []
    curChain = []
    if (s === '') return
    if (s.length <= max) { push(s, chain); return }
    for (const piece of splitBySentence(s, max, ov)) push(piece, chain)
  }
  for (const line of parts) {
    const hm = /^(#{1,6})\s+/.exec(line)
    if (hm !== null) {
      const lvl = hm[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= lvl) stack.pop()
      stack.push({ level: lvl, line: line.trim() })
    } else if (/^<!--\s*\S+\.md\s*-->\s*$/i.test(line)) {
      // ★文件边界★：`vault-sync` 把多份台账拼成一个分区时会插 `<!-- 相对路径 -->`。
      //   栈不重置的话，**上一份文件的抬头会串到下一份的块上**（链上写错出处，比没有链更坏）。
      //   只认"像路径的独立注释行"，免得把正文里的普通注释也当边界。
      stack.length = 0
    }
    const isHeading = hm !== null
    const isBullet = /^\s*([-*+]|\d+\.)\s/.test(line)
    if ((isHeading || isBullet) && cur.join('\n').trim() !== '') flush()
    if (cur.length === 0) curChain = snap()          // ★块的链 = 它**首行**那一刻的链★
    if (line.length > max) {
      flush()
      for (const piece of splitBySentence(line, max, ov)) push(piece, snap())
      continue
    }
    cur.push(line)
  }
  flush()

  // 合并小碎块：向前并（accumulate）优先，剩太小的再并进上一块
  // ★尺寸门槛要算上前缀★：合并后的块只带**第一块**的链，所以判"装不装得下"按第一块的剩余预算。
  const roomOf = function (chain) {
    if (!crumbOn) return max
    const c = crumbFor(chain, crumbCap)
    return max - (c === null ? 0 : c.length)
  }
  const merged = []
  const mergedChains = []
  let acc = ''
  let accChain = []
  let accRoom = max
  for (let i = 0; i < out.length; i++) {
    if (acc === '') { acc = out[i]; accChain = chains[i]; accRoom = roomOf(accChain); continue }
    if (acc.length < min && acc.length + 1 + out[i].length <= accRoom) { acc = acc + '\n' + out[i]; continue }
    merged.push(acc); mergedChains.push(accChain)
    acc = out[i]; accChain = chains[i]; accRoom = roomOf(accChain)
  }
  if (acc !== '') { merged.push(acc); mergedChains.push(accChain) }
  const final = []
  const finalRooms = []
  for (let i = 0; i < merged.length; i++) {
    const b = merged[i]
    const prev = final.length > 0 ? final[final.length - 1] : null
    if (b.length < min && prev !== null && prev.length + 1 + b.length <= finalRooms[final.length - 1]) {
      final[final.length - 1] = prev + '\n' + b
      continue
    }
    final.push(b)
    finalRooms.push(roomOf(mergedChains[i]))
  }
  if (!crumbOn) return final

  // ── 装饰：给"不能自己说自己"的块补一行父标题链 ──────────────────────
  const decorated = []
  for (let i = 0; i < final.length; i++) {
    const b = final[i]
    const chain = mergedChains[i]
    // ★硬约束①：块首就是"它自己所属的那条标题"（标题栈顶）→ **一个字节都不动**★
    //   会话卡（`## 会话卡 <id> · 日期 · 标题`）与目录卡片（`## 卡片 N · 项目名`）就是这种结构；
    //   「1 张卡 = 1 块」那条铁律（`verify_cards` 判的）靠这一条兜住 —— 卡片永不前缀，
    //   也就永远不会因为"多了一行前缀"被顶过上限而裂成两块。
    //   判据是**结构性的**：比的是"这块所属的那条标题"，不是"块首碰巧长得像个标题"。
    if (chain.length === 0 || b.split('\n')[0].trim() === chain[chain.length - 1]) { decorated.push(b); continue }
    const crumb = crumbFor(chain, Math.min(crumbCap, max - b.length - 1))
    if (crumb !== null) { decorated.push(crumb + b); continue }
    // 前缀放不下 → 按"最长可用前缀"减预算重切（阶段34 量出来的变体 B）
    const full = crumbFor(chain, crumbCap)
    const budget = full === null ? 0 : max - full.length
    if (full === null || budget < CRUMB_MIN_BUDGET) { decorated.push(b); continue }
    const effOv = Math.min(ov, Math.max(1, Math.floor(budget / 2)))
    for (const piece of splitBySentence(b, budget, effOv)) decorated.push(full + piece)
  }
  return decorated
}

// ── 分区写入锁 ────────────────────────────────────────────────────────────
// ★为什么必须串行★：`ingestToVault` 是**先清后写**（先 `DELETE` 整个分区，再逐块插入）。
// 两个 ingest 并发进**同一个分区**时，DELETE 与 INSERT 会交错 → **同一块内容在库里出现两份**。
// 2026-09-12 实测两个后果：
//   ① 桩测试复现：5 个并发 → **60 行、只有 12 条唯一（48 行重复）**；
//   ② 真实环境**已经中招**：`台账` 分区 123 行里只有 88 条唯一 ——
//      而**重复会把正确那条挤出检索前列**（用户此前就因重复吃过检索变差的亏）。
// 触发路径：启动 6 秒的 boot 同步、与「首次学到 cwd」的补跑，撞在一起（`runVaultSync` 当时没闸）。
// ★粒度是"分区"，不是全局★ —— 不同分区应当照旧并行（`verify_ingest_lock.mjs` 专门验了这条）。
const nsLocks = new Map()
function withNsLock(ns, fn) {
  const prev = nsLocks.get(ns) || Promise.resolve()
  const next = prev.then(fn, fn)   // 前一次即使失败，也不能把后面全堵死
  nsLocks.set(ns, next.then(function () {}, function () {}))   // 锁尾只记"结束"，不记异常
  return next
}

/** 把一段文本（或一个文件）切块写进 Vault 的某个 namespace。 */
export async function ingestToVault(opts) {
  const o = opts || {}
  let text = ''
  let source = '(inline)'
  if (o.path) {
    const p = String(o.path)
    if (!existsSync(p)) throw new Error('文件不存在：' + p)
    text = readFileSync(p, 'utf8')
    source = p
  } else {
    text = String(o.text || '')
  }
  if (text.trim() === '') throw new Error('没有内容可入档')
  const ns = String(o.namespace || 'core').trim() || 'core'
  const maxChars = Number(o.maxChars) > 0 ? Math.floor(Number(o.maxChars)) : 500
  const chunks = chunkByStructure(text, maxChars, 80)
  if (chunks.length === 0) throw new Error('切块后为空')

  const sizes = chunks.map(function (c) { return c.length })
  if (o.dryRun === true) {
    return {
      dryRun: true, source: source, namespace: ns, chunks: chunks.length,
      minChars: Math.min.apply(null, sizes), maxCharsSeen: Math.max.apply(null, sizes),
      sample: chunks.slice(0, 3)
    }
  }

  const cfg = effectiveEmbedder()
  let probe = []
  try {
    probe = await embedText(cfg, chunks[0])           // 先探一次：失败就别删库
  } catch (e) {
    throw new Error('嵌入失败，已中止、库未改动：' + ((e && e.message) || e))
  }
  if (!probe || probe.length === 0) throw new Error('嵌入失败（拿不到向量），已中止、库未改动')

  // ★整段"先清后写"必须在分区锁里★ —— 从读 before、DELETE、到全部插入完成，
  //   中间不能让另一个 ingest 插进来（否则重复行，见 withNsLock 的注释）。
  return withNsLock(ns, async function () {
    const store = await getVaultStore()
    const before = store.db.prepare('SELECT COUNT(*) AS c FROM memos WHERE namespace = ?').get(ns).c
    store.db.prepare('DELETE FROM memos WHERE namespace = ?').run(ns)
    let embedded = 0
    const items = []
    if (typeof store.addMany === 'function') {
      const rs = await store.addMany(chunks, ns)          // ★批量：嵌入一次一串 + 单事务 + 镜像只写一次★
      for (let i = 0; i < chunks.length; i++) {
        const r = rs[i] || {}
        if (r.embedded === true) embedded++
        items.push({ id: r.id, chars: chunks[i].length, head: chunks[i].replace(/\s+/g, ' ').slice(0, 36) })
      }
    } else {
      for (const c of chunks) {
        const r = await store.add(c, ns)                  // 兜底：旧 VaultStore 没有 addMany 时逐块（行为同改前）
        if (r.embedded === true) embedded++
        items.push({ id: r.id, chars: c.length, head: c.replace(/\s+/g, ' ').slice(0, 36) })
      }
    }
    try { store.syncVaultMd() } catch (_e) {}

    return {
      source: source, namespace: ns, chunks: chunks.length, embedded: embedded,
      replaced: before, minChars: Math.min.apply(null, sizes), maxCharsSeen: Math.max.apply(null, sizes),
      pointerPrefix: 'vault:' + ns + '#', items: items
    }
  })
}

async function ingestHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    const p = JSON.parse((await readBody(req)) || '{}')
    sendJson(res, 200, await ingestToVault(p))
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) })
  }
}

// ── Vault 同步（让索引永不过期）────────────────────────────────────────────
// ★为什么要有★：索引是快照，**没有重建触发器就必然变成谎话、而且不报错**
//   （`embeddings.json` 就是这么烂掉的）。所以：启动时自动重建 + 状态可见 + 可手点。
//
// ★普适性★：vault-sync.mjs 里**没有任何本机路径** —— memDir 与 cwd 都从这儿传进去。
//   cwd 用 process.cwd()（DSH 进程的工作目录 = 用户的工作区，任何机器都成立）。
//   扫不到台账（别人可能不用台账）→ 正常工作，不报错。
let lastSyncResult = null
let lastKnownCwd = null      // ★会话的工作区★（从 systemPrompt 装配回调里学到）
let syncedCwd = null         // 已经为哪个工作区同步过

/** 首次获知某个工作区时补跑一次同步 —— 兜住"启动时还不知道 cwd"那段空窗。 */
function maybeSyncForCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '' || syncedCwd === cwd) return
  syncedCwd = cwd
  lastKnownCwd = cwd
  // ★2026-09-16★ 顺手记到 init.json：这样**重启后**初始化向导仍能建议"你上次的工作区"
  //   （lastKnownCwd 只是进程内状态，重启就没了 —— 用户截图里那行建议为空就是这个原因）。
  try { initWizardWriteInit({ workspaceSeen: cwd }) } catch (_e) {}
  setTimeout(function () { runVaultSync('first-cwd').catch(function () {}) }, 1200)
}

/** 跑一次同步（启动时 / 首次获知 cwd 时 / 路由手动调）。
 *  ★cwd 未知时**拒绝跑**★ —— 宁可不做，也不能拿错误的 cwd 去扫、更不能用兜底目录覆盖真目录。 */
async function doVaultSync(trigger) {
  const t0 = Date.now()
  if (typeof lastKnownCwd !== 'string' || lastKnownCwd === '') {
    lastSyncResult = { ok: false, skipped: true, reason: 'no-cwd-yet', trigger: trigger, at: new Date().toISOString() }
    return lastSyncResult
  }
  try {
    const r = await syncVault({
      cwd: lastKnownCwd,
      memDir: memDir(),
      ingest: ingestToVault,
      log: function (m) { try { console.log(m) } catch (_e) {} }
    })
    r.trigger = trigger
    r.tookMs = Date.now() - t0
    // ── ⑧ 显示层：同步完**顺手刷一遍「记忆视图」**（DSH 重启也会刷）────────────────
    //   ★失败不许静默★：视图是"只读副本"，停在旧版 = 过时文档（铁律："过时文档比没有更坏"）。
    //   所以这里**大声报**，并把结果记进 `r.view`（设置页那条状态路由会带出去）——但**不改 r.ok**：
    //   Vault 同步成功与否，不该被显示层的一次失败翻掉（两件事）。
    //   ★为什么先查 `<cwd>/memory` 在不在★：视图落在 `<cwd>/memory/记忆视图`，而会话的 cwd 可能是
    //   **某个子项目目录**（比如 voice/）—— 不查就会在那个项目文件夹里**凭空长出一份整库副本**
    //   （"东西放错地方"，还白复制几百 KB）。判据 =「这个根确实有个记忆项目」才刷；没有就跳过，
    //   跳过**不算失败**（记进 r.view 留痕，不报红）。
    if (!existsSync(join(lastKnownCwd, 'memory'))) {
      r.view = { ok: true, skipped: true, reason: 'no-memory-project-here', cwd: lastKnownCwd }
      console.log('  [view] 跳过：' + lastKnownCwd + ' 下没有 memory/ 目录（cwd 大概在某个子项目里）')
    } else try {
      const v = await buildView({ root: lastKnownCwd, memDir: memDir(), log: function (m) { try { console.log('  [view] ' + m) } catch (_e) {} } })
      r.view = { ok: v.ok, files: v.files, sections: v.sections, bytes: v.bytes, out: v.out, error: v.error }
      if (!v.ok) console.log('★[dsh-memory-app] 记忆视图刷新失败★（库没事，显示层会停在旧版）：' + v.error)
    } catch (e) {
      r.view = { ok: false, error: String((e && e.message) || e) }
      console.log('★[dsh-memory-app] 记忆视图刷新抛错★：' + ((e && e.message) || e))
    }
    lastSyncResult = r
    return r
  } catch (e) {
    lastSyncResult = { ok: false, trigger: trigger, error: String((e && e.message) || e), tookMs: Date.now() - t0 }
    return lastSyncResult
  }
}

// ★同一时刻只允许一次同步在跑（single-flight）★
// 触发点有三个（启动后 6 秒 / 首次学到 cwd 时补跑 / 设置页按钮），**它们完全可能撞在一起**。
// 撞上会怎样（2026-09-12 实测）：
//   ① 两个 syncVault 同时写同一个分区 → **重复行**（`台账` 123 行里只有 88 条唯一）；
//   ② 白算一遍嵌入（真嵌入很慢，一次同步七八秒）。
// 处理：正在跑就直接复用它；跑的过程中又来了请求 → **合流只记一个**，等这次跑完再补跑一次
//       （补跑是必要的：后来的请求可能是"刚学到 cwd"，前提跟当前这次不同）。
let syncInFlight = null
let syncQueued = null

function runVaultSync(trigger) {
  if (syncInFlight) { syncQueued = syncQueued || trigger; return syncInFlight }
  syncInFlight = (async function () {
    try {
      let r = await doVaultSync(trigger)
      while (syncQueued) {
        const t = syncQueued
        syncQueued = null
        r = await doVaultSync(t)
      }
      return r
    } finally {
      syncInFlight = null
    }
  })()
  return syncInFlight
}

/** GET /dsh-memory-app/vault-sync/status —— 只读检查，给前端显示"过期了没" */
async function vaultSyncStatusHandler(req, res) {
  try {
    if (typeof lastKnownCwd !== 'string' || lastKnownCwd === '') {
      sendJson(res, 200, { ok: false, error: '还没获知工作区 —— 在本会话里发一条消息后就会自动同步' })
      return
    }
    // ★从库里数出真实行数，交给 checkVault 核对★ —— 状态文件说自己"已同步 N 块"时必须真对得上，
    //   否则会出现"状态说已同步、库里其实是旧的/有重复"这种**无声的谎话**（2026-09-12 真踩过）。
    let counts = {}
    try {
      const store = await getVaultStore()
      const rows = store.db.prepare('SELECT namespace, COUNT(*) AS c FROM memos GROUP BY namespace').all()
      for (const r of rows) counts[r.namespace] = r.c
    } catch (_e) { counts = {} }   // 拿不到就当核不了，不因为这一条把整个状态页搞挂

    const c = checkVault({ cwd: lastKnownCwd, memDir: memDir(), counts: counts })
    sendJson(res, 200, {
      ok: true,
      cwd: lastKnownCwd,
      stale: c.stale,
      staleCount: c.staleCount,
      mismatched: c.mismatched,
      synced: c.synced,
      lastAt: c.lastAt,
      discovered: c.discovered,
      lastRun: lastSyncResult
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

/** POST /dsh-memory-app/vault-sync/run —— 手动一键重建 */
async function vaultSyncRunHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    const r = await runVaultSync('manual')
    sendJson(res, 200, r)
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

// ── ⑤ 语义判官：只读状态路由 + 紧凑文字报告 ──────────────────────────────
// ★为什么状态路由是只读的★：语义判官**要外发**（把摘录发给当前模型），所以"什么时候跑"
//   必须由人/agent 显式决定。状态路由只负责回答"上次跑成什么样"，**绝不触发任何调用**。
function semanticLatestFile() {
  return join(memDir(), 'corrections', 'semantic-latest.json')
}

async function semanticStatusHandler(req, res, ctx) {
  try {
    const f = semanticLatestFile()
    let enabled = false
    try { enabled = typeof ctx.get === 'function' && ctx.get('llm') !== undefined } catch (_e) { enabled = false }
    if (!existsSync(f)) {
      sendJson(res, 200, { ok: true, enabled: enabled, lastAt: null, lastCount: 0, model: null, file: f })
      return
    }
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const vs = Array.isArray(j.verdicts) ? j.verdicts : []
    sendJson(res, 200, {
      ok: true,
      enabled: enabled,
      lastAt: j.at || null,
      lastCount: vs.filter(function (v) { return v && v.verdict === 'contradiction' }).length,
      model: j.model || null,
      file: f,
      scanned: j.scanned === undefined ? null : j.scanned,
      pairs: j.pairs === undefined ? null : j.pairs,
      error: j.error || null,
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

/** 把扫描结果写成**紧凑文字报告**（给人/agent 一眼看懂，不用去翻 JSON） */
function semanticReport(r) {
  const L = []
  const m = r.model ? (r.model.provider + '/' + r.model.model) : '(未知模型)'
  if (!r.ok) {
    L.push('✗ 语义判官没跑成：' + (r.error || '（没给原因）'))
    L.push('  已扫 ' + r.scannedBlocks + ' 块 ｜ 配出 ' + r.pairs + ' 对 ｜ 结果文件：' + (r.wrote ? r.outFile : '（没写）'))
    if (r.pairs > 0 && r.scannedBlocks > 0 && String(r.error || '').indexOf('JSON') >= 0) {
      L.push('  （模型回话不合规本身就是一次失败 —— 没解析出判决就不许当"没矛盾"）')
    }
    return L.join('\n')
  }
  const cs = r.verdicts.filter(function (v) { return v.verdict === 'contradiction' })
  L.push('⑤ 语义判官：扫了 ' + r.scannedBlocks + ' 块 ｜ 配了 ' + r.pairs + ' 对 ｜ **判出 ' + cs.length + ' 条矛盾**（模型 ' + m + '）')
  L.push('  结果文件：' + (r.wrote ? r.outFile : '（✗ 没写成：' + (r.error || '') + '）'))
  L.push('  并进裁决台账：node memory/tools/semantic_import.mjs')
  if (cs.length === 0) {
    L.push('  （这次没判出矛盾。注意：只扫了最近 ' + r.scannedBlocks + ' 块 —— 不是全库结论。）')
  }
  for (const v of cs.slice(0, 8)) {
    L.push('  · [严重 ' + v.severity + '] ' + v.a.namespace + ' ⇄ ' + v.b.namespace +
      '（共享 ' + (v.shared || []).slice(0, 3).join('、') + '）：' + v.why)
  }
  if (cs.length > 8) L.push('  …还有 ' + (cs.length - 8) + ' 条，见结果文件')
  return L.join('\n')
}

// ── ⑧ 显示层 · 记忆视图（Obsidian）：状态 / 打开 / 关闭 ──────────────────────
// ★为什么要做成按钮★：视图是给**人眼**看的，但"开没开、库登记了没、装在哪"以前全靠人手点 ——
//   用户 2026-09-15 提的："希望 obsidian 能植入 DSH，通过某个控件打开和关闭"。
//
// ★普适性（别写死本机路径）★：
//   ① 优先走 **Obsidian 自己的协议** `obsidian://open?vault=<库名>` —— 换台电脑、换个安装位置都成立；
//   ② 找不到就回退到**常见安装位置**找 exe（Windows/macOS/Linux 各一处），仍然用同一个 URI 启动；
//   ③ 再不行 → 打开那个文件夹 + **明确报"没找到 Obsidian"**（**绝不假装成功**）。
//
// ★关闭的力度★：先**优雅关**（发关闭消息，Obsidian 自己保存工作区）→ 还在才报出来、让用户点「强制关闭」。
//   **一上来就 /F 强杀是不可接受的**（用户可能正在别的库里写东西）。
// ★2026-09-16★ 这一组（URI / 找 exe / 库登记 / 纯函数"怎么开·怎么关" / 发出去打开）搬到
//   **`./obsidian.mjs`（一份实现）** —— 因为「一键初始化」的 `init-cli.mjs` 也要用它们，
//   而其中最危险的是 `ensureVaultRegistered`：**它写的是用户真实的 Obsidian 配置**
//   （`%APPDATA%\obsidian\obsidian.json`），两份实现漂一次就是把人家整个库列表搞坏。
//   `obsidianPids` 仍然留在本文件 —— 它用的是这里的 `listProcessPids`，那是通用进程查询（Ollama 也用它）。
import {
  obsidianConfigFile, findObsidianExe, viewDirOf, planOpenObsidian,
  isVaultRegistered, ensureVaultRegistered, openExternal, planCloseObsidian, openVault,
} from './obsidian.mjs'
// 这几个原来是从本文件 `export` 出去的，外部还在 import 它们（设置页 + `verify_settings_backend.mjs`
//   盯着 planOpenObsidian / planCloseObsidian / isVaultRegistered …）→ **原样再导出一遍**，对外面子不变。
export {
  findObsidianExe, viewDirOf, planOpenObsidian,
  isVaultRegistered, ensureVaultRegistered, planCloseObsidian,
} from './obsidian.mjs'
/** 按可执行名找 Obsidian 的 pid（win 走 tasklist，其他平台走 pgrep）。 */
async function obsidianPids() {
  if (process.platform === 'win32') {
    const rows = await listProcessPids('Obsidian.exe')
    return rows.map(function (r) { return r.pid })
  }
  return await new Promise(function (resolve) {
    try {
      execFile('pgrep', ['-f', 'Obsidian'], { timeout: 5000 }, function (err, stdout) {
        if (err || !stdout) { resolve([]); return }
        resolve(String(stdout).split(/\r?\n/).map(function (s) { return Number(s.trim()) }).filter(function (n) { return n > 0 }))
      })
    } catch (_e) { resolve([]) }
  })
}

/** GET /dsh-memory-app/view —— 只读状态（开没开、库在哪、登记了没、上次动作） */
let lastViewAction = null
async function viewStatusHandler(req, res) {
  try {
    const root = (typeof lastKnownCwd === 'string' && lastKnownCwd !== '') ? lastKnownCwd : null
    const dir = root ? viewDirOf(root) : null
    const pids = await obsidianPids()
    let registered = null
    try {
      const f = obsidianConfigFile()
      const raw = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
      registered = dir ? (isVaultRegistered(raw, dir) !== null) : false
    } catch (_e) { registered = null }
    sendJson(res, 200, {
      ok: true,
      vaultPath: dir,
      vaultName: dir ? basename(dir) : null,
      viewExists: dir ? existsSync(dir) : false,
      running: pids.length > 0,
      pids: pids,
      registered: registered,
      exe: findObsidianExe(),
      lastAction: lastViewAction,
      error: root ? null : '还没获知工作区 —— 在本会话里发一条消息后就能定位记忆视图'
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

/** POST /dsh-memory-app/view/open —— ① 先刷视图（用户拍板：打开前刷新）② 确保库登记 ③ 打开 */
async function viewOpenHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    const root = (typeof lastKnownCwd === 'string' && lastKnownCwd !== '') ? lastKnownCwd : null
    if (!root) { sendJson(res, 200, { ok: false, error: '还没获知工作区 —— 先在本会话发一条消息' }); return }
    const dir = viewDirOf(root)
    // ① 先刷新（这样"打开就是最新"，不会看到过时副本）
    let refreshed = null
    try {
      const v = await buildView({ root: root, memDir: memDir(), log: function (m) { try { console.log('  [view] ' + m) } catch (_e) {} } })
      refreshed = { ok: v.ok, files: v.files, sections: v.sections, bytes: v.bytes, error: v.error }
    } catch (e) { refreshed = { ok: false, error: String((e && e.message) || e) } }
    // ② 库登记 + ③ 打开：★交给 `openVault` 一处做★（2026-09-16）
    //   旧代码在这里自己拼"登记 + planOpenObsidian + openExternal"，而 `openExternal` 是**发出去就当成功**
    //   → 没装 Obsidian 的机器上会回 `ok:true`，卡片显示"已发出打开请求（若没弹出，看任务栏）"，其实什么都没开。
    //   `openVault` 的规矩是：**找不到 Obsidian.exe 就直接报失败 + 给出路**，而且**不碰**人家的 Obsidian 配置。
    const op = await openVault(dir)
    await new Promise(function (r2) { setTimeout(r2, 1200) })   // 给系统/程序一点启动时间，好如实回"现在开着没"
    const pids = await obsidianPids()
    lastViewAction = {
      at: new Date().toISOString(), action: 'open', via: op.via,
      refreshed: refreshed && refreshed.ok === true, registered: op.registered,
      ok: op.ok === true, error: op.error || null
    }
    sendJson(res, 200, {
      ok: op.ok === true,
      via: op.via,
      uri: op.uri || null,
      refreshed: refreshed,
      registered: op.registered,
      registerError: op.registerError || null,
      hint: op.hint || null,
      running: pids.length > 0,
      pids: pids,
      vaultPath: dir,
      error: op.ok === true ? null : (op.error || '打开失败')
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

/** POST /dsh-memory-app/view/close —— 先优雅关；带 {force:true} 才强杀 */
async function viewCloseHandler(req, res) {
  try {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch (_e) { body = {} }
    const force = body && body.force === true
    const before = await obsidianPids()
    if (before.length === 0) {
      lastViewAction = { at: new Date().toISOString(), action: 'close', forced: force, ok: true, note: '本来就没开' }
      sendJson(res, 200, { ok: true, running: false, pids: [], note: '本来就没开', forced: force })
      return
    }
    await new Promise(function (resolve) {
      const plan = planCloseObsidian(force)      // ★命令怎么拼在纯函数里（夹具盯着"默认不带 /F"）★
      try {
        execFile(plan.cmd, plan.args, { timeout: 12000, windowsHide: true }, function () { resolve() })
      } catch (_e) { resolve() }
    })
    await new Promise(function (r2) { setTimeout(r2, force ? 1200 : 2500) })  // 优雅关要给它存工作区的时间
    const after = await obsidianPids()
    lastViewAction = {
      at: new Date().toISOString(), action: 'close', forced: force,
      ok: after.length === 0, closed: before.length, left: after.length
    }
    sendJson(res, 200, {
      ok: after.length === 0,
      forced: force,
      running: after.length > 0,
      pids: after,
      note: after.length === 0
        ? (force ? '已强制关闭' : '已关闭（优雅退出）')
        : '还有 ' + after.length + ' 个没退 —— 可能在等你保存/确认，想强关就点「强制关闭」'
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
}

// ── 工具注册表（只读）：**这个进程现在到底注册了哪些工具** ─────────────────────
// ★为什么要有这个路由★（用户 2026-09-15 拍板"要做"）：
//   `knowledge/capabilities/` 里那一批 `tool:` 核对项以前**只能一律标"未核"** ——
//   因为"某个工具在不在"只有**跑着的 DSH 进程**自己知道，CLI 侧永远问不到。
//   没有这个出口，"能力点名"就永远点不到工具那一类（30 条全挂在"未核"上）。
// ★它读的是**真注册表**，不是我们写死的名单★（写死 = 又一个"看着有、其实没用"的假东西）：
//   · **宿主全局层**：`ctx.tools.schemas()`（注册表按 scope 分层，不传 scope = 全局视图）；
//   · **每个活着的 agent 那一层**：预设可以把工具注册在 **agent 平面**上 —— web profile 正是
//     把 `tool-fs`/`tool-subagent`/`tool-web` 这些**宿主行关掉、改由预设注册**的
//     （见 `dsh-web-app` 的 cordis.patch.yml）。只问全局层会**大面积假红**，所以活着的 agent 也要问。
// ★只给 name + description★（用户明确要求）：不吐 schema、不吐参数、不吐实现 ——
//   那些是内部结构，搬到这儿只会变成又一份会过期的副本。要精确签名请走 cordis_inspect。
// ★问不到就**如实说**★：`ok:false` + `error`，**绝不**把"没问到"渲染成"没有"或"有"。
async function toolsHandler(req, res, ctx) {
  try {
    let tools
    try { tools = ctx.tools } catch (_e) { tools = undefined }
    if (!tools || typeof tools.schemas !== 'function') {
      try { tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined } catch (_e2) { tools = undefined }
    }
    if (!tools || typeof tools.schemas !== 'function') {
      sendJson(res, 200, { ok: false, count: 0, tools: [], error: '拿不到工具注册表（ctx.tools.schemas 不可用）' })
      return
    }
    const seen = new Map()
    const take = function (schemas, from) {
      for (const s of (schemas || [])) {
        if (!s || typeof s.name !== 'string' || s.name === '') continue
        if (seen.has(s.name)) continue
        seen.set(s.name, { name: s.name, description: String(s.description || ''), from: from })
      }
    }
    take(tools.schemas(), 'host')                     // 宿主全局层
    let agents = []
    try {
      const reg = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (reg && typeof reg.list === 'function') agents = reg.list() || []
    } catch (_e) { agents = [] }
    for (const a of agents) {
      try { take(tools.schemas(a), 'agent') } catch (_e) { /* 某个 agent 问不到 → 跳过它，不拖垮整个回答 */ }
    }
    const list = [...seen.values()].sort(function (a, b) { return a.name < b.name ? -1 : 1 })
    sendJson(res, 200, {
      ok: true,
      count: list.length,
      tools: list.map(function (t) { return { name: t.name, description: t.description } }),
      // ↓ 这几格是"**这次到底问了谁**"的如实记录，**不是工具本身的信息**。
      //   必须有它：否则"真没有"和"这次没问到那一层"在调用方看来长得一模一样 —— 红与绿都会报错。
      scopes: { host: true, agents: agents.length },
      agentOnly: list.filter(function (t) { return t.from === 'agent' }).map(function (t) { return t.name }),
      at: new Date().toISOString(),
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, count: 0, tools: [], error: String((e && e.message) || e) })
  }
}

export function apply(ctx) {
  // ★2026-09-16「一个插件」★：把收进包内的 dsh-persist 分叉挂成子插件。
  //   上游 dsh-persist 是**第三方插件**（DSH 不带它），而整套记忆（USER/MEMORY 每轮注入、
  //   memory 工具、Vault 语义库、/dsh-memory/ 管理页与「记忆」tab）都建在它上面。
  //   收进本包 + 这里挂载 ⇒ 对外只装一个插件。子插件自带 inject，服务沿 Cordis 树往上找。
  //   ⚠️ apply() 不是 async（Cordis 允许异步挂载，但这里保持同步签名）→ 用 .then()。
  if (!globalThis.__dshMemoryPersistMounted) {
    globalThis.__dshMemoryPersistMounted = true
    import('./vendor/dsh-persist/index.js').then(function (persist) {
      ctx.plugin({ name: persist.name, inject: persist.inject, apply: persist.apply })
    }).catch(function (e) {
      console.error('★[dsh-memory-app] 挂载内置分叉失败（USER/MEMORY 注入与 memory 工具会缺失）★', e)
    })
  }

  // ★`DSH_MEMORY_NO_AUTO=1` = 关掉**所有自动后台行为**（清理 / 补转写 / 重建索引 / 折叠钩子）★
  //   为什么必须有这个开关（2026-09-14 实测）：桩测试只给 `{webServer, systemPrompt, tools}` 这种
  //   假 ctx 就调 `apply()`，于是**插件的真启动逻辑在测试进程里照跑** —— 我的新代码在 6 秒后
  //   真的扫了会话目录、**往真语料里写了 1 份转写**（`corpus-auto.log` 里那行就是它）。
  //   这违反项目铁律「**测试不许动用户的工具，也不许动用户的数据**」。
  //   现在：桩测试的统一入口 `verify_real/sync_real.mjs` 会在 import 时置上这个变量；
  //   想真测这些行为的套件（如 `verify_corpus_auto.mjs`）自己把它删掉再调 apply()。
  const NO_AUTO = process.env.DSH_MEMORY_NO_AUTO === '1'

  // 协作 SOP 开关的路由（客户端设置页的打勾调用它）
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/sop', handler: sopHandler })

  // ★初始化向导（2026-09-16）★ 新用户装上时什么骨架都没有：这里给一条
  //   检测 → 装 Ollama/模型 → 选工作区建骨架 → 分析他自己的文档生成专属 SOP → 收尾体检 的路。
  // ★2026-09-16★ 把"当前会话的工作区"作为初始化向导的**默认建议根目录**（lastKnownCwd 由 systemPrompt
  //   装配回调学到）；用户也可以改成别处。绝不拿进程 cwd 当默认。
  registerInitRoutes(ctx, {
    suggestRoot: function () {
      return (typeof lastKnownCwd === 'string' && lastKnownCwd !== '') ? lastKnownCwd : null
    },
  })

  // ★2026-09-16★ 维护作业的路由（/maintain/list、/maintain/run）——设置页「维护」卡用它。
  //   根目录同样优先用"当前会话的工作区"，没有就问 init.json（初始化向导记下来的那个）。
  registerMaintainRoutes(ctx, {
    suggestRoot: function () {
      return (typeof lastKnownCwd === 'string' && lastKnownCwd !== '') ? lastKnownCwd : null
    },
  })

  // 设置页「记忆」的路由：读/写嵌入器配置 + 状态 + 自检（自检不写 Vault）
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/embedder', handler: embedderHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/embedder/selftest', handler: embedderSelftestHandler })
  // Ollama 进程：检测在状态里，这里给启停、拉取模型、预热、卸载的出口
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/start', handler: ollamaActionHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/stop', handler: ollamaActionHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/pull', handler: ollamaActionHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/warm', handler: ollamaActionHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/unload', handler: ollamaActionHandler })
  // 收掉残留的本地模型进程（服务没了但显存还被占着时的出口）
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ollama/clean', handler: ollamaActionHandler })
  // 写入流：把核心记忆（或任意长文）按结构切块下沉进 Vault
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/ingest', handler: ingestHandler })
  // Vault 同步：状态（只读检查，显示"过期了没"）+ 手动一键重建
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/vault-sync/status', handler: vaultSyncStatusHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/vault-sync/run', handler: vaultSyncRunHandler })
  // ⑨ 自动转写：状态（只读）+ 手动补一把
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/corpus/status', handler: corpusStatusHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/corpus/run', handler: corpusRunHandler })
  // ⑤ 语义判官：**只读**状态路由（"上次跑成什么样"）。
  //   ★跑的那一下只在下面那个工具里★ —— 这个路由绝不触发外发（它是以后设置页按钮的读数口）。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-memory-app/semantic/status',
    handler: function (req, res) { return semanticStatusHandler(req, res, ctx) }
  })
  // ⑧ 记忆视图（Obsidian）：状态（只读）/ 打开（先刷新再开）/ 关闭（先优雅，带 {force:true} 才强杀）
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/view', handler: viewStatusHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/view/open', handler: viewOpenHandler })
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-app/view/close', handler: viewCloseHandler })
  // 工具注册表（**只读**）：回答"这个进程现在注册了哪些工具" —— 给能力点名器做 `tool:` 的运行时核。
  // ★它是只读的、且**不碰任何用户的东西**★（只问注册表），所以测试可以放心在真服务端上打它。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-memory-app/tools',
    handler: function (req, res) { return toolsHandler(req, res, ctx) }
  })

  // ★⑨ 自动转写的**主触发**：折叠一完成，就把**那一个**会话转成文本★
  //   为什么挂在折叠上：DSH 折叠会把之前的对话**摘要替换掉**，原文只剩日志 ——
  //   就在这一刻落一份可读副本，正是"压缩不丢状态"要的东西。
  //   实测依据（2026-09-14）：会话日志里 `compaction/end` 是**一等公民事件**
  //   （`{compactionId, turn}`，本次会话 9 次），不是拿"上下文快满"去猜。
  //   ⚠️ **就算这个钩子一次都不触发，开机补扫也会兜住** —— 那是保证，这个只是"立刻"。
  //   ★`typeof ctx.on === 'function'` 这道防御是有意的★：`on` 是 Cordis 的订阅能力，
  //     但**桩测试的 ctx 不一定给**（2026-09-14 实测：加上这行后 8 个桩套件全崩在
  //     `ctx.on is not a function`）。**插件不该因为"某个可选能力不存在"就把宿主带崩** ——
  //     拿不到钩子只是退化成"靠开机补扫"，功能仍在。
  //     钩子本身由 `verify_real/verify_corpus_auto.mjs` 专门测（那里**提供** on 并真的触发它）。
  if (typeof ctx.on === 'function' && !NO_AUTO) {
    ctx.on('session/event', function (session, event) {
      try {
        if (!event || event.type !== 'compaction/end') return
        const sid = String((session && (session.id || (session.header && session.header.id))) || '')
        const key = sid.replace(/^session-/, '')          // 日志目录名有的带 session- 前缀、有的不带
        if (key === '') return
        runAutoTranscribe('compaction', key).catch(function () {})
      } catch (_e) { /* 监听器绝不许把宿主搞崩 */ }
    })
  }

  if (!NO_AUTO) {
    // DSH 启动后 3 秒：**不自动拉起 Ollama**（用户要自己去设置里点启动），
    // 只做清理：① 按 PID 记录清真正的孤儿；② 按路径清 Ollama 残留的跑模型进程（强杀场景的兜底）。
    setTimeout(function () { bootCleanup().catch(function () {}); }, 3000)

    // DSH 启动后 6 秒：**先补转写（最多 5 份），再自动重建 Vault 索引**。
    // ★顺序是有意的★：反过来的话，索引会落在"旧卡片"上 → 新会话得等到下次同步才搜得到。
    // ★这是"索引永不过期"的兜底★ —— 不依赖任何人记得手动跑脚本。
    //   补转写同时也是**折叠钩子失灵时的保险**：强杀/断电漏掉的会话，开机扫"日志比转写新"就补上。
    //   放在 bootCleanup 之后，免得两件事抢资源。
    setTimeout(function () {
      runAutoTranscribe('boot').then(function () {
        return runVaultSync('boot')
      }).catch(function () {})
    }, 6000)
  }

  // 协作 SOP 叠加层（可选开关：sop.enabled 标志存在即注入；SOP.md 只存内容、永久保留）
  // ★必须 cap★ —— 2026-09-13 用 `memory/tools/budget.mjs` 量入口预算时发现：
  //   这是**唯一一份裸着 readFileSync 直接塞进提示的注入文件**，别人都有闸。
  //   后果：SOP.md 想长多长就多长，**每轮都在无声地吃掉窗口** —— 正是"被静默截断 = 白写且不报错"的反面
  //   （那个至少还会截断，这个连截断都没有，是**无上限膨胀**）。
  // 上限取 8000，与台账一致；**截断标记必须显眼**（规则被截掉比不注入更坏：会让人以为"写了就等于生效了"）。
  const SOP_CAP = 8000
  ctx.systemPrompt.section({
    name: 'dsh-memory-app-sop',
    order: 56,
    text: () => {
      if (!existsSync(sopFlagFile())) return ''
      const f = sopFile()
      if (!existsSync(f)) return ''
      try {
        const s = readFileSync(f, 'utf8')
        if (s.length <= SOP_CAP) return s
        return s.slice(0, SOP_CAP) +
          '\n\n…[★SOP.md 超过 ' + SOP_CAP + ' 字符，后面被截断了★ —— 规则被截掉比不注入更坏，' +
          '请立刻精简 SOP.md：把「为什么」挪进档案，SOP 只留规矩本身]'
      } catch (_e) { return '' }
    }
  })

  // 写半边：台账维护纪律（host 级 section，所有预设每轮注入）
  ctx.systemPrompt.section({
    name: 'dsh-memory-app-discipline',
    order: 58,
    text: '【记忆纪律（所有模式自动生效）】\n- 改动代码前：先读项目根 PROJECT_LEDGER.md 与 AGENTS.md（若存在），预估影响面与 BUG。\n- 改动后：回归验证全部"已验证功能"（不只测刚改的那处），并更新台账（当前状态/已验证清单/修复记录/待办）。\n- 一次只改一件事；坏了找根因修，不靠反复回退。\n- 上下文压缩后：先重读 AGENTS.md 与台账再继续。\n- 项目完结后：主动起草 ≤10 条"这阶段我更懂你什么"（带证据）给用户确认，写入 ~/.dsh-memory/impressions/ 对应档案。'
  })

  ctx.systemPrompt.context({
    name: 'dsh-memory-app-ledger',
    order: 55,
    text: (assembleCtx) => {
      const cwd = assembleCtx.agent && assembleCtx.agent.session && assembleCtx.agent.session.header
        ? assembleCtx.agent.session.header.cwd : undefined
      // ★记下"会话的工作区"，Vault 同步只用它★ —— **绝不能用 `process.cwd()`**：
      //   2026-09-12 实测踩过：DSH 从桌面快捷方式启动时 process.cwd() 不是工作区，
      //   结果扫到 0 份台账/0 份档案，**还把好的手写 `目录` 用"自动生成的兜底版"覆盖了**（580→564 块）。
      if (typeof cwd === 'string' && cwd !== '') maybeSyncForCwd(cwd)
      const parts = []
      if (cwd) {
        const agents = readFile(cwd, 'AGENTS.md')
        const ledger = readFile(cwd, 'PROJECT_LEDGER.md')
        // 标题带上【路径】：同名文件有多份（根的=工作区地图，项目的=项目规则），
        // 不带路径就会看不出这是哪一份（用户 2026-09-12 提出的）。
        if (agents) parts.push('## AGENTS.md（' + cwd + '）\n' + cap(agents, 4000))
        if (ledger) parts.push('## PROJECT_LEDGER.md（' + cwd + '）\n' + cap(ledger, 8000))
      }
      // 额外注入清单：本守卫只认【当前目录】下的台账，而项目其实住在子文件夹里
      // （比如在根目录开会话、项目在 memory/）。清单里列出来，就照样每轮注入。
      // ★ 去重必须先把路径【规范化】：`E:/a/b` 与 `E:\a\b` 是同一个文件，直接比字符串会漏
      //   （2026-09-12 实测：不规范化的话，在 memory/ 下开会话会把台账注入两遍 → 上下文白涨一倍）。
      const norm = function (p) {
        try { return resolve(p).replace(/\\/g, '/').toLowerCase() } catch (_e) { return String(p).replace(/\\/g, '/').toLowerCase() }
      }
      const seen = new Set()
      if (cwd) {
        seen.add(norm(join(cwd, 'AGENTS.md')))
        seen.add(norm(join(cwd, 'PROJECT_LEDGER.md')))
      }
      for (const f of injectFiles()) {
        if (seen.has(norm(f))) continue;                       // 当前目录已经注入了，别重复
        seen.add(norm(f))
        try {
          if (!existsSync(f)) continue
          const body = readFileSync(f, 'utf8')
          if (body.trim() === '') continue
          parts.push('## 额外注入：' + basename(f) + '（' + dirname(f) + '）\n' + cap(body, 8000))
        } catch (_e) {}
      }
      return parts.join('\n\n')
    }
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '本地语义检索：按意思查找记忆（Ollama qwen3-embedding，零外发）。**数据源 = Vault**（永远最新），不再是那个静态缓存的 embeddings.json —— 后者只会返回改版前的旧文本、且不报错，已确诊会喂过期内容（2026-09-12）。可传 namespace 把范围收到某个分区（如 会话 / voice / index / core）。返回最相关条目（分区+内容+相似度），用于"想不起时找到"某个约定/坑/进度。',
    parameters: {
      query: { type: 'string', required: true, description: '要查的内容/问题' },
      topK: { type: 'number', description: '返回条数，默认 5' },
      namespace: { type: 'string', description: '可选：只在这个分区里查（会话 / voice / ppt / upload / dsh-upgrade / desktop-scripts / index / core / 记忆系统）' }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      try {
        const q = String(args.query || '').trim()
        if (q === '') return { ok: false, error: 'query 不能为空' }
        const store = await getVaultStore()
        const k = Math.max(1, Math.min(Number(args.topK) || 5, 20))
        const ns = args.namespace ? String(args.namespace) : null
        const hits = await store.search(q, k, ns || undefined)
        return {
          ok: true,
          source: 'vault',
          namespace: ns || '(全部)',
          hits: (hits || []).map(function (h) {
            // ★ 字段名以 VaultStore.search 的实际返回为准：它给的是 `namespace` / `content` / `score`（不是 `ns`）。
            //   2026-09-12 实测踩过：我按 `h.ns` 映射，结果每条 hit 的 namespace 都是 undefined（测试当场抓到）。
            const ns = h.namespace !== undefined ? h.namespace : h.ns
            const text = h.content !== undefined ? h.content : h.text
            return {
              namespace: ns,
              text: text,
              score: Math.round(Number(h.score || 0) * 1000) / 1000,
              id: h.id
            }
          })
        }
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'memory_ingest',
    description: '把一份长文（核心记忆文件或任意文本）按结构切块后写进 Vault 的某个 namespace（先清后写，重复跑不会堆积）。用途：台账/画像/长期记忆"细节下沉"——文件留当前状态，完整正文切块进 Vault 供语义检索。path 或 text 二选一；dryRun=true 只回报切块结果、不写库。返回每块的 id 与开头，可写成指针 `vault:<namespace>#<id>`。',
    parameters: {
      path: { type: 'string', description: '要入档的文件绝对路径（与 text 二选一）' },
      text: { type: 'string', description: '要入档的文本（与 path 二选一）' },
      namespace: { type: 'string', description: '写进哪个分区，如 core / 记忆系统 / 索引' },
      maxChars: { type: 'number', description: '单块字数上限，默认 500' },
      dryRun: { type: 'boolean', description: '只切块、不写库' }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      try {
        return await ingestToVault(args || {})
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'memory_quiz',
    description: '抽查考试：记录用户对历史问题的评分，回读成绩统计。错题进纠错闭环（改档案后重考）。action=record 记一条（question/answer/correct）；action=report 回读成绩。',
    parameters: {
      action: { type: 'string', required: true, description: 'record | report' },
      question: { type: 'string', description: '用户问的历史问题（record 用）' },
      answer: { type: 'string', description: '你的回答要点（record 用）' },
      correct: { type: 'boolean', description: '用户判定是否正确（record 用）' }
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      try {
        const f = quizFile()
        if (args.action === 'record') {
          mkdirSync(dirname(f), { recursive: true })
          appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), question: args.question || '', answer: args.answer || '', correct: !!args.correct }) + '\n')
          return { ok: true, recorded: true }
        }
        if (args.action === 'report') {
          let rows = []
          if (existsSync(f)) {
            rows = readFileSync(f, 'utf8').split('\n').filter((x) => x.trim()).map((x) => { try { return JSON.parse(x) } catch (_e) { return null } }).filter(Boolean)
          }
          const total = rows.length
          const correct = rows.filter((x) => x.correct).length
          return { ok: true, total, correct, correctRate: total ? Math.round((correct / total) * 100) : 0, wrong: rows.filter((x) => !x.correct).slice(-10) }
        }
        return { ok: false, error: 'unknown action: ' + String(args.action) }
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    }
  }))

  // ⑤ 校验层 · 语义判官：机械测不出的那类矛盾（端口/路径/版本冲突、"已停用"vs"正在用"、
  //   数字打架），交给**现在 DSH 正在用的那个模型**判。
  //   ★为什么住插件里★：`ctx.get('llm')` 只有 DSH 进程里才有 —— CLI 侧永远拿不到它。
  //   ★为什么必须手动★：它**会外发**（每组 ≤600 字摘录发给当前模型；用户 2026-09-14 拍板可接受）。
  //     所以 boot / 折叠 / 同步**一概不自动调它** —— 只在这里被显式调一次。
  ctx.tools.register(defineTool({
    name: 'memory_semantic_scan',
    description: '⑤校验层·语义判官：把 Vault 里"共享同一个稀有实体（端口/路径/文件名/版本/型号/指针）"的记忆块两两配对，一次性问"现在这个模型"它们是否互相打架（矛盾）。★会外发★——每组只发 ≤600 字摘录给当前模型（用户 2026-09-14 拍板可接受）；只读 Vault，不写库、不动语料、不动台账。结果原子写到 <记忆库>/corrections/semantic-latest.json，再用 `node memory/tools/semantic_import.mjs` 并进裁决台账。**只在被显式调用时跑**（boot/折叠/同步都不会自动触发）。limit = 取最近多少块进候选池（默认 60，上限 200）：调大更全但更慢、外发更多。',
    parameters: {
      limit: { type: 'number', description: '取最近多少块进候选池，默认 60，上限 200（调大更全但外发更多）' },
      maxTokens: { type: 'number', description: '模型输出上限，默认 8000（★这台模型先"思考"再回答：2026-09-14 实测 1200 时思考就吃满 1200、回答 0 字 → 别调太小★）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: (v && v.report) ? v.report : JSON.stringify(v, null, 2) }]
    },
    async execute(args) {
      try {
        // ★默认 60 / 上限 200（用户 2026-09-14 拍板）★：真库实测曲线 limit=8→0 对 ／ 12→2 ／ 20→3 ／
        //   40→9 ／ 60→10（满）—— 默认 8 等于"一按就说没候选"。上限 200 与 runSemanticScan 内部 clamp 对齐。
        const raw = args && args.limit !== undefined ? Number(args.limit) : 60
        const limit = Math.max(1, Math.min(Number.isFinite(raw) ? Math.floor(raw) : 60, 200))
        // ★maxTokens 也暴露出来★：2026-09-14 首次真调就是栽在"思考吃满额度"上 ——
        //   以后调额度不该再走一次"改代码 + 重装 + 重启"，工具参数里直接给就行（判官内部还有 100..32000 兜底）。
        const rawTok = args && args.maxTokens !== undefined ? Number(args.maxTokens) : 8000
        const maxTokens = Math.max(100, Math.min(Number.isFinite(rawTok) ? Math.floor(rawTok) : 8000, 32000))
        const r = await runSemanticScan({ ctx: ctx, memDir: memDir(), limit: limit, maxTokens: maxTokens })
        return Object.assign({}, r, { report: semanticReport(r) })
      } catch (e) {
        // 兜底：判官自己已经"绝不抛"了，这里防的是我没预料到的东西 —— 绝不让用户看见一坨栈
        const r = { ok: false, error: e && e.message ? e.message : String(e), scannedBlocks: 0, pairs: 0, verdicts: [], wrote: false, outFile: semanticLatestFile(), model: null }
        return Object.assign({}, r, { report: semanticReport(r) })
      }
    }
  }))
}
