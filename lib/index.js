/**
 * dsh-qwen-paint —— 让 DSH 在对话里直接调用本机 ComfyUI，用 Qwen-Image 2.1 出图。
 *
 * 设计要点 ①–⑦ 的完整论证（零外部依赖 / workflow 照抄官方 / 纯本地 / 落盘位置 /
 * 图片显示路径 / 空闲自动关停 ComfyUI / 只读状态端点）已外置归档到
 * `docs/index-design-notes.md`。这里只留索引：lib/index.js 贴着 DSH Store
 * 单文件 262,144 B 上限，长注释必须外置，改工作流前先回去读，别凭感觉改。
 *
 * ⑥ 空闲自动关停 ComfyUI：原文另存于 lib/tool-registry.js 文件头。
 * ⑦ 只读状态端点 GET /api/qwen-paint/status.json：只回事实、只放行本机请求，
 *    不含任何路径 / 密钥。
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
import { touchResidency, RESIDENCY_KEYS } from './model-residency.js'
// ★★★ 2026-10-15：网络边界守卫（DSH STORE 合规整改 —— Issue #1390）。
//   README 原先声明"网络仅限本机回环"，但 comfyUrl 是普通配置项、代码里没有任何
//   强制校验，属于"声明与实现不符"。本模块把回环约束做成**代码层强制**，
//   并在所有出站请求上禁用重定向。详见 lib/net-guard.js 顶部说明。
import { assertLocalUrl, guardedFetch, setAllowRemote } from './net-guard.js'

// ★ 2026-10-19：已下移到 config.js；此处原样再导出，对外接口不变。
export { execFileAsync, getNodeSchema, nodeFileList }

// 设计说明已外置 → docs/index-design-notes.md#index-note-001（原 L33-43）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-002（原 L67-93）
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
  buildTaskWorkflow,
  OFFICIAL_TURBO_STEPS,
  OFFICIAL_EDIT_STEPS,
  OFFICIAL_TURBO_SIGMAS_8,
  OFFICIAL_EDIT_SIGMAS_9,
  resolvePlan,
  resolveOfficialTurbo,
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
  // ★ 2026-11-12（核显 / 8 GB）：低配可跑性评估（量化门槛，数字标 unverified）
  assessLowEndReadiness,
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
  // ★ 2026-11-17（M5）：SaveImage 前缀模板（按日期/模型分子目录，默认行为不变）
  applyFilePrefixTemplate,
} from './config.js'
import { readWorkflowMeta, attachWorkflowMeta } from './workflow-meta.js'
import { preprocessFileLabels } from './model-label.js'
import {
  TASK_SPECS, buildTaskParameters, taskDirections,
} from './task-specs.js'
import { runTask, isColorMatcherError } from './task-runner.js'
import { makeBinaryOutputContract, withDeclaredOutput } from './tool-contracts.js'
import {
  describeDrawTool, describeVideoTool, describeHybridTool,
  describeAccelTool, describeUpscaleTool,
} from './tool-descriptions.js'
import { makeSpeechTool, makeSpeechRunner } from './speech-tool.js'
import { uploadToComfy } from './comfy-upload.js'
// ★ 2026-11-13：CPU 指令集识别 / 加速档。纯逻辑全在 cpu-profile.js，
//   端点实现全在 cpu-endpoints.js —— 本文件只留最少的接线，避免吃光 4 KB 余量。
import { cpuAccelPlan, getCpuProfile, normalizeCpuAccelMode } from './cpu-profile.js'
import { makeCpuHandlers, registerCpuRoutes } from './cpu-endpoints.js'
import { normalizeReferencePaths, reconcileReferenceUploads } from './reference-inputs.js'
import {
  readControls, controlsToPref, resolveSeed,
  describeControls as describePipelineControls, DEFAULT_CONTROLS as DEFAULT_PIPELINE_CONTROLS,
  ASPECT_TICKS,
} from './pipeline-controls.js'
import { createLocalDedup, semanticFingerprint } from './prompt-cache.js'
import { runKey, recordTiming, readTimings, buildProgress } from './progress.js'
import {
  listStyles, readLibrary, writeLibrary, listSkills, skillsToText, composePrompt,
  libraryDir as styleLibraryDir,
} from './style-library.js'
import {
  // ★ A1 接管：三处调用点全部改走清单优先（清单不可用会回落硬编码构建，见该函数注释）。
  //   别名保留原名，调用点一行不用动 —— 迁移期少一处差异就少一处漂移。
  buildVideoWorkflowPreferred as buildVideoWorkflow, videoParamsForSpeed, widthForAspect,
} from './video-workflow.js'
import { pick as pickAccelProfile, profileById as accelProfileById, installedIds, describePick } from './accel-profiles.js'
import { SPEED_MAP, SPEED_TIERS, MODES } from './mode-schema.js'
// ★ 报告 v3 §14：A 线槽位推导 / B 线提交前管线 / C 线验证器 的 host 侧接线。
import {
  loadObjectInfo, finalizeWorkflow, readSlotsCatalog, slotsForWorkflow, catalogForTts,
  weightFilesFromObjectInfo,
} from './comfy-catalog.js'
import { probeTts, buildTtsWorkflow, TTS_FALLBACK_CHAINS } from './tts-workflow.js'
import { runHybrid } from './hybrid-runner.js'
// ★ 2026-11-17（H4）：视频分段续跑账本（段级，不是帧级续采样 —— 见 lib/resume-store.js 顶部说明）。
import { createResumeStore, RESUME_DIR_NAME } from './resume-store.js'
// ★ 2026-11-17（L1）：WebSocket 渐进预览（增强层，Node 20 无全局 WS 时如实不可用）。
import {
  createPreviewStore, createWsPreviewBridge, parsePreviewFrame, handleWsJson,
} from './ws-preview.js'
// ★ 2026-11-17：TTS 首段早出声事件（悬浮面板轮询带出，单例、TTL 有界）。
import { createTtsLiveStore } from './tts-lowlatency.js'
// ★ 模型无关的「角色参考」适配层：策略表 + 运行时能力协商 + 通用兜底 + 视频分段锁帧。
//   四个 HTTP 端点的处理器拆到 reference-endpoints.js —— 本文件已逼近 DSH Store 单文件上限。
import {
  adaptReference, describeStrategy, REFERENCE_STRATEGIES,
  planReferenceControls, applyReferencePlan,
} from './reference-strategy.js'
import { makeReferenceHandlers } from './reference-endpoints.js'
// ★ 2026-11-16 主模型候选端点 + 视频模型落盘（处理器外置：本文件需留在 256 KB 上限内）。
import { makeModelOptionsHandler, persistVideoModelChoice, persistTtsChoice } from './model-options.js'
import { makeUiEditHandlers } from './ui-edit-endpoints.js'
import { registerVideoFrameRoutes } from './video-frames-endpoints.js'
import { makeFileBytesHandler } from './file-route.js'
import { createHistoryStore, kindOf } from './history-store.js'
import { makeHistoryHandlers, historyRouteTable } from './history-endpoints.js'
import { makeHistoryTool } from './history-tool.js'
import { makePromptTool } from './prompt-tool.js'
import { makeConfigHandlers, configRouteTable } from './config-endpoints.js'
import { makeBatchTool } from './batch-tool.js'
import { sanitizeBody, failBody } from './http-errors.js'
import { registerAssetRoutes } from './asset-route.js'
import { registerExtras } from './tool-registry.js'
import { makeIntegrationHandlers, registerIntegrationRoutes } from './integration-endpoints.js'
import { normalizeMaskFx } from './mask-fx.js'
// ★ 2026-11-17（M3/M4）：队列前台操作端点 + ControlNet 预处理（纯逻辑在模块里，IO 在本文件注入）。
import { makeJobHandlers, jobRouteTable } from './job-endpoints.js'
// ★ 2026-11-17（L2）：外部 ComfyUI 工作流 JSON 导入（校验 + 模板 + 进程内注册表）。
import { createImportRegistry } from './workflow-import.js'
import { makeWorkflowImportHandlers, workflowImportRouteTable } from './workflow-import-endpoints.js'
import {
  PREPROCESS_TYPES, pickPreprocessNode, clampPreprocessParams,
  buildPreprocessWorkflow, cacheKeyOf, createPreprocessCache, PREVIEW_DIR_NAME,
} from './cnet-preprocess.js'

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

/** B3：语音段与独立 TTS 工具共用同一份本机 I/O 依赖（纯注入，便于离线回归）。 */
function makeSpeechDeps(config, logger) {
  return {
    cfg: config, log: logger,
    ensureComfyUp, loadObjectInfoFor, catalogForTts,
    submitPrompt, fetchOutputBytes, fetchWithTimeout, cancelReason,
    safeStem, uniquePath,
    onFirstChunk: (filePath, meta) => ttsLiveStore.publish(filePath, meta),
  }
}

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
// 设计说明已外置 → docs/index-design-notes.md#index-note-003（原 L365-368）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-004（原 L393-400）
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
 *   返回 false。所以「用户自己打开 ComfyUI 在别处画图」绝不会被本插件关掉。
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
      // ★ 2026-10-07 新增：`idleShutdownMs <= 0` 表示**不自动关闭**（用户在界面上选了这一项）。
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
      // ★ 2026-10-07：idleShutdownMs <= 0 = 用户在界面上选了「不自动关闭」
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-005（原 L562-590）
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
    // ★ 2026-11-13：错误响应统一消毒（本机路径 / 用户名不出门）。
    //   只在命中错误语义字段时才展开对象，正常响应零额外开销。
    const text = JSON.stringify(sanitizeBody(body))
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: '响应序列化失败（详见插件日志）' }))
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-006（原 L669-683）
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
async function uploadReference(cfg, filePath, signal, ordinal) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到参考图：${filePath}（${error?.message ?? error}）`)
  }
// 设计说明已外置 → docs/index-design-notes.md#index-note-007（原 L720-724）
  const baseName = path.basename(filePath)
  const uploadName = Number.isFinite(ordinal) ? `dshqp-ref-${ordinal}-${baseName}` : baseName
  const form = new FormData()
  form.append('image', new Blob([bytes]), uploadName)
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-008（原 L751-773）
let slotsCatalogCache = null
function getSlotsCatalog() {
  if (slotsCatalogCache === null) {
    slotsCatalogCache = readSlotsCatalog(() => readFileSync(
      fileURLToPath(new URL('../assets/slots.json', import.meta.url)), 'utf8'))
  }
  return slotsCatalogCache
}

/** 报告 §14 的「一次 /object_info 供三处用」：B 线校验 / TTS 探测 / modes 端点共用。 */
function loadObjectInfoFor(cfg, signal) {
  return loadObjectInfo({ url: cfg.comfyUrl, fetchFn: (u, o) => fetchWithTimeout(u, o), signal })
}

async function submitPrompt(cfg, workflow, signal) {
// 设计说明已外置 → docs/index-design-notes.md#index-note-009（原 L789-792）
  let submitBody = workflow
  try {
    const objectInfo = await loadObjectInfoFor(cfg, signal)
    const fin = finalizeWorkflow(workflow, objectInfo, { slots: slotsForWorkflow(workflow, getSlotsCatalog()) })
    if (fin.error !== null) {
      // 校验未通过 = 多半是 object_info 稀疏或节点改名 —— 交给 ComfyUI 自己判，插件不拦。
      diag('ast', `提交前校验未通过，按原样提交：${fin.error}`)
    } else {
      submitBody = fin.workflow
      diag('ast', fin.strict
        ? `AST passes 生效：${fin.changes.length} 项改动（提交体切换为管线产物）`
        : `AST 校验通过：object_info ${Object.keys(objectInfo ?? {}).length} 节点 / 0 改动 / 零漂移`)
    }
  } catch (error) {
    diag('ast', `提交前管线异常，按原样提交：${String(error?.message ?? error)}`)
  }
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ prompt: submitBody, client_id: `dsh-qwen-paint-${process.pid}` }),
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-010（原 L832-846）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-011（原 L911-926）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-012（原 L975-985）
function makeAccelTool(cfg, log) {
  return {
    name: 'check_acceleration',
    description: describeAccelTool(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'status（默认，只读检查）/ install（安装加速包）' },
        packId: { type: 'string', description: '要安装的加速包 id（见 status 返回的 packs[].id）' },
      },
    },
    timeoutMs: 900000,
// 设计说明已外置 → docs/index-design-notes.md#index-note-013（原 L999-1005）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-014（原 L1045-1070）

// 设计说明已外置 → docs/index-design-notes.md#index-note-015（原 L1072-1082）

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

// 设计说明已外置 → docs/index-design-notes.md#index-note-016（原 L1133-1146）

// 设计说明已外置 → docs/index-design-notes.md#index-note-017（原 L1148-1155）
const integrationRuntime = {
  maskFx: normalizeMaskFx({}),
  memoryMode: 'off',
  unloadCount: 0,
  lastUnloadOk: false,
  /** 由 makeIntegrationHandlers 注入，只向 cfg.comfyUrl 发 /free，不接受任意 URL。 */
  unloadModels: null,
}
/** 已注册工具名：/integration/state 如实列出，不写死清单。 */
const registeredToolNames = []
// ★ 2026-11-13：生成历史（SQLite）。apply() 里初始化；所有写入点只读它，失败不影响出图。
let historyStore = null

/** auto 模式（或用户勾了"完成后卸载内存"）在任务收尾触发一次 /free。
 *  fire-and-forget：既不拖慢返回，也绝不改变出图结果；失败只记账。 */
function maybeAutoUnload() {
  if (integrationRuntime.memoryMode !== 'auto' && integrationRuntime.maskFx?.unloadMemory !== true) return
  const unload = integrationRuntime.unloadModels
  if (typeof unload !== 'function') return
  Promise.resolve()
    .then(() => unload({ unload_models: true, free_memory: true }))
    .then((ok) => {
      integrationRuntime.unloadCount += 1
      integrationRuntime.lastUnloadOk = ok === true
    })
    .catch(() => {
      integrationRuntime.unloadCount += 1
      integrationRuntime.lastUnloadOk = false
    })
}

const inFlight = new Map()
// ★ 2026-11-17：TTS 首段音频事件单例（progress 端点带出给悬浮面板播）。
const ttsLiveStore = createTtsLiveStore()
// ★ 2026-11-17（L1）：WS 预览快照（有界内存，默认不连；端点显式启用后才建桥）。
const previewStore = createPreviewStore()
let previewBridge = null
let previewBridgeStatus = { ok: false, reason: '尚未启用（GET /api/qwen-paint/preview?enable=1 开启）' }

/** 按需建 WS 桥：只在端点第一次被拉时连，不让探针/日志热路径多一条常驻连接。 */
function ensurePreviewBridge(cfg, log) {
  if (previewBridge !== null) return previewBridgeStatus
  previewBridgeStatus = createWsPreviewBridge({ comfyUrl: cfg?.comfyUrl, store: previewStore, log })
  if (previewBridgeStatus.ok) previewBridge = previewBridgeStatus
  return previewBridgeStatus
}

async function fetchOutputBytes(cfg, file, signal) {
  const q = new URLSearchParams()
  q.set('filename', String(file.filename))
  q.set('subfolder', String(file.subfolder ?? ''))
  q.set('type', String(file.type ?? 'output'))
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${q.toString()}`, { timeoutMs: 300000, signal })
  if (!res.ok) throw new Error(`取视频文件失败（HTTP ${res.status}）：${file.filename}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 等视频任务出结果。
 * ⚠ 与 waitForResult 分开写的原因：图片链只看 `outputs[*].images`，
 *   而 VHS_VideoCombine 的产物在 **`outputs[*].gifs`**（历史遗留命名）。
 *   复用 waitForResult 会永远拿不到东西，最后报"成功但没有图片输出"。
 */
async function waitForVideo(cfg, promptId, { signal, onTick, timeoutMs }) {
  const started = Date.now()
  let lastNote = ''
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等视频生成超时（已等 ${Math.round((Date.now() - started) / 1000)} 秒）。`
        + '短视频（25 帧）热机约 20 s；首帧前要装模型，冷启动更久。')
    }
    if (signal?.aborted) throw cancelReason(signal)
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1200))

    let history
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 30000, signal })
      if (!res.ok) continue
      history = await res.json()
    } catch {
      continue
    }
    const entry = history?.[promptId]
    if (!entry) {
      const note = `视频生成中… 已等 ${Math.round((Date.now() - started) / 1000)}s`
      if (note !== lastNote) { lastNote = note; if (onTick) onTick(note) }
      continue
    }
    const status = entry.status
    if (Array.isArray(status?.messages)) {
      const errMsg = status.messages.find((m) => Array.isArray(m) && m[0] === 'execution_error')?.[1]
      if (errMsg) {
        throw new Error(`ComfyUI 执行失败：${errMsg?.exception_message ?? JSON.stringify(errMsg).slice(0, 400)}`)
      }
    }
    const media = []
    for (const out of Object.values(entry.outputs ?? {})) {
      // VHS_VideoCombine → gifs；SaveVideo/CreateVideo → videos；SaveAnimatedWEBP → images
      for (const key of ['gifs', 'videos', 'images']) {
        for (const f of out?.[key] ?? []) if (f?.filename) media.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output', kind: key })
      }
    }
    if (media.length > 0) return media
    if (status?.status_str === 'success') {
      throw new Error('ComfyUI 报告成功，但没有取到视频文件（VHS_VideoCombine 可能没接在链上）。')
    }
    const note = `运行中… 已等 ${Math.round((Date.now() - started) / 1000)}s`
    if (note !== lastNote) { lastNote = note; if (onTick) onTick(note) }
  }
}

