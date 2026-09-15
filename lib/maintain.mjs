// maintain.mjs —— 维护作业的**执行器**（设置页「维护」卡 + `maintain-cli.mjs` 共用）。
//
// ★这些作业的实现在 `lib/tools/` 里★（2026-09-16 从本项目的 `memory/tools/` 搬进来）——
//   原来它们只住在**我这个工作区**，朋友装了插件却没有那些文件 = 维护能力换机就没了。
//
// ★为什么要"写文件再读"，不用管道抓输出★：
//   Node 的 `execFile(..., {stdio:'pipe'})` 在受限沙箱下会 EPERM（本项目踩过：抓子进程输出失败）。
//   改成 `stdio: ['ignore', fd, fd]` 把输出**重定向到临时文件**，再读文件 —— 不经过管道，
//   到哪儿都能用；文件在 `finally` 里删掉，**删不掉要出声**（不许静默留垃圾）。
import { openSync, closeSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveRoot, resolveMemDir } from './tools/root.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, 'tools')

/**
 * 作业表。`exitMeans` 说清"非 0 退出码是什么意思"——
 * ★不是所有非 0 都是"失败"★：体检器/裁决台账/状态核对是**用退出码表示"有待你看的条目"**，
 * 把它们渲染成"失败"会让人以为工具坏了（本项目对"假红"很敏感）。
 */
export const JOBS = [
  { id: 'truth', name: '状态真话核对', script: 'check-vault-truth.mjs', needsRoot: false, exitMeans: '0 = 逐分区全对得上；1 = 有对不上的（状态撒了谎）',
    what: '核对"状态文件声称几块" vs "库里真有几行"，并查同分区重复块' },
  { id: 'lint', name: '分层纪律', script: 'lint-layers.mjs', needsRoot: true, exitMeans: '0 = 过；1 = 有失败项',
    what: '检查每轮注入文件的重复/放错层/指针失效，以及各项目台账的流水与长解释' },
  { id: 'budget', name: '注入预算', script: 'budget.mjs', needsRoot: true, exitMeans: '0 = 全在上限内；1 = 超上限或上限出处对不上',
    what: '每轮注入占多少、上限多少、上限的出处是否可核对（尺子必须用 Node 量）' },
  { id: 'doctor', name: '体检器（8 项）', script: 'memory-doctor.mjs', needsRoot: true, exitMeans: '0 = 没有候选；1 = 有候选条目（**是"待你裁"不是"坏了"**）',
    what: '路径存在性/退役物当现状/块级相似/注入重复/活文档住院区/快照一致性/语料过期/文档自称vs现实' },
  { id: 'findings', name: '裁决台账', script: 'findings.mjs', needsRoot: true, exitMeans: '0 = 没有待裁决；1 = 有待裁决条目',
    what: '⑤ 校验层的矛盾台账：在报几条、几条已裁决、清零率多少' },
  { id: 'capabilities', name: '能力清单点名', script: 'check-capabilities.mjs', needsRoot: true, exitMeans: '0 = 过（或这台机器没有能力清单）；1 = 清单本身有问题',
    what: '核对 `knowledge/capabilities/` 六格格式（没有这个目录就跳过，不算红）' },
  { id: 'backup', name: '备份记忆库', script: 'backup-memory.mjs', needsRoot: true, exitMeans: '0 = 备份已建；1 = 失败',
    what: '把记忆库备份到 `backups/`（轻量≈800KB；`--full` 连库与语料≈28MB）' },
]

export function jobById(id) { return JOBS.filter(function (j) { return j.id === id })[0] || null }

/**
 * 跑一个作业。
 * @param {string} id 作业 id
 * @param {{root?:string, memDir?:string, extraArgs?:string[], timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, id:string, exit:number|null, ms:number, text:string, cmd:string, error?:string, root:string|null, rootHow:string}>}
 */
