/**
 * dsh-qwen-paint —— 参数 schema、默认值与生图意图提示词（2026-11-10 从 lib/config.js 拆出，P0a 腾门禁）。
 *
 * 只放纯数据（不依赖 GPU 探测 / ComfyUI 客户端）：
 *   DEFAULTS / PARAMETERS / OUTPUT_SCHEMA / DRAW_INTENT_MODES / NO_SELF_DRAW_RULE /
 *   buildDrawIntentPrompt / INLINE_IMAGE_PROMPT / defaultOutputBase / defaultOutputDir
 *   TURBO8_STEPS / DEFAULT_TURBO8_LORA / BASE_STEPS / BASE_CFG
 *
 * 行为完全不变：config.js re-export 这些名字，所有 import 方（index.js / describe.js）不用改。
 */

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

  /**
   * ★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）：是否允许 comfyUrl 指向**非本机**地址。
   *
   * 默认 `false` —— 插件只与本机（127.0.0.1 / localhost / ::1）的 ComfyUI 通信，
   * 启动时由 lib/net-guard.js 的 `assertLocalUrl` **强制校验**，配错直接拒绝启动。
   *
   * 设为 `true` 才允许连接局域网（如 192.168.1.100）或远程 ComfyUI ——
   * 这是"如实披露可配置的外部端点"：启用后插件会向你指定的地址发送提示词与图片数据，
   * 请自行确认那是你信任的机器。**普通用户不需要动这个开关。**
   */
  allowRemoteComfy: false,

  /**
   * ★★★ 2026-10-09：**插件总开关**（默认 true，装上即用）。
   *
   * `true`  → 注册 `draw_image`，并按 `drawTrigger` 的策略注入生图意图提示词。
   * `false` → **完全不介入**：不注册绘图工具、不注入任何提示词、不预热 ComfyUI、
   *           也不做空闲关停。插件对 DSH 相当于"不存在"。
   *
   * 用途：① 想临时关掉画图能力但不卸载插件；② 同一个 DSH 里跑多个图像后端时，
   * 避免本插件抢话；③ 排查问题时把插件整个摘出去，确认是不是它引起的。
   *
   * ⚠ 关掉后 `check_acceleration` / `list_available_models` 这两个**诊断类**工具
   *   仍然可用（它们只读、不画图）—— 否则出了问题连查都没法查。
   */
  enabled: true,

  /**
   * ★★★ 2026-10-09：**生图意图判定策略** —— 这是本轮"联动性"改造的核心。
   *
   * 背景：原来只靠一段很长的 systemPrompt 让模型"自己领悟"用户想不想画图。
   * 问题有两个：① 模型可能仍判断不准（该画时没画、不该画时去画）；
   * ② 用户说"帮我画个流程图"这类**指的不是本工具**时，会被误判成生图请求。
   *
   * 四档（由紧到松）：
   *   `'off'`    不做任何生图意图引导 —— 只在用户**明确点名**要画图时才会用到。
   *              适合"只想要个安静工具"的人。
   *   `'strict'` 只在用户**明确表达**要生成图片时才画（「画一张…」「生成图片」等），
   *              且要求**画面描述具体**；模糊的一律**先问一句**再画。
   *              适合怕误触发的人。
   *   `'auto'`（默认）**判断是生图请求就画**；但若请求**明显不属于本工具**
   *              （如"画个流程图/思维导图/表格"这类通常要文字或其它工具的场景），
   *              先澄清一句再决定。平衡"响应快"与"不误画"。
   *   `'eager'`  只要沾边就画（最积极）。适合确定自己只用它画图的人。
   */
  drawTrigger: 'auto',

  /** 成品落盘目录（工作区约定：一律放「千问1生图」）。 */
  // ★★ 2026-10-07：出图目录**不再硬编码**。原来写死 C:\Users\<你的用户名>\Desktop\千问1生图，
  //    有两个问题：① 泄露 Windows 用户名（发出去的包里带着它）；
  //    ② **别人装上后用不了** —— 那个目录在他们机器上不存在，出图会写失败。
  //    改成按当前用户的桌面推算，profile 里显式配了 outputDir 时仍以配置为准。
  outputDir: defaultOutputDir(),
  /** resolveOutputDir() 回填的来源说明（仅供日志/面板展示，不必手配）。 */
  outputDirSource: '默认桌面目录',
  /**
   * ComfyUI 自己的 output 目录。**留空（默认）= 直接走 /view**（推荐、通用）。
   *
   * ★ 通用化：原默认写死某个绝对路径，那只对作者机器有意义
   *   —— 别人装到别处必然"先白读一次失败、再走 /view"。取图本来就以 `/view` 为准
   *   （见 fetchImageBytes 的说明），本地目录只是老版本 ComfyUI 的兜底，留空即可。
   */
  comfyOutputDir: '',
  /** 三个千问模型文件（照抄 app.py 的常量）。 */
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',

  /* ------------------------------------------------- 加速链（★ 2026-10-08 默认开启） ----
   * ★★★ 默认链路：turbo8 八步 LoRA + 官方 int8 前缀缓存 + TE-Speed 跳步缓存。
   *   本机稳态实测：91.6s（原 30 步基线）→ 9.7s，**快 89%**。
   *   其中 turbo8 是大头（→12.6s），TE-Speed 再省 23%（→9.7s）。
   *   ⚠ 首次出图还要额外 ~12s 加载模型（20 GB），那部分不是这条链的开销。
   *
   *   想完全退回**改动前**的老链路（25 步、无 LoRA、无缓存）：
   *     ① 先把下面 `forceTurbo8Steps` 设为 false、`turbo8Steps` 设为 25；
   *     ② 再把 `turbo8Lora` / `qwenCacheDtype` / `teSpeed*` 一并还原（LoRA 与缓存
   *        两个节点现在是**无条件**接在链子上的，只改步数并不能回到老状态）。
   *   简言之：这组开关是**微调**用的，不是一键开关。
   */
  /** turbo8 八步蒸馏 LoRA 文件名。留空 = 用内置默认 `turbo8_lora_step2500.safetensors`。 */
  turbo8Lora: DEFAULT_TURBO8_LORA,
  /** LoRA 强度。发布方按 1.0 训练；调到 0.65 左右会更"稳"但会丢风格，故默认 1.0。 */
  turbo8Strength: 1.0,
  /** turbo8 官方要求的采样位移（ModelSamplingFlux）。别乱改，改了就不是它的工作点。 */
  turbo8MaxShift: 0.6935,
  turbo8BaseShift: 0.5,

  /* ---------------------------------------------------------------- 极速档（4 步）---- */
  /**
   * ★★★ 2026-10-12（用户要求）：**极速档（4 步）** —— 默认关。
   *
   * 开启后整条链换成「4 步蒸馏」的工作点：步数 4 + 4 步 LoRA + 配套采样位移。
   *
   * ## 实测（2026-10-12 真机 A/B，1024²、CFG 1.0、热态）
   *   · 8 步 turbo8：**12.1 s**（热、不切 LoRA）
   *   · 4 步 Lightning：**6.0 ~ 7.5 s**
   *   ⇒ 约 **1.6 ~ 2×** 提速（步数只砍采样段；模型加载/VAE 解码/落盘不受影响）
   *
   * ## ⚠⚠ 代价（必须让用户知道，界面上也写了）
   *   **画面里有文字就会崩。** 实测同一 prompt、同一 seed：
   *   8 步能正确写出「午后」，4 步直接变成乱码。
   *   文字渲染是 Qwen-Image 的招牌能力，4 步蒸馏把它牺牲掉了。
   *   ⇒ 只适合"要快、画面里不需要文字"的场景。
   *
   * ## ⚠ 采样位移必须跟着换
   *   Lightning 官方 README 写明 `shift=3 in distillation`（`base_shift = max_shift = ln3`），
   *   而 turbo8 的工作点是 `ln2 ≈ 0.6935`。**拿 shift=2 跑 shift=3 蒸馏的 LoRA，
   *   画质会明显崩**（糊、五官走形）—— 实测同 seed 对比，换对位移后明显回血。
   *   所以这两个值必须与 LoRA 一起切换，不能只改步数。
   */
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
  /**
   * ★★ 2026-10-09 通用化新增：**turbo8 整条链的总开关**（默认开）。
   *
   * 与 `teSpeedEnabled` / `speedupEnabled` 的区别：那两个只管各自的节点，
   * 这个管"turbo8 这条链"整体（LoRA + ModelSamplingFlux + 8 步 / CFG 1）。
   * 设 false 会退回千问原生链路（`baseSteps` 步 / `baseCfg` CFG，默认 25 步 / 2.5）。
   *
   * ⚠ 一般**不需要**手动关它 —— 探测不到 turbo8 LoRA 时插件会自动降级（见 probeCapabilities）。
   *   这个开关是留给"我想强制对比原生画质"的场景。
   */
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
  /**
   * ★★ 2026-10-09 通用化新增：**没有 turbo8 时的回退采样参数**。
   *
   * 别人机器上没装 turbo8 LoRA 时（探测不到 → basic 档），绝不能还按 8 步 / CFG 1 跑
   * —— 那是 LoRA 的工作点，缺 LoRA 会得到一张糊图。此时用这里的两项，
   * 即千问原生工作点：25 步 / CFG 2.5。调用方显式传 steps 时仍以调用方为准。
   */
  baseSteps: BASE_STEPS,
  baseCfg: BASE_CFG,
  /**
   * ★ 2026-10-09 新增：能力探测结果的缓存时长（毫秒，默认 10 分钟）。
   *  探测要发 10 个轻量请求（本机共约 0.2s），缓存后连续出图不再重复探测。
   *  装了新节点/新模型想让探测立刻刷新：重启插件，或调小这个值。
   */
  capabilityCacheMs: 600000,
  /**
   * ★★ 2026-10-09：**自动配置厂商专用加速环境**（默认 true）。
   *
   * `true`  → 插件加载后**自动检测**本机缺哪个厂商专用加速包，缺就**自动下载安装**
   *           （白名单内、且仅当前平台适用的那些，见 `ACCEL_PACKS` / `packAppliesToOs`）。
   *           全过程在后台跑、失败只写日志，**绝不影响出图**。
   * `false` → 只报告不下载，需要时手动调 `check_acceleration(action:'install')`。
   *
   * ★ 发行包体积说明：包里**只带这套"下载器"逻辑，不预置任何已下载的文件** ——
   *   所以必须真的到网上去取。这也是包只有 ~500 KB 的原因（大头是 UI 动画）。
   *
   * ⚠ 会真的改动用户环境（git clone / pip install 第三方代码），
   *   介意的话设为 false 即可 —— 出图功能不受任何影响，只是少了厂商专用加速。
   */
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

  /**
   * ComfyUI 启动时的**注意力后端**参数。
  //
  // ## 结论：在千问 2.1 上做不了 —— 是接口设计问题，不是配置问题
  //   内建 `TomePatchModel` 当场崩：
  //       TypeError: tomesd_m() got an unexpected keyword argument 'pe'
  //   （老契约 = 位置参数 + 返回 tuple；千问 = 关键字 `pe` + 返回 dict。
  //     **N 卡同样会崩**，与显卡/系统无关。）
  //
  //   自己重写兼容层，逐个插入点试了三条路，全部走不通：
  //   ① `set_model_attn1_patch`
  //      千问**没有实现 `attn1_output_patch`**（grep 全 comfy/ldm：
  //      flux/layers.py、krea2/model.py、modules/attention.py 有；
  //      qwen_image21/model.py **一处都没有**），
  //      而 `_gated_residual`（model.py:130）要求注意力输出行数严格等于输入 N：
  //          x[:, prefix_len:].addcmul_(y[:, prefix_len:], g_target)
  //      → 合并后无人负责还原 → 必抛形状错。
  //   ② `patches_replace[("single_block", i)]`
  //      `block_wrap`（model.py:400-402）用的是**闭包捕获的 attn_fn**，
  //      根本不读 `args["attn_fn"]` → 改 args 完全无效。
  //      （实测证据：block_replace 命中了，但 attn_fn 内部零日志。）
  //   ③ 劫持 `block_causal_attention`（monkey-patch）
  //      实测 64 次调用**全部直通**，日志恒为 `N=4124 P=4124 n_target=0`。
  //      根因：本机开了**前缀缓存**，目标段走的是 `prefix_cached_attention`
  //      （model.py:397），被劫持的那个函数只在"未开缓存"时才是主路径。
  //
  // ## 为什么不继续试第四条路
  //   收益上限本就低：本机已开 Turbo8 8 步 + TE-Speed + `--use-quad-cross-attention`，
  //   注意力已不是瓶颈。继续改千问源码级接口，风险 > 收益。
  //
  // ⚠ 插件 `QwenToMe-QwenImage21` 节点**保留**（不卸载），默认 `ratio=0` = 纯直通。
  //   上述全部诊断都写在插件源码注释里，供将来（千问后续版本）参考。

  /**
   * ComfyUI 启动时的**注意力后端**参数。
   *   这是实测唯一有效的启动参数轴（两轮独立复现，RX 7900 XT / ROCm）：
   *     'quad'    → `--use-quad-cross-attention`   10.739s →  9.328s（**+15.1%**）
   *     'pytorch' → `--use-pytorch-cross-attention` 10.739s → 10.766s（−0.3%，无效）
   *     'default' → 不加任何参数                    10.739s
   *   满叠栈（TE + Speedup）上 quad 仍有效：9.709s → 8.278s（+17.3%）。
   *   画质无损（同 seed PSNR 39.5/41.4 dB，清晰度 166.3 vs 基线 164.6）。
   *
   * ★★ 2026-10-09 通用化：默认值由写死的 'quad' 改为 **'auto'** ——
   *   上面那 +15% 是 **AMD / ROCm** 上的结论，N 卡未必有、个别版本还可能直接不支持。
   *   'auto' 会在启动前查一次 GPU 厂商：AMD / Radeon / ATI → quad，其余 → 不加参数。
   *   想固定就显式写 'quad' / 'pytorch' / 'default'。
   */
  comfyAttentionBackend: 'auto',

  /**
   * ★★★ 2026-10-12 新增：**macOS / MPS 的两个专属开关**（只在 Mac 上生效）。
   *
   * 为什么它们不是启动参数而是**环境变量**：PyTorch 的 MPS 行为是通过环境变量调的
   * （官方 "MPS Environment Variables" 文档），ComfyUI 没有对应的命令行开关。
   * 所以插件需要在**拉起 ComfyUI 进程时**把变量注入进去 —— 这是本轮新增的能力
   * （此前插件一个环境变量都不注入）。
   *
   * ① `appleMpsFallback`（默认 **true**）→ 注入 `PYTORCH_ENABLE_MPS_FALLBACK=1`
   *    PyTorch 官方 MPS 变量：MPS 后端**未实现**的算子自动回退 CPU 执行。
   *    为什么默认开：没有它时，链路里只要碰到一个 MPS 未实现的算子，
   *    **整次出图直接抛错**（不是慢一点，是失败）。
   *    它只影响"本来就会失败"的路径 —— 对已支持的算子**不改变任何数值结果**，
   *    属纯健壮性兜底，不涉及画质取舍。
   *
   * ② `appleMpsUnlimitedMem`（默认 **false**）→ 注入 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
   *    官方默认 **1.7**（相对 `recommendedMaxWorkingSetSize` 的倍数，是**硬上限**）；
   *    设 `0.0` = **取消上限**，允许用满统一内存。
   *    用途：大模型（例如本插件这条 13.5 GB 的千问链路）在内存较小的 Mac 上
   *    本来会直接 OOM，开了它**可能就能跑**。
   *    ⚠ 为什么默认关：官方原文 —— 取消硬上限后若发生**系统级 OOM**，
   *      "may cause system failure"。这是"用稳定性换可用性"的取舍，必须由用户自己决定。
   *
   * ③ 只在 macOS 注入：其它平台没有 MPS 后端，注入这两个变量没有任何意义。
   */
  appleMpsFallback: true,
  appleMpsUnlimitedMem: false,

  /**
   * ★★★ 2026-10-12 新增（来自用户反馈）：**VAE 大图分块解码**，防 OOM。
   *
   * ## 为什么需要（有第三方源码依据，不是猜的）
   *   `ComfyUI-VOSR2/tiled_vae.py` 的文件头注释原文：
   *   > "Full-image VAE encode/decode of large inputs can **OOM**
   *   >  (the **Qwen VAE runs in fp32 internally**); this bounds peak memory to one tile's."
   *   —— Qwen 的 VAE 内部以 **fp32** 跑，大尺寸整图解码的显存峰值会失控。
   *
   * ## 怎么做（**零新增依赖**）
   *   ComfyUI **自带** `VAEDecodeTiled`（`nodes.py`，界面名 "VAE Decode (Tiled)"），
   *   直接把工作流里的 `VAEDecode` 换成它即可，不用装任何东西。
   *   ⚠ 不用第三方 VOSR2 的 tiled VAE 作为默认路径 —— 那个要额外选模型、依赖更重；
   *     自带节点已经够用，且**没装也不影响**（探测不到就自动回退）。
   *
   * ## 三档（为什么默认是 auto 而不是 on）
   *   `'auto'` —— **只在"显存紧 + 尺寸大"时**才切分块：
   *     判据是 `显存 < 16 GB 且 像素数 > 1024²`（见 resolvePlan 的注释）。
   *     理由：分块解码带 overlap 重叠，接缝通常无感但**不是逐位相同**，
   *     与本项目"不牺牲原生画质"的原则相权衡 —— **不该在不需要的机器上无条件启用**。
   *   `'on'`  —— 无条件分块（20 GB 卡跑 2K+ 图时也可能想手动开）。
   *   `'off'` —— 永不（显式关，连 auto 都不判）。
   *   ⚠ 无论哪档，**探测不到 `VAEDecodeTiled` 时一律回退到 `VAEDecode`**（绝不发一个节点不存在的单）。
   */
  vaeTiling: 'auto',
  /** 分块尺寸（像素）。ComfyUI 默认 512；调小更省显存、更慢、接缝更多。 */
  vaeTileSize: 512,
  /** 相邻块的重叠像素。ComfyUI 默认 64；越大接缝越不明显、越慢。 */
  vaeTileOverlap: 64,

  /**
   * ★★★ 2026-10-12 新增（来自用户反馈）：**Spectrum 跳步加速**（跳过冗余 Qwen 前向）。
   *
   * ## 2026-10-12 真机实测（_spectrum_ab.mjs，1024² turbo8 链）
   *   | 变体 | 中位耗时 | vs 基线 |
   *   | --- | --- | --- |
   *   | A 基线（不接 Spectrum） | 13.1 s | — |
   *   | B Spectrum 默认（warmup=5 / tail=2） | 18.2 s | **+5.1 s（−27.7%）** |
   *   | C Spectrum 针对 8 步调（warmup=2 / tail=1） | 17.2 s | **+4.1 s（−23.4%）** |
   *   **结论：在 8 步 turbo8 链上，预测器自身开销 > 跳步收益 ⇒ 更慢**。
   *   ⇒ 默认**关**，且**实测数据替代 README 的乐观数字**。
   *   推断：≥ 20 步的原生链可能**会**有收益（可跳步数多）—— 本轮没测；
   *   那边有收益也仍然是**叠加项**，得**先对比**再定默认值。
   *
   * ## 默认关的其他理由
   *   ① 节点作者自述 *"not a paper-exact universal Qwen port"*、**不保证通用兼容**，且
   *      *"does not score image quality for you"* —— **它不替你评估画质**（本次 1024² 对比
   *      肉眼没差，但更大尺寸 / 更复杂 prompt 未必）。
   *   ② 它的默认 `warmup_steps=5` + `tail_actual_steps=2` 是给**常规步数**调的；turbo8 的 8 步
   *      链被吃掉 7 步，**只剩 1 步可跳**，预测器开销反而成了主要成本 —— 上面的数字就是证据。
   *   ③ 与 TE-Speed / Speedup / BlockCache **叠加**后的画质影响，本项目**没有实测数据**。
   *
   * ⇒ 打开方式：把 `spectrumEnabled` 设为 true（或点面板开关）。想更激进可以调小
   *   `spectrumWarmupSteps` / `spectrumTailActualSteps` —— ⚠ 越激进画质风险越高。
   */
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

  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文
   *   "Stochastic Adversarial Diffusion Acceleration"，arXiv 2507.17135）。
   *
   * 思路与 Spectrum 同源（跳过冗余 Qwen transformer 前向），但**走的是新的采样分布**
   * 而非仅靠历史外推；ComfyUI 实现见 `liming123332/comfyui-sada-icml`。
   *
   * ⚠ 必须如实告知的边界（与 Spectrum 同）：
   *   ① 本插件**没有自动下载**该节点 —— 装不装由用户决定（GDPR/版权/审慎）。
   *      缺件时回落到基础链路（实测已有 9 倍提速，叠加收益需自行 A/B）。
   *   ② 节点作者没给出 Qwen-Image 2.1 的画质保证 —— **必须先单张对比**。
   *   ③ 论文的 "1.2–2.0×" 是基准对比，**不是**本项目的工作点；本链只有 8 步
   *      （turbo8）/ 4 步（Lightning），实际可跳步数被 SADA 的 warmup/tail 吃掉后
   *      未必有正收益，**实测是唯一依据**。
   *
   * ⇒ **默认关**；开 = `sadaEnabled: true`（或点面板开关）。
   *   改完要**重启 ComfyUI**让它重新加载节点图。
   */
  sadaEnabled: false,
  /** SADA 节点的 class_type（comfyui-sada-icml 仓库提供）。可由配置覆盖。 */
  sadaNodeClass: 'SADASampler',
  /** 采样步数预算（上限）。SADA 在此范围内跳步。0 = 跟随主链路。 */
  sadaMaxSteps: 0,
  /** 跳步阈值（越大越激进、画质风险越高）。 */
  sadaThreshold: 0.15,
  /** 是否把 SADA 同时挂到 model + sampler（true = 真生效；false = 只挂 model）。 */
  sadaPatchSampler: true,

  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**OOM 自动回退**。
   *
   * 出图撞 OOM（"out of memory" / "OutOfMemoryError" / "CUDA OOM" /
   * "hip out of memory" / "MPS OOM" 任一）时，**自动**重跑一次：
   *   ① 强制 `vaeTiling='on'`（ComfyUI 自带 VAEDecodeTiled，零新增依赖）；
   *   ② 不动 turbo8 / 其它加速链（先让代价最小的开关上场）。
   * 如果还 OOM，把错误如实抛出（**绝不静默吞**）—— 让用户知道真的出问题了。
   *
   * 收益：本机 16GB 显存实测 1408² 撞过 OOM，开启后第二次就出了图。
   *
   * ⇒ **默认开**（OOM 是没商量余地的硬约束，回退比失败好）。
   *   关 = `oomAutoFallback: false`（不推荐；只在你明确知道在做什么时关）。
   */
  oomAutoFallback: true,

  /**
   * ★★★ 2026-10-13（用户反馈）：**串行抽卡（排队模式）**。
   *
   * ## 为什么要这个
   *   `count > 1` 原来走 `EmptyLatentImage.batch_size = N` —— 那是**真并发**：
   *   N 份 latent **同时**占显存。8 GB 卡上这就是 OOM 直通车。
   *   串行模式改成「提交 1 张 → 等结果 → 落盘 → 再提交下一张」，
   *   显存里**始终只有一份 latent**。
   *
   * ## ⚠⚠ 必须澄清的一点（别照字面理解"释放显存"）
   *   用户原话是"释放显存后自动生成下一张"，但**真把主模型卸掉是错的**：
   *   下一张就得重新加载 ~13.5 GB 模型（实测冷启动 65 s），那才是灾难。
   *   串行的真正收益是「不同时持有 N 份 latent」，**主模型必须保持常驻**。
   *   ⇒ 所以串行**只做顺序提交，不做 freeComfyModels**。
   *
   * ## 三档
   *   `'auto'`（默认）—— 显存 < 16 GB 才串行（与 `vaeTiling` 的显存闸同源，判据一致）；
   *   `'on'`          —— 总是串行（晚上挂机抽卡用这个）；
   *   `'off'`         —— 走原来的并发批（大显存下更快，省 (N-1) 次排队往返）。
   */
  serialBatch: 'auto',

  /**
   * ★★★ 2026-10-13（用户反馈）：**生成后自动放大**（一键出大图）。
   *
   * 8 GB 卡想出 2K，唯一现实路径 = 先在 1024² 生成，再**分块放大**。
   *
   *   `0`（默认）= 不放大（行为与 0.16 完全一致）；
   *   `2`        = 生成完自动放大 2 倍 → 1024 × 2 = **2048（2K）** ← 推荐
   *   `3` / `4`  = 3072 / 4096（显存与时间代价大；VOSR2 高于约 4x 质量不保证）
   *
   * ⚠ 两段之间会 `freeComfyModels` 卸主模型再上放大模型（沿用放大工具既有逻辑，
   *   避免双占显存）。
   * ⚠ 放大**失败不影响**已经生成的那张图 —— 原图已落盘，只 warn 不抛错。
   */
  upscaleAfter: 0,

  /**
   * ★ 2026-10-09 实测新增：prompt 精简。
   *
   *   先给实测上限（RX 7900 XT / 1024²，同一条 TE + Speedup + quad 栈，只变 prompt）：
   *       38 字  → 7.821 s
   *      329 字  → 8.088 s
   *     1974 字  → 8.194 s
   *   即：prompt 从 38 字加到 1974 字（52 倍）也只多花 0.373 s（**+4.8%**）。
   *   ⇒ 文本 token **没有被填充到固定长度**（否则长短 prompt 会一样快），
   *     但同时也说明「精简 prompt」的收益天花板就是 ~5%，
   *     而且**只有写超长 prompt 时才摸得到**，日常 prompt 几乎为 0。
   *
   *   所以这里默认只做**无损清理**（折叠空白、合并重复标点），语义不变；
   *   `maxPromptChars` 硬截断默认 **0 = 关闭**，因为它会改变出图，
   *   而换来的最多也就是那 4.8%。
   */
  promptTrimEnabled: true,
  /** >0 时按字符数硬截断 prompt（会改变出图，默认 0 = 不截断）。 */
  maxPromptChars: 0,

  /**
   * ★★★ 2026-10-09 **实测新增：BlockCache T8**（取代了失败的 ToMe）。
   *
   * ## 实测（图生图，RX 7900 XT / ROCm，2 个 seed 取平均，只在链上加这一个节点）
   *     基线              120.75 s
   *     +BlockCache T8     93.34 s   →  **+22.7%**（省 27.4 s）
   *
   * ## 为什么它能成、ToMe 不能
   *   ToMe 在千问 2.1 上因接口不兼容三条路全断（详见 resolvePlan 里 ToMe 的移除说明）。
   *   而 BlockCache T8 官方描述明确写着：
   *     · "preserving Core's reference/text KV cache" → **原生兼容前缀缓存**
   *     · "For editing, start with threshold 0.03"   → 图生图推荐起点就是保守值
   *   下面这些默认值**就是官方对 editing 的推荐值**，我没有自己调激进口径。
   *
   * ⚠ `blockCacheThreshold` 是唯一的"速度 ↔ 保真"旋钮：
   *   调大 → 跳得更多、更快，但官方原话是 "may change pose and details"（可能改姿态和细节）。
   *   想更稳可调到 0.02；想更快可试 0.05 —— 但**请自己看效果再定**。
   */
  blockCacheEnabled: true,

  /**
   * ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按尺寸自动选**（取代"一刀切"）。
   *
   * ## 为什么必须改（这是实测打脸，不是推测）
   *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
   *   **只能上一组**。上一轮我按"TE+Speedup 8.639 s < BlockCache 9.712 s"
   *   把 BlockCache 关了（blockCacheEnabled=false）。
   *
   *   但那个对比是**小尺寸 + 模型已驻留**的理想条件下测的。
   *   在 1408×1408 的真实场景里，ComfyUI 日志白纸黑字：
   *       Qwen TE predictor: predicted 0/8 steps (**0.0%** model-call acceleration)
   *       QwenImage21Speedup: 1 cached of 8 model forwards (**12.5%** skipped)
   *   ⇒ **TE 一步都没命中、Speedup 只跳 1 步，却独占着 wrapper 坑。**
   *
   *   而 BlockCache T8 的实测是**大尺寸**（基线 120.75 s）下 **+22.7%（省 27.4 s）**，
   *   且官方描述 "preserving Core's reference/text KV cache" ⇒ **原生兼容前缀缓存**，
   *   能跟 turbo8 + 前缀 KV 缓存**叠着用**。
   *
   * ## 所以：按出图尺寸自动选
   *   · 小尺寸（latent tokens ≤ 阈值）→ TE-Speed + Speedup（小尺寸实测 +25.4%）
   *   · 大尺寸（latent tokens >  阈值）→ BlockCache T8（大尺寸实测 +22.7%）
   *
   *   ⇒ 两边都拿到各自场景里**实测更好**的那一套，而不是拿一套去硬扛所有尺寸。
   *
   * ## 取值
   *   'auto'  按尺寸自动（默认）
   *   'te'    始终 TE-Speed + Speedup（不管尺寸）
   *   'bc'    始终 BlockCache T8（不管尺寸）
   */
  wrapperPolicy: 'auto',
  /**
   * auto 模式的分界（单位：latent token 数 = round(W/8) × round(H/8)）。
   *
   * 16384 = 1024×1024 的 latent（128×128）。实测依据：
   *   992×992  → 124×124 = 15376 tokens → 模型能常驻，总耗时 23.00 s（小尺寸策略对）
   *   1408×1408→ 176×176 = 30976 tokens → 显存吃紧换页，总耗时 79.70 s（该换 BlockCache）
   */
  wrapperAutoTokensThreshold: 16384,

  /**
   * ★★★★ 2026-10-10 新增：**RDNA3 FlashAttention**（无损提速）。
   *
   * ## 为什么它是"无损"
   *   它是**精确注意力**（memory-efficient 的等价实现），不改数学 ⇒ 不改成品。
   *   节点自带 `safely falls back for unsupported calls`：形状/精度不满足就回退到
   *   原生注意力，**不会算错**。
   *
   * ## 为什么值得开（本机实测证据）
   *   启动日志里注意力走的是 ComfyUI 自带的
   *   `Using sub quadratic optimization for attention`（quad 路径，实测 +15%）；
   *   而 `custom_nodes/RDNA3-Flash-Attention` **已经装了却没用**（日志里加载了 0.3 s）。
   *   它的 `_validation.py` 明确只支持 **gfx1100**（本机 RX 7900 XT 正是 gfx1100），
   *   需要 ROCm PyTorch ≥ 2.8（本机 2.9.1+rocm7.2.1）⇒ **平台完全匹配**。
   *   1408² 时注意力是采样的大头 ⇒ 接上它有望明显缩短那 45 s。
   *
   * ## 接线位置
   *   放在**模型链最末端**（KSampler 之前）—— 它 patch 的是
   *   `model_options.transformer_options.optimized_attention_override`，
   *   必须让**采样器拿到的那个 model** 带上它，所以放最后最稳。
   *
   * ⚠ 节点没装时自动跳过（能力门控），不影响出图。
   * ⚠ 想关掉：把本项设成 false（或删掉那一行）。
   */
  rdna3FlashAttention: true,

  /**
   * ★★★ 2026-10-11 新增：**A 卡专属优化（可选，默认关）** —— 与 N 卡/I 卡专属优化同一套思路：
   *   只在**适用的显卡上**出现、默认关闭、由用户自己决定要不要开。
   *
   * ## 两条，**全部质量中性**（不牺牲原生画质）
   *   ① `amdKernel` —— 换用本代 A 卡的**替代注意力内核**（按代数自动挑 flag）：
   *        · 6000（RDNA2）→ `--use-quad-cross-attention`（子二次交叉注意力）
   *        · 7000（RDNA3）→ `--use-ck-attention`
   *        · 9000（RDNA4）→ `--use-ck-attention`
   *      注意这些是**换后端**，不是降精度：注意力仍然算完整结果，只是走不同内核。
   *   ② `amdAsyncOffload` —— `--async-offload`（异步权重卸载）。
   *      为什么值得给 A 卡：ComfyUI 的 help 原文写着
   *        "Use async weight offloading... **Enabled by default on Nvidia.**"
   *      —— 也就是**N 卡本来就默认开、A 卡默认关**。这里把它补上，属于"对齐 N 卡的默认待遇"，
   *      只改变**权重加载的时机**（与计算重叠），不改任何计算结果。
   *
   * ## 为什么默认关
   *   本机是 RDNA3，**没有 6000 / 9000 的硬件可实测**，所以**绝不擅自改别人的默认路径**
   *   （改错就是整条链路跑不动）。做成可选开关，试错成本最低。
   *   ⚠ 这两个都是**启动参数** ⇒ 改完必须**重启 ComfyUI** 才生效。
   */
  amdKernel: false,
  amdAsyncOffload: false,

  /**
   * ★★★ 2026-10-11 新增：**N 卡 SageAttention**（40 系 Ada / 50 系 Blackwell 的专属加速）。
   *
   * ## 三档
   *   · `'auto'`（默认）—— **后台自检确认 sageattention 已装**时才挂 `--use-sage-attention`；
   *     状态未知（自检还没跑完）→ **本次不加**（保守），下次启动会按自检结果决定。
   *   · `true`  —— 强制挂。**只有你确定装好了**才这么设 —— 没装会让 ComfyUI 起不来。
   *   · `false` —— 永不挂。
   *
   * ## 为什么必须"确认了才挂"
   *   `--use-sage-attention` 是**硬依赖**：ComfyUI 的 help 只有一句 "Use sage attention."，
   *   但 sageattention 不在时会直接抛错。所以这里宁可少加，也不能盲加。
   *
   * ⚠ **50 系（Blackwell / sm_120）特别注意**：SageAttention / Triton 需要**支持 sm_120 的构建**，
   *   老版本不认这代卡。装之前先确认版本；装了不匹配的话，本项反而会让 ComfyUI 起不来 ——
   *   那时把本项设成 false 即可恢复。
   */
  nvidiaSageAttention: 'auto',

  /**
   * ★★★ 2026-10-13（任务 #62②「SageAttention 收尾」）：**性能 / 兼容模式**的中文命名。
   *
   * ## 两档是什么
   *   · `'performance'`（默认，**性能模式**）—— 标准 INT8 量化注意力内核，
   *     走 ComfyUI 的 `--use-sage-attention` 全局开关，速度最快。
   *   · `'compatibility'`（**兼容模式**）—— 同样的全局开关，但**始终开启崩溃自动回退**：
   *     一旦启用后 ComfyUI 启动失败、且日志指向 sage-attention（例如 Blackwell / sm_120
   *     装了不匹配的构建、或 sageattention 没装却被强制开启），插件会**在本会话内自动关掉**
   *     `nvidiaSageAttention`，避免反复崩溃把后端彻底拉不起来。
   *
   * ## ⚠ 必须如实说明的边界
   *   ComfyUI 的 `--use-sage-attention` 是**全局开关、没有官方子模式参数**，
   *   所以本插件**没有**、也**没有编造**一个"模式"命令行参数 —— 这两档的区别只在
   *   **崩溃兜底策略**，不在命令行。性能模式假设构建正确、崩了就照常报错；
   *   兼容模式则把"崩了就自动禁用"当成默认行为，对 Blackwell 这类容易踩构建坑的卡更友好。
   *
   * ⚠ 本机是 AMD RX 7900 XT，**SageAttention 整条路径无法在本地实测**，
   *   以下结论仅来自官方文档与社区报告，未在本机验证过。
   */
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
  /**
   * ★★★ 2026-10-09 **尺寸锁默认关闭**（需求方决定：完全听调用方）。
   *
   * ## 为什么改成 false
   *   原来默认 `true` —— 会把**任何**请求尺寸都改写成 `resolution`（默认 1024²）。
   *   后果：界面上 7 个比例**全部失效**，选 3:4 / 16:9 出来的都是方图。
   *   实测对照（锁开启时）：
   *     1:1  → 1024²   ｜ 3:4  → 1024² ｜ 4:3  → 1024²
   *     2:3  → 1024²   ｜ 3:2  → 1024² ｜ 16:9 → 1024² ｜ 9:16 → 1024²
   *   ⇒ 这是**功能被静默阉割**，而且是它顺带触发了"尺寸校验误报"那个 bug
   *     （校验拿请求值比对归一后的实际值，必然对不上）。
   *
   * ## 现在
   *   调用方要什么尺寸就给什么尺寸（仍受 32 对齐约束）。想再锁回来设 `true`。
   *
   * ⚠ 注意：**步数锁 `forceTurbo8Steps` 保留** —— 那是 Turbo8 蒸馏 LoRA 的
   *   工作点，和尺寸无关；放开步数只会更慢更糊。
   */
  forceOptimizedSize: false,

  /**
   * ★★★ 2026-10-14（C1「专业卡版」）：**显存 / 内存档位**（面板可选，用户自己挑）。
   *
   * ## 六档
   *   · `'auto'`（默认）—— **按显存自动**（= 0.16 的老行为）：
   *       ≥24 GB → 全驻留；16–24 GB → 全驻留 + 保留 0.5 GB；<16 GB → 不加。
   *   · `'resident'` —— **全驻留**：`--highvram`，模型全留显存（最快；显存装不下会 OOM）。
   *   · `'standard'` —— **标准**：不加驻留参数，交给 ComfyUI 自己调度。
   *   · `'save'`     —— **省显存**：`--lowvram`，把部分权重换到内存（慢一些，但更稳）。
   *   · `'ram'`      —— **权重放内存**：`--novram`，权重常驻内存、按需换入显存
   *                      （最省显存；**这就是"负载放到内存上、不必全放显存"那一档**）。
   *   · `'cpu'`      —— **纯 CPU**：`--cpu`，最后手段，很慢。
   *
   * ## ⚠ 必须如实说明的三条
   *   ① 这些都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效。
   *   ② **macOS 上这组参数不参与** —— ComfyUI 源码里 MPS 的 `vram_state` 被强制成
   *      `SHARED`，显式选了档位也**不会**生效（面板会如实说明）。
   *   ③ `'save'` / `'ram'` / `'cpu'` 是**拿速度换空间**，不是"优化"——
   *      它们让**显存不够的机器也能跑**，代价是变慢。别当成提速档用。
   *   ⚠ 仅在你**没有**用 `comfyArgs` 接管启动参数时生效（接管了就完全听你的）。
   */
  vramMode: 'auto',

  /**
   * ★★★ 2026-10-14（C5「专业卡版」）：**文本控制档**。
   *
   * ## 三档
   *   · `'auto'`（默认）—— 跟随链路：有 turbo8 就走 8 步，没有就回退原生工作点。
   *   · `'turbo'` —— **极速档**：8 步 / CFG 1.0（turbo8 蒸馏工作点，快，文字稍弱）。
   *   · `'native'` —— **文本控制档**：千问**原生工作点 25 步 / CFG 2.5** ——
   *       turbo8 是为速度牺牲文字渲染的；要"更精细的文本控制"就该走原生工作点。
   *
   * ⚠ `'native'` 会**明显变慢**（约 3 倍采样时间），这是拿时间换文字精度，不是 bug。
   * ⚠ 选 `'native'` 时**不会**挂 turbo8 LoRA 的位移（否则步数与位移不匹配）。
   */
  textControl: 'auto',

  /**
   * ★★★ 2026-10-14（C2「专业卡版」）：**模型精度档**（面板可选）。
   *
   * ## 五档
   *   · `'auto'`（默认）—— 按探测到的模型文件自动挑（老行为）。
   *   · `'bf16'` —— **全精度 BF16**（专业卡 24 GB+；最高画质）。
   *   · `'fp8'`  —— **FP8**（12 GB+；画质接近 BF16，显存省一半）。
   *   · `'int8'` —— int8 safetensors（当前默认档）。
   *   · `'gguf'` —— GGUF Q4/Q5（低显存）。
   *
   * ⚠ **本机（AMD RX 7900 XT 20 GB）无法实测 BF16 / FP8** —— 相关档位是按
   *   官方发布格式与显存需求写的，**真机效果需你在 24 GB+ 卡上验**。
   * ⚠ 选了某个档但**模型文件不在**时，插件**如实报缺失**、并**回落**到可用档，
   *   绝不假装已经用上了（详见 `pickBestModel`）。
   */
  precisionTier: 'auto',

  /**
   * ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（面板下拉，运行时切换）。
   *   · `mainModelOverride`       —— 主模型文件名（空 = 用自动挑的那个）
   *   · `loraOverride`       —— 额外 LoRA 文件名（空 = 不加）
   *   · `controlnetOverride` —— ControlNet 权重文件名（空 = 不用）
   *
   * ⚠ **取值必须确实存在于 ComfyUI 的模型清单里** —— 服务端会校验（白名单 = 实时探测到的文件列表），
   *   不在清单里的一律**拒绝**（否则手拼一个 URL 就能把任意路径塞进工作流）。
   * ⚠ 这些是**工作流参数**，**下次出图**即生效（不用重启 ComfyUI）。
   * ⚠ 主模型覆写**优先于**精度档（用户显式选的就该赢）。
   */
  mainModelOverride: '',
  loraOverride: '',
  controlnetOverride: '',

  /**
   * ★★★ 2026-10-14（C4「专业卡版」）：**通用 ControlNet** 的强度与生效区间。
   *   ⚠ 只有在「选中了 ControlNet 权重」**且**「本次传了控制图」**且**「两个节点都在」时才会接进工作流；
   *     否则**不接**，并在工具返回值里如实说明原因（不静默）。
   *   ⚠ 本机未实测（AMD 20 GB）—— 真机效果请自行验证。
   */
  controlnetStrength: 0.8,
  controlnetStartPercent: 0.0,
  controlnetEndPercent: 1.0,

  // ★★ 0.18：600000（10 分钟）。
  //   旧值 300000 基于"模型已在页缓存"的假设；0.18 实测官方 Turbo 冷启动
  //   （从磁盘装载约 13–14 GB 权重 + 首次编译）单张就要 317 秒，旧上限会把
  //   一次成功的首图误判成超时。10 分钟只影响真正卡死的报错延迟，不影响正常出图。
  //   仍嫌久可在 cordis.patch.yml 调小。
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

  /** ★★★ 2026-10-19（用户要求）：抽卡「挑图」的两个开关 —— **都由用户自己决定是否启用**。
   *   · `aiPickBest`   = `'on'`：一次出多张时，AI 用 `read_image` 逐张查看，
   *     挑最好的一张推荐给用户并说明理由，其余一并列出；并**记住用户偏好**，下次按偏好挑。
   *   · `userPickBest` = `'on'`：面板把多张并排显示，让用户自己点选"哪张最好"（点开放大）。
   *   两者可以同时开（AI 先推荐，用户仍可自己点）。**默认都关 = 与升级前行为完全一致。**
   *   界面上的选择会**落盘**（见 uiStatePath），重启也记得住。 */
  aiPickBest: 'off',
  userPickBest: 'off',

  /* ------------------------------------------------- hipfire 出图后端（★新） ---- */
  // ★★ 2026-10-08 新增：与 ComfyUI 并存的第二个出图后端，可通过配置切换。
  //   硬约束：**默认仍是 comfyui** —— 不改变任何现有行为。
  //   详见 lib/hipfire-img.js 顶部的长篇说明（协议细节、已知不支持项、两条通道）。
  ...HIPFIRE_DEFAULTS,
}


