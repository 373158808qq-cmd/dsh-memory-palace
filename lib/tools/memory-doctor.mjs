// ★2026-09-16 从 `<工作区>/memory/tools/memory_doctor.mjs` **原样搬进来**★
//   为什么搬：这些维护工具原来只住在**本项目的 `memory/tools/`**里 —— 朋友装了插件却没有那个目录，
//   等于"体检 / 备份 / 裁决台账 / 分层纪律 / 预算 / 能力清单"这些维护能力只在我这台机器上存在。
//   搬进来之后：**插件里是唯一实现**，项目那边的同名文件只剩一行薄壳。
//   根目录/记忆库：仍然认 `--root` / `--memdir`；没给时靠自己的"往上找"（在插件里够不到工作区，
//   所以**调它的一方要传 --root** —— maintain-cli 与设置页路由都会传）。

// 记忆体检器 v2（memory_doctor）—— **只读**，不改任何文件、不写任何库。
//
// 它是「⑤ 校验层」的第一层：机械体检（零模型、零外发、秒级）。
// 设计依据（都在项目档案里）：
//   · V8 ⑤ 的定义 = "把'准'变成可量化"：冲突 / 过期 / 抽查 / 纠错。
//   · 选型结论（V8 L52/L180）：参照 Semantica 的"冲突先标后裁 + 时态快照"；探针未过 → 纯自研。
//   · ★核心口径★：**"提到已退役的东西" ≠ "过时"**。
//       正确的历史叙述（"某某服务已停用、绝不回退"）**不该报**；
//       "把已经失效的东西写成现状"（"音色 = 那两个权重文件"）**才该报**。
//     两条判据一起用：
//       ① 行内有没有"退役标记词"（已停用/已弃用/换成…）——有 = 正确的历史叙述，跳过
//       ② 这句话在"历史区"还是"现状区"（档案里 `### 日期 …` 条目 = 历史区）
//
// ★v2 改了什么（v1 第一跑暴露的问题 → 逐条治）★
//   1. **C 项 22 组全是假阳性**（89 张会话卡天然相似）→ **分置信档**：≥0.85 高度疑似 / ≥0.70 疑似 /
//      ≥阈值 同主题。**只有前两档值得看**，第三档单独列、默认不计数。
//   2. **B 项精度 12.5%** → 也是分档：**高置信 = "提到退役物" 且 "同行的路径实测不存在"**（双信号）；
//      其余降为"候选"。
//   3. **新增 E 项：活文档住在"随时可删"的目录里** —— 由 2026-09-13 那处真发现推广而来
//      （`ppt` 台账把 `_trash/` 里的文件当"方法论"）。**这条是机械可证的，精度高。**
//   4. 加 `--root/--memdir/--vault` 开关 → 可以用**夹具**写回归测试（见 verify/verify_doctor.mjs）。
//
// 八项检查：
//   A 路径存在性     —— 档案/台账里写的路径，现在还在不在
//   B 退役物当现状   —— 提到已退役物、却没有退役标记词
//   C 块级高相似     —— 同一个 Vault 分区内，3-gram Jaccard（分档：真重复 vs 天然相似）
//   D 注入文件重复   —— 一句是另一句的前缀 **或与它逐字相同**（lint_layers 的 L1/D 互补：
//                        L1 只抓"逐字相同"、原 D 只抓"前缀包含"，**两边各有一个盲区**，
//                        2026-09-14 把两个盲区一次补上）
//   E 活文档住待删区 —— 引用的文件确实存在，但躺在 _trash/ .ptmp/ test/ 里
//   F 快照一致性     —— INDEX.md / VAULT_INDEX.md 这类**快照** vs 它抄的**源台账**
//                        ★这是本项目铁律的直接检测器★：「快照式索引必须有重建触发器；
//                        没有触发器的快照必然变成谎话，**而且不报错**」。
//                        2026-09-14 实测真命中：`memory/INDEX.md` 写记忆系统「阶段16–20」，
//                        而台账已到「阶段25」——**全库 6 份台账、1 份快照，从来没有任何工具
//                        核对过它们一不一致**。判据四条，全部机械可证：
//                          ① 台账有阶段编号、快照写的比它旧        → 快照落后
//                          ② 台账有阶段编号、快照一个都没写        → 快照没写进度
//                          ③ 快照行指向的台账文件不存在            → 源没了
//                          ④ 有台账、但快照里没有任何一行指向它    → 项目漏进快照
//   G 语料过期       —— 转写/会话卡是**会长大的快照**：生成之后会话还在写就成了过期快照。
//                        依据 = 阶段20 ④ 那条发现（当时发现了却没人守）。分两档：日志**刚还在动**
//                        = 会话进行中，滞后是本性、**不报**；日志已停更而转写更旧 = **该重跑**、报。
//                        另报"日志有、corpus 里没有转写"。
//
// 用法：node memory/tools/memory_doctor.mjs [--json <输出>] [--sim 0.55] [--prefix 12]
//                                          [--root <工作区>] [--memdir <记忆库>] [--vault <库文件>]
// 退出码：0 = 没有"值得看"的；1 = 有（这是**报告**，不是"坏"）
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const argOf = function (name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

// ── 定位工作区根（不写死本机路径 —— 跟其它工具同一套"找标志物"的办法）──
const HERE = dirname(fileURLToPath(import.meta.url))
function findRoot() {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'plugins', 'dsh-memory-app', 'lib', 'index.js'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}
const ROOT_ARG = argOf('--root', null)
const ROOT = ROOT_ARG !== null ? ROOT_ARG : findRoot()
const MEM = argOf('--memdir', join(homedir(), '.dsh-memory'))
const VAULT = argOf('--vault', join(MEM, 'vault.db'))
if (ROOT === null) { console.log('✗ 找不到工作区根（可用 --root 指定）'); process.exit(1) }

const SIM = parseFloat(argOf('--sim', '0.55'))
const TIER_HIGH = parseFloat(argOf('--tier-high', '0.85'))
const TIER_MID = parseFloat(argOf('--tier-mid', '0.70'))
const PREFIX_MIN = parseInt(argOf('--prefix', '12'), 10)
const SESSION_STALE_MIN = parseInt(argOf('--stale-min', '30'), 10)
const JSON_OUT = argOf('--json', null)

const SKIP = /(^|[\\/])(node_modules|\.git|pylibs|pylibs312|runtime|logs|backups|_trash|\.ptmp|\.npm-cache|\.ollama-models|产出物|dist|build|\.venv|venv)([\\/]|$)/i
/** "随时可删"的目录 —— 活文档引用它们里的东西 = 延迟爆炸（2026-09-13 那处真发现的推广） */
const TRASH_TOP = /^(?:_trash|\.ptmp|test)([\\/]|$)/i

// ── 退役物清单（每条都注明为什么算"退役"；这是本项目自己的史实，可随时增删）──
// ★出厂清单：只放"这个产品自己"的退役物★（2026-09-16 用户拍板 —— 公开仓库里不许夹私人项目的痕迹）
//   原先这里还躺着 5 条**只对作者本机成立**的史实（某个权重文件名 / 服务名 / 端口号 / STT 名词）。
//   对使用者来说那是**永远不命中的噪声**，还会暴露"作者用过哪套 TTS" → 已删。
//   ⚠️ **代价要说清**：作者本机因此也不再自动检测"把那些旧物当现状"的写法了。
const RETIRED = [
  { needle: 'embeddings.json', why: '语料索引已退役（会喂过期文本）' },
  { needle: 'archive.json', why: '档案层已退役' },
  { needle: 'vault:记忆系统', why: 'Vault 分区名已改名 memory' }
]
// ★退役标记词★：行内出现这些 = 这句话是在"说它已经退役了"（正确的历史叙述）→ 跳过
//   v1 第一跑暴露出一批误报（9 条"现状区"里 8 条是假的），根因就是这份标记词不全。
//   ⚠️ 教训写在这儿：**光靠关键词分不清"提到"和"断言"**，所以本工具的输出只能是"候选清单"，
//      必须人过一遍（这正是选型里 Semantica 的"冲突先标后裁"）。
const RETIRE_MARK = /已停用|已弃用|已退役|退役|已废|作废|已停|不再|已移除|已删除|删掉|删除|清理|已改|已换|换成|替代|改为|改用|修正|演进|升级到|过渡|曾经|原先|当时|历史|旧版|旧的|不适用|绝不回退|已禁用|教育|过时|矛盾|印证|待处置|真问题|不存在/

// ── 收集"会进 Vault / 每轮注入"的 md ──
function collect() {
  const out = { ledgers: [], archives: [], injected: [] }
  const walk = function (dir, depth) {
    if (depth > 3) return
    let items = []
    try { items = readdirSync(dir) } catch (_e) { return }
    for (const it of items) {
      const p = join(dir, it)
      // ★SKIP 必须按"相对工作区根"的路径判，不能拿绝对路径判★（夹具测试抓出来的真 bug）：
      //   夹具工作区造在 `.ptmp/` 下 → 绝对路径里含 `\.ptmp\` → **整棵树被跳过、一个文件都没扫**。
      //   按相对路径判才对：真工作区里 `voice/xxx` 不匹配，`.ptmp/xxx` 匹配 ✓。
      if (SKIP.test(relative(ROOT, p))) continue
      let st
      try { st = statSync(p) } catch (_e) { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (it === 'PROJECT_LEDGER.md') out.ledgers.push(p)
      else if (it === 'PROJECT_LEDGER_ARCHIVE.md') out.archives.push(p)
      else if (it === 'AGENTS.md' && dir === ROOT) out.injected.push(p)
      else if (it === 'VAULT_INDEX.md' || it === 'INDEX.md') out.injected.push(p)
    }
  }
  walk(ROOT, 0)
  for (const f of ['USER.md', 'MEMORY.md', 'SOP.md']) {
    const p = join(MEM, f)
    if (existsSync(p)) out.injected.push(p)
  }
  return out
}

/** 这一行属于"历史区"还是"现状区"？
 *  规则：① `##` 大节定基调（标题带日期、或叫「修复记录/实测记录/…」→ 历史区）
 *        ② `###`/`####` 子标题**继承父节**，除非它自己另有说法
 *  ★这个继承是必须的，v2 之前漏了★：档案里 `## 二、修复记录 / 实测记录` 下面挂着一堆
 *    **不带日期的 `####` 子标题**（如「#### voice 的 5 份问题文档…」），原来一到子标题就把
 *    hist 重置成 false → 那些内容全被判成"现状区"，于是**体检器开始报我自己的体检报告**
 *    （回音室：审计记录描述问题 → 审计器把审计记录当问题）。 */
function classify(text) {
  const lines = text.split('\n')
  const out = []
  let h2 = false          // 大节基调
  let h3 = null          // 子标题（null = 没说过，继承父节）
  let inFence = false
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) inFence = !inFence
    if (!inFence && /^#{2,4}\s/.test(raw)) {
      const own = /20\d\d-\d\d-\d\d/.test(raw) || /修复记录|实测记录|变更记录|流水/.test(raw)
      if (/^##\s/.test(raw) && !/^###/.test(raw)) { h2 = own; h3 = null }
      else { h3 = (own || h2) }
    }
    out.push({ line: raw, hist: (h3 === null ? h2 : h3) })
  }
  return out
}

// ── 路径引用抽取（A 和 E 共用一份，免得两处正则走偏）──────────────────
const ABS_RE = /[A-Za-z]:\\[^\s`"'（）()「」【】，。；、|]+/g
// ★相对路径不许写死本工作区的目录名★（夹具测试抓出来的普适性 bug）：
//   原来写的是 `(?:memory|voice|ppt|upload|...)` 的固定清单 → **换个人用、或新建一个项目目录，
//   A 项就认不出路径了**，等于悄悄失效。现在改成：**任何 `a/b` 形状的相对路径都认**，
//   靠"前面那个字符不能是 `:` 或 `/`"把 URL（`http://x/y`、`127.0.0.1:11434/api/tags`）挡掉。
const REL_RE = /(^|[\s`（(【「"'\[<])((?:[\w.\-\u4e00-\u9fff]+\/)+[\w.\-\u4e00-\u9fff]*\/?)/g
const TRIM_TAIL = /[.,;:!?、。，；：！？）)】」]+$/
const isTemplate = function (s) { return /[<>*…]/.test(s) || /\{|\}/.test(s) }
const MEM_SELF = /^[A-Za-z]:\\Users\\[^\\]+\\\.dsh-memory/i

/** 把一行切成"**以命中点为中心**"的窗口 —— 而不是从头 `slice(0,96)`。
 *  ★2026-09-14 我裁决时亲自踩到★：B 项报 `MEMORY.md` 那条，输出里只有
 *  「- Ollama 已装（本地嵌入 qwen3-embedding:0.6b，595M）。**生命周期…」，而 needle
 *  「某个服务名」在**第 200 多字符处** —— **输出里根本看不到命中点**，只能另外去 grep 才敢裁。
 *  ★裁决是 ⑤ 的核心动作，看不清命中点 = 降低裁决质量★（而且容易把人逼成"凭印象裁"）。 */
function windowAround(raw, at, width) {
  if (raw.length <= width) return raw.trim()
  let start = Math.max(0, at - Math.floor(width * 0.35))
  let end = Math.min(raw.length, start + width)
  if (end === raw.length) start = Math.max(0, end - width)
  return (start > 0 ? '…' : '') + raw.slice(start, end).trim() + (end < raw.length ? '…' : '')
}

function norm(p) { return p.replace(TRIM_TAIL, '').replace(/\//g, '\\') }

/** "它像一条路径吗？"—— 泛化 REL_RE 之后必须补这一层，否则 `read/write/edit` 这种
 *  普通斜杠词组会被当成路径（夹具测试当场抓到：A 项报了 `read\write\edit` 不存在）。
 *
 *  ★这里踩过一个大坑，写下来别重蹈★：我一度把 REL_RE 放成"任何 `a/b` 形状"就想当然，
 *    结果 A 项从 2 条炸到 **87 条**（34 条"值得看"）—— 全是误报。根因是**"相对谁"的歧义**：
 *      · `impressions/` 是相对**记忆库**（`~/.dsh-memory/`）的
 *      · `verify/run_all.mjs` 是相对 **`memory/tools/`** 的
 *      · `backups/desktop_bats_*` 根本不是路径，是 **glob 通配符**
 *    正解有两条闸：
 *      ① **能对上一个"已知根"才算**（第一段在 ROOT 或 MEM 下真存在）——
 *         `impressions` 对上 MEM ✓、`verify` 两个根都没有 → **不报**（宁可不报，也不误报）
 *      ② **后面紧跟 `*` 的算 glob，跳过**
 *    代价（诚实记账）：**引用了一个"整个不存在的顶层目录"的路径会漏报** —— 接受。 */
function resolveRel(p) {
  const s = p.replace(/\\/g, '/')
  const first = s.split('/')[0]
  if (first === '' || first === '.' || first === '..') return null
  if (existsSync(join(ROOT, first))) return join(ROOT, p)
  if (existsSync(join(MEM, first))) return join(MEM, p)
  return null
}

function pathRefs(files) {
  const out = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const c of classify(text)) {
      const line = c.line
      // ★这里原来有一句 `if (isTemplate(line)) continue` —— **是个严重漏报 bug，v2 才抓到**★
      //   因为 isTemplate 把 `*` 当模板标记，而 markdown 的**加粗**就是 `*` →
      //   **一句里只要有加粗，整行就被跳过**，A 项等于半瞎（实测：voice 里两条不存在的
      //   形如「盘符:\\某目录\\...」的绝对路径全被漏掉，只剩没加粗的那一行报出来）。
      //   正解：**只对"抽出来的那个路径片段"判模板**（下面 `isTemplate(p)`），不对整行判。
      const cands = []
      let m
      ABS_RE.lastIndex = 0
      while ((m = ABS_RE.exec(line)) !== null) cands.push({ raw: m[0], kind: 'abs', start: m.index, end: m.index + m[0].length })
      REL_RE.lastIndex = 0
      // ⚠️ `start` 要**在这儿记下来**：循环结束后 `m` 已经是 null（下面那版就是拿 `m.index` 用完炸的）。
      //    REL 的 `m[0]` 含前面那个界定字符，路径从 `m[1].length` 之后开始。
      while ((m = REL_RE.exec(line)) !== null) cands.push({ raw: m[2], kind: 'rel', start: m.index + m[1].length, end: m.index + m[0].length })
      for (const cd of cands) {
        // glob／占位符都不是路径：`backups/xxx_*`（星号）、`index.js.bak_before_{a,b}`（花括号展开）、
        //   `backups/godot-tetris-<日期>/`（**尖括号占位** —— 2026-09-15 真事：这条被报成"路径不存在"）
        if (line[cd.end] === '*' || line[cd.end] === '{' || line[cd.end] === '<') continue
        // ★路径里带空格★ —— `ABS_RE`/`REL_RE` 遇到空白就停了，于是
        //   `C:\…\app_userdata\Simple Tetris\logs\` 被截成 `C:\…\Simple` → 实测不存在 → **A 项误报**
        //   （2026-09-15 真事：godot-tetris 台账那条，目录其实好端端在着）。
        //   ★为什么不干脆把正则里的空白去掉★：散文里 `见 E:\x\y 这个文件` 会把「这个文件」也吞进路径，
        //   **又造出一批误报** ——"允许空格"必须以**存在性**为准，不能凭正则贪心。
        //   做法：先按原样；它不存在就往右**逐字长回去**（从长到短），取**第一个真实存在的**；
        //        都长不回来 → 保持原样照旧报（宁可报"截断的那半截"，也不放过真丢了的路径）。
        const alts = [norm(cd.raw)]
        if (cd.end < line.length && /\s/.test(line[cd.end])) {
          let cut = cd.end
          while (cut < line.length && !/[`"'（）()「」【】，。；、|<>*{}]/.test(line[cut])) cut++
          // ★只"往右长到定界符"这一个版本，**不做逐字回退的一串中间版本**★
          //   中间版本会把**真丢了的文件救回来**：`…\有 空格\gone-here\missing.md` 里
          //   `…\有 空格` 本身是个**存在的目录** → 判"存在" → **A 项漏报**。
          //   ★这是夹具当场抓到的★（我第一版就是逐字回退，40 条断言里那条"合计 17"没红、
          //   但新加的正例没被报出来 → 等于把误报换成了漏报，两头都不许）。
          const grown = norm(line.slice(cd.start, cut))
          if (grown.length > alts[0].length) alts.push(grown)
        }
        let p = null, full = null, exists = false, best = null
        for (const a of alts) {
          if (isTemplate(a)) continue
          if (cd.kind === 'abs' && MEM_SELF.test(a)) continue      // 记忆库自身
          const t = cd.kind === 'abs' ? a : resolveRel(a)          // 对不上任何已知根 → 不当路径
          if (t === null) continue
          if (best === null || a.length > best.a.length) best = { a: a, t: t }  // 报就报**信息最全**的那个
          if (existsSync(t)) { p = a; full = t; exists = true; break }
        }
        if (best === null) continue
        if (p === null) { p = best.a; full = best.t; exists = false }   // 一个都不存在 → 照旧报（不放过）
        const rel = full.indexOf(ROOT) === 0 ? relative(ROOT, full) : p
        out.push({
          file: relative(ROOT, f),
          path: p,
          full: full,
          rel: rel,
          exists: exists,
          zone: c.hist ? '历史区' : '现状区',
          retiredSay: RETIRE_MARK.test(line),
          // ★`line`（给人看，带窗口）与 `lineKey`（当身份，稳定）**必须分开**★
          //   原因：B 的"高置信"档靠"A 和 B 报的是同一行"配对，而 `findings.mjs` 拿 `line` 当指纹种子。
          //   2026-09-14 我把 `line` 改成窗口后，**配对悄悄失效**（某条 needle 从「高」掉回「候选」）
          //   —— 显示格式一动、身份就漂，这是"拿给人看的文本当主键"的经典后果。
          //   `lineKey` = 老的 `line.trim().slice(0,96)`：**切回来以后指纹与历史一一对上**，裁决档案不会被打散。
          lineKey: line.trim().slice(0, 96),
          line: windowAround(line, cd.start + Math.floor(cd.raw.length / 2), 96)
        })
      }
    }
  }
  return out
}

