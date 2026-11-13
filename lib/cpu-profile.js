/**
 * CPU 指令集识别 + CPU 加速档位（**纯逻辑，零 I/O**）。
 *
 * ## 为什么单独一个模块
 *   `lib/index.js` 只剩 4.7 KB 余量、`lib/client.js` 只剩 290 B，而这块逻辑要
 *   能**离线单测**（不需要真 ComfyUI、不需要真 CPU 指令集）。所以全部做成
 *   纯函数：输入是 `os.cpus()` 之类的外部事实，输出是参数数组。
 *
 * ## 三条硬规矩（写死在实现里，不靠自觉）
 *
 * 1. **只输出 ComfyUI 官方 cli_args 里真实存在的开关。**
 *    已逐条核对 `comfy/cli_args.py`（2026-11-13，本机 ROCm 版 ComfyUI）：
 *      `--cpu`（"To use the CPU for everything (slow)"）
 *      `--lowvram` / `--highvram` / `--novram` / `--reserve-vram`
 *      `--use-pytorch-cross-attention` / `--use-quad-cross-attention` / ...
 *      `--preview-method <none|auto|latent2rgb|taesd>`
 *      `--bf16-unet` / `--bf16-text-enc` / `--fp32-unet` / ...
 *    **不存在**的东西一律不进这个文件：`n_threads`（ComfyUI-GGUF 的
 *    `UnetLoaderGGUF.INPUT_TYPES` 只有 `unet_name`）、GGUF 加载器的 `device=` /
 *    `dtype="int8"`（真实字段是 `dequant_dtype` / `patch_dtype` / `patch_on_device`，
 *    取值里没有 int8）。
 *
 *    ⚠⚠ **但 `QwenImage21Cache` 是真实存在的官方节点**，我第一版把它当成"编造的
 *    节点名"写进了这里，是**错的** —— 我当时搜的是第三方 `TE-Speed-QwenImage21`
 *    的 `.pyd`（那里面确实没有这个名字），而它是 ComfyUI 主程序自带的：
 *      `comfy_extras/nodes_qwen.py` 的 `class QwenImage21Cache(io.ComfyNode)`，
 *      输入正是 `device`（auto / gpu / cpu / off）+ `dtype`（default / int8 / int4）。
 *      官方 tooltip 原文：`cpu (RAM) is prefetched behind compute and costs little speed`、
 *      `int8 halves the cache at about bf16 accuracy`。
 *    本项目早就接好了：`cfg.qwenCacheDevice` / `cfg.qwenCacheDtype`
 *    → `lib/model-chain.js` 的 `prefixCacheNode()`。
 *    ⇒ 所以"device=cpu + dtype=int8"这条建议是对的，别和 GGUF 加载器混为一谈。
 *
 * 2. **实测 > 型号推断 > 未知。三者必须可区分。**
 *    有 CPU flags 就标 `isaEvidence: 'flags'`（实测）；
 *    只有型号就标 `'model'`（推断，`isaVerified: false`）；
 *    连型号都不认识就返回 `null` 而不是 `false` ——
 *    **"不知道"不等于"没有"**，拿 null 去当 false 用会静默关掉用户本来能用的加速。
 *
 * 3. **默认零漂移。**
 *    `mode:'off'` 时 `args` / `env` 必须是空数组，一个字节都不改现有启动参数。
 *
 * ## 线程数到底怎么钉
 *   用户资料里说「GGUF 加载器的 `n_threads` 设为物理核心数」—— 该字段**不存在**。
 *   真正控制 PyTorch CPU 线程的是 OpenMP / MKL 的**环境变量**：
 *      `OMP_NUM_THREADS` / `MKL_NUM_THREADS` / `OPENBLAS_NUM_THREADS`
 *   它们在 `startComfyHidden` 里以 `export K=V`（POSIX）/ `set K=V`（Windows .cmd）
 *   注入，两条启动路径都已支持。钉**物理**核心数而不是逻辑线程数，是因为
 *   SMT 兄弟线程争同一份执行端口，超线程跑 GEMM 通常反而慢。
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'

/** 用户可选的 CPU 加速档（顺序 = UI 展示顺序，从最保守到最激进）。 */
export const CPU_ACCEL_MODES = Object.freeze(['off', 'safe', 'balanced', 'max', 'force-cpu'])

export const CPU_ACCEL_DEFAULT_MODE = 'off'

