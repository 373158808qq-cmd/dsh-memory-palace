// 初始化向导（宿主端）★2026-09-16 新增★
//
// 为什么要有它：新用户装上插件时**什么骨架都没有** —— 没有 SOP、没有工作区地图、没有台账、
// 没有 Ollama/模型、没有记忆视图。系统不会崩，但会**静默半空转**（只有两条占位模板在注入），
// 这正是我们最不该给别人的第一印象。向导把"没有"变成"有"，走完就和老用户的设置页一模一样。
//
// 设计约定（用户 2026-09-16 拍板）：
//   · SOP：出厂默认**只含「东西放哪/目录结构」**；用户可【浏览文件夹】选一份自己的文档 →【分析】
//     → 用 **DSH 自己的 LLM**（进程内 `ctx.get('llm')`，不外发到别处）生成**他专属的 SOP 草稿**
//     → 他确认后才写盘。
//   · Ollama：检测 → 有则**落盘记录**；没有 →【安装】（后台调安装器）／【浏览文件夹】指到已有的
//     ollama.exe（防误判）。装失败 → 明确指引"去会话里让 DSH 装"。
//   · 模型：只检测 + 安装（`ollama pull`），**没有浏览**（模型必须从 Ollama 里找）。
//   · 工作区骨架：**先列清单、用户勾选后才建**，且**只建不存在的**（绝不覆盖用户已有文件）。
//   · 收尾：跑一遍体检，**全绿才算初始化完成**。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const MEM = function () { return join(homedir(), '.dsh-memory') }
const F = function (n) { return join(MEM(), n) }
const DEFAULT_MODEL = 'qwen3-embedding:0.6b'

export function readInit() { try { return JSON.parse(readFileSync(F('init.json'), 'utf8')) } catch (_e) { return {} } }
export function writeInit(patch) {
  const next = Object.assign({}, readInit(), patch, { at: new Date().toISOString() })
  try { if (!existsSync(MEM())) mkdirSync(MEM(), { recursive: true }); writeFileSync(F('init.json'), JSON.stringify(next, null, 2) + '\n', 'utf8') } catch (_e) {}
  return next
}

/** ★2026-09-16★ 模型"装没装"看**磁盘清单**，不需要 Ollama 在跑（用户拍板：检测只看装没装）。 */
function modelOnDisk(want) {
  const roots = [process.env.OLLAMA_MODELS, join(homedir(), '.ollama', 'models')].filter(Boolean)
  const parts = String(want || '').split(':')
  const name = parts[0], tag = parts[1] || 'latest'
  for (const r of roots) {
    const direct = join(r, 'manifests', 'registry.ollama.ai', 'library', name, tag)
    if (existsSync(direct)) return direct
    const md = join(r, 'manifests')
    if (!existsSync(md)) continue
    try {
      for (const reg of readdirSync(md)) {                       // 别的 registry 也兜一下
        const d1 = join(md, reg)
        if (!statSync(d1).isDirectory()) continue
        for (const ns of readdirSync(d1)) {
          const cand = join(d1, ns, name, tag)
          if (existsSync(cand)) return cand
        }
      }
    } catch (_e) {}
  }
  return null
}

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise(function (done) {
    let b = ''
    req.on('data', function (c) { b += c; if (b.length > 1 << 22) req.destroy() })
    req.on('end', function () { try { done(b ? JSON.parse(b) : {}) } catch (_e) { done({}) } })
    req.on('error', function () { done({}) })
  })
}
const exists = function (p) { try { return existsSync(p) && statSync(p).isFile() } catch (_e) { return false } }

