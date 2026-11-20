#!/usr/bin/env node
/**
 * scripts/setup-quality-fix.mjs —— 画质修复 LoRA 的可选下载/校验入口（CLI）。
 * 与 setup-audio-models.mjs 同范式：默认只读、绝不自动下载、只进不出。
 *
 * 用法（全部默认只读，不下载、不安装）：
 *   node scripts/setup-quality-fix.mjs --list
 *   node scripts/setup-quality-fix.mjs --check --dir=<ComfyUI/models/loras 绝对路径>
 *   node scripts/setup-quality-fix.mjs --guide --id=fix-lora
 *   不带参数 → 打印清单与自检提示，绝不下载。
 *
 * 边界：
 *   · 只下载、不安装；装到哪由用户自己决定（--dir 只是校验用）。
 *   · 仓库未核实 → 不编造 URL，只给自备指引；本脚本当前不执行网络下载。
 *   · 完整性只以权威 sha256 判定；默认关闭、无 --download 承诺。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  QUALITY_FIX_FILES, SELF_BRING_PAGES, RULES,
  listQualityFixFiles, findQualityFixFile, selfBringGuide, verifyAgainstAuthoritative,
} from './quality-fix-catalog.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : ''
}
const has = (name) => argv.includes('--' + name)

function printList() {
  console.log('画质修复 LoRA 登记清单（只读；默认不下载、不安装）')
  console.log('')
  for (const f of listQualityFixFiles()) {
    console.log(`  [${f.id}] ${f.label}`)
    console.log(`      文件：${f.filename}（目标目录 models/${f.targetDir}）`)
    console.log(`      权威 size：${f.size} B（${(f.size / 1048576).toFixed(1)} MiB）`)
    console.log(`      权威 sha256：${f.sha256}`)
    console.log(`      用于预设：${f.usedBy.length ? f.usedBy.join(', ') : '（可选叠加，非两档必需）'}`)
    if (f.note) console.log(`      说明：${f.note}`)
  }
  console.log('')
  for (const r of RULES) console.log('  · ' + r)
}

/** 只读校验：扫描 --dir 里的文件，比 size + sha256。不下载、不改动。 */
async function check(dirRaw) {
  if (!dirRaw) {
    console.log('✗ --check 需要 --dir=<ComfyUI/models/loras 的绝对路径>')
    return
  }
  const dir = path.resolve(String(dirRaw))
  if (!fs.existsSync(dir)) {
    console.log(`✗ 目录不存在：${dir}`)
    return
  }
  console.log(`校验目录：${dir}`)
  for (const f of QUALITY_FIX_FILES) {
    const full = path.join(dir, f.filename)
    if (!fs.existsSync(full)) {
      console.log(`  [缺] ${f.filename} → 未安装（自备：--guide --id=${f.id}）`)
      continue
    }
    const stat = fs.statSync(full)
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(full)
      rs.on('data', (c) => hash.update(c))
      rs.on('end', resolve)
      rs.on('error', reject)
    })
    const r = verifyAgainstAuthoritative(f.id, { size: stat.size, sha256: hash.digest('hex') })
    console.log(`  [${r.ok ? 'OK' : 'BAD'}] ${f.filename} → ${r.reason}`)
  }
}

function guide(id) {
  const g = selfBringGuide(id)
  if (!g.ok) { console.log('✗ ' + g.reason); return }
  console.log(`自备指引：${g.filename}`)
  console.log(`  size：${g.size} B`)
  console.log(`  sha256：${g.sha256}`)
  console.log(`  放到：ComfyUI/models/${g.targetDir}/`)
  console.log('  检索入口（页面，非文件直链）：')
  for (const p of g.pages) console.log('    ' + p)
  console.log('  ' + g.reason)
}

async function main() {
  if (has('list') || process.argv.length <= 2) { printList(); return }
  if (has('check')) { await check(flag('dir')); return }
  if (has('guide')) { guide(flag('id')); return }
  console.log('未知参数。可用：--list | --check --dir=<path> | --guide --id=<id>')
}

main().catch((e) => { console.error('运行失败：' + (e?.message ?? e)); process.exitCode = 1 })
