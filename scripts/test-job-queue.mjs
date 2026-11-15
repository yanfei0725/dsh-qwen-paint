#!/usr/bin/env node
/**
 * job-queue / job-tool 离线回归：全离线、零联网、零出图、不依赖外部可执行文件。
 * 退避与时钟全部注入，绝不真等真实时间。
 */
import { PRIORITY_LEVELS, createJobQueue } from '../lib/job-queue.js'
import { makeJobTool, JOB_ACTIONS } from '../lib/job-tool.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'

let pass = 0
let fail = 0
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fixedNow = () => 0
const instantSleep = () => Promise.resolve()

console.log('job-queue / job-tool 离线回归')

async function main() {
  ok('PRIORITY_LEVELS 四档且数值递增',
    PRIORITY_LEVELS.LOW < PRIORITY_LEVELS.NORMAL
    && PRIORITY_LEVELS.NORMAL < PRIORITY_LEVELS.HIGH
    && PRIORITY_LEVELS.HIGH < PRIORITY_LEVELS.URGENT)

  // 优先级：优先级高先跑，同级按提交顺序。
  {
    const order = []
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep, concurrency: 1 })
    const mk = (id, priority) => ({ id, priority, run: () => { order.push(id); return id } })
    q.enqueue(mk('low1', PRIORITY_LEVELS.LOW))
    q.enqueue(mk('high', PRIORITY_LEVELS.HIGH))
    q.enqueue(mk('low2', PRIORITY_LEVELS.LOW))
    q.enqueue(mk('normal', PRIORITY_LEVELS.NORMAL))
    await q.drain()
    ok('优先级高先跑：high > normal > low', eq(order, ['high', 'normal', 'low1', 'low2']))
    ok('同级 FIFO：low1 在 low2 之前', order.indexOf('low1') < order.indexOf('low2'))
  }

  // 重复 id 明确拒绝，且不影响首个作业。
  {
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep })
    const a = q.enqueue({ id: 'dup', run: () => 1 })
    const b = q.enqueue({ id: 'dup', run: () => 2 })
    ok('重复 id 返回 ok:false + 明确 reason', a.ok === true && b.ok === false && /duplicate/.test(b.reason))
    await q.drain()
    const s = q.stats()
    ok('重复 id 不影响首个作业（只跑一次）', s.total === 1 && s.done === 1)
  }

  // cancel：未开始直接移除。
  {
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep })
    q.pause()
    let ranA = false
    q.enqueue({ id: 'a', run: () => { ranA = true; return 1 } })
    q.enqueue({ id: 'b', run: () => 2 })
    const c = q.cancel('a')
    ok('cancel 未开始任务：ok:true 且状态 canceled', c.ok === true && c.job.state === 'canceled')
    q.resume()
    await q.drain()
    ok('cancel 后该任务 run 从未执行、另一任务照常完成',
      ranA === false && q.list({ state: 'canceled' }).some((j) => j.id === 'a')
      && q.list({ state: 'done' }).some((j) => j.id === 'b'))
  }

  // cancel：运行中的任务通过 AbortSignal 通知。
  {
    let sawAbort = false
    let markStarted
    const started = new Promise((r) => { markStarted = r })
    const run = ({ signal }) => new Promise((resolve) => {
      markStarted()
      signal.addEventListener('abort', () => { sawAbort = true; resolve({ aborted: true }) })
    })
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep, concurrency: 1 })
    q.enqueue({ id: 'x', run })
    await started
    const c = q.cancel('x')
    await q.drain()
    ok('cancel 运行中：AbortSignal 通知到 run（signal.aborted）', c.ok === true && sawAbort === true)
    ok('cancel 运行中：最终状态为 canceled 且 drain 能收敛',
      q.list({ state: 'canceled' }).length === 1 && q.stats().running === 0)
    const c2 = q.cancel('x')
    ok('cancel 已完成/已取消的作业被拒', c2.ok === false && c2.reason !== '')
  }

  // 失败自动重试：次数由 maxRetries 决定。
  {
    const sleeps = []
    let calls = 0
    const q = createJobQueue({
      now: fixedNow, maxRetries: 2, backoffMs: 100,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    q.enqueue({
      id: 'r',
      run: () => {
        calls += 1
        if (calls < 3) { const e = new Error('temporary'); e.retryable = true; throw e }
        return { ok: true }
      },
    })
    await q.drain()
    ok('自动重试：maxRetries=2 共尝试 3 次并成功', calls === 3 && q.list()[0].state === 'done')
    ok('自动重试：退避调用 2 次', sleeps.length === 2)
  }

  // 指数退避：100 / 200 / 400。
  {
    const sleeps = []
    const q = createJobQueue({
      now: fixedNow, maxRetries: 3, backoffMs: 100,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    q.enqueue({ id: 'f', run: () => { throw new Error('always') } })
    await q.drain()
    ok('指数退避 sleeps = [100,200,400]（注入 sleep，绝不真等）', eq(sleeps, [100, 200, 400]))
    ok('重试耗尽后状态 failed、attempts=4', q.list()[0].state === 'failed' && q.list()[0].attempts === 4)
  }

  // retryable:false 不重试。
  {
    const sleeps = []
    let calls = 0
    const q = createJobQueue({
      now: fixedNow, maxRetries: 3, backoffMs: 100,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    q.enqueue({
      id: 'n',
      run: () => { calls += 1; const e = new Error('no retry'); e.retryable = false; throw e },
    })
    await q.drain()
    ok('retryable:false 不重试（sleeps 空、只尝试 1 次）',
      eq(sleeps, []) && calls === 1 && q.list()[0].state === 'failed')
  }

  // pause / resume。
  {
    let ran = 0
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep })
    q.pause()
    q.enqueue({ id: 'p', run: () => { ran += 1; return 1 } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    ok('pause 后任务停在 pending、run 未执行', ran === 0 && q.stats().pending === 1 && q.stats().paused === true)
    q.resume()
    await q.drain()
    ok('resume 后任务跑完、paused 复位', ran === 1 && q.stats().done === 1 && q.stats().paused === false)
  }

  // concurrency 上限。
  {
    let inFlight = 0
    let maxInFlight = 0
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep, concurrency: 2 })
    for (let i = 0; i < 5; i += 1) {
      q.enqueue({
        id: 'c' + i,
        run: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await Promise.resolve(); await Promise.resolve()
          inFlight -= 1
          return i
        },
      })
    }
    await q.drain()
    ok('concurrency=2 时最大并行数不超过 2', maxInFlight === 2)
    ok('concurrency 场景 5 个任务全部完成', q.stats().done === 5 && q.stats().total === 5)
  }

  // stats / list(state) / retry(id)。
  {
    let n = 0
    const q = createJobQueue({ now: fixedNow, sleep: instantSleep, maxRetries: 0 })
    q.enqueue({
      id: 'g',
      run: () => { n += 1; if (n === 1) throw Object.assign(new Error('x'), { retryable: false }); return { ok: true, n } },
    })
    await q.drain()
    ok('stats 各状态计数自洽', q.stats().total === q.stats().failed && q.stats().failed === 1)
    ok('list({state}) 按状态过滤', q.list({ state: 'failed' }).length === 1 && q.list({ state: 'done' }).length === 0)
    const r = q.retry('g')
    await q.drain()
    ok('retry(id) 复用原 run 重新入队并成功', r.ok === true && n === 2 && q.list()[0].state === 'done')
    ok('retry 不存在的 id 被拒', q.retry('nope').ok === false)
  }

  // ---- job-tool：7 个 action 分派、schema 齐全、降级与裁剪 ----
  {
    const sleeps = []
    const q = createJobQueue({
      now: fixedNow, sleep: async (ms) => { sleeps.push(ms) }, concurrency: 2,
    })
    const tool = makeJobTool({
      queue: q,
      runners: { echo: ({ payload }) => ({ echo: payload }) },
    })
    ok('job-tool name 与 timeoutMs 合规', tool.name === 'manage_jobs' && tool.timeoutMs > 0)
    ok('JOB_ACTIONS 含 7 个 action', eq(JOB_ACTIONS, ['submit', 'list', 'cancel', 'retry', 'pause', 'resume', 'config']))
    ok('job-tool output.schema 声明齐全（6 键）',
      eq(Object.keys(tool.output.schema.properties).sort(),
        ['config', 'job', 'jobs', 'ok', 'reason', 'stats']))

    const sub = await tool.execute({ action: 'submit', id: 'j1', kind: 'echo', payload: { x: 1 }, priority: 'high' })
    ok('submit 入队成功并回带 job 快照', sub.ok === true && sub.job.id === 'j1')
    await q.drain()
    const listed = await tool.execute({ action: 'list', state: 'done' })
    ok('list 看到 done 作业且 run 结果正确', listed.ok === true && listed.jobs.length === 1 && listed.jobs[0].result.echo.x === 1)
    ok('submit 重复 id 被 queue 明确拒绝',
      (await tool.execute({ action: 'submit', id: 'j1', kind: 'echo' })).ok === false)

    ok('pause action 生效', (await tool.execute({ action: 'pause' })).ok === true && q.config().paused === true)
    ok('resume action 生效', (await tool.execute({ action: 'resume' })).ok === true && q.config().paused === false)
    const cfg = await tool.execute({ action: 'config', concurrency: 3, maxRetries: 2 })
    ok('config action 更新并返回新配置', cfg.config.concurrency === 3 && cfg.config.maxRetries === 2)
    const bad = await tool.execute({ action: 'nope' })
    ok('未知 action 返回 ok:false + reason', bad.ok === false && bad.reason !== '')

    const q2 = createJobQueue({ now: fixedNow, sleep: instantSleep, maxRetries: 0 })
    const t2 = makeJobTool({
      queue: q2,
      runners: { boom: () => { throw Object.assign(new Error('x'), { retryable: false }) } },
    })
    await t2.execute({ action: 'submit', id: 'b', kind: 'boom' })
    await q2.drain()
    ok('retry action 把 failed 作业重新入队', (await t2.execute({ action: 'retry', id: 'b' })).ok === true)

    // 未注入 runner 时走纯内存占位作业（不联网、不出图、不起子进程）。
    const q3 = createJobQueue({ now: fixedNow, sleep: instantSleep })
    const t3 = makeJobTool({ queue: q3 })
    const ph = await t3.execute({ action: 'submit', id: 'ph', payload: { a: 1 } })
    await q3.drain()
    ok('未注入 runner：submit 降级为纯内存占位作业并成功记账',
      ph.ok === true && q3.list()[0].state === 'done' && q3.list()[0].result.offline === true)

    // withDeclaredOutput 裁剪后不能把结果裁成空对象。
    const wrapped = withDeclaredOutput(makeJobTool({ queue: q3 }))
    const wr = await wrapped.execute({ action: 'list' })
    ok('withDeclaredOutput 裁剪后仍回齐 6 键（不空对象）', Object.keys(wr).length === 6)
  }
}

main().then(() => {
  console.log('=== job-queue：' + pass + ' 项通过，' + fail + ' 项失败 ===')
  if (fail > 0) process.exitCode = 1
}).catch((e) => {
  console.error(e)
  process.exitCode = 1
})
