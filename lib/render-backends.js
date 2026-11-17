/** 渲染后端探测（发现模式，绝不假装启用）
 *  · 视频编码器：真跑 1 帧探测 NVENC→QSV→libx264→AMF，逐级择优/降级；
 *    「编码器编译进 ffmpeg」≠「本机硬件可用」，所以必须实跑不查 -encoders。
 *    ★ libx264 排在 AMF 前（2026-11-17 实测决策）：本机 AMF 可用但慢 12.9%~38.3%
 *      （D3D11 初始化 0.38 s 摊不掉 + 无 GPU buffer 直传 + 核显 APU 共享带宽），
 *      软件 x264 在短片/低分辨率下反而更快；NVENC/QSV 仍是真硬件优先。
 *  · 光栅后端：探测 resvg（RESVG_PATH / PATH），可用则 SVG→PNG 走 resvg，
 *    否则降级调用方注入的 fallback（Edge 截图 / SVG 落盘）。
 *  · 全部纯逻辑 + 依赖注入：不 spawn、不联网、不写文件，由宿主 runCommand 执行。
 *  · 异常只回固定文案 + 降级原因，不回吐 error.message。
 */
export const ENCODE_PRIORITY = Object.freeze(['h264_nvenc', 'h264_qsv', 'libx264', 'h264_amf'])
export const ENCODER_LABELS = Object.freeze({
  h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel Quick Sync', h264_amf: 'AMD AMF', libx264: 'CPU x264（软件）',
})

/** 插件内置的 resvg 可执行文件路径（相对本模块解析，绝不硬编码本机绝对路径）。
 *  包结构：lib/render-backends.js → ../assets/bin/resvg.exe。
 *  仅 Windows 内置；其他平台返回 null，由 RESVG_PATH/PATH 发现模式兜底。
 *  返回 { binPath（真实路径，仅内部执行用，禁止回传前端）, display（脱敏展示名） }。 */
