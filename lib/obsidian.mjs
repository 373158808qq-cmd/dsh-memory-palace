// obsidian.mjs —— ⑧ 显示层「记忆视图」跟 Obsidian 打交道的**唯一实现**。
//
// ★为什么单独一个文件★：这组东西原来只住在 `index.js` 里（设置页那颗【打开记忆视图】用它），
//   而**「一键初始化」的任务书也要用它**（在建记忆之前先问"要不要装 Obsidian"、最后把库登记并打开）。
//   两处各写一份的话，最危险的是 `ensureVaultRegistered` —— **它写的是用户真实的 Obsidian 配置**
//   （`%APPDATA%\obsidian\obsidian.json`），写歪一次就是把人家整个库列表搞坏。
//   同族教训：切块器「CLI 一套、已装一套」漂过一回；嵌入器默认值也刚因为两份实现统一过（阶段64）。
//
// ★普适性（别写死本机路径）★：
//   ① 优先**直接拿 Obsidian 自己的 URI 交给 exe** `obsidian://open?vault=<库名>` —— 换台电脑、换安装位置都成立；
//   ② exe 找不到 → 回退到**常见安装位置**逐个探；
//   ③ 连 exe 都没有 → ★**如实报"没找到 Obsidian"，绝不再假装成功**★
//      （2026-09-16 用户点名要修：旧代码会退回 `obsidian://` 协议、`cmd /c start` 一发出去就报 ok，
//        卡片显示"已发出打开请求（若没弹出，看任务栏）" —— 明明什么都没开。正是他说的"看着有、其实没用"。）
//
// ★关闭的力度★：先**优雅关**（发关闭消息，Obsidian 自己保存工作区）；`/F` 强杀必须用户显式点。
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, basename, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

export const OBSIDIAN_URI = 'obsidian://open?vault='