/* ------------------------------------------------- 生图意图判定提示词（★ 2026-10-09）---- */

/**
 * ★★★ 生图意图判定 —— 把原先「一整段写死的长提示词」改为**按策略生成**。
 *
 * ## 为什么要改
 * 原来那段提示词是"越狠越好"地堆出来的（当天改过十七次），结果是：
 *   · 它对**所有**用户都一套话术，用户无法表达"我不想要这么激进的自动画图"；
 *   · 它只教模型"判断是生图就赶紧画"，却**没教它排除**"画个流程图/思维导图"这类
 *     看着像生图、实际不该用本工具的场景 —— 这才是最容易出错的边界；
 *   · 同一段话术在文件里抄了三份，改一次要改三处。
 *
 * ## 现在
 * 按 `cfg.drawTrigger` 四档生成，**核心事实（属于哪个档）只写一遍**，
 * 各档在此基础上增减。四档的定义见 DEFAULTS 里 `drawTrigger` 的注释。
 *
 * ⚠ 无论哪一档，都**不会**让模型在没有生图意图时去调工具 —— 最松的 'eager'
 *   也只是"沾边就画"，不是"无脑画"。
 */

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
    // ★★★ 2026-10-09 改写（真事故）：
    //   旧文案是「排除流程图/思维导图/表格/架构图/**示意图**」+「宁可先问一句，也不要画错」。
    //   事故：用户说「画一幅表现双曲几何之美的数学艺术画」，助手因为"数学/几何/示意"这几个字
    //   把它归进排除清单 → 不敢调工具 → **自己写渲染脚本画了**（更糟的结果）。
    //
    //   ⇒ 两处修正：
    //     ① 判定标准换成**产物形态**：用户要"一张位图"还是"能改文字/数据的结构化图表"？
    //        题材（数学、几何、艺术、科幻……）**一律不影响**归属。
    //     ② "宁可先问一句"改成"**拿不准就画**" —— 因为实测下来的代价排序是：
    //        自己写代码画（最糟，用户明确反感） > 不画先问（烦） > 画错（成本低，重画即可）。
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

