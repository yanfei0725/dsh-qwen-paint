#!/usr/bin/env node
/**
 * vram-budget 离线回归：全离线、零联网、零出图、不依赖外部可执行文件。
 * 纯函数断言，只校验档位解析、非法拒绝、按 kind 独立、launchArgs 的诚实措辞。
 */
import {
  VRAM_BUDGET_CHOICES,
  resolveVramBudget,
  listVramBudgetKinds,
} from '../lib/vram-budget.js'

let pass = 0
let fail = 0
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('vram-budget 离线回归')

// 档位表：0/2/4/8/12/16/24 GB 与无上限 null。
ok('档位表共 8 项（7 个有限 + 1 个无上限）', VRAM_BUDGET_CHOICES.length === 8)
ok('档位 GB 集合正确', eq(VRAM_BUDGET_CHOICES.map((c) => c.gb), [0, 2, 4, 8, 12, 16, 24, null]))
ok('每个有限档位 mb = gb * 1024',
  VRAM_BUDGET_CHOICES.filter((c) => c.gb !== null).every((c) => c.mb === c.gb * 1024))
ok('无上限档位 gb/mb 都是 null（不是 Infinity）',
  VRAM_BUDGET_CHOICES.some((c) => c.gb === null && c.mb === null && c.id === 'unlimited'))
ok('档位表所有 gb/mb 都不是 Infinity（null 或有限数），JSON 往返后仍是 null',
  VRAM_BUDGET_CHOICES.every((c) => c.gb !== Infinity && c.mb !== Infinity
    && (c.gb === null || Number.isFinite(c.gb)) && (c.mb === null || Number.isFinite(c.mb)))
  && VRAM_BUDGET_CHOICES.every((c) => {
    const back = JSON.parse(JSON.stringify(c))
    return back.gb === null || Number.isFinite(back.gb)
  }))
ok('0 GB 档位 cpuOnly 标记为真',
  VRAM_BUDGET_CHOICES.find((c) => c.gb === 0).cpuOnly === true)

// 全部档位都能正确解析。
{
  const finite = [0, 2, 4, 8, 12, 16, 24]
  const all = finite.every((gb) => {
    const r = resolveVramBudget({ requested: gb, kind: 'image' })
    return r.ok === true && r.mb === gb * 1024 && r.limited === true
  })
  ok('全部 7 个有限档位解析得到正确 mb 与 limited', all)
  ok('字符串档位 "8" 与数字 8 等价',
    resolveVramBudget({ requested: '8', kind: 'image' }).mb === 8192)
}

// 无上限：显式 null 与 unlimited 别名。
{
  const a = resolveVramBudget({ requested: null, kind: 'image' })
  const b = resolveVramBudget({ requested: 'unlimited', kind: 'image' })
  ok('显式 null 表示无上限（mb=null, limited=false, launchArgs=[]）',
    a.ok === true && a.mb === null && a.limited === false && eq(a.launchArgs, []))
  ok('unlimited 别名同样得到无上限', b.ok === true && b.mb === null && b.limited === false)
  ok('无上限结果的 gb/mb 是 null 而非 Infinity，JSON 往返后仍是 null',
    a.gb === null && a.mb === null && a.gb !== Infinity && a.mb !== Infinity
    && JSON.parse(JSON.stringify(a)).gb === null && JSON.parse(JSON.stringify(a)).mb === null)
}

// 0 GB：纯 CPU。
{
  const r = resolveVramBudget({ requested: 0, kind: 'image' })
  ok('0 GB 明确表示纯 CPU / 权重不放进显存',
    r.ok === true && r.mb === 0 && r.limited === true && r.reason.indexOf('纯 CPU') >= 0)
  ok('0 GB 的建议启动参数含 --cpu', r.launchArgs.indexOf('--cpu') >= 0)
}

// 非法值一律拒绝并给 reason。
{
  const bads = [6, 10, 32, -1, 3.5, 'abc', Number.NaN, true, {}, -0.5, 1.5]
  const allRejected = bads.every((v) => {
    const r = resolveVramBudget({ requested: v, kind: 'image' })
    return r.ok === false && typeof r.reason === 'string' && r.reason.length > 0
  })
  ok('11 个超出档位 / 非法值全部 ok=false + 非空 reason', allRejected)
  ok('非法 max 也被拒绝',
    resolveVramBudget({ requested: 8, max: 7, kind: 'image' }).ok === false)
}

