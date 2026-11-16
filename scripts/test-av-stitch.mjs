/**
 * test-av-stitch.mjs —— 轻量缝合（旁白时间轴 + BGM ducking + SRT）专项回归。
 *
 * 断言风格：ok(名称, 条件)。全离线、零联网、零真 ffmpeg 调用（全部注入假 execFile），
 * tmp 目录用完即删。覆盖：围栏 / 时间轴 / SRT / argv 构造（ducking + amix normalize=0）/
 * 执行诚实边界（ffmpeg 不可用绝不谎称）/ 工具与文档点名同步 / 体积红线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildNarrationTimeline, buildSrtFromTimeline, buildStitchArgs, runAvStitch, makeMixNarrationTool,
} from '../lib/av-stitch.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('✓ ' + name); return }
  fail += 1
  fails.push(name)
  console.log('✗ ' + name, extra ?? '')
}
ok('自检：本文件 ok() 是「名称, 条件」顺序（写反自检占位）', true)

/* ---------------- §1 时间轴（纯函数） ---------------- */

const tl = buildNarrationTimeline({ items: [{ file: 'a.wav', text: '你好' }, { file: 'b.wav', text: '世界' }], durationsMs: [2000, 1500] })
ok('时间轴顺序铺放：start 0 / 2300（含 300ms 间隔）', tl.ok === true && tl.timeline[0].startMs === 0 && tl.timeline[1].startMs === 2300)
ok('总时长 = 最后条目结束', tl.totalMs === 3800)
ok('空条目 → ok:false', buildNarrationTimeline({ items: [] }).ok === false)
ok('缺时长 → ok:false 且给原因', buildNarrationTimeline({ items: [{ file: 'a' }] }).ok === false
  && String(buildNarrationTimeline({ items: [{ file: 'a' }] }).reason).includes('缺少时长'))

/* ---------------- §2 SRT（复用 subtitle-plan 规范实现） ---------------- */

const srt = buildSrtFromTimeline(tl.timeline)
ok('SRT 产出且含时间码分隔符', srt.ok === true && srt.srt.includes('-->'))
ok('时间码来自实际时间轴（第二条 00:00:02,300）', srt.srt.includes('00:00:02,300'))
ok('无文本条目不产出 SRT', buildSrtFromTimeline([{ startMs: 0, endMs: 1000, text: '' }]).ok === false)

/* ---------------- §3 argv（ducking + amix） ---------------- */

const args3 = buildStitchArgs({ bgm: 'bgm.wav', timeline: tl.timeline, target: 'out.m4a', duck: { ratio: 12 } })
ok('三个 -i（BGM + 两条旁白）', args3.argv.filter((x) => x === '-i').length === 3)
// ★ Array.includes 是「精确元素匹配」：adelay 藏在整段 filter_complex 字符串元素里，
//   必须用 some(x => x.includes(...))（includes('adelay=...') 永远 false，专项当场抓到）。
ok('adelay 到位（0 与 2300）', args3.argv.some((x) => String(x).includes('adelay=0:all=1') && String(x).includes('adelay=2300:all=1')))
ok('sidechaincompress 进 filter_complex（ducking）', args3.argv.some((x) => x.includes('sidechaincompress')))
ok('amix normalize=0（不压音量）', args3.argv.some((x) => x.includes('amix=inputs=2:duration=longest:normalize=0')))
ok('-map [aout] 且无 shell 元字符独立 token', args3.argv.includes('-map') && args3.argv.includes('[aout]')
  && !args3.argv.some((x) => x === ';' || x === '&&' || x === '|'))
ok('duck ratio 12 被写入', args3.duck.ratio === 12)
const args4 = buildStitchArgs({ timeline: tl.timeline, target: 'out.m4a' })
ok('无 BGM → 旁白 anull 直出（无 sidechaincompress）', args4.argv.some((x) => x.includes('anull'))
  && !args4.argv.some((x) => x.includes('sidechaincompress')))
const args5 = buildStitchArgs({ bgm: 'bgm.wav', timeline: [{ ...tl.timeline[0] }], target: 'out.m4a' })
ok('单条目不做 amix 拼接', !args5.argv.some((x) => x.includes('amix=inputs=2:duration=longest:normalize=0[nar]')))

