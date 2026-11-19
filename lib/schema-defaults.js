// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-001（原 L1-10）

import path from 'node:path'
import { existsSync } from 'node:fs'
import { HIPFIRE_DEFAULTS } from './hipfire-img.js'
import { MAX_REFERENCE_IMAGES } from './reference-inputs.js'
import { OFFICIAL_TURBO_STEPS, OFFICIAL_EDIT_STEPS, OFFICIAL_TURBO_SIGMAS_8, OFFICIAL_EDIT_SIGMAS_9 } from './turbo-workflow.js'



const TURBO8_STEPS = 8
const DEFAULT_TURBO8_LORA = 'turbo8_lora_step2500.safetensors'
const BASE_STEPS = 25
const BASE_CFG = 2.5



/** 默认输出位置的**基目录**（桌面；没有桌面就退主目录，绝不硬造 Desktop）。 */
function defaultOutputBase() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  if (process.env.XDG_DESKTOP_DIR && existsSync(process.env.XDG_DESKTOP_DIR)) {
    return process.env.XDG_DESKTOP_DIR
  }
  for (const dir of [path.join(home, 'Desktop'), path.join(home, '桌面')]) {
    if (existsSync(dir)) return dir
  }
  return home
}

/** 成品落盘目录的**默认值**（`<桌面或主目录>/千问1生图`）。 */
function defaultOutputDir() {
  return path.join(defaultOutputBase(), '千问1生图')
}


