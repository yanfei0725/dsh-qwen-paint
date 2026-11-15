/**
 * lib/music-models.js —— 音乐 / BGM 模型注册表（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   在 TTS 能力区增加一个「音乐 BGM」板块，给用户选择：
 *     · ACE-Step 1.5（ace-step/ACE-Step-1.5）
 *     · YuE2 / YuE 2.0（smthemex/ComfyUI_YuE）
 *
 * ## ★ 诚实边界
 *   网上能核实到的只有**仓库 / 版本信息**；ComfyUI 节点类名、输入槽位、
 *   权重文件名、以及那些「几秒生成几分钟」「显存多少 G」的数字，
 *   一律未经本机 /object_info 与真机验证 ⇒ 全部标 unverified，不写进结论。
 *   本模块只做「注册表 + 模式发现 + 参数计划」，**不真提交 ComfyUI、
 *   不真生成音频、不自动下载任何权重**。探测不到节点就明确降级并给安装提示。
 */
export const MUSIC_MODEL_VERSION = 1

export const BGM_PRESETS = Object.freeze([
  { id: 'ambient', label: '氛围铺底', note: '低存在感、适合旁白背景' },
  { id: 'upbeat', label: '轻快明亮', note: '适合开场 / 转场' },
  { id: 'cinematic', label: '电影感', note: '适合叙事段落' },
  { id: 'lofi', label: 'Lo-Fi', note: '适合长时间陪伴' },
  { id: 'tension', label: '紧张悬疑', note: '适合铺垫' },
  { id: 'custom', label: '自定义', note: '由用户自己写描述' },
])

export const MUSIC_MODELS = Object.freeze([
  {
    id: 'ace_step_15',
    label: 'ACE-Step 1.5',
    origin: 'ace-step/ACE-Step-1.5（ComfyUI 侧有 ComfyUI-AceMusic 等节点包）',
    nodePattern: /Ace|ACE.?Step|ACEStep/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    existing: false,
    unverified: true,
    installHint: '需自行安装 ACE-Step 1.5 的 ComfyUI 节点包与权重；插件不自动下载。',
    params: ['prompt', 'lyrics', 'duration_sec', 'bpm', 'style', 'vocal', 'seed'],
  },
  {
    id: 'yue2',
    label: 'YuE2（YuE 2.0）',
    origin: 'smthemex/ComfyUI_YuE；模型镜像 Comfy-Org/Yue2',
    nodePattern: /YuE|Yue2|YUE/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    existing: false,
    unverified: true,
    installHint: '需自行安装 YuE 的 ComfyUI 节点包与权重；插件不自动下载。',
    params: ['prompt', 'lyrics', 'duration_sec', 'style', 'vocal', 'seed'],
  },
])

export const DEFAULT_MUSIC_MODEL = 'ace_step_15'

function namesOf(installed) {
  const nodes = installed?.nodes ?? installed
  if (nodes instanceof Set) return [...nodes].map(String)
  if (Array.isArray(nodes)) return nodes.map(String)
  if (nodes && typeof nodes === 'object') return Object.keys(nodes).filter((k) => nodes[k] !== false).map(String)
  return []
}

/** 模式发现：只从真实节点表里找，绝不虚构类名。 */
export function discoverMusicNodes(installed, model) {
  const names = namesOf(installed)
  const m = typeof model === 'string' ? MUSIC_MODELS.find((x) => x.id === model) : model
  if (!m) return { generate: [], save: [], nodeCount: names.length }
  return {
    generate: names.filter((n) => m.nodePattern.test(n)),
    save: names.filter((n) => m.savePattern.test(n)),
    nodeCount: names.length,
  }
}

export function pickMusicModel({ requested, installed = {} } = {}) {
  const id = String(requested ?? '').trim() || DEFAULT_MUSIC_MODEL
  const model = MUSIC_MODELS.find((x) => x.id === id)
  if (!model) {
    return { ok: false, selected: null, degraded: true,
      reasons: ['未知音乐模型：' + id, '可选：' + MUSIC_MODELS.map((x) => x.id).join(' / ')] }
  }
  const found = discoverMusicNodes(installed, model)
  const reasons = []
  if (found.generate.length === 0) reasons.push('未在 /object_info 中发现该模型的生成节点（节点类名未经核实）')
  if (found.save.length === 0) reasons.push('未发现音频保存节点')
  return {
    ok: reasons.length === 0,
    selected: model,
    degraded: reasons.length > 0,
    reasons,
    nodes: found,
    installHint: model.installHint,
  }
}

export function listMusicModels({ installed = {} } = {}) {
  return MUSIC_MODELS.map((m) => {
    const found = discoverMusicNodes(installed, m)
    const ready = found.generate.length > 0 && found.save.length > 0
    return {
      id: m.id, label: m.label, origin: m.origin, unverified: m.unverified,
      params: m.params.slice(), available: ready,
      generateCandidates: found.generate.slice(0, 8),
      installHint: m.installHint,
      reason: ready ? '' : '未检测到对应 ComfyUI 节点；' + m.installHint,
    }
  })
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt
}

/**
 * 纯参数计划：不提交、不落盘、不派生子进程。
 * 返回的 nodes 只是「探测到的真实类名」，inputs 只放通用文本字段，
 * 绝不硬塞未经核实的槽位名（那样真机会被 custom_validation_failed 拒掉）。
 */
export function buildMusicPlan({ model, installed = {}, params = {} } = {}) {
  const pick = pickMusicModel({ requested: model, installed })
  if (!pick.selected) return { ok: false, degraded: true, reasons: pick.reasons, plan: null }
  const p = params && typeof params === 'object' ? params : {}
  const prompt = String(p.prompt ?? '').trim().slice(0, 800)
  const lyrics = String(p.lyrics ?? '').trim().slice(0, 4000)
  const durationSec = clamp(p.duration_sec, 5, 600, 60)
  const bpm = clamp(p.bpm, 40, 240, 0)
  const seed = clamp(p.seed, 0, 2147483647, 0)
  const plan = {
    model: pick.selected.id,
    label: pick.selected.label,
    variant: String(p.variant ?? '').slice(0, 40),
    preset: String(p.preset ?? 'custom').slice(0, 40),
    prompt,
    lyrics,
    duration_sec: durationSec,
    bpm,
    style: String(p.style ?? '').slice(0, 200),
    vocal: p.vocal === true,
    seed,
    // 只回显探测到的类名，不作为「已安装可用」的承诺
    discoveredNodes: pick.nodes.generate.slice(0, 8),
    saveNodes: pick.nodes.save.slice(0, 8),
    unverified: true,
    note: '节点输入槽位未核实：本计划不提交 ComfyUI，需按节点包文档映射参数。',
  }
  return {
    ok: pick.ok,
    degraded: pick.degraded,
    reasons: pick.reasons,
    plan,
    installHint: pick.installHint,
  }
}
