/**
 * lib/pptx-lite.js —— 轻量档 PPTX 生成（纯 JS / 零依赖 / 零 GPU，0.35.0 之后批次）。
 *
 * ## 定位（对应 6GB 三档方案的「轻量档」）
 *   快速结构化草稿：标题 + 要点列表的大纲级 PPTX。不追求排版美化、不放图片、
 *   不做母版定制 —— 那是标准档/质量档（外部运行时）的职责。
 *
 * ## 实现口径
 *   · 纯 JS 手写最小 OOXML（presentation / slideMaster / slideLayout / slides / theme）
 *     + store-only ZIP（method 0，自算 CRC32）—— 零 npm 依赖，DSH bundle 直接可用。
 *   · 未安装任何外部引擎 ⇒ 永远可执行、无 degraded 态（轻量档的卖点）。
 *   · 诚实边界：PowerPoint / WPS 兼容性**未实测**（测试只验 ZIP 结构与 XML 转义）；
 *     纯文本大纲级，复杂排版请用标准/质量档或外部工具。
 *   · 输出围栏：目标 .pptx 必须落在出图目录内（沿用 manual-upscale 口径）。
 */
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { resolveUpscaleOutputPath } from './manual-upscale.js'

/* ------------------------------ CRC32 + ZIP（store） ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

const u16 = (v) => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF])
const u32 = (v) => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF])
const DOS_TIME = u16((0 << 11) | (0 << 5) | 0)
const DOS_DATE = u16(((2026 - 1980) << 9) | (1 << 5) | 1)

/** store-only ZIP（不压缩；PowerPoint 接受 stored 条目）。entries: [{name, data:Buffer}] */
export function buildZip(entries = []) {
  const local = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    local.push(u32(0x04034b50), u16(20), u16(0), u16(0), DOS_TIME, DOS_DATE,
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data)
    central.push(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), DOS_TIME, DOS_DATE,
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name)
    offset += 30 + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...local, centralBuf, eocd])
}

/* ------------------------------ XML 模板 ------------------------------ */

const xmlEscape = (s) => String(s ?? '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const IMAGE_EXT_MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' })

