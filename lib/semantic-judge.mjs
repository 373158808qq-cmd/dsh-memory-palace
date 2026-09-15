// ⑤ 校验层 · 语义判官 —— 机械测不出的那类矛盾，交给「现在 DSH 正在用的那个模型」判。
//
// ★为什么必须有这一层★（2026-09-14 的否证）：`memory_doctor.mjs` 的 A–H 八项
//   **测不出语义级矛盾** —— 4 轮探针、6 种信号，**真阳性 0**。A–H 只会抓：
//   "逐字相同 / 前缀包含 / 快照过期 / 自称与现实"。而真实矛盾长这样：
//   「Ollama 端口 :11434」vs「Ollama 端口 :11435」、「某服务已停用」vs「用某服务合成」
//   —— 两句**用词完全不同、字面毫不相干**，只有懂意思才知道它们在打架。
//   用户 2026-09-14 拍板：这类交给 LLM 判，**可接受外发（云端）**。
//
// ★它住插件里的唯一理由★：`ctx.get('llm')` 只有 DSH 进程里才有（CLI 侧拿不到）。
//   所以本模块的分工是：**判官住插件、结果落文件、CLI 只负责把结果并进裁决台账**。
//
// ★外发边界（有意设计，别改成"更省事"的写法）★
//   · 只发**每组 ≤600 字**的摘录（不是整块、不是整库）；
//   · 只发**已经配出共享稀有实体**的那些对（不乱发）；
//   · **绝不自动跑** —— 只在用户/agent 显式调 `memory_semantic_scan` 时才发一次请求。
//
// ★为什么先"配对"再判★：全库两两组合是 O(n²)，几百块就是几万次比较 —— 又慢又贵。
//   先用**倒排索引**把"共享同一个稀有实体"的块挑出来（端口/路径/版本/型号 —— 同一个东西的两种写法），
//   候选从几万降到十几对，再一次性批量问模型（**一次请求判 N 对**，不是 N 次请求）。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const sha = function (s) { return createHash('sha256').update(String(s)).digest('hex').slice(0, 16) }

function str(v) { return v === null || v === undefined ? '' : String(v) }
function intOf(v, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : dflt }
function clampInt(v, dflt, lo, hi) { const n = intOf(v, dflt); return Math.max(lo, Math.min(hi, n)) }
function msgOf(e) { return e && e.message ? String(e.message) : String(e) }
function one(s, cap) {
  const t = str(s).replace(/\s+/g, ' ').trim()
  if (t.length <= cap) return t
  // ★截断标记也算在 cap 里★ —— "≤200 字"是要兑现的承诺，不能截完再挂个尾巴把总数顶破
  return t.slice(0, Math.max(0, cap - 5)) + '…[截断]'
}

// ═══════════════ 1. 抽实体：找出"同一个东西的两种写法"里那个东西 ═══════════════
//
// 判据是"**能不能用来指认一个具体的东西**"：端口能、路径能、版本能、型号能；
// "文件""问题""已经"不能 —— 所以必须有停用词表 + 长度门槛，否则倒排索引会被常见词灌满，
// 配出来的对全是噪声（那样等于没做）。
//
// ★归一化在这儿做，因为"同一个东西的两种写法"是去重逻辑最常见的坑（项目里栽过：
//  路径斜杠方向 / 大小写 / 末尾斜杠 / URL 里的 `&amp;`）★ —— 归一化只做**无歧义**的那几种：
//  反斜杠→正斜杠、去尾随斜杠、去首尾引号与句读；**大小写保留**（`PROJECT_LEDGER.md` 不能变成小写），
//  比较时才用小写做 key。
const STOP = new Set([
  // 语言关键字 / 通用词（抽它们没有任何指认能力）
  'the', 'and', 'for', 'not', 'you', 'are', 'this', 'that', 'from', 'with', 'true', 'false',
  'null', 'undefined', 'const', 'let', 'var', 'function', 'return', 'import', 'export', 'async',
  'await', 'class', 'new', 'type', 'exit', 'error', 'ok', 'fail', 'pass', 'done', 'node', 'npm',
  // 到处都出现的缩写（留着只会配出噪声对；真需要时它们本来就会被 rareMax 挡掉）
  'url', 'uri', 'api', 'json', 'jsonl', 'http', 'https', 'html', 'css', 'sql', 'rpc', 'gui', 'cli',
  'llm', 'ai', 'id', 'js', 'ts', 'os', 'pc', 'pid', 'utf', 'ascii', 'todo', 'note', 'read', 'write',
  'file', 'test', 'name', 'path', 'text', 'data', 'info', 'item', 'list', 'true', 'false',
  // 英文常用连字符词（正则会把它们当"标识符"抓出来）
  'read-only', 'top-k', 'one-shot', 'end-to-end', 'well-known', 'case-by-case', 'step-by-step',
  'built-in', 'long-term', 'short-term', 'up-to-date', 'out-of-date', 'e-mail',
])