/**
 * 每一档的**人话说明**。文案原则：
 *   · 说清楚"加了什么参数"（可核对）；
 *   · 说清楚"哪些是真加速、哪些只是省开销"（不吹）；
 *   · 说清楚"没实测"（本机没有 E5 / 12 核机可测）。
 */
export const CPU_ACCEL_MODE_INFO = Object.freeze({
  off: {
    id: 'off',
    label: '关闭（默认，零改动）',
    summary: '一个参数都不加，保持你现在能跑的启动方式。',
    changes: [],
    risk: 'none',
  },
  safe: {
    id: 'safe',
    label: '保守：关预览 + 钉线程',
    summary: '关掉采样预览、把 torch 线程钉到物理核心数。两项都不改计算结果。',
    changes: [
      '--preview-method none（ComfyUI 默认本来就是 none，这里是**显式锁死**，防止别处把预览打开偷算力）',
      'OMP_NUM_THREADS / MKL_NUM_THREADS = 物理核心数（不是逻辑线程数）',
    ],
    risk: 'low',
  },
  balanced: {
    id: 'balanced',
    label: '均衡：保守 + 换注意力后端',
    summary: '在保守档基础上显式指定 PyTorch 注意力实现。方向上通常更稳，但**速度未必更快**。',
    changes: [
      '--preview-method none',
      'OMP_NUM_THREADS / MKL_NUM_THREADS = 物理核心数',
      '--use-pytorch-cross-attention',
    ],
    risk: 'low',
  },
  max: {
    id: 'max',
    label: '激进：均衡 + BF16 精度',
    summary: '只有 CPU **实测**支持 AVX512_BF16 时才生效；否则自动降级到均衡档并如实告知。',
    changes: [
      '--preview-method none',
      'OMP_NUM_THREADS / MKL_NUM_THREADS = 物理核心数',
      '--use-pytorch-cross-attention',
      '--bf16-unet + --bf16-text-enc（需要 AVX512_BF16 硬件加速）',
    ],
    risk: 'medium',
  },
  'force-cpu': {
    id: 'force-cpu',
    label: '强制纯 CPU（--cpu）',
    summary: '完全不碰显卡，全部跑 CPU。会和显存档位互斥，插件自动把 --highvram/--lowvram 等摘掉。',
    changes: [
      '--cpu（自动摘掉显存参数与 GPU 专属注意力内核）',
      '--preview-method none',
      'OMP_NUM_THREADS / MKL_NUM_THREADS = 物理核心数',
      'QwenImage21Cache 的 device 改为 cpu（KV 缓存放内存、后台预取；dtype 不动）',
    ],
    risk: 'high',
  },
})

/**
 * 纯栈上会互相打架的参数（argparse `add_mutually_exclusive_group`）。
 * **同时挂两个 → ComfyUI 启动当场退出**，不是"其中一个生效"。
 * 本项目 2026-10 就踩过一次（`--use-quad-cross-attention` 误写成别的名字直接崩）。
 * 所以合并时必须按"后出现的胜出、同组其它成员删掉"裁决。
 */
const EXCLUSIVE_GROUPS = Object.freeze([
  ['--force-fp32', '--force-fp16'],
  ['--fp32-unet', '--fp64-unet', '--bf16-unet', '--fp16-unet',
    '--fp8_e4m3fn-unet', '--fp8_e5m2-unet', '--fp8_e8m0fnu-unet'],
  ['--fp16-vae', '--fp32-vae', '--bf16-vae'],
  ['--fp8_e4m3fn-text-enc', '--fp8_e5m2-text-enc', '--fp16-text-enc',
    '--fp32-text-enc', '--bf16-text-enc'],
  ['--use-split-cross-attention', '--use-quad-cross-attention',
    '--use-pytorch-cross-attention', '--use-sage-attention',
    '--use-flash-attention', '--use-ck-attention'],
])

/** `--cpu` 生效后这些显存相关参数全部失去意义（ComfyUI 内部也会忽略它们）。 */
const VRAM_FLAGS = Object.freeze([
  '--highvram', '--lowvram', '--novram', '--gpu-only', '--disable-smart-memory',
])

/**
 * **GPU 专属**的注意力内核。`--cpu` 模式下必须摘掉：
 *   它们都要在启动时 import 对应的 CUDA/HIP 扩展（sageattention / flash-attn / ck），
 *   纯 CPU 机器上 import 失败会让 ComfyUI **启动即崩**，而不是"忽略该参数"。
 * 注意保留 `--use-pytorch-cross-attention` / `--use-quad-cross-attention` /
 * `--use-split-cross-attention` —— 这三个是纯 PyTorch 实现，CPU 上合法可跑。
 */