/** Obsidian 的配置文件在哪（按平台给候选，取第一个存在的）。不写死本机路径。 */
export function obsidianConfigCandidates() {
  const out = []
  const ro = String(process.env.APPDATA || '').trim()
  if (ro) out.push(join(ro, 'obsidian', 'obsidian.json'))                                   // Windows
  out.push(join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'))  // macOS
  if (String(process.env.XDG_CONFIG_HOME || '').trim()) {
    out.push(join(String(process.env.XDG_CONFIG_HOME).trim(), 'obsidian', 'obsidian.json'))  // Linux
  }
  out.push(join(homedir(), '.config', 'obsidian', 'obsidian.json'))                          // Linux 默认
  return out
}
export function obsidianConfigFile() {
  const c = obsidianConfigCandidates()
  for (const p of c) { if (existsSync(p)) return p }
  return c[0] || ''
}

/** Obsidian 可能装在哪（按平台给常见位置）。**纯候选**，返回存在的那个或 null。 */
export function findObsidianExe() {
  const c = []
  const la = String(process.env.LOCALAPPDATA || '').trim()
  const pf = String(process.env.ProgramFiles || '').trim()
  const pf86 = String(process.env['ProgramFiles(x86)'] || '').trim()
  if (la) c.push(join(la, 'Programs', 'Obsidian', 'Obsidian.exe'))     // Windows（winget/安装器默认）
  if (pf) c.push(join(pf, 'Obsidian', 'Obsidian.exe'))
  if (pf86) c.push(join(pf86, 'Obsidian', 'Obsidian.exe'))
  c.push('/Applications/Obsidian.app/Contents/MacOS/Obsidian')         // macOS
  c.push('/usr/bin/obsidian', '/usr/local/bin/obsidian', '/opt/Obsidian/obsidian')  // Linux
  for (const p of c) { try { if (existsSync(p)) return p } catch (_e) {} }
  return null
}

/** 视图目录（`<工作区>/memory/记忆视图`）—— 库里那个"库名"就是它的文件夹名。 */
export function viewDirOf(root) { return join(root, 'memory', '记忆视图') }

/**
 * ★纯函数：算出"打开"该怎么走★ —— 不执行任何东西，所以夹具能直接断言。
 * 返回 { via, exe, uri, why }：via = 'exe'（拿 URI 交给 exe）｜ 'protocol'（交给系统）｜ 'none'。
 */
export function planOpenObsidian(o) {
  const opt = o || {}
  const dir = opt.viewDir ? String(opt.viewDir) : ''
  const name = opt.vaultName ? String(opt.vaultName) : basename(dir)
  const uri = OBSIDIAN_URI + encodeURIComponent(name)
  // ★"传了 exe 就用传的（**哪怕是 null**）"★ —— 用真值判断的话，`exe:null` 会变成"去本机找"，
  //   于是"这台机器上没有 Obsidian"那条回退路**根本测不出来**（2026-09-15 夹具当场撞上）。
  const exe = ('exe' in opt) ? opt.exe : findObsidianExe()
  if (exe) return { via: 'exe', exe: exe, uri: uri, why: '用 Obsidian 自己的 URI 启动（不依赖协议注册）' }
  return { via: 'protocol', exe: null, uri: uri, why: '交给系统按 obsidian:// 协议打开' }
}

/** 库登记了没（按路径比，**归一化后再比** —— 斜杠方向/大小写/末尾斜杠都是同一个库的两种写法）。 */
export function isVaultRegistered(cfgJson, viewDir) {
  const want = resolve(viewDir).replace(/[\\/]+$/, '').toLowerCase()
  const vs = (cfgJson && cfgJson.vaults) || {}
  for (const id of Object.keys(vs)) {
    const p = vs[id] && vs[id].path
    if (typeof p === 'string' && resolve(p).replace(/[\\/]+$/, '').toLowerCase() === want) return id
  }
  return null
}

/**
 * 确保这个库在 Obsidian 里登记过（**只加这一条，不动别的**）。
 * 用户 2026-09-15 拍板：可以自动登记，并在界面上说明。
 */
export function ensureVaultRegistered(viewDir, cfgPath) {
  const f = cfgPath || obsidianConfigFile()
  if (!f) return { ok: false, changed: false, error: '找不到 Obsidian 配置文件位置' }
  let raw = null
  try { raw = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { vaults: {} } } catch (e) {
    return { ok: false, changed: false, error: '读 Obsidian 配置失败：' + String((e && e.message) || e) }
  }
  if (!raw || typeof raw !== 'object') raw = { vaults: {} }
  if (!raw.vaults || typeof raw.vaults !== 'object') raw.vaults = {}
  const hit = isVaultRegistered(raw, viewDir)
  if (hit !== null) return { ok: true, changed: false, id: hit, file: f }
  // id 用 16 位十六进制（Obsidian 自己的形状），不与已有 id 撞
  let id = ''
  try { id = randomBytes(8).toString('hex') } catch (_e) { id = String(Date.now()) }
  while (raw.vaults[id]) { try { id = randomBytes(8).toString('hex') } catch (_e) { id = String(Date.now()) + '1' } }
  raw.vaults[id] = { path: viewDir, ts: Date.now(), open: true }
  try {
    // ★2026-09-16★ 先建目录：`%APPDATA%\obsidian\` **在"装了但还没启动过一次"的机器上并不存在**
    //   （一键初始化刚用 winget 装完就是这个状态）→ 不建的话 `writeFileSync` 直接 ENOENT，
    //   而报出来的是一句没头没脑的"写 Obsidian 配置失败"。自测夹具当场撞上。
    mkdirSync(dirname(f), { recursive: true })
    // ★原子写★：先写临时文件再改名 —— 别把人家整个 Obsidian 配置写坏在半路
    const tmp = f + '.dsh-tmp'
    writeFileSync(tmp, JSON.stringify(raw), 'utf8')
    renameSync(tmp, f)
  } catch (e) {
    return { ok: false, changed: false, error: '写 Obsidian 配置失败：' + String((e && e.message) || e) }
  }
  return { ok: true, changed: true, id: id, file: f }
}

/** 抛给系统/程序去打开一个 URL 或路径（不阻塞、不等结果）。 */
export function openExternal(target, exe) {
  return new Promise(function (resolve) {
    try {
      if (exe) {
        const ch = spawn(exe, [target], { stdio: 'ignore', windowsHide: true, detached: true })
        ch.on('error', function (e) { resolve({ ok: false, error: String((e && e.message) || e) }) })
        ch.unref()
        resolve({ ok: true })
        return
      }
      const cmd = process.platform === 'win32' ? 'cmd'
        : process.platform === 'darwin' ? 'open' : 'xdg-open'
      // Windows 上 `start` 的**第一个带引号参数会被当成窗口标题** → 必须补一个空标题 ""
      const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
      const ch = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: true })
      ch.on('error', function (e) { resolve({ ok: false, error: String((e && e.message) || e) }) })
      ch.unref()
      resolve({ ok: true })
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }) }
  })
}

/**
 * ★纯函数：算出"关闭"该怎么走★（同样不执行 —— 夹具才能断言）。
 * ★★最关键的不变量：**默认不带 `/F`**★★ —— 不带 `/F` = 给窗口发关闭消息，Obsidian 自己存工作区；
 *   带了 `/F` 就是**当场砍**，用户正在别的库里写东西也会一起没。想强关必须显式 force。
 */
export function planCloseObsidian(force) {
  if (process.platform === 'win32') {
    return { cmd: 'taskkill', args: ['/IM', 'Obsidian.exe'].concat(force ? ['/F', '/T'] : []) }
  }
  return { cmd: 'pkill', args: force ? ['-9', '-f', 'Obsidian'] : ['-f', 'Obsidian'] }
}

// ─────────────── 一键初始化要用到的三步：状态 / 装 / 打开 ───────────────