// ── C 块级高相似（同一 namespace 内）────────────────────────────────
function gramsOf(s, n) {
  const g = new Set()
  const t = String(s).replace(/\s+/g, '')
  for (let i = 0; i + n <= t.length; i++) g.add(t.slice(i, i + n))
  return g
}
function jac(a, b) {
  const small = a.size < b.size ? a : b
  const big = a.size < b.size ? b : a
  let inter = 0
  for (const g of small) if (big.has(g)) inter++
  const uni = a.size + b.size - inter
  return uni === 0 ? 0 : inter / uni
}
/** 两块"像"在哪 —— 取共同起始段（帮人一眼判断"是不是同一件事"） */
function sharedHead(a, b) {
  const x = String(a).replace(/\s+/g, '')
  const y = String(b).replace(/\s+/g, '')
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i
}
async function checkSimilar() {
  let db = null
  try {
    const { DatabaseSync } = await import('node:sqlite')   // ESM：必须 await import，没有 require
    db = new DatabaseSync(VAULT, { readOnly: true })
  } catch (_e) {
    return { error: '读不到 Vault（跳过 C）：' + ((_e && _e.message) || _e) }
  }
  const rows = db.prepare('SELECT id, namespace, content FROM memos').all()
  db.close()
  const byNs = new Map()
  for (const r of rows) {
    const ns = String(r.namespace)
    if (!byNs.has(ns)) byNs.set(ns, [])
    byNs.get(ns).push({ id: Number(r.id), text: String(r.content), len: String(r.content).replace(/\s+/g, '').length })
  }
  const high = [], mid = [], low = []
  let scannedNs = 0
  for (const [ns, list] of byNs) {
    scannedNs++
    const withG = list.map(function (x) { return Object.assign({}, x, { g: gramsOf(x.text, 3) }) })
    for (let i = 0; i < withG.length; i++) {
      for (let j = i + 1; j < withG.length; j++) {
        const a = withG[i], b = withG[j]
        const ratio = a.len > b.len ? a.len / Math.max(1, b.len) : b.len / Math.max(1, a.len)
        if (ratio > 2.2) continue                     // 长度差太大，不可能是同一件事
        const s = jac(a.g, b.g)
        if (s < SIM) continue
        const rec = {
          ns: ns, a: a.id, b: b.id, sim: Number(s.toFixed(3)),
          sharedHead: sharedHead(a.text, b.text),
          head: a.text.replace(/\s+/g, ' ').slice(0, 60),
          headB: b.text.replace(/\s+/g, ' ').slice(0, 60)     // 给裁决台账做"稳定指纹"用（块 id 会变，内容不会）
        }
        if (s >= TIER_HIGH) high.push(rec)
        else if (s >= TIER_MID) mid.push(rec)
        else low.push(rec)
      }
    }
  }
  const bySim = function (x, y) { return y.sim - x.sim }
  high.sort(bySim); mid.sort(bySim); low.sort(bySim)
  return { high: high, mid: mid, low: low, scanned: rows.length, nsCount: scannedNs }
}

