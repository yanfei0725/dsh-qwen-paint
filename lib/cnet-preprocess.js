// 设计说明已外置 → docs/added-modules-design-notes.md#cnet-preprocess-note-001（原 L1-19）

/** 每种预处理类型的候选节点（按优先级）。名字是社区包的公开节点名，探测不到就算缺件。 */
export const PREPROCESS_TYPES = {
  canny: {
    label: '线稿（Canny）',
    candidates: ['Canny'],
    /** 可调参数：白名单键 + 数值范围。没给的键用默认值。 */
    params: {
      low_threshold: { min: 0, max: 999, default: 100 },
      high_threshold: { min: 0, max: 999, default: 200 },
    },
    hint: 'ComfyUI 核心节点，默认可用。',
  },
  depth: {
    label: '深度（Depth）',
    candidates: ['DepthAnythingV2', 'MiDaS-DepthMapPreprocessor', 'Zoe-DepthMapPreprocessor'],
    params: {},
    hint: '核心 0.39 无此节点；装 comfyui_controlnet_aux 后按本机 /object_info 命中。',
  },
  pose: {
    label: '姿态（OpenPose）',
    candidates: ['OpenPosePreprocessor'],
    params: {},
    hint: '需 comfyui_controlnet_aux；探测不到就如实报缺。',
  },
}

/** 从本机节点集合里挑第一个可用的预处理节点。纯函数。 */
export function pickPreprocessNode(type, nodeSet) {
  const spec = PREPROCESS_TYPES[type]
  if (!spec) return { ok: false, reason: `不支持的预处理类型：${type}（可选：${Object.keys(PREPROCESS_TYPES).join(' / ')}）` }
  const has = (n) => nodeSet instanceof Set ? nodeSet.has(n) : Boolean(nodeSet?.[n])
  const found = spec.candidates.find((n) => has(n))
  if (!found) {
    return {
      ok: false,
      reason: `本机没有 ${spec.label} 预处理节点（探测过：${spec.candidates.join('、')}）。${spec.hint}`,
    }
  }
  return { ok: true, node: found }
}

/** 白名单 + 夹取用户参数；非法值退默认。纯函数。 */
export function clampPreprocessParams(type, raw) {
  const spec = PREPROCESS_TYPES[type]
  if (!spec) return {}
  const out = {}
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const [key, rule] of Object.entries(spec.params)) {
    const v = Number(src[key])
    out[key] = Number.isFinite(v) ? Math.min(rule.max, Math.max(rule.min, Math.trunc(v))) : rule.default
  }
  return out
}

/**
 * 构建预处理小工作流：LoadImage → 预处理节点 → SaveImage。
 * 与主链同构的最小三节点，产物走 SaveImage 落 ComfyUI output，随后由
 * 处理器下载复制进插件输出目录（缓存），不再依赖 ComfyUI 的 output 残留。
 */
export function buildPreprocessWorkflow({ image, node, params, prefix }) {
  const name = String(image ?? '').trim()
  if (name === '') return { ok: false, reason: 'image（上传后的 ComfyUI 文件名）必填' }
  if (!node || !PREPROCESS_OK_NODE.test(node)) return { ok: false, reason: 'node 名不合法' }
  const p = params && typeof params === 'object' ? params : {}
  const wf = {
    1: { class_type: 'LoadImage', inputs: { image: name } },
    2: { class_type: node, inputs: { image: ['1', 0], ...p } },
    3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: String(prefix ?? 'dshqp-cnet-pre') } },
  }
  return { ok: true, workflow: wf }
}

/** 节点名只允许单词字符与有限符号 —— 防止把任意字符串塞进 class_type。 */
const PREPROCESS_OK_NODE = /^[\w][\w.-]{0,80}$/u

/**
 * 缓存键：sha256(原图字节) + 类型 + 规范化参数。
 * 参数参与键 ⇒ 阈值改了就是新条目，绝不拿旧阈值的结果糊弄人。
 */
export function cacheKeyOf(fileBytes, type, params, crypto) {
  const c = crypto ?? (globalThis.__preprocessCryptoForTest ?? null)
  const createHash = c?.createHash
  if (typeof createHash !== 'function') throw new Error('cacheKeyOf 需要 node:crypto（测试可注入）')
  const normalized = JSON.stringify(sortKeys(params ?? {}))
  return createHash('sha256').update(fileBytes).update(`|${type}|${normalized}`).digest('hex').slice(0, 32)
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  }
  return v
}

/** 产物缓存目录名（挂在插件输出目录下，隐藏，与生成产物分开）。 */
export const PREVIEW_DIR_NAME = '.qwen-paint-cnet-previews'
export const CACHE_SIDECAR_NAME = '.qwen-paint-cnet-cache.json'

/**
 * 缓存账本：sidecar JSON 持久化（重启不丢），写入全走「先内存后落盘」，
 * 落盘失败只警告不致命（缓存丢了顶多重算一次）。
 */
export function createPreprocessCache({ outputDir, fs, path }) {
  const sidecar = path.join(outputDir, CACHE_SIDECAR_NAME)
  let map = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
  } catch { /* 没有或坏了都从空账本开始 */ }

  const flush = () => {
    try { fs.writeFileSync(sidecar, JSON.stringify(map)) } catch { /* 尽力而为 */ }
  }

  return {
    get(key) {
      const e = map[key]
      if (!e || typeof e.rel !== 'string' || e.rel === '') return null
      const abs = path.join(outputDir, e.rel)
      try { if (!fs.existsSync(abs)) { delete map[key]; flush(); return null } } catch { return null }
      return { rel: e.rel, abs, node: e.node ?? '', created_at: e.created_at ?? '' }
    },
    put(key, rel, node) {
      map[key] = { rel: String(rel), node: String(node ?? ''), created_at: new Date().toISOString() }
      flush()
    },
    /** 账本条数（诊断用，不进热路径）。 */
    size() { return Object.keys(map).length },
  }
}