// ─────────────── Ollama（运行时 + 模型） ───────────────
async function probeTags(endpoint) {
  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    const j = await r.json()
    return Array.isArray(j.models) ? j.models : []
  } catch (_e) { return null }
}
/** 找一个已存在的 ollama 可执行文件：① 用户记录过的路径 ② PATH ③ 常见安装目录 */
export function locateOllama() {
  const rec = readInit().ollamaExe
  if (rec && typeof rec === 'string' && existsSync(rec)) return rec
  try {
    const out = execFileSync('where', ['ollama'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim()
    if (out && existsSync(out)) return out
  } catch (_e) {}
  const cands = [
    join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    'C:/Program Files/Ollama/ollama.exe',
    '/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama',
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}
/** 检测 Ollama：运行时（API 通）+ 模型名列表。API 不通但找到 exe 也算"装了没启" */
export async function detectOllama() {
  const st = readInit()
  const endpoint = st.ollamaEndpoint || 'http://127.0.0.1:11434'
  const models = await probeTags(endpoint)
  const exe = locateOllama()
  const running = models !== null
  const names = running ? models.map(function (m) { return m.name || m.model }).filter(Boolean) : []
  // ★判据 = 装了没装★（有 exe，或 API 通）；**跑没跑只作附注** ——
  //   用户的口径：Ollama 不自动启动、由他在设置页自己启；初始化不该以"没在跑"卡住他。
  const installed = running || !!exe
  if (installed) writeInit({ ollamaEndpoint: endpoint, ollamaExe: exe || undefined, ollamaRuntimeOk: running, modelsSeen: names })
  return { ok: installed, installed: installed, running: running, how: running ? 'api' : (exe ? 'exe-only' : 'none'), endpoint: endpoint, exe: exe, models: names }
}
/** 模型：照用户定的流程 —— 检测→有→记录；检测→无→请求安装（无浏览） */
export async function detectModel() {
  const st = readInit()
  const want = st.model || DEFAULT_MODEL
  // ① 先看磁盘（不需要 Ollama 在跑）② 再问 API（在跑的话更权威）
  const onDisk = modelOnDisk(want)
  const o = await detectOllama()
  const inApi = o.models.some(function (n) { return n === want || n.split(':')[0] === want.split(':')[0] })
  if (onDisk || inApi) { writeInit({ model: want, modelOk: true }); return { ok: true, want: want, onDisk: onDisk || null, inApi: inApi } }
  return { ok: false, want: want, missing: true, detail: o.installed ? '模型还没下载（点【安装模型】）' : '先装 Ollama，再下载模型' }
}

// ─────────────── 装 Ollama（路由与 init-cli 共用同一份实现） ───────────────
/** ★2026-09-16★ 后台下载 + 静默安装 Ollama。
 *  为什么抽成导出函数：**路由和 `init-cli.mjs` 必须共用一份实现** ——
 *  两处各写一份 = 迟早不一致（本项目为这类漂移付过代价：切块器 CLI/已装两套）。
 *  @returns {{ok:boolean, started?:boolean, file?:string, note?:string, error?:string}} */
export function installOllama() {
  const st = readInit()
  if (st.ollamaInstalling) return { ok: false, error: '已经在装了（' + st.ollamaInstalling + '）' }
  const url = process.platform === 'win32'
    ? 'https://ollama.com/download/OllamaSetup.exe'
    : 'https://ollama.com/install.sh'
  const tmp = join(MEM(), process.platform === 'win32' ? 'OllamaSetup.exe' : 'ollama-install.sh')
  writeInit({ ollamaInstalling: 'downloading', ollamaInstallUrl: url, ollamaInstallFile: tmp })
  // 后台下载 + 安装（不阻塞调用方）；失败要出声，且指引"去会话里让 DSH 装"
  try {
    const dl = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-L', '-o', tmp, url], { windowsHide: true, detached: true, stdio: 'ignore' })
    dl.unref()
    dl.on('exit', function (code) {
      if (code !== 0 || !existsSync(tmp)) { writeInit({ ollamaInstalling: null, ollamaInstallError: '下载失败（curl 退出码 ' + code + '）' }); return }
      const inst = process.platform === 'win32'
        ? spawn(tmp, ['/S'], { windowsHide: true, detached: true, stdio: 'ignore' })
        : spawn('sh', [tmp], { windowsHide: true, detached: true, stdio: 'ignore' })
      inst.unref()
      inst.on('exit', function (c) {
        writeInit({ ollamaInstalling: null, ollamaInstallExit: c, ollamaInstallAt: new Date().toISOString() })
      })
    })
    return { ok: true, started: true, file: tmp, note: '后台安装中；装完回到这里点【重新检测】。装不上就回会话里说一句"帮我装 Ollama"，让 DSH 来装。' }
  } catch (e) {
    writeInit({ ollamaInstalling: null, ollamaInstallError: String(e && e.message || e) })
    return { ok: false, error: '起不来安装进程：' + String(e && e.message || e) + '　→ 请回会话里让 DSH 帮你装。' }
  }
}

// ─────────────── SOP ───────────────
const SOP = function () { return F('SOP.md') }
const SOP_FLAG = function () { return F('sop.enabled') }
export function detectSop() {
  const p = SOP()
  if (!exists(p)) return { ok: false, detail: '还没有 SOP.md' }
  const t = readFileSync(p, 'utf8')
  const hasStruct = /东西放哪|目录结构|建项目就按这个/.test(t)
  const isDefault = /出厂基础版/.test(t)
  return { ok: true, chars: t.length, hasStruct: hasStruct, isDefault: isDefault, detail: isDefault ? '还是出厂基础版（只含目录结构约定）' : '已有你自己的 SOP（' + t.length + ' 字符）' }
}
export function defaultSopText() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), 'default-sop.md')
    if (existsSync(p)) return readFileSync(p, 'utf8')
  } catch (_e) {}
  return '# 协作 SOP（出厂基础版）\n\n## 一、东西放哪\n- 一个项目一个文件夹；工作区根只放共用的东西。\n'
}
/** ★分析用户自己的文档 → 生成专属 SOP 草稿（用 DSH 自己的 LLM，不外发）★ */
export async function analyzeDocForSop(ctx, docPath, opts) {
  const o = opts || {}
  let raw = ''
  let label = ''
  if (o.text && String(o.text).trim() !== '') {
    // ★浏览器里选的文档走这条★：浏览器拿不到服务器绝对路径，但能把文件内容读成文本传过来，
    //   这样"浏览文件夹/文件"由浏览器原生控件完成，服务端不需要任何路径权限。
    raw = String(o.text)
    label = String(o.name || '(浏览器选择的文档)')
  } else {
    const p = resolve(String(docPath || ''))
    if (!exists(p)) throw new Error('文件不存在：' + p)
    raw = readFileSync(p, 'utf8')
    label = p
  }
  const MAX = 60000
  const doc = raw.length > MAX ? raw.slice(0, MAX) + '\n…（原文太长，已截断到 ' + MAX + ' 字符）' : raw
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('这个运行环境没有可用的 LLM 服务，无法分析（可先把文档内容贴进对话，让 agent 帮你写）')
  const base = defaultSopText()
  // ★2026-09-16 改设计★：第一版让模型"保留目录结构 + 提炼其余"，实测它**把出厂 SOP 抄了一遍、
  //   用户的规矩没提炼出来**（草稿 1,876 字符基本等于基础版）。现在**目录结构由我们自己拼**，
  //   模型只干"从用户文档里提炼规矩"这一件事 —— 既不会毁掉机制依赖的那一段，也逼它真的去读文档。
  const system = [
    '你在帮用户把他自己的协作/交接文档，提炼成"给 AI 看的硬规矩"。',
    '要求：① 全程中文；② 只写"该怎么做"，一条一句，不写理由、不写过程；③ 不要寒暄、不要开场白、不要说你在做什么；',
    '④ **只输出从这份文档里提炼出来的规矩**（不要重复什么"目录结构""东西放哪"这类约定，那部分我会自己拼）；',
    '⑤ 按文档实际内容分节，例如：沟通方式／工作方式／验证与交付／编码铁律／记忆与复盘（文档没有的节就别写）；',
    '⑥ 直接输出 Markdown 正文（从 `## 一、…` 开始），总长 ≤ 4000 字符。',
  ].join('\n')
  const ask = '【用户自己的文档】文件名：' + label + '\n```\n' + doc + '\n```\n\n请按上面的要求提炼。'
  let out = ''
  const env = String(process.env.DSH_MEMORY_JUDGE_MODEL || '').trim()
  const [pv, md] = env ? env.split('/') : []
  const target = (pv && md) ? { provider: pv, model: md } : { provider: 'deepseek-official', model: 'deepseek-chat' }
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    system: system,
    messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }],
    temperature: 0.2,
    maxTokens: o.maxTokens || 4000,
    signal: AbortSignal.timeout(o.timeoutMs || 120000),
  })) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  if (out.trim() === '') throw new Error('模型没有返回内容（可能被风控或超长截断），请再试一次或换短一点的文档')
  // 拼装：机制依赖的目录结构（出自我们，逐字）＋ 模型从用户文档提炼的规矩
  const draft = base.trimEnd() + '\n\n---\n\n## 附：从你自己的文档提炼的规矩\n\n' + out.trim() + '\n'
  return { draft: draft, docPath: label, docChars: raw.length, draftChars: draft.length, extractedChars: out.trim().length }
}