const RE = {
  // Windows 路径（E:\a\b）与含分隔符的相对路径（memory/tools/findings.mjs）
  // ★段用"排除式"字符类：工作区路径里可能带中文（如中文目录名）★ —— 用 [A-Za-z0-9_.-]
  //   会把中文当边界、把路径截断（甚至截出个不存在的路径来），比不抽更坏。
  path: /(?:[A-Za-z]:[\\/])?[^\s\\/:*?"<>|'"`（）()【】〔〕,，。；;、]+(?:[\\/][^\s\\/:*?"<>|'"`（）()【】〔〕,，。；;、]+)+/g,
  // 文件名（带受控扩展名，避免把 `0.1.2` 这种版本号误当文件名）
  fname: /[A-Za-z0-9_.\-]+\.(?:mjs|js|cjs|ts|json|jsonl|md|txt|db|sqlite|yml|yaml|pptx|docx|xlsx|py|exe|log|zst|pid|bak|zip|png|jpg)(?![\w])/gi,
  // host:port（如 127.0.0.1:11434）
  hostport: /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/g,
  // 裸端口（:11434）；★排除 `12:30` 这类时间★（那是有意加的负向断言）
  port: /(?<![\d:])(?<!\d\d):(\d{2,5})(?!\d)/g,
  // 模型型号 tag（qwen3-embedding:0.6b）；`://` 由"冒号前不能是斜杠"排除
  modeltag: /\b[A-Za-z0-9_.\-]{3,}:([A-Za-z0-9][A-Za-z0-9_.\-]*)/g,
  // 版本号（0.1.2-rc.1 / 3.12）；★尾部负向断言挡住 `0.6b` 被截成 `0.6`★
  version: /\bv?\d+\.\d+(?:\.\d+)*(?:-[A-Za-z0-9.]+)?(?![\w.])/g,
  // 大写型号 / 缩写（V8、H1、P0、DSH、GPT）
  upper: /\b[A-Z]{2,}\d?\b/g,
  // 连字符标识符（qwen3-embedding、dsh-memory-palace 这种）
  dashed: /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g,
  // 指针（vault:memory#阶段17 / file:path#标题 / corpus:uuid#锚）
  pointer: /\b(?:vault|file|corpus):[^\s`"'）)】\]，。；;]+/g,
  // 反引号片段（`` `...` ``）
  backtick: /`([^`\n]{2,120})`/g,
}

/** 逐个匹配（不用 matchAll：显式处理零宽匹配，且不吃全局 lastIndex 的亏） */
function each(re, text, fn) {
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    fn(m)
    if (m.index === re.lastIndex) re.lastIndex++
    if (re.lastIndex > text.length) break
  }
}

// ★实体停用词表（"稀有但没意义"）★ —— 每条都拿真库量过才写进来，不是拍脑袋（见 extractEntities 里的注释）
const DENY = [
  /^pwsh-?\d*$/i,                                   // 后台任务名：pwsh / pwsh-1（换会话照样有）
  /^session-[0-9a-f][0-9a-f-]{6,}$/i,               // 会话 id / uuid
  /^[0-9a-f]{8,}$/i,                                // 纯十六进制 ≥8 位（内容哈希、短 id）—— 真库里 507 次
  /^\d{4}-\d{2}-\d{2}t[\d:.]+z?$/i,                 // ISO 时间戳（"时间"不是"东西的名字"）
  // ── ★2026-09-14 阶段42 补的两条"漏网"★（上面四条装上去之后，复测又抓到的）──
  // ① 裸 UUID（带短横线）：它躲过了"纯十六进制≥8位"那条 —— 短横线把它切成了一段一段。
  //    真库实测 **71 种**：`ee6d4e2d-8616-4fbd-a0d4-e59621d8b096` 出现 2 次（台账与档案各一次）；
  //    另有 70 种是 `<uuid>.md` 形式的**会话全文文件名**。
  //    ⚠️ 只挡"光秃秃的 uuid"：`corpus/<uuid>.md` 这种**指针形式**另有 path/fname 规则抽（那是真东西，留着）。
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.\w{1,5})?$/i,
  // ② 纯小数：评分（`0.69`/`0.740`/`0.501`）、体积（`24.19` MB）、耗时、百分比 —— **是"量"，不是"东西的名字"**。
  //    真库实测 **96 种**；它们配出来的对是"两块都有个评分表"这种没有信息量的对。
  //    ⚠️ 代价（如实记）：Python 的 `3.12`/`3.13`/`3.14` 也一并被挡（实测 3 种）。
  //       判断：**值** —— 它们是"量级/版本"，很少是"同一个东西的两种写法"的线索；
  //       而 96 种噪声会实打实占掉候选名额。要保版本号得靠上下文判（或给 version 正则加 v 前缀要求），
  //       **不该靠放宽这一条**。三段式版本号（`0.1.2-rc.1`）本来就不匹配这条 ✓。
  /^\d+\.\d+$/,
]

