/**
 * lib/history-endpoints.js —— 生成历史的本机只读 / 软删除端点。
 *
 * · GET  /api/qwen-paint/history         搜索 / 筛选 / 分页（keyword、kind、from、to、limit、offset）
 * · GET  /api/qwen-paint/history/stats   顶栏汇总（总数 / 各类型）
 * · POST /api/qwen-paint/history/delete 软删除一条（只改 deleted=1，绝不删磁盘文件）
 * · POST /api/qwen-paint/history/thumb  回写浏览器生成的缩略图（G36）
 *
 * 列表每条额外带 `alt` / `markdown` / `continue_hints` 三个派生字段
 * （见 `lib/history-export.js`）：前端零逻辑，外部集成也能直接取用。
 *
 * 安全边界：全部 isLocalRequest；写操作 POST only + guardWriteRequest；
 * 异常只写本机日志、回固定文案（不回吐 error.message）。
 *
 * 端点样板已收敛到 lib/route-factory.js（优化接力节点②，2026-11-19）：本机门 /
 * 方法门（只读路由收 GET+HEAD、文案钉回 'GET only'）/ 写守卫 / body 解析 / catch
 * 收口全部由工厂收口；redraw 依赖门与 outputDir 配置门走工厂的 before 钩子
 * （保持在 body 解析之前）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decorateHistoryItem } from './history-export.js'
import { makeRouteFactory } from './route-factory.js'

/** 缩略图存放目录：输出目录下的隐藏子目录，和出图产物分开，不会被当成结果。 */
export const THUMB_DIR_NAME = '.qwen-paint-thumbs'

/**
 * 单条缩略图的原始字节上限。320px 的 WebP（q=0.82）正常只有 15–40 KB。
 *
 * ★ 这个 128 KB **不是随便定的**：它受 `readJsonBody()` 默认 256 KB 的请求体上限约束，
 *   base64 会膨胀约 4/3，128 KB → 约 171 KB，刚好留出 JSON 外壳的余量。
 *   想调大这里，必须同时给 thumb 端点单独放宽读体上限，否则会变成「静默 400」。
 */
export const THUMB_MAX_BYTES = 128 * 1024

/**
 * D25 Canvas 草稿的上限与目录。
 * ★ 160 KB 同样受 `readJsonBody()` 默认 256 KB 的约束（base64 后约 213 KB）。
 *   一张 512×512 线稿 PNG 通常 20–60 KB，160 KB 足够；再大就请先存成文件再走路径。
 */
export const DRAFT_MAX_BYTES = 160 * 1024
export const DRAFT_DIR_NAME = 'qwen-paint-drafts'

/** 允许的 MIME。**故意不含 svg** —— SVG 能带脚本，回灌到 <img> 之外的地方就是 XSS 面。 */
const THUMB_MIME = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
}

/**
 * 解析 `data:image/webp;base64,xxxx`。
 *
 * 返回 `{ buf, ext }` 或 `{ error }`，**不做任何 IO**，方便单测直接打。
 * 三道闸：前缀白名单 → base64 长度预判 → 解码后真实字节数复核。
 */
