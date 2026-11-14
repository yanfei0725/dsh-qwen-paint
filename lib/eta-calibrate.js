/**
 * lib/eta-calibrate.js —— E27 的**本机实测**秒数，替代"编不出来就写 null"。
 *
 * ## 之前为什么是 null
 * 用参数量 × 步数去推秒数，误差能到 3-5 倍；拿社区别人机器上的数字更没意义
 * （不同显卡、不同 ComfyUI 版本、不同权重量化）。之前如实写 `est_seconds: null`
 * 是对的，但也就永远给不出任何有用信息。
 *
 * ## 现在的做法：只信这台机器真跑过的
 * ComfyUI 的 `/history` 里每条记录都带 `execution_start` / `execution_success`
 * 的**毫秒时间戳**，两者相减就是那次任务真实的墙钟耗时 —— 不是我估的，是它测的。
 * 再按「任务类型 + 像素量档 + 步数档」分组取中位数，就是"这台机器跑这类任务要多久"。
 *
 * ## 三条硬约束
 *   ① **没样本就返回 null**，绝不拿别的档位凑数（`eta_basis: 'unverified'` 照旧）；
 *   ② 样本少于 `MIN_SAMPLES` 时给值但标 `confidence: 'low'` 并带出样本数；
 *   ③ 首轮执行常含模型加载（可能几十秒），与后续热跑差一个量级 ——
 *      所以同一组里样本 ≥ 3 时**去掉最大值**再取中位数，避免首跑把中位数抬飞。
 */

/** 一个档位至少要有这么多样本才敢说自己"有依据"。 */
export const MIN_SAMPLES = 2

/** 少于 100ms 或超过 2 小时的记录一律丢弃：前者是缓存命中/空跑，后者是挂着没人管。 */
export const MIN_RUN_MS = 100
export const MAX_RUN_MS = 2 * 60 * 60 * 1000

/** 像素量分档边界（百万像素）。 */
export const SIZE_BUCKETS = [
  { id: 'tiny', maxMp: 0.6 },
  { id: 'small', maxMp: 1.2 },
  { id: 'medium', maxMp: 2.5 },
  { id: 'large', maxMp: Infinity },
]

/** 步数分档：蒸馏链 4/8 步、原生 20-30 步、慢档 40+。 */
export const STEP_BUCKETS = [
  { id: 's8', maxSteps: 8 },
  { id: 's20', maxSteps: 20 },
  { id: 's30', maxSteps: 30 },
  { id: 's40', maxSteps: Infinity },
]

export function sizeBucketOf(width, height) {
  const w = Number(width)
  const h = Number(height)
  const mp = (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)
    ? (w * h) / 1e6
    // 尺寸未知时**不给档位** —— 硬塞进 medium 会让所有未知任务共用一个假基准。
    : NaN
  if (!Number.isFinite(mp)) return null
  for (const b of SIZE_BUCKETS) if (mp <= b.maxMp) return b.id
  return SIZE_BUCKETS[SIZE_BUCKETS.length - 1].id
}

export function stepBucketOf(steps) {
  const n = Number(steps)
  if (!Number.isFinite(n) || n <= 0) return null
  for (const b of STEP_BUCKETS) if (n <= b.maxSteps) return b.id
  return STEP_BUCKETS[STEP_BUCKETS.length - 1].id
}

/** 归档键。缺任何一维都返回空串 —— 不完整的样本不该进统计。 */
export function sampleKey({ kind, size, steps }) {
  if (kind === '' || kind === undefined || kind === null) return ''
  if (size === null || size === undefined || size === '') return ''
  if (steps === null || steps === undefined || steps === '') return ''
  return `${kind}:${size}:${steps}`
}

const SAVE_CLASSES = {
  image: ['SaveImage', 'PreviewImage'],
  video: ['VHS_VideoCombine', 'SaveVideo', 'SaveAnimatedWEBP', 'SaveAnimatedPNG'],
  tts: ['SaveAudioMP3', 'SaveAudio'],
}

/**
 * 从一张图推断任务类型。**只认保存节点** —— 用 KSampler 之类的中间节点判断，
 * 混合模式里的"生图段"会被误判成纯生图，归档就串了。
 */