/**
 * 抽实体：返回**归一化后**的实体列表（去掉重复；大小写保留）。
 * 返回的是"点得名一个具体东西"的字符串：路径 / 文件名 / 端口 / host:port / 型号版本 / 指针 / 反引号里的标识符。
 */
export function extractEntities(text) {
  const src = str(text)
  const out = []
  const seen = new Set()

  function push(raw) {
    let s = str(raw).trim()
    if (s === '') return
    s = s.replace(/^[\s"'`（(【\[<]+/, '').replace(/[\s"'`）)】\]>]+$/, '')
    s = s.replace(/[，。；、,;]+$/, '')
    s = s.replace(/\\/g, '/')          // ★斜杠方向：同一个东西的两种写法★
    s = s.replace(/\/+$/, '')          // 尾随斜杠
    s = s.replace(/^\.\//, '')
    if (s === '') return
    if (s.length < 2) return
    // 两字符的只放行"型号"（V8 / H1 / P0）；别的一律太短
    if (s.length < 3 && !/^[A-Za-z]{1,2}\d$/.test(s)) return
    // ★纯数字的"路径"与纯数字串不是实体★ —— `10/10`、`27/27`、`5/8` 是**分数**，不是"东西的名字"。
    //   真库实测：不过滤的话它们会占掉候选名额，配出"两块都有个评分表"这种没有信息量的对。
    if (/^[0-9]+(?:[\\/][0-9]+)+$/.test(s)) return
    if (/^[0-9]+$/.test(s)) return
    // 纯中文（含中文标点）且很短 = 普通词，不是实体
    if (s.length < 6 && !/[A-Za-z0-9]/.test(s)) return
    // ★"稀有但没意义"的 token 不许当实体★（2026-09-14 第一次真外发打脸）：
    //   那次配出的第 0 对，**只是"两块都出现过后台任务名 pwsh-1"**就被配到一起 ——
    //   「更新DSH及适配插件」⇄「如何赋予AI读取Excel的能力」，判决再对也是白问、还白花钱外发。
    //   判据：这类 token **换成另一个会话/另一次生成照样会出现**，它不指向"同一个具体东西"。
    //   真库实测（835 块 / 21 万字）：pwsh-N 16 次、session-<uuid> 89 次、纯十六进制≥8位 **507 次/208 种**。
    //   （同一个探针里，端口 13 次、备份目录名 5 次 —— 那是真东西，**留着**。）
    for (let k = 0; k < DENY.length; k++) if (DENY[k].test(s)) return
    const key = s.toLowerCase()
    if (STOP.has(key)) return
    if (seen.has(key)) return
    seen.add(key)
    out.push(s)
  }

  function scanTokens(s) {
    each(RE.path, s, (m) => push(m[0]))       // 路径（含文件名，靠 key 去重）
    each(RE.fname, s, (m) => push(m[0]))
    each(RE.hostport, s, (m) => push(m[0]))
    each(RE.port, s, (m) => push(':' + m[1]))
    each(RE.pointer, s, (m) => push(m[0]))
    each(RE.modeltag, s, (m) => { if (m.index > 0 && s[m.index - 1] === '/') return; push(m[0]) })  // 排掉 http://host:port
    each(RE.version, s, (m) => push(m[0]))
    each(RE.upper, s, (m) => { if (m.index > 0 && s[m.index - 1] === ':') return; push(m[0]) })      // 排掉 tag 后半截
    each(RE.dashed, s, (m) => push(m[0]))
  }

  scanTokens(src)
  // 反引号里的东西**整体**也算一个实体（`` `node memory/tools/findings.mjs --status` `` 是一条完整命令）
  each(RE.backtick, src, (m) => {
    const body = m[1].trim()
    if (body.length <= 60) push(body)
    scanTokens(body)
  })
  return out
}

// ═══════════════ 2. 配对：倒排索引 + 稀有度打分 ═══════════════

/**
 * 把"共享稀有实体"的块配成对。
 * @param {{id?:any,namespace?:string,content:string}[]} blocks 候选块（只在这些块之间配对）
 * @param {{maxPairs?:number, rareMax?:number, minLen?:number, universe?:object[]}} [opts]
 *   ★`universe` = 算"稀有"的参照系（通常是全库）★。不传就退化成"只按候选算"。
 *   为什么必须有它（2026-09-14 拿真库实测出来的）：语义判官的候选通常只是"最近 N 块"，
 *   而 `AGENTS.md` 这类文件名在**那 N 块里**可能只出现 6 次 → 被判"稀有" → 配出来的 10 对
 *   **全是「台账⇄台账 共享 agents.md」这种泛化对**，一点用没有（而它在全库出现几百次，根本不稀有）。
 *   **"稀有"必须相对全库算**，否则候选集越小、噪声越大 —— 这正好和直觉相反。
 * @returns {{i:number,a:object,b:object,shared:string[],score:number}[]}
 */
export function buildPairs(blocks, opts) {
  const o = opts || {}
  const maxPairs = clampInt(o.maxPairs, 10, 1, 200)
  const rareMax = clampInt(o.rareMax, 8, 2, 1000)
  const minLen = clampInt(o.minLen, 40, 1, 100000)

  // ① 洗净输入：太短的不要、**内容相同的重复块只留一个**（同一分区里重复块配成对 = 纯噪声）
  const list = []
  const seenContent = new Set()
  const arr = Array.isArray(blocks) ? blocks : []
  for (const b of arr) {
    if (b === null || b === undefined || typeof b !== 'object') continue
    const content = str(b.content)
    if (content.trim().length < minLen) continue
    const h = sha(content)
    if (seenContent.has(h)) continue
    seenContent.add(h)
    list.push({
      idx: list.length,
      id: b.id,
      namespace: str(b.namespace),
      content: content,
      hash: h,
    })
  }

  // ①b 参照系频率（universe）：只用来判"稀不稀有"，不参与配对
  const univ = Array.isArray(o.universe) && o.universe.length > 0 ? o.universe : null
  const freq = new Map()
  if (univ !== null) {
    const seenU = new Set()
    for (const b of univ) {
      if (b === null || b === undefined || typeof b !== 'object') continue
      const c = str(b.content)
      if (c.trim().length < minLen) continue
      const h = sha(c)
      if (seenU.has(h)) continue
      seenU.add(h)
      for (const e of new Set(extractEntities(c).map(function (x) { return x.toLowerCase() }))) {
        freq.set(e, (freq.get(e) || 0) + 1)
      }
    }
  }

  // ② 倒排索引：实体 → 出现在候选里的哪些块
  const inv = new Map()
  for (const b of list) {
    const ents = extractEntities(b.content).map(function (e) { return e.toLowerCase() })
    b.entities = new Set(ents)
    for (const e of b.entities) {
      if (!inv.has(e)) inv.set(e, [])
      inv.get(e).push(b.idx)
    }
  }

  // ③ 稀有实体（在参照系里出现在 2..rareMax 个块里）→ 把共享它的候选块两两配对
  //    权重 = 1/参照系出现次数：越少见（越具体）的实体，越可能说明"这两块在说同一件事"。
  const byPair = new Map()
  for (const [ent, idxs] of inv) {
    if (idxs.length < 2) continue
    const f = univ !== null ? (freq.get(ent) || idxs.length) : idxs.length
    if (f < 2 || f > rareMax) continue
    const w = 1 / f
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const key = idxs[i] + '|' + idxs[j]
        let p = byPair.get(key)
        if (p === undefined) {
          p = { ai: idxs[i], bi: idxs[j], shared: [], score: 0 }
          byPair.set(key, p)
        }
        p.shared.push(ent)
        p.score += w
      }
    }
  }

  // ★跨分区优先（可调 crossNsBonus，默认 1.6）★ —— 2026-09-14 真库实测：只按稀有度排时
  //   **10/10 全是「同分区⇄同分区」**（最新块都挤在 `台账` 里），跨分区对要到 limit≥120 才冒头。
  //   而"同一个东西的两种说法"最可能出现在**不同来源**之间（会话卡 vs 台账 vs 档案 vs 注入文件）
  //   → 给跨分区的对加权。**只影响排序，不改判决**（判官看不看得到才是关键）。
  const crossNsBonus = (typeof o.crossNsBonus === 'number' && isFinite(o.crossNsBonus) && o.crossNsBonus > 0)
    ? o.crossNsBonus : 1.6
  const rankOf = function (p) {
    const a = list[p.ai], b = list[p.bi]
    const cross = a.namespace !== '' && b.namespace !== '' && a.namespace !== b.namespace
    return p.score * (cross ? crossNsBonus : 1)
  }
  const picked = Array.from(byPair.values())
    .sort(function (x, y) {
      const rx = rankOf(x), ry = rankOf(y)
      if (ry !== rx) return ry - rx
      if (y.score !== x.score) return y.score - x.score
      if (x.ai !== y.ai) return x.ai - y.ai
      return x.bi - y.bi
    })
    .slice(0, maxPairs)

  return picked.map(function (p, i) {
    const a = list[p.ai], b = list[p.bi]
    return {
      i: i,
      a: { id: a.id, namespace: a.namespace, content: a.content, hash: a.hash },
      b: { id: b.id, namespace: b.namespace, content: b.content, hash: b.hash },
      shared: p.shared.slice().sort(),
      score: Math.round(p.score * 1000) / 1000,
      cross: a.namespace !== '' && b.namespace !== '' && a.namespace !== b.namespace,
    }
  })
}

// ═══════════════ 3. 提示词：一次把 N 对问完 ═══════════════

/** 批量判官提示词。★只让它回严格 JSON 数组★（解析失败就是白花钱）。 */
export function buildJudgePrompt(pairs, opts) {
  const o = opts || {}
  const cap = clampInt(o.maxCharsPerBlock, 600, 50, 8000)
  const list = Array.isArray(pairs) ? pairs : []
  const L = []
  L.push('你是记忆一致性判官。下面是 ' + list.length + ' 对「记忆片段」，每对共享同一个实体（已标出）。')
  L.push('')
  L.push('只判【同一件事互相打架】这一类：')
  L.push('- 端口 / 路径 / 文件名 / 版本号 / 型号：同一个东西给出了两个不同的值')
  L.push('- “已停用 / 已退役 / 不再使用 / 已删除” 与 “正在用 / 已上线 / 就这么做” 直接对立')
  L.push('- 数字冲突：同一个量给出两个不同的数')
  L.push('不算矛盾（必须判 consistent）：各有各的说法但不互相对立、只是详略不同、同一件事的不同侧面、')
  L.push('时间上先后不同（旧的那条自己写明了“以前 / 曾经 / 已改”）、只是措辞或语气不同。')
  L.push('看不出来、或信息不够判断 → unclear（**不要硬猜**）。')
  L.push('')
  L.push('severity：3 = 照它做会做错事；2 = 说法冲突但影响有限；1 = 措辞上的小冲突。')
  L.push('')
  L.push('★只回一个 JSON 数组，不要任何解释文字、不要 Markdown 围栏、不要多余内容★。每项形如：')
  L.push('{"i": 0, "verdict": "contradiction"|"consistent"|"unclear", "severity": 1|2|3, "why": "一句话说清哪里打架"}')
  L.push('必须把 ' + list.length + ' 对**全部**各回一项（i 从 0 到 ' + (list.length - 1) + '，不能少、不能多）。')
  for (const p of list) {
    const shared = (p.shared || []).map(function (x) { return '`' + x + '`' }).join('、')
    L.push('')
    L.push('### 第 ' + p.i + ' 对（共享实体：' + (shared || '(无)') + '）')
    L.push('[A] 分区：' + (str(p.a && p.a.namespace) || '(无)'))
    L.push(one(p.a && p.a.content, cap))
    L.push('[B] 分区：' + (str(p.b && p.b.namespace) || '(无)'))
    L.push(one(p.b && p.b.content, cap))
  }
  return L.join('\n')
}

// ═══════════════ 4. 解析：脏输入也要稳 ═══════════════

/**
 * 从模型回话里解析判决。**解析不了就返回 null**（绝不猜）。
 * @returns {{i:number,verdict:string,severity:number,why:string}[]|null} 长度恒等于 n
 */
export function parseJudgeReply(text, n) {
  const count = Math.max(0, intOf(n, 0))
  const raw = str(text)
  if (raw.trim() === '') return null

  // ★从**每一个** `[` 位置各试一次★：模型常在数组前先写一句"结果如下："，而那句话里
  //   完全可能带方括号（实测构想过 `[注意]`）—— 只取"第一个 `[`"会当场解析失败，
  //   把一次花钱的调用白白判成失败。取"最后一个 `]`"也是一样的道理。
  function sliceJson(t) {
    const b = t.lastIndexOf(']')
    if (b < 0) return null
    let a = t.indexOf('[')
    while (a >= 0 && a < b) {
      try {
        const v = JSON.parse(t.slice(a, b + 1))
        if (Array.isArray(v)) return v
      } catch (_e) { /* 这个起点不行，试下一个 */ }
      a = t.indexOf('[', a + 1)
    }
    return null
  }

  let arr = null
  // ① 有围栏就**先取围栏里**的内容（全文里的第一个 `[` 可能是正文里的方括号）
  const fence = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(raw)
  if (fence) arr = sliceJson(fence[1])
  // ② 再做全文（纯 JSON / 前后有废话都能中）
  if (arr === null) arr = sliceJson(raw)
  if (arr === null) return null

  const out = new Array(count).fill(null)
  for (const it of arr) {
    if (it === null || it === undefined || typeof it !== 'object') continue
    const i = Number(it.i)
    if (!Number.isInteger(i) || i < 0 || i >= count) continue      // 越界：归不了位，丢掉
    if (out[i] !== null) continue                                   // 同一对回了两遍：取先到的
    const v = str(it.verdict).trim().toLowerCase()
    const verdict = (v === 'contradiction' || v === 'consistent' || v === 'unclear') ? v : 'unclear'
    let sev = Number(it.severity)
    if (sev !== 1 && sev !== 2 && sev !== 3) sev = verdict === 'contradiction' ? 2 : 1
    out[i] = {
      i: i,
      verdict: verdict,
      severity: sev,
      // ★why 只认字符串★：模型回个数字/对象进来就是垃圾，与其把 `123` 当理由摆进台账，
      //   不如明说"它没给理由"（台账要能被人读懂，塞垃圾比留空更坏）。
      why: typeof it.why === 'string' ? one(it.why, 200) : '',
    }
  }
  // 模型漏答的：**如实补 unclear**（不假装它说了 consistent）
  for (let k = 0; k < count; k++) {
    if (out[k] === null) out[k] = { i: k, verdict: 'unclear', severity: 1, why: '（模型没回这一对）' }
  }
  return out
}

// ═══════════════ 5. 判官：一次 LLM 调用 ═══════════════

/**
 * 把 N 对一次性交给模型判。
 * ★**任何失败都变成 {ok:false, error:'人话'}，绝不抛**★ —— 它是被模型工具调的，
 *   抛出去只会让用户看到一坨栈，而"为什么没判成"才是他要知道的。
 */
export async function judgePairs(opts) {
  const o = opts || {}
  const pairs = Array.isArray(o.pairs) ? o.pairs : []
  const res = { ok: false, verdicts: [], usage: null, error: null, replyChars: 0 }

  if (pairs.length === 0) { res.error = '没有可判的对：这些块里没有共享的稀有实体'; return res }

  const llm = o.llm
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    res.error = '拿不到 llm 服务（语义判官只能在 DSH 进程里跑）'
    return res
  }
  const route = o.route || {}
  const provider = str(route.provider)
  const model = str(route.model)
  if (provider === '' || model === '') {
    res.error = '拿不到当前模型（agentDefaultModel 没给出 provider/model）'
    return res
  }

  const prompt = buildJudgePrompt(pairs, { maxCharsPerBlock: o.maxCharsPerBlock })
  // ★默认给足，别抠★：这台模型（reasoningEffort=max）**先"思考"再回答**。
  //   2026-09-14 首次真调实测：maxTokens=1200 时 `reasoningTokens` 正好吃掉 1200、回答 0 字 → 判官失败。
  const maxTokens = clampInt(o.maxTokens, 8000, 100, 32000)
  const timeoutMs = clampInt(o.timeoutMs, 120000, 5000, 900000)

  // 外部给了 signal 就用外部的；否则自己上超时闸（模型挂住时不许把整个会话拖死）
  const own = (o.signal === null || o.signal === undefined)
  const ctl = own && typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl !== null ? setTimeout(function () { try { ctl.abort() } catch (_e) {} }, timeoutMs) : null

  try {
    const messages = [{
      // ★id 与 source 都是必填★（平台契约）：插件自造消息要写明来源
      id: 'semantic-judge-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-memory-palace' },
    }]
    const stream = llm.stream({
      provider: provider,
      model: model,
      messages: messages,
      maxTokens: maxTokens,
      // ★别传 `purpose`★：平台契约里它是 `'compaction' | 'session-title'` 两个字面量的联合，
      //   塞自定义值属于越界用法，可能被适配器校验直接拒掉 —— 而这正是"唯一没验过的那一步"。
      signal: own ? (ctl ? ctl.signal : undefined) : o.signal,
    })

    let text = ''
    let think = ''
    let finishKind = ''
    let failure = null
    for await (const chunk of stream) {
      if (chunk === null || chunk === undefined || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        // ★思考过程单独收着★：它不是答案，但"思考吃掉了全部额度"这种情况必须能说清楚。
        if (typeof chunk.text === 'string') think += chunk.text
      } else if (chunk.type === 'usage') {
        res.usage = chunk.usage === undefined ? null : chunk.usage
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason || {}
        finishKind = str(reason.kind)
        if (reason.kind === 'error') {
          const f = reason.failure || {}
          failure = '模型调用出错：' + str(f.message || f.code || reason.message || '（没给原因）')
        } else if (reason.kind === 'aborted') {
          failure = '模型调用被中断（aborted）'
        }
      }
    }
    res.replyChars = text.length
    res.thinkChars = think.length
    res.finishKind = finishKind
    if (failure !== null) { res.error = failure; return res }

    const verdicts = parseJudgeReply(text, pairs.length)
    if (verdicts === null) {
      const u = res.usage || {}
      const outT = intOf(u.outputTokens, 0)
      const reaT = intOf(u.reasoningTokens, 0)
      // ★把"为什么没回话"说清楚★：空回话 + finish=max-tokens + 思考吃满额度 = 额度给小了，
      //   这跟"模型不听话"是两回事 —— 报告里必须能区分，否则下次还得重新查一遍。
      const starved = text.length === 0 && outT > 0 && reaT >= outT
      res.error = '模型没按 JSON 回话（收到 ' + text.length + ' 字；思考 ' + res.thinkChars + ' 字' +
        '，结束原因 ' + (finishKind || '未知') +
        '，输出 ' + outT + ' token 其中思考 ' + reaT + ' token）' +
        (starved ? '　★判定：**额度被思考吃光了**（回答还没开始就截断）→ 调大 maxTokens 再来★' : '') +
        (text.length > 0 && !starved ? '　原始回话：' + one(text, 120) : '')
      return res
    }
    res.ok = true
    res.verdicts = verdicts
    return res
  } catch (e) {
    res.error = '调用模型失败：' + msgOf(e)
    return res
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// ═══════════════ 6. 扫一遍：读 Vault（只读）→ 配对 → 判 → 原子落文件 ═══════════════

function getService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get !== 'function') return undefined
  try { return ctx.get(name) } catch (_e) { return undefined }
}

