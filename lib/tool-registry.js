/**
 * lib/tool-registry.js —— 新增工具与端点的外置注册层。
 *
 * ## 为什么存在
 *   lib/index.js 贴着 DSH Store 的 262144 B 单文件上限，0.32.1 发布时只剩 19 B。
 *   再往 index.js 里逐个 `import` + `step('register.xxx', ...)` 必然爆红线。
 *   ⇒ 把整批新能力收敛到这一层，index.js 只留一行调用，并同时把顶部那段
 *     「空闲自动关停 ComfyUI」的设计要点注释搬到这里保存（净减字节）。
 *
 * ## 从 index.js 搬来的设计要点（原文保留，别再丢）
 *   ⑥ 空闲自动关停 ComfyUI（用户 2026-10-07 要求「不要让 comfyUI 一直跑着，
 *      只要五分钟不生图 comfyUI 后端自动关闭」）：
 *      · 计时只在插件出过图之后才开始（lastActivityAt 初始为 null）——
 *        这样绝不会误关用户自己打开的、正在本机 ComfyUI 里用的 ComfyUI；
 *      · 到点还要再确认：ComfyUI 在线、且 /queue 为空（有任务在跑就续期）；
 *      · 只杀「监听该端口 且 命令行确实像 ComfyUI（含 comfy…main.py）」的进程，
 *        认不出来就跳过并记日志 —— 绝不按端口盲杀。
 *
 * ## 诚实边界
 *   所有新增能力在没有注入真实 I/O 时一律**明确降级**，不假装可用：
 *   ffmpeg 没探测到就说未检测、doctor 没探针就说未检测、历史库打不开就说不可用、
 *   DAG 默认 dry_run 只出计划。用户资料里的性能倍率是 unverified，不写进结论。
 */
import { accessSync, constants as FS_CONST } from 'node:fs'
import { makeGifTool } from './gif-tool.js'
import { gifRouteTable } from './gif-endpoints.js'
import { createJobQueue } from './job-queue.js'
import { makeJobTool } from './job-tool.js'
import { makeIterateTool } from './iterate-tool.js'
import { openHistoryAdmin, makeHistoryQueryTool, historyAdminRouteTable } from './history-admin.js'
import { makeDoctorTool, doctorRouteTable } from './doctor.js'
import { makeDagTool } from './dag-planner.js'
import { agentGuideRouteTable } from './agent-guide.js'
import { accelChainRouteTable } from './accel-chain.js'
// ★ 2026-11-15：加速链/SageAttention/WaveSpeed 的模式发现需要**真实节点类名**，
//   caps.nodes 是插件内部能力名（qwen21/prefixCache…），不是 /object_info 的类名。
//   这里补一条只走本机回环的 /object_info 探测（60s 缓存），失败一律如实降级。
import { guardedFetch } from './net-guard.js'
import { INTEGRATION_ROUTES } from './integration-state.js'
import { eventLogRouteTable, createEventLog, attachGenerationLogging } from './event-log.js'
import { runtimeRouteTable, createBudgetStore } from './runtime-endpoints.js'
// ★ 2026-11-15 媒体格式转换批次：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、
//   音频 MP3/AAC/WAV/FLAC + 动图转视频 + 自有无媒体转换 + 生成物指定输出格式。
//   全部落独立模块并在这里注册，index.js 仍是零增长（贴 DSH Store 单文件上限）。
import { createMediaExec } from './media-exec.js'
import { createFormatPrefs } from './media-formats.js'
import { makeMediaConvertTool } from './media-convert-tool.js'
import { mediaRouteTable } from './media-convert-endpoints.js'
import { attachGenerationPostConvert } from './media-postconvert.js'
// ★ 2026-11-15 本地能力批次（未发布）：TTS 后端选择 / 拖入音频样本 / 音乐 BGM /
//   手动超分 / 主控端 + 独立 Worker。全部经 creative-extras.js 单点注册，index.js 零增长。
import {
  CREATIVE_TOOL_NAMES, createCreativeContext, makeTtsBackendsTool, makeMusicTool,
  makeManualUpscaleTool, makeWorkerTool, creativeRouteTable,
} from './creative-extras.js'
// ★ 2026-11-15 收尾：把三个"写了但没接进主链路"的模块接上 ——
//   entry-alias（口语入口别名）、color-tone（参考图色调）、creative-chain（编排四件）。
//   三者此前只有单测引用，生产链路零入口 ⇒ 用户根本用不到。
import {
  ORPHAN_TOOL_NAMES, makeEntryAliasTool, makeTimelineTool, makeResourceNeedsTool,
  makePrivacySummaryTool, makeProduceRefTool, orphanRouteTable,
} from './orphan-extras.js'
// /run/resources 的 live ETA 走本机 ComfyUI /history（只回环、6s 超时、拿不到就 null）。
import { fetchCalibration } from './eta-calibrate.js'

