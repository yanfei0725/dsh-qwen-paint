/** lib/portrait-endpoints.js —— 「人物替换」编排：拖拽素材登记 + 身份保持节点发现 + Rust 本地合成。
 *
 *  ★ 诚实边界（写进心智，别写成换脸）：
 *    · 社区成熟方案（InstantID / PuLID / IP-Adapter FaceID / ReActor）都靠几 GB 模型 + GPU，
 *      本插件不捆绑、不下载模型（体积红线 + 模型除外规矩）。
 *    · 这里交付的是「身份保持重绘编排」：本机 /object_info 探到对应节点就报"可真跑"并给工作流线索；
 *      探不到就明确降级 + 安装引导，绝不假装换脸成功。
 *    · 本地 CPU 底座 = 内置 Rust 合成器（local-portrait.js / dshqp-portrait.exe），
 *      做"选定人物图 → 贴到底图框选位置"的贴图/预演，纯 CPU、无模型。
 *    · 最终像素质量取决于用户本机装了什么模型；本端点不承诺像素级精确换脸。
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { decodeThumbDataUrl } from './history-endpoints.js'
import {
  builtinPortraitPath, composePortrait, isInsideOutputDir, PORTRAIT_ENGINE,
} from './local-portrait.js'

/** 身份保持节点发现表：模式 + 说明 + 安装引导（只发现，绝不自动装）。 */
export const IDENTITY_NODES = Object.freeze([
  { id: 'instantid', label: 'InstantID', pattern: /instantid/i,
    guide: '装 ComfyUI-InstantID 节点包 + 下载 antelopev2 人脸模型放 models/insightface，重启 ComfyUI。' },
  { id: 'pulid', label: 'PuLID', pattern: /pulid/i,
    guide: '装 ComfyUI-PuLID 节点包 + 对应权重放 models/pulid，重启 ComfyUI。' },
  { id: 'ipadapter_faceid', label: 'IP-Adapter FaceID', pattern: /ip.?adapter.*face|face.?id.*ip.?adapter/i,
    guide: '装 ComfyUI-IPAdapter 节点包 + FaceID 权重放 models/ipadapter，重启 ComfyUI。' },
  { id: 'reactor', label: 'ReActor', pattern: /reactor/i,
    guide: '装 ComfyUI-ReActor 节点包 + InsightFace 模型，重启 ComfyUI。' },
])

/** 从 /object_info 节点名数组发现可用的身份保持能力（纯函数）。 */
export function discoverIdentityNodes(nodeNames = []) {
  const names = Array.isArray(nodeNames) ? nodeNames.map((n) => String(n)) : []
  const found = IDENTITY_NODES.map((n) => ({
    id: n.id, label: n.label,
    nodes: names.filter((x) => n.pattern.test(x)).slice(0, 8), guide: n.guide,
  })).filter((x) => x.nodes.length > 0)
  return {
    available: found.length > 0,
    backends: found,
    degraded: found.length === 0,
    reason: found.length === 0
      ? '本机未探到 InstantID / PuLID / IP-Adapter FaceID / ReActor 节点；只能做本地 CPU 贴图预演，不能身份保持重绘。'
      : '',
  }
}

export const PORTRAIT_ROUTE_PATHS = Object.freeze({
  capabilities: '/api/qwen-paint/portrait/capabilities',
  register: '/api/qwen-paint/portrait/register',
  compose: '/api/qwen-paint/portrait/compose',
})

