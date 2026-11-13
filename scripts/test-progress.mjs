#!/usr/bin/env node
/**
 * 生成进度回归（`lib/progress.js` + 进度端点接线）。
 *
 * 要点（每条都对着"假进度条"这个坑）：
 *   ① ETA **只来自自家实测**（EWMA），没历史就是 null —— 绝不拿别人的 benchmark 当承诺
 *   ② 百分比只在有基准时才给，且最高 99%（不给"已 100% 但还没出图"的假象）
 *   ③ 队列位置解析要吃 ComfyUI `/queue` 的真实形状 `[[num, prompt_id, ...], …]`
 *   ④ 端点与面板真的接上了（不是写完模块没人调）
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  runKey, readTimings, recordTiming, estimateSeconds, parseQueue, buildProgress,
  TIMING_FILE, EWMA_ALPHA,
} from '../lib/progress.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

/* ---------------- 指纹 ---------------- */
console.log('— 耗时指纹')
ok('生图指纹含 kind/宽高/步数', runKey({ kind: 'image', width: 1024, height: 1024, steps: 8 }) === 'i:1024x1024s8')
ok('视频指纹额外含帧数', runKey({ kind: 'video', width: 832, height: 480, frames: 25, steps: 4 }) === 'v:832x480f25s4')
ok('★ seed / prompt 不进指纹（它们不影响耗时，进了就永远命中不了）',
  runKey({ kind: 'image', width: 512, height: 512, steps: 4, seed: 1, prompt: 'x' })
  === runKey({ kind: 'image', width: 512, height: 512, steps: 4, seed: 2, prompt: 'y' }))
ok('缺字段不抛', runKey() === 'i:0x0s0')

/* ---------------- EWMA 记录 ---------------- */
console.log('— 实测记录（EWMA）')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-progress-'))
try {
  const key = runKey({ kind: 'image', width: 1024, height: 1024, steps: 8 })
  ok('没历史 → estimateSeconds 返回 null（不编数字）', estimateSeconds(readTimings(tmp), key) === null)
  const r1 = recordTiming(tmp, key, 20)
  ok('第一次记录 → 均值就是它本身（20s）', r1.avgSeconds === 20 && r1.samples === 1, JSON.stringify(r1))
  const r2 = recordTiming(tmp, key, 30)
  const expect = Number((20 * (1 - EWMA_ALPHA) + 30 * EWMA_ALPHA).toFixed(2))
  ok(`★ 第二次按 EWMA 混（α=${EWMA_ALPHA} → ${expect}s）`, r2.avgSeconds === expect, String(r2.avgSeconds))
  ok('样本数累加', r2.samples === 2)
  const est = estimateSeconds(readTimings(tmp), key)
  ok('estimateSeconds 命中精确指纹', est && est.matched === 'exact' && est.seconds === expect, JSON.stringify(est))
  // 同尺寸不同步数 → 退化匹配
  const k2 = runKey({ kind: 'image', width: 1024, height: 1024, steps: 12 })
  const est2 = estimateSeconds(readTimings(tmp), k2)
  ok('★ 步数不同 → 退化到"同尺寸"基准并标出来（matched=same-size）',
    est2 && est2.matched === 'same-size', JSON.stringify(est2))
  const k3 = runKey({ kind: 'video', width: 640, height: 360, frames: 17, steps: 4 })
  ok('完全不同配置 → null（宁可没有 ETA）', estimateSeconds(readTimings(tmp), k3) === null)
  ok('非法秒数不入库', recordTiming(tmp, key, 0).saved === false && recordTiming(tmp, key, NaN).saved === false)
  ok('表文件落地 + 是 UTF-8 JSON',
    readFileSync(path.join(tmp, TIMING_FILE), 'utf8').trim().startsWith('{'))
  writeFileSync(path.join(tmp, TIMING_FILE), '{坏', 'utf8')
  ok('★ 坏 JSON 读成空表、不抛', Object.keys(readTimings(tmp)).length === 0)
  ok('写盘失败只返回 saved=false（不抛）', recordTiming(path.join(tmp, 'no\u0000bad', 'x'), key, 10).saved === false)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/* ---------------- 队列解析 ---------------- */
console.log('— 队列')
const queue = {
  queue_running: [[1, 'pid-running', {}, {}, ['9']]],
  queue_pending: [[2, 'pid-a', {}, {}, ['9']], [3, 'pid-b', {}, {}, ['9']]],
}
const parsed = parseQueue(queue)
ok('★ 吃 ComfyUI 真实形状 [[num, prompt_id, …], …]',
  parsed.running[0] === 'pid-running' && parsed.pending.join(',') === 'pid-a,pid-b', JSON.stringify(parsed))
ok('空/异常载荷不抛', parseQueue(null).running.length === 0 && parseQueue({ queue_running: 'x' }).running.length === 0)

/* ---------------- 进度视图 ---------------- */
console.log('— 进度视图')
const timings = { 'i:1024x1024s8': { avgSeconds: 20, samples: 3 } }
const key = 'i:1024x1024s8'
{
  const p = buildProgress({ queue: { queue_running: [], queue_pending: [] }, ownIds: [], timings, key })
  ok('没有自家任务 → idle，且不给任何数字',
    p.state === 'idle' && p.percent === null && p.etaSec === null && p.ahead === null, JSON.stringify(p))
}
{
  const now = 1_000_000
  const q = { queue_running: [], queue_pending: [[9, 'mine', {}, {}, []]] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: now - 3000, timings, key, now })
  ok('★ 排队第 1 位 → queued、ahead=0', p.state === 'queued' && p.ahead === 0, JSON.stringify(p))
  ok('★ 排队时不给百分比（还没开始算，凭什么叫 10%）', p.percent === null, String(p.percent))
  ok('已等时长按秒给出（3s）', p.elapsedSec === 3, String(p.elapsedSec))
}
{
  const now = 1_000_000
  const q = { queue_running: [[9, 'x'], [10, 'mine']], queue_pending: [] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: now - 5000, timings, key, now })
  ok('★ 在跑 → running、ahead=0', p.state === 'running' && p.ahead === 0, JSON.stringify(p))
  ok('★ 有实测基准时给百分比（5s/20s = 25%）', p.percent === 25, String(p.percent))
  ok('ETA = 基准 - 已等（20-5=15s）', p.etaSec === 15, String(p.etaSec))
}
{
  const now = 1_000_000
  const q = { queue_running: [[9, 'mine']], queue_pending: [] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: now - 100000, timings, key, now })
  ok('★★ 百分比封顶 99%（不给"100% 了还没出图"的假象）', p.percent === 99, String(p.percent))
  ok('超时也不给负数 ETA', p.etaSec === 0, String(p.etaSec))
}
{
  const now = 1_000_000
  const q = { queue_running: [[9, 'mine']] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: now - 5000, timings: {}, key, now })
  ok('★ 没有实测基准 → percent/eta 都是 null，只有"已等 Xs"',
    p.percent === null && p.etaSec === null && p.basis === 'none', JSON.stringify(p))
  ok('人话里明说给不出 ETA（不糊弄）', p.note.includes('给不出 ETA'), p.note)
}
{
  const q = { queue_running: [], queue_pending: [[1, 'other']] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: Date.now(), timings, key })
  ok('★ 自己的任务不在队列里（已跑完/丢了）→ 不装作在跑', p.state === 'idle', JSON.stringify(p))
}
ok('前方有 2 个任务时 ahead=2 且话说清楚', (() => {
  const now = 1_000_000
  const q = { queue_running: [], queue_pending: [[1, 'a'], [2, 'b'], [3, 'mine']] }
  const p = buildProgress({ queue: q, ownIds: ['mine'], startedAt: now, timings, key, now })
  return p.ahead === 2 && p.note.includes('前方还有 2 个')
})())