const GPU_ONLY_ATTN = Object.freeze([
  '--use-sage-attention', '--use-flash-attention', '--use-ck-attention',
])

/** 后面还要跟一个值的参数（解析时必须把值一起吞掉，否则会被当成独立 flag）。 */
const VALUE_FLAGS = Object.freeze([
  '--reserve-vram', '--preview-method', '--preview-size', '--directml',
  '--temp-directory', '--input-directory', '--output-directory',
])

const VALUE_FLAG_SET = new Set(VALUE_FLAGS)
const VRAM_FLAG_SET = new Set(VRAM_FLAGS)
const GPU_ONLY_ATTN_SET = new Set(GPU_ONLY_ATTN)

/** 型号 → 指令集能力的**参考**规则。命中即用，`isaVerified` 恒为 false。 */
const CPU_FAMILY_RULES = Object.freeze([
  // ---- AMD ----
  {
    id: 'amd-zen45',
    label: 'AMD Zen 4 / Zen 5（Ryzen 7000/8000/9000、EPYC 9004/9005）',
    test: /ryzen\s*(?:ai\s*)?(?:max\+?\s*)?\d+\s*([789]\d{3})[a-z]{0,3}\b|epyc\s*9\d{3}/i,
    isa: { avx2: true, avx512f: true, avx512Bf16: true, amxBf16: false },
    note: 'Zen 4 起原生支持 AVX-512（含 AVX512_BF16）；Zen 5 延续。此结论按家族给，未逐型号实测。',
  },
  {
    id: 'amd-zen3',
    label: 'AMD Zen 3 及更早（Ryzen 5000 及以前、EPYC 7003 及以前）',
    test: /ryzen\s*(?:ai\s*)?(?:max\+?\s*)?\d+\s*[1-6]\d{3}[a-z]{0,3}\b|epyc\s*7\d{3}/i,
    isa: { avx2: true, avx512f: false, avx512Bf16: false, amxBf16: false },
    note: 'Zen 3 及更早只有 AVX2，没有 AVX-512 / BF16 硬件加速。',
  },
  // ---- Intel Xeon E 系（用户资料里提到的 E5）----
  {
    id: 'intel-xeon-e5-v34',
    label: 'Intel Xeon E5 v3 / v4（Haswell-EP / Broadwell-EP）',
    // ⚠ 型号串真实长相是 `Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz` ——
    //   `Xeon(R)` 与 `E5-` 之间还夹着 `CPU `，所以必须用 `.*?` 跨过去。
    //   第一版写成 `xeon\s*\(?r?\)?\s*e5-` 直接漏判，E5 落进 unknown（已修）。
    test: /xeon.*?\be5-\d{4}\s*v\s*[34]\b/i,
    isa: { avx2: true, avx512f: false, avx512Bf16: false, amxBf16: false },
    note: 'E5 v3/v4 有 AVX2，但**没有** AVX-512，更没有 AVX512_BF16 —— '
      + 'BF16 硬件加速在这两代上不存在，别开 max 档的 BF16。',
  },
  {
    id: 'intel-xeon-e5-v12',
    label: 'Intel Xeon E5 v1 / v2（Sandy Bridge-EP / Ivy Bridge-EP）',
    test: /xeon.*?\be5-\d{4}\s*v\s*[12]\b/i,
    isa: { avx2: false, avx512f: false, avx512Bf16: false, amxBf16: false },
    note: 'E5 v1/v2 连 AVX2 都没有（只有 AVX）。这一代跑 CPU 生图基本不具备可行性。',
  },
  // ---- Intel 消费级 ----
  {
    id: 'intel-core-ultra',
    label: 'Intel Core Ultra（Meteor Lake / Lunar Lake / Arrow Lake 等）',
    test: /core\s*\(?tm\)?\s*ultra/i,
    isa: { avx2: true, avx512f: false, avx512Bf16: false, amxBf16: false },
    note: 'Core Ultra 消费级**屏蔽了 AVX-512**（含 BF16 扩展），只有 AVX2 + AVX-VNNI。',
  },
  {
    id: 'intel-core-12-14',
    label: 'Intel Core 12/13/14 代',
    test: /1[234]th\s*gen\s*intel|intel.*core\s*\(?tm\)?\s*i[3579]-1[2-4]\d{3}/i,
    isa: { avx2: true, avx512f: false, avx512Bf16: false, amxBf16: false },
    note: '12 代起消费级大小核屏蔽 AVX-512，只有 AVX2。',
  },
  {
    id: 'intel-core-11',
    label: 'Intel Core 11 代（Tiger Lake / Rocket Lake）',
    test: /11th\s*gen\s*intel|intel.*core\s*\(?tm\)?\s*i[3579]-11\d{3}/i,
    isa: { avx2: true, avx512f: true, avx512Bf16: false, amxBf16: false },
    note: '11 代桌面（Rocket Lake）有 AVX-512，但**没有** BF16 扩展。',
  },
])

