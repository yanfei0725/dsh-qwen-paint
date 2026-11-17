// 设计说明已外置 → docs/added-modules-design-notes.md#ws-preview-note-001（原 L1-15）

export const WS_PREVIEW_MAX_PROMPTS = 8
/** ComfyUI 二进制帧头：前 4 字节事件类型（1 = 图片预览）。 */
export const WS_FRAME_IMAGE = 1

/**
 * 解析 ComfyUI WS 二进制帧 → { ok, mime, bytes } 或 { ok:false, reason }。
 * 纯函数，真机字节流与测试假字节流走同一条路。
 */
export const WS_FRAME_HEADER_BYTES = 4
export function parsePreviewFrame(buf) {
  if (!buf || buf.length < WS_FRAME_HEADER_BYTES + 8) {
    return { ok: false, reason: '帧太短（4 字节头 + 至少 8 字节图片）' }
  }
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const type = b.readUInt32BE(0)
  if (type !== WS_FRAME_IMAGE) return { ok: false, reason: `不是图片预览帧（type=${type}）` }
  // ★ 载荷从字节 4 开始：ComfyUI 的 ws 二进制帧只有 4 字节事件号，
  //   之后直接是 PNG/JPEG 字节（早先按 8 字节头解析会把 PNG 魔数错当成头的一部分）。
  const h = WS_FRAME_HEADER_BYTES
  let mime = 'image/png'
  if (b[h] === 0xff && b[h + 1] === 0xd8) mime = 'image/jpeg'
  else if (b.toString('ascii', h, h + 4) === 'RIFF' && b.toString('ascii', h + 8, h + 12) === 'WEBP') mime = 'image/webp'
  else if (!(b[h] === 0x89 && b.toString('ascii', h + 1, h + 4) === 'PNG')) {
    return { ok: false, reason: '预览载荷不是已知图片格式（PNG/JPEG/WebP）' }
  }
  return { ok: true, mime, bytes: b.subarray(h) }
}

/** data-url：端点直接给前端 <img src>，不落盘、不经 /file 端点。 */
export function toDataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * 内存快照库：每 prompt 一条 { progress, preview }，有界（挤最老）。
 * 注入 now 便于测试 TTL。
 */
export function createPreviewStore({ now = () => Date.now(), max = WS_PREVIEW_MAX_PROMPTS, ttlMs = 10 * 60 * 1000 } = {}) {
  const entries = new Map()
  const getOrCreate = (id) => {
    if (!entries.has(id)) {
      entries.set(id, { updatedAt: now(), progress: null, preview: null })
      while (entries.size > max) entries.delete(entries.keys().next().value)
    }
    return entries.get(id)
  }
  return {
    /** WS progress JSON：{ promptId, value, max, node? } */
    setProgress(promptId, value, maxValue, node = '') {
      if (typeof promptId !== 'string' || promptId === '') return
      const e = getOrCreate(promptId)
      const v = Number(value)
      const m = Number(maxValue)
      e.progress = Number.isFinite(v) && Number.isFinite(m) && m > 0
        ? { value: v, max: m, percent: Math.min(100, Math.max(0, Math.round((v / m) * 100))), node: String(node) }
        : null
      e.updatedAt = now()
    },
    /** WS 二进制预览帧：先 parsePreviewFrame 再传进来。 */
    setPreview(promptId, mime, bytes) {
      if (typeof promptId !== 'string' || promptId === '') return
      const e = getOrCreate(promptId)
      e.preview = { mime, bytes: Buffer.from(bytes), at: now(),
        dataUrl: toDataUrl(mime, bytes) }
      e.updatedAt = now()
    },
    /** 端点读取：只给可安全放进 JSON 的形态（data-url），不吐 Buffer。 */
    snapshot(promptId) {
      const e = entries.get(String(promptId ?? ''))
      if (!e) return { found: false, connected: true }
      if (now() - e.updatedAt > ttlMs) {
        entries.delete(String(promptId))
        return { found: false, connected: true }
      }
      return { found: true, connected: true, progress: e.progress,
        preview: e.preview ? { mime: e.preview.mime, dataUrl: e.preview.dataUrl, at: e.preview.at } : null }
    },
    /** 任务收尾：删快照（保留内存有界，也不给过期预览冒充当前任务）。 */
    clear(promptId) { entries.delete(String(promptId ?? '')) },
    size() { return entries.size },
  }
}

