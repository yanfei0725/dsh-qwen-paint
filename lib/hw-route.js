// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-hw-route

/** 设备名 → 架构判定（纯字符串解析；识别不出如实 unknown，不猜）。 */
export function detectGpuArch(name = '') {
  const s = String(name ?? '')
  const out = { vendor: 'unknown', arch: 'unknown', sm: null, generation: 'unknown', evidence: s.slice(0, 120) }
  if (/nvidia|geforce|rtx|gtx/iu.test(s)) {
    out.vendor = 'nvidia'
    if (/rtx\s*5\d{3}|blackwell|rtx\s*pro/iu.test(s)) {
      out.arch = 'blackwell'; out.sm = 'sm_120'; out.generation = '50 系 / Blackwell'
    } else if (/rtx\s*4\d{3}/iu.test(s)) {
      out.arch = 'ada'; out.sm = 'sm_89'; out.generation = '40 系 / Ada'
    } else if (/rtx\s*3\d{3}|a100|h100/iu.test(s)) {
      out.arch = 'ampere'; out.sm = 'sm_86'; out.generation = '30 系 / Ampere'
    } else if (/rtx\s*2\d{3}|gtx\s*16\d{2}/iu.test(s)) {
      out.arch = 'turing'; out.sm = 'sm_75'; out.generation = '20 系 / Turing'
    } else if (/gtx\s*10\d{2}/iu.test(s)) {
      out.arch = 'pascal'; out.sm = 'sm_61'; out.generation = '10 系 / Pascal'
    } else {
      out.generation = 'nvidia（型号未识别）'
    }
    return out
  }
  if (/amd|radeon/iu.test(s)) {
    out.vendor = 'amd'
    if (/rx\s*9\d{3}/iu.test(s)) {
      out.arch = 'rdna4'; out.sm = 'gfx1200'; out.generation = '9000 系 / RDNA4（型号映射 unverified）'
    } else if (/rx\s*7\d{3}|gfx1100/iu.test(s)) {
      out.arch = 'rdna3'; out.sm = 'gfx1100'; out.generation = '7000 系 / RDNA3'
    } else if (/rx\s*6\d{3}|gfx1030/iu.test(s)) {
      out.arch = 'rdna2'; out.sm = 'gfx1030'; out.generation = '6000 系 / RDNA2'
    } else if (/radeon\(tm\) graphics|8060s|7840|8845/iu.test(s)) {
      out.arch = 'rdna-igpu'; out.generation = 'AMD 核显（ROCm 官方不支持，见 igpu-profiles 口径）'
    } else {
      out.generation = 'amd（型号未识别）'
    }
    return out
  }
  if (/intel|arc/iu.test(s)) {
    out.vendor = 'intel'; out.arch = 'xe-arc'; out.generation = 'Intel Arc / Xe'
    return out
  }
  return out
}

/**
 * SageAttention 内核变体建议（报告层；实际节点写入仍走 attention-workflow 的
 * 「宿主声明优先 + 已核实槽位」纪律——未核实的变体槽位绝不写）。
 *   · blackwell → 'auto'：sm_120 需匹配构建，FP8/SA3 变体待实测；
 *   · ada（40 系）→ 'fp8'：sm_89 具备 FP8 注意力能力（收益 unverified）；
 *   · ampere/turing/pascal → 'int8'：老卡走稳定 INT8 变体；
 *   · amd / intel → 'unsupported'：sage-attention 的 CUDA 内核不适用本架构，
 *     除非节点提供 Triton 变体（当前 /object_info 未核实到）。
 */