const json = (res, body, status = 200) => {
  try { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { /* 忽略 */ }
}
const bodyOf = (req, limit = 24 * 1024 * 1024) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => { size += c.length; if (size > limit) { resolve(null); try { req.destroy() } catch { /* 忽略 */ } return } chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch { json(res, { ok: false, reason: '内部错误（详情见本机日志）' }, 500) }
}
const localGate = (base, req, res) => {
  const isLocal = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  if (isLocal && !isLocal(req)) { json(res, { ok: false, reason: 'local requests only' }, 403); return false }
  return true
}
const postOnly = (req, res) => {
  if (req.method !== 'POST') { json(res, { ok: false, reason: 'POST only' }, 405); return false }
  return true
}

/** 拖拽素材登记：data:image/{png,jpeg,webp};base64 → 出图目录落盘，返回相对路径供后续引用。 */
async function registerAsset(base, body) {
  const outputDir = String(base.outputDir ?? '').trim()
  if (!outputDir) return { ok: false, reason: '出图目录未配置' }
  const kind = String(body?.kind ?? '').trim()
  if (!['reference', 'person'].includes(kind)) return { ok: false, reason: 'kind 必须是 reference 或 person' }
  const decoded = decodeThumbDataUrl(body?.data_url, { label: kind === 'reference' ? '参考图' : '人物图' })
  if (decoded.error) return { ok: false, reason: decoded.error }
  const safe = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${decoded.ext}`
  const rel = `.dshqp-portrait/${safe}`
  const full = path.join(outputDir, '.dshqp-portrait', safe)
  if (!isInsideOutputDir(full, outputDir, base)) return { ok: false, reason: '落盘路径越界（安全围栏）' }
  try {
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, decoded.buf)
  } catch { return { ok: false, reason: '素材落盘失败（目录只读？）' } }
  return { ok: true, kind, path: full, rel, bytes: decoded.buf.length,
    note: '素材已落盘到出图目录；仅本机可访问。' }
}

export function portraitRouteTable(base = {}) {
  return [
    {
      path: PORTRAIT_ROUTE_PATHS.capabilities, method: 'GET',
      handler: wrap(async (req, res) => {
        if (!localGate(base, req, res)) return
        const builtin = builtinPortraitPath({
          metaUrl: base.metaUrl, toPath: base.toPath,
          exists: base.exists || existsSync,
        })
        let identity = { available: false, backends: [], degraded: true, reason: '节点表尚未探测' }
        if (typeof base.objectInfoProbe === 'function') {
          try {
            const info = await base.objectInfoProbe()
            if (info && info.ok) identity = discoverIdentityNodes(info.nodes || [])
            else identity = { available: false, backends: [], degraded: true,
              reason: '本机 /object_info 未就绪（ComfyUI 可能未启动）；身份保持重绘不可用，仅本地 CPU 贴图可跑。' }
          } catch { /* 保持默认 */ }
        }
        json(res, {
          ok: true,
          cpu_compositor: builtin ? { available: true, source: builtin.source, engine: PORTRAIT_ENGINE } : { available: false },
          identity,
          boundary: '本地合成 = 纯 CPU 贴图预演（把选定人物贴到底图框选处，可绿幕抠图/羽化），不是像素级换脸；'
            + '身份保持重绘要本机 ComfyUI 装对应模型节点，探到才可用，缺失只给安装引导。',
          guides: IDENTITY_NODES.map((n) => ({ id: n.id, label: n.label, guide: n.guide })),
        })
      }),
    },
    {
      path: PORTRAIT_ROUTE_PATHS.register, method: 'POST',
      handler: wrap(async (req, res) => {
        if (!localGate(base, req, res)) return
        if (!postOnly(req, res)) return
        if (typeof base.guardWriteRequest === 'function' && !base.guardWriteRequest(req, res)) return
        const body = await bodyOf(req)
        if (!body) { json(res, { ok: false, reason: '请求体不是合法 JSON' }, 400); return }
        json(res, await registerAsset(base, body))
      }),
    },
    {
      path: PORTRAIT_ROUTE_PATHS.compose, method: 'POST',
      handler: wrap(async (req, res) => {
        if (!localGate(base, req, res)) return
        if (!postOnly(req, res)) return
        if (typeof base.guardWriteRequest === 'function' && !base.guardWriteRequest(req, res)) return
        const body = await bodyOf(req)
        if (!body) { json(res, { ok: false, reason: '请求体不是合法 JSON' }, 400); return }
        const runArgv = base.execStdin || ((bin, stdinText) => (base.exec || (() => Promise.reject(new Error('no exec'))))(
          bin, [], stdinText))
        const result = await composePortrait({
          outputDir: base.outputDir, metaUrl: base.metaUrl, toPath: base.toPath,
          exists: base.exists, builtin: base.builtinPortrait, runArgv,
        }, body)
        json(res, result)
      }),
    },
  ]
}

export const PORTRAIT_EXPORTS = Object.freeze({
  IDENTITY_NODES, discoverIdentityNodes, PORTRAIT_ROUTE_PATHS, portraitRouteTable,
})