const DEFAULTS = {
  /** ComfyUI 服务地址。默认本机回环；非回环地址会被 net-guard 拒绝（除非 allowRemoteComfy）。 */
  comfyUrl: 'http://127.0.0.1:8188',

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-4

  allowRemoteComfy: false,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-002（原 L53-69）
  referenceSearchEndpoint: '<API_ENDPOINT>',

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-5

  enabled: true,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-003（原 L76-93）
  drawTrigger: 'auto',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-004（原 L96-100）
  outputDir: defaultOutputDir(),
  /** resolveOutputDir() 回填的来源说明（仅供日志/面板展示，不必手配）。 */
  outputDirSource: '默认桌面目录',
// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-005（原 L104-110）
  comfyOutputDir: '',
  /** 三个千问模型文件（照抄 app.py 的常量）。 */
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-006（原 L117-129）
  turbo8Lora: DEFAULT_TURBO8_LORA,
  /** LoRA 强度。发布方按 1.0 训练；调到 0.65 左右会更"稳"但会丢风格，故默认 1.0。 */
  turbo8Strength: 1.0,
  /** turbo8 官方要求的采样位移（ModelSamplingFlux）。别乱改，改了就不是它的工作点。 */
  turbo8MaxShift: 0.6935,
  turbo8BaseShift: 0.5,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-007（原 L137-159）
  fast4Enabled: false,
  /**
   * 4 步蒸馏 LoRA 文件名。**留空 = 自动探测**（按 MODEL_HINTS.fast4 在 loras 目录里找）。
   * 探测不到 → 极速档在界面上显示为"不可用"并禁止打开（切了也出不来图）。
   */
  fast4Lora: '',
  /** 4 步档的采样位移。Lightning 蒸馏用的是 shift=3 ⇒ ln(3) ≈ 1.0986。 */
  fast4MaxShift: 1.0986,
  fast4BaseShift: 1.0986,
  /** 4 步档的步数。一般不用改（这是蒸馏模型的工作点）。 */
  fast4Steps: 4,
  /**
   * ★ 采样步数。`0` 或负数 = **跟随 turbo8 的 8 步**（默认）；
   * 写 1..60 的正数 = 用那个步数（离开 8 步会明显掉画质，除非你清楚在做什么）。
   *
   * ⚠ 要生效必须先关掉下面的 `forceTurbo8Steps` —— 它默认会把步数**强制**钉在 8。
   */
  turbo8Steps: 0,
  /**
   * 采样器要不要**强制**钉在 turbo8 的 8 步上（默认 true）。
   * false 时，上面 `turbo8Steps`（以及用户在工具参数里传的 steps）才会生效
   * —— 用于手工做步数对比。
   */
  forceTurbo8Steps: true,
// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-008（原 L184-193）
  turbo8Enabled: true,

  /* ------------------------------------------------ 官方 Turbo 工作点（0.18）---- */
  /**
   * 官方 `qwen_image_2.1_turbo_*` 主模型一旦探测到，默认优先于
   * 「基础模型 + turbo8 LoRA」链路。
   *
   * 文生图固定 8 步；编辑/重绘/移除/扩图固定 9 步（尾部 `0.150000`）。
   * 设 false 可强制回到旧 turbo8 链路。
   */
  officialTurboEnabled: true,
  officialTurboSteps: OFFICIAL_TURBO_STEPS,
  officialEditSteps: OFFICIAL_EDIT_STEPS,
  officialTurboSigmas: OFFICIAL_TURBO_SIGMAS_8,
  officialEditSigmas: OFFICIAL_EDIT_SIGMAS_9,

  /* ------------------------------------------------------- 任务 LoRA（可选）---- */
  /** 留空 = 自动探测 `Qwen2.1 一致性无偏移_GH*`。 */
  consistencyLora: '',
  consistencyStrength: 0.48,
  /** 留空 = 自动探测 `Qwen2.1_万物移除Remove_GH*`。 */
  removalLora: '',
  removalStrength: 1.0,
  /** 留空 = 自动探测 `Qwen2.1_扩图_GH_3750*` / `*outpaint*`。 */
  outpaintLora: '',
  outpaintStrength: 0.7,

  /* ------------------------------------------------ 裁剪回贴任务工作流（0.18）---- */
  /** 蒙版裁切时向外取多少倍上下文；1.3 表示四周各多取 30%。 */
  inpaintContextFactor: 1.3,
  /** 裁切前蒙版外扩像素，避免边缘残留。 */
  inpaintMaskGrow: 8,
  /** 回贴时的羽化像素。 */
  inpaintMaskBlend: 32,
  /** ★ 2026-11-13：蒙版反选（UI「反选蒙版」开关的真实落点）。
   *  默认 false = 保持历史行为逐字节不变；只有 UI 明确勾选才置 true。 */
  inpaintMaskInvert: false,
  /** 裁剪链进入采样前的最大画布长边；原图回贴不受此限制。 */
  taskMaxCanvasEdge: 2048,
  /** 回贴前做颜色匹配，缓解裁剪生成与原图的色差；节点/依赖缺失时自动跳过。 */
  taskColorMatch: true,
  taskColorMatchMethod: 'hm-mkl-hm',
  taskColorMatchStrength: 0.85,

  /** QwenImage21Cache（官方前缀 KV 缓存）：device + 存储精度。 */
  qwenCacheDevice: 'auto',
  qwenCacheDtype: 'int8',
  /** ★ 2026-10-09 新增：前缀缓存总开关（探测不到该节点时会自动跳过，一般不用管）。 */
  qwenCacheEnabled: true,
  /** ★ 2026-10-09 新增：TE-Speed 总开关（写成显式默认值，便于一眼看到）。
   *  设 false 时**整个 TESpeed 节点不接进链子**，模型直接由上一环进 KSampler。 */
  teSpeedEnabled: true,
// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-009（原 L246-252）
  baseSteps: BASE_STEPS,
  baseCfg: BASE_CFG,
  /**
   * ★ 2026-10-09 新增：能力探测结果的缓存时长（毫秒，默认 10 分钟）。
   *  探测要发 10 个轻量请求（本机共约 0.2s），缓存后连续出图不再重复探测。
   *  装了新节点/新模型想让探测立刻刷新：重启插件，或调小这个值。
   */
  capabilityCacheMs: 600000,
// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-010（原 L261-274）
  accelAutoInstall: true,
  /** TE-Speed 跳步缓存。`te_predictor` 每跳最多 1 步连续跳过；`speed` 是 2 步（更激进）。 */
  // ★ 总开关（见下面 `teSpeedEnabled`）：false 时**整个 TESpeed 节点不接进链子**。
  teSpeedAttention: 'kitchen_int8',
  teSpeedStepCache: 'te_predictor',
  teSpeedThreshold: 0.06,
  teSpeedStartPercent: 0.0,
  teSpeedEndPercent: 1.0,
  teSpeedErrorLimit: 0.08,
  teSpeedVerbose: false,

  /**
   * ★ 2026-10-09 实测新增：`QwenImage21Speedup`（frakd，MIT，纯 Python 无闭源件）。
   *   它挂在 DIFFUSION_MODEL/OUTER_SAMPLE wrapper 上，与 TE-Speed **实测可叠**
   *   （TE 10.741s → TE+Speedup 9.709s）。默认开。
   *   设 false 时整个节点不接进链子（该插件没装也不会导致整单拒收）。
   */
  speedupEnabled: true,
  speedupCacheThreshold: 0.30,
  speedupTargetError: 0.05,
  speedupStartPercent: 0.15,
  speedupEndPercent: 0.90,
  speedupMaxConsecutiveSkips: 3,
  speedupForecast: 'first',
  speedupCacheDevice: 'auto',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-011（原 L334-347）
  comfyAttentionBackend: 'auto',
  appleMpsFallback: true,
  appleMpsUnlimitedMem: false,

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-1


    // 设计说明已外置 → docs/schema-design-notes.md#anchor-2

  vaeTiling: 'auto',
  /** 分块尺寸（像素）。ComfyUI 默认 512；调小更省显存、更慢、接缝更多。 */
  vaeTileSize: 512,
  /** 相邻块的重叠像素。ComfyUI 默认 64；越大接缝越不明显、越慢。 */
  vaeTileOverlap: 64,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-012（原 L363-387）
  spectrumEnabled: false,
  /** 前 N 步强制走真实前向（给预测器攒历史）。8 步链路下默认 5 意味着只剩 1 步可跳。 */
  spectrumWarmupSteps: 5,
  /** 末尾 N 步强制走真实前向（收尾更稳）。 */
  spectrumTailActualSteps: 2,
  /** 保留多少个真实隐状态快照用于拟合。 */
  spectrumHistoryPoints: 5,
  /** 切比雪夫拟合的多项式阶数。 */
  spectrumChebyshevDegree: 3,
  /** 最多允许连续跳几步（越大越快、画质风险越高）。 */
  spectrumMaxConsecutiveForecasts: 1,
  /** 隐状态历史存放位置：`main_device`（最快）/ `offload_device` / `cpu`（省显存但可能吃掉提速）。 */
  spectrumCacheDevice: 'main_device',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-013（原 L402-419）
  sadaEnabled: false,
  /** SADA 节点的 class_type（comfyui-sada-icml 仓库提供）。可由配置覆盖。 */
  sadaNodeClass: 'SADASampler',
  /** 采样步数预算（上限）。SADA 在此范围内跳步。0 = 跟随主链路。 */
  sadaMaxSteps: 0,
  /** 跳步阈值（越大越激进、画质风险越高）。 */
  sadaThreshold: 0.15,
  /** 是否把 SADA 同时挂到 model + sampler（true = 真生效；false = 只挂 model）。 */
  sadaPatchSampler: true,

  // 2026-11-17：EasyCache（Core 实验节点）。参数照 nodes_easycache.py 真实签名；默认关，
  // 画质/收益未经本机 A/B，开启请自己单张对比；start/end 是采样进度 0..1。
  easyCacheEnabled: false,
  easyCacheReuseThreshold: 0.2,
  easyCacheStartPercent: 0.15,
  easyCacheEndPercent: 0.95,
  easyCacheVerbose: false,

  // 2026-11-17：分块重绘（默认关）。核心节点 SplitImageToTileList / ImageMergeTileList
  // 切块 + 正弦羽化合并；逐块采样显存更平稳，但块间语义连续性未经真机验证。
  tileInpaintEnabled: false,
  tileInpaintSize: 1024,
  tileInpaintOverlap: 128,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-014（原 L444-457）
  oomAutoFallback: true,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-015（原 L460-479）
  serialBatch: 'auto',

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-6

  upscaleAfter: 0,
  vulkanUpscalePath: '',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-016（原 L487-502）
  promptTrimEnabled: true,
  /** >0 时按字符数硬截断 prompt（会改变出图，默认 0 = 不截断）。 */
  maxPromptChars: 0,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-017（原 L507-524）
  blockCacheEnabled: true,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-018（原 L527-555）
  wrapperPolicy: 'auto',
  /**
   * auto 模式的分界（单位：latent token 数 = round(W/8) × round(H/8)）。
   *
   * 16384 = 1024×1024 的 latent（128×128）。实测依据：
   *   992×992  → 124×124 = 15376 tokens → 模型能常驻，总耗时 23.00 s（小尺寸策略对）
   *   1408×1408→ 176×176 = 30976 tokens → 显存吃紧换页，总耗时 79.70 s（该换 BlockCache）
   */
  wrapperAutoTokensThreshold: 16384,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-019（原 L566-589）
  rdna3FlashAttention: true,

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-9

  amdKernel: false,
  amdAsyncOffload: false,

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-10

  nvidiaSageAttention: 'auto',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-020（原 L601-620）
  nvidiaSageAttentionMode: 'performance',

  /** 残差差异阈值。0.03 = 官方推荐的图生图起点（调大更快但可能改姿态/细节）。 */
  blockCacheThreshold: 0.03,
  /** 缓存生效的采样区间（0.1~0.9 = 跳过首尾，首尾对结构最关键）。 */
  blockCacheStartPercent: 0.1,
  blockCacheEndPercent: 0.9,
  /** 最多连续命中几次（官方默认 2）。 */
  blockCacheMaxHits: 2,
  /** 缓存放哪（cpu 省显存；cuda 更快但吃显存）。 */
  blockCacheDevice: 'cpu',
  /** 误差度量的采样步长（官方默认 8）。 */
  blockCacheMetricStride: 8,
  /** 缓存上限 MB（官方默认 1024）。 */
  blockCacheMaxMb: 1024,
  /** 阈值策略（官方默认 two_stage）。 */
  blockCacheThresholdMode: 'two_stage',
  blockCacheSplitRatio: 0.35,
  blockCacheLateThreshold: 0.15,

  /** 默认步数 / 分辨率 / 单任务超时。 */
  steps: TURBO8_STEPS,
  resolution: 1024,
    // 设计说明已外置 → docs/schema-design-notes.md#anchor-7

  forceOptimizedSize: false,

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-3

  vramMode: 'auto',

    // 设计说明已外置 → docs/schema-design-notes.md#anchor-8

  textControl: 'auto',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-021（原 L656-670）
  precisionTier: 'auto',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-022（原 L673-683）
  mainModelOverride: '',
  loraOverride: '',
  controlnetOverride: '',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-023（原 L688-693）
  controlnetStrength: 0.8,
  controlnetStartPercent: 0.0,
  controlnetEndPercent: 1.0,

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-024（原 L698-702）
  timeoutMs: 600000,
  /** 轮询 ComfyUI 的间隔（毫秒）；自测里会调小。
   *  ★ 2026-10-10（提速 M7）：1200 → **400**。
   *    出图完成到被感知的延迟最多 = 一个轮询周期；本地 ComfyUI 多问几次代价可忽略，
   *    但"最后一秒才反应过来"的观感差别明显。 */
  pollIntervalMs: 400,
  /** 文件名前缀（落盘命名用）。 */
  filePrefix: 'Qwen2.1',
  /** ★ 空闲自动关停：出图后多久没再出图就关掉 ComfyUI（默认 5 分钟）。 */
  idleShutdownMs: 300000,
  /** 空闲检查的间隔。 */
  idleCheckMs: 30000,
  /** 关掉 ComfyUI 总开关（想一直留着就设 false）。 */
  autoShutdown: true,
  /** 状态探测的缓存时长，避免客户端每秒轮询都去敲 ComfyUI。 */
  statusCacheMs: 3000,
  /** ★★ 生图过程的动画（用户 2026-10-08 要求「使用户生图时可以自选动画」）。
   *   meteor = 现在这个马卡龙流星（默认，观感不变）；其余见 FLOW_STYLES。
   *   界面上的选择会**落盘**（见 uiStatePath），下次启动记得住。 */
  flowStyle: 'meteor',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-025（原 L724-729）
  aiPickBest: 'off',
  userPickBest: 'off',

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-026（原 L733-740）
  cpuAccel: 'off',
  /** 显式线程数；0 / 不填 = 用物理核心数，物理核也拿不到就不注入。 */
  cpuThreads: 0,
  /** 显式物理核心数。Windows 上 Node 拿不到准确值（只有逻辑核），可在这里写死。 */
  cpuPhysicalCores: 0,
  /** 显式指令集，如 `'avx2 avx512f avx512_bf16'`；填了就把"型号推断"升级成"按你给的算"。 */
  cpuFlags: '',
  /** BF16 三态：`null` = 跟硬件能力走（推荐）；`true` = 强制开；`false` = 强制关。 */
  cpuBf16: null,
  /** OOM 兜底：`true` 才允许追加 `--lowvram`（`--cpu` 模式下会被自动拒绝，因为无意义）。 */
  cpuOomFallback: false,
  /** 把 QwenImage21Cache 的 KV 缓存也挪到内存（`device: 'cpu'`）。
   *  默认 `false`：`auto`（有闲置显存就用显存）对独显机器才是最优，
   *  只有显存紧张、或你想把显存全留给采样时才打开。
   *  ⚠ `force-cpu` 档会**强制**设成 cpu —— 纯 CPU 下显存缓存毫无意义。 */
  cpuCacheOnCpu: false,

  /* ------------------------------------------------- hipfire 出图后端（★新） ---- */
  // ★★ 2026-10-08 新增：与 ComfyUI 并存的第二个出图后端，可通过配置切换。
  //   硬约束：**默认仍是 comfyui** —— 不改变任何现有行为。
  //   详见 lib/hipfire-img.js 顶部的长篇说明（协议细节、已知不支持项、两条通道）。
  ...HIPFIRE_DEFAULTS,
}


