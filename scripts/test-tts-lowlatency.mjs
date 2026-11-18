#!/usr/bin/env node
/**
 * test-tts-lowlatency.mjs —— 外部 TTS 低延迟编排的离线回归（2026-11-17）
 *   ① 语义分块：标点/长度切分、首块缩短降首音延迟、空文本降级；
 *   ② 回环围栏：serviceBase 只接受 127.0.0.1/localhost/::1，拒绝外部 host；
 *   ③ 两种 API 格式：gsv=/tts 平铺、openai=/v1/audio/speech 嵌套；
 *   ④ 探活：online/离线/异常都结构化返回，不抛、不假装在线；
 *   ⑤ 许可证与引导：AnifLive 标禁商用、GSV 标 MIT、都带引导、不捆绑；
 *   ⑥ 生产接线：工具/端点/UI 都有真实消费点，非孤儿。
 * ok() 采用 (name, cond, extra) 风格；全程离线：假 fetch，零真实服务/网络。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) } else { fail++; console.log('  FAIL', name, extra ?? '') }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

const m = await imp('lib/tts-lowlatency.js')

section('① 语义分块（抄通用思路，非任何项目代码）')
{
  const r = m.planLowLatencyTts('今天天气真好。我们在公园散步吧！然后回家。', { maxChars: 60, firstChars: 24 })
  ok('按句末标点切块', r.ok && r.count === 3, JSON.stringify(r))
  const long = m.planLowLatencyTts('这是很长的一段没有标点的话'.repeat(8), { maxChars: 30 })
  ok('无标点长句按长度兜底', long.ok && long.chunks.every((c) => c.length <= 30), JSON.stringify(long.count))
  const short = m.planLowLatencyTts('你好。', { firstChars: 24 })
  ok('短文本不被强行再切', short.ok && short.count === 1, JSON.stringify(short))
  ok('空文本明确降级', m.planLowLatencyTts('   ').ok === false)
  const f = m.planLowLatencyTts('甲乙丙丁。后续内容还很长足以超过首块上限需要切开看效果。', { maxChars: 80, firstChars: 3 })
  ok('首块缩短到 firstChars', f.ok && f.firstChunk.length <= 3, JSON.stringify(f.firstChunk))
}

section('①b 两段式早出声规划 + 首段事件 store')
{
  const two = m.planTwoStageTts('今天天气真好啊我们一起去公园散步行不行呀然后顺便买点吃的东西回家吧。', { firstChars: 6 })
  ok('两段式恰好切 2 段', two.ok && two.chunks.length === 2, JSON.stringify(two))
  ok('两段拼接回原文（无丢字）', two.ok && two.chunks.join('') === '今天天气真好啊我们一起去公园散步行不行呀然后顺便买点吃的东西回家吧。')
  ok('首段不超过 firstChars 附近（标点优先）', two.ok && two.firstChars <= 7, JSON.stringify(two.firstChars))
  const punct = m.planTwoStageTts('你好。后面的内容还很长足以构成第二段并且超过首块长度限制没问题。', { firstChars: 24 })
  ok('优先在句末标点断开', punct.ok && punct.chunks[0].endsWith('。'), JSON.stringify(punct.chunks[0]))
  ok('空文本降级', m.planTwoStageTts('   ').ok === false)
  const store = m.createTtsLiveStore({ ttlMs: 1000 })
  ok('无事件时快照为 null', store.snapshot() === null)
  store.publish('C:/out/p0.mp3', { bytes: 123, of: 1, total: 2 })
  const snap = store.snapshot()
  ok('publish 后带出 path/url/进度', !!snap && snap.path === 'C:/out/p0.mp3' && /api\/qwen-paint\/file\?path=/.test(snap.url) && snap.of === 1, JSON.stringify(snap))
  store.clear()
  ok('clear 后快照为 null', store.snapshot() === null)
}

section('② 回环围栏（数据只走本机）')
{
  const gsv = m.EXTERNAL_TTS_SERVICES.find((s) => s.id === 'gsv_cpp')
  ok('127.0.0.1 放行', m.serviceBase(gsv, { host: '127.0.0.1', port: 9880 }) === 'http://127.0.0.1:9880')
  ok('localhost 放行', m.serviceBase(gsv, { host: 'localhost', port: 1234 }) === 'http://localhost:1234')
  ok('外部域名拒绝', m.serviceBase(gsv, { host: 'evil.example.com', port: 9880 }) === '')
  ok('局域网 IP 拒绝', m.serviceBase(gsv, { host: '192.168.1.5', port: 9880 }) === '')
  ok('非法端口拒绝', m.serviceBase(gsv, { host: '127.0.0.1', port: 99999 }) === '')
  ok('默认端口兜底', m.serviceBase(gsv, { host: '127.0.0.1' }) === 'http://127.0.0.1:9880')
}

section('③ 两种 API 请求格式')
{
  const gsv = m.EXTERNAL_TTS_SERVICES.find((s) => s.id === 'gsv_cpp')
  const anif = m.EXTERNAL_TTS_SERVICES.find((s) => s.id === 'aniflive')
  const r1 = m.buildSynthRequest(gsv, { text: '你好', language: 'zh' })
  ok('gsv 走 /tts', r1.path === '/tts' && r1.method === 'POST')
  ok('gsv body 平铺含 text', JSON.parse(r1.body).text === '你好' && JSON.parse(r1.body).stream === false)
  const r2 = m.buildSynthRequest(anif, { text: 'hi', voice: 'v1', language: 'en', stream: true })
  ok('aniflive 走 /v1/audio/speech', r2.path === '/v1/audio/speech')
  ok('openai body 含 input/voice/stream', (() => { const b = JSON.parse(r2.body); return b.input === 'hi' && b.voice === 'v1' && b.stream === true })())
}

section('④ 探活结构化降级')
{
  const gsv = m.EXTERNAL_TTS_SERVICES.find((s) => s.id === 'gsv_cpp')
  const anif = m.EXTERNAL_TTS_SERVICES.find((s) => s.id === 'aniflive')
  // ★ 2026-11-19：真 GSV health 形状（本机实录 {"engine":"ready","ok":true,...}）。
  const okFetch = async () => ({ ok: true, status: 200, text: async () => '{"engine":"ready","ok":true,"sidecar":true}' })
  const otherFetch = async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' })
  const badFetch = async () => ({ ok: false, status: 503 })
  const errFetch = async () => { throw new Error('ECONNREFUSED') }
  const p1 = await m.probeExternalTts(gsv, { fetch: okFetch })
  ok('服务在线（health 含 engine 标记）', p1.online === true && p1.ok === true)
  const p2 = await m.probeExternalTts(gsv, { fetch: badFetch })
  ok('HTTP 异常报 offline 不抛', p2.online === false && /503/.test(p2.reason))
  const p3 = await m.probeExternalTts(gsv, { fetch: errFetch })
  ok('连不上报 offline 不抛', p3.online === false && /ECONNREFUSED/.test(p3.reason))
  const p4 = await m.probeExternalTts(gsv, { host: 'evil.com', fetch: okFetch })
  ok('外部 host 直接拒绝不探', p4.online === false && /回环/.test(p4.reason))
  const p5 = await m.probeExternalTts(gsv, {})
  ok('无 fetch 明确降级', p5.online === false && /fetch/.test(p5.reason))
  // ★ 2026-11-19 端口撞车标记校验（本机实录：GSV.CPP 在线后 AnifLive 误报在线）：
  const p6 = await m.probeExternalTts(anif, { fetch: okFetch })
  ok('aniflive 探到 GSV 应答（含 engine）判 offline 不误报',
    p6.online === false && /已被另一外部 TTS/.test(p6.reason))
  const p7 = await m.probeExternalTts(anif, { fetch: otherFetch })
  ok('aniflive 探到自己的应答（无 engine）在线',
    p7.online === true && p7.ok === true)
}

section('④b 分块音频拼接 argv（纯函数）')
{
  const r = m.buildAudioConcatArgv({ files: ['a.mp3', 'b.mp3'], listFile: '/tmp/list.txt', out: '/tmp/out.m4a', ffmpeg: 'ffmpeg' })
  ok('≥2 段才拼', r.ok === true && r.argv.includes('concat'))
  ok('清单内容逐行 file 指令', r.listContent.split('\n').filter(Boolean).length === 2 && /^file '/.test(r.listContent))
  ok('-safe 0 允许绝对路径', r.argv.includes('-safe') && r.argv.includes('0'))
  ok('输出 m4a/aac 重编码统一', r.argv[r.argv.length - 1] === '/tmp/out.m4a' && r.argv.includes('aac'))
  ok('不足 2 段拒绝', m.buildAudioConcatArgv({ files: ['a.mp3'], listFile: 'x', out: 'y' }).ok === false)
  ok('路径含单引号被转义', /\\'/.test(m.buildAudioConcatArgv({ files: ["a'b.mp3", 'b.mp3'], listFile: 'x', out: 'y' }).listContent))
  ok('note 诚实标注不承诺首音倍率', /不声称首音倍率/.test(r.note) && /语气可能不连贯/.test(r.note))
}

section('⑤ 许可证与引导（合规边界）')
{
  const list = m.listExternalTtsServices()
  ok('恰好两个外部服务', list.length === 2)
  const gsv = list.find((s) => s.id === 'gsv_cpp')
  const anif = list.find((s) => s.id === 'aniflive')
  ok('GSV.CPP 标 MIT', /MIT/.test(gsv.license))
  ok('AnifLive 标禁商用', /Noncommercial|禁止商用/.test(anif.license), anif.license)
  ok('两者都带安装引导', gsv.guide.length > 20 && anif.guide.length > 20)
  ok('AnifLive 引导含商用授权提醒', /授权|商用/.test(anif.guide))
  ok('GSV 引导含不代下声明', /不代下|自行下载/.test(gsv.guide))
  const src = read('lib/tts-lowlatency.js')
  ok('不捆绑二进制/权重：不 import fs/child_process、不写下载',
    !/node:fs|node:child_process|execFile|spawn|download|mkdir|writeFile/u.test(src))
}

section('⑥ 生产接线（非孤儿）')
{
  const creative = read('lib/creative-extras.js')
  ok('list_tts_backends 工具消费服务清单', /external_services: listExternalTtsServices\(\)/.test(creative))
  ok('HTTP 端点真实探活', /probeExternalTts\(s,/.test(creative))
  const lab = read('assets/lab.js')
  ok('lab 语音卡提示外部服务+禁商用', /AnifLive-TTS（PolyForm 禁商用/.test(lab))
  const notes = read('docs/tts-lowlatency-design-notes.md')
  ok('设计注记含许可证边界', /PolyForm Noncommercial/.test(notes) && /3\.16 GB/.test(notes))
  const speech = read('lib/speech-tool.js')
  ok('★ lowLatencyChunks 默认 false（零漂移）', /lowLatencyChunks = false/.test(speech))
  ok('分块走 planTwoStageTts（首段短+剩余整段）+ synthOne 复用',
    /planTwoStageTts\(body\)/.test(speech) && /synthOne\(/.test(speech))
  ok('分块产物拼接用 buildAudioConcatArgv', /buildAudioConcatArgv\(/.test(speech))
  ok('缓存键区分分块/整段（不撞键）', /lowLatencyChunks === true \? 'chunks' : 'whole'/.test(speech))
  ok('attention 参数透传三链', /prefix, attention \}\)/.test(speech) && /prefix, attention,/.test(speech))
  // ★ 首段早出声链路（悬浮面板）
  ok('speech 首段落盘即推 onFirstChunk', /i === 0 && typeof onFirstChunk === 'function'/.test(speech))
  ok('★ 首段事件在整段 concat 之前推出（早出声时序）',
    speech.indexOf("if (i === 0 && typeof onFirstChunk === 'function')") < speech.indexOf('const concat = buildAudioConcatArgv'))
  const index = read('lib/index.js')
  ok('index 建 ttsLiveStore 单例', /createTtsLiveStore\(\)/.test(index))
  ok('makeSpeechDeps 注入 onFirstChunk', /onFirstChunk: \(filePath, meta\) => ttsLiveStore\.publish/.test(index))
  ok('progress 响应带出 ttsLive', /const ttsLive = ttsLiveStore\.snapshot\(\)/.test(index) && /ttsLive \}/.test(index))
  const panel = read('assets/panel.js')
  ok('悬浮面板消费 ttsLive 播放', /playTtsLive\(j\.ttsLive\)/.test(panel) && /new Audio\(\)/.test(panel))
  const fileRoute = read('lib/file-route.js')
  ok('文件路由支持音频 MIME（含 m4a）', /'\.m4a': 'audio\/mp4'/.test(fileRoute))
  ok('ffmpeg 缺失明确报，不静默', /低延迟分块需要 ffmpeg/.test(speech))
  // 外置注释逐字可追溯
  for (const name of ['comfy-catalog', 'cpu-endpoints', 'media-convert-tool', 'job-tool']) {
    ok('锚点存在:' + name, notes.includes('tts-lowlatency-space-' + name))
  }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exitCode = 1
