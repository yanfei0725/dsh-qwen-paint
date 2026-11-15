/**
 * lib/media-postconvert.js —— 「生成时指定输出格式」的真实接线层。
 *
 * ## 为什么是「生成完成后自动补一次转码」
 *   ComfyUI 的保存节点格式是固定的：SaveImage → PNG、VHS_VideoCombine → mp4/gif、
 *   SaveAudioMP3 → mp3。插件不能让这些节点直接吐 WebP / MKV / FLAC。
 *   所以用户说的「生成的图片视频音频可以指定格式」，诚实的实现是：
 *     生成物落盘 → 生成完成钩子接住 → 按预设自动转一份目标格式（**原产物保留**）。
 *   绝不写成「生成时直接指定格式」来误导。
 *
 * ## 接线方式（零 index.js 改动）
 *   lib/history-store.js::record() 是**所有生成路径的统一出口**，会调一次
 *   模块级 generationLogHook。lib/event-log.js 已经用它写结构化日志（单实例钩子）。
 *   这里不覆盖、不替换，而是用 composeGenerationHook 把「日志消费」与
 *   「自动后转码消费」组合成一个钩子，两者互不干扰、任一抛错都不影响出图。
 *
 * ## 硬边界
 *   · 没有设置任何输出格式预设时，本层**零 I/O、零分配**（不改变既有行为）；
 *   · 后转码 fire-and-forget：绝不 await、绝不阻塞生成主链路；
 *   · 探测不到 ffmpeg / 转换失败 → 如实写一条降级事件，不假装成功、不删原产物；
 *   · 输出名带 _converted 且不会写回历史库，避免生成 → 转换 → 再记录的循环；
 *   · 路径绝不进结构化日志（沿用 structured-log.js 的消毒闸门）。
 */
import path from 'node:path'
import { getGenerationLogHook, setGenerationLogHook } from './history-store.js'
import { resolveFormat } from './media-formats.js'
import {
  resolveMediaSourcePath, resolveMediaOutputPath, needsConversion,
} from './media-convert-tool.js'
import { buildMediaConvertCommand, sourceKindOf } from './media-formats.js'

/** 历史条目里的 kind 与格式组的对应关系（只认这三类，other 一律跳过）。 */
const PREF_KINDS = Object.freeze(['image', 'video', 'audio'])

/**
 * 纯计划函数：不执行、不 I/O。便于离线回归直接断言「该不该转、转成什么」。
 * @returns {{skip:boolean, reason?:string, source?:string, out?:string, format?:string, kind?:string}}
 */
export function planPostConvert(entry = {}, { prefs, outputDir, sourceDirs = [] } = {}) {
  const file = String(entry?.file_path ?? entry?.path ?? '').trim()
  if (!file) return { skip: true, reason: '生成条目没有产物路径' }
  const rawKind = String(entry?.kind ?? '').trim().toLowerCase()
  const kind = PREF_KINDS.includes(rawKind) ? rawKind : sourceKindOf(file)
  if (!PREF_KINDS.includes(kind)) return { skip: true, reason: '产物类别不在 image/video/audio 内' }

  // 单次指定优先于全局预设：entry.output_format / entry.extra.output_format。
  const requested = entry?.output_format ?? entry?.extra?.output_format ?? prefs?.get?.(kind) ?? null
  if (!requested) return { skip: true, reason: '没有设置输出格式预设' }
  const fmt = resolveFormat(requested)
  if (!fmt.ok) return { skip: true, reason: fmt.reason }
  if (fmt.spec.kind !== kind) {
    return { skip: true, reason: `格式 ${fmt.format} 与产物类别 ${kind} 不匹配` }
  }
  if (!needsConversion(file, fmt.format)) return { skip: true, reason: '产物已经是目标格式，无需重复转码' }

  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(String(outputDir ?? ''), file)
  const src = resolveMediaSourcePath({ source: abs, outputDir, sourceDirs })
  if (!src.ok) return { skip: true, reason: src.reason }
  const base = path.basename(src.path).replace(/\.[^.]+$/u, '')
  const out = resolveMediaOutputPath({
    target: base + '_converted.' + fmt.format, outputDir, format: fmt.format,
  })
  if (!out.ok) return { skip: true, reason: out.reason }
  const built = buildMediaConvertCommand({
    source: src.path, out: out.path, format: fmt.format,
    sourceKind: sourceKindOf(src.path), options: entry?.extra?.media_options ?? {},
  })
  if (!built.ok) return { skip: true, reason: built.reason }
  return { skip: false, source: src.path, out: out.path, format: fmt.format, kind, command: built.command }
}

