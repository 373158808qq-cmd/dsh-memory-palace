// ★2026-09-16 从 `<工作区>/memory/tools/check_capabilities.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// 能力点名器：照着 knowledge/capabilities/*.md 里写的"核对 spec"，**真去点一遍名**。
//
// ★为什么必须有它★：能力清单最大的风险不是"写少了"，是**"写着我会、一用就废"** —— 那是无声的谎。
// ★它绝不执行被检查的东西★（这条是硬约束，2026-09-15 第一版就被自己抓过）：
//   清单里写 `cmd:node memory/tools/resync_vault.mjs` 的话，若照字面执行，**点名就变成了重建整个库**。
//   所以 cmd: 的实现是"**查**"而不是"跑"：
//     · 第一个词 = 可执行文件 → 查它在不在 PATH
//     · 其余看像"路径"的词（带斜杠 / 带 .mjs/.py/.ps1 这类后缀）→ 查那个文件在不在（相对路径按工作区根算）
//     · 以 `-` 开头的词（选项）→ 忽略
//   想让它真跑？那是"任务"，不是"点名" —— 请你自己敲，或走有副作用确认的流程。
//
// spec 语法（写在能力小节末尾的围栏里，每行一条）：
//   cmd:<可执行文件> [像路径的参数]   查程序在不在 PATH + 那些路径在不在（**不执行**）
//   path:<路径>                      文件/目录在不在
//   port:<端口>                       TCP 连得上吗
//   http:<URL>                        GET 能不能拿到 2xx
//   env:<变量名>                      环境变量非不非空
//   skill:<名字>                      skill 装没装（项目/用户/部署三个来源都查）
//   tool:<工具名>                     ★运行时核（阶段C）★：默认**不核**，如实标"未核"、**不装绿**；
//                                     加 `--tools` 才去问插件的 `/dsh-memory-palace/tools` 路由 ——
//                                     名字在注册表里 = 绿；名单里没有 = 红；**路由不可达 = 仍是未核 + 退出码 1**。
//   ★任意 spec 末尾加 `?` = "按需未启动"★（例如 port:9882?）：没就绪**不算红**，
//     但会在单独一行里列出来（可见、不静默、也不冒充绿）。
//
// 用法：
//   node memory/tools/check_capabilities.mjs                  # 人看（`tool:` 一律如实标"未核"）
//   node memory/tools/check_capabilities.mjs --tools          # 顺带核工具（默认问 127.0.0.1:3080）
//   node memory/tools/check_capabilities.mjs --tools --tools-url http://127.0.0.1:3081/dsh-memory-palace/tools
//   node memory/tools/check_capabilities.mjs --json           # 机器看（多一格 `toolProbe`）
//   node memory/tools/check_capabilities.mjs --root <目录>     # 换根（夹具用）
// 环境变量 `DSH_MEMORY_TOOLS_URL` 可替代 `--tools-url`。
// 退出码：无红 = 0；有红 = 1；★`--tools` 已开却没核成也 = 1★（"我没问成"不许当没事）。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const argAfter = function (flag, dflt) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const JSON_OUT = process.argv.includes('--json')

// ── ★`tool:` 的运行时核（阶段C，2026-09-15 用户拍板"要做"）★ ─────────────────────
// ★默认**不核**：`tool:` 一律如实标"未核"★ —— 工具在不在只有**跑着的 DSH 进程**知道，CLI 侧问不到。
//   加 `--tools` 才去问插件的 `/dsh-memory-palace/tools` 路由（它读的是**真注册表**，不是我们写死的名单）。
// ★三条不许违反★：
//   ① **没问 ≠ 绿**：默认仍是 `unchecked`；只有真从注册表里查到那个名字才标绿；
//   ② **问不到 ≠ 没有**：路由不可达时**一条都不判红**（那会把"我没问成"说成"你没有"），
//      但也**不许当没事** —— `--tools` 已开却没核成 → **退出码 1**，并在汇总里大声写出来；
//   ③ 名字从**回来那份名单**里查；本地**不设兜底清单**（有兜底 = 又能"看着有、其实没用"）。
const TOOLS_CHECK = process.argv.includes('--tools')
const TOOLS_URL = argAfter('--tools-url',
  process.env.DSH_MEMORY_TOOLS_URL || 'http://127.0.0.1:3080/dsh-memory-palace/tools')

