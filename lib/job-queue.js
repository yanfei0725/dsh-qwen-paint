/**
 * lib/job-queue.js - 通用优先级任务队列（纯 JS、零真实 I/O）。
 *
 * 定位：给「提交一批后台作业、按优先级跑、能取消、失败自动重试」提供一个
 * 进程内的编排器。它**不自带任何出图 / 网络 / 子进程能力**：run 完全由调用方
 * 注入，队列只负责排序、并发、取消信号、重试与退避。
 *
 * 三条诚实边界：
 *   ① 取消运行中的任务只能发 AbortSignal 通知（run 收到 signal 后自行收尾），
 *      队列不会、也无法强杀一个正在执行的 JS 函数；run 若不响应 signal，
 *      该作业会一直留在 running 状态。
 *   ② 退避等待、时间戳全部走注入的 sleep / now，离线测试绝不真等真实时钟。
 *   ③ 状态只在内存中，进程重启即清空；不做跨进程持久化，不假装能做到。
 *
 * 调度用微任务合并：一次同步里连续 enqueue 的多个作业会先全部入队，
 * 再由同一个 pump 按「优先级高先跑、同级按提交顺序」取，避免先提交的低优先级
 * 作业抢跑。这样批量提交的顺序是完全确定的，可逐条断言。
 *
 * 代码风格：ESM、export function/const、字符串只用 ASCII 直引号。
 */

/** 优先级常量。数值越大越先跑。也接受直接传数字。 */
export const PRIORITY_LEVELS = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
})

const DEFAULT_CONCURRENCY = 1
const DEFAULT_BACKOFF_MS = 1000
const MAX_CONCURRENCY = 64
const MAX_RETRIES = 20