/**
 * 执行一份计划。永远 resolve（不抛），失败只写降级事件，不影响生成主链路。
 * @returns {Promise<{ok:boolean, reason:string, degraded:boolean, format:string, kind:string}>}
 */
export async function runPostConvert(plan, deps = {}) {
  const { mediaExec, eventLog, log } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const format = plan?.format ?? ''
  const kind = plan?.kind ?? ''
  if (!plan || plan.skip) {
    return { ok: false, reason: plan?.reason ?? '没有转换计划', degraded: true, format, kind }
  }
  try {
    if (!mediaExec || typeof mediaExec.runCommand !== 'function') {
      return { ok: false, reason: '未注入媒体执行器，自动后转码跳过（原产物保留）', degraded: true, format, kind }
    }
    const probe = typeof mediaExec.probe === 'function' ? await mediaExec.probe() : null
    if (probe && probe.available === false) {
      return { ok: false, reason: '未探测到 ffmpeg，自动后转码跳过（原产物保留）', degraded: true, format, kind }
    }
    const run = await mediaExec.runCommand(plan.command, { timeoutMs: 180000 })
    const ok = run?.ok === true
    // 结构化日志：只记事实，绝不写路径 / prompt 全文 / 本机信息。
    try {
      eventLog?.append?.({
        event: 'format_autoconvert', tool: 'convert_media', kind,
        ok, degraded: !ok,
        degrade_reasons: ok ? [] : [String(run?.reason ?? '转换未成功')],
        timings: { total_ms: null },
      })
    } catch { /* 日志失败不影响转换结果 */ }
    return { ok, reason: String(run?.reason ?? '执行器未给出结论'), degraded: !ok, format, kind }
  } catch (error) {
    warn('生成物自动后转码失败：' + (error?.message ?? error))
    try {
      eventLog?.append?.({
        event: 'format_autoconvert', tool: 'convert_media', kind,
        ok: false, degraded: true, degrade_reasons: ['自动后转码异常（详见插件日志）'],
      })
    } catch { /* 忽略 */ }
    return { ok: false, reason: '自动后转码暂不可用（详见插件日志）', degraded: true, format, kind }
  }
}

/**
 * 把已有生成钩子与自动后转码组合成一个新钩子（不覆盖、不丢弃原消费者）。
 * 返回一个可传给 setGenerationLogHook 的函数；重复调用不会叠加多层后转码。
 */
export function composeGenerationHook(previous, consumer) {
  const wrapped = function hookedGeneration(entry) {
    if (typeof previous === 'function') {
      try { previous(entry) } catch { /* 原消费者失败不影响后转码 */ }
    }
    if (typeof consumer !== 'function') return
    // fire-and-forget：绝不 await，绝不阻塞出图主链路。
    try { Promise.resolve(consumer(entry)).catch(() => {}) } catch { /* 忽略 */ }
  }
  wrapped.__dshqpMediaPostConvert = true
  return wrapped
}

/**
 * 注册层的唯一接线入口：由 lib/tool-registry.js::createExtras() 调用一次。
 * 返回是否成功挂上（没有原始钩子时返回 false，绝不擅自造一个覆盖掉日志）。
 */
export function attachGenerationPostConvert(deps = {}) {
  const previous = getGenerationLogHook()
  if (typeof previous !== 'function') return false
  // 已经组合过就不再叠一层（测试会多次 createExtras）。
  if (previous.__dshqpMediaPostConvert === true) {
    return setGenerationLogHook(previous)
  }
  const { prefs, outputDir, sourceDirs, mediaExec, eventLog, log } = deps
  const consumer = (entry) => {
    const plan = planPostConvert(entry, { prefs, outputDir, sourceDirs })
    if (plan.skip) return { ok: false, degraded: true, reason: plan.reason }
    return runPostConvert(plan, { mediaExec, eventLog, log })
  }
  return setGenerationLogHook(composeGenerationHook(previous, consumer))
}
