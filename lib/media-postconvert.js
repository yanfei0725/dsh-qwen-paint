// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-media-postconvert
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
export function composeGenerationHook(previous, consumer, deps = {}) {
  const warn = (msg) => { try { deps.log?.('warn', msg) } catch { /* 日志失败不影响出图 */ } }
  const wrapped = function hookedGeneration(entry) {
    if (typeof previous === 'function') {
      try { previous(entry) } catch { /* 原消费者失败不影响后转码 */ }
    }
    if (typeof consumer !== 'function') return
    // fire-and-forget：绝不 await，绝不阻塞出图主链路；异步失败必须留痕不再静默吞。
    try {
      Promise.resolve(consumer(entry)).catch((error) => {
        warn('生成物自动后转码异步失败：' + (error?.message ?? error))
      })
    } catch (error) {
      warn('生成物自动后转码同步失败：' + (error?.message ?? error))
    }
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
  return setGenerationLogHook(composeGenerationHook(previous, consumer, { log }))
}
