#!/usr/bin/env node
/**
 * hipfire-img 纯函数直测（2026-11-20 补覆盖缺口④，勘察报告 #14：5 导出零触及）。
 *
 * 切片：parseSizeString（尺寸串解析）+ extractJsonPathFromCliOutput（CLI 输出里
 *   抓产物路径）—— 两个无 I/O 纯函数，直测无 mock。
 *
 * 纯离线。
 */
import { parseSizeString, extractJsonPathFromCliOutput } from '../lib/hipfire-img.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('— parseSizeString')
ok('★ "1920x1080" → [1920,1080]', eq(parseSizeString('1920x1080'), [1920, 1080]), JSON.stringify(parseSizeString('1920x1080')))
ok('大写 X / 星号 / 全角乘号同解析',
  eq(parseSizeString('512X512'), [512, 512]) && eq(parseSizeString('64*64'), [64, 64]) && eq(parseSizeString('768×768'), [768, 768]))
ok('两端空白容忍', eq(parseSizeString('  1024 x 1024 '), [1024, 1024]))
ok('非字符串 → null', parseSizeString(1920) === null && parseSizeString(null) === null && parseSizeString(undefined) === null)
ok('坏格式 → null（单数字 / 非数字 / 缺分隔）',
  parseSizeString('1920') === null && parseSizeString('axb') === null && parseSizeString('19201080') === null)

console.log('— extractJsonPathFromCliOutput')
ok('★ 纯 JSON 行：output 字段直取',
  extractJsonPathFromCliOutput('{"output":"X:/a.png"}') === 'X:/a.png')
ok('★ 混进度输出：取最后一个 JSON 行（早先行带有效 out 也让位末行）',
  extractJsonPathFromCliOutput('step 1/4\n{"out":"partial.png"}\n{"output":"X:/final.png"}\n') === 'X:/final.png'
  && extractJsonPathFromCliOutput('{"out":"partial.png"}\n{"out":"final.png"}') === 'final.png',
  extractJsonPathFromCliOutput('{"out":"partial.png"}\n{"out":"final.png"}'))
ok('字段别名 out/path/file/png 依次兼容',
  ['out', 'path', 'file', 'png'].every((k) => extractJsonPathFromCliOutput(`{"${k}":"p.png"}`) === 'p.png'))
ok('坏 JSON 行跳过、后续好行仍可用',
  extractJsonPathFromCliOutput('{oops\n{"out":"good.png"}') === 'good.png')
ok('兜底：无换行整段正则也能抓',
  extractJsonPathFromCliOutput('noise {"file":"b.png"} noise') === 'b.png')
ok('无产物 → null', extractJsonPathFromCliOutput('plain text') === null && extractJsonPathFromCliOutput('') === null)
ok('空串字段不收（typeof string && !== ""）',
  extractJsonPathFromCliOutput('{"output":""}') === null)

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
