/**
 * scripts/test-render-backends.mjs —— 渲染后端发现模式 + 动画缓存最小版回归。
 * 覆盖：①硬件编码择优（真跑探测/顺序/降级）②resvg 光栅探测（诚实不谎称）③中文字体
 * 空白帧自检 ④瓦片缓存/可插拔后端接口 ⑤生产接线（tool-registry 真注入探针）。
 * 断言签名铁律：ok(label, cond, detail)，标签在第一个参数。全离线：注入假执行器，不 spawn。
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
function section(t) { console.log(`\n=== ${t} ===`) }

const rb = await imp('lib/render-backends.js')
const cache = await imp('lib/anim-cache.js')
const kit = await imp('lib/animation-kit.js')

section('① 硬件编码择优')
{
  ok('优先级 NVENC→QSV→libx264→AMF（x264 在 AMF 前，避本机 AMF 负优化）',
    JSON.stringify(rb.ENCODE_PRIORITY) === JSON.stringify(['h264_nvenc', 'h264_qsv', 'libx264', 'h264_amf']))
  // ★ 核心护栏：x264 与 AMF 都可用时应选 x264（2026-11-17 实测 AMF 慢 12.9%~38.3%，不再误选）
  let probedFast = []
  const rf = await rb.probeEncoders({ probeEncoder: async (e) => { probedFast.push(e); return e === 'libx264' || e === 'h264_amf' } })
  ok('★ x264 与 AMF 都可用时优先 x264（避负优化）', rf.selected === 'libx264' && rf.label.includes('软件'), JSON.stringify(rf))
  ok('★ x264 命中即停，不探测其后的 AMF', JSON.stringify(probedFast) === JSON.stringify(['h264_nvenc', 'h264_qsv', 'libx264']))
  // 假执行器：只有 amf 成功 → x264 失败后仍可选 amf（AMF 保留为最后兜底，不删能力）
  let probed = []
  const r1 = await rb.probeEncoders({ probeEncoder: async (e) => { probed.push(e); return e === 'h264_amf' } })
  ok('x264 探测失败时降级选中 AMF（保留兜底）', r1.selected === 'h264_amf' && r1.label.includes('AMD'), JSON.stringify(r1))
  ok('命中即停，不再探测更低优先级', JSON.stringify(probed) === JSON.stringify(['h264_nvenc', 'h264_qsv', 'libx264', 'h264_amf']))
  // 全失败 → 降级 libx264
  const r2 = await rb.probeEncoders({ probeEncoder: async () => false })
  ok('硬件全失败降级 libx264 且标明软件编码', r2.selected === 'libx264' && r2.label.includes('软件') && r2.detail.includes('降级'))
  // 未注入探测器 → 保守 libx264，不谎称实测
  const r3 = await rb.probeEncoders({})
  ok('未注入探测器不谎称实测（probed:false）', r3.selected === 'libx264' && r3.probed === false && r3.detail.includes('未实测'))
  // 探测器抛错也不能崩
  const r4 = await rb.probeEncoders({ probeEncoder: async () => { throw new Error('x') } })
  ok('探测器异常被吞、安全降级', r4.selected === 'libx264')
}

section('② resvg 光栅探测（发现模式，诚实）')
{
  const r1 = await rb.probeRaster({ probeResvg: async () => true })
  ok('探测到 resvg 标 backend=resvg', r1.backend === 'resvg' && r1.probed === true)
  const r2 = await rb.probeRaster({ probeResvg: async () => false })
  ok('未探测到降级 fallback 且提示不谎称', r2.backend === 'fallback' && r2.detail.includes('不谎称'))
  const r3 = await rb.probeRaster({})
  ok('未注入探测器不谎称（probed:false）', r3.backend === 'fallback' && r3.probed === false)
  // 未注入内置时 RESVG_PATH 优先于 PATH；bin 是脱敏展示名，真实路径在 execPath（禁止回传前端）
  let bins = []
  const r4 = await rb.probeRaster({ resvgPath: 'C:/custom/resvg.exe', probeResvg: async (b) => { bins.push(b); return b === 'C:/custom/resvg.exe' } })
  ok('RESVG_PATH 优先并命中（bin 脱敏/execPath 真路径）',
    r4.source === 'RESVG_PATH' && r4.execPath === 'C:/custom/resvg.exe' && bins[0] === 'C:/custom/resvg.exe'
    && r4.bin === 'RESVG_PATH 指定')
  // ★ 内置优先：注入 builtin 候选时，它应排在 RESVG_PATH 之前被探测
  let seen = []
  const r5 = await rb.probeRaster({
    builtin: { binPath: 'D:/plugin/assets/bin/resvg.exe', display: '插件内置 resvg.exe', source: '内置' },
    resvgPath: 'C:/custom/resvg.exe',
    probeResvg: async (b) => { seen.push(b); return b === 'D:/plugin/assets/bin/resvg.exe' },
  })
  // 展示字段（bin/detail/source）必须脱敏；execPath 是内部执行路径，允许含真实路径但不回前端。
  ok('★ 内置 resvg 优先于 RESVG_PATH/PATH', r5.source === '内置' && seen[0] === 'D:/plugin/assets/bin/resvg.exe'
    && r5.bin === '插件内置 resvg.exe' && !r5.detail.includes('D:/plugin') && !r5.source.includes('D:/plugin'))
  // 内置探测失败时，仍继续试 RESVG_PATH（不因内置失败就整体降级）
  const r6 = await rb.probeRaster({
    builtin: { binPath: 'D:/plugin/assets/bin/resvg.exe', display: '插件内置 resvg.exe', source: '内置' },
    resvgPath: 'C:/custom/resvg.exe',
    probeResvg: async (b) => b === 'C:/custom/resvg.exe',
  })
  ok('内置失败继续试 RESVG_PATH', r6.source === 'RESVG_PATH' && r6.execPath === 'C:/custom/resvg.exe')
  ok('resvgCommand 基础形式 [bin, svg, png]', JSON.stringify(rb.resvgCommand({ bin: 'resvg', svgPath: 'a.svg', outPath: 'a.png' })) === JSON.stringify(['resvg', 'a.svg', 'a.png']))
  ok('resvgCommand 缺参返回 null', rb.resvgCommand({ bin: '', svgPath: 'a.svg', outPath: 'a.png' }) === null)
}

section('③ 中文字体空白帧自检')
{
  // 有字明显大于无字 → safe
  const r1 = await rb.checkFontSafety({ renderProbe: async (t) => Buffer.alloc(t ? 2000 : 800) })
  ok('有字/无字差异明显判安全', r1.safe === true)
  // 字消失（二者一样大）→ unsafe
  const r2 = await rb.checkFontSafety({ renderProbe: async () => Buffer.alloc(800) })
  ok('缺字（输出一样大）判不安全', r2.safe === false)
  // 未注入 → null 不误判
  const r3 = await rb.checkFontSafety({})
  ok('未注入探针跳过（safe:null）', r3.safe === null)
  // 探针抛错 → false 保守
  const r4 = await rb.checkFontSafety({ renderProbe: async () => { throw new Error('x') } })
  ok('探针异常保守判不安全', r4.safe === false)
}

section('③b 内置 resvg + stdin 渲染（真内置）')
{
  // 内置路径解析：相对模块解析、display 脱敏；exists/toPath 可桩。
  const bi = rb.builtinResvgPath({ metaUrl: 'file:///D:/plugin/lib/render-backends.js',
    toPath: (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/u, '$1').replace(/\//gu, '\\'),
    exists: () => true, })
  // 测试跑在 Windows，builtinResvgPath 应返回内置路径；非 Windows 返回 null（诚实）。
  const isWin = process.platform.startsWith('win')
  ok('内置路径解析：Windows 返回 binPath+脱敏 display', isWin ? (!!bi && bi.binPath.endsWith('resvg.exe') && bi.source === '内置' && bi.display === '插件内置 resvg.exe') : bi === null)
  // 用运行时用户名做反向检查（不写字面量，避免 pack 脱敏扫描把测试夹具当泄漏）
  let localUser = ''
  try { localUser = (await import('node:os')).userInfo().username } catch { /* 取不到就跳过 */ }
  if (isWin) ok('内置路径不含当前用户目录（脱敏）', !/Users[\\/]/iu.test(bi.binPath)
    && (localUser === '' || !bi.binPath.includes(localUser)))
  // stdin 模式：注入 execStdin，SVG 走 stdin、PNG 出 stdout，产物 <128B 判失败。
  const probes = rb.createRenderProbes({
    exec: async () => {}, // --version 探测通过
    execStdin: async (binPath, svg, opts) => {
      if (!binPath.endsWith('resvg.exe') || !svg.includes('<svg') || opts.timeoutMs <= 0) return { ok: false }
      return { ok: true, stdout: Buffer.alloc(900, 1) }
    },
    builtin: { binPath: 'D:/plugin/assets/bin/resvg.exe', display: '插件内置 resvg.exe', source: '内置' },
    path: null, fs: null,
  })
  const r = await probes.rasterBackend('<svg>中文</svg>', { width: 100, height: 50 })
  ok('★ stdin 渲染成功（内置优先/无需 svgPath）', r.ok === true && r.backend === 'resvg' && r.source === '内置')
  ok('★ stdin 产物未落盘时不谎称路径（png buffer 回传）', r.path === '' && r.png?.length === 900)
  const tiny = rb.createRenderProbes({ exec: async () => {},
    execStdin: async () => ({ ok: true, stdout: Buffer.alloc(50, 1) }),
    builtin: { binPath: 'D:/plugin/assets/bin/resvg.exe', display: '插件内置 resvg.exe', source: '内置' } })
  const rt = await tiny.rasterBackend('<svg></svg>', {})
  ok('★ stdin 产物过小判失败（缺字/空白帧不谎称成功）', rt.ok === false && rt.reason.includes('缺字'))
  const fail = rb.createRenderProbes({ exec: async () => {}, execStdin: async () => ({ ok: false }),
    builtin: { binPath: 'D:/plugin/assets/bin/resvg.exe', display: '插件内置 resvg.exe', source: '内置' } })
  ok('★ stdin 执行失败降级保留 SVG', (await fail.rasterBackend('<svg></svg>', {})).ok === false)
  // ★ 二进制 / 许可证是本机安装物，不在源码检出里（CI 必然缺）。
  //   有就验真实体积；没有就验生产代码如实降级为 null —— 绝不把缺件当代码 bug，也绝不假装有。
  const exePath = path.join(ROOT, 'assets/bin/resvg.exe')
  if (fs.existsSync(exePath)) {
    ok('★ 内置 exe 文件真在包内（assets/bin/resvg.exe）', fs.statSync(exePath).size > 1e6)
    ok('★ 内置双许可证（Apache-2.0 OR MIT）随包', ['LICENSE-resvg-MIT.txt', 'LICENSE-resvg-APACHE.txt']
      .every((f) => fs.existsSync(path.join(ROOT, 'assets/bin', f))))
  } else {
    ok('★ 缺内置二进制时 builtinResvgPath 如实返回 null（CI 源码检出）',
      rb.builtinResvgPath({ metaUrl: 'file:///D:/plugin/lib/render-backends.js', exists: () => false }) === null)
    console.log('— 源码检出不含随包二进制 / 许可证，跳过存在性断言（本机装了才会验）')
  }
}