// ─────────────── 工作区骨架 ───────────────
function wsRoot() { return readInit().root || null }
function ledgerTemplate(name) {
  return '# PROJECT_LEDGER — ' + name + '（台账）\n\n' +
    '> **只放"当前状态"**：大进度／已验证／未验收／待办／铁律／指针。做完的细节进 `PROJECT_LEDGER_ARCHIVE.md`（不进上下文）。\n' +
    '> 上限 8000 字符；指针写 `file:<路径>#<标题>` 或 `vault:<分区>#<标题>`（用标题当锚点）。\n\n' +
    '日期: ' + new Date().toISOString().slice(0, 10) + '　阶段: 起步\n\n' +
    '## 大进度\n- （还没开始）\n\n## 未验收\n| 项 | 目标 | 实况 |\n|---|---|---|\n| —— | —— | —— |\n\n## 接下来\n1. （写下下一步）\n'
}
function mapTemplate(root) {
  return '# AGENTS.md — 工作区地图（' + root + '）\n\n' +
    '> 这是**工作区级**说明：只讲"东西在哪、去哪看"。项目细节放各项目自己的文件夹里。\n\n' +
    '## 全局规矩\n' +
    '- 干活前读该项目的 `AGENTS.md` 与 `PROJECT_LEDGER.md`；改完更新台账。\n' +
    '- 根目录只放"整个工作区共用"的东西；只服务于某一个项目的东西进该项目文件夹。\n\n' +
    '## 项目地图\n| 文件夹 | 项目 | 该看哪 |\n|---|---|---|\n| `（项目名）/` | （一句话） | `（项目名）/PROJECT_LEDGER.md` |\n'
}
function indexTemplate() {
  return '# INDEX.md — 项目总目录\n\n> 只回答"**有没有、在哪、现在到哪了**"。细节去各项目台账/档案。\n\n' +
    '| 项目 | 是什么 | 现在到哪了 | 细节在哪 |\n|---|---|---|---|\n| （项目名） | （一句话） | （进度） | `（项目名）/PROJECT_LEDGER.md` |\n'
}
/** 列清单（只读，不写盘）：告诉用户"点了会建哪些文件" */
export function skeletonPlan(root) {
  // ★2026-09-16 修（用户截图指出）★：以前 root 为空时 `resolve('')` 会落到**进程 cwd**，
  //   界面上就冒出了 `C:\Users\1\Desktop\AGENTS.md` 这种路径。根目录**只能由用户选**：
  //   空 → 明确报"还没选"，绝不猜。默认建议由 status 的 suggest 给出（当前会话的工作区）。
  if (!root || String(root).trim() === '') {
    return { root: null, items: [], need: '还没选工作区根目录 —— 建议用你当前会话的工作区（点【用当前工作区】），也可以填别处' }
  }
  const r = resolve(String(root))
  const items = [
    { key: 'agents', path: join(r, 'AGENTS.md'), what: '工作区地图（项目清单 + 全局规矩）', exists: exists(join(r, 'AGENTS.md')) },
    { key: 'memory_dir', path: join(r, 'memory'), what: '记忆系统项目文件夹（放 INDEX.md 与它自己的台账）', exists: existsSync(join(r, 'memory')) },
    { key: 'index', path: join(r, 'memory', 'INDEX.md'), what: '项目总目录（每轮注入，回答"有没有、在哪"）', exists: exists(join(r, 'memory', 'INDEX.md')) },
    { key: 'ledger', path: join(r, 'memory', 'PROJECT_LEDGER.md'), what: '记忆系统台账（当前状态）', exists: exists(join(r, 'memory', 'PROJECT_LEDGER.md')) },
    { key: 'inject', path: F('inject.json'), what: '额外注入清单（把 INDEX.md 等按路径注入；★绝对路径★）', exists: exists(F('inject.json')) },
    { key: 'dirs', path: join(r, 'plugins'), what: '插件源码目录 / backups / .ptmp', exists: existsSync(join(r, 'plugins')) },
  ]
  return { root: r, items: items }
}
export function createSkeleton(root, picks) {
  const r = resolve(String(root || ''))
  const want = Array.isArray(picks) && picks.length ? picks : ['agents', 'memory_dir', 'index', 'ledger', 'inject', 'dirs']
  const created = []
  const skip = []
  const mk = function (p) { if (!existsSync(p)) { mkdirSync(p, { recursive: true }); created.push(p) } else skip.push(p) }
  const wr = function (p, text) {
    if (exists(p)) { skip.push(p); return }
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text, 'utf8')
    created.push(p)
  }
  if (want.includes('dirs')) { mk(join(r, 'plugins')); mk(join(r, 'backups')); mk(join(r, '.ptmp')) }
  if (want.includes('memory_dir')) mk(join(r, 'memory'))
  if (want.includes('agents')) wr(join(r, 'AGENTS.md'), mapTemplate(r))
  if (want.includes('index')) wr(join(r, 'memory', 'INDEX.md'), indexTemplate())
  if (want.includes('ledger')) wr(join(r, 'memory', 'PROJECT_LEDGER.md'), ledgerTemplate('记忆系统'))
  if (want.includes('inject')) {
    const files = []
    if (exists(join(r, 'memory', 'INDEX.md'))) files.push(join(r, 'memory', 'INDEX.md'))
    if (exists(join(r, 'memory', 'PROJECT_LEDGER.md'))) files.push(join(r, 'memory', 'PROJECT_LEDGER.md'))
    if (files.length) wr(F('inject.json'), JSON.stringify({ files: files }, null, 2) + '\n')
  }
  writeInit({ root: r, skeletonDone: created.length > 0 })
  return { root: r, created: created, skipped: skip }
}