/* ------------------------------------------------- 生图意图判定提示词（★ 2026-10-09）---- */

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-027（原 L768-784）

// ===== moved from index.js: DRAW_INTENT_MODES (was lines 3850-3907) =====
const DRAW_INTENT_MODES = {
  off: {
    // 不做任何主动引导：只在用户**直接点名**要画图时才画。
    lead: '【生图】当用户**明确要求生成图片**（「画一张…」「生成图片」「来张图」等）时，调用 draw_image。',
    guard: '用户没有明确要求生成图片时，**不要**调用 draw_image —— 不要主动揣测生图意图。',
  },
  strict: {
    lead: '【生图】仅当用户**明确要求生成图片**（「画一张…」「生成一张…」「来张…」「给我做张图」等）'
      + '且**画面描述足够具体**时，调用 draw_image。',
    // ★ 2026-10-09：判定标准从"题材"改成"产物形态"（见下面 auto 里的说明）；
    //   "示意图"这个词已从排除清单删除 —— 它太宽，会把"数学示意图/艺术示意图"也挡掉。
    guard: '若用户只是**含糊提及**（没说要图、或没说画什么），**先问一句**再画，不要直接调用工具。'
      + '只有当请求明显是**可编辑的结构化图表**时才不属于本工具：流程图、思维导图、组织架构图、数据表。'
      + '注意：**题材**不决定归属 —— 「数学艺术画」「几何可视化」「物理示意图」要的仍是一张图像，照画。',
  },
  auto: {
    lead: '【生图】判断用户是不是想生成图片（「画个…」「生成一张…」「来张…」「给我做张图」'
      + '「用这张图做参考画…」等）—— 这是你**优先要判断的一件事**。一旦判断是生图请求，'
      + '你的**第一个动作就是调用 draw_image**。',
// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-028（原 L806-815）
    guard: '★ 判定标准是**产物形态**，不是题材：用户要的是"一张图像"还是"能改文字/数据的结构化图表"？'
      + '★ 要图像 → 调 draw_image。**题材完全不影响判断** —— 艺术画、插画、壁纸、概念图、'
      + '数学/几何可视化、物理示意图，哪怕带"图/示意/可视化"字样，要的都是一张图像，照画。'
      + '★ 只有**可编辑的结构化图表**才不走本工具：流程图、思维导图、组织架构图、数据表'
      + '（这些要能改文字、改数据，用文字或其它方式表达）。'
      + '★ **拿不准就画一张**：画错重画的成本，远低于"没画"或"自己用代码画"。',
    noAsk: '不要先写分析、不要先列参数、不要反问确认（**除非**用户完全没说画什么）；'
      + '可以只回一句极短的话，然后**立刻**调用工具。',
  },
  eager: {
    lead: '【生图】只要用户表达出想要画面的意思（「画个…」「来张…」「帮我弄张图」等），'
      + '就**主动**调用 draw_image —— 且**第一个动作就调用**。',
    guard: '只有用户明显要的是**可编辑的结构化图表**（流程图、思维导图、组织架构图、数据表）'
      + '或纯文字说明时才不画；其余情况下哪怕描述简短、哪怕是数学/几何/抽象题材，也**先画出来**再说。',
    noAsk: '不要反问、不要列参数、不要写分析 —— 直接回一句话然后调用工具。',
  },
}

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-029（原 L834-844）

