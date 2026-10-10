// 验证 AbortController.abort(reason) 传非 Error 对象时，fetch 会以什么形式 reject。
// 用户报的 "Error: [object Object]" 极可能就出在这一条路径上。
const cases = [
  ['Error 实例', new Error('用户取消')],
  ['普通对象', { code: 'ABORT_ERR', message: 'aborted' }],
  ['字符串', 'aborted'],
  ['undefined', undefined],
]

for (const [label, reason] of cases) {
  const c = new AbortController()
  const p = fetch('http://127.0.0.1:59999/', { signal: c.signal, proxy: undefined })
  c.abort(reason)
  try {
    await p
    console.log(`${label.padEnd(10)} → 没抛错（意外）`)
  } catch (e) {
    const tag = e === reason ? '★同一引用' : '不同引用'
    console.log(`${label.padEnd(10)} → typeof=${typeof e} ctor=${e?.constructor?.name ?? '(无)'} ${tag}`)
    console.log(`${' '.repeat(13)}String(e)  = ${String(e)}`)
    console.log(`${' '.repeat(13)}e?.message = ${e?.message ?? '(undefined)'}`)
  }
}
