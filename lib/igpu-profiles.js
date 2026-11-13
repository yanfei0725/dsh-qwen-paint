/**
 * dsh-qwen-paint —— 核显（iGPU）型号档案：用户可选档位 + 可选自动下载
 * ============================================================================
 * ★ 2026-11-13 新增。用户明确要求：**把清单里的核显型号做成用户可选的选项**，
 *   并配一套「可选自动下载」；同时明确「不要试本机核显、不用跑实测」。
 *
 * ## 这个文件是什么
 *   · 一份**纯数据 + 纯函数**的型号档案（不联网、不探测硬件、不写文件、不跑模型）。
 *   · 安装脚本 `scripts/setup.mjs` 用它渲染选项列表；
 *   · `lib/config.js` 的 `assessLowEndReadiness()` 在用户指定了型号时透出对应建议；
 *   · 离线回归 `scripts/test-igpu-profiles.mjs` 锁住清单完整性与「默认不下载」。
 *
 * ## ⚠⚠ 三条诚实声明（务必保留，别改成「实测结论」）
 *   ① 下面每个 `reference` 里的秒数，来自用户提供的机型清单 / 社区公开分享，
 *      **本插件从未在任何一台核显机上实测过**（`unverified: true`）。
 *   ② 这些秒数测的是 **SD 1.5 / SDXL / Z-Image-Turbo / OpenVINO 示例**等
 *      **不同模型、不同分辨率、不同步数**，与本插件的 Qwen-Image 2.1 工作流
 *      **不可直接比较**（`comparable: false`）。它们只用来给用户一个量级感觉，
 *      **绝不替换** `assessLowEndReadiness()` 的 `speedTargetSec`。
 *   ③ 后端建议（DirectML / OpenVINO / ROCm）只是**路径说明**：换 PyTorch 后端
 *      要改用户自己的 ComfyUI 环境，插件**不自动改、不自动装**。
 *
 * ## 下载口径
 *   `IGPU_DOWNLOAD_CATALOG` 只描述「下什么、从哪下、按什么校验」，
 *   **默认不下**（`IGPU_AUTO_DOWNLOAD_DEFAULT = false`）。
 *   唯一的触发方式是用户显式给 `--igpu-download`（或交互里明确回答「下」）。
 *   大小与 sha256 取自服务器权威值（HF API 的 lfs.oid / Content-Length），不是估算。
 */

/** 所有可选型号的稳定 id（顺序 = 展示顺序，不强等于性能排序）。 */
export const IGPU_PROFILE_IDS = [
  'intel-arc-b390',
  'amd-780m',
  'intel-arc-140v',
  'intel-arc-140t',
  'amd-680m',
  'intel-iris-xe-96eu',
  'amd-760m',
  'amd-660m',
  'intel-uhd',
  'amd-8060s',
]

/**
 * 型号档案。
 *
 * 字段约定：
 *   id            稳定标识（CLI / 配置里用）
 *   vendor        'amd' | 'intel'
 *   name          面板上显示的名字
 *   arch          架构 / 规模
 *   cpus          代表处理器（用户提供，可能为空）
 *   rank          相对性能序号，越小越强（仅用于排序展示，**不是实测跑分**）
 *   backend       建议的推理后端 id（见 IGPU_BACKENDS）
 *   quant         建议的量化档 id（见 IGPU_QUANTS）
 *   resolution    建议的出图边长（用户明确要求核显机不要 1024，用 720）
 *   vramMode      建议的 ComfyUI 显存档（共享显存一律 lowvram）
 *   reference     { sec, workload, note } —— 用户提供 / 社区公开的量级参考
 *   notes         必须如实说明的边界
 */
