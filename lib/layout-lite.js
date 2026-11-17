/**
 * lib/layout-lite.js —— flex 子集声明式布局 → SVG（纯 JS，零依赖、零外部引擎）。
 *
 * ## 定位（诚实边界）
 *   这不是 Taffy / 浏览器级布局引擎：只做**单层 row/column + 固定 gap + 文本按估算宽度换行**，
 *   覆盖标题页 / 要点页 / 图文分栏 / 对比页四类教学分镜；不解析 CSS、不做 flex-wrap、
 *   不做百分比与响应式。文本宽度是**字符宽度估算**（CJK 记 1em，其余记 0.55em），
 *   不是真实字体度量 ⇒ 只保证「不溢出、不重叠」，不做像素级排版验收。
 *
 * ## 为什么估算而不是读字体
 *   量真字体要解析 TTF（数 MB）且跨平台度量不一致；产物交给 resvg/Edge 光栅化，
 *   估宽留 8% 余量（调用方可调 padding）就够。要精确像素排版请走 draw_image。
 *
 * ## 数据流
 *   spec(声明式 JSON) → layoutPage → boxes(矩形/文本行) → svg → 交 resvg 光栅 → ffmpeg 合成。
 */
import path from 'node:path'

export const LAYOUT_KINDS = Object.freeze(['title', 'bullets', 'split', 'compare'])