// max 收敛：请求超过上限时收敛到上限档位。
{
  const r = resolveVramBudget({ requested: 16, max: 8, kind: 'video' })
  ok('requested 超过 max 时收敛到 max 档位',
    r.ok === true && r.mb === 8192 && r.limited === true && r.reason.indexOf('收敛') >= 0)
  const u = resolveVramBudget({ requested: null, max: 4, kind: 'video' })
  ok('无上限请求 + max 时按 max 收敛', u.ok === true && u.mb === 4096 && u.limited === true)
}

// 按 kind 独立设上限：省略 requested 时用各自独立默认，互不串。
{
  const kinds = listVramBudgetKinds()
  const names = kinds.map((k) => k.kind)
  ok('listVramBudgetKinds 含 image/video/tts/upscale/inpaint/batch',
    eq(names, ['image', 'video', 'tts', 'upscale', 'inpaint', 'batch']))
  ok('每个 kind 都有独立的 defaultGb 档位值',
    kinds.every((k) => [0, 2, 4, 8, 12, 16, 24].indexOf(k.defaultGb) >= 0))
  const defaults = {}
  for (const k of kinds) defaults[k.kind] = resolveVramBudget({ kind: k.kind }).mb
  ok('各 kind 独立默认互不串（image=8GB/video=16GB/tts=4GB...）',
    defaults.image === 8192 && defaults.video === 16384 && defaults.tts === 4096
    && defaults.upscale === 4096 && defaults.inpaint === 8192 && defaults.batch === 4096)
  ok('按 kind 显式传不同 requested 也各自独立结算',
    resolveVramBudget({ requested: 2, kind: 'tts' }).mb === 2048
    && resolveVramBudget({ requested: 24, kind: 'video' }).mb === 24576
    && resolveVramBudget({ requested: 4, kind: 'image' }).mb === 4096)
  ok('未登记的 kind 按通用档位处理且不谎称已登记',
    resolveVramBudget({ requested: 12, kind: 'custom' }).reason.indexOf('未登记') >= 0)
}

// launchArgs：只生成合理参数字符串，绝不承诺实际显存占用。
{
  const forbidden = ['保证', '确保', '承诺', '实际占用', '不超过', '一定', '必定']
  const finite = [0, 2, 4, 8, 12, 16, 24]
  const allClean = finite.every((gb) => {
    const r = resolveVramBudget({ requested: gb, kind: 'image' })
    const isArr = Array.isArray(r.launchArgs) && r.launchArgs.every((x) => typeof x === 'string')
    // 首个 token 是开关，后面允许带数值（如 --reserve-vram 0.5），所以只校验首元素。
    const flagsOk = r.launchArgs.length > 0 && r.launchArgs[0].indexOf('--') === 0
    const noPromise = r.launchArgs.every((x) => forbidden.every((w) => x.indexOf(w) < 0))
    return isArr && flagsOk && noPromise
  })
  ok('全部有限档位 launchArgs 是 "--" 开头的字符串数组、不含承诺词', allClean)
  const r = resolveVramBudget({ requested: 12, kind: 'image' })
  ok('reason 明确写「建议启动参数」与「不保证/不承诺实际显存占用」',
    r.reason.indexOf('建议') >= 0 && r.reason.indexOf('不保证') >= 0
    && r.reason.indexOf('实际显存占用') >= 0)
  ok('无上限档位 launchArgs 为空数组（不额外加限制参数）',
    eq(resolveVramBudget({ requested: null, kind: 'image' }).launchArgs, []))
  ok('0 GB 与无上限的 limited 语义相反（true vs false）',
    resolveVramBudget({ requested: 0 }).limited === true
    && resolveVramBudget({ requested: null }).limited === false)
}

console.log('=== vram-budget：' + pass + ' 项通过，' + fail + ' 项失败 ===')
if (fail > 0) process.exitCode = 1