/**
 * 真正的视频生成逻辑。
 * 参数优先级与生图侧一致：**显式 args > 面板控制项 > 默认**。
 *   · 速度% → 帧数/帧率/高度（`SPEED_MAP.video`），**不改蒸馏步数**（DMD 工作点固定 4）。
 */
async function runVideo(args, exec, deps) {
  const { cfg, log, onProduced, onStart } = deps ?? {}
  if (!cfg || typeof log !== 'function') {
    throw new Error('插件内部错误：视频逻辑缺少必需依赖（cfg / log）。这是插件的 bug，请重载插件后重试。')
  }
  const prompt = String(args?.prompt ?? '').trim()
  if (prompt === '') throw new Error('prompt 不能为空：请描述你想生成什么视频。')
  const signal = exec?.signal
  if (typeof onStart === 'function') onStart()

  const t0 = Date.now()
  const controls = readControls(cfg.outputDir)
  const sp = videoParamsForSpeed(controls.speedPercent, SPEED_MAP, SPEED_TIERS)
  const aspectIdx = Math.min(ASPECT_TICKS.length - 1, Math.max(0, Math.trunc(controls.aspect)))
  const aspectKey = ASPECT_TICKS[aspectIdx]
  const height = Number.isFinite(args?.height) ? args.height : sp.height
  const width = Number.isFinite(args?.width) ? args.width : widthForAspect(aspectKey, height)
  // 帧数/帧率：显式 args > 面板滑块（用户真拨过、偏离默认才覆盖）> 速度档推导。
  //   ⚠ 不能无脑用 controls.frames/fps 盖 sp：面板没拨时它们是默认值 49/24，
  //     会把速度档（100%→81 帧 / 25%→17 帧）整段抹平。沿用 controlsToPref 的
  //     「只采纳用户真动过的键」铁律（见 pipeline-controls.js）。
  const frameOverride = Number.isFinite(controls.frames) && controls.frames !== DEFAULT_PIPELINE_CONTROLS.frames
    ? controls.frames : null
  const fpsOverride = Number.isFinite(controls.fps) && controls.fps !== DEFAULT_PIPELINE_CONTROLS.fps
    ? controls.fps : null
  const frames = Number.isFinite(args?.frames) ? args.frames : (frameOverride ?? sp.frames)
  const fps = Number.isFinite(args?.fps) ? args.fps : (fpsOverride ?? sp.fps)
  const startImage = typeof args?.startImage === 'string' ? args.startImage.trim() : ''
  // D22：音轨。这里只是本地路径，真正进工作流的是**上传后拿到的 ComfyUI 侧文件名**
  // （本地绝对路径写进工作流 = 要求 ComfyUI 看见调用方的盘符，跨机必炸）。
  const audioTrackPath = typeof args?.audio_track === 'string' ? args.audio_track.trim() : ''
  // 素材库（风格 / 指令 / skill）同样适用于视频链
  let promptForModel = prompt
  try {
    const lib = readLibrary(cfg.outputDir)
    const style = listStyles(cfg.outputDir).find((x) => x.id === lib.selected) ?? null
    const allSkills = lib.skills.length > 0 ? listSkills(cfg) : []
    const composed = composePrompt(prompt, { style, instruction: lib.instruction, skillsText: skillsToText(lib.skills, allSkills) })
    if (composed.text !== '') promptForModel = composed.text
    if (composed.parts.length > 0) log('info', `素材库生效（视频）：${composed.parts.map((p) => p.label).join('、')}`)
  } catch (error) {
    log('warn', `素材库读取失败（已忽略）：${error?.message ?? error}`)
  }

  await ensureComfyUp(cfg, log, signal)
  const caps = await probeCapabilities(cfg, log, signal)

  // ★ 2026-11-17（H3）：尾帧契约门禁 —— 本机 Wan22ImageToVideoLatent 得有 end_image
  //   输入才放行（0.39.0 的节点契约里没有这个槽）。给了就如实报错，
  //   绝不假装支持再炸在运行时；升级 ComfyUI 后重试即可。
  const endImage = typeof args?.endImage === 'string' ? args.endImage.trim() : ''
  if (endImage !== '') {
    const wanSchema = await getNodeSchema(cfg, 'Wan22ImageToVideoLatent', signal)
    if (!JSON.stringify(wanSchema ?? {}).includes('end_image')) {
      throw new Error('本机 Wan22ImageToVideoLatent 没有 end_image 输入（当前 ComfyUI 版本不支持视频尾帧）。'
        + '尾帧参考暂不可用——如实拒绝而非提交后炸在运行时；升级 ComfyUI 后重试。')
    }
  }

// 设计说明已外置 → docs/index-design-notes.md#index-note-018（原 L1305-1308）
  const refStrategyId = resolveReferenceStrategy(args)
  const refPaths = refStrategyId !== '' ? normalizeReferencePaths(args) : []
  const uploadedRefs = refPaths.length > 0
    ? await Promise.all(refPaths.map((p, i) => uploadReference(cfg, p, signal, i + 1)))
    : []
  const reconciled = reconcileReferenceUploads(refPaths, uploadedRefs)
  const refFiles = reconciled.references
  if (reconciled.warning !== '') log('warn', reconciled.warning)
  if (refStrategyId === '' && (typeof args?.reference === 'string' || Array.isArray(args?.references))) {
    log('info', '[角色参考] 收到参考图但未启用 referenceStrategy；视频侧仍按既有 startImage 逻辑执行，本次不上传、不改动工作流')
  }
  const wantReferenceAdapt = refStrategyId !== '' && refFiles.length > 0

  // D22：音轨上传。**必须放在 ensureComfyUp 之后** —— 提前传会撞「后端还没起」，
  //   报出来的错是连接失败，而不是「音轨有问题」，排查方向会被带偏。
  const audioTrackFile = audioTrackPath === ''
    ? ''
    : await uploadToComfy({
      cfg,
      filePath: audioTrackPath,
      fetchFn: guardedFetch,
      signal,
      namePrefix: `dshqp-track-${Date.now().toString(36)}-`,
      kind: '音轨',
    })
  if (audioTrackFile !== '') log('info', `音轨已上传：${audioTrackFile}`)

  const built = buildVideoWorkflow(caps, {
    prompt: promptForModel,
    negative: args?.negative,
    width,
    height,
    frames,
    fps,
    seed: args?.seed,
    steps: args?.steps,
    startImage,
    endImage,
    audioTrack: audioTrackFile,
    prefix: 'qwen-paint/video',
  })
  for (const note of built.notes) log('warn', note)
  let workflow = built.workflow
  const plan = built.plan
  // ★ 通用兜底会插入 LoadImage → I2V.start_image 的**节点链接**（比裸文件名字符串正确的接法）。
  //   适配成功就把 plan.mode 如实改成 i2v，别让日志说成纯文生视频。
  if (wantReferenceAdapt) {
    const adapted = await applyReferenceToWorkflow(workflow, {
      cfg, signal, refs: refFiles, mode: 'video', strategyId: refStrategyId, log,
    })
    workflow = adapted.workflow
    if (adapted.applied) plan.mode = 'i2v'
  }

  // ---- 加速档：只注入**本机真有 Wan 链对应节点**的那一档，否则如实说不注入 ----
  const has = (n) => caps?.nodes?.[n] === true
  const accelInstalled = []
  if (has('EasyCache')) accelInstalled.push('easycache')
  if (has('SpectrumQwenPatch')) accelInstalled.push('spectrum')
  if (has('PatchSageAttentionKJ') || has('SageAttention')) accelInstalled.push('sage')
  const accelId = pickAccelProfile({ frames: plan.frames, vendor: String(caps?.gpu?.vendor ?? ''), installed: accelInstalled })
  const accelProfile = accelId === null ? null : accelProfileById(accelId)
  if (accelProfile !== null && accelProfile.wanNode && has(accelProfile.wanNode)) {
    workflow[13] = { class_type: accelProfile.wanNode, inputs: { model: ['2', 0] } }
    workflow[6].inputs.model = ['13', 0]
    plan.accel = accelId
    log('info', `${describePick(accelId)} —— 已接进 Wan 链`)
  } else if (accelId === null) {
    log('info', describePick(null))
  } else {
    log('info', `${describePick(accelId)} —— 但本机没有 Wan 链对应的加速节点`
      + `（${accelProfile?.wanNode ?? '该档无 Wan 映射'}），**不注入**，照常生成`)
  }

  log('info', `视频任务：${plan.model} ${plan.width}x${plan.height} / ${plan.frames} 帧 @${plan.fps}fps`
    + `（成片 ${plan.seconds}s）/ ${plan.steps} 步 / seed=${plan.seed} / ${plan.mode}`
    + `${plan.startImage === '' ? '' : ` / 首帧=${plan.startImage}`}`
    + `${plan.endImage === '' ? '' : ` / 尾帧=${plan.endImage}`}`)

  const promptId = await submitPrompt(cfg, workflow, signal)
  inFlight.set(promptId, {
    startedAt: t0,
    key: runKey({ kind: 'video', width: plan.width, height: plan.height, frames: plan.frames, steps: plan.steps }),
  })
  const timeoutMs = Math.max(Number(cfg.timeoutMs ?? 0) || 0, 30 * 60 * 1000)
  const media = await waitForVideo(cfg, promptId, {
    signal,
    timeoutMs,
    onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
  })

  const first = media[0]
  const bytes = await fetchOutputBytes(cfg, first, signal)
  await fsp.mkdir(cfg.outputDir, { recursive: true })
  const extMatch = /\.([a-z0-9]{2,5})$/i.exec(String(first.filename))
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4'
  const filename = `${safeStem(prompt, 22)}_${cfg.filePrefix}_${plan.width}x${plan.height}_`
    + `${plan.frames}f${plan.fps}.${ext}`
  const target = await uniquePath(cfg.outputDir, filename)
  await fsp.writeFile(target, bytes)

  // ⚠ 这里的耗时变量**不能叫 seconds**：`scripts/selftest.mjs` 靠「生图段那一行 seconds 赋值」
  //   做串行循环的**右边界**去切片；视频段写同名会让它截到错位置（实测过，连注释里写那个字面量都会被当锚点）。
  const wallSeconds = Number(((Date.now() - t0) / 1000).toFixed(1))
  const value = {
    path: target,
    width: plan.width,
    height: plan.height,
    frames: plan.frames,
    fps: plan.fps,
    durationSeconds: plan.seconds,
    seed: plan.seed,
    seconds: wallSeconds,
    files: [target],
  }
  log('info', `视频落盘 ${target}（${bytes.length} 字节，耗时 ${wallSeconds}s）`)
  recordTiming(cfg.outputDir, runKey({ kind: 'video', width: plan.width, height: plan.height, frames: plan.frames, steps: plan.steps }), wallSeconds)
  inFlight.delete(promptId)
  if (typeof onProduced === 'function') {
    try { onProduced(exec, value) } catch (error) { log('warn', `交付事件登记失败（不影响出视频）：${error?.message ?? error}`) }
  }
  return value
}

const VIDEO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: '成品视频的绝对路径。' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    frames: { type: 'integer', description: '总帧数（已对齐 4n+1）。' },
    fps: { type: 'integer' },
    durationSeconds: { type: 'number', description: '成片时长（秒）= frames / fps。' },
    seed: { type: 'integer' },
    seconds: { type: 'number', description: '生成墙钟耗时（秒），不是视频长度。' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['path', 'width', 'height', 'frames', 'fps', 'durationSeconds', 'seed', 'seconds', 'files'],
}

function makeVideoTool(ctx, cfg, log, onProduced, onStart) {
  return {
    name: 'generate_video',
    description: describeVideoTool(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '视频内容描述（画面 + 动作/运镜）。' },
        negative: { type: 'string', description: '负向词。不填用内置那组（blurry/low quality/distorted/watermark）。' },
        frames: { type: 'integer', description: '帧数（9-161，自动对齐 4n+1）。25 帧≈1.04 s、81 帧≈5.06 s。' },
        fps: { type: 'integer', description: '帧率（8-30，默认随速度档 24/20/12/8）。' },
        height: { type: 'integer', description: '高度像素（自动对齐 16）。默认随速度档 720/540/480/360。' },
        width: { type: 'integer', description: '宽度像素（自动对齐 16）。不填按面板画幅比例由高度反推。' },
        steps: { type: 'integer', description: '采样步数。XT-5B 是 DMD 蒸馏，实测 3~6 步耗时几乎一样，默认 4。' },
        seed: { type: 'integer', description: '随机种子；不填每次随机。' },
        startImage: { type: 'string', description: '首帧图片的本地绝对路径（给了就走图生视频）。' },
        endImage: {
          type: 'string',
          description: '尾帧参考图的本地绝对路径（可选，H3）。⚠ 仅当本机 Wan22ImageToVideoLatent'
            + '有 end_image 输入时可用（ComfyUI 0.39.0 的节点契约里没有；给了会如实报错而不是静默忽略）。',
        },
        audio_track: {
          type: 'string',
          description: '音轨音频的本地绝对路径（可选，wav/mp3/flac/ogg/m4a）。给了就把它合进成片'
            + '（复用 VHS_VideoCombine 的 audio 槽，不额外压一遍）。文件会自动上传到 ComfyUI 的 input 目录；'
            + '音轨比视频长会被截断、短则后面留静音。',
        },
        reference: { type: 'string', description: '角色参考图的本地绝对路径（可选）。需配合 referenceStrategy 使用：按模型无关的策略把参考图锁进起始关键帧。' },
        referenceStrategy: {
          type: 'string',
          description:
            "角色参考约束策略（可选，不填 = 完全不改动工作流，行为与升级前逐字节一致）。'auto' 按后端 /object_info 的真实节点能力协商；"
            + '也可填具体策略 id（清单见 GET /api/comfy-pipeline/reference）。协商不到专属适配器时'
            + '自动回落「通用兜底」：参考图 → I2V.start_image 起始关键帧，只用任何视频扩散模型'
            + '都有的基础节点，对任意后端成立。⚠ 需同时给 reference。'
            + '联网检索参考图须用户每次显式同意，不受本参数控制。',
        },
      },
      required: ['prompt'],
    },
    timeoutMs: Math.max(Number(cfg.timeoutMs ?? 0) || 0, 30 * 60 * 1000),
    output: {
      schema: VIDEO_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `已生成视频：${value.path}（${value.width}x${value.height}，`
          + `${value.frames} 帧 @${value.fps}fps = ${value.durationSeconds}s 成片，`
          + `seed ${value.seed}，生成耗时 ${value.seconds}s）`,
      }],
      presentationMeta: (_args, value) => ({ path: value.path, files: value.files }),
    },
    /** 自测用：本次会提交的工作流（纯函数，不联网）。 */
    planWorkflow: (caps, args) => buildVideoWorkflow(caps, args),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return await runVideo(args, exec, { cfg, log, onProduced, onStart })
      } catch (error) {
        if (error instanceof Error) throw error
        const normalized = toError(error)
        normalized.message = `生成视频失败：${normalized.message}`
        throw normalized
      }
    },
  }
}

