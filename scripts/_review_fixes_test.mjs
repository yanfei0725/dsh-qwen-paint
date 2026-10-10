/**
 * _review_fixes_test.mjs —— 2026-10-10 代码审查所修 bug 的回归锁。
 *
 * 覆盖（每条都对应一处真实缺陷，见 本轮修复报告-20261009.md 〇·十四）：
 *   1. safeStem 英文分支忽略 maxChars（写死 34）
 *   2. drawTrigger 只写不读（重启丢设置）
 *   3. client `get current()` 引用未定义变量
 *   4. hipfire 通道仍裸传 abort(signal.reason)（[object Object]）
 *   5. FULL_CAPS 缺 rdna3fa
 *   6. genericOptimizations 与真实工作流不一致（报静态布尔而非策略）
 *   7. 面板「显存驻留」用 ?? 导致 0 不回落
 *   8. ensureComfyUp 无视 launch.phase（失败后空等 + 覆盖失败原因）
 *   9. 图生图 width/height 用请求值冒充实际值
 *  10. client 开关点后卡在"切换中…"
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { safeStem, DEFAULTS } = mod.__internal
const HOST = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const HIPFIRE = readFileSync(path.join(ROOT, 'lib', 'hipfire-img.js'), 'utf8')

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

console.log('=== 1. safeStem 英文分支遵守 maxChars ===')
{
  const long = 'a very long english prompt with many many words to exceed the limit yes indeed'
  ok('纯英文 prompt → 长度 ≤ maxChars(22)', safeStem(long, 22).length <= 22)
  ok('纯英文 prompt → 长度 ≤ maxChars(10)', safeStem(long, 10).length <= 10)
  ok('中文 prompt → 长度 ≤ maxChars(22)', safeStem('这是一个非常非常非常非常非常长的中文提示词', 22).length <= 22)
  ok('空 prompt → 有兜底名', safeStem('', 22) === '无题')
  ok('不再写死 34（源码里 maxChars 被真正使用）', HOST.includes('const limit = Number.isFinite(maxChars)'))
}

console.log('\n=== 2. drawTrigger 落盘后必须读回（与 flowStyle 对称） ===')
ok('apply 里恢复了 drawTrigger', HOST.includes('cfg.drawTrigger = savedUi.drawTrigger'))
ok('恢复时校验是合法档位', HOST.includes('hasOwnProperty.call(DRAW_INTENT_MODES, savedUi.drawTrigger)'))
ok('显式配置优先（rawConfig.drawTrigger === undefined 才回落）', HOST.includes('rawConfig?.drawTrigger === undefined'))

console.log('\n=== 3/10. 客户端两处 ===')
// ⚠ 必须**先剥注释**再查：修 bug 的说明注释里就原样引用了那句坏代码。
const CLIENT_NO_COMMENTS = CLIENT
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')
ok('3. 已删除引用未定义变量的 get current', !/get current\(\)\s*\{\s*return current\s*\}/u.test(CLIENT_NO_COMMENTS))
ok('3. current getter 现在返回真实存在的 lastDetail', CLIENT.includes('get current() { return lastDetail }'))
ok('10. 开关成功后关闭面板（否则按钮卡"切换中…"）', CLIENT.includes('closePanel()'))

console.log('\n=== 4. hipfire 不再裸传 abort(signal.reason) ===')
ok('没有裸 controller.abort(signal.reason)', !/controller\.abort\(signal\??\.reason\)/u.test(HIPFIRE))
ok('改成先归一化成 Error', HIPFIRE.includes('reason instanceof Error'))

console.log('\n=== 5. FULL_CAPS 含 rdna3fa ===')
ok('FULL_CAPS.nodes.rdna3fa === true', mod.__internal.FULL_CAPS.nodes.rdna3fa === true)
ok('caps 完全没传时 FA 会挂（说明 FULL_CAPS 生效）',
  (() => {
    const { buildWorkflow } = mod.__internal
    const wf = buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 })
    return wf['17']?.class_type === 'ApplyRDNA3FlashAttention'
  })())

console.log('\n=== 6. genericOptimizations 报"策略"而非静态布尔 ===')
ok('不再有 "TE-Speed 跳步缓存：${mark(plan.useTe)}"', !HOST.includes('`TE-Speed 跳步缓存：${mark(plan.useTe)}`'))
ok('改成三者互斥的策略行', HOST.includes('TE-Speed / Speedup / BlockCache（三者互斥）：${wrapperLine}'))
ok('策略里出现"按尺寸自动"', HOST.includes('按尺寸自动：小尺寸'))

console.log('\n=== 7. 面板显存驻留判定用 || 而非 ?? ===')
ok('不再用 `c.gpu?.vramGB ??`', !HOST.includes('c.gpu?.vramGB ?? c.residency'))
ok('改成 `c.gpu?.vramGB ||`', HOST.includes('c.gpu?.vramGB || c.residency'))

console.log('\n=== 8. ensureComfyUp 检查 launch.phase ===')
ok('startComfyHidden 之后立刻检查 failed', HOST.includes("if (launch.phase === 'failed') {"))
ok('循环里检查 failed/timeout', HOST.includes("launch.phase === 'failed' || launch.phase === 'timeout'"))
ok('只在仍 starting 时才置超时（不覆盖 failed）',
  /if \(launch\.phase === 'starting'\) \{\s*\n\s*launchMarkTimeout\(/u.test(HOST))

console.log('\n=== 9. 图生图用实测尺寸 ===')
ok('outWidth 是 let（可被实测值覆盖）', HOST.includes('let outWidth = eff.width'))
ok('图生图用 readPngSize 覆盖 outWidth/outHeight', HOST.includes("if (reference !== '' && actual !== null) {"))

console.log('\n=== 12. 拉起后端后最小化窗口（Win11/Windows Terminal 下原先无效） ===')
{
  ok('12. .cmd 设了唯一标题（供按标题精确定位）', HOST.includes("'title DSHQP-ComfyUI'"))
  ok('12. 按标题找窗口', HOST.includes('$api::FindWindow($null, $title)'))
  ok('12. 找可见的 Windows Terminal 窗口', HOST.includes('CASCADIA_HOSTING_WINDOW_CLASS'))
  ok('12. 自身控制台**仅在可见时**才用（修根因：WT 下它是不可见的伪控制台）',
    HOST.includes('$api::IsWindowVisible($own)'))
  ok('12. 结果落盘（旧脚本全吞掉、出问题看不到）', HOST.includes('.dshqp-minwin.log'))
  ok('12. ps1 注释保持纯 ASCII（PS5.1 无 BOM 按 ANSI 读，中文会解析错位）',
    HOST.includes("'# 2026-10-10 KEY FIX (window never got minimized):'"))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