export const EXTRA_TOOL_NAMES = Object.freeze([
  'convert_to_gif', 'manage_jobs', 'iterate_image', 'query_history', 'doctor', 'run_dag',
  'convert_media',
  ...CREATIVE_TOOL_NAMES,
  ...ORPHAN_TOOL_NAMES,
])

function builtInProbes(deps, admin) {
  const injected = deps.probes || {}
  return {
    ...injected,
    // 这两项不需要外部命令，可以真检测；其余保持未注入即 undetected。
    historyDb: injected.historyDb || (async () => ({
      ok: admin.available,
      detail: admin.available ? '索引可用' : '索引不可用（node:sqlite 缺失或库未建）',
    })),
    outputDir: injected.outputDir || (async () => {
      if (!deps.outputDir) return { status: 'undetected', detail: '未提供出图目录' }
      try {
        accessSync(deps.outputDir, FS_CONST.W_OK)
        return { ok: true, detail: '可写' }
      } catch {
        return { ok: false, detail: '不可写' }
      }
    }),
  }
}

/**
 * 只构造，不注册。返回 {tools, routes, admin, names} 便于离线单测。
 */
export function createExtras(deps = {}) {
  const log = deps.log
  const admin = deps.historyAdmin || openHistoryAdmin({ outputDir: deps.outputDir, log })
  const queue = deps.queue || createJobQueue({ now: deps.now })
  const probes = builtInProbes(deps, admin)
  const eventLog = deps.eventLog || createEventLog({ outputDir: deps.outputDir, log })
  const budgetStore = deps.budgetStore || createBudgetStore()
  // ★ 2026-11-15：把结构化日志接到生成完成钩子上。historyStore 在 index.js 里
  //   先于本注册层创建，钩子是模块级订阅，所以之后每次 record() 都会自动落一条
  //   generation_complete（含本机实测总耗时），不需要改贴线的 lib/index.js。
  //   deps.eventLog 显式注入时同样挂上，便于离线单测。
  attachGenerationLogging(eventLog)
  const mediaExec = deps.mediaExec || createMediaExec({ log, ffmpegPath: deps.cfg?.ffmpegPath })
  const formatPrefs = deps.formatPrefs || createFormatPrefs()
  const creative = deps.creativeContext || createCreativeContext({
    outputDir: deps.outputDir, sourceDirs: deps.sourceDirs, installed: deps.installed,
    spawn: deps.spawn, kill: deps.kill, workerFetch: deps.workerFetch,
    vramProbe: deps.vramProbe, now: deps.now, log,
  })
  // /object_info 全量节点表：60s 缓存，全部经 guardedFetch（只放行本机、禁重定向）。
  // 允许测试用 deps.objectInfoProbe 注入假数据；未注入且 ComfyUI 不在线时返回 ok:false。
  let objectInfoCache = { at: 0, nodes: [] }
  const objectInfoProbe = deps.objectInfoProbe || (async () => {
    const now = Date.now()
    if (now - objectInfoCache.at < 60000 && objectInfoCache.nodes.length > 0) {
      return { ok: true, nodes: objectInfoCache.nodes, reason: '' }
    }
    const url = String(deps.cfg?.comfyUrl || 'http://127.0.0.1:8188').replace(/\/+$/u, '') + '/object_info'
    try {
      const init = { redirect: 'error' }
      if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(2000)
      const res = await guardedFetch(url, init)
      if (!res?.ok) return { ok: false, nodes: [], reason: '本机 /object_info 未就绪' }
      const data = await res.json()
      const nodes = data && typeof data === 'object' ? Object.keys(data).slice(0, 4000) : []
      if (nodes.length > 0) objectInfoCache = { at: now, nodes }
      return { ok: nodes.length > 0, nodes, reason: nodes.length > 0 ? '' : '节点表为空' }
    } catch {
      return { ok: false, nodes: [], reason: '本机 /object_info 探测失败' }
    }
  })
  const base = { ...deps, historyAdmin: admin, queue, probes, eventLog, budgetStore, log,
    mediaExec, formatPrefs, creativeContext: creative, objectInfoProbe }
  // ★ 已注册工具名的全集：内置（index.js 传入）+ 本注册层全部外置工具。
  //   entry-alias 的别名必须指向**真实存在**的工具，指错要报错而不是放行；
  //   只靠 deps.tools 会漏掉本层工具（它们此刻还没 registerTool），所以这里取并集。
  const knownTools = [...new Set([...(Array.isArray(deps.tools) ? deps.tools : []),
    ...EXTRA_TOOL_NAMES])]
  // ★ 生成完成钩子已被结构化日志占用：不覆盖、不替换，用组合钩子把
  //   「生成物按预设自动后转码」接成第二个消费者，零 index.js 改动覆盖全部生成路径。
  attachGenerationPostConvert({
    prefs: formatPrefs, mediaExec, eventLog, log,
    outputDir: deps.outputDir, sourceDirs: deps.sourceDirs,
  })

  const tools = [
    makeGifTool(base),
    makeJobTool(base),
    makeIterateTool(base),
    makeHistoryQueryTool({ admin }),
    makeDoctorTool({ probes, log }),
    makeDagTool(base),
    makeMediaConvertTool(base),
    makeTtsBackendsTool(base),
    makeMusicTool(base),
    makeManualUpscaleTool(base),
    makeWorkerTool(base),
    // 口语入口 / 时间轴 / 资源声明 / 数据流摘要 / 产出短引用。
    makeEntryAliasTool({ knownTools }),
    makeTimelineTool(),
    makeResourceNeedsTool({ calibration: deps.calibration }),
    makePrivacySummaryTool({ cfg: deps.cfg }),
    makeProduceRefTool({ historyAdmin: admin }),
  ]
  const names = tools.map((t) => t.name)
  const routes = [
    ...gifRouteTable(base),
    // 媒体格式转换：POST /media/convert 执行、GET|POST /media/formats 能力清单与输出格式预设。
    ...mediaRouteTable(base),
    ...historyAdminRouteTable({ ...base, admin }),
    ...doctorRouteTable(base),
    ...agentGuideRouteTable({
      ...base,
      tools: [...(deps.tools || []), ...names],
      // ★ 2026-11-14 全面排查修复：index.js 只传了 tools、没传 routes，
      //   导致 /agent-guide 的 endpoints 恒为空数组，Agent 拿不到端点目录。
      //   这里回退到真实端点目录（纯常量、零 index.js 改动）。
      routes: deps.routes || INTEGRATION_ROUTES,
    }),
    // 加速链全景（含 TTS 加速段）：把原本孤儿的能力模块接进主链路。
    ...accelChainRouteTable(base),
    // 结构化日志落盘 + 显存预算档位 + 配置矛盾只读报告。
    ...eventLogRouteTable(base),
    ...runtimeRouteTable(base),
    // TTS 后端 / 音频样本 / 音乐 BGM / 手动超分 / Worker 生命周期。
    ...creativeRouteTable(base),
    // 口语入口别名全表 / 参考图色调提取 / 资源需求声明（含本机实测 ETA）。
    ...orphanRouteTable({ ...base, knownTools, fetchCalibration: deps.fetchCalibration || fetchCalibration,
      fetchFn: deps.fetchFn }),
  ]
  return { tools, routes, admin, queue, probes, names, eventLog, budgetStore,
    mediaExec, formatPrefs, creativeContext: creative }
}

/**
 * index.js 的唯一接线入口。
 * @param {(t:object)=>any} registerTool 已经包好 withDeclaredOutput 的注册函数
 * @param {(path:string,handler:Function)=>any} reg 端点注册函数
 */
export function registerExtras({ registerTool, reg, deps = {} } = {}) {
  const extras = createExtras(deps)
  if (typeof registerTool === 'function') {
    for (const t of extras.tools) registerTool(t)
  }
  if (typeof reg === 'function') {
    for (const r of extras.routes) reg(r.path, r.handler)
  }
  return extras
}
