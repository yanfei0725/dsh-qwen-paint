/**
 * lib/creative-chain.js —— 创作编排层的四个纯函数件。
 *
 *   D18 buildProduceRefs / resolveProduceRef  会话内产出的稳定短引用（#1 是最新）
 *   D20 buildTimeline / timelineToPrefix      无音频锚点时的建议时间轴
 *   E27 describeResourceNeeds                 提交前的资源需求声明
 *   F31 buildPrivacySummary                   本轮数据流摘要
 *
 * 四件都是纯函数，无 IO、无网络、不依赖 ComfyUI。放在一个文件里是因为它们
 * 服务同一件事：**让 Agent 在"上一步 → 下一步"之间拿到可靠的、可核对的上下文**，
 * 而不是靠猜上一次生成了什么。
 *
 * ★★ 一条贯穿的自我约束：**不编数字**。
 *   本插件没有可靠的性能基准（`speedTargetSec` 至今仍是 unverified 占位值），
 *   所以 E27 只给相对档位与"是否独占模型"，不给"预计 37 秒"；
 *   F31 的"未访问外网"是真的从请求清单算出来的，不是写死的 false。
 */

/* -------------------------------------------------- D18 产出短引用 ---- */

/**
 * 给一批历史条目配上稳定短引用。
 *
 * 引用规则（`#1` 永远是**最新**的那条）：
 *   `#1` / `#2` …   按时间倒序的序号
 *   `last` / `latest`  等价于 #1
 *   `first`            最老的一条
 *
 * ★ 为什么需要它：历史库的 id 是自增的，重启、删库、迁移后并不稳定；
 *   而"刚才那张"这种说法在对话里最自然。用**相对序号**做锚点，
 *   比让 Agent 记住一长串绝对路径可靠得多。
 */
export function buildProduceRefs(items) {
  const list = Array.isArray(items) ? items : []
  return list.map((it, i) => ({ ...it, ref: `#${i + 1}` }))
}

/**
 * 把 `#3` / last / first / 文件名后缀 解析成某一条。
 *
 * @param {string} ref
 * @param {Array} items `buildProduceRefs` 的结果（或已带 ref 的列表）
 * @returns {{ok:boolean, item:object|null, reason:string, index:number}}
 */
export function resolveProduceRef(ref, items) {
  const list = Array.isArray(items) ? items : []
  const raw = String(ref ?? '').trim()
  const miss = (reason) => ({ ok: false, item: null, reason, index: -1 })
  if (raw === '') return miss('ref 不能为空')
  if (list.length === 0) return miss('当前没有可引用的产出')

  const low = raw.toLowerCase()
  if (low === 'last' || low === 'latest' || low === '#1' || low === '1') {
    return { ok: true, item: list[0], reason: '', index: 0 }
  }
  if (low === 'first' || low === 'oldest') {
    return { ok: true, item: list[list.length - 1], reason: '', index: list.length - 1 }
  }

  const m = /^#?(\d+)$/u.exec(raw)
  if (m) {
    const n = Number(m[1])
    if (n < 1) return miss('序号从 1 开始')
    if (n > list.length) return miss(`只有 ${list.length} 条，没有 #${n}`)
    return { ok: true, item: list[n - 1], reason: '', index: n - 1 }
  }

  // 文件名 / 路径后缀匹配：`fox.png` 能命中 `K:/out/qwen-paint/fox.png`。
  // ★ 只在**唯一命中**时才返回 —— 多个候选就报歧义，绝不替用户挑一个。
  const hits = []
  for (let i = 0; i < list.length; i += 1) {
    const p = String(list[i]?.path ?? list[i]?.file_path ?? '').replace(/\\/g, '/')
    if (p !== '' && p.toLowerCase().endsWith(low)) hits.push(i)
  }
  if (hits.length === 1) return { ok: true, item: list[hits[0]], reason: '', index: hits[0] }
  if (hits.length > 1) return miss(`「${raw}」匹配到 ${hits.length} 条，请说得更具体（或用 #序号）`)
  return miss(`没有哪条产出的路径以「${raw}」结尾`)
}

/* -------------------------------------------------- D20 时间轴骨架 ---- */

/** 默认步长（秒）。清单给的例子是 0-2 / 2-4 / 4-6，即 2 秒一段。 */
export const TIMELINE_STEP_SEC = 2
export const TIMELINE_MAX_SEGMENTS = 12

