/**
 * _manifest_test.mjs —— 插件包元信息与关键文件完整性自检。
 *
 * ## 为什么需要它（2026-10-09 事故）
 *   排查过程中有一条命令写错了相对层级：
 *     cp _vendor/package.json _vendor/node_modules/@deepseek-ai/cordis/../../../../package.json
 *   `cordis/../../../../` 一路退到了**插件根目录**，把插件的 `package.json`
 *   覆盖成了 `{"name":"vendor","type":"module"}`。
 *   后果：DSH 认不出这个包 ⇒ **插件在管理器里直接消失**。
 *
 *   教训：**改任何文件前，先确认目标路径规范化后到底落在哪。**
 *   这个测试把"元信息必须正确"钉成可自动验证的事实，杜绝再次发生。
 *
 * 用法：node scripts/_manifest_test.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
let pass = 0
let fail = 0
const ok = (n) => { pass++; console.log('  OK  ', n) }
const bad = (n, x) => { fail++; console.log('  FAIL', n, x ?? '') }

console.log('=== 插件包元信息自检 ===')

// ---- 1. package.json 必须存在且合法 ----
const PKG = path.join(ROOT, 'package.json')
if (!existsSync(PKG)) {
  bad('package.json 存在')
  console.log(`\n=== 结果：失败 ===`)
  process.exit(1)
}
ok('package.json 存在')

let pkg
try {
  pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  ok('package.json 是合法 JSON')
} catch (e) {
  bad('package.json 解析', e.message)
  console.log(`\n=== 结果：失败 ===`)
  process.exit(1)
}

// ---- 2. 必需字段（DSH 靠这些认插件）----
const REQUIRED = [
  ['name', 'dsh-qwen-paint'],
  ['version', '0.1.2'],
  ['main', 'lib/index.js'],
  ['type', 'module'],
]
for (const [key, want] of REQUIRED) {
  if (pkg[key] === want) ok(`package.json ${key} = ${want}`)
  else bad(`package.json ${key}`, `应为 ${want}，实际 ${JSON.stringify(pkg[key])}`)
}

// ---- 3. dsh 段（插件能被 DSH 加载的关键）----
if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') ok('dsh.bundle.patch 指向 cordis.patch.yml')
else bad('dsh.bundle.patch', JSON.stringify(pkg.dsh?.bundle))

if (Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('slots')) {
  ok('dsh.client.inject 含 slots')
} else {
  bad('dsh.client.inject', JSON.stringify(pkg.dsh?.client))
}

if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.platform = web')
else bad('dsh.client.platform', JSON.stringify(pkg.dsh?.client?.platform))

// ---- 4. exports 映射（client 半边靠它）----
if (pkg.exports?.['.']?.default === './lib/index.js') ok('exports["."] → lib/index.js')
else bad('exports["."]', JSON.stringify(pkg.exports?.['.']))

if (pkg.exports?.['./client']?.default === './lib/client.js') ok('exports["./client"] → lib/client.js')
else bad('exports["./client"]', JSON.stringify(pkg.exports?.['./client']))

// ---- 5. 关键文件都在 ----
for (const rel of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  if (existsSync(path.join(ROOT, rel))) ok(`${rel} 存在`)
  else bad(`${rel} 存在`)
}

// ---- 6. description 没被污染（事故的典型痕迹）----
if (typeof pkg.description === 'string' && pkg.description.includes('千问')) {
  ok('description 正常（未被覆盖）')
} else {
  bad('description 疑似被覆盖', JSON.stringify(pkg.description)?.slice(0, 80))
}

// ---- 7. 严禁出现排查残留的字段 ----
if (pkg.name === 'vendor') bad('name 被覆盖成 vendor（事故痕迹）')
else ok('name 未被覆盖成 vendor')

console.log(`\n=== 结果：${fail === 0 ? '通过' : `失败 ${fail} 项`} ===`)
process.exit(fail === 0 ? 0 : 1)