/** 现在这台机器上 Obsidian 是什么状况（只读探测）。 */
export function obsidianStatus(opts) {
  const opt = opts || {}
  const viewDir = opt.viewDir || null
  const exe = ('exe' in opt && opt.exe) ? opt.exe : findObsidianExe()
  const cfgFile = obsidianConfigFile()
  let registered = false
  try {
    if (viewDir && existsSync(cfgFile)) {
      const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
      registered = isVaultRegistered(raw, viewDir) !== null
    }
  } catch (_e) {}
  return { installed: !!exe, exe: exe || null, configFile: cfgFile || null, viewDir: viewDir, vaultRegistered: registered }
}

/** winget 在不在（Windows 一键装要用它）。 */
export function wingetAvailable() {
  if (process.platform !== 'win32') return false
  try { execFileSync('winget', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); return true } catch (_e) { return false }
}

/**
 * 装 Obsidian（Windows 走 winget）。**这是往用户机器上装程序** —— 调用方必须先问过用户。
 * @returns {Promise<{ok:boolean, exit?:number, exe?:string|null, error?:string, hint?:string}>}
 */
export async function installObsidian() {
  if (process.platform !== 'win32') {
    return { ok: false, error: '这条自动安装只在 Windows 上走 winget；这个系统请自己去 https://obsidian.md 装' }
  }
  if (!wingetAvailable()) {
    return { ok: false, error: '这台机器上没有 winget（应用安装程序）', hint: '去 https://obsidian.md 下载安装，或用 Microsoft Store 搜 Obsidian' }
  }
  const args = ['install', '--id', 'Obsidian.Obsidian', '-e', '--accept-source-agreements', '--accept-package-agreements']
  const code = await new Promise(function (done) {
    let ch = null
    try { ch = spawn('winget', args, { stdio: 'inherit', windowsHide: false }) }
    catch (e) { process.stderr.write('✗ 起不来 winget：' + String((e && e.message) || e) + '\n'); done(-1); return }
    ch.on('error', function (e) { process.stderr.write('✗ winget 出错：' + String((e && e.message) || e) + '\n'); done(-1) })
    ch.on('close', function (c) { done(c === null ? -1 : c) })
  })
  const exe = findObsidianExe()
  if (code === 0 && exe) return { ok: true, exit: code, exe: exe }
  return {
    ok: false, exit: code, exe: exe || null,
    error: code === 0 ? 'winget 说装完了，但没在常见位置找到 Obsidian.exe' : 'winget 退出码 ' + code,
    hint: '可以自己去 https://obsidian.md 装；或者干脆不用 Obsidian —— 记忆视图就是一堆 .md，用任何编辑器都能看',
  }
}

/**
 * 登记 + 打开「记忆视图」这个库。
 * ★这是"不假装成功"的那条路★：**找不到 Obsidian.exe 就直接报失败**（旧代码会去试 `obsidian://` 协议、
 *   一发出去就报成功，于是卡片显示"已发出打开请求（若没弹出，看任务栏）"——其实什么也没发生）。
 * @param {string} viewDir 视图目录（库根）
 * @param {{exe?:string, cfgPath?:string}} [opts]
 */
export async function openVault(viewDir, opts) {
  const opt = opts || {}
  const dir = resolve(String(viewDir || ''))
  if (!existsSync(dir)) {
    return { ok: false, via: 'none', opened: false, registered: null, viewDir: dir,
      error: '视图目录还不存在（先把记忆视图生成出来）：' + dir }
  }
  const status = obsidianStatus(opt.exe ? { viewDir: dir, exe: opt.exe } : { viewDir: dir })
  if (!status.installed) {
    // ★没装就**不碰**人家的 Obsidian 配置★（否则等于在一个没有 Obsidian 的机器上凭空造配置文件）
    return {
      ok: false, via: 'none', opened: false, registered: null, viewDir: dir,
      error: '没找到 Obsidian（可能没装，或者装在非常规位置）',
      hint: '① 装它：winget install --id Obsidian.Obsidian　② 直接打开这个文件夹自己看：' + dir +
        '　③ 这些就是 .md 文件，用任何编辑器（VS Code / Typora / 记事本）都能看',
    }
  }
  const reg = ensureVaultRegistered(dir, opt.cfgPath)
  const plan = planOpenObsidian({ viewDir: dir, vaultName: basename(dir), exe: status.exe })
  const r = await openExternal(plan.uri, plan.via === 'exe' ? plan.exe : null)
  return {
    ok: r.ok === true, via: plan.via, opened: r.ok === true, exe: plan.exe || null, uri: plan.uri,
    viewDir: dir,
    registered: reg.changed ? 'added' : (reg.ok ? 'already' : null),
    registerError: reg.ok === false ? reg.error : null,
    error: r.ok === true ? null : (r.error || '打开失败'),
  }
}
