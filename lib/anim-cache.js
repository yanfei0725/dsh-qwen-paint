/** 动画缓存最小版（纯 JS，不重写渲染管线）：
 *  · 静态预渲染缓存：按帧指纹缓存已渲染产物（渲染结果 = SVG/PNG 路径 + 字节），避免同帧重渲。
 *  · 瓦片缓存：把一个分镜拆成 N 个静态「瓦片」（按行/块），只重渲变更瓦片——本实现是
 *    「分镜级」的轻量版：key 含分镜指纹，未变分镜整块复用（不做像素级脏矩形，诚实标注）。
 *  · 可插拔后端接口：预留 rasterize(svg, ctx) 槽位，默认 no-op（返回 SVG 原样），
 *    由 render-backends.js 的 resvg/Edge 结果注入真正实现；这里不伪造任何引擎。
 *  全程纯逻辑 + 依赖注入；缓存失败不致命（顶多重渲）。
 */
export const TILE_CACHE_FILE = '.qwen-paint-tile-cache.json'
export const TILE_CACHE_MAX = 128

/** 静态瓦片：把 N 个分镜各视为一个瓦片，返回 [{key, changed}]。
 *  prevKeys 为上一轮同序号分镜的指纹数组；新增/指纹变化 = changed。 */
export function diffTiles(curKeys, prevKeys = []) {
  const cur = Array.isArray(curKeys) ? curKeys.map(String) : []
  const prev = Array.isArray(prevKeys) ? prevKeys.map(String) : []
  return cur.map((key, i) => ({ key, index: i, changed: prev[i] !== key }))
}

/** 内存 + 可选 sidecar 持久化的瓦片产物缓存。
 *  fs/path 注入为真实模块时落盘；否则纯内存。 */
export function createTileCache({ outputDir, fs, path: pathMod, max = TILE_CACHE_MAX } = {}) {
  const cap = Math.max(1, Number(max) || TILE_CACHE_MAX)
  const file = outputDir && pathMod ? pathMod.join(String(outputDir), TILE_CACHE_FILE) : ''
  let map = Object.create(null)
  if (file && fs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
    } catch { /* 无账本/损坏都从空开始 */ }
  }
  const flush = () => {
    if (!file || !fs) return false
    try { fs.mkdirSync(pathMod.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(map)); return true } catch { return false }
  }
  const evict = () => {
    const keys = Object.keys(map)
    for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete map[k]
  }
  return {
    file,
    get(key) {
      if (typeof key !== 'string' || !key) return null
      const e = map[key]
      return e && typeof e === 'object' ? e : null
    },
    set(key, value) {
      if (typeof key !== 'string' || !key || !value || typeof value !== 'object') return false
      map[key] = { ...value, at: Date.now() }
      evict()
      flush() // 落盘失败不致命（内存仍存，顶多重启后重渲）
      return true
    },
    size() { return Object.keys(map).length },
    clear() { map = Object.create(null); return flush() },
  }
}

/** 可插拔渲染后端接口：把「光栅化实现」抽象成一个函数槽。
 *  defaultBackend 返回 {backend:'passthrough'}，不渲染、不伪造；调用方注入 resvg/Edge 实现。 */
export function createBackendSlot(impl = null) {
  let current = typeof impl === 'function' ? impl : null
  return {
    get backend() { return current ? 'custom' : 'passthrough' },
    set(fn) { current = typeof fn === 'function' ? fn : null },
    async rasterize(svg, ctx = {}) {
      if (!current) return { ok: true, backend: 'passthrough', svg, rasterized: false }
      try {
        const out = await current(svg, ctx)
        return out && typeof out === 'object' ? { ...out, rasterized: true } : { ok: false, reason: '后端返回格式错误', rasterized: false }
      } catch { return { ok: false, reason: '渲染后端执行失败（详见插件日志）', rasterized: false } }
    },
  }
}

/** 用缓存 + 后端跑一批瓦片：未变的直接命中，变更的走 rasterize 并回填。 */
export async function renderTiles({ tiles, cache, backend, ctx = {} }) {
  const out = []
  for (const t of (Array.isArray(tiles) ? tiles : [])) {
    const hit = t.changed === false ? cache.get(t.key) : null
    if (hit) { out.push({ ...hit, cache: 'hit', key: t.key }); continue }
    const r = await backend.rasterize(ctx.svgFor ? ctx.svgFor(t.index) : ctx.svg, ctx)
    const rec = { ok: r.ok !== false, backend: r.backend || 'passthrough', svg: r.svg, path: r.path || '', key: t.key }
    if (rec.ok && t.key) cache.set(t.key, rec)
    out.push({ ...rec, cache: 'miss' })
  }
  return out
}

export const ANIM_CACHE_EXPORTS = Object.freeze({
  TILE_CACHE_FILE, TILE_CACHE_MAX, diffTiles, createTileCache, createBackendSlot, renderTiles,
})