/**
 * 按目标时长切建议时间轴。
 *
 * ★ 定位必须是「建议结构」而不是硬约束：
 *   文生视频没有真实音频锚点时，模型对"第 3 秒发生什么"本来就没有严格时序概念；
 *   给一个均分骨架，作用是让提示词**有条理地**写下去（先交代环境、再动作、再收尾），
 *   而不是让模型真的精确到帧。文案里必须说清这一点，否则用户会拿它当承诺。
 *
 * ★ 与 TTS 排轴的区别：有配音时时间轴必须由**真实音频时长**决定（见 D21 的
 *   `generate_hybrid` 路径），不能用这个均分骨架 —— 两者不可混用。
 *
 * @param {object} o
 * @param {number} o.seconds 目标总时长；必须 > 0
 * @param {number} [o.step] 每段秒数，默认 2
 * @param {string[]} [o.labels] 自定义每段标签（不足则用默认顺序词）
 * @returns {{ok:boolean, reason:string, step:number, seconds:number,
 *   segments:Array<{index:number,from:number,to:number,label:string}>}}
 */
export function buildTimeline({ seconds, step, labels } = {}) {
  const total = Number(seconds)
  const st = Number.isFinite(step) && step > 0 ? Number(step) : TIMELINE_STEP_SEC
  const base = { ok: false, reason: '', step: st, seconds: Number.isFinite(total) ? total : 0, segments: [] }
  if (!Number.isFinite(total) || total <= 0) return { ...base, reason: 'seconds 必须是正数' }

  const count = Math.ceil(total / st)
  if (count > TIMELINE_MAX_SEGMENTS) {
    return { ...base, reason: `按 ${st} 秒一段会切出 ${count} 段，超过上限 ${TIMELINE_MAX_SEGMENTS}；请加大步长或缩短时长` }
  }
  const DEFAULT_LABELS = ['开场 · 交代环境', '展开 · 主体动作', '推进 · 细节或情绪', '转折 · 变化',
    '高潮 · 最强画面', '收尾 · 落定']
  const segs = []
  for (let i = 0; i < count; i += 1) {
    const from = Number((i * st).toFixed(2))
    // 最后一段夹到总时长，避免出现 6-8 秒但目标只有 7 秒这种越界。
    const to = Number(Math.min(total, (i + 1) * st).toFixed(2))
    const custom = Array.isArray(labels) ? labels[i] : undefined
    const label = typeof custom === 'string' && custom.trim() !== ''
      ? custom.trim().slice(0, 40)
      : (DEFAULT_LABELS[i] ?? `第 ${i + 1} 段`)
    segs.push({ index: i + 1, from, to, label })
  }
  return { ...base, ok: true, segments: segs }
}

/**
 * 把时间轴拼成可直接放进 prompt 的前缀。
 *
 * 输出形如：
 *   `0-2 秒：开场 · 交代环境；2-4 秒：展开 · 主体动作。按顺序演进，不要跳步。`
 */
export function timelineToPrefix(timeline) {
  const segs = Array.isArray(timeline?.segments) ? timeline.segments : []
  if (segs.length === 0) return ''
  const parts = segs.map((s) => `${s.from}-${s.to} 秒：${s.label}`)
  return `${parts.join('；')}。按这个顺序演进，画面之间要连贯，不要跳步。`
}

/* -------------------------------------------------- E27 资源需求声明 ---- */

/** 按输出像素数分三档。阈值只用于**相对**提示，不代表任何显卡的绝对能力。 */
import { pickEta } from './eta-calibrate.js'

export const RESOURCE_TIERS = [
  { id: 'low', maxPixels: 1_000_000, label: '轻量', note: '远小于 1080p，多数能跑图的机器都扛得住' },
  { id: 'medium', maxPixels: 2_600_000, label: '中等', note: '约 1080p 量级；显存紧张的机器可能要配合省显存档' },
  { id: 'high', maxPixels: Infinity, label: '偏重', note: '超过 1080p；建议先确认显存，或改用省显存 / 最省显存档位' },
]

/**
 * 提交前的资源需求声明。
 *
 * ★★ 为什么**不给预计秒数**：`speedTargetSec` 至今是 unverified 占位值，
 *   不同显卡差一个数量级。编一个"预计 20 秒"只会让用户拿它当承诺。
 *   所以这里给的是：相对档位、是否独占模型、以及"要不要担心显存"。
 *   真实秒数请以目标机实测（`scripts/cpu-probe.mjs` / `calibrate-8gb.mjs`）为准。
 *
 * @param {object} o
 * @param {'image'|'video'|'tts'|'upscale'} o.kind
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @param {number} [o.frames] 视频帧数（参与像素数计算）
 * @param {number} [o.scale] 放大倍数
 */
