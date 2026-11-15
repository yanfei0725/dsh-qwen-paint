/**
 * lib/vram-budget.js - 按子任务类型解析「显存预算」建议（独立模块、零 I/O）。
 *
 * 概念边界（务必先读）：
 *   · 本模块表示的是「每个子任务各自允许的显存上限档位」，是一个**预算建议**，
 *     不是 ComfyUI 的启动模式开关。它与 lib/vram-strategy.js 的 MODE_LADDER、
 *     lib/perf-presets.js 的 VRAM_CHOICES、lib/config.js 的 VRAM_MODES 是不同维度，
 *     本模块不 import、不修改、不覆盖它们，彼此不冲突。
 *   · 显存上限只能表述为「建议 / 生成的启动参数」。ComfyUI 没有精确的按任务显存
 *     配额开关，所以 launchArgs 只是依据所选档位生成的建议参数字符串，
 *     **绝不保证、绝不承诺实际显存占用**。用户提供的性能倍率数字一律视为 unverified，
 *     不当事实写进注释。
 *   · 无上限用 null 表示，绝不用 Infinity（Infinity 进 JSON 会变成 null / 报错）。
 *   · 0 GB 明确表示纯 CPU / 权重不放进显存。
 *   · 每个 kind 可独立设上限：resolveVramBudget 是纯函数，按传入的 kind 各自结算，
 *     模块不维护跨 kind 的单一全局上限；listVramBudgetKinds 列出各 kind 的独立默认建议。
 *
 * 代码风格：ESM、export function/const、字符串只用 ASCII 直引号。
 */

const GB_TO_MB = 1024

/** 可选档位（GB）。非法值一律拒绝并给 reason，不做「就近取整」的静默猜测。 */
const GB_STEPS = [0, 2, 4, 8, 12, 16, 24]

/**
 * 档位表：0/2/4/8/12/16/24 GB 与「无上限」。
 * 无上限项的 gb / mb 都是 null，不出现 Infinity。
 */
export const VRAM_BUDGET_CHOICES = Object.freeze(
  GB_STEPS.map((gb) => Object.freeze({
    id: String(gb),
    gb,
    mb: gb * GB_TO_MB,
    cpuOnly: gb === 0,
    label: gb === 0 ? '0 GB：纯 CPU，权重不进显存' : gb + ' GB：建议上限',
  })).concat(Object.freeze({
    id: 'unlimited',
    gb: null,
    mb: null,
    cpuOnly: false,
    label: '无上限：不设显存预算（null，不是 Infinity）',
  })),
)

/** 各 kind 的独立默认建议档位。defaultGb 为 null 表示不预设上限。 */
export const VRAM_BUDGET_KINDS = Object.freeze([
  Object.freeze({ kind: 'image', label: '文生图 / 图生图', defaultGb: 8 }),
  Object.freeze({ kind: 'video', label: '视频', defaultGb: 16 }),
  Object.freeze({ kind: 'tts', label: '语音合成', defaultGb: 4 }),
  Object.freeze({ kind: 'upscale', label: '超分放大', defaultGb: 4 }),
  Object.freeze({ kind: 'inpaint', label: '局部重绘 / 精修', defaultGb: 8 }),
  Object.freeze({ kind: 'batch', label: '批量子任务', defaultGb: 4 }),
])

export function listVramBudgetKinds() {
  return VRAM_BUDGET_KINDS.map((k) => ({ ...k }))
}

/** 依据档位生成「建议启动参数」字符串数组。纯参数，不含任何承诺性措辞。 */
const LAUNCH_ARGS = Object.freeze({
  0: Object.freeze(['--cpu']),
  2: Object.freeze(['--lowvram']),
  4: Object.freeze(['--lowvram']),
  8: Object.freeze(['--normalvram']),
  12: Object.freeze(['--normalvram', '--reserve-vram', '0.5']),
  16: Object.freeze(['--highvram', '--reserve-vram', '0.5']),
  24: Object.freeze(['--highvram', '--reserve-vram', '0.5']),
})

function buildLaunchArgs(gb) {
  if (gb === null) return []
  const args = LAUNCH_ARGS[gb]
  return args ? [...args] : []
}

