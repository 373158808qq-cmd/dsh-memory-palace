// **记忆视图生成器（⑧ 显示层）—— CLI 与插件 boot 共用这一份实现**
//
// ★为什么放进 `lib/`（而不是只留在 memory/tools）★
//   DSH 启动时那次自动同步是**插件侧**跑的（`vault-sync.mjs`）；它只重建 Vault 分区、
//   **不刷视图** → 重启一次视图就停在旧版（2026-09-14 留下的最后一个技术缺口）。
//   修法只能是"让插件也会生成视图"，而**两份实现必然漂移**（阶段42 切块器的同类教训：
//   CLI 与 boot 切出两种库、还不报错）→ 所以这里做成 **一份实现、两个入口**：
//     · CLI：`memory/tools/build_view.mjs`（薄壳，import 本文件）
//     · 插件：`lib/index.js` 的 `doVaultSync()` 在同步成功后调 `buildView()`
//
// ★它不造内容，只做搬运 + 组织★
//   Vault 里的内容**全部来自真实存在的 .md 文件**（常驻三件／索引／各项目台账档案／卡片）。
//   这一层只干两件事：① 把该读的**复制**进一个干净的小库（库外的文件 Obsidian 搜不到、链不到）；
//   ② 把 Vault 的块按分区摊成"节"（同一节的连续块合并、接缝去重）→ 大纲/搜索/图谱才有用。
//
// ★过时是这层唯一的真风险★（铁律："过时文档比没有更坏"）：每份副本带 **源路径 + 源指纹 + 正文指纹**；
//   `checkView()` 逐项核对，`_状态.md` 是账本。插件侧刷新失败会**大声报**（不静默）。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
// ★知识库的"怎么算一份"必须与同步器**同一份实现**★（`knowledgeText` 在 vault-sync 里）：
//   否则会出现"同步进去的是 A、入口页列的是 B"这种漂移（切块器那次的教训）。
import { knowledgeText } from './vault-sync.mjs'

const MARK = '记忆视图'
const ELL = '…'
/** ★树形（B5）之后的顶层★：入口 + 账本 + **五张大类页** + 四个大类目录。
 *  ⚠️ **`05-知识库` 绝不能加进来**：那是指向 `<工作区>/knowledge/` 的 **junction**（用户自己的东西）——
 *     把它当成"我们的目录"清掉 = **删用户的库**。`05-知识库.md` 是普通文件，与它同名不同物，安全。 */
export const OURS_TOP = ['00-入口.md', '_状态.md',
  '01-常驻.md', '02-索引.md', '03-项目.md', '04-分区.md', '05-知识库.md',
  '01-常驻', '02-索引', '03-项目', '04-分区']

const sha16 = function (s) { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16) }
const stamp = function () { return new Date().toISOString().replace('T', ' ').slice(0, 19) }
const read = function (p) { try { return readFileSync(p, 'utf8') } catch (_e) { return null } }
/** 文件名消毒（**只给文件名用**）：Windows 非法字符 + 控制字符 + 首尾点空格 */
const safeName = function (s, max) {
  const t = String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '').replace(/^[.\s]+|[.\s]+$/g, '')
  return (t.slice(0, max || 80) || '未命名')
}
/** 标题文本（写进 `## ` 里的）：**不做文件名消毒** —— 只去控制字符/换行、限长。
 *  ★别拿 safeName 处理标题★：它会把 `**粗体**` 换成 `__粗体__`（`*` 是**文件名**非法字符）= 篡改原文。 */