export function describeResourceNeeds({ kind, width, height, frames, scale, steps, calibration } = {}) {
  const k = String(kind ?? '').trim()
  const w = Number(width)
  const h = Number(height)
  const hasSize = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0
  const f = Number.isFinite(frames) && frames > 0 ? Math.trunc(frames) : 1
  const sc = Number.isFinite(scale) && scale > 0 ? Number(scale) : 1

  // 视频按帧累计、放大按面积平方 —— 这是显存压力的主要来源，粗算即可。
  const perFrame = hasSize ? w * h * sc * sc : 0
  const pixels = k === 'video' ? perFrame * f : perFrame
  const tier = RESOURCE_TIERS.find((t) => pixels <= t.maxPixels) ?? RESOURCE_TIERS[RESOURCE_TIERS.length - 1]

  // 是否"独占模型"：视频 / 超分都会把主模型卸下来换自己的权重。
  const exclusive = k === 'video' || k === 'upscale'
  const notes = []
  if (!hasSize && k !== 'tts') notes.push('没给尺寸，无法估档位')
  if (hasSize) notes.push(tier.note)
  if (exclusive) notes.push('该任务会先把千问主模型从显存卸下（避免双占），结束后下次出图自动重新加载')
  if (k === 'video') notes.push(`按 ${f} 帧累计，帧数对显存压力影响比分辨率更大`)

  // ★★ E27：秒数只来自**本机实测**（ComfyUI /history 的 execution_start→success）。
  //   没有样本就还是 null —— 之前那句"给数字等于编"依然成立，只是现在有了不编的来源。
  const eta = pickEta(calibration, {
    kind: k, width: hasSize ? w : undefined, height: hasSize ? h : undefined, steps,
  })
  notes.push(eta.detected === true
    ? eta.note
    : '不提供预计秒数：这台机器还没有同类任务的实测记录，拿别的档位或别人的机器凑数等于编')

  return {
    // 只有 kind 给了、且尺寸信息够算（tts 不需要尺寸）才算成功；
    // 缺尺寸时仍然返回结构，但 ok:false 并说明原因 —— 不返回一个全 null 的壳子装成功。
    ok: k !== '' && (k === 'tts' || hasSize),
    kind: k,
    tier: tier.id,
    tier_label: tier.label,
    pixel_estimate: pixels > 0 ? Math.round(pixels) : null,
    exclusive_model: exclusive,
    est_seconds: eta.est_seconds,
    eta_basis: eta.eta_basis,
    eta_samples: eta.samples,
    eta_confidence: eta.confidence,
    eta_key: eta.key,
    notes,
  }
}

/* -------------------------------------------------- F31 隐私数据流摘要 ---- */

/** 判定一个 URL 是否只指向本机回环。 */
export function isLoopbackUrl(url) {
  const s = String(url ?? '')
  const m = /^https?:\/\/([^/?#]+)/iu.exec(s)
  if (!m) return false
  const hostPort = m[1].toLowerCase()
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/**
 * 本轮数据流摘要。
 *
 * ★★ `external_network` 是**算出来的**，不是写死的 false：
 *   传入本轮真实发过的 URL 清单，逐个判定是不是回环地址。
 *   只要有一条出网就如实标 true —— 写死 false 的"隐私声明"是自欺欺人。
 *
 * @param {object} o
 * @param {string} [o.comfyUrl] 本轮调的 ComfyUI 地址
 * @param {string[]} [o.requestUrls] 本轮发过的全部 URL（含上传/轮询/取产物）
 * @param {string[]} [o.models] 本轮加载的模型文件名
 * @param {number} [o.seconds] 本轮耗时
 * @param {string} [o.promptId] 可用于 /history 交叉核对
 */
export function buildPrivacySummary({ comfyUrl, requestUrls, models, seconds, promptId } = {}) {
  const urls = []
  if (typeof comfyUrl === 'string' && comfyUrl.trim() !== '') urls.push(comfyUrl.trim())
  if (Array.isArray(requestUrls)) {
    for (const u of requestUrls) if (typeof u === 'string' && u.trim() !== '') urls.push(u.trim())
  }
  const external = urls.filter((u) => !isLoopbackUrl(u))
  const hosts = [...new Set(urls.map((u) => {
    const m = /^https?:\/\/([^/?#]+)/iu.exec(u)
    return m ? m[1].toLowerCase() : u
  }))]

  const list = Array.isArray(models) ? models.filter((m) => String(m ?? '').trim() !== '') : []
  const sec = Number.isFinite(seconds) ? Number(seconds) : null

  const bits = []
  if (hosts.length > 0) bits.push(`全部请求发往 ${hosts.join('、')}`)
  bits.push(external.length === 0 ? '未访问任何外部网络' : `有 ${external.length} 个请求发往外部：${external.slice(0, 3).join('、')}`)
  if (list.length > 0) bits.push(`加载模型 ${list.join('、')}`)
  if (sec !== null) bits.push(`耗时 ${sec}s`)

  return {
    ok: true,
    endpoints: hosts,
    request_count: urls.length,
    external_network: external.length > 0,
    external_urls: external.slice(0, 5),
    models: list,
    seconds: sec,
    prompt_id: String(promptId ?? ''),
    summary: bits.join('，') + '。',
    // 让用户能自己核对，而不是只能信这句话。
    cross_check: 'ComfyUI 侧可用 GET /history/<prompt_id> 查看本轮真实的节点与产物记录。',
  }
}