/* ------------------------------------------------- 混合模式（报告 v3 §3/§10） ---- */

/* TTS 段等待器已外置到 lib/speech-tool.js（混合模式与 generate_speech 共用一条实现）。 */

const HYBRID_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    stages: { type: 'array', items: { type: 'string' } },
    outputs: {
      type: 'object', additionalProperties: true,
      description: '三段产物：image(png) / tts(mp3 或 flac) / video(mp4，可能多段)。',
    },
    chunkPlan: { type: 'object', additionalProperties: true },
    note: { type: 'string' },
  },
  required: ['ok', 'stages', 'outputs', 'note'],
}

function makeHybridTool(ctx, cfg, log, onProduced, onStart, refs) {
  return {
    name: 'generate_hybrid',
    description: describeHybridTool(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '画面描述（生图段与视频段共用）。' },
        text: { type: 'string', description: '配音文本（TTS 段）。不填用画面描述。' },
        negative: { type: 'string' },
        frames: { type: 'integer', description: '视频段总帧数；> framesPerChunk(49) 时按 8 帧重叠分块。' },
        seed: { type: 'integer' },
        resumeVideo: {
          type: 'boolean',
          description: '段级续跑（默认开）。中断后以同参数重跑：校验 prompt/seed/帧数/首帧一致的已完成段直接复用产物，'
            + '只跑剩余段。⚠ 不做帧级续采样（ComfyUI KSampler 不支持），也不做段间帧接续；'
            + '产物被删 / 参数变了 / 超过 2 小时都会整条重跑。传 false 可关闭。',
        },
      },
      required: ['prompt'],
    },
    timeoutMs: Math.max(Number(cfg.timeoutMs ?? 0) || 0, 60 * 60 * 1000),
    output: {
      schema: HYBRID_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `混合模式三段完成：${(value.stages || []).join(' → ')}。`
          + `image=${value.outputs?.image?.path ?? ''} / tts=${value.outputs?.tts?.path ?? ''}`
          + ` / video=${value.outputs?.video?.path ?? ''}${value.note ? `。${value.note}` : ''}`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec?.signal
      if (typeof onStart === 'function') onStart()
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt === '') throw new Error('prompt 不能为空')
      await ensureComfyUp(cfg, log, signal)
      const objectInfo = await loadObjectInfoFor(cfg, signal)
      const caps = catalogForTts(objectInfo)
      const probe = probeTts(caps)
      if (!probe.available) throw new Error(probe.reason)   // 明确缺件，不假装能出音频
      log('info', `混合模式 TTS 后端：${probe.label}（${probe.tier}）`)

      const controls = readControls(cfg.outputDir)
      const frames = Number.isFinite(args?.frames) ? args.frames : (Number(controls.frames) || 49)
      const seed = Number.isFinite(args?.seed) ? args.seed : undefined
      const drawTool = refs?.drawTool
      const videoTool = refs?.videoTool
      const speechRunner = refs?.speechRunner ?? makeSpeechRunner(makeSpeechDeps(cfg, log))
      if (!drawTool || !videoTool) throw new Error('混合模式缺少生图/视频工具引用（插件内部错误）')

      // 视频段：按 chunkPlan 逐段提交（每段一个 prompt_id），不做帧间接续/自动合流。
      const submitVideoSegments = async (chunkPlan, firstFrame) => {
        const videoCaps = await probeCapabilities(cfg, log, signal)
        const segments = chunkPlan && chunkPlan.chunks > 1
          ? chunkPlan.segments
          : [{ index: 0, frameCount: frames, seedOffset: 0 }]
        // ★ 2026-11-17（H4）：段级续跑账本。显式 resumeVideo !== false 时启用：
        //   同参数（prompt/seed/帧数/首帧）且产物仍在 → 跳过已完成段，只跑剩余段。
        //   ⚠ 不做帧级续采样（KSampler 不支持），也不做段间帧接续（既有语义）。
        const resumeOn = args?.resumeVideo !== false && cfg.outputDir !== ''
        const resumeStore = resumeOn ? createResumeStore({ outputDir: cfg.outputDir,
          fs: { readFileSync, writeFileSync, existsSync, mkdirSync }, path, log }) : null
        const jobSpec = { prompt, negative: args?.negative, width, height: Number.isFinite(fps) ? fps : 24, startImage: firstFrame }
        const segSpecs = segments.map((s) => ({ index: s.index, frameCount: s.frameCount,
          seed: Number.isFinite(seed) ? seed + (Number(s.seedOffset) || 0) : undefined }))
        const resumed = resumeStore ? resumeStore.begin(jobSpec, segSpecs) : { keys: segSpecs.map(() => ''), reusable: [] }
        const reusableByIndex = new Map(resumed.reusable.map((r) => [r.index, r]))
        if (resumed.reusable.length > 0) {
          log('info', `续跑：${resumed.reusable.length}/${segments.length} 段已有产物且参数一致，跳过；只重跑剩余段`
            + `（账本 ${RESUME_DIR_NAME}/${resumeStore?.file ? '…' : '…'}）`)
        }
        const produced = []
        for (let si = 0; si < segments.length; si += 1) {
          if (signal?.aborted) throw cancelReason(signal)
          const seg = segments[si]
          const hit = reusableByIndex.get(si)
          if (hit) {
            produced.push({ path: hit.path, files: [hit.path], frames: hit.frameCount,
              jobId: hit.jobId ?? 'resumed', resumed: true })
            log('info', `续跑段 ${seg.index + 1}/${segments.length} 复用已完成产物 ${hit.path}`)
            continue
          }
          const built = buildVideoWorkflow(videoCaps, {
            prompt,
            negative: args?.negative,
            frames: seg.frameCount,
            seed: Number.isFinite(seed) ? seed + seg.seedOffset : undefined,
            startImage: firstFrame,
            prefix: `qwen-paint/hybrid-c${seg.index}`,
          })
          for (const note of built.notes) log('warn', note)
          const pid = await submitPrompt(cfg, built.workflow, signal)
          const media = await waitForVideo(cfg, pid, { signal, timeoutMs: 30 * 60 * 1000 })
          const first = media[0]
          const bytes = await fetchOutputBytes(cfg, first, signal)
          await fsp.mkdir(cfg.outputDir, { recursive: true })
          const extMatch = /\.([a-z0-9]{2,5})$/i.exec(String(first.filename))
          const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4'
          const target = await uniquePath(cfg.outputDir, `${safeStem(prompt, 22)}_${cfg.filePrefix}_c${seg.index}.${ext}`)
          await fsp.writeFile(target, bytes)
          produced.push({ path: target, files: [target], frames: seg.frameCount, jobId: pid })
          log('info', `混合模式视频段 ${seg.index + 1}/${segments.length} 落盘 ${target}（${bytes.length} 字节）`)
          // H4：完成一段立刻记账（崩溃/中断时也只丢当前段，已完成的都能续）。
          if (resumeStore) {
            try { resumeStore.complete(resumed.id, resumed.keys[si], { path: target, frameCount: seg.frameCount, jobId: pid }) }
            catch (error) { log('warn', `续跑账本写入失败（不影响交付）：${error?.message ?? error}`) }
          }
        }
        return {
          path: produced[produced.length - 1]?.path ?? '',
          files: produced.flatMap((p) => p.files),
          segments: produced,
          chunkPlan: chunkPlan ?? null,
          // H4 如实回报：复用段数 / 是否用了续跑。
          ...(resumed.reusable.length > 0
            ? { resumedSegments: resumed.reusable.length, totalSegments: segments.length } : {}),
        }
      }

      const submitStage = async (stage, sctx) => {
        if (stage.id === 'image') {
          return await drawTool.execute({ prompt, negative: args?.negative, seed }, exec)
        }
        if (stage.id === 'tts') {
// 设计说明已外置 → docs/index-design-notes.md#index-note-001（原 L1401-1404）
          const ttsUi = readUiState()
          return await speechRunner({
            text: String(args?.text ?? '').trim() || prompt,
            seed: seed ?? 0,
            prefix: 'qwen-paint/tts',
            stem: prompt,
            signal,
            caps,
            backend: String(ttsUi.ttsBackend ?? ''),
            voiceSample: String(ttsUi.ttsVoiceSample ?? ''),
          })
        }
        // video：消费生图首帧（I2V），按 chunkPlan 分段，段间模型由 runHybrid 卸载
        return await submitVideoSegments(sctx.chunkPlan, sctx.outputs?.image?.path ?? '')
      }
      const unload = async () => {
        await fetchWithTimeout(`${cfg.comfyUrl}/free`, {
          method: 'POST',
          body: JSON.stringify({ unload_models: true, free_memory: true }),
          timeoutMs: 15000,
          signal,
        })
      }

      const result = await runHybrid({
        frames,
        framesPerChunk: 49,
        overlap: Number(controls.chunkOverlap) || 8,
        submitStage,
        unload,
        onProgress: (pct, note) => log('info', `混合模式 ${Math.round(pct * 100)}% ${note}`),
        signal,
      })
      const value = {
        ok: true,
        stages: result.results.map((r) => r.stage),
        outputs: result.outputs,
        chunkPlan: result.chunkPlan,
        note: '三段各交付文件；音频与 mp4 未自动合流，多段 mp4 未做帧间接续（本工具不调 ffmpeg）。',
      }
      if (typeof onProduced === 'function') {
        try { onProduced(exec, value) } catch (error) { log('warn', `交付事件登记失败：${error?.message ?? error}`) }
      }
      return value
    },
  }
}

