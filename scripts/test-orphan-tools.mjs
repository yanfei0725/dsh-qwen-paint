#!/usr/bin/env node
/**
 * orphan-extras 工具工厂直测（2026-11-20 零触及清单：test-orphan-wiring 只锁注册接线、
 *   不锁行为——本文件补 makeTimelineTool / makePrivacySummaryTool 的 execute 行为）。
 *
 * 行为黑盒：不读 buildTimeline/buildPrivacySummary 实现，按工具输出 schema 断言结构
 *   与关键语义（external_network 按真实 URL 清单算——本地回环 vs 外网差异）。
 *
 * 纯离线。
 */
import { makeTimelineTool, makePrivacySummaryTool } from '../lib/orphan-extras.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('— plan_timeline')
{
  const t = makeTimelineTool()
  const r = await t.execute({ seconds: 24 })
  ok('★ 结构：ok/step/seconds/segments/prefix 五件齐（schema 口径）',
    r.ok === true && typeof r.step === 'number' && r.seconds === 24
    && Array.isArray(r.segments) && r.segments.length === 12 && typeof r.prefix === 'string' && r.prefix !== '',
    JSON.stringify({ ok: r.ok, step: r.step, n: r.segments.length }))
  ok('★ segments 累计覆盖 seconds（时间轴不丢尾段）',
    r.segments[r.segments.length - 1].to >= r.seconds, JSON.stringify(r.segments.slice(-1)))
  const r2 = await t.execute({})
  ok('seconds 未给 → ok:false + reason 如实（不编时间轴）',
    r2.ok === false && typeof r2.reason === 'string' && r2.reason !== '' && r2.prefix === '', JSON.stringify(r2))
}

console.log('— privacy_summary')
{
  const t = makePrivacySummaryTool()
  const local = await t.execute({
    comfy_url: 'http://127.0.0.1:8188',
    request_urls: ['http://127.0.0.1:8188/history/x', 'http://127.0.0.1:9880/tts'],
    models: ['qwen_image.safetensors'], seconds: 3.2, prompt_id: 'abc',
  })
  ok('★ 全本地 URL → external_network:false（按真实清单算，不是写死 false）',
    local.ok === true && local.external_network === false && local.external_urls.length === 0,
    JSON.stringify(local.external_network))
  ok('★ request_count/models/seconds/prompt_id 透传 + summary 非空',
    local.request_count === 3  // request_urls 2 条 + comfy 主端点本身 && local.models.length === 1
    && local.seconds === 3.2 && local.prompt_id === 'abc' && typeof local.summary === 'string' && local.summary !== '',
    JSON.stringify({ c: local.request_count, s: local.summary.slice(0, 60) }))
  ok('cross_check 提示可用 /history/<prompt_id> 交叉核对（诚实条款文案）',
    local.cross_check.includes('/history'), local.cross_check)
  const ext = await t.execute({
    comfy_url: 'http://127.0.0.1:8188',
    request_urls: ['http://example.com/api', 'http://127.0.0.1:8188/history/x'],
    models: [],
  })
  ok('★ 外网 URL → external_network:true + external_urls 只列外网（本地不误报）',
    ext.external_network === true && ext.external_urls.length === 1
    && ext.external_urls[0].includes('example.com'), JSON.stringify(ext.external_urls))
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