export function routeSageKernels({ arch = 'unknown', vendor = 'unknown', nodeOptions = [] } = {}) {
  const opts = (Array.isArray(nodeOptions) ? nodeOptions : []).map(String)
  const hasTritonVariant = opts.some((o) => /triton/iu.test(o))
  const base = { unverified: true, applies: vendor === 'nvidia', nodeOptions: opts.length }
  switch (arch) {
    case 'blackwell':
      return { ...base, recommended: 'auto', note: 'Blackwell/sm_120：构建匹配是第一前提；FP8/SA3 变体收益待实测（unverified）' }
    case 'ada':
      return { ...base, recommended: 'fp8', note: 'sm_89 具备 FP8 注意力能力；实际收益 unverified，建议 auto 与 fp8 各跑一轮对比' }
    case 'ampere':
    case 'turing':
    case 'pascal':
      return { ...base, recommended: 'int8', note: '老卡走稳定 INT8 变体（qk_int8_pv_fp16_cuda 一类）' }
    // ★ 2026-11-20：RDNA3/RDNA4 不再 unsupported——LightX2V 官方 sage_attn.py 逐字验证
    //   _VALIDATED_ARCHS = ('gfx1201', 'gfx1100')（Triton 路径，含 num_stages≤2 miscompile 的
    //   workaround）；Windows 预编译包 guinmoon/rocm7-triton-flash-attention-sage-attention-bnb
    //   覆盖 gfx1100+。A 卡实际倍率未实测（unverified 口径保留）。
    case 'rdna3':
    case 'rdna4':
      return { ...base, applies: true, recommended: 'triton',
        note: 'RDNA3/RDNA4：sage-attention 走 Triton 路径（LightX2V 官方验证 gfx1100/gfx1201）——'
          + '装好后 /object_info 出现节点类名即自动接线；A 卡收益未实测（unverified）' }
    case 'rdna2':
    case 'rdna-igpu':
    case 'xe-arc':
      return { ...base, recommended: 'unsupported', applies: false,
        note: 'sage-attention 的 CUDA 内核不适用；LightX2V 的 Triton 验证列表只有 gfx1100/gfx1201' }
    default:
      return { ...base, recommended: 'auto', note: '架构未知 → 保守 auto（由 ComfyUI 自选）' }
  }
}

/**
 * 量化内核感知提示：量化档位（GGUF / INT8 / FP8 权重）是否「真提速」取决于
 * 高效内核是否在位——本插件无法经 HTTP 探测到 torch/Triton 内核在位信息，
 * ⇒ 保守提示：A 卡（ROCm）按 memory-only；N 卡 unverified；未选量化档不提示。
 */
export function quantKernelVerdict({ vendor = 'unknown', arch = 'unknown', tier = '', model = '' } = {}) {
  const isQuant = /gguf|q4|q5|q6|q8|int8|fp8/iu.test(String(model)) || String(tier ?? '').toLowerCase() === 'gguf'
  if (!isQuant) {
    return { verdict: 'not-quantized', note: '当前未选择量化模型 / GGUF 档位，无内核感知提示', unverified: false }
  }
  if (vendor === 'nvidia') {
    return { verdict: 'unverified',
      note: 'N 卡：INT8/FP8 内核在位与否取决于 torch / Triton 构建，插件无法经 HTTP 探测 ⇒ 未实测前不承诺「量化必然提速」', unverified: true }
  }
  return { verdict: 'memory-only',
    note: (vendor === 'amd' ? 'A 卡（ROCm）：' : '该架构：') + '缺少对应高效内核的公开证据 ⇒ 按仅省显存提示（不保证提速）；以本机实测为准', unverified: true }
}

/** stable-fast 明确跳过声明（清单第 4 条：不集成，理由留痕）。 */
export const STABLE_FAST_SKIP = Object.freeze({
  id: 'stable-fast',
  integrated: false,
  reasons: [
    '原项目已停更',
    '低显存场景（如 6GB 跑 SDXL）效果不佳',
    '需要连续使用同一模型多次才见效，频繁切换模型 / LoRA 反而可能拖慢',
    '社区路线是并入 Comfy-WaveSpeed —— 插件已走 WaveSpeed / FBCache 路线',
  ],
})

/** 一次拼出 accel-chain 的 hw_route 段。 */
export function buildHwRouteSection({ gpuVendor = 'unknown', deviceName = '', tier = '', model = '' } = {}) {
  const det = detectGpuArch(deviceName || gpuVendor)
  const sage = routeSageKernels({ arch: det.arch, vendor: det.vendor })
  const quant = quantKernelVerdict({ vendor: det.vendor, arch: det.arch, tier, model })
  return {
    detected: det,
    sage_route: sage,
    quant_kernel: quant,
    reset_semantics: '图内注意力节点按每次生成插拔（非全局 Monkey Patch），关闭后下一次生成自然不带；'
      + '启动级 --use-sage-attention 的崩溃回退由 comfy-launch 自动禁用处理（性能/兼容模式见 nvidiaSageAttentionMode）。',
    skipped: [STABLE_FAST_SKIP],
    unverified: true,
  }
}
