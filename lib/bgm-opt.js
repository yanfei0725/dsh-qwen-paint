/** lib/bgm-opt.js —— BGM/音乐链路最小可跑优化（缓存 + §7 装配计划）。
 *  设计说明逐字外置：docs/bgm-opt-design-notes.md#bgm-opt-note-*。
 *  硬边界：不真生成音频、不下载权重、不谎称倍率；缓存读写失败一律降级真实链路。
 *  纯逻辑：fs/path/crypto 由宿主注入，不直接 I/O。 */
export const BGM_OPT_VERSION = 1
export const MUSIC_PLAN_CACHE_DIR = '.dshqp-music-plan-cache'

/** 稳定序列化：键顺序无关，避免同参数不同字面量顺序算成两条缓存。 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  const o = v && typeof v === 'object' ? v : {}
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'
}
function sha(hashFn, payload) {
  try { return hashFn('sha256').update(payload).digest('hex').slice(0, 24) } catch { return '' }
}

/** 音乐计划缓存键：model+prompt+neg+bpm+seed+时长+segment/loop/quality+探测节点集合。
 *  节点集合入键：换可用节点时计划可能不同（同 TTS 参考音频 mtime 入键）。 */
export function musicPlanFingerprint(crypto, p = {}) {
  return sha(crypto, stable([
    'v' + BGM_OPT_VERSION, String(p.model ?? ''), String(p.prompt ?? '').trim(),
    String(p.negPrompt ?? '').trim(), Number(p.bpm) || 0, Number(p.seed) || 0,
    Number(p.durationSec) || 0, String(p.segmentId ?? ''), p.loopAllowed === true,
    String(p.quality ?? ''), Array.isArray(p.nodes) ? p.nodes.slice().sort() : [],
  ]))
}

/** 音乐计划缓存读/写（信封 JSON + 字节自校验；失败一律 null/false）。fsp/path 注入。 */
export async function readPlanCache(fsp, path, cacheFile) {
  if (!cacheFile) return null
  try {
    const raw = await fsp.readFile(cacheFile, 'utf8')
    const c = JSON.parse(raw)
    if (c?.result && Number(c.bytes) === Buffer.byteLength(raw, 'utf8')) return c.result
  } catch { /* 无/坏缓存按未命中 */ }
  return null
}
export async function writePlanCache(fsp, path, cacheFile, key, result) {
  if (!cacheFile) return false
  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
    const env = { key, bytes: 0, result, at: new Date().toISOString() }
    // 迭代到 bytes 自洽（bytes 位数变化会改长度）：最多 4 轮必然收敛
    for (let i = 0; i < 4; i += 1) {
      const n = Buffer.byteLength(JSON.stringify(env), 'utf8')
      if (n === env.bytes) break
      env.bytes = n
    }
    await fsp.writeFile(cacheFile, JSON.stringify(env), 'utf8')
    return true
  } catch { return false }
}

/** ducking 缝合缓存键：BGM+条目(文件身份+文本+时长)+duck 参数+target 文件名。
 *  输入文件用 路径|大小|mtime 身份，改动即换 key；target 只取 basename 便于目录迁移。 */
export function stitchFingerprint(crypto, p = {}, fs, path) {
  const ident = (f) => {
    const s = String(f ?? '').trim()
    if (!s) return s
    try {
      const st = fs && fs.statSync ? fs.statSync(s) : null
      if (st && Number.isFinite(st.size)) return s + '|' + st.size + '|' + Math.round(Number(st.mtimeMs) || 0)
    } catch { /* 读不到只用路径 */ }
    return s
  }
  const items = (Array.isArray(p.items) ? p.items : []).map((it) => [ident(it?.file), String(it?.text ?? ''), Number(it?.duration_ms) || 0])
  const d = p.duck ?? {}
  return sha(crypto, stable([
    'v' + BGM_OPT_VERSION, ident(p.bgm), items, String(p.startMs ?? ''), String(p.gapMs ?? ''),
    Number(d.threshold) || 0, Number(d.ratio) || 0, Number(d.attackMs) || 0, Number(d.releaseMs) || 0,
    path && typeof path.basename === 'function' ? path.basename(String(p.target ?? '')) : String(p.target ?? ''),
  ]))
}

/** hyperframes §7 中「不依赖模型即可落地」的装配计划：缓存键/ducking/断点续推。
 *  需模型/权重的项明确 blocked，不假装已装上或已实测倍率。 */
export function buildBgmAssemblyPlan(p = {}) {
  const segments = Array.isArray(p.segments) ? p.segments : []
  const done = new Set((Array.isArray(p.completedSegmentIds) ? p.completedSegmentIds : []).map(String))
  const ids = segments.map((s) => String(s?.segmentId ?? s?.id ?? ''))
  return {
    version: BGM_OPT_VERSION,
    cacheKeyFields: ['model', 'prompt', 'negPrompt', 'bpm', 'seed', 'durationSec', 'segmentId', 'loopAllowed', 'quality', 'nodes'],
    ducking: { method: 'sidechaincompress', available: true,
      note: 'av-stitch.js 已有：旁白区间压低 BGM，纯 ffmpeg/CPU、显存 0' },
    resume: { reusable: ids.filter((id) => done.has(id)), pending: ids.filter((id) => !done.has(id)),
      strategy: 'complete-segment-only', note: '只复用完整已完成段，不从中途续（同 resume-store.js）' },
    embeddingCache: { planned: true, available: false, note: '同 prompt 只编码一次：需音乐模型接入后实现，当前 blocked' },
    blocked: [
      { id: 'candle_fp8_nf4', reason: '需确认音乐模型名/权重/许可证/采样率（§0.6 全线阻塞）' },
      { id: 'parallel_precompute', reason: '需 BGM 推理 worker 真实存在；当前只有 generate_music 参数计划' },
      { id: 'rust_worker', reason: 'hyperframes 无头 Chrome/Rust 系统非本插件；仅 §13 四项可映射，BGM 不在其中' },
    ],
    unverified: true,
    note: '只描述插件层可落地口径；不声称任何音乐生成倍率，模型相关项一律 blocked。',
  }
}

export const BGM_OPT_EXPORTS = Object.freeze({
  BGM_OPT_VERSION, MUSIC_PLAN_CACHE_DIR, musicPlanFingerprint, readPlanCache, writePlanCache,
  stitchFingerprint, buildBgmAssemblyPlan,
})