function makeDrawTool(ctx, cfg, log, onProduced, onStart) {
  return {
    name: 'draw_image',
    description: describeDrawTool(cfg),
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-019（原 L1682-1685）
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-020（原 L1696-1703）
    async execute(args, exec) {
      try {
// 设计说明已外置 → docs/index-design-notes.md#index-note-021（原 L1706-1716）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-022（原 L1772-1797）
let preferredReferenceStrategy = ''

/** 面板写端点用：只接受策略表里的 id / 'auto' / ''，脏值一律归零，不把每次生成带进不存在的策略名。 */
function setPreferredReferenceStrategy(id) {
  const v = typeof id === 'string' ? id.trim() : ''
  const allowed = new Set(['', 'auto', 'universal-latent'])
  for (const s of REFERENCE_STRATEGIES) allowed.add(s.id)
  preferredReferenceStrategy = allowed.has(v) ? v : ''
  return preferredReferenceStrategy
}

/**
 * 参数优先级：**显式工具入参 > 面板控件 > 未启用**。
 * 返回 '' ⇒ 生成路径完全不碰参考图逻辑（零漂移，与升级前逐字节一致）。
 */
function resolveReferenceStrategy(args) {
  const explicit = typeof args?.referenceStrategy === 'string' ? args.referenceStrategy.trim() : ''
  return explicit !== '' ? explicit : preferredReferenceStrategy
}

// 设计说明已外置 → docs/index-design-notes.md#index-note-023（原 L1818-1835）
async function applyReferenceToWorkflow(workflow, opts) {
  const { cfg, signal, refs, mode, strategyId, log } = opts
  const list = (Array.isArray(refs) ? refs : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  if (list.length === 0) return { workflow, applied: false, strategy: null, notes: [] }
  let objectInfo = null
  try { objectInfo = await loadObjectInfoFor(cfg, signal) } catch { objectInfo = null }
  // ★ 2026-11-17（H2）：每张参考图的独立权重/衰减/mask —— 显式给了才叠加，零漂移。
  //   controls 从 opts（调用方 args）传进来；视频模式暂不接（本机没有 per-ref 时序门控节点）。
  const refControls = Array.isArray(opts.controls) ? opts.controls : []
  const prefer = strategyId && strategyId !== 'auto' ? strategyId : undefined
  const r = adaptReference({ workflow, mode, refs: list, nodeSet: objectInfo, prefer })
  if (r.applied !== true) {
    for (const n of r.notes) log('info', `[角色参考] ${n}`)
    return { workflow, applied: false, strategy: r.strategy, notes: r.notes }
  }
  let appliedWorkflow = r.workflow
  let controlNotes = []
  if (mode === 'image' && refControls.length > 0) {
    const nodeSet = objectInfo instanceof Set ? objectInfo
      : new Set(Object.keys(objectInfo && typeof objectInfo === 'object' ? objectInfo : {}))
    const cr = planReferenceControls(appliedWorkflow, { refs: list, controls: refControls }, nodeSet)
    for (const n of cr.notes) log('info', `[参考图权重] ${n}`)
    if (cr.applied) {
      appliedWorkflow = applyReferencePlan(appliedWorkflow, cr).workflow
      controlNotes = cr.notes
    }
  }
  // structuredClone 只克隆可枚举自有属性 ⇒ 原工作流上不可枚举的 __plan/__effective/
  // __cnet 会丢。重建一遍，保证下游 readWorkflowMeta 与提交体语义不变。
  const meta = readWorkflowMeta(workflow)
  const rebuilt = attachWorkflowMeta(appliedWorkflow, {
    __effective: meta.effective ?? {},
    __plan: meta.plan ?? {},
    __cnet: meta.cnet ?? {},
  })
  for (const n of r.notes) log('info', `[角色参考] ${n}`)
  log('info', `[角色参考] 已应用 ${describeStrategy(r.strategy)}（${mode}）`)
  return { workflow: rebuilt, applied: true, strategy: r.strategy, notes: [...r.notes, ...controlNotes] }
}

function resolveDrawParams(args, cfg, pref) {
  const p = pref ?? {}
  // 一次判"显式给了没"，后续各档都复用同一条规则
  const hasPreset = typeof args?.preset === 'string' && args.preset !== ''
  const hasSize = typeof args?.size === 'string' && ASPECTS[args.size] !== undefined
  const hasMega = Number.isFinite(args?.megapixels) && args.megapixels > 0
  const hasSteps = Number.isFinite(args?.steps)
  const hasCount = Number.isFinite(args?.count)
  const hasNeg = typeof args?.negative === 'string' && args.negative.trim() !== ''
  const hasCfg = Number.isFinite(args?.cfg)

  // 只在对应参数**缺省**时才谈记忆 —— 否则置 null，绝不参与后续决策
  const prefSize = !hasSize && typeof p.size === 'string' && ASPECTS[p.size] ? p.size : null
  const prefPreset = !hasPreset && typeof p.preset === 'string' && p.preset !== '' && p.preset !== 'default'
    ? p.preset
    : null
  const prefMega = !hasMega && Number.isFinite(p.megapixels) && p.megapixels > 0 ? p.megapixels : null
  const prefSteps = !hasSteps && Number.isFinite(p.steps) ? Math.max(1, Math.trunc(p.steps)) : null
  const prefCount = !hasCount && Number.isFinite(p.count) ? Math.max(1, Math.min(4, Math.trunc(p.count))) : null
  const prefNegative = !hasNeg && typeof p.negative === 'string' && p.negative.trim() !== '' ? p.negative : null
  // ★ 0.19.2：CFG 可调。蒸馏链（Turbo8 / 官方 Turbo）要求 1.0，buildWorkflow 会强制回 1，
  //   所以这里只是把"面板拨过的 cfg"喂给下游，由它决定是否真覆盖（原生链默认 2.5）。
  const prefCfg = !hasCfg && Number.isFinite(p.cfg) ? p.cfg : null

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
    cfg: hasCfg ? args.cfg : (prefCfg ?? undefined),
    memFilled: [
      ...(prefSize ? [`画幅=${prefSize}`] : []),
      ...(prefMega ? [`${prefMega}MP`] : []),
      ...(prefSteps ? [`${prefSteps} 步`] : []),
      ...(prefCount ? [`每轮 ${prefCount} 张`] : []),
      ...(prefNegative ? ['负向词'] : []),
      ...(prefCfg ? [`CFG=${prefCfg}`] : []),
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
      // ★ 2026-11-10（素材库）：设计风格 + 用户指令 + 挂载的 skill 拼进**送给模型的**提示词。
      //   ⚠ 文件名仍用用户原文（见下面 safeStem）—— 否则落盘名会变成一长串风格词。
      //   ⚠ 拼败了就用原文：素材库是增效，不能把出图拖死。
      let promptForModel = prompt
      let styleApplied = null
      try {
        const lib = readLibrary(cfg.outputDir)
        const style = listStyles(cfg.outputDir).find((x) => x.id === lib.selected) ?? null
        const allSkills = lib.skills.length > 0 ? listSkills(cfg) : []
        const composed = composePrompt(prompt, {
          style,
          instruction: lib.instruction,
          skillsText: skillsToText(lib.skills, allSkills),
        })
        promptForModel = composed.text === '' ? prompt : composed.text
        styleApplied = { style: style?.id ?? 'none', parts: composed.parts.map((p) => p.label), truncated: composed.truncated }
        if (composed.parts.length > 0) {
          log('info', `素材库生效：${composed.parts.map((p) => p.label).join('、')}`
            + `${composed.truncated.length > 0 ? `（${composed.truncated.join('；')}）` : ''}`)
        }
      } catch (error) {
        styleApplied = null
        log('warn', `素材库读取失败（已忽略，照常出图）：${error?.message ?? error}`)
      }
      // ★ 出图**一开始**就记一次活动。否则存在这么一个毫秒级窗口：上次出图已过 5 分钟，
      //   这次刚进来还没 submit（所以 /queue 还是空的），定时器正好 tick 到 → 会把
      //   正在用的后端关掉。先 touch 就彻底堵上这个窗口。
      if (typeof onStart === 'function') onStart()

// 设计说明已外置 → docs/index-design-notes.md#index-note-024（原 L1947-1950）
      const prefMemory = (await readPreferences(cfg, log)) ?? {}
// 设计说明已外置 → docs/index-design-notes.md#index-note-025（原 L1952-1955）
      const panelControls = readControls(cfg.outputDir)
      const pref = { ...prefMemory, ...controlsToPref(panelControls) }
      const rp = resolveDrawParams(args, cfg, pref)
      // ★ resolveDrawParams 返回的字段叫 `cfg`，这里用别名接成下游 buildWf 要的 `cfgOverride`。
      //   早先直接解构一个不存在的 `cfgOverride` ⇒ CFG 覆盖恒为 undefined，面板拨了不生效。
      const { preset, aspect, megapixels, steps, count, negative, cfg: cfgOverride, memFilled } = rp
      // seed 单独走：-1 = 每次随机（resolveSeed 对 -1 返回 null），显式 args.seed 永远赢
      const panelSeed = resolveSeed(panelControls, args?.seed)
      const seed = Number.isFinite(panelSeed) ? Math.trunc(panelSeed) : Math.floor(Math.random() * 2 ** 31)
      // 只在控制项**真的偏离默认值**时说一句，避免每次出图都刷屏
      if (JSON.stringify(panelControls) !== JSON.stringify(DEFAULT_PIPELINE_CONTROLS)) {
        log('info', `面板控制项生效：${describePipelineControls(panelControls)}`
          + `${Number.isFinite(panelSeed) ? `，seed=${panelSeed}` : ''}`)
      }
      if (memFilled.length > 0) {
        log('info', `已按记忆偏好补默认：${memFilled.join('、')}（你本次没显式指定；想改就显式传参）`)
      }
      const [width, height] = calcSize(aspect, megapixels)

      // ★★★ 2026-10-08：**后端分派**。默认 'comfyui' → 走下面原有逻辑，一行不改。
      if (cfg.imageBackend === 'hipfire') {
        return await executeHipfire(args, exec, { cfg, log, prompt, aspect, megapixels, steps, seed, width, height, onProduced })
      }

      if (shouldProbe(args)) await ensureComfyUp(cfg, log, signal)

// 设计说明已外置 → docs/index-design-notes.md#index-note-026（原 L1982-1993）
      const refPaths = normalizeReferencePaths(args)
      const refPath = refPaths[0] ?? ''
      // ★ 2026-10-14（C4「专业卡版」）：ControlNet 控制图 —— 与参考图**同样要上传**给 ComfyUI。
      const cnetPath = typeof args?.controlImage === 'string' ? args.controlImage.trim() : ''
      // ★ 2026-11-17（H1）：多 ControlNet 栈 —— 每项 { image, name, strength, startPercent, endPercent }。
      //   image 是本地路径，必须逐张上传换成 ComfyUI 侧文件名（本地绝对路径进工作流 = 跨机必炸）。
      //   name 是 panel 选中的权重（可逐路不同），未给的路由 buildWorkflow 记原因不静默。
      const controlStackRaw = Array.isArray(args?.controlStack)
        ? args.controlStack.filter((x) => x && typeof x === 'object' && typeof x.image === 'string' && x.image.trim() !== '').slice(0, 4)
        : []
      const [ready, uploadedRefs, controlImage, ctrlStackUploaded, caps] = await Promise.all([
        probeReadiness(cfg, signal),
        Promise.all(refPaths.map((p, i) => uploadReference(cfg, p, signal, i + 1))),
        cnetPath !== '' ? uploadReference(cfg, cnetPath, signal) : Promise.resolve(''),
        Promise.all(controlStackRaw.map((x) => uploadReference(cfg, x.image.trim(), signal))),
        probeCapabilities(cfg, log, signal),
      ])
      const controlStack = controlStackRaw.map((x, i) => ({
        image: ctrlStackUploaded[i] ?? '',
        name: String(x.name ?? '').trim(),
        ...(Number.isFinite(x.strength) ? { strength: x.strength } : {}),
        ...(Number.isFinite(x.startPercent) ? { startPercent: x.startPercent } : {}),
        ...(Number.isFinite(x.endPercent) ? { endPercent: x.endPercent } : {}),
      }))
      const reconciled = reconcileReferenceUploads(refPaths, uploadedRefs)
      const references = reconciled.references
      if (reconciled.warning !== '') log('warn', reconciled.warning)
      const reference = references[0] ?? ''
      // ★ 模型无关的角色参考：只有显式给了 referenceStrategy 且真有参考图时才启用。
      //   不给 = 一行不改（零漂移，既有行为逐字节不变）。联网检索是独立能力，
      //   须用户每次显式同意，与本参数无关。
      const refStrategyId = resolveReferenceStrategy(args)
      const wantReferenceAdapt = refStrategyId !== '' && references.length > 0
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
      if (refPaths.length > 0) {
        log('info', `参考图已上传 ${refPaths.length} 张：`
          + refPaths.map((p, i) => `${p} → ${references[i] ?? '(失败)'}`).join('；'))
      }
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-027（原 L2050-2056）
      const buildWf = (overrideCfg, iterSeed, iterCount) => buildWorkflow(
        overrideCfg ?? cfg,
        {
          prompt: promptForModel,
          negative,
          width,
          height,
          steps,
          // ★ 0.19.2：CFG 用户覆盖值（蒸馏链里 buildWorkflow 会强制回 1，原生链才真生效）。
          cfgOverride: Number.isFinite(cfgOverride) ? cfgOverride : undefined,
          seed: Number.isFinite(iterSeed) ? iterSeed : seed,
          reference,
          references,
          // ★ 2026-10-14（C4）：ControlNet 控制图（上传后的 ComfyUI 文件名）
          controlImage,
          // ★ 2026-11-17（H1）：多 ControlNet 栈（每项 image 已换成 ComfyUI 文件名）
          controlStack,
          count: Number.isFinite(iterCount) ? iterCount : perIterCount,
        },
        caps,
      )

      let workflow = buildWf(undefined, seed, perIterCount)
      // ★ 串行抽卡只在文生图（reference === ''）启用，与「有参考图」互斥 ⇒ iterations 恒为 1，
      //   循环里不会重建 workflow，因此这里适配一次即可，无需在迭代内重复。
      if (wantReferenceAdapt) {
        const adapted = await applyReferenceToWorkflow(workflow, {
          cfg, signal, refs: references, mode: 'image', strategyId: refStrategyId, log,
          // ★ 2026-11-17（H2）：每张参考图的独立权重 / 衰减 / mask（显式给了才叠加）。
          controls: args?.referenceControls,
        })
        workflow = adapted.workflow
      }
      const wfMeta = readWorkflowMeta(workflow)
      const usedSteps = wfMeta.plan?.steps ?? workflow[8]?.inputs?.steps ?? steps
// 设计说明已外置 → docs/index-design-notes.md#index-note-028（原 L2088-2091）
      const eff = wfMeta.effective ?? { width, height, locked: false }
      // ★ 2026-10-14（C4）：ControlNet 是否真的接上了（没接上时带原因，如实回报）
      const cnet = wfMeta.cnet ?? { applied: false, name: '', reason: '' }
// 设计说明已外置 → docs/index-design-notes.md#index-note-029（原 L2095-2100）
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
        const iterMeta = readWorkflowMeta(workflow)
// 设计说明已外置 → docs/index-design-notes.md#index-note-030（原 L2119-2122）
        const iterDedup = createLocalDedup(cfg.outputDir)
        const dedupLookupKey = semanticFingerprint(workflow)
        const cachedFiles = iterDedup.lookup(dedupLookupKey)
        if (cachedFiles !== null) {
          log('info', `命中本地去重缓存（同提示词/同参数/同 seed）→ **不提交**，`
            + `直接复用已有 ${cachedFiles.length} 个文件`)
          for (const cached of cachedFiles) {
            index += 1
            savedFiles.push(cached)
            if (firstPath === '') firstPath = cached
          }
          continue
        }
        log('info', `提交任务 ${outWidth}x${outHeight} 档位=${caps.level} steps=${usedSteps} `
          + `cfg=${iterMeta.plan?.cfg ?? workflow[8]?.inputs?.cfg} seed=${seed + iter}`
          + `${iterations > 1 ? `（第 ${iter + 1}/${iterations} 张）` : ''}`
          + `${reference === '' ? '（文生图）' : `（图生图 参考=${reference}）`}`)

        let promptId, images
        try {
          promptId = await submitPrompt(cfg, workflow, signal)
          // ★ 进度：提交成功的那一刻就登记在飞（务必早于 waitForResult）。排队与采样
          //   都发生在 wait 期间；若等出图后才 set，inFlight 全程为空 ⇒ 进度/ETA 形同虚设。
          if (typeof promptId === 'string' && promptId !== '') {
            inFlight.set(promptId, {
              startedAt: t0,
              key: runKey({ kind: 'image', width: outWidth, height: outHeight, steps: usedSteps }),
            })
          }
          images = await waitForResult(cfg, promptId, {
            signal,
            timeoutMs: cfg.timeoutMs,
            onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
          })
        } catch (firstError) {
          // 摘掉首次提交（可能已在 wait 期间失败）的在飞登记，避免 OOM 重跑后残留旧 id。
          if (typeof promptId === 'string' && promptId !== '') inFlight.delete(promptId)
          const isOom = isOutOfMemoryError(firstError)
          const allowFallback = cfg.oomAutoFallback !== false
          if (!isOom || !allowFallback) throw firstError
          const firstMsg = String(firstError?.message ?? firstError).slice(0, 200)
          log('warn', `出图撞 OOM（${firstMsg}）→ 自动开启 VAE 分块解码重跑…`)
          const retryCfg = { ...cfg, vaeTiling: 'on' }
// 设计说明已外置 → docs/index-design-notes.md#index-note-031（原 L2166-2169）
          workflow = buildWf(retryCfg, seed + iter, perIterCount)
          oomRetried = true
          try {
            promptId = await submitPrompt(cfg, workflow, signal)
            if (typeof promptId === 'string' && promptId !== '') {
              inFlight.set(promptId, {
                startedAt: t0,
                key: runKey({ kind: 'image', width: outWidth, height: outHeight, steps: usedSteps }),
              })
            }
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
        } finally {
          // 进度收尾：无论成功 / 失败 / OOM 重跑都摘掉当前 id，绝不残留。
          if (typeof promptId === 'string' && promptId !== '') inFlight.delete(promptId)
        }
        // ---- 落盘（校验逻辑与原版一字不差，只是现在可能随串行跑多次）------------
        const iterFiles = []
        for (const image of images.slice(0, perIterCount)) {
          index += 1
          const bytes = await fetchImageBytes(cfg, image, signal)

// 设计说明已外置 → docs/index-design-notes.md#index-note-032（原 L2204-2220）
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
          iterFiles.push(target)
        }
        // 记进本地去重表：键用**本次真正提交的** workflow 现算
        //   （OOM 重跑会把 workflow 换成 vaeTiling 版，拿旧键记会记成一个永远命中不了的条目）。
        //   写盘失败不影响出图 —— 顶多下次重跑。
        if (iterFiles.length > 0) iterDedup.remember(semanticFingerprint(workflow), iterFiles)
        // 在飞登记由上面的 finally 统一摘除：waitForResult 返回即视为任务完成，
        //   落盘是本地 IO，不算「仍在飞」；异常路径也不会残留。
      }
      const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
      // 实测耗时入库（EWMA）—— 下次同尺寸的 ETA 就用它，用不到就不给 ETA，绝不猜。
      recordTiming(cfg.outputDir, runKey({ kind: 'image', width: outWidth, height: outHeight, steps: usedSteps }), seconds)
      if (oomRetried) {
        log('info', `本次为 OOM 自动重跑成功（用时 ${seconds}s，包含重跑）`)
      }
      if (firstPath === '') throw new Error('ComfyUI 报告成功，但没有取到任何图片')

// 设计说明已外置 → docs/index-design-notes.md#index-note-033（原 L2262-2273）
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
        // ★ 2026-11-17（H1）：多路叠加如实回报 —— 接了几路、哪几路没接及原因。
        ...(Number.isFinite(cnet.stackApplied) && cnet.stackTotal > 0
          ? {
            controlStackApplied: Number(cnet.stackApplied),
            controlStackTotal: Number(cnet.stackTotal),
            ...(Array.isArray(cnet.stackNotes) && cnet.stackNotes.length > 0
              ? { controlStackSkipped: cnet.stackNotes } : {}),
          }
          : {}),
        ...(refPaths.length > 1
          ? { referenceMode: 'multi', referenceCount: references.length }
          : {}),
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-001（原 L2033-2037）
      const recordNodes = Object.values(workflow ?? {})
      const recordLoras = recordNodes
        .filter((n) => String(n?.class_type ?? '').includes('LoraLoader'))
        .map((n) => ({ name: String(n?.inputs?.lora_name ?? ''), strength: Number(n?.inputs?.strength_model ?? 1) }))
        .filter((x) => x.name !== '')
      const recordUnet = String(wfMeta?.plan?.models?.unet ?? '')
      const recordCfgValue = Number(workflow?.[8]?.inputs?.cfg)
      try {
        historyStore?.record({
          file_path: firstPath, prompt: args?.prompt, tool_name: 'draw_image',
          model: cfg.imageBackend ?? 'comfyui', steps: usedSteps, seed,
          width: outWidth, height: outHeight, kind: 'image',
          extra: {
            negative: String(negative ?? '').slice(0, 200), seconds,
            cfg: Number.isFinite(recordCfgValue) ? recordCfgValue : null,
            unet: recordUnet,
            loras: recordLoras,
          },
        })
      } catch (error) {
        log('warn', `历史写入失败（不影响出图）：${error?.message ?? error}`)
      }
      return value
}

/* ------------------------------------------------------------------ 辅助引擎（放大 / 局部重绘）---- */

/**
 * ★ 2026-11-17（M5）：放大链 SaveImage 前缀。模板未配置 = 原样返回 tag
 * （`VOSR2_xxx` / `RealESRGAN_xxx` 平铺，行为逐字节不变）；配置了则落到
 * 同一个模板目录下（如 `{date}/VOSR2_xxx`），与主链产物共用目录组织。
 */
function upscaleSavePrefix(cfg, tag) {
  const base = applyFilePrefixTemplate(cfg?.filePrefixTemplate)
  return base !== '' ? `${base}/${tag}` : tag
}

// 设计说明已外置 → docs/index-design-notes.md#index-note-034（原 L2365-2374）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-035（原 L2390-2406）
function memoryPaths(cfg) {
  const base = String(cfg?.outputDir ?? '').trim()
  if (base === '') return { log: '', pref: '' }
  return {
    log: path.join(base, '.qwen-paint-memory.jsonl'),
    pref: path.join(base, '.qwen-paint-preferences.json'),
  }
}

// 设计说明已外置 → docs/index-design-notes.md#index-note-036（原 L2416-2425）
function uiMaskPath(cfg) {
  const rnd = Math.random().toString(36).slice(2, 8)
  return path.join(cfg.outputDir, `.qwen-paint-mask-${Date.now()}-${rnd}.png`)
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
    return failBody(error)
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-037（原 L2526-2545）
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
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: upscaleSavePrefix(cfg, `VOSR2_${cfg.filePrefix}_`) } },
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
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: upscaleSavePrefix(cfg, `RealESRGAN_${cfg.filePrefix}_`) } },
    }
    engineLabel = 'RealESRGAN'
  }
  log('info', `提交放大任务 ${engineLabel} ×${sc} 分块=${tileSize}/${vaeTileSize}`)
  const value = await submitAndSave(cfg, log, signal, workflow, { prefix: 'upscale' })
  // B6：按倍数分两档，只给相对量级（不编精确秒数 —— 没有可靠基准时编数字等于骗人）。
  return { ...value, upscaler: engineLabel, scale: sc,
    // B5：超分把主模型卸了换放大模型，记账供下一轮判断要不要重载。
    residency: touchResidency(RESIDENCY_KEYS.upscale),
    cost: sc <= 2 ? '快速档：耗时约为质量档的一半' : '质量档：约为快速档 2–3 倍耗时' }
}

