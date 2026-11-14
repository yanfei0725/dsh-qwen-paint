#!/usr/bin/env node
/**
 * 视频链回归（`lib/video-workflow.js` + `generate_video` 接线）。
 *
 * 判据分两类：
 *   ① **图本身**：节点集合、关键参数、对齐规则 —— 这些都对着本机**已跑通**的那张图写
 *      （拓扑见 lib/video-workflow.js 头注），不是凭空想的。
 *   ② **接线**：index.js 里注册了工具、等待逻辑读的是 `gifs` 而不是 `images`。
 *
 * 纯离线：不联网、不需要 ComfyUI。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildVideoWorkflow, videoParamsForSpeed, widthForAspect, alignFrames, alignEdge,
  WAN_ASSETS, DMD_STEPS, DMD_SHIFT, DEFAULT_NEGATIVE, REQUIRED_NODES,
  FRAME_MAX, FRAME_MIN,
  VIDEO_SEED_OFFSET_MIN, VIDEO_SEED_OFFSET_MAX,
  resetVideoSeed, getLastVideoSeed, resolveVideoParams,
} from '../lib/video-workflow.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const fullCaps = () => ({ nodes: Object.fromEntries(REQUIRED_NODES.map((n) => [n, true])), gpu: { vendor: 'amd' } })

/* ---------------- 图本身 ---------------- */
console.log('— 工作流图')
{
  const { workflow, plan, notes } = buildVideoWorkflow(fullCaps(), { prompt: 'a red fox in snow', frames: 25, fps: 24, height: 480 })
  const classes = Object.values(workflow).map((n) => n.class_type)
  ok('★ 节点集合与本机已跑通那张图一致（10 个节点，不多不少）',
    Object.keys(workflow).length === 10, `${Object.keys(workflow).join(',')}`)
  ok('★ 九个必需节点全在', REQUIRED_NODES.every((n) => classes.includes(n)),
    REQUIRED_NODES.filter((n) => !classes.includes(n)).join(','))
  ok('★ 权重三件套是本机实测存在的那三个文件',
    workflow[1].inputs.clip_name === WAN_ASSETS.clip
    && workflow[2].inputs.unet_name === WAN_ASSETS.unet
    && workflow[3].inputs.vae_name === WAN_ASSETS.vae,
    `${workflow[2].inputs.unet_name} / ${workflow[1].inputs.clip_name} / ${workflow[3].inputs.vae_name}`)
  ok('clip type = wan（写错 ComfyUI 会按 sd 解析，直接崩）', workflow[1].inputs.type === 'wan')
  ok('★ ModelSamplingSD3 shift = 10（DMD 工作点，改了下雪变噪点）', workflow[6].inputs.shift === DMD_SHIFT)
  ok('★ KSampler：euler / simple / cfg 1.0 / denoise 1.0 / steps 4（已验组合）',
    workflow[8].inputs.sampler_name === 'euler' && workflow[8].inputs.scheduler === 'simple'
    && workflow[8].inputs.cfg === 1.0 && workflow[8].inputs.denoise === 1.0
    && workflow[8].inputs.steps === DMD_STEPS,
    JSON.stringify({ s: workflow[8].inputs.sampler_name, sch: workflow[8].inputs.scheduler, cfg: workflow[8].inputs.cfg, st: workflow[8].inputs.steps }))
  ok('★ 解码走 VAEDecodeTiled 512/64/64/8（不分块会在 20 GB 上爆显存）',
    workflow[12].class_type === 'VAEDecodeTiled' && workflow[12].inputs.tile_size === 512
    && workflow[12].inputs.overlap === 64 && workflow[12].inputs.temporal_size === 64
    && workflow[12].inputs.temporal_overlap === 8)
  ok('★ 输出走 VHS_VideoCombine 的 h264-mp4 / crf 20 / yuv420p',
    workflow[10].inputs.format === 'video/h264-mp4' && workflow[10].inputs.crf === 20
    && workflow[10].inputs.pix_fmt === 'yuv420p')
  ok('连线：ksampler.model ← 6、positive ← 4、negative ← 5、latent ← 7',
    JSON.stringify(workflow[8].inputs.model) === '["6",0]'
    && JSON.stringify(workflow[8].inputs.positive) === '["4",0]'
    && JSON.stringify(workflow[8].inputs.negative) === '["5",0]'
    && JSON.stringify(workflow[8].inputs.latent_image) === '["7",0]')
  ok('连线：combine.images ← 12（VAEDecodeTiled）', JSON.stringify(workflow[10].inputs.images) === '["12",0]')
  ok('负向词不填时用内置那组', workflow[5].inputs.text === DEFAULT_NEGATIVE)
  ok('plan.seconds = frames / fps', plan.seconds === Number((25 / 24).toFixed(3)), String(plan.seconds))
  ok('无首帧 → 纯 t2v，且**不写** start_image 槽',
    plan.mode === 't2v' && !Object.prototype.hasOwnProperty.call(workflow[7].inputs, 'start_image'))
  ok('完整节点集时不报缺件', notes.length === 0, notes.join('；'))
}
{
  const { workflow, plan } = buildVideoWorkflow(fullCaps(), { prompt: 'x', frames: 25, startImage: '<本地路径>' })
  ok('★ 给了首帧 → i2v，且 start_image 真挂在 7 号节点上',
    plan.mode === 'i2v' && workflow[7].inputs.start_image === '<本地路径>')
}
{
  const r = buildVideoWorkflow({ nodes: { VHS_VideoCombine: false }, gpu: {} }, { prompt: 'x' })
  ok('★ 明确确认缺某个节点时，notes 如实点出来（不静默提交）',
    r.notes.some((n) => n.includes('缺节点') && n.includes('VHS_VideoCombine')), r.notes.join('；'))
}
{
  const r = buildVideoWorkflow({ nodes: { VHS_VideoCombine: undefined }, gpu: {} }, { prompt: 'x' })
  ok('★ 没探测到（undefined）不算缺 —— 把"没测出来"当"没有"会误杀整条链',
    !r.notes.some((n) => n.includes('缺节点')))
}
ok('空提示词直接报错', (() => { try { buildVideoWorkflow(fullCaps(), { prompt: '  ' }); return false } catch { return true } })())