export const IGPU_PROFILES = [
  {
    id: 'intel-arc-b390',
    vendor: 'intel', name: 'Intel Arc B390（Xe3，12 Xe3 核心）',
    arch: 'Xe3 / Panther Lake / 酷睿 Ultra 300 系', cpus: ['Core Ultra X9 388H', 'Core Ultra X7 358H'],
    rank: 1, backend: 'openvino', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: null, workload: '1080P 游戏性能对比', note: '28W 下比上代 Arc 140V 强 69%、比 Radeon 890M 强 62%，号称超过 RTX 3050（厂商/媒体口径，非出图秒数）' },
    notes: '用户清单里的旗舰级；无出图秒数，插件不编造。',
  },
  {
    id: 'amd-780m',
    vendor: 'amd', name: 'AMD Radeon 780M（RDNA3，12 CU）',
    arch: 'RDNA3 / 12 CU / 移动端', cpus: ['Ryzen 7 7840HS', 'Ryzen 7 8845HS'],
    rank: 2, backend: 'directml', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: 15, workload: 'Stable Diffusion 出图', note: '48 GB 内存、分配 16 GB 给核显的迷你主机，约 15 秒；性能接近 GTX 1650 Max-Q' },
    notes: '用户清单首选。桌面 7000/8000G 系列核显弱于同型号移动版，天花板同为 780M 级。',
  },
  {
    id: 'intel-arc-140v',
    vendor: 'intel', name: 'Intel Arc 140V（Xe2，Lunar Lake / 酷睿 Ultra 200V）',
    arch: 'Xe2 / 8 Xe2 核心', cpus: ['酷睿 Ultra 200V（Lunar Lake）'],
    rank: 3, backend: 'openvino', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: 54, workload: 'Z-Image-Turbo 单张 / OpenVINO SD1.5', note: 'Z-Image-Turbo 单张约 54 秒–1 分钟；OpenVINO SD 1.5 生成 16 张耗时 290.8 秒（平均 18.1 秒/张）' },
    notes: 'Intel 核显有 OpenVINO 官方加速路径，ComfyUI 配置相对简单。',
  },
  {
    id: 'intel-arc-140t',
    vendor: 'intel', name: 'Intel Arc 140T（Xe2，酷睿 Ultra 200H）',
    arch: 'Xe2 / 酷睿 Ultra 200H', cpus: ['酷睿 Ultra 200H'],
    rank: 4, backend: 'openvino', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: null, workload: '未给出单独出图秒数', note: '用户清单标注「性能略高于 140V，同样属于可用级别」' },
    notes: '无独立实测秒数，不套用 140V 的数字。',
  },
  {
    id: 'amd-680m',
    vendor: 'amd', name: 'AMD Radeon 680M（RDNA2，12 CU）',
    arch: 'RDNA2 / 12 CU / 移动端', cpus: ['Ryzen 7 6800H', 'Ryzen 7 7735HS'],
    rank: 5, backend: 'directml', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: 120, workload: 'AI 绘图（模型未注明）', note: '16 GB 内存笔记本上可能需要 2 分钟左右；性能接近 GTX 1050 Ti 移动版，跑 AI 绘图较吃力' },
    notes: '用户清单次选。',
  },
  {
    id: 'intel-iris-xe-96eu',
    vendor: 'intel', name: 'Intel Iris Xe Graphics（96EU）',
    arch: 'Xe-LP / 96EU / 11–14 代酷睿', cpus: ['i7-1165G7', 'i5-1240P', 'i7-1260P'],
    rank: 6, backend: 'openvino', quant: 'gguf-q4', resolution: 720, vramMode: 'save',
    reference: { sec: 12, workload: 'OpenVINO + ComfyUI 512×512', note: '512×512 约 12 秒；另有测试显示 SDXL 1024×1024 约 6 分 46 秒。12 代 96EU 比 11 代 80EU 强约 30%' },
    notes: '「能跑但比较慢」；两个秒数差 30 倍以上，说明分辨率/模型影响极大，不能当统一指标。',
  },
  {
    id: 'amd-760m',
    vendor: 'amd', name: 'AMD Radeon 760M（8 CU）',
    arch: 'RDNA3 / 8 CU', cpus: [],
    rank: 7, backend: 'directml', quant: 'gguf-q3-or-lighter', resolution: 720, vramMode: 'save',
    reference: { sec: null, workload: '未给出出图秒数', note: '接近 MX550 独显，性能尚可但 AI 算力有限' },
    notes: '入门可选；建议比 Q4 更轻的量化，但插件目前不预置更小模型文件（见 IGPU_QUANTS）。',
  },
  {
    id: 'amd-660m',
    vendor: 'amd', name: 'AMD Radeon 660M（6 CU）',
    arch: 'RDNA2 / 6 CU', cpus: [],
    rank: 8, backend: 'directml', quant: 'gguf-q3-or-lighter', resolution: 512, vramMode: 'ram',
    reference: { sec: null, workload: '未给出出图秒数', note: '680M 的缩减版，适合极轻量任务' },
    notes: '只建议 512 边长与更轻量化；不承诺 Qwen-Image 2.1 能流畅跑。',
  },
  {
    id: 'intel-uhd',
    vendor: 'intel', name: 'Intel UHD Graphics（11–14 代低配）',
    arch: 'UHD / 低配核显', cpus: [],
    rank: 9, backend: 'openvino', quant: 'gguf-q3-or-lighter', resolution: 512, vramMode: 'ram',
    reference: { sec: null, workload: '未给出出图秒数', note: '用户清单明确：UHD 系列在 AI 绘图上会非常吃力' },
    notes: '如实标注「非常吃力」，不粉饰；插件不会假装它能流畅出图。',
  },
  {
    id: 'amd-8060s',
    vendor: 'amd', name: 'AMD Radeon 8060S（Ryzen AI Max+ 395）',
    arch: 'RDNA3.5 / gfx1151 / 40 CU 级', cpus: ['Ryzen AI Max+ 395'],
    rank: 0, backend: 'rocm', quant: 'bf16-or-fp8', resolution: 720, vramMode: 'standard',
    reference: { sec: null, workload: 'SDXL / Flux 工作流（AMD 官方演示）', note: 'AMD 官方已支持 Windows 原生驱动它运行 ComfyUI，SDXL、Flux 等工作流都能跑' },
    notes: '特殊但很强的存在，AI 性能是另一个层级；设备定位与价格通常高得多。它是本机 ROCm 唯一官方支持的核显路线。',
  },
]

