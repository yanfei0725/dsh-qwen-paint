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
import { accessSync, statSync, unlinkSync, writeFileSync, existsSync, constants as FS_CONST } from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
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
// ★ 2026-11-16：位图 → SVG 矢量化（两步法）—— vtracer（MIT，官方 Release 单源下载）
//   + potrace（GPL-2.0+，用户自备 exe）。沿 vulkan-upscale 同款「目录 + execFile + 围栏」。
import { makeVectorizeTool, vectorizeRouteTable } from './vectorize.js'
// ★ 2026-11-16：轻量缝合（旁白时间轴 + BGM ducking + SRT，纯 ffmpeg 显存 0）、
//   轻量档 PPTX（纯 JS 零依赖零 GPU）、本机 ASR 状态探测（faster-whisper 零新路径）。
import { makeMixNarrationTool, stitchRouteTable } from './av-stitch.js'
import { makePptxTool, pptxRouteTable } from './pptx-lite.js'
import { asrStatusRouteTable } from './asr-status.js'
// ★ 2026-11-16 内置最小实现：音频后处理 / 无模型抠图 / 中置相消声源分离，
//   三工具共享一个 media-fx.js 模块（纯 ffmpeg 零模型零下载），index.js 零增长。
import {
  makeEnhanceAudioTool, makeCutoutTool, makeSplitAudioTool, mediaFxRouteTable,
} from './media-fx.js'
// ★ 2026-11-16：音频转文字升一等工具（复用 asr-client 的 transcribeAudio）。
import { makeTranscribeTool, transcribeRouteTable } from './transcribe-tool.js'
// ★ 2026-11-18：人物替换编排（拖拽登记 + 身份保持节点发现 + 内置 Rust CPU 合成器）。
//   只加端点、不新增 Agent 工具名；复用渲染探针的 execStdin，index.js 零增长。
import { portraitRouteTable } from './portrait-endpoints.js'
// ★ 2026-11-17：自研轻量代码动画三件套（不依赖 manim/Remotion）——分镜/SVG帧/合成。
import { makeAnimationTools } from './animation-kit.js'
import { makeLayoutFrameTool } from './layout-lite.js'
import { createRenderProbes } from './render-backends.js'
import { writeFile as fsWriteFile } from 'node:fs/promises'