export function decodeThumbDataUrl(dataUrl, { maxBytes = THUMB_MAX_BYTES, label = '缩略图' } = {}) {
  const s = String(dataUrl ?? '')
  if (s === '') return { error: 'data_url 必填' }
  // mime 用 `[^;,]+` 而不是 `[a-z]+`：`svg+xml` 里的 `+` 才不会被正则截断，
  // 这样 SVG 会掉进下面的白名单分支，报「不支持的图片类型 svg+xml」——
  // 比笼统的「格式不对」更容易让人明白为什么被拒。
  const m = /^data:image\/([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(s)
  if (!m) return { error: 'data_url 必须是 base64 编码的 webp / jpeg / png' }
  const ext = m[1].toLowerCase()
  if (!THUMB_MIME[ext]) return { error: `不支持的图片类型 ${ext}` }
  const b64 = m[2].replace(/\s+/g, '')
  // base64 膨胀约 4/3，先按长度预判能挡掉绝大多数超大包，免得多余解码。
  if (b64.length > Math.ceil(maxBytes * 4 / 3) + 16) {
    return { error: `${label}过大（上限 ${maxBytes} 字节）` }
  }
  let buf
  try { buf = Buffer.from(b64, 'base64') } catch { return { error: 'base64 解码失败' } }
  if (!buf || buf.length === 0) return { error: `${label}内容为空` }
  if (buf.length > maxBytes) return { error: `${label}过大（上限 ${maxBytes} 字节）` }
  // 魔数复核：别只信 data: 前缀，浏览器里改个字符串就能伪造。
  // ★ 必须按扩展名逐个分支 —— 写成 `ext !== 'png' && jpeg魔数` 会把 webp 一起误拒。
  let okMagic = false
  if (ext === 'png') {
    okMagic = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  } else if (ext === 'webp') {
    okMagic = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  } else {
    okMagic = buf[0] === 0xff && buf[1] === 0xd8
  }
  if (!okMagic) return { error: '缩略图内容与声明的类型不符' }
  return { buf, ext: ext === 'jpg' ? 'jpeg' : ext }
}

export function makeHistoryHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody, store, log, outputDir, redraw,
  } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const route = makeRouteFactory({ isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log })

  /** GET/HEAD：历史列表。参数全部在 store 里 clamp，端点不重复造校验。 */
  const historyHandler = route({
    path: '/api/qwen-paint/history', method: 'GET, HEAD', onlyText: 'GET only',
    handler: async ({ res, url }) => {
      // 这个端点的 500 有专属载荷（items/total/available/persistent）——前端靠它
      // 渲染降级态，不能收进工厂的通用 catch，所以本 handler 自带 try/catch。
      try {
        const p = url.searchParams
        const result = await store.query({
          keyword: p.get('q') ?? p.get('keyword') ?? '',
          kind: p.get('kind') ?? '',
          lora: p.get('lora') ?? '',
          from: p.get('from') ?? p.get('date_from') ?? '',
          to: p.get('to') ?? p.get('date_to') ?? '',
          limit: p.get('limit') ?? 20,
          offset: p.get('offset') ?? 0,
        })
        // 派生字段逐条兜底：某一条算失败也只是它少了三个字段，不该整页 500。
        if (Array.isArray(result?.items)) result.items = result.items.map(decorateHistoryItem)
        respondJson(res, result)
      } catch (error) {
        warn(`历史列表读取失败：${error?.message ?? error}`)
        respondJson(res, { ok: false, reason: '历史暂不可用（详见插件日志）',
          items: [], total: 0, available: false, persistent: false }, 500)
      }
    },
  }).handler

  /** GET/HEAD：汇总。 */
  const historyStatsHandler = route({
    path: '/api/qwen-paint/history/stats', method: 'GET, HEAD', onlyText: 'GET only',
    failText: '历史暂不可用（详见插件日志）',
    handler: async ({ res }) => { respondJson(res, store.stats()) },
  }).handler

  /** POST：软删除。id 不存在时如实回 removed:false，不假装成功。 */
  const historyDeleteHandler = route({
    path: '/api/qwen-paint/history/delete', method: 'POST', guard: true, parse: true,
    failText: '删除失败（详见插件日志）',
    handler: async ({ res, body }) => {
      const id = Number(body.id)
      if (!Number.isInteger(id) || id <= 0) {
        respondJson(res, { ok: false, reason: 'id 必填且须为正整数' }, 400); return
      }
      const removed = store.remove(id)
      respondJson(res, { ok: true, removed, note: removed
        ? '已从历史列表移除；磁盘文件保留'
        : '记录不存在或已被移除' })
    },
  }).handler

  /**
   * GET/HEAD：参数包导出（M2）。把一条历史的生成参数还原成机器可读的 JSON，
   * 字段对齐 draw_image 入参；参考图 / 控制图**刻意不入包** —— 文件可能已被
   * 移动或删除，把死路径打进包里就是教人踩坑。模型选择随面板当前值，
   * 包里的 unet / loras 仅作记录参考。
   */
  const historyExportHandler = route({
    path: '/api/qwen-paint/history/export', method: 'GET, HEAD', onlyText: 'GET only',
    failText: '参数包导出失败（详见插件日志）',
    handler: async ({ res, url }) => {
      const id = Number(url.searchParams.get('id'))
      if (!Number.isInteger(id) || id <= 0) {
        respondJson(res, { ok: false, reason: 'id 必填且须为正整数' }, 400); return
      }
      const item = store.get?.(id) ?? null
      if (!item) { respondJson(res, { ok: false, reason: '记录不存在或已被移除' }, 404); return }
      const extra = item.extra && typeof item.extra === 'object' ? item.extra : {}
      const drawArgs = {}
      if (item.prompt !== '') drawArgs.prompt = item.prompt
      if (extra.negative) drawArgs.negative = extra.negative
      if (Number.isFinite(item.width)) drawArgs.width = item.width
      if (Number.isFinite(item.height)) drawArgs.height = item.height
      if (Number.isFinite(item.steps)) drawArgs.steps = item.steps
      if (Number.isFinite(item.seed)) drawArgs.seed = item.seed
      respondJson(res, {
        ok: true,
        bundle: {
          id, tool_name: item.tool_name, kind: item.kind, created_at: item.created_at,
          file_path: item.file_path, prompt: item.prompt, negative: extra.negative ?? '',
          width: item.width, height: item.height, steps: item.steps, seed: item.seed,
          cfg: Number.isFinite(extra.cfg) ? extra.cfg : null,
          unet: extra.unet ?? '', loras: Array.isArray(extra.loras) ? extra.loras : [],
        },
        draw_args: drawArgs,
        note: 'draw_args 可直接交给 Agent 调 draw_image；reference / controlImage 不入包'
          + '（文件可能已移动）；主模型与 LoRA 随面板当前选择，包内仅记录当时值。',
      })
    },
  }).handler

  /**
   * POST：一键重画（M2）。按记录参数原样再跑一次（走与 draw_image 完全相同的
   * 内部 runDraw 链路 —— 由 index.js 注入 redraw 依赖，本文件不复制任何生成逻辑）。
   * 同 seed 会得到相同构图（幂等层的 2 分钟窗口内甚至直接复用结果）；
   * body.seed 可覆盖。⚠ 这是完整生成，HTTP 响应在出图完成后才返回。
   */
  const historyRedrawHandler = route({
    path: '/api/qwen-paint/history/redraw', method: 'POST', guard: true, parse: true,
    failText: '重画失败（详见插件日志）',
    before: ({ res }) => {
      // 依赖门在 body 解析之前：非标准装配（redraw 未注入）先于一切 IO 暴露。
      if (typeof redraw !== 'function') {
        respondJson(res, { ok: false, reason: '重画依赖未接线（非标准装配），请在完整插件环境使用' }, 500)
        return false
      }
    },
    handler: async ({ res, body }) => {
      const id = Number(body.id)
      if (!Number.isInteger(id) || id <= 0) {
        respondJson(res, { ok: false, reason: 'id 必填且须为正整数' }, 400); return
      }
      const item = store.get?.(id) ?? null
      if (!item) { respondJson(res, { ok: false, reason: '记录不存在或已被移除' }, 404); return }
      if (item.kind !== 'image' || item.tool_name !== 'draw_image') {
        respondJson(res, { ok: false, reason: `暂只支持重画 draw_image 图片记录（本条是 ${item.tool_name || item.kind}）` }, 400); return
      }
      const extra = item.extra && typeof item.extra === 'object' ? item.extra : {}
      const args = {}
      if (item.prompt !== '') args.prompt = item.prompt
      if (extra.negative) args.negative = extra.negative
      if (Number.isFinite(item.width)) args.width = item.width
      if (Number.isFinite(item.height)) args.height = item.height
      if (Number.isFinite(item.steps)) args.steps = item.steps
      // seed：显式覆盖 > 原记录 seed；都没有则走随机（与 draw_image 默认一致）。
      const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed)
        : (Number.isFinite(item.seed) ? item.seed : undefined)
      if (seed !== undefined) args.seed = Math.trunc(seed)
      const value = await redraw(args, {})
      respondJson(res, {
        ok: true,
        redrew_from: id,
        path: value?.path ?? '',
        seed: value?.seed ?? args.seed ?? null,
        note: '已按记录参数重画；素材库风格与面板当前设置会照常参与（与 Agent 出图同一条链路）。',
      })
    },
  }).handler

  /**
   * POST：回写浏览器端生成的缩略图（G36）。
   *
   * ★ 为什么缩略图由**浏览器**生成：Node 侧没有零依赖的图像解码器，
   *   为了缩略图引一个 sharp / canvas 原生模块，会让一次 `npm i` 变成
   *   编译 20 分钟还可能失败。浏览器天生有 canvas，`toBlob('image/webp')`
   *   一行就够 —— 代价是「用户不打开面板就不生成缩略图」，
   *   而这恰好是缩略图唯一被使用的地方，没有损失。
   *
   * 顺序刻意是「先写文件 → 再写库 → 失败回滚删文件」：
   *   setExtra 返回 false 表示 id 不存在或不可用，此时把刚写的文件删掉，
   *   不留孤儿图把输出目录越堆越大。
   */
  const historyThumbHandler = route({
    path: '/api/qwen-paint/history/thumb', method: 'POST', guard: true, parse: true,
    failText: '缩略图保存失败（详见插件日志）',
    before: ({ res }) => {
      if (!outputDir) { respondJson(res, { ok: false, reason: '输出目录未配置，无法保存缩略图' }, 400); return false }
    },
    handler: async ({ res, body }) => {
      const id = Number(body.id)
      if (!Number.isInteger(id) || id <= 0) {
        respondJson(res, { ok: false, reason: 'id 必填且须为正整数' }, 400); return
      }
      const decoded = decodeThumbDataUrl(body.data_url)
      if (decoded.error) { respondJson(res, { ok: false, reason: decoded.error }, 400); return }

      const dir = path.join(outputDir, THUMB_DIR_NAME)
      fs.mkdirSync(dir, { recursive: true })
      // ★ 文件名只由 id 与白名单扩展名拼成 —— 不接收任何调用方给的路径片段，
      //   天然没有目录穿越面。同一条记录换格式时，顺手把别的扩展名清掉。
      const fileName = `${id}.${decoded.ext}`
      const abs = path.join(dir, fileName)
      fs.writeFileSync(abs, decoded.buf)
      for (const other of Object.keys(THUMB_MIME)) {
        if (other === decoded.ext || (other === 'jpg' && decoded.ext === 'jpeg')) continue
        try { fs.unlinkSync(path.join(dir, `${id}.${other}`)) } catch { /* 不存在就算了 */ }
      }

      const rel = path.join(THUMB_DIR_NAME, fileName).replace(/\\/g, '/')
      const written = store.setExtra(id, { thumb: rel })
      if (!written) {
        try { fs.unlinkSync(abs) } catch { /* 回滚失败也只能算了 */ }
        respondJson(res, { ok: false, reason: '记录不存在或历史库不可用，缩略图未保存' }, 404)
        return
      }
      respondJson(res, { ok: true, thumb: rel, bytes: decoded.buf.length })
    },
  }).handler

  /**
   * D25 Canvas 草稿落盘。
   *
   * ★ 为什么复用一个已经过三道闸的解码器，而不是新写一个：
   *   data_url 是最容易被塞垃圾的入口（伪造 mime、超大体、脚本载荷）。
   *   同一份白名单 + 魔数复核 + 体积上限，审一次就够；再写一份就是再造一个漏洞面。
   *
   * ★ 落盘位置刻意**不在**历史库里：草稿不是"生成结果"，
   *   它没有 prompt / seed / 模型，混进历史只会让"最近生成了什么"变脏。
   *   这里只给回一个绝对路径，用户把它填进 `draw_image` 的 `reference` 即可。
   */
  const draftSaveHandler = route({
    path: '/api/qwen-paint/draft', method: 'POST', guard: true, parse: true,
    failText: '草稿保存失败（详见插件日志）',
    before: ({ res }) => {
      if (!outputDir) { respondJson(res, { ok: false, reason: '输出目录未配置，无法保存草稿' }, 400); return false }
    },
    handler: async ({ res, body }) => {
      const decoded = decodeThumbDataUrl(body.data_url, { maxBytes: DRAFT_MAX_BYTES, label: '草稿' })
      if (decoded.error) { respondJson(res, { ok: false, reason: decoded.error }, 400); return }
      const dir = path.join(outputDir, DRAFT_DIR_NAME)
      fs.mkdirSync(dir, { recursive: true })
      // 文件名全部由本端生成：时间戳 + 4 位随机，**不接受任何调用方给的片段**。
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
      const rnd = Math.random().toString(36).slice(2, 6)
      const fileName = `draft-${stamp}-${rnd}.${decoded.ext}`
      const abs = path.join(dir, fileName)
      fs.writeFileSync(abs, decoded.buf)
      respondJson(res, {
        ok: true,
        path: abs,
        rel_path: path.join(DRAFT_DIR_NAME, fileName).replace(/\\/g, '/'),
        bytes: decoded.buf.length,
        hint: '把 path 填进 draw_image 的 reference（或 inpaint_image 的底图）就能以这张草图为基础继续画。'
          + '草稿不会进生成历史 —— 它不是生成结果。',
      })
    },
  }).handler

  return {
    historyHandler, historyStatsHandler, historyDeleteHandler, historyThumbHandler, draftSaveHandler,
    historyExportHandler, historyRedrawHandler,
  }
}

/** 挂到 host 的 reg() 上；返回路径 → handler 的清单，便于测试核对。 */
export function historyRouteTable(handlers) {
  return [
    ['/api/qwen-paint/history', handlers.historyHandler],
    ['/api/qwen-paint/history/stats', handlers.historyStatsHandler],
    ['/api/qwen-paint/history/delete', handlers.historyDeleteHandler],
    ['/api/qwen-paint/history/thumb', handlers.historyThumbHandler],
    ['/api/qwen-paint/draft', handlers.draftSaveHandler],
    ['/api/qwen-paint/history/export', handlers.historyExportHandler],
    ['/api/qwen-paint/history/redraw', handlers.historyRedrawHandler],
  ]
}