const ISA_KEYS = Object.freeze(['avx2', 'avx512f', 'avx512Bf16', 'amxBf16'])

/** 把 `cpuinfo` 风格的 flags 字符串 / 数组归一成 Set（大写、去 `avx512_` 前缀差异）。 */
function flagSet(input) {
  if (!input) return null
  const list = Array.isArray(input)
    ? input
    : String(input).split(/\s+/u)
  if (list.length === 0) return null
  const set = new Set()
  for (const raw of list) {
    const t = String(raw ?? '').trim().toLowerCase()
    if (t === '') continue
    set.add(t)
    // Linux 内核叫 `avx512_bf16`，也见过 `avx512bf16`；统一成后一种
    if (t.startsWith('avx512_')) set.add(t.replace('avx512_', 'avx512'))
  }
  return set.size > 0 ? set : null
}

/**
 * 从实测 flags 读指令集。**这是唯一能把 `isaVerified` 置 true 的路径。**
 * @param {Set<string>|null} set
 */
function isaFromFlags(set) {
  if (!set) return null
  const has = (...names) => names.some((n) => set.has(n))
  return {
    avx2: has('avx2'),
    avx512f: has('avx512f', 'avx512'),
    avx512Bf16: has('avx512bf16', 'avx512_bf16'),
    amxBf16: has('amx_bf16', 'amxbf16', 'amx-bf16'),
  }
}

/** 物理核心数：优先显式值，其次型号里的 "N-Core"，最后按 SMT 推断。 */
function resolvePhysicalCores(model, logicalCores, explicit) {
  const exp = Number(explicit)
  if (Number.isFinite(exp) && exp > 0) return { cores: Math.trunc(exp), source: 'explicit' }
  const m = String(model ?? '').match(/(\d+)\s*-\s*core\b/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0 && n <= 1024) return { cores: n, source: 'model' }
  }
  const ct = String(model ?? '').match(/(\d+)\s*c\s*\/\s*(\d+)\s*t\b/i)
  if (ct) {
    const n = Number(ct[1])
    if (Number.isFinite(n) && n > 0) return { cores: n, source: 'model' }
  }
  if (Number.isFinite(logicalCores) && logicalCores > 0) {
    // 有 SMT 时逻辑核通常是物理核的 2 倍；奇数逻辑核说明没有 SMT 或数据异常。
    const half = Math.ceil(logicalCores / 2)
    return { cores: half, source: 'inferred' }
  }
  return { cores: 0, source: 'unknown' }
}

/**
 * 采集 CPU 事实 —— **本文件唯一有 I/O 的函数**，其余全是纯函数（便于离线测）。
 *
 * ## 平台差异（必须说清楚，否则会以为"探测没用"）
 *   · **Linux**：读 `/proc/cpuinfo` 的 `flags` 行 → **实测**指令集，
 *     `detectCpuProfile` 会把 `isaEvidence` 标成 `'flags'`。
 *   · **Windows / macOS**：Node 是原生进程，读不到 `/proc/cpuinfo`（MSYS/Git Bash
 *     的 `/proc` 只是它自己的虚拟映射，Node 看不到）→ `flags` 为 null，退到
 *     **型号推断**（`'model'`）。要拿实测值请在目标机跑 `scripts/cpu-probe.mjs`
 *     （用 ComfyUI 自带 python 的 `torch.backends.cpu.get_cpu_capability()`），
 *     再把结果填进 `cpuFlags` 配置或 `physicalCores`。
 *
 * ⚠ 绝不在这里跑子进程：起进程探测会被沙箱拦、也违背"不擅自动用户环境"。
 */
export function collectCpuFacts() {
  const cpus = os.cpus()
  let flags = null
  let flagsSource = 'none'
  if (process.platform === 'linux') {
    try {
      const text = readFileSync('/proc/cpuinfo', 'utf8')
      const m = text.match(/^flags\s*:\s*(.+)$/mu)
      if (m && m[1].trim() !== '') {
        flags = m[1].trim()
        flagsSource = '/proc/cpuinfo'
      }
    } catch {
      // 精简容器 / 只读 procfs / WSL 边界情况：静默退到型号推断，不打扰用户。
    }
  }
  return {
    cpus,
    platform: process.platform,
    arch: process.arch,
    logicalCores: cpus.length,
    flags,
    flagsSource,
  }
}