const cleanTitle = function (s, max) {
  const cap = max || 120
  const t = String(s).replace(/[\r\n\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > cap ? t.slice(0, cap - 1) + ELL : t
}
const fmt = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

/** 输出目录安全闸：**要删就先证明"这确实是我们自己的视图目录"** */
function assertSafeOut(out, root, memDir) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const forbidden = [root, memDir, home, join(root, 'memory'), resolve('/')].filter(Boolean)
  for (const f of forbidden) {
    if (resolve(f) === out) throw new Error('拒绝：视图目录不能是 ' + out)
  }
  const inRoot = root && out.startsWith(resolve(root) + sep)
  const inMem = memDir && out.startsWith(resolve(memDir) + sep)
  if (!inRoot && !inMem) throw new Error('拒绝：视图目录在工作区/记忆库之外 → ' + out)
  if (existsSync(out)) {
    const t = read(join(out, '_状态.md'))
    if (t === null || t.indexOf(MARK) < 0) {
      throw new Error('拒绝：目标目录已存在，但没有 `_状态.md` 标记（不是本工具生成的）→ 不敢清空它：' + out)
    }
  }
}

// ── 块 → 节 ─────────────────────────────────────────────────────────
/** 解析块首行。三种形态：① 带父标题链 ② 自带标题（H1=文档根 / H2+=一节）③ 都没有（块内找第一个标题） */
function parseBlock(b) {
  const lines = String(b).split('\n')
  const first = (lines[0] || '').trim()
  let chain = []
  let own = false
  let level = 0
  let from = 1
  if (/^#{1,6}\s*【父标题链】/.test(first)) {
    chain = first.replace(/^#{1,6}\s*【父标题链】\s*/, '')
      .split(' → ').map(function (x) { return x.replace(/^#{1,6}\s*/, '').trim() }).filter(Boolean)
  } else {
    let at = -1
    if (/^#{1,6}\s+/.test(first)) at = 0
    else at = lines.findIndex(function (l, i) { return i < 12 && /^#{1,6}\s+\S/.test(l.trim()) })
    if (at >= 0) {
      const m = /^(#{1,6})\s+/.exec(lines[at].trim())
      chain = [lines[at].trim().replace(/^#{1,6}\s+/, '').trim()]
      own = true
      level = m[1].length
      from = at === 0 ? 1 : 0
    } else {
      from = 0
    }
  }
  return { chain: chain, own: own, level: level, body: demote(lines.slice(from).join('\n')) }
}
/** 正文标题统一降 2 级（大纲里 `##` = 节边界）；**必须避开代码围栏**（围栏里是内容，改了就是篡改） */
function demote(body) {
  let inFence = false
  return body.split('\n').map(function (l) {
    if (/^\s*```/.test(l)) { inFence = !inFence; return l }
    if (inFence) return l
    const m = /^(#{1,6})(\s+)(.*)$/.exec(l)
    if (!m) return l
    return '#'.repeat(Math.min(6, m[1].length + 2)) + m[2] + m[3]
  }).join('\n')
}
/** 接缝重叠长度（切块 overlap 造成）：**只认 ≥20 字**，防"碰巧一样"误删 */
function overlapLen(a, b) {
  const max = Math.min(a.length, b.length, 400)
  for (let k = max; k >= 20; k--) if (a.slice(a.length - k) === b.slice(0, k)) return k
  return 0
}
/** 后一块接到前一块上：接缝重复只留一份（**先归一化两端空白**，否则永远对不上） */
function joinSeam(a, b) {
  const A = a.replace(/\s+$/, '')
  const B = b.replace(/^\s+/, '')
  const k = overlapLen(A, B)
  if (k > 0) {
    const midLine = B[k - 1] !== '\n'
    const rest = B.slice(k)
    return A + (midLine ? rest : (rest ? '\n\n' + rest : ''))
  }
  return A + (B ? '\n\n' + B : '')
}
/** "同一个东西"的容忍比较：链会逐级降级（中间层省成 `…`、元素被截断成 `…`、整条根被丢掉） */
function looseEq(a, b) {
  if (a === b) return true
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.endsWith(ELL) && a.length > 1 && b.startsWith(a.slice(0, -1))) return true
  if (b.endsWith(ELL) && b.length > 1 && a.startsWith(b.slice(0, -1))) return true
  return false
}
/** 块 → 节：**节的身份证 = (文档, 节名)**；根没了继承"当前文档"；认不出标题的块绝不合并 */
function groupBlocks(blocks) {
  const groups = []
  let curDoc = null
  for (const raw of blocks) {
    const p = parseBlock(raw)
    const els = p.chain.filter(function (x) { return x !== ELL })
    let doc = null
    let sec = ''
    if (els.length === 0) { sec = '' }
    else if (p.own && p.level <= 1) { sec = els[0]; doc = els[0]; curDoc = els[0] }
    else if (p.own) { sec = els[0]; doc = curDoc }
    else if (p.chain.length === 1) { sec = els[0]; doc = els[0]; curDoc = els[0] }
    else {
      sec = els[els.length - 1]
      if (els.length >= 2) { doc = els[0]; curDoc = els[0] }
      else { doc = curDoc }
    }
    const last = groups[groups.length - 1]
    if (last && sec !== '' && looseEq(doc, last.doc) && looseEq(sec, last.sec)) {
      last.body = joinSeam(last.body, p.body)
      last.parts++
      continue
    }
    groups.push({ doc: doc, sec: sec, body: p.body, parts: 1 })
  }
  return groups
}

/** 收集要生成的条目（不写盘） */
function collect(o) {
  const root = o.root
  const memDir = o.memDir
  const items = []
  const addCopy = function (rel, srcPath, title) {
    const t = read(srcPath)
    if (t === null) return false
    items.push({ rel: rel, src: srcPath, srcHash: sha16(t), body: t, title: title || rel })
    return true
  }
  // ① 常驻三件
  addCopy('01-常驻/USER.md', join(memDir, 'USER.md'), 'USER.md（用户画像）')
  addCopy('01-常驻/MEMORY.md', join(memDir, 'MEMORY.md'), 'MEMORY.md（长期记忆）')
  addCopy('01-常驻/SOP.md', join(memDir, 'SOP.md'), 'SOP.md（协作 SOP）')
  // ② 索引层
  addCopy('02-索引/总目录-INDEX.md', join(root, 'memory', 'INDEX.md'), '项目总目录')
  addCopy('02-索引/位置总目录-VAULT_INDEX.md', join(root, 'memory', 'VAULT_INDEX.md'), '全库位置总目录')
  addCopy('02-索引/项目卡片.md', join(root, 'memory', 'INDEX_CARDS.md'), '项目卡片正文')
  addCopy('02-索引/会话卡片.md', join(memDir, 'corpus', 'INDEX_CARDS.md'), '会话卡片正文')
  // ③ 每个项目的台账 + 档案
  const skip = /^(node_modules|\.|_trash|backups|pylibs|runtime|logs|test|docs|examples|skill_src|plugins|memory)$/
  const dirs = []
  try { for (const d of readdirSync(root).sort()) { if (!skip.test(d) && existsSync(join(root, d, 'PROJECT_LEDGER.md'))) dirs.push(d) } } catch (_e) {}
  for (const d of dirs) {
    addCopy('03-项目/' + safeName(d) + '/台账.md', join(root, d, 'PROJECT_LEDGER.md'), d + ' 台账')
    if (existsSync(join(root, d, 'PROJECT_LEDGER_ARCHIVE.md'))) {
      addCopy('03-项目/' + safeName(d) + '/档案.md', join(root, d, 'PROJECT_LEDGER_ARCHIVE.md'), d + ' 档案')
    }
  }
  addCopy('03-项目/memory/台账.md', join(root, 'memory', 'PROJECT_LEDGER.md'), 'memory 台账')
  if (existsSync(join(root, 'memory', 'PROJECT_LEDGER_ARCHIVE.md'))) {
    addCopy('03-项目/memory/档案.md', join(root, 'memory', 'PROJECT_LEDGER_ARCHIVE.md'), 'memory 档案')
  }
  return items
}

/** ④ 分区块 → 文件正文 */
function renderPartition(ns, blocks) {
  const groups = groupBlocks(blocks)
  const used = new Map()
  let prevDoc = null
  const lines = [
    '# Vault 分区：' + ns + '（' + blocks.length + ' 块 → ' + groups.length + ' 节）',
    '',
    '> 这些是**切块后的块**整理成的人眼视图：**同一节的连续块已合并**、接缝重复已去掉。',
    '> 每节以 `## 标题` 开头；**节正文里的标题统一降了 2 级**，所以大纲里 `##` = 节边界。',
    '> **同一份文档里，文档根只在"文档开头那一节"出现一次**（后面各节只写节名，不重复全文）。',
    '> 原文（不切块、带表格）见 `03-项目/` 对应那份；语义检索用 `memory_search`（带 `namespace`）。',
    '> **只读副本** —— 改源文件后重跑同步（CLI：`node memory/tools/resync_vault.mjs`）。',
    '',
  ]
  for (const g of groups) {
    let title
    if (g.sec === '') title = '（无标题块）'
    else if (g.doc !== null && g.doc !== g.sec && looseEq(g.doc, prevDoc)) title = g.sec
    else title = (g.doc !== null && g.doc !== g.sec) ? g.doc + ' → ' + g.sec : g.sec
    if (g.doc !== null) prevDoc = g.doc
    let t = cleanTitle(title || '（无标题块）', 120)
    const k = used.get(t) || 0
    used.set(t, k + 1)
    if (k) t = t + ' ·' + (k + 1)
    lines.push('## ' + t, '', g.body.replace(/\s+$/, ''), '')
  }
  return { text: lines.join('\n'), sections: groups.length }
}

// ── ★树形（B5，2026-09-15 用户拍板）★ ───────────────────────────────────────
// 以前是**星形**：`00-入口.md` 把常驻/索引/项目/分区/知识库**一次性平铺**链出来（30 多条）。
// 图谱因此是一朵蒲公英 —— 入口连接一切、中间没有层，翻只能靠 Ctrl+O 搜。
// 现在是一条**树**：**入口只链 01–05 五张大类页** → 每张大类页**只链它的孩子** →
// 项目再往下各有一张 `03-项目/<项目>/00-索引.md` 链该项目的台账/档案。
// ★判据写死在 `verify_view.mjs`★：每一条链接要么指向**自己的孩子**、要么指向**直接父亲**，
//   别的（跨层、平铺、指向别人家的孩子）一律算坏 —— 这条不变量就是"它真的长成树了"。
// ⚠️ 每张页**只往上指一层**（大类页 → 入口；项目页 → `03-项目.md`）。这不违反"只链孩子"，
//   而是让"往下翻得进去、往上回得来" —— 没有它，Obsidian 里翻到第 3 层就回不去了。
// ⚠️ **链接一律写在列表里，不许放进 markdown 表格**（2026-09-15 真机抓到的 bug）：
//   表格拿 `|` 分单元格，而别名链接 `[[文件|别名]]` 自带一个竖线 → 被切两半 →
//   **Obsidian 里点不开、图谱里全成孤立点**。同一批链接换个容器就坏，**判据要盯"容器"**。

/** 配方指纹：**由"孩子"决定**的页（大类页 / 项目页 / 入口页）拿它当 `srcHash`。
 *  为什么不能用"这一页自己的正文"：正文里写着生成时间，自己 hash 自己会**每次都变** →
 *  永远显示"过期"。用孩子的指纹当身份，源一变就会顺着树往上冒泡到入口页。 */
function recipeOf(list) { return sha16(list.map(function (x) { return x.rel + '|' + x.srcHash }).join('\n')) }

/** 五张大类页（**顺序就是入口页里的顺序**）。`dir` = 从 items 里挑孩子的判据（按 rel 前缀）。 */
const GROUPS = [
  { rel: '01-常驻.md', dir: '01-常驻/', title: '① 注入层',
    note: '每轮都塞进提示的那几份 —— 改它们等于改我每轮看到的东西。' },
  { rel: '02-索引.md', dir: '02-索引/', title: '② 索引层',
    note: '"有没有、在哪、到哪了" —— 细节一律去档案。' },
  { rel: '03-项目.md', dir: '03-项目/', title: '③ 项目',
    note: '一个项目一张页：**台账＝当前状态，档案＝细节全文**。' },
  { rel: '04-分区.md', dir: '04-分区/', title: '④ Vault 分区',
    note: '切块后的块，已按节合并（同一节的连续块合并、接缝重复已去掉）。' },
  { rel: '05-知识库.md', dir: '05-知识库/', title: '⑤ 知识库',
    note: '★**这里不是副本** —— 点进去编辑的就是 `knowledge/` 下的源文件★（其余几页都是只读副本）。' },
]

/** 一张大类页 / 项目页的正文：**只链它自己的孩子** + 一行回上层 */
function buildSectionPage(o) {
  const L = []
  L.push('# 记忆视图 · ' + o.title, '')
  L.push('> **这一页是什么**：' + o.note)
  L.push('> **往上**：[[' + o.parentRel + '|← ' + o.parentLabel + ']]　（本页**只**链它自己的孩子；' +
    '入口页也只链五张大类 —— 整棵树逐层往下，不再平铺）')
  L.push('> **生成时间**：**' + stamp() + '**（CLI 同步 / **DSH 启动时那次插件侧同步**都会重建它）')
  for (const l of (o.lines || [])) L.push('> ' + l)
  if (o.readonly !== false) L.push('> **别改这里**：本页链出去的都是**只读副本**，改源文件才作数（源路径写在每份文件第一行）。')
  L.push('')
  if (o.kids.length === 0) L.push('- ' + (o.empty || '（还没有内容）'))
  else for (const k of o.kids) L.push('- [[' + k.rel + '|' + k.label + ']]' + (k.note ? '　—— ' + k.note : ''))
  L.push('', '---', '')
  L.push('本页由 `lib/build-view.mjs` 生成（**别手改**）。刷新：`node memory/tools/resync_vault.mjs`')
  return L.join('\n') + '\n'
}

/** 入口页：**只链 01–05 五张大类**（B5 之前它把 30 多条链接全平铺在这一页） */
function buildEntry(items, root) {
  const L = []
  L.push('# 记忆视图 · 入口', '')
  L.push('> **这是什么**：把「懂你记忆系统」摊成人眼能翻的一页页 —— 注入层、索引、各项目台账/档案、Vault 分区块。')
  L.push('> **怎么用**：用 Obsidian（或任何编辑器）打开**本文件夹**，从下面**五张大类页**往下翻 —— ' +
    '本页**只链这五张**，每张页再链它自己的孩子。`Ctrl+O` 全局搜。')
  L.push('> **生成时间**：**' + stamp() + '**（CLI 同步 / **DSH 启动时那次插件侧同步**都会重建它）')
  L.push('> **发现内容旧了**：跑 `node memory/tools/resync_vault.mjs`，或 `node memory/tools/build_view.mjs`。')
  L.push('> **别改这里**：本目录全是**只读副本**，改源文件才作数（源路径写在每份文件第一行）。', '')
  L.push('## 五张大类页（往下逐层翻）', '')
  const nProj = items.filter(function (x) { return /^03-项目\/[^/]+\/00-索引\.md$/.test(x.rel) }).length
  const kb = knowledgeText(root)
  for (const g of GROUPS) {
    const n = g.dir === '03-项目/' ? nProj
      : (g.dir === '05-知识库/' ? (kb ? kb.list.length : 0)
        : items.filter(function (x) { return x.rel.indexOf(g.dir) === 0 }).length)
    L.push('- [[' + g.rel + '|' + g.title + ']]　—— ' + n + (g.dir === '03-项目/' ? ' 个项目' : ' 份'))
  }
  L.push('', '---', '')
  L.push('本页由 `lib/build-view.mjs` 生成（**别手改**）。刷新：')
  L.push('```')
  L.push('node memory/tools/resync_vault.mjs       # 重建 Vault 索引 + 顺手刷新本视图')
  L.push('node memory/tools/build_view.mjs --check # 只核对：副本过期/缺失/被手改 → 退出码 1')
  L.push('```')
  return L.join('\n') + '\n'
}

/** ★所有条目的**唯一**组装处★（`buildView` 与 `checkView` 共用）。
 *  以前两边各拼一遍条目表 —— 那是"同一件事两份实现"的标准配方（本项目为它付过代价：
 *  切块器 CLI 与 boot 各切一套、还不报错）。现在只有这一份，谁改都在同一处。
 *  返回 `{ items, partitions }`，**`items[0]` 恒为入口页**（`checkView` 靠这个约定算配方指纹）。 */
async function collectAll(o) {
  const root = o.root
  const memDir = o.memDir
  const items = collect({ root: root, memDir: memDir })   // ① 常驻 ② 索引 ③ 各项目台账/档案

  // ④ Vault 分区块（每个分区一份，按节合并）
  const partitions = []
  // ★2026-09-16★ **全新机器上还没有 vault.db**（库是后面才建的，初始化向导跑到这步时它就还没建）——
  //   以前这里无条件 `readOnly` 打开 → `unable to open database file` → **整个视图生成失败**，
  //   于是"一键初始化"的最后一步（记忆视图那行）在新机器上**永远变不成 ✓**。
  //   自测夹具当场抓到（把 HOME 指到空目录就跑出来了）。
  //   → 没有库 = 分区块为 0，其余（常驻 / 索引 / 各项目台账档案）照样生成。
  const dbFile = join(memDir, 'vault.db')
  if (existsSync(dbFile)) {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const rows = db.prepare('SELECT namespace, COUNT(*) c FROM memos GROUP BY namespace ORDER BY namespace').all()
      for (const p of rows) {
        const blocks = db.prepare('SELECT content FROM memos WHERE namespace = ? ORDER BY id').all(p.namespace)
          .map(function (r) { return String(r.content) })
        const r = renderPartition(p.namespace, blocks)
        items.push({
          rel: '04-分区/' + safeName(p.namespace) + '.md', src: 'vault.db#' + p.namespace,
          srcHash: sha16(blocks.join('\u0000')), body: r.text, title: '分区 ' + p.namespace,
          blocks: blocks.length, sections: r.sections,
        })
        partitions.push({ ns: p.namespace, blocks: blocks.length, sections: r.sections })
      }
    } finally { db.close() }
  }

  // ⑤ 项目页（树的第三层）：每个项目一张 `03-项目/<项目>/00-索引.md`，链该项目的台账/档案
  const projs = []
  for (const it of items) {
    const m = /^03-项目\/([^/]+)\//.exec(it.rel)
    if (m && projs.indexOf(m[1]) < 0) projs.push(m[1])
  }
  for (const proj of projs.sort()) {
    const kids = items.filter(function (x) { return x.rel.indexOf('03-项目/' + proj + '/') === 0 })
      .map(function (x) {
        const base = x.rel.slice(x.rel.lastIndexOf('/') + 1).replace(/\.md$/, '')
        return { rel: x.rel, label: base, note: base === '台账' ? '当前状态' : '细节全文', srcHash: x.srcHash, title: x.title }
      })
    items.push({
      rel: '03-项目/' + proj + '/00-索引.md',
      src: '（本工具生成：这个项目两份副本的配方指纹）',
      title: '项目 ' + proj + ' 索引', recipe: true, srcHash: recipeOf(kids),
      body: buildSectionPage({
        title: '项目 ' + proj, parentRel: '03-项目.md', parentLabel: '③ 项目',
        note: '`' + proj + '/` 这个项目的两份东西 —— **台账＝当前状态，档案＝细节全文**。',
        kids: kids,
      }),
    })
  }

  // ⑥ 五张大类页（树的第二层）—— ★入口只链它们★
  const kb = knowledgeText(root)
  for (const g of GROUPS) {
    let kids = []
    if (g.dir === '05-知识库/') {
      // ★知识库那侧是 junction（指向 `<工作区>/knowledge/`）—— **源就是它本身**，没有副本可对指纹；
      //   身份只能取"文件清单"，所以**内容改了不会让它变红**（它本来就不需要"新鲜度"这个概念）。
      //   ⚠️ 不在这里再建一层：junction 里面是**用户的东西**，我们一个字节都不写。
      kids = (kb ? kb.list : []).map(function (rel) {
        return { rel: rel.replace(/^knowledge\//, '05-知识库/'), label: rel.replace(/^knowledge\//, ''), srcHash: sha16(rel) }
      })
    } else if (g.dir === '03-项目/') {
      kids = items.filter(function (x) { return /^03-项目\/[^/]+\/00-索引\.md$/.test(x.rel) })
        .map(function (x) { return { rel: x.rel, label: x.rel.split('/')[1], srcHash: x.srcHash } })
    } else {
      kids = items.filter(function (x) { return x.rel.indexOf(g.dir) === 0 })
        .map(function (x) {
          if (g.dir === '04-分区/') {
            return { rel: x.rel, label: x.src.replace('vault.db#', ''), note: x.blocks + ' 块 → ' + x.sections + ' 节', srcHash: x.srcHash }
          }
          return { rel: x.rel, label: x.title, srcHash: x.srcHash }
        })
    }
    items.push({
      rel: g.rel, src: '（本工具生成：它孩子的配方指纹）', title: g.title, recipe: true,
      srcHash: recipeOf(kids),
      body: buildSectionPage({
        title: g.title, parentRel: '00-入口.md', parentLabel: '记忆视图 · 入口', note: g.note, kids: kids,
        readonly: g.dir !== '05-知识库/',
        lines: g.dir === '05-知识库/'
          ? ['源目录 `knowledge/`：能力清单与资料都在这儿。**我检索时也查这个分区（`知识`）。**',
            '★这一页**没有副本可核对**（链进去就是源文件本身），所以 `--check` 不管它的"新鲜度"。',
            '★**不在它里面再生一层索引**：junction 里是用户自己的东西，本工具一个字节都不写★']
          : null,
        empty: g.dir === '05-知识库/' ? '（还没有内容：把资料丢进 `knowledge/` 就会出现在这里）' : null,
      }),
    })
  }

  // ⑦ 入口页（最后 unshift：`items[0]` 恒为它，配方指纹覆盖**其余全部条目**）
  items.unshift({
    rel: '00-入口.md', src: '（本工具生成：其它条目的配方指纹）',
    srcHash: recipeOf(items), body: buildEntry(items, root), title: '入口', recipe: true,
  })
  return { items: items, partitions: partitions }
}

const withStamp = function (it) {
  return '<!-- 记忆视图 · 只读副本｜生成于 ' + stamp() + '｜源 ' + it.src + '｜源指纹 ' + it.srcHash +
    '｜块数 ' + (it.blocks === undefined ? '-' : it.blocks) + ' —— 别改这里，改源文件后重跑同步 -->\n' + it.body
}

function buildStatus(items) {
  const L = ['# 记忆视图 · 状态账本（' + MARK + '）', '',
    '> 本文件是 `build_view --check` / 插件校验的账本：**每份副本的源指纹 + 正文指纹**。对不上就是过期了。',
    '> `源指纹` = 源文件现在的内容 ｜ `正文指纹` = 视图文件去掉首行标记后的正文（用来抓"**副本被人手改**"）。', '',
    '| 文件 | 源 | 源指纹 | 正文指纹 | 块数 |', '|---|---|---|---|---|']
  for (const it of items) {
    L.push('| `' + it.rel + '` | `' + it.src + '` | `' + it.srcHash + '` | `' +
      (it.recipe ? '-' : sha16(it.body)) + '` | ' + (it.blocks === undefined ? '-' : it.blocks) + ' |')
  }
  L.push('', '生成时间：' + stamp(), '')
  return L.join('\n') + '\n'
}

/** 只清我们自己的东西（`.obsidian/` 与用户自己放的文件一概不动） */
function cleanOwn(out, oldStatus) {
  const mine = new Set(OURS_TOP)
  const removed = []
  for (const m of oldStatus.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) {
    const rel = m[1]
    const abs = resolve(join(out, rel))
    if (!abs.startsWith(out + sep)) continue
    if (existsSync(abs)) { rmSync(abs, { force: true }); removed.push(rel) }
    mine.add(rel.split('/')[0])
  }
  for (const name of mine) {
    const abs = join(out, name)
    if (existsSync(abs)) { rmSync(abs, { recursive: true, force: true }); removed.push(name) }
  }
  return removed
}

/** ★生成视图（插件与 CLI 共用）★
 *  `o = { root, memDir, out?, dryRun?, log? }` → `{ ok, out, files, bytes, blocks, sections, removed, error? }` */
export async function buildView(o) {
  const log = o.log || function () {}
  const root = o.root
  const memDir = o.memDir
  const out = resolve(o.out || join(root, 'memory', '记忆视图'))
  try {
    // ★条目表只有一份实现（`collectAll`）★ —— `buildView` 与 `checkView` 共用，
    //   免得"生成时一套、核对时另一套"（本项目为这种漂移付过代价：切块器 CLI/已装两套）。
    const { items, partitions } = await collectAll({ root: root, memDir: memDir })
    const blocks = partitions.reduce(function (a, b) { return a + b.blocks }, 0)
    const sections = partitions.reduce(function (a, b) { return a + b.sections }, 0)
    const cntDir = function (d) { return items.filter(function (x) { return x.rel.indexOf(d) === 0 }).length }
    const byGroup = {
      常驻: cntDir('01-常驻/'), 索引: cntDir('02-索引/'), 项目: cntDir('03-项目/'), 分区: cntDir('04-分区/'),
    }
    if (o.dryRun) {
      return { ok: true, out: out, dry: true, files: items.length, blocks: blocks, sections: sections, partitions: partitions.length, byGroup: byGroup }
    }
    assertSafeOut(out, root, memDir)
    const oldStatus = existsSync(out) ? (read(join(out, '_状态.md')) || '') : ''
    mkdirSync(out, { recursive: true })
    const removed = cleanOwn(out, oldStatus)
    let bytes = 0
    for (const it of items) {
      const abs = resolve(join(out, it.rel))
      if (!abs.startsWith(out + sep)) throw new Error('拒绝写出视图目录之外：' + abs)
      mkdirSync(dirname(abs), { recursive: true })
      const text = withStamp(it)
      writeFileSync(abs, text, 'utf8')
      bytes += Buffer.byteLength(text, 'utf8')
    }
    writeFileSync(join(out, '_状态.md'), buildStatus(items), 'utf8')
    return { ok: true, out: out, files: items.length, bytes: bytes, blocks: blocks, sections: sections,
      partitions: partitions.length, removed: removed.length, byGroup: byGroup }
  } catch (e) {
    return { ok: false, out: out, error: String((e && e.message) || e) }
  }
}

/** 核对新鲜度：源变过 / 文件缺失 / 副本被手改 / 多余文件 → `{ ok, out, bad: [] }`
 *
 *  ★2026-09-15 起它也走 `collectAll`★：以前它自己又拼一遍条目表 + 又算一遍入口页配方指纹 ——
 *    "同一件事两份实现"的典型（谁改了生成侧忘了改核对侧，就会**永远报过期**或**永远报新鲜**）。
 *    现在配方类条目（入口页/大类页/项目页）的 `srcHash` 由 `collectAll` 直接给出，这里只做比对。 */
export async function checkView(o) {
  const root = o.root
  const memDir = o.memDir
  const out = resolve(o.out || join(root, 'memory', '记忆视图'))
  const status = read(join(out, '_状态.md'))
  if (status === null) return { ok: false, out: out, bad: ['视图还没生成过（没有 _状态.md）'] }
  const { items } = await collectAll({ root: root, memDir: memDir })

  const recorded = new Map()
  for (const m of status.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]+)`\s*\|\s*`([0-9a-f]+|-)\`?\s*\|/gm)) {
    recorded.set(m[1], { src: m[2], hash: m[3], body: m[4] })
  }
  const bad = []
  for (const it of items) {
    const rec = recorded.get(it.rel)
    if (!rec) { bad.push(it.rel + '：账本里没有它（视图多半是旧版生成的）'); continue }
    if (rec.hash !== it.srcHash) bad.push(it.rel + '：**源变过了**（账本 ' + rec.hash + ' → 现在 ' + it.srcHash + '）')
    const abs = join(out, it.rel)
    if (!existsSync(abs)) { bad.push(it.rel + '：文件不在了'); continue }
    // 配方类条目（入口页/大类页/项目页）正文带生成时间，**不比正文**（账本里那格写的是 `-`）
    if (rec.body !== '-' && !it.recipe) {
      const now = read(abs)
      const got = now === null ? null : sha16(now.split('\n').slice(1).join('\n'))
      if (got !== rec.body) bad.push(it.rel + '：**副本被改过**（不是生成出来的那一份，正文指纹对不上）')
    }
  }
  for (const rel of recorded.keys()) {
    if (!items.some(function (x) { return x.rel === rel })) bad.push(rel + '：账本里有、现在不该再有（多余文件）')
  }
  return { ok: bad.length === 0, out: out, recorded: recorded.size, expected: items.length, bad: bad }
}
