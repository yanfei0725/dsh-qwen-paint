#!/usr/bin/env node
/**
 * test-route-factory.mjs —— lib/route-factory.js 端点公共工厂的契约锁
 *
 * 背景（2026-11-20 反向核查发现）：405 状态码有硬锁（test-history / test-video-replace
 * 会红），但工厂的 **catch 日志形态**、**守卫顺序**、**before 钩子顺序** 此前没有
 * 独立锁——同等缺陷注入后，历史测试仍绿（锁被各端点自己的本地逻辑兜住，
 * 缺陷会悄悄滑过去）。本文件把工厂行为本身锁死：工厂被改坏必须在这里变红。
 *
 * 全程注入假 deps：零网络、零文件、零进程副作用。
 */
import { makeRouteFactory } from '../lib/route-factory.js'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

console.log('=== 1. 门序：本机门 → 方法门 → 写守卫 → before → body 解析 → handler ===')
{
  const calls = []
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const log = (level, msg) => calls.push(['log', level, msg])
  const route = makeRouteFactory({
    isLocalRequest: (req) => { calls.push('local'); return req.local !== false },
    guardWriteRequest: (req) => { calls.push('guard'); return req.headers?.['content-type'] === 'application/json' },
    readJsonBody: async () => { calls.push('parse'); return { id: 1 } },
    respondJson, log,
  })
  const wrapped = route({
    path: '/x', method: 'POST', guard: true, parse: true,
    before: () => { calls.push('before') },
    handler: async ({ res }) => { calls.push('handler'); respondJson(res, { ok: true }) },
  })
  const res = { out: null }
  await wrapped.handler({ method: 'POST', headers: { 'content-type': 'application/json' } }, res)
  ok('正常请求放行 200', res.out?.code === 200, JSON.stringify(res.out))
  ok('顺序 local→guard→before→parse→handler（守卫/依赖门必须在 body 解析之前）',
    JSON.stringify(calls) === JSON.stringify(['local', 'guard', 'before', 'parse', 'handler']),
    JSON.stringify(calls))
}

console.log('\n=== 2. 本机门 / 方法门 / HEAD ===')
{
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const route = makeRouteFactory({
    isLocalRequest: (req) => req.local !== false,
    guardWriteRequest: () => true,
    readJsonBody: async () => ({}),
    respondJson,
  })
  const wrapped = route({
    path: '/y', method: 'GET, HEAD', onlyText: 'GET only',
    handler: async ({ res }) => respondJson(res, { ok: true }),
  })
  const nonLocal = { out: null }
  await wrapped.handler({ method: 'GET', local: false }, nonLocal)
  ok('非本机 → 403 local requests only', nonLocal.out.code === 403 && nonLocal.out.body.reason === 'local requests only')
  const wrongMethod = { out: null }
  await wrapped.handler({ method: 'POST' }, wrongMethod)
  ok('POST → 405', wrongMethod.out.code === 405)
  ok('405 文案可被 onlyText 钉回原样（GET only）', wrongMethod.out.body.reason === 'GET only')
  const head = { out: null }
  await wrapped.handler({ method: 'HEAD' }, head)
  ok('HEAD 放行（GET+HEAD 只读路由语义）', head.out.code === 200)
  const noOnly = { out: null }
  const wrapped2 = makeRouteFactory({
    isLocalRequest: () => true, guardWriteRequest: () => true, readJsonBody: async () => ({}), respondJson,
  })({ path: '/z', method: 'GET, POST', handler: async () => {} })
  await wrapped2.handler({ method: 'DELETE' }, noOnly)
  ok('默认 405 文案列出全部方法（GET / POST only）', noOnly.out.body.reason === 'GET / POST only', noOnly.out.body.reason)
}

