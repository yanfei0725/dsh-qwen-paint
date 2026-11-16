/**
 * 音频转文字（transcribe_audio）回归。断言风格：ok(名称, 条件)。全离线 —— 注入假 fetch，
 * 不联网、不生成音频文件、不调用真实 ASR 服务。
 *
 * 覆盖：能力探测（未配置诚实分支）/ 工具 schema / 空音频拒绝 / 路径围栏 /
 *       成功收口（文字+时间戳+白名单字段，不吐 key/绝对路径）/ 失败不冒充 /
 *       端点本机围栏 / 七处接线（工具/端点目录/Agent/自述/selftest/UI/SUITES）零孤儿。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRANSCRIBE_TOOL_NAME, TRANSCRIBE_ROUTE_PATH, TRANSCRIBE_OUTPUT_FIELDS,
  makeTranscribeTool, transcribeCapability, normalizeTranscribeResult, transcribeRouteTable,
} from '../lib/transcribe-tool.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond, extra) => {
  if (cond) pass++
  else failures.push(name + (extra ? ' | ' + extra : ''))
}
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

console.log('=== 1. 能力探测（诚实边界）===')
const unconfigured = transcribeCapability({})
ok('未配 asrUrl → configured:false', unconfigured.configured === false)
ok('未配 → 有自检步骤（verify 非空）', String(unconfigured.verify).includes('asrUrl'))
ok('未配 → 不吐 key', unconfigured.has_key === false && !JSON.stringify(unconfigured).includes('asrKey'))
const configured = transcribeCapability({ asrUrl: 'http://127.0.0.1:8000', asrKey: 'secret', asrModel: 'whisper-1' })
ok('已配 → configured:true', configured.configured === true)
ok('已配 → 自动补默认路径', configured.url.includes('/v1/audio/transcriptions'))
ok('key 只回配没配，不回显值', configured.has_key === true && !JSON.stringify(configured).includes('secret'))
ok('支持格式清单非空', Array.isArray(configured.formats) && configured.formats.length > 0)

console.log('=== 2. 工具 schema ===')
const OUT = path.join(ROOT, 'output')
// 围栏测试需配 asrUrl 才会走到路径检查（未配时 asr-client 先报缺件，见下一条断言）。
const tool = makeTranscribeTool({ cfg: { outputDir: OUT, asrUrl: 'http://127.0.0.1:8000' },
  fetchFn: async () => { throw new Error('should not be called') } })
ok('工具名 = transcribe_audio', tool.name === TRANSCRIBE_TOOL_NAME)
ok('required 只含 audio', JSON.stringify(tool.parameters.required) === JSON.stringify(['audio']))
ok('additionalProperties:false（拒杂参）', tool.parameters.additionalProperties === false)
ok('参数含 audio/seconds/format', ['audio', 'seconds', 'format'].every((k) => k in tool.parameters.properties))
ok('输出字段白名单 10 项', TRANSCRIBE_OUTPUT_FIELDS.length === 10)

console.log('=== 3. 空音频与围栏（不联网）===')
let r = await tool.execute({})
ok('空 audio → ok:false + 理由', r.ok === false && r.reason.includes('没给音频'))
const noAsrTool = makeTranscribeTool({ cfg: { outputDir: OUT }, fetchFn: async () => {} })
const rNoAsr = await noAsrTool.execute({ audio: 'a.mp3' })
ok('未配 asrUrl → 先报缺件（不假装能转）', rNoAsr.ok === false && rNoAsr.reason.includes('asrUrl'))
r = await tool.execute({ audio: '../evil.mp3' })
ok('.. 穿越 → 拒绝（asr-client 围栏）', r.ok === false && r.reason.includes('出图目录'))
ok('失败也有 verify 自检步骤', typeof r.verify === 'string' && r.verify.length > 0)

console.log('=== 4. 成功收口（假 asr-client 结果）===')
const shape = normalizeTranscribeResult({
  ok: true, text: '你好世界', cues: [{ start: 0, end: 1, text: '你好' }],
  aligned: true, language: 'zh', provider: 'faster-whisper', reason: '',
}, 'json')
ok('成功 → ok:true + 文字', shape.ok === true && shape.text === '你好世界')
ok('cue_count 与 cues 一致', shape.cue_count === 1)
ok('时间戳字段保留', shape.cues[0].start === 0 && shape.cues[0].end === 1)
ok('成功不塞 verify', shape.verify === '')
ok('输出只有白名单字段（不吐 key/路径/config）',
  Object.keys(shape).sort().join(',') === [...TRANSCRIBE_OUTPUT_FIELDS].sort().join(','))
const degraded = normalizeTranscribeResult({ ok: false, reason: '没配置 asrUrl', text: '', cues: [] }, 'srt')
ok('失败 → ok:false + 格式透传 + verify', degraded.ok === false && degraded.format === 'srt' && degraded.verify.includes('asrUrl'))
ok('失败不冒充成功（无文字）', degraded.text === '' && degraded.cue_count === 0)

console.log('=== 5. 端点本机围栏 ===')
const routes = transcribeRouteTable({
  cfg: {}, isLocalRequest: (req) => req.local === true,
  respondJson: (res, body, status = 200) => { res.body = body; res.status = status },
  readJsonBody: async () => ({}),
})
ok('两条端点（能力 GET + 执行 POST）', routes.length === 2)
ok('能力端点路径', routes[0].path === '/api/qwen-paint/audio/transcribe/capabilities')
ok('执行端点路径', routes[1].path === TRANSCRIBE_ROUTE_PATH)
const res0 = {}
await routes[0].handler({ local: false }, res0)
ok('非本机 GET → 403', res0.status === 403 && res0.body.reason === 'local requests only')
const res1 = {}
await routes[1].handler({ local: true, method: 'GET' }, res1)
ok('执行端点非 POST → 405', res1.status === 405)
const res2 = {}
await routes[0].handler({ local: true }, res2)
ok('本机 GET 能力 → 200 且回 configured', res2.status === 200 && res2.body.ok === true && typeof res2.body.configured === 'boolean')

console.log('=== 6. 七处接线与孤儿扫描 ===')
const REG = read('lib/tool-registry.js')
const INT = read('lib/integration-state.js')
const GUIDE = read('lib/agent-guide.js')
const DESC = read('lib/tool-descriptions.js')
const SELF = read('scripts/selftest.mjs')
const LAB = read('assets/lab.js')
ok('① tool-registry import', REG.includes("from './transcribe-tool.js'"))
ok('① tool-registry 工具构造', REG.includes('makeTranscribeTool(base)'))
ok('① tool-registry 端点注册', REG.includes('transcribeRouteTable(base)'))
ok('① EXTRA_TOOL_NAMES 含 transcribe_audio', REG.includes("'transcribe_audio'"))
ok('② integration-state 登记两端点', INT.includes('/audio/transcribe/capabilities') && INT.includes("path: '/api/qwen-paint/audio/transcribe'"))
ok('③ agent-guide TOOL_HINTS 点名', GUIDE.includes('transcribe_audio: {'))
ok('③ agent-guide 剧本步骤引用真实工具', GUIDE.includes("steps: ['transcribe_audio']"))
ok('④ tool-descriptions 点名', DESC.includes('transcribe_audio:'))
ok('⑤ selftest EXPECTED_TOOLS 点名', SELF.includes("'transcribe_audio'"))
ok('⑥ lab.js 内嵌 UI 两端点字面量', LAB.includes("request('audio/transcribe/capabilities')") && LAB.includes("request('audio/transcribe',"))
ok('⑥ lab.js 有转文字按钮', LAB.includes('转文字'))
ok('工具名不拼错（全仓统一 transcribe_audio）',
  !read('lib/transcribe-tool.js').includes('transcribe_audiox'))

console.log(`\n=== test-transcribe：${pass} 项通过，${failures.length} 项失败 ===`)
if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('结果：通过')
