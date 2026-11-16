#!/usr/bin/env node
/**
 * check-size.mjs —— 发布**之前**的体积守卫（package.json 的 prepack 会调它）。
 *
 * 0.32.1 审计 B 项：原来 5 处体积断言全是「事后」（跑回归时才发现超了）。
 * 挂到 prepack 后，npm pack / npm publish 在打包前就会拦住越界文件，
 * 不会出现「已经推上去了才发现装不上」。
 *
 * 策略：单文件 > 262144 B 或 lib/ 合计 > 2097152 B → 硬失败；
 *       余量 < 8192 B → 提示可执行减压命令；< 256 B → 明确告警。
 *       两者都不阻塞（贴线不等于违规），但不再等到 256 B 才提醒。
 *
 * 2026-11-16 红线根治：长注释可一键外置——
 *   node scripts/slim-comments.mjs --plan   预览
 *   node scripts/slim-comments.mjs --apply  执行（跑完必须全量回归）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIMIT_FILE = 262144
const LIMIT_LIB = 2097152
const dir = path.join(ROOT, 'lib')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
const sizes = files.map((f) => ({ f, b: fs.statSync(path.join(dir, f)).size }))
const over = sizes.filter((x) => x.b > LIMIT_FILE)
const total = sizes.reduce((s, x) => s + x.b, 0)

for (const x of over) console.error(`✗ ${x.f} ${x.b} B 超过单文件上限 ${LIMIT_FILE} B`)
if (total > LIMIT_LIB) console.error(`✗ lib/ 合计 ${total} B 超过 ${LIMIT_LIB} B`)
for (const x of sizes.filter((v) => v.b > LIMIT_FILE - 8192).sort((a, b) => b.b - a.b)) {
  const free = LIMIT_FILE - x.b
  const level = free < 256 ? '!! 贴线告警' : '! 余量偏紧'
  console.log(`  ${level} ${x.f} 余量 ${free} B`)
  if (x.f === 'index.js') {
    console.log('     → 可跑 node scripts/slim-comments.mjs --plan 查看可外置的设计注释')
  }
}
if (over.length > 0 || total > LIMIT_LIB) process.exit(1)
console.log(`体积守卫通过：${files.length} 个 lib/*.js，合计 ${total} B`)
