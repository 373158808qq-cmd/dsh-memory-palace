// tools/root.mjs —— 维护工具共用的**根目录/记忆库定位**（换台电脑也成立的那种）。
//
// ★为什么必须统一★：这七个工具原来是本项目 `memory/tools/` 里的脚本，靠"从自己所在位置往上走、
//   找到工作区根"（`findRoot()`）。搬进插件之后**这条路断了**：
//   朋友装的是 tarball，插件躺在 `~/.dsh/profiles/web/node_modules/dsh-memory-palace/lib/tools/`，
//   它上面**根本没有工作区**。⇒ 根目录必须能**问出来**，而不是猜出来。
//
// 取根顺序（先问、后猜，且**猜错要能被发现**）：
//   ① 显式传的 `--root`（人工/任务书/设置页给的）
//   ② `~/.dsh-memory/init.json` 里的 `root`（初始化向导问过用户、记下来了 —— **这是最可靠的一处**）
//   ③ 从 `startDir`（一般是进程 cwd）往上找"长得像工作区根"的目录（标志物：有 `AGENTS.md` 且有 `memory/`）
//   ④ 都没有 → `null`（调用方**如实报"不知道根目录"**，绝不拿 cwd 凑合 —— 那会把别处的文件当成你的）
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 记忆库：显式参数 > 环境变量 > `~/.dsh-memory`（与插件用的是同一个） */
export function resolveMemDir(explicit) {
  if (explicit) return resolve(String(explicit))
  const env = String(process.env.DSH_MEMORY_DIR || '').trim()
  if (env) return resolve(env)
  return join(homedir(), '.dsh-memory')
}

/** 读初始化向导记下的那台机器的状态（`~/.dsh-memory/init.json`）；读不到就 `{}` */
export function readInit(memDir) {
  try { return JSON.parse(readFileSync(join(resolveMemDir(memDir), 'init.json'), 'utf8')) || {} } catch (_e) { return {} }
}

/** 从一个目录往上找"工作区根"：标志物＝有 `AGENTS.md` **且** 有 `memory/` 目录 */
export function findWorkspaceRoot(startDir) {
  let dir = resolve(String(startDir || process.cwd()))
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'memory'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * 定工作区根。`explicit` 传了就**只认它**（且会检查它像不像工作区根，不像就如实说）。
 * @returns {{root:string|null, how:string, warn?:string}}
 */
export function resolveRoot(explicit, memDir) {
  if (explicit) {
    const r = resolve(String(explicit))
    if (!existsSync(r)) return { root: null, how: 'explicit', warn: '这个根目录不存在：' + r }
    if (!existsSync(join(r, 'AGENTS.md'))) return { root: r, how: 'explicit', warn: '这个目录里没有 AGENTS.md —— 可能根目录选错了：' + r }
    return { root: r, how: 'explicit' }
  }
  const st = readInit(memDir)
  if (typeof st.root === 'string' && st.root !== '' && existsSync(st.root)) return { root: resolve(st.root), how: 'init.json' }
  const found = findWorkspaceRoot(process.cwd())
  if (found) return { root: found, how: 'walk-up' }
  return { root: null, how: 'none', warn: '还不知道工作区根目录在哪 —— 用 --root 指定，或先在设置页跑一次初始化向导' }
}

/** `--名字 值` 的小解析器（各工具的入口共用；值不能是另一个 `--flag`） */
export function argOf(argv, name, dflt) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return dflt
  return v
}
