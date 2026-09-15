// dsh-memory-app 客户端（**一个模块 = 两半合并**）★2026-09-16★
//   上半 = 本插件原有的「记忆系统」设置卡；下半 = 收进包内的 dsh-persist 分叉的「记忆」tab。
//   两半各包一层 IIFE：各自有自己的 module/exports 与局部名（apply/save/t/NS…）——
//   直接拼会重名（实测撞 7 个：apply/exports/load/module/next/save/t），用作用域隔离代替重命名。
window.__ModuleLoader__.load({
	id: "dsh-memory-app",
	factory: (require) => {
		var PART_APP = (function () {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		// ── 样式：只用 DSH 真实主题 token（经 Inspect/Theme 查得，别猜）──
		// 可用: --dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay /
		//   border-l1 / border-l2 / brand-primary / label-primary / label-secondary /
		//   state-error-primary / state-success-primary / state-warn-primary
		var T = {
			text: "var(--dsw-alias-label-primary)",
			dim: "var(--dsw-alias-label-secondary)",
			border: "var(--dsw-alias-border-l1)",
			borderStrong: "var(--dsw-alias-border-l2)",
			surface: "var(--dsw-alias-bg-layer-2)",
			base: "var(--dsw-alias-bg-base)",
			brand: "var(--dsw-alias-brand-primary)",
			ok: "var(--dsw-alias-state-success-primary)",
			err: "var(--dsw-alias-state-error-primary)",
			warn: "var(--dsw-alias-state-warn-primary)"
		};

		var S = {
			title: { fontSize: 13, fontWeight: 600, color: T.text },
			hint: { fontSize: 11.5, lineHeight: 1.6, color: T.dim },
			block: { display: "flex", flexDirection: "column", gap: 8, padding: "6px 2px" },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			label: { fontSize: 12, color: T.dim, width: 64, flexShrink: 0 },
			input: {
				fontSize: 12, padding: "5px 8px", borderRadius: 6, minWidth: 0,
				border: "1px solid " + T.borderStrong, background: T.base, color: T.text
			},
			// 真按钮：有底、有框、有明确的文字颜色。
			// 特别注意：**不要**用品牌色打底 + 白字（浅色主题下会变成白底白字隐身）。
			btn: {
				fontSize: 12, lineHeight: 1.2, padding: "5px 12px", borderRadius: 6, cursor: "pointer",
				border: "1px solid " + T.borderStrong, background: T.surface, color: T.text,
				whiteSpace: "nowrap"
			},
			btnMain: {
				fontSize: 12, lineHeight: 1.2, padding: "5px 12px", borderRadius: 6, cursor: "pointer",
				border: "1px solid " + T.brand, background: T.surface, color: T.brand,
				fontWeight: 600, whiteSpace: "nowrap"
			},
			btnOff: {
				fontSize: 12, lineHeight: 1.2, padding: "5px 12px", borderRadius: 6,
				cursor: "not-allowed", opacity: 0.5,
				border: "1px solid " + T.border, background: T.surface, color: T.dim,
				whiteSpace: "nowrap"
			},
			card: {
				display: "flex", flexDirection: "column", gap: 5,
				padding: "10px 12px", borderRadius: 8,
				border: "1px solid " + T.border, background: T.surface
			},
			divider: { height: 1, background: T.border, margin: "2px 0" }
		};

		function Btn(props) {
			var style = props.disabled ? S.btnOff : (props.main ? S.btnMain : S.btn);
			return React.createElement("button", {
				type: "button", disabled: !!props.disabled, style: style, onClick: props.onClick
			}, props.children);
		}

		function Field(props) {
			return React.createElement("div", { style: S.row },
				React.createElement("span", { style: S.label }, props.label),
				props.children,
				props.note ? React.createElement("span", { style: S.hint }, props.note) : null
			);
		}

		function Select(props) {
			return React.createElement("select", {
				value: props.value,
				onChange: function (e) { props.onChange(e.target.value); },
				style: Object.assign({}, S.input, { maxWidth: 300, cursor: "pointer" })
			}, props.options.map(function (o) {
				return React.createElement("option", { key: o[0], value: o[0], style: { color: "#1a1a1a", background: "#fff" } }, o[1]);
			}));
		}

		// ── 设置页「记忆」：状态优先 + 渐进披露 ──────────────────────
		function MemorySettings() {
			var st = React.useState(null); var status = st[0]; var setStatus = st[1];
			// Vault 同步状态（索引过期了没）—— 单独一条，别跟嵌入器状态混
			var vsSt = React.useState(null); var vaultSync = vsSt[0]; var setVaultSync = vsSt[1];
			var dt = React.useState(null); var draft = dt[0]; var setDraft = dt[1];
			var bu = React.useState(false); var busy = bu[0]; var setBusy = bu[1];
			var te = React.useState(null); var test = te[0]; var setTest = te[1];
			var er = React.useState(""); var err = er[0]; var setErr = er[1];
			var sv = React.useState(false); var justSaved = sv[0]; var setJustSaved = sv[1];

			// ★★ 响应形状必须校验 —— 2026-09-13 真事故 ★★
			// 用户报："设置里的记忆模块全没了，点了一下 Vault 更新就这样了"。
			// 根因：Vault 重建按钮**复用了给 Ollama 路由写的 `act()`**，而 `/vault-sync/run`
			// 返回的是**同步结果**、里面**没有 `config`**。原来的 applyStatus 不校验，
			// 直接把"同步结果"当配置塞进 state → 紧接着 `d.config.mode` 抛错；
			// 更糟的是 `setStatus(d)` **已经生效了** → 带着畸形 status 重渲染 → 读 `cfg.isLocal` 再炸一次
			// → **React 把整个「记忆」区块摘掉**（刷新才回来）。
			// 教训：**跨接口复用"发请求"的函数时，必须校验回来的东西是不是你以为的那个形状**；
			//      一个"想当然的形状假设"就能把整块 UI 干掉。
			// 所以这里**形状不对就原样退回、绝不污染 state**（返回 false 让调用方知道没吃下）。
			function applyStatus(d) {
				if (!d || typeof d !== "object" || !d.config || typeof d.config !== "object") return false;
				setStatus(d);
				setDraft({
					mode: d.config.mode,
					endpoint: d.config.endpoint,
					model: d.config.model,
					key: d.config.key || "",
					device: d.config.device,
					numCtx: d.config.numCtx
				});
				return true;
			}

			function load() {
				loadVaultSync();
				loadCorpus();
				loadView();
				return fetch("/dsh-memory-app/embedder")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (d && !d.error) applyStatus(d); })
					.catch(function () {});
			}

			// ── ⑧ 记忆视图（Obsidian）：打开 / 关闭 ──────────────────────────
			// ★用户 2026-09-15 提的★："希望 obsidian 能植入 DSH，通过某个控件打开和关闭"。
			// ★状态声明一律**加在最后**★（夹具 `verify_client_render` 靠 hook 下标摆数据，
			//   插在中间会把老场景的下标全顶偏 —— 加的时候顺手把它那几个常量也往后挪）。
			function loadView() {
				return fetch("/dsh-memory-app/view")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (d) setView(d); })
					.catch(function () {});
			}
			function viewAct(path, body) {
				if (viewBusy) return;
				setViewBusy(true); setViewMsg("");
				fetch(path, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body || {})
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						setViewBusy(false);
						// 结果如实说：打开 = "先刷了 N 份 · 库登记（加了/早有）· 现在开着没"；
						// 关闭 = "优雅关了 / 还有几个没退"。**不许把失败说成成功。**
						// ★2026-09-16★ 失败时**连 `hint` 一起说**（没装 Obsidian 会给出三条出路）；
						//   登记库失败也从 `registerError` 说出来 —— 旧版只判 `registered === "added"`，
						//   等于把"登记失败的原因"**静默吞掉**。
						if (d && d.ok === false) { setViewMsg((d.error || d.note || "没成功") + (d.hint ? "　" + d.hint : "")); return loadView(); }
						if (d.action === "close" || path.indexOf("/close") > 0) {
							setViewMsg(d.note || (d.running ? "还没退干净" : "已关闭"));
						} else {
							setViewMsg((d.refreshed && d.refreshed.ok ? "已先刷新 " + d.refreshed.files + " 份副本 · " : "") +
								(d.registered === "added" ? "已替你把这个库登记进 Obsidian · " : "") +
								(d.registerError ? "登记库没成功（" + d.registerError + "）· " : "") +
								(d.running ? "Obsidian 已启动" : "已交给 Obsidian 打开"));
						}
						return loadView();
					})
					.catch(function (e) { setViewBusy(false); setViewMsg(String(e.message || e)); });
			}

			// ── 语料自动转写（P1）：折叠后自动转 / 开机补扫 / 这里手动补 ────────
			// ★走自己的状态，**不复用 act()**★ —— 同 vault-sync 那条教训：`/corpus/run` 回的是
			//   转写报告、里面没有 config，复用 act() 会把畸形数据塞进 config state
			//   （2026-09-13 那次"整块记忆模块消失"就是这个形状假设造成的）。
			var cst = React.useState(null); var corpus = cst[0]; var setCorpus = cst[1];
			// ★记忆视图（Obsidian）的三个状态：**故意加在最后**★（老场景的 hook 下标一个都没动）
			var vst = React.useState(null); var view = vst[0]; var setView = vst[1];
			var vmsg = React.useState(""); var viewMsg = vmsg[0]; var setViewMsg = vmsg[1];
			var vbusy = React.useState(false); var viewBusy = vbusy[0]; var setViewBusy = vbusy[1];
			// ── ★维护（2026-09-16）★ 把 7 件"维护记忆系统"的事从"敲命令"变成"点按钮" ──────────
			//   数据面 = `/maintain/list` + `/maintain/run`；**作业的实现在插件 `lib/tools/` 里**
			//   （随插件发布 → 换台电脑也能用；本项目 `memory/tools/` 那边只剩薄壳）。
			//   设计取舍：**每个作业的原始输出原样展开**（不美化、不删行）—— 他要"看得见"。
			//   ★非 0 退出码不一定是"坏了"★：体检器/裁决台账/状态核对是"有待你裁的条目" →
			//   所以行尾显示「退出码 + 它到底是什么意思」，而不是一律盖红字（本项目的"假红"教训）。
			var mst = React.useState(null); var maint = mst[0]; var setMaint = mst[1];
			var mres = React.useState({}); var mRes = mres[0]; var setMRes = mres[1];
			var mbsy = React.useState(""); var mBusy = mbsy[0]; var setMBusy = mbsy[1];
			var mopn = React.useState(null); var mOpen = mopn[0]; var setMOpen = mopn[1];
			// ★`mExpand` 必须和上面几个一起、**放在组件早退之前**★（见渲染块那段注释：放后面会让 hook 数变化）
			var mexp = React.useState(false); var mExpand = mexp[0]; var setMExpand = mexp[1];
			function loadMaint() {
				return fetch("/dsh-memory-app/maintain/list")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (d) setMaint(d); })
					.catch(function () {});
			}
			function putRes(id, d) { setMRes(function (p) { var n = Object.assign({}, p); n[id] = d; return n; }); }
			function runMaint(id) {
				if (mBusy) return Promise.resolve();
				setMBusy(id); setMOpen(id);
				return fetch("/dsh-memory-app/maintain/run", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: id })
				})
					.then(function (r) { return r.json(); })
					.then(function (d) { putRes(id, d); setMBusy(""); },
						function (e) { putRes(id, { ok: false, error: String((e && e.message) || e) }); setMBusy(""); });
			}
			function runAllMaint() {
				var jobs = (maint && maint.jobs) ? maint.jobs.slice() : [];
				if (!jobs.length || mBusy) return;
				setMBusy("__all");
				var i = 0;
				var step = function () {
					if (i >= jobs.length) { setMBusy(""); return; }
					var job = jobs[i++];
					setMOpen(job.id);
					fetch("/dsh-memory-app/maintain/run", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: job.id })
					})
						.then(function (r) { return r.json(); })
						.then(function (d) { putRes(job.id, d); step(); },
							function (e) { putRes(job.id, { ok: false, error: String((e && e.message) || e) }); step(); });
				};
				step();
			}
			React.useEffect(function () { loadMaint(); }, []);
			function loadCorpus() {
				return fetch("/dsh-memory-app/corpus/status")
					.then(function (r) { return r.json(); })
					// ok:false 也要收下来 —— 前端"什么都不显示"比"显示读不到"更糟
					.then(function (d) { if (d) setCorpus(d); })
					.catch(function () {});
			}
			function runCorpus(all) {
				if (busy) return;
				setBusy(true); setErr("");
				fetch("/dsh-memory-app/corpus/run", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(all ? { all: true } : {})
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						setBusy(false);
						if (d && d.ok === false) {
							setErr(d.skipped === "disabled"
								? "自动转写已关闭（要跑得先删掉 corpus.disabled 那个开关文件）"
								: ("转写没成功：" + (d.error || d.skipped || "未知原因")));
						}
						return loadCorpus();
					})
					.catch(function (e) { setBusy(false); setErr("转写失败：" + e.message); });
			}

			function loadVaultSync() {
				return fetch("/dsh-memory-app/vault-sync/status")
					.then(function (r) { return r.json(); })
					// ★ok:false 也要收下来★ —— 前端"什么都不显示"比"显示一句说明"更糟：
					//   用户会以为这功能没了（2026-09-12 实测：重启后未发消息 → cwd 未知 → 整行消失）。
					.then(function (d) { if (d) setVaultSync(d); })
					.catch(function () {});
			}

			React.useEffect(function () {
				var dead = false;
				fetch("/dsh-memory-app/embedder")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (!dead && d && !d.error) applyStatus(d); else if (!dead && d) setErr("读配置失败：" + d.error); })
					.catch(function (e) { if (!dead) setErr("读配置失败：" + e.message); });
				fetch("/dsh-memory-app/vault-sync/status")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (!dead && d && d.ok) setVaultSync(d); })
					.catch(function () {});
				loadCorpus();
				loadView();
				return function () { dead = true; };
			}, []);

			// 预热/拉取进行中 → 每 2 秒刷新（必须放在早返回之前，否则 hooks 顺序会变）
			React.useEffect(function () {
				var warming = status && status.warming && status.warming.done === false;
				var pulling = status && status.pull && status.pull.done === false;
				if (!warming && !pulling) return;
				var t = setTimeout(function () { load(); }, 2000);
				return function () { clearTimeout(t); };
			}, [status]);

			if (!status || !draft) {
				return React.createElement("div", { style: Object.assign({}, S.block, S.hint) }, err || "正在读取记忆系统配置…");
			}
			// ★第二道保险★：就算 state 因为任何原因变成了别的形状，也**只显示一句话**，
			// 不许抛错把整块 UI 摘掉（用户看到的是"功能没了"，比看到"出错了"糟得多）。
			if (!status.config || typeof status.config !== "object") {
				return React.createElement("div", { style: Object.assign({}, S.block, S.hint) },
					"⚠️ 读到的配置状态形状不对（这本身是个 bug，请联系我）。点「重试」或刷新页面即可恢复。" +
					"　—— 收到的是：" + JSON.stringify(status).slice(0, 200));
			}

			var cfg = status.config;
			var gpuOf = function (id) { return (status.gpus || []).filter(function (g) { return g.id === id; })[0]; };
			var engineOk = cfg.isLocal ? (status.ollamaUp === true && status.modelPresent === true) : (cfg.key !== "");
			var loaded = status.loaded;

			var set = function (k, v) {
				var o = Object.assign({}, draft); o[k] = v;
				setDraft(o); setJustSaved(false);
			};

			function save() {
				setBusy(true); setErr("");
				fetch("/dsh-memory-app/embedder", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(draft)
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						setBusy(false);
						if (d.error) { setErr("保存失败：" + d.error); return; }
						applyStatus(d); setTest(null); setJustSaved(true);
					})
					.catch(function (e) { setBusy(false); setErr("保存失败：" + e.message); });
			}

			function runTest() {
				setBusy(true); setErr(""); setTest(null);
				fetch("/dsh-memory-app/embedder/selftest", { method: "POST" })
					.then(function (r) { return r.json(); })
					.then(function (d) { setBusy(false); setTest(d); })
					.catch(function (e) { setBusy(false); setErr("自检失败：" + e.message); });
			}

			function act(path, body) {
				setBusy(true); setErr("");
				fetch(path, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body || {})
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						setBusy(false);
						if (d.error) { setErr(d.error); return; }
						// ★这个函数只给"返回配置状态"的路由用（Ollama 启停等）★。
						//   applyStatus 现在会自己校验形状；万一形状不对，**报出来**而不是静默。
						if (!applyStatus(d)) {
							setErr("这条操作返回的不是配置状态（这是 bug）：" + JSON.stringify(d).slice(0, 160));
							return;
						}
						setTest(null);
						if (d.action === "start" && d.ready !== true) setErr("已发出启动，但还没就绪——再等几秒，或看 Ollama 自己的报错");
					})
					.catch(function (e) { setBusy(false); setErr(e.message); });
			}

			// ★「重建 Vault 索引」走自己的路，**不能复用 act()** ★
			// 因为 `/vault-sync/run` 回的是"同步结果"（没有 config），而复用 act() 正是
			// 2026-09-13 那次"记忆模块整个消失"的根因（详见 applyStatus 上面的注释）。
			// 另外重建要几十秒（12 个分区逐个重算向量），所以**要明确告诉用户"在跑、别急"**。
			function rebuildVault() {
				setBusy(true); setErr("");
				fetch("/dsh-memory-app/vault-sync/run", {
					method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						setBusy(false);
						if (d && d.ok === false) {
							var why = d.error || (d.failed && d.failed.length
								? d.failed.map(function (f) { return f.ns + "：" + f.error; }).join("；")
								: "未知原因");
							setErr("重建没成功：" + why);
						}
						// 不管成没成，都把状态重新拉一遍 —— 界面才有变化可看
						return loadVaultSync();
					})
					.catch(function (e) { setBusy(false); setErr("重建失败：" + e.message); });
			}

			// ── 状态区：把"引擎可用"和"模型此刻在不在"分开说 ──
			var head = [];
			head.push(React.createElement("div", { style: S.row },
				React.createElement("span", { style: { fontSize: 13, color: engineOk ? T.ok : T.err } }, "●"),
				React.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: T.text } },
					engineOk ? "语义检索可用" : "已降级：只能按关键词找")
			));
			head.push(React.createElement("div", { style: S.hint },
				(cfg.isLocal ? "本机 " + cfg.model : "云端 " + cfg.model) +
				(cfg.isLocal ? " · " + (cfg.device === "cpu" ? "CPU（零显存）" : cfg.device === "auto" ? "自动选卡" : (gpuOf(cfg.device) ? "#" + cfg.device + " " + gpuOf(cfg.device).name : "显卡 #" + cfg.device)) : "") +
				(cfg.isLocal ? " · 上下文 " + cfg.numCtx : "")));
			if (cfg.isLocal) {
				head.push(React.createElement("div", { style: S.hint },
					loaded
						? "模型：已加载（占 " + loaded.sizeMiB + " MiB" + (loaded.vramMiB > 0 ? "，其中显存 " + loaded.vramMiB + " MiB" : "，全在内存、零显存") + "）"
						: (status.ollamaUp && status.modelPresent
							? "模型：当前未加载 —— 下次检索会自动加载（约 20–30 秒），也可点下面「预热模型」先备好"
							: "模型：未加载")));
			}
			if (status.hint) head.push(React.createElement("div", { style: { fontSize: 11.5, lineHeight: 1.6, color: T.err } }, status.hint));
			if (status.warming) {
				var w = status.warming;
				head.push(React.createElement("div", { style: { fontSize: 11.5, lineHeight: 1.6, color: w.done === false ? T.warn : (w.ok ? T.ok : T.err) } },
					w.done === false
						? "正在后台加载模型（约 20–30 秒，加载好就能立刻用）…"
						: (w.ok ? "已预热就绪（" + w.ms + " ms）" : "预热未完成：" + (w.error || "失败"))));
			}
			if (test) head.push(React.createElement("div", { style: { fontSize: 11.5, lineHeight: 1.6, color: test.ok ? T.ok : T.err } },
				(test.ok ? "自检通过：" : "自检未通过：") + test.message + (test.ms ? "（" + test.ms + " ms）" : "")));

			// ── Ollama 进程区：真按钮 ──
			var proc = [];
			// ── Vault 索引同步状态 ──
			// ★必须独立成一块、**永远显示**★ —— 它跟"嵌入器是本地还是云端"没关系：
			//   索引过期了就该说，云端模式一样会过期。
			// 2026-09-13 实测踩到：这段原来被塞在 `proc` 里，而 `proc` 又被包在
			//   `cfg.isLocal ? ... : null` 里面 → **云端模式的人根本看不到 Vault 过期提示、也没有重建按钮**
			//   （注释还写着"永远显示"，代码却是反的 —— 注释跟代码打架时，**信代码**）。
			// 教训：**"永远显示"这种东西不能靠注释保证，得让它真的在条件外面。**
			var vaultEls = [];
			if (vaultSync) {
				var stc = vaultSync.staleCount || 0;
				if (vaultSync.ok === false) {
					// ★绝不静默★：状态未知也要说出来，并告诉用户怎么让它变已知。
					//   （2026-09-12 实测：重启后未发消息 → cwd 未知 → 整行消失，用户以为功能没了）
					vaultEls.push(React.createElement("div", { key: "vsnone", style: T.hint },
						"⏳ Vault 索引：" + (vaultSync.error || "状态未知") +
						"（在本会话发一条消息后，它会自动学会工作区并同步）"));
				} else if (stc > 0) {
					vaultEls.push(React.createElement("div", {
						key: "vswarn",
						style: {
							fontSize: 11.5, lineHeight: 1.65, color: T.err,
							border: "1px solid " + T.err, borderRadius: 6,
							padding: "7px 9px", marginBottom: 6, width: "100%"
						}
					}, "⚠️ Vault 索引已过期（" + stc + " 个分区：目录/规则/台账/档案等）—— " +
						"现在检索到的可能是旧内容。启动时会自动重建；想立刻重建就点下面的按钮。"));
					vaultEls.push(React.createElement(Btn, {
						key: "vsrun", main: true, disabled: busy,
						onClick: function () { rebuildVault(); }
					}, busy ? "正在重建（要几十秒，别关页面）…" : "重建 Vault 索引（" + stc + " 个分区）"));
				} else {
					var last = vaultSync.lastAt ? String(vaultSync.lastAt).replace("T", " ").slice(0, 19) : "—";
					var disc = vaultSync.discovered || {};
					vaultEls.push(React.createElement("div", { key: "vsok", style: T.hint },
						"✓ Vault 索引已同步 · 上次 " + last +
						" · 发现 " + (disc.ledgers || 0) + " 份台账 / " + (disc.archives || 0) + " 份档案" +
						(vaultSync.synced ? " · 已建 " + vaultSync.synced.length + " 个分区" : "")));
				}
			}

			// ── 会话转写区（P1）──────────────────────────────────────────
			var corpusEls = [];
			if (corpus) {
				if (corpus.ok === false) {
					corpusEls.push(React.createElement("div", { key: "csnone", style: T.hint },
						"⏳ 会话转写：读不到状态（" + (corpus.error || "未知原因") + "）"));
				} else if (corpus.enabled === false) {
					corpusEls.push(React.createElement("div", { key: "csoff", style: T.hint },
						"语料自动转写：已关闭（开关文件 " + (corpus.disabledBy || "corpus.disabled") + "，删掉它就恢复）"));
				} else {
					var needN = corpus.needCount || 0;
					corpusEls.push(React.createElement("div", { key: "csline", style: T.hint },
						"✓ 会话转写已开 · 扫到 " + (corpus.scanned || 0) + " 份会话 · " +
						(needN > 0
							? ("有 " + needN + " 份待转写（每次折叠后自动转，也可现在手动补）")
							: "全部已转写、没有欠账")));
					if (needN > 0) {
						corpusEls.push(React.createElement(Btn, {
							key: "csrun", main: true, disabled: busy,
							onClick: function () { runCorpus(false); }
						}, busy ? "正在转写…" : ("立即转写（最多 5 份，还欠 " + needN + " 份）")));
					}
					if (corpus.recent && corpus.recent.length) {
						var lastLine = String(corpus.recent[corpus.recent.length - 1]).replace("T", " ");
						corpusEls.push(React.createElement("div", { key: "cslog", style: T.hint },
							"最近一次触发：" + (lastLine.length > 110 ? lastLine.slice(0, 110) + "…" : lastLine)));
					}
				}
			}

			// ── ⑧ 记忆视图（Obsidian）区：打开 / 关闭 ──────────────────────────
			// ★也独立成卡、同样在 isLocal 条件之外★（云端嵌入模式照样能打开视图翻东西）
			var viewEls = [];
			if (view) {
				viewEls.push(React.createElement("div", { key: "vline", style: T.hint },
					(view.running ? "✓ Obsidian 正在运行（pid " + (view.pids || []).join("、") + "）" : "Obsidian 当前没开") +
					" · 库：" + (view.vaultPath || view.error || "(还没定位到工作区)")));
				viewEls.push(React.createElement("div", { style: Object.assign({}, S.row, { marginTop: 2 }) },
					React.createElement(Btn, {
						main: true, disabled: viewBusy,
						onClick: function () { viewAct("/dsh-memory-app/view/open"); }
					}, viewBusy ? "正在刷新并打开…" : (view.running ? "刷新并打开" : "打开记忆视图")),
					view.running ? React.createElement(Btn, {
						disabled: viewBusy,
						onClick: function () { viewAct("/dsh-memory-app/view/close"); }
					}, "关闭") : null,
					// ★「强制关闭」只在"优雅关没关掉"之后才出现★ —— 免得它变成随手一点就强杀的东西
					(view.running && view.lastAction && view.lastAction.action === "close" && view.lastAction.ok === false)
						? React.createElement(Btn, {
							disabled: viewBusy,
							onClick: function () { viewAct("/dsh-memory-app/view/close", { force: true }); }
						}, "强制关闭") : null));
				viewEls.push(React.createElement("div", { key: "vhint", style: T.hint },
					"「打开」会**先刷新一遍视图**再打开（看到的永远是最新）；关闭默认是**优雅关**（Obsidian 自己存工作区），" +
					"没退干净才会冒出「强制关闭」。关掉的是**所有** Obsidian 窗口。"));
				if (viewMsg) viewEls.push(React.createElement("div", { key: "vmsg", style: { fontSize: 11.5, lineHeight: 1.6, color: T.ok } }, viewMsg));
			}
			// ── ★维护卡（2026-09-16）★ 默认**收起成一行**（用户反馈："是不是少了收起？现在有点太长了"）
			//   收起态：标题 + 一句状态摘要（跑过几项／几项有结果）+ 根目录 + 【全部跑一遍】【展开】。
			//   展开态：每行一个作业，**一行一个**（名字 + 状态 + 按钮）；作业说明与"退出码是什么意思"
			//   只在【看输出】展开时出现 —— 不再常驻占高度。结果永远**原样展开**（不美化、不删行）。
			//   ★这个 mexp/useState 挂在组件顶部（和别的维护 state 一起）★ —— 绝不能放在这里：
			//     组件首屏会**早退**（status 还没读到就 return 一句"正在读取…"），放在早退之后的 hook
			//     首屏不执行、第二次渲染才执行 → React 判"hook 数变了" → **整块 UI 被摘掉**
			//     （设置页里那一项直接消失，槽位标成 active:false。2026-09-16 真踩）。
			var maintEls = [];
			if (maint && maint.jobs) {
				var mRan = 0, mFlag = 0;
				for (var mi0 = 0; mi0 < maint.jobs.length; mi0++) {
					var r0 = mRes[maint.jobs[mi0].id];
					if (r0) { mRan++; if (!r0.ok) mFlag++; }
				}
				maintEls.push(React.createElement("div", { key: "mhead", style: S.row },
					React.createElement("span", { style: { fontWeight: 600 } }, "维护"),
					React.createElement("span", { style: S.hint },
						(mRan === 0 ? "点了才跑" : ("跑过 " + mRan + "/" + maint.jobs.length + (mFlag ? "（" + mFlag + " 项有结果待你看）" : "（都过）"))) +
						"　·　根目录 " + (maint.root || "还不知道") + "（" + maint.rootHow + "）"),
					React.createElement(Btn, { disabled: mBusy !== "", onClick: runAllMaint }, mBusy === "__all" ? "正在逐个跑…" : "全部跑一遍"),
					React.createElement(Btn, { onClick: function () { setMExpand(!mExpand); } }, mExpand ? "收起 ▴" : "展开 ▾")));
				if (maint.rootWarn) maintEls.push(React.createElement("div", { key: "mwarn", style: Object.assign({}, S.hint, { color: T.err }) }, "⚠ " + maint.rootWarn));
				if (mExpand) {
					for (var mi = 0; mi < maint.jobs.length; mi++) {
						(function (j) {
							var r = mRes[j.id];
							var line = r ? (r.ok ? "✓ 过" : "· 有结果") + "（exit " + r.exit + (r.ms ? "，" + r.ms + "ms" : "") + "）" : "还没跑过";
							maintEls.push(React.createElement("div", { key: "mj-" + j.id, style: { padding: "5px 0", borderTop: "1px solid " + T.border2 } },
								React.createElement("div", { style: Object.assign({}, S.row, { alignItems: "baseline" }) },
									React.createElement("span", { style: { fontWeight: 600, minWidth: 110 } }, j.name),
									React.createElement("span", { style: Object.assign({}, S.hint, { minWidth: 110 }) }, line),
									React.createElement(Btn, { disabled: mBusy !== "", onClick: function () { runMaint(j.id); } }, mBusy === j.id ? "跑着呢…" : "立即运行"),
									r ? React.createElement(Btn, { onClick: function () { setMOpen(mOpen === j.id ? null : j.id); } }, mOpen === j.id ? "收起输出" : "看输出") : null),
								(mOpen === j.id && r) ? React.createElement("div", null,
									React.createElement("div", { style: Object.assign({}, S.hint, { opacity: 0.85 }) }, j.what + "　·　退出码：" + j.exitMeans),
									React.createElement("div", { style: { marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid " + T.border, background: T.base, fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, color: T.text, whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" } }, (r.text || r.error || "(没有输出)"))) : null));
						})(maint.jobs[mi]);
					}
					maintEls.push(React.createElement("div", { key: "mhint2", style: Object.assign({}, S.hint, { marginTop: 4 }) },
						"七件里只有【备份记忆库】会往磁盘写（写进 backups/），其余都是只看不写。非 0 退出码不一定是坏了 —— 点【看输出】会写明它是什么意思。"));
				}
			}

			if (cfg.isLocal) {
				// ★ 先说要紧的：这个 Ollama 不是 DSH 启动的 → 关掉 DSH 不会收它、显存不会还。
				//   （2026-09-12 用户实测反馈：他自己从托盘启动过 Ollama，关掉 DSH 后显存没还，
				//    而当时设置页一个字都没说 —— 等于骗人。这里必须说出来，并且**只给按钮、不自动收**。）
				var ext = status.externalOllama;
				if (status.ollamaUp && ext && ext.mine === false) {
					proc.push(React.createElement("div", {
						key: "extwarn",
						style: {
							fontSize: 11.5, lineHeight: 1.65, color: T.err,
							border: "1px solid " + T.err, borderRadius: 6,
							padding: "7px 9px", marginBottom: 6, width: "100%"
						}
					}, "⚠️ " + (ext.warn || "这个 Ollama 不是 DSH 启动的 → 关掉 DSH 不会收它，显存不会还回来。")));
				}
				// 残留优先说：服务没在跑、但显卡上还压着模型进程 —— 得让用户能一键收掉，
				// 否则会出现"设置页说没运行、任务管理器却占着几个 GB"的矛盾画面（2026-09-12 用户发现）。
				var orphans = status.orphanRunners;
				if (orphans && orphans.count > 0) {
					proc.push(React.createElement(Btn, {
						key: "clean", main: true, disabled: busy,
						onClick: function () { act("/dsh-memory-app/ollama/clean"); }
					}, "清理残留进程（" + orphans.count + " 个，占着显存）"));
				}
				if (status.ollamaUp) {
					var isExt = !!(ext && ext.mine === false);
					proc.push(React.createElement(Btn, {
						key: "stop", main: isExt, disabled: busy,
						onClick: function () { act("/dsh-memory-app/ollama/stop"); }
					}, isExt ? "收掉这个 Ollama（不是 DSH 起的，会连残留模型进程一起收）" : "停止 Ollama"));
				} else {
					proc.push(React.createElement(Btn, { key: "start", main: true, disabled: busy, onClick: function () { act("/dsh-memory-app/ollama/start"); } }, "启动 Ollama"));
				}
				if (status.ollamaUp && status.modelPresent === true) {
					proc.push(React.createElement(Btn, {
						key: "warm", disabled: busy || (status.warming && status.warming.done === false),
						onClick: function () { act("/dsh-memory-app/ollama/warm"); }
					}, (status.warming && status.warming.done === false) ? "正在预热…" : "预热模型"));
				}
				if (status.ollamaUp && status.modelPresent === false) {
					proc.push(React.createElement(Btn, {
						key: "pull", main: true, disabled: busy || (status.pull && status.pull.done === false),
						onClick: function () { act("/dsh-memory-app/ollama/pull", { model: cfg.model }); }
					}, (status.pull && status.pull.done === false) ? "拉取中…" : "拉取模型 " + cfg.model));
				}
				if (loaded) {
					proc.push(React.createElement(Btn, {
						key: "unload", disabled: busy,
						onClick: function () { act("/dsh-memory-app/ollama/unload"); }
					}, "卸载模型（腾出显存/内存）"));
				}
			}

			// ── 配置区（渐进披露）──
			var fields = [];
			fields.push(React.createElement(Field, { key: "mode", label: "引擎" },
				React.createElement(Select, {
					value: draft.mode,
					onChange: function (v) {
						set("mode", v);
						if (v === "local" && draft.endpoint.indexOf("127.0.0.1") < 0) set("endpoint", "http://127.0.0.1:11434");
						if (v === "local" && !draft.model) set("model", "qwen3-embedding:0.6b");
					},
					options: [["local", "本机 Ollama（不出网）"], ["cloud", "云端 API（内容会发出去）"]]
				})
			));

			if (draft.mode === "local") {
				var deviceOptions = (function () {
					var o = [["cpu", "CPU — 零显存，加载快"], ["auto", "自动选卡 — 最快，占显存最多"]];
					var gs = status.gpus || [];
					if (gs.length) {
						gs.forEach(function (g) {
							o.push([g.id, "#" + g.id + " " + g.name + "（" + Math.round(g.totalMiB / 1024) + " GB，已用 " + g.usedMiB + " MiB）"]);
						});
					} else {
						o.push(["0", "指定显卡 #0"], ["1", "指定显卡 #1"]);
					}
					var has = o.some(function (x) { return x[0] === draft.device; });
					if (!has) o.push([draft.device, "指定显卡 #" + draft.device]);
					return o;
				})();
				fields.push(React.createElement(Field, { key: "device", label: "算在哪" },
					React.createElement(Select, { value: draft.device, onChange: function (v) { set("device", v); }, options: deviceOptions })
				));
				fields.push(React.createElement(Field, {
					key: "model", label: "模型",
					note: (status.ollamaUp ? "列表 = 本机实测装了的（不是预设清单）" : "Ollama 没启动，测不到本机有哪些模型")
				},
					React.createElement(Select, {
						value: draft.model, onChange: function (v) { set("model", v); },
						options: (status.models && status.models.length
							? status.models.map(function (m) { return [m, m]; })
							: [[draft.model, draft.model + (status.ollamaUp ? "（本机未安装）" : "（未知，Ollama 未启动）")]])
					})
				));
				fields.push(React.createElement(Field, { key: "ctx", label: "上下文", note: "单块上限，不是文件上限" },
					React.createElement(Select, {
						value: String(draft.numCtx), onChange: function (v) { set("numCtx", Number(v)); },
						options: [["512", "512"], ["1024", "1024"], ["2048", "2048（推荐）"], ["4096", "4096"]]
					})
				));
				fields.push(React.createElement("div", { key: "chint", style: S.hint },
					"CPU = 完全不占显存（只吃内存约 1–2 GB）；自动选卡把模型放进显存最多的那张卡；指定显卡可把占用挪到闲置卡。" +
					"这些是「每次请求」带过去的，所以 Ollama 先起还是后起都行；改动会在后台自动预热，不用你等。"));
			} else {
				fields.push(React.createElement(Field, { key: "endpoint", label: "服务地址" },
					React.createElement("input", {
						value: draft.endpoint, onChange: function (e) { set("endpoint", e.target.value); },
						placeholder: "https://api.siliconflow.cn/v1/embeddings",
						style: Object.assign({}, S.input, { width: 320 })
					})
				));
				fields.push(React.createElement(Field, { key: "cmodel", label: "模型" },
					React.createElement("input", {
						value: draft.model, onChange: function (e) { set("model", e.target.value); },
						placeholder: "BAAI/bge-m3", style: Object.assign({}, S.input, { width: 220 })
					})
				));
				fields.push(React.createElement(Field, { key: "key", label: "API Key" },
					React.createElement("input", {
						type: "password", value: draft.key, onChange: function (e) { set("key", e.target.value); },
						placeholder: "留空则退化成关键词检索", style: Object.assign({}, S.input, { width: 260 })
					})
				));
			}

			fields.push(React.createElement("div", { key: "actions", style: Object.assign({}, S.row, { marginTop: 4 }) },
				React.createElement(Btn, { main: true, disabled: busy, onClick: save }, busy ? "处理中…" : "保存"),
				React.createElement(Btn, { disabled: busy || !cfg.configured, onClick: runTest }, "自检（不写任何东西）"),
				justSaved ? React.createElement("span", { style: { fontSize: 11.5, color: T.ok } }, "已保存，下一次检索即生效（不用重启）") : null,
				err ? React.createElement("span", { style: { fontSize: 11.5, color: T.err } }, err) : null
			));

			return React.createElement("div", { style: S.block },
				React.createElement("div", { style: S.title }, "记忆系统"),
				React.createElement("div", { style: S.card }, head),
				React.createElement("div", { style: S.divider }),
				React.createElement("div", { style: S.card }, fields),
				// ★Vault 状态独立成卡、且**在 isLocal 条件之外**★ —— 云端模式也照样能看到"过期了"并重建。
				vaultEls.length ? React.createElement("div", { style: S.card }, vaultEls) : null,
				// ★会话转写也独立成卡、同样在 isLocal 条件之外★（本地/云端两种嵌入模式下都该看得到）
				corpusEls.length ? React.createElement("div", { style: S.card }, corpusEls) : null,
				// ★记忆视图（Obsidian）卡：同样在 isLocal 之外★ —— 打开视图跟嵌入器是本地还是云端无关
				viewEls.length ? React.createElement("div", { style: S.card }, viewEls) : null,
				maintEls.length ? React.createElement("div", { style: S.card }, maintEls) : null,
				cfg.isLocal ? React.createElement("div", { style: S.card },
					React.createElement("div", { style: S.hint }, "Ollama 进程（不会自动启动，点「启动」它才起来）"),
					React.createElement("div", { style: Object.assign({}, S.row, { marginTop: 2 }) }, proc),
					React.createElement("div", { style: S.hint },
						"你关掉 DSH 时它会跟着退出，不留后台孤儿。" +
						(status.warming && status.warming.done === false ? "　正在后台加载模型，请稍候…" : ""))
				) : null,
				React.createElement("div", { style: S.hint }, "自检只测「原句 / 换个说法 / 无关句」三者的相似度，不会往记忆库里写任何东西。")
			);
		}

		// ── 协作 SOP 开关 ────────────────────────────────────────────
		function SopToggle() {
			var st = React.useState(null); var on = st[0]; var setOn = st[1];
			var bu = React.useState(false); var busy = bu[0]; var setBusy = bu[1];

			React.useEffect(function () {
				var dead = false;
				fetch("/dsh-memory-app/sop")
					.then(function (r) { return r.json(); })
					.then(function (d) { if (!dead) setOn(!!d.on); })
					.catch(function () { if (!dead) setOn(false); });
				return function () { dead = true; };
			}, []);

			function toggle() {
				if (busy || on === null) return;
				var next = !on;
				setBusy(true);
				fetch("/dsh-memory-app/sop", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ on: next })
				})
					.then(function (r) { return r.json(); })
					.then(function (d) { setOn(!!d.on); setBusy(false); })
					.catch(function () { setBusy(false); });
			}

			return React.createElement("label", { style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", minHeight: 34 } },
				React.createElement("input", {
					type: "checkbox", checked: !!on, disabled: on === null || busy, onChange: toggle,
					style: { accentColor: T.brand, width: 16, height: 16, marginTop: 2, flexShrink: 0, cursor: "pointer" }
				}),
				React.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
					React.createElement("span", { style: S.title }, "协作 SOP（选任何预设都生效）"),
					React.createElement("span", { style: S.hint }, "勾选后，任何模式下都会注入协作规矩（先说结论、先对齐再动手、台账纪律、记忆复盘）；取消勾选即关闭。")
				)
			);
		}


		// ── 初始化向导（2026-09-16）★ 新用户开箱用：把『没有』变成『有』★ ──────
		var INIT_DEFAULT_MODEL = "qwen3-embedding:0.6b";
		function InitWizard() {
			var q1 = React.useState(null); var st = q1[0]; var setSt = q1[1];
			var q2 = React.useState(""); var busy = q2[0]; var setBusy = q2[1];
			var q3 = React.useState(""); var msg = q3[0]; var setMsg = q3[1];
			var q4 = React.useState(""); var root = q4[0]; var setRoot = q4[1];
			var q5 = React.useState(null); var plan = q5[0]; var setPlan = q5[1];
			var q6 = React.useState(false); var open = q6[0]; var setOpen = q6[1];
						var q8 = React.useState(""); var opath = q8[0]; var setOpath = q8[1];
			var q9 = React.useState([]); var picks = q9[0]; var setPicks = q9[1];
			var qA = React.useState(null); var pickUI = qA[0]; var setPickUI = qA[1];
			var qB = React.useState([]); var sources = qB[0]; var setSources = qB[1];
			var qC = React.useState([]); var logs = qC[0]; var setLogs = qC[1];
			// ★2026-09-16★ 新增（**按本文件的老规矩：加在最后**，前面 0…10 号 hook 的下标一个都没动，
			//   `verify_client_render.mjs` 的那些老场景不用改）。
			//   作用：把"每行的手动按钮"折叠起来 —— 平时只看得见"一键初始化 + 5 行状态"。
			var qD = React.useState(false); var manualOpen = qD[0]; var setManualOpen = qD[1];

			function load() {
				setBusy("load");
				fetch("/dsh-memory-app/init/status").then(function (r) { return r.json(); })
					.then(function (d) {
						setSt(d); setBusy("");
						if (root === "") setRoot(d.root || d.suggest || "");
						if (!open) setOpen(true);
					})
					.catch(function () { setBusy(""); setSt({ error: "拿不到状态（插件刚起来的话，等两秒再点一次）" }); });
			}
			React.useEffect(function () { load(); }, []);

			function post(path, body) {
				setBusy(path); setMsg("");
				return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
					.then(function (r) { return r.json(); })
					.then(function (d) { setBusy(""); if (d && d.ok === false) setMsg(d.error || "出错了"); return d; })
					.catch(function (e) { setBusy(""); setMsg(String(e)); return { ok: false }; });
			}
			// ★2026-09-16★ 弹系统对话框并等结果：POST 立刻回（宿主不阻塞），再轮询结果文件。
			//   最长等 ~85 秒；没等到就明确提示"直接粘路径"，绝不让按钮一直灰着。
			function pick(mode, opt, apply) {
				setMsg("已请求弹出系统对话框，请在桌面上找一下…");
				post("/dsh-memory-app/init/pick", Object.assign({ mode: mode }, opt || {})).then(function (d) {
					if (d && d.ok === false) { setMsg(d.error || "弹不出来，请把路径粘到输入框里"); return; }
					var n = 0;
					var t = setInterval(function () {
						n++;
						fetch("/dsh-memory-app/init/pick/result").then(function (r) { return r.json(); }).then(function (r) {
							if (!r || r.state === "pending") {
								if (n > 120) { clearInterval(t); setMsg("没等到选择结果（对话框可能没浮到前面）—— 请把路径直接粘到输入框里"); }
								return;
							}
							clearInterval(t);
							if (r.state === "cancelled") setMsg("你取消了 —— 也可以把路径直接粘到输入框里");
							else if (r.state === "picked") { apply(r.path); setMsg("已选：" + r.path); }
						}).catch(function () {});
					}, 700);
				});
			}

			// ★2026-09-16★ 卡片内文件夹浏览器（点【浏览…】展开）：服务端列目录，点进去选。
			//   不依赖任何系统弹窗 —— 用户点「选择文件」能弹是因为那是浏览器原生控件；
			//   浏览器拿不到绝对路径，所以这类"本机路径"只能由服务端列出来给他点。
			function ListPick(props) {
				var q = React.useState(props.start || ""); var cur = q[0]; var setCur = q[1];
				var d = React.useState(null); var data = d[0]; var setData = d[1];
				function load(p) {
					fetch("/dsh-memory-app/init/ls?path=" + encodeURIComponent(p || "") + (props.files ? ("&files=" + props.files) : ""))
						.then(function (r) { return r.json(); })
						.then(function (j) { setData(j); if (j && j.path) setCur(j.path); })
						.catch(function () { setData({ ok: false, error: "列目录失败" }); });
				}
				React.useEffect(function () { load(props.start || ""); }, []);
				var btn = { padding: "3px 8px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer", marginRight: 6, marginTop: 4 };
				return React.createElement("div", { style: { marginTop: 6, padding: 8, borderRadius: 8, border: "1px solid " + T.border, background: T.surface } },
					React.createElement("div", { style: Object.assign({}, S.hint, { fontFamily: "monospace", wordBreak: "break-all" }) }, (data && data.path) || cur || "(根目录)"),
					React.createElement("div", null,
						React.createElement("button", { style: btn, onClick: function () { if (data && data.parent) load(data.parent); } }, "← 上一级"),
						React.createElement("button", { style: btn, onClick: function () { props.onPick(data && data.path ? data.path : cur); props.onClose(); } }, props.files ? "选这个文件" : "★ 选这个文件夹"),
						React.createElement("button", { style: btn, onClick: props.onClose }, "收起")),
					data && data.ok === false ? React.createElement("div", { style: Object.assign({}, S.hint, { color: T.err }) }, data.error) : null,
					data && data.dirs ? React.createElement("div", { style: { maxHeight: 190, overflow: "auto", marginTop: 4 } },
						data.dirs.map(function (x) { return React.createElement("div", { key: x.path, onClick: function () { load(x.path); }, style: { padding: "3px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12 } }, "📁 " + x.name); }),
						(props.files && data.files ? data.files : []).map(function (x) { return React.createElement("div", { key: x.path, onClick: function () { props.onPick(x.path); props.onClose(); }, style: { padding: "3px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: T.brand } }, "📄 " + x.name); }),
						(props.files && data.files && data.files.length === 0 ? React.createElement("div", { style: S.hint }, "这一层没有匹配的文件，进入子文件夹找找") : null),
						data.truncated ? React.createElement("div", { style: S.hint }, "（条目太多，只列了前 400 项）") : null) : null);
			}

			// ★2026-09-16★ 优先用 **DSH 自带的目录选择器**（uiWorkspace.pickDirectory —— 与「选择文件」同族）；
		//   服务不在（老版本/被裁）时**回落**到卡片内文件夹浏览器，绝不静默失效。
					// ★2026-09-16★ 【进入新会话，配置】：① 宿主把任务书写好（含源文件路径）② 用 DSH 自带
		//   uiWorkspace.startSession() 新建会话 ③ 把首条消息放进剪贴板并提示用户粘贴发送。
		//   为什么走剪贴板而不是"直接发"：DSH 的客户端没有暴露"设置输入框/发送消息"的公开服务，
		//   硬塞消息要碰会话事件流（那是 agent-loop 的领域）——按铁律"有歧义往不动那边靠"。
			// ★2026-09-16 用户拍板★ 【进入新会话，配置】：**点一下就自动建会话 + 把任务书投进去**，
			//   不让用户粘贴。走的是 DSH 自己的 remote API（它自己的输入框就是这么发的）：
			//     ① remote.session.create({cwd}) → 建会话  ② sessions.open(id) → UI 切过去
			//     ③ remote.session.prompt({sessionId, content:[{type:'text',text}]}) → 投递（agent 开始干活）
			//   ⚠️ 这条路我**没法自测**（客户端行为、且会真的建会话）→ 因此任何一步失败都**把 DSH 的原话**显示在卡上，
			//      并回落到"复制到剪贴板 + 手动新建"，绝不静默。
			function fallbackClipboard(text, why) {
				var tip = (why ? (why + "　") : "") + "已复制到剪贴板；请手动新建一个会话并粘贴发送。";
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { setMsg(tip); }, function () { setMsg(tip.replace("已复制到剪贴板；", "") + "（复制失败，请手动复制）"); });
					else setMsg(tip.replace("已复制到剪贴板；", "") + "（复制失败，请手动复制）");
				} catch (e) { setMsg(tip.replace("已复制到剪贴板；", "")); }
			}

			// ★2026-09-16 第三版★ 用户点过两次"没反应"（没建会话、没投递）——我隔着屏幕看不到原因，
			//   所以这一版的核心是**把每一步都显示在卡上**，任何一步失败都留下可复制的原文。
			//   依据：DSH 输入框是 Lexical 富文本（改 DOM 不生效）⇒ 只能走客户端 API；
			//   composer 的投递模式是 mode: 'queue' | 'steer'（这次补上 mode）。
			function pushLog(line) {
				setLogs(function (prev) { return prev.concat([new Date().toLocaleTimeString() + "  " + line]).slice(-16); });
			}
			// （旧的 getRemote() 已删：`CLIENT_CTX.remote` 会抛 without-inject，留着就是一颗地雷。）
			function fallbackClipboard(text, why) {
				pushLog("✗ " + why);
				var tip = why + "　→ 已复制到剪贴板，请手动新建会话并粘贴发送。";
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).then(function () { setMsg(tip); }, function () { setMsg(why + "　（复制失败，请手动复制）"); });
					} else setMsg(why + "　（这个页面没有剪贴板权限，请手动复制）");
				} catch (e) { setMsg(why); }
				return text;
			}

			// ★Cordis 的事实（读源码确认，别再用猜的）★：`ctx.get(name)` 对未声明的服务
			//   **返回 undefined、不抛**；而**直接点属性**（`ctx.remote`）会抛
			//   `cannot get property "remote" without inject`。所以取服务一律走 get()。
			function svc(name) {
				try { return (CLIENT_CTX && typeof CLIENT_CTX.get === "function") ? (CLIENT_CTX.get(name) || null) : null }
				catch (e) { return null }
			}

			// ★2026-09-16 第四版★ 前两版用户点了"没反应"、日志停在① —— 根因就是上面那句
			//   `CLIENT_CTX.remote` 抛异常，而它在 .then 回调里又没有外层 catch → 静默 reject。
			//   这一版的铁律：**任何一步都不许静默死掉** —— 整条链一个外层 .catch，每步都写日志，
			//   catch 里把 e.message 原文打到卡上（用户能直接复制给我看）。
			//   建会话/投递走宿主路由 /init/session（宿主用 sessionController，跟浏览器输入框同一条路），
			//   浏览器只负责把新会话切到前台。
			function runInitSession() {
				setLogs([]);
				var text = "";
				var sid = "";
				var step = "开始";
				try {
					Promise.resolve()
						.then(function () {
							step = "准备任务书";
							pushLog("① 向宿主要任务书…");
							return post("/dsh-memory-app/init/task", { sources: sources });
						})
						.then(function (d) {
							step = "检查任务书";
							if (!d || d.ok === false) throw new Error((d && d.error) || "任务书没准备好");
							text = d.firstMessage || ("@" + d.file);
							pushLog("① ✓ 任务书：" + d.file + "（" + (d.sources || []).length + " 份源）");
							step = "取 sessions 服务";
							var ss = svc("sessions");
							pushLog("② sessions：" + (ss ? "有" : "没有") +
								"｜create=" + (ss ? typeof ss.create : "—") +
								"｜open=" + (ss ? typeof ss.open : "—"));
							if (!ss || typeof ss.create !== "function") { pushLog("② 这个版本没有 sessions.create → 交给宿主建会话"); return null }
							step = "建会话";
							pushLog("③ 建会话（cwd=" + (root || "默认") + "）…");
							return Promise.resolve(ss.create(root ? { cwd: root } : {})).then(function (id) {
								sid = (typeof id === "string" && id) ? id : String((id && (id.sessionId || id.id)) || "");
								if (!sid) throw new Error("建了会话但没拿到 id：" + JSON.stringify(id || {}).slice(0, 160));
								pushLog("③ ✓ 会话 " + sid);
								step = "切界面";
								try {
									if (typeof ss.open === "function") { ss.open(sid); pushLog("④ ✓ 已切到新会话"); }
									else pushLog("④ 这个版本没有 sessions.open —— 自己点左侧列表里的新会话");
								} catch (e) { pushLog("④ ✗ 切界面失败（不影响投递）：" + String((e && e.message) || e)) }
								return null;
							});
						})
						.then(function () {
							step = "投递任务书";
							pushLog("⑤ 投递任务书…");
							return post("/dsh-memory-app/init/session", { sessionId: sid || undefined, cwd: root || undefined, text: text });
						})
						.then(function (r) {
							step = "检查投递结果";
							// ★宿主可能"会话建好了、投递失败了"★ —— 这时也把那个会话切到前台，
							//   别让用户对着一个看不见的会话干瞪眼（而且能避免重复建会话）。
							if (r && r.sessionId && !sid) {
								sid = r.sessionId;
								var ss3 = svc("sessions");
								try { if (ss3 && typeof ss3.open === "function") ss3.open(sid) } catch (e) {}
							}
							if (!r || r.ok === false) throw new Error((r && r.error) || "投递失败");
							pushLog("⑤ ✓ 投递成功（" + (r.created ? "宿主建会话 + " : "") + "accepted=" + r.accepted + "）");
							setMsg("✅ 已建会话（" + sid + "）并投递任务书 —— 切到新会话看它干活。");
						})
						.catch(function (e) {
							fallbackClipboard(text || "", "第【" + step + "】步失败：" + String((e && e.message) || e));
						});
				} catch (e) {
					pushLog("✗ 同步异常：" + String((e && e.message) || e));
					setMsg("出错：" + String((e && e.message) || e));
				}
			}



			function pickDirNative(apply, mode) {
			var uw = (CLIENT_CTX && CLIENT_CTX.get) ? CLIENT_CTX.get("uiWorkspace") : null;
			if (uw && typeof uw.pickDirectory === "function" && mode !== "file") {
				setMsg("已请求系统选择框…");
				Promise.resolve(uw.pickDirectory()).then(function (p) {
					if (p) { apply(p); setMsg("已选：" + p); }
					else { setMsg("没选 —— 也可以点【卡片内浏览…】或直接把路径粘到输入框"); }
				}).catch(function (e) {
					setMsg("系统选择框没起来（" + String((e && e.message) || e) + "）→ 用卡片内浏览或粘路径");
					setPickUI({ mode: "dir" });
				});
				return;
			}
			setPickUI({ mode: mode === "file" ? "file" : "dir" });
		}

			function act(label, path, body, after) {
				return React.createElement("button", {
					onClick: function () { post(path, body).then(function (d) { if (after) after(d); }); },
					disabled: busy !== "" || !!(st && st.error),
					style: { marginRight: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
						border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12 }
				}, busy === path ? "处理中…" : label);
			}
			// 浏览器原生选文件 → 读成文本 → 交宿主的模型分析（服务端因此不需要任何路径权限）


			var steps = (st && st.steps) ? st.steps : [];
			// ★2026-09-16★ 卡片改成「1 键 + 5 行状态」★
			//   为什么：搭骨架 / 检测 Ollama / 装模型 这三步以前是**手工点**的，而它们本来就该由
			//   "新会话里的 agent"按任务书问着用户做完 —— 现在全并进任务书 → 真·一键。
			//   状态从哪来：agent 每做完一步跑 `init-cli.mjs …`，它**回写 `~/.dsh-memory/init.json`**，
			//   卡这边只要重新拉一次 `/init/status` 就会绿 —— 是**真回写**，不是我们把按钮点亮。
			var oneKey = React.createElement("div", { style: { marginTop: 8, padding: 10, borderRadius: 8, border: "1px solid " + T.brand, background: T.surface } },
				React.createElement("div", { style: S.hint }, "点一下 → 开一个新会话，它按『先问你三件事（根目录 / Ollama / 模型）→ 建骨架 → 建初始记忆』的顺序做完；做完这一卡就全绿了。"),
				React.createElement("div", { style: { marginTop: 6 } },
					React.createElement("button", { onClick: runInitSession, disabled: busy !== "",
						style: { marginRight: 6, padding: "7px 14px", borderRadius: 6, border: "1px solid " + T.brand, background: "transparent", color: T.brand, fontWeight: 600, fontSize: 13, cursor: "pointer" } }, "一键初始化（进入新会话）"),
					React.createElement("button", { onClick: function () { setPickUI({ mode: "src" }); }, disabled: busy !== "",
						style: { marginRight: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "选源文件…（可选：你已有的协作/交接文档）"),
					sources.length ? React.createElement("span", { style: S.hint }, "已选 " + sources.length + " 份") : null,
					sources.length ? React.createElement("button", { onClick: function () { setSources([]); },
						style: { marginLeft: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "清空已选") : null),
				sources.length ? React.createElement("div", { style: Object.assign({}, S.hint, { fontFamily: "monospace", wordBreak: "break-all" }) }, sources.join("　·　")) : null,
				logs.length ? React.createElement("div", { style: { marginTop: 6, padding: 8, borderRadius: 8, border: "1px solid " + T.border, background: T.base, fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, color: T.text, whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto" } }, logs.join(String.fromCharCode(10))) : null,
				pickUI && pickUI.mode === "src" ? React.createElement(ListPick, { start: (typeof root === "string" && root) ? root : ((st && st.suggest) || ""), files: ".md", onPick: function (p) { setSources(sources.indexOf(p) >= 0 ? sources : sources.concat([p])); setMsg("已加入源文件：" + p); }, onClose: function () { setPickUI(null); } }) : null,
				React.createElement("button", { onClick: function () { setManualOpen(!manualOpen); },
					style: { marginTop: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, manualOpen ? "收起手动分步 ▴" : "手动分步（备用）▾"));
			var rows = steps.map(function (x) {
				return React.createElement("div", { key: x.key, style: { padding: "7px 0", borderTop: "1px solid " + T.border2 } },
					React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
						React.createElement("span", { style: { color: x.ok ? T.ok : T.err, fontWeight: 600 } }, x.ok ? "✓" : "✗"),
						React.createElement("span", { style: { fontWeight: 600 } }, x.label),
						React.createElement("span", { style: Object.assign({}, S.hint, { minWidth: 0 }) }, x.detail || "")),
					(manualOpen && x.key === "memory-init") ? React.createElement("div", null,
						React.createElement("button", { onClick: function () { setPickUI({ mode: "src" }); }, disabled: busy !== "", style: { marginRight: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "选源文件…（你已有的协作/交接文档）"),
						sources.length ? React.createElement("span", { style: S.hint }, "已选 " + sources.length + " 份") : null,
						React.createElement("button", { onClick: runInitSession, style: { marginRight: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.brand, background: "transparent", color: T.brand, fontWeight: 600, fontSize: 12, cursor: "pointer" } }, "进入新会话，配置 →"),
						sources.length ? React.createElement("button", { onClick: function () { setSources([]); }, style: { marginRight: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "清空已选") : null,
						sources.length ? React.createElement("div", { style: Object.assign({}, S.hint, { fontFamily: "monospace", wordBreak: "break-all" }) }, sources.join("　·　")) : null,
						null,
						pickUI && pickUI.mode === "src" ? React.createElement(ListPick, { start: (typeof root === "string" && root) ? root : ((st && st.suggest) || ""), files: ".md", onPick: function (p) { setSources(sources.indexOf(p) >= 0 ? sources : sources.concat([p])); setMsg("已加入源文件：" + p); }, onClose: function () { setPickUI(null); } }) : null,
						act("只用出厂基础版（只含目录结构）", "/dsh-memory-app/init/sop/default", {}, load)) : null,
					(manualOpen && x.key === "ollama") ? React.createElement("div", null,
						act("重新检测", "/dsh-memory-app/init/ollama/install", null, null) ? null : null,
						React.createElement("button", { onClick: load, style: { marginRight: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "重新检测"),
						act("启动 Ollama（可选）", "/dsh-memory-app/ollama/start", {}, function (d) { setMsg(d && d.ok === false ? (d.error || "启动失败") : "已发启动指令（几秒后点【重新检测】）"); }),
						act("安装 Ollama（后台）", "/dsh-memory-app/init/ollama/install", {}, function (d) { setMsg(d && d.note ? d.note : "已开始安装，装完点【重新检测】"); }),
						React.createElement("button", { onClick: function () { pickDirNative(function (p) { setOpath(p); }, "file"); }, disabled: busy !== "", style: { marginTop: 6, marginRight: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "浏览…"),
						React.createElement("input", { value: opath, onChange: function (e) { setOpath(e.target.value); }, placeholder: "已装好？把 ollama.exe 路径贴这里",
							style: { marginTop: 6, width: 300, padding: "5px 8px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12 } }),
						act("用这个路径", "/dsh-memory-app/init/ollama/locate", { path: opath }, load),
						pickUI && pickUI.mode === "file" ? React.createElement(ListPick, { start: "C:/", files: ".exe", onPick: function (p) { setOpath(p); }, onClose: function () { setPickUI(null); } }) : null) : null,
					(manualOpen && x.key === "model") ? React.createElement("div", null,
						React.createElement("button", { onClick: function () { post("/dsh-memory-app/ollama/pull", { model: (st && st.init && st.init.model) || INIT_DEFAULT_MODEL }).then(function () { setMsg("模型拉取已在后台开始（首次约 600 MB），好了点【重新检测】"); }); },
							disabled: busy !== "", style: { marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "安装模型"),
						React.createElement("button", { onClick: load, style: { marginLeft: 6, marginTop: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "重新检测")) : null,
					(manualOpen && x.key === "skeleton") ? React.createElement("div", null,
						React.createElement("div", { style: S.hint }, "根目录＝你的工作区（项目文件夹都建在里面）。检测需要先知道它在哪（我们不会去扫你的整个磁盘）；建议用" + ((st && st.suggest) ? ("你上次的工作区：" + st.suggest) : "你当前的工作区") + "。"),
						React.createElement("button", { onClick: function () { pickDirNative(function (p) { setRoot(p); }); }, disabled: busy !== "", style: { marginTop: 6, marginRight: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "浏览…"),
						((st && st.suggest) ? React.createElement("button", { onClick: function () { setRoot(st.suggest); }, style: { marginTop: 6, marginRight: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "用当前工作区") : null),
						React.createElement("button", { onClick: function () { pick("dir", { title: "选择工作区根目录" }, function (p) { setRoot(p); }); }, disabled: busy !== "", style: { marginTop: 6, marginRight: 6, padding: "5px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, "系统对话框…"),
						React.createElement("input", { value: root, onChange: function (e) { setRoot(e.target.value); }, placeholder: "工作区根目录（绝对路径）",
							style: { marginTop: 6, width: 340, padding: "5px 8px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12 } }),
						pickUI && pickUI.mode === "dir" ? React.createElement(ListPick, { start: root || ((st && st.suggest) || ""), onPick: function (p) { setRoot(p); setMsg("已选：" + p); }, onClose: function () { setPickUI(null); } }) : null,
						act(root ? "看一下会建哪些文件" : "先选根目录…", "/dsh-memory-app/init/skeleton/plan", { root: root }, function (d) { if (d && d.plan) { if (d.plan.need) { setPlan(null); setMsg(d.plan.need); return; } setPlan(d.plan); setPicks(d.plan.items.filter(function (i) { return !i.exists; }).map(function (i) { return i.key; })); } }),
						plan ? React.createElement("div", { style: { marginTop: 6 } },
							React.createElement("div", { style: S.hint }, "勾选要创建的东西（已存在的一律不覆盖）："),
							plan.items.map(function (i) { return React.createElement("label", { key: i.key, style: { display: "flex", gap: 6, alignItems: "baseline", fontSize: 12, padding: "3px 0" } },
								React.createElement("input", { type: "checkbox", checked: picks.indexOf(i.key) >= 0, disabled: i.exists,
									onChange: function () { setPicks(picks.indexOf(i.key) >= 0 ? picks.filter(function (k) { return k !== i.key; }) : picks.concat([i.key])); } }),
								React.createElement("span", { style: { fontFamily: "monospace" } }, i.path),
								React.createElement("span", { style: Object.assign({}, S.hint, { minWidth: 0 }) }, (i.exists ? "（已存在，跳过）" : "") + i.what)); }),
							act("创建（只建不存在的）", "/dsh-memory-app/init/skeleton/create", { root: root, picks: picks }, function (d) { if (d && d.created) setMsg("已创建 " + d.created.length + " 项，跳过 " + d.skipped.length + " 项"); load(); })) : null) : null,
					(manualOpen && x.key === "view") ? React.createElement("div", null,
						act("生成/刷新记忆视图", "/dsh-memory-app/vault-sync/run", {}, function () { setMsg("视图已刷新（在 <工作区>/memory/记忆视图/，可用 Obsidian 打开）"); load(); })) : null);
			});

			var okCount = steps.filter(function (x) { return x.ok; }).length;
			var head = React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
				React.createElement("span", { style: S.title }, "记忆系统 · 初始化"),
				React.createElement("span", { style: Object.assign({}, S.hint, { color: (steps.length && okCount === steps.length) ? T.ok : T.err }) },
					st && st.error ? st.error : ("就绪 " + okCount + "/" + steps.length + (steps.length && okCount === steps.length ? "　全部就绪，这一卡可以收起来了" : "　点【一键初始化】就行（想手工一步步来：展开『手动分步（备用）』）"))),
				React.createElement("button", { onClick: load, style: { padding: "4px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, busy === "load" ? "检测中…" : "重新体检"),
				React.createElement("button", { onClick: function () { setOpen(!open); }, style: { padding: "4px 10px", borderRadius: 6, border: "1px solid " + T.border, background: T.base, color: T.text, fontSize: 12, cursor: "pointer" } }, open ? "收起" : "展开"));

			return React.createElement("div", { style: S.card },
				head,
				React.createElement("div", { style: S.hint }, "初始化只做一件事：把『没有』变成『有』 —— 走完之后，这一页和你熟悉的记忆系统一模一样。它不会覆盖你已有的任何文件。"),
				msg ? React.createElement("div", { style: Object.assign({}, S.hint, { color: T.brand, marginTop: 4 }) }, msg) : null,
				open ? React.createElement("div", { style: { marginTop: 4 } }, oneKey, rows) : null);
		}

		var CLIENT_CTX = null;   // ★2026-09-16★ 组件里要用 DSH 自带的客户端服务（uiWorkspace 等）

		function apply(ctx) {
			CLIENT_CTX = ctx;
			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "dsh-memory-app-embedder",
					order: 28,
					label: "记忆系统"
				}, MemorySettings);
			});
			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "dsh-memory-app-sop",
					order: 30,
					label: "协作 SOP"
				}, SopToggle);
			});
			// ★初始化向导（2026-09-16）★：只在"有缺项"时最有用；全部就绪后它自己会说"可以收起来"。
			ctx.slots.inject("settings.general.item", function () {
				return ctx.slots.register({
					name: "settings.general.item",
					id: "dsh-memory-app-init",
					order: 26,
					label: "初始化"
				}, InitWizard);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	
		})();
		var PART_MEM = (function () {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		const NS = "dsh-memory";
		const zh = {
			"memory.tab": "记忆",
			"memory.title": "记忆",
			"memory.hint": "本对话独有记忆 + 注入配置。保存后下一轮对话按配置注入。",
			"memory.save": "保存",
			"memory.saving": "保存中…",
			"memory.saved": "已保存",
			"memory.saveFailed": "保存失败",
			"memory.loadFailed": "加载记忆失败",
			"memory.refresh": "刷新",
			"memory.conversation.title": "本对话记忆",
			"memory.conversation.hint": "只属于这个对话，其他对话看不到、不注入。agent 在本对话里 memory add 也会写到这里。",
			"memory.inject.title": "注入配置",
			"memory.inject.hint": "勾选 = 每轮对话自动把这些记忆放进 AI 的上下文，AI 就\"记得\"它们；不勾 = AI 完全看不到。保存后下一轮生效。",
			"memory.inject.userProfile": "用户画像（你是谁：身份/偏好/习惯）",
			"memory.inject.longTerm": "长期记忆（跨对话的经验/进度/规则）",
			"memory.inject.conversation": "本对话记忆",
			"memory.inject.keyed": "关键记忆（keyed 记忆 · {count} 条）",
			"memory.inject.autoVaultGate.title": "自动检索",
			"memory.inject.autoVaultGate.hint": "每轮按你的消息从 Vault 语义检索 topK=3 注入。智能模式纯本地过滤闲聊（零外发）；LLM 模式调用模型判断（会发送消息给模型，超时/失败自动降级为智能，每轮最多约 5 秒延迟）。",
			"memory.inject.autoVaultGate.off": "关闭",
			"memory.inject.autoVaultGate.heuristic": "智能（启发式）",
			"memory.inject.autoVaultGate.llm": "LLM 判断",
			"memory.inject.vault.archiveHint": "Vault 语义记忆请在 /dsh-memory/ 管理页浏览与编辑（本 tab 的「自动检索」负责按需召回）。",
			"memory.inject.projects": "项目记忆（AI 自动维护 · 默认不注入）",
			"memory.inject.projects.hint": "AI 会在关键节点自动把项目进展写进\"本对话所属项目\"（下面选）。下面的勾选框控制要注入哪些项目的记忆；默认不勾——上下文里已有项目内容，勾了会重复。项目记忆用于：新对话接续、同项目对话共享、上下文丢失后恢复。",
			"memory.inject.projects.empty": "当前还没有项目记忆。AI 在关键节点会自动记录；也可以让 agent 用 memory add（scope=project）手动写入。",
			"memory.inject.projectSelect": "本对话所属项目",
			"memory.inject.projectSelect.hint": "AI 自动写项目记忆时写进这里；同一项目的对话即使工作目录不同也共享同一份。",
			"memory.inject.projectFollowCwd": "跟随工作目录（自动）",
			"memory.preview.title": "本对话每轮将注入的内容（实时预览，随勾选变化）",
			"memory.preview.empty": "（未勾选任何记忆 —— 本对话的 AI 每轮不会看到任何记忆）",
			"memory.global.title": "记忆库（存放所有记忆的仓库，所有对话共享）",
			"memory.global.hint": "仓库里的内容不会因勾选而增减 —— 勾选只是\"门卫\"，决定本对话的 AI 看不看得到它们。删除/修改记忆请用 /dsh-memory/ 页面。",
			"memory.global.empty": "（空）",
			"memory.project.current": "当前项目",
			"memory.editor.aria": "本对话记忆编辑器",
			"memory.project.new.placeholder": "新建命名项目（英文，如 dsh-persist）",
			"memory.project.new.aria": "新建命名项目",
			"memory.project.new.failed": "创建项目失败",
			"memory.project.new.invalid": "项目名仅限字母/数字/._-（且不能是 . 或 ..）",
			"memory.preview.expand": "（点击展开全部）",
			"memory.preview.collapse": "（点击收起）",
			"memory.admin.open": "打开记忆管理页"
		};
		const en = {
			"memory.tab": "Memory",
			"memory.title": "Memory",
			"memory.hint": "This conversation's own memory + injection config. Saved config applies from the next turn.",
			"memory.save": "Save",
			"memory.saving": "Saving…",
			"memory.saved": "Saved",
			"memory.saveFailed": "Save failed",
			"memory.loadFailed": "Failed to load memories",
			"memory.refresh": "Refresh",
			"memory.conversation.title": "This conversation's memory",
			"memory.conversation.hint": "Only this conversation sees or injects it. Agent `memory add` in this conversation writes here.",
			"memory.inject.title": "Injection config",
			"memory.inject.hint": "Checked = the AI sees these memories every turn; unchecked = it never sees them. Applies from the next turn.",
			"memory.inject.userProfile": "User profile (who you are: identity/preferences/habits)",
			"memory.inject.longTerm": "Long-term memory (cross-conversation experience/progress/rules)",
			"memory.inject.conversation": "This conversation's memory",
			"memory.inject.keyed": "Keyed memories ({count} items)",
			"memory.inject.autoVaultGate.title": "Auto retrieval",
			"memory.inject.autoVaultGate.hint": "Per turn, semantically retrieve topK=3 Vault hits for your message and inject them. Smart mode filters chatter with pure-local rules (zero network); LLM mode calls a model judge (sends the message to the model; timeout/failure degrades to Smart, up to ~5s latency per turn).",
			"memory.inject.autoVaultGate.off": "Off",
			"memory.inject.autoVaultGate.heuristic": "Smart (heuristic)",
			"memory.inject.autoVaultGate.llm": "LLM judge",
			"memory.inject.vault.archiveHint": "Browse and edit Vault semantic memories on the /dsh-memory/ management page (this tab's \"Auto retrieval\" recalls them on demand).",
			"memory.inject.projects": "Project memories (AI-maintained · not injected by default)",
			"memory.inject.projects.hint": "The AI writes project progress into the \"belongs-to project\" selected below. The checkboxes below control which projects' memories are injected; unchecked by default — the transcript already carries the project state, so injecting duplicates. Project memory exists for new conversations, sharing across conversations of the same project, and resuming after context loss.",
			"memory.inject.projects.empty": "No project memories yet. The AI will record them automatically at checkpoints; agents can also write via `memory add` (scope=project).",
			"memory.inject.projectSelect": "This conversation belongs to project",
			"memory.inject.projectSelect.hint": "The AI writes project memory into the selected project; conversations of the same project share one memory even with different working directories.",
			"memory.inject.projectFollowCwd": "Follow working directory (automatic)",
			"memory.preview.title": "What this conversation injects every turn (live preview, follows the checkboxes)",
			"memory.preview.empty": "(Nothing selected — this conversation's AI will not see any memory)",
			"memory.global.title": "Memory store (the warehouse holding all memories, shared by every conversation)",
			"memory.global.hint": "Checking boxes never adds or removes anything here — the checkboxes are the gatekeeper deciding whether THIS conversation's AI can see each block. Edit/delete memories on the /dsh-memory/ page.",
			"memory.global.empty": "(empty)",
			"memory.project.current": "Current project",
			"memory.editor.aria": "Conversation memory editor",
			"memory.project.new.placeholder": "New named project (English, e.g. dsh-persist)",
			"memory.project.new.aria": "Create a named project",
			"memory.project.new.failed": "Failed to create project",
			"memory.project.new.invalid": "Project name: letters/digits/._- only (not \".\" or \"..\")",
			"memory.preview.expand": "(click to expand all)",
			"memory.preview.collapse": "(click to collapse)",
			"memory.admin.open": "Open memory admin"
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
			// ★2026-09-15：这里原来还有「关键记忆 / 项目记忆」两段 —— 客户端为了实时预览，
			//   复制了一份注入逻辑；那两层已废弃，host 侧 `lib/index.js` 的注入已删，
			//   客户端这份**必须同时删**，否则预览会显示 host 根本不会再注入的段（= 预览撒谎，
			//   而上面那段注释还写着"预览永不漂移"）。
			return blocks;
		}
		//#endregion
		//#region src/client/MemoryView.tsx
		/**
		* Memory view: the per-conversation "记忆" tab.
		*
		* Shows THIS conversation's own memory (editable) plus its injection config
		* (selective: which memory blocks enter this conversation's prompt), with
		* previews of the global pool. Data comes from the host API
		* /dsh-memory/api/session/<id>.
		*
		* Styling follows the DSH design-system tokens (--dsw-alias-*) so the tab
		* inherits the host light/dark theme instead of hard-coded colors. Layout is
		* sectioned for scannability: header → this-conversation memory → injection
		* switches → live preview → memory store → action bar.
		*/
		/** Auto-retrieval mode options, in display order. */
		const GATE_MODES = [
			"off",
			"heuristic",
			"llm"
		];
		/** Stacked section <section> with a subtle card surface and 1-unit border. */
		const section = {
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-layer-1)",
			padding: "14px 16px",
			margin: "10px 0"
		};
		const sectionTitle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			fontSize: 14,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)",
			margin: "0 0 4px",
			flexWrap: "wrap"
		};
		const hint = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: 1.6,
			margin: "0 0 10px"
		};
		const textarea = {
			width: "100%",
			minHeight: 150,
			boxSizing: "border-box",
			fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
			fontSize: 13,
			lineHeight: 1.6,
			borderRadius: 8,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			resize: "vertical"
		};
		const switchRow = {
			display: "flex",
			alignItems: "flex-start",
			gap: 10,
			padding: "7px 10px",
			borderRadius: 8,
			fontSize: 13,
			cursor: "pointer",
			minHeight: 34,
			transition: "background 0.12s ease"
		};
		const switchChecked = { background: "var(--dsw-alias-interactive-bg-hover)" };
		const switchLabel = {
			display: "flex",
			flexDirection: "column",
			gap: 2,
			minWidth: 0
		};
		const switchTitle = {
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			fontWeight: 500,
			display: "flex",
			alignItems: "center",
			gap: 6
		};
		const preview = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 11.5,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
			maxWidth: 480
		};
		const rawInput = {
			accentColor: "var(--dsw-alias-brand-primary)",
			width: 16,
			height: 16,
			marginTop: 2,
			flexShrink: 0,
			cursor: "pointer"
		};
		const select = {
			margin: "2px 0 8px",
			padding: "6px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			maxWidth: 460,
			cursor: "pointer"
		};
		const bar = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			margin: "12px 0 4px",
			flexWrap: "wrap"
		};
		const primaryButton = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			padding: "6px 14px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-brand-primary)",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer",
			fontSize: 13,
			fontWeight: 500
		};
		const ghostButton = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			padding: "6px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			fontSize: 13
		};
		const buttonDisabled = {
			opacity: .55,
			cursor: "default"
		};
		const statusOk = {
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			fontSize: 12,
			color: "var(--dsw-alias-state-success-primary)"
		};
		const statusErr = {
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			fontSize: 12,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const detailBox = { margin: "6px 0" };
		const summary = {
			cursor: "pointer",
			padding: "6px 8px",
			borderRadius: 6,
			fontSize: 13,
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			display: "flex",
			alignItems: "center",
			gap: 6,
			listStyle: "none"
		};
		const preBlock = {
			maxHeight: 160,
			overflow: "auto",
			fontSize: 12,
			lineHeight: 1.6,
			background: "var(--dsw-alias-bg-layer-2)",
			padding: "10px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l1)",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			color: "var(--dsw-alias-label-secondary)",
			margin: "6px 4px 2px"
		};
		const sectionSubtitle = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 12,
			fontWeight: 500,
			margin: "4px 0 2px",
			display: "flex",
			alignItems: "center",
			gap: 6
		};
		/** Stronger, clearly-bolded heading for the project-memory sub-panel. */
		const projectHeading = {
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			fontWeight: 700,
			margin: "8px 0 6px",
			display: "flex",
			alignItems: "center",
			gap: 6
		};
		/** Multi-line project-memory preview: shows a few real lines, expands to all. */
		const projectPreview = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: 1.5,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			margin: "2px 0 0",
			cursor: "text"
		};
		/**
		* Up to `maxLines` meaningful preview lines for a memory block: skips
		* markdown headings, separators, and blanks so the preview shows real
		* content (e.g. "学生，懒人老板型") instead of the file's title line.
		*/
		function previewLines(text, maxLines = 3, maxChars = 50) {
			const out = [];
			for (const raw of text.split("\n")) {
				const line = raw.trim();
				if (line === "" || line.startsWith("#") || line.startsWith("---") || line.startsWith("```")) continue;
				out.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
				if (out.length >= maxLines) break;
			}
			return out.join(" · ");
		}
		/**
		* Compose the exact injection text for THIS conversation from the current
		* draft selection. Shares the host's block composer (memory-blocks.ts), so
		* the live preview can never drift from what the AI actually receives:
		* unchecking a block removes it here immediately, and the caps are identical.
		*/
		function composePreview(draft, snap, ownMemory) {
			const blocks = composeBlocks(draft, {
				user: snap.previews.userProfile,
				longTerm: snap.previews.longTerm,
				keyed: snap.previews.keyed,
				conversation: ownMemory,
				projects: snap.projects.map((p) => ({
					key: p.key,
					label: p.cwd ?? p.key,
					content: p.memory ?? ""
				}))
			});
			if (blocks.length === 0) return "";
			return `## 用户记忆（跨会话持久）\n${blocks.join("\n\n")}`;
		}
		/** The memory tab body. `sessionId` arrives from the conversation-view standard kit. */
		function MemoryView({ sessionId, t }) {
			const [snapshot, setSnapshot] = (0, react.useState)(null);
			const [memoryDraft, setMemoryDraft] = (0, react.useState)("");
			const [injectDraft, setInjectDraft] = (0, react.useState)(null);
			const [status, setStatus] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			/** Project keys whose memory preview is expanded to full (default 3-line). */
			const [expandedProjects, setExpandedProjects] = (0, react.useState)(/* @__PURE__ */ new Set());
			/** New named-project input value (hand-created project, not cwd-derived). */
			const [newProjectName, setNewProjectName] = (0, react.useState)("");
			const loadAbortRef = (0, react.useRef)(null);
			/** Latest t: stable ref so `load` can depend on sessionId alone. */
			const tRef = (0, react.useRef)(t);
			tRef.current = t;
			const load = (0, react.useCallback)(async () => {
				loadAbortRef.current?.abort();
				const controller = new AbortController();
				loadAbortRef.current = controller;
				setStatus(null);
				try {
					const response = await fetch(`/dsh-memory/api/session/${encodeURIComponent(String(sessionId))}`, { signal: controller.signal });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					if (data.ok !== true) throw new Error("load failed");
					if (data.sessionId !== String(sessionId) || controller.signal.aborted) return;
					setSnapshot(data);
					setMemoryDraft(data.memory);
					setInjectDraft(data.inject);
				} catch {
					if (controller.signal.aborted) return;
					setStatus({
						kind: "err",
						text: tRef.current("memory.loadFailed")
					});
				}
			}, [sessionId]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const toggleSwitch = (key) => {
				setInjectDraft((prev) => prev === null ? prev : {
					...prev,
					[key]: !prev[key]
				});
			};
			const toggleProject = (key) => {
				setInjectDraft((prev) => {
					if (prev === null) return prev;
					const projects = prev.projects.includes(key) ? prev.projects.filter((p) => p !== key) : [...prev.projects, key];
					return {
						...prev,
						projects
					};
				});
			};
			const setProjectKey = (key) => {
				setInjectDraft((prev) => prev === null ? prev : {
					...prev,
					projectKey: key === "" ? null : key
				});
			};
			/** Pick the auto-retrieval mode (off / heuristic / llm). */
			const setGateMode = (mode) => {
				setInjectDraft((prev) => prev === null ? prev : {
					...prev,
					autoVaultGate: mode
				});
			};
			/** Create a hand-named project, then assign it to this conversation. */
			const createNamedProject = async () => {
				const key = newProjectName.trim();
				if (key === "") return;
				if (!/^[A-Za-z0-9._-]{1,160}$/.test(key) || key === "." || key === "..") {
					setStatus({
						kind: "err",
						text: t("memory.project.new.invalid")
					});
					return;
				}
				try {
					const response = await fetch("/dsh-memory/api/projects", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ key })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setNewProjectName("");
					setProjectKey(key);
					setSnapshot((prev) => prev === null ? prev : {
						...prev,
						projects: [...prev.projects, {
							key,
							memory: ""
						}]
					});
				} catch {
					setStatus({
						kind: "err",
						text: t("memory.project.new.failed")
					});
				}
			};
			/** Toggle one project's memory preview between collapsed and expanded. */
			const toggleProjectPreview = (key) => {
				setExpandedProjects((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				});
			};
			const save = async () => {
				if (snapshot === null || injectDraft === null) return;
				if (snapshot.sessionId !== String(sessionId)) {
					setStatus({
						kind: "err",
						text: t("memory.loadFailed")
					});
					return;
				}
				setSaving(true);
				setStatus(null);
				try {
					const response = await fetch(`/dsh-memory/api/session/${encodeURIComponent(String(sessionId))}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							memory: memoryDraft,
							inject: injectDraft
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					setStatus(data.ok ? {
						kind: "ok",
						text: t("memory.saved")
					} : {
						kind: "err",
						text: t("memory.saveFailed")
					});
				} catch {
					setStatus({
						kind: "err",
						text: t("memory.saveFailed")
					});
				} finally {
					setSaving(false);
				}
			};
			if (snapshot === null || injectDraft === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontSize: 13
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						...section,
						color: "var(--dsw-alias-label-secondary)"
					},
					children: status?.kind === "err" ? status.text : "…"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: bar,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						style: ghostButton,
						onClick: () => void load(),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 }), t("memory.refresh")]
					})
				})]
			});
			const projectRows = [...snapshot.projects];
			if (snapshot.project !== null && !projectRows.some((p) => p.key === snapshot.project.key)) projectRows.unshift({
				key: snapshot.project.key,
				memory: "",
				...snapshot.project.cwd === void 0 ? {} : { cwd: snapshot.project.cwd }
			});
			const keyedCount = snapshot.previews.keyed.length;
			const keyedPreview = snapshot.previews.keyed.slice(0, 3).map((e) => e.key).join(" · ");
			const livePreview = composePreview(injectDraft, snapshot, memoryDraft);
			const switchMeta = [
				{
					key: "userProfile",
					label: t("memory.inject.userProfile"),
					note: previewLines(snapshot.previews.userProfile)
				},
				{
					key: "longTerm",
					label: t("memory.inject.longTerm"),
					note: previewLines(snapshot.previews.longTerm)
				},
				{
					key: "conversation",
					label: t("memory.inject.conversation"),
					note: previewLines(memoryDraft)
				}
			];
			const selectedCount = switchMeta.filter((s) => injectDraft[s.key]).length + (injectDraft.autoVaultGate === "off" ? 0 : 1);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontSize: 13,
					maxWidth: 760
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: {
							marginBottom: 6,
							display: "flex",
							alignItems: "flex-start",
							justifyContent: "space-between",
							gap: 8,
							flexWrap: "wrap"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: {
								margin: 0,
								fontSize: 16,
								fontWeight: 600,
								color: "var(--dsw-alias-label-primary)"
							},
							children: t("memory.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: hint,
							children: t("memory.hint")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: "/dsh-memory/",
							target: "_blank",
							rel: "noopener noreferrer",
							style: {
								whiteSpace: "nowrap",
								fontSize: 12,
								color: "var(--dsw-alias-label-link, var(--dsw-alias-label-secondary))",
								textDecoration: "underline",
								textUnderlineOffset: 2,
								marginTop: 2
							},
							children: t("memory.admin.open")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: sectionTitle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, { size: 14 }), t("memory.conversation.title")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: hint,
								children: t("memory.conversation.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								"aria-label": t("memory.editor.aria"),
								style: textarea,
								spellCheck: false,
								value: memoryDraft,
								onChange: (event) => setMemoryDraft(event.target.value)
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: sectionTitle,
								children: [t("memory.inject.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										fontWeight: 500,
										color: "var(--dsw-alias-label-tertiary)",
										background: "var(--dsw-alias-interactive-bg-hover)",
										borderRadius: 999,
										padding: "1px 8px"
									},
									children: selectedCount
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: hint,
								children: t("memory.inject.hint")
							}),
							switchMeta.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: injectDraft[item.key] ? {
									...switchRow,
									...switchChecked
								} : switchRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									style: rawInput,
									checked: injectDraft[item.key],
									onChange: () => toggleSwitch(item.key)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: switchLabel,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: switchTitle,
										children: item.label
									}), item.note !== void 0 && item.note !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: preview,
										children: item.note
									})]
								})]
							}, item.key)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 12,
									paddingLeft: 6
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: projectHeading,
										children: t("memory.inject.autoVaultGate.title")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: {
											...hint,
											marginBottom: 6
										},
										children: t("memory.inject.autoVaultGate.hint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											display: "flex",
											gap: 6,
											flexWrap: "wrap"
										},
										children: GATE_MODES.map((mode) => {
											const checked = injectDraft.autoVaultGate === mode;
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													...switchRow,
													...checked ? switchChecked : {},
													minHeight: 30,
													padding: "4px 10px",
													borderRadius: 8,
													cursor: "pointer"
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "radio",
													name: "autoVaultGate",
													style: rawInput,
													checked,
													onChange: () => setGateMode(mode)
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: switchLabel,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: switchTitle,
														children: t(`memory.inject.autoVaultGate.${mode}`)
													})
												})]
											}, mode);
										})
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 12 },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: sectionSubtitle,
									children: t("memory.preview.title")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									style: preBlock,
									children: livePreview === "" ? t("memory.preview.empty") : livePreview
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: sectionTitle,
								children: t("memory.global.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: hint,
								children: t("memory.global.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								style: detailBox,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
									style: summary,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 12 }), "USER.md · 用户画像"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									style: preBlock,
									children: snapshot.previews.userProfile.trim() === "" ? t("memory.global.empty") : snapshot.previews.userProfile
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								style: detailBox,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
									style: summary,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 12 }), "MEMORY.md · 长期记忆"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									style: preBlock,
									children: snapshot.previews.longTerm.trim() === "" ? t("memory.global.empty") : snapshot.previews.longTerm
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									...hint,
									marginTop: 8
								},
								children: t("memory.inject.vault.archiveHint")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: bar,
						role: "group",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								style: saving ? {
									...primaryButton,
									...buttonDisabled
								} : primaryButton,
								disabled: saving,
								onClick: () => void save(),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 }), saving ? t("memory.saving") : t("memory.save")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								style: ghostButton,
								onClick: () => void load(),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 }), t("memory.refresh")]
							}),
							status !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: status.kind === "ok" ? statusOk : statusErr,
								children: [status.kind === "ok" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 12 }), status.text]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the conversation slot and the locale service. */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: register the memory view tab. The registration rides
		* the slot service's effect wrapper, so plugin unload removes it.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-memory: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "memory",
				order: 20,
				locale: NS,
				label: () => t("memory.tab"),
				inject: () => ({})
			}, MemoryView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	
		})();
		var module = { exports: {} };
		var exports = module.exports;
		var inject = Array.from(new Set([].concat(PART_APP.inject || [], PART_MEM.inject || [])));
		function apply(ctx) {
			PART_APP.apply(ctx);
			PART_MEM.apply(ctx);
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