/** 后端路径说明：只描述，不自动改用户环境。 */
export const IGPU_BACKENDS = {
  rocm: {
    id: 'rocm', label: 'AMD ROCm（原生）',
    hint: '仅 Ryzen AI Max+ 395 / Radeon 8060S（gfx1151）有 AMD 官方 Windows 支持；普通消费级核显 ROCm 通常枚举不到。',
    changesEnv: false,
  },
  directml: {
    id: 'directml', label: 'DirectML（Windows）',
    hint: 'AMD 6000/7000 系核显的现实路径；需要另装 DirectML 版 PyTorch / ComfyUI 分支 —— 会改 Python 环境，插件不自动装。',
    changesEnv: true,
  },
  openvino: {
    id: 'openvino', label: 'Intel OpenVINO',
    hint: 'Intel 核显的官方加速路径，ComfyUI 里配置相对简单；需要对应的 OpenVINO 节点/后端，插件不自动装。',
    changesEnv: true,
  },
}

/** 量化档说明。⚠ 只有 gguf-q4 有校验过的可下载文件，其余只给方向。 */
export const IGPU_QUANTS = {
  'gguf-q4': {
    id: 'gguf-q4', label: 'GGUF Q4_K_M（约 4.6 GB）',
    file: 'qwen-image-2.1-UC-Q4_K_M.gguf', downloadable: true,
    hint: 'ComfyUI-GGUF 的 UnetLoaderGGUF 可用格式（general.architecture=qwen_image21）；需装 ComfyUI-GGUF 节点。',
  },
  'gguf-q3-or-lighter': {
    id: 'gguf-q3-or-lighter', label: 'GGUF Q3_K_M 或更轻（建议自备）',
    file: null, downloadable: false,
    hint: '更小的量化档确实存在，但本插件不预置文件、不自动下载；请把自备 .gguf 放进 models/unet，插件会按文件名自动挑。',
  },
  'bf16-or-fp8': {
    id: 'bf16-or-fp8', label: 'BF16 / FP8（大内存核显）',
    file: null, downloadable: false,
    hint: '8060S 这类大共享显存机型可考虑更高精度；插件按已装文件自动挑档，不静默换模型。',
  },
}

/** 默认不自动下载。改这里不能绕过 `--igpu-download` 的显式开关。 */
export const IGPU_AUTO_DOWNLOAD_DEFAULT = false

/**
 * 可选自动下载清单。
 * ⚠ size / sha256 是服务器权威值（HF API `lfs.oid` + `Content-Length`），不是估算。
 * ⚠ 第一优先源是**实测可达**的 hf-mirror 备份仓库；原 `abenzerps/...Uncensored-GGUF`
 *   已改名为 `abenzerps/Qwen-Image-2.1-Turbo-Quantized`，旧路径会 302→404。
 * ⚠ GGUF 头部已预检：magic=GGUF / version=3 / general.architecture=qwen_image21 /
 *   张量名 img_in.weight、transformer_blocks.*，**不含** model.diffusion_model.*
 *   （不是 stable-diffusion.cpp 那份加载不了的文件）。
 * ⚠ 但本机 ComfyUI-GGUF 的 IMG_ARCH_LIST 目前只有 `qwen_image`，与
 *   `qwen_image21` **严格名不匹配** —— 加载前可能需要把节点升级到识别该架构的版本。
 *   这一条如实保留，不假装「一定能加载」。
 */