section('④ 动画缓存最小版')
{
  ok('diffTiles 标出变更瓦片', JSON.stringify(cache.diffTiles(['a', 'b'], ['a', 'c']).map((t) => t.changed)) === JSON.stringify([false, true]))
  ok('diffTiles 新增瓦片算变更', cache.diffTiles(['a', 'b'], ['a'])[1].changed === true)
  const c = cache.createTileCache({}) // 纯内存（无 fs 时 set 返回 flush 结果 false，但内存已存）
  c.set('k', { svg: '<svg/>' })
  ok('内存缓存 set/get 通', c.get('k')?.svg === '<svg/>' && c.size() === 1)
  ok('未命中返回 null', c.get('nope') === null)
  ok('clear 后为空', (c.clear(), c.size() === 0))
  const slot = cache.createBackendSlot()
  ok('默认后端 passthrough 不伪造', slot.backend === 'passthrough')
  const pas = await slot.rasterize('<svg/>')
  ok('passthrough 回 rasterized:false', pas.rasterized === false && pas.svg === '<svg/>')
  slot.set(async (svg) => ({ ok: true, backend: 'resvg', svg, path: 'a.png' }))
  const hit = await slot.rasterize('<svg/>')
  ok('注入自定义后端后真调用', hit.rasterized === true && hit.backend === 'resvg')
  slot.set(async () => { throw new Error('x') })
  const bad = await slot.rasterize('<svg/>')
  ok('后端抛错回 ok:false 不崩', bad.ok === false && bad.rasterized === false)
  // renderTiles 命中不重渲
  let calls = 0
  const cache2 = cache.createTileCache({})
  cache2.set('same', { ok: true, backend: 'resvg', svg: 'X' })
  const slot2 = cache.createBackendSlot(async () => { calls += 1; return { ok: true, backend: 'resvg', svg: 'X' } })
  const out = await cache.renderTiles({ tiles: cache.diffTiles(['same', 'new'], ['same']), cache: cache2, slot: slot2, backend: slot2, ctx: { svg: 'X' } })
  ok('renderTiles 未变瓦片命中缓存、变更的才渲染', out[0].cache === 'hit' && out[1].cache === 'miss' && calls === 1, `calls=${calls}`)
}

