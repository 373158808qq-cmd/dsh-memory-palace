// ★2026-09-16 从 `<工作区>/memory/tools/backup_memory.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// 记忆系统 · 回退点工具（backup_memory）—— **建回退点** + **验证回退点真的能还原**。
//
// ★为什么要它★：未验收表里躺着一条「可回滚演练 ｜ 退回 P0 前 ｜ **只有弱证据；`backups/p0_pre`、`p3_pre` 现已不存在**」。
//   而"回退能力"是用户最在意的"**最恨修好的又坏**"唯一兜底。
//   光有备份 ≠ 能回退 —— **没验证过的备份等于没有备份**（跟"没跑过的测试会烂"同一个道理）。所以本工具两个模式：
//     · 建点：把**不可再生**的源文件抄进 `backups/memory_rollback_<时间戳>/`，附 `MANIFEST.json`（逐文件 sha256）
//     · 验证：**把回退点还原到临时目录 + 逐文件比 sha256** → 证明 `--verify` 通过才算"这个点可用"
//
// ★设计依据（2026-09-14 实测）★：记忆库 27.9 MB 里，**23 MB 是 `corpus/`、4.3 MB 是 `vault.db`**，
//   而这两个**都能从源重建**（库 ← `resync_vault.mjs`；语料 ← `ingest_corpus.mjs` + 会话日志）。
//   所以**默认只备"不可再生"的那几百 KB**（`--full` 才连库和语料一起备）。
//   ⚠️ **诚实的边界**：`corpus/` **不是 100% 可再生** —— 它可能是某些会话**唯一的副本**（日志被清了就没了）。
//      所以 `--full` 在"要动语料"之前该跑一次；日常小改用默认模式即可。
//
// 用法：
//   node memory/tools/backup_memory.mjs                 # 建"轻"回退点（源文件 + 项目文档 + 工具）
//   node memory/tools/backup_memory.mjs --full          # 连 vault.db + corpus 一起备（~28 MB）
//   node memory/tools/backup_memory.mjs --verify <目录> # ★验证某个回退点能不能真的还原★
//   node memory/tools/backup_memory.mjs --list          # 列出已有回退点
//   （换环境/夹具用：--root <工作区> --memdir <记忆库> --out <回退点放哪>）
//    ★夹具回归 `verify/verify_backup.mjs` 就是靠这三个开关，把整条链路跑在 `.ptmp/` 里、
//      **一个字节都不碰真库与真 backups/**★ —— 没有它们，这个工具就只能"手测"，而手测不会重跑。
// 退出码：0 = 成功；1 = 失败（含 --verify 不通过）
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
let DISCOVERED = HERE
for (let i = 0; i < 8; i++) {
  if (existsSync(join(DISCOVERED, 'plugins', 'dsh-memory-palace', 'lib', 'index.js'))) break
  DISCOVERED = dirname(DISCOVERED)
}
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const ROOT = argOf('--root', DISCOVERED)
const MEM = argOf('--memdir', join(homedir(), '.dsh-memory'))
const BACKUPS = argOf('--out', join(ROOT, 'backups'))
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