export const IGPU_DOWNLOAD_CATALOG = [
  {
    id: 'qwen21-q4km',
    dir: 'unet',
    name: 'qwen-image-2.1-UC-Q4_K_M.gguf',
    size: 4604558112,
    sha256: 'e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41',
    note: 'Qwen-Image 2.1 GGUF Q4_K_M 主模型（核显 / 小显存档）',
    sources: [
      'https://hf-mirror.com/KasugaiSakura/Qwen-Image-2.1-Uncensored-Abenzerps-GGUF/resolve/main/qwen-image-2.1-UC-Q4_K_M.gguf',
      'https://huggingface.co/KasugaiSakura/Qwen-Image-2.1-Uncensored-Abenzerps-GGUF/resolve/main/qwen-image-2.1-UC-Q4_K_M.gguf',
    ],
    /** 下载前必须先确认的事实，失败就如实报缺件，不静默继续。 */
    requires: ['ComfyUI-GGUF 节点（UnetLoaderGGUF）', '节点支持 general.architecture=qwen_image21'],
  },
]

/** 精确查型号；传空/未知一律返回 null（绝不 fallback 成"看起来像"的型号）。 */
export function findIgpuProfile(id) {
  const key = String(id ?? '').trim().toLowerCase()
  if (key === '' || key === 'auto' || key === 'none') return null
  return IGPU_PROFILES.find((p) => p.id === key) ?? null
}

/**
 * 按设备名做**软匹配**，只用于「推荐选中哪一项」，不替用户做决定。
 * 返回 null 表示认不出来 —— 调用方应当把列表完整摆给用户自己选。
 */
export function matchIgpuProfile(deviceNames = []) {
  const text = (Array.isArray(deviceNames) ? deviceNames : [deviceNames])
    .map((x) => String(x ?? '')).join(' | ').toLowerCase()
  if (text === '') return null
  const rules = [
    [/8060s|radeon\(tm\) 8060|ai max\+ ?395/, 'amd-8060s'],
    [/arc b390|b390/, 'intel-arc-b390'],
    [/arc 140t|140t/, 'intel-arc-140t'],
    [/arc 140v|140v|lunar lake/, 'intel-arc-140v'],
    [/iris xe|iris\(r\) xe/, 'intel-iris-xe-96eu'],
    [/\buhd graphics|uhd\b/, 'intel-uhd'],
    [/780m/, 'amd-780m'],
    [/680m/, 'amd-680m'],
    [/760m/, 'amd-760m'],
    [/660m/, 'amd-660m'],
  ]
  for (const [re, id] of rules) if (re.test(text)) return findIgpuProfile(id)
  return null
}

/**
 * 把型号翻译成一份**可直接展示/落地**的建议。
 * 全部是建议值，不改任何配置文件、不下载任何东西。
 */
export function igpuPlanFor(id) {
  const p = findIgpuProfile(id)
  if (p === null) return null
  const backend = IGPU_BACKENDS[p.backend] ?? null
  const quant = IGPU_QUANTS[p.quant] ?? null
  return {
    profileId: p.id,
    name: p.name,
    vendor: p.vendor,
    backend: backend?.id ?? p.backend,
    backendLabel: backend?.label ?? p.backend,
    backendHint: backend?.hint ?? '',
    backendChangesEnv: Boolean(backend?.changesEnv),
    quant: quant?.id ?? p.quant,
    quantLabel: quant?.label ?? p.quant,
    quantHint: quant?.hint ?? '',
    resolution: p.resolution,
    vramMode: p.vramMode,
    precisionTier: 'gguf',
    reference: { ...p.reference, unverified: true, comparable: false,
      source: '用户提供的机型清单 / 社区公开分享（本插件未做任何核显实测）' },
    notes: p.notes,
    downloadable: Boolean(quant?.downloadable),
    /** 只是「有哪些东西可选」，不代表会下载。 */
    suggestedDownloads: quant?.downloadable
      ? IGPU_DOWNLOAD_CATALOG.filter((m) => m.name === quant.file).map((m) => m.id)
      : [],
    autoDownload: IGPU_AUTO_DOWNLOAD_DEFAULT,
  }
}

/** 给安装脚本渲染选项列表用（按 rank 排，8060S 单独置顶说明）。 */
export function listIgpuOptions() {
  return [...IGPU_PROFILES]
    .sort((a, b) => (a.rank === 0 ? -1 : b.rank === 0 ? 1 : a.rank - b.rank))
    .map((p) => ({ id: p.id, name: p.name, vendor: p.vendor, rank: p.rank,
      backend: p.backend, resolution: p.resolution, quant: p.quant,
      referenceSec: p.reference?.sec ?? null }))
}