/**
 * host 侧统一的画像入口（带缓存）。
 *
 * 为什么需要缓存：`apply()` 要按档位改工作流配置（QwenImage21Cache 的 device），
 * `startComfyHidden` 要按档位拼启动参数 —— 两处相隔很远，各探测一次纯属浪费
 * （`os.cpus()` + 读 `/proc/cpuinfo` + 型号正则跑两遍）。这里缓存一份，
 * 键 = 影响结果的入参组合，用户改了 cpuFlags / cpuPhysicalCores 会自动失效重算。
 *
 * ⚠ 只给 host 用。测试请继续直接用纯函数 `detectCpuProfile()`，
 *   别让缓存把"同一输入出不同结果"这种问题带进回归。
 */
let _profileCache = null

export function getCpuProfile(opts = {}) {
  const key = `${opts.flags ?? ''}|${opts.physicalCores ?? 0}`
  if (_profileCache && _profileCache.key === key) return _profileCache.profile
  const facts = collectCpuFacts()
  const profile = detectCpuProfile({
    cpus: facts.cpus,
    logicalCores: facts.logicalCores,
    flags: opts.flags || facts.flags,
    physicalCores: opts.physicalCores,
  })
  _profileCache = { key, profile }
  return profile
}

/**
 * 识别 CPU 画像。
 *
 * @param {object} [input]
 * @param {Array<{model?:string}>} [input.cpus]  `os.cpus()` 的返回值
 * @param {string[]|string} [input.flags]        实测 CPU flags（Linux `/proc/cpuinfo`、或 torch 探测）
 * @param {number} [input.physicalCores]         用户显式给的物理核心数
 * @param {string} [input.model]                 没有 cpus 时直接给型号
 * @param {string} [input.platform]              `process.platform`
 * @returns {object} 画像（永不抛异常）
 */
export function detectCpuProfile(input = {}) {
  const cpus = Array.isArray(input.cpus) ? input.cpus : []
  const model = String(input.model ?? cpus[0]?.model ?? '').trim()
  const logicalCores = Number(input.logicalCores ?? (cpus.length || 0)) || 0
  const set = flagSet(input.flags)
  const fromFlags = isaFromFlags(set)
  const rule = CPU_FAMILY_RULES.find((r) => r.test.test(model)) ?? null

  const isa = {}
  for (const k of ISA_KEYS) {
    if (fromFlags) isa[k] = fromFlags[k] === true
    else if (rule) isa[k] = rule.isa[k] === true
    else isa[k] = null // 未知 ≠ 不支持
  }

  const { cores, source } = resolvePhysicalCores(model, logicalCores, input.physicalCores)
  const isaEvidence = fromFlags ? 'flags' : (rule ? 'model' : 'unknown')

  const notes = []
  if (isaEvidence === 'model') {
    notes.push(`指令集按型号家族推断（${rule.label}），**未经本机实测**；`
      + '要确认请在目标机跑 `node scripts/cpu-probe.mjs`。')
  }
  if (isaEvidence === 'unknown') {
    notes.push('型号未识别 → 指令集三态全部为"未知"，插件**不会**据此关闭任何加速选项。')
  }
  if (source === 'inferred') {
    notes.push(`物理核心数按"逻辑核 ${logicalCores} ÷ 2"推断（结果 ${cores}）。`
      + '若你的 CPU 没有超线程，请显式指定 physicalCores，否则线程会被钉少一半。')
  }
  if (rule?.note) notes.push(rule.note)

  return {
    ok: model !== '' || logicalCores > 0,
    model,
    vendor: /amd|ryzen|epyc|athlon/i.test(model) ? 'amd'
      : (/intel|xeon|core\s*\(?tm\)?/i.test(model) ? 'intel' : 'unknown'),
    family: rule?.id ?? 'unknown',
    familyLabel: rule?.label ?? '未识别的型号',
    logicalCores,
    physicalCores: cores,
    physicalCoresSource: source,
    isa,
    isaEvidence,
    isaVerified: isaEvidence === 'flags',
    // ⚠ 三态：true / false / **null（未知）**。
    //   第一版写成 `isa.avx512Bf16 === true`，把 null 压成了 false —— 结果 max 档
    //   对"没识别出型号"的机器报"本机 CPU 不支持 BF16"，那是**编了个结论**。
    bf16Hardware: isa.avx512Bf16 === null ? null : isa.avx512Bf16 === true,
    amxHardware: isa.amxBf16 === null ? null : isa.amxBf16 === true,
    notes,
  }
}

