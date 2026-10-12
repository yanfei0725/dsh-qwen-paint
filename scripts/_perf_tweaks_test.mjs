/**
 * _perf_tweaks_test.mjs —— 提速项 M4/M5/M6/M7/M8 的回归锁。
 * （M1 未实施；M2 见 _wrapper_policy_test / _wf_wrapper_integration；M3 未采纳。）
 *
 *   M4 批量出图（count → EmptyLatentImage.batch_size，默认 1）
 *   M5 空闲关停稳健化（ctx.effect 不可用时裸定时器兜底）
 *   M6 编排层并行（probeReadiness / uploadReference / probeCapabilities → Promise.all）
 *   M7 轮询间隔 1200 → 400
 *   M8 就绪后预热能力探测
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildWorkflow, planWorkflow, DEFAULTS } = mod.__internal
const SRC = ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n')

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

const wf = (over = {}) => buildWorkflow({ ...DEFAULTS }, { prompt: '测试', width: 1024, height: 1024, seed: 1, ...over })

console.log('=== M7 · 轮询间隔 400ms ===')
ok('DEFAULTS.pollIntervalMs === 400', DEFAULTS.pollIntervalMs === 400)

console.log('\n=== M4 · 批量出图（默认 1，clamp 1..4，仅文生图） ===')
ok('默认（不传 count）→ batch_size = 1', wf()['6']?.inputs?.batch_size === 1)
ok('count=3 → batch_size = 3', wf({ count: 3 })['6']?.inputs?.batch_size === 3)
ok('count=4 → batch_size = 4', wf({ count: 4 })['6']?.inputs?.batch_size === 4)
ok('count=9 → clamp 到 4', wf({ count: 9 })['6']?.inputs?.batch_size === 4)
ok('count=0 → 回到 1', wf({ count: 0 })['6']?.inputs?.batch_size === 1)
ok('count=-2 → 回到 1', wf({ count: -2 })['6']?.inputs?.batch_size === 1)
ok('count=NaN(非数字) → 1', wf({ count: undefined })['6']?.inputs?.batch_size === 1)
ok('图生图（有 reference）→ 不加 EmptyLatentImage（批量不适用）',
  wf({ reference: 'ref.png' })['6'] === undefined)
ok('planWorkflow 与 execute 一致：count=2 → batch_size=2',
  planWorkflow({ ...DEFAULTS }, { prompt: 'x', count: 2 })['6']?.inputs?.batch_size === 2)
ok('PARAMETERS 暴露了 count 参数', /count:\s*\{\s*\n\s*type:\s*'integer'/u.test(SRC))
ok('count 描述里写明"默认只出一张"', SRC.includes('默认就传 1（只出一张）'))
ok('落盘切片用 count（不是写死 1）', SRC.includes('images.slice(0, count)'))

console.log('\n=== M6 · 编排层并行（三步 Promise.all） ===')
ok('三处独立请求改成并发（Promise.all 解构 ready/reference/caps）',
  SRC.includes('const [ready, reference, caps] = await Promise.all('))
ok('并行块在 ensureComfyUp 之后（先在线再并发）',
  SRC.indexOf('await ensureComfyUp(cfg, log, signal)') < SRC.indexOf('const [ready, reference, caps] = await Promise.all('))

console.log('\n=== M8 · 就绪后预热能力探测 ===')
const prefetchCount = (SRC.match(/probeCapabilities\(cfg, log, signal\)\.catch\(\(\) => \{\}\)/gu) ?? []).length
ok(`就绪后预热 probeCapabilities（实测 ${prefetchCount} 处，应 ≥2）`, prefetchCount >= 2)

console.log('\n=== M5 · 空闲关停稳健化 ===')
ok('抽出 startIdleTimer', SRC.includes('const startIdleTimer = () =>'))
ok('有 ctx.effect 时走 effect', SRC.includes('ctx.effect(startIdleTimer,'))
ok('无 ctx.effect 时裸定时器兜底', SRC.includes('startIdleTimer()'))
ok('队列非空续期时有日志（可观测）', SRC.includes('空闲已到点，但队列非空 → 续期'))

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