export function builtinResvgPath(deps = {}) {
  try {
    if (typeof process !== 'undefined' && !/^win/u.test(process.platform ?? '')) return null
    const url = deps.metaUrl || (typeof import.meta !== 'undefined' ? import.meta.url : '')
    if (!url) return null
    const u = new URL('../assets/bin/resvg.exe', url)
    const raw = decodeURIComponent(u.pathname)
    // Windows: /X:/a/b → X:\a\b；用宿主注入的 toPath 转换（测试可桩），避免引入 node:url 依赖
    const binPath = typeof deps.toPath === 'function' ? deps.toPath(u) : raw.replace(/^\/([A-Za-z]:)/u, '$1').replace(/\//gu, '\\')
    if (typeof deps.exists === 'function' && !deps.exists(binPath)) return null
    return { binPath, display: '插件内置 resvg.exe', source: '内置' }
  } catch { return null }
}

/** 探测某编码器是否真能编 1 帧。probeFrame 由宿主注入（临时文件 + runCommand 已完成）。
 *  deps.probeEncoder(enc) => Promise<boolean> —— 真跑一帧，成功 true。 */
export async function probeEncoders(deps = {}) {
  const doProbe = deps.probeEncoder
  const results = []
  if (typeof doProbe !== 'function') {
    return { available: [], selected: 'libx264', label: ENCODER_LABELS.libx264,
      detail: '未注入编码器探测执行器，保守用 libx264（未实测硬件编码）。', probed: false }
  }
  for (const enc of ENCODE_PRIORITY) {
    let ok = false
    try { ok = (await doProbe(enc)) === true } catch { ok = false }
    results.push({ encoder: enc, label: ENCODER_LABELS[enc] || enc, ok })
    if (ok) break // 择优：第一个能编的就选，不再试更慢的
  }
  const hit = results.find((r) => r.ok)
  return {
    available: results.filter((r) => r.ok).map((r) => r.encoder),
    results,
    selected: hit ? hit.encoder : 'libx264',
    label: hit ? hit.label : ENCODER_LABELS.libx264,
    detail: hit ? `已实测 ${hit.label} 可编码，自动择优。` : '硬件编码均未通过实测，降级 libx264（软件编码，仍可出片）。',
    probed: true,
  }
}

/** resvg 探测：deps.probeResvg(bin) => Promise<boolean>（跑 `bin --version`）。
 *  bin 来自 RESVG_PATH 或 PATH 的 'resvg'。 */
export async function probeRaster(deps = {}) {
  const doProbe = deps.probeResvg
  const candidates = []
  // ★ 内置优先：插件自带 resvg.exe 是默认光栅后端；RESVG_PATH/PATH 仅作覆盖与外部兜底。
  const builtin = deps.builtin || (typeof deps.builtinResvg === 'function' ? deps.builtinResvg(deps) : null)
  if (builtin) candidates.push({ bin: builtin.binPath, display: builtin.display || '插件内置 resvg.exe', source: builtin.source || '内置' })
  const env = String(deps.resvgPath ?? (typeof process !== 'undefined' ? process.env.RESVG_PATH : '') ?? '').trim()
  if (env) candidates.push({ bin: env, display: 'RESVG_PATH 指定', source: 'RESVG_PATH' })
  candidates.push({ bin: 'resvg', display: 'PATH 中的 resvg', source: 'PATH' })
  if (typeof doProbe !== 'function') {
    return { backend: 'fallback', bin: '', source: '', detail: '未注入光栅探测执行器，用调用方降级路径（Edge/SVG）。', probed: false }
  }
  for (const c of candidates) {
    let ok = false
    try { ok = (await doProbe(c.bin)) === true } catch { ok = false }
    if (ok) return { backend: 'resvg', bin: c.display || c.bin, execPath: c.bin, source: c.source,
      detail: `已实测 resvg 可用（${c.source}），SVG→PNG 走 resvg 光栅。`, probed: true }
  }
  return { backend: 'fallback', bin: '', source: '',
    detail: '未探测到 resvg（内置/RESVG_PATH/PATH 均未通过 --version 实测），降级 Edge/SVG，不谎称已启用。', probed: true }
}

/** resvg 渲染命令（基础形式，尺寸交给 SVG 自身 width/height，避免版本参数漂移）。
 *  deps 仅用于围栏校验；返回 argv，宿主执行。 */
export function resvgCommand({ bin, svgPath, outPath } = {}) {
  const b = String(bin ?? '').trim(), i = String(svgPath ?? '').trim(), o = String(outPath ?? '').trim()
  if (!b || !i || !o) return null
  return [b, i, o]
}

/** 中文字体空白帧自检：渲染「有字」与「无字」两份，PNG 字节数应明显不同。
 *  deps.renderProbe(text) => Promise<Buffer|Uint8Array> —— 已注入 resvg 渲染。
 *  缺字时 resvg 不报错但文字消失 ⇒ 两份 PNG 几乎一样大 ⇒ 判为不安全。 */
export async function checkFontSafety(deps = {}) {
  const render = deps.renderProbe
  if (typeof render !== 'function') return { safe: null, detail: '未注入字体探针，跳过自检。' }
  try {
    const withText = await render('字'), without = await render('')
    const a = withText && withText.length ? withText.length : 0
    const b = without && without.length ? without.length : 0
    // 有字图应明显更大（>= 1.5 倍或至少多 200 B）；否则视为文字未渲染
    const safe = a > 0 && b > 0 && a >= b + 200 && a >= b * 1.5
    return { safe, withBytes: a, withoutBytes: b,
      detail: safe ? '中文字体探针通过：有字/无字输出差异明显。' : '字体自检未通过（疑似缺字/空白帧），建议降级 Edge 或配置字体。' }
  } catch {
    return { safe: false, detail: '字体探针执行失败，保守降级。' }
  }
}

/** 生产探针工厂：用宿主注入的 runCommand 真跑探测，产出可直接注入 animDeps 的三个执行器。
 *  只探测、不改任何全局状态；失败一律 false/降级，绝不谎称硬件或 resvg 已启用。
 *  deps.runCommand(cmd, opts) => Promise<{ok}>（ffmpeg 执行器）
 *  deps.exec(bin, args, opts)  => Promise  （通用执行器，给 resvg --version；缺省则用 runCommand）
 */
export function createRenderProbes(deps = {}) {
  const run = typeof deps.runCommand === 'function' ? deps.runCommand : null
  // exec 必须是「直接执行 bin」的通用执行器；未注入就不探测 resvg（不拿 ffmpeg 执行器冒充，
  // 否则 mediaExec 会把 argv[0] 换成 ffmpeg，导致 resvg --version 误判成功）。
  const exec = typeof deps.exec === 'function' ? deps.exec : null
  const log = (lvl, m) => { try { deps.log?.(lvl, m) } catch { /* 忽略 */ } }

  const probeEncoder = async (enc) => {
    if (!run) return false
    // 必须写真实 mp4 + 真实 PNG 输入 + ≥320×180：AMF 在 -f null / lavfi 直连 / 小尺寸下
    // 均会 Init() failed（假阴性），三条都实测踩过。临时文件落 outputDir，跑完即删。
    const dir = String(deps.outputDir ?? '').trim()
    if (!dir || !deps.path || !deps.fs) return false
    const tag = String(enc).replace(/[^a-z0-9]/giu, '')
    const png = deps.path.join(dir, '.enc-probe-' + tag + '.png')
    const tmp = deps.path.join(dir, '.enc-probe-' + tag + '.mp4')
    // 两步：① lavfi 造真 PNG；② 用它测编码器写 mp4（尺寸 320×180 为 AMF 实测下限）。
    const mk = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=0.04', '-frames:v', '1', '-y', png]
    const cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', png, '-frames:v', '1', '-c:v', String(enc), '-y', tmp]
    let ok = false
    try {
      if ((await run(mk, { timeoutMs: 10000 }))?.ok === true) ok = (await run(cmd, { timeoutMs: 15000 }))?.ok === true
    } catch { ok = false }
    for (const f of [png, tmp]) { try { deps.fs.unlinkSync(f) } catch { /* 删不掉不致命 */ } }
    return ok
  }

  const probeResvg = async (bin) => {
    if (!exec) return false
    try { await exec(String(bin), ['--version'], { timeoutMs: 8000 }); return true }
    catch { return false }
  }

  // rasterBackend：调用方（宿主）已探测过 resvg 才注入；这里只做「可选通道」，
  // 真正 SVG→PNG 由宿主 runCommand 调 resvg，失败反馈降级，不阻塞 SVG 返回。
  const rasterBackend = async (svg, ctx = {}) => {
    if (typeof svg !== 'string' || !svg.trim()) return { ok: false, backend: '', reason: '无 SVG 内容可光栅' }
    const ras = await probeRaster({ probeResvg, resvgPath: deps.resvgPath, builtin })
    if (ras.backend !== 'resvg') return { ok: false, backend: '', reason: ras.detail }
    const usePath = ras.execPath || ras.bin
    const p = deps.path
    // 目标 PNG 路径：有 svgPath 就同名替换，否则仅在注入 outputDir 时给一个确定名。
    let pngPath = ''
    if (ctx.svgPath && p && ctx.outputDir) {
      pngPath = String(ctx.svgPath).replace(/\.svg$/iu, '.png')
      const root = p.resolve(String(ctx.outputDir)), full = p.resolve(pngPath)
      if (full !== root && !full.startsWith(root + p.sep)) return { ok: false, reason: '光栅输出越出出图目录' }
    }
    // ★ 优先 stdin 模式：SVG 内容进 stdin、PNG 从 stdout 拿 —— 绕开 Windows 路径/编码/沙箱
    //   文件访问限制（实测 resvg 在受限环境读不到工作区 SVG，但 stdin 可渲染）。
    if (typeof deps.execStdin === 'function') {
      try {
        const r = await deps.execStdin(usePath, svg, { timeoutMs: 30000 })
        if (!r || r.ok !== true || !r.stdout || r.stdout.length < 128) {
          return { ok: false, backend: 'resvg', reason: 'resvg stdin 渲染失败或产物异常小（疑似缺字），保留 SVG' }
        }
        // 有落盘路径就写；能否落盘只取决于 fs，不该因为「没探测到 ffmpeg」就不写 PNG。
        let written = ''
        if (pngPath && deps.fs && typeof deps.fs.writeFileSync === 'function') {
          deps.fs.writeFileSync(pngPath, r.stdout); written = pngPath
        }
        return { ok: true, backend: 'resvg', path: written, png: written ? undefined : r.stdout,
          source: ras.source, reason: ras.detail + (written ? '（stdin 渲染并落盘）' : '（stdin 渲染，未落盘）') }
      } catch { return { ok: false, backend: 'resvg', reason: 'resvg stdin 执行异常，保留 SVG' } }
    }
    // 文件模式兜底：仅注入 runCommand 且有 svgPath 时可用（旧链路，测试兼容）。
    if (!run || !ctx.svgPath || !ctx.outputDir || !p || !pngPath) {
      return { ok: false, backend: '', reason: '未注入 resvg stdin/文件执行器或路径，保留 SVG' }
    }
    const argv = resvgCommand({ bin: usePath, svgPath: ctx.svgPath, outPath: pngPath })
    try {
      const r = await run(argv, { timeoutMs: 30000 })
      if (!r || r.ok !== true) return { ok: false, backend: 'resvg', reason: 'resvg 渲染失败，保留 SVG' }
      try {
        const size = deps.fs.statSync(pngPath).size
        if (size < 128) { log('warn', 'resvg 产物异常小（疑似缺字/空白帧）：' + size + ' B'); return { ok: false, backend: 'resvg', reason: '产物异常小，疑似缺字，保留 SVG' } }
      } catch { /* 没Stat到就信任执行结果 */ }
      return { ok: true, backend: 'resvg', path: pngPath, source: ras.source, reason: ras.detail }
    } catch { return { ok: false, backend: 'resvg', reason: 'resvg 执行异常，保留 SVG' } }
  }

  // 内置 exe 路径：相对本模块解析，存在性由 host 注入的 exists 校验（不硬编码绝对路径）。
  const builtin = builtinResvgPath({ metaUrl: deps.metaUrl, toPath: deps.toPath, exists: deps.exists })
  // probeRaster 的探测执行器要能识别内置：注入 builtin 候选，且 --version 走通用 exec。
  const probeRasterBuiltin = () => probeRaster({ probeResvg, resvgPath: deps.resvgPath, builtin })

  return { probeEncoder, probeResvg, rasterBackend, builtin, probeRaster: probeRasterBuiltin }
}

export const RENDER_BACKENDS_EXPORTS = Object.freeze({
  ENCODE_PRIORITY, ENCODER_LABELS, probeEncoders, probeRaster, resvgCommand, checkFontSafety, createRenderProbes, builtinResvgPath,
})
