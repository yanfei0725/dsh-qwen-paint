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

import { promises as fsp, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
// ★★ 2026-10-08：hipfire 出图后端（通用桥接）。
//   只在 cfg.imageBackend === 'hipfire' 时被调用；默认后端仍是 comfyui，
//   现有 ComfyUI 出图路径**一行不改**。
import { generateWithHipfire, HIPFIRE_DEFAULTS, HIPFIRE_SIZE_MULTIPLE } from './hipfire-img.js'
// ★★★ 2026-10-15：网络边界守卫（DSH STORE 合规整改 —— Issue #1390）。
//   README 原先声明"网络仅限本机回环"，但 comfyUrl 是普通配置项、代码里没有任何
//   强制校验，属于"声明与实现不符"。本模块把回环约束做成**代码层强制**，
//   并在所有出站请求上禁用重定向。详见 lib/net-guard.js 顶部说明。
import { assertLocalUrl, guardedFetch, setAllowRemote } from './net-guard.js'

export const execFileAsync = promisify(execFile)

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

import {
  defaultOutputBase,
  defaultOutputDir,
  resolveOutputDir,
  DEFAULTS,
  FLOW_STYLES,
  ASPECTS,
  uiStatePath,
  readUiState,
  writeUiState,
  makeLog,
  r32,
  calcSize,
  safeStem,
  portOf,
  toError,
  cancelReason,
  uniquePath,
  GPU_PROFILES,
  VENDOR_RULES,
  PCI_VENDOR,
  ACCEL_PACKS,
  ACCEL_SOURCES,
  PIP_MIRRORS,
  MODEL_HINTS,
  FULL_CAPS,
  MODEL_TIERS,
  INLINE_IMAGE_PROMPT,
  DRAW_INTENT_MODES,
  MODEL_NODES,
  UNET_LOADER_GGUF,
  UNET_LOADER_NATIVE,
  NO_SELF_DRAW_RULE,
  OUTPUT_SCHEMA,
  PARAMETERS,
  GPU_CACHE,
  CAP_CACHE,
  PROBE_FAIL_TTL_MS,
  SAGE_READY,
  AMD_KERNEL_FLAG,
  PATHS_CACHE,
  DIAG_FILE,
  DIAG_ON,
  describeOptimization,
  genericOptimizations,
  nvidiaGenOf,
  vendorIdOf,
  GPU_PROBE_WIN,
  GPU_PROBE_LINUX,
  GPU_PROBE_MAC,
  GPU_VRAM_PROBE_WIN,
  GPU_VRAM_PROBE_PY,
  GPU_VRAM_PROBE_PY_MAC,
  COMFY_SEARCH_WIN,
  COMFY_SEARCH_NIX,
  normalizeGpuText,
  detectGpuProfile,
  discoverComfyPaths,
  importantNotesOf,
  buildDrawIntentPrompt,
  tierLabelOf,
  unetLoaderFor,
  unetLoaderNode,
  pickBestModel,
  listComfyModels,
  makeListModelsTool,
  shouldProbe,
  pickWrapperSet,
  planWorkflow,
  buildWorkflow,
  resolvePlan,
  probeCapabilities,
  probeReadiness,
  fetchWithTimeout,
  runShell,
  IS_WINDOWS,
  IS_MAC,
  pipSources,
  trimPrompt,
  TURBO8_STEPS,
  DEFAULT_TURBO8_LORA,
  BASE_STEPS,
  BASE_CFG,
  presetAspect,
  auxCapabilities,
  clearCapabilityCache,
  // ★ 2026-10-14（C1/C2 专业卡版）：显存/内存档位解析与合法取值 —— 与面板报告**同源**
  resolveVramArgs,
  VRAM_MODES,
  PRECISION_TIERS,
  TEXT_CONTROL_MODES,
  pickUnetForTier,
  // ★ 2026-10-16：ControlNet 架构探测（真实用户反馈 —— InstantX 权重是给 1.0 的）
  readSafetensorsConvInChannels,
  looksLikeQwenImage10ControlNet,
} from './config.js'

import {
  packAppliesToOs,
  pathExists,
  runInstallSource,
  comfyDirsFrom,
  probeAccelPack,
  probeAcceleration,
  autoSetupAcceleration,
  installAccelPack,
} from './comfy-accel.js'

/** 带超时的 fetch（同时尊重 exec.signal 的取消）。 */
const IS_LINUX = process.platform === 'linux'

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
  /** ★ 2026-10-13（任务 #62②）：本次启动**是否真的挂了** `--use-sage-attention`。
   *   只有 true 时，启动失败才归咎于 SageAttention 并自动禁用（崩溃自动回退）。 */
  sageAttempted: false,
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
 * ★★★ 2026-10-13（任务 #62②「SageAttention 崩溃自动回退」）：判断这次启动失败
 * **是否由 `--use-sage-attention` 引起**。
 *
 * ## 为什么需要它
 *   启动失败的原因很多（端口被占、依赖缺失、显存不够…），**不能**一概归咎于 SageAttention。
 *   只有日志**明确指向 sage-attention** 时才认 —— 否则会误关用户想要的功能。
 *
 * ## 判据（宁可漏判、不可误判）
 *   · `unrecognized arguments` + 提到 sage-attention —— argparse 不认这个参数（版本太老）
 *   · `No module named 'sageattention'` —— 硬依赖没装却强制开了（auto 档永远不会走到这）
 *   · 提到 sage_attn / sageattention + 编译 / sm_120 / build 失败 —— Blackwell 构建不匹配
 *   · 日志里 sage-attention 与 ImportError / ModuleNotFoundError / Traceback 同时出现
 */
function launchFailedDueToSage(tail) {
  const t = String(tail ?? '').toLowerCase()
  if (/unrecognized arguments/i.test(t) && /sage[-_]?attention/i.test(t)) return true
  if (/no module named ['"]?sageattention/i.test(t)) return true
  if (/(sage[-_]?attn|sageattention).{0,80}(not compiled|sm_120|build|error)/i.test(t)) return true
  if (/sage[-_]?attention/i.test(t) && /(importerror|modulenotfounderror|traceback)/i.test(t)) return true
  return false
}

/**
 * 归咎于 SageAttention 时，在本会话内自动关掉它，避免崩溃循环。
 * ⚠ **只改内存中的 cfg**（与界面开关的持久化策略一致：面板开关也只改内存、不写盘）。
 *   要永久关闭，需在 cordis.patch.yml 把 `nvidiaSageAttention` 设成 false。
 * @returns {boolean} 是否真的做了禁用（已关则返 false，避免重复日志）。
 */
function recoverFromSageCrash(cfg, log) {
  if (cfg?.nvidiaSageAttention === false) return false
  cfg.nvidiaSageAttention = false
  log?.('warn',
    '⚠ SageAttention 疑似导致 ComfyUI 启动失败（启动日志指向 sage-attention）。'
    + '已在本会话内自动关闭 nvidiaSageAttention，避免反复崩溃 —— 下次启动将不再带 --use-sage-attention。'
    + '若要恢复：先确认装了与当前显卡匹配的 sageattention'
    + '（Blackwell / sm_120 需支持该架构的构建），再把 nvidiaSageAttention 设回 true。')
  return true
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
 * ★★★ 2026-10-12 抽出：**构造 POSIX（Linux / macOS）下的 ComfyUI 启动命令**。
 *
 * ## 为什么要抽成纯函数
 *   这段逻辑（尤其是**引号转义**）此前内联在 `ensureComfyUp` 里，
 *   于是它**永远没法被单测** —— 而它恰恰是最容易写坏的一处：
 *   启动命令要穿 `sh -c` → `sh -c` → `exec` 三层引号，写错一个字符就是
 *   "命令返回成功、但什么都没发生"（本项目已踩过一次同类坑）。
 *   本轮给它加了**环境变量注入**（macOS 的 MPS 两个变量），风险更高 ⇒ 必须能测。
 *   抽成纯函数后由 `_mac_env_test.mjs` **真起一个 sh 跑一遍**，
 *   断言变量确实传到了子进程里。
 *
 * ## 引号约定（照原样保留，别改）
 *   `q()` 用单引号包裹，内部单引号转义成 `'\''`。
 *   外层 `sh -c ${q(wrapped)}` 会把 `wrapped` 里的引号再转义一层 ——
 *   最终由**最内层**的 sh 解析出正确命令。这是本项目已验证的写法。
 *
 * ## 环境变量为什么用 `export K=V; exec ...`
 *   POSIX 下 `exec` 是**特殊内建**：`exec K=V cmd` 里的 `K=V` 会被当成 exec 的
 *   **第一个操作数（命令名）**，语义不明确。先 export 再 exec 是无歧义的写法。
 *
 * @param {object} o
 * @param {string} o.py        python 解释器路径
 * @param {string[]} o.args    传给 python 的参数（含 main.py）
 * @param {string} o.pidFile   写 pid 的文件（`$$` 即真正执行者的 pid，exec 不换 pid）
 * @param {string} o.logPath   启动日志路径（stderr/stdout 重定向目标）
 * @param {Array<[string,string]>} [o.launchEnv] 要注入的环境变量
 * @param {boolean} [o.useSetsid] 有 setsid 时用 `setsid --fork`，否则退回 `nohup ... &`
 */
function buildPosixLaunchCommand({ py, args, pidFile, logPath, launchEnv = [], useSetsid = false }) {
  const q = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
  const inner = [py, ...args].map(q).join(' ')
  const envExport = launchEnv.map(([k, v]) => `export ${k}=${q(v)};`).join(' ')
  // ★★★ 2026-10-12 **修 bug（真事故，且 macOS 上必然踩到）**：
  //   原写法是 `sh -c 'echo $$ > ${q(pidFile)}; exec ${inner}'` —— 用**手写引号**
  //   去包内层脚本。问题在于：内层脚本里那些 `q()` 产生的单引号，会和手写的
  //   外层引号**互相配对**，被外层 shell"抹平"（引号只做分组、不进最终文本），
  //   于是内层 sh 收到的是**没有引号的裸命令**。
  //   实测（Git Bash 的 sh，本机复现）：
  //     `exec 'sh' '-c' 'echo hi'` → 内层变成 `exec sh -c echo hi`
  //     ⇒ `sh -c echo`（`hi` 成了 $0）⇒ 什么都没跑、只吐一个空行；
  //     含空格的路径 `> '/tmp/a b/x.pid'` → 内层变成 `> /tmp/a b/x.pid`
  //     ⇒ 重定向到 `/tmp/a`、多出一个参数 ⇒ **路径带空格就彻底失效**。
  //   ⇒ 修法：**不要手写外层引号**，整段内层脚本用 `q()` 正规转义一层。
  //     这样外层 shell 把脚本**原样**交给内层 sh，内层再按它自己的引号解析 —— 两层的
  //     引号各自独立、互不干扰。`q()` 的 `'\''` 转义会让这段文本安全穿过两层。
  //   ⚠ 这一条对 macOS 尤其重要：Mac 上 ComfyUI 常装在
  //     `/Users/<名字>/My ComfyUI` 这类**带空格**的路径下。
  const innerScript = `echo $$ > ${q(pidFile)}; ${envExport}${envExport ? ' ' : ''}exec ${inner}`
  const wrapped = `sh -c ${q(innerScript)}`
  const cmd = useSetsid ? `setsid --fork sh -c ${q(wrapped)}` : `nohup sh -c ${q(wrapped)} &`
  return { wrapped, cmd, full: `${cmd} >${q(logPath)} 2>&1 < /dev/null &` }
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
    // ★★★ 2026-10-13（任务 #62②「崩溃自动回退」）：记住"本次**是否真的挂了**
    //   `--use-sage-attention`" —— 只有挂了它却崩，才归咎于它、自动禁用。
    //   （`want` 为 false 时不记，避免把"没装 sage 导致启动失败"误判成 sage 的锅。）
    launch.sageAttempted = want === true
    if (want) {
      autoArgs = [...autoArgs, '--use-sage-attention']
      // ★ 性能 / 兼容模式（中文命名）：ComfyUI 的全局开关没有官方子模式参数，
      //   所以这里**只**在日志里标注用户选的模式，不编造命令行参数。
      const sageMode = cfg.nvidiaSageAttentionMode === 'compatibility' ? '兼容模式' : '性能模式'
      log('info', '已启用 N 卡 SageAttention：--use-sage-attention'
        + `（${mode === true ? '配置显式开启' : '后台自检确认已安装'}，模式=${sageMode}）`
        + (sageMode === '兼容模式'
          ? '｜兼容模式：若本次启动因 sage-attention 失败，将自动禁用以避免反复崩溃。'
          : ''))
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
  //   对 X:\ComfyUI-rocm\ComfyUI\.dshqp-launch.log 里 6 笔出图逐笔拆解：
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
  const VRAM_ARGS = resolveVramArgs({
    mode: cfg.vramMode,
    vramGB: gpu.vramGB,
    isMac: IS_MAC,
  })

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

  // ★★★ 2026-10-12 新增：**给 ComfyUI 进程注入环境变量**（此前插件**一个都不注入**）。
  //
  // ## 为什么需要（这是 macOS 端"零优化"的第二块拼图）
  //   PyTorch 的 MPS 行为**没有命令行开关**，只能通过环境变量调
  //   （官方文档 "MPS Environment Variables"）。最要紧的一个是
  //   `PYTORCH_ENABLE_MPS_FALLBACK`：MPS 后端未实现的算子自动回退 CPU。
  //   没有它时，链路里碰到一个未实现的算子，**整次出图直接抛错**（不是慢一点，是失败）。
  //
  // ## 两个变量的来源与取舍
  //   · 档案级默认（`gpu.env`）—— 目前只有 Mac 三档带，值是 PYTORCH_ENABLE_MPS_FALLBACK=1；
  //   · 用户开关（见 DEFAULTS.appleMpsFallback / appleMpsUnlimitedMem）——
  //     前者能**关掉**档案默认，后者能**加上** `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
  //     （取消 MPS 分配器的硬上限，让大模型能在小内存 Mac 上跑；默认关，因为
  //      取消上限后系统级 OOM 会连系统一起拖垮 —— 那是"用稳定性换可用性"的取舍）。
  //
  // ⚠ 只在 macOS 注入：其它平台没有 MPS 后端，注入了也只是噪音。
  //   所以 Windows 上 `launchEnv` 恒为空 —— 下面两条启动路径都因此不受影响。
  const launchEnv = (() => {
    if (!IS_MAC) return []
    const pairs = Object.entries(gpu.env ?? {}).map(([k, v]) => [k, String(v)])
    const kept = cfg.appleMpsFallback === false
      ? pairs.filter(([k]) => k !== 'PYTORCH_ENABLE_MPS_FALLBACK')
      : pairs
    if (cfg.appleMpsUnlimitedMem === true) {
      kept.push(['PYTORCH_MPS_HIGH_WATERMARK_RATIO', '0.0'])
    }
    return kept
  })()
  if (launchEnv.length > 0) {
    log('info', `注入环境变量：${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
    diag('start', `env ${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

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
      // ★ 2026-10-12：环境变量（若有）以独立 `set` 行写在启动命令**之前**。
      //   后面的 `> "${launchLog}" 2>&1` 重定向只作用于最后一行（即真正的启动命令），
      //   这正是我们要的 —— set 行本身不需要重定向。
      //   ⚠ 目前 Windows 上 launchEnv 恒为空（见上面的 IS_MAC 闸），这条是**为将来留的**：
      //     真要在 Windows 上注入变量时不必再改这里。
      const line = [
        ...launchEnv.map(([k, v]) => `set ${k}=${v}`),
        [py, ...args].map((a) => `"${String(a)}"`).join(' '),
      ].join('\r\n')
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
      const pidFile = `${launchLog}.pid`
      const hasSetsid = await runShell(
        'if command -v setsid >/dev/null 2>&1; then echo YES; else echo NO; fi',
        8000,
      )
      // ★ 2026-10-12：命令构造抽成纯函数（见 buildPosixLaunchCommand 的说明）——
      //   便于单测，且环境变量注入与引号转义只有**一处**实现。
      const launchCmd = buildPosixLaunchCommand({
        py,
        args,
        pidFile,
        logPath: launchLog,
        launchEnv,
        useSetsid: hasSetsid.trim() === 'YES',
      })
      await runShell(launchCmd.full, 30000)
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
        // ★★★ 2026-10-13（任务 #62②）：崩溃自动回退 —— 若本次挂了 sage-attention 且崩因指向它，
        //   先禁用再判失败，避免用户重试又崩、陷入循环。
        if (launch.sageAttempted === true && launchFailedDueToSage(tail)) recoverFromSageCrash(cfg, log)
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
    // ★★★ 2026-10-13（任务 #62②）：崩溃自动回退（同日志路径）。
    if (launch.sageAttempted === true && launchFailedDueToSage(tail)) recoverFromSageCrash(cfg, log)
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
export async function ensureComfyUp(cfg, log, signal) {
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

/* ───────────────────────── 请求信任判定（★ 2026-10-16 AUTH001 整改）───────────────────────── */

/**
 * 解析一个"裸 authority"（`host` 或 `host:port`）→ URL；无法解析返回 null。
 * 与官方 `api-request-trust.ts` 的 `parseAuthority` 等价。
 */
function parseAuthority(authority, scheme = 'http:') {
  try {
    // http:/https: 是 WHATWG 的 special scheme：解析结果要么有非空 hostname，要么抛错。
    return new URL(`${scheme}//${authority}`)
  } catch {
    return null
  }
}

/** hostname 是否为回环（localhost / 127.0.0.0/8 / ::1）。 */
function isLoopbackHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/gu, '')
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h)
}

/**
 * Origin 是否就是本机这个 authority（同源）。
 * `Origin: null`（沙箱 iframe / file: 页面）是不透明源 → `new URL('null')` 抛错 → false。
 */
function isSameAuthorityOrigin(origin, host) {
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const scheme = originUrl.protocol === 'https:' ? 'https:'
    : originUrl.protocol === 'http:' ? 'http:'
      : undefined
  if (scheme === undefined) return false   // file: / ftp: 等一律不认
  const hostUrl = parseAuthority(host, scheme)
  return hostUrl !== null && originUrl.host === hostUrl.host
}

/**
 * ★★★ 2026-10-16（DSH STORE AUTH001 整改）**请求信任判定**。
 *
 * ## 原版为什么不够（审核原话）
 *   原来的 `isLocalRequest` *"只看 Host 和 socket 的本机地址；**缺失值也放行**，
 *   不检查 Origin、Sec-Fetch-Site 或宿主调用方身份"*。
 *   ⇒ **来自其它网页、但目标地址为本机的请求，Host 和 socket 仍然是本机** ——
 *     单纯"只允许本机连接"**并不证明发起请求的网页可信**（CORS 也挡不住有副作用的 GET）。
 *     这是典型的 confused-deputy 面。
 *
 * ## 实现：与官方 `api-request-trust.ts` 等价
 *   官方（`packages/client/connection/src/api-request-trust.ts`）的判定顺序，逐条照做：
 *   ① **Host 围栏**（防 DNS rebinding）：**每个请求都过**。Host 缺失 / 无法解析 /
 *      不是回环 ⇒ **拒绝**。理由：Host 是 rebinding **唯一无法伪造**的头 ——
 *      浏览器按"它以为在跟谁说话"填 Host，所以被 rebind 的页面会把攻击者域名带进来。
 *   ② **跨站围栏**：`Sec-Fetch-Site: cross-site` ⇒ **拒绝**（不论 Origin）。
 *   ③ **Origin 围栏**：带了 Origin 就必须与本机 Host **同源**；`Origin: null`
 *      （沙箱 iframe / file: 页面）是不透明源 ⇒ 拒绝；
 *      **没带 Origin 则放行** —— 此时 Host 围栏已经约束住了。官方原文：
 *      *"Absent Origin is fine — the Host fence above already bound the request."*
 *
 * ⚠ "没带 Origin 放行"**不是漏洞**：能过 Host 围栏说明请求方认为自己在跟本机说话；
 *   而能伪造 Host 的只有非浏览器客户端 —— 那已是本机进程，不在本模块的威胁模型内
 *   （威胁模型是**浏览器发起的跨站 / rebinding 请求**）。
 *
 * ⚠ 另外保留原来的 socket 检查（有值时必须是回环）作为**附加**一层。
 *   `remoteAddress` 缺失时**不**据此拒绝 —— 官方实现同样不检查该项，主要防线是 Host 围栏；
 *   把它变成硬性要求会误伤非 TCP 场景。
 */
function isTrustedRequest(req) {
  const headers = req?.headers ?? {}

  // ① Host 围栏 —— 缺失即拒。（原版这里是 `host === '' → hostOk = true`，即"缺失也放行"，是弱点。）
  const host = String(headers.host ?? '')
  if (host === '') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false

  // ② 附加：socket 若来自本机以外的地址，直接拒（有值才判）
  const remote = String(req?.socket?.remoteAddress ?? '')
  if (remote !== '' && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return false
  }

  // ③ 跨站围栏：现代浏览器在每次 fetch 上标注发起方关系，显式 cross-site 一律拒。
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false

  // ④ Origin 围栏：带了就必须同源；没带则 Host 围栏已足够。
  const origin = headers.origin
  if (origin === undefined) return true
  return isSameAuthorityOrigin(String(origin), host)
}

/**
 * 兼容别名 —— 语义已从"只放行本机"升级为"放行可信的本机请求"。
 * 保留旧名以免漏改调用点；新代码请用 `isTrustedRequest`。
 */
const isLocalRequest = isTrustedRequest

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

/**
 * ★ 2026-10-16（DSH STORE AUTH001 整改）：读 JSON 请求体。
 *
 * 写操作从"GET 带 query"改为"POST + JSON body"后，这里是**唯一的写入入口**。
 * · 有大小上限（默认 256 KiB）：超限直接放弃，避免内存放大；
 * · 空 body / 非 JSON / 解析失败 → 返回 null（调用方按"无写入"处理）。
 */
async function readJsonBody(req, limitBytes = 256 * 1024) {
  try {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > limitBytes) return null
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 取 Content-Type 的媒体类型（小写、去掉 `; charset=...` 之类的参数）。 */
function mediaTypeOf(req) {
  return String(req?.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * ★★★ 2026-10-17（AUTH001 收尾，审核指出"写入口最后边界"）：
 *   **写操作的前置守卫 —— 方法 + 媒体类型**。
 *
 * 审核原话：*"`lib/index.js:3869` 的状态 POST 尚未检查 `application/json`；
 * 4355 的 `repair` 没有限制方法/内容类型，任意方法的 JSON `confirm:true` 都会进入 `runRepair`。
 * 请让错误方法/媒体类型在**任何动作前**返回 405/415，并统一有界正文解析。"*
 *
 * 确实如此。本函数必须在**读 body 之前、碰 cfg 之前**调用：
 *   · 非 POST        → **405 Method Not Allowed**
 *   · 非 JSON 媒体类型 → **415 Unsupported Media Type**
 * 这样 `text/plain` 的"简单请求"（浏览器跨站表单能发、且不触发预检）根本进不到业务逻辑。
 *
 * @returns {boolean} true = 通过，可以继续；false = 已写响应，调用方应立即 return
 */
function guardWriteRequest(req, res) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    respondJson(res, {
      ok: false,
      reason: `method not allowed：写操作必须用 POST（收到 ${method}）`,
      allow: 'POST',
    }, 405)
    return false
  }
  if (mediaTypeOf(req) !== 'application/json') {
    respondJson(res, {
      ok: false,
      reason: 'unsupported media type：写操作要求 Content-Type: application/json',
      got: String(req?.headers?.['content-type'] ?? ''),
    }, 415)
    return false
  }
  return true
}

/* ---------------------------------------------------------------- 工作流与出图 ---- */

/**
 * ★★ 2026-10-08 新增：探活请求该不该发。
 *
 * 参考图那一路为了省掉一次 8 秒的「连不上」超时（图要上传说明后端肯定在跑），
 * 故意**跳过探活** —— 这是原有行为，这里只是把它抽成纯函数便于自测。
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
    // ★ 2026-10-16：改用 guardedFetch —— 回环校验 + 禁重定向收口在一处。
    const res = await guardedFetch(`${cfg.comfyUrl}/upload/image`, {
      method: 'POST', body: form, signal: controller.signal,
    })
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
    // ★★★ 2026-10-12 修 bug：DSH 的 `tools.register()` **强校验 `output`** ——
    //   必须同时有 `schema`(object) 与 `render`(function)，否则整条工具注册被拒：
    //     `tool "check_acceleration" must declare output { schema, render, presentationMeta? }`
    //   `makeDrawTool` 一直有；这两个**诊断类**工具漏了 ⇒ 重载后它们注册失败，
    //   面板里那句"可让助手调用 check_acceleration 查看"就成了空指引。
    //   用宽松 schema（`additionalProperties: true`）：这两个工具的返回结构是动态的，
    //   写死 properties 会在 DSH 校验返回值时把真实结果判为不合法。
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        description: 'GPU / 加速环境体检报告：显卡厂商与架构、注意力后端参数、优化链、加速包就位情况。',
      },
      render: (_args, value) => [{
        type: 'text',
        text: (typeof value?.summary === 'string' && value.summary !== '')
          ? value.summary
          : `加速环境检查完成：${JSON.stringify(value ?? {}).slice(0, 1200)}`,
      }],
    },
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
      // ★★★ 2026-10-12（用户要求「确认式一键修复」）：先做可逆/无害的修复。
      //   预览（confirm≠true）→ 返回将要做什么；确认（confirm=true）→ 真正执行。
      if (args?.action === 'repair') {
        return await runRepair(cfg, log, { confirm: args?.confirm === true, signal: exec?.signal })
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
export async function getNodeSchema(cfg, type, signal) {
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
export function nodeFileList(schema, field) {
  const spec = schema?.input?.required?.[field] ?? schema?.input?.optional?.[field]
  return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : []
}

/** 能力探测结果的缓存（按 ComfyUI 地址）。 */
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
/**
 * ★★★ 2026-10-13：OOM（显存不足）判定。
 *
 * ## 为什么提到模块级
 *   原先它定义在 `runDraw` 内部 ⇒ **没法被测试**（测试拿不到它）。
 *   结果 0.16.0 的"OOM 自动回退"是**零测试覆盖**上线的 —— 坏了没人知道
 *   （这次就是在补测试时，顺手发现另一个"重跑少出图"的 bug）。
 *   ⇒ 提到模块级，通过 `__internal` 暴露，让回归能**真喂字符串**去验。
 *
 * ## 判据为什么这么写
 *   必须**宽**到覆盖各家后端（NVIDIA CUDA / AMD ROCm hip / Apple MPS），
 *   又必须**窄**到不误伤普通错误（比如 "prompt too long"）：
 *     · 单词边界 `\b`，避免把普通句子里的 "room" 之类误判；
 *     · 后端前缀 + memory 的组合，避免单独出现 "memory" 就触发。
 */
/**
 * ★★★ 2026-10-14（C1「专业卡版」）：显存/内存档位的解析**已移到 `lib/config.js`**。
 *
 * 原因：启动参数（本文件的 ensureComfyUp）与面板报告（config.js 的 resolvePlan.residency）
 *   必须**同源**。两处各写一份判据，迟早出现"面板说一套、实际跑另一套"
 *   —— 本项目历史上就出过这种假报告。现在只剩 `resolveVramArgs` 一份实现。
 *   ⚠ 本文件通过 `import { resolveVramArgs, VRAM_MODES } from './config.js'` 使用它。
 */

function isOutOfMemoryError(err) {
  const m = String(err?.message ?? err ?? '').toLowerCase()
  if (!m) return false
  return /\b(out of memory|outofmemoryerror|oom)\b/u.test(m)
    || /\bcuda\b.*\bmemory\b/u.test(m)
    || /\bhip\b.*\bmemory\b/u.test(m)
    || /\bmps\b.*\bmemory\b/u.test(m)
}

/**
 * ★★★ 2026-10-13（任务 #62①「记忆消费」）：把「工具入参 + 记忆偏好 + 运行时默认」
 * 折算成实际生效的画参。
 *
 * ## 为什么提成纯函数
 *   这是本轮**最容易出错的一环** —— 铁律是"绝不拿记忆覆盖用户显式意图"。
 *   抽成纯函数就能对它单独回归（真喂 `args` / `cfg` / `pref` 断言优先级），
 *   不必为验一条优先级把整个 ComfyUI HTTP 后端都搭起来。
 *
 * ## 优先级（从高到低）
 *   显式入参 > 记忆偏好 > 运行时 `cfg.preset` > 插件默认（1:1 / 1.0MP / 1 张）。
 *   ⚠ 对 `negative` 缺省：记忆有才用，没有就如实给 undefined（不编一个默认负向词）。
 *
 * ## ⚠ seed 故意不在返回值里
 *   它由调用方按"显式就取、否则随机"决定。记忆里的 seed 会让每次出图都一模一样 ——
 *   那不是用户想要的行为，所以**不从记忆读**。
 *
 * @returns {{preset: string|null, aspect: string, megapixels: number,
 *            steps: number|undefined, count: number, negative: string|undefined,
 *            memFilled: string[]}}  `memFilled` = 本次由**记忆**补上的项（给日志如实说明用）。
 */
function resolveDrawParams(args, cfg, pref) {
  const p = pref ?? {}
  // 一次判"显式给了没"，后续各档都复用同一条规则
  const hasPreset = typeof args?.preset === 'string' && args.preset !== ''
  const hasSize = typeof args?.size === 'string' && ASPECTS[args.size] !== undefined
  const hasMega = Number.isFinite(args?.megapixels) && args.megapixels > 0
  const hasSteps = Number.isFinite(args?.steps)
  const hasCount = Number.isFinite(args?.count)
  const hasNeg = typeof args?.negative === 'string' && args.negative.trim() !== ''

  // 只在对应参数**缺省**时才谈记忆 —— 否则置 null，绝不参与后续决策
  const prefSize = !hasSize && typeof p.size === 'string' && ASPECTS[p.size] ? p.size : null
  const prefPreset = !hasPreset && typeof p.preset === 'string' && p.preset !== '' && p.preset !== 'default'
    ? p.preset
    : null
  const prefMega = !hasMega && Number.isFinite(p.megapixels) && p.megapixels > 0 ? p.megapixels : null
  const prefSteps = !hasSteps && Number.isFinite(p.steps) ? Math.max(1, Math.trunc(p.steps)) : null
  const prefCount = !hasCount && Number.isFinite(p.count) ? Math.max(1, Math.min(4, Math.trunc(p.count))) : null
  const prefNegative = !hasNeg && typeof p.negative === 'string' && p.negative.trim() !== '' ? p.negative : null

  const runtimePreset = (typeof cfg?.preset === 'string' && cfg.preset !== '' && cfg.preset !== 'default')
    ? cfg.preset
    : null
  const preset = hasPreset ? args.preset : (runtimePreset ?? prefPreset)
  const aspect = hasSize ? args.size : (prefSize ?? (presetAspect(preset) || '1:1'))
  return {
    preset: preset ?? null,
    aspect,
    megapixels: hasMega ? args.megapixels : (prefMega ?? 1.0),
    steps: hasSteps ? Math.trunc(args.steps) : (prefSteps ?? undefined),
    count: hasCount ? Math.max(1, Math.min(4, Math.trunc(args.count))) : (prefCount ?? 1),
    negative: hasNeg ? args.negative : (prefNegative ?? undefined),
    memFilled: [
      ...(prefSize ? [`画幅=${prefSize}`] : []),
      ...(prefMega ? [`${prefMega}MP`] : []),
      ...(prefSteps ? [`${prefSteps} 步`] : []),
      ...(prefCount ? [`每轮 ${prefCount} 张`] : []),
      ...(prefNegative ? ['负向词'] : []),
    ],
  }
}

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

      // ★★★ 2026-10-13（任务 #62①：记忆消费）：读 dsh-auto-memory 写进来的「偏好」
      //   （.qwen-paint-preferences.json），用它给**用户本次没显式传**的画参做兜底。
      //   ⚠ 铁律：显式参数 > 记忆 > 运行时 cfg.preset > 默认。**绝不**拿记忆覆盖用户当场的意图。
      //   ⚠ 读取失败按 {} 处理（内部已吞错），绝不影响出图。
      const pref = (await readPreferences(cfg, log)) ?? {}
      const rp = resolveDrawParams(args, cfg, pref)
      const { preset, aspect, megapixels, steps, count, negative, memFilled } = rp
      const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
      if (memFilled.length > 0) {
        log('info', `已按记忆偏好补默认：${memFilled.join('、')}（你本次没显式指定；想改就显式传参）`)
      }
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
      // ★ 2026-10-14（C4「专业卡版」）：ControlNet 控制图 —— 与参考图**同样要上传**给 ComfyUI。
      const cnetPath = typeof args?.controlImage === 'string' ? args.controlImage.trim() : ''
      const [ready, reference, controlImage, caps] = await Promise.all([
        probeReadiness(cfg, signal),
        refPath !== '' ? uploadReference(cfg, refPath, signal) : Promise.resolve(''),
        cnetPath !== '' ? uploadReference(cfg, cnetPath, signal) : Promise.resolve(''),
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
      if (cnetPath !== '') log('info', `ControlNet 控制图已上传：${cnetPath} → ${controlImage}`)
      // ★★★ 2026-10-13（用户反馈）：**串行抽卡（排队模式）**。
      //   ⚠ 关键澄清（详见 DEFAULTS.serialBatch）：串行**绝不卸主模型** ——
      //     真卸掉下一张就得重新加载 ~13.5GB（实测冷启动 65s），那才是灾难。
      //     串行省的是「不同时持有 N 份 latent」，模型**保持常驻**才是对的。
      const vramGB = Number(caps?.gpu?.vramGB ?? 0)
      const serialMode = cfg.serialBatch === 'on'
        ? true
        : (cfg.serialBatch === 'off'
          ? false
          : (Number.isFinite(vramGB) && vramGB > 0 && vramGB < 16))
      // 只在真的要出多张、且是文生图时才串行（图生图维持"一次一张"的既有语义，不改）。
      const wantSerial = serialMode && count > 1 && reference === ''
      const iterations = wantSerial ? count : 1
      const perIterCount = wantSerial ? 1 : count
      if (iterations > 1) {
        log('info', `串行抽卡：共 ${iterations} 张，每次只提交 1 张`
          + `（显存 ${vramGB} GB → serialBatch=${cfg.serialBatch ?? 'auto'}）`)
      }
      if (count > 1 && reference !== '') {
        log('warn', `图生图暂不支持一次多张（count=${count} 已按 1 张处理）`)
      }

      // ★★★ 2026-10-12（用户要求 + 审计文档）：**OOM 自动回退**。
      //   出图撞 OOM（"out of memory" / "OutOfMemoryError" / CUDA / hip / MPS 之一）时，
      //   自动强制 `vaeTiling='on'` 重跑一次（ComfyUI 自带 VAEDecodeTiled，零新增依赖）。
      //   再 OOM 则把两次错误如实抛出（**绝不静默吞**）。
      //   判据必须**宽**到覆盖各家后端（NVIDIA / AMD ROCm / Apple MPS），但**窄**到不误伤
      //   普通错误（"prompt too long" 等）—— 用单词边界 + 几个特定后端前缀。
      // ★ buildWf：三件事都靠它 —— ① OOM 重跑换 cfg；② 串行换 seed；③ 每次的张数
      const buildWf = (overrideCfg, iterSeed, iterCount) => buildWorkflow(
        overrideCfg ?? cfg,
        {
          prompt,
          negative,
          width,
          height,
          steps,
          seed: Number.isFinite(iterSeed) ? iterSeed : seed,
          reference,
          // ★ 2026-10-14（C4）：ControlNet 控制图（上传后的 ComfyUI 文件名）
          controlImage,
          count: Number.isFinite(iterCount) ? iterCount : perIterCount,
        },
        caps,
      )

      let workflow = buildWf(undefined, seed, perIterCount)
      const usedSteps = workflow[8]?.inputs?.steps ?? steps
      // ★★★ 2026-10-09 **以"生效尺寸"为准**（修「出的图尺寸不对」那个误报）。
      //   锁尺寸档（forceOptimizedSize=true）下，buildWorkflow 会把 864x1152 这类
      //   请求**改写成 1024x1024**。之后的"尺寸校验 / 文件名 / 返回值"必须都用
      //   **实际生效的那个**，否则就是在拿请求值跟实际值对账 —— 必然对不上。
      const eff = workflow.__effective ?? { width, height, locked: false }
      // ★ 2026-10-14（C4）：ControlNet 是否真的接上了（没接上时带原因，如实回报）
      const cnet = workflow.__cnet ?? { applied: false, name: '', reason: '' }
      // ★ 2026-10-10 修 bug：改成 `let` —— 图生图的真实输出尺寸要**用实测值覆盖**（见下）。
      let outWidth = eff.width
      let outHeight = eff.height
      if (outWidth !== width || outHeight !== height) {
        log('info', `尺寸已按优化档归一到 ${outWidth}x${outHeight}（请求 ${width}x${height}；`
          + `forceOptimizedSize=${cfg.forceOptimizedSize !== false}）`)
      }

      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const savedFiles = []
      let firstPath = ''
      let index = 0
      let oomRetried = false
      const t0 = Date.now()

      for (let iter = 0; iter < iterations; iter += 1) {
        // ★ 串行第 2 张起：换 seed（对齐 ComfyUI 批内 seed+1 的语义）+ 每次只提交 1 张
        if (iter > 0) workflow = buildWf(undefined, seed + iter, 1)
        log('info', `提交任务 ${outWidth}x${outHeight} 档位=${caps.level} steps=${usedSteps} `
          + `cfg=${workflow[8]?.inputs?.cfg} seed=${seed + iter}`
          + `${iterations > 1 ? `（第 ${iter + 1}/${iterations} 张）` : ''}`
          + `${reference === '' ? '（文生图）' : `（图生图 参考=${reference}）`}`)

        let promptId, images
        try {
          promptId = await submitPrompt(cfg, workflow, signal)
          images = await waitForResult(cfg, promptId, {
            signal,
            timeoutMs: cfg.timeoutMs,
            onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
          })
        } catch (firstError) {
          const isOom = isOutOfMemoryError(firstError)
          const allowFallback = cfg.oomAutoFallback !== false
          if (!isOom || !allowFallback) throw firstError
          const firstMsg = String(firstError?.message ?? firstError).slice(0, 200)
          log('warn', `出图撞 OOM（${firstMsg}）→ 自动开启 VAE 分块解码重跑…`)
          const retryCfg = { ...cfg, vaeTiling: 'on' }
          // ⚠⚠ 2026-10-13 修 bug（我自己上一轮引入的）：这里**不能**写死 1。
          //   非串行批量时 perIterCount = count（比如 4），写死 1 会让"OOM 重跑"
          //   只出 1 张 —— 用户要 4 张却静默只拿到 1 张，属于**静默少出图**。
          //   串行时 perIterCount 本来就是 1，所以两种模式用同一个值都正确。
          workflow = buildWf(retryCfg, seed + iter, perIterCount)
          oomRetried = true
          try {
            promptId = await submitPrompt(cfg, workflow, signal)
              images = await waitForResult(cfg, promptId, {
              signal,
              timeoutMs: cfg.timeoutMs,
              onTick: (note) => log('info', `prompt_id=${promptId} (OOM 重跑) ${note}`),
            })
            log('info', 'OOM 重跑成功（vaeTiling=on）')
          } catch (retryError) {
            const secondMsg = String(retryError?.message ?? retryError).slice(0, 200)
            throw new Error(
              `OOM 自动回退失败：① ${firstMsg}；② ${secondMsg}。`
              + '建议：① 调小尺寸（≤ 1024²）；② 关闭部分加速链（如把 teSpeedEnabled / speedupEnabled 设为 false）；'
              + '③ 加大显存 / 关闭其它占用显存的进程。',
            )
          }
        }
        // ---- 落盘（校验逻辑与原版一字不差，只是现在可能随串行跑多次）------------
        for (const image of images.slice(0, perIterCount)) {
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
          //   ★★★ 2026-10-10 修 bug（图生图尺寸）：图生图的输出尺寸由
          //     `resolution = round(sqrt(effWidth*effHeight))` **直接决定**（≈正方形），
          //     与请求的 width/height **本来就不是一回事**。原代码只跳过校验、却仍拿请求值
          //     当"实际尺寸"写进文件名与返回值 —— 属于数据错误（比如请求 864x1152、实际 ~998²）。
          //     ⇒ 这里用**实测 PNG 尺寸**覆盖 outWidth/outHeight，文件名与返回值都跟着变对。
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
      }
      const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
      if (oomRetried) {
        log('info', `本次为 OOM 自动重跑成功（用时 ${seconds}s，包含重跑）`)
      }
      if (firstPath === '') throw new Error('ComfyUI 报告成功，但没有取到任何图片')

      // ★★★ 2026-10-13（用户反馈）：**生成后自动放大**（一键出大图 / 2K）。
      //
      //   ## 为什么需要
      //   8 GB 卡想出 2K，唯一现实路径 = 先在 1024² 生成，再**分块放大**。
      //   放大工具 `upscale_image` 本来就有，但用户要手动跑两步 —— 这里串起来。
      //
      //   ## ⚠ 两条硬规矩
      //   ① 两段时间**分开记**：`seconds` 仍是"生图耗时"（与 0.16 语义一致，不擅自改），
      //      放大耗时单独放 `upscaleSeconds`。
      //   ② 放大**失败不影响**已经生成的那张图 —— 原图**已落盘**，只 warn 不抛错。
      //      （放大依赖 VOSR2/RealESRGAN，机器上未必装了；不能让"可选的后处理"
      //       把已经成功的主流程拖成失败。）
      let upscaledPath = ''
      let upscaleSeconds = 0
      const upscaleFactor = Number.isFinite(cfg.upscaleAfter) ? Math.trunc(cfg.upscaleAfter) : 0
      if (upscaleFactor >= 2 && firstPath !== '') {
        const tUp = Date.now()
        try {
          log('info', `生成后自动放大 ×${upscaleFactor}（upscaleAfter）…`)
          const up = await runUpscaleFile(cfg, log, signal, { image: firstPath, scale: upscaleFactor })
          upscaledPath = String(up?.path ?? '')
          if (upscaledPath !== '') {
            savedFiles.push(upscaledPath)
            outWidth = Number.isFinite(up?.width) ? up.width : outWidth
            outHeight = Number.isFinite(up?.height) ? up.height : outHeight
            upscaleSeconds = Number.isFinite(up?.seconds) ? up.seconds : 0
            log('info', `自动放大完成：${upscaledPath}（${up.width}x${up.height}，放大用时 ${upscaleSeconds}s）`)
          }
        } catch (error) {
          // ⚠ 只 warn —— 原图已经落盘了，绝不让"可选后处理"把成功的主流程拖成失败
          log('warn', `生成后自动放大失败（原图已保存，不受影响）：${error?.message ?? error}`)
        }
        if (upscaledPath === '' && upscaleSeconds === 0) {
          upscaleSeconds = Number(((Date.now() - tUp) / 1000).toFixed(1))
        }
      }

      // ★★★ 2026-10-09：这里返回的 width/height 必须是**生效尺寸** ——
      //   它会直接进工具返回值显示给模型看。以前返回请求值，
      //   于是"图是 1024²、回报却是 864x1152"，前后对不上。
      //   原始请求值另用 reqWidth/reqHeight 保留，供排查。
      const value = {
        // ★ 放大成功时，最终交付物 = 放大后的那张（用户要的就是大图）；
        //   原图用 originalPath 单独给，方便回看 / 对比。
        path: upscaledPath !== '' ? upscaledPath : firstPath,
        width: outWidth,
        height: outHeight,
        seed,
        seconds,
        files: savedFiles,
        ...(upscaledPath !== '' ? { originalPath: firstPath, upscaleSeconds } : {}),
        // ★ 2026-10-14（C4）：ControlNet 生效状态 —— 想用却没接上时如实说明原因
        ...(cnet.applied === true ? { controlnet: cnet.name } : {}),
        ...(cnet.applied !== true && cnet.reason !== '' ? { controlnetSkipped: cnet.reason } : {}),
        ...(outWidth !== width || outHeight !== height ? { requestedWidth: width, requestedHeight: height } : {}),
      }
      if (onProduced) {
        try {
          onProduced(exec, value)
        } catch (error) {
          log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
        }
      }
      // ★★★ 2026-10-12（用户要求）：**dsh-auto-memory 联动** —— 每次成功出图都写一条
      //   JSONL 到 `<outputDir>/.qwen-paint-memory.jsonl`。`dsh-auto-memory` 可通过
      //   `/api/qwen-paint/memory/recent` 拉取；任何写入失败都**不**影响出图。
      try {
        appendMemoryRecord(cfg, log, {
          ts: new Date().toISOString(),
          prompt: String(args?.prompt ?? '').slice(0, 200),
          negative: String(negative ?? '').slice(0, 200),
          seed,
          width: outWidth,
          height: outHeight,
          steps: usedSteps,
          path: firstPath,
          seconds,
          oomRetried: oomRetried === true,
          backend: cfg.imageBackend ?? 'comfyui',
        })
      } catch (error) {
        log('warn', `记忆日志写入失败（不影响出图）：${error?.message ?? error}`)
      }
      return value
}

/* ------------------------------------------------------------------ 辅助引擎（放大 / 局部重绘）---- */

/**
 * ★★★ 2026-10-12（用户明确要求）：**分阶段卸载主模型**。
 *
 * 放大引擎（VOSR2 ~7GB）与主千问模型（~13–20GB）同时占显存会直接 OOM。
 * 所以跑辅助任务前，先向 ComfyUI 发 `/free`（unload_models + free_memory）
 * 把主模型从显存卸下；放大/重绘结束后再由下次出图自动重新加载。
 * 这是"小模型别和主模型同时加载"这条硬约束的服务端实现。
 * 局部重绘复用主模型本身、**不**调它（见 makeEditTool 注释）。
 * 失败只返回 false，绝不拖垮调用方。
 */
async function freeComfyModels(cfg, signal) {
  try {
    const res = await fetchWithTimeout(
      `${cfg.comfyUrl}/free`,
      { method: 'POST', body: JSON.stringify({ unload_models: true, free_memory: true }), timeoutMs: 30000, signal },
    )
    return res.ok
  } catch (error) {
    log?.('warn', `卸载显存失败（不影响后续）：${error?.message ?? error}`)
    return false
  }
}

/* ------------------------------------------------------------------ dsh-auto-memory 联动 ---- */

/**
 * ★★★ 2026-10-12（用户要求）：**dsh-auto-memory 联动**。
 *
 * 本插件不依赖 dsh-auto-memory 存在 —— 但**主动**把每次成功出图写一条 JSONL，
 * 任何外部"记忆"插件（dsh-auto-memory、第三方知识库…）都可以通过
 *   GET /api/qwen-paint/memory/recent?limit=10
 * 拉走，按 ts / prompt / seed 做去重 / 召回。
 *
 * 同时提供一个"偏好"通道：GET/POST `/api/qwen-paint/memory/preference`，
 * 让 dsh-auto-memory 把"主人常用的预设/负向词/尺寸"等塞进来，
 * 下次 runDraw 时可以读到（★ 2026-10-13 已**自动消费**：仅当本次调用没显式传该参时
 * 才用记忆补默认，优先级「显式参数 > 记忆」；并会在日志里如实说明补了哪些。
 * ⚠ seed **不**从记忆读 —— 默认每次随机才对，要复现必须自己传 seed）。
 *
 * 文件位置：`<outputDir>/.qwen-paint-memory.jsonl` 与 `.qwen-paint-preferences.json`。
 * 全部失败都吞掉，**绝不影响出图**。
 */
function memoryPaths(cfg) {
  const base = String(cfg?.outputDir ?? '').trim()
  if (base === '') return { log: '', pref: '' }
  return {
    log: path.join(base, '.qwen-paint-memory.jsonl'),
    pref: path.join(base, '.qwen-paint-preferences.json'),
  }
}

/** 追加一条记忆（JSONL）。失败不抛。 */
async function appendMemoryRecord(cfg, log, entry) {
  const { log: logPath } = memoryPaths(cfg)
  if (logPath === '') return
  try {
    await fsp.mkdir(path.dirname(logPath), { recursive: true })
    await fsp.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch (error) {
    log?.('warn', `记忆日志写入失败：${error?.message ?? error}`)
  }
}

/** 读最近 N 条记忆。limit 默认 10、上限 100。 */
async function readMemoryRecent(cfg, log, { limit = 10 } = {}) {
  const { log: logPath } = memoryPaths(cfg)
  if (logPath === '') return []
  const cap = Math.max(1, Math.min(100, Math.trunc(limit) || 10))
  try {
    const text = await fsp.readFile(logPath, 'utf8').catch(() => '')
    if (!text) return []
    const lines = text.split(/\r?\n/u).filter((l) => l.trim() !== '')
    return lines.slice(-cap).reverse().map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch (error) {
    log?.('warn', `记忆日志读取失败：${error?.message ?? error}`)
    return []
  }
}

/** 读偏好。 */
async function readPreferences(cfg, log) {
  const { pref: prefPath } = memoryPaths(cfg)
  if (prefPath === '') return {}
  try {
    const text = await fsp.readFile(prefPath, 'utf8').catch(() => '')
    if (!text) return {}
    const obj = JSON.parse(text)
    return obj && typeof obj === 'object' ? obj : {}
  } catch (error) {
    log?.('warn', `偏好文件读取失败：${error?.message ?? error}`)
    return {}
  }
}

/** 写偏好（全量覆盖、合并传入对象）。 */
async function writePreferences(cfg, log, patch) {
  const { pref: prefPath } = memoryPaths(cfg)
  if (prefPath === '') return { ok: false, reason: 'outputDir not configured' }
  try {
    const current = await readPreferences(cfg, log)
    const next = { ...current, ...(patch ?? {}) }
    await fsp.mkdir(path.dirname(prefPath), { recursive: true })
    await fsp.writeFile(prefPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { ok: true, value: next }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 提交一个辅助工作流并把成品保存到输出目录（与 runDraw 的落盘逻辑同源）。
 * @returns {{path, width, height, seconds, files}}
 */
async function submitAndSave(cfg, log, signal, workflow, { prefix = 'aux', onTick } = {}) {
  const promptId = await submitPrompt(cfg, workflow, signal)
  const started = Date.now()
  const images = await waitForResult(cfg, promptId, {
    signal,
    timeoutMs: cfg.timeoutMs,
    onTick: (note) => { if (onTick) onTick(note); log('info', `辅助任务 ${promptId} ${note}`) },
  })
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))
  await fsp.mkdir(cfg.outputDir, { recursive: true })
  const saved = []
  let firstPath = ''
  let w = 0
  let h = 0
  let idx = 0
  for (const image of images) {
    idx += 1
    const bytes = await fetchImageBytes(cfg, image, signal)
    const actual = readPngSize(bytes)
    if (actual) { w = actual.width; h = actual.height }
    const fn = `${prefix}_${cfg.filePrefix}_${w}x${h}_${String(idx).padStart(2, '0')}.png`
    const target = await uniquePath(cfg.outputDir, fn)
    await fsp.writeFile(target, bytes)
    saved.push(target)
    if (firstPath === '') firstPath = target
    log('info', `辅助任务落盘 ${target}（${bytes.length} 字节）`)
  }
  if (firstPath === '') throw new Error('辅助任务报告成功，但没有取到任何图片')
  return { path: firstPath, width: w, height: h, seconds, files: saved }
}

/**
 * ★★★ 2026-10-12（用户要求「分块放大」）：把已有图片超分。
 *
 * · 默认引擎 **VOSR2**（一步 1.4B，已随插件装好，本地 `models/vosr2/VOSR2`）。
 * · 也可选 **RealESRGAN**（需自己在 `models/upscale_models` 放 .pth）。
 * · 跑之前先 `freeComfyModels` 把主千问卸下（避免双占显存）。
 * · 引擎/权重缺失 → 返回**明确的可照做指引**，绝不自动下载大模型。
 * ⚠ 只处理"放大"这一件事，不动主模型链路；纯本地、不出网。
 */
/**
 * ★★★ 2026-10-13（用户反馈）：把**放大逻辑**抽成可复用函数。
 *
 * 两条调用路径共用它：
 *   ① `upscale_image` 工具（用户手动放大）
 *   ② 「生成后自动放大」（`upscaleAfter`，一键出 2K）
 *
 * ⚠ 为什么必须抽出来而不是抄第二份：两份节点图会分叉 ——
 *   出现"工具能放大、串联却报节点缺失"这种最难查的 bug。
 *   共用一条路径，串联能用 == 工具能用。
 */
async function runUpscaleFile(cfg, log, signal, {
  image, scale = 2, upscaler = 'auto', model = '', tileSize = 512, vaeTileSize = 1024,
} = {}) {
  if (String(image ?? '').trim() === '') {
    throw new Error('image 不能为空：请给要放大的图片的本地路径。')
  }
  const sc = Number.isFinite(scale) ? Math.max(2, Math.min(16, Math.trunc(scale))) : 2
  await ensureComfyUp(cfg, log, signal)
  // ★ 分阶段：先卸主模型，再上放大模型（用户硬约束，避免双占显存）
  await freeComfyModels(cfg, signal)
  const vosr = await getNodeSchema(cfg, 'VOSR2ModelLoader', signal)
  const realesr = await getNodeSchema(cfg, 'UpscaleModelLoader', signal)
  const useVosr2 = upscaler === 'vosr2' || (upscaler === 'auto' && vosr.state === 'ok')
  let workflow
  let engineLabel
  if (useVosr2) {
    if (vosr.state !== 'ok') {
      throw new Error('VOSR2 节点（VOSR2ModelLoader）未安装。请用 ComfyUI 管理器装 ComfyUI-VOSR2，'
        + '或在界面上把 upscaler 选成 realesrgan。')
    }
    const models = nodeFileList(vosr.node, 'model')
    const m = (typeof model === 'string' && model.trim() !== '' && models.includes(model.trim()))
      ? model.trim()
      : (models.includes('VOSR2') ? 'VOSR2' : models[0])
    if (!m) {
      throw new Error('没找到 VOSR2 模型包（应在 models/vosr2/ 下有 VOSR2 文件夹）。'
        + '请按 ComfyUI-VOSR2 的指引放置模型，或改用 RealESRGAN。')
    }
    const ref = await uploadReference(cfg, image, signal)
    workflow = {
      1: { class_type: 'VOSR2ModelLoader', inputs: { model: m, dtype: 'default' } },
      2: { class_type: 'LoadImage', inputs: { image: ref } },
      3: {
        class_type: 'VOSR2Upscale',
        inputs: {
          model: ['1', 0], image: ['2', 0], upscale: sc, seed: 42,
          color_alignment: 'wavelet', tile_size: tileSize, tile_overlap: 32,
          vae_tile_size: vaeTileSize, vae_tile_overlap: 32,
        },
      },
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: `VOSR2_${cfg.filePrefix}_` } },
    }
    engineLabel = 'VOSR2'
  } else {
    if (realesr.state !== 'ok') {
      throw new Error('RealESRGAN 节点（UpscaleModelLoader）未安装，且 VOSR2 也不可用。'
        + '请在 models/upscale_models 放入 RealESRGAN 权重并装好 ComfyUI 自带的 UpscaleModelLoader，或改用 VOSR2。')
    }
    const models = nodeFileList(realesr.node, 'model_name')
    const m = (typeof model === 'string' && model.trim() !== '' && models.includes(model.trim()))
      ? model.trim()
      : (models[0] ?? null)
    if (!m) {
      throw new Error('没找到 RealESRGAN 放大模型（应在 models/upscale_models 下有 .pth 文件，如 RealESRGAN_x4plus.pth）。'
        + '请放入权重，或改用 VOSR2。')
    }
    const ref = await uploadReference(cfg, image, signal)
    workflow = {
      1: { class_type: 'UpscaleModelLoader', inputs: { model_name: m } },
      2: { class_type: 'LoadImage', inputs: { image: ref } },
      3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['1', 0], image: ['2', 0] } },
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: `RealESRGAN_${cfg.filePrefix}_` } },
    }
    engineLabel = 'RealESRGAN'
  }
  log('info', `提交放大任务 ${engineLabel} ×${sc} 分块=${tileSize}/${vaeTileSize}`)
  const value = await submitAndSave(cfg, log, signal, workflow, { prefix: 'upscale' })
  return { ...value, upscaler: engineLabel, scale: sc }
}

function makeUpscaleTool(cfg, log) {
  return {
    name: 'upscale_image',
    description:
      '把一张已有图片放大（超分辨率）。默认用 VOSR2（一步 1.4B，已随插件装好）做分块放大，支持 2–16 倍；'
      + '若你另装了 RealESRGAN 也可选它。放大前会先把主千问模型从显存卸下（避免与主模型同时占用显存），'
      + '放大结束后再由下次出图自动重新加载。纯本地、不出网、不需要任何 API Key。'
      + '当有人要"把图放大 / 提高分辨率 / 超分 / 2x / 4x / 放大这张图"时用它。'
      + '需要给图片的本地绝对路径；放大引擎缺失时会明确告诉你怎么装，不会擅自下载。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '要放大的图片的本地绝对路径。' },
        scale: { type: 'integer', description: '放大倍数，默认 4，范围 2–16。VOSR2 训练支持到 16x，但高于约 4x 质量不保证。' },
        upscaler: {
          type: 'string',
          enum: ['auto', 'vosr2', 'realesrgan'],
          description: '放大引擎：auto 优先 VOSR2（已装），否则 RealESRGAN；vosr2 强制 VOSR2；realesrgan 强制 RealESRGAN。',
        },
        model: { type: 'string', description: '可选：指定具体的放大模型文件名（覆盖默认挑选）。不懂就留空。' },
        tile_size: { type: 'integer', description: 'VOSR2 的 DiT 像素分块大小，默认 512；放大后超过 512px 必须分块，否则画质下降。0=不分块。' },
        vae_tile_size: { type: 'integer', description: 'VOSR2 的 VAE 分块大小，默认 1024；输出远超 1024px 时建议设置以防 OOM。0=不分块。' },
      },
      required: ['image'],
    },
    timeoutMs: cfg.timeoutMs,
    // ★ 同样要满足 DSH 的 output 契约（见 makeAccelTool 注释）
    output: {
      schema: { type: 'object', additionalProperties: true, description: '放大结果：保存路径、尺寸、倍数、引擎。' },
      render: (_args, v) => [{
        type: 'text',
        text: `已放大（${v.upscaler ?? ''} ×${v.scale ?? ''}）：${v.path}（${v.width}x${v.height}，用时 ${v.seconds}s）`,
      }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      // ★ 2026-10-13：放大逻辑已抽到 `runUpscaleFile` —— 与「生成后自动放大」
      //   共用**同一条**节点图路径，避免"工具能放大、串联却报节点缺失"的分叉。
      return await runUpscaleFile(cfg, log, signal, {
        image: String(args?.image ?? '').trim(),
        scale: Number.isFinite(args?.scale) ? Math.trunc(args.scale) : 4,
        upscaler: args?.upscaler === 'realesrgan' ? 'realesrgan'
          : (args?.upscaler === 'vosr2' ? 'vosr2' : 'auto'),
        model: typeof args?.model === 'string' ? args.model.trim() : '',
        tileSize: Number.isFinite(args?.tile_size) ? Math.max(0, Math.trunc(args.tile_size)) : 512,
        vaeTileSize: Number.isFinite(args?.vae_tile_size) ? Math.max(0, Math.trunc(args.vae_tile_size)) : 1024,
      })
    },
  }
}

/**
 * ★★★ 2026-10-12（用户要求「局部重绘」）：用主千问模型 + InstantX Inpainting ControlNet 改图。
 *
 * ## 关键设计
 *   · **复用主模型本身**（UNET/CLIP/VAE 直接吃主链路的文件），所以**不**调 freeComfyModels ——
 *     局部重绘不是"另装一份小模型"，而是主模型 + 一个轻量 ControlNet 的官方用法，
 *     与主模型同时在线恰恰是正确的、不会双占一份大模型。用户那条"小模型别和主模型同时加载"
 *     约束针对的是 VOSR2 / 独立 edit 模型这类**与主模型等量级的额外大模型**，本工具不涉及。
 *   · 唯一额外依赖是 **ControlNet 权重** `Qwen-Image-InstantX-ControlNet-Inpainting.safetensors`
 *     （放 models/controlnet/）。它**不在**插件里、也**不自动下载** —— 缺失时返回明确指引。
 *   · 蒙版（mask）必填：白=要重绘、黑=保留，局部重绘靠它定位区域。
 */
function makeEditTool(cfg, log) {
  return {
    name: 'inpaint_image',
    description:
      '局部重绘 / 图片编辑：给一张图 + 一句编辑指令 + 一张蒙版（白=要改、黑=保留），'
      + '用本机主千问模型 + Qwen-InstantX Inpainting ControlNet 只重绘蒙版区域。'
      + '需要额外装 ControlNet 权重（Qwen-Image-InstantX-ControlNet-Inpainting.safetensors）放到 models/controlnet/；'
      + '未装时本工具会明确告诉你怎么装，**不会自己下载**。纯本地、不出网。'
      // ★★★ 2026-10-16（真实用户反馈）：把兼容性讲在**动手之前** —— 用户原话是
      //   "建议插件在选择权重时做架构检测并明示'仅支持 1.0'，而不是让用户装完才发现"。
      + '⚠ **兼容性重要提示**：InstantX 公开的 Qwen ControlNet 权重是给 **Qwen-Image 1.0** 的'
      + '（latent 16 通道），而本插件默认底模是 **2.1**（latent 64 通道）—— 两者**不兼容**，'
      + '用 1.0 的权重跑 2.1 底模会在 ComfyUI 执行层报错。'
      + '本工具会尝试读取权重文件的形状做提示；若提示不兼容，请换用 2.1 对应的 ControlNet，'
      + '或把底模切到 1.0。'
      + '当有人要"局部修改这张图 / 只改这块区域 / 把背景换成… / 局部重绘 / 去个水印/物体"时用它。'
      + 'image / prompt / mask 三个都要给（mask 是本地绝对路径的蒙版图）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: '要编辑的图片的本地绝对路径。' },
        prompt: { type: 'string', description: '编辑指令，描述你希望蒙版区域变成什么（例如"把帽子换成红色"）。' },
        mask: { type: 'string', description: '蒙版图片的本地绝对路径：白色=要重绘的区域，黑色=保留。必须提供。' },
        seed: { type: 'integer', description: '随机种子，不填随机。' },
        denoise: { type: 'number', description: '重绘幅度 0.1–1.0，默认 1.0（完全重绘蒙版区）。' },
      },
      required: ['image', 'prompt', 'mask'],
    },
    timeoutMs: cfg.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: true, description: '重绘结果：保存路径、尺寸、种子。' },
      render: (_args, v) => [{
        type: 'text',
        text: `已局部重绘：${v.path}（${v.width}x${v.height}，seed ${v.seed}，用时 ${v.seconds}s）`,
      }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const image = String(args?.image ?? '').trim()
      const prompt = String(args?.prompt ?? '').trim()
      const mask = String(args?.mask ?? '').trim()
      if (image === '') throw new Error('image 不能为空：请给要编辑的图片的本地路径。')
      if (prompt === '') throw new Error('prompt 不能为空：描述你希望蒙版区域变成什么。')
      if (mask === '') throw new Error('mask 不能为空：局部重绘需要一张蒙版（白=要改、黑=保留）。')
      const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
      const denoise = Number.isFinite(args?.denoise) ? Math.min(1, Math.max(0.1, args.denoise)) : 1.0
      await ensureComfyUp(cfg, log, signal)
      // ★ 探测依赖节点 + ControlNet 权重（问 ComfyUI 本人，不猜文件名）
      const cnetLoader = await getNodeSchema(cfg, 'ControlNetLoader', signal)
      const cnetApply = await getNodeSchema(cfg, 'ControlNetInpaintingAliMamaApply', signal)
      if (cnetApply.state !== 'ok') {
        throw new Error('缺少 ControlNet 应用节点（ControlNetInpaintingAliMamaApply）。'
          + '请确认 ComfyUI 自带节点或 ComfyUI-InstantX-Utils / ComfyUI-Inpainting 已安装。')
      }
      if (cnetLoader.state !== 'ok') {
        throw new Error('缺少 ControlNetLoader 节点（ComfyUI 自带）。请确认 ComfyUI 完整安装。')
      }
      const cnetOpts = nodeFileList(cnetLoader.node, 'control_net_name')
      const wantCnet = 'Qwen-Image-InstantX-ControlNet-Inpainting.safetensors'
      const cnetName = cnetOpts.includes(wantCnet)
        ? wantCnet
        : (cnetOpts.find((o) => /instantx.*inpaint|inpaint.*instantx|qwen.*inpaint/i.test(o)) ?? null)
      if (!cnetName) {
        throw new Error(
          `局部重绘需要 ControlNet 权重「${wantCnet}」，但 models/controlnet 下没有`
          + `（现有：${cnetOpts.slice(0, 6).join('、') || '空'}）。\n`
          + '请把它下载到 models/controlnet/ 后重试：'
          + 'https://huggingface.co/Comfy-Org/Qwen-Image-InstantX-ControlNets/tree/main\n'
          + '（本工具不自动下载该权重。）',
        )
      }
      // ★ 复用主模型当前文件（避免再装一份大模型；主模型多半已加载）
      const caps = await probeCapabilities(cfg, log, signal).catch(() => null)
      const unet = caps?.models?.unet || cfg.unet || 'qwen_image_2.1_int8_convrot.safetensors'
      const clip = caps?.models?.clip || cfg.clip || 'qwen3vl_8b_w4a8.safetensors'
      const vae = caps?.models?.vae || cfg.vae || 'qwen_image_2.1_vae_bf16.safetensors'

      // ★★★ 2026-10-16（真实用户反馈）：**动手之前**先把"权重与底模可能不兼容"讲清楚。
      //   用户实测：InstantX 公开的 Qwen ControlNet 是给 **1.0** 的（latent 16ch），
      //   而这里用的底模是 **2.1**（64ch）⇒ 在 ComfyUI 执行层 unpack 崩。
      //   用户原话："建议插件在选择权重时做架构检测并明示'仅支持 1.0'，
      //   而不是让用户装完才发现。"
      //
      //   ⚠ 保守设计：只在**明确只见到 16、没见到 64** 时才警告（`looksLikeQwenImage10ControlNet`）。
      //     读不出文件、或两种通道都见到 → **不吭声**。宁可漏报，绝不误报。
      //     16/64 阈值来自用户实测，本机无该权重、无法独立验证（见 config.js 注释）。
      try {
        const mainPy = String(cfg.comfyMainPy ?? '')
        if (mainPy !== '') {
          const cnetPath = path.join(path.dirname(mainPy), 'models', 'controlnet', cnetName)
          const inCh = await readSafetensorsConvInChannels(cnetPath)
          if (looksLikeQwenImage10ControlNet(inCh)) {
            log('warn', `⚠ ControlNet 权重「${cnetName}」疑似 **Qwen-Image 1.0** 版本`
              + '（卷积输入通道只见 16、未见 64），与当前底模'
              + `「${unet}」**不兼容** —— 执行时大概率在 ComfyUI 里报形状/unpack 错误。`
              + '请换用 2.1 对应的 ControlNet 权重，或把底模切到 1.0。')
          }
        }
      } catch { /* 探测失败不影响主流程 */ }

      // 读原图最长边作为 TextEncode 的 resolution 提示
      let res = 1024
      try {
        const b = await fsp.readFile(image)
        const s = readPngSize(b)
        if (s) res = r32(Math.max(s.width, s.height))
      } catch { /* 读不到就用默认 1024 */ }
      const imgRef = await uploadReference(cfg, image, signal)
      const maskRef = await uploadReference(cfg, mask, signal)
      const workflow = {
        1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
        2: { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'qwen_image', device: 'default' } },
        3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
        // ★★★ 2026-10-16 修致命 bug（真实用户反馈 + 本机 ComfyUI 源码核实）：
        //   ① `LoadImage` 的必需输入名是 **`image`**，不是 `upload`。
        //      依据：ComfyUI `nodes.py` 的 `LoadImage.INPUT_TYPES` →
        //      `{"required": {"image": (sorted(files), {"image_upload": True})}}`
        //      （早先这里写成 `upload` ⇒ 节点校验必失败，局部重绘一执行就崩。）
        //   ② `LoadImageMask` 除 `image` 外**还必需 `channel`**。
        //      依据：`nodes.py` 的 `LoadImageMask.INPUT_TYPES` 在父类基础上追加
        //      `"channel": (["alpha","red","green","blue"],)`。
        //      `'red'` 这个取值取自 ComfyUI 官方 blueprint
        //      「Image Inpainting (Qwen-image).json」里 `ImageToMask` 的 channel。
        //      （黑白蒙版图的 R/G/B 三通道相同，取 red 即等价。）
        4: { class_type: 'LoadImage', inputs: { image: imgRef } },
        5: { class_type: 'LoadImageMask', inputs: { image: maskRef, channel: 'red' } },
        6: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['3', 0] } },
        7: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['6', 0], mask: ['5', 0] } },
        8: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: '', resolution: res } },
        9: { class_type: 'ControlNetLoader', inputs: { control_net_name: cnetName } },
        10: {
          class_type: 'ControlNetInpaintingAliMamaApply',
          // ★★★ 2026-10-16 修致命 bug：`strength` / `start_percent` / `end_percent`
          //   是**必需输入**（`execute()` 按位置接收），早先漏传 ⇒ 节点校验必失败。
          //   依据：`comfy_extras/nodes_controlnet.py` 的 `define_schema()`：
          //     io.Float.Input("strength",      default=1.0, min=0.0, max=10.0)
          //     io.Float.Input("start_percent", default=0.0, min=0.0, max=1.0, advanced=True)
          //     io.Float.Input("end_percent",   default=1.0, min=0.0, max=1.0, advanced=True)
          //   取值与官方 blueprint 里该节点的 widget `[1, 0, 1]` 一致。
          inputs: {
            positive: ['8', 0], negative: ['8', 1], control_net: ['9', 0], vae: ['3', 0],
            image: ['4', 0], mask: ['5', 0],
            strength: 1.0, start_percent: 0.0, end_percent: 1.0,
          },
        },
        11: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
        12: {
          class_type: 'KSampler',
          inputs: {
            model: ['11', 0], positive: ['10', 0], negative: ['10', 1], latent_image: ['7', 0],
            seed, steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise,
          },
        },
        13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
        14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: `Inpaint_${cfg.filePrefix}_` } },
      }
      log('info', `提交局部重绘 unet=${unet} cnet=${cnetName} steps=4 cfg=1 denoise=${denoise}`)
      const value = await submitAndSave(cfg, log, signal, workflow, { prefix: 'inpaint' })
      return { ...value, seed }
    },
  }
}