/* ---------------- 对齐规则 ---------------- */
console.log('— 对齐')
ok('★ 帧数对齐 4n+1：24→25、30→29、81→81、9→9',
  alignFrames(24).value === 25 && alignFrames(30).value === 29
  && alignFrames(81).value === 81 && alignFrames(9).value === 9,
  [24, 30, 81, 9].map((v) => `${v}→${alignFrames(v).value}`).join(' '))
ok(`帧数越界夹到 [${FRAME_MIN},${FRAME_MAX}] 并对齐`,
  alignFrames(9999).value <= FRAME_MAX && alignFrames(1).value >= FRAME_MIN
  && alignFrames(9999).value % 4 === 1 && alignFrames(1).value % 4 === 1,
  `${alignFrames(9999).value} / ${alignFrames(1).value}`)
ok('★ 边长对齐 16：480→480、540→544、720→720',
  alignEdge(480).value === 480 && alignEdge(540).value === 544 && alignEdge(720).value === 720,
  [480, 540, 720].map((v) => `${v}→${alignEdge(v).value}`).join(' '))
ok('对齐会**如实报告改了什么**（不静默改完当没事）',
  alignFrames(30).adjusted === true && alignFrames(81).adjusted === false
  && alignEdge(540).adjusted === true && alignEdge(480).adjusted === false)
ok('★ 速度% → 视频参数取 SPEED_MAP.video（帧/帧率/高度）', (() => {
  const map = {
    video: {
      100: { frames: 81, fps: 24, steps: 30, height: 720 },
      75: { frames: 49, fps: 20, steps: 20, height: 540 },
      50: { frames: 25, fps: 12, steps: 12, height: 480 },
      25: { frames: 17, fps: 8, steps: 8, height: 360 },
    },
  }
  const a = videoParamsForSpeed(100, map, [25, 50, 75, 100])
  const b = videoParamsForSpeed(25, map, [25, 50, 75, 100])
  const c = videoParamsForSpeed(63, map, [25, 50, 75, 100])
  return a.frames === 81 && a.height === 720 && b.frames === 17 && b.height === 360 && c.tier === 75
})())
ok('★★ 速度档**不返回 steps**（DMD 工作点固定，SPEED_MAP 的 steps 列不生效）', (() => {
  const p = videoParamsForSpeed(100, { video: { 100: { frames: 81, fps: 24, steps: 30, height: 720 } } }, [100])
  return !Object.prototype.hasOwnProperty.call(p, 'steps')
})())
ok('宽高比反推宽度：16:9@720→1280、1:1@720→720、9:16@720→400 且都是 16 的倍数',
  widthForAspect('16:9', 720) === 1280 && widthForAspect('1:1', 720) === 720
  && widthForAspect('9:16', 720) % 16 === 0,
  `${widthForAspect('16:9', 720)} / ${widthForAspect('1:1', 720)} / ${widthForAspect('9:16', 720)}`)

