/**
 * test-worker-runner.js —— Worker 线程内的测试执行器
 *
 * 职责单一：在独立 Worker 里 import 一个测试脚本，捕获 console 输出和
 * process.exit 的退出码，回传主线程。**判定口径不在这里** —— 主线程复用
 * test-all.mjs 的 tickCount/crossCount，保证 --worker 与 spawnSync 完全一致。
 *
 * 关键设计（踩过坑，别改回去）：
 *  1. process.exit patch 成「记录 code + 提前 resolve」，**不抛异常**。
 *     曾有版本抛哨兵异常，结果 test-contract-asr-eta 的 .catch() 把哨兵当
 *     测试失败（"ASR/ETA 阶段抛错 __TEST_WORKER_EXIT__"）→ 假红。
 *  2. import 完成后只给 300ms 宽限期等异步 exit，不等满 timeout。
 *     多数脚本不显式 exit（靠自然结束），等满 180s 会全部假超时。
 *  3. 每任务一个新 Worker、跑完即回收：测试普遍 mock 全局 fetch/env，
 *     同线程复用会跨测试污染。线程创建仍比进程便宜。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const { script, args = [], timeout = 180000 } = workerData

let out = ''
const realLog = console.log
const realErr = console.error
const capture = (...a) => { out += a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n' }
console.log = capture
console.error = capture

let exitCodeValue = 0
let exited = false
let resolveExit
const exitPromise = new Promise((r) => { resolveExit = r })
const realExit = process.exit
process.exit = (code) => {
  if (exited) return
  exited = true
  exitCodeValue = Number.isInteger(code) ? code : 0
  resolveExit('exit') // 不抛异常，只发信号
}
process.argv = [process.execPath, script, ...args]

const startedAt = Date.now()
let timedOut = false
const hardTimer = setTimeout(() => { timedOut = true; resolveExit('timeout') }, timeout)

function finish(code, extra = '') {
  clearTimeout(hardTimer)
  console.log = realLog
  console.error = realErr
  process.exit = realExit
  parentPort.postMessage({ exitCode: code, out: out + extra, ms: Date.now() - startedAt })
}

async function main() {
  let thrownErr = null
  try {
    await import(pathToFileURL(path.resolve(script)).href)
  } catch (e) {
    thrownErr = e
  }
  // 短宽限：同步脚本 import 内已 exit（resolve 早完成）；异步脚本在 then 里
  // exit。取 300ms —— 覆盖微任务与一轮定时器，又不会让不 exit 的脚本空等 2s。
  // 实测 contract-asr-eta（异步 exit）49ms 内完成，300ms 足够。
  const GRACE_MS = 300
  await Promise.race([
    exitPromise,
    new Promise((r) => setTimeout(r, GRACE_MS)),
  ])

  if (timedOut) finish(124)
  else if (thrownErr) finish(1, `\n[Worker 执行异常] ${thrownErr.stack || thrownErr.message || thrownErr}\n`)
  else if (exited) finish(exitCodeValue)
  else finish(0)
}

main().catch((e) => finish(1, `\n[Worker main 异常] ${e.message}\n`))
