/**
 * 工作流声明式清单（A1）回归 —— 2026-11-14 新增
 *
 * ## 这个测试存在的唯一理由
 *   A1 把节点拓扑从 JS 搬到 `workflows/*.json`。**搬迁本身不产生任何用户可见收益**，
 *   真正的风险是「搬的时候悄悄改了一个槽位/一个默认值」，而现有测试只看结构、
 *   看不出两张图已经不等价。
 *   ⇒ 这里做**双轨一致性断言**：硬编码路径与清单路径产出的 workflow 必须**逐字节相同**。
 *     一旦有人只改了一边，这条立刻红。
 *
 * ## 为什么还要测「清单 vs 源码常量」
 *   清单里重复了 `WAN_ASSETS` / `REQUIRED_NODES` / `DMD_SHIFT` 等值。重复 = 漂移来源。
 *   所以断言两边**必须相等**：将来改模型文件名时若只改 JS，这里会红，逼你同时改清单。
 *   这是「允许重复，但强制同步」的取舍 —— 比让清单去 import JS 常量更容易审阅。
 *
 * ## 为什么测 package.json 的 files
 *   `workflows/` 不在 files 白名单里 ⇒ npm 包**缺这些 json** ⇒ 装上就崩，
 *   而本地开发永远发现不了（本地有目录）。这条是发布事故的预防针。
 *
 * ⚠ 本文件统一用 `ok(cond, label)` 顺序（与 test-workflow-contract.mjs 同）。
 *   本仓还有 `ok(label, cond)` 风格的旧文件 —— 混用时**整份套件会假绿**（历史事故），
 *   新增文件必须一开始就选定并写明。
 *
 * 运行：node scripts/test-workflow-manifest.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildVideoWorkflow,
  buildVideoWorkflowFromManifest,
  resolveVideoParams,
  WAN_ASSETS,
  REQUIRED_NODES,
  DMD_SHIFT,
  DMD_STEPS,
  DEFAULT_NEGATIVE,
} from '../lib/video-workflow.js'
import {
  loadManifest,
  validateManifest,
  bindGraph,
  bindValue,
  listManifests,
  manifestDir,
  applyDefaults,
  SCHEMA_VERSION,
} from '../lib/workflow-manifest.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
let fail = 0
const fails = []

/** ⚠ 参数顺序：cond 在前，label 在后。 */
function ok(cond, label) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    fails.push(label)
    console.log(`  ✗ ${label}`)
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ═════════════════════ 1. 清单自校验 ═════════════════════ */

console.log('[1] 清单本身必须结构合法')

const dir = manifestDir()
const ids = listManifests()
ok(ids.length > 0, `workflows/ 目录里至少有一份清单（实际 ${ids.length} 份：${ids.join(', ')}）`)
ok(ids.includes('video-wan22'), 'video-wan22 清单存在')

const video = loadManifest('video-wan22')
ok(video.schemaVersion === SCHEMA_VERSION, `schemaVersion = ${SCHEMA_VERSION}`)
ok(video.id === 'video-wan22', 'id 与文件名一致（防 id 写错导致 loadManifest 语义混乱）')
ok(validateManifest(video).length === 0,
  `validateManifest 对真实清单零错误${validateManifest(video).length ? ` — ${validateManifest(video).join('; ')}` : ''}`)

/* ═════════════════════ 2. 清单 vs 源码常量 ═════════════════════ */

console.log('\n[2] 清单里重复的值必须与源码常量同步（允许重复，强制相等）')

ok(eq(video.assets, WAN_ASSETS),
  `assets 与 WAN_ASSETS 完全一致（清单 ${JSON.stringify(video.assets)} vs 源码 ${JSON.stringify(WAN_ASSETS)}）`)
ok(eq(video.requires.nodes, REQUIRED_NODES),
  'requires.nodes 与 REQUIRED_NODES 完全一致（顺序也算，便于人工对读）')
ok(video.consts.shift === DMD_SHIFT, `consts.shift === DMD_SHIFT（${DMD_SHIFT}）`)
ok(video.params.steps.default === DMD_STEPS, `params.steps.default === DMD_STEPS（${DMD_STEPS}）`)
ok(video.params.negative.default === DEFAULT_NEGATIVE, 'params.negative.default === DEFAULT_NEGATIVE')
ok(video.kind === 'video', 'kind 是 video')

/* ═════════════════════ 3. 双轨一致性（核心） ═════════════════════ */

console.log('\n[3] ★★ 双轨一致性：清单产物 === 源码产物（逐字节）')