/**
 * 把 WS 的 JSON 消息翻译成"当前 prompt_id / 进度"更新。
 * ComfyUI 的 executing 消息：{ type:'executing', data:{ node, prompt_id } }；
 * progress 消息：{ type:'progress', data:{ prompt_id, value, max } }（部分版本 data 里没 prompt_id，
 * 用 currentId 兜底 —— 调用方维护的最近 executing id）。
 */
export function handleWsJson(store, msg, currentId) {
  if (!msg || typeof msg !== 'object') return { id: currentId, applied: false }
  const t = String(msg.type ?? '')
  const d = msg.data && typeof msg.data === 'object' ? msg.data : {}
  const id = typeof d.prompt_id === 'string' && d.prompt_id !== '' ? d.prompt_id : currentId
  if (t === 'progress' && id) {
    store.setProgress(id, d.value, d.max, d.node ?? '')
    return { id, applied: true }
  }
  if (t === 'executing' && id) return { id, applied: true }
  return { id: currentId, applied: false }
}


// 设计说明已外置 → docs/added-modules-design-notes.md#ws-preview-note-002（原 L120-128）
export function createWsPreviewBridge(deps = {}) {
  // ★ 用 in 判断而非 ??：允许显式传 null 模拟"运行时无 WebSocket"（Node 20）做降级回归。
  const Impl = Object.prototype.hasOwnProperty.call(deps, 'WebSocketImpl')
    ? deps.WebSocketImpl : globalThis.WebSocket
  if (typeof Impl !== 'function') {
    return { ok: false, reason: '运行时尚无 WebSocket（Node 20 及更早）；渐进预览不可用，进度仍走历史耗时估算', close() {} }
  }
  const url = String(deps.comfyUrl ?? 'http://127.0.0.1:8188')
    .replace(/^http:/u, 'ws:').replace(/^https:/u, 'wss:').replace(/\/+$/u, '')
    + '/ws?clientId=' + encodeURIComponent(String(deps.clientId ?? 'dsh-qwen-paint'))
  let ws = null
  let currentId = ''
  const store = deps.store
  const log = (...a) => { try { deps.log?.('info', ...a) } catch { /* 日志失败不影响 */ } }
  try {
    ws = new Impl(url)
  } catch (error) {
    return { ok: false, reason: 'WS 连接创建失败：' + (error?.message ?? error), close() {} }
  }
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (ev) => {
    try {
      if (typeof ev.data === 'string' || ev.data instanceof Blob) {
        // JSON 消息（Blob 在 Node/浏览器形态不同，浏览器侧在这里不会发生）
        if (typeof ev.data !== 'string') return
        const msg = JSON.parse(ev.data)
        const r = handleWsJson(store, msg, currentId)
        currentId = r.id ?? currentId
      } else if (ev.data) {
        const buf = Buffer.from(ev.data)
        const parsed = parsePreviewFrame(buf)
        if (parsed.ok && currentId) store.setPreview(currentId, parsed.mime, parsed.bytes)
      }
    } catch { /* 单条坏帧不该炸掉整条 WS */ }
  }
  ws.onerror = () => { /* 静默：bridge 是增强，失败不写屏 */ }
  return {
    ok: true,
    reason: '',
    /** 任务收尾时调：清快照，让下次提交不读到旧帧。 */
    close() { try { ws?.close?.() } catch { /* 已关 */ } },
  }
}