/** 归一档位名；非法值一律回落 `off`（默认零漂移），不抛异常。 */
export function normalizeCpuAccelMode(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return CPU_ACCEL_MODES.includes(v) ? v : CPU_ACCEL_DEFAULT_MODE
}

/** 线程数：显式 > 物理核 > 0（0 = 不注入，交给 torch 自己决定）。 */
function resolveThreads(profile, opts) {
  const explicit = Number(opts.threads)
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit)
  const phys = Number(profile?.physicalCores)
  if (Number.isFinite(phys) && phys > 0) return Math.trunc(phys)
  return 0
}

/**
 * 生成某一档的启动参数 / 环境变量。
 *
 * @param {object} profile `detectCpuProfile()` 的结果
 * @param {object} [opts]
 * @param {string} [opts.mode]        档位（默认 off）
 * @param {number} [opts.threads]     显式线程数（覆盖物理核心数）
 * @param {boolean} [opts.oomFallback] OOM 兜底：允许追加 `--lowvram`
 * @param {boolean} [opts.bf16]       强制开/关 BF16（默认跟硬件能力走）
 * @returns {{mode:string,args:string[],env:Array<[string,string]>,threads:number,
 *   effectiveMode:string,notes:string[],skipped:Array<{item:string,reason:string}>}}
 */