// ─────────────── 状态汇总 & 收尾体检 ───────────────
export async function initStatus(ctx, deps) {
  const st = readInit()
  const seen = (typeof st.workspaceSeen === 'string' && st.workspaceSeen !== '') ? st.workspaceSeen : null
  const suggest = ((deps && typeof deps.suggestRoot === 'function') ? deps.suggestRoot() : null) || seen
  // ★2026-09-16★ 先看**嵌入器的真实配置**，再决定要不要探 Ollama：
  //   · 用户选了云端 API（或配置本来就是 cloud）→ 本机不需要 Ollama，那两行**不能显示 ✗**
  //     （那是"没做完"的假象）；判据取 `configured`（cloud 模式下 = Key 已填）。
  //   · ⚠️ `mode` 缺省就是 cloud ⇒ **不能拿 mode 当"用户选了 API"的证据**（见 embedder-cfg.mjs 抬头）。
  //   · 用 `await import()` 而不是顶层 import：这段在函数体里，而 ESM 的 import 只能在顶层
  //     （同一函数里已有同款写法：下面的 `await import('./build-view.mjs')`）。
  const { effectiveEmbedderFrom } = await import('./embedder-cfg.mjs')
  const emb = (function () {
    try { return effectiveEmbedderFrom(JSON.parse(readFileSync(F('embedder.json'), 'utf8'))) }
    catch (_e) { return effectiveEmbedderFrom({}) }
  })()
  const apiMode = emb.mode === 'cloud'
  const ollama = apiMode ? null : await detectOllama()
  const model = apiMode ? null : await detectModel().catch(function (e) { return { ok: false, detail: String(e && e.message || e) } })
  const sop = detectSop()
  const userOk = exists(F('USER.md')) && exists(F('MEMORY.md'))
  const root = st.root || null
  const skel = root ? skeletonPlan(root) : null
  const skelOk = !!(skel && skel.items.filter(function (i) { return i.key !== 'inject' }).every(function (i) { return i.exists }))
  let view = { ok: false, detail: '还没选工作区根目录（视图在 <工作区>/memory/记忆视图/）' }
  if (root) {
    try {
      const { checkView } = await import('./build-view.mjs')
      const r = await checkView({ root: root, memDir: MEM() })
      const bad = (r && Array.isArray(r.bad)) ? r.bad : []
      view = { ok: !!(r && r.ok === true), detail: (r && r.ok === true) ? '新鲜（逐份对上）' : (bad.length ? bad.slice(0, 2).join('；') : '视图不新鲜，点【生成/刷新视图】') }
    } catch (e) { view = { ok: false, detail: String((e && e.message) || e) } }
  }
  // ★2026-09-16★ 顺序按依赖排：初始记忆建立要写 vault ⇒ 必须等"根目录 + 嵌入器"就位之后。
  const steps = [
    { key: 'skeleton', label: '工作区骨架（地图 / 索引 / 台账）', ok: skelOk, detail: root ? (skelOk ? '齐全' : '有缺项，可一键补齐') : ('还没选工作区根目录' + (suggest ? '（建议：' + suggest + '）' : '')) },
    apiMode
      ? { key: 'ollama', label: '嵌入方式：云端 API（不走本地 Ollama）', ok: true, detail: '按你的选择用 API，本机不需要 Ollama —— 端点 ' + emb.endpoint }
      : { key: 'ollama', label: 'Ollama 已安装', ok: ollama.installed, detail: ollama.installed ? ((ollama.running ? '正在运行：' : '已安装（现在没在跑）：') + (ollama.exe || ollama.endpoint) + (ollama.running ? '' : ' —— 它是『你自己启动』的，想用语义检索时在设置页点【启动】即可，不启动也能装模型、检索会退化成关键词')) : '没检测到 ollama.exe' },
    apiMode
      ? { key: 'model', label: '嵌入模型（API）：' + emb.model, ok: emb.configured, detail: emb.configured ? 'API 已配好（Key 已填）' : '★还差一步：去 设置 → 记忆 → 嵌入器 填 API 地址／模型名／Key，保存后点【测试】；填好回会话里说一句「好了」★' }
      : { key: 'model', label: '嵌入模型 ' + (st.model || DEFAULT_MODEL), ok: model.ok === true, detail: model.ok ? ('已下载' + (model.onDisk ? '（磁盘清单：' + model.onDisk + '）' : '') + (model.inApi ? '（Ollama 里也有）' : '')) : (model.detail || '还没下载，点【安装模型】') },
    { key: 'memory-init', label: '初始记忆建立（SOP · 画像 · 长期记忆）', ok: (sop.ok && userOk), detail: 'SOP ' + (sop.ok ? '✓' : '✗') + ' ／ USER.md ' + (userOk ? '✓' : '✗') + ' ／ MEMORY.md ' + (userOk ? '✓' : '✗') + '　—— ' + sop.detail },
    { key: 'view', label: '记忆视图（Obsidian 只读副本）', ok: view.ok, detail: view.detail },
  ]

  const done = steps.every(function (s) { return s.ok })
  return { at: new Date().toISOString(), root: root, suggest: suggest, done: done, steps: steps, init: st }
}