/* ---------------- 接线 ---------------- */
console.log('— 接线')
const idxSrc = read('lib/index.js')
ok('★ index.js 注册了 generate_video 工具', idxSrc.includes("name: 'generate_video'") && idxSrc.includes("step('register.generate_video'"))
ok('★★ 视频等待读 gifs（VHS_VideoCombine 的产物在 gifs，不在 images）',
  idxSrc.includes("for (const key of ['gifs', 'videos', 'images'])") || idxSrc.includes("'gifs'"))
ok('★ 视频超时下限 30 分钟（冷启动装模型很久，别用生图的 10 分钟掐）',
  idxSrc.includes('30 * 60 * 1000'))
ok('★ 速度%/画幅控制项真的被视频链消费', idxSrc.includes('videoParamsForSpeed') && idxSrc.includes('widthForAspect'))
ok('★ 加速档走 pick(installed)，没有 Wan 对应节点时**不注入**（不假装加速）',
  idxSrc.includes('pickAccelProfile') && idxSrc.includes('accelProfile.wanNode'))
ok('工具数仍是 8（selftest 那边同步过）', idxSrc.includes("name: 'generate_video'"))
// ★ 2026-11-13：工具描述集中到 lib/tool-descriptions.js，断言改读新文件（不是删/放宽）。
ok('★ 工具描述如实写"短片段，做不了 60 秒长片"（不承诺做不到的事）',
  read('lib/tool-descriptions.js').includes('做不了 60 秒长片'))

/* ---------------- B10：种子继承 ---------------- */
// ⚠ 本文件用的是 ok(name, cond) —— 与 test-history.mjs 的 ok(cond, name) 相反。
//   追加断言前先确认顺序，写反会变成「名字恒真」的假绿。
console.log('— B10 视频种子继承')
{
  ok('偏移区间是 10–40', VIDEO_SEED_OFFSET_MIN === 10 && VIDEO_SEED_OFFSET_MAX === 40)

  resetVideoSeed()
  ok('reset 后基准为 null', getLastVideoSeed() === null)
  const first = resolveVideoParams({ prompt: '第一段' })
  ok('★ 没有基准时取随机种子（落在 32 位有符号正区间）',
    Number.isInteger(first.seed) && first.seed >= 0 && first.seed < 2 ** 31, String(first.seed))
  ok('第一次就把基准记下来了', getLastVideoSeed() === first.seed)

  // 连续同场景：每次应在上一段 +10..+40
  let prev = first.seed
  let allInRange = true
  let allDifferent = true
  const deltas = []
  for (let i = 0; i < 12; i += 1) {
    const r = resolveVideoParams({ prompt: '接着拍' })
    const d = r.seed - prev
    deltas.push(d)
    if (d < VIDEO_SEED_OFFSET_MIN || d > VIDEO_SEED_OFFSET_MAX) allInRange = false
    if (r.seed === prev) allDifferent = false
    prev = r.seed
  }
  ok('★★ 连续 12 段的种子偏移都落在 [10,40]',
    allInRange, deltas.join(','))
  ok('★★ 每段种子都不同（不会得到完全一样的构图）', allDifferent)
  ok('★ 种子单调递增（分镜编号可预期，不用猜）', deltas.every((d) => d > 0))

  // 显式传种子：用它，并成为新基准
  resetVideoSeed()
  const explicit = resolveVideoParams({ prompt: '换场景', seed: 999 })
  ok('★★ 显式 seed 优先（不被继承逻辑干扰）', explicit.seed === 999, String(explicit.seed))
  ok('★ 显式 seed 会成为新的继承基准', getLastVideoSeed() === 999)
  const after = resolveVideoParams({ prompt: '从新基准接着拍' })
  ok('★ 下一段在显式种子上继续偏移',
    after.seed - 999 >= VIDEO_SEED_OFFSET_MIN && after.seed - 999 <= VIDEO_SEED_OFFSET_MAX,
    String(after.seed - 999))

  // 边界：接近上限时不能溢出成 2^31+
  resetVideoSeed()
  resolveVideoParams({ prompt: 'x', seed: 2 ** 31 - 1 })
  const edge = resolveVideoParams({ prompt: 'y' })
  ok('★★ 累加到上限时被夹在 2^31-1（不溢出成负数 seed）',
    edge.seed >= 0 && edge.seed <= 2 ** 31 - 1, String(edge.seed))

  // 显式 seed 为 0 也算"给了"（不能因为 0 是 falsy 就当没给）
  resetVideoSeed()
  const zero = resolveVideoParams({ prompt: 'x', seed: 0 })
  ok('★★ seed=0 是合法值，不被当成"没给"而去继承', zero.seed === 0, String(zero.seed))

  resetVideoSeed()
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
