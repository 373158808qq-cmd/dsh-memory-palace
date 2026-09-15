# vendor/dsh-persist

这是 **dsh-persist 的本地分叉**（上游：https://github.com/tluoluo/dsh-persist ，v0.2.5），
**原样收进 dsh-memory-app 里**，由 `lib/index.js` 的 `apply()` 用 `ctx.plugin(...)` 挂载 ——
这样对外**只需要装一个插件**，不必另外装 dsh-persist。

本目录只在"重新 vendor"时改动：`node .ptmp/one_package_build.mjs`（见仓库脚本）。
改动记录（相对上游）见 `memory/PROJECT_LEDGER_ARCHIVE.md` 的阶段56/58/60。