/* ---------------- 接线 ---------------- */
console.log('— 接线')
const idx = read('lib/index.js')
const panel = read('assets/panel.js')
ok('★ host 注册了 GET /api/comfy-pipeline/progress',
  idx.includes("reg('/api/comfy-pipeline/progress'") && idx.includes('buildProgress('))
ok('★ 生图链在提交后登记、落盘后摘除（两条都是真调用，不是注释）',
  idx.includes('inFlight.set(promptId, {') && idx.includes('inFlight.delete(promptId)'))
// ★ 2026-11-10 审计：上面那条只查「字符串存在」，抓不到「set 写在 waitForResult 之后」
//   这种静默时序 bug（那样 inFlight 在排队/采样全程为空，进度形同虚设）。这里补一条位置断言。
ok('★ 生图链 inFlight.set 必须早于 waitForResult、delete 在 finally（进度在采样期可见）', (() => {
  const from = idx.indexOf('for (let iter = 0')
  const to = idx.indexOf('const seconds = Number(((Date.now() - t0)', from)
  const loop = from >= 0 && to > from ? idx.slice(from, to) : ''
  const setAt = loop.indexOf('inFlight.set(promptId, {')
  const waitAt = loop.indexOf('waitForResult(cfg, promptId')
  const finallyAt = loop.indexOf('} finally {')
  const delAt = loop.indexOf('inFlight.delete(promptId)', finallyAt)
  return setAt >= 0 && waitAt > setAt && finallyAt > waitAt && delAt > finallyAt
})())
ok('★ 生图/视频成功后都记实测耗时（ETA 的数据来源）',
  (idx.match(/recordTiming\(cfg\.outputDir, runKey\(/g) ?? []).length === 2,
  String((idx.match(/recordTiming\(cfg\.outputDir, runKey\(/g) ?? []).length))
ok('★ 端点读的是自家 timing 文件，不是外部 bench', idx.includes('readTimings(cfg.outputDir)'))
ok('★ 面板有进度块并轮询（1.5s），关面板就停',
  panel.includes('PROGRESS_PATH') && panel.includes('cp-progress') && panel.includes('stopPolling()'))
ok('★ 面板不把"时间比例"冒充采样百分比：percent 为 null 时走动图',
  panel.includes('is-indeterminate'))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