/** 读"现在这个模型"。★字段名防御性读取★：以实测为准（provider/model），另兼容常见别名。 */
export function readModelRoute(ctx) {
  const svc = getService(ctx, 'agentDefaultModel')
  if (svc === null || svc === undefined) return null
  let sel = null
  try {
    if (typeof svc.currentSelection === 'function') sel = svc.currentSelection()
    else if (typeof svc.current === 'function') sel = svc.current()
  } catch (_e) { return null }
  if (sel === null || sel === undefined || typeof sel !== 'object') return null
  const provider = str(sel.provider || sel.providerId || sel.providerName)
  const model = str(sel.model || sel.modelId || sel.modelName)
  if (provider === '' || model === '') return null
  return { provider: provider, model: model, reasoningEffort: str(sel.reasoningEffort) }
}

/** 从 Vault **只读**取块。用 dsh-persist 的公开 list()（newest first）—— 不写库、不动语料。 */
async function loadVaultBlocks(memDir) {
  const mod = await import('dsh-persist')
  if (typeof mod.VaultStore !== 'function') throw new Error('dsh-persist 没导出 VaultStore（分叉版本不对？）')
  const store = new mod.VaultStore(memDir)
  try {
    return store.list()
  } finally {
    try { store.db.close() } catch (_e) {}
  }
}

