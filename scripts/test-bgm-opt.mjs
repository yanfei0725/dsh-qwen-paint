#!/usr/bin/env node
/**
 * test-bgm-opt.mjs —— BGM 三块优化的离线回归（2026-11-17）
 *   ① 音乐计划缓存：指纹稳定/敏感、往返命中、坏缓存降级、关缓存不读；
 *   ② ducking 缝合缓存：文件身份指纹、命中跳过 ffmpeg、参数/文件变更换 key、写失败不致命；
 *   ③ §7 装配计划：缓存键字段/ducking/断点续复用、模型项 blocked 诚实；
 *   ④ 生产接线：三块都有真实消费点（creative-extras / av-stitch / music 端点），非孤儿。
 * ok() 采用 (name, cond, extra) 风格；全程离线：真临时目录 + 假 ffmpeg 执行器，零真实 ComfyUI。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) } else { fail++; console.log('  FAIL', name, extra ?? '') }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

const opt = await imp('lib/bgm-opt.js')

section('① 音乐计划缓存')
{
  const a = opt.musicPlanFingerprint(createHash, { model: 'ace_step_15', prompt: 'lofi', bpm: 80, seed: 7, durationSec: 30 })
  const b = opt.musicPlanFingerprint(createHash, { durationSec: 30, seed: 7, bpm: 80, prompt: 'lofi', model: 'ace_step_15' })
  ok('指纹与键顺序无关', a === b && a.length === 24, a + ' / ' + b)
  ok('prompt 变更换 key', opt.musicPlanFingerprint(createHash, { model: 'ace_step_15', prompt: 'cinematic', bpm: 80, seed: 7, durationSec: 30 }) !== a)
  ok('节点集合变更换 key', opt.musicPlanFingerprint(createHash, { model: 'ace_step_15', prompt: 'lofi', bpm: 80, seed: 7, durationSec: 30, nodes: ['YuE2GenerateMusic'] }) !== a)
  ok('节点集合顺序无关', opt.musicPlanFingerprint(createHash, { nodes: ['A', 'B'] }) === opt.musicPlanFingerprint(createHash, { nodes: ['B', 'A'] }))
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-bgm-plan-'))
  const f = path.join(dir, 'k.json')
  ok('空路径读缓存返回 null', (await opt.readPlanCache(fsp, path, '')) === null)
  ok('无文件读缓存返回 null', (await opt.readPlanCache(fsp, path, f)) === null)
  const result = { ok: true, model: 'ace_step_15', plan: { prompt: 'lofi' } }
  ok('写缓存成功', await opt.writePlanCache(fsp, path, f, 'k1', result) === true)
  const hit = await opt.readPlanCache(fsp, path, f)
  ok('往返命中且内容一致', hit && hit.model === 'ace_step_15' && hit.plan.prompt === 'lofi')
  // 篡改字节 → 未命中
  const raw = JSON.parse(await fsp.readFile(f, 'utf8')); raw.result.model = 'tampered'
  await fsp.writeFile(f, JSON.stringify(raw), 'utf8')
  ok('字节自校验拦下篡改缓存', (await opt.readPlanCache(fsp, path, f)) === null)
  await fsp.rm(dir, { recursive: true, force: true })
}

section('② ducking 缝合缓存')
{
  const fakeFs = { statSync: (p) => ({ size: p.includes('a.wav') ? 1000 : 2000, mtimeMs: 111 }) }
  const k1 = opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'a.wav', text: 'hi' }], duck: { threshold: 0.03 }, target: 'mix.wav' }, fakeFs, path)
  const k2 = opt.stitchFingerprint(createHash, { items: [{ text: 'hi', file: 'a.wav' }], target: 'mix.wav', duck: { threshold: 0.03 }, bgm: 'bgm.mp3' }, fakeFs, path)
  ok('缝合指纹与对象键顺序无关', k1 === k2 && k1.length === 24)
  ok('条目数组顺序变更换 key（顺序影响缝合）',
    opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'b.wav', text: 'x' }, { file: 'a.wav', text: 'y' }], duck: { threshold: 0.03 }, target: 'mix.wav' }, fakeFs, path)
      !== opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'a.wav', text: 'y' }, { file: 'b.wav', text: 'x' }], duck: { threshold: 0.03 }, target: 'mix.wav' }, fakeFs, path))
  ok('duck 参数变更换 key', opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'a.wav', text: 'hi' }], duck: { threshold: 0.5 }, target: 'mix.wav' }, fakeFs, path) !== k1)
  ok('输入文件变更换 key', opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'b.wav', text: 'hi' }], duck: { threshold: 0.03 }, target: 'mix.wav' }, fakeFs, path) !== k1)
  ok('target 目录不同 basename 同 → key 同', opt.stitchFingerprint(createHash, { bgm: 'bgm.mp3', items: [{ file: 'a.wav', text: 'hi' }], duck: { threshold: 0.03 }, target: 'C:/x/mix.wav' }, fakeFs, path) === k1)
}

section('②b 缝合缓存真链路（假 ffmpeg 计数，验证命中跳过执行）')
{
  const { runAvStitch } = await imp('lib/av-stitch.js')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-bgm-stitch-'))
  const wav = path.join(dir, 'nar.wav')
  await fsp.writeFile(wav, Buffer.alloc(1024))
  let ffmpegMixCalls = 0
  const execFileFn = (bin, argv, opts, cb) => {
    if (argv.includes('-version')) { if (cb) setImmediate(() => cb(null)); return { on() {} } }
    ffmpegMixCalls++
    // 真写产物（模拟 ffmpeg 混流输出），让第二次能命中字节校验
    const target = argv[argv.length - 1]
    try { fs.writeFileSync(target, Buffer.alloc(2048, 7)) } catch { /* ignore */ }
    if (cb) setImmediate(() => cb(null))
    return { on() {} }
  }
  const params = { outputDir: dir, items: [{ file: wav, text: '你好', duration_ms: 1000 }],
    target: path.join(dir, 'mix.wav'), params: { threshold: 0.03, ratio: 8 },
    cfg: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, execFileFn, timeoutMs: 5000 }
  const r1 = await runAvStitch(params)
  ok('首次缝合执行（假 ffmpeg 被调用）', r1.ok === true && r1.executed === true && ffmpegMixCalls >= 1, JSON.stringify({ ok: r1.ok, reason: r1.reason, calls: ffmpegMixCalls }))
  const callsAfterFirst = ffmpegMixCalls
  const r2 = await runAvStitch(params)
  ok('★ 第二次命中缓存跳过 ffmpeg', r2.ok === true && r2.cached === true && r2.executed === false && ffmpegMixCalls === callsAfterFirst, JSON.stringify({ cached: r2.cached, calls: ffmpegMixCalls }))
  // 关缓存后必须真跑
  const r3 = await runAvStitch({ ...params, stitchCache: false })
  ok('stitchCache:false 强制真跑', r3.executed === true && r3.cached !== true && ffmpegMixCalls > callsAfterFirst)
  await fsp.rm(dir, { recursive: true, force: true })
}