function makeUpscaleTool(cfg, log) {
  return {
    name: 'upscale_image',
    description: describeUpscaleTool(),
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
    output: makeBinaryOutputContract({
      description: '放大结果：保存路径、尺寸、倍数、引擎。',
      render: (_args, v) => [{
        type: 'text',
        text: `已放大（${v.upscaler ?? ''} ×${v.scale ?? ''}）：${v.path}（${v.width}x${v.height}，用时 ${v.seconds}s）`,
      }],
    }),
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
 * 局部重绘的「零下载潜空间重绘」原理（为何不用 ControlNet、ComfyUI 源码依据、
 * denoise / grow / feather 参数取舍）已外置归档到 `docs/index-design-notes.md` 第二节。
 * 2026-10-19 起该实现不加载任何 ControlNet 权重；改动前先读归档，别凭感觉改。
 */
/**
 * 0.18 通用任务工具：局部重绘 / 元素移除 / 四向扩图。
 *
 * 三者共用同一条「裁剪 → 采样 → 回贴」链：
 *   InpaintCropImproved → TextEncodeQwenImageEditPlus → SamplerCustomAdvanced
 *   → InpaintStitchImproved
 * 因而蒙版外区域由原图回贴，不再整图 VAE 往返。
 */
function makeTaskTool(cfg, log, kind) {
  const spec = TASK_SPECS[kind]
  if (!spec) throw new Error(`未知任务工具：${kind}`)
  const render = (_args, value) => [{
    type: 'text',
    text: `${spec.label}完成：${value.path}（${value.width}x${value.height}，seed ${value.seed}，用时 ${value.seconds}s`
      + `${value.lora ? `，LoRA ${value.lora}` : '，未使用任务 LoRA'}）`,
  }]
  return {
    name: spec.name,
    description: spec.description,
    parameters: buildTaskParameters(spec),
    timeoutMs: cfg.timeoutMs,
    output: makeBinaryOutputContract({
      description: `${spec.label}结果：保存路径、尺寸、种子。`,
      render,
    }),
    /** 自测用：原始文件名的计划图（不联网）。 */
    planWorkflow: (args) => buildTaskWorkflow(cfg, {
      mode: spec.mode,
      image: String(args?.image ?? 'image.png'),
      mask: String(args?.mask ?? 'mask.png'),
      prompt: String(args?.prompt ?? spec.label),
      seed: Number.isFinite(args?.seed) ? Math.trunc(args.seed) : 0,
      ...taskDirections(args, spec),
    }),
    async execute(args, exec) {
      try {
        return await runTask(args, spec, { cfg, log, signal: exec?.signal }, {
          ensureComfyUp,
          probeCapabilities,
          uploadReference,
          buildTaskWorkflow,
          submitAndSave,
        })
      } finally {
        maybeAutoUnload()
      }
    },
  }
}

function makeEditTool(cfg, log) {
  return makeTaskTool(cfg, log, 'inpaint')
}

function makeRemoveTool(cfg, log) {
  return makeTaskTool(cfg, log, 'remove')
}

function makeOutpaintTool(cfg, log) {
  return makeTaskTool(cfg, log, 'outpaint')
}

// 设计说明已外置 → docs/index-design-notes.md#index-note-038（原 L2734-2747）
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
 * 宿主侧入口。按用户的经验（MEMO 5189）：**用局部 `root.inject` 等服务**，
 * 不要用对象级 `inject` —— 对象级会把整个 apply 推迟到服务就绪之后，某个服务
 * 在老宿主里不存在时插件会**永远不 apply**，而且不报错，极难排查。
 */

// 设计说明已外置 → docs/index-design-notes.md#index-note-039（原 L2849-2871）
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
  const log = makeLog(root, cfg.progressMode)
  // ★ 第一行就记：能证明"插件 host 半边确实被加载了"。
  //   （之前排查时最大的困难就是分不清"没加载"和"加载了但判断错"。）
  // ⚠ pid 现在由 diag() 自己加在行首，这里不再重复（否则一行两个 pid=）
  diag('apply', `插件开始加载 platform=${process.platform} node=${process.version}`)
  /** ★ 2026-10-19：`inpaint_image` 工具的引用 —— 面板圈选重绘的端点要用它。 */
  let editToolRef = null
  /** ★ 2026-11-12「图片编辑台」：移除 / 扩图 / 放大三个动作的端点也要直接调工具。 */
  let removeToolRef = null
  let outpaintToolRef = null
  let upscaleToolRef = null
  // 混合模式要复用生图/视频两个工具的 execute（不重跑它们内部那套探测/落盘逻辑）。
  let drawToolRef = null
  let videoToolRef = null
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

  // ★ 2026-11-13：CPU 加速档同样"界面上选了就记住"（与 flowStyle / drawTrigger 同一套，
  //   显式配置优先）。⚠ 启动参数那部分要重启 ComfyUI 才生效 —— 界面上已写明。
  //   非法值只忽略、不写进 cfg（白名单校验在 normalizeCpuAccelMode 里）。
  if (rawConfig?.cpuAccel === undefined) {
    const savedCpuAccel = normalizeCpuAccelMode(savedUi.cpuAccel)
    if (savedCpuAccel !== 'off') {
      cfg.cpuAccel = savedCpuAccel
      log('info', `CPU 加速档：沿用上次界面选择（${savedCpuAccel}）—— 重启 ComfyUI 后生效`)
    }
  }

// 设计说明已外置 → docs/index-design-notes.md#index-note-040（原 L2935-2938）
  if (rawConfig?.mainModelOverride === undefined
      && typeof savedUi.unet === 'string' && savedUi.unet !== '') {
    cfg.mainModelOverride = savedUi.unet
    log('info', `主模型：沿用上次界面选择（${savedUi.unet}）—— 是否被采纳以探测清单为准`)
  }

  // ★ 档位不只改启动参数，还会改**工作流**里 QwenImage21Cache 的 device
  //   （纯 CPU 模式下让 KV 缓存放内存、后台预取）。**显式配置优先** ——
  //   用户自己在 cordis.patch.yml 里写了 qwenCacheDevice 就绝不覆盖。
  if (cfg.cpuAccel !== 'off') {
    const cpuPlan = cpuAccelPlan(
      getCpuProfile({ flags: cfg.cpuFlags, physicalCores: cfg.cpuPhysicalCores }),
      {
        mode: cfg.cpuAccel,
        threads: cfg.cpuThreads,
        oomFallback: cfg.cpuOomFallback === true,
        bf16: cfg.cpuBf16,
        cacheOnCpu: cfg.cpuCacheOnCpu === true,
      },
    )
    for (const [k, v] of Object.entries(cpuPlan.workflowOverrides)) {
      if (rawConfig?.[k] === undefined) {
        cfg[k] = v
        log('info', `CPU 加速档 ${cfg.cpuAccel} → ${k}=${v}（工作流级，下次出图生效）`)
      }
    }
  }

// 设计说明已外置 → docs/index-design-notes.md#index-note-041（原 L2967-2970）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-042（原 L2982-2997）
  {
    const allowRemote = cfg.allowRemoteComfy === true
    // ① 先把开关写进 net-guard 的全局状态：这样**所有**走 guardedFetch / assertLocalUrl
    //    的地方（含 config.js 里 8 处 fetchWithTimeout 调用）自动继承，结构上不可能漏。
    setAllowRemote(allowRemote)
    cfg.netAllowRemote = allowRemote

// 设计说明已外置 → docs/index-design-notes.md#index-note-043（原 L3005-3017）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-044（原 L3045-3062）
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-045（原 L3074-3078）
  ;((ctx) => {
    inited = true
// 设计说明已外置 → docs/index-design-notes.md#index-note-046（原 L3081-3096）
    diag('host', `ctx API：on=${typeof ctx?.on} effect=${typeof ctx?.effect}`
      + ` inject=${typeof ctx?.inject} get=${typeof ctx?.get}`
      + ` tools=${typeof ctx?.tools}`
      + ` webServer=${safePeek(() => ctx?.webServer)}`
      + ` sessionProjections=${safePeek(() => ctx?.sessionProjections)}`)

    const status = makeComfyStatus(cfg)
    const idle = makeIdleShutdown(cfg, log, status)
    historyStore = createHistoryStore({
      outputDir: cfg.outputDir, log,
      fallbackRecent: (limit) => readMemoryRecent(cfg, log, { limit }),
    })
    log('info', `生成历史：${historyStore.persistent ? 'SQLite 持久化' : '降级（' + historyStore.reason + '）'}`)

    // ★ 2026-11-13 审计修：插件重载 / 卸载时释放 SQLite 句柄。
    //   不释放的话 Windows 上会一直锁着 `.qwen-paint-history.db` —— 换出图目录、
    //   或用户想删掉这个 db 文件时都会撞「文件正被另一个程序使用」。
    //   宿主没有 ctx.effect 时不强求：进程退出时 OS 会回收。
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { historyStore?.close() } catch { /* 已经关了 */ } },
          'qwen-paint:history-store')
      }
    } catch { /* 老宿主：忽略 */ }

    /** 出图后：登记交付物（与官方 present 同载荷）+ 记一次活动时间。 */
    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      idle.touch()
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
// 设计说明已外置 → docs/index-design-notes.md#index-note-047（原 L3130-3135）
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

    // B3：所有工具注册统一走这一层 —— 回包按 output.schema 声明字段收口。
    const registerTool = (t) => {
      if (t?.name && !registeredToolNames.includes(t.name)) registeredToolNames.push(t.name)
      return ctx.tools.register(withDeclaredOutput(t))
    }

    const tool = makeDrawTool(ctx, cfg, log, onProduced, () => idle.touch())
    drawToolRef = tool

    // ★★★ 2026-10-09：**总开关**（`enabled`）。
    //   false 时不注册绘图工具、不注入提示词、不预热后端、不做空闲关停 ——
    //   插件对 DSH 相当于"不存在"，但下面两个**诊断类**工具仍然注册：
    //   它们只读、不画图，出了问题还得靠它们排查。
    if (cfg.enabled === false) {
      const offList = makeListModelsTool(cfg, log)
      registerTool(offList)
      const offAccel = makeAccelTool(cfg, log)
      registerTool(offAccel)
      log('info', `插件已停用（enabled=false）：不注册 draw_image、不注入提示词、不预热后端；`
        + `仅保留诊断工具 ${offList.name} / ${offAccel.name}`)
      return
    }

// 设计说明已外置 → docs/index-design-notes.md#index-note-048（原 L3170-3187）
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
      registerTool(tool)
      log('info', `已注册工具 ${tool.name}（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputDir}，生图策略=${cfg.drawTrigger}）`)
      diag('tools', `已注册 ${tool.name} comfyUrl=${cfg.comfyUrl} enabled=${cfg.enabled !== false} drawTrigger=${cfg.drawTrigger}`)
    })

    // ★ 2026-11-10：视频链（Wan 2.2 / XT-5B）。不在这里探测节点——探测放在提交前，
    //   因为插件启动时 ComfyUI 很可能还没起来（会把"没起"误判成"不支持"）。
    step('register.generate_video', () => {
      const videoTool = makeVideoTool(ctx, cfg, log, onProduced, () => idle.touch())
      videoToolRef = videoTool
      registerTool(videoTool)
      log('info', `已注册工具 ${videoTool.name}（Wan 2.2 / XT-5B DMD，输出=${cfg.outputDir}）`)
      diag('tools', `已注册 ${videoTool.name}`)
    })

    // ★ 2026-11-10：混合模式（image → tts → video，报告 v3 §3/§10）。
    //   TTS 后端缺不缺由 execute 时探测决定，不在这里判 —— 启动时 ComfyUI 很可能还没起来。
    //   工具本身始终注册；缺件时 execute 抛 ttsMissingReport 清单，不假装能出音频。
    step('register.generate_hybrid', () => {
      const hybridTool = makeHybridTool(ctx, cfg, log, onProduced, () => idle.touch(),
        { drawTool: drawToolRef, videoTool: videoToolRef, speechRunner: makeSpeechRunner(makeSpeechDeps(cfg, log)) })
      registerTool(hybridTool)
      log('info', `已注册工具 ${hybridTool.name}（三段串行；TTS 缺件时明确报错）`)
      diag('tools', `已注册 ${hybridTool.name}`)
    })

    // ★ 2026-11-13 B3：独立语音工具。TTS 段与混合模式共用 makeSpeechRunner，
    //   缺件时 execute 抛 ttsMissingReport 清单，不自动下载权重。
    step('register.generate_speech', () => {
      const speechTool = makeSpeechTool(makeSpeechDeps(cfg, log))
      registerTool(speechTool)
      log('info', `已注册工具 ${speechTool.name}（Qwen3-TTS；缺件时明确报错、不自动下载权重）`)
      diag('tools', `已注册 ${speechTool.name}`)
    })

    // ★★ 2026-10-09 新增：列出本机 ComfyUI 可用模型（正面回应"查看可用的模型"）。
    step('register.list_available_models', () => {
      const listModelsTool = makeListModelsTool(cfg, log)
      registerTool(listModelsTool)
      log('info', `已注册工具 ${listModelsTool.name}（ComfyUI=${cfg.comfyUrl}）`)
    })

    // ★★ 2026-10-09 新增：查看 / 配置加速环境（GPU 厂商自适应 + 厂家专用加速包）。
    step('register.accel_env', () => {
      const accelTool = makeAccelTool(cfg, log)
      registerTool(accelTool)
      log('info', `已注册工具 ${accelTool.name}（自动安装=${cfg.accelAutoInstall === true ? '允许' : '已禁止'}）`)
    })

    // ★ 2026-11-13：给 Agent 一个查历史的只读工具（不碰 ComfyUI）。
    step('register.list_generated_images', () => {
      const historyTool = makeHistoryTool({ store: historyStore, log })
      registerTool(historyTool)
      log('info', `已注册工具 ${historyTool.name}（持久化=${historyStore?.persistent === true}）`)
    })

    step('register.compose_prompt', () => { registerTool(makePromptTool({ log })) })
    step('register.batch_draw', () => { registerTool(makeBatchTool({ cfg, log, runOne: runDraw, fetchFn: fetchWithTimeout })) })

    // ★★★ 2026-10-12（用户要求「分块放大 / 局部重绘」）：注册两个辅助工具。
    //   它们都遵循 output 契约、且缺失依赖时给明确指引、绝不自动下大模型。
    step('register.upscale_image', () => {
      const upscaleTool = makeUpscaleTool(cfg, log)
      upscaleToolRef = upscaleTool
      registerTool(upscaleTool)
      log('info', `已注册工具 ${upscaleTool.name}（放大前会先卸载主模型以释放显存）`)
    })
    step('register.inpaint_image', () => {
      const editTool = makeEditTool(cfg, log)
      // 面板不能直接调工具，只能走端点；端点执行同一个 editTool，杜绝两套逻辑。
      editToolRef = editTool
      registerTool(editTool)
      log('info', `已注册工具 ${editTool.name}（官方 Turbo 9 步 + 裁剪回贴）`)
    })
    step('register.remove_image', () => {
      const removeTool = makeRemoveTool(cfg, log)
      removeToolRef = removeTool
      registerTool(removeTool)
      log('info', `已注册工具 ${removeTool.name}（任务 LoRA + 裁剪回贴）`)
    })
    step('register.outpaint_image', () => {
      const outpaintTool = makeOutpaintTool(cfg, log)
      outpaintToolRef = outpaintTool
      registerTool(outpaintTool)
      log('info', `已注册工具 ${outpaintTool.name}（四向扩图 + 裁剪回贴）`)
    })

