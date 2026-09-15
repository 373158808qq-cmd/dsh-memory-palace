#!/usr/bin/env node
// init-cli.mjs —— 初始化任务书用的命令行入口（给「召唤出来的新会话里的 agent」调用）。
//
// ★为什么要有它★：卡片的 `/init/*` 路由**带鉴权**（要浏览器令牌换来的 cookie），
//   新会话里的 agent 拿不到 → 只能走这条 CLI。好处：**直接 import 同一个模块**（一份实现、零鉴权），
//   而且每一步都**回写 `~/.dsh-memory/init.json`** → 卡片上那 5 行状态**自己就变 ✓**（不用人再点）。
//
// ★约定（判据要落在能被检查的地方）★
//   · **探测类**（status/detect）：永远 exit 0，结果在 JSON 里让 agent 判 —— "没装 Ollama"是**正常分支**，不是命令失败。
//   · **动作类**（skeleton/ollama-locate/install-ollama/pull-model/use-api/view/mark）：
//     真做成了才 exit 0；参数不对或做不了 → exit 1，原因写 stderr。
//   · ★**退出码一律用 `process.exitCode`，不用 `process.exit()`**★ ——
//     stdout/stderr 接到管道时是**异步**的，`process.exit()` 会把还没写完的 JSON 截掉，
//     agent 就只看到"失败了"、看不到**为什么**（自测当场抓到：失败时那段解释没了）。
//
// 用法（`<插件>` 就是已装的 dsh-memory-palace 目录）：
//   node <插件>/lib/init-cli.mjs status                         当前 5 行状态（JSON）
//   node <插件>/lib/init-cli.mjs detect                         检测 Ollama + 嵌入模型，并回写
//   node <插件>/lib/init-cli.mjs skeleton --root <绝对路径>      建工作区骨架（只建不存在的）
//   node <插件>/lib/init-cli.mjs ollama-locate --path <ollama.exe 或它的目录>
//   node <插件>/lib/init-cli.mjs install-ollama                 后台下载 + 静默安装 Ollama
//   node <插件>/lib/init-cli.mjs pull-model [--model <名字>]      拉嵌入模型（默认用 init.json 里的/检测到的）
//   node <插件>/lib/init-cli.mjs use-api [--model <名字>]        记录"走云端 API"这条路（本地那两行不再算缺）
//   node <插件>/lib/init-cli.mjs view                           按现状重生成「记忆视图」只读副本
//   node <插件>/lib/init-cli.mjs mark --json '{"k":v}'           通用回写（任务书里临时要记点什么时用）
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  readInit, writeInit, initStatus, detectOllama, detectModel,
  locateOllama, skeletonPlan, createSkeleton, installOllama,
} from './init-wizard.mjs'

const MEM = join(homedir(), '.dsh-memory')
const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'