section('⑤ 生产接线（非孤儿）')
{
  const tr = read('lib/tool-registry.js')
  ok('★ tool-registry import createRenderProbes', /import \{ createRenderProbes \} from '\.\/render-backends\.js'/u.test(tr))
  ok('★ tool-registry 注入 probeEncoder 到 animDeps', /animDeps\.probeEncoder\s*=/u.test(tr))
  ok('★ tool-registry 注入 rasterBackend 到 animDeps', /animDeps\.rasterBackend\s*=/u.test(tr))
  const kitSrc = read('lib/animation-kit.js')
  ok('★ animation-kit import 两个新模块', kitSrc.includes("from './render-backends.js'") && kitSrc.includes("from './anim-cache.js'"))
  ok('★ compose_video 消费 probeEncoders', /probeEncoders\(\{ probeEncoder: deps\.probeEncoder \}\)/u.test(kitSrc))
  ok('★ buildComposeCommand 用择优编码器（非写死）', /videoEncoder: enc\.selected/u.test(kitSrc))
  ok('★ render_frame 消费可选 rasterBackend', /deps\.rasterBackend\(svg/u.test(kitSrc))
  // 坑：AMF 在 `-f null` 下 Init() failed 会假阴性；探测器必须写真实 mp4。
  const rbSrc = read('lib/render-backends.js')
  ok('★ 编码器探测写真实 mp4（不用 -f null，避免 AMF 假阴性）',
    rbSrc.includes("'-y', tmp") && !/'-f', 'null'/u.test(rbSrc))
  // 编码器择优是真出片链的一部分：argv 里 -c:v 后跟所选编码器
  const cmd = kit.buildComposeCommand({ frames: ['a.png', 'b.png'], out: 'x.mp4', fps: 24, videoEncoder: 'h264_amf' })
  ok('buildComposeCommand 用传入编码器', cmd[cmd.indexOf('-c:v') + 1] === 'h264_amf')
  ok('buildComposeCommand 默认仍 libx264（旧调用零变化）', (() => { const c = kit.buildComposeCommand({ frames: ['a', 'b'], out: 'x', fps: 24 }); return c[c.indexOf('-c:v') + 1] === 'libx264' })())
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('全部通过 ✓')