// ===== moved from index.js: NO_SELF_DRAW_RULE (was lines 3908-3918) =====
const NO_SELF_DRAW_RULE =
  '★ **不许自己"画"图**：不要写 Python/Matplotlib/PIL、SVG、HTML/Canvas、Mermaid 或字符画'
  + '去生成用户要的那张图。出图**只能**通过 draw_image —— 绕过它自己去渲染属于**错误行为**。'
  + '（哪怕你觉得代码渲染"更精确/更可控"也不行：用户装这个插件就是为了用它出图。）'
  + '★ **别自作主张改需求**：不要因为"模型画的数学不精确"就擅自换成代码渲染，'
  + '也不要在出图后附加"要不要我改用代码画""要不要放大/换配色"这类追加方案 —— '
  + '先把图给用户，等用户开口再说。'

/**
 * 组装"生图意图"提示词段落。未知策略回落到 `auto`（默认档），不会抛错。
 */

// ===== moved from index.js: buildDrawIntentPrompt (was lines 3919-3943) =====
function buildDrawIntentPrompt(drawTrigger) {
  const mode = DRAW_INTENT_MODES[drawTrigger] ?? DRAW_INTENT_MODES.auto
  const parts = [
    // ── 最高优先级：意图判定 ──────────────────────────────────────────────
    mode.lead,
    mode.guard,
    // ★ 2026-10-09：铁律放在**意图判定之后、输出纪律之前** ——
    //   它比"怎么输出"更根本：先保证走对路（调工具），再管格式。
    NO_SELF_DRAW_RULE,
    // ── 输出纪律（四档共通）──────────────────────────────────────────────
    '★ **默认一次只生一张图**：一条消息里只调用一次 draw_image，不要连着调多次。'
      + '**仅当用户明确要求一次多张**（如"出 4 张让我选""给我几个版本"）时，'
      + '才在那一次调用里传 count=N（2-4），不要为凑数而多画。',
    '★ 出图后的回复正文**只保留那一句话，紧接着就是图片**：'
      + '不要写「耗时多少秒」「尺寸多大」「提示词是什么」「用的什么模型」这类附加说明，'
      + '也不要分小标题、不要列清单、不要总结。',
    '★ 生成期间界面上会自己播放动画、出图后平滑转成图片，**不需要用文字描述这个过程**。',
    '★ 识别到这是生图请求时，**思考过程保持极简** —— 界面上的思考块是**显示出来**的，'
      + '不要长篇分析风格/构图/参数，越写越长越碍事。',
  ]
  if (mode.noAsk) parts.splice(2, 0, mode.noAsk)
  return parts.join('')
}

