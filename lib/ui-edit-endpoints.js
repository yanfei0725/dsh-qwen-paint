/**
 * lib/ui-edit-endpoints.js —— 「图片编辑台」的本机 HTTP 端点。
 *
 * ## 为什么存在
 *   插件早就有 inpaint_image / remove_image / outpaint_image / upscale_image 四个工具，
 *   也有完整的圈选蒙版浮层，但**只有局部重绘**接到了 UI 端点；其余三个只能靠用户在
 *   对话里让 AI 调工具 —— 用户根本不知道有这些功能，更不知道参数怎么填。
 *   本模块把「移除 / 扩图 / 放大」也接成 UI 可直接调用的端点，并给出「最近生成的图」
 *   列表，让「选中一张图」这一步不依赖猜路径。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 已逼近 DSH Store 的 256 KB 单文件上限（selftest.mjs 有硬断言），
 *   新端点一律外置，host 只负责注入依赖与注册。
 *
 * ## 安全边界（与既有 /api/qwen-paint/inpaint 完全一致，不引入更宽松的口径）
 *   · 顶层 isLocalRequest 可信围栏在任何动作之前；POST only + guardWriteRequest；
 *   · body 走有界 readJsonBody；
 *   · 蒙版只接受 data:image/png;base64, 且 ≤ 24 MB，防「任意文件写入」；
 *   · 一次性蒙版用完即删（finally），不在出图目录堆垃圾；
 *   · 工具未注册返回 503；百分比 / 倍数一律 clamp，不接受任意数值；
 *   · 只调本机工具 execute()，不自行下载任何东西、不发起外部请求。
 */
import fsp from 'node:fs/promises'
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

  /** GET：最近生成的图片清单，供「选中一张图」用。拿不到就返回空数组，不报错弹窗。 */
  const recentImagesHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'GET') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return }
    try {
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
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) })
    }
  }

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
  const quickEditHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
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
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  return { recentImagesHandler, quickEditHandler }
}
