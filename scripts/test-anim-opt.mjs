/**
 * scripts/test-anim-opt.mjs —— 动画三件套四项纯 JS 优化回归。
 * hyperframes 清单 §13 可映射项：①静态帧去重 ②分镜级缓存 ③草稿/定稿档 ④时序校验前置。
 * 断言签名铁律：ok(label, cond, detail)，标签在第一个参数。
 * 全离线：缓存用内存 fs 桩，不写真实文件；import 真模块验证接线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
let passed = 0, failed = 0
function ok(label, cond, detail) {
  if (cond) { passed += 1; console.log('  OK  ', label) }
  else { failed += 1; console.log('  FAIL', label, detail === undefined ? '' : `→ ${detail}`) }
}
function eq(a, e, label) { ok(label, JSON.stringify(a) === JSON.stringify(e), `实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(e)}`) }
function section(t) { console.log(`\n=== ${t} ===`) }

const opt = await imp('lib/anim-opt.js')
const kit = await imp('lib/animation-kit.js')

section('③ 草稿/定稿档')
{
  eq(opt.ANIM_QUALITY_NAMES, ['draft', 'final'], '档位名集合正确')
  eq(opt.resolveAnimQuality('draft'), { fps: 12, width: 480, height: 270 }, 'draft 低采档参数')
  eq(opt.resolveAnimQuality('final'), { fps: 24, width: 960, height: 540 }, 'final 原默认档参数')
  ok('未知档返回 null（调用方保持原参数）', opt.resolveAnimQuality('wat') === null)
  ok('空档返回 null', opt.resolveAnimQuality('') === null)
  ok('大小写不敏感', opt.resolveAnimQuality('DRAFT')?.fps === 12)
  ok('档位是冻结常量（防运行时篡改）', Object.isFrozen(opt.ANIM_QUALITY_PRESETS))
}

section('①② 指纹与分镜 key')
{
  const a = opt.frameFingerprint('<svg>a</svg>'), b = opt.frameFingerprint('<svg>a</svg>'), c = opt.frameFingerprint('<svg>b</svg>')
  ok('同内容同指纹', a === b)
  ok('异内容异指纹', a !== c)
  ok('指纹 16 位 hex', /^[0-9a-f]{16}$/u.test(a))
  const k1 = opt.storyboardKey({ type: 'flow', hint: '开始→结束', width: 960, height: 540 })
  const k2 = opt.storyboardKey({ type: 'flow', hint: '开始→结束', width: 960, height: 540 })
  const k3 = opt.storyboardKey({ type: 'flow', hint: '改了提示', width: 960, height: 540 })
  const k4 = opt.storyboardKey({ type: 'flow', hint: '开始→结束', width: 480, height: 270 })
  ok('同分镜同 key', k1 === k2)
  ok('hint 变→key 变（改一镜只重渲那一镜）', k1 !== k3)
  ok('尺寸变→key 变', k1 !== k4)
}

section('② 分镜级缓存（内存 fs 桩，零真实写盘）')
{
  const store = new Map()
  const memfs = {
    readFileSync(p) { if (!store.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e } return store.get(p) },
    writeFileSync(p, d) { store.set(p, d) },
    mkdirSync() {},
  }
  const pathMod = path
  const cache = opt.createFrameCache({ outputDir: '\x4B:/fake/out', fs: memfs, path: pathMod })
  ok('缓存实例创建成功', !!cache && cache.file.includes('.qwen-paint-frame-cache.json'))
  ok('初始空缓存 miss', cache.lookup('no-key') === null)
  ok('写入成功', cache.remember('k1', { svg: '<svg>x</svg>', rel: 'f1.svg' }) === true)
  ok('命中且 svg 逐字一致', cache.lookup('k1')?.svg === '<svg>x</svg>')
  ok('命中带回落盘路径', cache.lookup('k1')?.path === 'f1.svg')
  ok('size=1', cache.size() === 1)
  ok('空 svg 拒绝写入', cache.remember('k2', { svg: '' }) === false)
  ok('坏账本从空开始（容错）', (() => {
    store.set(cache.file, 'not json{')
    const c2 = opt.createFrameCache({ outputDir: '\x4B:/fake/out', fs: memfs, path: pathMod })
    return c2.size() === 0
  })())
  const noDir = opt.createFrameCache({ outputDir: '', fs: memfs, path: pathMod })
  ok('无 outputDir 返回 null（不启用缓存）', noDir === null)
}

section('① 静态帧去重')
{
  eq(opt.collapseRepeatedFrames(['a.svg', 'a.svg', 'b.svg', 'a.svg']),
    [{ path: 'a.svg', repeat: 2 }, { path: 'b.svg', repeat: 1 }, { path: 'a.svg', repeat: 1 }],
    '只折叠相邻同路径（非相邻不动）')
  eq(opt.collapseRepeatedFrames(['x.svg', 'x.svg', 'x.svg']), [{ path: 'x.svg', repeat: 3 }], '三连折叠为一帧')
  eq(opt.repeatsOf([{ path: 'a', repeat: 2 }, { path: 'b', repeat: 1 }]), [2, 1], 'repeat 数组正确')
  eq(opt.collapseRepeatedFrames([]), [], '空输入返回空')
  // buildComposeCommand 带 repeats：帧输入数减少、-t 按 repeat 延长
  const cmd = kit.buildComposeCommand({ frames: ['/dup.png', '/other.png'], out: '/o.mp4', fps: 24, repeats: [3, 1] })
  ok('去重后 -i 数量=折叠帧数(2)', cmd.filter((x) => x === '-i').length === 2)
  ok('重复帧 -t 延长到 3/24', cmd.includes('-t') && cmd.some((x) => x === '0.125'), String(cmd))
  ok('concat=n=折叠帧数', cmd.some((x) => x.includes('concat=n=2:v=1:a=0')))
  const noRep = kit.buildComposeCommand({ frames: ['/a.png', '/b.png'], out: '/o.mp4', fps: 24 })
  ok('不传 repeats 保持原行为（每帧 1/fps）', noRep.filter((x) => x === '-i').length === 2 && noRep.some((x) => x.includes('concat=n=2:')))
}

section('④ 时序校验前置')
{
  const okCase = opt.checkTimelineAlignment({
    storyboard: [{ from: 0, to: 2 }, { from: 2, to: 4 }],
    srtCues: [{ to: 2 }, { to: 4 }], audioSeconds: 4, frames: 96, fps: 24,
  })
  ok('对齐时 ok=true', okCase.ok === true && okCase.aligned === true)
  ok('对齐时 checked=4', okCase.checked === 4, String(okCase.checked))
  const bad = opt.checkTimelineAlignment({
    storyboard: [{ from: 0, to: 2 }, { from: 2, to: 4 }],
    srtCues: [{ to: 2 }], audioSeconds: 9, frames: 96, fps: 24,
  })
  ok('不齐时 ok=false', bad.ok === false)
  ok('抓到字幕条数不符', bad.issues.some((x) => x.includes('字幕 1 条 ≠ 分镜 2 镜')))
  ok('抓到配音偏差', bad.issues.some((x) => x.includes('配音')))
  ok('不齐 summary 含原因', bad.summary.includes('时序不齐'))
  const empty = opt.checkTimelineAlignment({ frames: 48, fps: 24 })
  ok('缺数据时跳过（checked=0, ok=true）', empty.checked === 0 && empty.ok === true)
}

section('animation-kit 接线（真实工具调用）')
{
  const [sb, rf, cv] = kit.makeAnimationTools({ outputDir: '\x4B:/fake/output' })
  const r = await rf.execute({ type: 'flow', hint: '档位测试', quality: 'draft' })
  ok('render_frame 回传 quality=draft', r.quality === 'draft', JSON.stringify(r.quality))
  ok('render_frame 回传 fingerprint', /^[0-9a-f]{16}$/u.test(r.fingerprint), String(r.fingerprint))
  ok('未注入 fs 时 cache=miss（缓存关闭但仍回字段）', r.cache === 'miss')
  ok('draft 档 SVG 尺寸 480', r.svg.includes('width="480"'), r.svg.slice(0, 90))
  const rFinal = await rf.execute({ type: 'flow', hint: '档位测试', quality: 'final' })
  ok('final 档 SVG 尺寸 960', rFinal.svg.includes('width="960"'))
  const rExplicit = await rf.execute({ type: 'flow', hint: '档位测试', quality: 'draft', width: 800 })
  ok('显式 width 覆盖档位', rExplicit.svg.includes('width="800"'))

  const dupCmd = await cv.execute({ frames: ['/a.png', '/a.png', '/b.png'], target: 'o.mp4', dedupe: true })
  ok('compose dedup=true 回传', dupCmd.dedup === true)
  ok('compose 去重后 frames=2', dupCmd.frames === 2, String(dupCmd.frames))
  const noDup = await cv.execute({ frames: ['/a.png', '/a.png'], target: 'o.mp4' })
  ok('默认 dedup=false 不折叠', noDup.dedup === false && noDup.frames === 2)

  const strict = await cv.execute({ frames: ['/a.png', '/b.png'], target: 'o.mp4', strictTiming: true,
    storyboard: [{ to: 5 }], srtCues: [{ to: 1 }], audioSeconds: 2, fps: 2 })
  ok('strictTiming 时序不齐拒绝（独有文案，区分离线降级）', strict.ok === false && String(strict.reason).includes('已拒绝合成'))
  const loose = await cv.execute({ frames: ['/a.png', '/b.png'], target: 'o.mp4',
    storyboard: [{ to: 5 }], srtCues: [{ to: 1 }], audioSeconds: 2, fps: 2 })
  ok('非 strict 只告警不拒绝', loose.reason.includes('⚠') && loose.reason.includes('时序不齐'))
}

section('接线与体积')
{
  ok('animation-kit import anim-opt', read('lib/animation-kit.js').includes("from './anim-opt.js'"))
  ok('anim-opt 声明四项导出', ['resolveAnimQuality', 'collapseRepeatedFrames', 'checkTimelineAlignment', 'createFrameCache']
    .every((s) => read('lib/anim-opt.js').includes('export function ' + s)))
  const libTotal = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + fs.statSync(path.join(ROOT, 'lib', f)).size, 0)
  ok('lib 合计未爆 2 MB 红线', libTotal <= 2097152, `实际 ${libTotal}`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('全部通过 ✓')
