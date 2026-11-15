#!/usr/bin/env node
/**
 * test-overflow.mjs —— 「进度条 / 滑块 / 卡片横向溢出」加固护栏（全离线）。
 *
 * 背景：2026-11-15 用户反馈「那几个进度条的框直接溢出了」。容器实测
 *   /comfy-pipeline/panel.css 与本地逐字节一致，排除缓存旧版；根因是
 *   content-box 宽度叠加 padding/border、滑块 width:100% 与 flex 子项
 *   min-width:auto 不肯收缩。修复落在 panel.css / lab.css / setup-guide.css
 *   末尾的统一盒模型区块。
 *
 * 本测试不只是「查字符串在不在」：validateGuards() 是纯函数，会用改造后的
 *   内存字符串反向核查「删掉关键声明 → 必须变红」，杜绝假绿。
 * 全程只读文件 + 纯字符串运算：零联网、零出图、零子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (typeof name !== 'string') throw new Error('ok(名称, 条件)：第一个参数必须是名称')
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

const GUARD_MARK = '防横向溢出'
const REQUIRED_DECL = ['box-sizing: border-box', 'min-width: 0', 'max-width: 100%']
const SELECTORS = {
  'assets/panel.css': [
    '.cp-panel', '.cp-card', '.cp-field', '.cp-field-top', '.cp-ticks',
    '.cp-progress', '.cp-progress-track', '.cp-progress-fill', '.cp-progress-note',
    '.cp-field input[type="number"]', '.cp-field input[type="range"]',
  ],
  'assets/lab.css': [
    '.dshqp-lab-slot', '.dshqp-lab-sections', '.dshqp-lab-sec',
    '.dshqp-lab-row', '.dshqp-lab-result', '.dshqp-lab-input',
  ],
  'assets/setup-guide.css': [
    '.sg-barwrap', '.sg-bar', '.sg-progress', '.sg-card', '.sg-cmdrow', '.sg-list',
  ],
}

/** 取「防横向溢出」注释之后的全部内容（加固区块在文件末尾）。 */
export function guardBlock(css) {
  const i = css.indexOf(GUARD_MARK)
  return i < 0 ? null : css.slice(i)
}

/**
 * 纯函数：加固区块的**第一条规则**必须同时满足
 *   · 选择器列表点名全部目标选择器（不是「区块任意位置出现」就算）；
 *   · 该规则的声明体里三条盒模型声明齐全。
 * ★ 收紧口径的原因：首版只查「区块里出现」，panel.css 里 min-width:0 与
 *   .cp-panel 各出现两次，删掉第一处仍留第二处 ⇒ 反向核查「改坏没红」。
 *   这是护栏假绿，不是产品 bug；按纪律收紧护栏，绝不放宽断言去迁就。
 */
export function validateGuards(css, selectors) {
  const block = guardBlock(css)
  if (!block) return false
  const body = block.replace(/\/\*[\s\S]*?\*\//gu, '')
  const open = body.indexOf('{')
  const close = body.indexOf('}', open)
  if (open < 0 || close < 0) return false
  const selectorList = body.slice(0, open)
  const declarations = body.slice(open + 1, close)
  if (!REQUIRED_DECL.every((d) => declarations.includes(d))) return false
  if (!selectors.every((s) => selectorList.includes(s))) return false
  return true
}

console.log('=== 1. 三份 CSS 的防溢出区块 ===')
const sources = {}
for (const [file, selectors] of Object.entries(SELECTORS)) {
  const css = read(file)
  sources[file] = css
  ok(file + ' 有防溢出区块', guardBlock(css) !== null)
  ok('★ ' + file + ' 区块完整（三声明 + 全部目标选择器）', validateGuards(css, selectors))
}

console.log('\n=== 2. 关键溢出点逐条锁住 ===')
{
  const panel = sources['assets/panel.css']
  ok('★ 面板收掉横向溢出（overflow-x: hidden）',
    guardBlock(panel).includes('.cp-panel { overflow-x: hidden; }'))
  ok('★ 进度条轨道显式 width:100%，不再靠块级默认',
    guardBlock(panel).includes('.cp-progress-track { width: 100%; }'))
  ok('★ 滑块（用户说的「进度条框」）进了盒模型收口',
    guardBlock(panel).includes('.cp-field input[type="range"]'))
  ok('★ 读数 / 提示 / 刻度长文本可断行',
    guardBlock(panel).includes('overflow-wrap: anywhere'))
  const lab = sources['assets/lab.css']
  ok('★ 内嵌功能区 result 可断长 JSON', guardBlock(lab).includes('.dshqp-lab-result { overflow-wrap: anywhere; }'))
  ok('★ 内嵌功能区没有退回独立浮层',
    !lab.includes('position: fixed') && !lab.includes('inset: 0;'))
  const guide = sources['assets/setup-guide.css']
  ok('★ 安装引导进度条 bar 有 max-width 封顶',
    guardBlock(guide).includes('.sg-bar { max-width: 100%; }'))
}

console.log('\n=== 3. 接线：三份 CSS 都在静态资源路由表里 ===')
{
  const routes = read('lib/asset-route.js')
  ok('panel.css / lab.css / setup-guide.css 都被宿主提供',
    ['panel.css', 'lab.css', 'setup-guide.css'].every((f) => routes.includes("'" + f + "'")))
  ok('★ 修复没有塞进冻结的 index.js / client.js',
    !read('lib/index.js').includes(GUARD_MARK) && !read('lib/client.js').includes(GUARD_MARK))
  ok('index.js 仍在单文件红线内',
    fs.statSync(path.join(ROOT, 'lib/index.js')).size <= 262144)
}

console.log('\n=== 4. ★ 反向核查：改坏必须变红（内存改串，不落盘） ===')
for (const [file, selectors] of Object.entries(SELECTORS)) {
  const css = sources[file]
  const i = css.indexOf(GUARD_MARK)
  const head = css.slice(0, i)
  const tail = css.slice(i)
  // ★ 必须全文替换：panel.css 的 min-width:0 / .cp-panel 在区块里出现两次，
  //   只替第一处会留下第二处，反向核查会假绿（首版实测踩过）。
  const noBoxSizing = head + tail.replaceAll('box-sizing: border-box', '/* removed */')
  ok('★ ' + file + ' 删掉 box-sizing 后护栏变红', !validateGuards(noBoxSizing, selectors))
  const noMinWidth = head + tail.replaceAll('min-width: 0', '/* removed */')
  ok('★ ' + file + ' 删掉 min-width:0 后护栏变红', !validateGuards(noMinWidth, selectors))
  const noSelector = head + tail.replaceAll(selectors[0], '/* removed */')
  ok('★ ' + file + ' 删掉 ' + selectors[0] + ' 后护栏变红', !validateGuards(noSelector, selectors))
  const noBlock = head.trimEnd()
  ok('★ ' + file + ' 整块删掉后护栏变红', !validateGuards(noBlock, selectors))
}

console.log(`\n=== test-overflow：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
