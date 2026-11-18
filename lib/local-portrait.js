/** lib/local-portrait.js —— 内置 Rust 图片合成器的发现 + 调用 + 围栏（纯逻辑 / 依赖注入）。
 *  对应 tools-rust/dshqp-portrait（源码可复现构建），产物放 assets/bin/dshqp-portrait.exe。
 *
 *  ★ 诚实边界：这是纯 CPU 的「贴图合成 / 预演」底座（把选定人物图按框选贴到底图上，
 *    可绿幕抠图 + 边缘羽化），**不是像素级换脸**。真正换脸要几 GB 扩散模型 + GPU，
 *    本插件不捆绑、不下载、不假装能做。人脸检测/对齐需 ONNX 模型（模型除外），
 *    走发现 + 引导，见 lib/portrait-swap.js。
 *
 *  本模块：不 spawn、不联网、不读文件；由宿主注入 runArgv / exists / toPath。
 *  路径围栏：三个路径（底图 / 人物图 / 输出）都必须落在 outputDir 内，防越权读写。
 *  异常只回固定文案 + 降级原因，不回吐 error.message（可能夹带本机路径）。
 */
import path from 'node:path'

export const PORTRAIT_ENGINE = 'dshqp-portrait-rs/0.1.0'
export const PORTRAIT_EXE = 'dshqp-portrait.exe'

/** 内置 exe 路径（相对本模块解析 → ../assets/bin/dshqp-portrait.exe）。
 *  仅 Windows；返回 { binPath（仅内部执行用，禁止回传前端）, display, source }。 */
export function builtinPortraitPath(deps = {}) {
  try {
    if (typeof process !== 'undefined' && !/^win/u.test(process.platform ?? '')) return null
    const url = deps.metaUrl || (typeof import.meta !== 'undefined' ? import.meta.url : '')
    if (!url) return null
    const u = new URL(`../assets/bin/${PORTRAIT_EXE}`, url)
    const binPath = typeof deps.toPath === 'function'
      ? deps.toPath(u)
      : decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/u, '$1').replace(/\//gu, '\\')
    if (typeof deps.exists === 'function' && !deps.exists(binPath)) return null
    return { binPath, display: '插件内置 dshqp-portrait.exe（纯 CPU）', source: '内置' }
  } catch { return null }
}

/** 路径围栏：p 必须是 outputDir 内的路径（规范化后 startsWith root + sep），拒 .. 穿越。
 *  pathMod 可注入以便离线测试平台差异。 */
export function isInsideOutputDir(p, outputDir, deps = {}) {
  const P = deps.pathMod || path
  const rel = String(p ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (!rel || !base) return false
  if (rel.replace(/\\/gu, '/').split('/').some((s) => s === '..')) return false
  try {
    const root = P.resolve(base)
    const full = P.resolve(rel)
    if (full === root) return false
    return full.startsWith(root + P.sep)
  } catch { return false }
}

/** 归一化框选：把 {x,y,w,h} 夹进 0..1，w/h 必须 > 0。 */
export function normalizeBox(box = {}) {
  const c = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }
  const x = c(box?.x); const y = c(box?.y)
  const w = c(box?.w); const h = c(box?.h)
  return { x, y, w, h, ok: w > 0 && h > 0 }
}

/** 组装传给 Rust exe 的 stdin JSON（纯函数，便于断言形状）。 */
export function buildPortraitRequest({ base, person, out, box, feather, chroma, tolerance } = {}) {
  const b = normalizeBox(box)
  const req = {
    op: 'compose',
    base: String(base ?? ''), person: String(person ?? ''), out: String(out ?? ''),
    box: { x: b.x, y: b.y, w: b.w, h: b.h },
  }
  if (Number.isFinite(feather) && feather >= 0) req.feather = Math.min(256, Math.trunc(feather))
  if (Array.isArray(chroma) && chroma.length >= 3) req.chroma = chroma.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.trunc(Number(v) || 0))))
  if (Number.isFinite(tolerance) && tolerance >= 0) req.tolerance = Math.min(255, Math.trunc(tolerance))
  return req
}

/** 解析 Rust stdout（一行 JSON）。坏输出一律降级，不抛给调用方。 */
export function parsePortraitResult(stdout = '') {
  try {
    const j = JSON.parse(String(stdout).trim().split(/\r?\n/u).filter(Boolean).pop() || '{}')
    if (j && j.ok === true && typeof j.out === 'string') {
      return { ok: true, out: j.out, width: Number(j.width) || 0, height: Number(j.height) || 0,
        engine: typeof j.engine === 'string' ? j.engine : PORTRAIT_ENGINE }
    }
    return { ok: false, reason: typeof j?.reason === 'string' ? j.reason : '合成器返回失败' }
  } catch { return { ok: false, reason: '合成器输出无法解析' } }
}

/** 主执行：校验围栏 → 组请求 → 调注入的 runArgv(binPath, []) → 解析结果。
 *  deps.runArgv(binPath, argv, stdinText) => Promise<{stdout,stderr,code}>。 */
export async function composePortrait(deps = {}, args = {}) {
  const builtin = deps.builtin || (typeof deps.builtinPortrait === 'function' ? deps.builtinPortrait(deps) : null)
  if (!builtin || !builtin.binPath) {
    return { ok: false, degraded: true, reason: '未找到内置图片合成器（不是 Windows 或文件缺失），可用外部工具自行合成。',
      path: '', engine: '' }
  }
  const outputDir = String(deps.outputDir ?? '').trim()
  for (const key of ['base', 'person', 'out']) {
    if (!isInsideOutputDir(args?.[key], outputDir, deps)) {
      return { ok: false, degraded: true, reason: `${key} 路径必须落在出图目录内（安全围栏）`, path: '', engine: '' }
    }
  }
  const box = normalizeBox(args?.box)
  if (!box.ok) {
    return { ok: false, degraded: true, reason: '框选区域 w/h 必须大于 0', path: '', engine: '' }
  }
  const req = buildPortraitRequest(args)
  if (typeof deps.runArgv !== 'function') {
    return { ok: false, degraded: true, reason: '未注入命令执行器，无法调用本地合成器', path: '', engine: '' }
  }
  let res
  try {
    res = await deps.runArgv(builtin.binPath, [], JSON.stringify(req))
  } catch {
    return { ok: false, degraded: true, reason: '本地合成器执行失败（详情见本机日志）', path: '', engine: '' }
  }
  const parsed = parsePortraitResult(res?.stdout ?? '')
  if (!parsed.ok) return { ok: false, degraded: true, reason: parsed.reason, path: '', engine: '' }
  // 二次围栏：Rust 回报的输出路径也必须仍在 outputDir 内。
  if (!isInsideOutputDir(parsed.out, outputDir, deps)) {
    return { ok: false, degraded: true, reason: '合成器回报的输出路径越界，已拒绝', path: '', engine: '' }
  }
  return { ok: true, degraded: false, reason: '', path: parsed.out, width: parsed.width,
    height: parsed.height, engine: parsed.engine }
}

export const LOCAL_PORTRAIT_EXPORTS = Object.freeze({
  PORTRAIT_ENGINE, PORTRAIT_EXE, builtinPortraitPath, isInsideOutputDir,
  normalizeBox, buildPortraitRequest, parsePortraitResult, composePortrait,
})