/**
 * 把一个请求值解析成合法档位（GB）或 null（无上限）。
 * 返回 { valid, gb }；valid=false 表示不在可选档位内，应拒绝。
 */
function normalizeRequested(raw) {
  if (raw === null || raw === undefined) return { valid: true, gb: null }
  let value = raw
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '' || s === 'unlimited' || s === 'none' || s === 'null'
      || s === 'no-limit' || s === 'unbounded') {
      return { valid: true, gb: null }
    }
    const n = Number(s)
    if (!Number.isFinite(n)) return { valid: false }
    value = n
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { valid: false }
  const hit = VRAM_BUDGET_CHOICES.find((c) => c.gb !== null && c.gb === value)
  if (!hit) return { valid: false }
  return { valid: true, gb: hit.gb }
}

/**
 * 解析某个 kind 的显存预算。
 *
 * @param {object} [o]
 * @param {number|string|null} [o.requested] 请求的档位 GB（0/2/4/8/12/16/24）或 null/无上限；
 *        省略时回退到该 kind 的独立默认建议档位（未登记的 kind 回退为无上限）。
 * @param {number|string|null} [o.max] 本次允许的最高档位；超出时收敛到它（不超过它）。
 * @param {string} [o.kind] image / video / tts / upscale / inpaint / batch 等。
 * @returns {{ok:boolean, mb:number|null, limited:boolean, reason:string,
 *            launchArgs:string[], kind:string, gb:number|null}}
 */
export function resolveVramBudget({ requested, max, kind } = {}) {
  const k = String(kind ?? '').trim() || 'image'
  const known = VRAM_BUDGET_KINDS.some((x) => x.kind === k)
  const kindDefault = VRAM_BUDGET_KINDS.find((x) => x.kind === k)

  // 省略 requested：用该 kind 的独立默认档位；显式 null / unlimited：无上限。
  const omitted = requested === undefined
  const req = omitted
    ? { valid: true, gb: kindDefault ? kindDefault.defaultGb : null }
    : normalizeRequested(requested)
  if (!req.valid) {
    return {
      ok: false, mb: null, limited: false, kind: k, gb: null, launchArgs: [],
      reason: '请求的显存档位不在可选档位内；可用：0/2/4/8/12/16/24 GB 或无上限 null。',
    }
  }

  let cap = null
  if (max !== undefined && max !== null && max !== '') {
    const m = normalizeRequested(max)
    if (!m.valid) {
      return {
        ok: false, mb: null, limited: false, kind: k, gb: null, launchArgs: [],
        reason: 'max 不是合法档位（可用 0/2/4/8/12/16/24 GB 或 null）。',
      }
    }
    cap = m.gb
  }

  let effective = req.gb
  let clampNote = ''
  if (req.gb === null) {
    effective = cap
    if (cap !== null) clampNote = '未提供具体档位，按 max 收敛到 ' + cap + ' GB'
  } else if (cap !== null && req.gb > cap) {
    effective = cap
    clampNote = '请求 ' + req.gb + ' GB 超过上限 ' + cap + ' GB，已收敛到上限档位'
  }

  const limited = effective !== null
  const mb = effective === null ? null : effective * GB_TO_MB
  const launchArgs = buildLaunchArgs(effective)

  const bits = []
  bits.push('kind=' + k + (known ? '' : '（未登记的 kind，按通用档位处理）'))
  if (effective === null) bits.push('未设显存上限（null，不写入 Infinity）')
  else if (effective === 0) bits.push('0 GB：纯 CPU / 权重不放进显存')
  else bits.push('建议上限 ' + effective + ' GB（折合 ' + mb + ' MB）')
  if (clampNote !== '') bits.push(clampNote)
  bits.push('launchArgs 是依据所选档位生成的建议启动参数，仅供生成启动命令时参考；'
    + 'ComfyUI 没有精确的按任务显存配额参数，本模块不保证、也不承诺实际显存占用。')

  return {
    ok: true,
    mb,
    limited,
    kind: k,
    gb: effective,
    launchArgs,
    reason: bits.join('；') + '。',
  }
}
