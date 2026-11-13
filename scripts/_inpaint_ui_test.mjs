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
 *   6. /api/qwen-paint/inpaint 漏用来源/授权围栏 → 跨站可绕过宿主工具入口触发本地出图
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
// ★ 2026-11-12：字节路由已外置（lib/index.js 贴 256 KB 上限），断言改读新文件
const FILE_ROUTE = readFileSync(path.join(ROOT, 'lib', 'file-route.js'), 'utf8')
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
  ok('注册了 /api/qwen-paint/file', INDEX.includes("reg('/api/qwen-paint/file'"))
  const FR = strip(FILE_ROUTE)
  ok('只收 GET/HEAD（其它方法 405）', FR.includes("'GET only'"))
  ok('限本机请求（isLocalRequest 围栏）', /fileBytesHandler[\s\S]{0,800}isLocalRequest\(req\)/u.test(FR))
  ok('★ 路径包含检查（挡掉 .. 穿越）', FR.includes('startsWith(base + path.sep)'))
  // ★ 2026-11-12 变更：以前**一律**回 image/png。视频选帧要在这里取 mp4，
  //   写死 png 会让浏览器把 mp4 当图片解（直接黑屏）⇒ 改成按扩展名的 MIME 白名单。
  ok('MIME 白名单仍把 .png 映射到 image/png', FR.includes("'.png': 'image/png'"))
  ok('★ 视频能按 video/mp4 吐字节（否则 <video> 播不了）', FR.includes("'.mp4': 'video/mp4'"))
  ok('未知扩展名不猜类型（回落 application/octet-stream）', FR.includes("'application/octet-stream'"))
  // ★ 2026-11-12 轻量安全加固
  ok('★ nosniff（防按内容嗅探成 HTML 执行）', FR.includes('x-content-type-options'))
  ok('★ 先 stat 再读 + 大小上限（不把几 GB 视频读进内存）', FR.includes('st.size > maxBytes'))
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

console.log('\n=== 5. /api/qwen-paint/inpaint 顶层可信请求围栏（AUTH002 收录复核整改，源码级） ===')
{
  // ⚠ 只截 inpaintHandler 的函数体（到该路由 register 为止），否则会误命中别的端点的围栏。
  //   并且必须剥注释 —— 修复说明里原样引用了 isLocalRequest(req)，不剥就是假通过。
  const IDX = strip(INDEX)
  const start = IDX.indexOf('const inpaintHandler =')
  const end = IDX.indexOf("reg('/api/qwen-paint/inpaint'", start)
  const H = start >= 0 && end > start ? IDX.slice(start, end) : ''
  const atFence = H.indexOf('isLocalRequest(req)')
  const atGuard = H.indexOf('guardWriteRequest(req, res)')
  const atExec = H.indexOf('editToolRef.execute(')
  ok('能定位到 inpaintHandler 函数体', H.length > 0)
  ok('★ handler 内有 isLocalRequest(req) 顶层围栏', atFence >= 0)
  ok('★ 围栏在 guardWriteRequest 之前（POST/JSON 守卫只查方法与媒体类型，不能替代来源检查）',
    atFence >= 0 && atGuard > atFence)
  ok('★ 围栏在 editToolRef.execute 之前（跨站请求不得触发本地出图/写盘）',
    atFence >= 0 && atExec > atFence)
  ok('围栏拒绝时返回 403 + local requests only',
    H.includes("reason: 'local requests only'") && /isLocalRequest\(req\)[\s\S]{0,160}403/u.test(H))
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}`)
process.exit(fail === 0 ? 0 : 1)