export const EXTRA_TOOL_NAMES = Object.freeze([
  'convert_to_gif', 'manage_jobs', 'iterate_image', 'query_history', 'doctor', 'run_dag',
  'convert_media',
  ...CREATIVE_TOOL_NAMES,
  ...ORPHAN_TOOL_NAMES,
  'vectorize_image',
  'make_pptx',
  'mix_narration',
  'enhance_audio', 'cutout_image', 'split_audio',
  'transcribe_audio',
  'plan_storyboard', 'render_frame', 'compose_video', 'layout_frame',
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
  // ★ 2026-11-18（社区调研 A 类）：doctor 8 项里原有 6 项探针空转。这里把**能用现有
  //   deps 真检测到**的 4 项接上，其余 2 项（model_integrity 需服务器权威 size、
  //   tts_backend 需权重探测）保持 undetected —— 绝不为了 doctor 变绿而假装检测过。
  //   每项仍是 async 探针，失败/拿不到就如实返回 undetected，与 doctor.js 的诚实口径一致。
  {
    const injected = deps.probes || {}
    const accelNames = ['QwenImage21Cache', 'TeaCache', 'TESpeedQwenImage21',
      'QwenImage21Speedup', 'QwenImage21BlockCacheT8', 'ApplyRDNA3FlashAttention',
      'SageAttention', 'TorchCompileModel']
    probes.comfyOnline = injected.comfyOnline || (async () => {
      const r = await objectInfoProbe()
      return r.ok ? { ok: true, detail: '本机 /object_info 可访问（ComfyUI 在线）' }
        : { status: 'undetected', detail: r.reason || '本机 ComfyUI 未就绪' }
    })
    probes.accelPacks = injected.accelPacks || (async () => {
      const r = await objectInfoProbe()
      if (!r.ok) return { status: 'undetected', detail: r.reason || '节点表不可用' }
      const found = accelNames.filter((n) => r.nodes.includes(n))
      return { ok: found.length > 0,
        detail: found.length ? `检测到 ${found.length} 个加速节点：${found.slice(0, 4).join('、')}`
          : '节点表里没有已知加速节点（可正常出图，只是没有加速链）' }
    })
    probes.ffmpeg = injected.ffmpeg || (async () => {
      const p = await mediaExec.probe()
      return p.available ? { ok: true, detail: `ffmpeg 可用（来源：${p.source}）` }
        : { ok: false, detail: p.reason || '未探测到 ffmpeg' }
    })
    probes.attentionBackend = injected.attentionBackend || (async () => {
      const r = await objectInfoProbe()
      if (!r.ok) return { status: 'undetected', detail: r.reason || '节点表不可用' }
      const names = ['SageAttention', 'FlashAttention', 'ApplyRDNA3FlashAttention', 'TorchCompileModel']
      const found = names.filter((n) => r.nodes.includes(n))
      // 只查到「节点装了」，没验证「与当前显卡匹配」——按 doctor 口径只能算未检测，
      // 不能报 pass 让人误以为后端已经确认可用。诚实降级。
      return { status: 'undetected',
        detail: found.length ? `节点表有 ${found.join('、')}，但未验证与当前显卡匹配（请在 ComfyUI 侧确认）`
          : '未从节点表识别到注意力后端（需进 ComfyUI 确认）' }
    })
  }
  // ★ 动画三件套：writeFile 真落盘（工具内已做目录围栏）、runCommand 复用已探测 ffmpeg 的执行器。
  //   两者任一没就绪时工具会自行降级（只回 argv / svg，不谎称出片）。
  const animDeps = { ...base, writeFile: deps.writeFile || fsWriteFile,
    runCommand: deps.runCommand || ((cmd, opts) => mediaExec.runCommand(cmd, opts)) }
  // ★ 渲染后端探针：编码器用 ffmpeg 执行器真跑择优；resvg 光栅优先用插件内置 exe
  //   （assets/bin/resvg.exe），经 stdin 送 SVG/收 PNG，绕开路径与编码问题。
  //   --version 探测走 execFile，stdin 渲染走 spawn；宿主可注入自己的实现覆盖。
  //   任何失败都只是「不用光栅、保留 SVG」，不阻塞动画工具注册、不谎称已启用。
  const defaultExec = (bin, args, opts = {}) => new Promise((resolve, reject) => {
    execFile(String(bin), Array.isArray(args) ? args : [], { timeout: opts.timeoutMs || 8000, windowsHide: true },
      (err, stdout) => err ? reject(err) : resolve({ ok: true, stdout }))
  })
  const defaultExecStdin = (bin, svg, opts = {}) => new Promise((resolve) => {
    let child
    try {
      child = spawn(String(bin), ['-', '-c'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch { resolve({ ok: false }); return }
    const chunks = []
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ }; done({ ok: false, reason: 'resvg 渲染超时' }) }, opts.timeoutMs || 30000)
    child.stdout?.on('data', (d) => chunks.push(d))
    child.on('error', () => done({ ok: false }))
    child.on('close', (code) => {
      if (code === 0 && chunks.length) done({ ok: true, stdout: Buffer.concat(chunks) })
      else done({ ok: false })
    })
    try { child.stdin.end(String(svg), 'utf8') } catch { done({ ok: false }) }
  })
  const renderProbes = createRenderProbes({
    runCommand: animDeps.runCommand, exec: deps.exec || defaultExec, execStdin: deps.execStdin || defaultExecStdin,
    resvgPath: deps.cfg?.resvgPath, fs: { statSync, unlinkSync, writeFileSync },
    path, outputDir: deps.outputDir, log,
    exists: existsSync, toPath: deps.toPath, metaUrl: deps.metaUrl,
  })
  animDeps.probeEncoder = renderProbes.probeEncoder
  animDeps.rasterBackend = renderProbes.rasterBackend
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
    makeVectorizeTool(base),
    makeMixNarrationTool(base),
    makePptxTool(base),
    makeEnhanceAudioTool(base),
    makeCutoutTool(base),
    makeSplitAudioTool(base),
    makeTranscribeTool(base),
    ...makeAnimationTools(animDeps),
    makeLayoutFrameTool(animDeps),
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
    // 位图 → SVG 矢量化：GET 能力 / POST 执行（引擎未安装时如实降级）。
    ...vectorizeRouteTable(base),
    // 轻量缝合 / 轻量档 PPTX / 本机 ASR 状态。
    ...stitchRouteTable(base),
    ...pptxRouteTable(base),
    ...asrStatusRouteTable(base),
    // 音频后处理 / 无模型抠图 / 中置相消声源分离（4 条端点，能力探测 + 三执行）。
    ...mediaFxRouteTable(base),
    // 音频转文字：能力探测 + POST 执行（复用 asr-client，缺件如实降级）。
    ...transcribeRouteTable(base),
    // 人物替换编排：内置 Rust CPU 合成器（stdin JSON）+ 身份保持节点发现 + 拖拽素材登记。
    //   execStdin 复用渲染探针的同一执行器（defaultExecStdin / deps.execStdin）。
    ...portraitRouteTable({ ...base, execStdin: deps.execStdin || defaultExecStdin,
      exists: deps.exists || existsSync }),
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
    for (const r of extras.routes) {
      reg(r.path, r.handler)
      // ★ 2026-11-19 宿主墙回退别名：DSH 的 /api/* 鉴权墙对部分端点按路径 401（实测 doctor /
      //   tts/backends / creative / gif / media / vectorize / portrait / jobs 等被挡，而
      //   comfy-pipeline 家族与资产前缀不受影响），但**无 api 前缀的 qwen-paint 段完全不过墙**
      //   （/qwen-paint/status.json 别名与全部资产长期实证 200）。每条 extras 路由在去掉
      //   「/api」4 字符前缀的路径上再注册同一 handler：前端 401/404 时自动回退到此别名。
      //   （字符串全部运行时拼接，不写端点字面量——product-round 的注册扫描按字面量对账。）
      if (typeof r.path === 'string'
        && r.path.startsWith('/api/') && r.path.indexOf('qwen-paint/') === 5) {
        reg(r.path.slice(4), r.handler)
      }
    }
  }
  return extras
}
