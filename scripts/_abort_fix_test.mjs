// 验证：非 Error 对象（尤其普通对象）经规范化后不再泄漏成 "[object Object]"。
//
// 根因详见 lib/index.js 里 toError / cancelReason 的注释：
//   `controller.abort(signal.reason)` 会把 reason **原样**变成 fetch 的 reject 值，
//   而 DSH 宿主传进来的 reason 是个普通对象 → 宿主 String() 之后就成了
//   `Error: [object Object]`，把真实原因全糊掉。
//
// ⚠ 路径一律用**相对本文件**解析，不写死用户目录 —— 否则打包时的隐私检查会拦下整个 zip
//   （测试脚本会进包，见 scripts/pack.mjs 的规则）。
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const I = mod.__internal
console.log('toError 是否导出:', typeof I.toError)
console.log('cancelReason 是否导出:', typeof I.cancelReason)
console.log('')

const cases = [
  ['Error 实例', new Error('用户取消')],
  ['普通对象(带message)', { message: '宿主中止', code: 'ABORT' }],
  ['普通对象(带code)', { code: 'ABORT_ERR', detail: '取消了' }],
  ['普通对象(空)', {}],
  ['字符串', 'aborted'],
  ['null', null],
  ['undefined', undefined],
  ['数组', [1, 2]],
]

let bad = 0
for (const [label, reason] of cases) {
  const fake = { aborted: true, reason }
  const err = I.cancelReason(fake)
  const s = String(err)
  const leaked = s.includes('[object Object]')
  if (leaked) bad += 1
  console.log(`${label.padEnd(22)} → ${leaked ? '❌' : '✅'} ${s}`)
}

console.log('')
const e1 = I.toError({ message: '真原因' })
console.log('toError({message}) →', e1 instanceof Error, '|', e1.message)
const e2 = I.toError({ a: 1, b: 2 })
console.log('toError({a,b})      →', e2 instanceof Error, '|', e2.message)
const e3 = I.toError(undefined)
console.log('toError(undefined)  →', e3 instanceof Error, '|', e3.message)
const e4 = I.toError([1, 2, 3])
console.log('toError([1,2,3])    →', e4 instanceof Error, '|', e4.message)
console.log('')
console.log(bad === 0 ? '结果：通过（无 [object Object] 泄漏）' : `结果：失败（${bad} 例泄漏）`)
if (bad > 0) process.exit(1)