function clampInt(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

function briefError(e) {
  const raw = e && typeof e === 'object' && e.message !== undefined ? e.message : e
  const m = String(raw ?? '').replace(/\s+/g, ' ').trim()
  return m.length > 200 ? m.slice(0, 200) + '...' : (m || 'unknown error')
}

function toPriority(p) {
  if (typeof p === 'number' && Number.isFinite(p)) return p
  if (typeof p === 'string') {
    const key = p.toUpperCase()
    if (Object.prototype.hasOwnProperty.call(PRIORITY_LEVELS, key)) return PRIORITY_LEVELS[key]
  }
  return PRIORITY_LEVELS.NORMAL
}

/**
 * 建一个队列实例。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]          注入时钟（毫秒），默认 Date.now
 * @param {number} [opts.concurrency]        最大并发，默认 1
 * @param {number} [opts.maxRetries]         单作业失败后的最大重试次数，默认 0（不重试）
 * @param {number} [opts.backoffMs]          退避基数，默认 1000；第 n 次退避为 backoffMs * 2^(n-1)
 * @param {(ms:number) => Promise} [opts.sleep] 注入的等待函数；离线测试传入立即 resolve 的假实现
 */
export function createJobQueue(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms))

  let concurrency = clampInt(opts.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY)
  let maxRetries = clampInt(opts.maxRetries, 0, 0, MAX_RETRIES)
  let backoffMs = Number.isFinite(opts.backoffMs) && opts.backoffMs >= 0
    ? opts.backoffMs
    : DEFAULT_BACKOFF_MS

  let paused = false
  let seq = 0
  let pumpScheduled = false

  /** id -> job（含所有终态，便于 list / stats / retry 查询） */
  const jobs = new Map()
  /** 仅 state=pending 的作业 */
  const pending = []
  /** 正在跑的 id 集合 */
  const running = new Set()
  /** drain() 挂起的 resolve */
  const drainWaiters = []

  function snapshot(job) {
    return {
      id: job.id,
      priority: job.priority,
      state: job.state,
      payload: job.payload,
      attempts: job.attempts,
      result: job.result,
      error: job.error,
      canceled: job.canceled,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      seq: job.seq,
    }
  }

  function finalize(job, state, extra) {
    // 已取消的作业不接受任何后续终态覆盖（run 在 abort 后才返回也不改写）。
    if (job.canceled && state !== 'canceled') return
    job.state = state
    if (extra) Object.assign(job, extra)
    job.finishedAt = now()
  }

  function checkIdle() {
    if (pending.length > 0 || running.size > 0) return
    if (drainWaiters.length === 0) return
    const waiters = drainWaiters.splice(0)
    for (const w of waiters) w()
  }

  function pickNextIndex() {
    let best = -1
    for (let i = 0; i < pending.length; i += 1) {
      const j = pending[i]
      if (j.state !== 'pending') continue
      if (best < 0) { best = i; continue }
      const b = pending[best]
      if (j.priority > b.priority || (j.priority === b.priority && j.seq < b.seq)) best = i
    }
    return best
  }

  async function runWithRetries(job) {
    while (true) {
      if (job.canceled) return
      job.attempts += 1
      const controller = new AbortController()
      job.controller = controller
      let succeeded = false
      let value
      let err
      try {
        // run 收到的 signal 就是取消通道；payload / attempt / id 一并透传。
        value = await job.run({
          signal: controller.signal,
          payload: job.payload,
          attempt: job.attempts,
          id: job.id,
        })
        succeeded = true
      } catch (e) {
        err = e
      } finally {
        job.controller = null
      }

      if (job.canceled) return
      if (succeeded) {
        finalize(job, 'done', { result: value })
        return
      }

      // 仅当错误没有显式标 retryable:false 时才重试；次数受全局 maxRetries 限制。
      const retryable = err == null || err.retryable !== false
      if (retryable && job.attempts <= maxRetries) {
        const delay = backoffMs * (2 ** (job.attempts - 1))
        await sleep(delay)
        if (job.canceled) return
        continue
      }
      finalize(job, 'failed', { error: briefError(err) })
      return
    }
  }

  function startJob(job) {
    job.state = 'running'
    job.startedAt = now()
    running.add(job.id)
    void runWithRetries(job)
      .catch((e) => finalize(job, 'failed', { error: briefError(e) }))
      .then(() => {
        running.delete(job.id)
        checkIdle()
        schedule()
      })
  }

  function pump() {
    if (paused) return
    while (running.size < concurrency) {
      const idx = pickNextIndex()
      if (idx < 0) break
      const job = pending.splice(idx, 1)[0]
      startJob(job)
    }
    checkIdle()
  }

  function schedule() {
    if (pumpScheduled) return
    pumpScheduled = true
    Promise.resolve().then(() => {
      pumpScheduled = false
      pump()
      checkIdle()
    })
  }

  function enqueue(spec = {}) {
    const id = String(spec.id ?? '').trim()
    if (id === '') return { ok: false, id: '', reason: 'id is required', job: {} }
    if (jobs.has(id)) return { ok: false, id, reason: 'duplicate id', job: snapshot(jobs.get(id)) }
    if (typeof spec.run !== 'function') {
      return { ok: false, id, reason: 'run must be a function', job: {} }
    }
    seq += 1
    const job = {
      id,
      priority: toPriority(spec.priority),
      run: spec.run,
      payload: spec.payload,
      state: 'pending',
      attempts: 0,
      canceled: false,
      controller: null,
      result: undefined,
      error: undefined,
      createdAt: now(),
      startedAt: undefined,
      finishedAt: undefined,
      seq,
    }
    jobs.set(id, job)
    pending.push(job)
    schedule()
    return { ok: true, id, reason: '', job: snapshot(job) }
  }

  function cancel(id) {
    const key = String(id ?? '')
    const job = jobs.get(key)
    if (!job) return { ok: false, id: key, reason: 'not found', job: {} }
    if (job.state === 'canceled' || job.state === 'done' || job.state === 'failed') {
      return { ok: false, id: key, reason: 'job already finished', job: snapshot(job) }
    }
    job.canceled = true
    if (job.state === 'pending') {
      const i = pending.indexOf(job)
      if (i >= 0) pending.splice(i, 1)
    } else if (job.state === 'running') {
      // 运行中的取消：通过 AbortSignal 通知 run 自行收尾，并立即标记终态。
      try { job.controller?.abort() } catch { /* 忽略：signal 只是尽力而为的通知 */ }
    }
    finalize(job, 'canceled', {})
    checkIdle()
    return { ok: true, id: key, reason: '', job: snapshot(job) }
  }

  function list(query = {}) {
    const want = query.state
    const wanted = Array.isArray(want)
      ? want.map(String)
      : (want === undefined || want === null || want === '') ? null : [String(want)]
    const out = []
    for (const job of jobs.values()) {
      if (wanted !== null && !wanted.includes(job.state)) continue
      out.push(snapshot(job))
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  function stats() {
    const counts = { pending: 0, running: 0, done: 0, failed: 0, canceled: 0, total: jobs.size }
    for (const job of jobs.values()) {
      if (counts[job.state] !== undefined) counts[job.state] += 1
    }
    return { ...counts, paused, concurrency, maxRetries, backoffMs }
  }

  function pause() { paused = true; return { paused } }
  function resume() { paused = false; schedule(); return { paused } }

  /** 等待队列真正空闲（无 pending 且无 running）。暂停且仍有 pending 时会一直等。 */
  function drain() {
    if (pending.length === 0 && running.size === 0) return Promise.resolve()
    return new Promise((resolve) => { drainWaiters.push(resolve) })
  }

  function config() {
    return { concurrency, maxRetries, backoffMs, paused }
  }

  function configure(patch = {}) {
    if (patch.concurrency !== undefined) {
      concurrency = clampInt(patch.concurrency, concurrency, 1, MAX_CONCURRENCY)
    }
    if (patch.maxRetries !== undefined) {
      maxRetries = clampInt(patch.maxRetries, maxRetries, 0, MAX_RETRIES)
    }
    if (patch.backoffMs !== undefined && Number.isFinite(patch.backoffMs) && patch.backoffMs >= 0) {
      backoffMs = patch.backoffMs
    }
    schedule()
    return config()
  }

  /** 把 failed / canceled 的作业用原来的 run / payload 重新入队（复用同一 id）。 */
  function retry(id) {
    const key = String(id ?? '')
    const job = jobs.get(key)
    if (!job) return { ok: false, id: key, reason: 'not found', job: {} }
    if (job.state === 'pending' || job.state === 'running') {
      return { ok: false, id: key, reason: 'job is not in a retryable state', job: snapshot(job) }
    }
    job.state = 'pending'
    job.canceled = false
    job.attempts = 0
    job.result = undefined
    job.error = undefined
    job.startedAt = undefined
    job.finishedAt = undefined
    job.controller = null
    seq += 1
    job.seq = seq
    pending.push(job)
    schedule()
    return { ok: true, id: key, reason: '', job: snapshot(job) }
  }

  return {
    enqueue,
    cancel,
    list,
    stats,
    pause,
    resume,
    drain,
    config,
    configure,
    retry,
  }
}