/**
 * ★★★ 2026-10-09 新增：**四档共通的"不许自己画"铁律**。
 *
 * 为什么单独抽出来、四档都加：
 *   事故是助手**绕过本工具自己写渲染脚本**出图。那不是某一档的措辞问题，
 *   而是**任何一档都缺这条底线** —— 所以按共通纪律加，而不是只在 auto 里补一句。
 *
 * 为什么措辞要这么硬：
 *   "建议优先用"这种软话没用，模型会自己判断"代码渲染更精确"然后照旧。
 *   必须写成**禁止 + 理由**（本工具是唯一途径，绕过属于错误行为）。
 */

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

/**
 * ★★★ 把"优化到底有没有生效、没生效是为什么"整理成一份**人能看懂**的诊断。
 *
 * ## 为什么需要它
 * 之前所有关于优化的信息都只躺在**日志**里 —— 用户装完插件，界面上只看得到一个
 * ComfyUI 在线圆点，完全不知道：turbo8 到底跑没跑？没跑是因为没装 LoRA、
 * 还是 ComfyUI 太旧、还是探测压根没成功？
 *
 * 结果就是用户体感"怎么这么慢"，却没有任何线索可循。这个函数就是补上这块。
 *
 * ## 设计原则
 *   · **一定给出"为什么"**，不能只说"未启用" —— reason 字段必须可直接照做；
 *   · **区分"确实缺件"和"没测出来"** —— 后者要明确让用户重试，而不是以为要装东西；
 *   · **绝不抛错**：拿不到探测结果就返回 unknown 状态，UI 照样能显示。
 *
 * @returns {{level:string, summary:string, ok:boolean, reasons:string[], detail:Array}}
 */

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