/**
 * ★★★ 2026-10-12（用户要求「确认式一键修复」）：只做**可逆 / 无害**的修复动作。
 *
 * ## 为什么"确认式"
 *   第一阶段（confirm≠true）只返回**将要做什么的清单**，不动任何东西；
 *   第二阶段（confirm=true）才真正执行。避免"一键"把环境改坏。
 *
 * ## 为什么只列这几项
 *   都是**可逆 / 无害**的：卸载显存（随时可重载）、补输出目录（创建空目录）、清探测缓存
 *   （下次出图重新探测）。**绝不**自动下载驱动/模型、绝不删文件、绝不改配置 ——
 *   那类"重活"仍由人决定（与本项目"不擅自下大模型"的一贯原则一致）。
 *
 * @returns 预览阶段返回 { needsConfirm:true, plan }；执行阶段返回 { done, summary }
 */
async function runRepair(cfg, log, { confirm, signal } = {}) {
  const plan = [
    { id: 'free', label: '卸载 ComfyUI 已加载的模型、释放显存（可逆：下次出图自动重载）', safe: true },
    { id: 'outputDir', label: `确保输出目录存在：${cfg.outputDir}（创建空目录，无害）`, safe: true },
    { id: 'capCache', label: '清除能力探测缓存（下次出图重新探测节点/模型，可逆）', safe: true },
  ]
  if (confirm !== true) {
    return { action: 'repair', needsConfirm: true, confirm: false, plan, note: '下列操作均为可逆/无害的修复动作，确认后执行。' }
  }
  const done = []
  // ① 卸载显存
  try {
    const okF = await freeComfyModels(cfg, signal)
    done.push({ id: 'free', ok: okF })
  } catch (error) {
    done.push({ id: 'free', ok: false, error: String(error?.message ?? error) })
  }
  // ② 补输出目录
  try {
    await fsp.mkdir(cfg.outputDir, { recursive: true })
    done.push({ id: 'outputDir', ok: true })
  } catch (error) {
    done.push({ id: 'outputDir', ok: false, error: String(error?.message ?? error) })
  }
  // ③ 清探测缓存
  try {
    clearCapabilityCache()
    done.push({ id: 'capCache', ok: true })
  } catch (error) {
    done.push({ id: 'capCache', ok: false, error: String(error?.message ?? error) })
  }
  return {
    action: 'repair',
    confirm: true,
    done,
    summary: `已执行 ${done.filter((d) => d.ok).length}/${done.length} 项修复（均为可逆/无害操作）。`,
  }
}

