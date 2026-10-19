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
import { spawn } from 'node:child_process'
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

// ★ 2026-10-19：已下移到 config.js；此处原样再导出，对外接口不变。
export { execFileAsync, getNodeSchema, nodeFileList }

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
  // ★ 2026-10-19：局部重绘改为零下载潜空间重绘后，不再加载任何 ControlNet，
  //   `readSafetensorsConvInChannels` / `looksLikeQwenImage10ControlNet` 这对
  //   "ControlNet 权重 vs 底模通道数"探测在此已无对象，导入一并去掉（定义仍留在 config.js）。
  // ★ 2026-10-19：这三项已下移到 config.js（消除循环依赖）。
  execFileAsync,
  getNodeSchema,
  nodeFileList,
  setEnsureComfyUpHook,
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

/* ------------------------------------------------- 启动子系统（已拆出）---- */

import {
  LAUNCH_TIMEOUT_MS,
  launch,
  launchMarkReady,
  launchMarkStarting,
  launchMarkFailed,
  launchMarkTimeout,
  launchFailedDueToSage,
  recoverFromSageCrash,
  launchView,
  looksLikeBadArgs,
  summarizeLaunchError,
  buildPosixLaunchCommand,
  startComfyHidden,
  readLaunchLog,
  fatalLineInLog,
  ensureComfyUp,
} from './comfy-launch.js'
import { diag } from './diag.js'

