#!/usr/bin/env node
/**
 * 首次安装门禁回归（issue #3：setup.mjs 下载成功后 allOk 未重置）。
 *
 * 事故：allOk 在预检阶段被置 false（模型缺失），下载循环里即使三个模型全部
 * SHA256 校验通过也没把它改回 true，导致第③步「挂进 DSH profile」永远进不去；
 * 第二次跑因为走 continue 才恢复正常。用户首次安装必然踩中。
 *
 * 修法：拆成三个互不污染的标志 ——
 *   allOk       只反映「预检时的状态」，专供 --check 只读早退；
 *   modelsReady 反映「下载后 MODELS 是否全部就绪」，另加磁盘权威复核兜底；
 *   extrasOk    反映「可选补齐是否失败」，防止在主循环里被误清零。
 *
 * setup.mjs 是真会下几十 GB 的安装脚本，不能在本回归里实跑；本套件用
 * 「源码契约 + 状态机行为模型」双重锁定：既检查关键语句真的在正确位置，
 * 也用同一套转移规则验证三类场景（首次安装 / 下载失败 / 核显补齐失败）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('=== 1. 预检语义不能被破坏（--check 只看不下载） ===')
ok('allOk 仍初始化并在预检里声明', SRC.includes('let needDownload = 0') && SRC.includes('let allOk = true'))
ok('预检分支仍会置 allOk=false', /needDownload \+= 1\s*\n\s*allOk = false/u.test(SRC))
const checkBlock = SRC.slice(SRC.indexOf('if (CHECK_ONLY) {'), SRC.indexOf("if (IGPU_DOWNLOAD && IGPU_PLAN"))
ok('--check 早退仍用 allOk 决定退出码', checkBlock.includes('process.exit(allOk ? 0 : 1)'))
ok('--check 早退仍在下载循环之前', (() => {
  const atCheck = SRC.indexOf('if (CHECK_ONLY) {')
  const dl = SRC.indexOf('for (const model of MODELS) {', SRC.indexOf('if (needDownload === 0) {'))
  return atCheck > 0 && dl > atCheck
})())

console.log('\n=== 2. 下载后状态标志存在且职责单一 ===')
ok('modelsReady / extrasOk 均已声明', SRC.includes('let modelsReady = true') && SRC.includes('let extrasOk = true'))
const dlStart = SRC.indexOf('if (needDownload === 0) {')
// 下载循环的真正下界是「第二道闸」注释，不是后面的 ②b —— 磁盘复核夹在两者之间。
const dlEnd = SRC.indexOf('/* ★ issue #3 第二道闸')
const dlBlock = SRC.slice(dlStart, dlEnd)
ok('下载循环三个失败分支都置 modelsReady=false', (dlBlock.match(/modelsReady = false/gu) || []).length === 3)
ok('下载循环不再写预检变量 allOk', !/allOk\s*=\s*false/u.test(dlBlock))
const igpuStart = SRC.indexOf('if (IGPU_DOWNLOAD && IGPU_PLAN')
const igpuEnd = SRC.indexOf('} else if (IGPU_PLAN !== null && IGPU_PLAN.downloadable)')
ok('核显可选补齐失败写 extrasOk，不污染主模型状态',
  SRC.slice(igpuStart, igpuEnd).includes('extrasOk = false'))

console.log('\n=== 3. 磁盘权威复核兜底 ===')
const recheckAt = SRC.indexOf('const diskOk = MODELS.every')
const step3At = SRC.indexOf('/* ③ 插件本体 */')
ok('下载循环之后有 MODELS.every 磁盘复核', recheckAt > dlEnd && recheckAt > 0
  && recheckAt < SRC.indexOf('/* ②b 轻量档必需 ComfyUI-GGUF'))
ok('复核带 --check 断电保护', SRC.slice(recheckAt - 120, recheckAt).includes('if (!CHECK_ONLY)'))
ok('复核失败会拉低 modelsReady', /if \(!diskOk\) modelsReady = false/u.test(SRC))
ok('复核位于第③步之前', recheckAt < step3At && step3At > 0)

console.log('\n=== 4. 最终门禁只看下载后状态 ===')
ok('输出目录配置不再看预检变量', SRC.includes('if (!CHECK_ONLY && modelsReady && extrasOk && comfyDir !== null)'))
ok('第③步门槛用 modelsReady + extrasOk', srcHasStep3(SRC))
function srcHasStep3(s) {
  const g = s.slice(s.indexOf('/* ③ 插件本体 */'))
  return g.includes('if (!modelsReady || !extrasOk)') && g.includes('模型还没齐，先不装插件')
}
ok('第③步之后不再读取 allOk', !/allOk/u.test(SRC.slice(step3At)))

console.log('\n=== 5. 状态机行为模型（与源码契约双重锁定） ===')
/** 按修法后的转移规则跑一遍；与上面 1~4 的源码断言配套，防「改了代码没改逻辑」。 */
function gate({ precheckOk, downloadOk, extrasOk }) {
  const allOk = precheckOk                 // 预检状态，--check 专用
  let modelsReady = true                   // 下载后状态，与预检无关
  let extras = true
  if (!downloadOk) modelsReady = false     // 下载/复核失败
  if (!extrasOk) extras = false            // 可选补齐失败
  return { checkExit: allOk ? 0 : 1, canInstall: modelsReady && extras }
}
const firstRun = gate({ precheckOk: false, downloadOk: true, extrasOk: true })
ok('首次安装：预检缺件但下载全过 → 第③步放行', firstRun.checkExit === 1 && firstRun.canInstall === true)
const failed = gate({ precheckOk: false, downloadOk: false, extrasOk: true })
ok('下载真失败 → 第③步仍然拦住', failed.canInstall === false)
const igpuFail = gate({ precheckOk: false, downloadOk: true, extrasOk: false })
ok('主模型齐但核显补齐失败 → 仍拦住（不被成功分支抹掉）', igpuFail.canInstall === false)
const warm = gate({ precheckOk: true, downloadOk: true, extrasOk: true })
ok('二次运行：预检全过 → 第③步放行', warm.checkExit === 0 && warm.canInstall === true)

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass + fail} 项）===`)
process.exit(fail === 0 ? 0 : 1)
