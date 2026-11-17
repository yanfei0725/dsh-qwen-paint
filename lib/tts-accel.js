// 设计说明已外置 → docs/tts-early-audio-design-notes.md#hdr-note-tts-accel
export const TTS_ACCEL_BACKENDS = Object.freeze([
  { id: 'cuda_graph', label: 'CUDA Graph 捕获自回归解码循环', probeKey: 'tts_cuda_graph',
    requires: ['nvidia'], unverified: true,
    notes: '需固定 max_seq_len 预分配静态 KV；长文本要调大上限。本机效果未实测' },
  { id: 'triton_hybrid', label: 'Triton 融合算子（可与 CUDA Graph 叠加）', probeKey: 'tts_triton',
    requires: ['nvidia'], unverified: true,
    notes: '算子层融合；叠加时标为 hybrid。本机效果未实测' },
  { id: 'gguf', label: 'GGUF / llama.cpp 后端（非 N 卡兜底）', probeKey: 'tts_gguf',
    requires: [], unverified: true,
    notes: '面向 AMD / Intel 集显 / 纯 CPU；缺权重时只给清单，不自动下载' },
  { id: 'streaming', label: '流式生成（前后端解耦，降低首包延迟）', probeKey: 'tts_streaming',
    requires: [], unverified: true,
    notes: '只有调用方明确要流式时才启用；项目当前 TTS 链路是整段轮询，尚未改造' },
  { id: 'vocoder_fp16', label: '声码器 mel 输入转 float16', probeKey: 'vocoder_fp16',
    requires: [], unverified: true,
    notes: '纯数据类型开关，改动量小；是否可配取决于实际声码器节点' },
])

const VRAM_FLOOR_MB = 2048

function has(installed, key) {
  return installed.has(key) || installed.has(key.replace(/^tts_/, ''))
}

/**
 * @returns {{selected:string[], reasons:string[], degraded:boolean, hybrid:boolean, maxSeqLenHint:number|null}}
 */
export function pickTtsAccel({
  installed = [], gpuVendor = 'unknown', vramMb = null,
  textLength = 0, wantStreaming = false,
} = {}) {
  const have = new Set(Array.isArray(installed) ? installed : [])
  const vendor = String(gpuVendor || 'unknown').toLowerCase()
  const nvidia = /nvidia|cuda|geforce|rtx|quadro/u.test(vendor)
  const reasons = []
  const selected = []
  const byId = new Map(TTS_ACCEL_BACKENDS.map((b) => [b.id, b]))

  const tryAdd = (id) => {
    const b = byId.get(id)
    if (!b) return false
    if (!has(have, b.probeKey)) {
      reasons.push(b.id + '：未探测到后端，降级')
      return false
    }
    if (b.requires.includes('nvidia') && !nvidia) {
      reasons.push(b.id + '：当前显卡不是 NVIDIA，降级')
      return false
    }
    if (b.id === 'cuda_graph' && Number.isFinite(vramMb) && vramMb < VRAM_FLOOR_MB) {
      reasons.push(b.id + '：显存预算不足，降级')
      return false
    }
    if (b.id === 'streaming' && wantStreaming !== true) {
      reasons.push(b.id + '：调用方未请求流式，不启用')
      return false
    }
    if (!selected.includes(id)) selected.push(id)
    reasons.push(b.id + '：已探测到，启用')
    return true
  }

  // 非 N 卡优先 GGUF 兜底；N 卡先试 CUDA Graph，再叠加 Triton 成 hybrid。
  if (!nvidia) {
    tryAdd('gguf')
    reasons.push('非 NVIDIA 环境：以 GGUF 作为兜底后端')
  } else {
    tryAdd('cuda_graph')
    tryAdd('triton_hybrid')
  }
  if (wantStreaming) tryAdd('streaming')
  tryAdd('vocoder_fp16')

  const hybrid = selected.includes('cuda_graph') && selected.includes('triton_hybrid')
  const n = Number(textLength)
  const maxSeqLenHint = Number.isFinite(n) && n > 0
    ? Math.min(8192, Math.max(512, Math.ceil(n / 64) * 128)) : null

  return {
    selected,
    reasons,
    degraded: selected.length === 0,
    hybrid,
    maxSeqLenHint,
    fallbackReason: selected.length === 0 ? '没有探测到可用的 TTS 加速后端，按原链合成' : '',
  }
}

/** 纯数据补丁：只描述可配置项，不声称任何加速倍率或实测耗时。 */
export function ttsAccelToWorkflowPatch(selection = {}) {
  const selected = Array.isArray(selection.selected) ? selection.selected : []
  const patch = {
    accel_chain: [...selected],
    hybrid: selection.hybrid === true,
    reasons: Array.isArray(selection.reasons) ? [...selection.reasons] : [],
    degraded: selection.degraded === true,
    config: {},
  }
  if (selected.includes('vocoder_fp16')) patch.config.vocoder_mel_dtype = 'float16'
  if (selected.includes('cuda_graph') && Number.isFinite(selection.maxSeqLenHint)) {
    patch.config.max_seq_len = selection.maxSeqLenHint
  }
  if (selected.includes('streaming')) patch.config.streaming = true
  return patch
}