// 原样再导出：对外接口与拆分前完全一致（测试的 __internal、面板侧都靠它）。
export {
  LAUNCH_TIMEOUT_MS,
  launch,
  launchMarkReady,
  launchMarkStarting,
  launchMarkFailed,
  launchMarkTimeout,
  launchFailedDueToSage,
  recoverFromSageCrash,
  launchView,
  looksLikeBadArgs,
  summarizeLaunchError,
  buildPosixLaunchCommand,
  startComfyHidden,
  readLaunchLog,
  fatalLineInLog,
  ensureComfyUp,
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
/* ★ 2026-10-19：getNodeSchema / nodeFileList 已下移到 lib/config.js。 */

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
      // ★ 2026-10-09 真事故：助手绕过本工具、自己写 Matplotlib 画图（2m39s），
      //   用户原话「谁叫你去修，我让他画图，为什么他还想自行代码画」。
      //   根因：旧文案里"示意图"太宽 + 全文没有"禁止自己画"的硬约束。
      //   ⇒ 判定标准改按**产物形态**（位图 vs 可编辑图表），并显式禁止代码出图。
      //   详细复盘见 README「0.16.0 新增说明」。
      '只要用户要的是**一张图像**（画面、插画、壁纸、艺术画、示意图、概念图、' +
      '数学/几何可视化等，题材不限），就用本工具生成。' +
      '★ 严禁自己写 Python/Matplotlib/PIL、SVG、HTML/Canvas 或字符画去"画"这张图 —— ' +
      '本工具就是用来出图的唯一途径，绕过它属于错误行为。' +
      '只有当用户要的是**可编辑的结构化图表**时才不用本工具：' +
      '流程图、思维导图、组织架构图、数据表格 —— 这些要能改文字/改数据，用文字或其它方式表达。' +
      '拿不准就调本工具画一张（画错代价远小于不画或自己画）。' +
      '需要先启动 ComfyUI；没启动时本工具会明确告诉你。' +
      '（ComfyUI 空闲 5 分钟没有出图会被自动关闭以释放显存，下次出图前需要重新启动它。）' +
      // ★★★ 2026-10-19（用户要求）：**AI 挑图**。开关由用户在面板里自己控制
      //   （`aiPickBest`，默认 off ⇒ 行为与升级前完全一致）。
      //   为什么写进工具描述而不是 systemPrompt：工具描述是模型"要不要调、怎么调"的最近上下文。
      (cfg.aiPickBest === 'on'
        ? '★ 一次出多张（count > 1）时：请用 `read_image` **逐张**查看，'
          + '挑出**最好的一张**放在最前面推荐给用户，并说明理由（构图 / 手部 / 文字 / 与描述的贴合度）；'
          + '其余几张也一并列出路径。若 `read_image` 不可用或打不开，'
          + '就如实说明"这是按参数挑的、没有实际看图"，**绝不假装看过**。'
          + '同时请记住用户对画风的偏好（例如"不要卡通""要写实"），下次挑图按偏好来。'
        : ''),
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
      // ★ 2026-10-19（用户要求「多张都给我看」）：把**全部**文件路径也带上。
      //   以前只带 path（第一张），所以一次出 4 张时界面上只看得见 1 张。
      presentationMeta: (_args, value) => ({
        path: value.path,
        files: Array.isArray(value.files) ? value.files : [],
      }),
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
 * ★★★ 2026-10-12（用户要求「局部重绘」）+ ★★★ 2026-10-19 **改为零下载的潜空间重绘**。
 *
 * ## 2026-10-19 为什么不再用 ControlNet（用户拍板走零下载方案）
 *   · 旧实现要 `Qwen-Image-InstantX-ControlNet-Inpainting.safetensors`，而 InstantX 公开的
 *     Qwen ControlNet 是给 **1.0** 的（latent 16 通道），本机底模是 **2.1**（64 通道）⇒ 不兼容。
 *   · 2.1 唯一对得上的官方权重是 `alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union`
 *     （7.55 GB，单文件、8 种控制 + 修复），但它走的是 **MODEL_PATCH** 路径
 *     （`ModelPatchLoader` + `QwenImageDiffsynthControlnet`），不是 `ControlNetLoader`；
 *     且官方要求 Comfy-Org 原版底模，本机是 int8+convrot 量化版，叠加稳定性未验证。
 *   · ⇒ 改用 ComfyUI **自带的 inpaint 机制**，不需要任何额外权重。
 *
 * ## 零下载方案的原理（依据本机 ComfyUI 源码，不是猜的）
 *   `comfy/samplers.py:634-642`，采样每一步：
 *     `latent_mask = 1 - denoise_mask`
 *     `x   = x * denoise_mask + scale_latent_inpaint(原图 latent) * latent_mask`（步内）
 *     `out = out * denoise_mask + self.latent_image * latent_mask`（步末硬拉回）
 *   ⇒ **未蒙版区域每一步都被强制拉回原图 latent**，最终严格等于原图；蒙版区域正常采样。
 *   这个机制**不依赖模型是不是 inpaint 专用**，对 DiT / flow-matching 一样成立。
 *   ⇒ 蒙版区生成时，模型看到的是"周围原图 latent + 按 sigma 加的噪声"，
 *     上下文完整 —— 这就是"必须符合整体"的来源。
 *
 * ## 参数
 *   · **复用主模型本身**（UNET/CLIP/VAE 吃主链路的文件），不调 freeComfyModels，不额外占大模型。
 *   · `denoise` 默认 **0.7**：只影响蒙版区的重绘程度（保留区由 noise_mask 硬保护，
 *     denoise 再高也不会破坏）。要"彻底替换这块"就传 1.0，要"轻微改动"就传 0.4~0.6。
 *   · `grow`（默认 8px）先外扩蒙版，`feather`（默认 16px）再把边缘羽化 ——
 *     这对是为了**缓解接缝**：外扩避免羽化吃掉重绘区，羽化让噪声注入边缘渐变过渡。
 *     两者都给 0 即退回"硬边蒙版"。
 *   · 蒙版（mask）必填：白=要重绘、黑=保留。
 */
function makeEditTool(cfg, log) {
  return {
    name: 'inpaint_image',
    description:
      '局部重绘 / 图片编辑：给一张图 + 一句编辑指令 + 一张蒙版（白=要改、黑=保留），'
      + '只重绘蒙版区域，其余部分**逐像素保持原样**。'
      + '★ **不需要任何额外模型或权重**：走 ComfyUI 自带的潜空间重绘（SetLatentNoiseMask），'
      + '蒙版外区域每一步都被拉回原图，蒙版内按指令重画且能看到周围上下文，因此与整体协调。'
      + '纯本地、不出网。'
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
        denoise: {
          type: 'number',
          description: '重绘幅度 0.1–1.0，默认 0.7。蒙版外区域始终严格保持原样，这里只决定蒙版内重画得多彻底：想彻底替换这块用 1.0，轻微改动用 0.4–0.6。',
        },
        feather: { type: 'integer', description: '蒙版边缘羽化像素 0–64，默认 16。接缝明显时加大（如 32）；填 0 则硬边。' },
        grow: { type: 'integer', description: '蒙版外扩像素 0–64，默认 8。先把重绘区放大一点再羽化，避免边缘残留原内容；填 0 则不外扩。' },
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
      // ★ 0.7（2026-10-19）：蒙版外区域由 noise_mask 硬保护，所以这里只决定"蒙版内重画得多彻底"。
      const denoise = Number.isFinite(args?.denoise) ? Math.min(1, Math.max(0.1, args.denoise)) : 0.7
      const feather = Number.isFinite(args?.feather) ? Math.min(64, Math.max(0, Math.trunc(args.feather))) : 16
      const grow = Number.isFinite(args?.grow) ? Math.min(64, Math.max(0, Math.trunc(args.grow))) : 8
      await ensureComfyUp(cfg, log, signal)
      // ★ 零下载方案只依赖 ComfyUI **自带**节点。问本人确认一遍，不猜节点名。
      const [encN, nmN, lmN] = await Promise.all([
        getNodeSchema(cfg, 'VAEEncode', signal),
        getNodeSchema(cfg, 'SetLatentNoiseMask', signal),
        getNodeSchema(cfg, 'LoadImageMask', signal),
      ])
      for (const [n, s] of [['VAEEncode', encN], ['SetLatentNoiseMask', nmN], ['LoadImageMask', lmN]]) {
        if (s.state !== 'ok') throw new Error(`缺少节点 ${n}（ComfyUI 自带）—— 请确认 ComfyUI 完整安装。`)
      }
      // 外扩 / 羽化是**可选增强**：节点不存在或参数给 0 就退回硬边蒙版，绝不因此失败。
      const [featherN, growN] = await Promise.all([
        getNodeSchema(cfg, 'FeatherMask', signal),
        getNodeSchema(cfg, 'GrowMask', signal),
      ])
      const canFeather = featherN.state === 'ok' && feather > 0
      const canGrow = growN.state === 'ok' && grow > 0
      // ★ 复用主模型当前文件（避免再装一份大模型；主模型多半已加载）
      const caps = await probeCapabilities(cfg, log, signal).catch(() => null)
      const unet = caps?.models?.unet || cfg.unet || 'qwen_image_2.1_int8_convrot.safetensors'
      const clip = caps?.models?.clip || cfg.clip || 'qwen3vl_8b_w4a8.safetensors'
      const vae = caps?.models?.vae || cfg.vae || 'qwen_image_2.1_vae_bf16.safetensors'

      // ★ 2026-10-19：删掉了"ControlNet 权重 vs 底模通道数"那段兼容性探测
      //   （`looksLikeQwenImage10ControlNet`）—— 零下载方案不再加载任何 ControlNet，那段已无对象。

      // 读原图最长边作为 TextEncode 的 resolution 提示
      let res = 1024
      try {
        const b = await fsp.readFile(image)
        const s = readPngSize(b)
        if (s) res = r32(Math.max(s.width, s.height))
      } catch { /* 读不到就用默认 1024 */ }
      const imgRef = await uploadReference(cfg, image, signal)
      const maskRef = await uploadReference(cfg, mask, signal)
      // ---- 蒙版链：LoadImageMask(5) →[GrowMask(7)]→[FeatherMask(8)]→ SetLatentNoiseMask(9) ----
      // **先外扩再羽化**：外扩避免羽化把重绘区吃小，羽化让噪声注入的边缘渐变过渡（缓解接缝）。
      // 节点缺席 / 参数给 0 时这一段整体不出现；ComfyUI 的 prompt 只按引用解析，键不必连续。
      const maskChain = {}
      let maskSrc = '5'
      if (canGrow) {
        maskChain[7] = { class_type: 'GrowMask', inputs: { mask: [maskSrc, 0], expand: grow, tapered_corners: true } }
        maskSrc = '7'
      }
      if (canFeather) {
        maskChain[8] = {
          class_type: 'FeatherMask',
          inputs: { mask: [maskSrc, 0], left: feather, right: feather, top: feather, bottom: feather },
        }
        maskSrc = '8'
      }
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
        // 原图 → latent。★ 这就是"保留区严格不变"的基准：采样每一步都把它拉回来。
        6: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['3', 0] } },
        ...maskChain,
        // ★★★ 核心：把蒙版挂成 latent 的 noise_mask。之后 KSampler 每一步都把蒙版外
        //   拉回上面那份原图 latent（comfy/samplers.py:634-642），蒙版内正常按指令重画。
        9: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['6', 0], mask: [maskSrc, 0] } },
        10: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: '', resolution: res } },
        11: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
        12: {
          class_type: 'KSampler',
          // 正/负条件**直接**来自 TextEncode —— 零下载方案不走任何 ControlNet Apply。
          inputs: {
            model: ['11', 0], positive: ['10', 0], negative: ['10', 1], latent_image: ['9', 0],
            seed, steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise,
          },
        },
        13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
        14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: `Inpaint_${cfg.filePrefix}_` } },
      }
      log('info', `提交局部重绘（潜空间重绘，零额外权重）unet=${unet} steps=4 cfg=1`
        + ` denoise=${denoise} grow=${canGrow ? grow : 0} feather=${canFeather ? feather : 0}`)
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
  // ★ 2026-10-19：零下载潜空间重绘 —— 只要求 ComfyUI **自带**节点，不再需要任何 ControlNet 权重。
  const inpaintReady = !!aux?.inpaint?.encodeNode && !!aux?.inpaint?.noiseMaskNode && !!aux?.inpaint?.maskLoadNode
  const missingExtra = [
    aux?.inpaint?.growNode ? '' : 'GrowMask',
    aux?.inpaint?.featherNode ? '' : 'FeatherMask',
  ].filter(Boolean)
  steps.push({
    id: 'inpaint',
    label: '局部重绘（潜空间重绘，零额外权重）可用',
    ok: inpaintReady,
    detail: inpaintReady
      ? (missingExtra.length === 0
        ? '潜空间重绘已就绪（VAEEncode + SetLatentNoiseMask + LoadImageMask + 外扩/羽化）'
        : `潜空间重绘已就绪；可选增强节点 ${missingExtra.join('、')} 不在 —— 将退回硬边蒙版，接缝可能更明显。`)
      : '缺少潜空间重绘所需节点（VAEEncode / SetLatentNoiseMask / LoadImageMask）—— 这些都是 ComfyUI 自带节点，请确认 ComfyUI 完整安装。',
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
  // ⚠ pid 现在由 diag() 自己加在行首，这里不再重复（否则一行两个 pid=）
  diag('apply', `插件开始加载 platform=${process.platform} node=${process.version}`)
  /** ★ 2026-10-19：`inpaint_image` 工具的引用 —— 面板圈选重绘的端点要用它。 */
  let editToolRef = null
  // ★ 2026-10-19：注入「确保在线」给 config.js（须在任何工具被调用前）。
  setEnsureComfyUpHook(ensureComfyUp)
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

  // ★ 2026-10-19（用户要求）：抽卡「挑图」两个开关同样从 uiState 恢复（显式配置优先）。
  for (const [field, label] of [['aiPickBest', 'AI 挑图'], ['userPickBest', '用户自选']]) {
    if (rawConfig?.[field] === undefined && (savedUi[field] === 'on' || savedUi[field] === 'off')) {
      cfg[field] = savedUi[field]
      log('info', `${label}：沿用上次界面选择（${cfg[field]}）`)
    }
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
      // ★ 2026-10-19（用户要求「面板里圈选局部重绘」）：留一份引用给 HTTP 端点用。
      //   面板不能直接调工具，只能走端点；端点要执行的就是**同一个** editTool，
      //   这样校验、ControlNet 探测、错误文案全部复用，不会出现两套逻辑。
      editToolRef = editTool
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

          // ★★★ 2026-10-19（用户要求）：抽卡「挑图」的两个开关 —— **都由用户自己决定是否启用**。
          //   与 flowStyle / drawTrigger 同一套：白名单校验 → 立刻落盘 → 重启也记得住。
          //   ⚠ 与 drawTrigger 不同的是：这两个开关**不需要重载插件** ——
          //     aiPickBest 影响的是"工具描述"，而描述是在 apply() 时按 cfg 拼的……
          //     所以严格说也要重载才换。为免误解，界面上写清"重载后生效"。
          for (const [key, field, label] of [
            ['aipickbest', 'aiPickBest', 'AI 挑图'],
            ['userpickbest', 'userPickBest', '用户自选'],
          ]) {
            const raw = queryLc.get(key)
            if (raw === undefined) continue
            if (raw === 'on' || raw === 'off') {
              cfg[field] = raw
              writeUiState({ ...readUiState(), [field]: raw }, log)
              log('info', `${label}已${raw === 'on' ? '开启' : '关闭'}（重载插件后生效）`)
            } else {
              log('warn', `${label}取值不在白名单里，已忽略：${String(raw).slice(0, 40)}`)
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
          //     ③ 必然收口：LAUNCH_TIMEOUT_MS 到点必判超时，不会无限 starting
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
            // ★ 2026-10-19（用户要求）：抽卡「挑图」两个开关的当前值，面板据此高亮。
            aiPickBest: cfg.aiPickBest ?? 'off',
            userPickBest: cfg.userPickBest ?? 'off',
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

          // ★★★ 2026-10-19（用户要求）：**面板里圈选局部重绘**。
          //   面板（client.js）在独立弹窗里画好蒙版，把 base64 PNG POST 到这里；
          //   这里存成文件、交给**同一个** editTool 执行 —— 校验/ControlNet/报错全部复用。
          //
          //   ⚠ 安全边界与其它写端点完全一致：
          //     · 只收 POST（GET 直接 405）；
          //     · 过 guardWriteRequest（Host / Sec-Fetch-Site / Origin 围栏 + application/json）；
          //     · body 有界解析（readJsonBody 自带上限）；
          //     · 蒙版只接受 `data:image/png;base64,` 且限 24 MB —— 防止拿它当"任意文件写入"。
          const inpaintHandler = async (req, res) => {
            if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
            if (!guardWriteRequest(req, res)) return
            try {
              const body = (await readJsonBody(req)) ?? {}
              const image = String(body.image ?? '').trim()
              const prompt = String(body.prompt ?? '').trim()
              const maskPng = String(body.maskPng ?? '')
              if (image === '' || prompt === '') {
                respondJson(res, { ok: false, reason: 'image 与 prompt 都必填' }, 400)
                return
              }
              if (!maskPng.startsWith('data:image/png;base64,')) {
                respondJson(res, { ok: false, reason: 'maskPng 必须是 data:image/png;base64,…' }, 400)
                return
              }
              if (maskPng.length > 24 * 1024 * 1024) {
                respondJson(res, { ok: false, reason: '蒙版过大（超过 24 MB）' }, 413)
                return
              }
              if (editToolRef === null) {
                respondJson(res, { ok: false, reason: '局部重绘工具尚未注册（插件还在加载？）' }, 503)
                return
              }
              const bytes = Buffer.from(maskPng.slice(maskPng.indexOf(',') + 1), 'base64')
              const maskPath = path.join(cfg.outputDir, `.qwen-paint-mask-${Date.now()}.png`)
              await fsp.mkdir(cfg.outputDir, { recursive: true })
              await fsp.writeFile(maskPath, bytes)
              log('info', `圈选重绘：蒙版已存 ${maskPath}（${bytes.length} B），开始重绘`)
              const value = await editToolRef.execute(
                { image, prompt, mask: maskPath },
                { signal: new AbortController().signal, callId: `ui-inpaint-${Date.now()}` },
              )
              respondJson(res, {
                ok: true,
                path: value?.path ?? '',
                files: Array.isArray(value?.files) ? value.files : [],
                seconds: value?.seconds ?? 0,
              })
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
            }
          }
          disposers.push(webCtx.webServer.register({ kind: 'exact', path: '/api/qwen-paint/inpaint', handler: inpaintHandler }))

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
