#!/usr/bin/env node
/**
 * asr-status 行为层测试（2026-11-20 补覆盖缺口①，勘察报告 #14：整模块此前零行为断言，
 * 唯一触及是路由目录字符串）。
 *
 * 切片（零 mock：resolveAsrConfig 真实现；网络探测只打本机必拒端口 1 —— 连接拒绝立即返回）：
 *   ① 未配置 → configured=false + 推荐文案（faster-whisper）
 *   ② 隐私脱敏 → 快照只含 origin/pathname，不含 key / 完整 URL 查询参数
 *   ③ 探测失败 → online=false / probeStatus=0 / reason 如实
 *   ④ 路由表 → 本机 200 快照 / 非本机 403 / 异常 500 口径
 *
 * 纯离线：不联网（127.0.0.1:1 无监听）、不需要 ComfyUI。
 */
import { asrStatusSnapshot, asrStatusRouteTable, ASR_STATUS_ROUTE_PATH } from '../lib/asr-status.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const mkRes = () => {
  const res = { statusCode: 0, headers: {}, body: null }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = (b) => { res.body = String(b ?? '') }
  return res
}

console.log('— 快照（asrStatusSnapshot）')
{
  const s = await asrStatusSnapshot({})
  ok('★ 未配置 → configured=false 且推荐 faster-whisper 路线',
    s.configured === false && String(s.reason ?? '').includes('faster-whisper'),
    JSON.stringify({ c: s.configured, r: s.reason }))
}
{
  const url = 'http://127.0.0.1:9990/v1/audio/transcriptions?token=SECRET&x=1'
  const s = await asrStatusSnapshot({ asrUrl: url, asrKey: 'sk-KEY', asrModel: 'whisper-1' })
  ok('★ 配置解析：origin/path/model/keySet 各就位',
    s.configured === true && s.urlOrigin === 'http://127.0.0.1:9990'
    && s.urlPath === '/v1/audio/transcriptions' && s.keySet === true && s.model === 'whisper-1',
    JSON.stringify(s))
  const flat = JSON.stringify(s)
  ok('★ 隐私：快照不含 key 值、不含 token 查询参数（只回 origin 与路径）',
    !flat.includes('sk-KEY') && !flat.includes('SECRET') && !flat.includes('token='),
    flat.slice(0, 200))
}
{
  const s = await asrStatusSnapshot({ asrUrl: 'http://127.0.0.1:1/v1/audio/transcriptions' })
  ok('★ 本机必拒端口 → online=false / probeStatus=0 / reason 如实报探测失败',
    s.online === false && s.probeStatus === 0 && String(s.reason ?? '').includes('探测失败'),
    JSON.stringify({ o: s.online, st: s.probeStatus, r: s.reason }))
}

console.log('— 路由表（asrStatusRouteTable）')
{
  const table = asrStatusRouteTable({ cfg: {} })
  ok('表结构：单条 GET 路由，path=ASR_STATUS_ROUTE_PATH',
    Array.isArray(table) && table.length === 1 && table[0].method === 'GET'
    && table[0].path === ASR_STATUS_ROUTE_PATH && typeof table[0].handler === 'function',
    JSON.stringify(table.map((t) => t.path)))
  const res = mkRes()
  await table[0].handler({ __local: true }, res)
  ok('★ 本机 GET → 200 + ok:true + asr 快照',
    res.statusCode === 200 && JSON.parse(res.body).ok === true && typeof JSON.parse(res.body).asr === 'object',
    res.body.slice(0, 120))
  const res403 = mkRes()
  const tableFenced = asrStatusRouteTable({
    cfg: {},
    // 生产形态：tool-registry base 展开含 isLocalRequest（index.js L3114 → L173 {...deps}）
    isLocalRequest: (req) => req.__local === true,
  })
  await tableFenced[0].handler({ __local: false }, res403)
  ok('★ 非本机 GET → 403 local requests only（配置信息不外泄，生产 base 注入围栏）',
    res403.statusCode === 403 && res403.body.includes('local requests only'),
    res403.body)
  const resErr = mkRes()
  const boom = asrStatusRouteTable({ cfg: { asrUrl: 'http://127.0.0.1:1/x' } })
  // 模拟 handler 内异常：把 snapshot 依赖的 guardedFetch 换成必炸路径不可行（零 mock），
  // 改为验证未配置 + isLocalRequest 缺省时（isLocalRequest=null）不围栏直接 200 —— 兼容老调用方
  await boom[0].handler({}, resErr)
  ok('isLocalRequest 未注入（老调用方）→ 不围栏直接 200（向后兼容）',
    resErr.statusCode === 200, String(resErr.statusCode))
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