const THEME = Object.freeze({
  bg: '#ffffff', title: '#12324f', body: '#333333', muted: '#8a8a8a',
  accent: '#4f8ef7', panel: '#eef4ff', border: '#c9d6e8',
})
const CJK = /[\u2e80-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u
const px = (n) => Math.round(n * 10) / 10
const clampInt = (v, lo, hi, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

/** 单字符宽度（em）：CJK/全角 1，其余 0.55。估算值，非字体度量。 */
export function charWidthEm(ch) { return CJK.test(ch) ? 1 : 0.55 }

export function measureTextEm(text) {
  let n = 0
  for (const ch of String(text ?? '')) { if (ch !== '\n') n += charWidthEm(ch) }
  return n
}

/** 按可用宽度换行：逐字符累加估算宽度，超宽断行；显式 \n 强制断行。 */
export function wrapText(text, maxWidth, fontSize) {
  const limit = Math.max(1, Number(maxWidth) || 1), fs = Math.max(1, Number(fontSize) || 1)
  const out = []
  let cur = '', w = 0
  for (const ch of String(text ?? '')) {
    if (ch === '\n') { out.push(cur); cur = ''; w = 0; continue }
    const cw = charWidthEm(ch) * fs
    if (w + cw > limit && cur !== '') { out.push(cur); cur = ch; w = cw } else { cur += ch; w += cw }
  }
  out.push(cur)
  return out
}

const LINE_H = 1.34

function pushText(boxes, { x, y, lines, size, fill, anchor = 'start', weight = '' }) {
  boxes.push({ kind: 'text', x: px(x), y: px(y), lines, size: px(size), fill, anchor, weight })
  return lines.length * size * LINE_H
}

/** 四类版式之一 → 绝对坐标 boxes。宽度不足/内容过高时自动缩字号，仍超则给 warning（不裁剪、不丢字）。 */
export function layoutPage(spec = {}) {
  const kind = String(spec.kind ?? 'title').trim().toLowerCase()
  if (!LAYOUT_KINDS.includes(kind)) return { ok: false, kind, boxes: [], warnings: [], svg: '', reason: '不支持的版式 ' + kind + '（支持 ' + LAYOUT_KINDS.join('/') + '）' }
  const W = clampInt(spec.width, 320, 1920, 960)
  const H = clampInt(spec.height, 180, 1080, 540)
  const theme = { ...THEME, ...(spec.theme && typeof spec.theme === 'object' ? spec.theme : {}) }
  const pad = clampInt(spec.padding, 6, Math.round(Math.min(W, H) / 3), Math.round(Math.min(W, H) * 0.085))
  const innerW = W - pad * 2
  const warnings = [], boxes = []
  const title = String(spec.title ?? spec.text ?? '').trim()

  if (kind === 'title') {
    const tf = Math.max(18, Math.round(H * 0.095)), sf = Math.max(12, Math.round(H * 0.042))
    const tLines = wrapText(title === '' ? '未命名' : title, innerW, tf)
    const sLines = spec.subtitle ? wrapText(spec.subtitle, innerW, sf) : []
    const gap = Math.round(H * 0.05)
    const h1 = tLines.length * tf * LINE_H, h2 = sLines.length * sf * LINE_H
    const total = h1 + (sLines.length ? gap + h2 : 0)
    let y = Math.max(pad, Math.round((H - total) / 2))
    boxes.push({ kind: 'rect', x: px(pad), y: px(Math.max(6, y - Math.round(H * 0.045))), w: Math.round(W * 0.06), h: 6, fill: theme.accent, rx: 3 })
    y += pushText(boxes, { x: W / 2, y, lines: tLines, size: tf, fill: theme.title, anchor: 'middle', weight: 'bold' }) + (sLines.length ? gap : 0)
    if (sLines.length) pushText(boxes, { x: W / 2, y, lines: sLines, size: sf, fill: theme.muted, anchor: 'middle' })
  } else if (kind === 'bullets') {
    const tf = Math.max(16, Math.round(H * 0.066)), base = Math.max(12, Math.round(H * 0.041))
    const tLines = wrapText(title === '' ? '要点' : title, innerW, tf)
    let y = pad + pushText(boxes, { x: pad, y: pad, lines: tLines, size: tf, fill: theme.title, weight: 'bold' })
    y += Math.round(H * 0.025)
    boxes.push({ kind: 'rect', x: px(pad), y: px(y), w: innerW, h: 2, fill: theme.border })
    const top = y + Math.round(H * 0.045), avail = H - pad - top
    const items = (Array.isArray(spec.items) ? spec.items : []).map((s) => String(s ?? '').trim()).filter(Boolean)
    if (items.length === 0) warnings.push('items 为空：只输出标题')
    let size = base, laid = null
    for (const scale of [1, 0.92, 0.85, 0.78, 0.72]) {
      size = Math.max(11, Math.round(base * scale))
      const gap = Math.round(size * 0.55)
      const blocks = items.map((it) => wrapText(it, innerW - size * 1.3, size))
      const need = blocks.reduce((n, ls) => n + ls.length * size * LINE_H, 0) + gap * Math.max(0, items.length - 1)
      laid = { gap, blocks, need, size }
      if (need <= avail) break
    }
    if (laid.need > avail) warnings.push('内容超出可用高度：已用最小字号，可能溢出底部')
    let cy = top
    laid.blocks.forEach((lines, i) => {
      boxes.push({ kind: 'circle', x: px(pad + laid.size * 0.32), y: px(cy + laid.size * 0.46), r: px(laid.size * 0.18), fill: theme.accent })
      cy += pushText(boxes, { x: pad + laid.size * 1.3, y: cy, lines, size: laid.size, fill: theme.body }) + (i < laid.blocks.length - 1 ? laid.gap : 0)
    })
  } else if (kind === 'split') {
    const tf = Math.max(16, Math.round(H * 0.062)), base = Math.max(12, Math.round(H * 0.036))
    const ratio = Math.min(0.7, Math.max(0.35, Number(spec.ratio) || 0.55))
    const colGap = Math.round(W * 0.035)
    const availW = innerW - colGap, leftW = Math.round(availW * ratio), rightW = availW - leftW
    let y = pad
    if (title !== '') {
      y += pushText(boxes, { x: pad, y, lines: wrapText(title, innerW, tf), size: tf, fill: theme.title, weight: 'bold' })
      y += Math.round(H * 0.035)
    }
    const avail = H - pad - y
    const body = String(spec.body ?? spec.text ?? '').trim()
    const blocks = body === '' ? [] : wrapText(body, leftW, base)
    const need = blocks.length * base * LINE_H
    const size = need > avail ? Math.max(11, Math.round(base * (avail / need) * 0.98)) : base
    const lines = body === '' ? [] : wrapText(body, leftW, size)
    if (lines.length * size * LINE_H > avail) warnings.push('左栏文本超出可用高度，可能溢出')
    pushText(boxes, { x: pad, y, lines, size, fill: theme.body })
    const rx = pad + leftW + colGap
    boxes.push({ kind: 'rect', x: px(rx), y: px(y), w: rightW, h: Math.max(40, avail), fill: theme.panel, stroke: theme.border, rx: 10 })
    const label = String(spec.image ?? '图片位').trim() || '图片位'
    const lf = Math.max(11, Math.round(H * 0.032))
    boxes.push({ kind: 'text', x: px(rx + rightW / 2), y: px(y + Math.max(40, avail) / 2 - lf * 0.6), lines: [label], size: lf, fill: theme.muted, anchor: 'middle' })
  } else {
    const tf = Math.max(16, Math.round(H * 0.058)), hf = Math.max(13, Math.round(H * 0.038)), base = Math.max(11, Math.round(H * 0.033))
    let y = pad
    y += pushText(boxes, { x: pad, y, lines: wrapText(title === '' ? '对比' : title, innerW, tf), size: tf, fill: theme.title, weight: 'bold' })
    y += Math.round(H * 0.04)
    const cols = (Array.isArray(spec.columns) ? spec.columns : []).slice(0, 2)
    if (cols.length < 2) warnings.push('columns 少于两栏：只按给定栏排布')
    const colGap = Math.round(W * 0.03)
    const cw = cols.length === 2 ? Math.floor((innerW - colGap) / 2) : innerW
    const avail = H - pad - y
    cols.forEach((col, ci) => {
      const x = pad + ci * (cw + colGap)
      boxes.push({ kind: 'rect', x: px(x), y: px(y), w: cw, h: Math.max(40, avail), fill: ci === 0 ? theme.panel : theme.bg, stroke: theme.border, rx: 10 })
      const head = String(col?.header ?? (ci === 0 ? 'A' : 'B')).trim()
      let cy = y + Math.round(H * 0.03) + pushText(boxes, { x: x + cw * 0.06, y: y + Math.round(H * 0.03), lines: wrapText(head, cw * 0.88, hf), size: hf, fill: ci === 0 ? theme.accent : theme.title, weight: 'bold' })
      const list = (Array.isArray(col?.items) ? col.items : []).map((s) => String(s ?? '').trim()).filter(Boolean)
      let size = base, laid = null
      for (const scale of [1, 0.92, 0.84, 0.76, 0.7]) {
        size = Math.max(10, Math.round(base * scale))
        const bl = list.map((it) => wrapText(it, cw * 0.82, size))
        const need = bl.reduce((n, ls) => n + ls.length * size * LINE_H, 0) + Math.round(size * 0.5) * Math.max(0, list.length - 1)
        laid = { bl, need, size }
        if (need <= avail - (cy - y) - Math.round(H * 0.03)) break
      }
      laid.bl.forEach((ls, i) => {
        cy += pushText(boxes, { x: x + cw * 0.09, y: cy, lines: ls, size: laid.size, fill: theme.body }) + (i < laid.bl.length - 1 ? Math.round(laid.size * 0.5) : 0)
      })
    })
  }
  return { ok: true, kind, width: W, height: H, boxes, warnings, svg: renderLayoutSvg(boxes, W, H, theme), reason: '' }
}

export function renderLayoutSvg(boxes, width, height, theme = THEME) {
  const body = (Array.isArray(boxes) ? boxes : []).map((b) => {
    if (b.kind === 'rect') {
      return '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="' + (b.rx ?? 0)
        + '" fill="' + b.fill + '"' + (b.stroke ? ' stroke="' + b.stroke + '"' : '') + '/>'
    }
    if (b.kind === 'circle') return '<circle cx="' + b.x + '" cy="' + b.y + '" r="' + b.r + '" fill="' + b.fill + '"/>'
    const lh = b.size * LINE_H
    return b.lines.map((ln, i) => '<text x="' + b.x + '" y="' + px(b.y + b.size + i * lh) + '" font-size="' + b.size
      + '" fill="' + b.fill + '"' + (b.anchor === 'middle' ? ' text-anchor="middle"' : '')
      + (b.weight ? ' font-weight="' + b.weight + '"' : '') + '>' + esc(ln) + '</text>').join('')
  }).join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">'
    + '<rect width="100%" height="100%" fill="' + theme.bg + '"/>' + body + '</svg>'
}

const shapeLayout = (p) => ({ ok: p.ok === true, kind: String(p.kind ?? ''), width: p.width ?? 0, height: p.height ?? 0,
  svg: String(p.svg ?? ''), path: String(p.path ?? ''), raster: String(p.raster ?? ''), boxes: p.boxes ?? 0,
  warnings: Array.isArray(p.warnings) ? p.warnings.map(String) : [], reason: String(p.reason ?? '') })

function resolveLayoutOutput({ target, outputDir } = {}) {
  const t = String(target ?? '').trim()
  if (t === '') return { ok: true, path: '' }
  if (!outputDir) return { ok: false, reason: '未注入输出目录，不能落盘（svg 字段已给完整内容）' }
  if (t.includes('..') || /^[a-zA-Z]:/u.test(t) || /^[\\/]/u.test(t)) return { ok: false, reason: 'target 必须是输出目录内的相对文件名' }
  const root = path.resolve(String(outputDir)), full = path.resolve(root, t)
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, reason: 'target 越出输出目录' }
  return { ok: true, path: full }
}

/** 声明式版式页工具：算坐标 → SVG →（可选）落盘 →（宿主有光栅后端时）出 PNG。 */
export function makeLayoutFrameTool(deps = {}) {
  return {
    name: 'layout_frame',
    description: '声明式版式页 → SVG：title(标题页)/bullets(要点)/split(图文分栏)/compare(对比)。'
      + '纯 JS flex 子集算绝对坐标（不做 CSS 解析、不解析字体度量，文本按字符宽度估算换行）。'
      + '给了 target 才落盘；宿主注入光栅后端（内置 resvg）时顺带出 PNG 供合成。零依赖不联网。',
    timeoutMs: 20000,
    parameters: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: [...LAYOUT_KINDS], description: '版式：title/bullets/split/compare' },
      title: { type: 'string', description: '页标题' },
      subtitle: { type: 'string', description: '副标题（仅 title 版式）' },
      items: { type: 'array', items: { type: 'string' }, description: '要点列表（bullets）' },
      body: { type: 'string', description: '正文（split 左栏）' },
      image: { type: 'string', description: 'split 右栏占位标签（不嵌入真实图片，仅位置占位）' },
      columns: { type: 'array', items: { type: 'object', description: '{header,items[]}' }, description: '对比两栏（compare）' },
      ratio: { type: 'number', description: 'split 左栏宽度占比 0.35-0.7，默认 0.55' },
      width: { type: 'integer', description: '宽 320-1920，默认 960' },
      height: { type: 'integer', description: '高 180-1080，默认 540' },
      padding: { type: 'integer', description: '内边距，默认按短边 8.5%' },
      target: { type: 'string', description: '输出 SVG 文件名（相对输出目录），给了才落盘' },
    }, required: ['kind'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean' }, kind: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' },
      svg: { type: 'string' }, path: { type: 'string' }, raster: { type: 'string' },
      boxes: { type: 'integer' }, warnings: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
    } } },
    async execute(args = {}) {
      try {
        const laid = layoutPage(args)
        if (!laid.ok) return shapeLayout({ ...laid, reason: laid.reason })
        const out = resolveLayoutOutput({ target: args.target, outputDir: deps.outputDir })
        if (!out.ok) return shapeLayout({ ...laid, ok: false, reason: out.reason })
        let outPath = ''
        if (out.path) {
          if (typeof deps.writeFile !== 'function') return shapeLayout({ ...laid, ok: false, reason: '未注入 writeFile，未落盘（svg 字段已给完整内容）' })
          await deps.writeFile(out.path, laid.svg)
          outPath = out.path
        }
        let raster = ''
        if (outPath && typeof deps.rasterBackend === 'function') {
          try {
            const r = await deps.rasterBackend(laid.svg, { width: laid.width, height: laid.height, svgPath: outPath, outputDir: deps.outputDir })
            if (r && r.ok === true) raster = String(r.backend ?? 'raster') + (r.path ? ':' + String(r.path) : '')
            else try { deps.log?.('warn', '版式页光栅未生效，保留 SVG：' + String(r?.reason ?? '')) } catch { /* 忽略 */ }
          } catch { try { deps.log?.('warn', '版式页光栅执行失败，保留 SVG') } catch { /* 忽略 */ } }
        }
        return shapeLayout({ ...laid, path: outPath, raster,
          reason: '已生成 ' + laid.kind + ' 版式（' + laid.boxes.length + ' 个图元）' + (outPath ? '，SVG 已落盘' : '，未落盘') })
      } catch (error) {
        try { deps.log?.('warn', '版式页生成失败：' + (error?.message ?? error)) } catch { /* 忽略 */ }
        return shapeLayout({ ok: false, reason: '版式页生成暂不可用（详见插件日志）' })
      }
    },
  }
}

export const LAYOUT_EXPORTS = Object.freeze({ LAYOUT_KINDS, charWidthEm, measureTextEm, wrapText, layoutPage, renderLayoutSvg, makeLayoutFrameTool })