/**
 * ★★★ 2026-10-12（用户要求「首次使用向导」）：生成一份**可照做的就绪清单**。
 *
 * 纯本机、基于 ComfyUI 真实返回（在线时才探测辅助引擎，离线时如实标"未探到"）。
 * 每项给 ok / 缺失原因 / 怎么修。由状态端点一并下发给前端渲染。
 */
async function buildWizardReport(cfg, log, signal, { online, caps } = {}) {
  const steps = []
  steps.push({
    id: 'comfy',
    label: 'ComfyUI 后端在线',
    ok: online === true,
    detail: online === true ? '已就绪' : '未启动：在状态点菜单里点「启动 ComfyUI」，或手动启动你机器上的 ComfyUI。',
  })
  const mainModel = caps?.models?.unet
  steps.push({
    id: 'main',
    label: '主千问模型可用',
    ok: !!mainModel,
    detail: mainModel ? `当前主模型：${mainModel}` : '未探测到主模型文件（models/unet 或 diffusion_models 下应有 qwen_image_2.1 系列）。',
  })
  let aux = null
  if (online) {
    try { aux = await auxCapabilities(cfg, log, signal) } catch { aux = null }
  }
  const vosrReady = !!aux?.vosr2?.node && (aux?.vosr2?.models?.length ?? 0) > 0
  steps.push({
    id: 'upscale',
    label: '分块放大（VOSR2）可用',
    ok: vosrReady,
    detail: vosrReady
      ? `VOSR2 已就绪（${aux.vosr2.models.join('、')}）`
      : 'VOSR2 节点或模型缺失：用 ComfyUI 管理器装 ComfyUI-VOSR2，并确保 models/vosr2/ 下有模型包（已随插件装好则无需额外操作）。',
  })
  const inpaintReady = !!aux?.inpaint?.applyNode && !!aux?.inpaint?.loaderNode
    && (aux?.inpaint?.controlnets ?? []).some((o) => /instantx.*inpaint|inpaint.*instantx|qwen.*inpaint/i.test(o))
  steps.push({
    id: 'inpaint',
    label: '局部重绘（InstantX Inpainting ControlNet）可用',
    ok: inpaintReady,
    detail: inpaintReady
      ? 'InstantX Inpainting ControlNet 已就绪'
      : '缺 InstantX Inpainting ControlNet 权重：下载 Qwen-Image-InstantX-ControlNet-Inpainting.safetensors 放到 models/controlnet/（本工具不自动下载）。',
  })
  const allOk = steps.every((s) => s.ok)
  return { steps, allReady: allOk, online: online === true }
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
export function diag(tag, detail) {
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

  // ★★★ 2026-10-12（用户要求：允许自选输出目录）**启动时就校验并定死** outputDir。
  //   原来直接拿去用 —— 配错（盘符不存在 / 没写权限 / 路径指到文件）要到**出图那一刻**
  //   才失败，报的还是"写文件失败"这种看不出原因的错。现在启动时校验、明确告知、安全退回。
  //   校验后的绝对路径写回 cfg.outputDir，后面所有用它的地方（落盘、读回、面板显示）就都一致了。
  {
    const r = resolveOutputDir(rawConfig?.outputDir ?? DEFAULTS.outputDir, log)
    cfg.outputDir = r.dir
    cfg.outputDirSource = r.source
    log('info', `输出目录：${r.dir}（${r.source}）`)
    if (r.problem) {
      log('warn', `⚠ 配置里的 outputDir 不可用（${r.problem}）→ 已退回默认目录。`
        + '改好后重开 DSH 即可生效。')
    }
  }

  // ★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）**启动时强制校验 comfyUrl**。
  //
  //   审核机器人指出的核心问题：README 声明"网络仅限 127.0.0.1、不访问外部地址"，
  //   但 apply() 直接把 rawConfig 合并进 cfg，comfyUrl 是个普通可配置项，
  //   代码里**没有任何一处**校验它到底是不是本机 —— 声明与实现不符。
  //
  //   现在：默认只允许回环地址（127.0.0.1 / localhost / ::1 / 0.0.0.0）；
  //   配成局域网/公网地址会**直接拒绝启动**并说明怎么改（fail-fast，
  //   不让配错的地址带着半边功能跑起来、到出图那一刻才莫名失败）。
  //   确实要连远程 ComfyUI 的用户可显式设置 `allowRemoteComfy: true` ——
  //   这是"如实披露可配置的外部端点"，而不是靠改文档掩盖。
  //
  // ★★★ 2026-10-16（第二轮复核整改）：这里扩成**两个独立外部端点**都校验。
  //   审核机器人指出：`hipfireUrl` 是**独立于 comfyUrl 的第二个外部端点**，
  //   上一轮只收口了 comfyUrl，hipfire 那条链路（probeHipfireHttp / generateViaHttp）
  //   仍在直接用可配置地址、不受 allowRemoteComfy 控制。
  {
    const allowRemote = cfg.allowRemoteComfy === true
    // ① 先把开关写进 net-guard 的全局状态：这样**所有**走 guardedFetch / assertLocalUrl
    //    的地方（含 config.js 里 8 处 fetchWithTimeout 调用）自动继承，结构上不可能漏。
    setAllowRemote(allowRemote)
    cfg.netAllowRemote = allowRemote

    // ② 抛错即拒绝启动。这里刻意**不 try/catch 吞掉** —— 静默回退到 127.0.0.1
    //    会让用户以为"配的远端生效了"，实际连的是本机，属于更坏的行为。
    // ★★★ 2026-10-17 修 bug（真机实测发现；**0.17.2 起一直存在**，影响是阻断级的）：
    //   `assertLocalUrl(...).toString()` 会把 `http://127.0.0.1:8188` 规范化成
    //   **带尾斜杠**的 `http://127.0.0.1:8188/`（`new URL()` 把空路径补成 `/`）。
    //   而全代码有 **15 处** `${cfg.comfyUrl}/xxx` 拼接 ⇒ 实际请求变成 `//xxx`。
    //   实测：`GET http://127.0.0.1:8188/system_stats` → **200**，
    //         `GET http://127.0.0.1:8188//system_stats` → **404**（ComfyUI 的 aiohttp 不做合并）。
    //   后果：探活永远失败（界面一直停在"未就绪"）、提交 /prompt、取图 /view 也全 404 ——
    //   等于**整个 ComfyUI 后端不可用**，而界面上只表现为"启动超时 / 没反应"。
    //   ⇒ 这里统一去掉尾斜杠，让 cfg.comfyUrl 保持"可直接拼路径"的形态。
    //   注意只去掉**末尾的** `/`：用户若配了带路径前缀的地址（如 `http://127.0.0.1:8188/comfy`），
    //   `toString()` 本就不会补斜杠，这段替换对它无影响。
    const trimTrailingSlashes = (u) => u.replace(/\/+$/, '')
    cfg.comfyUrl = trimTrailingSlashes(
      assertLocalUrl(cfg.comfyUrl, { allowRemote, what: 'comfyUrl', log }).toString(),
    )
    diag('net', `comfyUrl 通过回环校验：${cfg.comfyUrl}（allowRemoteComfy=${allowRemote}）`)

    // ③ hipfire 后端同样校验。**只在真正用 hipfire 后端时才硬拒绝** ——
    //    否则"配了远端 hipfireUrl 但当前用 comfyui"的用户会被无谓地拦在启动之外。
    //    但即便不硬拒绝，也仍然如实记一条 warn（配置里存在外部端点就是事实）。
    const hipfireUrl = cfg.hipfireUrl
    if (cfg.imageBackend === 'hipfire') {
      cfg.hipfireUrl = trimTrailingSlashes(
        assertLocalUrl(hipfireUrl, { allowRemote, what: 'hipfireUrl', log }).toString(),
      )
      diag('net', `hipfireUrl 通过回环校验：${cfg.hipfireUrl}（allowRemoteComfy=${allowRemote}）`)
    } else {
      try {
        assertLocalUrl(hipfireUrl, { allowRemote: false, what: 'hipfireUrl' })
      } catch (error) {
        // 当前不用 hipfire，所以不阻断启动；但要让用户知道"一旦切到 hipfire 就会被拦"。
        log('warn', `配置里的 hipfireUrl 不是本机地址，且当前 imageBackend=${cfg.imageBackend}。`
          + '一旦切到 hipfire 后端，插件会拒绝启动。详见下方原因：')
        log('warn', String(error?.message ?? error))
      }
    }
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

    // ★★★ 2026-10-12（用户要求「分块放大 / 局部重绘」）：注册两个辅助工具。
    //   它们都遵循 output 契约、且缺失依赖时给明确指引、绝不自动下大模型。
    step('register.upscale_image', () => {
      const upscaleTool = makeUpscaleTool(cfg, log)
      ctx.tools.register(upscaleTool)
      log('info', `已注册工具 ${upscaleTool.name}（放大前会先卸载主模型以释放显存）`)
    })
    step('register.inpaint_image', () => {
      const editTool = makeEditTool(cfg, log)
      ctx.tools.register(editTool)
      log('info', `已注册工具 ${editTool.name}（复用主模型 + InstantX Inpainting ControlNet）`)
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
          // ★★★ 2026-10-16（DSH STORE AUTH001 整改）：**GET 只读、写参数一律走 POST JSON**。
          //
          //   审核原话：*"同文件 3715-3777 的状态 GET 处理器修改运行配置，部分选项还写 UI 状态。
          //   …让状态 GET 保持只读，写配置移到显式 POST JSON。"*
          //   确实如此 —— 之前所有开关/档位/目录/启动都是**GET 带 query** 就能改配置，
          //   而"有副作用的 GET"正是 CSRF 的经典载体（CORS 挡不住它）。
          //
          //   现在：`queryLc` 这张表**只从 POST 的 JSON body 填充**；
          //   GET 时它是空的 ⇒ 下面所有写分支自然全部失效（**无需逐个改**）。
          //   GET 若携带任何非只读参数，直接 405 并提示改用 POST —— 明确拒绝，不静默忽略。
          const method = String(req.method ?? 'GET').toUpperCase()
          const isWriteReq = method === 'POST'
          /** GET 允许携带的**只读**参数（其余任何参数一律拒绝，强制走 POST）。 */
          const READ_ONLY_PARAMS = new Set(['ping'])
          const queryLc = new Map()
          if (isWriteReq) {
            // ★★★ 2026-10-17（AUTH001 收尾）：**先过方法与媒体类型守卫**，再读 body。
            //   审核指出状态 POST 原先不检查 `application/json` —— 那样 `text/plain` 的
            //   "简单请求"（跨站表单能发、不触发预检）也能把 JSON 塞进来。现在不通过就 415。
            if (!guardWriteRequest(req, res)) return
            const body = await readJsonBody(req)
            if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
              for (const [bk, bv] of Object.entries(body)) {
                queryLc.set(String(bk).toLowerCase(), String(bv))
              }
            }
          } else {
            const offending = [...query.searchParams.keys()]
              .filter((qk) => !READ_ONLY_PARAMS.has(qk.toLowerCase()))
            if (offending.length > 0) {
              respondJson(res, {
                ok: false,
                reason: '写操作必须用 POST + JSON body（状态 GET 已改为只读）',
                offending,
                hint: 'POST /api/qwen-paint/status.json  {"<参数名>": "<值>"}',
              }, 405)
              return
            }
          }
          const rawMinutes = queryLc.get('idleminutes')
          if (rawMinutes !== undefined) {
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
          const rawStyle = queryLc.get('flowstyle')
          if (rawStyle !== undefined) {
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
          const rawTrigger = queryLc.get('drawtrigger')
          if (rawTrigger !== undefined) {
            if (Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, rawTrigger)) {
              cfg.drawTrigger = rawTrigger
              writeUiState({ ...readUiState(), drawTrigger: rawTrigger }, log)
              log('info', `生图判断策略已改为 ${rawTrigger}（需重载插件后生效）`)
            } else {
              log('warn', `生图判断策略取值不在白名单里，已忽略：${String(rawTrigger).slice(0, 40)}`)
            }
          }

          // ★★★ 2026-10-12（用户要求「预设工作流」）：界面菜单点一下设默认预设。
          //   与 flowStyle 同一套：写进 uiState（重启也记得住），但真正生效是"下次出图"
          //   经 draw_image 的 preset 参数 / cfg.preset 接管（不覆盖用户显式 size/megapixels）。
          const rawPreset = queryLc.get('preset')
          if (rawPreset !== undefined) {
            if (['default', 'portrait', 'anime', 'wallpaper'].includes(rawPreset)) {
              cfg.preset = rawPreset
              writeUiState({ ...readUiState(), preset: rawPreset }, log)
              log('info', `出图预设已改为 ${rawPreset}`)
            } else {
              log('warn', `出图预设取值不在白名单里，已忽略：${String(rawPreset).slice(0, 40)}`)
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
          if (queryLc.get('start') === '1') {
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
          const blockCacheParam = String(queryLc.get('blockcache') ?? '').toLowerCase()
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

          // ★★★ 2026-10-12（用户要求）：`?fast4=on|off` —— 界面上的「极速档（4 步）」开关。
          //   与 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //
          //   ⚠ 护栏：**探测不到 4 步 LoRA 时，在服务端就拒绝打开** ——
          //     面板虽然会把开关置灰，但端点自己也必须有护栏：否则一个手拼的 URL
          //     就能把链路切成 4 步，而机器上根本没有那个权重 ⇒ 每次出图都被
          //     ComfyUI 以 `value not in list` 拒收。这与 SageAttention 那条同一条原则。
          //   ⚠ 这里再调一次 probeCapabilities 是**便宜**的：它有 10 分钟缓存，
          //     而且只在真的带了 fast4 参数时才走到（普通轮询不受影响）。
          const fast4Param = String(queryLc.get('fast4') ?? '').toLowerCase()
          if (fast4Param === 'on' || fast4Param === 'off') {
            const want = fast4Param === 'on'
            if (want) {
              const capsNow = await probeCapabilities(cfg, log, undefined).catch(() => null)
              if (!capsNow?.models?.fast4Lora) {
                log('warn', '界面想打开「极速档（4 步）」，但 loras 目录里没找到 4 步蒸馏 LoRA → 已拒绝。'
                  + '把 4 步 LoRA 放进 models\\loras 后开关才可用。')
              } else if (cfg.fast4Enabled !== true) {
                cfg.fast4Enabled = true
                log('info', `界面打开了「极速档（4 步）」→ 下次出图走 4 步 / CFG 1.0 / 位移 ln3`
                  + `（LoRA=${capsNow.models.fast4Lora}）。`
                  + '⚠ 不适用于有文字的情形：画面里有中文/英文时文字会崩坏。')
              }
            } else if (cfg.fast4Enabled !== false) {
              cfg.fast4Enabled = false
              log('info', '界面关闭了「极速档（4 步）」→ 回到 8 步（画质更好，文字能正常渲染）')
            }
          }

          // ★★★ 2026-10-12（用户要求）：**在界面上直接改输出目录**。
          //   `?outputDir=<url编码的路径>` —— 空值 = 恢复默认。
          //   ⚠ 校验与 apply() 那一步**完全同一套**（resolveOutputDir），
          //     避免"端点收下、下次启动又判非法"的两套标准。
          const wantDir = queryLc.get('outputdir')
          if (wantDir !== undefined) {
            const r = resolveOutputDir(wantDir, log)
            if (r.problem) {
              log('warn', `界面想把输出目录改成「${wantDir}」，但不可用（${r.problem}）→ 未采用`)
            } else if (r.dir === cfg.outputDir) {
              log('info', `界面设置输出目录：与当前一致（${r.dir}）`)
            } else {
              cfg.outputDir = r.dir
              cfg.outputDirSource = r.source
              log('info', `界面把输出目录改成了：${r.dir}（${r.source}）`)
            }
          }

          const busy = online ? await status.queueBusy() : false

          // ★★★ 2026-10-11 新增：**A 卡专属优化（可选）的两个开关** ——
          //   `?amdkernel=on|off` / `?asyncoffload=on|off`。
          //   与上面的 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //   ⚠ 但这两个是**启动参数** ⇒ 要等**下次启动 ComfyUI** 才真正起作用 ——
          //     面板的 hint 里已经写明，用户不会以为是"点了没反应"。
          // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码**的开关。
          //   ⚠ 它是**三态枚举**（`auto` / `on` / `off`），**不是布尔** —— 不能走下面那条
          //     `cfg[key] = want` 的通用分支（那会把它写成 `true`/`false`，判据直接废掉）。
          //   语义（面板开关只有两态，所以在这里映射）：
          //     开 → 回到**推荐档** `auto`（只在"显存 < 16 GB 且出图 > 1024²"时分块）；
          //     关 → `off`。
          //   ⚠ 想"所有尺寸都强制分块"请**显式写配置** `vaeTiling: 'on'` —— 面板不提供这一档，
          //     因为它不是常用选择，而误开会让小图也走分块（多花时间、无收益）。
          {
            const v = String(queryLc.get('vaetiling') ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const next = v === 'on' ? (cfg.vaeTiling === 'on' ? 'on' : 'auto') : 'off'
              if (cfg.vaeTiling !== next) {
                cfg.vaeTiling = next
                log('info', `界面把「VAE 大图分块解码」切成了 ${next}`
                  + '（工作流节点，**下次出图**即生效，不用重启 ComfyUI）')
              }
            }
          }

          for (const [param, key, label] of [
            ['amdkernel', 'amdKernel', 'A 卡专属内核'],
            ['asyncoffload', 'amdAsyncOffload', 'A 卡异步卸载'],
            // ★ 2026-10-11：N 卡 SageAttention（三档，这里是 true/false 两档）
            ['sagesa', 'nvidiaSageAttention', 'N 卡 SageAttention'],
            // ★★★ 2026-10-12：macOS / MPS 的两个开关（见 DEFAULTS 的说明）。
            //   ⚠ 它们也是**启动期生效**（注入给 ComfyUI 进程的环境变量）⇒ 需重启 ComfyUI。
            ['applempsfallback', 'appleMpsFallback', 'MPS 算子回退兜底'],
            ['applempsunlimited', 'appleMpsUnlimitedMem', 'MPS 取消显存水位上限'],
            // ★★★ 2026-10-12（用户反馈）：Spectrum 跳步加速（**布尔**，走通用分支即可）
            ['spectrum', 'spectrumEnabled', 'Spectrum 跳步加速'],
            // ★★★ 2026-10-13 补（**真 bug**：面板有开关、端点不认 = 假开关）：
            //   describeOptimization 里已经给了 `key:'sada'` / `key:'oom'` 两个可点开关，
            //   但端点这份**白名单**里没有它们 ⇒ 点了之后 URL 参数被静默忽略，
            //   界面刷新又弹回原值 —— 典型的"面板说一套、实际跑另一套"。
            //   ⇒ 面板每加一个开关，端点白名单**必须同步加一行**。
            ['sada', 'sadaEnabled', 'SADA 跳步采样'],
            ['oom', 'oomAutoFallback', 'OOM 自动回退'],
          ]) {
            const v = String(queryLc.get(param.toLowerCase()) ?? '').toLowerCase()
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
              // ★★★ 2026-10-12 加固：MPS 的两个开关**只在 macOS 上有意义**
              //   （PyTorch 的 MPS 后端在其它平台根本不存在）。
              //   非 Mac 上直接拒绝，而不是"改了个什么都不会发生的值"。
              if ((key === 'appleMpsFallback' || key === 'appleMpsUnlimitedMem') && !IS_MAC) {
                log('warn', `界面想改「${label}」，但当前平台是 ${process.platform}`
                  + '（不是 macOS）→ 已拒绝：MPS 环境变量在其它平台没有对应后端。')
                continue
              }
              if (cfg[key] !== want) {
                cfg[key] = want
                log('info', `界面把「${label}」切成了 ${want ? '开' : '关'}（启动期生效，重启 ComfyUI 后生效）`)
              }
            }
          }

          // ★★★ 2026-10-14（C1/C2/C5「专业卡版」）：**枚举型档位**参数。
          //   ⚠ 为什么单独一段：开关是 on/off 二值，而档位是**多选一** ——
          //     塞进上面的布尔循环会被静默忽略（"面板有下拉、端点不认"= 假控件）。
          //   ⚠ 服务端**必须校验取值**（白名单），否则手拼 URL 就能把 cfg 写成任意值。
          for (const [param, key, label, allowed] of [
            ['vrammode', 'vramMode', '显存/内存档位', VRAM_MODES],
            ['precision', 'precisionTier', '模型精度档', PRECISION_TIERS],
            ['textctl', 'textControl', '文本控制档', TEXT_CONTROL_MODES],
          ]) {
            const raw = String(queryLc.get(param.toLowerCase()) ?? '').toLowerCase()
            if (raw === '') continue
            if (!allowed.includes(raw)) {
              log('warn', `界面想改「${label}」为「${raw}」，但不在合法取值（${allowed.join('/')}）内 → 已拒绝`)
              continue
            }
            if (cfg[key] !== raw) {
              cfg[key] = raw
              log('info', `界面把「${label}」切成了 ${raw}`
                + (key === 'vramMode' ? '（启动参数，**重启 ComfyUI** 后生效）'
                  : '（工作流参数，**下次出图**即生效）'))
            }
          }

          // ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（主模型 / LoRA / ControlNet）。
          //   ⚠ 校验是**动态白名单** —— 值必须出现在 ComfyUI **实时探测到的**模型清单里。
          //     否则一个手拼的 URL 就能把任意路径塞进工作流（这是**安全**问题，不只是体验）。
          //   ⚠ 空串是合法值 = 清除覆写（回到插件自动挑）。
          if (['unet', 'lora', 'controlnet'].some((p) => queryLc.has(p))) {
            let wf = null
            try {
              const caps = await probeCapabilities(cfg, log, null)
              wf = caps?.files ?? null
            } catch (error) {
              log('warn', `权重清单探测失败 → 本次拒绝改权重：${error?.message ?? error}`)
            }
            for (const [param, key, label, listsOf] of [
              // ⚠ 参数名必须与面板里 weights 的 `key` **逐字一致**（mainmodel / lorapick / cnetpick），
              //   否则下拉发了 `?lorapick=` 而这里等的是 `lora` ⇒ 被静默忽略 = 假控件。
              //   （这一条正是 `_opt_status_test` 的"每个开关 key 端点都认"抓出来的。）
              ['mainmodel', 'mainModelOverride', '主模型', () => [wf?.unet, wf?.unetGguf]],
              ['lorapick', 'loraOverride', 'LoRA', () => [wf?.lora]],
              ['cnetpick', 'controlnetOverride', 'ControlNet', () => [wf?.controlnet]],
            ]) {
              if (!queryLc.has(param)) continue
              const val = String(queryLc.get(param) ?? '')
              if (val === '') {
                if (cfg[key] !== '') {
                  cfg[key] = ''
                  log('info', `界面清除了「${label}」覆写（回到自动挑）`)
                }
                continue
              }
              const allowed = (listsOf() ?? []).filter((l) => Array.isArray(l)).flat()
              if (wf === null || allowed.length === 0 || !allowed.includes(val)) {
                log('warn', `界面想选「${label}」=「${val}」，但它**不在 ComfyUI 的模型清单里** → 已拒绝`)
                continue
              }
              if (cfg[key] !== val) {
                cfg[key] = val
                log('info', `界面把「${label}」切成了 ${val}（工作流参数，**下次出图**即生效）`)
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
              // ★★★ 2026-10-17（AUTH001 收尾）：**状态 GET 不得改配置**。
              //
              //   审核原话：*"4242 的状态 GET 故障分支仍调用 `recoverFromSageCrash`，
              //   642-644 会把 `cfg.nvidiaSageAttention` 改为 false。请把配置恢复放到
              //   **后台生命周期或显式写操作**，GET 只展示状态。"*
              //
              //   确实如此 —— 这和刚改掉的"GET 写配置"是同一性质：**有副作用的 GET**。
              //   自动回退本身**保留**，仍在后台启动流程里（`launchComfy` 的失败分支），
              //   那条路径不依赖任何 HTTP 请求、本来就会生效。
              //   这里只**标记原因 + 记日志**供前端展示与用户决策，**绝不改 cfg**。
              if (launch.sageAttempted === true && launchFailedDueToSage(tail)) {
                launch.sageSuspect = true
                log('warn', '⚠ 启动日志指向 SageAttention 疑似导致失败。'
                  + '自动回退由后台启动流程负责；状态接口只报告、不改配置。')
              }
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
          // ★★★ 2026-10-12 修正：首次使用向导（含模型名/路径的就绪清单）**不再**随状态体下发。
          //   原因：状态体是每 5 秒轮询、会被日志/宿主带走的契约，硬底线是"不含本地路径/模型名"；
          //   而向导本就需要告诉用户"哪个模型缺了"，两者冲突。
          //   ⇒ 改为独立端点 `/api/qwen-paint/wizard`，由前端"首次使用向导"按钮按需拉取。
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
            // ★★★ 2026-10-12（用户要求）：输出目录 + 它是怎么来的 ——
            //   前端据此显示"当前出图存到哪"，并给出修改入口。
            outputDir: cfg.outputDir,
            outputDirSource: cfg.outputDirSource ?? '默认桌面目录',
            outputDirDefault: defaultOutputDir(),
            optimization,
            preset: cfg.preset ?? 'default',
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
          // ★★★ 2026-10-12（确认式一键修复）：一个 POST 端点，前端"一键修复"按钮调它。
          //   默认返回预览（将要做什么）；带 {confirm:true} 才真正执行（只做可逆/无害动作）。
          const repairHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            // ★★★ 2026-10-17（AUTH001 收尾）：**任何动作之前**先过方法与媒体类型守卫。
            //
            //   审核原话：*"4355 的 `repair` 没有限制方法/内容类型，任意方法的 JSON
            //   `confirm:true` 都会进入 `runRepair`"* —— 确实如此：
            //   原先这里既不查 method 也不查 Content-Type，正文还是**无上限**内联读的。
            //   现在：非 POST → **405**；非 `application/json` → **415**；
            //   正文统一走**有界**的 `readJsonBody`（与状态端点、memory/preference 同一套）。
            if (!guardWriteRequest(req, res)) return
            const body = await readJsonBody(req)
            try {
              const result = await runRepair(cfg, log, { confirm: body?.confirm === true })
              respondJson(res, { ok: true, ...result })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/repair', handler: repairHandler }))
          // ★★★ 2026-10-12（首次使用向导）：独立端点，前端"首次使用向导"按钮按需拉取。
          //   故意**不**进状态体 —— 避免把模型名/路径带进每 5 秒轮询、会被日志/宿主带走的契约里。
          const wizardHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const online = await status.probe().catch(() => false)
              let caps = null
              if (online) caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              const wizard = await buildWizardReport(cfg, log, undefined, { online, caps })
              respondJson(res, { ok: true, ...wizard })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/wizard', handler: wizardHandler }))

          // ★★★ 2026-10-12（用户要求）：**更丰富的 API** —— 在状态/向导/修复之外，
          //   再开 5 个端点：health / capabilities / presets / memory.recent / memory.preference。
          //   全部只走本机回环（`isLocalRequest`），不对外暴露。
          // ★ /api/qwen-paint/health —— 极简存活探针（CI / 监控 / dsh-auto-memory 健康检查）
          const healthHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const online = await status.probe().catch(() => false)
              // 读自身 package.json 取版本（ESM 下用 import.meta.url 反推根目录）
              let version = 'unknown'
              let name = 'dsh-qwen-paint'
              try {
                const pkgPath = path.join(
                  path.dirname(fileURLToPath(import.meta.url)),
                  '..', 'package.json',
                )
                const pkgRaw = await fsp.readFile(pkgPath, 'utf8')
                const pkg = JSON.parse(pkgRaw)
                version = pkg.version ?? version
                name = pkg.name ?? name
              } catch { /* 取不到版本也不影响 health 返回 */ }
              respondJson(res, {
                ok: true,
                version,
                name,
                comfyOnline: online === true,
                time: new Date().toISOString(),
              })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/health', handler: healthHandler }))

          // ★ /api/qwen-paint/capabilities —— 探测结果（供前端按能力切换 UI / 供 dsh-auto-memory 判断）
          const capsHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
              const caps = await probeCapabilities(cfg, log, undefined, { force })
              respondJson(res, { ok: true, caps })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/capabilities', handler: capsHandler }))

          // ★ /api/qwen-paint/presets —— 当前可用的预设列表（含 ASPECTS / FLOW_STYLES）
          //   从 config.js 动态导入，避免本文件 (index.js) 顶部 import 时与 config.js 循环依赖踩坑
          //   （config.js 反向 import 本文件的 ensureComfyUp / getNodeSchema）。
          const presetsHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const m = await import('./config.js')
              respondJson(res, { ok: true, aspects: m.ASPECTS, flowStyles: m.FLOW_STYLES })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/presets', handler: presetsHandler }))

          // ★ /api/qwen-paint/memory/recent —— dsh-auto-memory 拉取最近出图记忆
          const memoryRecentHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 10) || 10
              const items = await readMemoryRecent(cfg, log, { limit })
              respondJson(res, { ok: true, items, count: items.length })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) })
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/memory/recent', handler: memoryRecentHandler }))

          // ★ /api/qwen-paint/memory/preference —— GET 读 / POST 写偏好
          const memoryPrefHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            if (req.method === 'GET') {
              try {
                const value = await readPreferences(cfg, log)
                respondJson(res, { ok: true, value })
              } catch (error) {
                respondJson(res, { ok: false, reason: String(error?.message ?? error) })
              }
              return
            }
            if (req.method === 'POST') {
              // ★ 2026-10-17（AUTH001 收尾）：与状态 / repair 用**同一套**守卫与有界解析。
              if (!guardWriteRequest(req, res)) return
              try {
                const body = (await readJsonBody(req)) ?? {}
                const result = await writePreferences(cfg, log, body)
                if (!result.ok) respondJson(res, { ok: false, reason: result.reason }, 400)
                else respondJson(res, { ok: true, value: result.value })
              } catch (error) {
                respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 400)
              }
              return
            }
            respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/memory/preference', handler: memoryPrefHandler }))

          log('info', '已注册只读状态端点 /api/qwen-paint/status.json、修复 /api/qwen-paint/repair、'
            + '向导 /api/qwen-paint/wizard、健康 /api/qwen-paint/health、'
            + '能力 /api/qwen-paint/capabilities、预设 /api/qwen-paint/presets、'
            + '记忆 /api/qwen-paint/memory/{recent,preference}')
          routeMounted = true
          diag('route', '已注册 /api/qwen-paint/status.json 与 /api/qwen-paint/repair 与 /api/qwen-paint/wizard')
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

/**
 * 内部导出的**取值源** —— 故意包在箭头函数里：只有真正访问某个属性时才读绑定。
 *
 * ⚠⚠ 为什么不能直接写 `export const __internal = { DEFAULTS, ... }`：
 *   本文件（index.js）与 config.js **互相 import**（config 反向取本文件的
 *   ensureComfyUp / getNodeSchema / nodeFileList / execFileAsync 等运行时胶水）。
 *   若这里在**模块求值期**就读 config 的绑定，一旦有人**先** `import './config.js'`，
 *   config 还没求值完，本文件顶层就已经去读它的绑定 → 直接 TDZ 崩：
 *     ReferenceError: Cannot access 'DEFAULTS' before initialization
 *   生产路径按 `main` 先加载 index.js，所以一直没暴露 —— 但那是"碰巧安全"，
 *   不是"设计安全"（任何先 import config.js 的测试/工具都会当场炸）。
 *
 * 用 Proxy 把求值推迟到**属性访问时**；Object.keys / 解构 / 展开 / JSON 全部照常。
 * 这些只给自测用，真机不依赖。
 */
const internalOf = () => ({
  DEFAULTS,
  // ★ 2026-10-12：POSIX 启动命令构造（纯函数）—— 供 `_mac_env_test.mjs`
  //   **真起一个 sh 跑一遍**，验证 macOS 的 MPS 环境变量确实注入到了子进程。
  buildPosixLaunchCommand,
  // ★ 2026-10-11：面板数据的两个纯函数 —— 供"按显卡过滤"的回归断言直接调
  describeOptimization,
  genericOptimizations,
  // ★ 2026-10-09 真事故修复：[object Object] 的规范化工具（供自测断言）
  toError,
  cancelReason,
  // ★ 2026-10-13：暴露给回归（OOM 判定此前**零测试覆盖**）
  isOutOfMemoryError,
  // ★ 2026-10-13：暴露给回归（任务 #62② SageAttention 崩溃自动回退的判定）
  launchFailedDueToSage,
  recoverFromSageCrash,
  // ★ 2026-10-13：暴露给回归（任务 #62① 记忆消费的优先级：显式 > 记忆）
  resolveDrawParams,
  // ★ 2026-10-14（C1/C2 专业卡版）：显存/内存档位的纯函数 + 合法取值（供回归与端点白名单共用）
  resolveVramArgs,
  VRAM_MODES,
  PRECISION_TIERS,
  TEXT_CONTROL_MODES,
  pickUnetForTier,
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
  // ★ 2026-10-16（AUTH001）：请求信任判定的正名（isLocalRequest 是它的兼容别名）。
  //   导出供 scripts/test-request-trust.mjs 做 fixture 断言。
  isTrustedRequest,
  // ★ 2026-10-17（AUTH001 收尾）：写入口的方法/媒体类型守卫，导出供单测。
  guardWriteRequest,
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
  unetLoaderFor,
  unetLoaderNode,
  MODEL_TIERS,
  resolveOutputDir,
  defaultOutputDir,
  defaultOutputBase,
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
  makeUpscaleTool,
  makeEditTool,
  freeComfyModels,
  runRepair,
  buildWizardReport,
  auxCapabilities,
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
})

/**
 * 给自测用的内部导出（真机不依赖这些）。
 * ⚠ 必须是**惰性**的（见上面 `internalOf` 的长注释）：求值推到属性访问时，
 *   这样任何 import 顺序都不会撞上循环 import 的 TDZ。
 */
export const __internal = new Proxy({}, {
  get: (_t, k) => internalOf()[k],
  has: (_t, k) => k in internalOf(),
  ownKeys: () => Reflect.ownKeys(internalOf()),
  getOwnPropertyDescriptor: (_t, k) => {
    const src = internalOf()
    return k in src
      ? { value: src[k], enumerable: true, configurable: true, writable: false }
      : undefined
  },
})