console.log('\n=== 3. 守卫失败短路：readJsonBody 绝不能先跑 ===')
{
  const calls = []
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const route = makeRouteFactory({
    isLocalRequest: () => true,
    guardWriteRequest: (req, res) => {
      calls.push('guard')
      // 模仿 host 真守卫：415 自己响应并返回 false
      respondJson(res, { ok: false, reason: 'json only' }, 415)
      return false
    },
    readJsonBody: async () => { calls.push('parse'); return {} },
    respondJson,
  })
  const wrapped = route({ path: '/w', method: 'POST', guard: true, parse: true, handler: async () => { calls.push('handler') } })
  const res = { out: null }
  await wrapped.handler({ method: 'POST' }, res)
  ok('守卫失败 → 415 原样透传', res.out.code === 415 && res.out.body.reason === 'json only')
  ok('守卫失败时 parse / handler 未被调用（守卫后移缺陷在这里变红）',
    JSON.stringify(calls) === JSON.stringify(['guard']), JSON.stringify(calls))
}

console.log('\n=== 4. before 钩子：respond + 返回 false 即短路 ===')
{
  const calls = []
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const route = makeRouteFactory({
    isLocalRequest: () => true, guardWriteRequest: () => true,
    readJsonBody: async () => { calls.push('parse'); return {} },
    respondJson,
  })
  const wrapped = route({
    path: '/v', method: 'POST', guard: true, parse: true,
    before: ({ res }) => { calls.push('before'); respondJson(res, { ok: false, reason: '输出目录未配置' }, 400); return false },
    handler: async () => { calls.push('handler') },
  })
  const res = { out: null }
  await wrapped.handler({ method: 'POST' }, res)
  ok('before 短路 → 400 且 parse / handler 未跑', res.out.code === 400
    && JSON.stringify(calls) === JSON.stringify(['before']), JSON.stringify(calls))
}

console.log('\n=== 5. catch 收口：warn 单条 msg + 固定文案 + failText 覆盖 ===')
{
  const logs = []
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const log = (level, msg) => logs.push({ level, msg }) // 与 test-history 同款两参桩
  const route = makeRouteFactory({
    isLocalRequest: () => true, guardWriteRequest: () => true,
    readJsonBody: async () => ({}), respondJson, log,
  })
  const boom = route({ path: '/boom', handler: async () => { throw new Error('X:/secret/private.db locked') } })
  const res1 = { out: null }
  await boom.handler({ method: 'GET' }, res1)
  ok('默认 catch → 500 处理失败（详见插件日志）',
    res1.out.code === 500 && res1.out.body.reason === '处理失败（详见插件日志）')
  ok('日志级别 warn（原样板同形；改成 error 在这里变红）', logs.at(-1)?.level === 'warn')
  ok('log 是 (level, msg) 两参签名，错误原文必须拼进单条 msg（三参丢参在这里变红）',
    typeof logs.at(-1)?.msg === 'string' && logs.at(-1).msg.includes('[route /boom]')
    && logs.at(-1).msg.includes('X:/secret/private.db locked'),
    JSON.stringify(logs.at(-1)))
  ok('响应不回吐 error.message（项目私规）', !JSON.stringify(res1.out.body).includes('X:/secret'))

  const custom = route({
    path: '/custom', failText: '历史暂不可用（详见插件日志）',
    handler: async () => { throw new Error('x') },
  })
  const res2 = { out: null }
  await custom.handler({ method: 'GET' }, res2)
  ok('failText 按路由覆盖原文案', res2.out.body.reason === '历史暂不可用（详见插件日志）')
}

console.log('\n=== 6. before/handler 之外：parse 缺省 {} 与 ctx.url ===')
{
  const seen = []
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const route = makeRouteFactory({
    isLocalRequest: () => true, guardWriteRequest: () => true,
    readJsonBody: async () => undefined, // 模拟空体：工厂必须兜成 {}
    respondJson,
  })
  const wrapped = route({
    path: '/u', method: 'GET', parse: true,
    handler: async ({ url, body }) => seen.push({ q: url.searchParams.get('q'), body, isUrl: url instanceof URL }),
  })
  const res = { out: null }
  await wrapped.handler({ method: 'GET', url: '/u?q=1' }, res)
  ok('parse=true 时空体兜成 {}', seen[0]?.body && Object.keys(seen[0].body).length === 0)
  ok('ctx.url 是真 URL 实例且 searchParams 可用', seen[0]?.isUrl === true && seen[0]?.q === '1')
}

console.log(`\ntest-route-factory: ${pass} 项断言通过${fail ? `，${fail} 项失败` : '，全绿'}`)
if (fail) process.exitCode = 1
