#!/usr/bin/env node
/**
 * reference-endpoints 直测（2026-11-20 零触及清单：makeReferenceHandlers 零断言）。
 *
 * route-factory 成熟模式（deps 全 mock）：4 端点行为切片 —— GET 协商（image/video 双模式）、
 *   POST prefer 零漂移、POST search 硬同意门 403、POST adapt 入参校验 400。
 *
 * 纯离线（loadObjectInfoFor mock，fetchReferenceCandidates 不给 consent 不会真联网）。
 */
import { makeReferenceHandlers } from '../lib/reference-endpoints.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const makeDeps = (overrides = {}) => {
  let preferred = ''
  const calls = []
  return {
    cfg: {},
    log: () => {},
    isLocalRequest: () => true,
    guardWriteRequest: () => true,  // guard 放行须 truthy（falsy=拒绝且 factory 静默 return）
    readJsonBody: async () => (overrides.__body ?? {}),
    respondJson: (res, body, code) => { res.__resp = { body, code: code ?? 200 } },
    loadObjectInfoFor: async () => overrides.__objectInfo ?? null,
    getPreferred: () => preferred,
    setPreferred: (v) => { preferred = typeof v === 'string' ? v : ''; return preferred },
    ...overrides,
    __calls: calls,
  }
}
const run = (handler, url, body) => {
  const res = {}
  const req = { url, method: body === undefined ? 'GET' : 'POST' }
  // handler 是 route-factory 的 wrapped(req,res) —— body 由 factory 的 readJsonBody mock 给出
  return Promise.resolve(handler(req, res)).then(() => res)
}

const H = makeReferenceHandlers(makeDeps())

console.log('— GET /reference（能力协商）')
{
  const res = await run(H.referenceHandler, '/api/comfy-pipeline/reference')
  ok('★ objectInfo=null → online:false 如实（不假装在线）+ preferred 字段在',
    res.__resp.code === 200 && res.__resp.body.online === false
    && 'preferred' in res.__resp.body && res.__resp.body.characterLock === null,
    JSON.stringify(res.__resp.body).slice(0, 120))
  const resV = await run(H.referenceHandler, '/api/comfy-pipeline/reference?mode=video')
  ok("★ mode=video → characterLock 非空（81 帧/25 chunk/8 overlap 的分段锁）",
    resV.__resp.body.characterLock !== null && typeof resV.__resp.body.characterLock === 'object',
    JSON.stringify(resV.__resp.body.characterLock))
}

console.log('— POST /reference/prefer（零漂移）')
{
  const H2 = makeReferenceHandlers(makeDeps({ __body: { strategy: 'mask_blend' } }))
  const res = await run(H2.referencePreferHandler, '/api/comfy-pipeline/reference/prefer', { strategy: 'mask_blend' })
  ok('★ prefer 设策略 → ok + preferred 回显 + enabled:true',
    res.__resp.body.ok === true && res.__resp.body.preferred === 'mask_blend' && res.__resp.body.enabled === true,
    JSON.stringify(res.__resp.body))
  const H3 = makeReferenceHandlers(makeDeps({ __body: { strategy: '' } }))
  const res3 = await run(H3.referencePreferHandler, '/api/comfy-pipeline/reference/prefer', { strategy: '' })
  ok("★ strategy:'' = 关闭 → enabled:false（零漂移：清空即回到无偏好）",
    res3.__resp.body.enabled === false && res3.__resp.body.preferred === '', JSON.stringify(res3.__resp.body))
}

console.log('— POST /reference/search（硬同意门）')
{
  const H4 = makeReferenceHandlers(makeDeps({ __body: { query: 'some character' } }))
  const res = await run(H4.referenceSearchHandler, '/api/comfy-pipeline/reference/search', { query: 'some character' })
  ok("★ 无 consent → 403 + CONSENT_REQUIRED（硬同意门默认拒绝，不联网）",
    res.__resp.code === 403 && res.__resp.body.ok === false && typeof res.__resp.body.code === 'string'
    && res.__resp.body.candidates.length === 0, JSON.stringify(res.__resp.body).slice(0, 120))
}

console.log('— POST /reference/adapt（入参校验）')
{
  const H5 = makeReferenceHandlers(makeDeps({ __body: { workflow: 'not-an-object' } }))
  const res = await run(H5.referenceAdaptHandler, '/api/comfy-pipeline/reference/adapt', { workflow: 'not-an-object' })
  ok('★ workflow 非对象 → 400 + 中文 reason', res.__resp.code === 400 && res.__resp.body.reason.includes('workflow'), JSON.stringify(res.__resp.body))
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
