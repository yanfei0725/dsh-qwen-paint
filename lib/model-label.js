/**
 * lib/model-label.js —— 模型文件名 → 干净展示名 + 右侧参数标签（host 侧纯函数）。
 *
 * 为什么在 host 侧做：`lib/client.js` 是 window.__ModuleLoader__ 非 ESM 单入口，
 * 不能 import ESM；而「文件名里哪些是花哨参数、哪些是主体」是**数据规则**，
 * 不该让前端再各自发明一遍。这里算好，经 GET /api/qwen-paint/capabilities
 * 的 fileLabels 快照下发，前端只读。client.js 里保留一个同口径的本地兜底，
 * 用于旧版 host 没下发 fileLabels 时不至于露出裸文件名。
 *
 * 规则（按用户要求）：_fp8 / _int8 / .safetensors 等量化与格式标记一律从展示名里
 * 「截断」，挪到右侧灰色小字；模型主体名（含版本、架构词）保持原样。
 */
const EXT_RE = /\.(safetensors|gguf|pth|pt|ckpt|bin|onnx)$/iu
const PARAM_RE = /[_-](fp8(?:_e4m3fn|_e5m2|_scaled)?|int8|bf16|fp16|q[2-8]_[0-9a-z_]+|w\d+a\d+|convrot|dmd|turbo8|step\d+)(?=[_-]|$)/giu

/** @returns {{clean:string, meta:string, ext:string, params:string[]}} */
export function splitModelLabel(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return { clean: '', meta: '', ext: '', params: [] }
  const extMatch = EXT_RE.exec(raw)
  const ext = extMatch ? extMatch[0].slice(1) : ''
  let stem = extMatch ? raw.slice(0, raw.length - extMatch[0].length) : raw
  const params = []
  const seen = new Set()
  stem = stem.replace(PARAM_RE, (_m, p) => {
    const key = String(p).toLowerCase()
    if (!seen.has(key)) { seen.add(key); params.push(key) }
    return ''
  })
  stem = stem.replace(/[_-]{2,}/gu, '_').replace(/^[_-]+|[_-]+$/gu, '')
  // 全被剥光（文件名本身就是个量化标记）时退回原名，绝不显示空下拉项
  const clean = stem !== '' ? stem : raw
  const metaParts = params.slice()
  if (ext !== '') metaParts.push(ext)
  return { clean, meta: metaParts.join(' · '), ext, params }
}

/** 把 caps.files（{unet:[...], lora:[...]}）压成 filename → {clean,meta} 的扁平表。 */
export function preprocessFileLabels(files) {
  const out = {}
  for (const group of Object.values(files ?? {})) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      const raw = String(item)
      out[raw] = splitModelLabel(raw)
    }
  }
  return out
}