const CASES = [
  { name: 't2v 基本（全默认）', opts: { prompt: '一只橘猫在草地上奔跑', seed: 12345 } },
  { name: 'i2v 带首帧', opts: { prompt: '镜头缓慢推近', seed: 12345, startImage: 'K:/tmp/first.png' } },
  { name: '非默认尺寸/帧数/帧率/步数', opts: { prompt: '海浪拍岸', seed: 7, width: 1000, height: 600, frames: 30, fps: 16, steps: 6 } },
  { name: '越界值（低）', opts: { prompt: '极简色块', seed: 0, width: 100, height: 100, frames: 5, fps: 1 } },
  { name: '越界值（高）', opts: { prompt: '极繁细节', seed: 2147483647, width: 4096, height: 4096, frames: 999, fps: 999 } },
  { name: 'negative 空串（应回落默认负向词）', opts: { prompt: '测试', seed: 11, negative: '' } },
  { name: 'negative 白空格（trim 后回落）', opts: { prompt: '测试', seed: 11, negative: '   ' } },
  { name: 'negative 自定义', opts: { prompt: '测试', seed: 11, negative: 'lowres, jpeg artifacts' } },
  { name: 'prefix 空串（空串是合法值，不得回落）', opts: { prompt: '测试', seed: 11, prefix: '' } },
  { name: 'prefix 自定义', opts: { prompt: '测试', seed: 11, prefix: 'my/dir/v' } },
  { name: 'startImage 白空格（trim 后视为没给）', opts: { prompt: '测试', seed: 11, startImage: '   ' } },
  { name: '缺节点 caps（KSampler=false）', opts: { prompt: '测试', seed: 11 }, caps: { nodes: { KSampler: false } } },
  { name: '没探测到 caps（undefined 不算缺）', opts: { prompt: '测试', seed: 11 }, caps: { nodes: { KSampler: undefined } } },
  // ↓ D22 音轨（2026-11-14 新增）：这是**条件新增节点**，双轨最容易漂的地方
  { name: 'D22 带音轨', opts: { prompt: '测试', seed: 11, audioTrack: 'dshqp-ref-audio-x.wav' } },
  { name: 'D22 音轨 + 首帧（两个补丁同时生效）', opts: { prompt: '测试', seed: 11, startImage: 'K:/a.png', audioTrack: 'a.wav' } },
  { name: 'D22 音轨白空格（trim 后视为没给，不得新增节点）', opts: { prompt: '测试', seed: 11, audioTrack: '   ' } },
  { name: 'D22 缺 VHS_LoadAudio 但不用音轨（不该报缺件）', opts: { prompt: '测试', seed: 11 }, caps: { nodes: { VHS_LoadAudio: false } } },
  { name: 'D22 缺 VHS_LoadAudio 又给了音轨（要报缺件）', opts: { prompt: '测试', seed: 11, audioTrack: 'a.wav' }, caps: { nodes: { VHS_LoadAudio: false } } },
]

for (const c of CASES) {
  const caps = c.caps ?? { nodes: {} }
  const a = buildVideoWorkflow(caps, c.opts)
  const b = buildVideoWorkflowFromManifest(caps, c.opts)
  ok(eq(a.workflow, b.workflow), `${c.name}：workflow 逐字节一致`)
  ok(eq(a.notes, b.notes), `${c.name}：notes 一致`)
  ok(eq(a.plan, b.plan), `${c.name}：plan 一致`)
}

// 单条细化断言：i2v 的补丁到底有没有生效
{
  const t2v = buildVideoWorkflowFromManifest({ nodes: {} }, { prompt: 'x', seed: 1 })
  const i2v = buildVideoWorkflowFromManifest({ nodes: {} }, { prompt: 'x', seed: 1, startImage: 'K:/a.png' })
  ok(!('start_image' in (t2v.workflow[7].inputs)), 't2v：节点 7 没有 start_image（没首帧就不写这个槽）')
  ok(i2v.workflow[7].inputs.start_image === 'K:/a.png', 'i2v：节点 7 的 start_image 等于传入路径')
  ok(eq(t2v.appliedPatches, []), 't2v：没有应用任何补丁')
  ok(eq(i2v.appliedPatches, ['i2v-start-image']), 'i2v：应用了 i2v-start-image 补丁')
  ok(t2v.plan.mode === 't2v' && i2v.plan.mode === 'i2v', 'plan.mode 随首帧正确切换')
}

