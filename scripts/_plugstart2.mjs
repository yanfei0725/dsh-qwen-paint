// 用插件自己的 ensureComfyUp 拉 ComfyUI —— 与生产路径完全一致，
// 避免手工拼参数导致"我这边测的环境 ≠ 用户实际环境"。
//
// 用法：node _plugstart2.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = process.env.USERPROFILE + '\\Documents\\dsh-qwen-paint'

// 动态 import 插件的 index.js（ESM）
const mod = await import('file:///' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))
const api = mod.default ?? mod

const logs = []
const log = (level, msg) => {
  logs.push(`[${level}] ${msg}`)
  console.log(`[${level}] ${msg}`)
}

// 找 ensureComfyUp —— 它在 __internal 命名空间下
const fn = api.ensureComfyUp ?? api.__internal?.ensureComfyUp
if (typeof fn !== 'function') {
  console.error('拿不到 ensureComfyUp。顶层键：', Object.keys(api).slice(0, 20))
  console.error('__internal 键：', Object.keys(api.__internal ?? {}).slice(0, 20))
  process.exit(1)
}

const cfg = {
  comfyUrl: 'http://127.0.0.1:8188',
  autoStartComfy: true,
  startTimeoutMs: 240000,
}
// 读真实配置覆盖
const cfgFile = path.join(ROOT, 'cordis.patch.yml')
if (fs.existsSync(cfgFile)) {
  const y = fs.readFileSync(cfgFile, 'utf8')
  for (const key of ['comfyPython', 'comfyMainPy', 'comfyWorkdir']) {
    const m = y.match(new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\n]+)['"]?`, 'm'))
    if (m) cfg[key] = m[1].trim()
  }
}
console.log('配置:', JSON.stringify(cfg, null, 2))

try {
  await fn(cfg, log, null)
  console.log('\n=== ComfyUI 已就绪 ===')
} catch (e) {
  console.error('\n=== 启动失败 ===')
  console.error(e.message)
  process.exit(1)
}