/** 问一次工具注册表。**绝不抛**：拿不到就回 `{ok:false, error}`，由调用方如实反映。 */
async function probeTools(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, url: url }
    const j = await r.json()
    // ★跨接口复用"发请求"的函数前，先校验回来的形状★（09-13 UI 整块消失那次的老教训）
    if (!j || j.ok !== true || !Array.isArray(j.tools)) {
      return { ok: false, error: '路由回的形状不对（ok !== true 或没有 tools 数组）', url: url, raw: JSON.stringify(j).slice(0, 120) }
    }
    const names = new Set()
    for (const t of j.tools) if (t && typeof t.name === 'string' && t.name !== '') names.add(t.name)
    // ★记下"这次到底问到了几层"★ —— 实测（2026-09-15，3081 隔离实例）它是 `agents: 0`：
    //   那个实例里**没有活着的 agent**，而 web profile 是把 `tool-fs`/`tool-subagent`/`tool-web`
    //   这些**关掉宿主行、改由预设注册在 agent 平面**的 → 那一层根本没被看到。
    //   ⇒ 这种时候"名单里没有"**不能判红**（那是把"我没看到"说成"你没有"）。
    const agentScopes = (j.scopes && typeof j.scopes.agents === 'number') ? j.scopes.agents : null
    return { ok: true, url: url, names: names, count: names.size, scopes: j.scopes || null, agentScopes: agentScopes, agentOnly: j.agentOnly || [] }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140), url: url }
  }
}
const TOOL_PROBE = TOOLS_CHECK
  ? await probeTools(TOOLS_URL)
  : { ok: false, skipped: true, error: '没开 --tools（默认不核工具）', url: TOOLS_URL }

/** 找根：从本文件往上找工作区根（标志物 = plugins/dsh-memory-palace；不写死本机路径） */
function findRoot() {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'plugins', 'dsh-memory-palace', 'lib', 'vault-sync.mjs'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}
const ROOT = resolve(argAfter('--root', findRoot() || process.cwd()))

