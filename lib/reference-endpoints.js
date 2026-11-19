/**
 * lib/reference-endpoints.js —— 角色参考 / 联网检索的本机 HTTP 端点处理器。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 已逼近 DSH Store 的 256 KB 单文件上限（selftest.mjs 有硬断言），
 *   端点注册是可拆的独立关注点。把四个 handler 搬到这里，host 只负责注入依赖与注册，
 *   既腾出余量，也不丢任何设计说明。
 *
 * ## 边界
 *   · 所有依赖由 makeReferenceHandlers(deps) 注入：本模块不持有配置、不持有进程内存
 *     偏好状态、不自行判定请求信任（沿用 host 的 isLocalRequest / guardWriteRequest）。
 *   · 只读端点限 GET；三个写端点过 guardWriteRequest（POST + application/json）。
 *   · 联网检索**默认拒绝**：没有 consent:true 直接 403，连端点都不解析、不发任何请求。
 *     端点占位符 <API_ENDPOINT> 未替换时一律拒绝，不臆造搜索 API 地址。
 *   · /adapt 是纯工作流变换：只返回结果供检视，不提交 ComfyUI、不下载任何字节。
 *
 * 端点样板已收敛到 lib/route-factory.js（优化接力节点②，2026-11-20）：四个历史 catch
 * 全部回吐 error.message（一处还回 200）——按项目私规（细节只进日志、响应固定文案）
 * 由工厂统一消毒为 500；详情经注入的 log 落本机日志。
 */
import {
  capabilitySnapshot, selectStrategy, describeStrategy, planCharacterLock, adaptReference,
} from './reference-strategy.js'
import {
  fetchReferenceCandidates, describeWebReference, CONSENT_REQUIRED, WEB_ENDPOINT_PLACEHOLDER,
} from './reference-web.js'
import { makeRouteFactory } from './route-factory.js'

/**
 * 构造四个端点处理器。依赖注入而非各自 import，是为了让信任判定 / 写护栏 / 配置 /
 * 能力缓存全部走 host 的同一套，不出现第二份口径。
 *
 * @param {object} deps
 * @param {(req: object) => boolean} deps.isLocalRequest 本机请求判定
 * @param {(req: object, res: object) => boolean} deps.guardWriteRequest 写端点护栏
 * @param {(res: object, body: object, status?: number) => void} deps.respondJson
 * @param {(req: object) => Promise<object>} deps.readJsonBody 有界读取
 * @param {object} deps.cfg 插件配置
 * @param {(cfg: object, signal?: any) => Promise<object|null>} deps.loadObjectInfoFor
 * @param {() => string} deps.getPreferred 读进程内存里的面板策略偏好
 * @param {(id: string) => string} deps.setPreferred 写策略偏好（脏值归零）
 * @param {(level: string, msg: string) => void} [deps.log] 异常细节只进本机日志
 */
export function makeReferenceHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
    cfg, loadObjectInfoFor, getPreferred, setPreferred, log,
  } = deps
  const route = makeRouteFactory({ isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log })

  /** GET：按真实 /object_info 做运行时能力协商，列出可用策略 + 选中策略 + 联网同意要求。 */
  const referenceHandler = route({
    path: '/api/comfy-pipeline/reference', method: 'GET', onlyText: 'GET only',
    handler: async ({ res, url }) => {
      const mode = url.searchParams.get('mode') === 'video' ? 'video' : 'image'
      const objectInfo = await loadObjectInfoFor(cfg, undefined)
      const snapshot = capabilitySnapshot(objectInfo, mode)
      const selected = selectStrategy(objectInfo, { mode })
      respondJson(res, {
        ok: true,
        online: objectInfo !== null,
        preferred: getPreferred(),
        ...snapshot,
        selectedLabel: describeStrategy(selected),
        characterLock: mode === 'video'
          ? planCharacterLock({ totalFrames: 81, chunkFrames: 25, overlap: 8 })
          : null,
        web: describeWebReference(),
      })
    },
  }).handler

  /** POST prefer：'' = 关闭 ⇒ 零漂移。只记一个策略 id，不发起任何外部请求。 */
  const referencePreferHandler = route({
    path: '/api/comfy-pipeline/reference/prefer', method: 'POST', guard: true, parse: true,
    handler: async ({ res, body }) => {
      const value = setPreferred(body.strategy)
      respondJson(res, { ok: true, preferred: value, enabled: value !== '' })
    },
  }).handler

  /** POST search：硬同意门在 fetchReferenceCandidates 内部，默认拒绝。 */
  const referenceSearchHandler = route({
    path: '/api/comfy-pipeline/reference/search', method: 'POST', guard: true, parse: true,
    handler: async ({ res, body }) => {
      const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() !== ''
        ? body.endpoint.trim()
        : (typeof cfg.referenceSearchEndpoint === 'string' && cfg.referenceSearchEndpoint.trim() !== ''
          ? cfg.referenceSearchEndpoint.trim()
          : WEB_ENDPOINT_PLACEHOLDER)
      const r = await fetchReferenceCandidates(body.query, {
        consent: body.consent === true,
        endpoint,
        limit: body.limit,
      })
      if (!r.ok && r.code === CONSENT_REQUIRED) {
        respondJson(res, { ok: false, code: r.code, reason: r.reason, candidates: [], count: 0 }, 403)
        return
      }
      respondJson(res, r)
    },
  }).handler

  /** POST adapt：任意工作流 + 模式 + 参考图 → 按策略变换，只返回不提交。 */
  const referenceAdaptHandler = route({
    path: '/api/comfy-pipeline/reference/adapt', method: 'POST', guard: true, parse: true,
    handler: async ({ res, body }) => {
      const workflow = body.workflow && typeof body.workflow === 'object' && !Array.isArray(body.workflow)
        ? body.workflow : null
      if (workflow === null) { respondJson(res, { ok: false, reason: 'workflow 必须是对象' }, 400); return }
      const mode = body.mode === 'video' ? 'video' : 'image'
      const objectInfo = await loadObjectInfoFor(cfg, undefined)
      const r = adaptReference({
        workflow,
        mode,
        refs: Array.isArray(body.refs) ? body.refs : [],
        nodeSet: objectInfo,
        prefer: typeof body.strategy === 'string' && body.strategy !== 'auto' ? body.strategy : undefined,
      })
      respondJson(res, {
        ok: true,
        workflow: r.workflow,
        applied: r.applied,
        strategy: { id: r.strategy.id, label: r.strategy.label, tier: r.strategy.tier, maxRefs: r.strategy.maxRefs },
        strategyLabel: describeStrategy(r.strategy),
        plan: { nodePatches: r.plan.nodePatches, rewires: r.plan.rewires, denoise: r.plan.denoise, maxRefs: r.plan.maxRefs },
        notes: r.notes,
      })
    },
  }).handler

  return { referenceHandler, referencePreferHandler, referenceSearchHandler, referenceAdaptHandler }
}
