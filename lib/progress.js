/**
 * lib/progress.js —— 生成进度与 ETA（**只用自己实测过的数字，不编**）。
 *
 * ## 为什么单独一个模块
 *   以前进度只有两条路：① ComfyUI 那边 `tqdm` 打在控制台（用户在对话框里看不见）；
 *   ② 插件 `log('info', …)` 写诊断日志（要翻日志才有）。用户要的是"生成时给进度提示"。
 *
 * ## 数据从哪来（三份，都可离线测）
 *   ① **队列位置**：`GET /queue` 的 `queue_running` / `queue_pending`（含 prompt_id）。
 *      插件提交时把自己的 prompt_id 记进 `inFlight`，据此判断"我排第几、有没有在跑"。
 *   ② **已等时长**：提交时间戳。
 *   ③ **ETA**：`<outputDir>/.comfy-pipeline-timing.json` 里**自己跑出来的**历史耗时
 *      （EWMA 平滑）。没有历史 ⇒ `etaSec: null`，UI 就只显示"已等 Xs"，**不猜**。
 *      —— 拿别人的 benchmark 当自己的承诺，本项目明确禁止。
 *
 * ## 不做什么
 *   不去猜 ComfyUI 内部的采样步数百分比：那要走它的 WebSocket `progress` 事件，
 *   本插件没连 WS。拿"时间比例"冒充"采样百分比"就是假进度条，宁可不给。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const TIMING_FILE = '.comfy-pipeline-timing.json'
/** 最多记多少组"尺寸指纹"的耗时。 */
export const TIMING_MAX = 64
/** EWMA 系数：新样本权重（0.4 = 约 2~3 次就跟上新的机器状态）。 */
export const EWMA_ALPHA = 0.4

/**
 * 耗时指纹：同 kind + 同尺寸 + 同步数才算"可比"。帧数只对视频有意义。
 * ⚠ 不把 seed / prompt 放进键 —— 它们不影响耗时，放进去会永远命中不了。
 */
export function runKey({ kind = 'image', width = 0, height = 0, frames = 0, steps = 0 } = {}) {
  const k = kind === 'video' ? 'v' : 'i'
  const f = kind === 'video' ? `f${Math.trunc(Number(frames) || 0)}` : ''
  return `${k}:${Math.trunc(Number(width) || 0)}x${Math.trunc(Number(height) || 0)}${f}s${Math.trunc(Number(steps) || 0)}`
}

/** 读历史耗时表（坏文件 → 空表，绝不抛）。 */
export function readTimings(outputDir) {
  const file = path.join(typeof outputDir === 'string' && outputDir !== '' ? outputDir : '.', TIMING_FILE)
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * 记一次实测耗时（EWMA）。写盘失败只返回 false —— 进度只是体验，不该拖累出图。
 * @returns {{ avgSeconds:number, samples:number, saved:boolean }}
 */
export function recordTiming(outputDir, key, seconds) {
  const s = Number(seconds)
  if (typeof key !== 'string' || key === '' || !Number.isFinite(s) || s <= 0) {
    return { avgSeconds: 0, samples: 0, saved: false }
  }
  const dir = typeof outputDir === 'string' && outputDir !== '' ? outputDir : '.'
  const file = path.join(dir, TIMING_FILE)
  const table = readTimings(dir)
  const prev = table[key] && Number.isFinite(table[key].avgSeconds) ? table[key] : null
  const avg = prev ? prev.avgSeconds * (1 - EWMA_ALPHA) + s * EWMA_ALPHA : s
  const samples = (prev?.samples ?? 0) + 1
  table[key] = { avgSeconds: Number(avg.toFixed(2)), samples, at: Date.now() }
  // FIFO 截断
  const keys = Object.keys(table)
  for (const k of keys.slice(0, Math.max(0, keys.length - TIMING_MAX))) delete table[k]
  let saved = false
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    saved = true
  } catch {
    try { unlinkSync(`${file}.${process.pid}.tmp`) } catch { /* 没建出来就算了 */ }
  }
  return { avgSeconds: Number(avg.toFixed(2)), samples, saved }
}

/**
 * 查 ETA 基准（秒）。命中顺序：精确指纹 → 同 kind/尺寸（忽略步数）→ null。
 * **绝不返回编出来的数字**：没历史就是 null。
 */