function probePort(port) {
  return new Promise(function (done) {
    const s = createConnection({ host: '127.0.0.1', port: port, timeout: 1200 })
    s.on('connect', function () { s.destroy(); done(true) })
    s.on('timeout', function () { s.destroy(); done(false) })
    s.on('error', function () { done(false) })
  })
}
function hasCmd(exe) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [exe],
      { stdio: 'pipe', timeout: 6000, windowsHide: true })
    return String(out).trim().length > 0
  } catch (_e) { return false }
}
/** 部署自带的 skill 在哪（在当前 DSH 安装里找 agent-presets 各预设下的 skills 目录） */
function deploymentSkillRoots() {
  const out = []
  const npmGlobal = process.platform === 'win32'
    ? join(String(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')), 'npm', 'node_modules')
    : '/usr/lib/node_modules'
  const presets = join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
  try {
    if (existsSync(presets)) for (const p of readdirSync(presets)) out.push(join(presets, p, 'skills'))
  } catch (_e) {}
  const bundled = String(process.env.DSH_BUNDLED_SKILL_DIR || '').trim()
  if (bundled) out.push(bundled)
  return out
}
function skillInstalled(name, wsRoot) {
  const roots = [
    { at: join(wsRoot, '.dsh', 'skills'), label: '项目级' },
    { at: join(wsRoot, '.agents', 'skills'), label: '项目级(agents)' },
    { at: join(homedir(), '.dsh', 'skills'), label: '用户级' },
    { at: join(homedir(), '.agents', 'skills'), label: '用户级(agents)' }
  ].concat(deploymentSkillRoots().map(function (p) { return { at: p, label: '部署自带' } }))
  for (const r of roots) {
    if (existsSync(join(r.at, name, 'SKILL.md')) || existsSync(join(r.at, name + '.md'))) return r.label + '：' + r.at.replace(homedir(), '~')
  }
  return null
}
const looksLikePath = function (t) { return /[\\/]/.test(t) || /\.(mjs|js|cjs|ts|py|ps1|bat|cmd|exe|json|md|txt|sh)$/i.test(t) }

/** 收集每条能力的 spec：`## 能力名` 开小节，小节内的 `type:value` 行都算 */
function collect(root) {
  const dir = join(root, 'knowledge', 'capabilities')
  if (!existsSync(dir)) return { caps: [], files: [] }
  const caps = []
  const files = readdirSync(dir).filter(function (n) { return n.endsWith('.md') }).sort()
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split(/\r?\n/)
    let cur = null
    for (const line of lines) {
      const h = line.match(/^##\s+(.+?)\s*$/)
      if (h) { cur = { file: f, name: h[1], specs: [] }; caps.push(cur); continue }
      const m = line.match(/^(cmd|path|port|http|env|tool|skill):(.+?)\s*$/)
      if (m && cur) cur.specs.push({ type: m[1], value: m[2].trim() })
    }
  }
  return { caps: caps, files: files }
}

const { caps, files } = collect(ROOT)
const rows = []
for (const c of caps) {
  const results = []
  for (const s0 of c.specs) {
    const optional = /\?$/.test(s0.value)
    const s = { type: s0.type, value: optional ? s0.value.replace(/\?+$/, '') : s0.value, optional: optional }
    let state = 'red', why = ''
    if (s.type === 'cmd') {
      const toks = s.value.split(/\s+/).filter(Boolean)
      const exe = toks[0]
      if (!hasCmd(exe)) { state = 'red'; why = '可执行文件不在 PATH：' + exe }
      else {
        const paths = toks.slice(1).filter(function (t) { return !t.startsWith('-') && looksLikePath(t) })
        const missing = paths.filter(function (t) {
          const p = /^[A-Za-z]:[\\/]/.test(t) ? t : join(ROOT, t)
          return !existsSync(p)
        })
        if (missing.length) { state = 'red'; why = '命令里像路径的东西不存在：' + missing.join('、') }
        else { state = 'ok'; why = '程序在 PATH' + (paths.length ? ' + ' + paths.length + ' 个路径都在' : '') + '（只查不跑）' }
      }
    } else if (s.type === 'path') {
      const p = /^[A-Za-z]:[\\/]/.test(s.value) ? s.value : join(ROOT, s.value)
      try { if (existsSync(p)) { state = 'ok'; why = '存在' } else why = '不存在：' + p } catch (_e) { why = '路径非法' }
    } else if (s.type === 'port') {
      const ok = await probePort(Number(s.value))
      state = ok ? 'ok' : (optional ? 'optional' : 'red'); why = ok ? '端口通' : '端口连不上（没启动）'
    } else if (s.type === 'http') {
      try {
        const r = await fetch(s.value, { signal: AbortSignal.timeout(2500) })
        const ok = r.status >= 200 && r.status < 300
        state = ok ? 'ok' : (optional ? 'optional' : 'red'); why = 'HTTP ' + r.status
      } catch (e) { state = optional ? 'optional' : 'red'; why = '取不到：' + String(e.message || e).slice(0, 40) }
    } else if (s.type === 'env') {
      const v = process.env[s.value]
      const ok = (typeof v === 'string' && v !== '')
      state = ok ? 'ok' : (optional ? 'optional' : 'red'); why = ok ? '有值' : '没设或为空'
    } else if (s.type === 'skill') {
      const at = skillInstalled(s.value, ROOT)
      if (at) { state = 'ok'; why = at } else { state = optional ? 'optional' : 'red'; why = '四个来源都没找到' }
    } else if (s.type === 'tool') {
      // ★运行时核（阶段C）★：只有"真从注册表里查到那个名字"才标绿；别的三种情况各有各的说法。
      if (TOOL_PROBE.skipped) {
        state = 'unchecked'; why = '没核：默认不查工具（要核就加 `--tools`，让它去问插件的 /tools 路由）'
      } else if (!TOOL_PROBE.ok) {
        state = 'unchecked'; why = '没核成：' + TOOL_PROBE.error + '（★按"没问"算：不判红、也绝不当绿★）'
      } else if (TOOL_PROBE.names.has(s.value)) {
        state = 'ok'; why = '工具注册表里有（本次看到 ' + TOOL_PROBE.count + ' 个工具）'
      } else if (TOOL_PROBE.agentScopes === 0) {
        // ★问了、但只问到宿主全局层（0 个活着的 agent）★ —— 实测 3081 隔离实例就是这样：
        //   那一层里注册着 `tool-fs`/`tool-subagent`/`tool-web` 等（web profile 关掉了宿主行、改由预设注册）。
        //   ⇒ 此时"名单里没有"**不许判红**（那是把"我没看到"说成"你没有"），如实标**未核**：
        //     红与绿都要有依据，**没看到的既不是红也不是绿**。
        state = 'unchecked'
        why = '没核到那一层：本次只看到宿主全局层（**0 个活着的 agent**），agent 平面的工具这次根本没露面 → **不判红、也不算绿**'
      } else {
        state = 'red'; why = '工具注册表里**没有**这个名字（本次看到 ' + TOOL_PROBE.count + ' 个工具，问了宿主全局层 + ' +
          (TOOL_PROBE.agentScopes === null ? '?' : TOOL_PROBE.agentScopes) + ' 个 agent 层）'
      }
    }
    results.push({ type: s.type, value: s.value, optional: s.optional, state: state, why: why })
  }
  rows.push({ file: c.file, name: c.name, specs: results })
}

const red = [], unchecked = [], optional = []
for (const r of rows) {
  for (const s of r.specs) {
    if (s.state === 'red') red.push({ cap: r.name, s: s })
    else if (s.state === 'unchecked') unchecked.push({ cap: r.name, s: s })
    else if (s.state === 'optional') optional.push({ cap: r.name, s: s })
  }
}

// ★"没核成"也要算进退出码★：`--tools` 已开、却没能问到注册表 → 退出码同样是 1。
//   理由正是本项目最恨的那件事：**把"我没问成"当成"没问题"就是假绿**。
//   （红不红是"内容"的事；"我到底核没核"是我自己的事，不能悄悄咽下去。）
const probeFailed = TOOLS_CHECK && TOOL_PROBE.ok !== true

if (JSON_OUT) {
  console.log(JSON.stringify({
    root: ROOT, files: files.length, caps: rows.length,
    red: red.length, unchecked: unchecked.length, optional: optional.length,
    toolProbe: {
      requested: TOOLS_CHECK,
      ok: TOOL_PROBE.ok === true,
      skipped: TOOL_PROBE.skipped === true,
      url: TOOL_PROBE.url,
      count: TOOL_PROBE.count === undefined ? null : TOOL_PROBE.count,
      scopes: TOOL_PROBE.scopes || null,
      agentOnly: TOOL_PROBE.agentOnly || [],
      error: TOOL_PROBE.ok === true ? null : TOOL_PROBE.error,
    },
    rows: rows
  }, null, 1))
} else {
  console.log('══════════════════════════════════════════════════════════════════════════')
  console.log('  能力点名（' + join(ROOT, 'knowledge') + '）')
  console.log('══════════════════════════════════════════════════════════════════════════')
  const total = rows.reduce(function (a, r) { return a + r.specs.length }, 0)
  console.log('  组文件 ' + files.length + ' 个 ／ 能力 ' + rows.length + ' 条 ／ 核对项 ' + total + ' 个')
  console.log('')
  for (const r of rows) {
    const bad = r.specs.filter(function (s) { return s.state === 'red' })
    const tag = bad.length ? '✗ 红' : (r.specs.length ? '✓ 绿' : '· 无spec')
    console.log('  ' + tag + '  ' + r.name + '   ' + (r.specs.length ? (r.specs.length - bad.length) + '/' + r.specs.length : '（没写核对 spec）'))
    for (const s of r.specs) {
      if (s.state === 'red') console.log('        ✗ 红    ' + s.type + ':' + s.value + '  —— ' + s.why)
      else if (s.state === 'optional') console.log('        ⚪ 待启  ' + s.type + ':' + s.value + '  —— ' + s.why + '（按需启动，不算红）')
      else if (s.state === 'unchecked') console.log('        · 未核  ' + s.type + ':' + s.value + '  —— ' + s.why)
    }
  }
  console.log('')
  if (red.length) {
    console.log('  ★有 ' + red.length + ' 项点不到名★（不许当绿的看：要么补条件，要么把那条改成"暂不可用"并写清原因）')
    for (const r of red) console.log('     · ' + r.cap + ' → ' + r.s.type + ':' + r.s.value + '（' + r.s.why + '）')
  } else console.log('  ✓ 全部点得到名（没有红的）')
  if (optional.length) {
    console.log('  ⚪ 按需未启动 ' + optional.length + ' 项（**不是失败**，但别当它们在跑）：')
    for (const r of optional) console.log('     · ' + r.cap + ' → ' + r.s.type + ':' + r.s.value)
  }
  if (unchecked.length) console.log('  · 另有 ' + unchecked.length + ' 项**没核**（`tool:` 类，**没算绿**）')
  if (TOOLS_CHECK) {
    if (TOOL_PROBE.ok) {
      console.log('  ✓ 工具运行时核：问了 ' + TOOL_PROBE.url + ' → 注册表里共 ' + TOOL_PROBE.count + ' 个工具' +
        (TOOL_PROBE.scopes ? '（宿主全局层 + ' + (TOOL_PROBE.scopes.agents || 0) + ' 个活着的 agent 层）' : '') +
        (TOOL_PROBE.agentOnly && TOOL_PROBE.agentOnly.length
          ? '；其中只在 agent 层才注册得到的 ' + TOOL_PROBE.agentOnly.length + ' 个' : ''))
      if (TOOL_PROBE.agentScopes === 0) {
        console.log('  ⚠ ★这次**没有活着的 agent**（`scopes.agents = 0`）★：web profile 把 `tool-fs`／`tool-subagent`／')
        console.log('     `tool-web` 这些**关掉宿主行、改由预设注册在 agent 平面** → 那一层这次没露面。')
        console.log('     所以上面"点不到名"的那些**一律算未核，不判红**（把"我没看到"说成"你没有"就是假红）。')
      }
    } else {
      console.log('  ✗ ★工具运行时核**没核成**★：' + TOOL_PROBE.url + ' → ' + TOOL_PROBE.error)
      console.log('     → 上面那批 `tool:` 一律仍是**未核**（既不是绿、也不是红）；但**这一项本身算失败（退出码 1）**：')
      console.log('       "我没问成"和"你没有"是两件事 —— 混起来就是假绿。先看 DSH 起没起、端口对不对。')
    }
  } else {
    console.log('  · 想核 `tool:` 那一类：加 `--tools`（**默认不核，未核不许当绿**）')
  }
  console.log('')
}
process.exit((red.length === 0 && !probeFailed) ? 0 : 1)
