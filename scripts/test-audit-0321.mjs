#!/usr/bin/env node
/**
 * test-audit-0321.mjs —— 0.32.1 两轮审计修复的行为级回归。
 *
 * 全离线、零联网、零出图：A1 用系统临时目录 + 注入假 fetch 真跑围栏，
 * 其余是源码锁 / 纯函数实跑 / 只读文件核对。关键断言能用纯 JS 表达，
 * 不依赖外部可执行文件（历史教训：沙箱会间歇性禁子进程）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveAudioPath, transcribeAudio } from '../lib/asr-client.js'
import { TOOL_SUMMARIES } from '../lib/tool-descriptions.js'
import { ASSET_ROUTES } from '../lib/asset-route.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'
import { buildMarkdown } from '../lib/history-export.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, extra ?? '') }
}
const V = JSON.parse(read('package.json')).version

console.log('=== 1. A1：ASR 音频路径围栏（真跑） ===')
{
  const out = path.join(os.tmpdir(), 'qp-audit-out')
  const inside = path.join(out, 'a.mp3')
  const r1 = resolveAudioPath({ audioPath: inside, outputDir: out })
  ok('目录内绝对路径放行', r1.ok === true && r1.file === path.resolve(inside))
  ok('目录外的 ../ 被拒', resolveAudioPath({ audioPath: path.join(out, '..', 'outside.mp3'), outputDir: out }).ok === false)
  ok('同级不同前缀目录被拒（防字符串前缀误判）',
    resolveAudioPath({ audioPath: out + '-evil/a.mp3', outputDir: out }).ok === false)
  ok('空路径被拒且保留原提示', resolveAudioPath({ audioPath: '', outputDir: out }).reason === '没给音频文件路径')
  ok('没给 outputDir 时不替调用方猜目录（纯库调用保持兼容）',
    resolveAudioPath({ audioPath: inside }).ok === true)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-audit-0321-'))
  const outside = path.join(dir, 'outside.mp3')
  fs.writeFileSync(outside, 'AUDIT-CANARY')
  let fetched = false
  const fake = async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' } }
  try {
    const r = await transcribeAudio({
      audioPath: outside,
      cfg: { asrUrl: 'http://127.0.0.1:9/asr', outputDir: out },
      fetchFn: fake,
    })
    ok('★ 目录外文件在端点口径下被拒（原漏洞已封）', r.ok === false && /出图目录内/u.test(r.reason))
    ok('★ 拒绝时根本没发起 POST（不读、不外发）', fetched === false)
  } finally {
    try { fs.unlinkSync(outside); fs.rmdirSync(dir) } catch { /* 忽略 */ }
  }
  ok('端点调用显式带 cfg（围栏拿得到 outputDir）', read('lib/config-endpoints.js').includes('cfg: deps.cfg ?? {}'))
}

console.log('\n=== 2. A2：按包名安装也能跑引导脚本 ===')
{
  const files = JSON.parse(read('package.json')).files
  ok('★ files 白名单含 scripts/setup.mjs', files.includes('scripts/setup.mjs'))
  ok('★ files 白名单含它的依赖 video-model-catalog.mjs', files.includes('scripts/video-model-catalog.mjs'))
  ok('两个脚本真实存在', ['scripts/setup.mjs', 'scripts/video-model-catalog.mjs'].every((f) => fs.existsSync(path.join(ROOT, f))))
  ok('引导卡片里的命令与包内脚本对得上', read('lib/setup-guide.js').includes('node scripts/setup.mjs --check'))
}

console.log('\n=== 3. A3：草图台四事件点按 ===')
{
  const d = read('assets/draft.js')
  ok('★ 四事件源都绑了', ["'click'", "'pointerup'", "'mouseup'", "'touchend'"].every((s) => d.includes(s)))
  ok('有 300ms 冷却去重', d.includes('now - lastAt < 300'))
  ok('★ 遮罩关闭也走 tap（不再只绑 click）', d.includes('tap(ov,'))
  ok('不再有只绑 click 的按钮', !d.includes("node.addEventListener('click', fire)"))
  ok('history.js 仍是同口径基准', read('assets/history.js').includes("var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']"))
}