export function kindOfGraph(graph) {
  const classes = new Set()
  for (const id of Object.keys(graph ?? {})) {
    const c = graph[id]?.class_type
    if (typeof c === 'string') classes.add(c)
  }
  for (const kind of ['video', 'tts', 'image']) {
    if (SAVE_CLASSES[kind].some((c) => classes.has(c))) return kind
  }
  return ''
}

/** 从图里找尺寸与步数。找不到就返回 null（该样本不进统计）。 */
export function shapeOfGraph(graph) {
  let width = null
  let height = null
  let steps = null
  let frames = null
  for (const id of Object.keys(graph ?? {})) {
    const node = graph[id]
    const cls = node?.class_type
    const inputs = node?.inputs
    if (inputs === null || typeof inputs !== 'object') continue
    if (steps === null && typeof inputs.steps === 'number') steps = inputs.steps
    if (width === null && typeof inputs.width === 'number' && typeof inputs.height === 'number') {
      width = inputs.width
      height = inputs.height
    }
    if (frames === null && cls === 'Wan22ImageToVideoLatent' && typeof inputs.length === 'number') {
      frames = inputs.length
    }
  }
  return { width, height, steps, frames }
}

/** 从 messages 里取两个时间戳。缺一个就算不出耗时，返回 null。 */
export function durationOfMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = null
  let end = null
  for (const m of list) {
    if (!Array.isArray(m) || m.length < 2) continue
    const type = String(m[0] ?? '')
    const ts = Number(m[1]?.timestamp)
    if (!Number.isFinite(ts)) continue
    if (type === 'execution_start') start = ts
    if (type === 'execution_success') end = ts
  }
  if (start === null || end === null) return null
  const ms = end - start
  if (!Number.isFinite(ms) || ms < MIN_RUN_MS || ms > MAX_RUN_MS) return null
  return ms
}

/**
 * 把 `/history` 的整份返回折成样本。
 * @param {object} history `{ "<promptId>": { prompt:[n,id,graph,...], status:{messages} } }`
 */
export function extractSamples(history) {
  const samples = []
  const skipped = { noGraph: 0, noDuration: 0, noKind: 0, noShape: 0 }
  for (const id of Object.keys(history ?? {})) {
    const rec = history[id]
    const graph = Array.isArray(rec?.prompt) ? rec.prompt[2] : null
    if (graph === null || typeof graph !== 'object') { skipped.noGraph += 1; continue }
    const ms = durationOfMessages(rec?.status?.messages)
    if (ms === null) { skipped.noDuration += 1; continue }
    const kind = kindOfGraph(graph)
    if (kind === '') { skipped.noKind += 1; continue }
    const shape = shapeOfGraph(graph)
    const size = sizeBucketOf(shape.width, shape.height)
    const step = stepBucketOf(shape.steps)
    const key = sampleKey({ kind, size, steps: step })
    if (key === '') { skipped.noShape += 1; continue }
    samples.push({
      promptId: id, kind, size, step, key, ms,
      width: shape.width, height: shape.height, steps: shape.steps, frames: shape.frames,
    })
  }
  return { samples, skipped }
}

/** 中位数（会就地排序副本，不改入参）。 */
export function median(list) {
  const arr = (Array.isArray(list) ? list : []).filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (arr.length === 0) return null
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}

/**
 * 分组统计。
 * ★ 样本 ≥ 3 时去掉最大值：同一档位的第一跑通常含模型加载（几十秒），
 *   混进来会把中位数抬高一个量级 —— 那不是"这类任务要多久"，那是"第一次要多久"。
 */
