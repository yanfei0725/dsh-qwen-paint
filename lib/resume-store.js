// 设计说明已外置 → docs/added-modules-design-notes.md#resume-store-note-001（原 L1-18）
import crypto from 'node:crypto'

export const RESUME_DIR_NAME = '.qwen-paint-resume'
export const RESUME_FILE = 'video-segments.json'
export const RESUME_TTL_MS = 2 * 60 * 60 * 1000 // 2 小时：过期就让整条重跑，不拿隔夜产物糊弄人
export const RESUME_MAX_JOBS = 32

/** 稳定序列化：键排序，避免参数顺序变化算出不同 key（与 idempotency.js 同口径）。 */
export function stableKey(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    }
    return v
  }
  return crypto.createHash('sha256').update(JSON.stringify(norm(value))).digest('hex').slice(0, 32)
}

/**
 * 单段 key：把"这段是否可复用"的所有参数都算进去。
 * @param {object} seg { index, frameCount, seed }
 * @param {object} job { prompt, negative?, width?, height?, fps?, startImage? }
 */
export function segmentKey(seg, job) {
  return stableKey({
    index: Number(seg?.index),
    frames: Number(seg?.frameCount),
    seed: Number(seg?.seed),
    prompt: String(job?.prompt ?? ''),
    negative: String(job?.negative ?? ''),
    width: Number(job?.width ?? 0),
    height: Number(job?.height ?? 0),
    fps: Number(job?.fps ?? 0),
    startImage: String(job?.startImage ?? ''),
  })
}

/** 账本容器：读写全走注入的 fs，测试可用内存 fs。 */
export function createResumeStore({ outputDir, fs, path, now = () => Date.now() }) {
  const file = path.join(outputDir, RESUME_DIR_NAME, RESUME_FILE)
  let data = { version: 1, jobs: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.jobs && typeof parsed.jobs === 'object') {
      data = parsed
    }
  } catch { /* 没有或坏了都从空账本开始 */ }

  const flush = () => {
    try {
      const dir = path.dirname(file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data))
      return true
    } catch { return false } // 缓存写失败不致命：最坏是这次续跑没记录，下次整条重跑
  }

  /**
   * 新开一条续跑任务。返回 jobId 与每段 key/是否可复用已完成产物。
   * @param {object} job 见 segmentKey 的 job
   * @param {Array} segments [{index, frameCount, seed}]
   */
  function begin(job, segments) {
    const list = Array.isArray(segments) ? segments : []
    const keys = list.map((s) => segmentKey(s, job))
    const id = stableKey({ keys, at: Math.floor(now() / 60000) })
    const old = data.jobs[id]
    const reusable = []
    if (old && now() - Number(old.updatedAt ?? 0) <= RESUME_TTL_MS && Array.isArray(old.done)) {
      const byKey = new Map(old.done.map((d) => [d.key, d]))
      for (let i = 0; i < keys.length; i += 1) {
        const hit = byKey.get(keys[i])
        // 产物必须真的还在磁盘上，否则不能算"已完成"
        if (hit && typeof hit.path === 'string' && fs.existsSync(hit.path)) reusable.push({ index: i, ...hit })
        else break // 段必须从头连续可复用；中间断了后面就不能跳过（保持段间顺序）
      }
    }
    data.jobs[id] = { updatedAt: now(), keys, done: old?.done ?? [] }
    // 容量上限：丢最老的（按 updatedAt）
    const ids = Object.keys(data.jobs)
    if (ids.length > RESUME_MAX_JOBS) {
      ids.sort((a, b) => Number(data.jobs[a].updatedAt ?? 0) - Number(data.jobs[b].updatedAt ?? 0))
      for (const stale of ids.slice(0, ids.length - RESUME_MAX_JOBS)) delete data.jobs[stale]
    }
    flush()
    return { id, keys, reusable, fresh: reusable.length === 0 }
  }

  /** 段完成：记账（key → 产物路径/帧数）。同 key 重复写覆盖，幂等。 */
  function complete(id, key, info) {
    const job = data.jobs[id]
    if (!job) return false
    if (!Array.isArray(job.keys) || !job.keys.includes(key)) return false // 不认没登记的段
    const done = Array.isArray(job.done) ? job.done.filter((d) => d.key !== key) : []
    done.push({ key, ...info, completedAt: now() })
    job.done = done
    job.updatedAt = now()
    return flush()
  }

  /** 诊断：某任务已完成段数（不暴露绝对路径给 HTTP，调用方按需取）。 */
  function status(id) {
    const job = data.jobs[id]
    if (!job) return { found: false, done: 0, total: 0 }
    return { found: true, done: Array.isArray(job.done) ? job.done.length : 0,
      total: Array.isArray(job.keys) ? job.keys.length : 0,
      fresh: now() - Number(job.updatedAt ?? 0) <= RESUME_TTL_MS }
  }

  return { begin, complete, status, get file() { return file } }
}
