/**
 * lib/queue-gate.js —— C14 队列感知（提交前预警）。
 *
 * 解决的问题：多个插件 / 多个会话同时往同一个 ComfyUI 提交任务时，谁都不知道
 * 前面还排着几张，结果都以为「怎么这么慢」。更糟的是显存已经被别人占满，
 * 自己这张进去直接 OOM，报出来的错还看不出跟别人有关。
 *
 * ★★ 定位是**预警**，不是**拦截**：
 *   本模块只返回状态与建议，绝不因为"队列非空"就拒绝提交 ——
 *   用户可能就是想让任务排队等着。要不要等，由调用方（或人）决定。
 *
 * ★ 为什么放在 `ensureComfyUp` 的在线分支里用 fire-and-forget 调用：
 *   那是每次出图必经、且已经确认服务可用的唯一位置。放在别处要么重复探活，
 *   要么在服务还没起来时白等超时。**结果不参与出图决策，只写日志**，
 *   所以探不到 / 超时都不影响出图。
 */

/** 显存占用超过这个比例就算"紧张"，值得提醒。 */
export const VRAM_TIGHT_RATIO = 0.85

/** 队列里排了这么多张（不含自己在跑的）就值得提醒一句。 */
export const QUEUE_BUSY_THRESHOLD = 1

const gb = (bytes) => (Number.isFinite(bytes) ? Number((bytes / 1024 ** 3).toFixed(2)) : null)

/**
 * 读一次队列与显存水位。两个请求并行，各自失败互不影响。
 *
 * @param {object} o
 * @param {object} o.cfg 需要 `comfyUrl`
 * @param {Function} o.fetchFn 注入的请求函数
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs] 单请求超时，默认 2500ms（这是预警，不该拖慢出图）
 * @returns {Promise<{ok:boolean, level:'idle'|'busy'|'tight'|'unknown',
 *   running:number, pending:number, vramFreeGB:number|null, vramTotalGB:number|null,
 *   vramUsedRatio:number|null, hint:string, reason:string}>}
 */
export async function probeQueueGate({ cfg, fetchFn, signal, timeoutMs = 2500 } = {}) {
  const base = {
    ok: false, level: 'unknown', running: 0, pending: 0,
    vramFreeGB: null, vramTotalGB: null, vramUsedRatio: null,
    hint: '', reason: '',
  }
  if (!cfg?.comfyUrl || typeof fetchFn !== 'function') {
    return { ...base, reason: '缺少 ComfyUI 地址或请求函数' }
  }

  const getJson = async (p) => {
    try {
      const res = await fetchFn(`${cfg.comfyUrl}${p}`, { method: 'GET', signal, timeoutMs })
      if (!res?.ok) return null
      return await res.json()
    } catch { return null }
  }

  const [queue, stats] = await Promise.all([getJson('/queue'), getJson('/system_stats')])
  if (queue === null && stats === null) return { ...base, reason: '队列与显存都没读到' }

  const out = { ...base, ok: true }
  if (queue && typeof queue === 'object') {
    out.running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0
    out.pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0
  }
  const dev = Array.isArray(stats?.devices) ? stats.devices[0] : null
  if (dev) {
    out.vramFreeGB = gb(dev.vram_free)
    out.vramTotalGB = gb(dev.vram_total)
    if (Number.isFinite(dev.vram_total) && dev.vram_total > 0 && Number.isFinite(dev.vram_free)) {
      out.vramUsedRatio = Number((1 - dev.vram_free / dev.vram_total).toFixed(3))
    }
  }

  // ★ 判定顺序有讲究：显存紧张比队列长更致命（排队只是慢，OOM 是直接失败）。
  if (out.vramUsedRatio !== null && out.vramUsedRatio >= VRAM_TIGHT_RATIO) {
    out.level = 'tight'
    out.hint = `显存已占用 ${Math.round(out.vramUsedRatio * 100)}%（剩 ${out.vramFreeGB ?? '?'} GB / 共 ${out.vramTotalGB ?? '?'} GB）。`
      + '这时提交很容易 OOM；如果前面有别人/别的插件在跑，建议等它跑完再提交。'
  } else if (out.pending + out.running > QUEUE_BUSY_THRESHOLD) {
    out.level = 'busy'
    out.hint = `ComfyUI 队列里已有 ${out.pending + out.running} 个任务（运行中 ${out.running}、排队 ${out.pending}）。`
      + '提交后会排在它们后面；不想等就先等一下再提交。'
  } else {
    out.level = 'idle'
  }
  return out
}

/**
 * 在日志里留一句预警。**不抛错、不阻断**，所有异常都吞掉。
 * 只在 busy / tight 时说话 —— 一切正常时闭嘴，不刷屏。
 */
export async function warnQueueGate(cfg, log, signal, opts = {}) {
  try {
    const r = await probeQueueGate({ cfg, fetchFn: opts.fetchFn, signal, timeoutMs: opts.timeoutMs })
    if (!r.ok) return r
    if (r.level === 'tight' || r.level === 'busy') {
      try { log?.('warn', `提交前提示：${r.hint}`) } catch { /* 忽略 */ }
    }
    return r
  } catch {
    return { ok: false, level: 'unknown', running: 0, pending: 0, vramFreeGB: null,
      vramTotalGB: null, vramUsedRatio: null, hint: '', reason: '探测异常' }
  }
}