export async function runJob(id, opts) {
  const o = opts || {}
  const job = jobById(id)
  if (!job) return { ok: false, id: id, exit: null, ms: 0, text: '', cmd: '', error: '没有这个作业：' + id }
  const script = join(TOOLS, job.script)
  if (!existsSync(script)) return { ok: false, id: id, exit: null, ms: 0, text: '', cmd: '', error: '插件里缺这个工具脚本（打包漏了？）：' + script }

  const memDir = resolveMemDir(o.memDir)
  const rr = resolveRoot(o.root, memDir)
  const args = [script]
  if (job.needsRoot) {
    if (!rr.root) return { ok: false, id: id, exit: null, ms: 0, text: '', cmd: '', error: rr.warn || '不知道工作区根目录', root: null, rootHow: rr.how }
    args.push('--root', rr.root)
  }
  args.push('--memdir', memDir)
  args.push(...(o.extraArgs || []))

  const stamp = process.pid + '-' + Date.now().toString(36)
  const outFile = join(tmpdir(), 'dsh-maintain-' + stamp + '.log')
  const t0 = Date.now()
  let fd = null
  try { fd = openSync(outFile, 'w') } catch (e) {
    return { ok: false, id: id, exit: null, ms: 0, text: '', cmd: '', error: '开不了输出文件：' + String((e && e.message) || e) }
  }
  const exit = await new Promise(function (done) {
    let ch = null
    try { ch = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true }) }
    catch (e) { process.stderr.write('起不来作业进程：' + String((e && e.message) || e) + '\n'); done(-1); return }
    ch.on('error', function () { done(-1) })
    ch.on('close', function (c) { done(c === null ? -1 : c) })
  })
  try { closeSync(fd) } catch (_e) {}
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch (_e) {}
  // ★收尾要出声★：删不掉就把路径说出来，别静默留垃圾
  try { rmSync(outFile, { force: true }) } catch (e) { text += '\n⚠ 临时输出文件没删掉：' + outFile + '（' + String((e && e.message) || e) + '）' }

  return {
    ok: exit === 0, id: id, name: job.name, exit: exit, ms: Date.now() - t0, text: text,
    cmd: 'node "' + script + '" ' + args.slice(1).join(' '),
    root: rr.root, rootHow: rr.how, rootWarn: rr.warn || null, exitMeans: job.exitMeans,
  }
}

/** 一次性把作业表 + 这台机器的根目录状况给出去（设置页用它渲染按钮） */
export function jobList(opts) {
  const o = opts || {}
  const memDir = resolveMemDir(o.memDir)
  const rr = resolveRoot(o.root, memDir)
  return {
    ok: true, memDir: memDir, root: rr.root, rootHow: rr.how, rootWarn: rr.warn || null,
    jobs: JOBS.map(function (j) { return { id: j.id, name: j.name, what: j.what, needsRoot: j.needsRoot, exitMeans: j.exitMeans } }),
  }
}

// ─────────────── 宿主路由（设置页「维护」卡用） ───────────────
// 与 `init-wizard.mjs` 的 `/init/*` 同一套路：`deps.suggestRoot()` 给"当前会话的工作目录"当兜底。
function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise(function (done) {
    let b = ''
    req.on('data', function (c) { b += c; if (b.length > 1 << 20) req.destroy() })
    req.on('end', function () { try { done(b ? JSON.parse(b) : {}) } catch (_e) { done({}) } })
    req.on('error', function () { done({}) })
  })
}

export function registerMaintainRoutes(ctx, deps) {
  const handler = async function (req, res, fn) {
    try { sendJson(res, 200, await fn(req)) }
    catch (e) { sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }) }
  }
  const R = function (path, fn) { ctx.webServer.register({ kind: 'exact', path: path, handler: function (req, res) { handler(req, res, fn) } }) }
  const rootOf = function (b) {
    if (b && typeof b.root === 'string' && b.root !== '') return b.root
    try { return (deps && typeof deps.suggestRoot === 'function') ? deps.suggestRoot() : null } catch (_e) { return null }
  }

  R('/dsh-memory-app/maintain/list', async function (req) {
    const b = await readBody(req)
    return jobList({ root: rootOf(b) })
  })
  R('/dsh-memory-app/maintain/run', async function (req) {
    const b = await readBody(req)
    const id = String(b.id || '')
    if (!jobById(id)) return { ok: false, error: '没有这个作业：' + id, jobs: JOBS.map(function (j) { return j.id }) }
    return await runJob(id, { root: rootOf(b), extraArgs: Array.isArray(b.args) ? b.args.map(String) : [] })
  })
  return ctx
}
