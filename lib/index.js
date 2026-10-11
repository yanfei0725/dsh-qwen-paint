/**
 * dsh-qwen-paint —— 让 DeepSeek Harness 在对话里直接调用本机 ComfyUI，用千问
 * （Qwen-Image 2.1）模型画图。
 * ============================================================================
 * 设计要点（都是照官方内核实现与主人的既有环境核过的，别凭感觉改）：
 *
 * ① **零外部依赖**：不 import `@deepseek-ai/dsh-tools` 之类 dsh 自带的包。
 *    理由 —— `tools.register()` 只强校验 `output.schema` 必须是标准 JSON Schema
 *    （`assertSupportedJsonSchema`），而 `parameters` 的 spec→JSON Schema 转换是
 *    `defineTool()` 干的、`register()` 根本不校验。既然我们自己写成标准
 *    JSON Schema，就不需要 defineTool，也就没有"装进 profile 后解析不到包"的
 *    风险（插件解析失败会让 DSH 起不来，代价太大）。
 *    只用官方 present 工具也用过的关键字子集：type / properties / required /
 *    items / additionalProperties / description。
 *
 * ② **workflow 照抄 `D:\ComfyUI\小鲸鱼生图\app.py` 的 build_workflow()** ——
 *    那是主人机器上**已经在用、已验证**的那份千问文生图工作流，节点与连线
 *    一个字都不改，只把提示词/尺寸/步数/种子做成参数。
 *
 * ③ **纯本地**：只连 127.0.0.1 的 ComfyUI，不出网、不需要任何 API Key。
 *
 * ④ **落盘位置**：默认桌面「千问1生图」，遵循工作区约定。
 *
 * ⑤ **图片怎么显示在聊天框**：真正有效的只有两条 —— 正文 Markdown 图片
 *    （靠 systemPrompt 段落保证）与客户端自定义 toolview（lib/client.js）。
 *    ImageBlock / presentCall / presentationMeta / present 卡片**都不行**。
 *
 * ⑥ **空闲自动关停 ComfyUI**（主人 2026-10-07 要求："不要让 comfyUI 一直跑着，
 *    只要五分钟不生图 comfyUI 后端自动关闭"）：
 *    · 计时**只在插件出过图之后**才开始（`lastActivityAt` 初始为 null）——
 *      这样绝不会误关主人自己打开的、正在「小鲸鱼生图」里用的 ComfyUI；
 *    · 到点还要再确认两件事：ComfyUI 在线、且 `/queue` 为空（有任务在跑就续期）；
 *    · **只杀"监听该端口 且 命令行确实像 ComfyUI（含 comfy…main.py）"的进程**，
 *      认不出来就跳过并记日志——绝不按端口盲杀。
 *
 * ⑦ **只读状态端点**（给客户端的状态指示器用）：
 *    `GET /api/qwen-paint/status.json`（另注册一个根路径同内容作回退）。
 *    只回 {online, busy, idleShutdownInMs, ...} 这类事实，**不含任何路径/密钥**；
 *    并且只放行本机请求。
 * ============================================================================
 */

import { promises as fsp, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
// ★★ 2026-10-08：hipfire 出图后端（通用桥接）。
//   只在 cfg.imageBackend === 'hipfire' 时被调用；默认后端仍是 comfyui，
//   现有 ComfyUI 出图路径**一行不改**。
import { generateWithHipfire, HIPFIRE_DEFAULTS, HIPFIRE_SIZE_MULTIPLE } from './hipfire-img.js'

const execFileAsync = promisify(execFile)

/**
 * ★★ 2026-10-08：「正在生成图片」的呼吸动图 —— 路径与准备。
 *
 * 为什么这么做（主人给的正解，原话）：
 *   「你直接把这个动画当成一张图片发出来不就完美了吗」
 * 在此之前我三次尝试往消息树里插 DOM，最后一次把界面搞成整片空白 —— 那棵树由 React 管理，
 * 插自己的节点会被下一次渲染重排/清空（MEMO 里记过的红线：**只加属性、不改结构**）。
 * 改成动图后：位置就是正文图片的位置、随消息滚动、且完全不碰内核结构。
 *
 * 路径**动态算**（outputDir 已是按当前用户桌面推算的），复制到那儿供正文引用。
 */
function loadingGifPath(cfg) {
  // ★ 2026-10-08：**改用 webp**。GIF 版本在 DSH 里显示「图片无法预览」；
  //   而内核的 MIME 白名单明确支持 png / jpeg / webp / gif 四种（见 client.js L3728-3741），
  //   所以那次失败更可能是"GIF 编码/体积"而非格式本身 —— webp 只有 80KB（GIF 是 266KB）。
  return path.join(cfg.outputDir, '_正在生成图片.webp')
}

/** 把动图复制到用户目录（后台执行，不阻塞 systemPrompt 注册）。 */
async function prepareLoadingGif(cfg, log) {
  try {
    const src = fileURLToPath(new URL('../assets/loading.webp', import.meta.url))
    await fsp.mkdir(cfg.outputDir, { recursive: true })
    await fsp.copyFile(src, loadingGifPath(cfg))   // 每次覆盖：插件升级后动图可能变过
    return true
  } catch (error) {
    log('warn', `准备「正在生成」动图失败（不影响出图）：${error?.message ?? error}`)
    return false
  }
}

/** 稳定标识（与 cordis.patch.yml 里的 id 无关，这个是插件名）。 */
export const name = 'qwen-paint'

/**
 * ★★★ 2026-10-09 **关键修复**：模块级声明依赖 —— 这是 DSH 的**官方模式**。
 *
 * ## 为什么必须这么写（踩了很久的坑）
 *   本插件原先在 `apply()` 里用 `root.inject(['tools'], (ctx) => { …整个初始化… })`，
 *   把**所有初始化都塞进那个回调**。实测日志反复出现：
 *     `[apply] 插件开始加载` → `[inject] 准备注册` → **然后什么都没有**
 *   即：`root.inject` 的回调**从未执行**（cordis 的 scoped inject 在依赖解析上
 *   不可靠 / 静默挂起），于是工具、状态端点、提示词全都注册不上，
 *   界面上就是「一直卡在正在启动中」。
 *
 * ## 官方模式长什么样（对照两个正常工作的一线插件）
 *   · `@liustack/modlens`：`export const inject = ['tools','agents','attachments','llm']`，
 *     然后 `apply(ctx, config)` 里**直接** `ctx.tools.register(...)`
 *   · `dsh-univer-office`：`inject = ['univer','tools']`，同样直接 `ctx.tools.register(...)`
 *
 *   ⇒ **`export const inject` 是"声明"**：DSH 会等这些服务就绪后**才调用 `apply`**，
 *     而 `apply` 的 `ctx` 上**直接就有** `tools`，**根本不需要再 inject 一次**。
 *
 * ## 改法
 *   ① 这里声明 `inject = ['tools']`；
 *   ② `apply` 里把原来的 `root.inject(['tools'], cb)` 改成**立即执行**（IIFE），
 *      `ctx` 就是 `apply` 的第一个参数本身。
 *
 *   ⚠ `webServer` 是**可选**服务，仍走 `ctx.inject(['webServer'], …)`
 *     （modlens 也是这么用的：**必需**服务靠 export 声明，**可选**服务靠 inject 等它出现）。
 */
export const inject = ['tools']

/* --------------------------------------------------------------- 默认配置 ---- */

/**
 * ★★★ 2026-10-08：默认加速配置的**常量**（不属于可调配置，只给 buildWorkflow 用）。
 *
 * 上面这两条是"钉死的物理事实"，不是偏好：
 *   · turbo8 是**八步蒸馏** LoRA（发布页：8 steps / CFG 1 / euler + simple）。
 *     换别的步数就是掉出训练区间，出图直接变差 —— 所以步数不作为默认配置暴露。
 *   · LoRA 文件名写死一份默认值：显式配置为空串时也回落到它（不用 `??`，见 buildWorkflow）。
 */
const TURBO8_STEPS = 8
const DEFAULT_TURBO8_LORA = 'turbo8_lora_step2500.safetensors'
/**
 * 没有 turbo8 时的回退采样参数（千问原生工作点）。
 * ⚠ 必须定义在这里（DEFAULTS 之前引用，否则 TDZ 报错）。
 */
const BASE_STEPS = 25
const BASE_CFG = 2.5

/**
 * 推算默认出图目录（不写死任何绝对路径）。
 *
 * ★ 2026-10-09：这里必须**真的去看目录存不存在**，不能一味拼 `~/Desktop` ——
 *   Linux 上（尤其无桌面环境的机器、服务器、WSL）`~/Desktop` 常常压根不存在，
 *   硬拼会造出一个用户根本不用的 `Desktop` 目录；Windows 上则基本必然存在。
 *
 * 顺序：XDG 桌面目录（Linux 规范，且照顾中文系统改名）→ ~/Desktop → ~/桌面 → 主目录。
 */
function defaultOutputDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  const candidates = []
  if (process.env.XDG_DESKTOP_DIR) candidates.push(process.env.XDG_DESKTOP_DIR)
  candidates.push(path.join(home, 'Desktop'), path.join(home, '桌面'))
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return path.join(dir, '千问1生图')
    } catch {
      /* 读不到就当它不存在，继续下一个候选 */
    }
  }
  // 一个都不存在（无桌面环境）→ 直接落主目录，别硬造 Desktop
  return path.join(home, '千问1生图')
}

const DEFAULTS = {
  /** ComfyUI 服务地址。 */
  comfyUrl: 'http://127.0.0.1:8188',

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
  /**
   * ComfyUI 自己的 output 目录。**留空（默认）= 直接走 /view**（推荐、通用）。
   *
   * ★ 2026-10-09 通用化：原默认写死 `D:\ComfyUI\ComfyUI\output`，那只对作者机器有意义
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
   * ★★★ 2026-10-09 **尺寸锁默认关闭**（主人决定：完全听调用方）。
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
  // ★★ 2026-10-09：从 600000(10分钟) 收敛到 300000(5分钟)。
  //   原值过大——一旦后端真卡住，工具会干等 10 分钟才报错，观感就是"卡死"。
  //   5 分钟足够覆盖首次加载模型(~12s)+大图生图(2048² 约 53s)的余量；
  //   真要更久可在 cordis.patch.yml 调大，但别再回到 10 分钟那种"假性卡死"。
  timeoutMs: 300000,
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
  /** ★★ 生图过程的动画（主人 2026-10-08 要求「使用户生图时可以自选动画」）。
   *   meteor = 现在这个马卡龙流星（默认，观感不变）；其余见 FLOW_STYLES。
   *   界面上的选择会**落盘**（见 uiStatePath），下次启动记得住。 */
  flowStyle: 'meteor',

  /* ------------------------------------------------- hipfire 出图后端（★新） ---- */
  // ★★ 2026-10-08 新增：与 ComfyUI 并存的第二个出图后端，可通过配置切换。
  //   硬约束：**默认仍是 comfyui** —— 不改变任何现有行为。
  //   详见 lib/hipfire-img.js 顶部的长篇说明（协议细节、已知不支持项、两条通道）。
  ...HIPFIRE_DEFAULTS,
}

/* ------------------------------------------------ 生图动画方案（界面可自选） ---- */

/**
 * 允许的动画 id 白名单 —— **host 端只需要 id，渲染全在客户端**（见 client.js 的 FLOW_GRADS）。
 * meteor + 15 种流光（色值照搬主人小肥鱼挂件里那套「跑马灯」流光，一个字没改）。
 *
 * ⚠ 这里必须**白名单校验**：`?flowStyle=` 是外部输入，直接塞进样式名会变成注入面。
 * ⚠ 客户端那份表要和这里对齐 —— 自测里有一条专门比对两边 id 集合，改名时两边一起改。
 */
const FLOW_STYLES = [
  'meteor',
  'macaron', 'candy', 'rouge', 'bamboo', 'aurora', 'deepsea', 'sunset', 'forest',
  'champagne', 'lavender', 'mint', 'lava', 'galaxy', 'ink', 'indigo',
]

/** 界面偏好落盘路径：$DSH_HOME 优先（跟着 DSH 的 home 走），其次按用户目录推算。 */
function uiStatePath() {
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return path.join(home, 'qwen-paint-ui.json')
}

/** 读界面偏好。文件不存在 / 内容坏了都返回空对象 —— 绝不影响出图。 */
function readUiState() {
  try {
    const parsed = JSON.parse(readFileSync(uiStatePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 写界面偏好（同步写：文件很小、只在用户点选时发生，避免异步写的竞态）。 */
function writeUiState(state, log) {
  try {
    writeFileSync(uiStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    log('warn', `界面偏好写盘失败（只影响"下次启动还记不记得"）：${error?.message ?? error}`)
    return false
  }
}

/** 画幅比例（照抄 app.py 的 ASPECTS）。 */
const ASPECTS = {
  '1:1': [1, 1],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '16:9': [16, 9],
  '9:16': [9, 16],
}

/* ------------------------------------------------------------------ 小工具 ---- */

/** 写日志：宿主 logger 存在就写，不存在就吞掉（绝不让日志把功能搞崩）。 */
function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = ctx.logger ?? ctx.root?.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[qwen-paint] ${message}`)
      else if (level === 'error' || level === 'warn') console.error(`[qwen-paint] ${message}`)
    } catch {
      /* 日志失败绝不影响出图 */
    }
  }
}

/** 对齐到 32 的倍数（照抄 app.py 的 r32）。 */
function r32(value) {
  return Math.max(32, Math.round(value / 32) * 32)
}

/** 按画幅比例 + 百万像素算尺寸（照抄 app.py 的 calc_size）。 */
function calcSize(aspect, megapixels) {
  const [aw, ah] = ASPECTS[aspect] ?? [1, 1]
  const ratio = aw / ah
  const total = Number(megapixels) * 1e6
  const width = Math.sqrt(total * ratio)
  return [r32(width), r32(width / ratio)]
}

/** 把提示词变成安全的文件名主体（照抄 app.py 的 safe_name 精神）。 */
function safeStem(prompt, maxChars) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return '无题'
  // ★ 2026-10-10 修 bug：调用方传的是 `maxChars`（落盘时是 22），但英文分支原先**写死 34** ——
  //   于是纯英文 prompt 会生成比中文长一截的文件名，参数形同虚设、风格还不统一。
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 34
  if (/^[\x20-\x7e]+$/u.test(cleaned)) {
    // 纯英文按词截断，别切半个单词
    let out = ''
    for (const word of cleaned.split(' ')) {
      if (out.length + word.length + 1 > limit) break
      out = `${out} ${word}`.trim()
    }
    return out || cleaned.slice(0, limit)
  }
  return cleaned.slice(0, limit)
}

/** 找一个不冲突的落盘路径。 */
async function uniquePath(dir, filename) {
  const first = path.join(dir, filename)
  try {
    await fsp.access(first)
  } catch {
    return first
  }
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  for (let i = 2; i < 999; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/** 从 comfyUrl 取端口号（取不到就退回 8188）。 */
function portOf(url) {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 8188
  }
}

/* -------------------------------------------------------------- 错误规范化 ---- */

/**
 * ★★★ 2026-10-09 **真事故修复**：把"任何形态的错误"变成真正的 `Error`。
 *
 * ## 事故现场
 *   主人点"画一张"，DSH 只回报一句：
 *     `画图失败：Error: [object Object]`
 *   信息量为零 —— 既不知道哪一步失败，也不知道为什么。
 *
 * ## 根因（已用 `scripts/_abort_reason_test.mjs` 实测复现）
 *   `AbortController.abort(reason)` 会把 `reason` **原样**变成 fetch 的 reject 值。
 *   实测四种 reason 的落地形态：
 *     · `new Error('x')`  → reject 值是同一个 Error      → `String(e)` = `Error: x`      ✅
 *     · 普通对象 `{...}`  → reject 值是**同一个普通对象** → `String(e)` = `[object Object]` ❌
 *     · 字符串 `'x'`      → reject 值是同一个字符串       → `String(e)` = `x`             ⚠
 *     · `undefined`       → reject 值是 DOMException      → `String(e)` = `AbortError: …` ✅
 *
 *   而 DSH 宿主传进来的 `exec.signal.reason` **是个普通对象**（不是 Error）。
 *   老代码 `controller.abort(signal.reason)` 把它当 reason 转发 →
 *   `[object Object]` 就一路飘到用户眼前，把真实原因（取消？超时？哪一步？）全糊掉了。
 *
 * ## 修法
 *   ① 新增 `toError()`：**任何**输入都能得到一个带可读 message 的 Error；
 *   ② 新增 `cancelReason()`：把外来 signal.reason **翻译成人话**，绝不原样转发；
 *   ③ 所有 `throw signal.reason` / `controller.abort(signal.reason)` / `?? error` 全部改用它。
 *
 *   这样即使宿主再换一种 reason 形态，用户看到的也永远是"人话"，不是 `[object Object]`。
 */
function toError(value) {
  if (value instanceof Error) return value
  // 字符串 / 数字 / 布尔：直接当消息
  if (typeof value === 'string') return new Error(value === '' ? '未知错误（空字符串）' : value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return new Error(String(value))
  }
  if (value === null || value === undefined) return new Error('未知错误（无详情）')
  // 普通对象：优先掏它身上像"消息"的字段，再退到 JSON
  if (typeof value === 'object') {
    for (const key of ['message', 'msg', 'reason', 'error', 'detail', 'description']) {
      const inner = value[key]
      if (typeof inner === 'string' && inner !== '') {
        const wrapped = new Error(inner)
        wrapped.cause = value
        return wrapped
      }
    }
    let json = ''
    try {
      json = JSON.stringify(value)
    } catch {
      json = ''
    }
    const wrapped = new Error(json && json !== '{}' ? json.slice(0, 500) : `未知错误（${Object.prototype.toString.call(value)}）`)
    wrapped.cause = value
    return wrapped
  }
  return new Error(String(value))
}

/**
 * 把"取消原因"翻译成人话。
 *
 * ⚠ **不要**直接把 `signal.reason` 丢给 `controller.abort()`：
 *   它可能是任何东西，实测传普通对象就会让用户看到 `[object Object]`。
 *   这里统一转成一句可读的中文 Error —— 顺便把"是谁取消的"也说清楚。
 */
function cancelReason(signal) {
  const raw = signal?.reason
  if (raw instanceof Error && raw.message !== '') return raw
  // 宿主没给 reason（或给的不是 Error）时，不能把空对象透出去
  const text = (() => {
    if (typeof raw === 'string' && raw !== '') return raw
    if (raw && typeof raw === 'object') {
      for (const key of ['message', 'msg', 'reason', 'detail']) {
        const inner = raw[key]
        if (typeof inner === 'string' && inner !== '') return inner
      }
    }
    return ''
  })()
  return new Error(text === '' ? '任务已取消（宿主中止了这次调用）' : `任务已取消：${text}`)
}

/** 带超时的 fetch（同时尊重 exec.signal 的取消）。 */
async function fetchWithTimeout(url, { method = 'GET', body, timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs} 毫秒）：${url}`)), timeoutMs)
  // ★ 2026-10-09：**绝不**原样转发 signal.reason —— 它是普通对象时会让上层看到
  //   `[object Object]`（真事故，详见 toError / cancelReason 的注释）。
  const onAbort = () => controller.abort(cancelReason(signal))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      // ★★ 2026-10-08：**别让系统代理劫持 localhost**。
      //   本机环境里有 HTTP_PROXY/HTTPS_PROXY（实测 http://127.0.0.1:54536），
      //   Node 的 fetch 默认**会**把带显式端口的 127.0.0.1 也塞给代理 ——
      //   结果是连本机 ComfyUI 都报「连不上」，误导性极强。
      //   这里显式 `proxy: undefined`：对 http:// 目标等于直连（HTTPS 目标不受影响，
      //   因为 ComfyUI 走的是 http）。
      proxy: undefined,
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ★★ 把 ComfyUI 后端**隐身**启动：无控制台、不弹浏览器、不抢焦点。
 *
 * 主人先后两次要求：①「comfyUI 及其所有后端全部隐藏不要显示出来」；
 * ②（2026-10-07）「生图时依旧有弹窗出来，想办法隐藏掉」。
 * 那个弹窗就是**浏览器**，来源有两处，都已查实：
 *   · 启动 bat 的「已在运行」分支里有一句 `start "" http://127.0.0.1:8188`；
 *   · ComfyUI 自身的 `--auto-launch`（`--windows-standalone-build` 下可能被带上）。
 * 所以这里**绕过 bat**，直接调 python.exe + `-WindowStyle Hidden`（窗口藏住、输出流仍在），
 * 并显式加 `--disable-auto-launch`。两个参数名都用 `main.py --help` 核实过确实存在。
 */
/**
 * ★★ 2026-10-09（通用化）：**自动找出 ComfyUI 装在哪**。
 *
 * 通用包**绝不能写死安装路径** —— 每个人装的盘符、目录名都不同（有人是官方
 * Windows 便携包 `ComfyUI_windows_portable\python_embeded\python.exe`，有人是
 * 源码 + venv，有人装在 K 盘、E 盘……）。所以：
 *   ① 配置里显式给了 python + main.py → 直接用（尊重用户）
 *   ② 否则扫常见位置 + **各盘根目录下名字含 comfy 的目录**，找"python + main.py"齐活的组合
 * 都找不到返回 null，由调用方给出可照做的提示（而不是抛一个莫名其妙的 ENOENT）。
 */
/* ---------------------------------------------------------------- 平台抽象 ---- */

const IS_WINDOWS = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'
const IS_MAC = process.platform === 'darwin'

/** Windows：WMI 列出所有显示适配器名称。 */
const GPU_PROBE_WIN = '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | '
  + 'Select-Object -ExpandProperty Name) -join " | "'

// ★ 2026-10-09 新增：**显存总量探测（最可靠的一条）**。
//
//   为什么必须单独探：启动参数里的「显存驻留档位」需要**显存总量**才能决定，
//   而启动流程用的是 skipOnline（ComfyUI 还没起来），拿不到 /system_stats。
//
//   三条来源的可靠性（本机实测）：
//     ① ComfyUI `/system_stats`               → ✅ 准（但未启动时拿不到）
//     ② Windows WMI AdapterRAM                → ❌ **不可信**：本机 RX 7900 XT
//        实际 19.98 GB，WMI 却报 4293918720 bytes = **4.0 GB**（32 位字段截断）
//     ③ PyTorch `get_device_properties(0).total_memory` → ✅ **最准**（实测 19.98 GB）
//
//   ⇒ 所以这条放在 WMI 之前用。它就是用 ComfyUI 自己的 Python 跑一句，
//     既不需要 ComfyUI 运行，也不受 WMI 那个 4 GB 截断的影响。
//   注意：这里**只取总显存这个静态值**，不会加载任何模型、不占显存。
const GPU_VRAM_PROBE_PY = 'import torch;'
  + 'p=torch.cuda.get_device_properties(0);'
  + 'print(int(p.total_memory))'

/**
 * ★★★ 2026-10-11 新增：**macOS（Apple Silicon）** 的显存探测。
 *
 * ⚠ 上面那个写死了 `torch.cuda.get_device_properties(0)` —— macOS 上**没有 CUDA**，
 *   那一句直接抛错（被 catch 吞掉）⇒ macOS 上 vramGB 恒为 0。
 * 改用 PyTorch 官方的 MPS API `torch.mps.recommended_max_memory()`（返回字节数）。
 *
 * ⚠ 它给的是**建议的最大工作集**，在统一内存上**不等于物理总量**（PyTorch 会按总内存
 *   留出余量）。所以这个值只用于**展示**；Apple 上不会据此加任何驻留参数
 *   （见 VRAM_ARGS 里的显式跳过）。
 * 用 `getattr(..., lambda: 0)` 兜底：老版本 PyTorch 没有这个 API 时打 0，而不是抛错。
 */
const GPU_VRAM_PROBE_PY_MAC = 'import torch;'
  + 'print(int(getattr(torch.mps, \'recommended_max_memory\', lambda: 0)()))'

const GPU_VRAM_PROBE_WIN = '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | '
  + 'Where-Object { $_.Name -notmatch "Basic|Remote|Meta|Mirror" } | '
  + 'Sort-Object AdapterRAM -Descending | Select-Object -First 1 '
  + '-ExpandProperty AdapterRAM)'

/**
 * Linux：**多级回落**取显卡信息。
 *   nvidia-smi（N 卡型号最准）→ rocm-smi（A 卡型号）→ lspci（通用，但可能没装）
 *   → `/sys/class/drm/<card>/device/vendor`（最后兜底：只有 PCI vendor id，够判断厂商）
 * 全部 `2>/dev/null`：工具没装是常态，不该产生噪音。
 */
const GPU_PROBE_LINUX = 'nvidia-smi -L 2>/dev/null; '
  + 'rocm-smi --showproductname 2>/dev/null; '
  + 'lspci 2>/dev/null | grep -iE "vga|3d controller|display"; '
  + 'cat /sys/class/drm/card*/device/vendor 2>/dev/null'

/**
 * ★★★ 2026-10-11 新增：**macOS** 的显卡探测。
 *
 * ⚠ macOS **没有** nvidia-smi / rocm-smi / lspci —— 所以绝不能沿用 Linux 那条
 *   （沿用的结果就是"探测永远为空 → 一律 unknown"，这正是之前 macOS 上的实际表现）。
 *
 *   · `system_profiler SPDisplaysDataType` —— 最稳的一条，输出里就有我们要的那行
 *     `Chipset Model: Apple M3 Pro`；
 *   · 兜底 `sysctl -n machdep.cpu.brand_string` —— Apple Silicon 上直接给出
 *     `Apple M3 Pro`（`system_profiler` 偶发很慢/被沙箱限制时还有它）。
 *   两条都 `2>/dev/null`：拿不到是常态，不该产生噪音。
 */
const GPU_PROBE_MAC = 'system_profiler SPDisplaysDataType 2>/dev/null; '
  + 'sysctl -n machdep.cpu.brand_string 2>/dev/null'

/** PCI vendor id → 厂商名（Linux 兜底路径只能拿到这个）。 */
const PCI_VENDOR = { '0x1002': 'AMD Radeon', '0x10de': 'NVIDIA', '0x8086': 'Intel' }

/** 把多行探测输出规范化成一行，并把裸 vendor id 翻成厂商名。 */
function normalizeGpuText(raw) {
  return String(raw ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => PCI_VENDOR[line.toLowerCase()] ?? line)
    .join(' | ')
}

/**
 * ComfyUI 路径扫描 —— Windows 版。
 * 找"python + main.py 齐活"的目录组合，输出 `python|main.py|root` 一行。
 */
const COMFY_SEARCH_WIN = [
  '$cands = @()',
  '$cands += "$env:USERPROFILE\\ComfyUI", "$env:USERPROFILE\\Documents\\ComfyUI", "$env:USERPROFILE\\Desktop\\ComfyUI", "$env:USERPROFILE\\Downloads\\ComfyUI"',
  // ★★★ 2026-10-09 修复（通用性）：原来这里写死了 几个固定盘符。
  //   装在第 7 个盘（H:、I:…）或盘符被改过的机器上，这一行**完全覆盖不到**，
  //   只能靠下面 `Get-PSDrive` 那段兜底 —— 而兜底只找**目录名含 comfy** 的。
  //   所以"盘符不在表里 + 目录名不含 comfy"（例如自定义命名 `Qwen`）就会漏掉。
  //   改成**动态枚举所有本地盘符**，一个都不预设；目录名字面量另列在最上面，
  //   保证 `X:\ComfyUI` 这种最常见的安装即使不做递归也能命中。
  'foreach ($l in [char[]](65..90)) {',
  '  $drive = "${l}:"',
  '  if (Test-Path -LiteralPath "$drive\\") { $cands += "$drive\\ComfyUI", "$drive\\ComfyUI_windows_portable" }',
  '}',
  'foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {',
  // 只扫本地盘（形如 `X:\`）：网络盘/映射盘上 Get-ChildItem 可能长时间无响应，会把探测拖到超时
  "  if ($d.Root -notmatch '^[A-Za-z]:\\\\$') { continue }",
  '  Get-ChildItem -LiteralPath $d.Root -Directory -ErrorAction SilentlyContinue |',
  "    Where-Object { $_.Name -match 'comfy' } | ForEach-Object { $cands += $_.FullName }",
  '}',
  'foreach ($root in ($cands | Select-Object -Unique)) {',
  '  if (-not (Test-Path -LiteralPath $root)) { continue }',
  '  $py = @("$root\\python_embeded\\python.exe", "$root\\venv\\Scripts\\python.exe", "$root\\.venv\\Scripts\\python.exe") |',
  '    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1',
  '  $mp = @("$root\\ComfyUI\\main.py", "$root\\main.py") |',
  '    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1',
  '  if ($py -and $mp) { Write-Output ($py + "|" + $mp + "|" + $root); break }',
  '}',
].join('\n')

/**
 * ComfyUI 路径扫描 —— Linux / macOS 版。
 *
 * 与 Windows 版的差别（都是平台事实，不是随意写的）：
 *   · 解释器在 `venv/bin/python`（不是 `Scripts\python.exe`）；
 *   · 安装位置习惯不同：`~/ComfyUI`、`/opt/ComfyUI`、`~/comfy/...` 更常见；
 *   · 没有"盘符"概念，改为扫 `/mnt`、`/media`、`/opt`、`/srv` 与家目录下
 *     名字含 comfy 的目录（同样覆盖改名安装，如 `ComfyUI-rocm`）。
 * `-maxdepth 3` 是刻意的：再深就会变成全盘遍历，慢到不可接受。
 */
const COMFY_SEARCH_NIX = [
  'for root in \\',
  '  "$HOME/ComfyUI" "$HOME/comfy/ComfyUI" "$HOME/ComfyUI-rocm/ComfyUI" "$HOME/ai/ComfyUI" \\',
  '  /opt/ComfyUI /usr/local/ComfyUI /opt/comfyui /srv/ComfyUI \\',
  '  $(find /mnt /media /opt /srv "$HOME" -maxdepth 3 -type d -iname "*comfy*" 2>/dev/null); do',
  '  [ -d "$root" ] || continue',
  '  py=""',
  '  for p in "$root/venv/bin/python" "$root/.venv/bin/python" "$root/venv/bin/python3" "$root/bin/python"; do',
  '    if [ -x "$p" ]; then py="$p"; break; fi',
  '  done',
  '  [ -n "$py" ] || continue',
  '  mp=""',
  '  for m in "$root/main.py" "$root/ComfyUI/main.py"; do',
  '    if [ -f "$m" ]; then mp="$m"; break; fi',
  '  done',
  '  [ -n "$mp" ] || continue',
  '  printf "%s|%s|%s\\n" "$py" "$mp" "$root"',
  '  break',
  'done',
].join('\n')

/**
 * ★★★ 2026-10-09：**跨平台**执行一段脚本，拿 stdout（超时保护）。
 *
 *   Windows        → PowerShell（并把控制台输出编码钉成 UTF-8，
 *                    否则 Windows PowerShell 5.1 按 ANSI 代码页输出、这里按 utf8 解析，
 *                    遇到中文（如「Microsoft 基本显示适配器」）会变成乱码）
 *   Linux / macOS  → `sh -c`（POSIX，**不假设有 bash** —— 精简发行版里可能只有 dash）
 *
 * ⚠ 所以叫 `runShell` 而不是 `runPowerShell`：它是**所有系统命令的唯一入口**
 *   （探测 GPU、找 comfy 进程、装加速包…），任何绕过它的 Windows 专有命令
 *   都会在 Linux 上直接崩掉。
 */
async function runShell(script, timeoutMs = 20000) {
  if (IS_WINDOWS) {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
    )
    return String(stdout ?? '').trim()
  }
  const { stdout } = await execFileAsync('sh', ['-c', script], {
    timeout: timeoutMs,
    encoding: 'utf8',
  })
  return String(stdout ?? '').trim()
}

/** 路径探测结果缓存（ComfyUI 装在哪不会中途变；扫盘有成本，别每次调用都重来）。 */
let PATHS_CACHE = null

async function discoverComfyPaths(cfg, log) {
  if (cfg.comfyPython && cfg.comfyMainPy) {
    return {
      py: cfg.comfyPython,
      mainPy: cfg.comfyMainPy,
      workdir: cfg.comfyWorkdir ?? path.dirname(cfg.comfyMainPy),
      from: '配置',
    }
  }
  // ★ 缓存 10 分钟：本函数要扫各盘根目录（几百毫秒~数秒），
  //   而 `ensureComfyUp`（每次自启）与 `probeAcceleration`（每次检查）都会调它。
  if (PATHS_CACHE && Date.now() - PATHS_CACHE.at < 600000) return PATHS_CACHE.paths

  try {
    const out = await runShell(IS_WINDOWS ? COMFY_SEARCH_WIN : COMFY_SEARCH_NIX, 30000)
    const line = String(out).split(/\r?\n/u).map((s) => s.trim()).find((s) => s.includes('|'))
    if (line) {
      const [py, mainPy, root] = line.split('|')
      if (py && mainPy) {
        // ★★ 2026-10-09 修正（**真 bug**）：workdir 必须是 **main.py 所在目录**，
        //   而不是扫描脚本回传的 `$root`。
        //   扫描脚本的 `$root` 是"候选根目录"（例如 `X:\ComfyUI`），
        //   而 main.py 其实在 `$root\ComfyUI\main.py` —— 两者差一层。
        //   拿 `$root` 当工作目录会让 ComfyUI 的相对路径解析全错。
        //   `path.dirname(mainPy)` 永远等于"main.py 所在目录"，这才是对的那个。
        const found = { py, mainPy, workdir: path.dirname(mainPy), from: '自动探测' }
        void root
        PATHS_CACHE = { at: Date.now(), paths: found }
        return found
      }
    }
  } catch (error) {
    log?.('warn', `自动探测 ComfyUI 路径失败：${error?.message ?? error}`)
  }
  return null
}

/* ------------------------------------------------- GPU 厂商自适应 + 专用加速 ---- */

/**
 * ★★★ 2026-10-09（三厂商自适应）：把"按显卡厂商选优化方案"做成一张表。
 *
 * ## 两层优化，别混为一谈
 *   ① **通用优化**（与显卡无关，所有厂商都吃）：turbo8 八步链、官方前缀 KV 缓存、
 *      TE-Speed / Speedup 跳步缓存 —— 这些是"算法层"的省时，已在 buildWorkflow 里按
 *      能力探测自动接上。**任何卡都受益**。
 *   ② **专用优化**（跟厂商强绑定）：注意力后端启动参数 + 厂商专属的高性能 attention 内核。
 *      三家的硬件特性、可用内核、PyTorch 后端完全不同，**一刀切必然翻车**：
 *        · AMD/ROCm：`--use-quad-cross-attention` 实测 +15%；且 RDNA3 缺少生产级融合
 *          内核（PyTorch 在 gfx11 上退回"非融合 math"路径，会实打实展开 seqlen² 矩阵）。
 *        · NVIDIA/CUDA：PyTorch SDPA 本身就走 flash / mem-efficient 内核，再挂 quad
 *          没有收益；真正的大头是 **SageAttention**（INT8 量化注意力）这类第三方内核。
 *        · Intel/XPU：只能靠 PyTorch 的 xpu 后端 + IPEX，插件不该乱加内核参数。
 *   ③ 识别不出厂商 → **一个参数都不加**（最保守，先保证能起来）。
 *
 * ## 匹配规则为什么要打分
 * 一台机器可能同时报出核显 + 独显（例如 Intel 核显 + NVIDIA 独显、AMD 核显 + RTX）。
 * 若按数组顺序匹配，"AMD Radeon Graphics | NVIDIA RTX 4090"会先命中 AMD 核显而判错。
 * 所以按**得分最高**者胜：明确型号（RTX / Radeon RX / Arc）> 泛化的厂商名 > 核显。
 */
const GPU_PROFILES = {
  /**
   * ★ RDNA3（RX 7000 系列）—— **主人的既定方案，刻意保持不变**。
   *   A 卡这条线上不再引入任何额外内核：turbo8 八步链 + 前缀缓存 + 跳步缓存 + quad，
   *   本机全链路已验证（8.2s/张），够用且稳。
   */
  amd_rdna3: {
    id: 'amd_rdna3',
    label: 'AMD Radeon RX 7000 系列（RDNA3 / gfx11xx）',
    // 实测（RX 7900 XT / gfx1100 / ROCm 7.2.1）：10.739s → 9.328s（+15.1%），
    // 满叠栈再 +17.3%；`--use-pytorch-cross-attention` 则是 −0.3%（无效，本来就是默认路径）。
    args: ['--use-quad-cross-attention'],
    tuning: 'quad 交叉注意力（既定方案，实测 +15%）',
    packs: [],
  },
  /**
   * ★★★ RDNA4（RX 9000 系列）—— **唯一需要换内核的 AMD 分支**。
   *
   * 为什么必须区别对待：RDNA4 走的是 PyTorch 的 **CK SDPA（Composable Kernel）** flash
   * attention 路径，而它在 gfx1200/gfx1201 上**长期是坏的**（内核断言失败，
   * 见 pytorch#188113），后来的 PR #188114 / #193585 才修好并放开。
   * 所以 9000 系不能沿用 RDNA3 的 quad，而要显式走 `--use-pytorch-cross-attention`
   * 去用那个 CK 内核 —— **前提是 PyTorch 足够新**。
   */
  amd_rdna4: {
    id: 'amd_rdna4',
    label: 'AMD Radeon RX 9000 系列（RDNA4 / gfx120x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch CK SDPA flash attention（RDNA4 专用内核）',
    packs: [],
    note: 'RDNA4 的 CK SDPA 需要较新的 PyTorch；旧版在 gfx1200/1201 上会断言失败'
      + '（pytorch#188113 → 修复 #188114 / #193585）。若启动即崩，可把 comfyAttentionBackend 设为 default。',
  },
  /**
   * ★ RDNA2（RX 6000 系列）—— 保守路径。
   *
   * 为什么单独一档：ROCm 的融合注意力路径（AOTriton）**只覆盖 RDNA3 / RDNA3.5 / RDNA4**，
   * RDNA2（gfx103x）不在其列，CK SDPA 同样不覆盖它。也就是说这代卡上**没有可用的
   * 厂商级融合 attention 内核**，挂 quad / 强行指定内核都只是碰运气。
   * 所以这里走 `--use-pytorch-cross-attention`，把内核选择权交回 PyTorch
   * （它会自行落到可用的 mem-efficient / math 路径），先保证**能跑、不崩**。
   */
  amd_rdna2: {
    id: 'amd_rdna2',
    label: 'AMD Radeon RX 6000 系列（RDNA2 / gfx103x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（RDNA2 无 AOTriton / CK 融合内核，走保守路径）',
    packs: [],
    note: 'RDNA2 不在 ROCm AOTriton 覆盖范围内（仅 RDNA3/3.5/4），故不套用 quad；'
      + '若有异常可把 comfyAttentionBackend 设为 default。',
  },
  /** 认得出是 AMD、但认不出具体代数（信息不足时的保守落点）。 */
  amd: {
    id: 'amd',
    label: 'AMD Radeon（未识别具体架构）',
    args: ['--use-quad-cross-attention'],
    tuning: 'quad 交叉注意力（保守沿用既定方案）',
    packs: [],
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA（CUDA）',
    // CUDA 下 PyTorch SDPA 默认已用 flash / mem-efficient 内核，quad 无收益；
    // 这里显式写 pytorch 只是"明确用官方路径"，真正的加速靠 SageAttention 这类外部内核。
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch 原生 SDPA（flash / mem-efficient 内核）',
    // ★ 2026-10-09：补上社区公认的 N 卡方案（保守起见都能装、但**默认不自动装**）。
    //   triton-windows 是前置组件 → sageattention 是主力 → nunchaku 属进阶（要转模型）。
    packs: ['triton-windows', 'sageattention', 'nunchaku'],
  },
  /**
   * ★ Intel Arc —— 只把**两张主力消费卡**单独拉出来（B580 / A770），其余 Arc 落到泛化分支。
   *
   * 两代卡的共同点：都靠 PyTorch 的 **XPU 后端 + IPEX**，插件不额外指定内核参数
   * （Intel 上没有任何值得手动挂的 attention 后端轴）。
   * 差别在**所需软件栈的代数**：A770 = Alchemist(Xe HPG)，B580 = Battlemage(Xe2)，
   * 后者更新，需要更新的 torch-xpu / IPEX。
   */
  intel_battlemage: {
    id: 'intel_battlemage',
    label: 'Intel Arc B 系列（Battlemage / Xe2 — B580 / B570）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端 + IPEX（Xe2 需要更新版 torch-xpu / IPEX）',
    packs: ['ipex'],
    note: 'Battlemage 较新：若 torch 未编译 XPU（`torch.xpu.is_available()` 为假），'
      + '需先按 ComfyUI 官方 XPU 说明安装 torch-xpu，再装 IPEX。',
  },
  intel_alchemist: {
    id: 'intel_alchemist',
    label: 'Intel Arc A 系列（Alchemist / Xe HPG — A770 / A750 / A580）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端 + IPEX',
    packs: ['ipex'],
    note: 'Alchemist 是 XPU 支持最成熟的一代：装好 torch-xpu + IPEX 即可。',
  },
  /**
   * ★★★ 2026-10-11 新增：**Apple Silicon（MPS）**。
   *
   * ComfyUI 官方支持 Apple Silicon（M1–M4），做法是装 **pytorch nightly**
   * （Apple 的 Metal 加速指南），然后直接 `python main.py`
   * —— **官方没有给任何 Mac 专属启动参数**。
   * 所以这里 `args: []`：**不擅自**把 CUDA/ROCm 那套搬过来
   * （`--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention`
   * 在 MPS 上都不适用，加了反而可能起不来）。
   *
   * ⚠ **统一内存**：Apple Silicon 没有独立显存 ⇒ "按显存选驻留档位"那套
   *   （`--highvram` / `--reserve-vram`）**不适用**，已在 `VRAM_ARGS` 里显式跳过。
   * ⚠ 官方文档**没有提 Intel Mac**（老 Intel 机型 + 核显基本跑不动），
   *   本档只针对 Apple Silicon；Intel Mac 会落到 `intel` 或 `unknown`。
   */
  apple: {
    id: 'apple',
    label: 'Apple Silicon（MPS / 统一内存）',
    args: [],
    tuning: 'PyTorch MPS 后端（不指定任何 CUDA / ROCm 专用内核参数）',
    packs: [],
    note: '需要 ComfyUI 官方说明的 **pytorch nightly**（Apple Metal 版），'
      + '然后直接 `python main.py` 即可（官方没有 Mac 专属启动参数）。'
      + '统一内存没有独立显存 ⇒ 插件不加 --highvram 之类的驻留参数。',
  },
  intel: {
    id: 'intel',
    label: 'Intel（XPU，未识别具体型号）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端（插件不额外指定内核）',
    packs: ['ipex'],
  },
  unknown: {
    id: 'unknown',
    label: '未知 / 其他',
    args: [],
    tuning: '不指定任何注意力参数（保证能启动）',
    packs: [],
  },
}

/**
 * ★★★ 2026-10-11 新增：**A 卡"专属内核"候选表**（可选优化，默认关）。
 *
 * 与上面 `GPU_PROFILES` 的**默认** `args` 是两回事：
 *   · `GPU_PROFILES[x].args`  = **默认路径**（经过验证、不动）；
 *   · 本表                    = 用户**主动打开** `amdKernel` 时才替换成的**替代内核**。
 *
 * 为什么按代数给不同 flag：
 *   · 6000（RDNA2）没有 AOTriton / CK 融合内核覆盖（见 GPU_PROFILES.amd_rdna2），
 *     所以给它的是 `--use-quad-cross-attention`（子二次交叉注意力，换掉默认的 pytorch-cross）；
 *   · 7000 / 9000 给 `--use-ck-attention`（ComfyUI 自带的 "Comfy Kitchen attention"）。
 * ⚠ 全部是**换后端**、不改计算结果 —— 不是降精度，也就**不牺牲原生画质**。
 * ⚠ 本机只有 RDNA3，6000/9000 **没硬件实测** ⇒ 一律默认关，由用户自行尝试。
 */
const AMD_KERNEL_FLAG = {
  amd_rdna2: '--use-quad-cross-attention',
  amd_rdna3: '--use-ck-attention',
  amd_rdna4: '--use-ck-attention',
}

/**
 * 厂商判定规则（**得分高者胜**）。
 * 明确型号优先于泛化厂商名，独显优先于核显 —— 见上面"为什么要打分"。
 */
const VENDOR_RULES = [
  { id: 'nvidia', re: /nvidia|geforce|rtx\s?\d|quadro|tesla|a100|h100|l40/i, score: 100 },
  // ★ AMD 按**代数**细分：RX 9000=RDNA4（换 CK 内核）、7000=RDNA3（既定方案）、6000=RDNA2（保守）
  { id: 'amd_rdna4', re: /radeon\s+(rx\s?)?9\d{3}|gfx120\d/i, score: 98 },
  { id: 'amd_rdna3', re: /radeon\s+(rx\s?)?7\d{3}|gfx11\d{2}/i, score: 95 },
  { id: 'amd_rdna2', re: /radeon\s+(rx\s?)?6\d{3}|gfx103\d/i, score: 93 },
  // ★ Intel Arc 按代系细分（B580 = Battlemage / Xe2，A770 = Alchemist / Xe HPG）。
  //   注意显卡名常写成 "Intel(R) Arc(TM) B580 Graphics"，所以不能用 `arc\s?b580` 这种
  //   紧邻匹配，放宽成 `arc.*b\d{3}`；同时保留裸型号 `b580` 兜底。
  { id: 'intel_battlemage', re: /battlemage|xe2|\bb5[0-9]0\b|arc.*b\d{3}/i, score: 92 },
  { id: 'intel_alchemist', re: /alchemist|xe\s?hpg|\ba7[0-9]0\b|arc.*a\d{3}/i, score: 91 },
  { id: 'intel', re: /intel.*arc|arc\s?\w|battlemage|alchemist/i, score: 88 },
  // ★★★ 2026-10-11 新增：**Apple Silicon**（MPS）。型号形如 "Apple M1/M2/M3/M4 [Pro|Max|Ultra]"。
  //   ⚠ 分数要**低于** NVIDIA/AMD 的明确型号规则：装了 eGPU / 或 Intel Mac 上同时报出
  //     独显时，应优先按那张真正在算图的独显处理，而不是把整机当 Apple 核显。
  { id: 'apple', re: /apple\s+m[1-9]|\bm[1-9]\s*(pro|max|ultra)\b|apple.*(gpu|metal)/i, score: 86 },
  { id: 'amd', re: /amd|radeon|ati\b|advanced micro devices/i, score: 60 }, // 含核显
  { id: 'intel', re: /intel|iris|uhd graphics|xe graphics/i, score: 50 },
]

/**
 * 按 VENDOR_RULES **打分**判定厂商/代数，返回最匹配的 profile id（识别不出 = 'unknown'）。
 *
 * ★ 2026-10-10 抽出：`detectGpuProfile` 与 `resolvePlan` 共用同一套判定 ——
 *   后者要靠它**门控厂商专用节点**（如 RDNA3 FlashAttention 只认 gfx1100），
 *   两处若各写一份，改一处忘另一处就会"探测说 A、接线按 B"。
 */
function vendorIdOf(text) {
  const s = String(text ?? '')
  let best = 'unknown'
  let bestScore = 0
  for (const rule of VENDOR_RULES) {
    if (rule.score > bestScore && rule.re.test(s)) { best = rule.id; bestScore = rule.score }
  }
  return best
}

/**
 * 识别用户机器的 GPU 厂商。
 *
 * 探测顺序（**先权威、后兜底**）：
 *   ① ComfyUI `/system_stats` 的 `devices[0].name` —— 这是**实际用来算图的那张卡**，最准；
 *   ② 没在跑就查 Windows WMI 的 `Win32_VideoController`（会列出所有显卡）。
 * 两条路都拿不到 → 返回 unknown，**不加任何参数**（绝不猜）。
 */
/** GPU 判定结果缓存（显卡不会中途换，没必要每次启动 ComfyUI 都重查）。 */
let GPU_CACHE = null

/**
 * ★★★ 2026-10-11 新增：**N 卡 SageAttention 的就绪状态**（`null` = 还不知道）。
 *
 * ## 为什么要有这个缓存
 *   `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，
 *   ComfyUI 会**直接起不来**。所以"挂不挂"必须先确认"装没装"。
 *   而确认要起一次 Python 去 `import sageattention`（冷启动可能好几秒）——
 *   那是**每次启动 ComfyUI 都要付**的成本，绝不能放在启动关键路径上。
 *   ⇒ 由**后台**的加速环境自检（见 `autoSetupAcceleration`）顺手记下来，启动时直接读。
 *
 * 三态：`null` 未知（本次不加，保守）/ `true` 已装 / `false` 确认没装。
 */
let SAGE_READY = null

/**
 * ★ 2026-10-11：NVIDIA **代系**识别 —— 只用于**提示**，不改默认启动路径。
 *
 * 为什么要分：50 系（Blackwell / sm_120）比 40 系（Ada）新，
 * 老版本的 Triton / SageAttention 构建**不认 sm_120**，硬挂会报错。
 * 所以 50 系上要把"需要支持 Blackwell 的构建"这件事**明确写出来**，
 * 而不是让用户撞一次错才知道。
 */
function nvidiaGenOf(name) {
  const s = String(name ?? '')
  // ⚠ `(?!\s*ada)` 是必须的：**"RTX 5000 Ada" 是 Ada 架构的专业卡**，不是 Blackwell。
  //   没有这个负向断言时它会被判成 blackwell（实测过），从而给出错误的 sm_120 提示。
  //   注意 "RTX 4000 Ada" 因为 `\bada\b` 能命中，本来就不会误判 —— 5000 是唯一的坑。
  if (/rtx\s?50\d{2}(?!\s*ada)|blackwell/iu.test(s)) return 'blackwell'
  if (/rtx\s?40\d{2}|\bada\b|rtx\s?l40/iu.test(s)) return 'ada'
  return 'other'
}

async function detectGpuProfile(cfg, log, { force = false, skipOnline = false } = {}) {
  const ttl = 3600000
  if (!force && GPU_CACHE && Date.now() - GPU_CACHE.at < ttl) return GPU_CACHE.profile

  let detected = ''
  let source = ''

  // ★ `skipOnline`：调用方**已经知道 ComfyUI 没在跑**时（典型场景：正要启动它），
  //   就别再去敲 `/system_stats` 白等一次 6 秒超时 —— 那是纯粹的启动延迟。
  if (!skipOnline) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 6000 })
      if (res.ok) {
        const json = await res.json()
        detected = (json?.devices ?? []).map((d) => String(d?.name ?? '')).filter(Boolean).join(' | ')
        if (detected !== '') source = 'ComfyUI'
      }
    } catch {
      /* ComfyUI 没在跑属正常，继续走 WMI */
    }
  }

  if (detected === '') {
    try {
      // ★ 2026-10-11：**三路分派**（原先只有 Windows / Linux 两路 —— macOS 会落到
      //   Linux 那条，而 nvidia-smi / rocm-smi / lspci 在 macOS 上**全都不存在**，
      //   结果就是"探测永远为空 → 一律 unknown"，这就是 macOS 之前没被适配的实际表现）。
      const probeCmd = IS_WINDOWS ? GPU_PROBE_WIN : (IS_MAC ? GPU_PROBE_MAC : GPU_PROBE_LINUX)
      detected = normalizeGpuText(await runShell(probeCmd, 20000))
      if (detected !== '') {
        source = IS_WINDOWS ? 'WMI' : (IS_MAC ? 'system_profiler / sysctl' : '系统命令')
      }
    } catch (error) {
      log?.('warn', `GPU 探测失败：${error?.message ?? error}`)
    }
  }

  // ★ 2026-10-10：判定抽成 vendorIdOf（与 resolvePlan 的节点门控同源）。
  const best = vendorIdOf(detected)

  const profile = { ...(GPU_PROFILES[best] ?? GPU_PROFILES.unknown), detected, source }

  // ★ 2026-10-09：补上**显存总量** —— 启动参数里的「驻留档位」要靠它决定。
  //   来源优先级（按可靠性，本机实测结论）：
  //     ① ComfyUI /system_stats            → 运行时真实值（未启动时拿不到）
  //     ② PyTorch total_memory             → ✅ 最准，且不需要 ComfyUI 运行
  //     ③ Windows WMI AdapterRAM           → ⚠ 本机报 4.0 GB（实际 19.98 GB，32 位截断）
  //   都拿不到 → 留 0，调用方见到 0 会**选择不加驻留参数**，绝不瞎猜。
  if (!skipOnline) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 6000 })
      if (res.ok) {
        const json = await res.json()
        const bytes = Number(json?.devices?.[0]?.vram_total ?? 0)
        if (Number.isFinite(bytes) && bytes > 0) {
          profile.vramGB = Math.round((bytes / 1024 ** 3) * 10) / 10
          profile.vramSource = 'ComfyUI /system_stats'
        }
      }
    } catch {
      /* ComfyUI 没在跑 —— 落到下面的 PyTorch 兜底 */
    }
  }

  // ★ PyTorch 兜底：用 ComfyUI 自己的 python 跑一句取总显存。
  //   它不加载模型、不占显存，只读设备属性 —— 实测 19.98 GB，比 WMI 可靠得多。
  //   ★★ 2026-10-09 修正（**真 bug，会让整个驻留方案静默失效**）：
  //     我原先写的是 `findComfyPython?.()` —— **这个函数根本不存在**。
  //     全文只有 `discoverComfyPaths`（真正的路径解析器，见 821 行）。
  //     因为用了可选链 `?.`，不存在的函数会**静默返回 undefined**，
  //     于是 ② 这一层**永远不会执行**，一路落到被守卫拦掉的 WMI 层，
  //     最终 vramGB 恒为 0 ⇒ VRAM_ARGS 永远返回空数组 ⇒ `--highvram` 永不生效。
  //     表现就是"改了半天，30~40 秒还是没到"。教训：可选链是好的，
  //     但它会把"函数名写错"这种硬错误伪装成"运行时没数据"，务必回查调用点。
  if (!profile.vramGB) {
    const found = await discoverComfyPaths(cfg, log)
    const py = found?.py
    if (py) {
      try {
        // ★★ 2026-10-09 第二次修正：PowerShell 里调用**带引号的 exe** 必须加 `&`
        //   调用运算符。`"C:\path\python.exe" -c "..."` 在 PowerShell 里是**语法错误**
        //   （ParserError: UnexpectedToken），实测 stdout 为空、命令直接抛错。
        //   这不止影响本处 —— 凡是用 runShell 拼 `"路径" 参数` 的地方在 Windows 上都是坏的。
        //   加 `&` 后实测拿到 21458059264（19.98 GB）。
        // ★★★ 2026-10-11 修 bug（**Linux / macOS 上真失效**）：
        //   下面这行原来**没有平台闸** —— `&` 是 PowerShell 的**调用运算符**，
        //   但在 POSIX 的 `sh -c` 里它是**后台运算符** ⇒ 整条命令语法错、被 catch 吞掉
        //   ⇒ Linux 上 `vramGB` 恒为 0 ⇒ 驻留参数（--highvram 等）**永不生效**。
        //   ⚠ `probeAccelPack` 里踩过一模一样的坑并修好了，这一处漏了。
        //   ⇒ 现在按平台分叉：Windows 用 `& "exe"`，其余用 POSIX 单引号引用。
        const shq = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
        // ★ macOS：没有 CUDA，改用 PyTorch 的 MPS 建议工作集（见常量处的说明）
        const pyProbe = IS_MAC ? GPU_VRAM_PROBE_PY_MAC : GPU_VRAM_PROBE_PY
        const cmd = IS_WINDOWS
          ? `& "${py}" -c "${pyProbe}"`
          : `${shq(py)} -c ${shq(pyProbe)}`
        const out = String(await runShell(cmd, 30000))
        // ★ 解析要**挑出纯数字行**，不能盲取最后一行：
        //   ROCm 启动时会往 stdout 吐 `[WARNING] offload-arch failed...` / `[stderr]`，
        //   实测输出形如：
        //       [WARNING] offload-arch failed with return code 1
        //       [stderr]
        //       21458059264
        //   取最后一行虽然这次恰好对，但换台机器/换版本就可能失灵。
        const digits = out.split(/\r?\n/u).map((s) => s.trim()).filter((s) => /^\d+$/u.test(s)).pop()
        const raw = Number(digits)
        const gb = raw / 1024 ** 3
        // 只收"看起来合理"的值（≥ 1 GB）；不合理就留 0，让驻留逻辑不介入。
        if (Number.isFinite(gb) && gb >= 1) {
          profile.vramGB = Math.round(gb * 10) / 10
          profile.vramSource = 'PyTorch total_memory'
        } else {
          log?.('info', `显存探测：PyTorch 输出无法解析（${JSON.stringify(out.slice(0, 120))}）`)
        }
      } catch (error) {
        log?.('warn', `显存探测：PyTorch 调用失败：${String(error?.message ?? error).split('\n')[0]}`)
      }
    } else {
      log?.('info', '显存探测：没找到 ComfyUI 的 python，跳过 PyTorch 探测')
    }
  }

  if (!profile.vramGB && IS_WINDOWS) {
    try {
      const raw = Number(String(await runShell(GPU_VRAM_PROBE_WIN, 15000)).trim())
      const gb = raw / 1024 ** 3
      // ★ 只信任"看起来合理"的值：见 GPU_VRAM_PROBE_WIN 处的实测注释。
      //   4 GB 附近是 32 位字段的截断特征值，不能当真实显存用（会误判成"小显存"）。
      const looksTruncated = gb > 3.9 && gb < 4.2
      if (Number.isFinite(gb) && gb >= 1 && !looksTruncated) {
        profile.vramGB = Math.round(gb * 10) / 10
        profile.vramSource = 'WMI AdapterRAM'
      }
    } catch {
      /* 探测不到就算了 —— 留 0 更安全 */
    }
  }

  GPU_CACHE = { at: Date.now(), profile }
  if (log) {
    log('info', `GPU 判定：${profile.label}｜探测到「${detected || '未知'}」（来源：${source || '无'}）`)
    log('info', `该厂商专用调优：${profile.tuning}`)
    if (profile.vramGB) log('info', `显存总量：${profile.vramGB} GB（来源：${profile.vramSource}）`)
  }
  return profile
}

/**
 * 厂商专属加速包白名单。
 *
 * ⚠ 只放**来源明确、作者可查**的包；每一项都标了 `verified`：
 *   `verified: true`  = 在作者本机实测过
 *   `verified: false` = 方案真实存在、但**未在当前硬件上实测**（换硬件请自行确认）
 * 绝不自动安装白名单之外的东西。
 */
const ACCEL_PACKS = {
  // ★ AMD 一支**刻意留空**（主人 2026-10-09 明确要求）：
  //   A 卡用户沿用既定优化方案 —— 通用链（turbo8 + 前缀缓存 + 跳步缓存）+ quad，
  //   本机已验证，**不额外引入第三方内核**。唯一例外是 RDNA4（9000 系），
  //   它在**启动参数**上换用 PyTorch 的 CK SDPA 内核（见 GPU_PROFILES.amd_rdna4），
  //   同样不需要下载任何东西。
  sageattention: {
    id: 'sageattention',
    name: 'SageAttention',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/thu-ml/SageAttention',
    package: 'sageattention',
    pythonModule: 'sageattention',
    os: ['win32', 'linux'],
    requires: 'NVIDIA + Triton',
    why: 'INT8 量化注意力内核。近两年扩散模型圈子里最主流的 N 卡注意力加速方案，'
      + '对 DiT 类模型（含 Qwen-Image）普遍有可观增益。',
    verified: false,
  },
  /**
   * ★ 2026-10-09 新增（按主人要求补充 N 卡方案，保守起见只收社区公认、来源明确的）。
   *   注意定位：它是**前置组件**而不是加速本身 —— SageAttention 等一堆
   *   Triton 内核在 Windows 上都需要它。装了 Triton 的机器上会直接判定为已就位。
   */
  'triton-windows': {
    id: 'triton-windows',
    name: 'Triton for Windows',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/woct0rdho/triton-windows',
    package: 'triton-windows',
    pythonModule: 'triton',
    // ★ 只给 Windows：Linux 上 Triton 有官方 wheel（走下面的 `triton` 条目），
    //   装 triton-windows 反而会顶掉官方构建。
    os: ['win32'],
    requires: 'Windows + 对应版本的 PyTorch',
    why: 'Windows 上的 Triton 构建。官方 Triton 长期没有 Windows 轮子，而 SageAttention '
      + '等一批加速内核都依赖它 —— 是这些方案能装上的前置条件。',
    verified: false,
  },
  /**
   * ★ Linux 侧与 `triton-windows` **平行**的条目 —— 这就是"两套方案"的落点：
   *   同一个能力（Triton），Windows 上必须装第三方构建，Linux 上装官方包即可。
   *   多数 Linux 机器上它会直接探测为"已装"（通常随 PyTorch 一同带入）。
   */
  triton: {
    id: 'triton',
    name: 'Triton（官方构建）',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/triton-lang/triton',
    package: 'triton',
    pythonModule: 'triton',
    os: ['linux', 'darwin'],
    requires: 'Linux + 对应版本 PyTorch（通常已随 torch 安装）',
    why: 'Linux 上 Triton 的官方发行版，SageAttention 等加速内核的前置依赖。',
    verified: false,
  },
  /**
   * ★ 2026-10-09 新增：SVDQuant 4-bit 量化推理，DiT 模型上的社区热门方案。
   *
   * ⚠ **属进阶项**，不是"装上就变快"：需要先把模型转成它自己的 4-bit 格式，
   *   且对 PyTorch / CUDA 版本较敏感。放在白名单里供有需要的人按需安装，
   *   **不作为默认推荐**。
   */
  nunchaku: {
    id: 'nunchaku',
    name: 'Nunchaku（SVDQuant 4-bit）',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/nunchaku-tech/nunchaku',
    package: 'nunchaku',
    pythonModule: 'nunchaku',
    os: ['win32', 'linux'],
    requires: 'NVIDIA（较新架构）+ 匹配的 PyTorch/CUDA + 已转换的 4-bit 模型',
    why: 'SVDQuant 4-bit 量化推理，显著降低显存占用并提速。⚠ 需先把模型转换成其专用格式，'
      + '属进阶方案，未在本机验证。',
    verified: false,
  },
  ipex: {
    id: 'ipex',
    name: 'Intel Extension for PyTorch (IPEX)',
    vendor: 'intel',
    kind: 'pip',
    repo: 'https://github.com/intel/intel-extension-for-pytorch',
    package: 'intel-extension-for-pytorch',
    pythonModule: 'intel_extension_for_pytorch',
    os: ['win32', 'linux'],
    /**
     * ★★ 2026-10-09 实测修正：这个包**不在 PyPI 上**！
     *   裸跑 `pip install intel-extension-for-pytorch` 会报
     *   "No matching distribution found" —— 我一开始就是这么写的，是个真 bug。
     *   它挂在 Intel 自己的扩展索引下（已实测该索引有 2.8.10+xpu / 2.7.10+xpu 等版本），
     *   安装时必须带上 `--extra-index-url` —— 该索引地址配在 `ACCEL_SOURCES.ipex` 里。
     */
    requires: 'Intel Arc / XPU + 对应版本 PyTorch（包版本带 +xpu 后缀）',
    why: 'XPU 后端支持与算子优化。⚠ 版本号必须与已装 PyTorch 对齐，否则装不上。',
    verified: false,
  },
}

/**
 * ★★ 2026-10-09：加速包按**操作系统**过滤（方案表的 `os` 字段）。
 *
 * 为什么必须分两套：同一个能力在不同系统上**装法不同**。
 *   · **Triton** —— Windows 必须装第三方构建（`triton-windows`，官方长期没有 Windows 轮子），
 *     Linux 则装官方包。**装错了会顶掉正确的那个**，所以两个条目互为平台独占。
 *   · 将来若出现仅 Windows 可用的预编译内核（`.pyd`），也要靠这个字段把 Linux 挡在外面。
 *
 * 缺省（不写 `os`）视为全平台适用。
 */
function packAppliesToOs(pack) {
  const list = pack.os ?? ['win32', 'linux', 'darwin']
  return list.includes(process.platform)
}

/** 存在性检查（不抛异常）。 */
async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------- 多套下载方案（★ 2026-10-09）---- */

/**
 * ★★★ 每个加速包都给**一串候选下载源**，按顺序试，**任一套成功即止**。
 *
 * 为什么必须这样：用户环境千差万别 —— 公司网络挡 GitHub、pip 官方源不通、
 * 只有国内镜像可达、代理只放行部分域名、IPv6 抽风……**任何单一下载源都必然有人装不上**。
 * 多源 + 自动顶上，才是"通用包"该有的样子。
 *
 * ⚠ 全部源都失败也**不影响出图** —— 见 README「内置通用配置」一节：
 *   缺任何加速件都会自动降级到可用的链路，而不是报错罢工。
 */
const PIP_MIRRORS = [
  { label: '清华 TUNA', index: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { label: '阿里云', index: 'https://mirrors.aliyun.com/pypi/simple/' },
  { label: '腾讯云', index: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
]

/** 生成一个 pip 包的多套下载方案：官方源 → 三个国内镜像 → GitHub 源码直装。 */
function pipSources(pkg, { extraIndex, git } = {}) {
  // 标签里点明"含扩展索引"，否则像 IPEX 这种主包只在 Intel 索引上的会看不出来
  const suffix = extraIndex ? '（含 Intel 扩展索引）' : ''
  const sources = [{ label: `PyPI 官方源${suffix}`, pip: pkg, extraIndex }]
  for (const mirror of PIP_MIRRORS) {
    sources.push({ label: `镜像：${mirror.label}${suffix}`, pip: pkg, extraIndex, index: mirror.index })
  }
  if (git) sources.push({ label: 'GitHub 源码直装', pipGit: git })
  return sources
}

/** 各加速包的下载方案表（与 ACCEL_PACKS 一一对应）。 */
const ACCEL_SOURCES = {
  sageattention: pipSources('sageattention', {
    git: 'git+https://github.com/thu-ml/SageAttention.git',
  }),
  triton: pipSources('triton', {
    git: 'git+https://github.com/triton-lang/triton.git',
  }),
  'triton-windows': pipSources('triton-windows', {
    git: 'git+https://github.com/woct0rdho/triton-windows.git',
  }),
  nunchaku: pipSources('nunchaku', {
    git: 'git+https://github.com/nunchaku-tech/nunchaku.git',
  }),
  // ★ IPEX 特殊：它在 Intel 自己的索引上，PyPI 和国内镜像都没有。
  //   所以"官方索引"那一套是主方案，镜像套只是**顺带指定一个更快的 PyPI 镜像**
  //   给它的依赖用（依赖大多在 PyPI 上）。
  ipex: pipSources('intel-extension-for-pytorch', {
    extraIndex: 'https://pytorch-extension.intel.com/release-whl/stable/xpu/us/',
    git: 'git+https://github.com/intel/intel-extension-for-pytorch.git',
  }),
}

/**
 * 执行**一套**下载方案：pip 走 `-m pip install`，custom_node 走 `git clone`。
 *
 * ★ `--timeout 15 --retries 1` 是刻意的：让"连不上"**快速失败**并切下一套源，
 *   而不是卡在 pip 默认的长重试里（默认能拖好几分钟，观感就是"卡死"）。
 *
 * ★ 引号转义**必须按平台选**：PowerShell 用 `''` 转义单引号，POSIX sh 用 `'\''`。
 *   早先这里不分平台统一用了 sh 风格，Windows 上参数一旦含单引号就会被解析错。
 */
async function runInstallSource(source, env) {
  const q = IS_WINDOWS
    ? (s) => `'${String(s).replace(/'/gu, "''")}'`
    : (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
  /** 同一段命令在两个平台上的收尾差异（PowerShell 需要 & 调用符 + Out-String）。 */
  const wrap = (cmd, timeoutMs) => runShell(
    IS_WINDOWS ? `${cmd} 2>&1 | Out-String` : `${cmd} 2>&1`,
    timeoutMs,
  )

  const target = source.pipGit ?? source.pip
  if (target) {
    const args = ['-m', 'pip', 'install', '--upgrade', '--timeout', '15', '--retries', '1']
    if (source.index) args.push('-i', source.index)
    if (source.extraIndex) args.push('--extra-index-url', source.extraIndex)
    args.push(target)
    const exe = IS_WINDOWS ? `& ${q(env.py)}` : q(env.py)
    return await wrap(`${exe} ${args.map(q).join(' ')}`, 900000)
  }

  // ⚠ 与 probeAccelPack 里的 `custom_node` 分支同理：当前没有这类包，属**扩展预留**。
  if (source.gitClone) {
    if (!env.customNodes) throw new Error('没找到 custom_nodes 目录')
    const hasGit = await runShell(
      IS_WINDOWS
        ? "if (Get-Command git -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }"
        : 'if command -v git >/dev/null 2>&1; then echo YES; else echo NO; fi',
      15000,
    )
    if (hasGit.trim() !== 'YES') throw new Error('本机没有 git')
    const dest = path.join(env.customNodes, source.dirName ?? 'pack')
    return await wrap(`git clone --depth 1 ${q(source.gitClone)} ${q(dest)}`, 300000)
  }

  throw new Error('这套下载方案没有可执行的命令')
}

/** 从探测到的 ComfyUI 路径推出关键目录（custom_nodes 由 main.py 所在目录推）。 */
function comfyDirsFrom(paths) {
  const base = path.dirname(paths.mainPy)
  return { base, customNodes: path.join(base, 'custom_nodes') }
}

/**
 * 探测单个加速包是否已就位。
 * · `custom_node` 类 → 先看 custom_nodes 下有没有对应目录（快，且不依赖 python 能起来）
 * · `pip` 类        → 只能问 python 能不能 `import`
 */
async function probeAccelPack(pack, env, log) {
  // ⚠ 当前白名单里的包**全是 `pip` 类**，所以下面这个 `custom_node` 分支暂时走不到。
  //   保留它是为将来收录"只能靠 git clone 装"的自定义节点时不必再改这里。
  if (pack.kind === 'custom_node' && env.customNodes) {
    const dir = path.join(env.customNodes, pack.dirName ?? pack.id)
    if (await pathExists(dir)) {
      // ★ 目录存在还不够 —— `git clone` 中途失败会留下一个**空壳目录**，
      //   只看 "目录在不在" 会把它误判成"已经装好了"，以后再也不会重试。
      //   这里要求里面至少有一个条目。
      try {
        const entries = await fsp.readdir(dir)
        if (entries.length > 0) return true
      } catch {
        /* 读不了就当作没装，落到下面用 python 模块名再试一次 */
      }
    }
  }
  if (!env.py || !pack.pythonModule) return false
  // ★★★ 2026-10-09 修复（**真 bug，通用性**）：这里的脚本**必须按平台分叉**。
  //   原先是写死的 PowerShell 语法（`& '...'`、`Out-Null`、`$LASTEXITCODE`），
  //   而 `runShell` 在非 Windows 上走的是 `sh -c` —— `&` 是 shell 的**后台运算符**，
  //   整条命令会在 Linux/macOS 上语法错、被下面的 catch 吞掉、恒返回 false。
  //   后果不只是"显示未安装"：`autoSetupAcceleration` 会据此**反复尝试重装**，
  //   每次都失败 —— 用户看到的是"明明装了却一直说没装，还不停重试"。
  //   ⚠ 这正是 runShell 注释里警告过的"绕过它写 Windows 专有命令"那种错，
  //     我自己在别处写对了、在这一行漏了。
  const probeScript = IS_WINDOWS
    // PowerShell：模块能 import 就算装好了（`2>&1 | Out-Null` 是必须的 ——
    // 否则 ImportError 的堆栈会混进 stdout，把后面的 YES/NO 判断弄脏）。
    ? `& '${env.py.replace(/'/gu, "''")}' -c "import ${pack.pythonModule}" 2>&1 | Out-Null; `
      + "if ($LASTEXITCODE -eq 0) { 'YES' } else { 'NO' }"
    // POSIX：用 `>/dev/null 2>&1` 丢输出，按退出码判断。
    // ⚠ 路径整体加单引号，且**转义规则走 POSIX 版**（`'\''`）——
    //   这不是 `runInstallSource` 里那个按平台选引号的局部 `q`，
    //   这里已经确定是 POSIX 分支，直接用 POSIX 写法即可。
    //   不转义的话，路径带空格（如 `/home/a b/ComfyUI/venv/bin/python`）会被拆成两个参数。
    : `'${String(env.py).replace(/'/gu, "'\\''")}'`
      + ` -c 'import ${pack.pythonModule}' >/dev/null 2>&1 && echo YES || echo NO`
  try {
    const out = await runShell(probeScript, 40000)
    return out.trim() === 'YES'
  } catch (error) {
    log?.('warn', `探测加速包 ${pack.id} 失败：${error?.message ?? error}`)
    return false
  }
}

/**
 * 通用优化（与显卡无关）的**实际启用情况** —— 跟着能力探测结果走，不是一张静态清单。
 * 这样用户看到的"启用了什么"和真正提交的工作流永远一致。
 */
function genericOptimizations(caps, cfg) {
  if (!caps) return []
  const plan = resolvePlan(cfg, caps)
  const mark = (ok) => (ok ? '已启用' : '未启用')
  // ★★★ 2026-10-10 修 bug：TE-Speed / Speedup / BlockCache **三者互斥，且由出图尺寸决定谁上**
  //   （见 `pickWrapperSet`）。而 `plan.useTe/useSpeedup` 是"被 BlockCache 挤掉之后"的**静态**结果 ——
  //   直接报它会出现"报告说未启用、实际 1024² 正在用 TE+Speedup"的假报告。
  //   ⇒ 这里报**策略**，不报布尔值（与真正提交的工作流一致）。
  const wpPolicy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'
  const bcUsable = caps.nodes?.blockCache === true && cfg.blockCacheEnabled !== false
  const wrapperLine = wpPolicy === 'bc'
    ? (bcUsable ? 'BlockCache T8（固定，所有尺寸）' : 'BlockCache T8 不可用 → 退回 TE-Speed + Speedup')
    : (wpPolicy === 'te'
      ? 'TE-Speed + Speedup（固定，所有尺寸）'
      : (bcUsable
        ? '按尺寸自动：小尺寸（≤1024²）TE-Speed + Speedup ／ 大尺寸（如 1408²）BlockCache T8'
        : 'TE-Speed + Speedup（未装 BlockCache T8 节点）'))
  // ★★★ 2026-10-11：**按显卡过滤** —— RDNA3 FlashAttention 只对 AMD RDNA3（gfx1100）有意义。
  //   在 N 卡 / I 卡 / RDNA2 / RDNA4 上列出来只会误导（"未安装节点"会让用户去装一个装不了的东西）。
  //   与 `describeOptimization` 用同一套约定：**认不出显卡就不隐藏**。
  const gpuName = String(caps.gpu?.name ?? '').trim()
  const gpuVendor = gpuName === '' ? 'unknown' : vendorIdOf(gpuName)
  const lines = [
    `turbo8 八步蒸馏 LoRA：${mark(plan.useTurbo)}`,
    `官方前缀 KV 缓存 (QwenImage21Cache)：${mark(plan.usePrefix)}`,
    ...(gpuVendor === 'unknown' || gpuVendor === 'amd_rdna3'
      ? [`RDNA3 FlashAttention（无损）：${plan.useRdna3Fa ? '已启用' : (caps.nodes?.rdna3fa ? '未启用（被配置关）' : '未安装节点')}`]
      : []),
    `TE-Speed / Speedup / BlockCache（三者互斥）：${wrapperLine}`,
    `采样档位：${plan.useTurbo ? '8 步 / CFG 1.0（turbo8 工作点）' : `${plan.steps} 步 / CFG ${plan.cfgScale}（千问原生工作点）`}`,
    // ★ 2026-10-11：主模型档位（小显存适配）—— 让用户一眼看到现在用的是哪一档
    `主模型档位：${tierLabelOf(caps, cfg)}`,
  ]
  // ★★★ 探测没成功时（典型：ComfyUI 没在运行），上面那些"已启用"其实是**按能力齐全做的假设**。
  //   不点明的话，用户会以为加速全都生效了 —— 那是最容易误导人的一种报告。
  if (caps.probeFailed) {
    lines.unshift('⚠ 本次能力探测未成功（ComfyUI 可能没在运行），以下状态是按「能力齐全」假设的，**不代表真实可用**')
  }
  return lines
}

/**
 * 汇总"当前环境该用哪套加速、各部件就位了没"。
 * 这是 `check_acceleration` 工具与启动日志共用的**只读**入口。
 */
async function probeAcceleration(cfg, log) {
  // ★ 三项探测互不依赖 → **并发**；其中 paths / caps 都有缓存，实际开销很小。
  const [gpu, paths, caps] = await Promise.all([
    detectGpuProfile(cfg, log),
    discoverComfyPaths(cfg, log),
    probeCapabilities(cfg, log).catch(() => null),
  ])
  const env = paths
    ? { py: paths.py, ...comfyDirsFrom(paths), from: paths.from }
    : { py: '', customNodes: '', base: '', from: '未找到' }

  // ★ 按当前操作系统过滤（见 packAppliesToOs 的说明）：Windows 与 Linux 各取自己那套
  const wanted = (gpu.packs ?? [])
    .map((id) => ACCEL_PACKS[id])
    .filter((pack) => pack && packAppliesToOs(pack))

  // ★ 各包探测同样互不依赖，而且**每个都要起一次 Python**（`import` 检查），
  //   串行在 N 卡上要白等好几秒 —— 并发跑。
  const packs = await Promise.all(wanted.map(async (pack) => ({
    id: pack.id,
    name: pack.name,
    installed: await probeAccelPack(pack, env, log),
    kind: pack.kind,
    repo: pack.repo,
    requires: pack.requires,
    why: pack.why,
    verified: pack.verified,
  })))
  const missing = packs.filter((p) => !p.installed)

  return {
    gpu: {
      id: gpu.id,
      label: gpu.label,
      detected: gpu.detected,
      source: gpu.source,
      args: gpu.args ?? [],
      tuning: gpu.tuning,
      note: gpu.note ?? '',
    },
    env,
    // 通用优化的**真实**状态（跟着上面那次能力探测走）
    generic: genericOptimizations(caps, cfg),
    caps: caps
      ? {
        level: caps.level,
        // ★ 必须带上：上层靠它区分"真的缺件"和"这次没探测成功"（后者不该显示成"未启用"）
        probeFailed: caps.probeFailed,
        cached: caps.cached,
        nodes: caps.nodes,
        models: caps.models,
        notes: caps.notes,
      }
      : null,
    packs,
    missing,
  }
}

/**
 * ★★★ 2026-10-09：**自动加速环境配置** —— 检测到缺哪个厂商专用加速包，就自动下载安装。
 *
 * 包内**只带下载器、不预置任何已下载的文件**，所以必须真的去网上取。
 *
 * 设计要点（都是刻意的）：
 *   · **不阻塞任何事**：插件加载后延迟再跑，且任何失败都只写日志，绝不影响出图；
 *   · **只装当前平台适用的**（`packAppliesToOs`）—— Windows 装 triton-windows，
 *     Linux 装官方 triton，装错了会顶掉正确的那个；
 *   · **只补缺失的**：已装的一律跳过（`installAccelPack` 内部也会再查一次）；
 *   · 顺序即 `packs` 数组顺序 —— 前置组件排在前面（Triton → SageAttention → Nunchaku）。
 */
async function autoSetupAcceleration(cfg, log) {
  try {
    const report = await probeAcceleration(cfg, log)
    // ★ 2026-10-11：顺手把 SageAttention 的就绪状态记下来 —— 启动 ComfyUI 时要用它决定
    //   要不要挂 `--use-sage-attention`（**没装就挂上，ComfyUI 会直接起不来**）。
    //   放在这里是因为自检本来就跑在后台、且已经付过"起 Python 探测"的成本。
    {
      const sage = (report.packs ?? []).find((p) => p.id === 'sageattention')
      if (sage) SAGE_READY = sage.installed === true
    }
    if (report.missing.length === 0) {
      log('info', `加速环境自检：${report.gpu.label} 对应的专用加速包已全部就位`)
      return { ok: true, skipped: '都已就位', installed: [] }
    }
    log('info', `加速环境自检：发现 ${report.missing.length} 个缺失项（${report.missing.map((p) => p.id).join(', ')}）→ 开始自动下载`)
    const installed = []
    for (const pack of report.missing) {
      try {
        const result = await installAccelPack(pack.id, report.env, log)
        installed.push(result)
        // ★★★ 2026-10-11 修 bug：**装完立刻刷新** SageAttention 的就绪状态。
        //   原先只在探测时写一次，而探测跑在**安装之前** ⇒ 本次会话装了它，
        //   也要等**下次重启 DSH** 才生效；用户不重启就永远拿不到。
        if (pack.id === 'sageattention' && result.ok === true) SAGE_READY = true
        log('info', `${pack.name}：${result.ok ? '安装完成' : '安装未成功'}${result.skipped ? `（${result.skipped}）` : ''}`)
      } catch (error) {
        // 单个包失败不中断其余的，也不影响出图
        log('warn', `${pack.name} 安装失败（不影响出图）：${error?.message ?? error}`)
        installed.push({ ok: false, id: pack.id, error: String(error?.message ?? error) })
      }
    }
    return { ok: true, installed }
  } catch (error) {
    log('warn', `加速环境自检失败（不影响出图）：${error?.message ?? error}`)
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 安装一个加速包。
 *
 * ★ 安全边界（刻意设计成这样）：
 *   · 只接受 `ACCEL_PACKS` 白名单里的 id，**绝不接受任意 URL / 任意 pip 包名**；
 *   · 装之前先查一次是否已就位，已装就不动；
 *   · 失败**只返回错误，不回滚也不影响出图** —— 加速是锦上添花，不能反过来搞坏环境。
 */
async function installAccelPack(packId, env, log) {
  const pack = ACCEL_PACKS[packId]
  if (!pack) throw new Error(`不认识的加速包：${packId}（只支持白名单内的 ${Object.keys(ACCEL_PACKS).join(' / ')}）`)
  if (!packAppliesToOs(pack)) {
    throw new Error(
      `${pack.name} 不适用于当前系统（${process.platform}）；它只支持：${(pack.os ?? ['全平台']).join(' / ')}`,
    )
  }
  if (!env.py) throw new Error('还没定位到 ComfyUI 的 python，无法安装')

  // 已经装好了就不动它
  if (await probeAccelPack(pack, env, log)) {
    return { ok: true, id: pack.id, name: pack.name, skipped: '已经装好了，未做改动' }
  }

  const sources = ACCEL_SOURCES[packId] ?? []
  if (sources.length === 0) throw new Error(`${pack.name} 没有配置任何下载方案`)

  // ★★ 逐套尝试，**任一套成功即止**；一套不通就自动顶上下一套。
  //    这是"避免因用户网络环境装不上"的核心（见 ACCEL_SOURCES 的说明）。
  const attempts = []
  for (const source of sources) {
    const label = source.label ?? '未命名源'
    log('info', `安装 ${pack.name}：尝试「${label}」`)
    try {
      await runInstallSource(source, env)
      // 用**重新探测**判定成败，而不是"命令没抛异常就算成功"——
      // runShell 只回 stdout、拿不到退出码，装失败也可能干干净净地退出。
      if (await probeAccelPack(pack, env, log)) {
        log('info', `${pack.name} 安装成功（来源：${label}）`)
        return { ok: true, id: pack.id, name: pack.name, via: label, attempts }
      }
      attempts.push({ source: label, ok: false, note: '命令跑完了，但复检仍未就位' })
      log('warn', `「${label}」跑完但复检未通过 → 换下一个源`)
    } catch (error) {
      attempts.push({ source: label, ok: false, note: String(error?.message ?? error) })
      log('warn', `「${label}」失败：${error?.message ?? error} → 换下一个源`)
    }
  }

  // 全挂了也要给一句能照做的话，并明确"不影响出图"
  return {
    ok: false,
    id: pack.id,
    name: pack.name,
    attempts,
    hint: `所有下载方案（共 ${sources.length} 套）都没成功。可稍后重试，或照 ${pack.repo} 手动安装。`
      + '**这不影响出图**：缺件会自动降级到可用的链路。',
  }
}

/* ------------------------------------------------- 启动失败诊断（★ 2026-10-09）---- */

/**
 * ★★★ 启动状态与失败诊断 —— 这一块专治「点了启动，界面永远卡在"启动中"」。
 *
 * ## 根因（不是一个 bug，是三个叠在一起）
 *   ① `stdio: 'ignore'` → ComfyUI 的一切输出（包括"参数不认识"这种致命错误）**全被丢弃**；
 *   ② **没有监听 `exit`** → 进程秒退时插件毫无察觉，还在傻等它就绪；
 *   ③ **`starting` 状态没有任何过期机制** → 于是永远停在"启动中"，用户只能干等到天荒地老。
 *
 * ## 为什么这是"所有平台 + 所有显卡"的通用问题（不是偶发）
 *   · ComfyUI 一旦遇到**不认识的参数**就立刻 `exit 2` —— 实测：把
 *     `--use-quad-cross-attention` 误写成 `--use-cross-attention`，进程当场退出；
 *   · 而 attention 参数在**不同厂商、不同 ComfyUI 版本上支持的并不一致**
 *     （quad / pytorch / 有些老版本干脆不认），所以"参数被拒"是**必然会发生**的情况。
 *   · Windows 与 Linux 都走同一条 spawn 路径，所以修一处即可两边受益。
 *
 * ## 所以这里要做到四件事
 *   ① 保留 stderr → 拿得到错误原文；
 *   ② 监听 exit / error → 进程一退就知道；
 *   ③ 超时封顶 → 45 秒还没就绪就判失败（不再无限"启动中"）；
 *   ④ 认得出"参数被拒"这种错 → 自动去掉该参数重试一次（这才是真正通用的修法）。
 */
const LAUNCH_TIMEOUT_MS = 45000

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-09 **完全重写**：启动状态机（单一真相源）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要推倒重来
 *   之前是三轮补丁叠出来的，结果**两套状态并行**：
 *     · `launchState`（我在 2026-10-09 加的）
 *     · `comfyStartRequestedAt`（更早的"90 秒内算启动中"时间戳）
 *   两者都在决定 `starting`，互相覆盖，谁也说不清最终值。主人反复看到
 *   "一直卡在启动中"就是这么来的 —— 那是**状态机本身坏了**，不是某个判断写错。
 *
 * ## 现在的设计（就三条规则，没有例外）
 *   ① **只有一个事实来源**：`probe()` 探活的结果 + `phase`。
 *      `starting` 只由 `phase === 'starting'` 决定，**没有第二套时间戳**。
 *   ② **在线就是在线**：任何时刻探到通，phase 立刻变 `ready`，
 *      启动窗口、失败原因、计时全部清空 —— 不允许残留状态把界面卡住。
 *   ③ **窗口必然收口**：`starting` 有个硬性截止时间（45 秒）。
 *      到点还没通 → 变 `failed`（带原因）。**绝不会无限停在 starting。**
 *
 * ## 状态流转（穷举，没有别的可能）
 *   idle ──start()──▶ starting ──探到通──▶ ready
 *                        │
 *                        ├─ 日志出现致命错 ──▶ failed
 *                        ├─ 进程消失 ────────▶ failed
 *                        └─ 超过 45 秒 ──────▶ timeout
 *   ready ──探到不通──▶ idle（回到起点，下次可再启动）
 */
const launch = {
  /** idle | starting | ready | failed | timeout */
  phase: 'idle',
  /** 本次 starting 的开始时刻（ms）。phase 非 starting 时为 0。 */
  startedAt: 0,
  /** 失败/超时的原因（给界面显示）。 */
  error: '',
  /** 启动日志文件路径（拿错误原文用）。 */
  logPath: '',
}

/** 把状态重置为"在线"。**这是唯一的"成功"入口**，任何人探到通都该调它。 */
function launchMarkReady() {
  launch.phase = 'ready'
  launch.startedAt = 0
  launch.error = ''
}

/** 把状态置为"启动中"。 */
function launchMarkStarting(logPath) {
  launch.phase = 'starting'
  launch.startedAt = Date.now()
  launch.error = ''
  launch.logPath = logPath ?? launch.logPath
}

/** 置为失败（带原因）。 */
function launchMarkFailed(reason) {
  launch.phase = 'failed'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
}

/** 置为超时（无报错、纯等不到）。与 failed 分开，因为对用户含义不同。 */
function launchMarkTimeout(reason) {
  launch.phase = 'timeout'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
}

/**
 * ★ 纯函数：把 `launch` 状态折算成**给前端的三个布尔量**。
 *
 * 之所以单独抽出来：这样"界面到底显示什么"只取决于这一个函数，
 * 可以**直接单元测试**，不必启动整个插件去猜。
 *
 * @param online 探活结果
 * @returns {{starting:boolean, failed:boolean, timedOut:boolean, error:string}}
 */
function launchView(online) {
  if (online) {
    // ★ 规则②：在线就是在线 —— 任何残留的失败/启动态一律作废
    return { starting: false, failed: false, timedOut: false, error: '' }
  }
  const starting = launch.phase === 'starting' && Date.now() - launch.startedAt < LAUNCH_TIMEOUT_MS
  return {
    starting,
    failed: launch.phase === 'failed' || launch.phase === 'timeout',
    timedOut: launch.phase === 'timeout',
    error: launch.phase === 'failed' || launch.phase === 'timeout' ? launch.error : '',
  }
}

/**
 * stderr / 错误文本是否属于「参数不被支持」。
 * 各版本的措辞不一样，所以把常见的几种都覆盖上 —— argparse 是 Python 标准库，
 * 所以 `unrecognized arguments` 覆盖了绝大多数情况。
 */
function looksLikeBadArgs(text) {
  return /unrecognized arguments|unknown argument|invalid choice|no such option|error: argument/i
    .test(String(text ?? ''))
}

/** 从 stderr 尾部挑出一行最有用的错误（优先带 error/Error 的），供展示。 */
function summarizeLaunchError(stderrTail, exitNote) {
  const lines = String(stderrTail ?? '')
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const key = lines.filter((s) => /error|Error|Traceback|ModuleNotFound|cannot|failed/i.test(s))
  const picked = (key.length > 0 ? key : lines).slice(-3).join(' / ')
  return exitNote + (picked === '' ? '' : `：${picked}`)
}

/**
 * ★★★ 2026-10-09 新增：由**父进程 pid** 找出真正在跑 ComfyUI 的子进程 pid。
 *
 * ## 为什么必须这么做（Windows / Linux 踩到了同一个坑）
 *   启动 ComfyUI 时中间隔了一层"壳"：
 *     · Windows：`Win32_Process.Create` 起的是 **cmd.exe**，python 是它的子进程；
 *     · Linux  ：`setsid` 起的是 **sh / setsid**，python 也是子进程。
 *   拿这层壳的 pid 去做"进程还在不在"的存活检查是**错的** ——
 *   壳的死活跟 ComfyUI 的死活不是一回事。
 *   后果：进程明明活着却被判"已退出"（或反之），
 *   界面表现正是主人反复看到的**"一直卡在启动中"**。
 *
 * ✓ 正解：按**父子关系**找出真正的 python。查不到就返回 0 ——
 *   调用方会退化成"只靠探活判断"，那也远比盯错一个进程靠谱。
 */
async function resolveChildPid(parentPid, log) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return 0
  try {
    // ★ 关键：**不能只查一层子进程**。
    //   实测链路是 `WMI → cmd.exe → (可能还有一层) → python`，
    //   只查直接子进程经常扑空（日志里就记着"定位子进程失败（父 8980）"）。
    //   所以改成**按命令行全表搜**：谁的命令行含 main.py 且 pid 命中，
    //   就取谁 —— 这比顺着父子关系爬更稳，也省掉"中间隔了几层"的不确定性。
    const script = IS_WINDOWS
      ? "(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue "
        + "| Where-Object { $_.CommandLine -match 'main\\.py' -and $_.Name -match 'python' } "
        + '| Select-Object -First 1 -ExpandProperty ProcessId)'
      : "ps -eo pid=,args= 2>/dev/null | awk '/main\\.py/ && !/awk/ {print $1; exit}'"
    const out = await runShell(script, 10000)
    const pid = Number.parseInt(String(out).trim().split(/\s+/u).pop() ?? '', 10)
    if (Number.isSafeInteger(pid) && pid > 0) {
      log?.('info', `已定位 ComfyUI 进程 pid=${pid}（壳进程 ${parentPid}）`)
      diag('spawn', `真实 pid=${pid}（壳 pid=${parentPid}）`)
      return pid
    }
    // 兜底：直接子进程（有些环境下命令行匹配不到，但父子关系在）
    const childScript = IS_WINDOWS
      ? `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" -ErrorAction SilentlyContinue `
        + '| Select-Object -First 1 -ExpandProperty ProcessId)'
      : `ps -eo pid=,ppid= 2>/dev/null | awk -v p=${parentPid} '$2==p {print $1; exit}'`
    const childOut = await runShell(childScript, 10000)
    const childPid2 = Number.parseInt(String(childOut).trim().split(/\s+/u).pop() ?? '', 10)
    if (Number.isSafeInteger(childPid2) && childPid2 > 0) {
      log?.('info', `已定位 ComfyUI 子进程 pid=${childPid2}（父 ${parentPid}）`)
      diag('spawn', `子进程 pid=${childPid2}（父 ${parentPid}）`)
      return childPid2
    }
    // ⚠ 拿不到也不要紧：watchLaunchedProcess 会退化为"只靠探活+日志"，
    //   那才是权威事实来源。**绝不能因为拿不到 pid 就判失败**。
    log?.('warn', `未能定位 ComfyUI 的 pid，改为只靠探活判断（不影响启动）`)
    diag('spawn', `定位 pid 失败（壳 ${parentPid}），退化为探活判断`)
    return 0
  } catch (error) {
    log?.('warn', `解析子进程 pid 失败：${error?.message ?? error}`)
    return 0
  }
}

async function startComfyHidden(cfg, log) {
  // ★★ 2026-10-07 实测修正：**绝对不能用 pythonw.exe**！
  //    它没有控制台、sys.stdout 是 None，而 ComfyUI 启动时会大量 print ——
  //    一打印就抛异常、进程立刻退出。现象是出图报「240 秒内没就绪」，实际上
  //    python.exe 11 秒就能起（实测：pythonw 那次 8188 不在听、python 进程一个都没有）。
  //    正确组合 = python.exe + -WindowStyle Hidden：窗口藏住、输出流仍在。
  // ★ 2026-10-09（通用化）：路径不再写死 —— 先看配置，再自动探测。
  const found = await discoverComfyPaths(cfg, log)
  if (!found) {
    throw new Error(
      '找不到 ComfyUI 的安装位置（常见路径下都没发现 python + main.py 的组合）。\n'
      + '请在 cordis.patch.yml 的 config 里手动补上这三项后重试：\n'
      + "  comfyPython: 'X:\\...\\python.exe'\n"
      + "  comfyMainPy: 'X:\\...\\ComfyUI\\main.py'\n"
      + "  comfyWorkdir: 'X:\\...'",
    )
  }
  const { py, mainPy, workdir, from } = found
  if (from !== '配置') log('info', `自动探测到 ComfyUI：${mainPy}`)

  // ★ 启动参数：配置里的 comfyArgs 完全接管；否则按 **GPU 厂商 / 架构**自动选。
  //   skipOnline: 走到这里说明 ComfyUI 本来就连不上（不是我们要启动它吗），
  //   所以别再去敲 /system_stats 白等 6 秒。
  const gpu = await detectGpuProfile(cfg, log, { skipOnline: true })
  if (gpu.note) log('info', `注意：${gpu.note}`)
  // ★ 2026-10-09：把探测到的显存总量**回写 cfg** —— 这样面板里的「显存驻留」项
  //   与这里真正加的参数读的是同一个数，不会出现"面板说已启用、实际没加参数"的假报告。
  if (Number.isFinite(gpu.vramGB) && gpu.vramGB > 0) cfg.vramGB = gpu.vramGB
  const ATTN_FLAG = {
    quad: '--use-quad-cross-attention',
    pytorch: '--use-pytorch-cross-attention',
    // ★ 2026-10-11：ComfyUI 自带 `--use-ck-attention`（help 原文 "Use Comfy Kitchen attention"）。
    //   也开放给 `comfyAttentionBackend: ck` 手动指定。
    ck: '--use-ck-attention',
    default: null,
  }
  const explicit = cfg.comfyAttentionBackend
  let autoArgs = gpu.args ?? []
  if (explicit && explicit !== 'auto') {
    // 显式配置优先（用户想接管就让他接管）
    const flag = ATTN_FLAG[explicit]
    autoArgs = flag ? [flag] : []
    log('info', `注意力后端由配置指定：${explicit}`)
  } else {
    // ★★★ 2026-10-11：**A 卡专属优化（可选，默认关）** —— 与"厂商专属优化"同一套思路。
    //   两项都是**质量中性**的（换后端 / 改加载时机，都不改计算结果）：
    //     · `amdKernel`        —— 换本代的替代注意力内核（按代数挑 flag，见 AMD_KERNEL_FLAG）
    //     · `amdAsyncOffload`  —— `--async-offload`（N 卡默认开、A 卡默认关，这里补上）
    //   ⚠ 默认**一个都不加** —— 没实测过的卡上绝不擅自改默认路径。
    const kernelFlag = AMD_KERNEL_FLAG[gpu.id]
    if (kernelFlag && cfg.amdKernel === true) {
      autoArgs = [kernelFlag]
      log('info', `已启用 A 卡专属内核（可选）：${kernelFlag}`)
    }
    if (String(gpu.id ?? '').startsWith('amd') && cfg.amdAsyncOffload === true) {
      autoArgs = [...autoArgs, '--async-offload']
      log('info', '已启用 A 卡专属优化（可选）：--async-offload（异步权重卸载）')
    }
  }

  // ★★★ 2026-10-11 新增：**N 卡 SageAttention**（40 系 Ada / 50 系 Blackwell 的专属加速）。
  //   ⚠ `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，ComfyUI 直接起不来。
  //   ⇒ 三档（见 DEFAULTS.nvidiaSageAttention）：
  //        true  → 强制挂（用户确认装了）
  //        false → 永不挂
  //        auto / 未设 → **只在后台自检确认已装时**才挂；状态未知时**不加**（保守）
  if (String(gpu.id ?? '') === 'nvidia') {
    const mode = cfg.nvidiaSageAttention
    const want = mode === true || (mode !== false && SAGE_READY === true)
    if (want) {
      autoArgs = [...autoArgs, '--use-sage-attention']
      log('info', '已启用 N 卡 SageAttention：--use-sage-attention'
        + `（${mode === true ? '配置显式开启' : '后台自检确认已安装'}）`)
    } else if (mode !== false && SAGE_READY === null) {
      log('info', 'SageAttention 就绪状态未知（加速自检尚未跑完）→ 本次不加 --use-sage-attention；'
        + '下次启动 ComfyUI 会按自检结果决定。想强制开启可把 nvidiaSageAttention 设为 true')
    } else if (mode !== false) {
      log('info', 'SageAttention 未安装 → 不加 --use-sage-attention（装了之后自检会自动启用）')
    }
    const gen = nvidiaGenOf(gpu.detected)
    if (gen === 'blackwell') {
      log('info', '注意：50 系（Blackwell / sm_120）需要**支持 sm_120 的** Triton / SageAttention 构建，'
        + '老版本不认这代卡 —— 装了不匹配的版本反而会让 ComfyUI 起不来')
    }
  }

  // ★★★★ 2026-10-09 新增：**显存驻留参数** —— 这才是整条工作流 90 秒的真正解药。
  //
  // ## 问题（实测账，不是推测）
  //   加速节点只优化"采样那 8 步"（8~11 秒），而**整条工作流实测 90~150 秒**。
  //   差额几乎全在**模型反复装卸**上，日志里是这种模式：
  //       Requested to load QwenImage21     ← 装 6.9 GB
  //       Requested to load WanVAE          ← 装 VAE
  //       Unloaded partially: 1325.83 MB freed   ← 又卸
  //   原因：UNET(6.9) + CLIP(6.0) + VAE(0.64) ≈ 13.5 GB，
  //   而 ComfyUI 当时**只拿到 12.09 GB 可用**（19.98 GB 里有 7.89 GB 被占）
  //   ⇒ 装不下全部，只能"用完就卸、要用再装"，每次装卸按十秒计。
  //
  // ## ★★★ 2026-10-09 硬数据复核（scripts/_timing_forensics.py 跑出来的，不是推测）
  //   对 X:\ComfyUI\.dshqp-launch.log 里 6 笔出图逐笔拆解：
  //
  //       #  采样s    总s    非采样s  非采样%   加载MB   lowvram补丁
  //       1  124.0  169.75   45.75   27.0%    13584        0
  //       3   15.0   58.73   43.73   74.5%     1288        0
  //       4   28.0   45.99   17.99   39.1%    13584      156
  //       5   57.0   99.77   42.77   42.9%    13584        0
  //       6   45.0   79.70   34.70   43.5%    13584      150
  //       ─────────────────────────────────────────────────────
  //       平均非采样开销 = **36.99 s，占总耗时 40.7%**
  //
  //   三个关键事实：
  //   ① **非采样开销占四成** —— 用户看到的 80 秒里有 ~35 秒不是"在画画"，
  //      而是把 13.58 GB 模型（TE 6019 + UNET 6920 + VAE 644）重新搬进显存。
  //   ② **ComfyUI 全程只启动了 1 次**（"To see the GUI go to" / "Total VRAM"
  //      各只出现 1 次）⇒ 这**不是冷启动问题**，是模型被反复卸载又加载。
  //   ③ 第 3 笔只加载 1288 MB（模型已在显存）→ 采样只要 **15 s / 1.88 s每步**；
  //      需要全量加载的那几笔 → 采样 45~124 s。**差 3~8 倍。**
  //
  //   ⇒ 结论：**消除"每次重新加载 13.58 GB"，就是最大的一块时间。**
  //
  // ## 做法：按显存总量选驻留档位
  //   · ≥ 24 GB：`--highvram` —— 模型全留显存，绝不卸载（最快）
  //   · ≥ 16 GB：`--highvram` + **极少**保留 —— 刚好够装下 13.58 GB 那套 + 激活值
  //   · < 16 GB：不加（强行 highvram 会 OOM，退化成更糟的反复换页）
  //
  // ★★ 2026-10-09 二次修正：**保留量从 1.5 GB 降到 0.5 GB**。
  //   为什么：这台机器 19.98 GB，模型 13.58 GB，只剩 6.4 GB 给激活值；
  //   再被 reserve 扣掉 1.5 GB → 只剩 4.9 GB ⇒ 1408×1408 的激活装不下
  //   ⇒ ComfyUI 把模型切成 150~156 块换页（日志里 `lowvram patches: 150`）
  //   ⇒ 采样从 15 s 涨到 45 s。这 1.5 GB 恰恰是压垮骆驼的那根。
  //   降到 0.5 GB：既给桌面合成器留一口气，又把 1 GB 还给模型/激活。
  //   ⚠ 这是**权衡值**，不是实测最优值 —— 保留多少取决于本机桌面占多少显存。
  //
  // ⚠ 仅在**没显式配 comfyArgs** 时介入（用户接管就完全听用户的）。
  const VRAM_ARGS = (() => {
    const gb = Number(gpu.vramGB ?? 0)
    // 拿不到显存信息时不猜
    if (!Number.isFinite(gb) || gb <= 0) return { args: [], note: '' }
    // ★★★ 2026-10-11：**Apple Silicon 显式跳过** —— 统一内存没有独立显存，
    //   `--highvram` / `--reserve-vram` 这套是给**离散显存**设计的，
    //   搬到 MPS 上只会误导（而且 ComfyUI 官方对 Mac 也没给这类参数）。
    if (gpu.id === 'apple') {
      return {
        args: [],
        note: `Apple Silicon（统一内存，PyTorch 建议工作集约 ${gb} GB）`
          + ' → 不加离散显存驻留参数（--highvram 这套不适用于统一内存）',
      }
    }
    if (gb >= 24) {
      return { args: ['--highvram'], note: `${gb} GB ≥ 24 GB → --highvram（模型全驻留）` }
    }
    if (gb >= 16) {
      // 16~24 GB 区间：13.5 GB 那套装得下，但要给系统留一点，否则桌面会卡。
      // ★ 0.5 而非 1.5：见上面 2026-10-09 二次修正的实测账（19.98 GB 机器上
      //   1.5 GB 的保留会把 1408×1408 逼进换页，采样 15 s → 45 s）。
      return {
        args: ['--highvram', '--reserve-vram', '0.5'],
        note: `${gb} GB ∈ [16,24) → --highvram + 保留 0.5 GB 给系统`,
      }
    }
    // ★ 2026-10-11 撤回：这里一度想给 A 卡加"减负档"（`--cache-none` 等），
    //   **已删除** —— 主人明确纠正：「我说的是做**专门的优化**，不是以降低原生质量为代价」。
    //   `--cache-none` 的原文是 "Reduced RAM/VRAM usage **at the expense of executing
    //   every node for each run**" —— 那是**拿性能换空间**，不是优化，方向错了。
    //   A 卡的专属优化改为**可选、质量中性**的开关，见 `amdKernel` / `amdAsyncOffload`。
    return {
      args: [],
      note: `${gb} GB < 16 GB → 不加驻留参数（强行 highvram 会 OOM，反而不如让 ComfyUI 自己调度）`,
    }
  })()

  const useAutoArgs = !Array.isArray(cfg.comfyArgs)
  const finalArgs = useAutoArgs ? [...autoArgs, ...VRAM_ARGS.args] : cfg.comfyArgs
  if (useAutoArgs && VRAM_ARGS.note) log('info', `显存驻留：${VRAM_ARGS.note}`)

  const extraArgs = finalArgs
  log('info', `启动参数：${extraArgs.length > 0 ? extraArgs.join(' ') : '(无额外参数)'}`)
  const args = [
    '-s', mainPy,
    // --windows-standalone-build 只对 Windows 便携包有意义；Linux 上不加（无意义，个别版本还会挑刺）
    ...(IS_WINDOWS ? ['--windows-standalone-build'] : []),
    '--disable-auto-launch',
    ...extraArgs,
  ]

  // ★★★★ 2026-10-09 重大修正：**把 spawn 换回"平台原生派生进程"**。
  //
  // ## 为什么（实测结论，不是推测）
  //   我上一轮为了"修复 Linux 上没有 Start-Process"而改成 Node 的 `spawn`，
  //   结果**把 Windows 上也搞坏了** —— 本机实测三种方式启动同一个 ComfyUI：
  //     · PowerShell `Start-Process`            → ✅ 进程存活、8188 正常监听
  //     · `spawn(detached: true)` + unref()     → ❌ 进程随即消失
  //     · `spawn()`（普通、不 detached）         → ❌ 进程随即消失
  //   端口空着、无并发冲突，两种 spawn 都是"起来了又没了"。
  //   而 DSH 宿主（Electron）不是控制台进程，Node 在这种宿主里派生的子进程
  //   很容易随宿主的活动/作业对象被回收 —— 这正是主人遇到的"后端拉不起来"。
  //
  // ## 现在的做法：各平台用各自的"脱离式启动"
  //   · Windows：`Start-Process -WindowStyle Hidden` —— 它是**独立进程**，
  //     不属于 DSH 的作业对象，宿主重启也不会把它带走（这正是 2026-10-08 那条
  //     "DSH 重启后 ComfyUI 被连带杀死"的教训所指向的正解）。
  //   · Linux：`setsid ... &` —— 新会话（new session）里跑，
  //     同样脱离父进程的进程组，且 `setsid` 是 util-linux 标准组件，普遍都有。
  //
  // ## stderr 怎么办（这才是真正的难点）
  //   进程由 shell 派生，Node 拿不到它的 stderr 流了。所以改成
  //   **把 stderr 重定向到临时文件**，失败时回头读那个文件 —— 见下面的 readLaunchLog。
  //   不能像以前那样用 spawn 的 'pipe'：那个方案正是让进程活不下来的原因。
  const launchLog = path.join(comfyDirsFrom(found).base, '.dshqp-launch.log')
  let childPid = 0
  try {
    if (IS_WINDOWS) {
      // ★★★★ 2026-10-09 实测得出的**唯一可靠方式**（试了四种，只有这种活下来）：
      //     ① 直接 `Start-Process`（在会话里）           → ✅ 存活
      //     ② 经 `powershell -Command` 包一层            → ❌ 进程被父 shell 收走
      //     ③ Node `spawn(detached)` / 普通 `spawn`      → ❌ 进程消失
      //     ④ WMI `Win32_Process.Create` + 内联长命令行   → ❌ cmd 引号被吃、压根没跑
      //     ⑤ **写 .cmd 文件 + WMI 创建该文件**           → ✅ **存活、8188 正常监听**
      //
      //   为什么最终选 ⑤：
      //     · WMI 由服务端直接派生进程，**不属于任何 shell、也不属于 DSH 的作业对象**，
      //       父 shell 退出与 DSH 重启都不会带走它（顺带解决了 2026-10-08
      //       "DSH 重启后 ComfyUI 被连带杀死"那个老问题）；
      //     · 走 .cmd 文件则彻底绕开**多层引号嵌套**这个坑 ——
      //       内联写法里 python 路径带空格/反斜杠时，引号会被 cmd 与 PowerShell 各吃一层，
      //       表现为"命令返回成功、但什么都没发生、日志也不生成"（踩过）。
      //
      //   stderr 依然保留：在 .cmd 里用 `>` 重定向写进日志文件，
      //   失败时由 readLaunchLog 读回来 —— 这是能给出"能照做的原因"的前提。
      //
      // ★★★ 另一个关键修正：**pid 不能拿 WMI 返回的那个**。
      //   `Win32_Process.Create` 返回的是 **cmd.exe 的 pid**，而真正跑 ComfyUI 的
      //   是它启动的 python（**子进程**，pid 完全不同）。拿 cmd 的 pid 去做
      //   "进程还在不在"的存活检查，会在 python 已经退出时仍看到 cmd 还活着
      //   （或反之），判断直接失真。
      //   ✓ 让 .cmd 自己把 **python 的 pid** 写进文件 —— `%~dp0` 无关，
      //     用 wmic/PowerShell 都太重，这里用最朴素的办法：cmd 启动 python 前
      //     先记下自己的 pid 不够（那是 cmd 的），
      //     所以改为**由 python 自己写 pid**？不行，ComfyUI 不干这事。
      //     最终用 PowerShell 的 `-Resolve` 思路：启动后由外部查"哪个 python 的父进程是它"。
      //     —— 见下方 readChildPid，靠**父子关系**拿到真实 python pid。
      const batPath = path.join(comfyDirsFrom(found).base, '.dshqp-launch.cmd')
      const line = [py, ...args].map((a) => `"${String(a)}"`).join(' ')
      // ★★★★ 2026-10-09 新增（主人要求「每次拉起后端时自动最小化窗口，别让人再手动点掉」）：
      //   `cmd.exe /c` 会在桌面弹一个控制台黑窗，且**不会自己消失**
      //   （python 一直在前台跑，cmd 得等着它）→ 每次启动后端都要人手动点掉。
      //
      // ## 做法：启动 python **之前**，用 powershell 把控制台窗口最小化
      //   时序是关键：必须在 `line`（启动 python）之前。放到后面的话，
      //   python 已占住前台，那条命令要等 ComfyUI 退出才执行 —— 等于没用。
      //
      // ## 为什么把 PowerShell 脚本放**独立文件**而不是内联
      //   内联 `.cmd` 里嵌 PowerShell 要穿四五层引号（cmd → powershell → C# 签名），
      //   实测极易被吃坏。改成独立 .ps1 后 **零引号嵌套**，只需 `-File` 一个参数。
      //
      // ## ⚠⚠ 写 .ps1 的硬性约束（四次实测才搞明白，务必保留）
      //   **.ps1 必须是纯 ASCII！** PowerShell 5.1 在没有 BOM 时按 ANSI 读 .ps1，
      //   中文注释会被解成乱码 → 解析错位 → 报**完全不相干的行**上
      //   `表达式或语句中包含意外的标记"}"`（ParserError: UnexpectedToken）。
      //   我为此白折腾了三轮。所以下面用 fsp.writeFile 写**英文注释**的 ps1。
      //
      // ## 为什么选 SW_MINIMIZE(6) 而不是 SW_HIDE(0)
      //   隐藏后用户在任务栏找不到入口，ComfyUI 万一卡住他想看日志都看不到；
      //   最小化只是收进任务栏 —— 不碍事，但需要时点一下就能看。
      const ps1Path = path.join(comfyDirsFrom(found).base, '.dshqp-minwin.ps1')
      const ps1 = [
        '# Minimize the ComfyUI launcher console window. Generated by dsh-qwen-paint.',
        '# MUST STAY PURE ASCII: PowerShell 5.1 reads .ps1 as ANSI without a BOM,',
        '# so non-ASCII comments corrupt the parse (bogus "unexpected token }").',
        '#',
        '# 2026-10-10 KEY FIX (window never got minimized):',
        '# When the default terminal is Windows Terminal (Win11 default), GetConsoleWindow()',
        '# returns an INVISIBLE pseudo-console window (non-zero handle). ShowWindow on it has',
        '# NO visible effect -- and because the old script accepted any non-zero handle,',
        '# the later "find window by class" fallbacks were never reached. So nothing minimized.',
        '# New order: prefer a VISIBLE window (by title first, then by class), own console last.',
        '$sig = @(',
        '  \'[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);\',',
        '  \'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\',',
        '  \'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);\',',
        '  \'[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder s, int n);\',',
        '  \'[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();\'',
        ') -join [Environment]::NewLine',
        '$api = Add-Type -MemberDefinition $sig -Name WinApi -Namespace DshqpHelp -PassThru',
        '$title = \'DSHQP-ComfyUI\'',
        '$hwnd = [IntPtr]::Zero',
        '$how = \'\'',
        '# 1) by title (the .cmd runs: title DSHQP-ComfyUI) -- most precise, works on WT + conhost',
        '$h = $api::FindWindow($null, $title)',
        'if ($h -ne [IntPtr]::Zero) { $hwnd = $h; $how = \'title\' }',
        '# 2) a VISIBLE Windows Terminal window',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $h = $api::FindWindow(\'CASCADIA_HOSTING_WINDOW_CLASS\', $null)',
        '  if ($h -ne [IntPtr]::Zero -and $api::IsWindowVisible($h)) { $hwnd = $h; $how = \'WT\' }',
        '}',
        '# 3) a VISIBLE classic console window',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $h = $api::FindWindow(\'ConsoleWindowClass\', $null)',
        '  if ($h -ne [IntPtr]::Zero -and $api::IsWindowVisible($h)) { $hwnd = $h; $how = \'console\' }',
        '}',
        '# 4) last resort: our own console window -- only if it is actually visible',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $own = $api::GetConsoleWindow()',
        '  if ($own -ne [IntPtr]::Zero -and $api::IsWindowVisible($own)) { $hwnd = $own; $how = \'own\' }',
        '}',
        'if ($hwnd -ne [IntPtr]::Zero) { $null = $api::ShowWindow($hwnd, 6) }',
        '# Write the outcome to a log -- the old script swallowed everything, so failures were invisible.',
        '$cls = New-Object System.Text.StringBuilder 256',
        'if ($hwnd -ne [IntPtr]::Zero) { $null = $api::GetClassName($hwnd, $cls, 256) }',
        '$line = (Get-Date).ToString(\'s\') + \' hwnd=\' + $hwnd + \' how=\' + $how + \' class=\' + $cls.ToString()',
        '$logPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) \'.dshqp-minwin.log\'',
        'Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue',
        '',
      ].join('\r\n')
      let minWinLine = ''
      try {
        await fsp.writeFile(ps1Path, ps1, 'ascii')
        // 先 start /b 起 powershell（它自己用 -WindowStyle Hidden 不显示窗口），
        // 让它去最小化 cmd 的窗口；`>nul 2>&1` 免得它自己往控制台打字。
        // ⚠ `DSHQP_NOMIN=1` 是留的逃生门：万一这个最小化在某些环境上出问题，
        //   用户可以在启动前设这个环境变量把这段跳过（不必改代码）。
        minWinLine = [
          'if not "%DSHQP_NOMIN%"=="1" (',
          '  start "" /b powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass'
            + ` -WindowStyle Hidden -File "${ps1Path}" >nul 2>&1`,
          ')',
        ].join('\r\n')
      } catch (error) {
        // ★ 最小化只是"体验优化"，**绝不能因为它失败就不启动后端**。
        log('warn', `生成窗口最小化脚本失败（不影响启动）：${error?.message ?? error}`)
      }
      await fsp.writeFile(
        batPath,
        [
          '@echo off',
          // ★ 2026-10-10：给控制台一个**唯一标题** —— 最小化脚本优先按它精确定位窗口
          //   （Win11 用 Windows Terminal 时按类名找会撞上别的终端窗口，按标题最稳）。
          //   顺带也让任务栏里显示成 "DSHQP-ComfyUI" 而不是 "cmd.exe"，更好认。
          'title DSHQP-ComfyUI',
          minWinLine,
          `${line} > "${launchLog}" 2>&1`,
          '',
        ].join('\r\n'),
        'utf8',
      )
      const script = [
        "$ErrorActionPreference = 'Stop'",
        // ⚠ `-Arguments @{...}` 是**哈希字面量**，内部**不能用分号**把多行压成一行 ——
        //   压了以后 PowerShell 会报 IncompleteHashLiteral（实测踩到）。
        //   所以这里用数组的 join("\n") 保留真正的换行。
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{`,
        `  CommandLine = 'cmd.exe /c "${batPath.replace(/'/gu, "''")}"'`,
        `  CurrentDirectory = '${workdir.replace(/'/gu, "''")}'`,
        '}',
        'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create 失败，ReturnValue=$($r.ReturnValue)" }',
        'Write-Output $r.ProcessId',
      ].join('\n')
      const out = await runShell(script, 30000)
      const cmdPid = Number.parseInt(String(out).trim().split(/\s+/u).pop() ?? '', 10) || 0
      // ★ 关键一步：拿到的只是 cmd.exe 的 pid，真实 python 是它的子进程 —— 查出来。
      childPid = await resolveChildPid(cmdPid, log)
    } else {
      // ══ Linux / macOS ══
      // ★★★ 2026-10-09 修正（**真 bug**）：原先写的是
      //     `setsid nohup <cmd> & echo $!` —— 那样拿到的 `$!` 是 **setsid 的 pid**，
      //     而 setsid 会立刻 exec 成目标进程……**大多数情况下没问题，但并不总是**：
      //     setsid 若是 fork 后再 exec（util-linux 在某些场景下会），
      //     真正跑 ComfyUI 的是**它的子进程**，用 setsid 的 pid 去做存活检查就会查错对象
      //     → 进程明明活着却被判"已退出" → 界面报"启动失败"。
      //
      //   ✓ 现在改用 `--fork` 明确的语义 + **用 pid 文件**回报真实 pid：
      //     `setsid --fork` 让 setsid 直接返回、目标进程独立成会话首进程；
      //     再加 `sh -c 'echo $$ > pidfile'` 把**真正执行者的 pid** 写出来。
      //     这样无论 setsid 怎么实现，我们盯的都是那个真正在跑的 shell（及其子进程）。
      //
      //   ⚠ `--fork` 是 util-linux 的写法；macOS 的 setsid 没有这个选项（其实 macOS
      //     根本没有 setsid 命令），所以下面做了**能力探测**，没有 setsid 时退回
      //     `nohup ... &`（macOS 上够用：nohup 已能免疫挂断信号）。
      const q = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
      const pidFile = `${launchLog}.pid`
      const inner = [py, ...args].map(q).join(' ')
      // 用一层 sh 包住：先把**自己的 pid** 写进文件，再 exec 目标（exec 不换 pid）
      const wrapped = `sh -c 'echo $$ > ${q(pidFile)}; exec ${inner}'`
      const hasSetsid = await runShell(
        'if command -v setsid >/dev/null 2>&1; then echo YES; else echo NO; fi',
        8000,
      )
      const cmd = hasSetsid.trim() === 'YES'
        ? `setsid --fork sh -c ${q(wrapped)}`
        : `nohup sh -c ${q(wrapped)} &`
      await runShell(`${cmd} >${q(launchLog)} 2>&1 < /dev/null &`, 30000)
      // 稍等一下让 pid 文件落盘，再读真实 pid
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        childPid = Number.parseInt(String(await fsp.readFile(pidFile, 'utf8')).trim(), 10) || 0
      } catch {
        childPid = 0
      }
    }
  } catch (error) {
    launchMarkFailed(`无法启动进程（${py}）：${error?.message ?? error}`)
    log('error', `启动 ComfyUI 失败：${error?.message ?? error}`)
    return
  }

  launchMarkStarting(launchLog)
  log('info', `已拉起 ComfyUI 进程（pid=${childPid || '未知'}），等待它就绪…`)
  diag('start', `已拉起 pid=${childPid || 0} args=${args.join(' ')}`)

  // ★ 脱离式的子进程拿不到 exit 事件，所以**用轮询看它还在不在**。
  //   这与状态端点的 5 秒轮询解耦：这里 1 秒一次、只查进程存活，开销极小。
  //   ⚠ pid 为 0（没定位到）时仍然要监视 —— 见 watchLaunchedProcess 的说明：
  //     它会退化成"只靠探活 + 日志"，这比完全不监视安全得多。
  watchLaunchedProcess(cfg, log, childPid)
}

/**
 * 看着刚拉起的进程：它要是**提前死了**，就判失败并把日志里的原因摘出来。
 *
 * ★ 为什么不能用 `child.on('exit')`：改用 Start-Process / setsid 之后，
 *   进程由 shell 派生，Node 这边**没有它的句柄**，自然会收不到 exit 事件。
 *   所以退回到"定时看它还在不在" —— 简单、跨平台、且不依赖任何句柄。
 *
 * ⚠ 只在 state === 'starting' 期间工作，一旦就绪（或超时）立刻自行退出，
 *   不会变成常驻轮询、也不会和状态端点重复请求 ComfyUI 接口。
 */
function watchLaunchedProcess(cfg, log, pid) {
  // ★★★ 不再因为 pid<=0 就整个放弃监视。
  //   拿不到可靠 pid 时仍要盯着：**探活 + 日志**这两条路一样能判断成败，
  //   而且它们才是权威事实。只有"进程存活查询"这一步会被跳过（见循环里）。
  const hasPid = Number.isSafeInteger(pid) && pid > 0
  let checks = 0
  const timer = setInterval(async () => {
    checks += 1
    // 已经就绪 / 已经判过失败 / 已经查够次数（45 秒 ÷ 1 秒）→ 收摊
    if (launch.phase !== 'starting' || checks > 46) {
      clearInterval(timer)
      return
    }

    // ★★★ 2026-10-09 竞态防护：**先确认它真的还没就绪**，再谈失败。
    //   实测踩到过：ComfyUI 明明 9 秒就绪了，但日志里那句
    //   「No OpenGL_accelerate module loaded」被误判成致命错 → 状态被设成 failed，
    //   而进程其实活得好好的、端口也通了。用户看到的就是"报错了但明明能用"。
    //   所以每轮先探一次活；**只要在线就立刻收摊并置为 ok**，根本不给误判机会。
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
      if (res.ok) {
        clearInterval(timer)
        launchMarkReady()
        if (typeof log === 'function') log('info', 'ComfyUI 已就绪（启动监视结束）')
        return
      }
    } catch {
      /* 还没起来，继续往下判 */
    }

    // ★★★ 2026-10-09（主人要求：「如果直接启动失败你就直接报错，不要等 45 秒」）：
    //   **先查日志**再查进程 —— 日志里一旦出现致命错误，立刻报错并收摊，
    //   根本不用等进程真的死掉、更不用等 45 秒超时。
    //   典型：`unrecognized arguments`（参数被拒）、`Port 8188 is already in use`
    //   （端口被占）、`ModuleNotFoundError`（依赖缺失）—— 这些一出现就注定失败。
    const tail = await readLaunchLog(launch.logPath)
    if (tail !== '') {
      const fatal = fatalLineInLog(tail)
      if (fatal !== '') {
        clearInterval(timer)
        const hint = looksLikeBadArgs(tail)
          ? '。这看起来是**启动参数不被当前 ComfyUI 支持** —— 可在 cordis.patch.yml 里把 '
            + 'comfyArgs 设为 [] 或改 comfyAttentionBackend 后重试'
          : ''
        launchMarkFailed(fatal + hint)
        log('error', `ComfyUI 启动失败（日志已报错，立即判定）：${launch.error}`)
        return
      }
    }

    // ★★★ 再看进程还在不在。
    //   ⚠⚠ 这里有个**必须守住的前提**：pid 无效时**绝不能**做存活判断。
    //   实测踩到：`resolveChildPid` 没定位到时 pid=0，而 `Get-Process -Id 0`
    //   必然失败 → `alive=false` → **立刻被判成"进程已退出"** →
    //   界面报"启动失败"，可 ComfyUI 其实正在正常加载。
    //   （这正是主人反复看到"卡在启动中/启动失败"的直接原因之一。）
    //   ✓ 拿不到可靠 pid 时**跳过存活判断**，把结论完全交给"探活 + 日志"——
    //     探活才是唯一权威的事实来源。
    if (hasPid) {
      let alive = false
      try {
        const out = await runShell(
          IS_WINDOWS
            ? `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`
            : `if kill -0 ${pid} 2>/dev/null; then echo YES; else echo NO; fi`,
          8000,
        )
        alive = out.trim() === 'YES'
      } catch {
        // 查询命令本身失败（powershell 起不来等）→ **不能**据此判定进程死了
        alive = true
        diag('watch', `存活查询失败，本轮跳过判定（pid=${pid}）`)
      }
      if (alive) return
    } else {
      // 没有可靠 pid：**只报告，不判定** —— 结论完全交给探活与日志
      return
    }
    // 进程确认已消失 —— 读日志给出原因
    clearInterval(timer)
    // ★ 如果错在「参数不被支持」，把提示写得更能照做：
    //   各厂商 / 各版本支持的 attention 参数并不一致，这是最常见的一种失败。
    //   （不再自动重试 —— 用户可以从菜单里点重试，或把 comfyArgs 清空，更可控。）
    const base = summarizeLaunchError(tail, `进程在就绪前退出（pid=${pid}）`)
    const hint = looksLikeBadArgs(tail)
      ? '。这看起来是**启动参数不被当前 ComfyUI 支持** —— 可在 cordis.patch.yml 里把 '
        + 'comfyArgs 设为 [] 或改 comfyAttentionBackend 后重试'
      : ''
    launchMarkFailed(base + hint)
    log('error', `ComfyUI 启动失败：${launch.error}`)
  }, 1000)
  if (typeof timer.unref === 'function') timer.unref()
}

/**
 * ★ 2026-10-09 新增：从日志里找出「注定失败」的那一行，找到就立刻报错、不等超时。
 *
 * 为什么需要它：有些失败**压根不会让进程立刻退出**（例如端口被占时，
 * 有的版本是先打印 ERROR 再自己退），也可能进程挂着不动。
 * 与其等 45 秒超时，不如一看到这些关键字就当场判定 ——
 * 主人明确要求「如果直接启动失败你就直接报错，不要等 45 秒」。
 *
 * ⚠ 关键字只挑**确定致命**的，不能把普通 WARN 也算进来（否则会误报失败）。
 */
function fatalLineInLog(text) {
  const FATAL = [
    // ⚠ 只放**真正致命**的。每条都是踩坑后收进来的：
    //   · `unrecognized arguments` —— argparse 拒绝参数，进程当场退
    //   · `is already in use`      —— 端口被占，起不来
    //   · `ModuleNotFoundError:`   —— **必须带冒号**
    //   · `ImportError:`           —— **必须带冒号**
    //   ⚠⚠ 绝不能写成泛化的 /No module named/ —— ComfyUI 正常启动时会打
    //      「No OpenGL_accelerate module loaded: No module named 'OpenGL_accelerate'」，
    //      那只是一句 INFO（可选加速模块没装），**完全不影响运行**。
    //      实测：这行误判把一次**成功**的启动报成了"启动失败"，是本文件最阴的坑。
    /unrecognized arguments/i,
    /is already in use/i,
    /ModuleNotFoundError:/i,
    /ImportError:/i,
    /Traceback \(most recent call last\)/i,
    /Address already in use/i,
  ]
  const lines = String(text ?? '').split(/\r?\n/u).map((s) => s.trim()).filter((s) => s !== '')
  // 从后往前找：最后出现的错误最有代表性
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // 去掉 ANSI 颜色码再匹配（ComfyUI 的 [ERROR] 是带色的）
    const clean = lines[i].replace(/\u001B\[[\d;]*m/gu, '')
    // ★ 第二道闸：明确标了 INFO / WARNING / DEBUG 的行**一律不当致命** ——
    //   有些 INFO 行里恰好含关键词（那句 OpenGL 提示就是），靠前缀把它们挡掉。
    if (/^\[?(INFO|WARNING|DEBUG)\]?[\s:]/i.test(clean) && !/\[ERROR\]/i.test(clean)) continue
    if (FATAL.some((re) => re.test(clean))) return clean.slice(0, 300)
  }
  return ''
}

/** 读启动日志的尾部；读不到就返回空串（绝不抛错）。 */
async function readLaunchLog(logPath) {
  if (!logPath) return ''
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    return String(text).slice(-2000)
  } catch {
    return ''
  }
}

/**
 * ★ 2026-10-09：**不再需要 `startComfyHiddenWith`（spawn 版的重试入口）**。
 *
 * 它当初是为"参数被拒就降级重试"抽出来的，但用的是 `spawn` —— 而实测已证明
 * spawn 在本机（DSH/Electron 宿主里）起的 ComfyUI 会立刻消失。
 * 参数降级的能力**并没有丢**：现在由状态端点里的超时/退出判定 + 菜单里的
 * 「点此重试」按钮承担 —— 用户去掉注意力参数（`comfyArgs: []`）或点重试即可，
 * 比自动重试更可控，也不会在后台悄悄多起一个进程。
 */

/**
 * ★ 探活；没开就**隐藏启动**并等它就绪 —— 主人要求后端完全不可见、且全自动。
 * 配合空闲关停：出图前自动拉起、闲置 5 分钟自动关掉，全程不需要主人动手。
 */
async function ensureComfyUp(cfg, log, signal) {
  try {
    await assertComfyUp(cfg, signal)
    // ★ 规则②：一开始就在线 —— 直接置 ready，别留下任何过期的启动态
    launchMarkReady()
    // ★ 2026-10-10（提速 M8）：预热能力探测（fire-and-forget）。
    //   命中缓存时是空操作；未命中时提前把 10 次 /object_info 的往返做掉，
    //   这样下面 runDraw 里的 probeCapabilities 直接命中缓存，不占关键路径。
    probeCapabilities(cfg, log, signal).catch(() => {})
    return
  } catch (error) {
    if (cfg.autoStartComfy === false) throw error
    log('info', 'ComfyUI 没在跑 → 后台隐藏启动它')
  }
  await startComfyHidden(cfg, log)
  // ★★★ 2026-10-10 修 bug：`startComfyHidden` 在 spawn 失败时是 **`launchMarkFailed()` + `return`**
  //   （**不抛错**），原代码无法区分"已拉起"与"拉起即失败"，于是照样进等待循环、空等满 240 秒，
  //   到点还会把已经明确的 `failed` **覆盖成 `timeout`**（用户看到的失败原因被抹掉）。
  //   ⇒ 补一道：启动已判失败就当场抛，保留原因。
  if (launch.phase === 'failed') {
    throw new Error(launch.error || 'ComfyUI 启动失败（进程未能拉起）')
  }
  const started = Date.now()
  // ★ 等待上限：默认 240 秒（首次要加载十几 GB 模型，慢是正常的）。
  //   它**只决定 `ensureComfyUp` 这个调用等多久**；界面上"启动中"的显示上限
  //   由 LAUNCH_TIMEOUT_MS（45 秒）独立决定 —— 两者职责不同，不要混。
  const limit = Number(cfg.startTimeoutMs ?? 240000)
  for (;;) {
    // 监视器（watchLaunchedProcess）可能已把状态置成 failed/timeout → 立即结束，不再空等。
    if (launch.phase === 'failed' || launch.phase === 'timeout') {
      throw new Error(launch.error || 'ComfyUI 启动失败')
    }
    if (Date.now() - started > limit) {
      // 只在仍处"启动中"时才置超时 —— 避免把已经明确的"失败"覆盖成"超时"。
      if (launch.phase === 'starting') {
        launchMarkTimeout(
          `等待 ${Math.round(limit / 1000)} 秒仍未就绪（首次要加载十几 GB 模型，可能更久）`,
        )
      }
      throw new Error(
        `已在后台启动 ComfyUI，但 ${Math.round(limit / 1000)} 秒内没就绪（首次要加载十几 GB 模型，可能更久）。`
        + '稍等一会儿再让我画一次即可。若一直不行，可在左下角状态点菜单里点「启动 ComfyUI」重试，'
        + '或手动启动你机器上的 ComfyUI。',
      )
    }
    if (signal?.aborted) throw cancelReason(signal)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      await assertComfyUp(cfg, signal)
      // ★ 规则②：探到通就置 ready —— **就地**改，不指望别人擦屁股。
      //   （之前这里只 log 不改状态，是"永远卡在启动中"的直接原因。）
      launchMarkReady()
      log('info', `ComfyUI 已就绪（等了 ${Math.round((Date.now() - started) / 1000)} 秒）`)
      // ★ 2026-10-10（提速 M8）：刚起来就预热能力探测，别等第一次出图才探 10 次。
      probeCapabilities(cfg, log, signal).catch(() => {})
      return
    } catch {
      /* 还在加载，继续等 */
    }
  }
}

/** 探活：ComfyUI 在不在，不在就给一句能照做的提示。 */
async function assertComfyUp(cfg, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 8000, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    throw new Error(
      `连不上本机 ComfyUI（${cfg.comfyUrl}）：${error?.message ?? error}\n` +
        '请先启动 ComfyUI（例如双击 D:\\ComfyUI\\启动ComfyUI.bat，或先打开「小鲸鱼生图」），' +
        '等服务起来后再让我画一次。',
    )
  }
}

/**
 * ComfyUI 状态（带缓存）。
 * 缓存是为了让客户端每 5 秒的轮询不至于每次都去敲 ComfyUI（它可能正忙）。
 */
function makeComfyStatus(cfg) {
  let cache = { at: 0, online: false }
  /** ★ 2026-10-09：队列忙碌状态的短缓存（见 queueBusy 的说明）。 */
  let queueCache = { at: 0, busy: false }
  return {
    async probe(force = false) {
      const now = Date.now()
      if (!force && now - cache.at < cfg.statusCacheMs) return cache.online
      let online = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
        online = res.ok
      } catch {
        online = false
      }
      cache = { at: now, online }
      return online
    },
    /** 队列里有东西就算了"忙"——空闲关停会因此续期，绝不打断别人正在跑的任务。 */
    async queueBusy() {
      // ★ 2026-10-09：加个 2 秒的短缓存。
      //   `probe()` 本来就有 statusCacheMs 缓存，而这里原先**每次都真发请求** ——
      //   两边不对称，等于每轮状态轮询都固定多打一次 ComfyUI。
      //   2 秒足够挡住"同一轮里被调两次"（状态端点 + 空闲关停检查），
      //   又不会让"忙/闲"的显示明显滞后。
      const now = Date.now()
      // ★ 2026-10-11：TTL 做成**可配置**（默认 2000ms，生产行为一字不变）。
      //   起因：TTL 原先是写死的 2000 —— 自测里连续断言"忙/闲"两种状态时，
      //   第二次调用必然命中缓存、测不出变化（自测只能靠 sleep 绕过，又慢又不稳）。
      //   现在 `cfg.queueCacheMs` 可覆盖：生产不配 = 沿用 2 秒；自测置 0 = 每次真查。
      if (now - queueCache.at < (cfg.queueCacheMs ?? 2000)) return queueCache.busy
      let busy = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
        if (res.ok) {
          const data = await res.json()
          const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0
          const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
          busy = running + pending > 0
        }
      } catch {
        busy = false
      }
      queueCache = { at: now, busy }
      return busy
    },
    invalidate() {
      cache = { at: 0, online: cache.online }
    },
  }
}

/* ------------------------------------------------- 空闲关停 + 进程识别（★ 安全） ---- */

/**
 * ★★ 找出"确实是 ComfyUI"的进程。两道闸：
 *   ① 它必须正监听 ComfyUI 的端口；
 *   ② 它的命令行必须同时含 `comfy` 与 `main.py`（本机启动命令是
 *      `…\python_embeded\python.exe -s .\ComfyUI\main.py --windows-standalone-build`）。
 * 只要有一条不满足就返回 null —— **绝不动手**。宁可留着占显存，也不误杀别人的进程。
 * @returns {{pid:number, commandLine:string}|null}
 */
async function findComfyProcess(cfg, log) {
  const port = portOf(cfg.comfyUrl)
  try {
    // ★ 2026-10-09 补齐 Linux：这两个命令原先**只有 PowerShell 版**，
    //   在 Linux 上 sh 会直接报 "command not found"，被下面的 catch 吞掉 →
    //   表现为"空闲关停静默失效"（不会误杀进程，但也永远关不掉）。
    const pidText = IS_WINDOWS
      ? await runShell(
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | `
        + 'Select-Object -First 1 -ExpandProperty OwningProcess)',
      )
      // Linux：优先 lsof（最省事），没有就退回 ss + sed 提取 pid=
      : await runShell(
        `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1; `
        + `ss -ltnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1`,
      )
    const pid = Number.parseInt(String(pidText).split(/\s+/u)[0] ?? '', 10)
    if (!Number.isInteger(pid) || pid <= 0) return null

    const commandLine = IS_WINDOWS
      ? await runShell(
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | `
        + 'Select-Object -ExpandProperty CommandLine)',
      )
      // Linux：`ps -o args=` 取完整命令行（含参数）
      : await runShell(`ps -p ${pid} -o args= 2>/dev/null`)

    if (!/comfy/iu.test(commandLine) || !/main\.py/iu.test(commandLine)) {
      log('warn', `端口 ${port} 上的 PID ${pid} 命令行不像 ComfyUI，拒绝关闭：${commandLine.slice(0, 160)}`)
      return null
    }
    return { pid, commandLine }
  } catch (error) {
    log('warn', `识别 ComfyUI 进程失败：${error?.message ?? error}`)
    return null
  }
}

/**
 * 空闲关停器。
 *
 * ★ 计时**只在插件出过图之后**才开始：`lastActivityAt` 初始为 null，此时 tick 永远
 *   返回 false。所以「主人自己打开 ComfyUI 在别处画图」绝不会被本插件关掉。
 * ★ 到点后还要过两关：ComfyUI 在线、`/queue` 为空。队列非空 → 续期（有人在用）。
 */
function makeIdleShutdown(cfg, log, status) {
  const state = { lastActivityAt: null, shuttingDown: false, shutdowns: 0 }

  return {
    /** 记一次活动（出图成功后调用）。 */
    touch() {
      state.lastActivityAt = Date.now()
    },
    /** 距离下次自动关停还有多久（毫秒）；不可用时返回 0。 */
    idleShutdownInMs() {
      if (!cfg.autoShutdown) return 0
      // ★ 2026-10-07 新增：`idleShutdownMs <= 0` 表示**不自动关闭**（主人在界面上选了这一项）。
      //   remaining() 返回 0、shouldShutdown() 返回 false，两者都要挡住，否则会算出负数/立刻关停。
      if (cfg.idleShutdownMs <= 0) return 0
      if (state.lastActivityAt === null) return 0
      return Math.max(0, cfg.idleShutdownMs - (Date.now() - state.lastActivityAt))
    },
    snapshot() {
      return {
        autoShutdown: cfg.autoShutdown,
        lastActivityAt: state.lastActivityAt,
        idleShutdownMs: cfg.idleShutdownMs,
        idleShutdownInMs: this.idleShutdownInMs(),
        shutdowns: state.shutdowns,
      }
    },
    /** 定时检查。真关掉了返回 true。 */
    async tick() {
      if (!cfg.autoShutdown) return false
      // ★ 2026-10-07：idleShutdownMs <= 0 = 主人在界面上选了「不自动关闭」
      if (cfg.idleShutdownMs <= 0) return false
      if (state.lastActivityAt === null) return false
      if (state.shuttingDown) return false
      if (Date.now() - state.lastActivityAt < cfg.idleShutdownMs) return false

      // 关之前必须确认它还在（不在就没什么可关的，顺手复位计时）
      const online = await status.probe(true)
      if (!online) {
        state.lastActivityAt = null
        return false
      }
      // 队列非空 → 有人在用，续期，绝不打断
      if (await status.queueBusy()) {
        state.lastActivityAt = Date.now()
        // ★ 2026-10-10（M5）：把"续期"也记一笔 —— 否则用户会以为"到点却没关"是坏了。
        log('info', '空闲已到点，但队列非空 → 续期，本次不关闭 ComfyUI')
        return false
      }

      state.shuttingDown = true
      try {
        const found = await findComfyProcess(cfg, log)
        if (found === null) {
          log('warn', '空闲已超时，但没能确认哪个进程是 ComfyUI，本次不关闭')
          return false
        }
        // ★ Linux 用 kill（先 SIGTERM 温和，再兜底 SIGKILL）；Windows 用 Stop-Process -Force
      await runShell(IS_WINDOWS
        ? `Stop-Process -Id ${found.pid} -Force`
        : `kill ${found.pid} 2>/dev/null || kill -9 ${found.pid} 2>/dev/null`)
        state.shutdowns += 1
        log('info', `已空闲 ${Math.round((Date.now() - state.lastActivityAt) / 1000)} 秒，关闭 ComfyUI（PID ${found.pid}）`)
        state.lastActivityAt = null
        status.invalidate()
        return true
      } catch (error) {
        log('warn', `关闭 ComfyUI 失败：${error?.message ?? error}`)
        return false
      } finally {
        state.shuttingDown = false
      }
    },
  }
}

/** 只放行本机请求（照 dsh-boot-splash 余额路由的做法）。 */
function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

/** 回 JSON；任何异常都降级成一个可读的错误体，绝不 5xx。 */
function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
    } catch {
      /* 连接已经没了 */
    }
  }
}

/* ---------------------------------------------------------------- 工作流与出图 ---- */

/**
 * ★★ 2026-10-08 新增：探活请求该不该发。
 *
 * 参考图那一路为了省掉一次 8 秒的「连不上」超时（图要上传说明后端肯定在跑），
 * 故意**跳过探活** —— 这是原有行为，这里只是把它抽成纯函数便于自测。
 */
function shouldProbe(args) {
  return typeof args?.reference === 'string' && args.reference.trim() !== ''
    ? false
    : true
}

/**
 * ★★ 2026-10-08 新增：把 draw_image 的参数折算成「本次要提交的工作流」。
 *
 * 纯函数（不联网、不开 ComfyUI），自测靠它断言工作流长什么样。
 * ⚠ 这里**必须**与 execute 里的折算保持一致 —— 两处不一致就会"测试绿、实际错"。
 */
function planWorkflow(cfg, args, caps) {
  const aspect = typeof args?.size === 'string' && ASPECTS[args.size] ? args.size : '1:1'
  const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0 ? args.megapixels : 1.0
  // ★ 同上：**不回落到 cfg.steps**（理由见 execute 里的注释），没传就是 undefined。
  const steps = Number.isFinite(args?.steps) ? Math.trunc(args.steps) : undefined
  const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : 0
  // ★ 提速 M4：与 execute 保持一致（默认 1）。
  const count = Number.isFinite(args?.count) ? Math.max(1, Math.min(4, Math.trunc(args.count))) : 1
  const [width, height] = calcSize(aspect, megapixels)
  const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
  return buildWorkflow(cfg, {
    prompt: String(args?.prompt ?? ''),
    negative: args?.negative,
    width,
    height,
    steps,
    seed,
    reference: refPath,
    count,
  }, caps)
}

/**
 * 组装千问工作流。
 *
 * · 不给 `reference` → **文生图**（照 app.py build_workflow 的无参考图分支）
 * · 给了 `reference` → **图生图**（照 `scripts/_img2img.mjs`，那份在本机验证过）
 *
 * ★ 图生图有四个要点，一个都不能少：
 *   ① 加一个 `LoadImage` 节点读参考图
 *   ② `TextEncodeQwenImage21` **必须拿到 `vae`** —— 不给 vae 它就不会编码参考图
 *   ③ 参考图走 `images.image_1`（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的**第 2 号输出**（positive=0 / negative=1 / latent=2），
 *      并且**删掉 `EmptyLatentImage`** —— 所以图生图的 `resolution` 要用 sqrt(W*H)，
 *      它**直接决定输出尺寸**（文生图那边则由 EmptyLatentImage 决定，所以用固定值即可）
 *
 * ★★★ 2026-10-08 重大改动：**Turbo8 八步 + TE-Speed 变成默认链路**。
 *   （主人原话：「你把这个改成默认设置吧。开到最大。就是 turbo8 加 TE 八步」）
 *
 *   模型链（1 → 11 → 12 → 7 → 13 → KSampler）：
 *
 *     UNETLoader ──► LoraLoaderModelOnly(turbo8, 1.0)     ← 八步蒸馏 LoRA
 *                ──► ModelSamplingFlux(0.6935, 0.5)       ← turbo8 官方要求的采样位移
 *                ──► QwenImage21Cache(auto, int8)         ← 官方前缀 KV 缓存（int8 折半，几乎无损）
 *                ──► TESpeedQwenImage21(...)              ← 跳步缓存
 *                ──► KSampler(steps=8, cfg=1.0, euler, simple)
 *
 *   本机实测（RX 7900 XT / ComfyUI 0.39.0，都是 1024 档、每遍换 seed 的稳态值）：
 *     基线 30 步 CFG2.5            ── 91.6 s   （原默认）
 *     turbo8 八步（无缓存）        ── 12.6 s   （−86%）
 *     turbo8 八步 + TE-Speed       ──  9.7 s   （**−89%**）  ← 现在的默认
 *
 *   ⚠ 关于「TE 在这一档里到底做了多少」——查证过，别被老数字误导：
 *     · TE 的**整层跳过**（日志里的 `eligible`）在 8 步下是 **0 次**：8 步的 t 序列是
 *       1.000/0.933/0.857/0.769/0.667/0.546/0.400/0.222，而节点内置窗口硬性要求
 *       t<=0.82，前 3 步直接出局；剩下 5 步的 change 又都 > 0.06 阈值。
 *     · 但它**仍然有效**：每次 call 都会复用一部分 KV/attention（算子级省时），
 *       实测稳态 12.6 s → 9.7 s，**−23%**。
 *     · 早先报过的「−43%」是**测量失真**（撞上了 ComfyUI 对相同 prompt 的直接缓存）。
 *       ★ 教训：任何"快了多少"的对比，**每遍都必须换 seed**。
 *
 *   为什么是 8 步而不是 16 步：turbo8 就是**为 8 步训练的**（发布页写明 8 步 / CFG 1 /
 *   euler + simple）；16 步只会更慢而不会更准。
 *
 *   ⚠ 三条硬约束，别随手改掉：
 *     ① `ModelSamplingFlux` 的 width/height 必须是**字面量**。图生图那一支没有
 *        `EmptyLatentImage`（latent 从 TextEncode 的第 2 号输出拿），一旦写成节点连线，
 *        图生图会**直接引用到不存在的节点**。所以这里固定传 `width`/`height` 数字。
 *     ② `ModelSamplingFlux` 的宽度默认 **1024**，而 ModelSamplingFlux 的 max_shift 是按
 *        像素面积算的 —— 尺寸一变位移量就跟着变（实测 992² 与 1024² 出图不同）。
 *        要换默认尺寸，请把 `DEFAULTS.turbo8RefWidth/Height` 一起改。
 *     ③ `TESpeedQwenImage21` 是**插件节点**，装不上时 ComfyUI 会以
 *        "node type not found" 当场拒收整个任务（不会静默降级）。
 *
 * @param reference ComfyUI 里的参考图文件名（已经上传过去的）；空 = 文生图
 */
/**
 * ★ prompt 精简（2026-10-09 新增，依据见 DEFAULTS 里 `promptTrimEnabled` 的注释）。
 *
 * 只做**不改变语义**的清理：
 *   ① 折叠所有空白（换行/tab/多空格）为单空格并去首尾
 *   ② 合并连续重复的分隔标点（",,,,," → ","）
 *   ③ 去掉末尾悬挂的分隔符
 * 再按 `cfg.maxPromptChars` 可选硬截断（默认 0 = 不截断）。
 *
 * ⚠ 刻意**不做**：删除形容词 / 同义词替换 / 按 token 数截断 —— 那些都会改图，
 *   而实测收益上限只有 4.8%（还得是 2000 字的超长 prompt），不值得。
 */
function trimPrompt(text, cfg) {
  let s = String(text ?? '')
  if (cfg.promptTrimEnabled === false) return s
  s = s.replace(/\s+/gu, ' ').trim()
  s = s.replace(/([,，.。;；:：!！?？])(?:\s*\1)+/gu, '$1')
  s = s.replace(/[\s,，.。;；:：]+$/gu, '')
  const cap = Number(cfg.maxPromptChars)
  if (Number.isFinite(cap) && cap > 0 && s.length > cap) s = s.slice(0, cap)
  return s
}

/**
 * ★★★★ 2026-10-09：决定这次出图用**哪一组**互斥的 diffusion wrapper。
 *
 * ## 为什么需要它
 *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
 *   同时挂会抛 `ValueError: ... requires exclusive diffusion-wrapper ownership`。
 *   所以必须**三选一**，而"选哪个"取决于尺寸（实测，见 DEFAULTS 里 wrapperPolicy 的注释）。
 *
 * ## 实测依据（都是这台机器上跑出来的，不是估的）
 *   ┌ 场景          ┌ 方案              ┌ 效果
 *   │ 小尺寸/常驻   │ TE-Speed+Speedup  │ +25.4%（11.581 → 8.639 s，纯采样）
 *   │ 大尺寸/换页   │ TE-Speed          │ **0%**（日志：predicted 0/8 steps）
 *   │ 大尺寸/换页   │ Speedup           │ 12.5%（1/8 cached）
 *   │ 大尺寸（120s）│ BlockCache T8     │ **+22.7%**（120.75 → 93.34 s，省 27.4 s）
 *
 *   ⇒ 小尺寸用 TE+Speedup，大尺寸用 BlockCache T8。
 *
 * @returns {{te:boolean, speedup:boolean, blockCache:boolean, reason:string, tokens:number}}
 *   三个布尔**最多只有一个为 true**（互斥是硬约束，由这里的写法保证）。
 */
function pickWrapperSet(cfg, plan, width, height, caps) {
  const tokens = Math.max(1, Math.round(Number(width || 0) / 8)) * Math.max(1, Math.round(Number(height || 0) / 8))
  const policy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'

  // ★ 节点可用性一律**直接看 caps**（能力探测结果），不看 plan.useTe / useSpeedup ——
  //   那两个是"互斥之后"的结果：一旦 BlockCache 开着它们就恒为 false，
  //   拿它们当"节点在不在"会得出"TE 不可用"的错误结论，小尺寸就永远退回空链了。
  //   caps 不传 = 老行为（当作能力齐全）。
  const has = (key) => caps === undefined || caps === null || caps?.nodes?.[key] === true
  const bcAvailable = has('blockCache') && cfg.blockCacheEnabled !== false
  const teAvailable = has('teSpeed') && cfg.teSpeedEnabled !== false && plan.useTurbo === true
  const speedupAvailable = has('speedup') && cfg.speedupEnabled !== false && plan.useTurbo === true

  let wantBc
  let reason
  if (policy === 'bc') {
    wantBc = true
    reason = '固定走 BlockCache T8（wrapperPolicy=bc）'
  } else if (policy === 'te') {
    wantBc = false
    reason = '固定走 TE-Speed + Speedup（wrapperPolicy=te）'
  } else {
    const threshold = Number.isFinite(cfg.wrapperAutoTokensThreshold) && cfg.wrapperAutoTokensThreshold > 0
      ? cfg.wrapperAutoTokensThreshold : 16384
    wantBc = tokens > threshold
    reason = wantBc
      ? `大尺寸（${tokens} tokens > ${threshold}）→ BlockCache T8：TE-Speed 在这个尺寸实测 0% 加速，BlockCache 实测 +22.7%`
      : `小尺寸（${tokens} tokens ≤ ${threshold}）→ TE-Speed + Speedup：模型能常驻，实测 +25.4%`
  }

  // ★ 互斥硬保证：想上 BC 但 BC 不可用 → 退回 TE+Speedup（而不是两个都上）
  if (wantBc && !bcAvailable) {
    return { te: teAvailable, speedup: speedupAvailable, blockCache: false, tokens,
      reason: `想用 BlockCache T8 但不可用（节点没装或被 blockCacheEnabled=false 关掉）→ 退回 TE-Speed + Speedup` }
  }
  if (wantBc) {
    return { te: false, speedup: false, blockCache: true, tokens, reason }
  }
  return { te: teAvailable, speedup: speedupAvailable, blockCache: false, tokens, reason }
}

function buildWorkflow(cfg, { prompt, negative, width, height, steps, seed, reference, count }, caps) {
  const withRef = typeof reference === 'string' && reference !== ''
  // ★ 2026-10-10（提速 M4）：一次出几张。**默认 1**（守住"每次只生一张"的既定要求），
  //   只有调用方显式传 count 2-4 时才批量。批量只在**文生图**生效（EmptyLatentImage.batch_size）——
  //   图生图的 latent 来自参考图，批量需要另加 RepeatLatentBatch，本次不做，按 1 张处理。
  const batchCount = Number.isFinite(count) ? Math.max(1, Math.min(4, Math.trunc(count))) : 1
  // ★ 2026-10-09（通用化）：按**探测到的真实能力**折算本次链路。
  //   caps 不传 = 当作能力齐全 → 保持"默认全栈"的老行为（自测直接调本函数即此情形）。
  const plan = resolvePlan(cfg, caps)

  // ★ 尺寸锁（2026-10-09）：默认把**文生图**尺寸钉死在优化档，调用方传进来的
  //   size / megapixels / width / height 全部回落到它（默认 = resolution = 1024²），
  //   —— 防止重蹈"1328² + 慢步数"的慢路径。图生图由参考图定尺寸，不锁。
  //   设 cfg.forceOptimizedSize = false 可恢复"听调用方的尺寸"（仍受 32 对齐约束）。
  const lockSize = cfg.forceOptimizedSize !== false
  const OPT_SIZE = Number.isFinite(cfg.optimizedSize) && cfg.optimizedSize >= 32
    ? r32(cfg.optimizedSize)
    : (Number.isFinite(cfg.resolution) && cfg.resolution >= 32 ? r32(cfg.resolution) : 1024)
  const effWidth = (!withRef && lockSize)
    ? OPT_SIZE
    : (Number.isFinite(width) && width > 0 ? r32(width) : OPT_SIZE)
  const effHeight = (!withRef && lockSize)
    ? OPT_SIZE
    : (Number.isFinite(height) && height > 0 ? r32(height) : OPT_SIZE)

  // ★ 2026-10-09：模型文件名与链路开关**全部来自 plan**（探测结果），不再写死。
  const turboLora = plan.models.turbo8Lora
  const withTurbo = plan.useTurbo
  const withPrefix = plan.usePrefix

  // ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按本次出图尺寸动态选**。
  //
  //   plan 里的 useTe / useSpeedup / useBlockCache 是**配置级**的静态决定，
  //   它不知道这次要画多大 —— 而实测恰恰证明"该用哪一套"正是**由尺寸决定**的：
  //     · 992×992（15376 tokens）：模型能常驻 → TE+Speedup 实测 +25.4%
  //     · 1408×1408（30976 tokens）：显存换页 → TE 实测 **0%**、Speedup 12.5%，
  //       而 BlockCache T8 在大尺寸实测 **+22.7%**（省 27.4 s）
  //   ⇒ 同一套配置硬扛所有尺寸，必然有一档是错的。所以在这里按尺寸二次决策。
  //
  //   ⚠ 三者的互斥关系**不变**（仍争抢同一组 DIFFUSION_MODEL wrapper），
  //     这里只是把"谁上"从静态配置改成按尺寸挑，绝不会两个同时上（那会 ValueError）。
  const wrapperPick = pickWrapperSet(cfg, plan, effWidth, effHeight, caps)
  const withTe = wrapperPick.te
  const withSpeedup = wrapperPick.speedup
  // ★★★ 2026-10-09：BlockCache T8 —— 取代 ToMe 的图生图加速节点
  //
  // ## 为什么它取代了 ToMe（ToMe 已移除，见 DEFAULTS 里的说明）
  //   ToMe 在千问 2.1 上接口不兼容，三条插入点全走不通；而本节点：
  //     · 官方描述明确写着 "preserving Core's reference/text KV cache"
  //       → **原生兼容前缀缓存**（正是 ToMe 卡住的那个点）
  //     · "For editing, start with threshold 0.03" → 图生图推荐起点就是保守值
  //   ✅ 已实测确认：挂上后服务器日志出现 `T8: full=6 cache=2` —— **真的命中**，
  //      不是"看起来在跑其实没生效"。
  //
  // ## ⚠ 与 Speedup 互斥（这点比数字更重要）
  //   BlockCache 要求独占 DIFFUSION_MODEL wrapper（runtime.py:51），而 Speedup
  //   也注册同一组 wrapper → 同时挂会抛 ValueError 整单失败。
  //   处理：**BlockCache 优先，自动让位 Speedup**（见 resolvePlan 里的长注释）。
  //
  // ## 实测耗时（图生图，2 个不同 seed 取平均）
  //   注意：下面的"基线"是**只有 BlockCache / 无 BlockCache** 的对照，
  //   两者都不含 Speedup（因为 Speedup 与 BlockCache 互斥，无法同链对照）。
  //     无 BlockCache      120.75 s
  //     +BlockCache T8      93.34 s   →  快 22.7%（省 27.4 s）
  //   该数字来自独立对照跑（见 memory 2026-10-09），不是端到端全链耗时。
  //   参数即官方默认：threshold=0.03 / start=0.1 / end=0.9 / max_hits=2
  //
  // ## 接在哪
  //   放在模型链**最前面**（紧跟 UNETLoader）—— 它要缓存的是"首块目标残差"，
  //   越靠前拿到的越接近原始 UNET 输出；官方示图也是这个位置。
  // ★ 由 pickWrapperSet 决定（按尺寸），不再只看静态配置
  const withBlockCache = wrapperPick.blockCache === true
  const nodeAfterUnet0 = '1'
  const nodeAfterBlockCache = withBlockCache ? '16' : nodeAfterUnet0

  // 模型链末端逐级推进 —— 每一环都是"可选依赖"，探测不到就跳过：
  //   1(UNET) → [16 BlockCache] → [11 LoRA] → [12 采样位移] → [7 前缀缓存] → [13 TE] → [14 Speedup] → KSampler
  const nodeAfterUnet = nodeAfterBlockCache
  const nodeAfterTurbo = withTurbo ? '12' : nodeAfterUnet
  const nodeAfterCache = withPrefix ? '7' : nodeAfterTurbo
  const nodeAfterTe = withTe ? '13' : nodeAfterCache
  const nodeAfterSpeedup = withSpeedup ? '14' : nodeAfterTe
  // ★★★ 2026-10-10：RDNA3 FlashAttention（无损）放**模型链最末端** ——
  //   它 patch 的是 model_options 里的 attention override，必须让 KSampler
  //   最终拿到的那个 model 带上它；放最后最稳（前面的 wrapper 不会再覆盖它）。
  const withRdna3Fa = plan.useRdna3Fa === true
  const nodeAfterFa = withRdna3Fa ? '17' : nodeAfterSpeedup
  const modelRef = nodeAfterFa

  const workflow = {
    1: unetLoaderNode(plan.models.unet),
    2: { class_type: 'CLIPLoader', inputs: { clip_name: plan.models.clip, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: plan.models.vae } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        // ★ prompt 精简（无损清理 + 可选硬截断），依据见 trimPrompt 的注释
        prompt: trimPrompt(prompt, cfg),
        negative_prompt: negative ?? '',
        resolution: withRef ? Math.round(Math.sqrt(effWidth * effHeight)) : OPT_SIZE,
      },
    },

    // ---- 加速链（★ 2026-10-09：每一环都由**探测结果**决定接不接）--------------
    //   关闭时置 undefined，最后统一 delete —— 绝不能留一个"无 class_type 的空节点"
    //   （ComfyUI 会当成节点校验失败，整单拒收，而不是忽略）。
    11: withTurbo
      ? {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: [nodeAfterUnet, 0],
          lora_name: turboLora,
          strength_model: Number.isFinite(cfg.turbo8Strength) ? cfg.turbo8Strength : 1.0,
        },
      }
      : undefined,
    12: withTurbo
      ? {
        class_type: 'ModelSamplingFlux',
        inputs: {
          model: ['11', 0],
          max_shift: Number.isFinite(cfg.turbo8MaxShift) ? cfg.turbo8MaxShift : 0.6935,
          base_shift: Number.isFinite(cfg.turbo8BaseShift) ? cfg.turbo8BaseShift : 0.5,
          // ★ 必须是字面量：图生图那支没有 EmptyLatentImage 可以连（见函数头 ①）
          width: effWidth,
          height: effHeight,
        },
      }
      : undefined,
    7: withPrefix
      ? {
        class_type: 'QwenImage21Cache',
        inputs: {
          model: [nodeAfterTurbo, 0],
          device: cfg.qwenCacheDevice ?? 'auto',
          // int8：缓存折半、约等于 bf16 精度（官方 tooltip 原话）；int4 每步误差翻倍，不用。
          dtype: cfg.qwenCacheDtype ?? 'int8',
        },
      }
      : undefined,
    13: withTe
      ? {
        class_type: 'TESpeedQwenImage21',
        inputs: {
          model: [nodeAfterCache, 0],
          attention: cfg.teSpeedAttention ?? 'kitchen_int8',
          // te_predictor：每跳最多 1 步连续跳过 —— 比 'speed'（2 步）稳
          step_cache: cfg.teSpeedStepCache ?? 'te_predictor',
          reuse_threshold: Number.isFinite(cfg.teSpeedThreshold) ? cfg.teSpeedThreshold : 0.06,
          start_percent: Number.isFinite(cfg.teSpeedStartPercent) ? cfg.teSpeedStartPercent : 0.0,
          end_percent: Number.isFinite(cfg.teSpeedEndPercent) ? cfg.teSpeedEndPercent : 1.0,
          predictor_error_limit: Number.isFinite(cfg.teSpeedErrorLimit) ? cfg.teSpeedErrorLimit : 0.08,
          verbose: cfg.teSpeedVerbose === true,
        },
      }
      : undefined,

    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'dsh-qwen-paint' } },

    // ---- 2026-10-09 实测新增：QwenImage21Speedup（与 TE-Speed 实测可叠）----
    //   它接在模型链最末端（TE 之后、KSampler 之前），挂在 DIFFUSION_MODEL /
    //   OUTER_SAMPLE wrapper 上做整步残差缓存。
    //   实测：TE 10.741s → TE+Speedup 9.709s；再叠 quad → 8.278s。
    //   ⚠ 它是插件节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withSpeedup 开关控制，且下面要把未启用的节点删掉。
    14: withSpeedup
      ? {
        class_type: 'QwenImage21Speedup',
        inputs: {
          model: [nodeAfterTe, 0],
          enable_cache: true,
          cache_threshold: Number.isFinite(cfg.speedupCacheThreshold) ? cfg.speedupCacheThreshold : 0.30,
          target_error: Number.isFinite(cfg.speedupTargetError) ? cfg.speedupTargetError : 0.05,
          cache_start_percent: Number.isFinite(cfg.speedupStartPercent) ? cfg.speedupStartPercent : 0.15,
          cache_end_percent: Number.isFinite(cfg.speedupEndPercent) ? cfg.speedupEndPercent : 0.90,
          max_consecutive_skips: Number.isFinite(cfg.speedupMaxConsecutiveSkips) ? Math.trunc(cfg.speedupMaxConsecutiveSkips) : 3,
          forecast: cfg.speedupForecast ?? 'first',
          cache_device: cfg.speedupCacheDevice ?? 'auto',
          debug_log: cfg.speedupDebugLog === true,
        },
      }
      : undefined,

    // ---- 2026-10-09 实测新增：BlockCache T8（本机图生图实测 +22.7%）------
    //   参数全部走官方对 editing 的推荐值，不自己调激进口径。
    //   ⚠ 它是插件节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withBlockCache 开关控制（由 resolvePlan 按探测结果决定）。
    16: withBlockCache
      ? {
        class_type: 'QwenImage21BlockCacheT8',
        inputs: {
          model: [nodeAfterUnet0, 0],
          // 官方：图生图（editing）从这个值起步。调大→更快但可能改姿态/细节。
          residual_diff_threshold: Number.isFinite(cfg.blockCacheThreshold) ? cfg.blockCacheThreshold : 0.03,
          start_percent: Number.isFinite(cfg.blockCacheStartPercent) ? cfg.blockCacheStartPercent : 0.1,
          end_percent: Number.isFinite(cfg.blockCacheEndPercent) ? cfg.blockCacheEndPercent : 0.9,
          max_consecutive_hits: Number.isFinite(cfg.blockCacheMaxHits) ? Math.trunc(cfg.blockCacheMaxHits) : 2,
          cache_device: cfg.blockCacheDevice ?? 'cpu',
          metric_stride: Number.isFinite(cfg.blockCacheMetricStride) ? Math.trunc(cfg.blockCacheMetricStride) : 8,
          max_cache_mb: Number.isFinite(cfg.blockCacheMaxMb) ? Math.trunc(cfg.blockCacheMaxMb) : 1024,
          threshold_mode: cfg.blockCacheThresholdMode ?? 'two_stage',
          split_ratio: Number.isFinite(cfg.blockCacheSplitRatio) ? cfg.blockCacheSplitRatio : 0.35,
          late_threshold: Number.isFinite(cfg.blockCacheLateThreshold) ? cfg.blockCacheLateThreshold : 0.15,
        },
      }
      : undefined,

    // ---- 2026-10-10 实测新增：RDNA3 FlashAttention（无损加速）----
    //   精确注意力（memory-efficient 等价实现），不改数学；节点自带"不支持就回退"。
    //   只认 gfx1100 + ROCm PyTorch ≥2.8（本机都满足）。放在模型链最末端。
    //   ⚠ 它是插件节点：没装时整单会被拒收，所以必须用 withRdna3Fa 开关控制。
    17: withRdna3Fa
      ? {
        class_type: 'ApplyRDNA3FlashAttention',
        inputs: {
          model: [nodeAfterSpeedup, 0],
        },
      }
      : undefined,
  }

  // `7` / `11` / `12` / `13` / `14` / `16` 在关闭时都是 undefined —— 统一删掉，
  // 否则 ComfyUI 会把它当成一个"没有 class_type 的节点"直接报校验错（而不是忽略它）。
  for (const id of [7, 11, 12, 13, 14, 16, 17]) {
    if (workflow[id] === undefined) delete workflow[id]
  }

  if (withRef) {
    // 图生图：参考图进来，latent 由编码节点给，不要空 latent
    workflow[4] = { class_type: 'LoadImage', inputs: { image: reference } }
    workflow[5].inputs.vae = ['3', 0]
    workflow[5].inputs['images.image_1'] = ['4', 0]
  } else {
    // ★ 提速 M4：batch_size = batchCount（默认 1）。一次提交出 N 张只装卸一次模型。
    workflow[6] = { class_type: 'EmptyLatentImage', inputs: { width: effWidth, height: effHeight, batch_size: batchCount } }
  }

  // ---- 采样器 ------------------------------------------------------------------
  // ★ 步数默认 **8**：turbo8 是八步蒸馏模型，这就是它的工作点。
  //   层层回落（先到先用）：
  //     ① 用户显式传了 steps（1..60）→ 用它的         ← 只在 forceTurbo8Steps=false 时
  //     ② cfg.turbo8Steps 是正数     → 用配的那个数    ← 同上
  //     ③ 其余一律 → TURBO8_STEPS = 8                  ← 默认走这条
  //   给别的步数会掉出 LoRA 的训练区间、出图变差，所以默认必须钉死在 8。
  //   ★ 2026-10-09（通用化）：**没有 turbo8 时绝不能再钉 8 步** ——
  //     8 步是 turbo8 蒸馏 LoRA 的工作点，缺了 LoRA 还跑 8 步只会得到一张糊图。
  //     此时改用 plan.steps（默认 25），并允许调用方显式传 steps 覆盖。
  const explicitSteps = Number.isFinite(steps) ? Math.trunc(steps) : undefined
  const effSteps = withTurbo
    ? (cfg.forceTurbo8Steps !== false
      ? TURBO8_STEPS
      : (explicitSteps
        ?? (Number.isFinite(cfg.turbo8Steps) && cfg.turbo8Steps > 0 ? Math.trunc(cfg.turbo8Steps) : TURBO8_STEPS)))
    : (explicitSteps ?? plan.steps)

  workflow[8] = {
    class_type: 'KSampler',
    inputs: {
      // ★ 模型链末端：14(Speedup) → 13(TE) → 7(前缀缓存)，按开关逐级回落
      model: [modelRef, 0],
      seed,
      steps: Math.max(1, Math.min(60, effSteps)),
      // ★ CFG：有 turbo8 时必须 1.0（八步蒸馏 LoRA 在 >1 的 CFG 下会过曝/崩边，
      //   也是 TE-Speed 作者 2026-10-07 那版专门去修的问题）；
      //   没有 turbo8 时用千问原生工作点 2.5。
      cfg: plan.cfgScale,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['5', 0],
      negative: ['5', 1],
      latent_image: withRef ? ['5', 2] : ['6', 0],
      denoise: 1.0,
    },
  }
  // ★★★ 2026-10-09 **把"生效尺寸"随 workflow 一起交出去**（修一个真 bug）。
  //
  //   ## 之前的 bug
  //     `forceOptimizedSize = true` 时，上面会把尺寸**锁成 `OPT_SIZE`（默认 1024²）**，
  //     但调用方拿到的仍然只有 workflow 本身 —— 于是 `makeDrawTool` 里：
  //       · 尺寸校验用 **请求值** width/height 去比对实际出图尺寸 → **误报**
  //         「ComfyUI 出的图尺寸不对：请求 864x1152，实际 1024x1024」
  //       · 落盘文件名也用请求值 → 文件名标着 864x1152，图其实是 1024x1024
  //     ⇒ **作品已经正常生成了，却被自己拦下来报错**，主人看到的就是"尺寸不对"。
  //
  //   ## 为什么挂在对象上而不是改返回值
  //     这个函数的返回值**直接当 ComfyUI 的 prompt 载荷提交**（`submitPrompt` 里
  //     会 `JSON.stringify` 后 POST）。改返回结构会连带改提交格式。
  //     而 ComfyUI 只认**数字键**（`Object.values(workflow)` 那一批节点），
  //     挂一个符号属性/非数字键**不会进 JSON** —— 零副作用。
  //     这里用 `Object.defineProperty` 定义**不可枚举**属性，确保
  //     `JSON.stringify(workflow)` 与 `Object.keys` 都不受影响。
  Object.defineProperty(workflow, '__effective', {
    value: Object.freeze({ width: effWidth, height: effHeight, locked: !withRef && lockSize }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return workflow
}

/**
 * 把参考图上传给 ComfyUI，返回它在 ComfyUI 那边的文件名。
 *
 * ★ 为什么必须走 `/upload/image` 而不是"自己复制进 input 目录"：
 *   ComfyUI 的 input 目录**未必是配置里以为的那个**（启动时可以用 `--input-directory` 改），
 *   直接复制过去很可能放错地方；`/upload/image` 是**问 ComfyUI 本人要位置**，永远对。
 *   （同样的坑今天刚在 output 目录上踩过一次。）
 *
 * ⚠ 不能复用 `fetchWithTimeout` —— 它写死了 `Content-Type: application/json`，
 *   而这里要发 multipart。所以自己发一次。
 */
async function uploadReference(cfg, filePath, signal) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到参考图：${filePath}（${error?.message ?? error}）`)
  }
  const form = new FormData()
  form.append('image', new Blob([bytes]), path.basename(filePath))
  form.append('overwrite', 'true')

  const controller = new AbortController()
  // ★ 同 fetchWithTimeout：不转发裸 signal.reason（普通对象 → [object Object]）
  const onAbort = () => controller.abort(cancelReason(signal))
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('上传参考图超时')), 120000)
  try {
    const res = await fetch(`${cfg.comfyUrl}/upload/image`, { method: 'POST', body: form, signal: controller.signal })
    if (!res.ok) throw new Error(`参考图上传失败：HTTP ${res.status}`)
    const data = await res.json()
    if (!data?.name) throw new Error(`参考图上传返回异常：${JSON.stringify(data).slice(0, 200)}`)
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 提交任务，拿 prompt_id。 */
/**
 * ★★★ 2026-10-09 新增：**一次请求摸清后端"能不能马上接活"**。
 *
 * ## 为什么需要它（主人原话：「调用再聪明一点，不要那么傻」）
 *   原先进 execute 后是**串行**打三枪：
 *     ① `ensureComfyUp` → `/system_stats`（探活）
 *     ② `probeCapabilities` → 10 次 `object_info`（能力）
 *     ③ `submitPrompt` → `/prompt`
 *   其中 ② 有 10 分钟缓存、实际多半是命中的，但 ① 每次都要真发一次；
 *   更要命的是**它不知道后端忙不忙** —— 后端正在跑别人的任务时，它照样提交，
 *   于是任务排进队列，`waitForResult` 傻等，用户看到的是"卡住不动"。
 *
 * ## 这个函数做什么
 *   用 `/queue` 一次拿到三件事：
 *     · `online` —— 通了就说明后端活着（省掉一次 `/system_stats`）
 *     · `busy`   —— 有 running 就说明正在跑（据此决定"先等一下"而不是硬塞）
 *     · `pending`—— 排了多少（据此给用户一句**诚实**的预估，而不是假装马上出）
 *   失败不抛错：拿不到就当"未知"，走老路径（探测失败绝不能变成出图失败）。
 *
 * @returns {Promise<{online:boolean, busy:boolean, running:number, pending:number}>}
 */
async function probeReadiness(cfg, signal) {
  const unknown = { online: false, busy: false, running: 0, pending: 0 }
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 4000, signal })
    // 401/403 之类也算"通了"——有东西在听这个端口就够了
    if (!res.ok) return { ...unknown, online: true }
    const data = await res.json()
    const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0
    const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
    return { online: true, busy: running + pending > 0, running, pending }
  } catch {
    return unknown
  }
}

async function submitPrompt(cfg, workflow, signal) {
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ prompt: workflow, client_id: `dsh-qwen-paint-${process.pid}` }),
    timeoutMs: 60000,
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ComfyUI 拒绝了这次任务（HTTP ${res.status}）：${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`ComfyUI 返回了看不懂的内容：${text.slice(0, 300)}`)
  }
  if (payload?.error) {
    const detail = payload.error?.message ?? JSON.stringify(payload.error).slice(0, 300)
    const nodeErrors = payload.node_errors === undefined ? '' : `\n节点校验详情：${JSON.stringify(payload.node_errors).slice(0, 500)}`
    throw new Error(`ComfyUI 报错：${detail}${nodeErrors}`)
  }
  if (typeof payload?.prompt_id !== 'string') throw new Error('ComfyUI 没有返回 prompt_id，无法跟踪任务')
  return payload.prompt_id
}

/**
 * 轮询等结果。每 tick 回调一次进度，方便主人看到"在动"。
 *
 * ★★★ 2026-10-09 改造（主人：「调用再聪明一点，不要那么傻」）：
 *   原先这个循环只会说「排队/加载模型中…」「运行中… 已等 Ns」——
 *   用户根本分不清"在排队"和"在算"，更不知道还要多久，观感就是"卡死"。
 *   现在改成**看得懂的三段状态**：
 *     · 队列里还没轮到   → 报「排在队列第 N 位」
 *     · 正在跑但不吐进度 → 报「ComfyUI 正在执行（已 Ns）」
 *     · 有真实进度       → 直接报百分比 + 当前步数
 *   进度从 `/prompt` 的 websocket 太麻烦，改用 `/history` 里 ComfyUI 自己
 *   写回的时间戳/状态 —— 拿不到就退化成上面的粗粒度文案，**绝不编数字**。
 *
 * @returns 输出图片描述数组 [{filename, subfolder, type}]
 */
async function waitForResult(cfg, promptId, { signal, onTick, timeoutMs }) {
  const started = Date.now()
  let lastNote = ''
  let idleTicks = 0
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error(`等 ComfyUI 出图超时（已等 ${Math.round((Date.now() - started) / 1000)} 秒）`)
    if (signal?.aborted) throw cancelReason(signal)
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1200))

    let history
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 30000, signal })
      if (!res.ok) continue
      history = await res.json()
    } catch {
      continue // ComfyUI 短暂忙不过来时不要当场判死
    }
    const entry = history?.[promptId]
    if (!entry) {
      // ★ 还没进 history 说明要么在队列里、要么在跑。去 /queue 问一句"我排第几"，
      //   比干说"排队/加载模型中"有用得多 —— 这是"聪明一点"最直接的体现。
      idleTicks += 1
      if (onTick) {
        // 每 3 个 tick 才去问一次队列，避免把 ComfyUI 问烦
        if (idleTicks % 3 === 1) {
          const q = await probeReadiness(cfg, signal)
          const waited = Math.round((Date.now() - started) / 1000)
          if (q.pending > 0) {
            const note = `正在等前一个任务（前方还有 ${q.pending} 个），已等 ${waited}s`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          } else if (q.running > 0) {
            const note = `ComfyUI 正在执行（已等 ${waited}s；若刚换过尺寸，首次会重载模型，偏慢正常）`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          } else {
            const note = `已提交，正在装载模型… 已等 ${waited}s`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          }
        }
      }
      continue
    }
    const status = entry.status
    if (status?.status_str === 'error' || status?.completed === false) {
      const messages = status?.messages
      if (Array.isArray(messages) && messages.some((m) => Array.isArray(m) && m[0] === 'execution_error')) {
        const err = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error')?.[1]
        throw new Error(`ComfyUI 执行失败：${err?.exception_message ?? JSON.stringify(err).slice(0, 400)}`)
      }
    }
    const images = []
    for (const nodeOutput of Object.values(entry.outputs ?? {})) {
      for (const image of nodeOutput?.images ?? []) {
        if (image?.filename) images.push(image)
      }
    }
    if (images.length > 0) return images
    const note = status?.status_str === 'success' ? '成功但没有图片输出' : `运行中… 已等 ${Math.round((Date.now() - started) / 1000)}s`
    if (note !== lastNote) {
      lastNote = note
      if (onTick) onTick(note)
    }
  }
}

/**
 * 取图片字节。
 *
 * ★★ 0.1.2 修正（真事故，主人一眼看出来的）：
 *   **先走 ComfyUI 官方的 `/view`，本地目录只当兜底。**
 *
 * 原来顺序是反的（先读本地 `comfyOutputDir`），结果踩了个大坑：
 *   ComfyUI 的 output 目录**未必是配置里那个** —— 插件自己拉起 ComfyUI 时会带
 *   `--output-directory <别处>`，或者机器上跑的是另一个实例。而两个实例的
 *   SaveImage 编号**都从 00001 重新开始**，于是**旧目录里恰好躺着一个同名文件** ✗
 *   → `readFile` 成功 → **根本走不到兜底** → 把昨天的旧图当成这次的成果，
 *     还按新 prompt 命名、报新请求的尺寸。主人看到的就是"画得完全不对"。
 *
 *   `/view` 是**问 ComfyUI 要它自己那次产出的文件**，不存在这个问题 ✓
 *   （代价只是多一次本地回环 HTTP，几 MB 而已。）
 */
async function fetchImageBytes(cfg, image, signal) {
  // ① 先问 ComfyUI 本人要 —— 这是唯一权威的来源
  try {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${query.toString()}`, { timeoutMs: 120000, signal })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    /* 落下去试本地兜底 */
  }
  // ② 本地目录兜底（老版本 ComfyUI、或 /view 不可用时）
  //   ★ 2026-10-09 通用化：`comfyOutputDir` 默认**留空** —— 写死作者机器的路径对别人
  //     毫无意义（必然先白失败一次）。留空则直接跳过本地这一路，报错也更干净。
  const local = cfg.comfyOutputDir
    ? path.join(cfg.comfyOutputDir, image.subfolder ?? '', image.filename)
    : ''
  if (local !== '') {
    try {
      return await fsp.readFile(local)
    } catch (error) {
      /* 落到下面的统一报错 */
    }
  }
  throw new Error(
    `取图失败：/view 读不到 ${image.filename}`
    + (local === '' ? '（未配置本地 output 目录，无法本地兜底）' : `，本地 ${local} 也读不到`),
  )
}

/**
 * 从 PNG 字节头读尺寸；不是 PNG（或太短）返回 null。
 *
 * ★★ 0.1.2 新增：用来做**尺寸校验** —— 这次事故里插件报的是请求尺寸
 *   （832x1216），而实际拿到的文件是 992x992，机器明明"知道"却没人拦。
 *   加上这道闸，同类问题会**当场报错**，不会再静默产出错图。
 */
function readPngSize(bytes) {
  if (!bytes || bytes.length < 24) return null
  // PNG 魔数：89 50 4E 47
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ 列出可用模型 ---- */

/**
 * ★★ 2026-10-09 新增：列出本机 ComfyUI 当前可用的模型文件。
 *
 * 直接问 ComfyUI 本人（`/object_info/<节点类型>` 子路径，只回该节点 schema，远比全量
 * 1.97MB 的 `/object_info` 轻），取各加载器输入项的 `OPTIONS`（下拉候选 = 磁盘上的模型文件名）。
 * 纯本地、不出网；用来正面回应"查看可用的模型"——宿主顶部的 LLM 模型下拉若卡住，
 * 这一条能直接把 ComfyUI 这边的模型清单拉出来看。
 *
 * ⚠ 子路径 `/object_info/<Type>` 在 ComfyUI 上是稳定的；若某个加载器节点不存在
 *   （如未装某自定义节点），对应项返回 null 而非报错，绝不拖垮整次查询。
 */
const MODEL_NODES = [
  { type: 'UNETLoader', field: 'unet_name', label: 'UNET / 千问主模型' },
  { type: 'CLIPLoader', field: 'clip_name', label: 'CLIP / 文本编码器' },
  { type: 'VAELoader', field: 'vae_name', label: 'VAE' },
  { type: 'LoraLoader', field: 'lora_name', label: 'LoRA' },
  { type: 'CheckpointLoader', field: 'ckpt_name', label: 'Checkpoint' },
  { type: 'CheckpointLoaderSimple', field: 'ckpt_name', label: 'Checkpoint(简单)' },
]

async function listComfyModels(cfg, log, signal) {
  const models = {}
  for (const { type, field, label } of MODEL_NODES) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/object_info/${type}`, { timeoutMs: 15000, signal })
      if (!res.ok) { models[label] = null; continue }
      const j = await res.json()
      const node = j?.[type]
      const spec = node?.input?.required?.[field] ?? node?.input?.optional?.[field]
      const options = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : []
      models[label] = options
      log?.('info', `列出模型 ${label}：${options.length} 个`)
    } catch (error) {
      models[label] = null
      log?.('warn', `列出模型 ${label} 失败：${error?.message ?? error}`)
    }
  }
  return models
}

/**
 * ★★ 2026-10-09 新增工具：列出本机 ComfyUI 可用模型。
 * 用来"查看可用的模型"——宿主自己的 LLM 模型下拉若卡住，这条直接查 ComfyUI 本体，
 * 给出磁盘上实际存在的模型文件名清单（UNET/CLIP/VAE/LoRA/Checkpoint）。
 */
function makeListModelsTool(cfg, log) {
  return {
    name: 'list_available_models',
    description:
      '列出本机 ComfyUI 当前可用的模型文件（UNET / CLIP / VAE / LoRA / Checkpoint 各类），' +
      '返回每类磁盘上实际存在的模型文件名清单。用来确认生图后端到底加载了哪些模型、文件叫什么，' +
      '或排查"某个模型找不到"的问题。纯本地、不出网、不需要任何 API Key。' +
      '当有人问"有哪些模型 / 查看可用的模型 / 模型列表"时用它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 30000,
    async execute(_args, exec) {
      const signal = exec?.signal
      await ensureComfyUp(cfg, log, signal) // 顺带确认后端在（不在就拉起）
      const models = await listComfyModels(cfg, log, signal)
      // 统计每类数量，方便一眼看懂
      const summary = {}
      for (const [label, list] of Object.entries(models)) {
        summary[label] = Array.isArray(list) ? `${list.length} 个` : '（节点不存在 / 查询失败）'
      }
      return { url: cfg.comfyUrl, online: true, summary, models }
    },
  }
}

/**
 * ★★★ 2026-10-09 新增工具：检查 / 配置本机加速环境。
 *
 * 回答"我这台机器用的是哪套优化、还差什么"。
 * · `action=status`（默认）：**纯只读**，不发任何下载。
 * · `action=install`：安装白名单内的加速包，且受 `accelAutoInstall` 约束。
 *
 * ⚠ 为什么安装要单独一个显式动作、而不是"出图时顺手装上"：
 *   下载并执行第三方代码是**用户环境的实质性改动**，不该藏在绘图流程背后发生。
 *   默认 `accelAutoInstall: false`，让"装不装"由人决定。
 */
function makeAccelTool(cfg, log) {
  return {
    name: 'check_acceleration',
    description:
      '检查本机 GPU 与生图加速环境：识别显卡厂商与架构、当前采用的注意力后端参数、'
      + '通用优化链（turbo8 / 前缀缓存 / 跳步缓存）与厂商专用加速包的就位情况，并给出缺什么。'
      + 'action=status（默认）只读查看；action=install 配合 packId 安装指定加速包。'
      + 'status 纯本地、不联网；只有 install 才会下载。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'status（默认，只读检查）/ install（安装加速包）' },
        packId: { type: 'string', description: '要安装的加速包 id（见 status 返回的 packs[].id）' },
      },
    },
    timeoutMs: 900000,
    async execute(args, exec) {
      if (args?.action === 'install') {
        if (cfg.accelAutoInstall === false) {
          throw new Error(
            '当前配置 accelAutoInstall=false，已禁止安装加速包。'
            + '要允许安装，请把 cordis.patch.yml 里的 accelAutoInstall 改成 true 后重试。',
          )
        }
        const packId = String(args?.packId ?? '').trim()
        if (packId === '') throw new Error('action=install 需要同时提供 packId（见 status 返回的 packs[].id）')
        const report = await probeAcceleration(cfg, log)
        const installed = await installAccelPack(packId, report.env, log)
        return { ...report, installed }
      }
      return await probeAcceleration(cfg, log)
    },
  }
}

/* ------------------------------------------------------------------ 环境自适应 ---- */

/**
 * ★★★ 2026-10-09（通用化改造）：**从"写死优化链路"改为"探测后自适应"**。
 *
 * ## 为什么必须改
 * 优化链上的每一环都是**可选依赖**，别人机器上未必有：
 *   · `turbo8_lora_step2500.safetensors`（1.36 GB，要自己下）
 *   · `TE-Speed-QwenImage21` 自定义节点（闭源 `nodes.pyd`）
 *   · `ComfyUI-Qwen-Image-2.1-Speedup` 自定义节点
 *   · 官方前缀缓存节点 `QwenImage21Cache`（要足够新的 ComfyUI）
 * 而 ComfyUI 遇到"引用了不存在的节点类型"或"模型名不在候选列表里"是**整单拒收**
 * （`node type not found` / `value not in list`），**不会静默降级**。
 * 所以老版本一旦发出去，凡是不满足条件的人一画图就报错 —— 包等于是坏的。
 *
 * ## 现在怎么做
 * 出图前先**问 ComfyUI 本人**（`/object_info/<节点类型>`）：摸清"有哪些节点、
 * 磁盘上模型文件的真实名字叫什么"，再据此选一档**可用的最高链路**。
 * 探测结果按 ComfyUI 地址缓存（默认 10 分钟），不会每次出图都重查。
 *
 * ## 三档链路（自动取可用的最高档）
 *   `full`  turbo8 + 前缀缓存 + 跳步缓存 → 8 步 / CFG 1.0（最快；作者本机 8.2s）
 *   `turbo` turbo8（缺跳步缓存也可以）  → 8 步 / CFG 1.0
 *   `basic` 没有 turbo8 LoRA            → 25 步 / CFG 2.5（慢，但任何千问环境都能出图）
 *
 * ⚠ 探测**失败**（ComfyUI 连不上等）**不拦截出图**：一律当 `full` 处理，
 *   让 ComfyUI 自己抛原始错误 —— 比插件"猜"出一个含糊结论要诚实。
 */

/**
 * 模型文件名的**模糊匹配表**（按优先级打分，从高到低）。
 *
 * 为什么必须模糊匹配：作者本机用的是 int8 量化版（`..._int8_convrot` / `..._w4a8`），
 * 但别人下的可能是 bf16 版、fp8 版，文件名并不相同。**写死文件名 = 换台机器就拒收**。
 * 这里按关键字从"磁盘上真实存在的"列表里挑一个最合适的；一个都匹配不上则返回 null，
 * 交给上层降级处理。
 *
 * ⚠ 正则都**不带 `g` 标志** —— 带 g 的 `test()` 有 `lastIndex` 状态，会漏匹配。
 */
const MODEL_HINTS = {
  unet: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*int8/iu, 100],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*fp8/iu, 95],
    [/qwen[_\-.]?image[_\-.]?2[._]?1/iu, 90],
    [/qwen.*image/iu, 70],
  ],
  /**
   * ★★★ 2026-10-11 新增：**GGUF 档**（小显存显卡用，见 MODEL_TIERS）。
   *   这些文件名来自公开的 GGUF 转换仓库（如 abenzerps/Qwen-Image-2.1-GGUF 的
   *   `qwen-image-2.1-Q4_K_M.gguf` / `-Q5_K_M` / `-Q6_K` / `-Q8_0`）。
   *   ⚠ 这里**只是"从已装文件里挑最优"的排序**，不做任何下载决策 ——
   *     真正下什么由 setup.mjs 的档位选择决定（见那里的说明）。
   *   排序理由：Q4_K_M 最省显存、是 8GB 档的落点，故优先级最高。
   */
  unetGguf: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q4_k_m/iu, 100],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q4_0/iu, 96],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q5_k_m/iu, 92],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q6_k/iu, 88],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q8_0/iu, 84],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*\.gguf/iu, 80],
    [/qwen.*image.*\.gguf/iu, 60],
  ],
  clip: [
    [/qwen3[_\-.]?vl.*8b.*w4a8/iu, 100],
    [/qwen3[_\-.]?vl.*8b/iu, 95],
    [/qwen3[_\-.]?vl/iu, 85],
    [/qwen/i, 60],
  ],
  vae: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*vae/iu, 100],
    [/qwen.*image.*vae/iu, 90],
    [/qwen.*vae/iu, 80],
    [/vae/iu, 40],
  ],
  lora: [
    [/turbo8.*qwen/iu, 100],
    [/qwen.*turbo8/iu, 100],
    [/turbo8/iu, 92],
  ],
}

/* ------------------------------------------------- 模型档位（小显存适配）---- */

/**
 * ★★★ 2026-10-11 新增：**模型档位** —— 让 8GB 这类小显存卡也能跑起来。
 *
 * ## 为什么需要
 * 默认主模型是 `qwen_image_2.1_int8_convrot.safetensors`（int8，20B 级）。
 * 在 ≥16GB 的卡上是首选；但在 **8GB（如 RTX 5060）** 上装不进显存，只能靠
 * ComfyUI 反复换页 —— 慢到不可用。社区通行做法是换 **GGUF 量化档**，
 * 用 `ComfyUI-GGUF`（city96）的 `UnetLoaderGGUF` 节点加载。
 *
 * ## 两个档位
 *   · `full`（默认）—— 原生 `UNETLoader` + int8 safetensors。**与旧版行为完全一致**。
 *   · `lite`         —— `UnetLoaderGGUF` + GGUF（Q4_K_M 优先，见 MODEL_HINTS.unetGguf）。
 *
 * ⚠ **本表只描述"档位长什么样"，不做任何下载决策** ——
 *   下什么模型由 `scripts/setup.mjs` 的档位选择（安装时那个二选一弹窗）决定。
 *   运行期只做一件事：**看 `cfg.unet` 的后缀**决定用哪个加载器（见 `unetLoaderFor`），
 *   于是"用户下载时选了什么"就自动决定了"运行时怎么加载"，不需要再多一个开关。
 */
const UNET_LOADER_NATIVE = 'UNETLoader'
/** ComfyUI-GGUF（city96）的节点类名 —— 输入**只有** `unet_name`，没有 weight_dtype。 */
const UNET_LOADER_GGUF = 'UnetLoaderGGUF'

const MODEL_TIERS = {
  full: {
    id: 'full',
    label: '完整档（int8 safetensors）',
    loader: UNET_LOADER_NATIVE,
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
  },
  lite: {
    id: 'lite',
    label: '轻量档（GGUF Q4_K_M）',
    loader: UNET_LOADER_GGUF,
    unet: 'qwen-image-2.1-Q4_K_M.gguf',
  },
}
// ⚠ 这里**刻意不放**"推荐显存 / 需装什么节点"这类文案 —— 那是**安装期**给用户看的，
//   已经写在 `scripts/setup.mjs` 的 TIERS 里（那里才是弹窗要用的）。
//   运行期只需要"档位 → 加载器 + 模型名"这一件事，多放的字段没人读，就是死代码。

/**
 * 按模型文件名后缀决定用哪个加载器节点。
 *
 * ⚠ 两个节点的输入**不一样**，混用会被 ComfyUI 直接拒收：
 *   · `UNETLoader`     —— 原生节点，要 `unet_name` + `weight_dtype`
 *   · `UnetLoaderGGUF` —— 第三方节点，**只有 `unet_name`**
 *     （多传 `weight_dtype` 会报 unexpected input）
 */
function unetLoaderFor(unetName) {
  return /\.gguf$/iu.test(String(unetName ?? '')) ? UNET_LOADER_GGUF : UNET_LOADER_NATIVE
}

/** 组装主模型加载节点 —— 两个加载器的输入形状不同，集中在这里，别再各写一份。 */
function unetLoaderNode(unetName) {
  return unetLoaderFor(unetName) === UNET_LOADER_GGUF
    ? { class_type: UNET_LOADER_GGUF, inputs: { unet_name: unetName } }
    : { class_type: UNET_LOADER_NATIVE, inputs: { unet_name: unetName, weight_dtype: 'default' } }
}

/**
 * 给用户看的一句话：当前用的是哪一档主模型。
 *
 * ⚠ 判定**与 `resolvePlan` 同源** —— 只看最终生效的那个模型名（+ 探测阶段定下的加载器），
 *   不另起一套判断。否则又是"面板说一套、实际跑另一套"（这个坑本项目踩过好几次）。
 */
function tierLabelOf(caps, cfg) {
  const name = String(caps?.models?.unet ?? cfg?.unet ?? '')
  const loader = caps?.unetLoader ?? unetLoaderFor(name)
  const isGguf = loader === UNET_LOADER_GGUF
  const tier = isGguf ? MODEL_TIERS.lite : MODEL_TIERS.full
  const missing = isGguf && caps?.nodes && caps.nodes.ggufUnet === false
    ? '（⚠ 缺 UnetLoaderGGUF 节点，需先装 ComfyUI-GGUF）'
    : ''
  return `${tier.label}：${name}${missing}`
}

/**
 * ★★★ 2026-10-11 新增：**把关键能力缺口从 `caps.notes` 里挑出来**，供面板显示。
 *
 * ## 为什么需要（这是个真缺口）
 *   `caps.notes` 以前**只写日志**（`log('info', ...)`），**面板上看不到**。
 *   于是"选了 GGUF 档、却没装 ComfyUI-GGUF 节点"这种**会让出图直接失败**的情况，
 *   用户在界面上完全看不出来 —— 直到出图被 ComfyUI 拒收才知道。
 *   那正是最该避免的一类体验：**机器明明知道，却没告诉用户**。
 *
 * ## 挑哪些
 *   只挑**以 `⚠` 开头**的（这是本项目里"重要"的既有约定），
 *   避免把"跳过了某环节"这类常规说明也糊到面板上。
 */
function importantNotesOf(caps) {
  return (caps?.notes ?? []).filter((n) => String(n).startsWith('⚠'))
}

/** 从候选文件名里按 hint 打分挑最优；挑不出返回 null。 */
function pickBestModel(list, hints) {
  if (!Array.isArray(list) || list.length === 0) return null
  let best = null
  let bestScore = -1
  for (const name of list) {
    if (typeof name !== 'string') continue
    for (const [re, score] of hints) {
      if (score > bestScore && re.test(name)) {
        best = name
        bestScore = score
      }
    }
  }
  return best
}

/**
 * 取某个节点的 schema。
 *
 * ★ 2026-10-09 加固：返回**三态**，而不是简单的 `null`。
 *
 * 之前用 `null` 表示一切失败，导致**无法区分"节点确实没装"和"这次查询没成功"** ——
 * 于是一次网络抖动、一次超时、甚至用户点了取消（signal abort），
 * 都会被判成"节点缺失" → 静默降级到 basic 档 → 再把这个错误结论**缓存 10 分钟**。
 * 用户看到的现象是"突然变慢好几倍，而且没有任何提示"，极难排查。
 *
 * @returns {{state:'ok'|'missing'|'error', node: object|null}}
 *   · `ok`      — 查询成功，节点存在
 *   · `missing` — 查询成功，但 ComfyUI 里确实没有这个节点（**确定**）
 *   · `error`   — 请求失败 / 超时 / 被取消（**不确定**，绝不能当作缺失）
 */
async function getNodeSchema(cfg, type, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/object_info/${type}`, { timeoutMs: 15000, signal })
    if (!res.ok) return { state: 'error', node: null }
    const json = await res.json()
    const node = json?.[type] ?? null
    return node === null ? { state: 'missing', node: null } : { state: 'ok', node }
  } catch {
    return { state: 'error', node: null }
  }
}

/** 从节点 schema 里取某个输入项的候选文件名列表（ComfyUI 的 OPTIONS 约定）。 */
function nodeFileList(schema, field) {
  const spec = schema?.input?.required?.[field] ?? schema?.input?.optional?.[field]
  return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : []
}

/** 能力探测结果的缓存（按 ComfyUI 地址）。 */
const CAP_CACHE = new Map()

/**
 * ★ 2026-10-09：「探测失败」时用的**短缓存时长**。
 *
 * 为什么不干脆不缓存：状态端点是**每 5 秒轮询一次**的，探测一次要发 10 个请求。
 * 失败不缓存 = ComfyUI 一不稳定就变成每 5 秒 10 个请求的持续轰炸。
 * 30 秒是个折中：既不会白烧算力，又能较快恢复出真实结论。
 */
const PROBE_FAIL_TTL_MS = 30000

/**
 * 探测本机 ComfyUI 的能力：有哪些节点、有哪些模型、GPU 是什么。
 *
 * 所有查询**并发**发出（本机实测每项 ~24ms），任一失败都不影响其余项。
 * 全部失败 = 返回一个"什么都探测不到"的对象，由 `resolvePlan` 当 `full` 处理。
 */
async function probeCapabilities(cfg, log, signal, { force = false } = {}) {
  const baseTtl = Number.isFinite(cfg.capabilityCacheMs) ? cfg.capabilityCacheMs : 600000
  const hit = CAP_CACHE.get(cfg.comfyUrl)
  // ★ 用**条目自带**的 ttl（失败时是短 TTL），不再统一用一个常量
  if (!force && hit && Date.now() - hit.at < hit.ttl) return hit.caps

  // ★ 三态探测：每项是 {state, node}，见 getNodeSchema 的说明。
  const NODE_KEYS = ['qwen21', 'prefixCache', 'teSpeed', 'speedup', 'blockCache', 'rdna3fa', 'loraOnly', 'unet', 'ggufUnet', 'clip', 'vae', 'lora']
  const raw = await Promise.all([
    getNodeSchema(cfg, 'TextEncodeQwenImage21', signal),
    getNodeSchema(cfg, 'QwenImage21Cache', signal),
    getNodeSchema(cfg, 'TESpeedQwenImage21', signal),
    getNodeSchema(cfg, 'QwenImage21Speedup', signal),
    getNodeSchema(cfg, 'QwenImage21BlockCacheT8', signal),
    // ★ 2026-10-10：RDNA3 FlashAttention（无损加速；只认 gfx1100，节点自带回退）
    getNodeSchema(cfg, 'ApplyRDNA3FlashAttention', signal),
    getNodeSchema(cfg, 'LoraLoaderModelOnly', signal),
    getNodeSchema(cfg, 'UNETLoader', signal),
    // ★ 2026-10-11：GGUF 加载器（ComfyUI-GGUF 提供）—— 小显存档要用它，**没装就不能切档**
    getNodeSchema(cfg, UNET_LOADER_GGUF, signal),
    getNodeSchema(cfg, 'CLIPLoader', signal),
    getNodeSchema(cfg, 'VAELoader', signal),
    getNodeSchema(cfg, 'LoraLoader', signal),
  ]).catch(() => [])

  const probe = Object.fromEntries(
    NODE_KEYS.map((key, index) => [key, raw[index] ?? { state: 'error', node: null }]),
  )
  const errored = NODE_KEYS.filter((key) => probe[key].state === 'error').length
  /** 一半以上查询失败 ⇒ 整体结论不可信（不是"缺件"，是"没测出来"）。 */
  const probeFailed = errored >= Math.ceil(NODE_KEYS.length / 2)
  /** 只有**确认存在**才算有；`error` 绝不等同于 `missing`。 */
  const up = (key) => probe[key].state === 'ok'

  // GPU 信息单独取（探测不到也不影响链路判定）
  let stats = null
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 8000, signal })
    if (res.ok) stats = await res.json()
  } catch {
    stats = null
  }

  const caps = {
    at: Date.now(),
    probeFailed,
    cached: false,
    nodes: {
      qwen21: up('qwen21'),
      prefixCache: up('prefixCache'),
      teSpeed: up('teSpeed'),
      speedup: up('speedup'),
      blockCache: up('blockCache'),
      rdna3fa: up('rdna3fa'),
      loraOnly: up('loraOnly'),
      // ★ 2026-10-11：ComfyUI-GGUF 的 UnetLoaderGGUF —— 小显存档（GGUF）的前提
      ggufUnet: up('ggufUnet'),
    },
    models: {
      unet: pickBestModel(nodeFileList(probe.unet.node, 'unet_name'), MODEL_HINTS.unet),
      // ★ 2026-10-11：GGUF 档的候选。**与原生列表是两套**（UnetLoaderGGUF 只列 .gguf），
      //   所以必须单独探、单独挑，不能拿原生那份顶替。
      unetGguf: pickBestModel(nodeFileList(probe.ggufUnet.node, 'unet_name'), MODEL_HINTS.unetGguf),
      clip: pickBestModel(nodeFileList(probe.clip.node, 'clip_name'), MODEL_HINTS.clip),
      vae: pickBestModel(nodeFileList(probe.vae.node, 'vae_name'), MODEL_HINTS.vae),
      turbo8Lora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.lora),
    },
    gpu: stats
      ? {
        name: String(stats?.devices?.[0]?.name ?? ''),
        vramGB: Math.round((Number(stats?.devices?.[0]?.vram_total ?? 0) / 1024 ** 3) * 10) / 10,
      }
      : null,
    level: 'basic',
    notes: [],
  }

  // ---- 模型档位：决定"用哪个加载器 + 哪个主模型名"（★ 2026-10-11 小显存适配）----
  //
  // 规则（**保证默认行为与旧版一字不差**）：
  //   ① `cfg.unet` 是 `.gguf`                        → 走 GGUF 档（安装时选了小档）
  //   ② 配置的主模型**一个都没探到**、却探到了 GGUF   → 自动走 GGUF 档（**记 note，不静默**）
  //   ③ 其余                                          → 原生 UNETLoader（现状）
  //
  // ⚠ 必须算在 `hasCore` **之前**：否则"只装了 GGUF"的机器会被误判成 unsupported。
  const cfgUnet = String(cfg.unet ?? '')
  if (/\.gguf$/iu.test(cfgUnet)) {
    caps.unetLoader = UNET_LOADER_GGUF
    caps.models.unet = caps.models.unetGguf ?? cfgUnet
    if (!caps.nodes.ggufUnet) {
      caps.notes.push('⚠ 配置的是 GGUF 主模型，但 ComfyUI 里**没有 UnetLoaderGGUF 节点** —— '
        + '请先把 ComfyUI-GGUF（city96/ComfyUI-GGUF）装进 custom_nodes 再重启 ComfyUI，'
        + '否则这个工作流会被直接拒收')
    }
  } else if (caps.models.unet === null && caps.models.unetGguf !== null) {
    caps.unetLoader = UNET_LOADER_GGUF
    caps.models.unet = caps.models.unetGguf
    caps.notes.push(`主模型（${cfgUnet}）没在 ComfyUI 里找到，但发现了 GGUF 版本`
      + `（${caps.models.unetGguf}）→ 自动改用 UnetLoaderGGUF 加载`)
  } else {
    caps.unetLoader = UNET_LOADER_NATIVE
  }

  // ---- 档位判定 ------------------------------------------------------------
  const hasCore = caps.models.unet !== null && caps.models.clip !== null && caps.models.vae !== null
  const canTurbo = caps.nodes.loraOnly && caps.models.turbo8Lora !== null
  if (probeFailed) {
    // ★ 探测本身不可信时**不降级**：按"能力齐全"去试。
    //   理由：把"没测出来"当成"没有"，会把用户静默打到慢档且毫无提示；
    //   而按 full 去试，万一真缺件，ComfyUI 会当场给出明确的 node type not found，
    //   用户看得懂、能重试。**明确报错优于静默变慢。**
    caps.level = 'full'
    caps.notes.push(`⚠ 能力探测有 ${errored}/${NODE_KEYS.length} 项未成功，本次按"能力齐全"处理，且不缓存结果`)
  } else if (!hasCore) {
    caps.level = 'unsupported'
    caps.notes.push('没在 ComfyUI 里匹配到完整的千问模型（UNET/CLIP/VAE），将沿用配置里的文件名')
  } else if (canTurbo) {
    caps.level = (caps.nodes.teSpeed || caps.nodes.speedup) ? 'full' : 'turbo'
  } else {
    caps.level = 'basic'
    caps.notes.push('未发现 turbo8 LoRA → 回退到 25 步 / CFG 2.5 的原生链路（慢但一定能出图）')
  }
  if (!probeFailed) {
    if (canTurbo && !caps.nodes.teSpeed) caps.notes.push('未安装 TE-Speed 节点 → 跳过该环节')
    if (canTurbo && !caps.nodes.speedup) caps.notes.push('未安装 QwenImage21Speedup 节点 → 跳过该环节')
    if (!caps.nodes.prefixCache) caps.notes.push('ComfyUI 无 QwenImage21Cache 节点 → 跳过前缀缓存')
    if (!caps.nodes.qwen21) caps.notes.push('⚠ 未发现 TextEncodeQwenImage21 节点：ComfyUI 版本可能过旧，需要 Qwen-Image 2.1 支持')
  }

  // ---- 模型名回落：探测不到就用配置里的（用户可能手填了自定义名）----
  caps.models.unet = caps.models.unet ?? cfg.unet
  caps.models.clip = caps.models.clip ?? cfg.clip
  caps.models.vae = caps.models.vae ?? cfg.vae
  caps.models.turbo8Lora = caps.models.turbo8Lora ?? (cfg.turbo8Lora || DEFAULT_TURBO8_LORA)

  // ★★★ 2026-10-09 性能修正（主人要求排查"重复请求、浪费算力"）：
  //   这里原先写的是"只在探测可信时才缓存"，于是**失败就完全不缓存** ——
  //   而状态端点是**每 5 秒轮询一次**的，且每次都会走一遍探测。
  //   结果：ComfyUI 在线但不稳定时，每 5 秒重发 10 个 HTTP 请求
  //   （9 个 object_info + 1 个 system_stats），纯粹是浪费。
  //   现在改为**失败也缓存，但用短 TTL**：既不重复轰炸，又能较快恢复真实结论。
  if (!signal?.aborted) {
    CAP_CACHE.set(cfg.comfyUrl, {
      at: Date.now(),
      ttl: probeFailed ? PROBE_FAIL_TTL_MS : baseTtl,
      caps,
    })
    caps.cached = true
  }

  if (log) {
    log('info', `能力探测：档位=${caps.level}${caps.cached ? '' : '（不缓存）'} `
      + `节点[qwen21=${caps.nodes.qwen21} 前缀缓存=${caps.nodes.prefixCache} TE=${caps.nodes.teSpeed} Speedup=${caps.nodes.speedup}]`)
    log('info', `模型匹配：unet=${caps.models.unet} clip=${caps.models.clip} vae=${caps.models.vae} lora=${caps.models.turbo8Lora}`)
    for (const note of caps.notes) log('info', `能力提示：${note}`)
  }
  return caps
}

/** 探测结果的空对象（`buildWorkflow` 不传 caps 时用它，等价于"能力齐全"）。 */
const FULL_CAPS = Object.freeze({
  // ★ 2026-10-10 修 bug：补 `rdna3fa` —— 原先漏了它，导致凡是不传 caps 的路径
  //   （`planWorkflow` / 自测）都拿不到 FA，与"caps 缺省 = 能力齐全"的约定不符。
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true, ggufUnet: true },
  // ⚠ 这里**刻意不放 `unetLoader`** —— 让它按模型名后缀现推（见 resolvePlan）。
  //   写死成 'UNETLoader' 会把 `.gguf` 的情形盖住（caps 缺省时错误地走原生加载器）。
  models: {},
  gpu: null,
  level: 'full',
  notes: [],
})

/**
 * 把「配置 + 探测结果」折算成这次实际要用的链路。
 *
 * ⚠ `caps` 为 undefined（自测直接调 buildWorkflow 的情况）＝ 当作能力齐全，
 *   保持"默认全栈"的老行为，避免所有既有断言失效。
 */
function resolvePlan(cfg, caps) {
  const c = caps ?? FULL_CAPS
  // ⚠ 只认 `level`（探测阶段算好的）。**绝不能**在这里用 `models.turbo8Lora` 判断 ——
  //   probeCapabilities 会把"没探测到"的 LoRA 名回落到默认文件名（为了给用户一个提示值），
  //   那时该字段非空但文件事实上不存在，用它判断会让 basic 档错误地接上 turbo8 LoRA，
  //   结果整单被 ComfyUI 以 `value not in list` 拒收。
  //
  // ★ 2026-10-09 精简：原先这里还写了 `c === FULL_CAPS ||`，其实**完全冗余** ——
  //   `FULL_CAPS` 自身的 `level` 就是 'full'、`nodes` 也全为 true，
  //   所以下面这些条件在传 FULL_CAPS 时本来就成立。
  const turboAvailable = c.level === 'full' || c.level === 'turbo'
  const useTurbo = turboAvailable && cfg.turbo8Enabled !== false
  // ⚠ TE-Speed / Speedup **刻意挂在 useTurbo 之下**（basic 档不接），这不是偷懒：
  //   它们的阈值（reuse_threshold 0.06 / te_predictor）是**针对 8 步 turbo8 链路调出来的**，
  //   挪到 25 步原生链路上，同一个阈值意味着完全不同的跳过行为，会动画质且未经验证。
  //   想强行叠加：把 turbo8Enabled 保持 true 即可（有 LoRA 时本来就会全接）。
  const useTe = useTurbo && c.nodes?.teSpeed === true && cfg.teSpeedEnabled !== false
  const useSpeedup = useTurbo && c.nodes?.speedup === true && cfg.speedupEnabled !== false
  const usePrefix = c.nodes?.prefixCache === true && cfg.qwenCacheEnabled !== false

  // ★★★ 2026-10-09：BlockCache T8 与 **TE-Speed、Speedup 三者互斥**（实测，见下）。
  //
  //   这不是猜测 —— 三个节点都在 ModelPatcher 上注册 **同一组** wrapper：
  //       DIFFUSION_MODEL + OUTER_SAMPLE
  //     · BlockCache  runtime.py:51 要求 **独占** DIFFUSION_MODEL：
  //         "Qwen Image 2.1 T8 cache requires exclusive diffusion-wrapper ownership;
  //          use T8 Spectrum"
  //     · TE-Speed    **编译成 nodes.pyd**，字符串表里能直接读到
  //         `DIFFUSION_MODEL` / `_predictor_diffusion_wrapper` /
  //         `_predictor_sample_wrapper` / `add_wrapper_with_key` / `WrappersMP`
  //     · Speedup     nodes.py:335-338 明写 add_wrapper_with_key(DIFFUSION_MODEL / OUTER_SAMPLE)
  //   只要同时挂上，KSampler 会在 sample_wrapper 里直接抛 ValueError，**整单失败**。
  //
  //   实测证据（同一台机器、图生图、逐个叠加）：
  //     BlockCache 单独                   → ✅ 成功，日志 `T8: full=6 cache=2`（真的命中）
  //     BlockCache + LoRA                 → ✅
  //     BlockCache + LoRA + Flux 位移     → ✅
  //     BlockCache + LoRA + Flux + 前缀缓存 → ✅
  //     BlockCache + … + **TE-Speed**     → ❌ ValueError 整单失败  ★ 真凶在这里
  //     （早先误判为 Speedup —— 当时 Speedup 也开着，是它先暴露了同样的错。）
  //
  //   ⇒ 处理：**BlockCache 优先，挂上它就让 TE-Speed 与 Speedup 双双让位**。
  //     理由：说好的「找一个能用的加速」就是 BlockCache，它是当前唯一被实测确认
  //     真正生效（cache 命中计数非零）的图生图加速；而 TE-Speed/Speedup 每步仍要
  //     算完整 block，只是跳预测，无法与它共存。
  //     想换回原来的链路：把 blockCacheEnabled 设成 false。
  const useBlockCache = c.nodes?.blockCache === true && cfg.blockCacheEnabled !== false
  // ★ 2026-10-10：RDNA3 FlashAttention —— 与上面三者**不互斥**（它是注意力层钩子，
  //   不是 DIFFUSION_MODEL wrapper），可任意叠加。无损，能力门控。
  //
  //   ★★ 还必须看 **GPU 架构**：FA 节点的 `patch()` 在不支持的架构上是**直接抛错**
  //      （不是"跳过"），一旦挂上就会让**整单失败**。所以门控加一条：
  //        · caps **完全没传**（自测 / planWorkflow）→ 视为"能力齐全"，不拦（守住既有约定）；
  //        · caps **传了** → **必须能确认是 RDNA3**（有 GPU 名 且 vendorIdOf==='amd_rdna3'）才挂。
  //          探测不到 GPU 名时**不放行** —— 否则会在"未知架构"上挂出会崩的节点。
  //   ★ 2026-10-10 修正：原先是"拿不到名字就不拦"，与"只认 gfx1100"自相矛盾。
  const faCapsOmitted = caps === undefined || caps === null
  const faGpuName = c.gpu?.name
  const faGpuOk = faCapsOmitted ? true : (!!faGpuName && vendorIdOf(faGpuName) === 'amd_rdna3')
  const useRdna3Fa = c.nodes?.rdna3fa === true && cfg.rdna3FlashAttention !== false && faGpuOk
  // ★ TE-Speed / Speedup 让位：BlockCache 赢了就不挂它们（否则整链崩）。
  const useTeFinal = useTe && !useBlockCache
  const useSpeedupFinal = useSpeedup && !useBlockCache

  // ★★★ 2026-10-09 新增：**显存驻留**档位的判定（供面板如实展示）。
  //   注意：它**不是**工作流节点，而是启动参数 —— 真正的加参数逻辑在
  //   ensureComfyUp（见 VRAM_ARGS），这里只做"同一套规则"的复述，
  //   供 check_acceleration 面板显示，避免面板与实际启动参数说法不一致。
  //   判定必须与 VRAM_ARGS **完全同源**（都读 vramGB + comfyArgs），否则就是假报告。
  //   取值优先级与 detectGpuProfile 一致：caps.gpu（/system_stats，权威）→ cfg.vramGB（探测缓存）。
  // ★ 2026-10-10 修 bug：原来用 `??` —— 而 `c.gpu.vramGB` 在 `/system_stats` 缺 `vram_total`
  //   时会被算成 **0**，`??` 不会把 0 当"空值"跳过 ⇒ 面板报"未取到显存总量"，
  //   可真实启动参数那边用的是 PyTorch 探测值、**已经加了 --highvram** —— 又一处"面板与实际不同源"。
  //   改用 `||`：0 视为无效，继续往回落。
  const vramGB = Number(c.gpu?.vramGB || c.residency?.vramGB || cfg.vramGB || 0)
  const userArgs = Array.isArray(cfg.comfyArgs)
  const residency = (() => {
    if (!Number.isFinite(vramGB) || vramGB <= 0) {
      return { on: false, applicable: false, vramGB: 0, note: '未取到显存总量（探测不到或不支持）' }
    }
    if (vramGB < 16) {
      return {
        on: false,
        applicable: false,
        vramGB,
        note: `本机显存 ${vramGB} GB < 16 GB，装不下整条链路（约 13.5 GB）还需给系统留量，故不加驻留参数`,
      }
    }
    if (userArgs) {
      // 用户接管了启动参数 → 插件不介入，如实说明（不冒充"已启用"）
      return {
        on: false,
        applicable: true,
        vramGB,
        note: `本机 ${vramGB} GB 够常驻，但你用 comfyArgs 接管了启动参数，插件不再自动加 --highvram`,
      }
    }
    return {
      on: true,
      applicable: true,
      vramGB,
      // ★ 数值必须与 VRAM_ARGS 同源（0.5，不是 1.5）—— 两处写死同一个数，
      //   改一处忘另一处就会出现"界面这么说、实际那么跑"的假报告。
      note: `本机 ${vramGB} GB ≥ 16 GB → 启动时自动加 --highvram${vramGB < 24 ? ' --reserve-vram 0.5' : ''}`,
    }
  })()
  return {
    useTurbo,
    useTe: useTeFinal,
    useSpeedup: useSpeedupFinal,
    usePrefix,
    useBlockCache,
    useRdna3Fa,
    residency,
    steps: useTurbo
      ? TURBO8_STEPS
      : (Number.isFinite(cfg.baseSteps) && cfg.baseSteps > 0 ? Math.trunc(cfg.baseSteps) : BASE_STEPS),
    cfgScale: useTurbo ? 1.0 : (Number.isFinite(cfg.baseCfg) ? cfg.baseCfg : BASE_CFG),
    models: {
      unet: c.models?.unet || cfg.unet,
      clip: c.models?.clip || cfg.clip,
      vae: c.models?.vae || cfg.vae,
      turbo8Lora: c.models?.turbo8Lora || (cfg.turbo8Lora || DEFAULT_TURBO8_LORA),
    },
    // ★ 2026-10-11：主模型加载器 —— 由探测阶段定好（见 probeCapabilities 的"模型档位"段）。
    //   caps 缺省（FULL_CAPS / 不传）时按文件名后缀现推一次，语义与旧版一致。
    unetLoader: c.unetLoader ?? unetLoaderFor(c.models?.unet || cfg.unet),
  }
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
function describeOptimization(cfg, caps) {
  // ── 总开关关掉：这是最优先要说清的事 ──────────────────────────────────
  if (cfg.enabled === false) {
    return {
      level: 'disabled',
      ok: false,
      summary: '插件已停用（enabled=false）',
      reasons: ['总开关被设为 false —— 不注册绘图工具、不注入提示词、不预热后端。'
        + '要恢复请把 cordis.patch.yml 里的 enabled 改成 true（或删掉那一行）后重启 DSH。'],
      detail: [],
      // 停用态没有可评估的项 —— 给零值而非 undefined，前端不必到处判空
      // ★ 2026-10-11：补 `optional`（与正常路径**形状一致** —— 否则"按桶求和"的代码会踩）
      stats: { on: 0, available: 0, off: 0, blocked: 0, optional: 0, optionalOn: 0, total: 0 },
      // 停用态不去探显卡（连 ComfyUI 都没打算用）→ 如实给空，前端不显示过滤提示
      gpu: null,
      filtered: [],
      warnings: [],
    }
  }

  // ── ComfyUI 没在运行 ─────────────────────────────────────────────────
  // ★★★ 2026-10-09 修正（主人反馈「为什么我本机都显示优化状态未知啊，这个判断也太傻了吧」）：
  //   原先这里报的是「未检测到 ComfyUI，优化状态未知」。
  //   但"未知"是错的说法 —— 我们**很清楚**发生了什么：优化链本来就跑在 ComfyUI 里，
  //   它没启动，当然无从谈优化。这不是"不知道"，而是"还没轮到检测"。
  //   更关键的是：**插件自己就有能力把 ComfyUI 拉起来**（出图时 ensureComfyUp，
  //   启动时还会预热），所以对用户来说这就是一个"待会儿自然就绪"的正常状态，
  //   完全不需要他做任何事，更不该让他以为哪里坏了。
  if (!caps) {
    return {
      level: 'idle',
      ok: false,
      // ★ 2026-10-09 按主人要求改成**因果明确**的表述：
      //   原来是"优化待检测"，主人指出应该直说"没启动 → 所以检测不了"。
      summary: 'ComfyUI 未启动，无法检测优化状态',
      reasons: [
        '优化链（turbo8、前缀缓存、跳步缓存）都跑在 ComfyUI 里，它现在没运行，所以**检测不了** —— 这是正常状态，不是故障。',
        '你不需要做任何事：出图时插件会自动把 ComfyUI 拉起来，之后这里就会显示真实的优化状态。',
        '想立刻看到结果：点状态点弹出的菜单里选「启动 ComfyUI」，或直接画一张图。',
      ],
      detail: [],
      // ★ 注意是 `total: 0` 而**不是 4** —— 这时候四项一项都没探测过，
      //   报"0/4 已启用"会让人以为全都没开，那是误导。
      // ★ 2026-10-11：补 `optional`（与正常路径形状一致）
      stats: { on: 0, available: 0, off: 0, blocked: 0, optional: 0, optionalOn: 0, total: 0 },
      // 还没探测 → 也还没识别显卡 → 不隐藏任何项
      gpu: null,
      filtered: [],
      warnings: [],
    }
  }

  const plan = resolvePlan(cfg, caps)
  const detail = []
  const reasons = []

  // ★★★ 2026-10-11 新增：**按显卡厂商过滤掉不适用的优化项**。
  //
  //   主人原话：「优化菜单没有动态过滤或者置灰啊。怎么 5060 还能弹出来 AMD R3 的优化呢？
  //     应该识别一下呀，识别是哪个显卡，就把不能用的优化直接隐藏掉。」
  //
  //   根因：`RDNA3 FlashAttention` 那一项原先**只看"节点装没装"、完全不看显卡** ——
  //     在 N 卡（如 RTX 5060）上会显示成「可启用：把 RDNA3-Flash-Attention 装进 custom_nodes」，
  //     而那个节点是 gfx1100（AMD RDNA3）专用的，装了也跑不了 ⇒ 纯误导。
  //
  //   约定（与"caps 缺省 = 能力齐全"一致）：**认不出显卡就不隐藏**。
  //     只有明确认到厂商、且该厂商不是这项要求的厂商时，才把它藏掉。
  //     —— 宁可多显示一项，也不能因为探测不到就把用户真能用的优化藏了。
  //
  //   `caps.gpu.name` 来自 ComfyUI `/system_stats` 的 `devices[0].name`
  //   （**实际用来算图的那张卡**，比 WMI 枚举更准）。拿不到时是空串。
  const gpuName = String(caps.gpu?.name ?? '').trim()
  const gpuVendor = gpuName === '' ? 'unknown' : vendorIdOf(gpuName)
  /** 该项是否适用于当前显卡：不指定 vendorId 的项一律适用；认不出显卡时一律适用。 */
  const appliesToGpu = (needVendor) => needVendor === undefined
    || gpuVendor === 'unknown' || gpuVendor === needVendor
  /** 被显卡过滤掉的项名 —— 给前端显示"藏了哪几项、为什么"，不静默消失。 */
  const hiddenByGpu = []

  // ── 逐项列出"打算用什么"以及"能不能用" ──────────────────────────────
  //
  // ★★★ 2026-10-09 升级（主人要求）：**从二元「已启用/未启用」升级为四态**。
  //
  //   主人原话：「你启用优化就应该是启用了哪些优化，这个也肯定要用区分啊
  //     你点进去就应该是告诉你启用了哪些优化，哪些可以启用哪些没启用，哪些不能启用」。
  //
  //   为什么必须分：原来的 whyOff 一句话里其实混着**三种完全不同的处境**，
  //   用户看完不知道该干什么 ——
  //     · 「没装 TE-Speed 节点」→ 装上就能快，**值得动手**；
  //     · 「被配置关了」        → 改一行配置就能快，**最容易修**；
  //     · 「依赖 turbo8 未生效」→ 上游没通，**现在做什么都没用**。
  //   三者显示成同一句灰字，等于把"能做的"和"做不了的"糊在一起，
  //   用户要么白折腾、要么以为插件坏了。
  //
  //   四态定义（`state` 字段，UI 直接照它上色，不再从文案里猜）：
  //     'on'        已启用 —— 正在生效
  //     'available' 可启用 —— 缺外部组件，装了就能生效（给出确切安装目标）
  //     'off'       可启用 —— 被配置关了，改配置即生效（给出确切配置键）
  //     'blocked'   不可启用 —— 依赖不满足 / 平台不支持，当前做什么都没用
  //     'superseded'  被取代 —— 与另一项结构互斥而主动让位（不是故障，也不需修）
  //
  //   `action` 是"该做什么"的一句话 —— 没有可做之事时给空串（UI 不显示那一行）。
  //   `whyOff` 保留：外部（含既有测试）可能还在读它。
  //
  // ★★★ 2026-10-09 新增 `toggle` 字段：**让用户自己开关**。
  //   主人原话：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
  //     TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
  //     请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
  //
  //   有 `toggle` 的项，前端会在那一行渲染一个可点的开关按钮。
  //   形状：{ key, on, canToggle, hint }
  //     · key       —— 开关标识，前端原样回传给 `?<key>=on|off`
  //     · on        —— 当前是开还是关（决定按钮外观）
  //     · canToggle —— false 时按钮置灰（缺节点等，切了也没用）
  //     · hint      —— 鼠标悬停/按钮下方的一句说明
  const item = (name, state, whyOn, whyOff, action, toggle, optional) => {
    detail.push({
      name,
      state,
      on: state === 'on',
      whyOn,
      whyOff,
      action: action ?? '',
      ...(toggle ? { toggle } : {}),
      // ★ 2026-10-11：`optional: true` = **可选实验档**（默认关、不影响"优化是否完整"的判定）。
      //   为什么需要它：像 RDNA4 的 CK 内核这种"厂商专属、默认关"的项，
      //   如果按普通项算，用户一进面板就会看到"优化部分启用（还差 1 项）" —— 纯属噪音。
      ...(optional ? { optional: true } : {}),
    })
  }

  item(
    'turbo8 八步蒸馏',
    plan.useTurbo ? 'on' : (caps.models?.turbo8Lora ? 'off' : 'available'),
    '已生效：LoRA + 采样位移 + 8 步 / CFG 1.0',
    caps.models?.turbo8Lora
      ? `未启用：没在 ComfyUI 的 loras 目录里找到 turbo8 LoRA`
        + `（当前回落的文件名是「${caps.models.turbo8Lora}」，看起来并不存在）。`
        + '把 turbo8_lora_step2500.safetensors 放进 models\\loras 即可。'
      : '未启用：没找到 turbo8 LoRA。放进 models\\loras 后可提速约 7 倍。',
    plan.useTurbo
      ? ''
      : (caps.models?.turbo8Lora
        // 探测到了名字却没用上 → 是配置关的
        ? '把 turbo8Enabled 改回 true（或删掉那一行）后重启 DSH。'
        // 连名字都没探测到 → 需要放文件
        : '把 turbo8_lora_step2500.safetensors 放进 ComfyUI 的 models\\loras 目录，'
          + '重启 ComfyUI 后自动生效（不必改配置）。'),
  )

  item(
    '前缀 KV 缓存',
    plan.usePrefix ? 'on' : (caps.nodes?.prefixCache ? 'off' : 'available'),
    '已生效：QwenImage21Cache（int8）',
    caps.nodes?.prefixCache
      ? '未启用：被配置关了（qwenCacheEnabled=false）。'
      : '未启用：ComfyUI 里没有 QwenImage21Cache 节点 —— 通常是 ComfyUI 版本偏旧，'
        + '升级到支持 Qwen-Image 2.1 的版本即可。',
    plan.usePrefix
      ? ''
      : (caps.nodes?.prefixCache
        ? '把 qwenCacheEnabled 改回 true（或删掉那一行）后重启 DSH。'
        : '升级 ComfyUI 到带 QwenImage21Cache 节点的版本（Qwen-Image 2.1 支持）。'),
  )

  // TE-Speed / Speedup：**依赖 turbo8 链路**，所以"不可启用"是一个独立状态 ——
  // 这也是主人那句「哪些不能启用」最典型的落点。
  //
  // ★ 2026-10-09：新增 `superseded`（被取代）—— BlockCache 与 TE-Speed/Speedup
  //   三者争抢同一组 DIFFUSION_MODEL wrapper，BlockCache 生效时后两者**主动让位**，
  //   不是"被配置关了"也不是"没装"。显示成 off 会让用户去修一个不该开的开关。
  const depNote = '它依赖 turbo8 链路（阈值是按 8 步调的），turbo8 没生效时不会单独启用。'
  item(
    'TE-Speed 跳步缓存',
    plan.useTe
      ? 'on'
      : (plan.useBlockCache
        ? 'superseded'
        : (!plan.useTurbo ? 'blocked' : (caps.nodes?.teSpeed ? 'off' : 'available'))),
    '已生效',
    plan.useTe
      ? ''
      : (plan.useBlockCache
        // ★ 2026-10-09 二次修正：不再是"无条件让位"，而是**按尺寸让位**。
        ? '按尺寸让位：大尺寸（latent > '
          + `${Number.isFinite(cfg.wrapperAutoTokensThreshold) ? cfg.wrapperAutoTokensThreshold : 16384}`
          + ' tokens，如 1408²=30976）交给 BlockCache T8 —— '
          + '**TE-Speed 在这个尺寸实测 0% 加速**（日志：predicted 0/8 steps），'
          + '白占互斥的 wrapper 坑；小尺寸仍由本项生效（实测 +25.4%）。'
        : (!plan.useTurbo
          ? `未启用：${depNote}`
          : (caps.nodes?.teSpeed
            ? '未启用：被配置关了（teSpeedEnabled=false）。'
            : '未启用：没装 TE-Speed-QwenImage21 自定义节点（少省约 23% 时间）。'))),
    plan.useTe
      ? ''
      : (plan.useBlockCache
        ? '想换回 TE-Speed：把 blockCacheEnabled 改成 false（两者只能二选一）。'
        : (!plan.useTurbo
          // 上游没通 —— 明确告诉用户"先别管这个"
          ? '先让 turbo8 生效（见上一项），本项会自动跟上，无需单独配置。'
          : (caps.nodes?.teSpeed
            ? '把 teSpeedEnabled 改回 true（或删掉那一行）后重启 DSH。'
            : '装 TE-Speed-QwenImage21 自定义节点到 custom_nodes 后重启 ComfyUI。'))),
  )

  // ★ 2026-10-09：新增 `superseded`（被取代）状态 —— Speedup 与 BlockCache 互斥，
  //   BlockCache 生效时 Speedup 是**主动让位**，而不是"被配置关了"或"没装"。
  //   把它显示成 off 会误导用户去"修"一个本来就不该开的开关。
  item(
    'Speedup 步级残差缓存',
    plan.useSpeedup
      ? 'on'
      : (plan.useBlockCache
        ? 'superseded'
        : (!plan.useTurbo ? 'blocked' : (caps.nodes?.speedup ? 'off' : 'available'))),
    '已生效',
    plan.useSpeedup
      ? ''
      : (plan.useBlockCache
        // ★ 2026-10-09 二次修正：同样是**按尺寸让位**，且 Speedup 在大尺寸只有 12.5%。
        ? '按尺寸让位：大尺寸交给 BlockCache T8 —— Speedup 在 1408² 实测只跳过 1/8 步（12.5%），'
          + '而 BlockCache T8 在大尺寸实测 +22.7%；小尺寸仍由本项与 TE-Speed 一起生效。'
        : (!plan.useTurbo
          ? '未启用：同 TE-Speed，依赖 turbo8 链路。'
          : (caps.nodes?.speedup
            ? '未启用：被配置关了（speedupEnabled=false）。'
            : '未启用：没装 ComfyUI-Qwen-Image-2.1-Speedup 自定义节点。'))),
    plan.useSpeedup
      ? ''
      : (plan.useBlockCache
        ? '想让所有尺寸都走 Speedup：把 wrapperPolicy 改成 te（或 blockCacheEnabled 改成 false）。'
        : (!plan.useTurbo
          ? '先让 turbo8 生效（见上一项），本项会自动跟上，无需单独配置。'
          : (caps.nodes?.speedup
            ? '把 speedupEnabled 改回 true（或删掉那一行）后重启 DSH。'
            : '装 ComfyUI-Qwen-Image-2.1-Speedup 自定义节点到 custom_nodes 后重启 ComfyUI。'))),
  )

  // ★ 2026-10-09 新增：BlockCache T8（取代 ToMe 的图生图加速）
  //   它是**插件节点**，没装时整单会被 ComfyUI 拒收 —— 必须靠探测开关兜住，
  //   所以这里也要如实告诉用户"装了就能用"还是"没装"。
  //   ★ 让位关系要说清楚：BlockCache 生效时 TE-Speed / Speedup 是**主动让位**
  //     （superseded），不是故障。用户若想换回去，这里给出确切做法。
  // ★★★ 2026-10-09 二次修正：不再是"要么一直开、要么一直关"，
  //   而是**按出图尺寸自动接管**（wrapperPolicy=auto）。文案必须跟着改，
  //   否则会出现"面板说 BlockCache 关着，但 1408 出图实际在用它"的假报告。
  const wpPolicy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'
  const wpThreshold = Number.isFinite(cfg.wrapperAutoTokensThreshold) && cfg.wrapperAutoTokensThreshold > 0
    ? cfg.wrapperAutoTokensThreshold : 16384
  item(
    'BlockCache T8 块级缓存',
    plan.useBlockCache ? 'on' : (caps.nodes?.blockCache ? 'off' : 'available'),
    (wpPolicy === 'bc'
      ? '已生效（固定）：wrapperPolicy=bc，所有尺寸都走本项。'
      : `已生效（按尺寸）：latent > ${wpThreshold} tokens（约 1024² 以上，如 1408²=30976）时由本项接管；`
        + '小尺寸让位给 TE-Speed + Speedup。')
      + `｜首块目标残差缓存（threshold ${cfg.blockCacheThreshold ?? 0.03}），`
      + '官方描述保留 Core 的参考图/文本 KV 缓存 ⇒ **与前缀 KV 缓存可叠加**。'
      + '｜大尺寸实测 **+22.7%**（120.75 s → 93.34 s，省 27.4 s）。',
    caps.nodes?.blockCache
      ? '未启用：被配置关了（blockCacheEnabled=false）—— 大尺寸会退回 TE-Speed + Speedup，'
        + '而 TE-Speed 在 1408×1408 实测 **0% 加速**。'
      : '未启用：没装 Comfyui-Qwen-Image-2.1-BlockCache-T8 自定义节点。',
    plan.useBlockCache
      ? '想让所有尺寸都走 TE-Speed + Speedup：把 wrapperPolicy 改成 te（或 blockCacheEnabled 改成 false）。'
      : (caps.nodes?.blockCache
        ? '把 blockCacheEnabled 改回 true（或删掉那一行）后重启 DSH —— 大尺寸就能用上它。'
        : '把 Comfyui-Qwen-Image-2.1-BlockCache-T8 装进 custom_nodes 后重启 ComfyUI。'),
    // ★ 开关（主人要求）：装了节点才能切；没装时置灰，切了也没用。
    {
      key: 'blockcache',
      on: plan.useBlockCache,
      canToggle: caps.nodes?.blockCache === true,
      hint: caps.nodes?.blockCache
        ? (plan.useBlockCache
          ? `当前：开。${wpPolicy === 'auto' ? `按尺寸接管 —— 大于 ${wpThreshold} tokens 时上，小尺寸仍走 TE-Speed + Speedup。` : '所有尺寸都走本项。'}`
          : '当前：关。大尺寸（如 1408²）会退回 TE-Speed + Speedup，'
            + '而 TE-Speed 在那个尺寸实测 0% 加速 —— 建议打开。')
        : '没装 BlockCache T8 节点，开关不可用。',
    },
  )

  // ★ 2026-10-10 新增：RDNA3 FlashAttention（**无损**加速，与上面三者不互斥）。
  //   它已经装在 custom_nodes 里、却一直没接进工作流（等于白装）—— 接上后如实展示。
  // ★★★ 2026-10-11：**按显卡门控** —— 这个节点只认 gfx1100（AMD RDNA3）。
  //   在 N 卡 / I 卡 / RDNA2 / RDNA4 上它既装不了也跑不了，列出来只会让用户白折腾，
  //   所以**直接不显示**（认不出显卡时照旧显示，见 appliesToGpu 的约定）。
  if (appliesToGpu('amd_rdna3')) {
    item(
      'RDNA3 FlashAttention（无损）',
      plan.useRdna3Fa ? 'on' : (caps.nodes?.rdna3fa ? 'off' : 'available'),
      '已生效：注意力走 RDNA3 FlashAttention 内核（**精确注意力**，不改成品）。'
        + '｜1408² 时注意力是采样的大头，这条是纯提速、不掉质量。',
      plan.useRdna3Fa
        ? ''
        : (caps.nodes?.rdna3fa
          ? '未启用：被配置关了（rdna3FlashAttention=false）。'
          : '未启用：没装 RDNA3-Flash-Attention 自定义节点（gfx1100 专用、无损）。'),
      plan.useRdna3Fa
        ? ''
        : (caps.nodes?.rdna3fa
          ? '把 rdna3FlashAttention 改回 true（或删掉那一行）后重启 DSH。'
          : '把 RDNA3-Flash-Attention 装进 custom_nodes 后重启 ComfyUI。'),
    )
  } else {
    hiddenByGpu.push('RDNA3 FlashAttention（无损）')
  }

  // ★★★ 2026-10-11 新增：**A 卡专属优化（可选，仅 AMD 显示）**。
  //   与 N 卡/I 卡的"厂商专属优化"同一套思路：只在适用的显卡上出现、**默认关**、用户自己决定。
  //   两项都**质量中性**（换后端 / 改加载时机，都不改计算结果 ⇒ **不牺牲原生画质**）。
  //   ⚠ 标记为 `optional`：默认关的项**不该**把面板拖成"优化部分启用"（见 item() 的说明）。
  if (String(gpuVendor).startsWith('amd')) {
    const kernelFlag = AMD_KERNEL_FLAG[gpuVendor] ?? null
    if (kernelFlag !== null) {
      const defaultPath = (GPU_PROFILES[gpuVendor]?.args ?? []).join(' ') || '（无额外参数）'
      item(
        `A 卡专属内核（可选）：${kernelFlag}`,
        cfg.amdKernel === true ? 'on' : 'off',
        `已启用：启动参数改用 ${kernelFlag}。⚠ 改这个参数**需要重启 ComfyUI** 才生效。`,
        `未启用：当前走本代默认路径（${defaultPath}）。本项是**可选档**，默认关闭；`
          + '换的是注意力**后端**，不改计算结果、不降画质。',
        cfg.amdKernel === true ? '想回到默认：关掉本项（同样需重启 ComfyUI）。' : '想试：打开本项，然后重启 ComfyUI。',
        {
          key: 'amdkernel',
          on: cfg.amdKernel === true,
          canToggle: true,
          hint: `⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。换成 ${kernelFlag}（质量中性）。`
            + '本项**没在你的卡上实测过**，属可选档；不合适就关回去。',
        },
        true,
      )
    }
    item(
      'A 卡异步卸载（可选）：--async-offload',
      cfg.amdAsyncOffload === true ? 'on' : 'off',
      '已启用：--async-offload（权重加载与计算重叠）。⚠ 需重启 ComfyUI 才生效。',
      '未启用：ComfyUI 的 `--async-offload` **在 N 卡上默认开、在 A 卡上默认关**，本项就是把它补上。'
        + '只改变权重加载的**时机**，不改任何计算结果。',
      cfg.amdAsyncOffload === true ? '想关掉：关掉本项（同样需重启 ComfyUI）。' : '想试：打开本项，然后重启 ComfyUI。',
      {
        key: 'asyncOffload',
        on: cfg.amdAsyncOffload === true,
        canToggle: true,
        hint: '⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。质量中性（只改加载时机）。',
      },
      true,
    )
  }

  // ★★★ 2026-10-11 新增：**N 卡 SageAttention（可选，仅 NVIDIA 显示）**。
  //   40 系（Ada）/ 50 系（Blackwell）的专属注意力加速 —— 与 A 卡的专属优化同一套模式：
  //   只在适用显卡上出现、默认按自检结果、用户可手动接管。
  //   ⚠ 与 A 卡那两项不同：`--use-sage-attention` 是**硬依赖** —— 没装还挂上，ComfyUI 起不来。
  //     所以"确认没装"时**把开关置灰**，而不是让用户点一下就崩。
  if (gpuVendor === 'nvidia') {
    const mode = cfg.nvidiaSageAttention
    const on = mode === true || (mode !== false && SAGE_READY === true)
    const gen = nvidiaGenOf(gpuName)
    const genNote = gen === 'blackwell'
      ? '⚠ 50 系（Blackwell / sm_120）需要**支持 sm_120 的** Triton / SageAttention 构建，老版本不认这代卡。'
      : ''
    item(
      'N 卡 SageAttention（可选）：--use-sage-attention',
      on ? 'on' : 'off',
      `已启用：启动参数加上 --use-sage-attention（INT8 量化注意力内核）。⚠ 需重启 ComfyUI 才生效。${genNote}`,
      // ⚠ 顺序很重要：**先看用户是不是显式关了** —— 否则 `nvidiaSageAttention: false`
      //   会被后面"自检还没跑完"的分支盖住，用户明明关了却读到一句无关的话。
      (mode === false
        ? '未启用：被配置关了（nvidiaSageAttention=false）。'
        : (SAGE_READY === false
          ? '未启用：后台自检**没探测到 sageattention** —— 先把它装上，装好后会自动启用（开关当前置灰）。'
          : (SAGE_READY === true
            ? '未启用：被配置关了（nvidiaSageAttention=false）。'
            : '未启用：后台自检还没跑完，状态未知（保守起见先不加）。稍等或出一次图后再回来看。')))
        + ` ${genNote}`,
      SAGE_READY === false
        ? '装法：在对话里说「检查加速环境并安装缺失的包」，或调 check_acceleration 的 install 动作。'
        : '想强制开启：把 nvidiaSageAttention 设成 true（**确定装好了再设** —— 没装会让 ComfyUI 起不来）。',
      {
        key: 'sagesa',
        on,
        // 已确认"没装"时置灰 —— 切了只会让 ComfyUI 起不来（这是硬依赖参数）
        canToggle: SAGE_READY !== false,
        hint: '⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。质量中性（只换注意力内核）。'
          + (SAGE_READY === false ? ' 当前**未检测到 sageattention**，开关已置灰 —— 先装它。' : '')
          + (genNote ? ` ${genNote}` : ''),
      },
      true,
    )
  }

  // ★ 2026-10-09 二次修正新增：**三选一策略**单独列一项。
  //   这三者互相排斥，用户最需要知道的不是"每一项开没开"，
  //   而是"这次出图到底走哪一套、凭什么"。不列出来就只能靠猜。
  item(
    '互斥三选一策略（wrapper）',
    'on',
    (wpPolicy === 'auto'
      ? `按尺寸自动：latent ≤ ${wpThreshold} tokens → TE-Speed + Speedup（小尺寸实测 +25.4%）；`
        + `> ${wpThreshold} tokens → BlockCache T8（大尺寸实测 +22.7%）。`
      : (wpPolicy === 'te'
        ? '固定 TE-Speed + Speedup（所有尺寸）。⚠ 大尺寸下 TE 实测 0% 加速，等于白占坑。'
        : '固定 BlockCache T8（所有尺寸）。⚠ 小尺寸下 TE+Speedup 更快（+25.4% vs +22.7%）。'))
      + '｜三者争抢同一组 DIFFUSION_MODEL wrapper，绝不会同时上两个（同挂会 ValueError 整单失败）。'
      + `｜改法：cordis.patch.yml 设 wrapperPolicy: auto | te | bc；`
      + `auto 的分界用 wrapperAutoTokensThreshold（当前 ${wpThreshold}）。`,
    '',
  )

  // ★★★ 2026-10-09 新增：**显存驻留**才是整条工作流 90 秒 → 30~40 秒的真正解药。
  //   加速节点只省"采样那 8 步"（8~11 秒）；而整条工作流实测 90~150 秒，
  //   差额几乎全在**模型反复装卸**上（UNET 6.9 + CLIP 6.0 + VAE 0.64 ≈ 13.5 GB
  //   装不进当时可用的 12.09 GB）。所以这一项必须**显式列出来**，
  //   否则用户会以为"优化打了跟没打一样"——正是主人上次的原话。
  //   它由启动参数决定，不在工作流里，所以单独描述。
  item(
    '显存驻留（--highvram）',
    plan.residency?.on ? 'on' : (plan.residency?.applicable ? 'off' : 'blocked'),
    `已生效：${plan.residency?.note ?? ''}`
      + '｜模型常驻显存，避免每次出图反复装卸（这是整条工作流耗时的大头）。',
    plan.residency?.applicable
      ? `未启用：${plan.residency?.note ?? ''}`
      : `不适用：${plan.residency?.note ?? '未取到显存总量，插件不擅自加驻留参数。'}`,
    plan.residency?.on
      ? ''
      : (plan.residency?.applicable
        ? '把 comfyArgs 里的自定义参数删掉（让它回到自动档），或自行加上 --highvram。'
        : '让 ComfyUI 的 python 可被探测到（通常装好即自动），随后重启 DSH 即会重判。'),
  )

  // 把"没生效"的逐条汇总成 reason（这才是用户真正要看的东西）
  //   ★ 被取代项（superseded）不进 reasons —— 它不是"没生效"，是主动让位，
  //     塞进待办清单会让用户去修一个本来就不该开的开关。
  for (const one of detail) {
    // ★ 2026-10-11：`optional`（A 卡专属可选档）**不进 reasons** ——
    //   它是"默认关、想试再开"的项，不是"缺了什么"，列进待办只会让人去修一个本就不该开的开关。
    if (!one.on && one.state !== 'superseded' && one.optional !== true) reasons.push(one.whyOff)
  }

  // ★ 状态统计 —— summary 与 UI 的「可做之事」都靠它。
  //   2026-10-09：新增 `superseded`（被取代）一态，见上面 Speedup 那段注释。
  // ★ 2026-10-11：`optional`（可选档）**单独一桶**，不再混进 on/available/off/blocked ——
  //   否则"默认关的可选项"会被算成"1 项可启用"，把总账搅浑。各桶之和 = total。
  const countOf = (state) => detail.filter((d) => d.optional !== true && d.state === state).length
  const optionalItems = detail.filter((d) => d.optional === true)
  const stats = {
    on: countOf('on'),
    available: countOf('available'),
    off: countOf('off'),
    blocked: countOf('blocked'),
    superseded: countOf('superseded'),
    optional: optionalItems.length,
    // ★★★ 2026-10-11 补：可选项里**已经打开**的有几个。
    //   没有它的话，用户把可选项打开之后总账仍会写「N 项可选（**默认关**）」—— 自相矛盾。
    //   ⚠ 它是 `optional` 的**子计数**（不是独立一桶），所以"各桶之和 = total"不受影响。
    optionalOn: optionalItems.filter((d) => d.state === 'on').length,
    total: detail.length,
  }

  // ── 探测本身没成功：这跟"确实缺件"是两回事，必须分开说 ────────────────
  if (caps.probeFailed) {
    // ★★★ 关键：这时候上面那四项的 state 是**按"能力齐全"假设**算出来的，
    //   （resolvePlan 在探测失败时会照 FULL_CAPS 的语义走），
    //   直接把它们显示成"已启用"就是骗人 —— 用户会以为加速都生效了。
    //   所以整批改写成 `unknown`，前端显示"未确认"而不是"已启用"。
    const uncertain = detail.map((d) => ({
      ...d,
      state: 'unknown',
      on: false,
      action: '等 ComfyUI 起来后重新检测（通常点一次出图即可）。',
    }))
    for (const one of uncertain) one.whyOff = '未确认：本次探测没成功，无法判断这一项到底能不能用。'
    return {
      level: 'probe-failed',
      ok: false,
      summary: '优化状态未确认（探测失败）',
      reasons: [
        '插件没能从 ComfyUI 读到节点/模型清单（接口无响应或超时），'
        + '所以**无法确认**优化是否可用 —— 这不代表缺件，也不代表优化没生效。',
        '出图时插件会重新探测。若反复出现，请确认 ComfyUI 正在运行、且 8188 端口可达。',
      ],
      detail: uncertain,
      // ★ 未确认时各态一律归零 —— 报"4 项已启用"是假报告，"4 项可用"也是假报告。
      // ★★★ 2026-10-11 修 bug：`unknown` 必须**排除可选项** ——
      //   否则它会与 `optional` **重复计数**（实测 total=10 / unknown=10 / optional=2 ⇒ 求和 12），
      //   客户端总账会出现「共 10 项：10 项未确认 · 2 项可选」这种自相矛盾的显示。
      stats: {
        on: 0,
        available: 0,
        off: 0,
        blocked: 0,
        superseded: 0,
        optional: detail.filter((d) => d.optional === true).length,
        // 探测失败时所有项都是 unknown ⇒ 可选项一个都没开
        optionalOn: 0,
        unknown: detail.filter((d) => d.optional !== true).length,
        total: detail.length,
      },
      // ★ 显卡过滤结果照带（探测失败时 `caps.gpu` 往往也是空的 → 不隐藏，如实反映）
      gpu: gpuName === '' ? null : { name: gpuName, vendor: gpuVendor },
      filtered: hiddenByGpu,
      // ★★★ 2026-10-11 去重：探测失败时 `reasons` 已经把"读不到清单"说清楚了，
      //   而 `caps.notes` 里那句「⚠ 能力探测有 N/M 项未成功…」是**同一件事**——
      //   两条都显示等于让用户在面板上看两遍同样的内容。
      //   所以这里把它排除掉；**其余 ⚠ note（如缺 UnetLoaderGGUF / 缺 TextEncodeQwenImage21）
      //   照常保留** —— 那两条是"机器知道、但用户看不到就白折腾"的硬缺口。
      warnings: importantNotesOf(caps).filter((n) => !String(n).includes('项未成功')),
    }
  }

  // ── ComfyUI 没启动（idle）：上面已经提前 return，这里只会是「真探测过」的情形 ──

  // ── 一切正常 ─────────────────────────────────────────────────────────
  // ★ 各项**全都要算进来**：早先这里只看了 turbo8 + 前缀缓存，于是"没装 TE-Speed"
  //   这种确实少了一层优化的情况，照样报"优化已启用"—— 报告等于骗人。
  //
  //   2026-10-09：改成按「**未解决**项」判定。三种"没生效"要分开看：
  //     · blocked / off / available → 真的没生效，**算未解决** → 不能报 full
  //     · superseded（被取代）      → 是主动让位，**不算未解决** → 不拉低 level
  //   原先用 `plan.useTe` 直接判定是错的 —— 让位后它必然是 false，
  //   会把一条完全健康的链路误报成"部分启用"。
  const unresolved = detail.filter((d) => d.state !== 'on' && d.state !== 'superseded' && d.optional !== true)
  const allOn = unresolved.length === 0

  // ★ summary 升级：不只是"缺了哪几项"，而是**分别点出"能补的"和"补不了的"**。
  //   主人要的正是这个区分 —— 全堆在一起用户不知道从哪下手。
  let summary
  if (allOn) {
    const superNote = stats.superseded > 0 ? `（${stats.superseded} 项按尺寸让位）` : ''
    // ★ 2026-10-09 二次修正：BlockCache 已**不是恒定生效**，而是按出图尺寸与
    //   TE-Speed + Speedup 二选一。所以这里不能无条件写"+ BlockCache" ——
    //   小尺寸实际挂的是 TE+Speedup，写成 BlockCache 就是"面板说一套、实际跑另一套"。
    const chainNote = wpPolicy === 'bc'
      ? ' + BlockCache T8'
      : (wpPolicy === 'te'
        ? ' + TE-Speed + Speedup'
        : ' + wrapper 按尺寸自动（小尺寸 TE+Speedup / 大尺寸 BlockCache T8）')
    summary = `优化已启用（8 步 / CFG 1.0 全栈链路${chainNote}）${superNote}`
  } else if (!plan.useTurbo) {
    summary = '未启用优化：回退到 25 步原生链路（较慢，但一定能出图）'
  } else {
    const fixable = stats.available + stats.off
    const stuck = stats.blocked
    summary = fixable > 0
      ? `优化部分启用（还差 ${fixable} 项可启用）`
      : `优化部分启用（${stuck} 项当前不可启用）`
  }

  return {
    level: allOn ? 'full' : (plan.useTurbo ? 'turbo' : 'basic'),
    ok: allOn,
    summary,
    reasons: allOn ? [] : reasons,
    detail,
    // ★ 状态计数 —— 前端据此决定标题下方那行"可做之事"怎么措辞。
    stats,
    // ★★★ 2026-10-11：**按显卡过滤的结果**（见函数上方 appliesToGpu 的说明）。
    //   `gpu` 让前端能显示"按哪张卡过滤的"；`filtered` 是被藏掉的项名 ——
    //   不静默消失：用户至少知道"藏了哪几项、为什么"。
    gpu: gpuName === '' ? null : { name: gpuName, vendor: gpuVendor },
    filtered: hiddenByGpu,
    // ★★★ 2026-10-11：关键能力缺口（如"缺 UnetLoaderGGUF 节点"）——
    //   以前只在日志里，面板上看不到；现在如实带出去，由前端置顶显示。
    warnings: importantNotesOf(caps),
  }
}

/* ------------------------------------------------------------------ 工具本体 ---- */

/** 参数 schema（标准 JSON Schema；只用官方 present 用过的那几个关键字）。 */
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
        '参考图的本地文件路径（可选）。**给了就走图生图**：以这张图为参考，按 prompt 改姿势、换环境、换动作，'
        + '保持同一个角色和画风；不给就是普通文生图（只按文字描述画）。PNG / JPG / WEBP 都行。',
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
      description: '采样步数，默认 25，范围 1-60。步数越高越精细、越慢。',
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
    negative: {
      type: 'string',
      description: '负面提示词（不想要的内容）。注意千问模型 cfg=1，负面词基本不生效，一般不用填。',
    },
  },
  required: ['prompt'],
}

/** 结果 schema（标准 JSON Schema）。 */
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
  },
  required: ['path', 'width', 'height', 'seed', 'seconds', 'files'],
}

/**
 * hipfire 出图分支（★ 2026-10-08 新增）。
 *
 * ★ 设计原则：**复用现有交付链路**，不另造一套 ——
 *   产物路径照样进 value.files → 由外层的 onProduced 登记交付事件 →
 *   正文 Markdown 内联显示（与 ComfyUI 路径完全同一条链路）。
 *
 * ★ 与 ComfyUI 分支的**语义差异**（都是客观限制，如实处理，不粉饰）：
 *   · 尺寸：hipfire 要求宽高是 **16 的倍数**（VAE factor 8 + 2x2 patch），
 *     所以把 calcSize 出来的值再过一遍 alignSize；图生图时 Klein 另有 1 MP 面积上限。
 *   · 步数：schnell 是步蒸馏模型，默认 4 步；用户没显式给 steps 时交给 hipfire
 *     用它自己的架构默认值（不硬塞插件的 25 步 —— 那对 schnell 是纯粹浪费）。
 *   · 参考图：hipfire 直接吃**本地路径**（CLI 的 --image / HTTP 的 multipart），
 *     **不需要**像 ComfyUI 那样先上传到 input 目录。
 *   · 负面提示词：hipfire 不支持 → 在适配器里明确报错。
 */
async function executeHipfire(args, exec, { cfg, log, prompt, steps, seed, width, height, onProduced }) {
  const signal = exec?.signal
  const started = Date.now()

  // hipfire 的宽高必须是 16 的倍数
  const hw = Math.max(HIPFIRE_SIZE_MULTIPLE, Math.round(width / HIPFIRE_SIZE_MULTIPLE) * HIPFIRE_SIZE_MULTIPLE)
  const hh = Math.max(HIPFIRE_SIZE_MULTIPLE, Math.round(height / HIPFIRE_SIZE_MULTIPLE) * HIPFIRE_SIZE_MULTIPLE)

  // 用户**显式**传了 steps 才透传；否则交给 hipfire 用自己的架构默认
  // （schnell=4 / dev=28），避免把插件的默认 25 硬塞给步蒸馏模型。
  const explicitSteps = Number.isFinite(args?.steps) ? steps : undefined

  const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
  const references = refPath === '' ? [] : [refPath]

  // ⚠ 这行原先写成了**嵌套模板字符串**（外层反引号里又嵌了一个反引号模板），
  //   JS 解析歧义、node --check 直接报语法错 —— 整个文件都过不了。
  //   拆成"先算个变量"再插值，结果完全一样但没有嵌套。
  const modeText = references.length > 0 ? `（图生图 参考=${refPath}）` : '（文生图）'
  log('info', `hipfire 出图 ${hw}x${hh} steps=${explicitSteps ?? '(模型默认)'} seed=${seed}${modeText}`)

  const result = await generateWithHipfire(
    cfg,
    { prompt, negative: args?.negative, width: hw, height: hh, steps: explicitSteps, seed, references },
    signal,
    log,
  )

  if (!result.ok) {
    // ★ 失败**必须明确抛出** —— 绝不返回假成功（出图是用户可见产物）。
    throw new Error(`hipfire 出图失败：\n${result.error}`)
  }
  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error('hipfire 出图报告成功，但没有返回任何文件路径')
  }

  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))
  const value = { path: result.files[0], width: hw, height: hh, seed, seconds, files: result.files }
  if (typeof onProduced === 'function') {
    try {
      onProduced(exec, value)
    } catch (error) {
      log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
    }
  }
  return value
}

/**
 * 建工具定义。注意这里**不用 defineTool**：register 要的就是这么个对象。
 * @param ctx - 已注入 tools 的上下文
 * @param cfg - 合并后的配置
 * @param log - 记日志
 * @param onProduced - 出图成功后回调（用来 append 交付事件 + 记活动时间）
 */
function makeDrawTool(ctx, cfg, log, onProduced, onStart) {
  return {
    name: 'draw_image',
    description:
      '用本机 ComfyUI 的千问（Qwen-Image 2.1）模型画图。给一段画面描述就能出图，图片会保存到「千问1生图」目录，' +
      '并把绝对路径回给你，用来在回复里内联显示。纯本地运行，不出网、不花钱、不需要任何 API Key。' +
      // ★ 2026-10-09：把边界写进描述 —— 工具描述是模型最先看到的信息，
      //   比 systemPrompt 段落更靠近"要不要调这个工具"的那一刻。
      // ★★★ 2026-10-09 改写（真事故）：**不许助手绕过本工具自己去"画"图**。
      //
      //   现场：用户说「画一幅表现双曲几何之美的数学艺术画」，助手**没调本工具**，
      //   而是自己写 Python/Matplotlib 渲染了一张 —— 耗时 2 分 39 秒，
      //   还附带一通"数学上不精确""要不要我改用代码渲染"的分析。
      //   用户原话：「谁叫你去修，我让他画图，为什么他还想自行代码画」。
      //
      //   根因有两处，都在提示词里：
      //     ① 旧文案写「流程图 / 思维导图 / 表格 / 架构图 / **示意图**……先与用户确认」
      //        —— "示意图"三个字太宽，助手看到"数学/几何"就往"图表类"上靠 → 不敢画。
      //     ② **全篇没有任何一条"禁止自己用代码画图"的硬约束**
      //        —— 助手于是选了它自认为"更精确"的路：自己写脚本渲染。
      //
      //   所以改写遵循三条：
      //     · 判定标准从"内容题材"改成**用户要的产物形态**（一张位图 vs 可编辑的结构化图表）；
      //     · 排除清单**收窄**到明确可编辑的那几类，删掉"示意图"这个万金油词；
      //     · **显式禁止**用代码 / SVG / HTML / ASCII 自己出图代替本工具。
      '只要用户要的是**一张图像**（画面、插画、壁纸、艺术画、示意图、概念图、' +
      '数学/几何可视化等，题材不限），就用本工具生成。' +
      '★ 严禁自己写 Python/Matplotlib/PIL、SVG、HTML/Canvas 或字符画去"画"这张图 —— ' +
      '本工具就是用来出图的唯一途径，绕过它属于错误行为。' +
      '只有当用户要的是**可编辑的结构化图表**时才不用本工具：' +
      '流程图、思维导图、组织架构图、数据表格 —— 这些要能改文字/改数据，用文字或其它方式表达。' +
      '拿不准就调本工具画一张（画错代价远小于不画或自己画）。' +
      '需要先启动 ComfyUI；没启动时本工具会明确告诉你。' +
      '（ComfyUI 空闲 5 分钟没有出图会被自动关闭以释放显存，下次出图前需要重新启动它。）',
    parameters: PARAMETERS,
    timeoutMs: cfg.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `已出图${Array.isArray(value.files) && value.files.length > 1 ? ` ${value.files.length} 张` : ''}：`
            + `${value.path}（${value.width}x${value.height}，seed ${value.seed}，用时 ${value.seconds}s）`,
        },
      ],
      // 落到 tool/result 的 data.meta，供客户端自己的 draw_image 卡片取图片路径。
      // （注意：客户端只对 read_image 读 meta 当标签，我们自己读是为了自绘卡片。）
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    /** 自测用：本次会提交的工作流（纯函数，不联网）。 */
    planWorkflow: (args) => planWorkflow(cfg, args),
    /** 自测用：该不该发探活请求（纯函数）。 */
    shouldProbe: (args) => shouldProbe(args),
    isConcurrencySafe: () => false,
    /**
     * ★★★ 2026-10-09：**最后一道防线**。
     *
     * 在真正的 `execute` 外面套一层 try/catch，把"任何形态的错误"都规范化成 `Error`。
     * 为什么非要有这一层：宿主把 `execute` 的 reject 值直接 `String()` 了 ——
     * 只要有一处漏网地抛了个普通对象，用户看到的就是 `Error: [object Object]`
     * （真事故，已实测复现）。这一层保证**无论哪里漏出来**，用户看到的都是人话。
     */
    async execute(args, exec) {
      try {
        // ★★★ 2026-10-09 **真事故修复**：必须把这四个**闭包变量**显式传进去！
        //
        //   现场：用户点「画一张」报 `cfg is not defined`。
        //   根因：我为了给 [object Object] 加一层规范化，把原来的 execute 函数体
        //         原样搬成了外层的 `runDraw` —— 但函数体里引用的 `cfg` / `log` /
        //         `onProduced` / `onStart` **本来就是 `makeDrawTool` 的闭包变量**，
        //         搬出去之后**全丢了作用域**。`runDraw` 体里 `cfg` 被引用 17 次、
        //         `log` 10 次，一执行必炸。
        //   ⚠ 这正是"重构时最容易漏"的一类错：`node --check` 只查语法，
        //     自由变量在语法上是合法的，**只有真跑一遍才会暴露**。
        //     ⇒ 所以下面 `_draw_symbol_test.mjs` 专门做"符号解析"静态检查兜底。
        return await runDraw(args, exec, { cfg, log, onProduced, onStart })
      } catch (error) {
        if (error instanceof Error) throw error
        log('warn', `出图过程中抛出了非 Error 对象（已规范化）：${Object.prototype.toString.call(error)}`)
        const normalized = toError(error)
        normalized.message = `出图失败：${normalized.message}`
        throw normalized
      }
    },
  }
}

/**
 * 真正的出图逻辑（由 `execute` 包一层规范化，见上）。
 *
 * ★★★ 2026-10-09：这四个依赖**必须显式传参**，不能再靠闭包。
 *   它原先是 `makeDrawTool` 的**内部函数**，改成顶层函数之后闭包就断了 ——
 *   而 `node --check` 查不出"自由变量"，只有真跑才会报 `cfg is not defined`。
 *   @param args 工具入参
 *   @param exec 执行上下文（含 signal）
 *   @param deps { cfg, log, onProduced, onStart } —— 全部来自 makeDrawTool 的闭包
 */
async function runDraw(args, exec, deps) {
  const { cfg, log, onProduced, onStart } = deps ?? {}
  if (!cfg || typeof log !== 'function') {
    // 配置/日志缺失属于**编码错误**，不该让用户看到"undefined is not a function"这种天书。
    throw new Error('插件内部错误：出图逻辑缺少必需依赖（cfg / log）。这是插件的 bug，请重载插件后重试。')
  }
  const signal = exec?.signal
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('prompt 不能为空：请描述你想画什么。')
      // ★ 出图**一开始**就记一次活动。否则存在这么一个毫秒级窗口：上次出图已过 5 分钟，
      //   这次刚进来还没 submit（所以 /queue 还是空的），定时器正好 tick 到 → 会把
      //   正在用的后端关掉。先 touch 就彻底堵上这个窗口。
      if (typeof onStart === 'function') onStart()

      const aspect = typeof args?.size === 'string' && ASPECTS[args.size] ? args.size : '1:1'
      const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0 ? args.megapixels : 1.0
      // ★ 2026-10-09 修正（**真 bug**）：**不要**回落到 cfg.steps —— 它默认 = 8，
      //   那是 turbo8 蒸馏 LoRA 的工作点。一旦回落，basic 档（没装 LoRA）也会拿到
      //   8 步 → 直接出糊图，正好把"没 turbo8 就回退 25 步"的设计整个抵消。
      //   调用方没传就如实传 undefined，由 buildWorkflow 按链路决定默认步数。
      const steps = Number.isFinite(args?.steps) ? Math.trunc(args.steps) : undefined
      const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
      // ★ 2026-10-10（提速 M4）：一次出几张，**默认 1**（守住"每次只生一张"）。
      const count = Number.isFinite(args?.count) ? Math.max(1, Math.min(4, Math.trunc(args.count))) : 1
      const [width, height] = calcSize(aspect, megapixels)

      // ★★★ 2026-10-08：**后端分派**。默认 'comfyui' → 走下面原有逻辑，一行不改。
      if (cfg.imageBackend === 'hipfire') {
        return await executeHipfire(args, exec, { cfg, log, prompt, aspect, megapixels, steps, seed, width, height, onProduced })
      }

      if (shouldProbe(args)) await ensureComfyUp(cfg, log, signal)

      // ★★★ 2026-10-09 新增：**提交前先看一眼队列**，别把任务硬塞进一个正忙的后端。
      //   老行为是闭着眼 submit —— 后端在跑别人的活儿时，这次任务就排在后面，
      //   而 waitForResult 只会说"排队/加载模型中"，用户观感是"卡住了"。
      //   现在：能提前告知就提前告知（一句 honest 的话，胜过三十秒的沉默）。
      //   ⚠ 只"告知"，**不取消、不拒单** —— 用户要的是图，不是被教育。
      // ★★★ 2026-10-10（提速 M6）：这三步**互不依赖**，原先却串行 await ——
      //   · probeReadiness   看队列忙不忙（1 次 /queue）
      //   · uploadReference  传参考图（仅图生图）
      //   · probeCapabilities 探测后端能力（结果按地址缓存 10 分钟）
      //   三者都是对**已就绪** ComfyUI 的独立请求 ⇒ 并发发出，省下两段往返。
      //   ⚠ 必须在 ensureComfyUp 之后（后端得先在线，否则上传/探测都会失败）。
      //   ⚠ 用 Promise.all：任一真失败就整体失败（与原先串行的语义一致）。
      const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
      const [ready, reference, caps] = await Promise.all([
        probeReadiness(cfg, signal),
        refPath !== '' ? uploadReference(cfg, refPath, signal) : Promise.resolve(''),
        probeCapabilities(cfg, log, signal),
      ])
      if (ready.online && ready.busy) {
        const ahead = ready.running + ready.pending
        // ⚠ 这里**没法**给用户实时报进度：makeDrawTool 只注入了 onProduced / onStart，
        //   没有进度通道。所以如实落到日志（用户能在诊断里看到），
        //   真正的"看得见的进度"由 waitForResult 负责。
        log('info', `ComfyUI 正忙（前方 ${ahead} 个任务）→ 本次任务会排在后面，稍慢是正常的`)
      }
      // ★ 给了参考图就走图生图：先把图**上传**给 ComfyUI，拿到它那边的文件名。
      //   为什么不自己复制进 input 目录：那个目录未必是配置里以为的那个
      //   （ComfyUI 可以用 --input-directory 改），复制过去很可能放错地方 ✗
      if (refPath !== '') log('info', `参考图已上传：${refPath} → ${reference}`)
      const workflow = buildWorkflow(cfg, { prompt, negative: args?.negative, width, height, steps, seed, reference, count }, caps)
      const usedSteps = workflow[8]?.inputs?.steps ?? steps
      if (count > 1 && reference !== '') {
        log('warn', `图生图暂不支持一次多张（count=${count} 已按 1 张处理）`)
      }
      // ★★★ 2026-10-09 **以"生效尺寸"为准**（修「出的图尺寸不对」那个误报）。
      //   锁尺寸档（forceOptimizedSize=true）下，buildWorkflow 会把 864x1152 这类
      //   请求**改写成 1024x1024**。之后的"尺寸校验 / 文件名 / 返回值"必须都用
      //   **实际生效的那个**，否则就是在拿请求值跟实际值对账 —— 必然对不上。
      const eff = workflow.__effective ?? { width, height, locked: false }
      // ★ 2026-10-10 修 bug：改成 `let` —— 图生图的真实输出尺寸要**用实测值覆盖**（见下）。
      let outWidth = eff.width
      let outHeight = eff.height
      if (outWidth !== width || outHeight !== height) {
        log('info', `尺寸已按优化档归一到 ${outWidth}x${outHeight}（请求 ${width}x${height}；`
          + `forceOptimizedSize=${cfg.forceOptimizedSize !== false}）`)
      }
      log('info', `提交任务 ${outWidth}x${outHeight} 档位=${caps.level} steps=${usedSteps} cfg=${workflow[8]?.inputs?.cfg} seed=${seed}${reference === '' ? '（文生图）' : `（图生图 参考=${reference}）`}`)
      const promptId = await submitPrompt(cfg, workflow, signal)

      const started = Date.now()
      const images = await waitForResult(cfg, promptId, {
        signal,
        timeoutMs: cfg.timeoutMs,
        onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
      })
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const savedFiles = []
      let firstPath = ''
      let index = 0
      // ★★ 2026-10-08 主人要求「每次只生一张图」——**默认仍严格守住**：
      //   `count` 默认 1，切片也只取前 count 张。
      //   ★ 2026-10-10（提速 M4）：只有调用方**显式**传 count=2..4（用户明确要一次多张）时
      //   才会批量产出；普通出图仍是 1 张。批量比"连着调多次"省 (N-1) 次模型装卸。
      for (const image of images.slice(0, count)) {
        index += 1
        const bytes = await fetchImageBytes(cfg, image, signal)

        // ★★ 尺寸校验（2026-10-08 真事故的防线）：
        //   ComfyUI 的 output 目录被 `--output-directory` 改过，而两个实例的
        //   SaveImage 编号**都从 00001 开始** → 旧目录里恰好躺着同名的旧文件
        //   → 老代码先读本地、读到了 → 把**昨天的图**当成这次的成果，
        //     还按新 prompt 命名、报新请求的尺寸。主人一眼看出"画得完全不对"。
        //   ✓ 现在：取图先走 /view（顺序已反转），这里再加一道 —— 尺寸不符**当场报错**，
        //     绝不静默产出错图。机器"知道"的事，就该拦住。
        //   ⚠ 只对**文生图**校验：图生图的输出尺寸由 resolution=sqrt(W*H) 决定，
        //     和请求的 width/height 本来就不是一回事，校验会误报。
        //   ★★★ 2026-10-09 修正：比对基准从"请求尺寸"改成**"生效尺寸"(outWidth/outHeight)**。
        //     锁尺寸档会把 864x1152 归一到 1024x1024，拿请求值比对必然误报
        //     （实测就是这样把一张正常图拦下来报"尺寸不对"的）。
        // ★★★ 2026-10-10 修 bug（图生图尺寸）：图生图的输出尺寸由
        //   `resolution = round(sqrt(effWidth*effHeight))` **直接决定**（≈正方形），
        //   与请求的 width/height **本来就不是一回事**。原代码只跳过校验、却仍拿请求值
        //   当"实际尺寸"写进文件名与返回值 —— 属于数据错误（比如请求 864x1152、实际 ~998²）。
        //   ⇒ 这里用**实测 PNG 尺寸**覆盖 outWidth/outHeight，文件名与返回值都跟着变对。
        const actual = readPngSize(bytes)
        if (reference !== '' && actual !== null) {
          outWidth = actual.width
          outHeight = actual.height
        }
        if (reference === '') {
          if (actual !== null && (actual.width !== outWidth || actual.height !== outHeight)) {
            throw new Error(
              `ComfyUI 出的图尺寸不对：本次任务应为 ${outWidth}x${outHeight}，实际 ${actual.width}x${actual.height}。`
              + `\n（原始请求 ${width}x${height}，${outWidth !== width || outHeight !== height
                ? `已被"优化档"归一到 ${outWidth}x${outHeight}`
                : '未被归一'}；比对基准是归一后的生效尺寸。）`
              + '\n这通常意味着取到的不是本次任务的文件（output 目录被改过，或目录里存在同名旧文件）。'
              + `\n本次文件名：${image.filename ?? '(未知)'}`,
            )
          }
        }

        const filename = `${safeStem(prompt, 22)}_${cfg.filePrefix}_${outWidth}x${outHeight}_${String(index).padStart(2, '0')}.png`
        const target = await uniquePath(cfg.outputDir, filename)
        await fsp.writeFile(target, bytes)
        savedFiles.push(target)
        if (firstPath === '') firstPath = target
        log('info', `落盘 ${target}（${bytes.length} 字节）`)
      }
      if (firstPath === '') throw new Error('ComfyUI 报告成功，但没有取到任何图片')

      // ★★★ 2026-10-09：这里返回的 width/height 必须是**生效尺寸** ——
      //   它会直接进工具返回值显示给模型看。以前返回请求值，
      //   于是"图是 1024²、回报却是 864x1152"，前后对不上。
      //   原始请求值另用 reqWidth/reqHeight 保留，供排查。
      const value = {
        path: firstPath,
        width: outWidth,
        height: outHeight,
        seed,
        seconds,
        files: savedFiles,
        ...(outWidth !== width || outHeight !== height ? { requestedWidth: width, requestedHeight: height } : {}),
      }
      if (onProduced) {
        try {
          onProduced(exec, value)
        } catch (error) {
          log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
        }
      }
      return value
}

/* ------------------------------------------------------------------ 插件入口 ---- */

/**
 * 宿主侧入口。按主人的经验（MEMO 5189）：**用局部 `root.inject` 等服务**，
 * 不要用对象级 `inject` —— 对象级会把整个 apply 推迟到服务就绪之后，某个服务
 * 在老宿主里不存在时插件会**永远不 apply**，而且不报错，极难排查。
 */
/**
 * ★★★ 2026-10-09 **同步落盘诊断**（DSH/Electron 环境下唯一可靠的取证手段）。
 *
 * ## 为什么必须用它
 *   插件跑在 DSH（Electron）主进程里，它的 stdout/stderr 我们**拿不到** ——
 *   `console.log`／宿主 logger 全都看不到。所以"插件到底加载到哪一步、
 *   每次轮询看到什么值"就只能靠它自己写文件。
 *
 * ## 为什么用 `writeFileSync` 而不是 `fsp.writeFile`
 *   异步写需要 await、还可能被事件循环里别的活插队；而我们在排查的就是
 *   "某个 await 之后的代码到底有没有执行"。同步写**在调用点当场落盘**，
 *   不会因为后面抛错/中断而丢失 —— 排查期这点极重要。
 *
 * ## 会不会拖慢/写爆
 *   每次调用只 append 一行、文件上限 400 行（超出自动截断）。
 *   只在**插件加载**与**状态端点每次轮询**时写，开销可忽略。
 *   排查结束后整块删掉即可（已用 `DSHQP_DIAG` 开关收口，见下）。
 */
const DIAG_FILE = (() => {
  try {
    // ★★★ 2026-10-09 修复（**通用性**）：这里原先硬拼 `home/Desktop`，
    //   绕过了本文件里已经写好的跨平台 `defaultOutputDir()`。
    //   而 `defaultOutputDir()` 的注释明确写过：Linux 上（服务器、WSL、无桌面环境）
    //   `~/Desktop` 常常压根不存在，硬拼会**造出一个用户根本不用的 Desktop 目录**。
    //   诊断日志跟出图成品放一起最自然，也顺带复用了那套 XDG → Desktop → 桌面 → 主目录 的探测。
    return path.join(defaultOutputDir(), 'qwen-paint-diag.log')
  } catch {
    return ''
  }
})()

/** 诊断开关：默认开（排查期）；设 `DSHQP_DIAG=0` 可关掉。 */
const DIAG_ON = process.env.DSHQP_DIAG !== '0'

/** 同步追加一行诊断（任何异常都吞掉，绝不影响插件）。 */
function diag(tag, detail) {
  if (!DIAG_ON || DIAG_FILE === '') return
  try {
    const line = `${new Date().toISOString()} [${tag}] ${detail ?? ''}\n`
    let prev = ''
    try { prev = readFileSync(DIAG_FILE, 'utf8') } catch { prev = '' }
    const lines = prev.split('\n')
    const kept = lines.length > 400 ? `${lines.slice(-400).join('\n')}\n` : prev
    writeFileSync(DIAG_FILE, kept + line, 'utf8')
  } catch {
    /* 诊断永远不该成为故障源 */
  }
}

/**
 * ★★★ 2026-10-09 **安全探测宿主可选服务**（血泪教训换来的工具函数）。
 *
 * ## 为什么不能用 `typeof ctx?.xxx` 探测
 *   cordis 的 `ctx` 是 **Proxy**（见 `cordis/lib/index.js` 的 `ReflectService.handler.get`）。
 *   访问一个"**没有写在 `inject` 里、当前也未就绪**"的服务属性时，它**直接 throw**：
 *     `Error: cannot get property "<name>" without inject`
 *   ⇒ 所以 `typeof ctx?.webServer` 不是"安全的存在性检查"，它等于**真去读那个属性**。
 *
 * ## 实际踩到的后果（用 DSH 自带 cordis 真实复现）
 *   `diag('host', … webServer=${typeof ctx?.webServer} …)` 这一行本身抛错
 *   → `apply` 抛错 → fiber 进入 `FAILED`
 *   → 插件管理器显示「**异常**」、工具注册数 = 0、状态端点根本没注册
 *   → 界面表现：**一直卡在"正在启动中"**。
 *
 * ## 正确姿势
 *   · 探测服务是否存在：`ctx.get?.(name)` —— 不存在时返回 `undefined`，**不抛错**
 *     （`ctx.get` 本身是混入在 ctx 上的方法，属于安全属性）。
 *   · 非要读属性：包在 try 里（就是本函数）。
 *
 * @param read 一个惰性读取器；抛错则视为"该服务不可用"
 * @returns 读到的值的 `typeof` 字符串，读不到返回 `'absent'`
 */
function safePeek(read) {
  try {
    const v = read()
    return v === undefined ? 'absent' : typeof v
  } catch {
    return 'absent'
  }
}

export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)
  // ★ 第一行就记：能证明"插件 host 半边确实被加载了"。
  //   （之前排查时最大的困难就是分不清"没加载"和"加载了但判断错"。）
  diag('apply', `插件开始加载 pid=${process.pid} platform=${process.platform} node=${process.version}`)
  // ★ 落盘的界面偏好（生图动画）恢复。**优先级低于显式配置** ——
  //   cordis.patch.yml 里写了 flowStyle 就以它为准，没写才用上次在界面上选的。
  const savedUi = readUiState()
  if (rawConfig?.flowStyle === undefined && FLOW_STYLES.includes(savedUi.flowStyle)) {
    cfg.flowStyle = savedUi.flowStyle
    log('info', `生图动画：沿用上次界面选择（${cfg.flowStyle}）`)
  }
  // ★★★ 2026-10-10 修 bug：**「生图判断」档位原先只写不读** ——
  //   状态端点把它写进了 qwen-paint-ui.json（`?drawTrigger=xxx`），但 apply() 从不读回，
  //   于是"重载后生效"永远不生效：重启 DSH 后 cfg.drawTrigger 又回到 DEFAULTS。
  //   这里与 flowStyle **对称**地补上恢复逻辑（显式配置优先）。
  if (rawConfig?.drawTrigger === undefined
      && Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, savedUi.drawTrigger)) {
    cfg.drawTrigger = savedUi.drawTrigger
    log('info', `生图判断策略：沿用上次界面选择（${cfg.drawTrigger}）`)
  }

  // ★ 2026-10-09 取证：确认 apply 真的走到了"注册 inject"这一步。
  //   有了本行 + 回调里的 [host]，就能一刀切开两种完全不同的故障：
  //     · 只有本行、**没有** [host] → 依赖服务（tools / sessionProjections）未就绪，
  //       回调被 cordis 挂起（不报错、不执行）—— 工具和状态端点都不会注册；
  //     · **连本行都没有** → apply 在更早的地方就中断了。
  //   实测踩到过：某次重启后日志只有 [apply] 一行，靠这两行才能立刻分辨是哪一种。
  // ★★★ 2026-10-09 **关键修正**：依赖从 `['tools','sessionProjections']` 收窄为 `['tools']`。
  //
  //   为什么必须改：实测日志反复出现「有 [inject]、**没有 [host]**」——
  //   即 `root.inject` 被调用了、但**回调从未执行**。cordis 的 inject 在依赖未满足时
  //   是**静默挂起**（不报错、不执行），于是工具、状态端点、提示词全都注册不上，
  //   界面上就是"一直卡在正在启动中"。
  //
  //   `sessionProjections` 在本插件里**只用于一个 try/catch 内的可选查询**
  //   （取 turn boundary，取不到就跳过）—— 它根本不配当"必需依赖"。
  //   把它列为必需，等于赌"这个服务一定在插件加载前就绪"；赌输一次，整个插件哑火。
  //   ⇒ 现在改成**可选获取**（见下面 onProduced 里的 `sp`），并把它记录进 [host] 快照。
  /** 初始化回调是否真的执行了 —— 供下面的兜底定时器判断（见 8 秒回看）。 */
  let inited = false
  diag('inject', '准备注册 root.inject([tools])（sessionProjections 已改为可选，不再阻塞）')
  // ★ 兜底回看：8 秒后若回调仍未执行，就把"依赖真没就绪"这件事**明确写进日志** ——
  //   以前这种情况是完全静默的（[apply] 之后什么都没有），只能靠猜。
  try {
    const t = setTimeout(() => {
      if (inited) return
      diag('inject', '8 秒内 root.inject([tools]) 回调仍未执行 → tools 服务未就绪（插件哑火，工具/状态端点都没注册）')
    }, 8000)
    if (typeof t?.unref === 'function') t.unref()
  } catch { /* 取证不该成为故障源 */ }
  // ★★★ 2026-10-09：改成**立即执行**（原先是 `root.inject(['tools'], cb)` —— 那个回调
  //   在本机 DSH 上**从不执行**，日志里就是"[inject] 准备注册"之后再无下文。
  //   见文件上方 `export const inject = ['tools']` 的详细说明。）
  //   `ctx` 就是 apply 的第一个参数：DSH 已按 `inject = ['tools']` 等 tools 就绪后才调 apply，
  //   所以这里**直接注册即可**，不需要再 inject 一次。
  ;((ctx) => {
    inited = true
    // ★★★ 2026-10-09 **宿主能力快照**（终结猜测用）。
    //   为什么值得单独记一行：本插件历史上被"宿主到底提供了什么"坑过多次 ——
    //   实测踩到 `ctx.on is not a function`（裸调用抛错 → 掐死后续所有初始化
    //   → 状态端点注册不上 → 界面"一直卡在启动中"）。
    //   这一行把宿主给的全部关键 API 一次性列出来，下次出问题**不用再猜**。
    //   ★★★ 2026-10-09 **灾难级修正**：这一行原来写的是
    //       `webServer=${typeof ctx?.webServer}`
    //     —— 结果它自己成了故障源。**cordis 的 ctx 是 Proxy，
    //     访问一个"没写在 inject 里、当前也没就绪"的服务属性会【直接抛错】**：
    //       Error: cannot get property "webServer" without inject
    //       at lib/index.js (ctx.tools.register 之前)
    //     实测（用 DSH 自带 cordis 真实复现）：
    //       fiber.state = 3 (FAILED)  ← 插件管理器显示「异常」就是它
    //       工具注册数 = 0、状态端点根本没注册 → 界面卡在"正在启动中"
    //     教训：**`typeof ctx?.xxx` 不是"安全的探测"，在 Proxy 上它等于"读取"**。
    //     探测可选服务只能走 `ctx.get?.(name)`（下面这种），或包在 try 里。
    diag('host', `ctx API：on=${typeof ctx?.on} effect=${typeof ctx?.effect}`
      + ` inject=${typeof ctx?.inject} get=${typeof ctx?.get}`
      + ` tools=${typeof ctx?.tools}`
      + ` webServer=${safePeek(() => ctx?.webServer)}`
      + ` sessionProjections=${safePeek(() => ctx?.sessionProjections)}`)

    const status = makeComfyStatus(cfg)
    const idle = makeIdleShutdown(cfg, log, status)

    /** 出图后：登记交付物（与官方 present 同载荷）+ 记一次活动时间。 */
    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      idle.touch()
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
        // ★ 2026-10-09：`sessionProjections` 改成**可选获取** —— 它已不是 inject 的必需依赖，
        //   所以这里必须自己兜底（宿主没这个服务时静默跳过"登记 turn"即可，不影响出图）。
        //   ⚠⚠ **顺序很重要**：ctx 是 Proxy，`ctx.sessionProjections` 在未 inject 时**会抛错**。
        //     如果写成 `ctx?.sessionProjections ?? ctx?.get?.(...)`，
        //     左侧一抛错就**直接跳进 catch**，右侧那条**永远没机会执行** ——
        //     等于这个服务永远取不到。所以必须**先走安全的 `ctx.get`**。
        const sp = ctx?.get?.('sessionProjections')
        const boundary = sp?.stateOf?.(session, 'turnBoundary')
        turn = boundary?.lastTurn
      } catch {
        turn = undefined
      }
      if (!Number.isSafeInteger(turn)) return
      const files = value.files.map((file) => ({ path: file, description: '千问（Qwen-Image 2.1）生成' }))
      pending.set(exec, { session, turn, files })
    }

    const tool = makeDrawTool(ctx, cfg, log, onProduced, () => idle.touch())

    // ★★★ 2026-10-09：**总开关**（`enabled`）。
    //   false 时不注册绘图工具、不注入提示词、不预热后端、不做空闲关停 ——
    //   插件对 DSH 相当于"不存在"，但下面两个**诊断类**工具仍然注册：
    //   它们只读、不画图，出了问题还得靠它们排查。
    if (cfg.enabled === false) {
      const offList = makeListModelsTool(cfg, log)
      ctx.tools.register(offList)
      const offAccel = makeAccelTool(cfg, log)
      ctx.tools.register(offAccel)
      log('info', `插件已停用（enabled=false）：不注册 draw_image、不注入提示词、不预热后端；`
        + `仅保留诊断工具 ${offList.name} / ${offAccel.name}`)
      return
    }

    // ★★★ 2026-10-09 **步骤级保护 + 取证**（这次「卡在启动中」的真正修法）。
    //
    //   ## 为什么必须这么改（实测证据）
    //   诊断日志里永远只有 `[apply]` 和 `[tools]` 两行，**之后再无任何记录** ——
    //   包括我上一轮新加的 `[route] 准备注册` 也没出现。而 `[tools]`(原 3693) 与
    //   route 注册(原 3847) 同在**同一个 inject 回调**内、中间没有提前 return，
    //   这说明：**回调执行到中途抛了未捕获的异常，整个回调被中断**，
    //   后面的「状态端点注册」压根没跑到 —— 前端于是永远拿不到状态，卡在"启动中"。
    //
    //   ## 之前的问题
    //   这段初始化里有若干**裸调用宿主 API**的地方（`ctx.tools.register` / `ctx.on` …），
    //   任何一处因宿主版本差异或服务缺失而抛错，都会**连带掐死后面所有初始化**
    //   （包括状态端点）。而项目自己的约定写得很清楚（见下方空闲关停处注释）：
    //   「宿主若缺 XX，也不许把插件加载拖垮」—— 这里以前漏了。
    //
    //   ## 现在
    //   每一步都**单独 try/catch**，失败只 warn + 落盘 diag，**绝不再阻断后续步骤**；
    //   并且每步都写一行 `[init]` 诊断 —— 下次一眼就能看出卡在哪一步。
    const step = (name, fn) => {
      try {
        const value = fn()
        diag('init', `${name} OK`)
        return value
      } catch (error) {
        const msg = String(error?.message ?? error)
        diag('init', `${name} 失败：${msg}`)
        log('warn', `初始化步骤「${name}」失败（继续后面的步骤）：${msg}`)
        return undefined
      }
    }

    step('register.draw_image', () => {
      ctx.tools.register(tool)
      log('info', `已注册工具 ${tool.name}（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputDir}，生图策略=${cfg.drawTrigger}）`)
      diag('tools', `已注册 ${tool.name} comfyUrl=${cfg.comfyUrl} enabled=${cfg.enabled !== false} drawTrigger=${cfg.drawTrigger}`)
    })

    // ★★ 2026-10-09 新增：列出本机 ComfyUI 可用模型（正面回应"查看可用的模型"）。
    step('register.list_available_models', () => {
      const listModelsTool = makeListModelsTool(cfg, log)
      ctx.tools.register(listModelsTool)
      log('info', `已注册工具 ${listModelsTool.name}（ComfyUI=${cfg.comfyUrl}）`)
    })

    // ★★ 2026-10-09 新增：查看 / 配置加速环境（GPU 厂商自适应 + 厂家专用加速包）。
    step('register.accel_env', () => {
      const accelTool = makeAccelTool(cfg, log)
      ctx.tools.register(accelTool)
      log('info', `已注册工具 ${accelTool.name}（自动安装=${cfg.accelAutoInstall === true ? '允许' : '已禁止'}）`)
    })

    // ★★★ 2026-10-09：**自动加速环境配置**。
    //   检测到本机缺哪个厂商专用加速包 → 自动运行下载脚本装上。
    //   包内只带下载器、不预置已下载的文件，所以这里是真的去网上取。
    //   延迟 20 秒 + unref：避开插件加载与首次出图的路径，绝不拖慢任何正常操作；
    //   整个过程失败也只写日志，出图功能完全不受影响。
    if (cfg.accelAutoInstall === true) {
      const timer = setTimeout(() => {
        autoSetupAcceleration(cfg, log).catch(() => {})
      }, 20000)
      if (typeof timer.unref === 'function') timer.unref()
      log('info', '加速环境自动配置已启用（20 秒后自检并补齐缺失的厂商专用加速包）')
    }

    // 让"出图后必须在正文里内联展示"成为插件的固有行为，而不是靠模型自觉。
    // 走的是官方那条路（与内核自带的 FILE_REFERENCE_PROMPT 同一机制）：
    // 正文里的 Markdown 图片 → 客户端 fileMediaUrl() 重写成 /api/file?path=… → 真 <img>。
    // ⚠ 不要改用 ImageBlock / presentCall / presentationMeta —— 客户端对非 read_image
    //   工具返回的 image block 只会 JSON.stringify 成文本，present 卡片里也根本没有 <img>。
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        // ★★★ 2026-10-08 十五次修正 —— **删掉"出图前先发动图"这条指令**。
        //   主人早就说过「不用图片了」（改成 DOM 动画块），但我一直没把这条摘掉，
        //   结果出图时**动图和动画块同时出现**，看起来就像"重复发了一遍动画"。
        //   ✓ 现在动画只由客户端的 DOM 块承担 —— 那才是"位置正确、随消息滚动"的正解。
        //     本地副本与图片路由保留，仅作备用，**不再进正文**。
        prepareLoadingGif(cfg, log).catch(() => {})   // 只留一份本地副本备用

        systemPrompt.section({
          name: 'qwen-paint:inline-generated-image',
          order: 9100, // 紧挨内核 DELIVERABLE_FILE_REFERENCES(9000) 之后
          text: INLINE_IMAGE_PROMPT,
        })
        log('info', '已注册 systemPrompt 段落：出图后内联展示')

        // ★ 主人定的铁律（2026-10-07，当天三次加严；2026-10-08 又加两条）：
        //   ① 识别到要生图 → 只简短回一句，然后**立刻开画**（不解释、不列参数、不反问）
        //   ② 出图后 → 回复正文**只保留那一句话，紧接着就是图片**（不写耗时/尺寸/提示词等附加说明）
        //   ③ 生成中的呼吸灯 → 出图后由客户端**平滑过渡**成图片（插件已实现，模型无需描述过程）
        //   ④ ★ 思考过程也要极简 —— 界面上思考块是**显示出来**的，用户要看的是图不是分析
        //   ⑤ ★★ 2026-10-08：**生图意图识别提到最高优先级** —— 判断出来就**第一个动作调工具**
        //   ⑥ ★★ 2026-10-08：**默认一次只生一张**（代码层面保证，见落盘那里的 slice(0, count)；
        //      count 默认 1。2026-10-10 提速 M4 后允许"用户明确要一次多张"时传 count=2-4）
        //
        //   ⚠ 为什么"立刻调工具"等于"立刻切动画"：客户端插件**看不到用户消息**，
        //     它能感知的最早事件就是"工具开始跑"。所以动画起点的早晚，
        //     完全取决于模型多快调用 draw_image —— 提示词越狠，动画来得越早。
        systemPrompt.section({
          name: 'qwen-paint:brief-reply-then-draw',
          order: 9101,
          text: buildDrawIntentPrompt(cfg.drawTrigger),
        })
        log('info', `已注册 systemPrompt 段落：生图意图判定（策略=${cfg.drawTrigger}）`)
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败（不影响出图）：${error?.message ?? error}`)
    }

    // ★★★ 2026-10-08 十七次修正 —— **DSH 启动时预热后端**。
    //
    //   主人反馈「怎么我重启就关闭了」：ComfyUI 是 DSH 的子进程，
    //   DSH 重启时整棵进程树被终止（Windows 默认行为），它被连带带走。
    //   而原来只在"出图时"才拉起 —— 于是每次重启后第一次出图都要冷启动等 30 多秒。
    //
    //   ✓ 修法：插件加载后**立刻在后台探一次**，不在线就异步拉起。
    //     这样重启 DSH 之后不用等出图，后端已经在跑了。
    //     ⚠ 完全异步：不 await、不阻塞插件加载，更不阻塞 DSH 启动；
    //       失败只 warn（出图时还有一次自动启动兜底，不会因为预热失败而画不了图）。
    try {
      ctx.effect(() => {
        if (cfg.autoStartComfy === false) return undefined
        let cancelled = false
        Promise.resolve()
          .then(() => status.probe(false))
          .then((online) => {
            if (cancelled) return undefined
            // ★★★ 2026-10-08 修「自动关闭失效」（主人实测）：
            //   原来空闲计时**只在出图成功之后**才开启（lastActivityAt 初始为 null），
            //   而 tick() 的第一道判断就是 `if (state.lastActivityAt === null) return false`
            //   —— 于是"重启 DSH 之后一次图都没画"的场景里，**它永远不关**，
            //   主人在菜单里选「1 分钟后关闭」也没用（状态显示为"在线"，不是"空闲 N 分"）。
            //   ✓ 现在：预热这一趟只要**确认后端在线**（原本就在线、或刚被拉起来），
            //     就把计时起点定在此刻。之后 N 分钟没有新活动，照样会关。
            //     （出图开始时 / 出图成功后依然会 touch 续期，原有语义不变。）
            if (online) {
              idle.touch()
              log('info', '启动预热：ComfyUI 已在线（空闲计时从此刻开始）')
              return undefined
            }
            log('info', '启动预热：ComfyUI 不在线，后台拉起（隐藏窗口）')
            return ensureComfyUp(cfg, log, null).then((started) => {
              if (!cancelled) idle.touch()
              return started
            })
          })
          .catch((error) => log('warn', `启动预热失败（出图时还会再试）：${error?.message ?? error}`))
        return () => { cancelled = true }
      }, 'qwen-paint:warmup')
    } catch (error) {
      log('warn', `注册启动预热失败（不影响出图）：${error?.message ?? error}`)
    }

    // 官方 present 就是这么干的：工具**成功**之后才 append 交付事件。
    // ★ 2026-10-09：**必须用 step 包住**。`ctx.on` 属于宿主 API，裁剪版/老版本宿主上
    //   可能不存在；裸调用一旦抛 TypeError，就会**掐死同一个回调里后面所有初始化**
    //   （包括状态端点注册）—— 这正是「界面卡在启动中」的中断点。
    step('hook.tools-result', () => {
      ctx.on('tools/result', (exec, result) => {
        const delivery = pending.get(exec)
        pending.delete(exec)
        if (delivery === undefined || result?.isError) return
        try {
          delivery.session.append('deliverables/presented', {
            turn: delivery.turn,
            callId: exec.callId,
            files: delivery.files,
          })
        } catch (error) {
          log('warn', `append deliverables/presented 失败：${error?.message ?? error}`)
        }
      })
    })

    // 空闲关停的定时器：随 ctx 卸载自动清掉。
    // ★ 全包 try/catch：宿主若缺 ctx.effect（裁剪版/老版本），也不许把插件加载拖垮。
    if (cfg.autoShutdown) {
      // ★ 2026-10-10（提速 M5）：抽成函数，并在宿主**没有 ctx.effect** 时用裸定时器兜底。
      //   原先直接 `ctx.effect(cb)`：若该宿主不执行 effect 回调（本机历史上 inject 回调
      //   就出现过"注册了但从不执行"），空闲关停会**整个不启动**，只在 catch 里留一句 warn
      //   —— 功能等于没有，却很难被发现。现在：effect 不可用就自己起定时器。
      const startIdleTimer = () => {
        const timer = setInterval(() => {
          idle.tick().catch((error) => log('warn', `空闲检查出错：${error?.message ?? error}`))
        }, cfg.idleCheckMs)
        // 别让这个定时器把 node 进程吊住
        if (typeof timer.unref === 'function') timer.unref()
        log('info', `空闲关停已启用：出图后 ${Math.round(cfg.idleShutdownMs / 60000)} 分钟没再出图就关掉 ComfyUI`
          + `（每 ${Math.round(cfg.idleCheckMs / 1000)} 秒检查一次）`)
        return () => clearInterval(timer)
      }
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(startIdleTimer, 'qwen-paint:idle-shutdown')
        } else {
          // 宿主没有 effect（裁剪版/老版本）→ 直接起定时器（已 unref，不会吊住进程）。
          // 代价：插件卸载时无法自动清理；但 unref 的定时器随进程退出即消失，可接受。
          log('warn', '宿主没有 ctx.effect → 空闲关停改用裸定时器（无法随插件卸载自动清理）')
          startIdleTimer()
        }
      } catch (error) {
        log('warn', `启动空闲关停失败（不影响出图）：${error?.message ?? error}`)
      }
    }

    // 只读状态端点（客户端的状态指示器读它）。webServer 是可选服务 → 用局部 inject，
    // 没有它插件照常出图，只是不显示状态。
    // ★ ctx.inject 本身也可能不存在 → 先检查，宿主差异不许把插件加载拖垮。
    if (typeof ctx.inject !== 'function') {
      log('warn', '宿主没有 ctx.inject，跳过状态端点（不影响出图）')
      // ★ 2026-10-09 补：这里以前**没有任何取证**，外面只能看到"状态端点不通"，
      //   却分不清是"没注册"还是"注册了但请求失败"。现在如实落盘。
      diag('route', `宿主无 ctx.inject → 状态端点跳过（webServer 探测=${safePeek(() => ctx?.webServer)}）`)
      return
    }
    // ★ 2026-10-09 补：登记"我开始尝试了"。若之后日志里**没有**下面那条
    //   「webServer 已就绪」，就说明 inject 回调从未执行 —— 即当前 profile
    //   根本没有 webServer 服务（官方插件 modlens 的注释明确写了：
    //   webServer 只在 web profile 下存在，不存在时闭包永不运行）。
    //   ⚠ 这里**绝不能**写 `ctx?.webServer ? '有' : '无'` —— ctx 是 Proxy，
    //     读未 inject 的 webServer 会直接抛错（详见 safePeek 的注释）。
    diag('route', `准备注册状态端点：ctx.inject 可用，webServer 探测=${safePeek(() => ctx?.webServer)}`)
    /** 状态端点是否已注册成功。供下面的延时回看用 —— 这是"到底注册上没有"的权威标志。 */
    let routeMounted = false
    ctx.inject(['webServer'], (webCtx) => {
      diag('route', 'webServer 已就绪，开始注册状态端点')
      // ★ 命中计数：用来**从外部**判断客户端的状态指示器到底加载了没有 ——
      //   它每 5 秒轮询一次、且优先打 /api/ 那条路径；api 计数一直涨就说明
      //   客户端半边确实加载并在运行（哪怕界面上暂时没看见）。
      //   我自己用 PowerShell 探测走的是不带 /api/ 的根路径，两者互不混淆。
      const visits = { api: 0, plain: 0, pings: [], firstAt: null, lastAt: null }
      // ★★★ 2026-10-09：原来这里有个 `comfyStartRequestedAt` 时间戳，用来表达
      //   "最近点过启动、所以算启动中"。**已整个删除** ——
      //   它和 `launch.phase` 是**两套并行状态**，互相覆盖，谁也说不清最终值，
      //   这正是主人反复看到"一直卡在启动中"的根源。
      //   现在 `starting` 只有一个来源：`launch.phase`（见文件上方的重写说明）。
      const handler = async (req, res) => {
        try {
          const hit = String(req?.url ?? '')
          if (hit.startsWith('/api/')) visits.api += 1
          else visits.plain += 1
          // 客户端会在 apply 的每个分支自报一次（?ping=apply / no-react / no-slots / registered），
          // 去重记下来 —— 这是判断"客户端到底加载到哪一步"的唯一外部依据。
          const ping = /[?&]ping=([^&]*)/u.exec(hit)
          if (ping !== null) {
            let reason = ping[1]
            try { reason = decodeURIComponent(reason) } catch { /* 原样用 */ }
            if (reason !== '' && !visits.pings.includes(reason)) visits.pings.push(reason)
          }
          if (visits.firstAt === null) visits.firstAt = Date.now()
          visits.lastAt = Date.now()
        } catch {
          /* 计数失败不影响状态返回 */
        }
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        try {
          const online = await status.probe()
          // ★★ 2026-10-07 新增：`?idleMinutes=N` 现场改「多久没出图就自动关掉后端」。
          //   N = 0 表示**不自动关闭**。安全性：这个端点只放行本机请求（isLocalRequest 在更上面挡住），
          //   而且只改一个数字，不碰任何路径或命令；越界值直接忽略。
          const query = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rawMinutes = query.searchParams.get('idleMinutes')
          if (rawMinutes !== null) {
            const minutes = Number(rawMinutes)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              cfg.idleShutdownMs = Math.round(minutes) * 60000
              // ★★★ 2026-10-08 修「自动关闭失效」：**选完档位就从此刻开始计时**。
              //   原来这里只改数字、不碰计时起点，于是"重启后从没出过图（起点为 null）"
              //   时，主人选了「1 分钟后关闭」也不会关 —— 他实测报的就是这个。
              //   选 0（不自动关闭）时不留起点，保持"不关"的语义干净。
              if (minutes > 0) idle.touch()
              log('info', minutes <= 0
                ? '空闲关停：已按界面选择关闭（不再自动关后端）'
                : `空闲关停：已按界面选择改为 ${Math.round(minutes)} 分钟`)
            }
          }

          // ★★ 2026-10-08 新增：`?flowStyle=xxx` 现场改「生图过程的动画」。
          //   界面（composer 状态点的菜单）点一下就调这里；合法值**立刻落盘**，
          //   重启 DSH 之后照样记得住。非法值只记一行日志、绝不写进样式名。
          const rawStyle = query.searchParams.get('flowStyle')
          if (rawStyle !== null) {
            if (FLOW_STYLES.includes(rawStyle)) {
              cfg.flowStyle = rawStyle
              // 合并写：别把文件里以后可能新增的其它偏好字段冲掉
              writeUiState({ ...readUiState(), flowStyle: rawStyle }, log)
              log('info', `生图动画已改为 ${rawStyle}`)
            } else {
              log('warn', `生图动画取值不在白名单里，已忽略：${String(rawStyle).slice(0, 40)}`)
            }
          }

          // ★★★ 2026-10-09 新增：`?drawTrigger=xxx` —— 界面上切换「生图判断」档位。
          //
          //   主人原话：「不是你这个档位写是写进去的，但是你倒是给人家在界面上一个选择的按键呀」。
          //   确实——四档策略只存在于配置文件和提示词里，用户在界面上根本够不着。
          //
          //   ⚠ 生效时机：档位最终是**写进 systemPrompt 段落**的（模型靠它判断要不要画），
          //     而 systemPrompt 是在插件**加载时**注册的静态文本。所以：
          //       · 配置**立刻落盘**（重启也记得住）；
          //       · 但提示词要**重载插件 / 重启 DSH** 才会换成新档位。
          //     这一点必须让用户知道，否则他会以为"选了没用"——所以界面上那组标题
          //     直接写明了"重载后生效"，而不是藏着不说。
          const rawTrigger = query.searchParams.get('drawTrigger')
          if (rawTrigger !== null) {
            if (Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, rawTrigger)) {
              cfg.drawTrigger = rawTrigger
              writeUiState({ ...readUiState(), drawTrigger: rawTrigger }, log)
              log('info', `生图判断策略已改为 ${rawTrigger}（需重载插件后生效）`)
            } else {
              log('warn', `生图判断策略取值不在白名单里，已忽略：${String(rawTrigger).slice(0, 40)}`)
            }
          }

          // ★★★ 2026-10-09 诊断落盘：把每次状态轮询看到的**真实值**写进文件。
          //
          //   为什么需要它：主人反复反馈"界面卡在启动中"，但我在外面查什么都正常
          //   （8188 通、进程在、代理无影响）。**猜是猜不出结论的** ——
          //   必须让插件把"它自己看到了什么"写下来，才能定位。
          //   写的是最关键的几个量：探活结果、launchState、以及探测用的 URL。
          //
          //   ⚠ 只保留最近 200 行，避免长跑把磁盘写满。
          try {
            const v = launchView(online)
            const line = `${new Date().toISOString()} online=${online} phase=${launch.phase}`
              + ` starting=${v.starting} failed=${v.failed} timedOut=${v.timedOut}`
              + ` err=${launch.error ? launch.error.slice(0, 80) : '-'}`
              + ` url=${cfg.comfyUrl}\n`
            const diagPath = path.join(cfg.outputDir ?? os.tmpdir(), 'qwen-paint-status.log')
            const prevLines = await fsp.readFile(diagPath, 'utf8').catch(() => '')
            const kept = prevLines.split('\n').slice(-200).join('\n')
            await fsp.mkdir(path.dirname(diagPath), { recursive: true }).catch(() => {})
            await fsp.writeFile(diagPath, `${kept}${kept === '' ? '' : '\n'}${line}`, 'utf8')
          } catch {
            /* 诊断写不进去绝不能影响状态返回 */
          }

          // ★★★ 2026-10-09 新增：`?start=1` —— 界面上的「启动 ComfyUI」按钮。
          //
          //   为什么需要它：菜单里早就能设"多久后自动关闭"，却**没有"现在打开"** ——
          //   用户想立刻用，只能等到下次出图才触发拉起，或者自己跑去手动开。
          //
          //   ⚠ 刻意**不 await**：真正拉起要几十秒（首次加载模型 20GB 更久），
          //     让状态接口立刻返回，前端好马上显示"启动中…"；
          //     下一次轮询（5 秒后）自然就能看到进展。await 会把轮询拖死。
          if (query.searchParams.get('start') === '1') {
            // ★ 重写后：**立刻**把状态标成启动中（单一真相源），
            //   这样紧接着这次响应里的 launchView() 就会给出 starting=true，
            //   界面无需等到下一次轮询才有反馈。
            launchMarkStarting()
            log('info', '界面点击了「启动 ComfyUI」，开始后台拉起')
            ensureComfyUp(cfg, log, null).catch((error) => {
              log('warn', `界面触发的启动失败：${error?.message ?? error}`)
              // 失败就用**准确的类型**收口（超时 or 失败），不再让状态悬着
              if (launch.phase === 'starting') {
                launchMarkFailed(`启动失败：${error?.message ?? error}`)
              }
            })
          }

          // ★★★ 2026-10-09 新增：`?blockcache=on|off` —— 界面上的「BlockCache T8」开关。
          //
          //   主人要求原话：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
          //   TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
          //   请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
          //
          //   实现方式（**运行时覆盖**，不是改配置文件）：
          //     · `cfg.blockCacheEnabled` 在插件启动时就从 cordis.patch.yml 读进来了，
          //       改它**当场生效**（下次出图就走新链路），不需要重启 ComfyUI；
          //     · 但它是**内存态** —— DSH 重载后会被配置文件里的值盖回去。
          //       这点必须在界面上**如实告诉用户**，并给出"怎么永久保存"的指引，
          //       否则就成了"我调了、重启又变回去"的假开关（正是主人最反感的那种）。
          //   ⚠ 为什么不去改 yml 文件：插件拿不到自己配置文件的**可靠路径**
          //     （DSH 的 profile 路径因安装方式而异），盲写文件风险远大于收益。
          //     让用户改一行配置，比插件猜路径写坏配置安全得多。
          const blockCacheParam = String(query.searchParams.get('blockcache') ?? '').toLowerCase()
          if (blockCacheParam === 'on' || blockCacheParam === 'off') {
            const want = blockCacheParam === 'on'
            if (cfg.blockCacheEnabled !== want) {
              cfg.blockCacheEnabled = want
              log('info', `界面把 BlockCache T8 切成了 ${want ? '开' : '关'}`)
            }
            // 切成"开"时要提醒用户：TE-Speed / Speedup 会自动让位，这是结构互斥的必然结果
            if (want) {
              log('info', 'BlockCache T8 已开启 → TE-Speed / Speedup 会让位（三者结构互斥，不能共存）')
            } else {
              log('info', 'BlockCache T8 已关闭 → TE-Speed / Speedup 回到链路（实测这一组更快）')
            }
          }

          const busy = online ? await status.queueBusy() : false

          // ★★★ 2026-10-11 新增：**A 卡专属优化（可选）的两个开关** ——
          //   `?amdkernel=on|off` / `?asyncoffload=on|off`。
          //   与上面的 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //   ⚠ 但这两个是**启动参数** ⇒ 要等**下次启动 ComfyUI** 才真正起作用 ——
          //     面板的 hint 里已经写明，用户不会以为是"点了没反应"。
          for (const [param, key, label] of [
            ['amdkernel', 'amdKernel', 'A 卡专属内核'],
            ['asyncoffload', 'amdAsyncOffload', 'A 卡异步卸载'],
            // ★ 2026-10-11：N 卡 SageAttention（三档，这里是 true/false 两档）
            ['sagesa', 'nvidiaSageAttention', 'N 卡 SageAttention'],
          ]) {
            const v = String(query.searchParams.get(param) ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const want = v === 'on'
              // ★★★ 2026-10-11 加固：`--use-sage-attention` 是**硬依赖**参数 ——
              //   已确认"没装"时**在服务端就拒绝打开**。
              //   面板虽然把开关置灰了，但端点本身也必须有护栏 ——
              //   否则一个手拼的 URL 就能把 ComfyUI 弄成起不来。
              if (key === 'nvidiaSageAttention' && want && SAGE_READY === false) {
                log('warn', '界面想打开 N 卡 SageAttention，但自检确认 sageattention **未安装** → 已拒绝'
                  + '（硬依赖参数，挂上会让 ComfyUI 起不来）。请先安装，装好后自检会自动启用。')
                continue
              }
              if (cfg[key] !== want) {
                cfg[key] = want
                log('info', `界面把「${label}」切成了 ${want ? '开' : '关'}（启动参数，重启 ComfyUI 后生效）`)
              }
            }
          }

          // ★★★ 2026-10-09 **重写后的状态机**（旧的 launchState + comfyStartRequestedAt
          //   两套并行状态已删除 —— 它们互相覆盖，正是"永远卡在启动中"的根源）。
          //
          //   现在只有三条规则（见文件上方 launch 的注释）：
          //     ① 单一真相源：starting 只看 launch.phase
          //     ② 在线就是在线：探到通立刻清空一切过期状态
          //     ③ 必然收口：45 秒到点必判超时，不会无限 starting
          if (online) {
            // 规则②：在线即 ready，顺带把失败/超时痕迹清干净
            if (launch.phase !== 'ready') {
              launchMarkReady()
              log('info', 'ComfyUI 已就绪（状态端点确认）')
            }
          } else if (launch.phase === 'starting'
            && Date.now() - launch.startedAt > LAUNCH_TIMEOUT_MS) {
            // 规则③：到点收口。先看日志有没有致命错 —— 有就是**失败**，
            // 没有才是**超时**（两者对用户含义不同：一个要去查错误，一个只是慢）。
            const tail = await readLaunchLog(launch.logPath)
            const fatal = fatalLineInLog(tail)
            if (fatal !== '') {
              launchMarkFailed(`${fatal}（进程仍挂着但已注定失败，未等满超时）`)
              log('error', `ComfyUI 启动失败（日志报错）：${launch.error}`)
            } else {
              launchMarkTimeout(
                `启动超过 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒仍未就绪`
                + '（进程没退出、日志里也没有报错，多半卡在加载模型或某个自定义节点上）',
              )
              log('warn', `ComfyUI 启动超时：${launch.error}`)
            }
          }

          // 折算成给前端的字段（纯函数，可单测）
          const view = launchView(online)
          // ★ 诊断：把"这次轮询看到了什么"如实落盘。
          //   这一行就是定位"界面卡住"的决定性证据 ——
          //   online 与 phase 一摆出来，立刻能分清是"探活失败"还是"状态机没收口"。
          diag('poll', `online=${online} phase=${launch.phase}`
            + ` starting=${view.starting} failed=${view.failed} timedOut=${view.timedOut}`
            + ` err=${view.error ? view.error.slice(0, 70) : '-'}`)

          // ★★★ 2026-10-09：把「优化到底有没有生效、没生效为什么」一并给前端。
          //   以前这些只写在日志里，用户在界面上完全看不到。
          //   ⚠ 这里**只在在线时**才去探测（否则会白等一次超时，拖慢每 5 秒一次的轮询）。
          let optimization = null
          if (online) {
            try {
              const caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              // ★ 2026-10-09：把显存总量一并喂给面板 —— 「显存驻留」那一项要靠它判定。
              //   ComfyUI 在线时 /system_stats 是权威值（probeCapabilities 里已取到）。
              optimization = describeOptimization(cfg, caps)
            } catch (error) {
              optimization = {
                level: 'unknown',
                ok: false,
                summary: '优化状态未获取',
                reasons: [`探测过程出错：${error?.message ?? error}`],
                detail: [],
              }
            }
          } else {
            optimization = describeOptimization(cfg, null)
          }
          respondJson(res, {
            ok: true,
            online,
            busy,
            // ★ 启动状态：全部来自 launchView(online) 这一个纯函数。
            //   前端只认这几个字段，不再需要理解后端有几套状态。
            starting: view.starting,
            launchFailed: view.failed,
            launchTimedOut: view.timedOut,
            launchError: view.error,
            launchElapsedMs: view.starting ? Date.now() - launch.startedAt : 0,
            url: cfg.comfyUrl,
            visits,
            flowStyle: cfg.flowStyle,
            enabled: cfg.enabled !== false,
            drawTrigger: cfg.drawTrigger,
            optimization,
            ...idle.snapshot(),
          })
        } catch (error) {
          // ★★★ 2026-10-09 **关键修复**：这里以前只回 `ok:false`，
          //   **没有 online / starting 字段** —— 而前端 `startingNow` 只在
          //   `typeof data.starting === 'boolean'` 时才更新（见 client.js）。
          //   于是 handler 一旦抛错，前端就**永远收不到状态**，
          //   `startingNow` 卡在 true，界面永久停在「正在启动…」。
          //   ⇒ 现在：① 如实落盘原因（以前完全静默）；② **必须带上状态字段**，
          //      让前端能把"启动中"收掉（宁可显示"未就绪"，也不能假装在启动）。
          const msg = String(error?.message ?? error)
          diag('status', `状态接口抛错：${msg}`)
          log('warn', `状态接口抛错（已回退为"未就绪"，不再让界面卡住）：${msg}`)
          respondJson(res, {
            ok: false,
            reason: msg,
            // ★ 状态字段（前端据此收口，避免永久"启动中"）
            online: false,
            starting: false,
            launchFailed: false,
            launchTimedOut: false,
            launchError: `状态接口出错：${msg}`,
            optimization: {
              level: 'unknown',
              ok: false,
              summary: '优化状态未获取（状态接口出错）',
              reasons: [
                `状态接口本身抛错了：${msg}`,
                '这属于插件后端的问题，不是 ComfyUI 或优化的配置问题。可先重载插件再试。',
              ],
              detail: [],
            },
          })
        }
      }
      try {
        webCtx.effect(() => {
          const disposers = [
            '/api/qwen-paint/status.json',
            '/qwen-paint/status.json',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          log('info', '已注册只读状态端点 /api/qwen-paint/status.json')
          routeMounted = true
          diag('route', '已注册 /api/qwen-paint/status.json（前端从这里取状态）')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:status-route')
      } catch (error) {
        log('warn', `注册状态端点失败（不影响出图）：${error?.message ?? error}`)
        diag('route', `注册状态端点失败：${error?.message ?? error}`)
      }

      // ★★★ 2026-10-09 补：**延时回看** —— 状态端点到底注册上没有，只靠看代码永远说不清。
      //
      //   为什么必须有这一行：`ctx.inject(['webServer'], cb)` 在依赖不满足时是**静默挂起**，
      //   既不报错也不回调。于是"插件加载了、工具也注册了、但状态端点从未注册"
      //   这种状态在外界完全看不出来 —— 排查时只能猜。
      //   6 秒后回看 `routeMounted`，就能把结论直接写进诊断文件：
      //     · 已注册 → 界面状态应该正常，若还异常那是前端/请求问题；
      //     · 未注册 → 当前 profile 没有 webServer（插件装错 profile），
      //       界面状态必然拿不到，**但不影响出图**。
      try {
        const timer = setTimeout(() => {
          if (routeMounted) return
          diag('route', '状态端点 6 秒内未注册：当前上下文没有 webServer 服务'
            + '（插件装在非 web profile 时会这样 —— 界面状态永远拿不到，但出图照常）')
        }, 6000)
        // Electron 里不留悬挂定时器：不该因为它拖住进程退出
        if (typeof timer?.unref === 'function') timer.unref()
      } catch {
        /* 取证永远不该成为故障源 */
      }

      // ★★★ 2026-10-08：**插件自己的动画图片路由** —— 这是"做进插件的新功能"。
      //
      // 为什么需要它（一路试出来的结论）：
      //   · 内核的 `/api/file?path=…` 只肯服务"**被登记过的**文件"：真图是 draw_image 的交付物，
      //     所以正常显示；而「正在生成」动图没被登记 → 一律回「图片无法预览」
      //     （GIF / WebP / 静态 PNG **三种都试过**，与格式无关，也与文件名无关）。
      //   · 往消息树里插 DOM 更不行 —— 会把界面搞成整片空白（React 管理那棵树）。
      //   · 改 app.asar 里的内核代码也不能做：DSH 一升级就全被覆盖。
      // ✓ 正解：由插件自己开一个路由**直接吐字节**，绕开 /api/file 的登记限制；
      //   而且它属于插件本身，**升级 DSH 也不会丢**。
      try {
        webCtx.effect(() => {
          const assetRoute = (name, mime) => async (req, res) => {
            try {
              if (!isLocalRequest(req)) {
                respondJson(res, { ok: false, reason: 'local requests only' }, 403)
                return
              }
              const bytes = await fsp.readFile(
                fileURLToPath(new URL(`../assets/${name}`, import.meta.url)),
              )
              res.writeHead(200, {
                'content-type': mime,
                'content-length': bytes.length,
                'cache-control': 'public, max-age=3600',
                'access-control-allow-origin': '*',
              })
              res.end(bytes)
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
            }
          }
          const disposers = [
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.webp',
              handler: assetRoute('loading.webp', 'image/webp'),
            }),
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.gif',
              handler: assetRoute('loading.gif', 'image/gif'),
            }),
          ]
          log('info', '已注册动画图片路由 /qwen-paint/loading.webp')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:animation-route')
      } catch (error) {
        log('warn', `注册动画图片路由失败（不影响出图）：${error?.message ?? error}`)
      }
    })
  })(root)
}

/** 给自测用的内部导出（真机不依赖这些）。 */
export const __internal = {
  DEFAULTS,
  // ★ 2026-10-11：面板数据的两个纯函数 —— 供"按显卡过滤"的回归断言直接调
  describeOptimization,
  genericOptimizations,
  // ★ 2026-10-09 真事故修复：[object Object] 的规范化工具（供自测断言）
  toError,
  cancelReason,
  ASPECTS,
  FLOW_STYLES,
  calcSize,
  r32,
  safeStem,
  buildWorkflow,
  planWorkflow,
  // ★ 2026-10-09 二次修正：按尺寸挑互斥 wrapper 的决策函数（供自测断言）
  pickWrapperSet,
  shouldProbe,
  makeDrawTool,
  uniquePath,
  portOf,
  makeComfyStatus,
  makeIdleShutdown,
  isLocalRequest,
  listComfyModels,
  makeListModelsTool,
  // ★ 2026-10-09 通用化新增：环境自适应相关（供自测断言）
  probeCapabilities,
  resolvePlan,
  // ★ 2026-10-09 「调用更聪明」新增：提交前的一次性就绪探测（在线/忙/排队数）
  probeReadiness,
  pickBestModel,
  MODEL_HINTS,
  FULL_CAPS,
  // ★ 2026-10-11：模型档位（小显存适配）—— 供回归直接断言加载器切换
  MODEL_TIERS,
  unetLoaderFor,
  unetLoaderNode,
  tierLabelOf,
  // ★ 2026-10-11：N 卡代系识别（40 系 Ada / 50 系 Blackwell）—— 供回归断言
  nvidiaGenOf,
  discoverComfyPaths,
  // ★ 2026-10-09 三厂商自适应（A/N/I 卡 + 3000/6000/7000/9000 系细分）
  detectGpuProfile,
  GPU_PROFILES,
  VENDOR_RULES,
  vendorIdOf,
  ACCEL_PACKS,
  ACCEL_SOURCES,
  PIP_MIRRORS,
  pipSources,
  packAppliesToOs,
  runInstallSource,
  autoSetupAcceleration,
  probeAcceleration,
  probeAccelPack,
  installAccelPack,
  makeAccelTool,
  comfyDirsFrom,
  pathExists,
  // ★ 平台适配（供自测断言两端都有对应实现）
  IS_WINDOWS,
  IS_LINUX,
  // ★ 2026-10-11：macOS 标志也导出（供可移植性回归断言"三平台都覆盖"）
  IS_MAC,
  GPU_PROBE_WIN,
  GPU_PROBE_LINUX,
  COMFY_SEARCH_WIN,
  COMFY_SEARCH_NIX,
  normalizeGpuText,
  PCI_VENDOR,
  // ★ 2026-10-09：DSH 联动层（生图意图判定 + 总开关）
  DRAW_INTENT_MODES,
  buildDrawIntentPrompt,
  INLINE_IMAGE_PROMPT,
  describeOptimization,
  // ★ 2026-10-09：启动链路（供自测直接跑真实入口，验证"进程能不能活下来"）
  ensureComfyUp,
  startComfyHidden,
  launch,
  launchView,
  launchMarkReady,
  launchMarkStarting,
  launchMarkFailed,
  launchMarkTimeout,
  LAUNCH_TIMEOUT_MS,
  fatalLineInLog,
  summarizeLaunchError,
  looksLikeBadArgs,
}