// D22 音轨的细化断言：节点真的新增了、接线真的接上了、不给就不该多出节点
{
  const noAudio = buildVideoWorkflowFromManifest({ nodes: {} }, { prompt: 'x', seed: 1 })
  const withAudio = buildVideoWorkflowFromManifest({ nodes: {} }, { prompt: 'x', seed: 1, audioTrack: 'a.wav' })
  ok(!('13' in noAudio.workflow), 'D22：不给音轨时**不存在**节点 13（空 audio_file 会运行时炸）')
  ok(!('audio' in noAudio.workflow[10].inputs), 'D22：不给音轨时 VHS_VideoCombine 没有 audio 槽')
  ok(withAudio.workflow['13']?.class_type === 'VHS_LoadAudio', 'D22：给音轨时新增 VHS_LoadAudio 节点')
  ok(withAudio.workflow['13']?.inputs?.audio_file === 'input/a.wav',
    'D22：audio_file 已规范成 input/ 前缀（真机只认这个格式）',
    withAudio.workflow['13']?.inputs?.audio_file)
  ok(eq(withAudio.workflow[10].inputs.audio, ['13', 0]), 'D22：VHS_VideoCombine.audio 接到新节点输出 0')
  ok(eq(withAudio.appliedPatches, ['audio-track']), 'D22：应用了 audio-track 补丁')
  ok(withAudio.plan.audioTrack === 'input/a.wav', 'D22：plan 回传规范化后的音轨路径',
    withAudio.plan.audioTrack)
  const both = buildVideoWorkflowFromManifest({ nodes: {} }, { prompt: 'x', seed: 1, startImage: 'K:/a.png', audioTrack: 'a.wav' })
  ok(eq(both.appliedPatches, ['i2v-start-image', 'audio-track']), 'D22：首帧 + 音轨两个补丁按声明顺序都应用')
}

/* ═════════════════════ 4. 占位符语义 ═════════════════════ */

console.log('\n[4] 占位符：整串匹配 / 保持原类型 / 不做内联插值')

ok(bindValue('$const.saveMetadata', { const: { saveMetadata: true } }) === true,
  '布尔 true 替换后仍是布尔（不被字符串化成 "true"）')
ok(bindValue('$const.crf', { const: { crf: 20 } }) === 20, '数字替换后仍是数字')
ok(bindValue('$const.shift', { const: { shift: 10.0 } }) === 10, '浮点 10.0 替换后是 number 10')
ok(bindValue('$param.prompt', { param: { prompt: '$const.crf 不要被替换' } }) === '$const.crf 不要被替换',
  '★★ 参数值里出现 $const.xxx 字样时**原样保留**（不递归、不内联替换）')
ok(bindValue('前缀-$param.prompt', { param: { prompt: 'X' } }) === '前缀-$param.prompt',
  '★ 非整串匹配不做插值（prompt 里的 $ 不会被误吃）')
ok(eq(bindValue(['1', 0], {}), ['1', 0]), '节点引用数组 ["1",0] 原样返回')
ok(eq(bindValue({ a: 1, b: ['2', 0] }, {}), { a: 1, b: ['2', 0] }), '嵌套对象原样返回')
{
  let threw = ''
  try { bindValue('$param.nope', { param: {} }) } catch (e) { threw = String(e?.message ?? e) }
  ok(threw.includes('$param.nope'), '取不到的占位符直接抛错，且错误里点名是哪个')
}

/* ═════════════════════ 5. 校验器能抓出坏清单 ═════════════════════ */

console.log('\n[5] ★ 校验器必须抓得出这些错（否则等于没校验）')

const mutate = (fn) => {
  const copy = JSON.parse(JSON.stringify(video))
  fn(copy)
  return validateManifest(copy)
}
const hasErr = (errs, kw) => errs.some((e) => e.includes(kw))

ok(hasErr(mutate((m) => { m.schemaVersion = 2 }), 'schemaVersion'), '抓 schemaVersion 不匹配')
ok(hasErr(mutate((m) => { delete m.graph }), 'graph'), '抓 graph 缺失')
ok(hasErr(mutate((m) => { m.graph['1'].inputs.clip_name = '$asset.nope' }), 'asset.nope'),
  '★★ 抓未声明的 $asset.nope（清单里最常见的笔误）')
ok(hasErr(mutate((m) => { m.graph['8'].inputs.seed = '$param.nope' }), 'param.nope'), '抓未声明的 $param.nope')
ok(hasErr(mutate((m) => { m.graph['8'].inputs.cfg = '$const.nope' }), 'const.nope'), '抓未声明的 $const.nope')
ok(hasErr(mutate((m) => { m.graph['8'].inputs.model = ['99', 0] }), '不存在的节点 99'),
  '★★ 抓指向不存在节点的连线（把 6 写成 99）')
