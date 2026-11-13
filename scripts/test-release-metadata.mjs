#!/usr/bin/env node
/**
 * test-release-metadata.mjs —— 「每次发布，简介 / 描述 / 版本号全部一起改」的回归护栏
 *
 * ★ 2026-11-13 用户明确要求：「简介、描述、版本号每次发布时全部一起改」。
 *   光靠人记一定会漏（历史上 README / llms / docs / pyproject 已经各说各话），
 *   所以这里把「一起改」变成机器可判的硬约束：
 *     · package.json 的 description 是**唯一真相源**；
 *     · meta.description / README 首段 / 两个 llms 首段必须逐字一致；
 *     · 版本号从 package.json 读，六处文档必须同时是同一个数；
 *     · 三大能力（视频 / 生图 / TTS）与视频模型自动下载包必须在每处简介里都在。
 *   漏改任何一处 → npm test 直接红，发不了版。
 *
 * 全程只读文件、零联网、零副作用。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HEADLINE_CAPABILITIES } from '../lib/integration-state.js'
import { SETUP_STEPS } from '../lib/setup-guide.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

const pkgText = read('package.json')
const pkg = JSON.parse(pkgText)
const V = pkg.version
const DESC = pkg.description
const HEADLINE = '视频 / 生图 / TTS 全能'

const readme = read('README.md')
const llms = read('llms.txt')
const docsLlms = read('docs/llms.txt')
const install = read('INSTALL.md')
const talk = read('给DSH安装的话.md')
const pyproject = read('pyproject.toml')

const firstNonEmptyAfterTitle = (text) => text.split('\n').slice(1).find((l) => l.trim() !== '')
const firstQuoteLine = (text) => text.split('\n').find((l) => l.startsWith('> ') && (l.includes('DSH 插件') || l.includes('DeepSeek Harness')))

console.log('=== 1. 唯一真相源：简介逐字同步 ===')
{
  ok('description 与 meta.description 完全相同', DESC === pkg.meta?.description)
  ok('★ README 首段与 package.json description 逐字一致', firstNonEmptyAfterTitle(readme) === DESC)
  ok('★ llms.txt 首段与 description 逐字一致', firstQuoteLine(llms) === '> ' + DESC)
  ok('★ docs/llms.txt 首段与 description 逐字一致', firstQuoteLine(docsLlms) === '> ' + DESC)
  ok('★ 三大能力主推口径统一', [DESC, llms, docsLlms, readme, pyproject, talk].every((s) => s.includes(HEADLINE)))
  ok('简介同时点名视频 / 生图 / TTS', ['视频', '生图', 'TTS'].every((k) => DESC.includes(k)))
  ok('代码里的 headline 与文档口径一致', SETUP_STEPS.length === 7
    && HEADLINE_CAPABILITIES.map((c) => c.id).join(',') === 'video,image,tts')
  ok('keywords 覆盖视频 / 语音 / 生图', ['text-to-video', 'image-to-video', 'qwen3-tts', 'text-to-speech', 'image-generation']
    .every((k) => Array.isArray(pkg.keywords) && pkg.keywords.includes(k)))
}

console.log('\n=== 2. 视频模型自动下载包：有、默认关闭、口径一致 ===')
{
  const places = [
    ['package.json', DESC], ['README.md', readme], ['llms.txt', llms],
    ['docs/llms.txt', docsLlms], ['INSTALL.md', install], ['给DSH安装的话.md', talk],
    ['pyproject.toml', pyproject],
  ]
  ok('★ 七处都写明 --video-models 下载包', places.every(([n, s]) => s.includes('--video-models')),
    places.filter(([, s]) => !s.includes('--video-models')).map(([n]) => n).join(','))
  ok('★ 主文档都写明「默认不装 / 默认关闭 / 需显式」', [DESC, readme, llms, docsLlms, install, talk].every((s) =>
    /默认不装|默认关闭|默认不会|可选、默认关闭/u.test(s)))
  ok('下载包按服务器权威 size + sha256 校验的口径在', [DESC, readme, install, docsLlms]
    .every((s) => s.includes('sha256')))
  ok('★ 音频权重口径一致：不自动下载、缺件给清单', [DESC, readme, llms, docsLlms, install]
    .every((s) => s.includes('音频') && /不自动下载|不提供音频模型自动下载/u.test(s)))
  // 订正句会**引用**旧错误说法（「早期版本写成…」）、澄清句会**引用**被否定的说法
  // （「不是『不支持视频』」），这两类行必须保留在文档里，但不能算作误导陈述。
  // 所以先剥离这两类带明确标记的行，再检查剩下的现行陈述。
  const stripClarifications = (s) => s.split('\n')
    .filter((l) => !l.includes('2026-11-13 订正') && !l.includes('不是「不支持视频」'))
    .join('\n')
  ok('★ 现行陈述里不再有「不支持视频 / 不下载模型权重」的绝对断言',
    ![readme, llms, docsLlms, install, DESC].some((s) =>
      /不支持视频|不提供视频|暂不提供视频|插件不下载模型权重|插件\*\*不下载\*\*/u.test(stripClarifications(s))))
  ok('★ 订正句与澄清句本身必须在（否则就是悄悄抹掉历史）',
    readme.includes('2026-11-13 订正') && docsLlms.includes('不是「不支持视频」'))
  ok('docs/llms.txt 明确澄清「不提供」≠ 不支持视频', docsLlms.includes('不是「不支持视频」'))
  ok('引导步骤里视频包是可选且需同意', SETUP_STEPS.find((s) => s.id === 'video')?.optional === true
    && SETUP_STEPS.find((s) => s.id === 'video')?.consent === true)
}