/** 出图后"必须在正文内联展示图片"的固定段落（与 drawTrigger 无关，恒定生效）。 */

// ===== moved from index.js: INLINE_IMAGE_PROMPT (was lines 3944-3966) =====
const INLINE_IMAGE_PROMPT =
  '用 draw_image 出图后，必须在回复正文里用 Markdown 图片语法把生成的图直接展示给用户：'
  + '![画面简述](<图片的绝对路径>)。不要把图片路径放进代码块，也不要只给路径或链接而不给图。'

/* ------------------------------------------------- 优化状态诊断（★ 2026-10-09）---- */

// 设计说明已外置 → docs/schema-defaults-design-notes.md#schema-defaults-note-030（原 L893-909）

// ===== moved from index.js: describeOptimization (was lines 3967-4538) =====
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description:
        '画面描述，想画什么就写什么（中文可以）。建议写成一段完整、具体的话：主体 + 外观细节 + 环境 + 光线 + 风格 + 画质词。',
    },
    reference: {
      type: 'string',
      description:
        '参考图的本地文件路径（可选，单图兼容写法）。**给了就走图生图**：以这张图为参考，按 prompt 改姿势、换环境、换动作，'
        + '保持同一个角色和画风；不给就是普通文生图（只按文字描述画）。PNG / JPG / WEBP 都行。',
    },
    references: {
      type: 'array',
      maxItems: MAX_REFERENCE_IMAGES,
      items: { type: 'string' },
      description:
        `多参考图本地路径（可选，1-${MAX_REFERENCE_IMAGES} 张，按数组顺序接到 image_1…image_${MAX_REFERENCE_IMAGES}）。`
        + '与 `reference` 二选一；同时给时 `references` 优先。'
        + '第 1 张决定画布与主体，后面几张按序作为外观 / 场景 / 构图参考。'
        + '1-3 张走 TextEncodeQwenImageEditPlus（官方 Turbo 的编辑链），'
        + `4-${MAX_REFERENCE_IMAGES} 张走 TextEncodeQwenImage21 的 images.image_N。`
        + `超过 ${MAX_REFERENCE_IMAGES} 张会直接报错，不会静默丢弃。`,
    },
    controlImage: {
      type: 'string',
      description:
        'ControlNet 控制图的本地文件路径（可选）。**给了就走 ControlNet**：按这张图的结构（边缘/深度/姿态）'
        + '约束生成结果，比 reference 更能"锁结构"。⚠ 需先在优化面板里选好 ControlNet 权重，'
        + '且 ComfyUI 装有 ControlNetLoader / ControlNetApplyAdvanced 节点；缺任一条都不会生效（会如实说明）。',
    },
    controlStack: {
      type: 'array',
      maxItems: 4,
      description:
        '多 ControlNet 链式叠加（可选，最多 4 路）。每项是 { image, name, strength?, startPercent?, endPercent? }：'
        + 'image 是控制图本地路径；name 是 ControlNet 权重文件名（各路可不同）；strength/startPercent/endPercent 是该路'
        + '施加强度与起止区间（0–1，缺省用面板档）。各路按数组顺序串成 condition 链后接进 KSampler —— '
        + '这就是 Canny+Depth+OpenPose 同时叠加的接法。⚠ 任一路缺图或缺权重 will 跳过并在返回值 controlStackSkipped 里如实说明；'
        + '需 ComfyUI 装有 ControlNetLoader / ControlNetApplyAdvanced 节点。与单张 controlImage 可并存（单路先接，栈从其后串）。',
      items: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '控制图本地绝对路径（必填）' },
          name: { type: 'string', description: 'ControlNet 权重文件名（必填，来自 models/controlnet）' },
          strength: { type: 'number', description: '该路施加强度，默认 0.8' },
          startPercent: { type: 'number', description: '开始施加的采样百分比，默认 0' },
          endPercent: { type: 'number', description: '结束施加的采样百分比，默认 1' },
        },
        required: ['image', 'name'],
      },
    },
    size: {
      type: 'string',
      description: '画幅比例，可选：1:1（默认）、3:4、4:3、2:3、3:2、16:9、9:16。',
    },
    megapixels: {
      type: 'number',
      description: '总像素（百万），默认 1.0。想要更清楚就调大，例如 1.5 或 2.0。',
    },
    steps: {
      type: 'integer',
      description: '采样步数，范围 1-60，步数越高越精细、越慢。'
        + '官方 Turbo 链路固定为文生图 8 步 / 编辑 9 步；turbo8 LoRA 链路默认锁 8 步；'
        + '两种蒸馏链都会忽略本参数，改步数会破坏蒸馏工作点。'
        + '只有原生链路（textControl=native）才真正按本参数采样。',
    },
    seed: {
      type: 'integer',
      description: '随机种子。同一提示词 + 同一种子 = 同一张图；不填则每次都不一样。',
    },
    count: {
      type: 'integer',
      description:
        '一次产出几张图（默认 1，范围 1-4）。**默认就传 1（只出一张）**；'
        + '仅当用户**明确要求**一次多张（如"出 4 张让我选""给我几个版本"）时才传 2-4。'
        + '同一次调用出多张只加载一次模型，比连着调多次快得多。仅文生图支持；图生图会按 1 张处理。',
    },
    preset: {
      type: 'string',
      enum: ['default', 'portrait', 'anime', 'wallpaper'],
      description: '可选的轻量预设：default 保持原样；portrait 人像3:4；anime 动漫插画3:4；wallpaper 壁纸16:9。用户明确要求某类风格时才选择，不覆盖显式 size/megapixels。',
    },
    negative: {
      type: 'string',
      description: '负面提示词（不想要的内容）。注意千问模型 cfg=1，负面词基本不生效，一般不用填。',
    },
    referenceStrategy: {
      type: 'string',
      description:
        '角色参考约束策略（可选；不填 = 完全不改动工作流，行为与升级前逐字节一致）。'
        + "填 'auto' 时按后端 /object_info 的真实节点能力自动协商当前可用的最高级策略；"
        + '也可填具体策略 id（清单见 GET /api/comfy-pipeline/reference 返回的 strategies[].id）。'
        + '本能力与模型无关：协商不到专属适配器（IP-Adapter / ControlNet Reference 等，需配套权重）'
        + '时自动回落到「通用兜底」—— 生图用 参考图 → VAEEncode → KSampler.latent_image，'
        + '视频用 参考图 → I2V 起始关键帧，只用任何扩散模型都有的基础节点，对任意后端成立。'
        + '⚠ 需同时给 reference / references；只给本参数不给参考图不会生效。'
        + '联网检索参考图是独立能力，须用户每次显式同意，不受本参数控制。',
    },
    referenceControls: {
      type: 'array',
      maxItems: 8,
      description:
        '每张参考图的独立权重 / 区域绑定（可选，H2；需同时给 references + referenceStrategy）。'
        + '第 i 项对应第 i 张参考图：{ weight?: 0–1 软权重, startPercent?: 起始采样区间,'
        + ' endPercent?: 结束采样区间, mask?: 遮罩图本地路径, feather?: 0–1 羽化 }。'
        + '权重用本机 LatentComposite.feather 作软近似（**不是** IP-Adapter weight 的冒充）；'
        + 'mask 用 SetLatentNoiseMask / VAEEncodeForInpaint 绑定（按 /object_info 探测）。'
        + '缺节点或没给本参数时零漂移；start/end 无 per-reference 时序节点，只记录不假装生效。',
      items: {
        type: 'object',
        properties: {
          weight: { type: 'number', description: '0–1 软权重（1 = 完全影响）' },
          startPercent: { type: 'number', description: '起始采样区间（记录用，本机无每图时序门控）' },
          endPercent: { type: 'number', description: '结束采样区间（记录用）' },
          mask: { type: 'string', description: '遮罩图本地绝对路径（可选）' },
          feather: { type: 'number', description: '0–1 羽化，默认 = 1 - weight' },
        },
      },
    },
  },
  required: ['prompt'],
}

/** 结果 schema（标准 JSON Schema）。 */

// ===== moved from index.js: OUTPUT_SCHEMA (was lines 4586-4615) =====
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: '成品图片的绝对路径。' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    seed: { type: 'integer' },
    seconds: { type: 'number', description: '本次出图耗时（秒）。' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部图片路径。' },
    referenceMode: { type: 'string', description: '参考图模式：single / multi。' },
    referenceCount: { type: 'integer', description: '实际参与生成的参考图张数。' },
    referenceNote: { type: 'string', description: '多图未被当前链路支持时的如实说明。' },
  },
  required: ['path', 'width', 'height', 'seed', 'seconds', 'files'],
}

export {
  DEFAULTS,
  DRAW_INTENT_MODES,
  NO_SELF_DRAW_RULE,
  buildDrawIntentPrompt,
  INLINE_IMAGE_PROMPT,
  PARAMETERS,
  OUTPUT_SCHEMA,
  defaultOutputBase,
  defaultOutputDir,
  TURBO8_STEPS,
  DEFAULT_TURBO8_LORA,
  BASE_STEPS,
  BASE_CFG,
}
