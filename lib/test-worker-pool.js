/**
 * test-worker-pool.js —— Worker 线程池执行测试（真能跑版）
 *
 * 由 scripts/test-all.mjs 的 --worker 模式动态 import。每套测试起一个独立
 * Worker（lib/test-worker-runner.js），跑完即回收：既拿到线程启动比进程便宜
 * 的收益，又避免同线程复用导致的全局 mock / ESM 顶层状态跨测试污染。
 *
 * 职责边界：本池只负责"跑脚本 → 拿 exitCode/out/ms"，**判定 verdict 由主线程
 * test-all.mjs 用统一口径完成**（tickCount/crossCount），保证 --worker 与
 * spawnSync 两种模式结果一致，绝不出现"Worker 模式假绿"。
 *
 * 用法：
 *   const pool = new TestWorkerPool({ size: 6 })
 *   const r = await pool.run('/abs/scripts/test-x.mjs', { timeout: 60000, args: [] })
 *   // r = { exitCode, out, ms }
 *   await pool.terminate()
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const RUNNER = fileURLToPath(new URL('./test-worker-runner.js', import.meta.url))

export class TestWorkerPool {
  constructor(options = {}) {
    this.size = Math.max(1, Number(options.size) || 4)
    this.queue = []
    this.active = 0
    this.workers = new Set()
    this.closed = false
  }

  /** 提交一个测试脚本，返回 { exitCode, out, ms } */
  run(script, options = {}) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ exitCode: 1, out: '[Worker Pool] 已关闭\n', ms: 0 })
        return
      }
      this.queue.push({ script, options, resolve })
      this._pump()
    })
  }

  _pump() {
    while (!this.closed && this.queue.length > 0 && this.active < this.size) {
      const task = this.queue.shift()
      this.active++
      this._spawn(task)
    }
  }

  _spawn(task) {
    const { script, options, resolve } = task
    const timeout = Number(options.timeout) || 180000
    let worker
    try {
      worker = new Worker(RUNNER, {
        workerData: { script, args: options.args || [], timeout },
      })
    } catch (e) {
      resolve({ exitCode: 1, out: `[Worker Pool] 起线程失败：${e.message}\n`, ms: 0 })
      this.active--
      this._pump()
      return
    }
    this.workers.add(worker)

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      this.workers.delete(worker)
      worker.terminate().catch(() => {})
      this.active--
      resolve(result)
      this._pump()
    }

    // 硬超时兜底（runner 内定时器失效时仍能回收）
    const hardTimer = setTimeout(() => {
      finish({
        exitCode: 124,
        out: `${task.script} [Worker 硬超时 ${timeout}ms]\n`,
        ms: timeout,
      })
    }, timeout + 3000)

    worker.on('message', (msg) => {
      finish({
        exitCode: Number(msg?.exitCode) || 0,
        out: String(msg?.out ?? ''),
        ms: Number(msg?.ms) || 0,
      })
    })
    worker.on('error', (err) => {
      finish({ exitCode: 1, out: `[Worker error] ${err.message}\n`, ms: 0 })
    })
    worker.on('exit', (code) => {
      if (code !== 0 && !settled) {
        finish({ exitCode: code || 1, out: `[Worker 退出码 ${code}]\n`, ms: 0 })
      }
    })
  }

  /** 等排空后关闭所有 Worker */
  async terminate() {
    this.closed = true
    // 等在途任务自然结束（硬超时最多 timeout+3s）
    while (this.active > 0) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await Promise.all([...this.workers].map((w) => w.terminate().catch(() => {})))
    this.workers.clear()
  }
}
