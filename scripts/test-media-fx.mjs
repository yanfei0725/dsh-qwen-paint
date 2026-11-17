/**
 * 断言风格：ok(名称, 条件)。全离线、零子进程（注入假 mediaExec）。
 * 覆盖：三条 argv 构建（纯函数）/ 数值 clamp / 双围栏 / 降级诚实 / 端点 / 七处接线 / 孤儿扫描。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEDIA_FX_TOOL_NAMES, MEDIA_FX_ROUTE_PATHS, AUDIO_FX_PRESETS, CUTOUT_KEY_COLORS,
  buildAudioFxArgs, buildCutoutArgs, buildSplitArgs,
  makeEnhanceAudioTool, makeCutoutTool, makeSplitAudioTool, mediaFxRouteTable,
} from '../lib/media-fx.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond, extra) => {
  if (cond) pass++
  else failures.push(name + (extra ? ' | ' + extra : ''))
}
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

const OUT = path.join(ROOT, 'output')
const SRC = path.join(OUT, 'media-fx-fixture')
const fakeExec = (calls, okRun = true) => ({
  probe: async () => ({ available: true, source: 'test', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
  runCommand: async (cmd, opts) => {
    calls.push({ cmd, opts })
    return { ok: okRun, probed: true, reason: okRun ? 'ok' : 'fail', command: cmd }
  },
})

console.log('=== 1. 音频后处理 argv 构建（纯函数）===')
{
  const cmd = buildAudioFxArgs('in.wav', 'out.m4a', { preset: 'voice', trim_silence: true, deess: true, denoise: true })
  const af = cmd[cmd.indexOf('-af') + 1]
  ok('voice 预设用 speechnorm（语音响度）', af.includes('speechnorm=e=5:l=1'))
  ok('l=1 是 boolean（不再是错误的 l=5）', !/speechnorm[^,]*l=5/.test(af))
  ok('去静音链在', af.includes('silenceremove='))
  ok('降噪链在', af.includes('afftdn=nr='))
  ok('去齿音链在', af.includes('deesser'))
  ok('music 预设用 loudnorm（EBU R128）', buildAudioFxArgs('a', 'b', { preset: 'music' })[0] === 'ffmpeg'
    && buildAudioFxArgs('a', 'b', { preset: 'music' }).join(' ').includes('loudnorm=I=-16:TP=-1.5:LRA=11'))
  ok('loudnorm 目标可覆盖', buildAudioFxArgs('a', 'b', { loudness: true, loudness_target: -14 }).join(' ').includes('loudnorm=I=-14'))
  ok('eq 三频段都在', buildAudioFxArgs('a', 'b', { eq: true }).join(' ').includes('equalizer=f=3000'))
  ok('全关时无 -af（不塞空滤镜）', !buildAudioFxArgs('a', 'b', {}).includes('-af'))
  ok('数值 clamp：expansion 上界 50', buildAudioFxArgs('a', 'b', { preset: 'voice', expansion: 999 }).join(' ').includes('speechnorm=e=50:'))
  ok('数值 clamp：loudness_target 下界 -30', buildAudioFxArgs('a', 'b', { loudness: true, loudness_target: -99 }).join(' ').includes('loudnorm=I=-30'))
  ok('codec/bitrate 可指定', buildAudioFxArgs('a', 'b', { codec: 'libmp3lame', bitrate: '256k' }).includes('libmp3lame'))
  ok('preset 白名单：voice/music/podcast', AUDIO_FX_PRESETS.voice.length === 4
    && AUDIO_FX_PRESETS.music.length === 1 && AUDIO_FX_PRESETS.podcast.length === 3)
}

console.log('=== 2. 抠图 / 声源分离 argv（纯函数）===')
{
  const cmd = buildCutoutArgs('in.png', 'out.png', { key_color: 'green', similarity: 0.3, mask: '/abs/m.png' })
  const vf = cmd[cmd.indexOf('-vf') + 1]
  ok('绿幕用 chromakey', vf.includes('chromakey=green:0.3'))
  ok('有蒙版时叠 alphamerge', vf.includes('alphamerge=inputs=2'))
  ok('有蒙版时多一个 -i 输入', cmd.filter((x) => x === '-i').length === 2)
  ok('白幕用 colorkey', buildCutoutArgs('a', 'b', { key_color: 'white' })[0]
    && buildCutoutArgs('a', 'b', { key_color: 'white' }).join(' ').includes('colorkey=white'))
  ok('非法 key_color 回落 white', buildCutoutArgs('a', 'b', { key_color: 'purple' }).join(' ').includes('colorkey=white'))
  ok('无蒙版时不加 alphamerge', !buildCutoutArgs('a', 'b', {}).join(' ').includes('alphamerge'))
  ok('similarity clamp 上界 1', buildCutoutArgs('a', 'b', { similarity: 9 }).join(' ').includes(':1:'))
  ok('key 色白名单 5 色', CUTOUT_KEY_COLORS.join(',') === 'white,black,green,blue,red')

  const split = buildSplitArgs('in.mp3', 'v.mp3', 'm.mp3', {})
  ok('声源分离用 asplit+pan', split.join(' ').includes('asplit=2') && split.join(' ').includes('pan=stereo'))
  ok('人声支路 c0=FL-FR', split.join(' ').includes('c0=FL-FR|c1=FL-FR'))
  ok('伴奏支路 c1=FR-FL（中置相消）', split.join(' ').includes('c0=FL-FR|c1=FR-FL'))
  ok('两路各自 -map 输出', split.filter((x) => x === '-map').length === 2)
  ok('argv 全字符串（不拼 shell）', [...cmd, ...split].every((x) => typeof x === 'string'))
}

console.log('=== 3. 工具执行：围栏 / 降级 / 成功 ===')
{
  const calls = []
  const exec = fakeExec(calls)
  const deps = { outputDir: OUT, sourceDirs: [SRC], mediaExec: exec, log: () => {} }

  const audio = makeEnhanceAudioTool(deps)
  ok('enhance_audio 名字对', audio.name === 'enhance_audio')
  ok('schema 关额外字段', audio.parameters.additionalProperties === false)
  const a0 = await audio.execute({ source: path.join(path.parse(ROOT).root, 'Windows', 'System32', 'nope.wav'), target: 'a.m4a' })
  ok('源不在允许目录（绝对越界）→ 拒绝', !a0.ok && !a0.executed && a0.reason.includes('源目录'))
  const a1 = await audio.execute({ source: '../evil.wav', target: 'a.m4a' })
  ok('源 .. 穿越 → 拒绝', !a1.ok && a1.reason.includes('..'))
  const a2 = await audio.execute({ source: 'in.wav', target: '../evil.m4a' })
  ok('输出 .. 穿越 → 拒绝', !a2.ok && a2.reason.includes('..'))
  const a3 = await audio.execute({ source: 'in.wav', target: 'a.m4a', preset: 'voice' })
  ok('合法调用 → 执行', a3.ok && a3.executed && !a3.degraded)
  ok('执行传的是 argv 数组', Array.isArray(calls[calls.length - 1].cmd))

  const cut = makeCutoutTool(deps)
  const c0 = await cut.execute({ source: 'in.png', target: 'a.jpg', format: 'jpg' })
  ok('抠图输出 jpg（无 alpha）→ 拒绝', !c0.ok && c0.reason.includes('alpha'))
  const c1 = await cut.execute({ source: 'in.png', target: 'a.png', mask: '../m.png' })
  ok('蒙版 .. 穿越 → 拒绝', !c1.ok && c1.reason.includes('蒙版'))
  const c2 = await cut.execute({ source: 'in.png', target: 'a.png', key_color: 'green' })
  ok('合法抠图 → 执行', c2.ok && c2.executed)

  const splitT = makeSplitAudioTool(deps)
  const s0 = await splitT.execute({ source: 'in.mp3', vocals_target: '../v.mp3', music_target: 'm.mp3' })
  ok('人声输出越界 → 拒绝', !s0.ok)
  const s1 = await splitT.execute({ source: 'in.mp3' })
  ok('合法分离 → 执行', s1.ok && s1.executed && s1.path.includes('|'))

  // 未注入执行器 → 降级 + 参数预览
  const offline = makeEnhanceAudioTool({ outputDir: OUT, sourceDirs: [SRC], log: () => {} })
  const d0 = await offline.execute({ source: 'in.wav', target: 'a.m4a', preset: 'voice' })
  ok('无执行器 → degraded + preview', d0.degraded && d0.preview && d0.command.length > 0)
  ok('降级不谎称已执行', !d0.ok && !d0.executed)
  ok('降级原因不含本机绝对路径', !d0.reason.includes(ROOT))

  // 执行失败 → 固定文案，不回吐 error.message
  const failExec = fakeExec([], false)
  const f0 = await makeSplitAudioTool({ ...deps, mediaExec: failExec }).execute({ source: 'in.mp3' })
  ok('执行失败 → degraded', f0.degraded && !f0.ok)
  ok('失败原因固定文案（不回吐异常）', f0.reason.length > 0 && !f0.reason.includes('C:'))
  const throwExec = { probe: async () => ({ available: true }), runCommand: async () => { throw new Error('SECRET /\x43:/Users/x') } }
  const f1 = await makeEnhanceAudioTool({ ...deps, mediaExec: throwExec }).execute({ source: 'in.wav', target: 'a.m4a' })
  ok('抛异常 → 固定文案不泄漏路径', f1.degraded && !f1.reason.includes('C:') && !f1.reason.includes('SECRET'))
}

console.log('=== 4. 端点表 ===')
{
  const calls = []
  const routes = mediaFxRouteTable({ outputDir: OUT, sourceDirs: [SRC], mediaExec: fakeExec(calls), log: () => {} })
  ok('4 条端点', routes.length === 4)
  ok('路径常量与实际路由一致', MEDIA_FX_ROUTE_PATHS.every((p) => routes.some((r) => r.path === p)))
  const cap = routes[0]
  const capRes = { setHeader() {}, end(body) { this._b = body } }
  await cap.handler({}, capRes)
  const capBody = JSON.parse(capRes._b)
  ok('能力端点列 3 个工具', capBody.tools.join(',') === MEDIA_FX_TOOL_NAMES.join(','))
  ok('能力端点带 ffmpeg 状态', ['available', 'unavailable', 'undetected'].includes(capBody.ffmpeg))
  ok('能力端点 note 写明诚实边界', capBody.note.includes('纯色背景') && capBody.note.includes('近似'))
  // 测 postOnly 分支（method 非 POST → 405）
  const badRes = { setHeader() {}, end(body) { this._b = body }, statusCode: 200 }
  await routes[1].handler({ method: 'GET', on() {} }, badRes)
  ok('非 POST → 405', badRes.statusCode === 405)
}

console.log('=== 5. 联动接线 / 孤儿扫描 ===')
{
  const registry = read('lib/tool-registry.js')
  for (const n of MEDIA_FX_TOOL_NAMES) {
    ok('tool-registry 注册 ' + n, registry.includes(`make${n[0].toUpperCase()}${n.slice(1)}Tool`)
      || registry.includes(n) || /make(EnhanceAudio|Cutout|SplitAudio)Tool/.test(registry))
  }
  ok('tool-registry import media-fx', registry.includes('./media-fx.js'))
  ok('tool-registry 挂 mediaFxRouteTable', registry.includes('mediaFxRouteTable'))
  ok('EXTRA_TOOL_NAMES 含三工具', registry.includes('enhance_audio') && registry.includes('cutout_image') && registry.includes('split_audio'))
  const integ = read('lib/integration-state.js')
  ok('integration-state 登记端点', integ.includes('enhance/audio') || integ.includes('media-fx'))
  const guide = read('lib/agent-guide.js')
  ok('agent-guide TOOL_HINTS 点名三工具', MEDIA_FX_TOOL_NAMES.every((n) => guide.includes(n)))
  const desc = read('lib/tool-descriptions.js')
  ok('tool-descriptions 点名三工具', MEDIA_FX_TOOL_NAMES.every((n) => desc.includes(n)))
  const selftest = read('scripts/selftest.mjs')
  ok('selftest 点名三工具', MEDIA_FX_TOOL_NAMES.every((n) => selftest.includes(`'${n}'`)))
  const lab = read('assets/lab.js')
  ok('lab.js 有三工具 UI 消费者', lab.includes('enhance_audio') || lab.includes('media-fx'))
  const all = read('scripts/test-all.mjs')
  ok('test-all 登记 test-media-fx', all.includes('test-media-fx.mjs'))
}

if (failures.length) {
  console.error('\n失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log(`\n=== test-media-fx：结果：全部通过（${pass} 项通过，0 项失败） ===`)