export function cpuAccelPlan(profile, opts = {}) {
  const mode = normalizeCpuAccelMode(opts.mode)
  const threads = resolveThreads(profile, opts)
  const args = []
  const env = []
  const notes = []
  const skipped = []
  /** 工作流级覆盖（不是启动参数）：键名直接用 cfg 的字段名，方便 Object.assign。 */
  const workflowOverrides = {}
  let effectiveMode = mode

  if (mode === 'off') {
    return {
      mode,
      effectiveMode,
      args,
      env,
      threads: 0,
      workflowOverrides,
      notes: ['未启用 CPU 加速档 → 不加任何参数（零漂移）'],
      skipped,
    }
  }

  // ---- 所有非 off 档共同的"质量中性"部分 ----
  // `--preview-method none` 本来就是 ComfyUI 默认值，挂它的意义是**显式锁死**：
  // 一旦有人（或某个工作流节点）把预览打开，采样每一步都要多解码一次潜变量。
  args.push('--preview-method', 'none')
  notes.push('--preview-method none：关采样预览（默认值，这里是显式锁死，不改变出图结果）')

  if (threads > 0) {
    // 真正控制 PyTorch / MKL CPU 线程数的旋钮（不是 GGUF 节点的 n_threads）。
    for (const key of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS']) {
      env.push([key, String(threads)])
    }
    notes.push(`线程钉到 ${threads} 个**物理**核心（OMP/MKL/OpenBLAS 三个环境变量）；`
      + '用逻辑线程数会让 SMT 兄弟线程抢同一份执行端口，通常更慢')
  } else {
    skipped.push({ item: '线程数', reason: '拿不到物理核心数，交给 torch 自己决定（可显式指定 physicalCores）' })
  }

  // ---- force-cpu：完全不碰显卡 ----
  if (mode === 'force-cpu') {
    args.push('--cpu')
    notes.push('--cpu：全部算子跑 CPU（很慢，属于最后手段）；显存档位会被自动摘掉')
    // ★ 前缀 KV 缓存放哪：纯 CPU 模式下 `qwenCacheDevice='gpu'` 毫无意义
    //   （没有 GPU 上下文），官方给 `cpu` 的说明是「RAM 里后台预取，几乎不掉速」，
    //   所以这一档**强制**改成 cpu —— 这是档位定义的一部分，不是擅自改用户配置。
    //   `dtype` 保持不动：`int8` 本来就是本项目默认，动它会掉精度，不在"加速档"职责内。
    workflowOverrides.qwenCacheDevice = 'cpu'
    notes.push('QwenImage21Cache 的 device 已设为 cpu（官方说明：缓存放内存、后台预取、几乎不掉速）；'
      + 'dtype 保持你的配置不变（默认 int8，折半缓存、约 bf16 精度）')
    // `--lowvram` 在 `--cpu` 下毫无意义（权重本来就在系统内存里），明确拒绝。
    if (opts.oomFallback === true) {
      skipped.push({ item: '--lowvram', reason: '--cpu 模式下权重本来就在系统内存，--lowvram 无意义' })
    }
    return { mode, effectiveMode, args, env, threads, workflowOverrides, notes, skipped }
  }

  // ---- balanced 及以上：换注意力后端 ----
  if (mode === 'balanced' || mode === 'max') {
    args.push('--use-pytorch-cross-attention')
    // 诚实标注：这是"选实现"，不是"必快"。
    notes.push('--use-pytorch-cross-attention：显式指定 PyTorch 注意力实现。'
      + '**方向上更稳，但速度未必更快** —— CPU 上 sub-quadratic 对高分辨率也可能更优，'
      + '本项目未在 E5 / 12 核机上实测，请以自己的耗时为准')
  }

  // ---- max：BF16（严格看硬件）----
  //
  // 四分支必须分开写清楚，不能合并成 `want && hw` 两个条件 ——
  // 第一版就是合并写的，结果 E5（`bf16Hardware:false`）落进"用户显式关掉了 BF16"
  // 这个借口里，既没降级也没说真话。**"没表态"和"明确关掉"是两件事**。
  if (mode === 'max') {
    const hw = profile?.bf16Hardware
    if (opts.bf16 === false) {
      skipped.push({ item: 'BF16', reason: '用户显式关掉了 BF16' })
    } else if (hw === true) {
      args.push('--bf16-unet', '--bf16-text-enc')
      notes.push('--bf16-unet + --bf16-text-enc：CPU 实测支持 AVX512_BF16，BF16 走硬件加速')
    } else if (hw === false) {
      effectiveMode = 'balanced'
      skipped.push({
        item: 'BF16',
        reason: '本机 CPU 不支持 AVX512_BF16 → 强行开 BF16 会退化成模拟实现，通常更慢，已自动降级到均衡档',
      })
    } else {
      // 能力未知（型号未识别 / 未实测）：不擅自开，也不谎称不支持。
      effectiveMode = 'balanced'
      skipped.push({
        item: 'BF16',
        reason: 'BF16 能力未知（型号未识别或未实测）→ 不擅自开启，已降级到均衡档；'
          + '确认支持可显式传 bf16:true，或在目标机跑 scripts/cpu-probe.mjs 实测',
      })
    }
  }

  // ---- 可选：把前缀缓存也挪到内存（低显存机器受益）----
  //   默认**不动**：`qwenCacheDevice` 的默认值是 `auto`（有闲置显存就用显存），
  //   对独显机器来说 auto 才是最优。只有用户显式勾了才改成 cpu。
  if (opts.cacheOnCpu === true && workflowOverrides.qwenCacheDevice === undefined) {
    workflowOverrides.qwenCacheDevice = 'cpu'
    notes.push('QwenImage21Cache device=cpu：KV 缓存放系统内存、后台预取（省显存，官方称几乎不掉速）')
  }

  // ---- OOM 兜底 ----
  if (opts.oomFallback === true) {
    args.push('--lowvram')
    notes.push('--lowvram：OOM 兜底 —— 权重按需换入系统内存，不一次性占满。'
      + '注意它**不是**"把文本编码器交给 CPU"，只是改变权重的换入时机')
  }

  return { mode, effectiveMode, args, env, threads, workflowOverrides, notes, skipped }
}

/** 把参数数组拆成 `[{flag, value?}]`，值参数会吞掉后面的 token。 */
function tokenizeArgs(list) {
  const out = []
  const src = Array.isArray(list) ? list : []
  for (let i = 0; i < src.length; i += 1) {
    const flag = String(src[i] ?? '')
    if (flag === '') continue
    if (VALUE_FLAG_SET.has(flag)) {
      const value = src[i + 1]
      if (value !== undefined && !String(value).startsWith('--')) {
        out.push({ flag, value: String(value) })
        i += 1
        continue
      }
      out.push({ flag })
      continue
    }
    out.push({ flag })
  }
  return out
}