/** 取 `--名字 值`；没给就返回默认值（值不能是另一个 --flag） */
function flag(name, dflt) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return dflt
  return v
}
const out = function (o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n') }
/** 用法/前置条件不对 → 抛这个；顶层统一收，**写完再退出**（见抬头那条约定） */
class Die extends Error {}
const die = function (m) { throw new Die(m) }

const HELP = [
  'init-cli.mjs —— 初始化任务书用的命令行入口',
  '  status / detect / skeleton --root <p> / ollama-locate --path <p> /',
  '  install-ollama / pull-model [--model m] / use-api [--model m] / view / mark --json <json>',
].join('\n')

try {
  switch (cmd) {
    // ── 探测类 ────────────────────────────────────────────────
    case 'status': {
      const st = await initStatus({}, { suggestRoot: function () { return readInit().workspaceSeen || process.cwd() } })
      out(st)
      break
    }
    case 'detect': {
      const ollama = await detectOllama()
      const model = await detectModel().catch(function (e) { return { ok: false, detail: String((e && e.message) || e) } })
      out({ at: new Date().toISOString(), ollama: ollama, model: model })
      break
    }

    // ── 动作类 ────────────────────────────────────────────────
    case 'skeleton': {
      const root = flag('root', readInit().root)
      if (!root) die('要 --root <工作区根目录的绝对路径>（这是任务书里问用户拿到的那个）')
      if (!existsSync(root) || !statSync(root).isDirectory()) die('不是一个存在的文件夹：' + root)
      const plan = skeletonPlan(root)
      if (plan.need) die(plan.need)
      const picks = plan.items.filter(function (i) { return !i.exists }).map(function (i) { return i.key })
      const r = createSkeleton(root, picks)
      out({ ok: true, root: r.root, created: r.created, skipped: r.skipped, plan: plan.items })
      break
    }
    case 'ollama-locate': {
      let p = flag('path', null)
      if (!p) die('要 --path <ollama.exe 的路径，或它所在的目录>')
      p = resolve(String(p))
      if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'ollama.exe')
      if (!existsSync(p)) die('这个路径下没找到 ollama 可执行文件：' + p)
      writeInit({ ollamaExe: p, ollamaLocatedBy: 'user' })
      const d = await detectOllama()
      out({ ok: true, exe: p, ollama: d })
      break
    }
    case 'install-ollama': {
      const r = installOllama()
      out(r)
      if (!r.ok) process.exitCode = 1
      break
    }
    case 'pull-model': {
      let model = flag('model', null)
      if (!model) model = readInit().model || (await detectModel()).want
      if (!model) die('拿不到模型名 —— 用 --model <名字> 指定')
      const exe = locateOllama()
      if (!exe) die('没找到 ollama.exe —— 先装 Ollama（install-ollama），或用 ollama-locate --path 定位')
      process.stdout.write('开始拉模型：' + exe + ' pull ' + model + '\n')
      const code = await new Promise(function (done) {
        // stdio 继承：进度直接打在会话里，人和 agent 都看得见（首次约 600 MB，别当成卡死）
        // ★spawn 也可能**同步抛**★（Windows 上 Node 不许 spawn `.cmd/.bat`，会 EINVAL）——
        //   不接住的话这个 Promise 会直接 reject、JSON 结果就没机会打出来（自测当场抓到）。
        try {
          const ch = spawn(exe, ['pull', model], { stdio: 'inherit', windowsHide: false })
          ch.on('error', function (e) { process.stderr.write('✗ 起不来 ollama pull：' + String((e && e.message) || e) + '\n'); done(-1) })
          ch.on('close', function (c) { done(c === null ? -1 : c) })
        } catch (e) {
          process.stderr.write('✗ 起不来 ollama pull：' + String((e && e.message) || e) + '\n')
          done(-1)
        }
      })
      const after = await detectModel().catch(function () { return { ok: false } })
      out({ ok: code === 0 && after.ok === true, exit: code, model: model, modelOk: after.ok === true, detail: after.detail || null })
      if (code !== 0 || after.ok !== true) process.exitCode = 1
      break
    }
    case 'use-api': {
      let model = flag('model', null)
      if (!model) model = readInit().model || null
      writeInit({ embedderMode: 'api', apiModel: model, model: model || undefined })
      out({ ok: true, embedderMode: 'api', model: model, note: '已记下"走云端 API"；请用户去设置页填 API 地址 / 模型名 / Key，填好回一句"好了"再继续。' })
      break
    }
    case 'view': {
      const root = readInit().root
      if (!root) die('还没记录工作区根目录（先跑 skeleton --root）')
      const { buildView } = await import('./build-view.mjs')
      const r = await buildView({ root: root, memDir: MEM, log: function (m) { process.stdout.write(String(m) + '\n') } })
      // ★必须把 buildView 的真实结果原样回出去★ —— 我第一版硬写 `ok:true`，
      //   结果它内部 `assertSafeOut` 抛的错被**盖掉了**，只留一句"视图生成了"（自测当场抓到）。
      out(Object.assign({ cliOk: r.ok !== false }, r))
      if (r.ok === false) process.exitCode = 1
      break
    }
    case 'mark': {
      const raw = flag('json', null)
      if (!raw) die('要 --json \'{"键":值}\'')
      let obj = null
      try { obj = JSON.parse(raw) } catch (e) { die('--json 不是合法 JSON：' + String((e && e.message) || e)) }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) die('--json 得是一个对象')
      out({ ok: true, init: writeInit(obj) })
      break
    }

    // ── ⑧ 显示层：Obsidian（2026-09-16 用户拍板：并进一键初始化，位置在"建记忆之前"）──
    //   ★为什么必须在建记忆之前问★：库＝`<工作区根>/memory/记忆视图`，而根目录是三问里的第一问；
    //     先问完 Obsidian 才能把库**登记好**，等记忆建完、视图一生成，打开就是一棵完整的树。
    case 'obsidian-status': {
      const ob = await import('./obsidian.mjs')
      const st = readInit()
      const root = flag('root', st.root)
      const viewDir = root ? ob.viewDirOf(root) : null
      const s = ob.obsidianStatus(viewDir ? { viewDir: viewDir, ...(st.obsidianExe ? { exe: st.obsidianExe } : {}) } : {})
      out({ at: new Date().toISOString(), winget: ob.wingetAvailable(), choice: st.obsidianChoice || null, status: s })
      break
    }
    case 'obsidian-locate': {
      const p = flag('path', null)
      if (!p) die('要 --path <Obsidian.exe 的路径，或它所在的目录>')
      const fs2 = await import('node:fs')
      const path2 = await import('node:path')
      let exe = path2.resolve(String(p))
      if (fs2.existsSync(exe) && fs2.statSync(exe).isDirectory()) exe = path2.join(exe, 'Obsidian.exe')
      if (!fs2.existsSync(exe)) die('这个路径下没找到 Obsidian.exe：' + exe)
      writeInit({ obsidianExe: exe, obsidianChoice: 'installed' })
      const ob = await import('./obsidian.mjs')
      out({ ok: true, exe: exe, status: ob.obsidianStatus({ exe: exe }) })
      break
    }
    case 'install-obsidian': {
      // ★往用户机器上装程序★ —— 任务书里必须**先问过他**才跑到这儿。会调 winget（可能几分钟）。
      const ob = await import('./obsidian.mjs')
      process.stdout.write('开始装 Obsidian（winget）…\n')
      const r = await ob.installObsidian()
      if (r.ok) writeInit({ obsidianExe: r.exe, obsidianChoice: 'installed-by-us' })
      out(Object.assign({ cliOk: r.ok }, r))
      if (!r.ok) process.exitCode = 1
      break
    }
    case 'obsidian-register': {
      // 只登记库（先建出目录，让"库"合法存在）——树状图要有地方搭
      const ob = await import('./obsidian.mjs')
      const fs2 = await import('node:fs')
      const st = readInit()
      const root = flag('root', st.root)
      if (!root) die('要先知道工作区根目录（skeleton --root 会记下来）')
      const dir = ob.viewDirOf(root)
      fs2.mkdirSync(dir, { recursive: true })
      const reg = ob.ensureVaultRegistered(dir, undefined)
      out({ ok: reg.ok !== false, viewDir: dir, registered: reg.changed ? 'added' : 'already',
        id: reg.id || null, file: reg.file || null, error: reg.ok === false ? reg.error : null })
      if (reg.ok === false) process.exitCode = 1
      break
    }
    case 'obsidian-open': {
      const ob = await import('./obsidian.mjs')
      const st = readInit()
      const root = flag('root', st.root)
      if (!root) die('要先知道工作区根目录')
      const dir = ob.viewDirOf(root)
      const op = await ob.openVault(dir, st.obsidianExe ? { exe: st.obsidianExe } : {})
      out(Object.assign({ cliOk: op.ok === true }, op))
      if (op.ok !== true) process.exitCode = 1
      break
    }

    default:
      process.stderr.write(HELP + '\n')
      process.exitCode = 2
  }
} catch (e) {
  if (e instanceof Die) {
    process.stderr.write('✗ ' + e.message + '\n')
    process.exitCode = 1
  } else {
    process.stderr.write('✗ 未预期错误：' + String((e && e.stack) || e) + '\n')
    process.exitCode = 1
  }
}