console.log('\n=== 4. A4：嵌套错误字段消毒 + 死命令订正 ===')
{
  const c = read('lib/config-endpoints.js')
  ok('★ 清单/契约的 errors[] 不再原样塞 error.message',
    (c.match(/sanitizeReason\(String\(error\?\.message \?\? error\)\)/gu) ?? []).length >= 2)
  ok('★ 异常细节只进本机日志', (c.match(/warn\(/gu) ?? []).length >= 3)
  ok('★ 真图构建失败改固定文案', c.includes("auditSkipped = '构建失败（详见插件日志）'"))
  ok('★ 不再提示不存在的 contract-audit.mjs', !c.includes('contract-audit.mjs'))
  ok('改指真实存在的回归脚本', c.includes('scripts/test-workflow-contract.mjs')
    && fs.existsSync(path.join(ROOT, 'scripts/test-workflow-contract.mjs')))
}

console.log('\n=== 5. A5：版本号与简介一次性同步 ===')
{
  ok('版本号 0.32.1', V === '0.32.1')
  const pkg = JSON.parse(read('package.json'))
  const DESC = pkg.description
  ok('★ 简介前段写明 0.32.1 审计加固', DESC.indexOf('0.32.1 两轮审计加固') >= 0 && DESC.indexOf('0.32.1 两轮审计加固') < 120)
  ok('★ QQ 群仍在 registry 255 字符截断内', DESC.indexOf('QQ 交流群') < 60)
  ok('description 与 meta.description 逐字一致', DESC === pkg.meta.description)
  ok('★ README 首段与 DESC 逐字一致', read('README.md').split('\n').slice(1).find((l) => l.trim() !== '') === DESC)
  ok('★ llms.txt 首段与 DESC 逐字一致', read('llms.txt').split('\n').find((l) => l.startsWith('> ') && l.includes('DSH 插件')) === '> ' + DESC)
  ok('★ docs/llms.txt 首段与 DESC 逐字一致', read('docs/llms.txt').split('\n').find((l) => l.startsWith('> ') && l.includes('DSH 插件')) === '> ' + DESC)
  const inline = (s) => [...s.matchAll(/当前[^`\n]{0,12}`(\d+\.\d+\.\d+)`/gu)].map((m) => m[1])
  for (const [name, f] of [['README', 'README.md'], ['llms.txt', 'llms.txt'], ['docs/llms.txt', 'docs/llms.txt']]) {
    const xs = inline(read(f))
    ok(`★ ${name} 里所有「当前 x.y.z」都等于 ${V}`, xs.length > 0 && xs.every((x) => x === V), xs.join(','))
  }
  const landing = read('docs/index.html')
  ok('落地页三处版本号都同步', landing.includes('"softwareVersion": "' + V + '"')
    && landing.includes('版本 ' + V + '<') && landing.includes('当前 <code>' + V + '</code>'))
  ok('★ 落地页简介也点了 0.32.1 加固', landing.includes('0.32.1 两轮审计加固'))
  ok('pyproject 版本同步', read('pyproject.toml').includes('version = "' + V + '"'))
  ok('给DSH安装的话 版本同步', read('给DSH安装的话.md').includes('**当前版本：' + V + '**'))
  ok('README 有 0.32.1 更新说明章节', read('README.md').includes('## 0.32.1 更新说明'))
  ok('★ 版本护栏已覆盖两份 llms', read('scripts/test-release-metadata.mjs').includes("['docs/llms.txt', docsLlms]")
    && read('scripts/test-release-metadata.mjs').includes("['llms.txt', llms]"))
}

console.log('\n=== 6. A7：指纹基准只读 ===')
{
  const g = read('scripts/test-runtime-guards.mjs')
  ok('★ 只有显式 --update 才写基准', g.includes('if (UPDATE) {') && !g.includes('if (UPDATE || stored'))
  ok('★ 缺失/损坏直接报红', g.includes('禁止自动重建') && g.includes('ok(false,'))
  ok('基准文件当前存在且可解析', (() => {
    try { return Boolean(JSON.parse(read('scripts/workflow-fingerprints.json')).fixtures) } catch { return false }
  })())
}

console.log('\n=== 7. A8：端点目录守卫不再漏根别名 ===')
{
  ok('★ 目录含 /qwen-paint/status.json', INTEGRATION_ROUTES.some((r) => r.path === '/qwen-paint/status.json'))
  ok('目录无重复路径', new Set(INTEGRATION_ROUTES.map((r) => r.path)).size === INTEGRATION_ROUTES.length)
  ok('★ 守卫正则覆盖根别名', read('scripts/test-product-round.mjs').includes('status\\.json'))
}

console.log('\n=== 8. B 类低风险项 ===')
{
  ok('★ TOOL_SUMMARIES 补齐 13 个工具', Object.keys(TOOL_SUMMARIES).length === 13
    && ['list_generated_images', 'compose_prompt', 'batch_draw'].every((k) => k in TOOL_SUMMARIES))
  ok('★ loading.gif 死路由已删', !ASSET_ROUTES.some((r) => r[1] === 'loading.gif'))
  ok('★ 登记的资源文件零缺失', ASSET_ROUTES.every(([, f]) => fs.existsSync(path.join(ROOT, 'assets', f))))
  const md = buildMarkdown({ id: 1, kind: 'image', file_path: 'a.png', prompt: 'a](b' })
  ok('★ Markdown 里 alt 的特殊字符被转义', md.split('\n')[0].includes('\\]\\('))
  ok('★ 转义后图片链接结构仍完整', (md.split('\n')[0].match(/\]\(/gu) ?? []).length === 1)
  ok('★ 无路径时仍明说「（无路径）」（不回归）', buildMarkdown({ id: 2, kind: 'image', prompt: 'x' }).includes('（无路径）'))
  ok('★ _client_scope_test 现在有逐条断言标记', read('scripts/_client_scope_test.mjs').includes('✓ 面板作用域'))
  ok('★ selftest 形状检查扩到全部 13 个工具', read('scripts/selftest.mjs').includes('13 个工具全部具备基础形状'))
  ok('★ render 断言文案不再谎称「register 强校验」', !read('scripts/selftest.mjs').includes('register 强校验'))
  const cliBytes = fs.statSync(path.join(ROOT, 'lib/client.js')).size
  ok('★ client.js 字节基线冻结（≤ 261467）', cliBytes <= 261467, String(cliBytes))
  ok('★ 发布前有体积守卫（prepack）', read('package.json').includes('"prepack": "node scripts/check-size.mjs"')
    && fs.existsSync(path.join(ROOT, 'scripts/check-size.mjs')))
  ok('check-size 硬上限是 262144 / 2097152', read('scripts/check-size.mjs').includes('262144') && read('scripts/check-size.mjs').includes('2097152'))
  ok('★ 本套件已登记 SUITES', read('scripts/test-all.mjs').includes("file: 'test-audit-0321.mjs'"))

  const LEGACY = [
    '_abort_fix_test.mjs', '_abort_reason_test.mjs', '_adapt_test.mjs', '_cordis_proxy_test.mjs',
    '_draw_e2e_test.mjs', '_draw_smoke_test.mjs', '_init_abort_test.mjs', '_intent_test.mjs',
    '_perf_test.mjs', '_test_listmodels.mjs', '_tome_shim_test.mjs', '_trimtest.mjs',
    '_vram_patch_test.mjs', '_wrapper_policy_test.mjs',
  ]
  const suites = read('scripts/test-all.mjs')
  const debugs = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^_.*test.*\.mjs$/u.test(f))
  const orphan = debugs.filter((f) => !suites.includes(`'${f}'`) && !LEGACY.includes(f))
  ok('★ 历史调试脚本要么登记要么显式记账（新增未登记会红）', orphan.length === 0, orphan.join(','))
  ok('LEGACY 名单本身不虚报（每个都真实存在）', LEGACY.every((f) => fs.existsSync(path.join(ROOT, 'scripts', f))))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过')