// ── D 注入文件重复（一句是另一句的前缀 **或与它逐字相同**）──────────
// ★2026-09-14 补第二个盲区★：原来这里写着 `if (a.k.length >= b.k.length) continue` ——
//   本意是"只报短的⊆长的、避免报两遍"，副作用是**逐字相同的一对永远进不来**
//   （长度相等 → 被 continue 掉）。而 `lint_layers` 的 L1 恰好相反：只抓逐字相同、
//   抓不到前缀包含。**两个工具各瞎一半，而且都不报错。** 现在 D 一次覆盖两种。
function normLine(raw) {
  const l = raw.trim()
  if (l === '') return null
  if (l.startsWith('#') || l.startsWith('---') || l.startsWith('|') || l.startsWith('>')) return null
  return l.replace(/\s+/g, ' ').replace(/^[-*+]\s*/, '').toLowerCase()
}
function checkPrefixDup(files) {
  const all = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    let inFence = false
    text.split('\n').forEach(function (raw, i) {
      if (raw.trim().startsWith('```')) { inFence = !inFence; return }
      if (inFence) return
      const k = normLine(raw)
      if (k === null || k.length < PREFIX_MIN) return
      const isMemFile = dirname(f) === MEM
      all.push({ label: isMemFile ? f.split(/[\\/]/).pop() : relative(ROOT, f), k: k, line: i + 1, raw: raw.trim() })
    })
  }
  const hits = []
  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue
      const a = all[i], b = all[j]
      if (a.label === b.label && a.line === b.line) continue
      // ① 逐字相同（原来这个分支根本到不了 —— 见上面那段注释）
      if (a.k === b.k) {
        if (i < j) hits.push({ kind: 'same', shortFile: a.label, shortLine: a.line, longFile: b.label, longLine: b.line, prefix: a.k.slice(0, 70), shortRaw: a.raw.slice(0, 80) })
        continue
      }
      // ② 前缀包含（只报"短的 是 长的 的前缀"，避免报两遍）
      if (a.k.length >= b.k.length) continue
      if (!b.k.startsWith(a.k)) continue
      hits.push({ kind: 'prefix', shortFile: a.label, shortLine: a.line, longFile: b.label, longLine: b.line, prefix: a.k.slice(0, 70), shortRaw: a.raw.slice(0, 80) })
    }
  }
  return hits
}