/* ---------------- §4 执行诚实边界（注入假 execFile，真 tmp 目录） ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-stitch-'))
fs.writeFileSync(path.join(tmp, 'a.wav'), 'fake')
fs.writeFileSync(path.join(tmp, 'b.wav'), 'fake')
fs.writeFileSync(path.join(tmp, 'bgm.wav'), 'fake')
const deadCfg = { ffmpegPath: 'T:/no-such-ffmpeg.exe', ffprobePath: 'T:/no-such-ffprobe.exe' }
const d1 = await runAvStitch({ cfg: deadCfg, outputDir: tmp,
  items: [{ file: 'a.wav', text: '你好', duration_ms: 2000 }], target: 'out.m4a' })
ok('ffmpeg 不可用 → degraded 且绝不谎称已混音', d1.degraded === true && d1.executed === false
  && String(d1.reason).includes('ffmpeg'))
const d2 = await runAvStitch({ cfg: deadCfg, outputDir: tmp,
  items: [{ file: '../outside.wav', text: 'x', duration_ms: 1000 }], target: 'out.m4a' })
ok('旁白穿越围栏在执行层就被拒', d2.degraded === true && String(d2.reason).includes('条目 1'))
const d3 = await runAvStitch({ cfg: deadCfg, outputDir: tmp,
  items: [{ file: 'a.wav', text: 'x', duration_ms: 1000 }], target: '../evil.m4a' })
ok('输出穿越被拒', d3.degraded === true && String(d3.reason).includes('输出'))

let stage = 0
let captured = null
const fakeExec = (exe, argv, opts, cb) => {
  const isProbe = exe.endsWith('ffmpeg') && argv.includes('-version')
  const isProbeDur = argv.includes('format=duration')
  setImmediate(() => {
    if (isProbe) { stage = 1; cb(null); return }
    if (isProbeDur) { stage = 2; cb(null, '2.500\n'); return }
    stage = 3
    captured = { exe, argv, opts }
    cb(null)
  })
  return { on() {} }
}
const runOk = await runAvStitch({ cfg: {}, outputDir: tmp,
  items: [{ file: 'a.wav', text: '你好' }, { file: 'b.wav', text: '世界' }], bgm: 'bgm.wav',
  target: 'out.m4a', srtTarget: 'out.srt', execFileFn: fakeExec })
ok('ffmpeg 可用 → executed:true 且回产物路径', runOk.executed === true && runOk.path === path.join(tmp, 'out.m4a'))
ok('时长经假 ffprobe 探测（2.5s）→ 第二条 start 2800ms', runOk.timeline[1].startMs === 2800)
ok('SRT 已写盘且时间码来自实际时间轴', runOk.srt_written === true
  && fs.readFileSync(path.join(tmp, 'out.srt'), 'utf8').includes('00:00:02,800'))
ok('主 argv 走 filter_complex 且映射 [aout]', captured.argv.includes('-filter_complex') && captured.argv.includes('[aout]'))
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------- §5 工具边界 ---------------- */

const tool = makeMixNarrationTool({ cfg: deadCfg, outputDir: 'T:/fence-test-out' })
const t1 = await tool.execute({ items: [{ file: 'a.wav', text: '你好', duration_ms: 1000 }], target: 'out.m4a' })
ok('ffmpeg 不可用时工具 executed:false 如实降级', t1.executed === false && t1.degraded === true && t1.ok === false)
ok('工具 note 绝不谎称已混音', String(t1.note).includes('未执行') && !String(t1.note).includes('缝合完成'))
ok('工具超时 10 分钟（真混音需要）', tool.timeoutMs === 10 * 60 * 1000)

/* ---------------- §6 注册层与文档点名同步 ---------------- */

ok('tool-registry 注册 mix_narration', read('lib/tool-registry.js').includes("'mix_narration'")
  && read('lib/tool-registry.js').includes('makeMixNarrationTool'))
ok('integration-state 目录含两条缝合路由', read('lib/integration-state.js').includes('/api/qwen-paint/av/stitch/capabilities')
  && read('lib/integration-state.js').includes("path: '/api/qwen-paint/av/stitch'"))
ok('selftest EXPECTED_TOOLS 含 mix_narration', read('scripts/selftest.mjs').includes("'mix_narration'"))
ok('tool-descriptions 与 agent-guide 点名', read('lib/tool-descriptions.js').includes('mix_narration')
  && read('lib/agent-guide.js').includes('mix_narration'))
ok('两份 llms 以代码字体点名 mix_narration', read('llms.txt').includes('`mix_narration`')
  && read('docs/llms.txt').includes('`mix_narration`'))
ok('video-post 头部声明随缝合落地更新（不再说「没有音频混流实现」）',
  !read('lib/video-post.js').includes('本插件没有音频混流实现'))
ok('lab UI 有缝合入口', read('assets/lab.js').includes('av/stitch'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-av-stitch.mjs'))

/* ---------------- §7 体积红线 ---------------- */

ok('lib/av-stitch.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'av-stitch.js')).size <= 262144)

console.log(`\n=== test-av-stitch：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
