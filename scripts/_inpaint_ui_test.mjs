/**
 * _inpaint_ui_test.mjs —— 0.17.13「面板圈选局部重绘」三项修复的回归锁。
 *
 * 覆盖（每条都对应一处真实缺陷）：
 *   1. 一次性蒙版文件写完不删 → outputDir 里越堆越多（dotfile 更难发现）
 *   2. 蒙版文件名只拼 Date.now() → 同毫秒并发两次圈选互相覆盖
 *   3. 弹窗结果图走内核 `api/file?path=` → 该路由只服务"已登记"文件，
 *      而 UI 重绘结果没走 tools/result 钩子登记 ⇒ 大概率裂图
 *   4. 连点「再改一次」→ 每次成功都 append 一个新 <img>，结果图越叠越长
 *   5. 重复点图片 → 圈选浮层层层叠加（底层监听器泄漏）
 *
 * 断言方式：行为级（调 __internal.uiMaskPath）+ 源码级锁（读 lib 源码）。
 * ⚠ 源码级"必须不存在"的断言**必须先剥注释** —— 修复注释里原样引用了坏代码。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { uiMaskPath } = mod.__internal
const INDEX = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
// 剥注释：C 风格块注释 + 行注释（行注释带 m 标志逐行匹配）
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

console.log('=== 1. uiMaskPath：一次性蒙版路径（行为级） ===')
{
  const a = uiMaskPath({ outputDir: 'C:\\out' })
  const b = uiMaskPath({ outputDir: 'C:\\out' })
  ok('落在 outputDir 内', a.startsWith('C:\\out'))
  ok('是 .png', a.endsWith('.png'))
  ok('文件名带固定前缀（好识别、好清理）', path.basename(a).startsWith('.qwen-paint-mask-'))
  ok('★ 连续两次调用不重名（随机后缀，防同毫秒覆盖）', a !== b)
  ok('随机后缀是 6 位 base36', /-[0-9a-z]{6}\.png$/u.test(a))
}

console.log('\n=== 2. 蒙版用完即删 + 不再只拼时间戳（源码级） ===')
{
  const IDX = strip(INDEX)
  ok('handler 用 uiMaskPath 造路径', IDX.includes('const maskPath = uiMaskPath(cfg)'))
  ok('★ finally 里 unlink 蒙版（防泄漏）',
    /finally\s*\{[\s\S]{0,300}unlink\(maskPath\)/u.test(IDX))
  ok('unlink 失败被吞掉（不影响主流程）', /unlink\(maskPath\)\s*\}\s*catch/u.test(IDX))
  ok('★ 剥注释后不存在"只拼 Date.now() 的一次性蒙版"旧写法',
    !/qwen-paint-mask-\$\{Date\.now\(\)\}\.png/u.test(strip(INDEX)))
}

console.log('\n=== 3. 插件自有图片路由 /api/qwen-paint/file（源码级） ===')
{
  const IDX = strip(INDEX)
  ok('注册了 /api/qwen-paint/file', INDEX.includes("path: '/api/qwen-paint/file'"))
  ok('只收 GET/HEAD（其它方法 405）', IDX.includes("'GET only'"))
  ok('限本机请求（isLocalRequest 围栏）', /fileBytesHandler[\s\S]{0,600}isLocalRequest\(req\)/u.test(IDX))
  ok('★ 路径包含检查（挡掉 .. 穿越）', IDX.includes('startsWith(base + path.sep)'))
  ok('吐的是 image/png 字节', IDX.includes("'content-type': 'image/png'"))
}

console.log('\n=== 4. 弹窗三处修复（client.js 源码级） ===')
{
  const CLI = strip(CLIENT)
  ok('★ 开窗前先清残留浮层（防层层叠加 / 监听器泄漏）',
    CLI.includes("querySelectorAll('.dshqp-mask-overlay')"))
  ok('★ 结果图容器只造一次、用 replaceChildren 替换',
    CLI.includes('resultSlot.replaceChildren(next)'))
  ok('★ 弹窗内图片走插件自有路由（不依赖 api/file 的登记机制）',
    CLI.includes('api/qwen-paint/file?path='))
  ok('★ 剥注释后不再把结果图直接 appendChild 到 card',
    !CLI.includes('card.appendChild(next)'))
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}`)
process.exit(fail === 0 ? 0 : 1)