export function estimateSeconds(timings, key) {
  const table = timings && typeof timings === 'object' ? timings : {}
  const exact = table[key]
  if (exact && Number.isFinite(exact.avgSeconds) && exact.avgSeconds > 0) {
    return { seconds: exact.avgSeconds, samples: exact.samples ?? 1, matched: 'exact' }
  }
  // 退化匹配：同 kind + 同宽高，取样本最多的那条（步数变了耗时会变，但比"没有"强，
  // 且 UI 会标「按同尺寸历史估算」）
  const head = String(key).split('s')[0]
  const cands = Object.entries(table).filter(([k, v]) => k.startsWith(head) && Number.isFinite(v?.avgSeconds) && v.avgSeconds > 0)
  if (cands.length === 0) return null
  const best = cands.sort((a, b) => (b[1].samples ?? 0) - (a[1].samples ?? 0))[0]
  return { seconds: best[1].avgSeconds, samples: best[1].samples ?? 1, matched: 'same-size' }
}

/** 从 `/queue` 载荷里抽出 prompt_id 顺序。 */
export function parseQueue(queue) {
  const ids = (arr) => (Array.isArray(arr) ? arr.map((item) => (Array.isArray(item) ? item[1] : item?.prompt_id)).filter((x) => typeof x === 'string') : [])
  const running = ids(queue?.queue_running)
  const pending = ids(queue?.queue_pending)
  return { running, pending }
}

/**
 * 组装进度视图。
 *
 * @param {object} opt
 * @param {object} opt.queue     ComfyUI `/queue` 原始载荷
 * @param {Set|Array} opt.ownIds 本插件提交过、还没收尾的 prompt_id
 * @param {number} opt.startedAt 提交时刻（ms）。拿不到就传 undefined（进度会退化成"队列位置"）
 * @param {object} opt.timings   `readTimings()` 的结果
 * @param {string} opt.key       `runKey()` 的指纹
 * @param {number} [opt.now]     now（测试可注入）
 * @returns {{ state:string, ahead:number|null, elapsedSec:number|null, etaSec:number|null,
 *            percent:number|null, basis:string, note:string }}
 */
export function buildProgress({ queue, ownIds, startedAt, timings, key, now } = {}) {
  const ids = ownIds instanceof Set ? ownIds : new Set(Array.isArray(ownIds) ? ownIds : [])
  const { running, pending } = parseQueue(queue)
  const nowMs = Number.isFinite(now) ? now : Date.now()
  const mine = [...ids].filter((id) => running.includes(id) || pending.includes(id))

  if (ids.size === 0 || mine.length === 0) {
    // 没有自家任务在队列里：要么空闲，要么刚跑完还没收尾 —— 都按 idle 报，不编进度
    return {
      state: 'idle', ahead: null, elapsedSec: null, etaSec: null, percent: null, basis: 'none',
      note: ids.size === 0 ? '当前没有本插件提交的任务在跑' : '任务已离开队列（正在收尾）',
    }
  }

  const id = mine[0]
  const runningIdx = running.indexOf(id)
  const pendingIdx = pending.indexOf(id)
  const isRunning = runningIdx >= 0
  // ahead = **前面还有几个任务**（0 = 下一个就跑你）。running 里被并发的可能性低，按 0 算。
  const ahead = isRunning ? 0 : Math.max(0, pendingIdx)
  const elapsedSec = Number.isFinite(startedAt) ? Math.max(0, Math.round((nowMs - startedAt) / 100) / 10) : null

  const state = isRunning ? 'running' : 'queued'
  const est = estimateSeconds(timings, key)
  // ★★ ETA / 百分比**只在真的在跑的时候才给**：
  //   排队时的 elapsed 是"等别人"的时间，拿它去除自己的耗时基准，
  //   会算出"排了 3 分钟 = 15%"这种不知所云的数字。排队就只说排队。
  const etaSec = !isRunning || est === null || elapsedSec === null
    ? null
    : Math.max(0, Math.round(est.seconds - elapsedSec))
  // ★ percent 只在**有实测基准 + 在跑**时才给，且明确标成"按历史耗时估算"，
  //   不是采样步数百分比。
  const percent = !isRunning || est === null || elapsedSec === null
    ? null
    : Math.max(0, Math.min(99, Math.round((elapsedSec / est.seconds) * 100)))
  const parts = []
  if (state === 'queued') parts.push(ahead > 0 ? `排队中，前方还有 ${ahead} 个任务` : '排队中，下一个就是你')
  else parts.push('正在生成')
  if (elapsedSec !== null) parts.push(`已等 ${elapsedSec}s`)
  if (etaSec !== null) parts.push(`按历史估算还需约 ${etaSec}s（基准 ${est.seconds}s / ${est.samples} 次实测${est.matched === 'same-size' ? '，同尺寸' : ''}）`)
  else parts.push('还没有同配置的实测耗时，暂时给不出 ETA')

  return {
    state,
    ahead,
    elapsedSec,
    etaSec,
    percent,
    basis: est === null ? 'none' : est.matched,
    note: parts.join('，'),
  }
}
