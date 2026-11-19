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
const HEADLINE = '视频 / 生图 / TTS / PPT 全能'

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
    ['docs/llms.txt 是什么', docsLlms, '版本 ' + V + '，BSL 1.1（BUSL-1.1'],
    ['给DSH安装的话 当前版本', talk, '**当前版本：' + V + '**'],
    ['pyproject.toml version', pyproject, 'version = "' + V + '"'],
  ]
  for (const [name, text, needle] of spots) ok('★ ' + name + ' 与 package.json 一致', text.includes(needle), needle)
  ok('package.json 自身版本字段唯一', (pkgText.match(/"version":/gu) ?? []).length === 1)
  const currentTags = [...readme.matchAll(/\*\*当前版本\*\*：`([^`]+)`/gu)].map((m) => m[1])
  ok('README 里所有「当前版本」标记都等于 V', currentTags.length > 0 && currentTags.every((x) => x === V), currentTags.join(','))

  // ★ 2026-11-13 审计（第二轮）补漏：上一轮 0.3.0→0.3.1 时漏掉了 README 里
  //   「当前 `0.3.0`」那句安装引导 —— 因为它既不是「**当前版本**：」也不是更新说明标题，
  //   两道判据都够不着。这里改成抓**任何**「当前 … `x.y.z`」的写法，漏一个就红。
  const inlineCurrent = [...readme.matchAll(/当前[^`\n]{0,12}`(\d+\.\d+\.\d+)`/gu)].map((m) => m[1])
  ok('★ README 里所有「当前 `x.y.z`」写法都等于 V（上一轮就是这里漏的）',
    inlineCurrent.length > 0 && inlineCurrent.every((x) => x === V), inlineCurrent.join(','))
  // ★ 0.32.1 审计 A5：两份 llms 里的「当前 `x.y.z`」此前完全不在护栏里，
  //   于是 0.3.0 的老版本号一路留到 0.32.0 都没人发现。补上，漏一个就红。
  for (const [name, text] of [['llms.txt', llms], ['docs/llms.txt', docsLlms]]) {
    const xs = [...text.matchAll(/当前[^`\n]{0,12}`(\d+\.\d+\.\d+)`/gu)].map((m) => m[1])
    ok('★ ' + name + ' 里所有「当前 x.y.z」都等于 V', xs.length > 0 && xs.every((x) => x === V), xs.join(','))
  }

  // 落地页 docs/index.html 三处版本号此前完全不在检查清单里 —— GitHub Pages 会一直
  // 对外宣称旧版本，而 npm 上已经是新的。
  const landing = read('docs/index.html')
  ok('★ 落地页 JSON-LD 的 softwareVersion 与 V 一致',
    landing.includes('"softwareVersion": "' + V + '"'))
  ok('★ 落地页可见版本标签与 V 一致', landing.includes('版本 ' + V + '<'))
  ok('★ 落地页安装说明里的当前版本与 V 一致', landing.includes('当前 <code>' + V + '</code>'))

  // 反向：更新说明标题里不许出现比 V 更新的版本号（防手滑把未来版本写进历史）
  const noteHeads = [...readme.matchAll(/^## (\d+)\.(\d+)\.(\d+) 更新说明/gu)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
  const [V1, V2, V3] = V.split('.').map(Number)
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])
  ok('更新说明里没有比 V 更新的版本号', noteHeads.every((x) => cmp(x, [V1, V2, V3]) <= 0),
    noteHeads.map((x) => x.join('.')).join(','))
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
    (read('lib/setup-guide.js').match(/视频 \/ 生图 \/ TTS \/ PPT 全能/gu) ?? []).length === 1)
}

console.log('\n=== 6. ★ 2026-11-15 发布前审计补漏：时态 / 许可 / 更新说明不许说谎 ===')
{
  // 血泪：2026-11-15 发布前实采发现，5 处静态文档把「仓库当前版本 0.33.0」写成
  //   「**已发布到 npm**（当前 0.33.0）」，而线上 latest 其实还是 0.32.1。
  //   发布状态是**外部事实**，静态文档不该替 registry 断言；统一改成时态中立的
  //   「包名为 X，可按包名安装（仓库当前 V）」。
  //   判据故意不写「未发布 / 0.32.1」这类会随发布过期的话，只禁「已发布 + 当前 V」同句。
  // ★ 2026-11-15 审计加严：静态文档集合必须覆盖全部对外「简介 / 安装说明」，
  //   INSTALL.md 与 给DSH安装的话.md 此前漏检，旧 UI 口径（实验室浮层并入 / 浮标贴右边框）
  //   就藏在那里没被抓到。以后新增静态文档忘了纳入这里，判据本身也要能发现。
  const STATIC_DOCS = [
    ['README.md', readme], ['llms.txt', llms], ['docs/llms.txt', docsLlms],
    ['docs/index.html', read('docs/index.html')], ['pyproject.toml', pyproject],
    ['INSTALL.md', install], ['给DSH安装的话.md', talk],
  ]
  // 不依赖「已发布 … 当前 V」的语序：只要同一行里同时出现「已发布」与「当前 V」，
  // 或「已发布到 npm」紧跟本版本号，就算替 registry 断言发布状态。
  const versionTag = V.replace(/\./gu, '\\.')
  const publishedClaim = new RegExp(
    '已发布[到于]?[^\\n]{0,80}(?:当前|latest|版本)?[^\\n]{0,20}(?:`|<code>)?' + versionTag + '(?:`|</code>)?', 'u')
  const claimInLine = (s) => s.split('\n').some((line) =>
    line.includes('已发布') && new RegExp('(?:当前|latest|版本)?[^\\n]{0,20}(?:`|<code>)?' + versionTag, 'u').test(line))
  for (const [name, s] of STATIC_DOCS) {
    ok('★ ' + name + ' 不把「已发布」与「当前 ' + V + '」绑成一句（发布状态交给 registry）',
      !publishedClaim.test(s) && !claimInLine(s))
  }
  ok('★ 静态文档集合覆盖 7 份对外文档（新增文档忘了纳入会红）', STATIC_DOCS.length === 7)
  ok('★ 现行文档不再出现已删除的「实验室浮层」形态（功能已内嵌进 cp-panel）',
    STATIC_DOCS.every(([, s]) => !s.includes('实验室浮层')))
  ok('★ 现行文档不再出现「浮标贴右边框」旧口径（最终是边框对齐边框 / 正上方）',
    STATIC_DOCS.every(([, s]) => !s.includes('浮标贴右边框')))

  // 本版最重大变更是许可证换 BSL 1.1；简介（含 registry 只显示的前 255 字符）
  // 与 V 的更新说明都不得漏写。这两条不随「是否已推送」过期。
  ok('★ 简介里写明许可为 BSL 1.1（且落在 npm 只显示的前 255 字符内）',
    DESC.slice(0, 255).includes('BSL 1.1') && DESC.includes('BUSL-1.1'))
  ok('★ 简介写明 0.32.1 及更早仍 MIT、不追溯', /0\.32\.1 及更早仍 MIT/u.test(DESC))
  ok('★ 落地页与 pyproject 简介也带上 BSL 1.1',
    read('docs/index.html').includes('BSL 1.1') && pyproject.includes('BSL 1.1'))

  // README 的 V 更新说明不能停留在旧批次的口径（曾写着「面板翻边 / 105 B / 71 套 5309 项 /
  // 补白名单就修好点不动」，全部被后续轮次推翻，且整个换证一个字没写）。
  const noteStart = readme.indexOf('## ' + V + ' 更新说明')
  const noteEnd = readme.indexOf('\n## ', noteStart + 4)
  const note = noteStart >= 0 ? readme.slice(noteStart, noteEnd < 0 ? undefined : noteEnd) : ''
  // 弱断言加严：不只看字节数，还要求关键小节标题都在（防「写一大段却漏掉本版最重大变更」）。
  ok('★ ' + V + ' 更新说明存在且够长', note.length > 800, String(note.length))
  ok('★ 更新说明覆盖本版全部重大主题（许可 / 新工具 / 加速链 / 链清单 / 结构化日志 / UI / 媒体格式 / 回归 / 文档）',
    ['许可证', '新工具与端点', '加速链全景', '工作流清单层', '结构化运行日志',
      'UI 与交互', '媒体格式转换', '联动护栏与回归', '### 文档'].every((k) => note.includes(k)))
  // 旧版本边界用语义化判据：文档写「0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、
  // 不追溯」，比硬字面量「0.32.1 及更早仍 MIT」更完整，不该被钉死措辞而误判为漏写。
  ok('★ 更新说明写明 BSL 1.1 / 生效起点 / Change Date / 旧版本 MIT 边界与不追溯',
    ['BSL 1.1', 'BUSL-1.1', '0.33.0 起', '2030-11-15', 'Apache'].every((k) => note.includes(k))
    && /0\.32\.1 及更早[^。\n]{0,20}MIT/u.test(note) && note.includes('不追溯'))
  ok('★ 更新说明写明 UI 最终口径（内嵌 / 正上方 / 边框对齐 / 不变形 / 点按链路）',
    ['内嵌', '正上方', '边框对齐', '不变形', 'pointerdown'].every((k) => note.includes(k)))
  ok('★ 更新说明不再出现已被推翻的旧结论（翻边 / 105 B / 5309 项 / 补白名单即修好）',
    !/面板完整性改由翻边|余量守住 105 B|71 套 \/ 5309|白名单，修掉/u.test(note))
  // ★ 2026-11-15 审计加严：原先硬编码「77 套 / 5,632 项」会随每加一个测试过期，
  //   而且反过来**阻止**把数字订正到真实值（Spec 轴实测已 5,646）。
  //   改成：套数由 scripts/test-all.mjs 的 SUITES 条目数静态推导（漏登记测试会红），
  //   断言数只要求写明「项全绿」不锁具体数字，体积余量由真实字节数算，永不因回归增长失效。
  const suiteCount = (read('scripts/test-all.mjs').match(/\{ file: '/gu) ?? []).length
  // ★ 2026-11-16 CI 修复：Windows 工作树受 core.autocrlf 影响，有 3 个 lib 文件
  //   落盘成 CRLF（比 git blob / Ubuntu checkout 多 699 B）。本地 stat 与 CI stat
  //   不是同一个数 → 护栏在 CI 上必红。统一按**规范化 LF 字节**算，四处判据一致：
  //   本地 Windows / CI Windows / CI Ubuntu / git blob。
  const normalizedBytes = (rel) => Buffer.byteLength(read(rel).replace(/\r\n/gu, '\n'), 'utf8')
  const indexBytes = normalizedBytes('lib/index.js')
  const freeBytes = 262144 - indexBytes
  ok('★ 更新说明写明的回归套数 == SUITES 实际条目数（漏登记测试会红）',
    suiteCount > 0 && note.includes(suiteCount + ' 套'), `SUITES=${suiteCount}`)
  ok('★ 更新说明写明断言全绿但不锁死具体项数（避免每次加测试都要改文档）',
    /项全绿|项断言|断言 \d/u.test(note) && !/5,632|5,499|5,490/u.test(note))
  ok('★ 更新说明写明的 lib/index.js 体积余量 == 真实字节数推算值',
    freeBytes > 0 && note.includes(freeBytes.toLocaleString('en-US') + ' B'),
    `真实余量=${freeBytes} B`)
  // ★ 同类问题再堵一次：README 曾写死「16 个独立模块 / 98 个 lib / 1,778,329 B」，
  //   新增 5 个媒体模块后全部过期。改成拿真实值比对，加模块忘改文档就红。
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const libTotal = libFiles.reduce((n, f) => n + normalizedBytes('lib/' + f), 0)
  ok('★ 更新说明写明的 lib/ 文件数与体积 == 真实值（加模块忘改文档会红）',
    note.includes(libFiles.length + ' 个 `lib/*.js`')
      && note.includes(libTotal.toLocaleString('en-US') + ' B'),
    `真实 ${libFiles.length} 个 / ${libTotal} B`)
  // ★ 自检不能自指：上一版把被检查的字面量原样写进检查代码，导致这条护栏恒红。
  //   改为扫描护栏源码里是否还存在「把具体断言数写死成对 note 的硬编码调用」。
  const guardSrc = read('scripts/test-release-metadata.mjs')
  const staleAssertionCount = /note\.includes\(\s*['"]\d[\d,]*['"]\s*\)/u
  ok('★ 发布护栏自身不再含会过期的断言数硬编码', !staleAssertionCount.test(guardSrc),
    '护栏里不应出现对具体断言数的硬编码调用')
  // ★ 2026-11-15 审计补漏：两份 llms 是 Agent 读的能力清单，新增工具漏写 =
  //   Agent 根本不知道能调，等于功能没接线。工具名从 tool-registry 动态取，不硬编码。
  const extraBlock = read('lib/tool-registry.js')
    .match(/EXTRA_TOOL_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/u)
  // ★★ 2026-11-15 反向核查抓到的**真护栏盲区**：EXTRA_TOOL_NAMES 里用了
  //    `...CREATIVE_TOOL_NAMES` 展开常量，源码正则只抠得到字面量 ⇒ 新增的
  //    4 个工具完全没进护栏视野，把 llms 里的反引号删掉竟然不红。
  //    ⇒ 把展开常量指向的定义也解析进来，并加一条「展开项必须可解析」自检。
  // ★★ 2026-11-15 收尾再补：同一盲区会随新模块**复发**（加了 `...ORPHAN_TOOL_NAMES`
  //    后，只认 CREATIVE_TOOL_NAMES 的老写法又漏 5 个）。改成**通用解析**：
  //    把 lib/ 全量源码扫一遍，任何一个 `X_TOOL_NAMES = Object.freeze([...])` 都能解，
  //    解不出来的展开项直接判红 —— 新模块想绕过清单检查必须先让这条红。
  const namesFrom = (block) => block
    ? (block[1].match(/'[a-z0-9_]+'/gu) ?? []).map((s) => s.slice(1, -1))
    : []
  const libDir = path.join(ROOT, 'lib')
  const libSources = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(libDir, f), 'utf8'))
  const spreadRefs = [...new Set((extraBlock?.[1].match(/\.\.\.([A-Z][A-Z0-9_]*)/gu) ?? [])
    .map((s) => s.slice(3)))]
  const resolvedNames = []
  const unresolvedRefs = []
  for (const ref of spreadRefs) {
    const re = new RegExp(ref + ' = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)', 'u')
    let hit = null
    for (const src of libSources) {
      const m = src.match(re)
      if (m) { hit = m; break }
    }
    if (hit) resolvedNames.push(...namesFrom(hit))
    else unresolvedRefs.push(ref)
  }
  ok('★ 展开常量里的工具名也能被护栏解析（防止新增工具绕过清单检查）',
    unresolvedRefs.length === 0 && resolvedNames.length >= 4,
    '展开项=' + spreadRefs.join(',') + ' 未解析=' + unresolvedRefs.join(','))
  const extraTools = [...namesFrom(extraBlock), ...resolvedNames]
  ok('★ 两份 llms 的能力清单以代码字体点名全部外置工具（新增工具漏写就红）',
    extraTools.length >= 11 && ['llms.txt', 'docs/llms.txt'].every((f) => {
      const s = read(f)
      // 必须写成 `工具名`（反引号包裹）：单纯 includes 会被前缀 / 相似串骗过
      //（反向核查实测：把 convert_to_gif 改成 convert_to_gif_DISABLED 仍能骗过 includes）。
      return extraTools.every((t) => s.includes('`' + t + '`'))
    }), '工具数=' + extraTools.length)
  // ★ 2026-11-16 隐患审计：外置工具点名护栏只盖 16 个外置工具，13 个内联工具不在
  //    射程 —— llms.txt 漏 `compose_prompt` / `batch_draw`，docs 版连
  //    `list_available_models` / `check_acceleration` 也漏。⇒ 升级为全量：
  //    名单从 scripts/selftest.mjs 的 EXPECTED_TOOLS 解析（单一真相源），
  //    29 个全部反引号点名，缺一就红。
  const expectedBlock = read('scripts/selftest.mjs').match(/EXPECTED_TOOLS\s*=\s*\[([\s\S]*?)\]/u)
  const expectedTools = expectedBlock
    ? (expectedBlock[1].match(/'[a-z0-9_]+'/gu) ?? []).map((s) => s.slice(1, -1))
    : []
  ok('★ EXPECTED_TOOLS 名单可解析且与外置工具名单一致（两套名单不打架）',
    expectedTools.length >= 29 && extraTools.every((t) => expectedTools.includes(t)),
    'EXPECTED=' + expectedTools.length + ' 外置=' + extraTools.length)
  ok('★ 两份 llms 以代码字体点名全部外置+内联工具（数量动态，漏写就红）',
    expectedTools.length > 0 && ['llms.txt', 'docs/llms.txt'].every((f) => {
      const s = read(f)
      return expectedTools.every((t) => s.includes('`' + t + '`'))
    }),
    '名单=' + expectedTools.length)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓')