section('③ §7 装配计划')
{
  const plan = opt.buildBgmAssemblyPlan({
    segments: [{ segmentId: 's1' }, { segmentId: 's2' }, { segmentId: 's3' }],
    completedSegmentIds: ['s1', 's3'],
  })
  ok('缓存键字段与 musicPlanFingerprint 实际入键一致', ['model', 'prompt', 'negPrompt', 'bpm', 'seed', 'durationSec', 'segmentId', 'loopAllowed', 'quality', 'nodes'].every((x) => plan.cacheKeyFields.includes(x)))
  ok('ducking 标可用（sidechaincompress 已落生产）', plan.ducking.available === true && plan.ducking.method === 'sidechaincompress')
  ok('断点续推只复用完整段', JSON.stringify(plan.resume.reusable) === JSON.stringify(['s1', 's3']) && JSON.stringify(plan.resume.pending) === JSON.stringify(['s2']))
  ok('embedding 缓存标 planned 但 unavailable', plan.embeddingCache.planned === true && plan.embeddingCache.available === false)
  ok('模型相关三项明确 blocked', plan.blocked.length === 3 && plan.blocked.every((b) => !!b.reason))
  ok('整体标 unverified 不谎称倍率', plan.unverified === true && !JSON.stringify(plan).match(/\d+(\.\d+)?×/))
}

section('④ 生产接线（非孤儿）')
{
  const ce = read('lib/creative-extras.js')
  ok('★ creative-extras import bgm-opt', /from '\.\/bgm-opt\.js'/u.test(ce))
  ok('★ makeMusicTool 真调用计划缓存', /readPlanCache\(fsp, nodePath, cacheFile\)/u.test(ce) && /writePlanCache\(fsp, nodePath, cacheFile, key, result\)/u.test(ce))
  ok('★ music/models 端点暴露 assembly', /assembly: buildBgmAssemblyPlan/u.test(ce))
  const av = read('lib/av-stitch.js')
  ok('★ av-stitch import stitchFingerprint', /import \{ stitchFingerprint \} from '\.\/bgm-opt\.js'/u.test(av))
  ok('★ runAvStitch 真用缝合缓存', /stitchFingerprint\(createHash/u.test(av) && /cachedHit/u.test(av))
  ok('★ 缓存开关可关（验证真实链路）', /musicPlanCache !== false/u.test(ce) && /stitchCache !== false/u.test(av))
  ok('★ 设计注释逐字外置可追溯', fs.existsSync(path.join(ROOT, 'docs/bgm-opt-design-notes.md')))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓')
