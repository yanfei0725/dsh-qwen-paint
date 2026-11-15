#!/usr/bin/env node
/**
 * iterate-tool 离线回归：全离线、零联网、零出图、不依赖外部可执行文件。
 * 出图函数 runOne 全部注入假实现，绝不真出图、绝不真起子进程。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ITERATE_TOOL_NAME,
  STRATEGIES,
  ITERATE_ROUNDS_MAX,
  ITERATE_ROUNDS_DEFAULT,
  resolveImagePath,
  selectBest,
  makeIterateTool,
} from '../lib/iterate-tool.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'output')
const INSIDE = path.join(OUT, 'a.png')
const OUTSIDE = path.join(OUT, '..', 'escape.png')

let pass = 0
let fail = 0
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('iterate-tool 离线回归')

async function main() {
  // 工具形状与 schema。
  {
    const tool = makeIterateTool()
    ok('工具 name / timeoutMs 合规', tool.name === 'iterate_image' && tool.name === ITERATE_TOOL_NAME && tool.timeoutMs > 0)
    ok('output.schema.properties 声明齐全（5 键）',
      eq(Object.keys(tool.output.schema.properties).sort(), ['best', 'candidates', 'ok', 'reason', 'rounds']))
    ok('STRATEGIES 含四种策略', eq(STRATEGIES, ['seed_variant', 'prompt_delta', 'inpaint_refine', 'upscale_relook']))
    ok('rounds 上限 / 默认值为正且上限大于默认', ITERATE_ROUNDS_MAX > 0 && ITERATE_ROUNDS_DEFAULT > 0
      && ITERATE_ROUNDS_MAX >= ITERATE_ROUNDS_DEFAULT)
  }

  // 离线降级：没有 runOne 时 ok:false + 明确 reason，且不真出图。
  {
    const tool = makeIterateTool()
    const r = await tool.execute({ image_path: 'a.png', rounds: 2, strategy: 'seed_variant' })
    ok('无 runOne 时离线降级 ok:false', r.ok === false)
    ok('降级 reason 明确（绝不真出图 / 绝不联网 / 绝不真起子进程）',
      r.reason.indexOf('降级') >= 0 && r.reason.indexOf('真出图') >= 0
      && r.reason.indexOf('联网') >= 0 && r.reason.indexOf('子进程') >= 0)
    ok('降级返回 rounds=0 / candidates=[] / best 为对象', r.rounds === 0 && eq(r.candidates, [])
      && typeof r.best === 'object' && !Array.isArray(r.best))
  }

  // 目录围栏：判据与 asr 的 resolveAudioPath 一致。
  {
    ok('resolveImagePath：空路径被拒', resolveImagePath({ imagePath: '', outputDir: OUT }).ok === false)
    ok('resolveImagePath：越界路径被拒', resolveImagePath({ imagePath: OUTSIDE, outputDir: OUT }).ok === false)
    ok('resolveImagePath：目录内路径放行并返回绝对 file',
      resolveImagePath({ imagePath: INSIDE, outputDir: OUT }).ok === true
      && resolveImagePath({ imagePath: INSIDE, outputDir: OUT }).file === INSIDE)
    ok('resolveImagePath：outputDir 本身也算合法', resolveImagePath({ imagePath: OUT, outputDir: OUT }).ok === true)
    ok('resolveImagePath：没给 outputDir 时不猜目录（仅校验非空）',
      resolveImagePath({ imagePath: 'relative.png' }).ok === true)
  }

  // 越界路径：runOne 一次都不能被调用；降级态也先过围栏。
  {
    let calls = 0
    const tool = makeIterateTool({ cfg: { outputDir: OUT }, runOne: () => { calls += 1; return { score: 1 } } })
    const r = await tool.execute({ image_path: OUTSIDE, rounds: 2, strategy: 'seed_variant' })
    ok('越界 image_path 被目录围栏拒绝', r.ok === false && r.reason.indexOf('目录围栏') >= 0)
    ok('越界时 runOne 完全未被调用（零出图）', calls === 0)
    const degraded = await makeIterateTool({ cfg: { outputDir: OUT } }).execute({
      image_path: OUTSIDE, rounds: 2, strategy: 'seed_variant',
    })
    ok('离线降级态也先过目录围栏（围栏先于降级检查）',
      degraded.ok === false && degraded.reason.indexOf('目录围栏') >= 0)
  }

  // 合法路径 + 注入 runOne：真逻辑跑通，四种策略各自产出候选与 best。
  {
    for (const st of STRATEGIES) {
      let calls = 0
      const runOne = (params) => { calls += 1; return { score: params.round, echo: params.strategy } }
      const tool = makeIterateTool({ cfg: { outputDir: OUT }, runOne })
      const r = await tool.execute({ image_path: INSIDE, rounds: 3, strategy: st, feedback: 'more detail' })
      ok('四策略 ' + st + ' 跑通（3 轮 / best 非空 / runOne 调 3 次）',
        r.ok === true && r.rounds === 3 && r.candidates.length === 3
        && r.best.strategy === st && Object.keys(r.best).length > 0 && calls === 3)
    }
  }

  // selectBest：不同策略的挑选规则确实不同。
  {
    const mk = (round, score) => ({ round, ok: true, strategy: 'x', result: { score } })
    const cs = [mk(1, 9), mk(2, 1), mk(3, 5)]
    ok('selectBest(seed_variant) 取最高 score 的轮次', selectBest(cs, 'seed_variant').round === 1)
    ok('selectBest(upscale_relook) 取最高 score 的轮次', selectBest(cs, 'upscale_relook').round === 1)
    ok('selectBest(prompt_delta) 取最后一轮（渐进累积）', selectBest(cs, 'prompt_delta').round === 3)
    ok('selectBest(inpaint_refine) 取最后一轮（渐进精修）', selectBest(cs, 'inpaint_refine').round === 3)
    ok('selectBest 无成功候选时返回空对象（不是 null）',
      eq(selectBest([], 'seed_variant'), {}) && typeof selectBest([], 'seed_variant') === 'object')
  }

  // rounds 校验：上限 / 非法值 / 默认。
  {
    const tool = makeIterateTool({ cfg: { outputDir: OUT }, runOne: () => ({ score: 1 }) })
    const over = await tool.execute({ image_path: INSIDE, rounds: ITERATE_ROUNDS_MAX + 1, strategy: 'seed_variant' })
    ok('rounds 超过上限被拒 + reason', over.ok === false && over.reason.indexOf('上限') >= 0)
    const illegal = [0, -1, 1.5, 'abc']
    let allBad = true
    for (const v of illegal) {
      const r = await tool.execute({ image_path: INSIDE, rounds: v, strategy: 'seed_variant' })
      if (r.ok !== false) allBad = false
    }
    ok('rounds 0 / 负数 / 小数 / 非数字全部被拒', allBad)
    const def = await tool.execute({ image_path: INSIDE, strategy: 'seed_variant' })
    ok('不传 rounds 时用默认值', def.ok === true && def.rounds === ITERATE_ROUNDS_DEFAULT)
    const badStrategy = await tool.execute({ image_path: INSIDE, rounds: 2, strategy: 'nope' })
    ok('非法 strategy 被拒 + reason', badStrategy.ok === false && badStrategy.reason.indexOf('strategy') >= 0)
  }

  // 单轮失败续跑 / 全轮失败。
  {
    let n = 0
    const runOne = () => { n += 1; if (n === 2) throw new Error('round 2 boom'); return { score: n } }
    const tool = makeIterateTool({ cfg: { outputDir: OUT }, runOne })
    const r = await tool.execute({ image_path: INSIDE, rounds: 3, strategy: 'seed_variant' })
    ok('单轮失败记入候选并续跑（不拖垮整批）',
      r.ok === true && r.candidates.length === 3 && r.candidates[1].ok === false && r.best.ok === true)
    const allFail = makeIterateTool({
      cfg: { outputDir: OUT }, runOne: () => { throw new Error('always') },
    })
    const f = await allFail.execute({ image_path: INSIDE, rounds: 2, strategy: 'seed_variant' })
    ok('全轮失败：ok=false / best={} / reason 明确', f.ok === false && eq(f.best, {}) && f.reason.indexOf('没有可用候选') >= 0)
  }

  // withDeclaredOutput 裁剪后不能把结果裁成空对象（漏字段 = 空对象）。
  {
    const wrapped = withDeclaredOutput(makeIterateTool({
      cfg: { outputDir: OUT }, runOne: () => ({ score: 1 }),
    }))
    const r = await wrapped.execute({ image_path: INSIDE, rounds: 2, strategy: 'seed_variant' })
    const props = Object.keys(wrapped.output.schema.properties)
    ok('execute 返回顶层字段全部在 schema 声明内且裁剪后非空',
      props.length === 5 && props.every((p) => Object.prototype.hasOwnProperty.call(r, p))
      && Object.keys(r).length === 5)
  }
}

main().then(() => {
  console.log('=== iterate-tool：' + pass + ' 项通过，' + fail + ' 项失败 ===')
  if (fail > 0) process.exitCode = 1
}).catch((e) => {
  console.error(e)
  process.exitCode = 1
})
