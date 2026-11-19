// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-ui-edit-endpoints
// 端点样板已收敛到 lib/route-factory.js（优化接力节点②，2026-11-20）：本机门 / 方法门 /
// 写守卫 / body 解析 / catch 收口由工厂收口；两个历史 catch（回吐 error.message、
// recent-images 甚至回 200）一并修齐为固定文案 + 500。
import fsp from 'node:fs/promises'
import { makeRouteFactory } from './route-factory.js'
import { clipOutpaintPercent } from './task-specs.js'

const MAX_MASK_CHARS = 24 * 1024 * 1024
const PNG_PREFIX = 'data:image/png;base64,'

/** 工具执行结果统一成前端认得的形状。 */
function resultOf(value) {
  return {
    ok: true,
    path: typeof value?.path === 'string' ? value.path : '',
    files: Array.isArray(value?.files) ? value.files : [],
    seconds: Number.isFinite(value?.seconds) ? value.seconds : 0,
  }
}

/**
 * @param {object} deps
 * @param {(req: object) => boolean} deps.isLocalRequest
 * @param {(req: object, res: object) => boolean} deps.guardWriteRequest
 * @param {(res: object, body: object, status?: number) => void} deps.respondJson
 * @param {(req: object) => Promise<object>} deps.readJsonBody
 * @param {object} deps.cfg 插件配置（含 outputDir）
 * @param {() => string} deps.makeMaskPath 一次性蒙版路径（与 inpaint 端点同源）
 * @param {(name: string) => object|null} deps.getTool 按名字取已注册工具引用
 * @param {(limit: number) => Promise<object[]>} deps.readRecent 最近出图记忆
 * @param {(level: string, msg: string) => void} deps.log
 */
export function makeUiEditHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
    cfg, makeMaskPath, getTool, readRecent, log,
  } = deps
  const route = makeRouteFactory({ isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log })

  /** GET：最近生成的图片清单，供「选中一张图」用。拿不到就返回空数组，不报错弹窗。 */
  const recentImagesHandler = route({
    path: '/api/qwen-paint/recent-images', method: 'GET', onlyText: 'GET only',
    handler: async ({ res }) => {
      const rows = await readRecent(12)
      const seen = new Set()
      const items = []
      for (const row of Array.isArray(rows) ? rows : []) {
        const candidates = [
          row?.path,
          ...(Array.isArray(row?.files) ? row.files : []),
        ]
        for (const p of candidates) {
          if (typeof p !== 'string' || p.trim() === '' || seen.has(p)) continue
          seen.add(p)
          items.push({ path: p, name: String(p).split(/[\\/]/u).pop() || '图片' })
          if (items.length >= 12) break
        }
        if (items.length >= 12) break
      }
      respondJson(res, { ok: true, items, count: items.length })
    },
  }).handler

  /** 存一次性蒙版、调 remove 工具、用完即删。返回 null 表示调用方应直接回错。 */
  async function runWithMask(image, maskPng, toolName, argsOf) {
    if (!maskPng.startsWith(PNG_PREFIX)) {
      return { error: { reason: 'maskPng 必须是 data:image/png;base64,…', status: 400 } }
    }
    if (maskPng.length > MAX_MASK_CHARS) {
      return { error: { reason: '蒙版过大（超过 24 MB）', status: 413 } }
    }
    const tool = getTool(toolName)
    if (!tool) return { error: { reason: '对应工具尚未注册（插件还在加载？）', status: 503 } }
    const bytes = Buffer.from(maskPng.slice(PNG_PREFIX.length), 'base64')
    const maskPath = makeMaskPath()
    try {
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      await fsp.writeFile(maskPath, bytes)
      const value = await tool.execute(
        argsOf(maskPath),
        { signal: new AbortController().signal, callId: `ui-edit-${toolName}-${Date.now()}` },
      )
      return { value }
    } finally {
      // ComfyUI 用的是上传副本，删本地这份不影响结果；删不掉也无所谓。
      try { await fsp.unlink(maskPath) } catch { /* 本来就没写成功 */ }
    }
  }

  /** POST：按 action 分发到 remove / outpaint / upscale 三个工具。 */
  const quickEditHandler = route({
    path: '/api/qwen-paint/quick-edit', method: 'POST', guard: true, parse: true,
    handler: async ({ res, body }) => {
      const action = String(body.action ?? '').trim()
      const image = String(body.image ?? '').trim()
      if (image === '') { respondJson(res, { ok: false, reason: 'image 必填（先选一张图）' }, 400); return }

      let result
      if (action === 'remove') {
        const r = await runWithMask(image, String(body.maskPng ?? ''), 'remove_image',
          (mask) => ({ image, mask, prompt: String(body.prompt ?? '').trim() || undefined }))
        if (r.error) { respondJson(res, { ok: false, reason: r.error.reason }, r.error.status); return }
        result = r.value
      } else if (action === 'outpaint') {
        const tool = getTool('outpaint_image')
        if (!tool) { respondJson(res, { ok: false, reason: '四向扩图工具尚未注册' }, 503); return }
        const dirs = {
          left: clipOutpaintPercent(body.left),
          right: clipOutpaintPercent(body.right, 50),
          up: clipOutpaintPercent(body.up),
          down: clipOutpaintPercent(body.down),
        }
        if (dirs.left + dirs.right + dirs.up + dirs.down === 0) {
          respondJson(res, { ok: false, reason: '至少选一个方向扩展' }, 400); return
        }
        result = await tool.execute(
          { image, ...dirs },
          { signal: new AbortController().signal, callId: `ui-edit-outpaint-${Date.now()}` },
        )
      } else if (action === 'upscale') {
        const tool = getTool('upscale_image')
        if (!tool) { respondJson(res, { ok: false, reason: '高清放大工具尚未注册' }, 503); return }
        const scale = Math.max(2, Math.min(16, Math.trunc(Number(body.scale) || 4)))
        result = await tool.execute(
          { image, scale },
          { signal: new AbortController().signal, callId: `ui-edit-upscale-${Date.now()}` },
        )
      } else {
        respondJson(res, { ok: false, reason: `不认识的 action：${action || '(空)'}` }, 400)
        return
      }
      log?.('info', `[图片编辑台] ${action} 完成：${result?.path ?? '(无路径)'}`)
      respondJson(res, resultOf(result))
    },
  }).handler

  return { recentImagesHandler, quickEditHandler }
}
