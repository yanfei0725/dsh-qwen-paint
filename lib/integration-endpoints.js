/**
 * lib/integration-endpoints.js —— 本轮新增的本机 HTTP 端点（全部外置）。
 *
 * 覆盖三块能力：
 *   ① 图形化安装引导 `GET /api/qwen-paint/setup-guide`
 *   ② 蒙版增强 + 卸载内存模式 `GET|POST /api/qwen-paint/mask-fx`
 *   ③ 外部集成状态 `GET /api/qwen-paint/integration/state|routes`
 *
 * ## 安全边界（与既有端点逐条对齐，不引入更宽松口径）
 *   · 顶层 isLocalRequest 在任何动作之前；
 *   · 写操作一律 POST only + guardWriteRequest（JSON 媒体类型）+ 有界 readJsonBody；
 *   · 卸载内存只向 cfg.comfyUrl（由 net-guard 强制回环）发 /free，不接受任意 URL；
 *   · 不读本机任意路径、不落盘、不派生子进程、不联网下载；
 *   · 输出全部来自纯函数白名单，不含绝对路径 / 用户名 / 凭据。
 */
import {
  normalizeMaskFx, maskWorkflowPatch, describeMaskFx,
  MASK_FX_LIMITS, MASK_FX_DEFAULTS, normalizeMemoryMode, MEMORY_MODES,
} from './mask-fx.js'
import { buildSetupGuideReport, publicSteps } from './setup-guide.js'
import { buildIntegrationState, buildRouteCatalog, INTEGRATION_ROUTES } from './integration-state.js'

/**
 * @param {object} deps
 * @param {(req:object)=>boolean} deps.isLocalRequest
 * @param {(req:object,res:object)=>boolean} deps.guardWriteRequest
 * @param {(res:object,body:object,status?:number)=>void} deps.respondJson
 * @param {(req:object)=>Promise<object|null>} deps.readJsonBody
 * @param {object} deps.cfg 插件配置（含 comfyUrl）
 * @param {(level:string,msg:string)=>void} deps.log
 * @param {()=>Promise<object>} deps.probeGuideState host 采集的真实就绪状态
 * @param {()=>object} deps.snapshot 外部集成状态输入（版本 / 工具 / 档位 / 计数）
 * @param {(body:object)=>Promise<boolean>} deps.unloadModels 向 ComfyUI /free 卸模型
 * @param {object} deps.runtime 可变运行态（maskFx / memoryMode / 计数）
 */
export function makeIntegrationHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
    cfg, log, probeGuideState, snapshot, unloadModels, runtime,
  } = deps

  const localGet = (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return false }
    if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
      respondJson(res, { ok: false, reason: 'GET only' }, 405); return false
    }
    return true
  }

  /** GET：图形化安装引导的步骤 + host 现算的真实状态。 */
  const setupGuideHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const state = await probeGuideState()
      respondJson(res, buildSetupGuideReport(state))
    } catch (error) {
      // 探测失败也要给完整步骤清单（状态为 checking），不让引导白屏。
      // ★ 2026-11-13 审计修复：异常 message 可能含本机绝对路径 / 模型名，
      //   绝不回吐给浏览器；只写本地日志，对外统一给固定文案。
      log?.('warn', `[安装引导] 状态探测暂不可用：${String(error?.message ?? error).slice(0, 200)}`)
      respondJson(res, { ...buildSetupGuideReport({}), ok: true, steps: publicSteps(),
        note: '状态探测暂不可用，已按「待检查」展示全部步骤；稍后可重试。' })
    }
  }

  /** GET：当前蒙版增强参数与可调范围；POST：设置参数 / 立即卸载内存。 */
  const maskFxHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      respondJson(res, {
        ok: true,
        schema: 'dsh-qwen-paint/mask-fx@1',
        current: { ...runtime.maskFx },
        defaults: { ...MASK_FX_DEFAULTS },
        limits: JSON.parse(JSON.stringify(MASK_FX_LIMITS)),
        memoryMode: runtime.memoryMode,
        memoryModes: [...MEMORY_MODES],
        unloadCount: runtime.unloadCount,
        workflowPatch: maskWorkflowPatch(runtime.maskFx),
        description: describeMaskFx(runtime.maskFx),
        note: '羽化/边缘融合/外扩/反选会真正写入 InpaintCropImproved 节点参数；笔刷软硬度在浏览器画布生效。',
      })
      return
    }
    if (method !== 'POST') { respondJson(res, { ok: false, reason: 'GET or POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    const body = (await readJsonBody(req)) ?? {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      respondJson(res, { ok: false, reason: 'body 必须是 JSON 对象' }, 400); return
    }
    // action=unload：显式立即卸载（手动模式 / 一键释放按钮）
    if (body.action === 'unload') {
      const ok = await unloadModels({ unload_models: true, free_memory: true })
      runtime.unloadCount += 1
      runtime.lastUnloadOk = ok
      log?.('info', `[卸载内存] 手动触发 /free：${ok ? '成功' : '失败或不在线'}`)
      respondJson(res, { ok, unloadCount: runtime.unloadCount, memoryMode: runtime.memoryMode })
      return
    }
    if (body.memoryMode !== undefined) runtime.memoryMode = normalizeMemoryMode(body.memoryMode)
    // 只合并显式传入的字段，缺省保持当前值；全部经 normalizeMaskFx 钳制。
    const patch = { ...runtime.maskFx, ...body.maskFx, ...body }
    delete patch.action
    delete patch.memoryMode
    runtime.maskFx = normalizeMaskFx(patch)
    respondJson(res, {
      ok: true,
      current: { ...runtime.maskFx },
      memoryMode: runtime.memoryMode,
      workflowPatch: maskWorkflowPatch(runtime.maskFx),
      description: describeMaskFx(runtime.maskFx),
    })
  }

  /** GET：聚合状态快照（脱敏）。 */
  const integrationStateHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const base = (await snapshot()) ?? {}
      respondJson(res, buildIntegrationState({
        ...base,
        // 真实值：默认只允许回环；用户显式 allowRemoteComfy: true 时如实报 false。
        comfyLocalOnly: cfg?.allowRemoteComfy !== true,
        memoryMode: runtime.memoryMode,
        unloadCount: runtime.unloadCount,
        lastUnloadOk: runtime.lastUnloadOk,
        maskFx: runtime.maskFx,
      }))
    } catch (error) {
      // ★ 2026-11-13 审计修复：同上，异常细节只进本地日志，不进 HTTP 响应。
      log?.('warn', `[集成状态] 快照采集失败：${String(error?.message ?? error).slice(0, 200)}`)
      respondJson(res, { ok: false, reason: '状态快照暂不可用' }, 500)
    }
  }

  /** GET：端点目录，供外部集成自行发现。 */
  const integrationRoutesHandler = async (req, res) => {
    if (!localGet(req, res)) return
    respondJson(res, buildRouteCatalog())
  }

  return { setupGuideHandler, maskFxHandler, integrationStateHandler, integrationRoutesHandler }
}

/** 统一注册，返回 disposer 数组（与既有 registerVideoFrameRoutes 同样的形态）。 */
export function registerIntegrationRoutes(register, handlers) {
  return [
    register({ kind: 'exact', path: '/api/qwen-paint/setup-guide', handler: handlers.setupGuideHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/mask-fx', handler: handlers.maskFxHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/integration/state', handler: handlers.integrationStateHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/integration/routes', handler: handlers.integrationRoutesHandler }),
  ]
}

export { INTEGRATION_ROUTES }