ok(hasErr(mutate((m) => { m.requires.nodes = m.requires.nodes.filter((n) => n !== 'KSampler') }), '漏声明'),
  '★ 抓 requires.nodes 漏声明（图里有、清单没写）')
ok(hasErr(mutate((m) => { m.requires.nodes.push('TotallyFakeNode') }), '多声明'),
  '★ 抓 requires.nodes 多声明（清单写了、图里没有）')
// ⚠ 对照项必须判「错误数为 0」。早先写成 `hasErr(..., '')` 是错的 ——
//   任何字符串都 includes('')，那条断言会恒真，等于没测。
ok(mutate((m) => { m.graph['7'].inputs.width = '$asset.unet' }).length === 0,
  '（对照）合法占位符不报错 —— 证明上面的失败不是校验器恒错')
ok(hasErr(mutate((m) => { m.patches[0].set['99'] = { x: 1 } }), '不存在的节点 99'),
  '抓补丁指向不存在的节点')
ok(hasErr(mutate((m) => { m.params.prompt.default = 'x' }), '语义冲突'),
  '抓「required 又有 default」的语义冲突')
ok(hasErr(mutate((m) => { m.patches.push(JSON.parse(JSON.stringify(m.patches[0]))) }), '重复'),
  '抓 patch id 重复')
// 对照：只改 _comment 不应报错
ok(mutate((m) => { m._comment = '随便改注释' }).length === 0, '改 _comment 不触发校验错误')

/* ═════════════════════ 6. 路径穿越防护 ═════════════════════ */

console.log('\n[6] 清单 id 不得穿越目录（照搬历史库那次教训）')

for (const bad of ['../package', '..\\package', 'a/b', 'C:package', '..', '']) {
  let threw = false
  try { loadManifest(bad) } catch { threw = true }
  ok(threw, `拒绝非法清单 id：${JSON.stringify(bad)}`)
}

/* ═════════════════════ 7. 参数归一化口径 ═════════════════════ */

console.log('\n[7] 参数归一化的默认值口径（negative 用 ||，prefix 用 ??）')

{
  const r = resolveVideoParams({ prompt: 'x', negative: '', prefix: '' })
  ok(r.negative === DEFAULT_NEGATIVE, '★ negative 空串 → 回落默认负向词（|| 口径）')
  ok(r.prefix === '', '★★ prefix 空串 → 保留空串（?? 口径，不能被 || 吃掉）')
  ok(r.startImage === '', 'startImage 缺省是空串')
  ok(resolveVideoParams({ prompt: 'x', seed: 3.9 }).seed === 3, 'seed 取整（3.9 → 3）')
  ok(resolveVideoParams({ prompt: 'x', steps: 0 }).steps === DMD_STEPS, 'steps=0 视为无效，回落 DMD_STEPS')
  ok(resolveVideoParams({ prompt: 'x', fps: 999 }).fps === 30, 'fps 夹到上限 30')
  ok(resolveVideoParams({ prompt: 'x', fps: 1 }).fps === 8, 'fps 夹到下限 8')
  let threw = false
  try { resolveVideoParams({ prompt: '   ' }) } catch { threw = true }
  ok(threw, '空提示词抛错（两条路径共用这一处，口径必然一致）')
}

/* ═════════════════════ 8. 发布物完整性 ═════════════════════ */

console.log('\n[8] ★★ 清单必须进 npm 包（否则发布后必崩，本地发现不了）')

{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  ok(files.includes('workflows'),
    `package.json 的 files 白名单包含 workflows（当前：${JSON.stringify(files)}）`)
}
ok(path.isAbsolute(dir) && dir.replace(/\\/gu, '/').endsWith('/workflows/'),
  `manifestDir() 指向包内 workflows/（${dir}）`)

/* ═════════════════════ 9. applyDefaults 工具语义 ═════════════════════ */

console.log('\n[9] applyDefaults 只在「没给」时填，空串不填')

{
  const m = { params: { a: { default: 1 }, b: { default: 'd' }, c: {} } }
  const out = applyDefaults(m, { b: '', c: 9 })
  ok(out.a === 1, '缺失键填 default')
  ok(out.b === '', '★ 空串视为已给，不覆盖（?? 口径）')
  ok(out.c === 9, '没 default 的键保持原值')
}

/* ═════════════════════ 结果 ═════════════════════ */

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
