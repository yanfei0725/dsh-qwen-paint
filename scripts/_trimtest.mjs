// 验证 prompt 精简真的在工作（不是"配置写了但没生效"）。
// 直接调插件的 trimPrompt 逻辑 —— 通过 buildWorkflow 的导出验证。

import path from 'node:path'

const ROOT = process.env.USERPROFILE + '\\Documents\\dsh-qwen-paint'
const mod = await import('file:///' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))
const api = mod.default ?? mod
const I = api.__internal ?? {}

const bw = I.buildWorkflow
if (typeof bw !== 'function') {
  console.error('拿不到 buildWorkflow。__internal 键：', Object.keys(I).slice(0, 40))
  process.exit(1)
}

const dirty = '  a red   car,,,,\n\non a wet street ...   '
const cfg = {}  // 用 DEFAULTS

const wf = bw(cfg, { prompt: dirty, negative: '', width: 1024, height: 1024, steps: 8, seed: 1 }, null)
const got = wf[5].inputs.prompt

console.log('原始 prompt:', JSON.stringify(dirty))
console.log('精简后    :', JSON.stringify(got))
console.log('')

let ok = true
const checks = [
  ['换行被折叠', !got.includes('\n')],
  ['连续逗号被合并', !got.includes(',,')],
  ['首尾空白被去掉', got === got.trim()],
  ['语义文字保留', got.includes('a red car') || got.includes('a red   car'.replace(/\s+/g, ' '))],
  ['末尾悬挂标点被去掉', !/[\s,，.。;；:：]+$/.test(got)],
]
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '[OK]' : '[!!]'} ${name}`)
  if (!pass) ok = false
}

// 再验一下"关闭时不动"
const wf2 = bw({ promptTrimEnabled: false }, { prompt: dirty, negative: '', width: 1024, height: 1024, steps: 8, seed: 1 }, null)
const got2 = wf2[5].inputs.prompt
console.log('')
console.log(JSON.stringify(got2) === JSON.stringify(dirty)
  ? '  [OK] promptTrimEnabled=false 时原样透传'
  : `  [!!] 关闭时仍被改动: ${JSON.stringify(got2)}`)
if (JSON.stringify(got2) !== JSON.stringify(dirty)) ok = false

console.log('')
console.log(ok ? 'prompt 精简工作正常 ✅' : '有问题 ❌')
process.exit(ok ? 0 : 1)
