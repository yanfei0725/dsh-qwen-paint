// 验证：BlockCache T8 那一项确实带上了 `toggle` 字段 —— 前端就是靠它渲染开关的。
// 主人要求：「BlockCache T8 只显示怎么调，但没提供开关……请改成可以自行开启或关闭的选项」。
// ⚠ 路径相对本文件解析，不写死用户目录（打包有隐私检查）。
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const I = mod.__internal
const cfg = { ...I.DEFAULTS, blockCacheEnabled: false }
const caps = { ...I.FULL_CAPS, gpu: { name: 'AMD Radeon RX 7900 XT', vramGB: 20 } }
const st = I.describeOptimization(cfg, caps)
const bc = st.detail.find((d) => d.name.includes('BlockCache'))
console.log('BlockCache 项完整字段:')
console.log(JSON.stringify(bc, null, 2))
console.log('')
const ok = Boolean(bc?.toggle && bc.toggle.key === 'blockcache' && bc.toggle.canToggle === true)
console.log('有 toggle ?', bc?.toggle ? '✅' : '❌')
console.log('key      :', bc?.toggle?.key)
console.log('on       :', bc?.toggle?.on)
console.log('canToggle:', bc?.toggle?.canToggle)
console.log('')
console.log(ok ? '结果：通过' : '结果：失败')
if (!ok) process.exit(1)
