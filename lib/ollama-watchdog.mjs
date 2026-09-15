// Ollama 看门狗（独立进程）——DSH 一死，不论**怎么死的**，都把 Ollama 整棵树收掉。
//
// 为什么必须是独立进程：
//   · DSH 被强杀（Ctrl+C / 关窗口 / 任务管理器 / 任何停止脚本）时，
//     它自己的 `process.on('exit')` **根本没机会跑**；
//   · 事后"按 pid 去杀"也够不着 —— 实测：强杀的那一刻 `ollama serve` 自己也跟着没了，
//     只剩**跑模型的孙进程** `llama-server` 孤儿占着 2 GB 显存（taskkill /T 只认活着的父进程）。
// 所以换个思路：**谁起的孩子，就派一个遗言执行人跟着**。它只干一件事：
//   盯着主人 pid → 主人一没，就把 Ollama 那棵树（含跑模型的孙进程）连根收掉 → 自己退。
//
// 这样"跟着 DSH 一起被杀、不占显存"**不依赖** DSH 能不能优雅退出、
// 也**不依赖**任何启动/停止脚本怎么写 —— 换电脑、别人拿去用，一样成立。
//
// 用法：node ollama-watchdog.mjs <主人pid> <ollama_pid>
import { execFile } from 'node:child_process'

const ownerPid = Number(process.argv[2])
const ollamaPid = Number(process.argv[3])
const POLL_MS = 2000
const MAX_MS = 7 * 24 * 3600 * 1000          // 兜底：最多守 7 天，别真变成常驻垃圾

if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !Number.isInteger(ollamaPid) || ollamaPid <= 0) {
  process.exit(2)
}

/** 进程还活着吗（signal 0 可用；EPERM 表示存在但权限不够，也算活着）。 */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

/** 收掉一整棵进程树。 */
function killTree(pid) {
  return new Promise(function (resolve) {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true },
        function () { resolve() })
      return
    }
    // POSIX：ollama serve 是以"进程组组长"身份起的。即使组长自己先死了，进程组 id 仍在、组里还有活着的
    // 成员（跑模型的子进程），所以按 -pgid 杀一次就能把它一起带走。
    try { process.kill(-pid, 'SIGKILL') } catch (_e) {
      try { process.kill(pid, 'SIGKILL') } catch (_e2) {}
    }
    resolve()
  })
}

function listProcs(imageName) {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32') { resolve([]); return }
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'],
      { timeout: 6000, windowsHide: true },
      function (err, stdout) {
        if (err || !stdout) { resolve([]); return }
        resolve([...String(stdout).matchAll(/^"([^"]+)","(\d+)"/gm)].map((m) => Number(m[2])))
      })
  })
}

/** 按【身份】扫掉 Ollama 残留的跑模型进程：nvidia-smi 给出占用显存的进程的完整路径，
 *  路径落在 ollama 目录下、名字是 llama-server 的才是它的 —— **不按名字乱杀**别人的 llama.cpp。
 *  闸：只有当【没有任何 ollama 服务进程活着】时才扫（否则可能是在替另一个实例干活，不能动）。 */
function sweepOllamaRunners() {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32') { resolve(0); return }
    listProcs('ollama.exe').then(function (serves) {
      if (serves.length > 0) { resolve(0); return }          // 还有活的 Ollama 服务 → 不扫，别误伤
      execFile('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'],
        { timeout: 8000, windowsHide: true },
        function (err, stdout) {
          if (err || !stdout) { resolve(0); return }
          const targets = []
          for (const line of String(stdout).split(/\r?\n/)) {
            const i = line.indexOf(',')
            if (i < 0) continue
            const pid = Number(line.slice(0, i).trim())
            const path = line.slice(i + 1).trim()
            if (Number.isInteger(pid) && pid > 0 && /ollama/i.test(path) && /llama-server(\.exe)?$/i.test(path)) {
              targets.push(pid)
            }
          }
          if (targets.length === 0) { resolve(0); return }
          let left = targets.length
          for (const pid of targets) {
            killTree(pid).then(function () { if (--left === 0) resolve(targets.length) })
          }
        })
    })
  })
}

const startedAt = Date.now()
const timer = setInterval(function () {
  if (Date.now() - startedAt > MAX_MS) { clearInterval(timer); process.exit(0) }

  // ★ 顺序很重要：**先看主人**。
  //   （第一版反过来先看 ollamaPid —— 结果强杀时 serve 先死、我一看"目标没了"就退休了，
  //     留下跑模型的孙进程继续占显存。实测抓到的。）
  if (alive(ownerPid)) {
    // 主人还在：只管盯着。serve 自己先没了（用户点了「停止 Ollama」）→ 收工，不越权
    if (!alive(ollamaPid)) { clearInterval(timer); process.exit(0) }
    return
  }

  // 主人没了 → 收尸：先按 pid 收树；serve 可能已经先死，所以再按身份扫一遍兜住孙进程
  clearInterval(timer)
  killTree(ollamaPid).then(sweepOllamaRunners).then(function () { process.exit(0) })
}, POLL_MS)
