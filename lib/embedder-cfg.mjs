// embedder-cfg.mjs —— 「嵌入器配置怎么算」的**唯一实现**（默认值 / isLocal / configured）。
//
// ★为什么单独一个文件★：这段判断原来只住在 `index.js` 的 `effectiveEmbedder()` 里，
//   而**初始化向导也要判"嵌入器配好没有"** —— 两处各写一份 = 迟早不一致，
//   而这类不一致的表现正是**假绿 / 假红**（卡片说 ✓、真嵌入其实没配；或者反过来）。
//   同族教训：切块器「CLI 一套、已装一套」漂过一回，为它专门加了 parity 夹具。
//
// ⚠️ **注意 `mode` 缺省是 `cloud`（不是 local）** —— 所以**不能拿 mode 当"用户选了 API"的证据**：
//   全新装好、还没碰过设置页时，`mode` 读出来也是 `cloud`、但 `key` 是空的。
//   判"能用了吗"必须 `configured`（cloud 模式下 = Key 已填）跟着一起看。
//
// 本文件只放**纯函数**：读文件由调用方做（`index.js` 用它的 `embedderFile()`，
//   向导用它的 `~/.dsh-memory/embedder.json`）—— 这样"配置存在哪"仍然只有一处口径。

/** 把一份（可能残缺的）embedder.json 内容补成**实际生效**的配置。
 *  @param {{[k:string]:any}} c 读到的原始 JSON（可能是 `{}`）
 *  @returns {{mode:'local'|'cloud', isLocal:boolean, endpoint:string, model:string, key:string, device:string, numCtx:number, configured:boolean}} */
export function effectiveEmbedderFrom(c) {
  const cfg = c || {}
  const isLocal = String(cfg.mode || 'cloud').toLowerCase() === 'local'
  const endpoint = String(cfg.endpoint || (isLocal ? 'http://127.0.0.1:11434' : 'https://api.siliconflow.cn/v1/embeddings')).replace(/\/+$/, '')
  const model = String(cfg.model || (isLocal ? 'qwen3-embedding:0.6b' : 'BAAI/bge-m3'))
  const key = String(cfg.key || '')
  return {
    mode: isLocal ? 'local' : 'cloud',
    isLocal,
    endpoint,
    model,
    key,
    device: cfg.device === undefined || cfg.device === null ? 'auto' : String(cfg.device),
    numCtx: Number(cfg.numCtx) > 0 ? Math.floor(Number(cfg.numCtx)) : 1024,
    configured: isLocal || key !== '',
  }
}