/** ★2026-09-16★ 列一个目录（给卡片里的文件夹浏览器用）：只读、只收绝对路径、条数设上限。 */
export function listDir(p, opts) {
  const o = opts || {}
  const abs = resolve(String(p || ''))
  const out = { ok: true, path: abs, parent: null, dirs: [], files: [], truncated: false }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) { out.ok = false; out.error = '不是一个存在的文件夹：' + abs; return out }
  const par = resolve(abs, '..')
  out.parent = (par === abs) ? null : par
  let items = []
  try { items = readdirSync(abs, { withFileTypes: true }) } catch (e) { out.ok = false; out.error = '读不了这个文件夹：' + String((e && e.message) || e); return out }
  const MAX = 400
  for (const it of items) {
    if (it.name === 'node_modules' || it.name.startsWith('.')) continue          // 噪音目录不进列表
    if (out.dirs.length + out.files.length >= MAX) { out.truncated = true; break }
    const full = join(abs, it.name)
    if (it.isDirectory()) out.dirs.push({ name: it.name, path: full })
    else if (o.files && it.isFile() && String(it.name).toLowerCase().endsWith(String(o.files).toLowerCase())) out.files.push({ name: it.name, path: full })
  }
  out.dirs.sort(function (a, b) { return a.name.localeCompare(b.name) })
  out.files.sort(function (a, b) { return a.name.localeCompare(b.name) })
  return out
}