console.log('\n=== 3. 版本号：一处改、六处必须同时改 ===')
{
  ok('版本号是语义化 X.Y.Z', /^\d+\.\d+\.\d+$/u.test(V), V)
  const spots = [
    ['README 当前版本', readme, '**当前版本**：`' + V + '`'],
    ['README 更新说明章节', readme, '## ' + V + ' 更新说明'],
    ['llms.txt 版本行', llms, '版本 ' + V + '；'],
    ['docs/llms.txt 是什么', docsLlms, '版本 ' + V + '，MIT'],
    ['给DSH安装的话 当前版本', talk, '**当前版本：' + V + '**'],
    ['pyproject.toml version', pyproject, 'version = "' + V + '"'],
  ]
  for (const [name, text, needle] of spots) ok('★ ' + name + ' 与 package.json 一致', text.includes(needle), needle)
  ok('package.json 自身版本字段唯一', (pkgText.match(/"version":/gu) ?? []).length === 1)
  const currentTags = [...readme.matchAll(/\*\*当前版本\*\*：`([^`]+)`/gu)].map((m) => m[1])
  ok('README 里所有「当前版本」标记都等于 V', currentTags.length > 0 && currentTags.every((x) => x === V), currentTags.join(','))
}

console.log('\n=== 4. 三大能力在 README Features 表里都有工具行 ===')
{
  const table = readme.slice(readme.indexOf('## Features'), readme.indexOf('## Installation'))
  ok('视频：generate_video', table.includes('`generate_video`'))
  ok('生图：draw_image / 编辑族工具', ['`draw_image`', '`inpaint_image`', '`remove_image`', '`outpaint_image`', '`upscale_image`']
    .every((t) => table.includes(t)))
  ok('TTS：generate_speech 独立工具', table.includes('`generate_speech`'))
  ok('混合模式：generate_hybrid', table.includes('`generate_hybrid`'))
  ok('视频模型自动下载包在 Features 段显眼处', table.includes('--video-models'))
}

console.log('\n=== 5. 审计补漏：安装层标识与工具清单也得跟着改 ===')
{
  // ★ 2026-11-13 审计发现：护栏原来只盯 6 个文档，cordis.patch.yml（安装层标识）
  //   和 lib/tool-descriptions.js（工具自述）漏检 —— 那两处写错同样会让用户
  //   「搜到的简介」和「装上的东西」对不上。
  const patchYml = read('cordis.patch.yml')
  ok('cordis.patch.yml 的插件 name 与 package.json 一致',
    patchYml.includes("name: '" + pkg.name + "'"), pkg.name)
  ok('cordis.patch.yml 的 id 是稳定标识（不随版本变）', patchYml.includes('\n    - id: qwen-paint\n'))

  const toolDesc = read('lib/tool-descriptions.js')
  ok('★ 工具自述里视频 / 生图 / 语音三类都在（不让工具描述掉队）',
    ['generate_video', 'draw_image', 'generate_speech', 'generate_hybrid'].every((t) => toolDesc.includes(t)))
  ok('★ 工具自述不再出现「不支持视频」类误读措辞', !/不支持视频|不提供视频|做不了视频/u.test(toolDesc))

  const describeSrc = read('lib/describe.js')
  ok('★ 面板摘要也不出现「不支持视频」类误读措辞', !/不支持视频|不提供视频/u.test(describeSrc))
  ok('headline 常量在 setup-guide 里只有一处定义（口径唯一真相源）',
    (read('lib/setup-guide.js').match(/视频 \/ 生图 \/ TTS 全能/gu) ?? []).length === 1)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓')