export function buildCalibration(samples) {
  const groups = new Map()
  for (const s of Array.isArray(samples) ? samples : []) {
    if (typeof s?.key !== 'string' || s.key === '') continue
    const list = groups.get(s.key)
    if (list === undefined) groups.set(s.key, [s.ms])
    else list.push(s.ms)
  }
  const byKey = {}
  for (const [key, list] of groups) {
    const sorted = list.slice().sort((a, b) => a - b)
    const used = sorted.length >= 3 ? sorted.slice(0, -1) : sorted
    byKey[key] = {
      samples: list.length,
      used: used.length,
      median_ms: Math.round(median(used) ?? 0),
      min_ms: sorted[0],
      max_ms: sorted[sorted.length - 1],
      dropped_max: sorted.length - 1 === used.length,
    }
  }
  return { byKey, total: Array.isArray(samples) ? samples.length : 0 }
}

/**
 * 给某次任务查基准。
 * @returns {{ detected:boolean, est_seconds:number|null, eta_basis:string,
 *             samples:number, confidence:string, note:string }}
 */
export function pickEta(calibration, { kind, width, height, steps } = {}) {
  const size = sizeBucketOf(width, height)
  const step = stepBucketOf(steps)
  const key = sampleKey({ kind, size, steps: step })
  const none = {
    detected: false, est_seconds: null, eta_basis: 'unverified', samples: 0,
    confidence: 'none', key,
    note: '这台机器还没跑过同类任务，给不出秒数（不拿别的档位或别人的机器凑数）。',
  }
  if (key === '') return none
  const hit = calibration?.byKey?.[key]
  if (hit === undefined) return none
  const samples = Number(hit.samples) || 0
  if (samples < MIN_SAMPLES) {
    return {
      detected: true,
      // 只有 1 个样本时给的是"那次"的耗时，不是中位数 —— 说清楚，照样能用作数量级参考。
      est_seconds: Math.round(hit.median_ms / 100) / 10,
      eta_basis: 'measured-local-single',
      samples,
      confidence: 'low',
      key,
      note: `只有 1 条本机实测记录（${(hit.median_ms / 1000).toFixed(1)}s），仅供参考，不算基准。`,
    }
  }
  return {
    detected: true,
    est_seconds: Math.round(hit.median_ms / 100) / 10,
    eta_basis: 'measured-local',
    samples,
    confidence: samples >= 5 ? 'high' : 'medium',
    key,
    note: `本机实测中位数 ${(hit.median_ms / 1000).toFixed(1)}s（${samples} 次同类任务`
      + `${hit.dropped_max === true ? '，已剔除含模型加载的首次' : ''}）。`,
  }
}

/**
 * 拉 `/history` 并算好。`depth` 是 ComfyUI 的 history 保留条数（默认它自己定），
 * 这里只取最近 `limit` 条，避免一次拉几千条。
 */
export async function fetchCalibration({
  cfg, fetchFn, signal, timeoutMs = 6000, limit = 200,
} = {}) {
  const base = String(cfg?.comfyUrl ?? '').replace(/\/+$/, '')
  if (base === '') {
    return { ok: false, reason: '没配置 comfyUrl', calibration: { byKey: {}, total: 0 }, samples: [] }
  }
  const doFetch = fetchFn ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, reason: '当前运行环境没有 fetch', calibration: { byKey: {}, total: 0 }, samples: [] }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onAbort = () => ac.abort()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) { clearTimeout(timer); return { ok: false, reason: '已取消', calibration: { byKey: {}, total: 0 }, samples: [] } }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await doFetch(`${base}/history?max_items=${Math.max(1, Math.trunc(limit))}`, { signal: ac.signal })
    if (res.ok !== true) {
      return { ok: false, reason: `ComfyUI /history 返回 ${res.status}`, calibration: { byKey: {}, total: 0 }, samples: [] }
    }
    const body = await res.json()
    const { samples, skipped } = extractSamples(body)
    return {
      ok: true,
      reason: '',
      calibration: buildCalibration(samples),
      samples,
      skipped,
      note: samples.length === 0
        ? '这台机器的 ComfyUI 还没有可用的执行记录（或者记录里没有时间戳），所以给不出实测秒数。'
        : '',
    }
  } catch (error) {
    return {
      ok: false,
      reason: ac.signal.aborted ? `拉 /history 超时（${timeoutMs}ms）` : `拉 /history 失败：${error?.message ?? error}`,
      calibration: { byKey: {}, total: 0 },
      samples: [],
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }
}