export function registerInitRoutes(ctx, deps) {
  const handler = async function (req, res, fn) {
    try { sendJson(res, 200, await fn(req)) }
    catch (e) { sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }) }
  }
  const R = function (path, fn) { ctx.webServer.register({ kind: 'exact', path: path, handler: function (req, res) { handler(req, res, fn) } }) }

  R('/dsh-memory-palace/init/status', async function () { return await initStatus(ctx, deps) })

  R('/dsh-memory-palace/init/ollama/locate', async function (req) {
    const b = await readBody(req)
    const p = resolve(String(b.path || ''))
    const exe = existsSync(p) && statSync(p).isDirectory() ? join(p, 'ollama.exe') : p
    if (!existsSync(exe)) return { ok: false, error: '这个路径下没找到 ollama 可执行文件：' + exe }
    writeInit({ ollamaExe: exe, ollamaLocatedBy: 'user' })
    const d = await detectOllama()
    return Object.assign({ ok: true, exe: exe }, d)
  })

  // ★2026-09-16★ 实现搬到上面导出的 `installOllama()` —— 路由与 `init-cli.mjs` **共用一份**。
  R('/dsh-memory-palace/init/ollama/install', async function () { return installOllama() })

  R('/dsh-memory-palace/init/skeleton/plan', async function (req) {
    const b = await readBody(req)
    return { ok: true, plan: skeletonPlan(b.root) }
  })
  R('/dsh-memory-palace/init/skeleton/create', async function (req) {
    const b = await readBody(req)
    if (!b.root) return { ok: false, error: '需要先选工作区根目录' }
    return Object.assign({ ok: true }, createSkeleton(b.root, b.picks))
  })

  R('/dsh-memory-palace/init/sop/analyze', async function (req) {
    const b = await readBody(req)
    const r = await analyzeDocForSop(ctx, b.path, { text: b.text, name: b.name })
    return Object.assign({ ok: true }, r)
  })
  R('/dsh-memory-palace/init/sop/save', async function (req) {
    const b = await readBody(req)
    const text = String(b.text || '')
    if (text.trim().length < 20) return { ok: false, error: '草稿太短，没保存' }
    writeFileSync(SOP(), text, 'utf8')
    writeFileSync(SOP_FLAG(), '1', 'utf8')
    writeInit({ sopDone: true, sopChars: text.length })
    return { ok: true, chars: text.length, file: SOP() }
  })
  R('/dsh-memory-palace/init/sop/default', async function () {
    writeFileSync(SOP(), defaultSopText(), 'utf8')
    writeFileSync(SOP_FLAG(), '1', 'utf8')
    writeInit({ sopDone: true, sopChars: defaultSopText().length })
    return { ok: true, chars: defaultSopText().length }
  })

  // ★2026-09-16 新增 / 当天二次修正★：真·系统选择器（点【浏览…】弹 Windows 原生对话框）。
  //   为什么必须这样：浏览器拿不到服务器上的绝对路径，而根目录/ollama.exe 都是本机路径 →
  //   让宿主进程弹原生对话框是唯一"点着就能选"的正路。
  //   ★★第一版我用了 execFileSync【同步】等待 → 对话框没浮到前面时，**整个 DSH 进程被卡住**，
  //     界面全灰、点什么都没反应（用户当场抓到）。现在改成：**后台 detached 弹出 + 结果写文件 +
  //     前端轮询** —— 宿主发完请求就返回，事件循环永不被对话框占住。
  //   返回空（取消 / 对话框起不来 / 非 Windows）都**明确出声**，前端一律给"手动粘路径"的出路。

  const pickFile = function () { return join(MEM(), 'pick-result.json') }
  const powershellExe = function () {
    const abs = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    return existsSync(abs) ? abs : 'powershell'
  }
  R('/dsh-memory-palace/init/pick', async function (req) {
    const b = await readBody(req)
    if (process.platform !== 'win32') {
      return { ok: false, error: '这个系统上没有原生文件夹对话框 —— 请把路径粘到输入框里' }
    }
    const mode = b.mode === 'file' ? 'file' : 'dir'
    const title = String(b.title || (mode === 'file' ? '选择文件' : '选择文件夹')).replace(/'/g, "''")
    const filter = String(b.filter || '').replace(/'/g, "''")
    const out = pickFile().replace(/'/g, "''")
    // ★2026-09-16★ 对话框"浮到最前"：先建一个 1×1 的 TopMost 窗口当所有者，
    //   再 ShowDialog($owner) —— 否则后台进程弹的对话框常被浏览器压在下面，用户以为"没弹"。
    const lines = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "Add-Type -AssemblyName System.Drawing | Out-Null",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.FormBorderStyle = 'None'",
      "$owner.Size = New-Object System.Drawing.Size(1,1)",
      "$owner.StartPosition = 'CenterScreen'",
      "$owner.Show(); $owner.Activate()",
    ]
    if (mode === 'file') {
      lines.push("$f = New-Object System.Windows.Forms.OpenFileDialog")
      lines.push("$f.Title = '" + title + "'")
      if (filter !== '') lines.push("$f.Filter = '" + filter + "'")
      lines.push("$picked = ''")
      lines.push("if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $f.FileName }")
    } else {
      lines.push("$f = New-Object System.Windows.Forms.FolderBrowserDialog")
      lines.push("$f.Description = '" + title + "'")
      lines.push("$f.ShowNewFolderButton = $true")
      lines.push("$picked = ''")
      lines.push("if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $f.SelectedPath }")
    }
    lines.push("$owner.Close()")
    lines.push("Set-Content -LiteralPath '" + out + "' -Value $picked -Encoding UTF8")
    const script = lines.join('; ')
    if (b.dryRun === true) return { ok: true, dryRun: true, mode: mode, cmd: script }
    try {
      if (existsSync(pickFile())) rmSync(pickFile())
      const child = spawn(powershellExe(), ['-NoProfile', '-STA', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return { ok: true, started: true, mode: mode, note: '已弹出系统对话框（在桌面上找一下）—— 选完这里会自动填上' }
    } catch (e) {
      return { ok: false, error: '起不来系统对话框（' + String((e && e.message) || e).slice(0, 120) + '）—— 请把路径粘到输入框里' }
    }
  })
  // ★2026-09-16★ 卡片内文件夹浏览器：GET /init/ls?path=<绝对路径>（只读）
  ctx.webServer.register({ kind: 'exact', path: '/dsh-memory-palace/init/ls', handler: async function (req, res) {
    try {
      const u = new URL(String(req.url || ''), 'http://127.0.0.1')
      const p = u.searchParams.get('path') || (readInit().root || '') || (process.env.USERPROFILE || process.env.HOME || '')
      sendJson(res, 200, listDir(p, { files: u.searchParams.get('files') || undefined }))
    } catch (e) { sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }) }
  } })

  R('/dsh-memory-palace/init/pick/result', async function () {
    const f = pickFile()
    if (!existsSync(f)) return { ok: true, state: 'pending' }
    let picked = ''
    try { picked = String(readFileSync(f, 'utf8')).replace(/^\uFEFF/, '').trim() } catch (_e) {}
    try { rmSync(f) } catch (_e) {}
    if (picked === '') return { ok: true, state: 'cancelled' }
    return { ok: true, state: 'picked', path: picked }
  })

  // ★2026-09-16★ 把「初始化任务书」准备好：填入用户选的源文件路径，落盘到 ~/.dsh-memory/init-task.md，
  //   新会话里只要 @ 这个文件即可（DSH 支持 @ 引用）。返回可复制的首条消息。
  R('/dsh-memory-palace/init/task', async function (req) {
    const b = await readBody(req)
    const sources = Array.isArray(b.sources) ? b.sources.filter(function (x) { return String(x || '').trim() !== '' }) : []
    let tpl = ''
    try { tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'init-task.md'), 'utf8') } catch (_e) {}
    if (tpl === '') return { ok: false, error: '插件里没找到 init-task.md（打包漏了？）' }
    const list = sources.length ? sources.map(function (p) { return '- ' + p }).join('\n') : '（用户没选源文件 —— 那就以扫描会话为主）'
    // ★2026-09-16★ 任务书开头要"**问用户根目录是什么**"，所以这里先把**候选答案**备好：
    //   DSH 自己登记的工作区（workspaceRegistry.list()）+ 本插件最近看到的会话工作区。
    //   用户在会话里挑一个、或者自填 —— 我们**不替他猜**（根目录猜错 = 往错的地方建一堆文件夹）。
    const cands = []
    try {
      const reg = ctx.get ? ctx.get('workspaceRegistry') : null
      if (reg && typeof reg.list === 'function') {
        for (const w of reg.list()) { const p = w && (w.path || w.root); if (p && cands.indexOf(String(p)) < 0) cands.push(String(p)) }
      }
    } catch (_e) {}
    const seen = readInit().workspaceSeen
    if (typeof seen === 'string' && seen !== '' && cands.indexOf(seen) < 0) cands.push(seen)
    const wsList = cands.length
      ? cands.map(function (p, i) { return '   ' + (i + 1) + '. ' + p }).join('\n')
      : '   （DSH 还没登记过工作区 —— 让用户直接给一个绝对路径）'
    const libDir = dirname(fileURLToPath(import.meta.url))
    const fill = function (t, k, v) { return t.split('{{' + k + '}}').join(v) }
    let text = fill(tpl, 'SOURCES', list)
    text = fill(text, 'WORKSPACES', wsList)
    text = fill(text, 'PLUGIN_LIB', libDir)
    text = fill(text, 'SUGGEST', cands[0] || '')
    const file = F('init-task.md')
    try { writeFileSync(file, text, 'utf8') } catch (e) { return { ok: false, error: '写不了任务书：' + String((e && e.message) || e) } }
    writeInit({ taskFile: file, taskSources: sources, taskAt: new Date().toISOString() })
    return { ok: true, file: file, sources: sources, workspaces: cands, firstMessage: '@' + file + ' 按这份任务书，把这台机器的记忆初始化做完（草案先给我看）' }
  })

  // ★2026-09-16 第四版：用户点了两次【进入新会话，配置】都"没反应"，日志停在①。
  //   根因（读 Cordis 源码确认，不是猜）：上一版在浏览器里读 `CLIENT_CTX.remote`，
  //   而 `remote` **根本不是 Cordis 服务** → 代理抛 `cannot get property "remote" without inject`；
  //   那行在 .then 回调里且没有外层 catch → 整个 Promise 静默 reject，日志就此打住。
  //   ⇒ 现在把"建会话 + 投递"搬到宿主侧，用 `ctx.sessionController`（浏览器输入框走的就是这条路），
  //     浏览器只负责把它切到前台。好处：这条路由能**用 HTTP 直接自测**，不再靠"点一下试试"。
  R('/dsh-memory-palace/init/session', async function (req) {
    const b = await readBody(req)
    const sc = ctx.get ? ctx.get('sessionController') : null
    if (!sc || typeof sc.create !== 'function' || typeof sc.prompt !== 'function') {
      return { ok: false, error: '拿不到宿主的 sessionController 服务（这个 DSH 版本可能不一样）' }
    }
    const text = String(b.text || '').trim() ||
      ('@' + F('init-task.md') + ' 按这份任务书，把这台机器的记忆初始化做完（草案先给我看）')
    let sessionId = String(b.sessionId || '').trim()
    let created = false
    if (sessionId === '') {
      const r = await sc.create(b.cwd ? { cwd: String(b.cwd) } : {})
      sessionId = String((r && (r.sessionId || r.id)) || '')
      created = true
      if (sessionId === '') return { ok: false, error: '建了会话但没拿到 sessionId：' + JSON.stringify(r || {}).slice(0, 200) }
    }
    const requestId = 'memory-init-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    // ★必须给 signal★：宿主 `sessionController.prompt(request, signal)` 第一行就是
    //   `signal.throwIfAborted()`（浏览器走 Remote 网关时那个 signal 是网关塞的）。
    //   第一次自测就栽在这儿 —— 报错 `Cannot read properties of undefined (reading 'throwIfAborted')`。
    let ack = null
    try {
      ack = await sc.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
    } catch (e) {
      // ★会话已经建出来了★ —— 必须把 sessionId 一起回给前端，否则前端会再建一个（留下一串孤儿会话）。
      const msg = String((e && e.message) || e)
      writeInit({ initSessionId: sessionId, initSessionAt: new Date().toISOString(), initSessionError: msg })
      return { ok: false, error: '会话已建（' + sessionId + '）但投递失败：' + msg, sessionId: sessionId, created: created }
    }
    writeInit({ initSessionId: sessionId, initSessionAt: new Date().toISOString(), initSessionError: null })
    return { ok: true, sessionId: sessionId, created: created, accepted: !!(ack && ack.accepted), textLen: text.length }
  })

  R('/dsh-memory-palace/init/check', async function () { return await initStatus(ctx, deps) })
  return ctx
}