const CONTENT_TYPES = (slideCount, imageExts = []) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...new Set(imageExts)].map((e) => `<Default Extension="${e}" ContentType="${IMAGE_EXT_MIME[e] || 'application/octet-stream'}"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`

const PRESENTATION = (slideCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

const PRESENTATION_RELS = (slideCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:bg/><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1600"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`

const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

const LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="QP Lite"><a:themeElements><a:clrScheme name="QP"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="7C3AED"/></a:accent2><a:accent3><a:srgbClr val="059669"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="QP"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="QP"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const SP_TEXT = (id, name, x, y, cx, cy, size, bold, paragraphs) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.map((p) => `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${xmlEscape(p)}</a:t></a:r></a:p>`).join('') || '<a:p/>'}</p:txBody></p:sp>`

/** 图片字节魔数探测扩展名（白名单），拒绝伪装类型。 */
export function imageExtOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buf.toString('ascii', 0, 2) === 'BM') return 'bmp'
  return ''
}

/** 图片来源 → Buffer：data:image/...;base64 / 裸 base64 / Buffer。拒空、拒非法 base64。 */
export function imageBytesOf(src) {
  if (Buffer.isBuffer(src)) return src.length ? src : null
  const s = String(src ?? '').trim()
  if (!s) return null
  const m = /^data:image\/[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(s)
  const b64 = (m ? m[1] : (/^[A-Za-z0-9+/=\s]+$/.test(s) ? s : '')).replace(/\s+/g, '')
  if (!b64 || b64.length > 32 * 1024 * 1024) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.length ? buf : null
  } catch { return null }
}

// slide 画布：12192000 × 6858000 EMU（16:9）。图片位置/尺寸为 0..1 归一化。
const CANVAS_W = 12192000
const CANVAS_H = 6858000
const SP_PIC = (id, name, rid, x, y, w, h) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

const SLIDE_RELS_WITH_IMAGES = (images) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${images.map((im, k) => `<Relationship Id="rId${k + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${im.mediaName}"/>`).join('')}</Relationships>`

const SLIDE = (slide, images = []) => {
  const title = SP_TEXT(2, 'Title', 838200, 365125, 10515600, 1325563, 3200, true, [slide.title ?? ''])
  const bullets = Array.isArray(slide.bullets) ? slide.bullets.filter((b) => String(b ?? '').trim() !== '') : []
  const body = bullets.length > 0
    ? SP_TEXT(3, 'Bullets', 838200, 1825625, 10515600, 4114800, 1800, false, bullets.map((b) => '• ' + String(b)))
    : ''
  // 图片默认占右下 40%×46%，可由每张图的 x/y/w/h（0..1）覆盖——agent 在 slides JSON 里决定。
  const pics = images.map((im, k) => {
    const cx = Math.round(CANVAS_W * (Number.isFinite(im.w) ? Math.min(1, Math.max(0.02, im.w)) : 0.4))
    const cy = Math.round(CANVAS_H * (Number.isFinite(im.h) ? Math.min(1, Math.max(0.02, im.h)) : 0.46))
    const ox = Math.round(CANVAS_W * (Number.isFinite(im.x) ? Math.min(1, Math.max(0, im.x)) : 0.58))
    const oy = Math.round(CANVAS_H * (Number.isFinite(im.y) ? Math.min(1, Math.max(0, im.y)) : 0.5))
    return SP_PIC(10 + k, im.name || `图片${k + 1}`, `rId${k + 2}`, ox, oy, cx, cy)
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${title}${body}${pics}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

/* ------------------------------ 组装 ------------------------------ */

/**
 * 纯函数：deck → ZIP Buffer。
 * deck: { title: string, slides: [{ title: string, bullets: string[] }] }
 */
export function buildPptxDeck({ title = '', slides = [] } = {}) {
  const list = Array.isArray(slides) ? slides : []
  if (list.length === 0) return { ok: false, reason: '至少需要一个 slide（slides）', buffer: null }
  if (list.length > 50) return { ok: false, reason: '轻量档上限 50 页（更大篇幅请用标准/质量档）', buffer: null }
  // 先把每页图片解析成 {buf, ext, mediaName, name, x/y/w/h}；坏图整张跳过，不伪造。
  // mediaName 用全局递增编号（跨页唯一），避免同名覆盖；同一张图重复给就存两份（正确性优先）。
  let globalNo = 0
  const perSlide = list.map((sl) => {
    const rawImgs = Array.isArray(sl?.images) ? sl.images : []
    const imgs = []
    for (const raw of rawImgs) {
      const buf = imageBytesOf(raw?.data ?? raw?.data_url ?? raw?.bytes ?? raw)
      if (!buf) continue
      const ext = imageExtOf(buf)
      if (!ext) continue // 魔数不符白名单 → 跳过，不塞伪造媒体
      globalNo += 1
      imgs.push({ buf, ext, mediaName: `image${globalNo}.${ext}`,
        name: String(raw?.name ?? `图片${globalNo}`).slice(0, 80),
        x: raw?.x, y: raw?.y, w: raw?.w, h: raw?.h })
    }
    return imgs
  })
  const allImgs = perSlide.flat()
  const entries = [{ name: '[Content_Types].xml', data: CONTENT_TYPES(list.length, allImgs.map((i) => i.ext)) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'ppt/presentation.xml', data: PRESENTATION(list.length) },
    { name: 'ppt/_rels/presentation.xml.rels', data: PRESENTATION_RELS(list.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME }]
  for (const im of allImgs) entries.push({ name: `ppt/media/${im.mediaName}`, data: im.buf })
  for (let i = 0; i < list.length; i += 1) {
    const imgs = perSlide[i]
    const refs = imgs.map((im, k) => ({ ...im, rid: `rId${k + 2}` }))
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: SLIDE(list[i] ?? {}, refs) })
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: imgs.length ? SLIDE_RELS_WITH_IMAGES(refs) : LAYOUT_RELS })
  }
  return { ok: true, reason: '', buffer: buildZip(entries), slideCount: list.length,
    imageCount: allImgs.length, deckTitle: String(title ?? '').slice(0, 120) }
}

/* ------------------------------ 工具与端点 ------------------------------ */

const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const STR = { type: 'string' }
const ARR = { type: 'array', items: { type: 'object' } }
const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const json = (res, body, status = 200) => {
  try { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { /* 忽略 */ }
}
const bodyOf = (req) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  // ★ 2026-11-18：支持每页插图后，多张 base64 图片会超旧 2MB；放宽到 48MB（仍是有界）。
  req.on('data', (c) => { size += c.length; if (size > 48 * 1024 * 1024) { resolve(null); try { req.destroy() } catch { /* 忽略 */ } ; return } chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})
const postOnly = (req, res) => {
  if (req.method !== 'POST') { json(res, { ok: false, reason: 'POST only' }, 405); return false }
  return true
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch { json(res, { ok: false, reason: '内部错误（详情见本机日志）' }, 500) }
}

export function makePptxTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  return {
    name: 'make_pptx',
    description: '轻量档 PPTX 生成（纯 JS / 零依赖 / 零 GPU，永远可执行）：标题 + 要点列表 + '
      + '每页可选插图（slides[].images：data:image base64 / 裸 base64，含 name 与归一化 x/y/w/h 位置）'
      + ' 的大纲级 PPTX，直接落出图目录。Agent 自己决定每张图插在哪一页、放在哪；图片字节真写进 '
      + 'ppt/media 并挂 OOXML 关系，不是占位链接。Office/WPS 兼容性未实测（unverified），'
      + '复杂排版请用标准/质量档或外部工具。',
    parameters: schemaOf({
      title: STR,
      slides: ARR,
      target: STR,
    }),
    timeoutMs: 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, output_path: STR, degraded: BOOL,
      reason: STR, note: STR, slides: NUM, images: NUM, bytes: NUM,
    }) },
    async execute(args = {}) {
      const out = resolveUpscaleOutputPath({ target: args?.target, outputDir })
      if (!out.ok) return { ok: false, executed: false, output_path: '', degraded: true,
        reason: '输出：' + out.reason, note: '目标 .pptx 必须落在出图目录内。', slides: 0, images: 0, bytes: 0 }
      if (!/\.pptx$/iu.test(String(args?.target ?? '').trim())) {
        return { ok: false, executed: false, output_path: '', degraded: true,
          reason: '目标必须是 .pptx 文件', note: '未生成，绝不谎称已落盘。', slides: 0, images: 0, bytes: 0 }
      }
      const built = buildPptxDeck({ title: args?.title, slides: args?.slides })
      if (!built.ok) return { ok: false, executed: false, output_path: '', degraded: true,
        reason: built.reason, note: '未生成，绝不谎称已落盘。', slides: 0, images: 0, bytes: 0 }
      writeFileSync(out.path, built.buffer)
      return {
        ok: true, executed: true, output_path: out.path, degraded: false, reason: '',
        note: '轻量档 PPTX 已落盘（大纲级纯文本，兼容性 unverified）；排版美化请走标准/质量档。',
        slides: built.slideCount, images: built.imageCount || 0, bytes: built.buffer.length,
      }
    },
  }
}

export const PPTX_ROUTE_PATH = '/api/qwen-paint/pptx'

export function pptxRouteTable(base = {}) {
  const outputDir = String(base.outputDir ?? '').trim()
  // ★ 2026-11-16 审计 P0：POST 会写 outputDir，必须本机围栏。
  const isLocalRequest = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  return [
    {
      path: PPTX_ROUTE_PATH, method: 'POST',
      handler: wrap(async (req, res) => {
        if (isLocalRequest && !isLocalRequest(req)) { json(res, { ok: false, reason: 'local requests only' }, 403); return }
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const tool = makePptxTool({ outputDir })
        const r = await tool.execute(body ?? {})
        json(res, r)
      }),
    },
  ]
}