/** 要备的清单：`[源绝对路径, 包内相对路径]` */
function plan(full) {
  const out = []
  // ① 记忆库：配置 + 规则 + 画像 + 长期记忆 + 裁决台账（都是小文件）
  for (const f of ['USER.md', 'MEMORY.md', 'SOP.md', 'embedder.json', 'inject.json', 'memory.json', 'vault-sync.json', 'gate2.json', 'sop.enabled']) {
    const p = join(MEM, f)
    if (existsSync(p)) out.push([p, 'mem/' + f])
  }
  const corr = join(MEM, 'corrections')
  if (existsSync(corr)) for (const f of readdirSync(corr)) out.push([join(corr, f), 'mem/corrections/' + f])
  // ★2026-09-15 加：`impressions/`（⑥ 懂你档案）★
  //   为什么属于"默认该备的那一份"：它跟 USER.md **同性质** —— 是**不可再生的源文件**
  //   （本工具的口径就是"默认只备不可再生的那几百 KB"，库和语料才丢给 `--full`）。
  //   以前没备它 → 回退点还原之后"越来越懂你"那一层会**静默回到旧版**，
  //   而 Vault 的 `impressions` 分区是照它重建的 → 两边打架，且**不报错**。
  const impr = join(MEM, 'impressions')
  if (existsSync(impr)) {
    for (const f of readdirSync(impr)) if (/\.md$/i.test(f)) out.push([join(impr, f), 'mem/impressions/' + f])
  }
  // ② 本项目文档 + 规则 + 工具（**回退真正要保住的东西**）
  for (const rel of ['memory/AGENTS.md', 'memory/PROJECT_LEDGER.md', 'memory/PROJECT_LEDGER_ARCHIVE.md', 'memory/INDEX.md', 'memory/INDEX_CARDS.md', 'memory/VAULT_INDEX.md', 'AGENTS.md']) {
    const p = join(ROOT, rel)
    if (existsSync(p)) out.push([p, 'project/' + rel.replace(/\//g, '__')])
  }
  const tools = join(ROOT, 'memory', 'tools')
  if (existsSync(tools)) {
    const walk = (d, depth) => {
      if (depth > 3) return
      for (const it of readdirSync(d)) {
        const p = join(d, it)
        if (/(^|[\\/])(node_modules|verify_client)([\\/]|$)/.test(p)) continue
        let st
        try { st = statSync(p) } catch (_e) { continue }
        if (st.isDirectory()) { walk(p, depth + 1); continue }
        if (!/\.(mjs|js|py|json)$/.test(it)) continue
        out.push([p, 'tools/' + relative(tools, p).replace(/\\/g, '__')])
      }
    }
    walk(tools, 0)
  }
  // ③ `--full`：连"可重建但可能不可再生"的一起备
  if (full) {
    const db = join(MEM, 'vault.db')
    if (existsSync(db)) out.push([db, 'mem/vault.db'])
    const vmd = join(MEM, 'vault.md')
    if (existsSync(vmd)) out.push([vmd, 'mem/vault.md'])
    const corpus = join(MEM, 'corpus')
    if (existsSync(corpus)) for (const f of readdirSync(corpus)) out.push([join(corpus, f), 'mem/corpus/' + f])
  }
  return out
}

function buildBackup(full) {
  const dest = join(BACKUPS, 'memory_rollback_' + stamp() + (full ? '_full' : ''))
  const items = plan(full)
  const man = { at: new Date().toISOString(), root: ROOT, memDir: MEM, full: !!full, files: [] }
  let bytes = 0
  for (const [src, rel] of items) {
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(src, to)
    const st = statSync(src)
    bytes += st.size
    man.files.push({ rel, src, sha256: sha(src), size: st.size })
  }
  writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify(man, null, 1), 'utf8')
  console.log('✓ 回退点已建：' + dest)
  console.log('  文件 ' + man.files.length + ' 个 ／ ' + (bytes / 1024).toFixed(0) + ' KB' + (full ? '（含库与语料）' : '（轻量：不含 vault.db 与 corpus —— 它们可从源重建）'))
  console.log('  清单：MANIFEST.json（逐文件 sha256）')
  return dest
}

function verify(dir) {
  const mp = join(dir, 'MANIFEST.json')
  if (!existsSync(mp)) { console.log('✗ 这个目录不是回退点（没有 MANIFEST.json）：' + dir); return false }
  // ★坏掉的 MANIFEST 必须"出声失败"，不许甩一屏栈★ —— 这是负例测试当场抓到的真 bug：
  //   回退点坏掉的时候**正是你最需要它说清楚的时候**，抛未捕获异常等于什么都没说。
  //   （那次触发它的正是本项目的老熟人：**PowerShell 写 JSON 会带 BOM** → JSON.parse 直接炸。）
  let man = null
  try {
    man = JSON.parse(readFileSync(mp, 'utf8').replace(/^\uFEFF/, ''))   // 容忍 BOM（有人手改过也认）
  } catch (e) {
    console.log('✗ MANIFEST.json 读不了（坏了 / 不是合法 JSON）：' + dir)
    console.log('  ' + ((e && e.message) || e))
    return false
  }
  if (man === null || !Array.isArray(man.files)) { console.log('✗ MANIFEST.json 形状不对（没有 files 数组）：' + dir); return false }
  // ★还原到临时目录再比 —— 只是"读一遍备份"证明不了"能还原"★
  const tmp = join(BACKUPS, '.verify_tmp')
  rmSync(tmp, { recursive: true, force: true })
  let ok = 0, bad = []
  for (const f of man.files) {
    const src = join(dir, f.rel)
    const to = join(tmp, f.rel)
    if (!existsSync(src)) { bad.push(f.rel + '（备份里缺失）'); continue }
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(src, to)
    if (sha(to) !== f.sha256) bad.push(f.rel + '（还原后哈希不符）')
    else ok++
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log('回退点 : ' + dir)
  console.log('  建于 ' + man.at + (man.full ? '（full）' : '（轻量）'))
  console.log('  还原并校验：' + ok + ' 通过' + (bad.length ? ' / ' + bad.length + ' 失败' : ' / 0 失败'))
  if (bad.length) { for (const b of bad.slice(0, 8)) console.log('    ✗ ' + b); return false }
  console.log('  ✓ 这个回退点**可用**（每个文件都能还原且哈希一致）')
  return true
}

function list() {
  if (!existsSync(BACKUPS)) { console.log('（还没有 backups/ 目录）'); return }
  const ds = readdirSync(BACKUPS).filter(function (n) { return n.indexOf('memory_rollback_') === 0 }).sort()
  if (ds.length === 0) { console.log('（还没有记忆系统回退点）'); return }
  for (const d of ds) {
    const mp = join(BACKUPS, d, 'MANIFEST.json')
    let n = '?', size = 0
    if (existsSync(mp)) { const m = JSON.parse(readFileSync(mp, 'utf8')); n = m.files.length; size = m.files.reduce(function (a, b) { return a + b.size }, 0) }
    console.log('  ' + d + '  ' + n + ' 文件 / ' + (size / 1024).toFixed(0) + ' KB')
  }
}

// ══ 主流程 ══
const V = process.argv.indexOf('--verify')
if (V >= 0) { process.exit(verify(process.argv[V + 1]) ? 0 : 1) }
if (process.argv.includes('--list')) { list(); process.exit(0) }
buildBackup(process.argv.includes('--full'))
process.exit(0)
