import { createRequire } from "node:module";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
//#region src/memory-store.ts
/**
* MemoryStore: file-backed persistent memory for DeepSeek Harness agents.
*
* Storage layout (Plan A from the course: plain file):
*   <root>/memory.json   — one JSON object: { [key]: { content, createdAt, updatedAt } }
*
* The file is append-replaced atomically (write temp + rename) so a crash
* never leaves a half-written memory file.
*/
/** Warn about a corrupt backup only once per process (avoids log spam on repeated reads). */
let corruptWarned = false;
/**
* File-backed memory store.
*
* Implements the four verbs the tool exposes: get / set / delete / list.
* All methods are synchronous and read the file fresh (simple; fine for a
* first version — the course's "Plan A: plain file").
*/
var MemoryStore = class {
	file;
	constructor(root) {
		const base = root ?? join(homedir(), ".dsh-memory");
		this.file = join(base, "memory.json");
		if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), {
			recursive: true,
			mode: 448
		});
	}
	/** Read the whole map; missing/corrupt file returns {} (never throws). */
	read() {
		try {
			const raw = readFileSync(this.file, "utf8");
			const parsed = JSON.parse(raw);
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			try {
				const backup = `${this.file}.corrupt-${Date.now()}`;
				renameSync(this.file, backup);
				if (!corruptWarned) {
					corruptWarned = true;
					console.warn(`dsh-memory: ${this.file} was corrupt — backed up to ${backup} and reset to empty`);
				}
			} catch {}
			return {};
		}
	}
	/**
	* Atomically write the whole map (unique temp + rename). Concurrent writers
	* never collide on one .tmp name; a failed rename cleans the temp up.
	* NOTE: read-modify-write (set/delete) is atomic only within one process —
	* JavaScript's single thread makes synchronous methods non-interleaving.
	* Multiple PROCESSES sharing one memory.json are not synchronized (not a
	* supported deployment; DSH runs one host process).
	*/
	write(map) {
		const tmp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 384 });
		try {
			renameSync(tmp, this.file);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {}
			throw error;
		}
	}
	/** Get one memory entry by key. */
	get(key) {
		return this.read()[key];
	}
	/** Set (create or update) one memory entry. */
	set(key, content) {
		const map = this.read();
		const now = Date.now();
		const entry = {
			content,
			createdAt: map[key]?.createdAt ?? now,
			updatedAt: now
		};
		map[key] = entry;
		this.write(map);
		return entry;
	}
	/** Delete one memory entry; returns whether it existed. */
	delete(key) {
		const map = this.read();
		if (!(key in map)) return false;
		delete map[key];
		this.write(map);
		return true;
	}
	/** List all keys. */
	keys() {
		return Object.keys(this.read());
	}
	/** All entries as key → entry pairs, from ONE file read (avoids N+1 reads). */
	all() {
		const map = this.read();
		return Object.keys(map).map((key) => ({
			key,
			content: map[key].content
		}));
	}
	/** Get the absolute path of the memory file (for the user's information). */
	path() {
		return this.file;
	}
};
//#endregion
//#region src/profile-store.ts
/**
* ProfileStore: the "Builtin" memory layer (course Plan C, layer ①).
*
* Mirrors the Hermes Builtin design: two small Markdown files that are
* injected into the system prompt every turn.
*
*   <root>/USER.md    — user profile (identity, preferences, habits)
*   <root>/MEMORY.md  — environment facts, learning progress, behavior rules
*
* Both files are plain Markdown so a human can read and edit them directly.
* This layer is the FASTEST memory: no search, no vectors — just file reads.
*/
const DEFAULT_USER = `# 用户画像

## 身份
- （你是谁？如：学生）

## 偏好
- （你的偏好，如：喜欢简洁的回复）

## 习惯
- （你的习惯，如：用空格缩进）
`;
const DEFAULT_MEMORY = `# 长期记忆

## 环境事实
- （服务器配置、工具链等）

## 学习进度
- （当前课程、进度）

## 行为规则
- （给 agent 的规则，如：免费优先）
`;
/**
* File-backed profile store. Read/write whole files; a missing file starts
* from a sensible default template so the first injection is never empty.
*/
var ProfileStore = class {
	root;
	constructor(root) {
		this.root = root ?? join(homedir(), ".dsh-memory");
	}
	fileFor(kind) {
		return join(this.root, kind === "user" ? "USER.md" : "MEMORY.md");
	}
	/** Read a profile file; missing file returns the default template. */
	read(kind) {
		const file = this.fileFor(kind);
		if (!existsSync(file)) {
			const template = kind === "user" ? DEFAULT_USER : DEFAULT_MEMORY;
			if (!existsSync(this.root)) mkdirSync(this.root, {
				recursive: true,
				mode: 448
			});
			writeFileSync(file, template, { mode: 384 });
			return template;
		}
		try {
			return readFileSync(file, "utf8");
		} catch {
			return "";
		}
	}
	/** Overwrite a profile file with new content. */
	write(kind, content) {
		if (!existsSync(this.root)) mkdirSync(this.root, {
			recursive: true,
			mode: 448
		});
		writeFileSync(this.fileFor(kind), content, { mode: 384 });
	}
	/**
	* Parse a profile file into its `## heading` sections. Used by the tool so
	* the model can see a structured view instead of raw Markdown.
	*/
	sections(kind) {
		const text = this.read(kind);
		const result = [];
		let current;
		for (const line of text.split("\n")) {
			const heading = /^##\s+(.+)$/.exec(line.trim());
			if (heading) {
				current = {
					heading: heading[1],
					lines: []
				};
				result.push(current);
			} else if (current !== void 0) {
				const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
				if (bullet) current.lines.push(bullet[1]);
			}
		}
		return result;
	}
};
//#endregion
//#region src/embedder.ts
/**
* Embedder: turns memory text into vectors. Two modes, both controlled at
* runtime by ~/.dsh-memory/embedder.json — re-read on every call (cached by
* mtime), so the settings page takes effect immediately, no restart.
*
*   local → Ollama's NATIVE /api/embeddings. Its per-request `options`
*           { num_gpu, main_gpu, num_ctx } are how the settings page steers
*           "which device / how much context" without touching the server env.
*   cloud → any OpenAI-compatible /v1/embeddings (SiliconFlow bge-m3 default).
*
* Config fields (file > env > default, resolved per field):
*   mode      "local" | "cloud"                       default cloud
*   endpoint  local: Ollama base URL                  default http://127.0.0.1:11434
*             cloud: full /v1/embeddings URL          default SiliconFlow
*   model                                             default qwen3-embedding:0.6b / BAAI/bge-m3
*   key       cloud only (env DSH_MEMORY_EMBED_KEY / SILICONFLOW_API_KEY)
*   device    local only: "auto" | "cpu" | GPU index  → num_gpu / main_gpu
*   numCtx    local only: context length              default 1024
*
* Graceful degradation: on any failure embed() returns null and callers fall
* back to keyword matching. A missing embedding must never crash the agent.
*/
function readEmbedderFile() {
	const filePath = join(homedir(), ".dsh-memory", "embedder.json");
	try {
		const st = statSync(filePath);
		return { mtimeMs: st.mtimeMs, size: st.size, cfg: JSON.parse(readFileSync(filePath, "utf8")) ?? {} };
	} catch {
		return { mtimeMs: 0, cfg: {} };
	}
}
/** mtime-keyed cache so hot paths don't re-read the file on every embedding. */
let embedderCache = null;
function resolveEmbedder() {
	const file = readEmbedderFile();
	/**
	* Cache key = 配置文件的 mtime + 文件大小 + 那几个环境变量。
	* ★ 2026-09-11 修正：原先只拿 mtime 当键，有两个洞 ——
	*   ① 配置文件【不存在】时 mtime 恒为 0，改了 DSH_MEMORY_EMBED_* 也照样返回缓存里的旧结果；
	*   ② 同一毫秒内连写两次配置（mtime 相同）后者看不见。加 envKey 与 size 各堵一个。
	*   两个洞都是回归测试抓到的，不是我事后想到的。
	*/
	const envKey = `${process.env.DSH_MEMORY_EMBED_MODE || ""}|${process.env.DSH_MEMORY_EMBED_ENDPOINT || ""}|${process.env.DSH_MEMORY_EMBED_MODEL || ""}|${process.env.DSH_MEMORY_EMBED_KEY || ""}|${process.env.SILICONFLOW_API_KEY || ""}`;
	const cacheKey = `${file.mtimeMs}|${file.size}|${envKey}`;
	if (embedderCache !== null && embedderCache.cacheKey === cacheKey) return embedderCache.resolved;
	const c = file.cfg;
	const isLocal = String(c.mode || process.env.DSH_MEMORY_EMBED_MODE || "cloud").toLowerCase() === "local";
	const endpoint = String(c.endpoint || process.env.DSH_MEMORY_EMBED_ENDPOINT || (isLocal ? "http://127.0.0.1:11434" : "https://api.siliconflow.cn/v1/embeddings")).replace(/\/+$/, "");
	const model = String(c.model || process.env.DSH_MEMORY_EMBED_MODEL || (isLocal ? "qwen3-embedding:0.6b" : "BAAI/bge-m3"));
	const rawKey = String(c.key || process.env.DSH_MEMORY_EMBED_KEY || process.env.SILICONFLOW_API_KEY || "");
	const numCtx = Number(c.numCtx) > 0 ? Math.floor(Number(c.numCtx)) : 1024;
	const resolved = {
		mode: isLocal ? "local" : "cloud",
		isLocal,
		endpoint,
		model,
		// A local Ollama needs no key; keep it non-empty so the old `apiKey === ""` guard passes.
		key: isLocal ? "local" : rawKey,
		device: c.device === undefined || c.device === null ? "auto" : String(c.device),
		numCtx,
		/**
		* Vectors only rank against queries carrying the same fingerprint: two
		* models can share a dimension (bge-m3 and qwen3-embedding are both 1024),
		* so a length check alone would silently rank unrelated spaces.
		*/
		fingerprint: (isLocal ? "local:" : "cloud:") + endpoint + "|" + model
	};
	embedderCache = { cacheKey, resolved };
	return resolved;
}
/** Small in-memory cache keyed by exact text — repeated queries share vectors. */
const cache = /* @__PURE__ */ new Map();
/** Cache bound: each vector is ~4KB, so cap the map to avoid unbounded growth. */
const MAX_CACHE = 500;
function cacheSet(text, vector) {
	if (cache.size >= MAX_CACHE) {
		const oldest = cache.keys().next().value;
		if (oldest !== void 0) cache.delete(oldest);
	}
	cache.set(text, vector);
}
/**
* Embed a list of texts. Returns Promise of arrays aligned with `texts`, or
* null when unavailable (not configured / network error / non-200).
*
* Config is re-resolved on every call, so a settings change applies to the
* very next embedding without restarting DSH.
*/
async function embed(texts) {
	if (texts.length === 0) return [];
	const emb = resolveEmbedder();
	if (!emb.isLocal && emb.key === "") return null;
	const cached = texts.map((t) => cache.get(t));
	const missing = [];
	for (let i = 0; i < texts.length; i++) if (cached[i] === void 0) missing.push(i);
	if (missing.length === 0) return cached;
	const toFetch = missing.map((i) => texts[i]);
	/**
	* ★2026-09-16 修：结果按【顺序就地收集】★
	* 以前结尾是 `texts.map((t) => cache.get(t))`，而 cache 上限只有 MAX_CACHE=500 条：
	* 一次要嵌 >500 条时，先嵌的会被后面挤掉 → out 里出现 undefined → **整个调用返回 null**
	* （症状：整批入库全是空向量、embedded=0，且不报错）。本会话用 872 块真档案当场踩到。
	* 现在 fet[missing[k]] 直接拿走刚取回的向量，不再经过缓存。
	*/
	const fetched = new Array(missing.length);
	try {
		if (emb.isLocal) {
			/**
			* ★2026-09-16 改批量（用户拍板 A）★ 原写法"一条一个请求"：1101 块 = 1101 趟往返。
			* `/api/embed` 的 input 收数组，且同样支持 options 与 keep_alive（旧注释"只有 native
			* 端点收 options"已过时；官方把 `/api/embeddings` 标为 superseded）。
			* 实测（互不相同的真文本，~450 字）：慢卡 261 → 239 ms/条；快卡 34 → 19.8 ms/条。
			* BATCH_MAX=32：慢卡一批 32 条约 7.7 秒，离 60 秒超时留足余量。
			* 老端点【保留为兜底】：/api/embed 不可用（老 Ollama）或返回形状不对时逐条退回。
			*/
			const options = { num_ctx: emb.numCtx };
			if (emb.device === "cpu") options.num_gpu = 0;
			else if (emb.device !== "" && emb.device !== "auto") {
				const idx = Number(emb.device);
				if (Number.isInteger(idx) && idx >= 0) options.main_gpu = idx;
			}
			const BATCH_MAX = 32;
			for (let start2 = 0; start2 < toFetch.length; start2 += BATCH_MAX) {
				const slice = toFetch.slice(start2, start2 + BATCH_MAX);
				let batched = false;
				try {
					const res = await fetch(`${emb.endpoint}/api/embed`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: emb.model, input: slice, options }),
						signal: AbortSignal.timeout(6e4)
					});
					if (res.ok) {
						const json = await res.json();
						const out = json && json.embeddings;
						if (Array.isArray(out) && out.length === slice.length && out.every(function (v) { return Array.isArray(v) && v.length > 0; })) {
							for (let i = 0; i < slice.length; i++) {
								fetched[start2 + i] = out[i];
								cacheSet(slice[i], out[i]);
							}
							batched = true;
						}
					}
				} catch (_e) {}
				if (batched) continue;
				for (let i = 0; i < slice.length; i++) {
					const text = slice[i];
					const res = await fetch(`${emb.endpoint}/api/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: emb.model, prompt: text, options }),
						signal: AbortSignal.timeout(6e4)
					});
					if (!res.ok) return null;
					const json = await res.json();
					if (!Array.isArray(json.embedding) || json.embedding.length === 0) return null;
					fetched[start2 + i] = json.embedding;
					cacheSet(text, json.embedding);
				}
			}
		} else {
			const res = await fetch(emb.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${emb.key}`
				},
				body: JSON.stringify({
					model: emb.model,
					input: toFetch
				}),
				signal: AbortSignal.timeout(6e4)
			});
			if (!res.ok) return null;
			const json = await res.json();
			for (const item of json.data) {
				fetched[item.index] = item.embedding;
				cacheSet(toFetch[item.index], item.embedding);
			}
		}
		const result = cached.slice();
		for (let k = 0; k < missing.length; k++) result[missing[k]] = fetched[k];
		return result.some((v) => v === void 0) ? null : result;
	} catch {
		return null;
	}
}
/** Whether the embedder is usable (useful for the tool to report status). */
function isConfigured() {
	const emb = resolveEmbedder();
	return emb.isLocal || emb.key !== "";
}
/** Cosine similarity between two vectors; returns 0 on empty input. */
function cosine(a, b) {
	if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
//#endregion
//#region src/vault-store.ts
/**
* SQLite-backed semantic memory store. `node:sqlite` is synchronous, so all
* methods are sync except add()/search() which need async embedding.
*/
var VaultStore = class {
	/** The memory root this store was opened on (default ~/.dsh-memory). */
	root;
	db;
	constructor(root) {
		const base = root ?? join(homedir(), ".dsh-memory");
		this.root = base;
		if (!existsSync(base)) mkdirSync(base, {
			recursive: true,
			mode: 448
		});
		const { DatabaseSync: Sync } = createRequire(import.meta.url)("node:sqlite");
		this.db = new Sync(join(base, "vault.db"));
		try {
			chmodSync(join(base, "vault.db"), 384);
		} catch {}
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT 'default',
        vector BLOB NOT NULL,
        createdAt INTEGER NOT NULL,
        fingerprint TEXT NOT NULL DEFAULT ''
      )
    `);
		try {
			const cols = this.db.prepare("PRAGMA table_info(memos)").all().map((c) => c.name);
			if (!cols.includes("fingerprint")) this.db.exec("ALTER TABLE memos ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
		} catch {}
		// ★2026-09-16 混合检索（FTS5 关键词通道）★ memos_fts 是 memos 的**派生索引**，
		//   任何时刻都能从 memos 全量重建（纯 SQL、不需要嵌入）。建表失败不致命：
		//   检索退回纯语义并把状态标出来（**不静默**）。
		this.ftsOk = false;
		try {
			this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(content, tokenize='trigram')");
			this.ftsOk = true;
		} catch (e) {
			console.warn("[dsh-persist] FTS5 建表失败（检索退回纯语义）：" + (e && e.message));
		}
	}
	encodeFloatArray(v) {
		const buf = Buffer.alloc(v.length * 4);
		for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
		return buf;
	}
	decodeFloatArray(buf) {
		const b = Buffer.from(buf);
		const v = [];
		for (let i = 0; i < b.length; i += 4) v.push(b.readFloatLE(i));
		return v;
	}
	/** Store a memory with its vector. Call add() for the embedding+store path. */
	insert(content, namespace, vector, createdAt) {
		const result = this.db.prepare("INSERT INTO memos (content, namespace, vector, createdAt, fingerprint) VALUES (?, ?, ?, ?, ?)").run(content, namespace, this.encodeFloatArray(vector), createdAt, resolveEmbedder().fingerprint);
		const newId = Number(result.lastInsertRowid);
		this.ftsIndexRow(newId, content);   // ★同一条写路径里同步派生索引★
		return newId;
	}
	/**
	* Add a memory. Returns `{ id, embedded }` — `embedded: false` when the
	* embedder was unavailable and a zero vector was stored (text survives for
	* keyword search, but won't rank in semantic search until re-embedded).
	*/
	async add(content, namespace = "default") {
		const vectors = await embed([content]);
		const createdAt = Date.now();
		let id;
		if (vectors === null || vectors[0].length === 0) id = this.insert(content, namespace, [], createdAt);
		else id = this.insert(content, namespace, vectors[0], createdAt);
		this.syncVaultMd();
		return {
			id,
			embedded: vectors !== null && vectors[0].length > 0
		};
	}
/**
* ★2026-09-16 新增（用户拍板 A+C）★ 一次加一批，专给"整段先清后写"的入档路径用：
*   · 嵌入走批量（见 embed()：/api/embed 一次一串）；
*   · 所有 INSERT 在一个事务里（node:sqlite 没有 transaction() 助手 → 手动 BEGIN/COMMIT）。
*     synchronous=FULL 下每行单独提交就是一次 fsync，实测 7.2 ms/行；
*   · ★vault.md 镜像整批结束只写一次★ —— 原来 add() 每块都重渲染整库再写盘，
*     实测 10.2 ms/块，1101 块 ≈ 11 秒纯浪费（镜像本来就是可再生的）。
* 返回与入参等长、**保持顺序**的 [{ id, embedded }]（调用方按顺序建块）。
*/
async addMany(contents, namespace = "default") {
	const list = Array.isArray(contents) ? contents : [contents];
	if (list.length === 0) return [];
	const vectors = await embed(list);
	const createdAt = Date.now();
	const out = [];
	this.db.exec("BEGIN");
	try {
		for (let i = 0; i < list.length; i++) {
			const v = vectors === null ? [] : vectors[i] || [];
			const id = v.length === 0 ? this.insert(list[i], namespace, [], createdAt) : this.insert(list[i], namespace, v, createdAt);
			out.push({ id, embedded: v.length > 0 });
		}
		this.db.exec("COMMIT");
	} catch (e) {
		try { this.db.exec("ROLLBACK"); } catch (_e2) {}
		throw e;
	}
	this.syncVaultMd();
	return out;
}

	// ═══ ★2026-09-16 混合检索辅助★（纯 SQLite 进程内：零网络、零 GPU、零模型） ═══
	/** 查询串 → 检索词：ASCII 标识符（文件名/常量/版本号）+ 中文 4 字窗。全是实测调出来的。 */
	ftsTerms(query) {
		const out = [];
		const q = String(query || "");
		for (const m of q.matchAll(/[A-Za-z0-9][A-Za-z0-9_.\-]{2,}/g)) out.push(m[0]);
		const clean = q.replace(/[A-Za-z0-9][A-Za-z0-9_.\-]*/g, " ");
		for (const seg of clean.split(/[\s，。？！：；、（）()「」【】·\/\\\[\]{}<>=+|,.:;!?~\u2014-]+/)) {
			for (const run of (seg.match(/[\u4e00-\u9fff]+/g) || [])) {
				if (run.length <= 6) { if (run.length >= 3) out.push(run); }
				else for (let i = 0; i + 4 <= run.length; i += 2) out.push(run.slice(i, i + 4));
			}
		}
		return [...new Set(out.map((s) => s.trim()).filter((s) => s.length >= 3))].slice(0, 14);
	}
	/** FTS5 短语消毒：原样把用户串丢给 MATCH 会抛（`.` `-` `(` 都是查询语法字符）→ 整串短语化。 */
	ftsQuote(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
	/** 关键词通道：逐词检索 + 逐词 RRF + 词频阻尼（命中面越宽的语气词越不值钱）。 */
	ftsRank(query, limit = 50) {
		const total = Number(this.db.prepare("SELECT COUNT(*) AS c FROM memos").get().c) || 0;
		if (total === 0) return [];
		const acc = new Map();
		// ★词频（DF）必须用精确 COUNT 统计★：原来拿 `hits.length`（被 LIMIT 50 封顶）当词频 →
		//   `DSH`/`PPT`/`voice` 这类超宽词永远"看起来只有 50 命中"，过滤形同虚设，
		//   结果是 RRF **拆东墙补西墙**（实测：精确串 6/6 但会话卡 5/8→4/8，合计不变）。
		//   换成精确 DF + 5% 上限后实测：精确串 6/6、会话卡 6/8、合计 20/24→22/24（双赢）。
		const cap = Math.max(20, Math.floor(total * 0.05));
		for (const t of this.ftsTerms(query)) {
			let df = 0;
			try { df = Number(this.db.prepare("SELECT COUNT(*) AS c FROM memos_fts WHERE memos_fts MATCH ?").get(this.ftsQuote(t)).c); } catch (_e) { continue; }
			if (df === 0 || df > cap) continue;
			let hits = [];
			try { hits = this.db.prepare("SELECT rowid FROM memos_fts WHERE memos_fts MATCH ? ORDER BY bm25(memos_fts) LIMIT ?").all(this.ftsQuote(t), limit); } catch (_e) { continue; }
			if (hits.length === 0) continue;
			const idf = Math.log(1 + total / df);
			for (let i = 0; i < hits.length; i++) {
				const k = Number(hits[i].rowid);
				const p = acc.get(k) || { score: 0, n: 0 };
				acc.set(k, { score: p.score + idf / (60 + i), n: p.n + 1 });
			}
		}
		return [...acc.entries()].map(([id, v]) => ({ id, score: v.score, terms: v.n }))
			.sort((a, b) => (b.terms - a.terms) || (b.score - a.score)).slice(0, limit);
	}
	/** 派生索引自愈：行数不一致就全量重建（只跑 SQL）。 */
	ftsEnsure() {
		if (this.ftsOk !== true) return false;
		try {
			const a = Number(this.db.prepare("SELECT COUNT(*) AS c FROM memos").get().c);
			const b = Number(this.db.prepare("SELECT COUNT(*) AS c FROM memos_fts").get().c);
			if (a !== b) this.ftsRebuild();
		} catch (_e) { this.ftsOk = false; }
		return true;
	}
	ftsRebuild() {
		try {
			this.db.exec("BEGIN");
			this.db.exec("DELETE FROM memos_fts");
			const rows = this.db.prepare("SELECT id, content FROM memos").all();
			const ins = this.db.prepare("INSERT INTO memos_fts(rowid, content) VALUES (?, ?)");
			for (const r of rows) ins.run(Number(r.id), String(r.content));
			this.db.exec("COMMIT");
		} catch (e) {
			try { this.db.exec("ROLLBACK"); } catch (_e2) {}
			console.warn("[dsh-persist] FTS 索引重建失败（检索退回纯语义）：" + (e && e.message));
			this.ftsOk = false;
		}
	}
	ftsIndexRow(id, content) {
		if (this.ftsOk !== true) return;
		try { this.db.prepare("INSERT INTO memos_fts(rowid, content) VALUES (?, ?)").run(Number(id), String(content)); } catch (_e) {}
	}
	ftsDropRow(id) {
		if (this.ftsOk !== true) return;
		try { this.db.prepare("DELETE FROM memos_fts WHERE rowid = ?").run(Number(id)); } catch (_e) {}
	}
	/** ★2026-09-17 过时降权用★：库里出现过的最大「阶段N」；按行数缓存，行数变了才重算。 */
	phaseNmax(rows) {
		const key = rows.length;
		if (this._phaseCache !== void 0 && this._phaseCache.key === key) return this._phaseCache.n;
		let mx = 0;
		for (const r of rows) {
			const re = /阶段\s*(\d{1,3})/g;
			const s = String(r.content || "");
			let m;
			while ((m = re.exec(s)) !== null) { const n = Number(m[1]); if (n > mx && n < 1000) mx = n; }
		}
		this._phaseCache = { key: key, n: mx };
		return mx;
	}
	/** Semantic search: embed query, cosine rank, top-k. Empty embeddings → keyword fallback. */
	async search(query, topK = 5, namespace, minScore = 0) {
		const rows = this.db.prepare("SELECT id, content, namespace, vector, createdAt, fingerprint FROM memos").all();
		if (rows.length === 0) return [];
		const queryVec = (await embed([query]))?.[0];
		const semanticAble = isConfigured() && queryVec !== void 0 && queryVec.length > 0;
		const normQuery = query.trim().toLowerCase();
		const matchesNamespace = (rowNs) => namespace === void 0 ? true : typeof namespace === "string" ? rowNs === namespace : namespace.includes(rowNs);
		const scored = [];
		let staleCount = 0;
		const activeFp = resolveEmbedder().fingerprint;
		for (const r of rows) {
			const row = r;
			if (!matchesNamespace(row.namespace)) continue;
			const vec = this.decodeFloatArray(row.vector);
			const sameEmbedder = String(row.fingerprint ?? "") === activeFp;
			if (semanticAble && vec.length > 0 && !sameEmbedder) staleCount++;
			if (semanticAble && sameEmbedder && vec.length > 0) {
				// ★2026-09-16★ minScore **不在这里丢**：过滤挪到末尾按"通道"决定，
				//   这样关键词通道捞回来的块能带**真实余弦**进结果，不被语义阈值挡在门外。
				scored.push({
					id: row.id,
					content: row.content,
					namespace: row.namespace,
					createdAt: row.createdAt,
					score: cosine(queryVec, vec),
					via: "semantic"
				});
			} else if (normQuery !== "" && row.content.toLowerCase().includes(normQuery)) scored.push({
				id: row.id,
				content: row.content,
				namespace: row.namespace,
				createdAt: row.createdAt,
				score: 1,
				via: "keyword"
			});
		}
		if (staleCount > 0 && this.warnedStaleEmbedder !== true) {
			this.warnedStaleEmbedder = true;
			console.warn(`[dsh-persist] ${staleCount} vault entr${staleCount === 1 ? "y was" : "ies were"} embedded by a different model than the one active now (${activeFp}); they rank by keyword only until re-embedded.`);
		}
		scored.sort((a, b) => b.score - a.score);
		// ═══ ★2026-09-17 排序策略（**只挪名次、不删数据**，各自可关）★ ═══
		//   ① 目录层加成（**默认开，1.2**）：会话卡问"上次/哪次"时该先于③层档案。
		//      实测（真尺子，×1.2）：卡组 6/8→**8/8**、可用性 10/10、历史 5/5、精确串 6/6 全达标；
		//      ×1.5 起会伤"按意抽查"组（10/10→8/10），所以甜点是 1.2~1.3。MEMORY_CARD_BOOST=1 即关。
		//   ② 过时降权（**默认关 —— 实测它是负收益，别开**）：块里写着「阶段n」的按 0.98^(nmax−n) 后退。
		//      ★为什么关★：它把**精确串组从 6/6 打到 5/6** —— 问"阶段42 那次切块器改了什么"时，
		//      恰好是那个块被自己降权了（我原以为"关键词通道会顶上来"，实测顶不住）。
		//      要开它，先得有一把能**量出它好处**的尺子（"现状型"问法，如"现在的检索可用性是多少"），
		//      现在这把尺子还没有 → 于是先关着、保留代码。MEMORY_STALE_DEMOTE=1 可临时开。
		//   两者只乘在**排序键**上：score 仍是真实余弦、下游 minScore 语义不变。
		const CARD_BOOST = Number((typeof process !== "undefined" && process.env && process.env.MEMORY_CARD_BOOST) || "1.2") || 1;
		const STALE_ON = String((typeof process !== "undefined" && process.env && process.env.MEMORY_STALE_DEMOTE) || "0") !== "0";
		const nmax = STALE_ON ? this.phaseNmax(rows) : 0;
		const boostOf = (h) => {
			let k = 1;
			if (CARD_BOOST > 1 && h.namespace === "会话" && /^\s*##\s*会话卡\s/.test(String(h.content || ""))) k *= CARD_BOOST;
			if (nmax > 0) {
				const m = /阶段\s*(\d{1,3})/.exec(String(h.content || ""));
				if (m !== null) { const n = Number(m[1]); if (n > 0 && n < nmax) k *= Math.pow(0.98, nmax - n); }
			}
			return k;
		};
		const kwRank = (id) => (typeof id === "number" ? id : Number(id));
		// ═══ ★2026-09-16 混合检索★：语义 ＋ FTS5 关键词，用 RRF **只改名次** ═══
		//   score 仍是**真实余弦**（不编分）→ 下游 minScore 语义不变、注入块上的 [0.65] 还是真数。
		const hybridOn = String((typeof process !== "undefined" && process.env && process.env.MEMORY_HYBRID) || "1") !== "0";
		if (hybridOn && this.ftsOk === true) {
			try {
				this.ftsEnsure();
				const kw = this.ftsRank(query, 50);
				if (kw.length > 0 && scored.length > 0) {
					const RRF_K = 60, KW_W = 0.5;
					const rrf = new Map();
					scored.forEach((h, i) => rrf.set(Number(h.id), (rrf.get(Number(h.id)) || 0) + 1 / (RRF_K + i)));
					kw.forEach((h, i) => rrf.set(h.id, (rrf.get(h.id) || 0) + KW_W / (RRF_K + i)));
					const kwIds = new Set(kw.map((h) => h.id));
					const pool = new Map();
					for (const h of scored) pool.set(Number(h.id), h);
					for (const h of kw) {
						if (pool.has(h.id)) continue;
						const row = rows.find((x) => Number(x.id) === h.id);
						if (!row || !matchesNamespace(row.namespace)) continue;
						const vec = this.decodeFloatArray(row.vector);
						const same = String(row.fingerprint ?? "") === activeFp;
						pool.set(h.id, {
							id: row.id, content: row.content, namespace: row.namespace, createdAt: row.createdAt,
							score: (semanticAble && same && vec.length > 0) ? cosine(queryVec, vec) : 0,
							via: "keyword"
						});
					}
					return [...pool.values()]
						.filter((h) => kwIds.has(Number(h.id)) || h.via === "keyword" || h.score >= minScore)
						.sort((a, b) => ((rrf.get(kwRank(b.id)) || 0) * boostOf(b)) - ((rrf.get(kwRank(a.id)) || 0) * boostOf(a)) || (b.score - a.score))
						.slice(0, topK);
				}
			} catch (e) {
				console.warn("[dsh-persist] 关键词通道异常，本次退回纯语义：" + (e && e.message));
			}
		}
		return scored
			.filter((h) => h.via === "keyword" || h.score >= minScore)   // ★过滤用**原始分**★，不让加成把不合格的块放进来
			.map((h) => ({ h: h, k: h.score * boostOf(h) }))
			.sort((x, y) => y.k - x.k)
			.map((x) => x.h)
			.slice(0, topK);
	}
	/** Delete a memory by id; returns whether it existed. */
	delete(id) {
		const r = this.db.prepare("DELETE FROM memos WHERE id = ?").run(id);
		if (Number(r.changes) > 0) { this.ftsDropRow(id); this.syncVaultMd(); }
		return Number(r.changes) > 0;
	}
	/** Count of memories (optionally within a namespace). */
	count(namespace) {
		if (namespace !== void 0) {
			const r = this.db.prepare("SELECT COUNT(*) AS c FROM memos WHERE namespace = ?").get(namespace);
			return Number(r.c);
		}
		const r = this.db.prepare("SELECT COUNT(*) AS c FROM memos").get();
		return Number(r.c);
	}
	/** List all memories (optionally within a namespace), newest first. */
	list(namespace) {
		return (namespace !== void 0 ? this.db.prepare("SELECT id, content, namespace, createdAt FROM memos WHERE namespace = ? ORDER BY createdAt DESC").all(namespace) : this.db.prepare("SELECT id, content, namespace, createdAt FROM memos ORDER BY createdAt DESC").all()).map((r) => {
			const row = r;
			return {
				id: row.id,
				content: row.content,
				namespace: row.namespace,
				createdAt: row.createdAt
			};
		});
	}
	/**
	* Export all memories as human-readable, hand-editable Markdown. This is the
	* "readable and editable" face of the Vault: the file is the source of truth
	* for humans, and importMarkdown() re-syncs it back into SQLite.
	*
	* Format:
	*   ## [id] namespace: <ns>
	*   - <content line 1>
	*   - <content line 2>
	*/
	exportMarkdown() {
		const entries = this.list();
		if (entries.length === 0) return "# Vault 记忆（空）\n";
		const lines = ["# Vault 记忆（可读可改：改完用 vault import 同步回数据库）\n"];
		for (const e of entries) {
			lines.push(`## [${e.id}] namespace: ${e.namespace}\n`);
			for (const line of e.content.split("\n")) lines.push(`- ${line}\n`);
			lines.push("\n");
		}
		return lines.join("");
	}
	/**
	* Parse the export Markdown format back into entries. Returns parsed
	* `{ id, namespace, content }[]` — ids that already exist are updated,
	* new ones are inserted. Does NOT embed; callers re-embed afterwards.
	*/
	static parseMarkdown(text) {
		const result = [];
		let current;
		for (const rawLine of text.split("\n")) {
			const header = /^##\s+\[(\d+)\]\s+namespace:\s*(\S+)\s*$/.exec(rawLine.trim());
			if (header) {
				if (current !== void 0) result.push({
					...current,
					content: current.lines.join("\n")
				});
				current = {
					id: Number(header[1]),
					namespace: header[2],
					lines: []
				};
			} else if (current !== void 0) {
				const bullet = /^[-*]\s+(.*)$/.exec(rawLine.trim());
				if (bullet) current.lines.push(bullet[1]);
			}
		}
		if (current !== void 0) result.push({
			...current,
			content: current.lines.join("\n")
		});
		return result;
	}
	/**
	* Sync entries parsed from Markdown into the DB: existing ids are updated in
	* place (vector re-embedded, createdAt preserved), new entries are inserted,
	* and rows whose id vanished from the file are deleted (the file is the
	* source of truth). Returns the number of rows written.
	*
	* Data-loss guard: an id-less parse usually means a hand-edited or truncated
	* vault.md, NOT an intentional wipe. When the DB is non-empty and the import
	* contains no ids at all, the caller must pass `confirmClear: true` or the
	* import is refused with an error (nothing is deleted).
	*/
	async importEntries(entries, opts = {}) {
		const importedIds = entries.filter((e) => e.id !== void 0).map((e) => e.id);
		if (importedIds.length === 0) {
			const count = this.count();
			if (count > 0 && opts.confirmClear !== true) throw new Error(`import produced no ids but the vault has ${count} entries — refusing to clear it; pass confirmClear: true to wipe`);
		}
		const vectors = await embed(entries.map((e) => e.content));
		if (importedIds.length === 0) this.db.exec("DELETE FROM memos");
		let written = 0;
		entries.forEach((entry, index) => {
			const vector = vectors !== null && vectors[index].length > 0 ? vectors[index] : [];
			if (entry.id !== void 0) {
				if (this.db.prepare("SELECT createdAt FROM memos WHERE id = ?").get(entry.id) !== void 0) {
					this.db.prepare("UPDATE memos SET content = ?, namespace = ?, vector = ?, fingerprint = ? WHERE id = ?").run(entry.content, entry.namespace, this.encodeFloatArray(vector), resolveEmbedder().fingerprint, entry.id);
					written++;
					return;
				}
			}
			this.insert(entry.content, entry.namespace, vector, Date.now());
			written++;
		});
		if (importedIds.length > 0) {
			const placeholders = importedIds.map(() => "?").join(",");
			this.db.prepare(`DELETE FROM memos WHERE id NOT IN (${placeholders})`).run(...importedIds);
		}
		this.syncVaultMd();
		return written;
	}
	/**
	* Keep vault.md (the human-readable mirror) in lockstep with the DB: after
	* every add/delete/import, rewrite it from the current rows. Otherwise the
	* file drifts — deleted entries linger, new ones stay invisible — and any
	* UI reading the file shows stale "memories".
	*/
	syncVaultMd() {
		try {
			const md = this.exportMarkdown();
			writeFileSync(this.vaultMdPath(), md, { mode: 384 });
		} catch {}
	}
	close() {
		this.db.close();
	}
	/** Path of the human-readable export (vault.md) next to the DB. */
	vaultMdPath() {
		return join(this.root, "vault.md");
	}
};
//#endregion
//#region src/vault-cap.ts
/**
* Shared injection caps: the HOST renderer (session-store.ts) and the CLIENT
* live preview (MemoryView.tsx) must truncate injected blocks the same way,
* or the preview would lie about what the AI actually receives. Import this
* from both sides instead of duplicating the numbers.
*
* Why cap at all: memory files grow without bound if authors never prune, and
* injecting everything would eat the prompt context every turn. Caps are a
* defensive floor under the "keep it dense" guideline.
*
* (The Vault has no static injection cap: it is semantic-only — read on
* demand via the `memory` tool or the per-conversation auto retrieval.)
*/
/** Generic line cap with a trailing note; used by every injected block. */
function capText(text, maxLines, note) {
	const lines = text.split("\n");
	return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}${note}` : text;
}
const SOFT_CAP_NOTE = "\n…（内容过长已截断，请精简记忆文件）";
//#endregion
//#region src/memory-blocks.ts
/**
* Conversation memory injects at a lower line cap than the other free-form
* blocks: it grows on every milestone (append-only) and would otherwise
* inflate context unboundedly. The cap forces compaction (the usage guide
* tells the agent to archive finished milestones into the Vault).
*/
const CONVERSATION_CAP_LINES = 60;
/**
* Cross-block, line-level deduplication: identical content lines (trimmed,
* case-folded) are injected only ONCE no matter how many layers carry them.
* This is the hard guarantee that duplicated memories across layers (e.g. a
* finished project present in project memory, keyed memory and MEMORY.md)
* never inflate the injected context. Headings/separators/code fences are
* structural and always kept. Lines INSIDE a ``` fence are structural too
* (code snippets, tables, CSV) and never participate in dedup — collapsing
* them would silently alter the injected context (review P2-1). The `seen`
* set is shared across all blocks.
*/
function dedupeLines(block, seen) {
	const out = [];
	let inFence = false;
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			inFence = !inFence;
			out.push(raw);
			continue;
		}
		if (!inFence && line !== "" && !line.startsWith("#") && !line.startsWith("---")) {
			const key = line.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
		}
		out.push(raw);
	}
	return out.join("\n");
}
/**
* Assemble the markdown memory blocks for one conversation, following its
* inject config. Empty when nothing is selected. The returned blocks are
* deduplicated across layers (identical lines appear once).
*
* The Vault has no static block: it is a semantic store read on demand —
* either via the `memory` tool or the per-conversation "auto retrieval" tick
* (agent/pre-step), never injected verbatim.
*/
function composeBlocks(cfg, sources) {
	const blocks = [];
	const user = sources.user.trim();
	const longTerm = sources.longTerm.trim();
	const seen = /* @__PURE__ */ new Set();
	if (cfg.userProfile && user !== "") blocks.push(dedupeLines(`### 用户画像\n${capText(user, 100, SOFT_CAP_NOTE)}`, seen));
	if (cfg.longTerm && longTerm !== "") blocks.push(dedupeLines(`### 长期记忆\n${capText(longTerm, 100, SOFT_CAP_NOTE)}`, seen));
	if (cfg.conversation) {
		const own = sources.conversation.trim();
		if (own !== "") blocks.push(dedupeLines(`### 本对话记忆\n${capText(own, CONVERSATION_CAP_LINES, SOFT_CAP_NOTE)}`, seen));
	}
	return blocks;
}
//#endregion
//#region src/session-store.ts
/**
* SessionMemoryStore: per-conversation memory, per-conversation injection
* config, and cwd-scoped project memory for DeepSeek Harness agents.
*
* Layout (under <root>, default ~/.dsh-memory/):
*   sessions/<sessionId>/memory.md    — THIS conversation's own memory
*   sessions/<sessionId>/inject.json  — which memory blocks get injected here
*   projects/<projectKey>/memory.md   — project (cwd) shared memory
*   projects/<projectKey>/project.json — { cwd } metadata for display
*
* The global pool (USER.md / MEMORY.md / memory.json / vault.md) stays in the
* root, managed by the existing MemoryStore / ProfileStore / VaultStore.
* This store only adds the per-conversation + per-project layers.
*/
/** Fresh-conversation default: EVERYTHING OFF. A new conversation starts with
* a clean context — the user checks the boxes for whatever it should see
* (user decision, 2026-08-15: even injected memory costs context, so nothing
* is injected until explicitly selected).
*/
const DEFAULT_INJECT = {
	userProfile: false,
	longTerm: false,
	conversation: false,
	keyed: false,
	autoVaultGate: "off",
	projects: [],
	projectKey: null
};
/** Safe parse of the auto-retrieval mode (legacy booleans migrate). */
function parseAutoVaultGate(raw) {
	if (raw.autoVaultGate === "heuristic" || raw.autoVaultGate === "llm") return raw.autoVaultGate;
	if (raw.autoVault === true || raw.vault === true) return "heuristic";
	return "off";
}
/**
* Line-level deduplication for memory APPENDS (the `memory add` path): lines
* already present in the target layer — or appearing twice within the new
* content itself — are dropped (trimmed, case-folded), so re-writing an
* existing fact never duplicates it. Returns the lines to append ('' when
* everything is a duplicate) plus a note for the caller.
*
* Comparison is bullet-insensitive: existing file lines are written with a
* leading `- ` (appendMemory always prefixes), while the model's raw input
* often is not — both sides are stripped of leading `- ` / `* ` / `+ ` before
* keying, so `已有事实` and `- 已有事实` count as the same fact (review P2-2).
*/
function dedupeAppendLines(existing, content) {
	const stripMarker = (l) => l.replace(/^[-*+]\s+/, "");
	const seen = new Set(existing.split("\n").map((l) => stripMarker(l.trim()).toLowerCase()).filter((l) => l !== ""));
	const allLines = content.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	const freshLines = [];
	for (const line of allLines) {
		const key = stripMarker(line).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		freshLines.push(line);
	}
	return {
		fresh: freshLines.join("\n"),
		duplicated: allLines.length - freshLines.length
	};
}
/** Session ids arrive from the web API, so validate before touching the fs. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/;
/** Project keys also arrive from the web API — same strict charset as session ids (path-traversal guard). */
const SAFE_PROJECT_KEY = /^[A-Za-z0-9._-]{1,160}$/;
/**
* A project key is acceptable only if it matches the charset AND is not a
* bare dot component. `.` would resolve to the projects/ dir itself and `..`
* would escape one level to the memory root (path.join(root,'projects','..')
* === root) — both must be rejected even though the regex allows them.
*/
function isSafeProjectKey(key) {
	return SAFE_PROJECT_KEY.test(key) && key !== "." && key !== "..";
}
/**
* Session ids get the same bare-dot rejection: path.join(root,'sessions','..')
* would resolve to the memory root, making `..` a writable alias of the
* global pool files. Symmetric with isSafeProjectKey.
*/
function isSafeSessionId(id) {
	return SAFE_ID.test(id) && id !== "." && id !== "..";
}
/**
* Canonical form of a project key. On case-insensitive filesystems (win32)
* project keys are folded to lowercase so `16_D_ten_Documents` and
* `16_d_ten_documents` (one physical NTFS directory) collapse to one key —
* both in stored inject configs and in the picker. Elsewhere keys are kept
* as-is (case-sensitive filesystems treat them as distinct).
*/
function normalizeProjectKey(key) {
	return process.platform === "win32" ? key.toLowerCase() : key;
}
/**
* Per-conversation / per-project memory store.
*
* All methods are synchronous file reads/writes (same Plan-A simplicity as
* MemoryStore). Missing files read as empty; writes are atomic-ish
* (tmp + rename) so a crash never leaves a half-written note.
*/
var SessionMemoryStore = class SessionMemoryStore {
	root;
	constructor(root) {
		this.root = root ?? join(homedir(), ".dsh-memory");
		if (!existsSync(this.root)) mkdirSync(this.root, {
			recursive: true,
			mode: 448
		});
	}
	/** Guard a session id against path traversal (incl. bare dot components). */
	static checkSessionId(sessionId) {
		if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
		return sessionId;
	}
	/** Guard a project key against path traversal (mirrors checkSessionId). */
	static checkProjectKey(projectKey) {
		if (!isSafeProjectKey(projectKey)) throw new Error(`invalid project key: ${JSON.stringify(projectKey)}`);
		return projectKey;
	}
	sessionDir(sessionId) {
		return join(this.root, "sessions", SessionMemoryStore.checkSessionId(sessionId));
	}
	memoryFile(sessionId) {
		return join(this.sessionDir(sessionId), "memory.md");
	}
	injectFile(sessionId) {
		return join(this.sessionDir(sessionId), "inject.json");
	}
	/** Read this conversation's own memory; missing → ''. */
	memory(sessionId) {
		SessionMemoryStore.checkSessionId(sessionId);
		try {
			return readFileSync(this.memoryFile(sessionId), "utf8");
		} catch {
			return "";
		}
	}
	/** Replace this conversation's own memory. */
	writeMemory(sessionId, content) {
		const file = this.memoryFile(sessionId);
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, content);
	}
	/** Append one bullet to this conversation's memory (the tool's `add`). */
	appendMemory(sessionId, content) {
		const file = this.memoryFile(sessionId);
		const existing = this.memory(sessionId);
		const bullet = existing.length === 0 ? `- ${content}` : `${existing.endsWith("\n") ? existing : `${existing}\n`}- ${content}`;
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, bullet);
	}
	/**
	* Read this conversation's injection config; missing → defaults.
	*
	* `backupCorrupt` defaults to true (a later save must not silently wipe a
	* corrupted original). Read-only listing paths (listSessions) pass false:
	* a GET must not carry a renameSync write side-effect (P2-1, review round
	* for the session-management feature).
	*/
	inject(sessionId, opts = {}) {
		SessionMemoryStore.checkSessionId(sessionId);
		try {
			const parsed = JSON.parse(readFileSync(this.injectFile(sessionId), "utf8"));
			const boolField = (v, fallback) => typeof v === "boolean" ? v : fallback;
			return {
				userProfile: boolField(parsed.userProfile, DEFAULT_INJECT.userProfile),
				longTerm: boolField(parsed.longTerm, DEFAULT_INJECT.longTerm),
				conversation: boolField(parsed.conversation, DEFAULT_INJECT.conversation),
				keyed: boolField(parsed.keyed, DEFAULT_INJECT.keyed),
				autoVaultGate: parseAutoVaultGate(parsed),
				projects: Array.isArray(parsed.projects) ? [...new Set(parsed.projects.filter((p) => typeof p === "string" && isSafeProjectKey(p)).map(normalizeProjectKey))] : [...DEFAULT_INJECT.projects],
				projectKey: typeof parsed.projectKey === "string" && isSafeProjectKey(parsed.projectKey) ? normalizeProjectKey(parsed.projectKey) : null
			};
		} catch {
			if (opts.backupCorrupt !== false) {
				const file = this.injectFile(sessionId);
				try {
					if (readdirSync(dirname(file)).filter((n) => n.startsWith("inject.json.corrupt-")).length === 0) renameSync(file, `${file}.corrupt-${Date.now()}`);
				} catch {}
			}
			return {
				...DEFAULT_INJECT,
				projects: [...DEFAULT_INJECT.projects],
				projectKey: null
			};
		}
	}
	/** Replace this conversation's injection config. */
	writeInject(sessionId, config) {
		const file = this.injectFile(sessionId);
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, JSON.stringify(config, null, 2));
	}
	/**
	* Map a working directory to a stable project key. Two sessions whose cwds
	* resolve to the same absolute path share one project memory. Windows paths
	* are case-folded so `C:\Proj` and `c:\proj` are one project.
	*
	* The `<abs.length>_` prefix is a collision-reduction shim: distinct paths
	* can sanitize to the same safe form (e.g. `a/b` vs `a_b`), so different
	* lengths keep them apart. It also keeps the key valid under SAFE_PROJECT_KEY.
	*/
	projectKeyOf(cwd) {
		if (cwd === void 0 || cwd === "") return void 0;
		const abs = resolve(cwd);
		const safe = (process.platform === "win32" ? abs.toLowerCase() : abs).replace(/[^A-Za-z0-9._-]+/g, "_");
		return `${abs.length}_${safe}`;
	}
	/**
	* The project this conversation belongs to: its explicitly chosen
	* `projectKey` when set, otherwise the cwd-derived key. Lets conversations
	* of one real project share memory across different working directories.
	*/
	projectKeyOfSession(sessionId, cwd) {
		const chosen = this.inject(sessionId).projectKey;
		if (chosen !== null && chosen !== "") return chosen;
		return this.projectKeyOf(cwd);
	}
	projectDir(projectKey) {
		const key = normalizeProjectKey(SessionMemoryStore.checkProjectKey(projectKey));
		return join(this.root, "projects", key);
	}
	projectMemoryFile(projectKey) {
		return join(this.projectDir(projectKey), "memory.md");
	}
	projectMetaFile(projectKey) {
		return join(this.projectDir(projectKey), "project.json");
	}
	/** Read one project's shared memory; missing → ''. */
	projectMemory(projectKey) {
		SessionMemoryStore.checkProjectKey(projectKey);
		try {
			return readFileSync(this.projectMemoryFile(projectKey), "utf8");
		} catch {
			return "";
		}
	}
	/** Replace one project's shared memory. */
	writeProjectMemory(projectKey, content) {
		const file = this.projectMemoryFile(projectKey);
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, content);
	}
	/**
	* Append one bullet to a project's shared memory.
	*
	* Known concurrency note (accepted, Plan-A simplification): this is a
	* read-modify-write without a lock. Two agents appending to the SAME project
	* at the same instant could both read the old content and the later rename
	* would drop one bullet. Within one conversation DSH runs tools
	* sequentially, so only cross-conversation same-project concurrent writes
	* can race — rare, and the cost is a lost line, never file corruption
	* (writeAtomic's unique tmp + rename stays crash-safe).
	*/
	appendProjectMemory(projectKey, content) {
		const file = this.projectMemoryFile(projectKey);
		const existing = this.projectMemory(projectKey);
		const bullet = existing.length === 0 ? `- ${content}` : `${existing.endsWith("\n") ? existing : `${existing}\n`}- ${content}`;
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, bullet);
	}
	/** Remember the cwd behind a project key (for human-readable labels). */
	rememberProjectCwd(projectKey, cwd) {
		const file = this.projectMetaFile(projectKey);
		if (!existsSync(file)) {
			mkdirSync(dirname(file), {
				recursive: true,
				mode: 448
			});
			this.writeAtomic(file, JSON.stringify({ cwd }, null, 2));
		}
	}
	/**
	* Create a user-named project (not tied to any working directory).
	*
	* This lets several real projects that share one folder (e.g. everything
	* under one workspace directory) keep SEPARATE project memories: the user
	* picks a name (like "dsh-persist" or "opencode-balance"), it becomes a
	* stable projectKey independent of cwd, and conversations that select it
	* share exactly that memory — while a sibling conversation selecting
	* another name gets its own. The project.json records `named: true` so the
	* picker can
	* tell hand-created projects from cwd-derived ones.
	*/
	createNamedProject(projectKey) {
		const file = this.projectMetaFile(projectKey);
		if (existsSync(file)) return;
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		this.writeAtomic(file, JSON.stringify({ named: true }, null, 2));
	}
	/** Whether a project was hand-named (vs cwd-derived). */
	isNamedProject(projectKey) {
		try {
			return JSON.parse(readFileSync(this.projectMetaFile(projectKey), "utf8")).named === true;
		} catch {
			return false;
		}
	}
	/** List every known project (for the injection picker). */
	listProjects() {
		const dir = join(this.root, "projects");
		if (!existsSync(dir)) return [];
		const out = [];
		for (const name of readdirSync(dir)) {
			const key = normalizeProjectKey(name);
			try {
				const meta = JSON.parse(readFileSync(join(dir, name, "project.json"), "utf8"));
				const base = meta.named === true ? {
					key,
					named: true
				} : { key };
				out.push(meta.cwd === void 0 ? base : {
					...base,
					cwd: meta.cwd
				});
			} catch {
				out.push({ key });
			}
		}
		const seen = /* @__PURE__ */ new Set();
		return out.filter((p) => seen.has(p.key) ? false : (seen.add(p.key), true)).sort((a, b) => a.key.localeCompare(b.key));
	}
	/**
	* List every known conversation's memory + inject config, newest first
	* (by memory/inject mtime). This is the management-page window into the
	* sessions/ directory — the memory tab only edits the CURRENT conversation.
	*/
	listSessions() {
		const dir = join(this.root, "sessions");
		if (!existsSync(dir)) return [];
		const out = [];
		for (const name of readdirSync(dir)) {
			if (!isSafeSessionId(name)) continue;
			const sdir = join(dir, name);
			try {
				if (!statSync(sdir).isDirectory()) continue;
			} catch {
				continue;
			}
			let memory = "";
			let memoryMtime = null;
			try {
				const st = statSync(join(sdir, "memory.md"));
				memory = readFileSync(join(sdir, "memory.md"), "utf8");
				memoryMtime = st.mtimeMs;
			} catch {}
			let injectMtime = null;
			try {
				injectMtime = statSync(join(sdir, "inject.json")).mtimeMs;
			} catch {}
			out.push({
				id: name,
				memory,
				inject: this.inject(name, { backupCorrupt: false }),
				memoryMtime,
				injectMtime
			});
		}
		return out.sort((a, b) => {
			const diff = Math.max(b.memoryMtime ?? 0, b.injectMtime ?? 0) - Math.max(a.memoryMtime ?? 0, a.injectMtime ?? 0);
			if (diff !== 0) return diff;
			return a.id.localeCompare(b.id);
		});
	}
	/**
	* Delete one conversation's memory files (memory.md, inject.json, corrupt
	* backups). The whole session directory is removed — it holds nothing but
	* this plugin's files; a live conversation recreates it on next write.
	* Returns whether anything was deleted.
	*/
	deleteSession(sessionId) {
		const dir = this.sessionDir(sessionId);
		if (!existsSync(dir)) return false;
		try {
			rmSync(dir, {
				recursive: true,
				force: true
			});
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Assemble the markdown memory block for one conversation, following that
	* conversation's inject config. Empty when nothing is selected.
	*/
	render(sessionId, sources) {
		const cfg = this.inject(sessionId);
		const blocks = composeBlocks(cfg, {
			user: sources.user,
			longTerm: sources.longTerm,
			keyed: sources.keyed,
			conversation: this.memory(sessionId),
			projects: cfg.projects.map((key) => ({
				key,
				label: this.projectLabel(key),
				content: this.projectMemory(key)
			}))
		});
		if (blocks.length === 0) return "";
		return `## 用户记忆（跨会话持久）\n${blocks.join("\n\n")}`;
	}
	/** Human-readable label for a project key (its cwd when recorded). */
	projectLabel(projectKey) {
		try {
			return JSON.parse(readFileSync(this.projectMetaFile(projectKey), "utf8")).cwd ?? projectKey;
		} catch {
			return projectKey;
		}
	}
	/**
	* Atomic write (unique temp + rename). The temp name carries pid+time+random
	* so concurrent writers (multi-agent) never collide on one .tmp file; a
	* failed rename cleans the temp up.
	*/
	writeAtomic(file, content) {
		const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmp, content, { mode: 384 });
		try {
			renameSync(tmp, file);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {}
			throw error;
		}
	}
};
//#endregion
//#region src/webui.ts
/** The global memory files this UI manages: name → filename under ~/.dsh-memory/. */
const MEMORY_FILES = [
	{
		name: "USER.md",
		label: "用户画像",
		hint: "全局记忆池 · 身份/偏好/习惯（每对话可选注入）"
	},
	{
		name: "MEMORY.md",
		label: "长期记忆",
		hint: "全局记忆池 · 环境/进度/规则/经验（每对话可选注入）"
	},
	{
		name: "vault.md",
		label: "Vault 语义记忆",
		hint: "可读可改 · 改完点\"同步\"写回 vault.db"
	}
];
const memoryRoot = () => {
	const base = join(homedir(), ".dsh-memory");
	if (!existsSync(base)) mkdirSync(base, {
		recursive: true,
		mode: 448
	});
	return base;
};
/** Managed file names — readMemoryFile/writeMemoryFile accept nothing else (defense in depth). */
const KNOWN_FILES = new Set(MEMORY_FILES.map((f) => f.name));
function checkFileName(name) {
	if (!KNOWN_FILES.has(name)) throw new Error(`unknown memory file: ${JSON.stringify(name)}`);
	return name;
}
/** Read one memory file; missing → empty string. */
function readMemoryFile(name) {
	checkFileName(name);
	const file = join(memoryRoot(), name);
	if (!existsSync(file)) return "";
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
/** Write one memory file (creates the root if needed). */
function writeMemoryFile(name, content) {
	checkFileName(name);
	const base = memoryRoot();
	writeFileSync(join(base, name), content, { mode: 384 });
}
/** All global memory files with their content, plus a vault count for display. */
function memorySnapshot() {
	const out = {};
	for (const f of MEMORY_FILES) out[f.name] = {
		label: f.label,
		hint: f.hint,
		content: readMemoryFile(f.name)
	};
	return out;
}
/** Read the raw request body as UTF-8 text, bounded to protect memory. */
function readBody(req, maxBytes = 10485760) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (c) => {
			total += c.length;
			if (total > maxBytes) {
				const err = /* @__PURE__ */ new Error(`request body exceeds ${maxBytes} bytes`);
				err.statusCode = 413;
				reject(err);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** JSON helper for responses. */
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/**
* Memory routes carry the user's private data. The DSH web server normally
* binds 127.0.0.1 (safe); when it is exposed on 0.0.0.0, refuse non-loopback
* clients unless the operator explicitly opts in via DSH_MEMORY_ALLOW_REMOTE=1.
*/
function guardLoopback(req) {
	if (process.env.DSH_MEMORY_ALLOW_REMOTE === "1") return true;
	const addr = (req.socket.remoteAddress ?? "").toLowerCase();
	const host = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
	return host.startsWith("127.") || host === "::1" || host === "7f00:1" || host === "0:0:0:0:0:0:0:1";
}
/**
* Origin guard for state-changing routes. Browsers attach an Origin header to
* cross-origin requests; a malicious page must fail. The origin is compared
* EXACTLY against the request's Host header (host + port): anything else —
* `127.0.0.1.evil.com` (a hostname that merely starts with "127."), a page
* served from another local port, or a remote site — is rejected. Requests
* WITHOUT an Origin header (curl, non-browser clients) pass — the loopback
* guard above already restricts them to the local machine, and
* DSH_MEMORY_ALLOW_REMOTE=1 deployments send their own same-value Origin.
*/
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	const host = req.headers.host;
	if (host === void 0) return false;
	try {
		const o = new URL(origin);
		const originPort = o.port || (o.protocol === "https:" ? "443" : "80");
		return `${o.hostname.toLowerCase()}:${originPort}` === host.toLowerCase();
	} catch {
		return false;
	}
}
/**
* Shared guard for every state-changing route. Returns `true` when the
* request may proceed, or `{ status, error }` describing the rejection.
*
* This exists because browsers treat `text/plain` POSTs as "simple requests"
* (no CORS preflight): without a Content-Type check, a malicious page could
* hit any write route directly. All write routes must pass this. DELETE
* carries no body, so only POST requires the JSON Content-Type.
*/
function guardStateChange(req, method = "POST") {
	if (req.method !== method) return {
		status: 405,
		error: `requires ${method}`
	};
	if (!sameOrigin(req)) return {
		status: 403,
		error: "cross-origin request rejected"
	};
	if (method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) return {
		status: 415,
		error: "requires application/json"
	};
	return true;
}
/**
* Per-conversation snapshot the client memory tab renders:
* the conversation's own memory, its inject config, the project it belongs
* to (when the host knows its cwd), every known project (the picker), and
* previews of the global pool blocks.
*/
function sessionSnapshot(sessionStore, sessionId, cwd) {
	const ownProject = sessionStore.projectKeyOf(cwd);
	if (ownProject !== void 0 && cwd !== void 0) sessionStore.rememberProjectCwd(ownProject, cwd);
	const projects = sessionStore.listProjects();
	return {
		ok: true,
		sessionId,
		memory: sessionStore.memory(sessionId),
		inject: sessionStore.inject(sessionId),
		project: ownProject === void 0 ? null : {
			key: ownProject,
			cwd
		},
		projects: projects.map((p) => ({
			key: p.key,
			cwd: p.cwd,
			named: sessionStore.isNamedProject(p.key),
			memory: sessionStore.projectMemory(p.key)
		})),
		previews: {
			userProfile: readMemoryFile("USER.md"),
			longTerm: readMemoryFile("MEMORY.md"),
			keyed: []
		}
	};
}
/** Sanitize an incoming inject config: booleans coerced, project keys filtered (strict charset). */
function sanitizeInject(value) {
	if (value === null || typeof value !== "object") return null;
	const raw = value;
	const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
	const projects = Array.isArray(raw.projects) ? [...new Set(raw.projects.filter((p) => typeof p === "string" && isSafeProjectKey(p)).map(normalizeProjectKey))] : [];
	return {
		userProfile: bool(raw.userProfile, false),
		longTerm: bool(raw.longTerm, false),
		conversation: bool(raw.conversation, false),
		keyed: bool(raw.keyed, false),
		autoVaultGate: parseAutoVaultGate(raw),
		projects,
		projectKey: typeof raw.projectKey === "string" && isSafeProjectKey(raw.projectKey) ? normalizeProjectKey(raw.projectKey) : null
	};
}
/** The management page HTML (self-contained, dependency-free). */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-memory · 记忆管理</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .tabs button { padding: 6px 14px; border-radius: 8px; border: 1px solid #8884; background: #0000; cursor: pointer; }
  .tabs button.active { background: #08f2; border-color: #08f; }
  .hint { color: #888; font-size: 12px; margin: 4px 0 8px; }
  textarea { width: 100%; min-height: 320px; font-family: ui-monospace, monospace; font-size: 13px;
             border-radius: 8px; padding: 10px; box-sizing: border-box; }
  .bar { display: flex; gap: 8px; margin: 8px 0; align-items: center; }
  .bar button { padding: 6px 14px; border-radius: 8px; border: 1px solid #08f; background: #08f2; cursor: pointer; }
  #msg { font-size: 13px; margin-left: 8px; }
  .ok { color: #0a8; } .err { color: #d33; }
  .srow { border: 1px solid #8884; border-radius: 8px; padding: 8px 10px; margin: 6px 0; }
  .srow .sid { font-weight: 600; font-size: 13px; word-break: break-all; }
  .srow .smeta { color: #888; font-size: 12px; margin: 3px 0; }
  .srow .sprev { font-size: 12px; white-space: pre-wrap; word-break: break-word;
                 max-height: 54px; overflow: hidden; margin: 3px 0; color: #555; }
  .srow .sbtn { margin-right: 6px; padding: 3px 10px; border-radius: 6px; border: 1px solid #08f;
                background: #08f2; cursor: pointer; font-size: 12px; }
  .srow .sbtn.danger { border-color: #d33; background: #d332; }
  #session-detail { display: none; }
</style>
</head>
<body>
<h1>dsh-memory · 记忆管理</h1>
<p class="hint">全局记忆池（所有对话共享）的浏览与编辑；「会话记忆」tab 可查看/编辑/删除每个历史对话的独有记忆。</p>
<div class="tabs" id="tabs"></div>

<div id="files-area">
<div class="bar">
  <button id="save">保存</button>
  <button id="sync">Vault 同步（vault.md → vault.db）</button>
  <span id="msg"></span>
</div>
<textarea id="editor" spellcheck="false"></textarea>
</div>

<div id="session-panel" style="display:none">
  <div id="session-list"></div>
  <div id="session-detail">
    <div class="bar">
      <button id="sess-back">← 返回列表</button>
      <button id="sess-save">保存此会话记忆</button>
      <button id="sess-delete" class="danger">删除此会话记忆</button>
      <span id="sess-info"></span>
    </div>
    <p class="hint" id="sess-inject"></p>
    <textarea id="session-editor" spellcheck="false"></textarea>
  </div>
</div>

<script>
const FILES = ${JSON.stringify(MEMORY_FILES.map((f) => ({
	name: f.name,
	label: f.label,
	hint: f.hint
})))};
const SESSIONS_TAB = 'sessions';
let current = 'USER.md';
const tabs = document.getElementById('tabs');
const editor = document.getElementById('editor');
const msg = document.getElementById('msg');
const data = {};
let sessionsData = [];
let currentSession = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtTime(ms) {
  if (ms == null) return '-';
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}

function injectSummary(inj) {
  const on = [];
  if (inj.userProfile) on.push('用户画像');
  if (inj.longTerm) on.push('长期记忆');
  if (inj.conversation) on.push('本对话');
  if (inj.keyed) on.push('关键记忆');
  if (inj.autoVaultGate === 'heuristic') on.push('自动检索·智能');
  else if (inj.autoVaultGate === 'llm') on.push('自动检索·LLM');
  const proj = (inj.projects || []).length;
  const key = inj.projectKey || '跟随cwd';
  return '注入: ' + (on.length ? on.join('+') : '无') + ' · 项目 ' + proj + ' 个 · 归属 ' + key;
}

function show(name) {
  current = name;
  document.querySelectorAll('.tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.name === name));
  const isSessions = name === SESSIONS_TAB;
  // Explicit display values via the shared panelDisplays state machine:
  // '' would fall back to the CSS default and hide a panel (review P1/P3).
  const d = panelDisplays(isSessions ? 'session-list' : 'files');
  document.getElementById('files-area').style.display = d.filesArea;
  document.getElementById('session-panel').style.display = d.sessionPanel;
  if (isSessions) {
    refreshSessions();
    return;
  }
  const f = FILES.find(x => x.name === name);
  // The API returns { label, hint, content } per file; normalize to the
  // content string (defensive: tolerate both shapes so a stale payload can
  // never render as "[object Object]").
  const raw = data[name];
  editor.value = (raw != null && typeof raw === 'object') ? (raw.content ?? '') : (raw ?? '');
  document.querySelector('.hint').textContent = f ? f.hint : '';
}

async function refresh() {
  const r = await fetch('/dsh-memory/api/memory');
  const json = await r.json();
  // Unwrap each { label, hint, content } payload into the plain content
  // string (labels/hints come from FILES anyway), so the editor always
  // receives text — not an object (which would show as "[object Object]").
  Object.assign(data, unwrapMemoryPayload(json));
  tabs.innerHTML = '';
  for (const f of FILES) {
    const b = document.createElement('button');
    b.textContent = f.label;
    b.dataset.name = f.name;
    b.onclick = () => show(f.name);
    tabs.appendChild(b);
  }
  const sb = document.createElement('button');
  sb.textContent = '会话记忆';
  sb.dataset.name = SESSIONS_TAB;
  sb.onclick = () => show(SESSIONS_TAB);
  tabs.appendChild(sb);
  show(current);
}

function flash(text, ok = true) {
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'err';
}

document.getElementById('save').onclick = async () => {
  // Guard: the file editor is hidden on the sessions tab; never POST a
  // pseudo-file name like 'sessions' (defense in depth, review P3).
  if (current === SESSIONS_TAB) return;
  const r = await fetch('/dsh-memory/api/memory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: current, content: editor.value }),
  });
  const j = await r.json();
  if (j.ok) { data[current] = editor.value; flash('已保存 ' + current); }
  else flash('保存失败：' + (j.error ?? ''), false);
};

document.getElementById('sync').onclick = async () => {
  const confirmClear = confirm('同步后 vault 将完全等于 vault.md 的内容。\\n若 vault.md 为空或没有 [id] 条目，现有语义记忆会被清空。\\n确定继续吗？');
  if (!confirmClear) return;
  const r = await fetch('/dsh-memory/api/sync-vault', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmClear: true }),
  });
  const j = await r.json();
  flash(j.ok ? ('Vault 同步完成：' + (j.written ?? 0) + ' 条') : ('同步失败：' + (j.error ?? '')), j.ok);
};

// ── 会话记忆管理 ─────────────────────────────────────────────────────────

async function refreshSessions() {
  try {
    const r = await fetch('/dsh-memory/api/sessions');
    const j = await r.json();
    sessionsData = j.sessions || [];
  } catch {
    sessionsData = [];
  }
  if (currentSession !== null && !sessionsData.some(s => s.id === currentSession)) {
    currentSession = null; // deleted elsewhere
  }
  renderSessionList();
}

function renderSessionList() {
  const list = document.getElementById('session-list');
  const detail = document.getElementById('session-detail');
  list.innerHTML = '';
  if (sessionsData.length === 0) {
    list.innerHTML = '<p class="hint">（没有任何会话记忆）</p>';
  }
  for (const s of sessionsData) {
    const row = document.createElement('div');
    row.className = 'srow';
    const memFirst = (s.memory || '').split('\\n').filter(l => l.trim() !== '').slice(0, 3).join(' · ') || '（空）';
    const meta = '记忆 ' + (s.memory ? s.memory.length + ' 字符' : '空') +
      ' · 修改 ' + fmtTime(s.memoryMtime || s.injectMtime);
    row.innerHTML =
      '<div class="sid">' + esc(s.id) + '</div>' +
      '<div class="smeta">' + esc(meta) + '</div>' +
      '<div class="smeta">' + esc(injectSummary(s.inject)) + '</div>' +
      '<div class="sprev">' + esc(memFirst) + '</div>' +
      '<button class="sbtn" data-id="' + esc(s.id) + '" data-act="open">查看/编辑</button>' +
      '<button class="sbtn danger" data-id="' + esc(s.id) + '" data-act="del">删除</button>';
    list.appendChild(row);
  }
  list.querySelectorAll('button[data-act="open"]').forEach(b => {
    b.onclick = () => openSession(b.dataset.id);
  });
  list.querySelectorAll('button[data-act="del"]').forEach(b => {
    b.onclick = () => deleteSession(b.dataset.id);
  });
  // Always reset the list panel to visible here: openSession() hides it, and
  // re-entering the tab (or coming back from a detail) must restore it —
  // otherwise the panel stays blank until a full reload (review P1).
  const d = panelDisplays('session-list');
  list.style.display = d.sessionList;
  detail.style.display = d.sessionDetail;
}

function openSession(id) {
  currentSession = id;
  const s = sessionsData.find(x => x.id === id);
  if (!s) return;
  const d = panelDisplays('session-detail');
  document.getElementById('session-list').style.display = d.sessionList;
  const detail = document.getElementById('session-detail');
  detail.style.display = d.sessionDetail;
  document.getElementById('session-editor').value = s.memory || '';
  document.getElementById('sess-inject').textContent = '该会话的注入配置 — ' + injectSummary(s.inject) +
    '（保存记忆不会改动注入配置）';
  document.getElementById('sess-info').textContent = '会话 ' + id;
  document.getElementById('sess-info').className = '';
}

function backToList() {
  currentSession = null;
  const d = panelDisplays('session-list');
  document.getElementById('session-list').style.display = d.sessionList;
  document.getElementById('session-detail').style.display = d.sessionDetail;
  refreshSessions();
}

document.getElementById('sess-back').onclick = backToList;

document.getElementById('sess-save').onclick = async () => {
  if (currentSession === null) return;
  const r = await fetch('/dsh-memory/api/session/' + encodeURIComponent(currentSession), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memory: document.getElementById('session-editor').value }),
  });
  const j = await r.json();
  const info = document.getElementById('sess-info');
  if (j.ok) {
    // Update the local snapshot in place — a full refreshSessions() would
    // hide the detail panel while openSession() has hidden the list, leaving
    // the whole panel blank. The list preview picks the change up on the
    // next render (back/refresh).
    const s = sessionsData.find(x => x.id === currentSession);
    if (s) s.memory = document.getElementById('session-editor').value;
    info.textContent = '已保存 ' + currentSession;
    info.className = 'ok';
  } else {
    info.textContent = '保存失败：' + (j.error ?? '');
    info.className = 'err';
  }
};

document.getElementById('sess-delete').onclick = async () => {
  if (currentSession === null) return;
  if (!confirm('确定删除会话 ' + currentSession + ' 的记忆与注入配置？\\n（memory.md + inject.json，不可恢复）')) return;
  const r = await fetch('/dsh-memory/api/session/' + encodeURIComponent(currentSession), { method: 'DELETE' });
  const j = await r.json();
  if (j.ok) { backToList(); }
  else {
    const info = document.getElementById('sess-info');
    info.textContent = '删除失败：' + (j.error ?? '');
    info.className = 'err';
  }
};

async function deleteSession(id) {
  if (!confirm('确定删除会话 ' + id + ' 的记忆与注入配置？\\n（memory.md + inject.json，不可恢复）')) return;
  const r = await fetch('/dsh-memory/api/session/' + encodeURIComponent(id), { method: 'DELETE' });
  const j = await r.json();
  if (!j.ok) { flash('删除失败：' + (j.error ?? ''), false); }
  refreshSessions();
}

refresh();
<\/script>
</body>
</html>`;
/** Register all dsh-memory web routes on the DSH web server. Returns the disposer. */
function registerWebUi(ctx, deps) {
	const { sessionStore } = deps;
	const disposers = [];
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/dsh-memory/",
		handler: (req, res) => {
			if (!guardLoopback(req)) {
				json(res, 403, {
					ok: false,
					error: "dsh-memory is local-only (set DSH_MEMORY_ALLOW_REMOTE=1 to expose)"
				});
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE);
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/dsh-memory/api/memory",
		handler: async (req, res) => {
			try {
				if (!guardLoopback(req)) {
					json(res, 403, {
						ok: false,
						error: "dsh-memory is local-only"
					});
					return;
				}
				if (req.method === "POST") {
					const guard = guardStateChange(req);
					if (guard !== true) {
						json(res, guard.status, {
							ok: false,
							error: guard.error
						});
						return;
					}
					const body = JSON.parse(await readBody(req));
					const name = body.name;
					if (name === void 0 || !MEMORY_FILES.some((f) => f.name === name)) {
						json(res, 400, {
							ok: false,
							error: "unknown memory file"
						});
						return;
					}
					writeMemoryFile(name, body.content ?? "");
					json(res, 200, {
						ok: true,
						name
					});
					return;
				}
				json(res, 200, memorySnapshot());
			} catch (error) {
				json(res, error.statusCode ?? 400, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/dsh-memory/api/sync-vault",
		handler: async (req, res) => {
			try {
				if (!guardLoopback(req)) {
					json(res, 403, {
						ok: false,
						error: "dsh-memory is local-only"
					});
					return;
				}
				const guard = guardStateChange(req);
				if (guard !== true) {
					json(res, guard.status, {
						ok: false,
						error: guard.error
					});
					return;
				}
				if (deps.vault === null) {
					json(res, 500, {
						ok: false,
						error: "vault unavailable (node:sqlite needs Node >= 22.6 with --experimental-sqlite, or >= 23.4 default)"
					});
					return;
				}
				const body = JSON.parse(await readBody(req));
				const vaultFile = join(memoryRoot(), "vault.md");
				const text = existsSync(vaultFile) ? readFileSync(vaultFile, "utf8") : "";
				const entries = VaultStore.parseMarkdown(text);
				const written = await deps.vault.importEntries(entries, { confirmClear: body.confirmClear === true });
				json(res, 200, {
					ok: true,
					entries: entries.length,
					written
				});
			} catch (error) {
				json(res, error.statusCode ?? 400, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-memory/api/session",
		handler: async (req, res) => {
			try {
				if (!guardLoopback(req)) {
					json(res, 403, {
						ok: false,
						error: "dsh-memory is local-only"
					});
					return;
				}
				const rest = new URL(req.url ?? "/", "http://localhost").pathname.slice(23);
				const sessionId = rest.startsWith("/") ? rest.slice(1) : rest;
				if (!isSafeSessionId(sessionId)) {
					json(res, 400, {
						ok: false,
						error: "invalid session id"
					});
					return;
				}
				if (req.method === "POST") {
					const guard = guardStateChange(req);
					if (guard !== true) {
						json(res, guard.status, {
							ok: false,
							error: guard.error
						});
						return;
					}
					const body = JSON.parse(await readBody(req));
					if (typeof body.memory === "string") sessionStore.writeMemory(sessionId, body.memory);
					const inject = sanitizeInject(body.inject);
					if (inject !== null) sessionStore.writeInject(sessionId, inject);
					json(res, 200, {
						ok: true,
						sessionId
					});
					return;
				}
				if (req.method === "DELETE") {
					const guard = guardStateChange(req, "DELETE");
					if (guard !== true) {
						json(res, guard.status, {
							ok: false,
							error: guard.error
						});
						return;
					}
					json(res, 200, {
						ok: true,
						sessionId,
						removed: sessionStore.deleteSession(sessionId)
					});
					return;
				}
				json(res, 200, sessionSnapshot(sessionStore, sessionId, deps.cwdOf(sessionId)));
			} catch (error) {
				json(res, error.statusCode ?? 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/dsh-memory/api/sessions",
		handler: async (req, res) => {
			try {
				if (!guardLoopback(req)) {
					json(res, 403, {
						ok: false,
						error: "dsh-memory is local-only"
					});
					return;
				}
				if (req.method !== "GET") {
					json(res, 405, {
						ok: false,
						error: "requires GET"
					});
					return;
				}
				const sessions = sessionStore.listSessions().map((s) => ({
					id: s.id,
					memory: s.memory,
					inject: s.inject,
					memoryMtime: s.memoryMtime,
					injectMtime: s.injectMtime
				}));
				json(res, 200, {
					ok: true,
					count: sessions.length,
					sessions
				});
			} catch (error) {
				json(res, error.statusCode ?? 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	disposers.push(ctx.webServer.register({
		kind: "exact",
		path: "/dsh-memory/api/projects",
		handler: async (req, res) => {
			try {
				if (!guardLoopback(req)) {
					json(res, 403, {
						ok: false,
						error: "dsh-memory is local-only"
					});
					return;
				}
				const guard = guardStateChange(req);
				if (guard !== true) {
					json(res, guard.status, {
						ok: false,
						error: guard.error
					});
					return;
				}
				const body = JSON.parse(await readBody(req));
				if (typeof body.key !== "string" || !isSafeProjectKey(body.key)) {
					json(res, 400, {
						ok: false,
						error: "invalid project key (use letters, digits, . _ -)"
					});
					return;
				}
				sessionStore.createNamedProject(body.key);
				json(res, 200, {
					ok: true,
					key: body.key
				});
			} catch (error) {
				json(res, error.statusCode ?? 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}));
	return () => {
		for (const d of disposers) d();
	};
}
//#endregion
//#region src/auto-vault.ts
/** Concatenated text of the claimed user messages (query source for auto retrieval). */
function userMessageText(messages) {
	const parts = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") parts.push(content);
		else for (const part of content) if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n").trim();
}
/** Gate selector: env `off` → `always` (gate off); `llm` needs a judge. */
function gateMode(gateEnv) {
	if (gateEnv === "off") return "always";
	if (gateEnv === "llm") return "llm";
	return "heuristic";
}
/**
* Resolve the effective gate mode for one pre-step turn.
* - Explicit env `DSH_MEMORY_AUTO_VAULT_GATE` wins over the conversation.
* - Without it: conversation mode `off` (feature off) → `'skip'`; otherwise
*   the conversation's mode is used as-is.
* Pure and testable so the host integration branch is smoke-covered.
*/
function resolveTurnGate(envGate, conversationGate) {
	if (envGate !== void 0) return gateMode(envGate);
	return conversationGate === "off" ? "skip" : conversationGate;
}
/**
* Parse the judge model env (`DSH_MEMORY_JUDGE_MODEL`) as `provider/model`.
* Unparseable or missing → the default DeepSeek route. Pure and testable.
*/
function parseJudgeModel(env) {
	const [provider, model] = (env ?? "").trim().split("/");
	if (provider !== void 0 && provider !== "" && model !== void 0 && model !== "") return {
		provider,
		model
	};
	return {
		provider: "deepseek-official",
		model: "deepseek-chat"
	};
}
/**
* Unified gate decision. `mode`:
* - 'always'    → always retrieve (gate off; reachable only via an explicit
*                 `DSH_MEMORY_AUTO_VAULT_GATE=off` env — see resolveTurnGate)
* - 'heuristic' → local rules (shouldAutoRetrieve)
* - 'llm'       → the judge decides; on error/timeout/missing judge it
*                 degrades to the heuristic (never breaks the turn)
*/
async function decideAutoRetrieve(text, mode, judge) {
	if (mode === "always") return true;
	if (mode === "llm" && judge !== void 0) try {
		return await judge(text);
	} catch {}
	return shouldAutoRetrieve(text);
}
/**
* Pure greeting / ack / continue chatter — never worth a vault lookup.
* One or more of these words (any order) plus trailing particles/punctuation
* only, so "嗯嗯好的没问题那我们继续" and "好的收到明白" both match while
* "继续干活" does not.
*/
const SKIP_RE = /^(?:你好|您好|嗨|哈喽|hello|hi|hey|在吗|谢谢|感谢|辛苦了|再见|拜拜|晚安|好的|好|嗯|哦|ok|okay|可以|行|没问题|收到|明白|知道了|继续|继续吧|请继续|下一步|然后呢|加油|牛|厉害|不错|真棒|对|是的|没错|同意|那我们继续|没问题那我们继续)+(?:吧|呀|啊)*[\s!！。.,，~～]*$/i;
/** Signals the message asks about something remembered — always retrieve. */
const TRIGGER_RE = /(?:之前|上次|以前|过去|还记得|忘了|我们做过|我们说过|之前说|那个|当时|项目|插件|记忆|配置|文档|方案|(?<!没)问题|bug|报错|如何|怎么|为什么|是什么|在哪|多少|哪里|能不能|是否|记录|日志|清单|进展|历史|经过|详情|内容|信息|状态|结果)/i;
/**
* Below this length and without a trigger word the message is too vague.
* Long-enough chatter without trigger words (e.g. "嗯嗯好的没问题那我们继续")
* can still slip through the fallback — a known heuristic limit; the skip
* list covers the common combos. Trigger-word messages are length-independent.
*/
const MIN_LEN_FOR_DEFAULT = 12;
/**
* Heuristic gate: should this user message trigger an automatic vault
* retrieval? Pure and local — no LLM call, nothing leaves the box.
* Known limitation (documented): the word lists are heuristic — a message
* can be missed (no trigger word, short) or let through (long chatter).
*/
function shouldAutoRetrieve(text) {
	const t = text.trim();
	if (t === "") return false;
	if (SKIP_RE.test(t)) return false;
	if (TRIGGER_RE.test(t)) return true;
	return t.length >= MIN_LEN_FOR_DEFAULT;
}
/**
* Enrich the retrieval query with recent context (current message first).
* Single short messages often carry too little semantics; appending the last
* distinct user message(s) gives the embedder more to match on. The caller
* supplies `recent` (last turns' user text, newest first, when available);
* empty when the hook only sees the current turn.
*/
function enhanceRetrieveQuery(current, recent) {
	const parts = [current.trim()];
	for (const r of recent) {
		const s = r.trim();
		if (s === "" || s === current.trim()) continue;
		parts.push(s);
		if (parts.length >= 3) break;
	}
	return parts.join(" ").slice(0, 400);
}
/** Render auto-retrieved vault hits as the injected text block ('' when empty). */
function renderVaultHits(hits) {
	if (hits.length === 0) return "";
	return "## 记忆检索（自动：按当前消息从 Vault 语义检索）\n" + hits.map((h) => `- [${h.score.toFixed(2)}] ${h.content.replace(/\s*\n+\s*/g, " ").trim()}`).join("\n") + "\n（需要更全面结果时用 memory 工具 vault search）";
}
//#endregion
//#region src/index.ts
const name = "dsh-persist";
const inject = [
	"tools",
	"systemPrompt",
	"webServer",
	"sessions",
	"agents"
];
const injectEnabled = process.env.DSH_MEMORY_INJECT !== "0";
/**
* Vault semantic-search relevance threshold. bge-m3 scores unrelated Chinese
* short sentences around 0.4–0.5, so 0.5 is the tuned cutoff (lesson learned).
*/
const VAULT_MIN_SCORE = .5;
/**
* LLM-judge failure warnings are throttled to once per interval so a
* persistently misconfigured judge (e.g. default deepseek route without a
* key) degrades silently after the first diagnosable warning (review P3-4).
*/
const JUDGE_WARN_INTERVAL_MS = 6e4;
let lastJudgeWarnAt = 0;
/**
* Vault namespaces arrive from the model (memory tool args). Keep them strict
* so export/import round-trips can never be corrupted by weird characters
* (parseMarkdown reads namespace with (\S+) — a space would split the header).
*/
const SAFE_NAMESPACE = /^[A-Za-z0-9._-]{1,64}$/;
/** Upper bound for a single memory content write (100 KB — far beyond any sane note). */
const MAX_CONTENT_LEN = 102400;
/**
* node:sqlite availability: built-in from Node 22.5.0 but only DEFAULT-enabled
* from 23.4.0 (stable in 24). On older runtimes the plugin must degrade —
* the vault tool reports unavailable instead of failing the whole plugin.
*/
const vaultAvailable = (() => {
	try {
		createRequire(import.meta.url)("node:sqlite");
		return true;
	} catch {
		return false;
	}
})();
/**
* Walk the session parent chain to the owning conversation. Subagents share
* their parent conversation's inject config and memory: the memory tab edits
* the conversation, so the conversation's selection must govern every agent
* working inside it. Bounded (a malicious/cyclic header chain cannot loop).
*
* TRUST BOUNDARY (design, not a security fence): any agent with a session
* context may write the owning conversation's memory — the plugin trusts the
* harness's agent/session identity. A destroyed mid-chain session stops the
* walk at the deepest locatable ancestor (get() → undefined → break). The
* 20-hop cap means an extremely deep subagent chain stops at the deepest
* locatable ancestor instead of the root conversation — bounded degradation
* (its inject config then reads as not-opted-in → no retrieval), never a crash.
*/
function conversationSessionId(ctx, sessionId) {
	let current = sessionId;
	for (let hops = 0; hops < 20; hops += 1) {
		const parent = ctx.sessions.get(current)?.header.parentSession;
		if (parent === void 0) break;
		current = String(parent);
	}
	return current;
}
function apply(ctx) {
	const store = new MemoryStore();
	const profile = new ProfileStore();
	const vault = vaultAvailable ? new VaultStore() : null;
	const sessions = new SessionMemoryStore();
	registerWebUi(ctx, {
		sessionStore: sessions,
		cwdOf: (sessionId) => ctx.sessions.get(sessionId)?.header.cwd,
		vault
	});
	const judgeModel = parseJudgeModel(process.env.DSH_MEMORY_JUDGE_MODEL);
	const judgeTimeoutMs = Math.max(1e3, Number(process.env.DSH_MEMORY_JUDGE_TIMEOUT_MS ?? 5e3) || 5e3);
	const llmService = ctx.get("llm");
	const judge = llmService === void 0 ? void 0 : async (text) => {
		const system = "你是记忆检索过滤器。判断这条用户消息是否需要检索历史记忆：提到过去的事、项目、插件、配置、文档、问题、方案等具体主题时需要；纯寒暄、确认、继续、简单命令不需要。只回答 yes 或 no。";
		let out = "";
		try {
			for await (const chunk of llmService.stream({
				provider: judgeModel.provider,
				model: judgeModel.model,
				system,
				messages: [{
					role: "user",
					content: [{
						type: "text",
						text
					}]
				}],
				temperature: 0,
				maxTokens: 8,
				signal: AbortSignal.timeout(judgeTimeoutMs)
			})) if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				out += chunk.text;
				const low = out.toLowerCase();
				if (low.includes("yes") || low.includes("no")) break;
			}
			if (out.trim() === "") throw new Error("empty judge response (no text-delta chunks)");
		} catch (error) {
			const now = Date.now();
			if (now - lastJudgeWarnAt > JUDGE_WARN_INTERVAL_MS) {
				lastJudgeWarnAt = now;
				console.warn(`[dsh-persist] LLM judge unavailable (${judgeModel.provider}/${judgeModel.model}):`, error instanceof Error ? error.message : String(error), "— degraded to heuristic; set DSH_MEMORY_JUDGE_MODEL=provider/model to use your own model");
			}
			throw new Error("memory judge call failed");
		}
		return out.trim().toLowerCase().startsWith("yes");
	};
	const autoVaultEnv = process.env.DSH_MEMORY_AUTO_VAULT;
	const autoVaultGateEnv = gateMode(process.env.DSH_MEMORY_AUTO_VAULT_GATE);
	const autoVaultNamespaces = process.env.DSH_MEMORY_AUTO_VAULT_NAMESPACES?.split(",").map((s) => s.trim()).filter((s) => s !== "");
	const AUTO_VAULT_TOP_K = 3;
	ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		if (vault === null || step !== 1) return decision;
		if (autoVaultEnv === "0") return decision;
		let gate = autoVaultGateEnv;
		if (autoVaultEnv !== "1") {
			const sid = agent?.session?.id;
			if (sid === void 0) return decision;
			const conversationId = conversationSessionId(ctx, String(sid));
			const resolved = resolveTurnGate(process.env.DSH_MEMORY_AUTO_VAULT_GATE, sessions.inject(conversationId).autoVaultGate);
			if (resolved === "skip") return decision;
			gate = resolved;
		}
		try {
			const query = userMessageText(messages);
			if (query === "") return decision;
			if (!await decideAutoRetrieve(query, gate, judge)) return decision;
			const enriched = enhanceRetrieveQuery(query, []);
			const hits = await vault.search(enriched, AUTO_VAULT_TOP_K, autoVaultNamespaces, VAULT_MIN_SCORE);
			if (hits.length === 0) return decision;
			const text = renderVaultHits(hits);
			return {
				kind: "enter",
				messages: [...decision.messages, createUserMessage({
					content: [{
						type: "text",
						text
					}],
					source: {
						kind: "plugin",
						plugin: name,
						form: "snapshot",
						sections: [{
							name: "dsh-persist-vault",
							text
						}]
					}
				})]
			};
		} catch {
			return decision;
		}
	}, { prepend: true });
	ctx.systemPrompt.context({
		name: "dsh-persist-profile",
		order: 50,
		text: (assembleCtx) => {
			if (!injectEnabled) return "";
			const agent = assembleCtx.agent;
			if (agent === void 0) return "";
			const sessionId = conversationSessionId(ctx, String(agent.session.id));
			return sessions.render(sessionId, {
				user: profile.read("user").trim(),
				longTerm: profile.read("memory").trim(),
				keyed: store.all()
			});
		}
	});
	ctx.systemPrompt.section({
		name: "dsh-persist-guide",
		order: 60,
		text: "记忆系统使用指南（dsh-memory：所有记忆都是 ~/.dsh-memory/ 下的可读文件）：【分层 · ★2026-09-15 用户拍板后的口径★】1) 每轮注入层：`USER.md`（用户画像）／`MEMORY.md`（跨项目事实与教训）／`SOP.md`（协作规矩）；工作区侧另有 `AGENTS.md`（地图）、`INDEX.md`（项目总目录）、各项目 `PROJECT_LEDGER.md`（台账＝当前状态）。2) 对话记忆（默认 scope=conversation）：只属于当前对话的要点，action=add 追加。3) 台账／档案：项目进度写 `<项目>/PROJECT_LEDGER.md`（只放当前状态），细节、数字、证据写 `<项目>/PROJECT_LEDGER_ARCHIVE.md`（不进上下文）。4) Vault 语义记忆（action=vault）：大容量知识库，按语义检索（vaultOp=search）——细节经验、完成项目的归档都放这里，一条一个主题。5) 懂你档案 `impressions/` ＝ `USER.md` 的档案层。【★两层已废弃（2026-09-15）★】项目记忆（scope=project）与关键记忆（memory.json 的 keyed 用法）**不要再写**：项目进展写台账，跨项目事实写 MEMORY.md 或 Vault。【自动写入标准】完成里程碑/任务、解决踩坑、环境或配置变化、作出关键决策、用户明确要求记。【定期清理标准】发现注入的记忆有重复/过时/已完成的一次性状态时主动精简或删除。【归档铁律】归档完成后：①台账里该项目的细节精简为指针 ②检查 MEMORY.md 里的详细内容精简为指针 ③对话记忆里的完成记录压缩为一行。【防重复铁律】同一事实只写一层：项目进度写台账、跨项目事实写 MEMORY.md、细节写档案或 Vault；add 会自动跳过重复行，但「换层重写同一事实」不会被拦，靠本条约束。【共同规则】只记值得保留的要点，不要每轮都记、不要记琐碎过程；写入前先 read 保留原结构。"
	});
	ctx.tools.register(defineTool({
		name: "memory",
		description: "Manage persistent memory. Actions: \"add\" (append a note), \"profile\" to read/write USER.md or MEMORY.md, \"vault\" to add or semantically search memories. scope: \"conversation\" (default) writes to THIS conversation's own memory (add appends a note; list reads it). ★项目记忆(project)／关键记忆(global keyed) 已于 2026-09-15 废弃★：项目进展写该项目台账 PROJECT_LEDGER.md，跨项目事实写 MEMORY.md 或 vault。★写入已硬拦★：`scope=project` 或 keyed（`scope=global`）的 `add` 一律直接报错、不写任何文件。`action=vault` 与 scope 无关（不需要再带 `scope=global`，2026-09-15 已修好路由）。Prefer dense, high-information sentences. Files live in ~/.dsh-memory/ — all human-readable and editable (the memory tab in the UI edits them).",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: add | get | search | delete | profile | vault"
			},
			scope: {
				type: "string",
				description: "Target memory: conversation (default)。★project／global 的 add 写入已硬拦（直接报错、不落文件）；`action=vault` 与 scope 无关（不用再带 global）★"
			},
			key: {
				type: "string",
				description: "Memory key (for global add/get/search/delete)."
			},
			content: {
				type: "string",
				description: "Memory content (for add, profile write, vault add)."
			},
			profileKind: {
				type: "string",
				description: "User|memory profile file (for profile)."
			},
			profileOp: {
				type: "string",
				description: "read|write (for profile)."
			},
			namespace: {
				type: "string",
				description: "Namespace/scope for vault or global add (default \"user\"). Use this to isolate projects."
			},
			vaultOp: {
				type: "string",
				description: "add|search|list|delete|export|import (for vault)."
			},
			id: {
				type: "number",
				description: "Vault entry id (for vault delete)."
			},
			query: {
				type: "string",
				description: "Search text (for vault search, or get by key)."
			},
			topK: {
				type: "number",
				description: "How many vault hits (default 5)."
			},
			confirmClear: {
				type: "boolean",
				description: "Vault import: explicitly allow clearing the DB when vault.md parses to no [id] entries (destructive)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args, exec) {
			if (typeof args.content === "string" && args.content.length > MAX_CONTENT_LEN) return {
				ok: false,
				error: `content too long (max ${MAX_CONTENT_LEN} chars)`
			};
			// ★2026-09-15（用户拍板"顺手修"）：vault 与 scope 无关，但它的 case 挂在最下面那个 switch 里 ——
			//   以前用默认 scope 调 action=vault 会掉进 conversation 分支、报 "unknown action for conversation scope: vault"，
			//   逼调用方显式传 scope=global（而 global 又正好是被废弃的那层，自相矛盾）。
			//   这里把 vault 的 scope 规范化成 "vault" → 直接落到 case "vault"；显式传 global/project 的老写法照样走通（向后兼容）。
			const scope = args.action === "vault" ? "vault" : (args.scope ?? "conversation");
			const sessionId = exec.agent?.session !== void 0 ? String(exec.agent.session.id) : void 0;
			const cwd = exec.agent?.session?.header.cwd;
			if (scope === "conversation") {
				if (sessionId === void 0) return {
					ok: false,
					error: "conversation scope needs a live session context"
				};
				const conversationId = conversationSessionId(ctx, sessionId);
				switch (args.action) {
					case "add": {
						if (args.content === void 0) return {
							ok: false,
							error: "add requires content"
						};
						const { fresh, duplicated } = dedupeAppendLines(sessions.memory(conversationId), args.content);
						if (fresh !== "") sessions.appendMemory(conversationId, fresh);
						const out = {
							ok: true,
							scope: "conversation",
							conversation: conversationId,
							action: "add",
							duplicated
						};
						if (duplicated > 0) out.note = `已跳过 ${duplicated} 行与已有记忆重复的内容`;
						return out;
					}
					case "list":
					case "search": return {
						ok: true,
						scope: "conversation",
						conversation: conversationId,
						memory: sessions.memory(conversationId)
					};
					case "get":
					case "delete": return {
						ok: false,
						error: "★项目记忆／关键记忆已于 2026-09-15 废弃★：项目进展写 <项目>/PROJECT_LEDGER.md（台账＝当前状态），细节与证据写 PROJECT_LEDGER_ARCHIVE.md，跨项目事实写 MEMORY.md 或 vault"
					};
					default: return {
						ok: false,
						error: `unknown action for conversation scope: ${String(args.action)}`
					};
				}
			}
			if (scope === "project") {
				// ★add 在**最前面**挡掉：连"项目登记表"都不许碰★
				//   （2026-09-15 夹具实测：闸放在下面的 switch 里时，rememberProjectCwd 仍会写 `projects/<key>/` 2 个文件 → 那种"硬拦"名不副实）
				if (args.action === "add") return {
					ok: false,
					error: "★项目记忆／关键记忆已于 2026-09-15 废弃★：add 的写入已被硬拦（本次没有写任何文件）。项目进展写 <项目>/PROJECT_LEDGER.md（台账＝当前状态），细节与证据写 PROJECT_LEDGER_ARCHIVE.md，跨项目事实写 MEMORY.md 或 vault"
				};
				const conversationId = sessionId === void 0 ? void 0 : conversationSessionId(ctx, sessionId);
				const projectKey = conversationId === void 0 ? sessions.projectKeyOf(cwd) : sessions.projectKeyOfSession(conversationId, cwd);
				if (projectKey === void 0) return {
					ok: false,
					error: "project scope needs a session with a working directory (or a chosen project)"
				};
				if (cwd !== void 0) sessions.rememberProjectCwd(projectKey, cwd);
				switch (args.action) {
					case "list":
					case "search": return {
						ok: true,
						scope: "project",
						project: projectKey,
						memory: sessions.projectMemory(projectKey)
					};
					case "get":
					case "delete": return {
						ok: false,
						error: "★项目记忆／关键记忆已于 2026-09-15 废弃★：项目进展写 <项目>/PROJECT_LEDGER.md（台账＝当前状态），细节与证据写 PROJECT_LEDGER_ARCHIVE.md，跨项目事实写 MEMORY.md 或 vault"
					};
					default: return {
						ok: false,
						error: `unknown action for project scope: ${String(args.action)}`
					};
				}
			}
			switch (args.action) {
				case "add": return {
					ok: false,
					error: "★关键记忆（memory.json keyed）已于 2026-09-15 废弃★：add 的写入已被硬拦（本次没有写任何文件）。跨项目事实写 MEMORY.md；细节/归档写 vault（action=vault 仍须带 scope=global 才走通，那是历史路由，与本条限制无关）"
				};
				case "get": {
					if (args.key === void 0) return {
						ok: false,
						error: "get requires key"
					};
					const entry = store.get(args.key);
					return entry === void 0 ? {
						ok: true,
						scope: "global",
						found: false,
						key: args.key
					} : {
						ok: true,
						scope: "global",
						found: true,
						key: args.key,
						content: entry.content
					};
				}
				case "search": return {
					ok: true,
					scope: "global",
					count: store.keys().length,
					keys: store.keys()
				};
				case "delete":
					if (args.key === void 0) return {
						ok: false,
						error: "delete requires key"
					};
					return {
						ok: true,
						scope: "global",
						removed: store.delete(args.key),
						key: args.key
					};
				case "profile": {
					const kind = args.profileKind === "memory" ? "memory" : "user";
					if ((args.profileOp ?? "read") === "write") {
						if (args.content === void 0) return {
							ok: false,
							error: "profile write requires content"
						};
						profile.write(kind, args.content);
						return {
							ok: true,
							kind,
							op: "write",
							bytes: args.content.length
						};
					}
					return {
						ok: true,
						kind,
						op: "read",
						sections: profile.sections(kind).map((s) => ({
							heading: s.heading,
							lines: [...s.lines]
						}))
					};
				}
				case "vault": {
					if (vault === null) return {
						ok: false,
						error: "vault unavailable: node:sqlite needs Node >= 22.6 (22.x with --experimental-sqlite, 23.4+ default); keyed/profile memory still work"
					};
					const op = args.vaultOp ?? "search";
					const nsRaw = args.namespace ?? "user";
					if (!SAFE_NAMESPACE.test(nsRaw)) return {
						ok: false,
						error: "invalid namespace (use [A-Za-z0-9._-]{1,64})"
					};
					const ns = nsRaw;
					if (op === "add") {
						if (args.content === void 0) return {
							ok: false,
							error: "vault add requires content"
						};
						const result = await vault.add(args.content, ns);
						return {
							ok: true,
							id: result.id,
							namespace: ns,
							embedder: result.embedded ? "semantic" : "keyword"
						};
					}
					if (op === "list") {
						const entries = vault.list(ns);
						return {
							ok: true,
							namespace: ns,
							count: entries.length,
							entries: entries.map((e) => ({
								id: e.id,
								content: e.content,
								createdAt: e.createdAt
							}))
						};
					}
					if (op === "delete") {
						if (typeof args.id !== "number" || !Number.isInteger(args.id) || args.id < 0) return {
							ok: false,
							error: "vault delete requires a numeric id (see vault list)"
						};
						return {
							ok: true,
							removed: vault.delete(args.id),
							id: args.id
						};
					}
					if (op === "export") {
						const md = vault.exportMarkdown();
						const vaultFile = vault.vaultMdPath();
						writeFileSync(vaultFile, md, { mode: 384 });
						return {
							ok: true,
							path: vaultFile,
							bytes: md.length,
							count: vault.count()
						};
					}
					if (op === "import") {
						const vaultFile = vault.vaultMdPath();
						if (!existsSync(vaultFile)) return {
							ok: false,
							error: `vault.md not found at ${vaultFile} — run vault export first`
						};
						const text = readFileSync(vaultFile, "utf8");
						const entries = VaultStore.parseMarkdown(text);
						try {
							const written = await vault.importEntries(entries, { confirmClear: args.confirmClear === true });
							return {
								ok: true,
								path: vaultFile,
								entries: entries.length,
								written
							};
						} catch (error) {
							return {
								ok: false,
								error: error instanceof Error ? `${error.message} — 如确认要清空，请传 confirmClear=true 或使用管理页面的 Vault 同步` : String(error)
							};
						}
					}
					const q = args.query ?? "";
					if (q === "") return {
						ok: true,
						count: vault.count(ns),
						namespace: ns,
						note: "empty query — count only"
					};
					const k = Math.max(1, Math.min(args.topK ?? 5, 50));
					const hits = await vault.search(q, k, ns, VAULT_MIN_SCORE);
					return {
						ok: true,
						namespace: ns,
						embedder: isConfigured() ? "semantic" : "keyword",
						count: hits.length,
						hits: hits.map((h) => ({
							id: h.id,
							content: h.content,
							score: Number(h.score.toFixed(3))
						}))
					};
				}
				default: return {
					ok: false,
					error: `unknown action: ${String(args.action)}`
				};
			}
		}
	}));
}
//#endregion
export { apply, inject, name };
// --- 本地分叉：仅供离线验证用的额外导出（不是公开 API，上游没有） ---
export { VaultStore, isConfigured, resolveEmbedder };

