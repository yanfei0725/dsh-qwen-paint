/**
 * scripts/quality-fix-catalog.mjs —— 画质修复 LoRA 登记（2026-11-20）。
 *
 * ## 设计红线（对齐 video-model-catalog / audio-model-catalog）
 *  1. **权威 size/sha256 以本机已实测的黄金副本为准**：下面三个哈希是
 *     2026-11-20 在本机 `sha256sum` 实测的既有文件值，不是记忆估算、不是服务器猜测。
 *     下载后按这些值校验；不一致就判残缺，绝不"差不多就算了"。
 *  2. **不编造仓库 URL**：HF/ModelScope 的具体 repo 未经核实，故 `repo` 留空，
 *     只给「自备文件」指引 + 官方模型站的检索入口（页面 URL，非文件 URL）。
 *     用户自备后，本模块用权威哈希验真。
 *  3. **只进不出**：本模块没有任何 POST / PUT / 上传路径，只读清单 + 校验。
 *  4. **默认不下载**：这里是纯登记/校验数据，下载交给 setup 脚本且需显式确认。
 */

/** 权威校验基准：size 为实测字节数，sha256 为实测值。 */
export const QUALITY_FIX_FILES = [
  {
    id: 'fix-lora',
    label: 'Qwen-Image 2.1 画质修复 LoRA（主）',
    filename: 'qwen-image-2.1-fix-1.0-comfy.safetensors',
    targetDir: 'loras',
    size: 111612000,
    sha256: 'e4a369158b957aee3a8316d94dbe00c98f7d648ef3d1926ccf7283915b6db60c',
    usedBy: ['qualityfix-fast', 'qualityfix-high'],
    note: '两档画质修复共用；0.75/1.0 是加载强度，不是两个文件。',
  },
  {
    id: 'detail-fix-lora',
    label: 'Qwen-Image 2.1 细节修复 LoRA（可选）',
    filename: 'qwen2.1-detail-fix-2.0.safetensors',
    targetDir: 'loras',
    size: 54800124,
    sha256: '3f00361145703a64c7b9812d7797079820a1f7b0dbb5768b9d3df1f3c7750dfa',
    usedBy: [],
    note: '配套细节增强，非两档必需；用户可选叠加。',
  },
  {
    id: 'restore-lora',
    label: 'Qwen-Image 2.1 修复/还原 LoRA（可选）',
    filename: 'qwen-image-2.1-restore.safetensors',
    targetDir: 'loras',
    size: 159436584,
    sha256: '65de4f6c2468071d5aa6ffbd82c76bfee7cc8ac28fe960e91bbca4a58f43c08c',
    usedBy: [],
    note: '老图修复/还原用途，非两档必需。',
  },
]

/** 检索入口（页面 URL，非具体文件 URL；避免编造 repo）。 */
export const SELF_BRING_PAGES = [
  'https://huggingface.co/models?search=qwen-image%202.1%20fix%20lora',
  'https://www.modelscope.cn/models?q=qwen-image%202.1%20fix',
]

export const RULES = [
  '默认不下载：登记与校验只读，下载须用户在 setup 里显式确认。',
  '完整性以权威 sha256 判定：不一致即残缺，需重下，不"差不多就算"。',
  '不上传：本模块无 POST / PUT，绝不把本机模型文件送出去。',
  '仓库未核实：只给检索入口与自备文件指引，不编造具体下载 URL。',
]

export function listQualityFixFiles() {
  return QUALITY_FIX_FILES.map((f) => ({ ...f }))
}

export function findQualityFixFile(id) {
  const f = QUALITY_FIX_FILES.find((x) => x.id === String(id ?? '').trim())
  return f ? { ...f } : null
}

/** 自备文件指引（诚实：不假装知道 repo）。 */
export function selfBringGuide(id) {
  const f = findQualityFixFile(id)
  if (!f) return { ok: false, reason: `未知的画质修复权重：${id || '(空)'}` }
  return {
    ok: true,
    filename: f.filename,
    targetDir: f.targetDir,
    size: f.size,
    sha256: f.sha256,
    pages: [...SELF_BRING_PAGES],
    reason: `仓库未核实，不编造下载 URL；请自备 ${f.filename} 并按 sha256 校验。`,
  }
}

/**
 * 校验一个本地文件是否与权威基准一致。
 * 只比 size 与 sha256；hash 由调用方传入（本模块不读文件、不依赖 node:fs）。
 */
export function verifyAgainstAuthoritative(id, { size, sha256 } = {}) {
  const f = findQualityFixFile(id)
  if (!f) return { ok: false, reason: `未知的画质修复权重：${id || '(空)'}` }
  if (!Number.isFinite(size)) return { ok: false, reason: '缺少 size，无法校验' }
  if (size !== f.size) {
    return { ok: false, reason: `size 不符：期望 ${f.size}，实际 ${size}`, expected: f.size, actual: size }
  }
  const got = String(sha256 ?? '').toLowerCase()
  if (got !== f.sha256) {
    return { ok: false, reason: `sha256 不符：期望 ${f.sha256}，实际 ${got || '(空)'}`, expected: f.sha256, actual: got }
  }
  return { ok: true, reason: 'size 与 sha256 均与权威基准一致', expected: f.sha256 }
}
