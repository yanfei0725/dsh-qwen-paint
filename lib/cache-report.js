/**
 * lib/cache-report.js —— B9「缓存命中摘要」。
 *
 * ★ 先说要害：清单原文写的是「读取缓存节点统计，返回『本轮缓存命中 X 次、
 *   跳过 Y 个 block 计算』」。我抓了真机 `/object_info` 核对，
 *   `QwenImage21Cache` 的 output 只有 `['MODEL']` —— **它不吐任何统计数字**。
 *   所以「跳过 Y 个 block 计算」在这个节点上是拿不到的，硬编一个只会是假数据。
 *
 * 但真机 `/history/<id>` 里有实测确认可用的东西：
 *   · `status.messages` 里的 `execution_cached.nodes` —— ComfyUI 自己记的
 *     **节点级缓存命中**（这次直接复用上次结果、没重算的节点 id）
 *   · `execution_start` / `execution_success` 的 `timestamp` —— 真实耗时
 *   · `prompt[2]` 里的 `QwenImage21Cache.inputs.device/dtype` —— 本轮到底用的哪档
 *
 * 所以本模块给的是：**节点级缓存命中数 + 真实耗时 + 本轮缓存档位**，
 * 并明确标注 `scope: 'comfy-node-cache'`，与 block 级统计区分开。
 * 这仍然是「从徽标变成数字」，只是数字的来源是诚实的那个。
 */

/** 报告口径标识。外部集成看到这个值就知道数字不是 block 级的。 */
export const CACHE_SCOPE = 'comfy-node-cache'

const num = (v) => (Number.isFinite(v) ? Number(v) : null)

/**
 * 从一条 `/history/<id>` 记录里榨出缓存与耗时信息。纯函数，不做 IO。
 *
 * @param {object} rec `/history/<id>` 返回的那条记录（`{ prompt, status, outputs, meta }`）
 * @returns {object} 见文件头注释
 */
export function summarizeCacheRun(rec) {
  const out = {
    ok: false,
    scope: CACHE_SCOPE,
    cached_nodes: [],
    cached_count: 0,
    total_nodes: 0,
    executed_count: 0,
    seconds: null,
    cache: { present: false, device: '', dtype: '', node: '' },
    note: '',
  }
  if (!rec || typeof rec !== 'object') { out.note = '没有可读的执行记录'; return out }

  // prompt 是 [number, prompt_id, nodes, extra_data, output_node_ids]
  const nodes = Array.isArray(rec.prompt) && rec.prompt[2] && typeof rec.prompt[2] === 'object'
    ? rec.prompt[2]
    : {}
  const ids = Object.keys(nodes)
  out.total_nodes = ids.length

  const status = rec.status && typeof rec.status === 'object' ? rec.status : {}
  const msgs = Array.isArray(status.messages) ? status.messages : []
  let startedAt = null
  let endedAt = null
  for (const m of msgs) {
    if (!Array.isArray(m) || m.length < 2) continue
    const [kind, payload] = m
    if (kind === 'execution_cached' && payload && Array.isArray(payload.nodes)) {
      out.cached_nodes = payload.nodes.map((x) => String(x))
    } else if (kind === 'execution_start') {
      startedAt = num(payload?.timestamp)
    } else if (kind === 'execution_success') {
      endedAt = num(payload?.timestamp)
    }
  }
  out.cached_count = out.cached_nodes.length
  // 命中缓存的节点不在「重算」之列，剩下的才是真跑了的。
  // 用 max(0, …) 兜住「cached 里出现图外 id」这种脏数据，不产出负数。
  out.executed_count = Math.max(0, out.total_nodes - out.cached_count)
  if (startedAt !== null && endedAt !== null && endedAt >= startedAt) {
    out.seconds = Number(((endedAt - startedAt) / 1000).toFixed(3))
  }

  // 本轮实际用的缓存档位 —— 从图里读，而不是从 config 读：
  // CPU 加速档会在 workflowOverrides 里把 device 改成 cpu，读 config 会答错。
  for (const id of ids) {
    const n = nodes[id]
    if (n && n.class_type === 'QwenImage21Cache') {
      out.cache.present = true
      out.cache.node = String(id)
      out.cache.device = String(n.inputs?.device ?? '')
      out.cache.dtype = String(n.inputs?.dtype ?? '')
      break
    }
  }

  out.ok = out.total_nodes > 0
  if (!out.ok) { out.note = '执行记录里没有节点信息'; return out }

  const bits = [`${out.total_nodes} 个节点`]
  if (out.cached_count > 0) bits.push(`其中 ${out.cached_count} 个命中缓存跳过重算`)
  else bits.push('本次没有节点命中缓存（首次跑这条链时正常）')
  if (out.seconds !== null) bits.push(`耗时 ${out.seconds}s`)
  if (out.cache.present) bits.push(`前缀缓存档位 ${out.cache.device || '?'}+${out.cache.dtype || '?'}`)
  out.note = bits.join('，')
    + '。口径是 **ComfyUI 节点级缓存**（哪些节点复用了上次结果），'
    + '不含 block 级统计 —— QwenImage21Cache 这个节点本身不输出命中次数。'
  return out
}

/**
 * 取一次执行的缓存摘要。
 *
 * 提交后拿到的 `prompt_id` 就是 key；`/history/<prompt_id>` 在任务完成后才有记录，
 * 所以这里**不轮询**：调用方在收尾阶段调一次，拿不到就如实说拿不到
 * （多等几百毫秒去追一个锦上添花的数字不值得）。
 *
 * @param {object} o
 * @param {object} o.cfg 需要 `comfyUrl`
 * @param {Function} o.fetchFn 注入的带超时 / 回环校验的请求函数
 * @param {string} o.promptId
 * @param {AbortSignal} [o.signal]
 */
export async function fetchCacheReport({ cfg, fetchFn, promptId, signal }) {
  const pid = String(promptId ?? '').trim()
  const base = {
    ok: false, scope: CACHE_SCOPE, cached_nodes: [], cached_count: 0,
    total_nodes: 0, executed_count: 0, seconds: null,
    cache: { present: false, device: '', dtype: '', node: '' }, note: '',
  }
  if (pid === '') return { ...base, note: '没有 prompt_id，无法回查缓存摘要' }
  if (!cfg || typeof cfg.comfyUrl !== 'string' || typeof fetchFn !== 'function') {
    return { ...base, note: '缓存摘要需要 ComfyUI 地址与请求函数' }
  }
  try {
    const res = await fetchFn(`${cfg.comfyUrl}/history/${encodeURIComponent(pid)}`, {
      method: 'GET', signal, timeoutMs: 5000,
    })
    if (!res?.ok) return { ...base, note: `回查执行记录失败：HTTP ${res?.status}` }
    const data = await res.json()
    const rec = data && typeof data === 'object' ? data[pid] : null
    if (!rec) return { ...base, note: 'ComfyUI 还没写出这条执行记录（任务刚结束时会短暂出现）' }
    return summarizeCacheRun(rec)
  } catch (error) {
    return { ...base, note: `回查执行记录失败：${error?.message ?? error}` }
  }
}