// ── F 快照一致性（快照文件 vs 它抄的源台账）────────────────────────────
// 铁律的直接检测器：「快照式索引必须有重建触发器；没有触发器的快照必然变成谎话，而且不报错。」
// ★通用写法★：不写死"快照一定是 INDEX.md"这种东西在哪 —— 改成"**名字叫 INDEX.md /
//   VAULT_INDEX.md 的就是快照**"，且"**哪一行抄了哪个台账**"从行里的 `.../PROJECT_LEDGER.md`
//   反推（不靠"显示名↔文件夹名"的人工映射 —— 那种映射没人维护，实测第一版就是被它坑的：
//   INDEX.md 写的是"**记忆系统**"，文件夹叫 `memory`，按文件夹名去匹配**一行都匹配不上**）。
const SNAP_RE = /^(INDEX|VAULT_INDEX)\.md$/i
// ★允许数字之间/周围夹 markdown 强调★ —— 2026-09-14 真数据复现的 bug：
//   台账里写「阶段16–**26**」（把新区间加粗）时，`**` 把"区间"从中间切断 →
//   旧正则只认出 `阶段16` → **误报"快照落后 10 个阶段"**。所以两头都要能吃下 `**`/`*`/`_`/`` ` ``。
const EMPH = '[*_`]*'
const STAGE_RANGE_RE = new RegExp('阶段\\s*' + EMPH + '\\s*(\\d+)\\s*' + EMPH + '\\s*(?:[–\\-~—]|到|至)\\s*' + EMPH + '\\s*(\\d+)', 'g')
const STAGE_ONE_RE = new RegExp('阶段\\s*' + EMPH + '\\s*(\\d+)(?!\\s*' + EMPH + '\\s*(?:[–\\-~—]|到|至)\\s*' + EMPH + '\\s*\\d)', 'g')
const LEDGER_IN_LINE_RE = /([\w.\-\u4e00-\u9fff]+[\\/][^\s`|「」（）()]*PROJECT_LEDGER\.md)/g
const FULL_DATE_RE = /20\d\d-\d\d-\d\d/g

function stagesIn(text) {
  const out = []
  let m
  STAGE_RANGE_RE.lastIndex = 0
  while ((m = STAGE_RANGE_RE.exec(text)) !== null) out.push([Number(m[1]), Number(m[2])])
  STAGE_ONE_RE.lastIndex = 0
  while ((m = STAGE_ONE_RE.exec(text)) !== null) out.push([Number(m[1]), Number(m[1])])
  return out
}
const maxStage = function (r) { return r.length === 0 ? null : Math.max.apply(null, r.map(function (x) { return x[1] })) }
const lateDate = function (t) { const d = t.match(FULL_DATE_RE); return (d === null || d.length === 0) ? null : d.slice().sort().pop() }

function checkSnapshot(allFiles, ledgerFiles) {
  const snaps = allFiles.filter(function (f) { return SNAP_RE.test(f.split(/[\\/]/).pop()) })
  if (snaps.length === 0) return { skipped: '工作区里没有 INDEX.md / VAULT_INDEX.md 快照文件，这一项没跑' }
  const hits = []
  const seen = new Set()
  for (const s of snaps) {
    const relS = relative(ROOT, s)
    const text = readFileSync(s, 'utf8')
    const lines = text.split('\n')
    // ★判据② 的前提★：**这份快照自己是不是"进度型"** —— 全文一个阶段编号都没有的，
    //   是"位置目录"（如 `VAULT_INDEX.md`：只讲"哪个文件在哪、是什么"），
    //   它**设计上就不写进度**，拿"没写进度"去报它就是误报（第一跑实测炸出这条）。
    //   机械判法：**这份快照里至少有一行写了阶段编号** → 才按进度型要求它。
    const snapIsProgress = maxStage(stagesIn(text)) !== null
    lines.forEach(function (raw, i) {
      LEDGER_IN_LINE_RE.lastIndex = 0
      const found = []
      let m
      while ((m = LEDGER_IN_LINE_RE.exec(raw)) !== null) found.push(m[1])
      for (const p of found) {
        const ledPath = join(ROOT, p)
        seen.add(ledPath)
        const where = relS + ':' + (i + 1)
        const brief = raw.trim().replace(/\s+/g, ' ').slice(0, 120)
        if (!existsSync(ledPath)) {
          hits.push({ kind: '指向不存在的台账', snap: relS, where: where, target: p, line: brief,
            detail: where + ' 指向的台账**不存在**：' + p })
          continue
        }
        const led = readFileSync(ledPath, 'utf8')
        const ls = maxStage(stagesIn(led)), is = maxStage(stagesIn(raw))
        if (ls !== null && is !== null && ls > is) {
          hits.push({ kind: '快照落后', snap: relS, where: where, target: p, line: brief,
            detail: where + ' 只写到 **阶段' + is + '**，而 ' + p + ' 已到 **阶段' + ls + '**（落后 ' + (ls - is) + ' 个阶段）' })
        } else if (ls !== null && is === null && snapIsProgress) {
          hits.push({ kind: '快照没写进度', snap: relS, where: where, target: p, line: brief,
            detail: where + ' 一个阶段编号都没写，而 ' + p + ' 已到 **阶段' + ls + '**（这份快照别处会写阶段号，所以它是进度型）' })
        }
        const ld = lateDate(led), sd = lateDate(raw)
        if (ld !== null && sd !== null && ld > sd) {
          const gap = Math.round((new Date(ld) - new Date(sd)) / 86400000)
          if (gap >= 2) {
            hits.push({ kind: '快照落后（日期）', snap: relS, where: where, target: p, line: brief,
              detail: where + ' 最新日期是 **' + sd + '**，而 ' + p + ' 已到 **' + ld + '**（落后 ' + gap + ' 天）' })
          }
        }
      }
    })
  }
  // 反向：有台账、快照里却没有任何一行指向它
  for (const led of ledgerFiles) {
    if (SNAP_RE.test(led.split(/[\\/]/).pop())) continue
    if (seen.has(led)) continue
    const rel = relative(ROOT, led)
    hits.push({ kind: '项目没进快照', snap: snaps.map(function (s) { return relative(ROOT, s) }).join(' , '), where: '(快照里没有指向它的行)', target: rel, line: '(快照里没有指向它的行)',
      detail: rel + ' 存在，但快照里**没有任何一行**指向它' })
  }
  return { hits: hits, snaps: snaps.map(function (s) { return relative(ROOT, s) }), matched: seen.size }
}

// ── G 语料过期（"会长大的快照"：转写生成之后，会话日志还在写）────────────
// 依据：阶段20 ④ 的发现 ——「**进行中的会话，转写必然是过期快照**」。当时发现了，**却没人守这条**。
// ★分两档，因为"快照滞后"有两种性质完全不同的原因★（F 项第一版就栽在"报了一个结构上必然成立的"上）：
//   ① 日志**刚还在动**（< --stale-min 分钟，默认 30）→ 会话进行中 → 快照滞后是**本性**，报它=噪声
//   ② 日志已停更、转写还更旧 → **该重跑转写** = 真缺陷，报
// ⚠️ 这一项**不可避免要用墙上时钟**（"过期"本来就相对"现在"）—— 所以：阈值给宽、可用 `--stale-min` 调，
//    并且**夹具用 `utimesSync` 显式设 mtime**，让测试本身是确定的（不靠"跑得快"）。
const SESS_DIR_DEFAULT = join(homedir(), '.dsh', 'sessions')
function checkCorpusFresh(sessDir, memDir, staleMin) {
  if (!existsSync(sessDir)) return { skipped: '找不到会话日志目录（' + sessDir + '；可用 --sessions 指定），这一项没跑' }
  const corpus = join(memDir, 'corpus')
  if (!existsSync(corpus)) return { skipped: '没有 ' + corpus + '，这一项没跑' }
  const logs = new Map()
  const walk = function (dir, depth) {
    if (depth > 4) return
    let items = []
    try { items = readdirSync(dir) } catch (_e) { return }
    for (const it of items) {
      const p = join(dir, it)
      let st
      try { st = statSync(p) } catch (_e) { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (it === 'session.jsonl.zstd') logs.set(dir.split(/[\\/]/).pop(), { mtime: st.mtimeMs, size: st.size })
    }
  }
  walk(sessDir, 0)
  if (logs.size === 0) return { skipped: sessDir + ' 下没有 session.jsonl.zstd，这一项没跑' }
  const agoTxt = function (mins) {
    if (mins < 60) return mins + ' 分钟'
    if (mins < 2880) return Math.round(mins / 60) + ' 小时'
    return Math.round(mins / 1440) + ' 天'
  }
  const hits = []
  let fresh = 0, growing = 0, orphan = 0
  for (const it of readdirSync(corpus)) {
    if (!it.endsWith('.md') || it === 'INDEX_CARDS.md') continue
    const uuid = it.replace(/\.md$/, '')
    const lg = logs.get(uuid)
    if (lg === undefined) { orphan++; continue }
    let mdSt
    try { mdSt = statSync(join(corpus, it)) } catch (_e) { continue }
    const gapMin = Math.round((lg.mtime - mdSt.mtimeMs) / 60000)
    if (gapMin <= 1) { fresh++; continue }
    const idleMin = Math.round((Date.now() - lg.mtime) / 60000)
    if (idleMin < staleMin) { growing++; continue }            // ① 进行中 → 不报
    hits.push({
      kind: '转写过期', target: uuid, gapMin: gapMin, idleMin: idleMin,
      detail: '转写生成后**会话又写了 ' + agoTxt(gapMin) + '**，而日志已停更 ' + agoTxt(idleMin) + ' → 该重跑转写'
    })
  }
  const missing = []
  for (const [uuid, lg] of logs) {
    if (existsSync(join(corpus, uuid + '.md'))) continue
    // ★「没有转写」也要过"进行中"这道闸★ —— 2026-09-14 挂上触发器后立刻踩到：
    //   我刚起了 3 个新会话，G 就把它们报成"没有转写"。**刚开的会话当然还没转写**，
    //   拿它当缺陷报 = 噪声（跟"位置型快照"那次是同一类错误：报了一个结构上必然如此的东西）。
    const idleMin = Math.round((Date.now() - lg.mtime) / 60000)
    if (idleMin < staleMin) { growing++; continue }
    missing.push({
      kind: '没有转写', target: uuid, sizeKB: Math.round(lg.size / 1024), idleMin: idleMin,
      detail: '日志有 ' + Math.round(lg.size / 1024) + ' KB，但 corpus 里没有它的转写（日志已停更 ' + agoTxt(idleMin) + '）'
    })
  }
  return { hits: hits.concat(missing), fresh: fresh, growing: growing, orphan: orphan, logs: logs.size, corpus: corpus }
}

// ── H 文档里的"自称"对不对得上现实（两类，都机械可证）──────────────────
// ★由来 = 2026-09-14 的「零重讲实验」★：起了 3 个**全新会话**（只给问题、只让它们用记忆文件答题），
//   它们**独立地**挑出同一批不一致：「台账抬头写阶段26、正文已到 27」「台账写清零率 100%、实查 73%」……
//   ★而 A–G 七项机械检查一条都没报★ —— 因为它们只看**跨文件的关系**（快照 vs 源、语料 vs 日志），
//   **不看"文档自己声称的" vs "现实"**。
//   → 所以这一项的意义是：**把"只有人眼才发现的东西"变成机器守的**。
// 两类判据：
//   H1 台账**抬头声明**的阶段 vs **正文最大**阶段 —— **两头都查**：
//      ① 落后（正文比抬头新）= 抬头在说谎；② 领先（抬头比正文新）= 宣称的进度查不到出处。
//      ★2026-09-14 之前只查"落后"那一头★ —— 撞上真事（抬头写阶段31、正文只到阶段29）才补上另一半。
//   H2 **抄进"当前状态"层的"会漂的数"**（清零率 / 分区数）vs **现查**
//      ⚠️ 只扫**台账 + 每轮注入**这两层，**不扫档案** —— 档案是历史，里面引用当时的工具输出是**对的**，
//         拿今天的值去报它 = 假阳性（这条边界是刻意的）。
const DRIFT_RATE_RE = /清零率\s*\**\s*(\d+)\s*%/
const DRIFT_NS_RE = /(\d+)\s*(?:个)?\s*分区/
async function checkSelfClaim(ledgerFiles, injected, memDir, vaultPath) {
  const hits = []
  let h1 = 0, h2 = 0
  // ── H1 抬头 vs 正文 ──
  for (const f of ledgerFiles) {
    const rel = relative(ROOT, f)
    const lines = readFileSync(f, 'utf8').split('\n')
    const headIdx = lines.findIndex(function (l) { return /^\s*日期\s*[:：]/.test(l) && /阶段\s*[:：]/.test(l) })
    if (headIdx < 0) continue
    const hmax = maxStage(stagesIn(lines[headIdx]))
    if (hmax === null) continue
    h1++
    let bmax = null
    lines.forEach(function (l, i) {
      if (i === headIdx) return
      const m = maxStage(stagesIn(l))
      if (m !== null && (bmax === null || m > bmax)) bmax = m
    })
    if (bmax !== null && bmax > hmax) {
      hits.push({
        kind: '抬头落后', file: rel, target: rel,
        detail: rel + ' **抬头写"阶段' + hmax + '"，正文已到"阶段' + bmax + '"** —— 抬头是每轮注入的第一眼，落后就是说谎',
        line: lines[headIdx].trim().slice(0, 110)
      })
    } else if (bmax === null) {
      // ★2026-09-14 补的方向★：抬头宣告了阶段号，**正文一个都查不到** —— 宣称的进度没有出处。
      hits.push({
        kind: '抬头领先正文', file: rel, target: rel,
        detail: rel + ' **抬头写"阶段' + hmax + '"，而正文一个阶段号都没有** —— 宣称的进度在正文里查不到出处',
        line: lines[headIdx].trim().slice(0, 110)
      })
    } else if (bmax < hmax) {
      // ★同一个盲区的另一半★：原先只查"抬头落后正文"（bmax > hmax），
      //   **"抬头比正文新"（bmax < hmax）一声不响** —— 2026-09-14 实测撞上：
      //   台账抬头写"阶段31"，而「大进度」只写到阶段29（正文最大 29）。
      //   两头都是"自称与现实对不上"，没有理由只报一头。
      hits.push({
        kind: '抬头领先正文', file: rel, target: rel,
        detail: rel + ' **抬头写"阶段' + hmax + '"，而正文最大只到"阶段' + bmax + '"** —— 抬头宣称的进度，正文里查不到出处（差 ' + (hmax - bmax) + ' 个阶段）',
        line: lines[headIdx].trim().slice(0, 110)
      })
    }
  }
  // ── H2 抄死的会漂的数 ──
  const probes = []
  const regPath = join(memDir, 'corrections', 'findings.json')
  if (existsSync(regPath)) {
    try {
      const r = JSON.parse(readFileSync(regPath, 'utf8'))
      const live = (r.entries || []).filter(function (e) { return e.status !== '已消失' })
      const done = live.filter(function (e) { return ['已改', '保留', '作废'].indexOf(e.status) >= 0 })
      probes.push({ name: '清零率', actual: Math.round(done.length / Math.max(1, live.length) * 100), unit: '%', re: DRIFT_RATE_RE, how: 'node memory/tools/findings.mjs --status' })
    } catch (_e) { /* 读不到就不查这项 */ }
  }
  if (existsSync(vaultPath)) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(vaultPath, { readOnly: true })
      const q = db.prepare('SELECT COUNT(DISTINCT namespace) n FROM memos')
      const n1 = Number(q.get().n), n2 = Number(q.get().n)
      db.close()
      // ★两次读必须一致才用来"指责文档"★ —— DSH 在跑时库可能正被 boot 同步写（clear + insert），
      //   并发读有可能看到中间态。**2026-09-14 实测见过一次 13，随后怎么读都是 12，复现不了。**
      //   拿一个"自己都读不稳"的数去报"文档写错了" = 冤假错案；读不稳就这一轮**不报**。
      if (n1 === n2) {
        probes.push({ name: 'Vault 分区数', actual: n1, unit: '', re: DRIFT_NS_RE, how: 'node memory/tools/check_vault_truth.mjs' })
      }
    } catch (_e) { /* 读不到就不查这项 */ }
  }
  for (const p of probes) {
    let used = false
    for (const f of ledgerFiles.concat(injected)) {
      const rel = relative(ROOT, f)
      readFileSync(f, 'utf8').split('\n').forEach(function (l, i) {
        if (l.trim().startsWith('>') && /别抄|现查|硬编码/.test(l)) return   // 这行本身就在说"别抄"→ 不算
        const m = p.re.exec(l)
        p.re.lastIndex = 0
        if (m === null) return
        const stated = Number(m[1])
        if (stated === p.actual) return
        used = true
        hits.push({
          // ★`target` 里**不放行号**★（行号一动指纹就变 → 台账会"天天发现新问题"）。
          //   行号只出现在 `detail` 里给人看。这是 `lineKey` 那条教训的同一课：**身份要稳**。
          kind: '抄死的数已过期', file: rel, target: rel + '|' + p.name,
          detail: rel + ':' + (i + 1) + ' 写「' + p.name + ' ' + stated + p.unit + '」，**现查是 ' + p.actual + p.unit + '** —— 这个数会漂，不该抄进每轮注入的层（现查：' + p.how + '）',
          line: l.trim().slice(0, 110)
        })
      })
    }
    if (used || probes.length) h2++
  }
  if (h1 === 0 && probes.length === 0) return { skipped: '没找到"带头部的台账"、也没有可现查的数，这一项没跑' }
  return { hits: hits, ledgersWithHead: h1, probes: probes.map(function (p) { return p.name + '=' + p.actual }) }
}

// ══════════════════ 跑 ══════════════════
const t0 = Date.now()
const files = collect()
const allFiles = files.ledgers.concat(files.archives).concat(files.injected)

const REFS = pathRefs(allFiles)
const A = REFS.filter(function (r) { return !r.exists })
// ★E 的第一版把"光提到目录本身"也算进来了 → 实测炸出 18 条假阳性★（连"长期工具不许住 `.ptmp/`"
//   这句规矩、工作区地图的表格行都被报）。正解两道闸：
//   ① **必须指到目录"里面"**（`_trash/foo.md` 而不是 `_trash/`）② **目标得是个文件**。
const E = REFS.filter(function (r) {
  if (!r.exists || r.zone !== '现状区') return false
  const rel = String(r.rel)
  if (!TRASH_TOP.test(rel)) return false
  const depth = rel.replace(/[\\/]+$/, '').split(/[\\/]/).length
  if (depth < 2) return false                                  // 只提到 `_trash/` 本身 → 不算
  try { if (!statSync(r.full).isFile()) return false } catch (_e) { return false }
  return true
})

const Ball = []
{
  // B 复用 A 的"路径实测不存在"当第二信号 —— 双信号 = 高置信
  // ⚠️ 这里**必须用 `lineKey` 不用 `line`**：`line` 是给人看的窗口文本，格式一动两边就对不上（见 pathRefs 里的注释）。
  const missingPaths = new Set(A.map(function (x) { return x.file + '|' + x.lineKey }))
  for (const f of allFiles) {
    const text = readFileSync(f, 'utf8')
    for (const c of classify(text)) {
      const line = c.line
      for (const r of RETIRED) {
        if (line.indexOf(r.needle) < 0) continue
        if (RETIRE_MARK.test(line)) continue
        const relF = relative(ROOT, f)
        const lineKey = line.trim().slice(0, 96)
        const shown = windowAround(line, line.indexOf(r.needle) + Math.floor(r.needle.length / 2), 96)
        const doubleSignal = missingPaths.has(relF + '|' + lineKey)
        Ball.push({
          file: relF, needle: r.needle, why: r.why,
          zone: c.hist ? '历史区' : '现状区',
          confidence: doubleSignal ? '高（同行的路径实测不存在）' : '候选',
          lineKey: lineKey,
          line: shown
        })
        break
      }
    }
  }
}
const C = await checkSimilar()
const D = checkPrefixDup(files.injected)
const F = checkSnapshot(allFiles, files.ledgers)
const G = checkCorpusFresh(argOf('--sessions', SESS_DIR_DEFAULT), MEM, parseFloat(argOf('--stale-min', String(SESSION_STALE_MIN))))
const H = await checkSelfClaim(files.ledgers, files.injected, MEM, VAULT)

const A_live = A.filter(function (x) { return x.zone === '现状区' && !x.retiredSay })
const B_live = Ball.filter(function (x) { return x.zone === '现状区' })
const C_high = C.error ? [] : C.high
const C_mid = C.error ? [] : C.mid
const F_live = F.skipped ? [] : F.hits
const G_live = G.skipped ? [] : G.hits
const H_live = H.skipped ? [] : H.hits
const worth = A_live.length + B_live.length + C_high.length + C_mid.length + D.length + E.length + F_live.length + G_live.length + H_live.length

console.log('═'.repeat(78))
console.log('  记忆体检器 v2（只读）—— 没有任何文件/库被修改')
console.log('═'.repeat(78))
console.log('  工作区 ' + ROOT)
console.log('  记忆库 ' + MEM + (VAULT === join(MEM, 'vault.db') ? '' : '（库 ' + VAULT + '）'))
console.log('  扫了 ' + allFiles.length + ' 份：台账 ' + files.ledgers.length + ' / 档案 ' + files.archives.length + ' / 常驻注入 ' + files.injected.length)
console.log('  口径：A 路径存在性 ｜ B 退役物当现状 ｜ C 块级相似（分档 ≥' + TIER_HIGH + ' 高 / ≥' + TIER_MID + ' 中 / ≥' + SIM + ' 低）｜ D 逐字相同或前缀 ⊆ ≥' + PREFIX_MIN + ' 字 ｜ E 活文档住待删区 ｜ F 快照一致性 ｜ G 语料过期（停更 ≥' + SESSION_STALE_MIN + ' 分钟才算）')

console.log('\n' + '─'.repeat(78))
console.log('A 路径存在性：' + A.length + ' 条「指向的东西现在不存在」')
console.log('   ★值得看 ' + A_live.length + '（现状区 + 没说是退役）／ 其余 ' + (A.length - A_live.length) + '（历史区或已说明退役，多半正常）')
for (const x of A_live.slice(0, 20)) console.log('   ★ ' + x.file + '  →  ' + x.path + '\n      行：' + x.line)
if (A_live.length === 0) console.log('   ✓ 没有')

console.log('\n' + '─'.repeat(78))
console.log('B 退役物当现状：' + Ball.length + ' 条（★现状区 ' + B_live.length + '）')
for (const x of B_live.slice(0, 24)) console.log('   [' + x.confidence + '] ' + x.file + '  ← ' + x.needle + '（' + x.why + '）\n      行：' + x.line)
const B_hist = Ball.length - B_live.length
if (B_hist) console.log('   · 另有 ' + B_hist + ' 条在历史区（当时的事实，正常）')
if (B_live.length === 0) console.log('   ✓ 没有')

console.log('\n' + '─'.repeat(78))
if (C.error) console.log('C 块级高相似：' + C.error)
else {
  console.log('C 块级高相似：全库 ' + C.scanned + ' 块 / ' + C.nsCount + ' 分区')
  console.log('   ★高度疑似重复 ≥' + TIER_HIGH + '：' + C.high.length + ' 组')
  for (const p of C.high.slice(0, 20)) console.log('      ' + p.sim.toFixed(3) + '  ' + p.ns.padEnd(14) + ' #' + p.a + ' ↔ #' + p.b + '（共同开头 ' + p.sharedHead + ' 字）「' + p.head + '…」')
  console.log('   ★疑似 ≥' + TIER_MID + '：' + C.mid.length + ' 组')
  for (const p of C.mid.slice(0, 20)) console.log('      ' + p.sim.toFixed(3) + '  ' + p.ns.padEnd(14) + ' #' + p.a + ' ↔ #' + p.b + '（共同开头 ' + p.sharedHead + ' 字）「' + p.head + '…」')
  console.log('   · 同主题（' + SIM + '–' + TIER_MID + '，天然相似，通常不用管）：' + C.low.length + ' 组')
  if (C.high.length + C.mid.length === 0) console.log('   ✓ 没有值得看的')
}

console.log('\n' + '─'.repeat(78))
console.log('D 注入文件重复（逐字相同 或 一句是另一句的前缀）：' + D.length + ' 组')
for (const d of D.slice(0, 20)) console.log('   [' + d.kind + '] ' + d.shortFile + ':' + d.shortLine + ' ⊆ ' + d.longFile + ':' + d.longLine + '\n      「' + d.shortRaw + '…」')
if (D.length === 0) console.log('   ✓ 没有')

console.log('\n' + '─'.repeat(78))
if (F.skipped) console.log('F 快照一致性：' + F.skipped)
else {
  console.log('F 快照一致性（快照 vs 源台账）：' + F_live.length + ' 条 ／ 快照 ' + F.snaps.join(' , ') + ' ／ 对应上 ' + F.matched + ' 份台账')
  for (const x of F_live.slice(0, 20)) console.log('   ★ [' + x.kind + '] ' + x.detail + '\n      快照行：' + x.line)
  if (F_live.length === 0) console.log('   ✓ 没有')
}

console.log('\n' + '─'.repeat(78))
console.log('E 活文档住在"随时可删"的目录里（_trash / .ptmp / test）：' + E.length + ' 条')
for (const x of E.slice(0, 20)) console.log('   ★ ' + x.file + '  →  ' + x.rel + '（这个文件**存在**，但在待删区）\n      行：' + x.line)
if (E.length === 0) console.log('   ✓ 没有')

console.log('\n' + '─'.repeat(78))
if (G.skipped) console.log('G 语料过期：' + G.skipped)
else {
  console.log('G 语料过期（转写 vs 会话日志）：' + G_live.length + ' 条 ／ 日志 ' + G.logs + ' 份 ｜ 新鲜 ' + G.fresh + ' ｜ 进行中(不报) ' + G.growing + ' ｜ 孤儿转写 ' + G.orphan)
  for (const x of G_live.slice(0, 20)) console.log('   ★ [' + x.kind + '] ' + x.target + '\n      ' + x.detail)
  if (G_live.length === 0) console.log('   ✓ 没有')
}

console.log('\n' + '─'.repeat(78))
if (H.skipped) console.log('H 文档自称 vs 现实：' + H.skipped)
else {
  console.log('H 文档自称 vs 现实：' + H_live.length + ' 条 ／ 带头部的台账 ' + H.ledgersWithHead + ' 份 ｜ 现查：' + (H.probes.length ? H.probes.join(' , ') : '（无可现查项）'))
  for (const x of H_live.slice(0, 20)) console.log('   ★ [' + x.kind + '] ' + x.detail + '\n      行：' + x.line)
  if (H_live.length === 0) console.log('   ✓ 没有')
}

console.log('\n' + '═'.repeat(78))
console.log('  ★值得看合计 ' + worth + ' 条' + (C.error ? '' : '（C 的"同主题" ' + C.low.length + ' 组不计入）') + ' ／ 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒')
console.log('  ⚠️ 这是**候选清单**不是判决：启发式精度有限，必须人裁（SOP：不擅自覆盖）')
console.log('═'.repeat(78))

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    at: new Date().toISOString(), root: ROOT, memDir: MEM, vault: VAULT,
    sim: SIM, tierHigh: TIER_HIGH, tierMid: TIER_MID, prefixMin: PREFIX_MIN,
    A: A, B: Ball, C: C, D: D, E: E, F: F, G: G, H: H,
    worth: worth
  }, null, 1), 'utf8')
  console.log('  报告已写 ' + JSON_OUT)
}
process.exit(worth === 0 ? 0 : 1)