// 设计说明已外置 → docs/index-design-notes.md#index-note-049（原 L3289-3293）
    if (cfg.accelAutoInstall === true) {
      const timer = setTimeout(() => {
        autoSetupAcceleration(cfg, log).catch(() => {})
      }, 20000)
      if (typeof timer.unref === 'function') timer.unref()
      log('info', '加速环境自动配置已启用（20 秒后自检并补齐缺失的厂商专用加速包）')
    }

// 设计说明已外置 → docs/index-design-notes.md#index-note-050（原 L3302-3306）
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
// 设计说明已外置 → docs/index-design-notes.md#index-note-051（原 L3310-3314）
        prepareLoadingGif(cfg, log).catch(() => {})   // 只留一份本地副本备用

        systemPrompt.section({
          name: 'qwen-paint:inline-generated-image',
          order: 9100, // 紧挨内核 DELIVERABLE_FILE_REFERENCES(9000) 之后
          text: INLINE_IMAGE_PROMPT,
        })
        log('info', '已注册 systemPrompt 段落：出图后内联展示')

        // ★ 需求方定的铁律（2026-10-07，当天三次加严；2026-10-08 又加两条）：
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-052（原 L3347-3356）
    try {
      ctx.effect(() => {
        if (cfg.autoStartComfy === false) return undefined
        let cancelled = false
        Promise.resolve()
          .then(() => status.probe(false))
          .then((online) => {
            if (cancelled) return undefined
// 设计说明已外置 → docs/index-design-notes.md#index-note-053（原 L3365-3372）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-054（原 L3391-3394）
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
        // ★ 2026-11-13：历史兜底。所有走 onProduced 的工具（视频 / 混合 / 编辑）
        //   都在这里补一条；file_path UNIQUE，draw 已写过的不会重复。
        try {
          for (const f of delivery.files ?? []) {
            const fp = typeof f === 'string' ? f : String(f?.path ?? '')
            if (fp === '') continue
            historyStore?.record({
              file_path: fp,
              tool_name: String(exec?.name ?? exec?.toolName ?? ''),
              prompt: String(exec?.args?.prompt ?? exec?.arguments?.prompt ?? '').slice(0, 1000),
              kind: kindOf(fp),
              extra: { callId: String(exec?.callId ?? '') },
            })
          }
        } catch (error) {
          log('warn', `历史兜底写入失败（不影响出图）：${error?.message ?? error}`)
        }
      })
    })

    // 空闲关停的定时器：随 ctx 卸载自动清掉。
    // ★ 全包 try/catch：宿主若缺 ctx.effect（裁剪版/老版本），也不许把插件加载拖垮。
    if (cfg.autoShutdown) {
// 设计说明已外置 → docs/index-design-notes.md#index-note-055（原 L3432-3435）
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-056（原 L3470-3475）
    diag('route', `准备注册状态端点：ctx.inject 可用，webServer 探测=${safePeek(() => ctx?.webServer)}`)
    /** 状态端点是否已注册成功。供下面的延时回看用 —— 这是"到底注册上没有"的权威标志。 */
    let routeMounted = false
    ctx.inject(['webServer'], (webCtx) => {
      diag('route', 'webServer 已就绪，开始注册状态端点')
// 设计说明已外置 → docs/index-design-notes.md#index-note-057（原 L3481-3484）
      const visits = { api: 0, plain: 0, pings: [], firstAt: null, lastAt: null }
// 设计说明已外置 → docs/index-design-notes.md#index-note-058（原 L3486-3492）
      const handler = makeStatusHandler({ cfg, log, status, idle, visits })
      try {
        webCtx.effect(() => {
          const disposers = [
            '/api/qwen-paint/status.json',
            '/qwen-paint/status.json',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          // ★ 2026-11-13：21 处注册只差路径与 handler —— 收成一行。
          //   纯注册期执行，请求热路径一行不动；handler 仍是原来的那个函数。
          const reg = (routePath, handler) =>
            disposers.push(webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          // 0.33：新增 6 个工具 + 11 条端点全在外置注册表，index.js 只留这一行。
          //   ★ 2026-11-17（M3）：接住返回值 —— 同一份 queue 实例要交给 /jobs 端点，
          //   前台按钮才能操作 Agent 用的那条真队列（另建一条队列必然漂移）。
          let extrasBundle = null
          step('register.extras', () => { extrasBundle = registerExtras({ registerTool, reg,
            deps: { cfg, log, respondJson, isLocalRequest, readJsonBody,
              outputDir: cfg.outputDir, tools: registeredToolNames } }) })
          // M3：任务队列前台操作（GET 列表 / POST cancel|pause|resume）。
          //   安全级别与 history/delete 一致：本机围栏 + POST 写闸。
          if (extrasBundle?.queue) {
            const jobHandlers = makeJobHandlers({
              isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
              queue: extrasBundle.queue, log,
            })
            for (const [routePath, handler] of jobRouteTable(jobHandlers)) reg(routePath, handler)
          }
// 设计说明已外置 → docs/index-design-notes.md#index-note-002（原 L3003-3007）
          const cnetCache = createPreprocessCache({ outputDir: cfg.outputDir,
            fs: { readFileSync, writeFileSync, existsSync }, path })
          const cnetPreprocessHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            if (String(req.method ?? '').toUpperCase() !== 'POST') {
              respondJson(res, { ok: false, reason: 'POST only' }, 405); return
            }
            if (!guardWriteRequest(req, res)) return
            if (!cfg.outputDir) { respondJson(res, { ok: false, reason: '输出目录未配置，无法缓存预处理产物' }, 400); return }
            try {
              const body = (await readJsonBody(req)) ?? {}
              const type = String(body?.type ?? '').trim()
              if (!PREPROCESS_TYPES[type]) {
                respondJson(res, { ok: false, reason: `type 必须是 ${Object.keys(PREPROCESS_TYPES).join(' / ')}` }, 400); return
              }
              const srcPath = String(body?.path ?? '').trim()
              if (srcPath === '' || !existsSync(srcPath)) {
                respondJson(res, { ok: false, reason: 'path 必填且必须是本机存在的图片文件' }, 400); return
              }
              const stat = statSync(srcPath)
              if (!stat.isFile() || stat.size > 30 * 1024 * 1024) {
                respondJson(res, { ok: false, reason: '图片须是 ≤ 30 MB 的常规文件' }, 400); return
              }
              const bytes = readFileSync(srcPath)
              const params = clampPreprocessParams(type, body?.params)
              const key = cacheKeyOf(bytes, type, params)
              const hit = cnetCache.get(key)
              if (hit) {
                respondJson(res, { ok: true, cached: true, type, node: hit.node, path: hit.abs,
                  preview_url: 'api/qwen-paint/file?path=' + encodeURIComponent(hit.abs),
                  note: '同一原图 + 同参数已有缓存，直接复用，未重复跑预处理。' })
                return
              }
              const caps = await probeCapabilities(cfg, log, undefined)
              const pick = pickPreprocessNode(type, caps?.nodes ?? {})
              if (!pick.ok) { respondJson(res, { ok: false, reason: pick.reason }, 409); return }
              const uploaded = await uploadToComfy({ cfg, filePath: srcPath, fetchFn: guardedFetch, signal: undefined,
                namePrefix: `dshqp-cnet-${Date.now().toString(36)}-`, kind: '预处理原图' })
              const wf = buildPreprocessWorkflow({ image: uploaded, node: pick.node, params, prefix: 'dshqp-cnet-pre' })
              if (!wf.ok) { respondJson(res, { ok: false, reason: wf.reason }, 400); return }
              const promptId = await submitPrompt(cfg, wf.workflow, undefined)
              const images = await waitForResult(cfg, promptId, { signal: undefined, timeoutMs: 120000 })
              const first = images?.[0]
              if (!first?.filename) {
                respondJson(res, { ok: false, reason: '预处理完成但没有产物（详见插件日志）' }, 500); return
              }
              const vq = new URLSearchParams({ filename: first.filename, subfolder: first.subfolder ?? '', type: first.type ?? 'output' })
              const vres = await fetchWithTimeout(`${cfg.comfyUrl}/view?${vq.toString()}`, { timeoutMs: 120000 })
              if (!vres.ok) { respondJson(res, { ok: false, reason: '预处理产物下载失败' }, 502); return }
              const buf = Buffer.from(await vres.arrayBuffer())
              const dir = path.join(cfg.outputDir, PREVIEW_DIR_NAME)
              mkdirSync(dir, { recursive: true })
              const rel = path.join(PREVIEW_DIR_NAME, `${key}.png`).replace(/\\/g, '/')
              const abs = path.join(cfg.outputDir, rel)
              writeFileSync(abs, buf)
              cnetCache.put(key, rel, pick.node)
              respondJson(res, { ok: true, cached: false, type, node: pick.node, path: abs,
                preview_url: 'api/qwen-paint/file?path=' + encodeURIComponent(abs),
                hint: '把 path 填进 draw_image 的 controlImage 即可用这张预处理图控图。' })
            } catch (error) {
              log('warn', `ControlNet 预处理失败：${error?.message ?? error}`)
              respondJson(res, { ok: false, reason: '预处理失败（详见插件日志）' }, 500)
            }
          }
          reg('/api/qwen-paint/cnet-preprocess', cnetPreprocessHandler)
          // ★★★ 2026-10-12（确认式一键修复）：一个 POST 端点，前端"一键修复"按钮调它。
          //   默认返回预览（将要做什么）；带 {confirm:true} 才真正执行（只做可逆/无害动作）。
          const repairHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
// 设计说明已外置 → docs/index-design-notes.md#index-note-059（原 L3512-3518）
            if (!guardWriteRequest(req, res)) return
            const body = await readJsonBody(req)
            try {
              const result = await runRepair(cfg, log, { confirm: body?.confirm === true })
              respondJson(res, { ok: true, ...result })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/repair', repairHandler)
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
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/wizard', wizardHandler)

// 设计说明已外置 → docs/index-design-notes.md#index-note-060（原 L3545-3548）
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
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/health', healthHandler)

          // ★ /api/qwen-paint/capabilities —— 探测结果（供前端按能力切换 UI / 供 dsh-auto-memory 判断）
          const capsHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
              const caps = await probeCapabilities(cfg, log, undefined, { force })
              // ★ 模型名的「干净展示名 / 右侧参数」由 host 端统一算好下发，前端不自己发明规则
              respondJson(res, { ok: true, caps, fileLabels: preprocessFileLabels(caps?.files) })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/capabilities', capsHandler)

          // ★ /api/qwen-paint/presets —— 当前可用的预设列表（含 ASPECTS / FLOW_STYLES）
          //   从 config.js 动态导入，避免本文件 (index.js) 顶部 import 时与 config.js 循环依赖踩坑
          //   （config.js 反向 import 本文件的 ensureComfyUp / getNodeSchema）。
          const presetsHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const m = await import('./config.js')
              respondJson(res, { ok: true, aspects: m.ASPECTS, flowStyles: m.FLOW_STYLES })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/presets', presetsHandler)

          // ★ /api/comfy-pipeline/schema —— 通用 Comfy 控制层契约 JSON 桥（v3 修订 #3）
          //   lib/mode-schema.js 是 host 侧 ESM；前端是非 ESM 单入口且 lib/ 不经 web 暴露，
          //   host 序列化后从这里下发 JSON，前端 fetch 一次挂 window.ComfyPipelineSchema。
          const schemaHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const m = await import('./mode-schema.js')
              respondJson(res, { ok: true, schema: m.buildSchemaSnapshot() })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/comfy-pipeline/schema', schemaHandler)

// 设计说明已外置 → docs/index-design-notes.md#index-note-061（原 L3621-3624）
          const controlsHandler = async (req, res) => {
            // ★ 顶层可信请求围栏：GET/POST 都要过（Host / Sec-Fetch-Site / Origin）。
            //   POST 的 guardWriteRequest 只管 method + application/json，不查来源，不能替代本围栏。
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            if (req.method === 'GET') {
              try {
                const m = await import('./pipeline-controls.js')
                const controls = m.readControls(cfg.outputDir)
                respondJson(res, {
                  ok: true,
                  controls,
                  summary: m.describeControls(controls),
                  path: m.controlsPath(cfg.outputDir),
                })
              } catch (error) {
                respondJson(res, failBody(error))
              }
              return
            }
            if (req.method === 'POST') {
              // 与状态 / 偏好同样的写守卫（application/json + POST 方法），叠加顶层来源围栏
              if (!guardWriteRequest(req, res)) return
              try {
                const body = (await readJsonBody(req)) ?? {}
                const m = await import('./pipeline-controls.js')
                const r = m.writeControls(cfg.outputDir, body)
                // ★ 写盘失败**不判 400**：合并结果已经在内存里生效，如实回 saved=false 让面板提示，
                //   不把"目录只读"这种事伪装成"参数不合法"。
                respondJson(res, {
                  ok: true,
                  saved: r.saved,
                  reason: r.reason,
                  controls: r.controls,
                  summary: m.describeControls(r.controls),
                })
              } catch (error) {
                respondJson(res, failBody(error), 400)
              }
              return
            }
            respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
          }
          reg('/api/comfy-pipeline/controls', controlsHandler)

          // ★ /api/comfy-pipeline/progress —— 生成进度（队列位置 + 已等时长 + 基于**自家实测**的 ETA）
          //   ⚠ ETA 只读 `<outputDir>/.comfy-pipeline-timing.json`（自己跑出来的 EWMA），
          //     没历史就返 etaSec:null —— **不拿别人的 benchmark 当承诺**。
          const progressHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            let queue = null
            try {
              const r = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
              if (r.ok) queue = await r.json()
            } catch { queue = null }
            const now = Date.now()
            const timings = readTimings(cfg.outputDir)
            const items = []
            for (const [promptId, meta] of inFlight) {
              // 防止异常路径漏掉清理导致永久"还在跑"：超过 2 小时就当废弃
              if (!meta || now - meta.startedAt > 2 * 3600 * 1000) { inFlight.delete(promptId); continue }
              // 单项计算失败只跳过这一项，别让一条脏 meta 把整个进度端点拖成 5xx。
              try {
                const p = buildProgress({ queue, ownIds: [promptId], startedAt: meta.startedAt, timings, key: meta.key, now })
                items.push({ promptId, key: meta.key, ...p })
              } catch (error) {
                log('warn', `进度项 ${promptId} 计算失败（已跳过）：${error?.message ?? error}`)
              }
            }
            // TTS 首段早出声事件：与上表 inFlight 无关，独立带出；无事件时 null。
            const ttsLive = ttsLiveStore.snapshot()
            respondJson(res, { ok: true, online: queue !== null, active: items.length, items,
              ttsLive })
          }
          reg('/api/comfy-pipeline/progress', progressHandler)

          // ★ /api/comfy-pipeline/library —— 素材库（设计风格 / 用户指令 / 挂载的 skill）
          //   ⚠ 用户定义：素材库**不是图片库**，是出图前的输入（见 lib/style-library.js 头注）。
          const libraryHandler = async (req, res) => {
            // ★ 顶层可信请求围栏：GET/POST 都要过（Host / Sec-Fetch-Site / Origin）。
            //   POST 的 guardWriteRequest 只管 method + application/json，不查来源，不能替代本围栏。
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            if (req.method === 'GET') {
              try {
                const lib = readLibrary(cfg.outputDir)
                const skillsAvail = listSkills(cfg)
                respondJson(res, {
                  ok: true,
                  dir: styleLibraryDir(cfg.outputDir),
                  styles: listStyles(cfg.outputDir),
                  selected: lib.selected,
                  instruction: lib.instruction,
                  skills: lib.skills,
                  skillsAvailable: skillsAvail,
                })
              } catch (error) {
                respondJson(res, failBody(error))
              }
              return
            }
            if (req.method === 'POST') {
              if (!guardWriteRequest(req, res)) return
              try {
                const body = (await readJsonBody(req)) ?? {}
                const r = writeLibrary(cfg.outputDir, body)
                respondJson(res, {
                  ok: true, saved: r.saved, reason: r.reason,
                  selected: r.library.selected, instruction: r.library.instruction, skills: r.library.skills,
                })
              } catch (error) {
                respondJson(res, failBody(error), 400)
              }
              return
            }
            respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
          }
          reg('/api/comfy-pipeline/library', libraryHandler)

          // ★ /api/comfy-pipeline/skills —— 本机可装载的 skill 清单（目录扫描，只读）
          const skillsHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              respondJson(res, { ok: true, skills: listSkills(cfg) })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/comfy-pipeline/skills', skillsHandler)

          // ★ /api/comfy-pipeline/modes —— 模式可用性（报告 v3 §3/§10）。
          //   与「面板写死 disabled」的区别：按 /object_info 的**真实节点类名**判定；缺件时把该放什么、
          //   放哪列清楚（ttsMissingReport），既不假装能出音频，也不永远关着。
          const modesHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const objectInfo = await loadObjectInfoFor(cfg, undefined)
              // ★ 2026-11-16 报障修复（审计 F2）：探测失败 ≠ 节点缺失。真机 /object_info 实测
              //   9 个 FB_Qwen3TTS* 全在；旧回复把「探测失败」（后端忙 / 未启动 / 20s 超时）
              //   误报成 ttsMissingReport，用户读成「我没装 TTS 节点」⇒ 混合模式「经常打不开」。
              if (objectInfo === null || typeof objectInfo !== 'object') {
                respondJson(res, {
                  ok: true,
                  online: false,
                  modes: MODES.map((m) => ({
                    id: m.id, label: m.label, deliver: m.deliver,
                    // ★ 2026-11-16 ppt 恒放行：轻量档纯 JS 零 GPU，不依赖 ComfyUI 在线。
                    available: m.id === 'image' || m.id === 'video' || m.id === 'ppt',
                  })),
                  hybrid: {
                    available: false, tier: '', label: '',
                    reason: 'ComfyUI /object_info 探测失败（后端忙 / 未启动 / 超时）——'
                      + '这不代表没装 TTS 节点；请稍后重开面板重试，或直接访问 ComfyUI 确认状态。',
                  },
                  probeFailed: true,
                }, 200)
                return
              }
              const probe = probeTts(catalogForTts(objectInfo))
              const modes = MODES.map((m) => ({
                id: m.id,
                label: m.label,
                deliver: m.deliver,
                available: m.id === 'image' || m.id === 'video' || m.id === 'ppt'
                  || (m.id === 'hybrid' && probe.available),
              }))
              respondJson(res, {
                ok: true,
                online: objectInfo !== null,
                modes,
                hybrid: {
                  available: probe.available,
                  tier: probe.tier,
                  label: probe.label,
                  reason: probe.available ? '' : probe.reason,
                },
                // ⚠ 返回链里**真实存在**的字段：TTS_FALLBACK_CHAINS 没有 models 字段，
                //   早先写 `models: c.models` 恒为 undefined（JSON.stringify 直接省略该键）。
                ttsChains: TTS_FALLBACK_CHAINS.map((c) => ({ id: c.id, label: c.label, nodes: c.nodes, format: c.format })),
              })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/comfy-pipeline/modes', modesHandler)

          // ★ 2026-11-16 GET /api/comfy-pipeline/model-options —— 主模型候选清单
          //   （面板「主模型」下拉的数据源）。处理器在 lib/model-options.js：
          //   从真机 /object_info 抓 UNETLoader / UnetLoaderGGUF 的 unet_name 候选，
          //   探测失败回 online:false + 空清单（诚实，不编造）。
          reg('/api/comfy-pipeline/model-options', makeModelOptionsHandler({
            isLocalRequest, respondJson, failBody, cfg, loadObjectInfoFor,
          }))

          // ★ 角色参考四个端点：处理器在 lib/reference-endpoints.js（本文件需留在 256 KB 上限内）。
          //   依赖在这里注入，信任判定 / 写护栏 / 配置 / 能力缓存一律沿用 host 的同一套口径。
          const refHandlers = makeReferenceHandlers({
            isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
            cfg, loadObjectInfoFor,
            getPreferred: () => preferredReferenceStrategy,
            setPreferred: setPreferredReferenceStrategy,
          })
          reg('/api/comfy-pipeline/reference', refHandlers.referenceHandler)
          reg('/api/comfy-pipeline/reference/prefer', refHandlers.referencePreferHandler)
          reg('/api/comfy-pipeline/reference/search', refHandlers.referenceSearchHandler)
          reg('/api/comfy-pipeline/reference/adapt', refHandlers.referenceAdaptHandler)

          // ★ /api/qwen-paint/memory/recent —— dsh-auto-memory 拉取最近出图记忆
          const memoryRecentHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            try {
              const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 10) || 10
              const items = await readMemoryRecent(cfg, log, { limit })
              respondJson(res, { ok: true, items, count: items.length })
            } catch (error) {
              respondJson(res, failBody(error))
            }
          }
          reg('/api/qwen-paint/memory/recent', memoryRecentHandler)

          // ★ /api/qwen-paint/memory/preference —— GET 读 / POST 写偏好
          const memoryPrefHandler = async (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            if (req.method === 'GET') {
              try {
                const value = await readPreferences(cfg, log)
                respondJson(res, { ok: true, value })
              } catch (error) {
                respondJson(res, failBody(error))
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
                respondJson(res, failBody(error), 400)
              }
              return
            }
            respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
          }
          reg('/api/qwen-paint/memory/preference', memoryPrefHandler)

// 设计说明已外置 → docs/index-design-notes.md#index-note-062（原 L3869-3883）
          const inpaintHandler = async (req, res) => {
            // ★ 顶层可信请求围栏：任何动作（method 判定 / 读 body / 写蒙版 / 调 editTool）之前先过。
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
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
              // ★ 2026-10-20（0.17.13）：一次性蒙版 —— 带随机后缀，见 uiMaskPath 注释①。
              const maskPath = uiMaskPath(cfg)
              try {
                await fsp.mkdir(cfg.outputDir, { recursive: true })
                await fsp.writeFile(maskPath, bytes)
                log('info', `圈选重绘：蒙版已存 ${maskPath}（${bytes.length} B），开始重绘`)
                // ★ 2026-11-13：蒙版精修参数真正落到 InpaintCropImproved / ManualSigmas。
                //   老客户端不带 maskFx 时，沿用 /mask-fx 端点保存的那一份。
                const fx = (body.maskFx && typeof body.maskFx === 'object' && !Array.isArray(body.maskFx))
                  ? body.maskFx : integrationRuntime.maskFx
                const value = await editToolRef.execute(
                  { image, prompt, mask: maskPath, maskFx: fx },
                  { signal: new AbortController().signal, callId: `ui-inpaint-${Date.now()}` },
                )
                respondJson(res, {
                  ok: true,
                  path: value?.path ?? '',
                  files: Array.isArray(value?.files) ? value.files : [],
                  seconds: value?.seconds ?? 0,
                })
              } catch (error) {
                respondJson(res, failBody(error), 500)
              } finally {
// 设计说明已外置 → docs/index-design-notes.md#index-note-063（原 L3934-3938）
                try { await fsp.unlink(maskPath) } catch { /* 本来就没写成功 */ }
              }
            } catch (error) {
              respondJson(res, failBody(error), 500)
            }
          }
          reg('/api/qwen-paint/inpaint', inpaintHandler)

          // ★ 2026-11-12「图片编辑台」：最近图片清单 + 移除 / 扩图 / 放大三个动作的 UI 端点。
          //   处理器外置（lib/ui-edit-endpoints.js），依赖注入，信任判定沿用同一套围栏。
          const uiEditHandlers = makeUiEditHandlers({
            isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
            cfg,
            makeMaskPath: () => uiMaskPath(cfg),
            getTool: (name) => ({
              remove_image: removeToolRef,
              outpaint_image: outpaintToolRef,
              upscale_image: upscaleToolRef,
            })[name] ?? null,
            readRecent: (limit) => readMemoryRecent(cfg, log, { limit }),
            log,
          })
          reg('/api/qwen-paint/recent-images', uiEditHandlers.recentImagesHandler)
          reg('/api/qwen-paint/quick-edit', uiEditHandlers.quickEditHandler)

          // ★ 2026-11-13：图形化安装引导 / 蒙版增强 / 卸载内存 / 外部集成状态。
          //   处理器全在外置模块，host 只注入依赖与注册；信任围栏沿用既有四件套。
          const integrationUnload = async (body) => {
            try {
              const r = await fetchWithTimeout(`${cfg.comfyUrl}/free`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                timeoutMs: 15000,
              })
              return r.ok === true
            } catch { return false }
          }
          integrationRuntime.unloadModels = integrationUnload
          const integrationHandlers = makeIntegrationHandlers({
            isLocalRequest, guardWriteRequest, respondJson, readJsonBody, cfg, log,
            runtime: integrationRuntime,
            unloadModels: integrationUnload,
            probeGuideState: async () => {
              const onlineNow = await status.probe().catch(() => false)
              let caps = null
              if (onlineNow) caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              return {
                checked: true,
                online: onlineNow === true,
                mainModel: !!caps?.models?.unet,
                plugin: true,
              }
            },
            // ★ async 快照：全部字段取自 host 真值，探测失败如实留空，绝不编数字。
            snapshot: async () => {
              let version = 'unknown'
              try {
                const pkgPath = path.join(
                  path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
                version = String(JSON.parse(await fsp.readFile(pkgPath, 'utf8')).version ?? version)
              } catch { /* 取不到版本不影响快照 */ }
              const online = await status.probe().catch(() => false)
              let lowEnd = null
              try {
                lowEnd = assessLowEndReadiness(await detectGpuProfile(cfg, log))
              } catch { /* GPU 探测失败 → 档位留空，不猜 */ }
              let queueRunning = 0
              let queuePending = 0
              try {
                const qr = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
                if (qr.ok) {
                  const q = await qr.json()
                  queueRunning = Array.isArray(q?.queue_running) ? q.queue_running.length : 0
                  queuePending = Array.isArray(q?.queue_pending) ? q.queue_pending.length : 0
                }
              } catch { /* 队列不可达就报 0，不编数字 */ }
              return {
                version,
                online: online === true,
                tools: registeredToolNames.slice(),
                tier: lowEnd?.tier,
                meetsAcceptableBar: lowEnd?.meetsAcceptableBar === true,
                speedTargetSec: lowEnd?.speedTargetSec ?? null,
                unverified: lowEnd?.unverified !== false,
                active: inFlight.size,
                queueRunning,
                queuePending,
                enabled: cfg.enabled !== false,
                imageBackend: cfg.imageBackend,
                // ★ 2026-11-13 审计修：原来写死 true，等于告诉外部集成「永远就绪」。
                //   真实语义 = 插件已挂载（有注册工具）+ 本机 ComfyUI 可达。
                setupGuideReady: online === true && registeredToolNames.length > 0,
              }
            },
          })
          disposers.push(...registerIntegrationRoutes(
            (route) => webCtx.webServer.register(route), integrationHandlers))

// 设计说明已外置 → docs/index-design-notes.md#index-note-064（原 L4038-4041）
          const cpuHandlers = makeCpuHandlers({
            snapshot: async () => ({
              profile: getCpuProfile({ flags: cfg.cpuFlags, physicalCores: cfg.cpuPhysicalCores }),
              cfg,
            }),
            isLocalRequest,
            guardWriteRequest,
            readJsonBody,
            respondJson,
            readUiState,
            writeUiState,
            log,
          })
          disposers.push(...registerCpuRoutes(
            (route) => webCtx.webServer.register(route), cpuHandlers))

          // ★ 2026-11-12「视频选帧 / 时间段截取」：四个端点，处理器外置（lib/video-frames-endpoints.js）。
          //   `/frame-save` 是**零依赖**那条路：浏览器画布已经抽出 PNG，这里只落盘；
          //   其余三个要 ffmpeg / ffprobe，找不到就如实返回 needFfmpeg，不假装成功。
          disposers.push(...registerVideoFrameRoutes(
            (route) => webCtx.webServer.register(route),
            { isLocalRequest, guardWriteRequest, respondJson, readJsonBody, cfg, log },
          ))

// 设计说明已外置 → docs/index-design-notes.md#index-note-065（原 L4066-4069）
          const fileBytesHandler = makeFileBytesHandler({ isLocalRequest, respondJson, cfg, log })
          reg('/api/qwen-paint/file', fileBytesHandler)
          // ★ 2026-11-13：生成历史（搜索 / 分页 / 软删除）。软删除只改索引，不碰磁盘文件。
          //   ★ 2026-11-17（M2）：redraw 依赖注入 —— 重画端点走与 draw_image 完全相同的
          //   内部 runDraw 链路（批量工具 batch_draw 也是这么接的），本文件之外零复制。
          const historyHandlers = makeHistoryHandlers({
            isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
            store: historyStore, log, outputDir: cfg.outputDir,
            redraw: (args, exec = {}) => runDraw(args, exec, { cfg, log }),
          })
          for (const [routePath, handler] of historyRouteTable(historyHandlers)) reg(routePath, handler)
          // ★ 2026-11-17（L1）：渐进预览快照（本机只读）。enable=1 才按需连 WS，
          //   没连/运行时无 WebSocket 时如实回 unavailable + reason，不假装进度。
          reg('/api/qwen-paint/preview', (req, res) => {
            if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
            const u = new URL(req.url, 'http://127.0.0.1')
            const promptId = u.searchParams.get('promptId') ?? ''
            const status = u.searchParams.get('enable') === '1'
              ? ensurePreviewBridge(cfg, log) : previewBridgeStatus
            const snap = previewStore.snapshot(promptId)
            respondJson(res, {
              ok: true,
              available: status.ok === true,
              reason: status.reason ?? '',
              ...snap,
              note: status.ok === true
                ? '数据来自本机 ComfyUI WebSocket 的 progress / 预览帧；没有帧时 preview=null（不伪造）。'
                : '渐进预览不可用；生成进度仍走 /api/qwen-paint/status.json 的历史耗时估算。',
            })
          })
          // ★ 2026-11-17（L2）：外部 ComfyUI 工作流 JSON 导入。模板只进进程内存，
          //   本机围栏 + POST 写闸（与 jobs 同级）；loadObjectInfoFor 复用同一份 /object_info。
          const importRegistry = createImportRegistry()
          const wfImportHandlers = makeWorkflowImportHandlers({
            isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
            registry: importRegistry,
            loadObjectInfo: () => loadObjectInfoFor(cfg),
            log,
          })
          for (const [routePath, handler] of workflowImportRouteTable(wfImportHandlers)) reg(routePath, handler)
          // B7/B8/B9/G34 的只读端点（档位清单 / 偏好复位 / 缓存摘要）
          const configHandlers = makeConfigHandlers({
            isLocalRequest, guardWriteRequest, respondJson, cfg, log, fetchFn: fetchWithTimeout,
          })
          for (const [p, fn] of configRouteTable(configHandlers)) reg(p, fn)

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

// 设计说明已外置 → docs/index-design-notes.md#index-note-066（原 L4097-4105）
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

      // ★★★ 2026-10-08：插件自己的静态资源路由。内核 /api/file 只服务「登记过的」
      //   文件 → 动图 / 面板脚本一律裂图；往消息树插 DOM 会白屏；改 app.asar 会被升级覆盖。
      //   ✓ 正解：插件自己吐字节。2026-11-13 外置到 lib/asset-route.js（表驱动 + 固定错误文案）。
      try {
        webCtx.effect(() => {
          const disposers = registerAssetRoutes(webCtx.webServer, { isLocalRequest, respondJson, log })
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
  isColorMatcherError,
  // ★ 2026-10-13：暴露给回归（任务 #62② SageAttention 崩溃自动回退的判定）
  launchFailedDueToSage,
  recoverFromSageCrash,
  // ★ 2026-10-13：暴露给回归（任务 #62① 记忆消费的优先级：显式 > 记忆）
  resolveDrawParams,
  // ★ 2026-10-20（0.17.13）：面板圈选重绘的一次性蒙版路径（随机后缀 + 定位 outputDir）
  uiMaskPath,
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
  buildTaskWorkflow,
  planWorkflow,
  OFFICIAL_TURBO_STEPS,
  OFFICIAL_EDIT_STEPS,
  OFFICIAL_TURBO_SIGMAS_8,
  OFFICIAL_EDIT_SIGMAS_9,
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
  resolveOfficialTurbo,
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
  makeRemoveTool,
  makeOutpaintTool,
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


// 设计说明已外置 → docs/index-design-notes.md#index-note-067（原 L4299-4305）
function makeStatusHandler(deps) {
  const { cfg, log, status, idle, visits } = deps
  return async (req, res) => {
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-068（原 L4336-4345）
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
          // ★ 2026-11-16 假成功根治：把「被拒的界面选择」从日志搬到响应里。
          //   顶层 ok 仍表示**端点本身正常**（三处状态轮询依赖它），
          //   本次选择是否真生效只看 choiceResult.ok —— 避免修 UI 谎言时把监控一起带崩。
          const choiceRejections = []
          const rejectChoice = (label, value, reason) => {
            choiceRejections.push({
              label: String(label ?? ''),
              value: String(value ?? ''),
              reason: String(reason ?? ''),
            })
            log('warn', `界面想选「${label}」=「${value}」→ 已拒绝：${reason}`)
          }

          const rawMinutes = queryLc.get('idleminutes')
          if (rawMinutes !== undefined) {
            const minutes = Number(rawMinutes)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              cfg.idleShutdownMs = Math.round(minutes) * 60000
// 设计说明已外置 → docs/index-design-notes.md#index-note-069（原 L4380-4383）
              if (minutes > 0) idle.touch()
              log('info', minutes <= 0
                ? '空闲关停：已按界面选择关闭（不再自动关后端）'
                : `空闲关停：已按界面选择改为 ${Math.round(minutes)} 分钟`)
            } else {
              rejectChoice('空闲关停分钟数', rawMinutes, '必须是 0–1440 之间的数字（0 = 关闭）')
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
              rejectChoice('生图动画', rawStyle, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-070（原 L4406-4416）
          const rawTrigger = queryLc.get('drawtrigger')
          if (rawTrigger !== undefined) {
            if (Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, rawTrigger)) {
              cfg.drawTrigger = rawTrigger
              writeUiState({ ...readUiState(), drawTrigger: rawTrigger }, log)
              log('info', `生图判断策略已改为 ${rawTrigger}（需重载插件后生效）`)
            } else {
              rejectChoice('生图判断策略', rawTrigger, '取值不在白名单里，未生效')
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
              rejectChoice('出图预设', rawPreset, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-071（原 L4442-4446）
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
              rejectChoice(label, raw, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-072（原 L4462-4469）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-073（原 L4485-4492）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-074（原 L4508-4522）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-075（原 L4538-4546）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-076（原 L4587-4599）
          {
            const v = String(queryLc.get('vaetiling') ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const next = v === 'on' ? (cfg.vaeTiling === 'on' ? 'on' : 'auto') : 'off'
              if (cfg.vaeTiling !== next) {
                cfg.vaeTiling = next
                log('info', `界面把「VAE 大图分块解码」切成了 ${next}`
                  + '（工作流节点，**下次出图**即生效，不用重启 ComfyUI）')
              }
            } else if (v !== '') {
              rejectChoice('VAE 大图分块解码', v, '只能填 on / off')
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-077（原 L4623-4627）
            ['sada', 'sadaEnabled', 'SADA 跳步采样'],
            ['easycache', 'easyCacheEnabled', 'EasyCache 步级复用'],
            ['tileinpaint', 'tileInpaintEnabled', '分块重绘'],
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
                rejectChoice(label, v, '自检确认 sageattention 未安装；这是硬依赖参数，打开会让 ComfyUI 起不来')
                continue
              }
              // ★★★ 2026-10-12 加固：MPS 的两个开关**只在 macOS 上有意义**
              //   （PyTorch 的 MPS 后端在其它平台根本不存在）。
              //   非 Mac 上直接拒绝，而不是"改了个什么都不会发生的值"。
              if ((key === 'appleMpsFallback' || key === 'appleMpsUnlimitedMem') && !IS_MAC) {
                rejectChoice(label, v, 'MPS 只在 macOS 有意义，当前平台没有对应后端')
                continue
              }
              if (cfg[key] !== want) {
                cfg[key] = want
                log('info', `界面把「${label}」切成了 ${want ? '开' : '关'}（启动期生效，重启 ComfyUI 后生效）`)
              }
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-078（原 L4658-4661）
          for (const [param, key, label, allowed] of [
            ['vrammode', 'vramMode', '显存/内存档位', VRAM_MODES],
            ['precision', 'precisionTier', '模型精度档', PRECISION_TIERS],
            ['textctl', 'textControl', '文本控制档', TEXT_CONTROL_MODES],
          ]) {
            const raw = String(queryLc.get(param.toLowerCase()) ?? '').toLowerCase()
            if (raw === '') continue
            if (!allowed.includes(raw)) {
              rejectChoice(label, raw, `取值不在白名单内（可用：${allowed.join(' / ')}）`)
              continue
            }
            if (cfg[key] !== raw) {
              cfg[key] = raw
              log('info', `界面把「${label}」切成了 ${raw}`
                + (key === 'vramMode' ? '（启动参数，**重启 ComfyUI** 后生效）'
                  : '（工作流参数，**下次出图**即生效）'))
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-079（原 L4681-4684）
          if (['unet', 'lora', 'controlnet', 'unetvideo'].some((p) => queryLc.has(p))) {
            let wf = null
            try {
              // ★ 2026-11-16 性能：优先复用 comfy-catalog 的全量 /object_info 缓存
              //   （model-options 端点与提交前校验都已拉过它）—— 命中即零网络请求。
              //   拿不到才回退 probeCapabilities（冷启动时那串单节点探测），语义不变。
              const info = await loadObjectInfoFor(cfg, null)
              wf = weightFilesFromObjectInfo(info)
              if (wf === null) {
                const caps = await probeCapabilities(cfg, log, null)
                wf = caps?.files ?? null
              }
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
                // ★ 2026-11-16 主模型选择镜像落盘 uiState.unet（重启后 apply() 恢复）。
                if (key === 'mainModelOverride') writeUiState({ ...readUiState(), unet: '' }, log)
                continue
              }
              const allowed = (listsOf() ?? []).filter((l) => Array.isArray(l)).flat()
              if (wf === null || allowed.length === 0 || !allowed.includes(val)) {
                const why = wf === null || allowed.length === 0
                  ? '本机模型清单此刻不可用，无法校验这次选择（请稍后重试）'
                  : '不在 ComfyUI 的模型清单里（可能是缓存里的旧候选，模型已被删或改名）'
                rejectChoice(label, val, why)
                continue
              }
              if (cfg[key] !== val) {
                cfg[key] = val
                log('info', `界面把「${label}」切成了 ${val}（工作流参数，**下次出图**即生效）`)
                if (key === 'mainModelOverride') writeUiState({ ...readUiState(), unet: val }, log)
              }
            }
            // ★ 2026-11-16 视频主模型（unetvideo）：校验 + 落盘 uiState.unetVideo，
            //   lib/video-workflow.js 的 activeVideoUnet() 读取；处理器在 model-options.js。
            if (queryLc.has('unetvideo')) {
              const wanted = String(queryLc.get('unetvideo') ?? '')
              if (persistVideoModelChoice({ val: wanted, wf, log }) === false) {
                rejectChoice('视频主模型', wanted, '不在视频模型清单里（模型已被删或改名）')
              }
            }
            // ★ 2026-11-16 报障修复：混合链 TTS 后端 / 音色落盘。两者都不依赖 wf
            //   （不是 UNET 权重），单独白名单校验；值由混合链 speechRunner 消费。
            if (queryLc.has('ttsbackend') || queryLc.has('ttsvoice')) {
              persistTtsChoice({
                backend: queryLc.has('ttsbackend') ? queryLc.get('ttsbackend') : undefined,
                voiceSample: queryLc.has('ttsvoice') ? queryLc.get('ttsvoice') : undefined,
                log,
              })
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-080（原 L4730-4736）
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-081（原 L4750-4759）
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

// 设计说明已外置 → docs/index-design-notes.md#index-note-082（原 L4785-4788）
          const optControls = readControls(cfg.outputDir)
          const optMode = optControls.mode
          const videoAccelOf = (probeCaps) => {
            if (optMode !== 'video' && optMode !== 'hybrid') return { id: null, note: '当前不是视频模式' }
            const installed = []
            const nodes = probeCaps?.nodes ?? {}
            if (nodes.EasyCache === true) installed.push('easycache')
            if (nodes.SpectrumQwenPatch === true) installed.push('spectrum')
            if (nodes.PatchSageAttentionKJ === true || nodes.SageAttention === true) installed.push('sage')
            const frames = videoParamsForSpeed(optControls.speedPercent, SPEED_MAP, SPEED_TIERS).frames
            const id = pickAccelProfile({ frames, vendor: String(probeCaps?.gpu?.vendor ?? ''), installed })
            return { id, note: describePick(id) }
          }
          let optimization = null
          if (online) {
            try {
              const caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              // ★ 2026-10-09：把显存总量一并喂给面板 —— 「显存驻留」那一项要靠它判定。
              //   ComfyUI 在线时 /system_stats 是权威值（probeCapabilities 里已取到）。
              optimization = describeOptimization(cfg, caps, process.platform, { mode: optMode, videoAccel: videoAccelOf(caps) })
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
            optimization = describeOptimization(cfg, null, process.platform, { mode: optMode, videoAccel: videoAccelOf(null) })
          }
// 设计说明已外置 → docs/index-design-notes.md#index-note-083（原 L4821-4824）
          respondJson(res, {
            ok: true,
            // ★ 选择类写操作是否真的生效：与端点自身的 ok 分开。
            //   前端据此决定显示「已选」还是明确的拒绝原因，杜绝假成功。
            choiceResult: {
              ok: choiceRejections.length === 0,
              rejections: choiceRejections,
            },
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
// 设计说明已外置 → docs/index-design-notes.md#index-note-084（原 L4854-4860）
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
}