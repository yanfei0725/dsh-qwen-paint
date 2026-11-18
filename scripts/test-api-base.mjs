#!/usr/bin/env node
/**
 * 无头浏览器面板 API 基址护栏（2026-11-18.2）
 *
 * 报障：插件所有「查看后端与探测状态」等探测统一 HTTP 404，文案却说
 *      「请确认 ComfyUI 已启动」。
 * 根因：面板在无头浏览器里注入到宿主 document，页面的 baseURI 指向 ComfyUI
 *      （8188），但插件脚本以绝对地址从 DSH 宿主（随机端口）加载；前端 fetch
 *      用相对路径 api/... ⇒ 被解析到 8188/api/qwen-paint/* ⇒ 全 404。
 * 修法：每个前端脚本内联 qpApiUrl()，以「加载本插件脚本的 <script src>」的
 *      origin 为准拼绝对地址；拿不到就退回相对路径（兼容 vm 假 DOM / 老宿主）。
 *
 * 本套两类断言：
 *   · 真调用 —— 把 helper 抽出来在 node:vm 里真跑，覆盖错位 / 无 script / 外部 URL 三种场景；
 *   · 源码级 —— 七个前端脚本都做了同样修复，fetch 调用点无遗留裸相对路径。
 * 全离线：零联网、零子进程、零真实 DOM。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
const fails = []
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  OK   ${label}`) }
  else { fail += 1; fails.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/* ---------- 1. 把 qpApiUrl 从 lab.js 抽出，真跑三种场景 ---------- */
console.log('=== 1. qpApiUrl 真调用（vm） ===')
{
  const LAB = read('assets/lab.js')
  const m = LAB.match(/  function qpApiUrl\(rel\) \{[\s\S]*?\n  \}/)
  ok('能从 lab.js 抽出 qpApiUrl 定义', !!m)
  if (m) {
    const fnSrc = m[0]
    // 造一个假 document：scripts 里有一条指向 DSH 宿主 56287 的插件脚本；
    // location.href 却是 ComfyUI 8188（复现无头浏览器错位）。
    function makeCtx(scripts, href) {
      const doc = {
        getElementsByTagName(tag) {
          return tag === 'script' ? scripts : []
        },
      }
      const ctx = { document: doc, location: { href }, URL, String }
      vm.createContext(ctx)
      vm.runInContext(fnSrc, ctx)
      return ctx
    }
    const hostScript = [{ src: 'http://127.0.0.1:56287/qwen-paint/lab.js' }]

    const ctx = makeCtx(hostScript, 'http://127.0.0.1:8188/')
    ok('★ 错位场景：相对路径解析到宿主 56287 而非页面 8188',
      vm.runInContext("qpApiUrl('api/qwen-paint/health')", ctx) === 'http://127.0.0.1:56287/api/qwen-paint/health',
      vm.runInContext("qpApiUrl('api/qwen-paint/health')", ctx))
    ok('★ comfy-pipeline 前缀同样钉到宿主',
      vm.runInContext("qpApiUrl('api/comfy-pipeline/modes')", ctx) === 'http://127.0.0.1:56287/api/comfy-pipeline/modes')
    ok('带 query 的路径不丢参数',
      vm.runInContext("qpApiUrl('api/qwen-paint/doctor?detail=1')", ctx) === 'http://127.0.0.1:56287/api/qwen-paint/doctor?detail=1')

    const ctxNone = makeCtx([], 'http://127.0.0.1:8188/')
    ok('无插件 script 时退回相对路径（假 DOM / 老宿主行为零变化）',
      vm.runInContext("qpApiUrl('api/qwen-paint/health')", ctxNone) === 'api/qwen-paint/health')

    const ctxExt = makeCtx([{ src: 'https://evil.example/qwen-paint/lab.js' }], 'http://127.0.0.1:8188/')
    ok('★ 外部脚本 src 不被当作宿主（只认回环 host，拒绝劫持到 evil.example）',
      vm.runInContext("qpApiUrl('api/qwen-paint/health')", ctxExt) === 'api/qwen-paint/health',
      vm.runInContext("qpApiUrl('api/qwen-paint/health')", ctxExt))

    const ctxAbs = makeCtx(hostScript, 'http://127.0.0.1:8188/')
    ok('已是绝对 URL 时不二次拼接',
      vm.runInContext("qpApiUrl('http://127.0.0.1:9999/x')", ctxAbs) === 'http://127.0.0.1:9999/x')

    // panel.js 自己从 /comfy-pipeline/panel.js 加载（src 不含 qwen-paint/），
    // 且它的常量在脚本顶部同步求值（早于 lab.js 注入）⇒ 必须认自己的 script。
    const ctxPanel = makeCtx([{ src: 'http://127.0.0.1:56287/comfy-pipeline/panel.js' }], 'http://127.0.0.1:8188/')
    ok('★ panel.js 自身 script（/comfy-pipeline/）也能定位宿主 origin',
      vm.runInContext("qpApiUrl('api/comfy-pipeline/modes')", ctxPanel) === 'http://127.0.0.1:56287/api/comfy-pipeline/modes',
      vm.runInContext("qpApiUrl('api/comfy-pipeline/modes')", ctxPanel))
  }
}

/* ---------- 2. 源码级：七个脚本都做了同样修复 ---------- */
console.log('=== 2. 七个前端脚本的修复一致性 ===')
{
  const FILES = ['lab', 'panel', 'history', 'cpu-accel', 'draft', 'mask-fx', 'setup-guide']
  for (const f of FILES) {
    const s = read(`assets/${f}.js`)
    ok(`${f}.js 内联了 qpApiUrl`, s.includes('function qpApiUrl'))
  }
  // fetch 调用点不得再有裸的相对 api/... 字面量（都应经 qpApiUrl 或常量包裹）
  let leaked = []
  for (const f of FILES) {
    const s = read(`assets/${f}.js`)
    for (const line of s.split('\n')) {
      if (/fetch\('api\//.test(line) && !line.includes('qpApiUrl')) leaked.push(`${f}: ${line.trim()}`)
    }
  }
  ok('★ 无遗留的裸相对 fetch 调用点', leaked.length === 0, leaked.join(' | '))
  // 关键常量都已包裹
  ok('panel 的 MODES_PATH 已包裹', read('assets/panel.js').includes("var MODES_PATH = qpApiUrl('api/comfy-pipeline/modes')"))
  ok('history 的 LIST_API 已包裹', read('assets/history.js').includes("var LIST_API = qpApiUrl('api/qwen-paint/history')"))
  ok('lab 的 request() 内部经 qpApiUrl', read('assets/lab.js').includes('var url = qpApiUrl(API + pathPart)'))
  // 错误文案不再误导为「ComfyUI 未启动」
  ok('★ 404 文案不再甩锅 ComfyUI 未启动',
    !read('assets/lab.js').includes("'），请确认 ComfyUI 已启动'"))
}

console.log(`\n=== test-api-base：${pass} 项通过，${fail} 项失败 ===`)
if (fail) {
  console.log('失败项：', fails.join(' / '))
  process.exit(1)
}