/**
 * 合并三路启动参数：注意力/厂商自动参数 + 显存档位 + CPU 档位。
 *
 * 三件事必须做对，否则 ComfyUI **启动即退出**（不是"其中一个生效"）：
 *   1. `--cpu` 出现 → 摘掉所有显存参数（`--highvram` / `--lowvram` / `--novram` /
 *      `--gpu-only` / `--disable-smart-memory` / `--reserve-vram X`）；
 *   2. 同一互斥组里只留**最后出现**的那个（cpuArgs 排最后 ⇒ 用户显式选的 CPU 档
 *      能真正覆盖厂商默认，而不是两个都挂着崩掉）；
 *   3. 同名 flag 去重（保留最后一次，位置取最后一次出现处）。
 *
 * @param {{autoArgs?:string[],vramArgs?:string[],cpuArgs?:string[]}} parts
 * @returns {string[]} 可直接交给 `main.py` 的参数数组
 */
export function mergeLaunchArgs(parts = {}) {
  const merged = [
    ...(Array.isArray(parts.autoArgs) ? parts.autoArgs : []),
    ...(Array.isArray(parts.vramArgs) ? parts.vramArgs : []),
    ...(Array.isArray(parts.cpuArgs) ? parts.cpuArgs : []),
  ]
  const tokens = tokenizeArgs(merged)
  const hasCpu = tokens.some((t) => t.flag === '--cpu')

  // ① --cpu 时摘显存参数 + GPU 专属注意力内核（后者不摘会让纯 CPU 机器启动即崩）
  let kept = hasCpu
    ? tokens.filter((t) => !VRAM_FLAG_SET.has(t.flag)
      && t.flag !== '--reserve-vram'
      && !GPU_ONLY_ATTN_SET.has(t.flag))
    : tokens.slice()

  // ② 互斥组：后出现者胜出
  for (const group of EXCLUSIVE_GROUPS) {
    const inGroup = kept.filter((t) => group.includes(t.flag))
    if (inGroup.length <= 1) continue
    const winner = inGroup[inGroup.length - 1].flag
    kept = kept.filter((t) => !group.includes(t.flag) || t.flag === winner)
  }

  // ③ 同名去重（保留最后一次）
  const seen = new Set()
  const dedup = []
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const t = kept[i]
    if (seen.has(t.flag)) continue
    seen.add(t.flag)
    dedup.push(t)
  }
  dedup.reverse()

  return dedup.flatMap((t) => (t.value === undefined ? [t.flag] : [t.flag, t.value]))
}

/** 环境变量对 → 便于日志展示的一行文本。 */
export function threadEnvSummary(plan) {
  const env = Array.isArray(plan?.env) ? plan.env : []
  return env.map(([k, v]) => `${k}=${v}`).join(' ')
}

/**
 * 给 UI / 端点用的结构化视图（**不含任何本机绝对路径**）。
 * @param {object} profile
 * @param {object} plan
 */
export function describeCpuAccel(profile, plan) {
  const info = CPU_ACCEL_MODE_INFO[plan?.mode ?? 'off'] ?? CPU_ACCEL_MODE_INFO.off
  return {
    schema: 'dsh-qwen-paint/cpu-accel@1',
    mode: plan?.mode ?? 'off',
    effectiveMode: plan?.effectiveMode ?? plan?.mode ?? 'off',
    label: info.label,
    summary: info.summary,
    risk: info.risk,
    args: Array.isArray(plan?.args) ? plan.args.slice() : [],
    env: Array.isArray(plan?.env) ? plan.env.map(([k, v]) => [k, v]) : [],
    threads: Number(plan?.threads ?? 0),
    // 工作流级覆盖（例如 QwenImage21Cache 的 device）。**单独一段**，
    // 不和启动参数混在一起 —— 前者改工作流节点输入，后者改进程启动开关，生效时机不同。
    workflowOverrides: { ...(plan?.workflowOverrides ?? {}) },
    notes: Array.isArray(plan?.notes) ? plan.notes.slice() : [],
    skipped: Array.isArray(plan?.skipped) ? plan.skipped.slice() : [],
    cpu: {
      model: String(profile?.model ?? ''),
      vendor: profile?.vendor ?? 'unknown',
      familyLabel: profile?.familyLabel ?? '',
      logicalCores: Number(profile?.logicalCores ?? 0),
      physicalCores: Number(profile?.physicalCores ?? 0),
      physicalCoresSource: profile?.physicalCoresSource ?? 'unknown',
      isa: { ...(profile?.isa ?? {}) },
      isaEvidence: profile?.isaEvidence ?? 'unknown',
      isaVerified: profile?.isaVerified === true,
      // 保持三态原样：null 表示"未知"，UI 要靠它把徽章画成虚线而不是灰掉。
      bf16Hardware: profile?.bf16Hardware ?? null,
      notes: Array.isArray(profile?.notes) ? profile.notes.slice() : [],
    },
  }
}