function blockBrief(b) {
  return {
    namespace: str(b.namespace),
    hash: str(b.hash),
    excerpt: one(b.content, 200),      // ★落盘只留 ≤200 字摘录★
  }
}

/** 原子写：写同目录临时文件 → rename 覆盖（读者永远看到完整 JSON，不会读到写一半的） */
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8')
  renameSync(tmp, file)
}

/**
 * 跑一次语义扫描。
 * @param {{ctx?:any, memDir?:string, limit?:number, listBlocks?:Function, llm?:any, route?:any, signal?:any, maxTokens?:number}} opts
 * @returns {Promise<{ok:boolean, model:object|null, scannedBlocks:number, pairs:number, verdicts:object[], outFile:string, wrote:boolean, error:string|null}>}
 */
export async function runSemanticScan(opts) {
  const o = opts || {}
  const memDir = str(o.memDir) !== '' ? str(o.memDir) : join(homedir(), '.dsh-memory')
  const limit = clampInt(o.limit, 8, 1, 200)
  const outFile = join(memDir, 'corrections', 'semantic-latest.json')
  const res = {
    ok: false,
    model: null,
    scannedBlocks: 0,
    pairs: 0,
    verdicts: [],
    contradictions: 0,
    outFile: outFile,
    wrote: false,
    usage: null,
    error: null,
  }

  // ① 取块（只读）
  let blocks = null
  try {
    blocks = typeof o.listBlocks === 'function' ? await o.listBlocks() : await loadVaultBlocks(memDir)
  } catch (e) {
    res.error = '读 Vault 失败：' + msgOf(e)
    return res
  }
  if (!Array.isArray(blocks)) { res.error = 'Vault 没给出块列表（拿到的不是数组）'; return res }

  const picked = blocks.slice(0, limit)     // list() 已经是"最新在前"
  res.scannedBlocks = picked.length
  if (picked.length === 0) { res.error = 'Vault 里一块都没有（先在 DSH 里跑一次记忆同步）'; return res }

  // ② 配对
  //   ★`universe: blocks`（全库）★ —— 只在"最近 limit 块"之间配对，但**稀有度按全库算**。
  //   不这么做的话，`AGENTS.md` 这类到处出现的文件名在候选集里显得稀有 → 配出来的全是没有信息量的对
  //   （2026-09-14 拿真库实测到的：60 块 → 10 对全是「台账⇄台账 共享 agents.md」）。
  const pairs = buildPairs(picked, { maxPairs: 10, universe: blocks })
  res.pairs = pairs.length
  if (pairs.length === 0) {
    res.error = '这 ' + picked.length + ' 块里没有共享稀有实体的（把 limit 调大再试）'
    return res
  }

  // ③ 模型路由
  const route = o.route !== undefined && o.route !== null ? o.route : readModelRoute(o.ctx)
  if (route === null || route === undefined || str(route.provider) === '' || str(route.model) === '') {
    res.error = '拿不到"现在这个模型"：agentDefaultModel.currentSelection() 没给出 provider/model'
    return res
  }
  res.model = { provider: str(route.provider), model: str(route.model) }

  // ④ 判
  const llm = o.llm !== undefined ? o.llm : getService(o.ctx, 'llm')
  const judged = await judgePairs({
    llm: llm,
    route: route,
    pairs: pairs,
    signal: o.signal,
    maxTokens: o.maxTokens,
    maxCharsPerBlock: o.maxCharsPerBlock,
  })
  res.ok = judged.ok
  res.error = judged.ok ? null : judged.error
  res.usage = judged.usage
  res.replyChars = judged.replyChars || 0

  // ⑤ 合并 pair 信息 → verdict（含两块的分区 + ≤200 字摘录 + 共享实体）
  const verdicts = []
  for (const v of (judged.verdicts || [])) {
    const p = pairs[v.i]
    if (p === undefined) continue
    verdicts.push({
      i: v.i,
      verdict: v.verdict,
      severity: v.severity,
      why: v.why,
      shared: (p.shared || []).slice(0, 8),
      a: blockBrief(p.a),
      b: blockBrief(p.b),
    })
  }
  res.verdicts = verdicts
  res.contradictions = verdicts.filter(function (v) { return v.verdict === 'contradiction' }).length

  // ⑥ 落文件（**成败都写**：失败也要让状态路由看得见"上次没成 + 为什么"）
  const payload = {
    at: new Date().toISOString(),
    model: res.model,
    scanned: res.scannedBlocks,
    pairs: res.pairs,
    ok: res.ok,
    error: res.error,
    contradictions: res.contradictions,
    usage: res.usage,
    verdicts: verdicts,
  }
  try {
    writeJsonAtomic(outFile, payload)
    res.wrote = true
  } catch (e) {
    res.wrote = false
    const w = '结果没落盘：' + msgOf(e)
    res.error = res.error === null ? w : res.error + '；' + w
  }
  return res
}
