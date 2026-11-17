#!/usr/bin/env node
/**
 * scripts/test-license-bsl.mjs —— 2026-11-15：MIT → BSL 1.1（BUSL-1.1）换证回归。
 *
 * 用户拍板：BSL 1.1，**四年后转 Apache-2.0**。据此落地：
 *   · Change Date        = 2030-11-15（自 2026-11-15 起整四年）
 *   · Change License     = Apache License, Version 2.0
 *   · Licensor           = @yanfei0725（★ 2026-11-15 第二次拍板：单一主体）
 *   · Additional Use Grant = 用户给的中文原文：除两类「竞争性使用」外，
 *     任何个人 / 团队 / 企业均可免费在生产环境中使用；中文为准，英文仅参考。
 *   · Licensed Work      = 0.33.0 及以后（0.32.1 及更早仍 MIT，不可撤销）
 *
 * ★ 本轮口径变更（断言过期，非改测试迁就 bug）：上一版 AUG = None、
 *   Licensor 为双版权人。用户随后明确要求「改单一主体」并给出附加授权全文，
 *   因此第 2 / 4 / 6 节的旧断言按新事实重写并加严，不是放宽。
 *
 * 法理核实（MariaDB bsl11 官方页 + SPDX BUSL-1.1 逐字文本）：
 *   Covenants 要求 Change License 是「GPL v2.0 or any later version, or a
 *   license compatible with it」。Apache-2.0 与 GPLv3 兼容，而 GPLv3 属于
 *   「a later version」，因此满足；CockroachDB / Moonlink 等 BSL 1.1 项目
 *   同样直接用 Apache-2.0 作 Change License。Covenants 第 4 条还要求
 *   「Not to modify this License in any other way」⇒ 参数区与条款正文必须
 *   严格分离，正文与 SPDX 官方文本逐字一致（本套断言逐字比对 + SHA-256 双锁）。
 *
 * 守六条：
 *   ① 官方条款正文逐字未改（内嵌 SPDX 基准，零联网）；
 *   ② 五个参数逐字正确（含单一主体 / AUG 中文原文），Change Date 真的是「四年后」；
 *   ③ 已发布 0.32.1 及更早的 MIT 授权不被追溯收回；
 *   ④ 元数据 + 8 处文档口径一致；AUG 新口径扩散到两份 llms 与落地页；
 *      第三方 MIT / Qwen Research License 描述不被误改；
 *   ⑤ 发布护栏同步（不再硬锁 MIT）、LICENSE 进打包白名单、脱敏零命中；
 *   ⑥ 附加授权只放宽不收窄（Covenants 2(a)）、中文原文为准、英译非约束、
 *      Change Date 转 Apache-2.0 后「竞争性使用」限制消失。
 *
 * ⚠ 本文件统一用 ok(cond, label) 顺序；helper 内建写反自检。
 *
 * 运行：node scripts/test-license-bsl.mjs
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const fails = []

/** ⚠ 参数顺序：cond 在前，label 在后。写反（ok(true, true)）必须当场抛。 */
function ok(cond, label) {
  if (typeof label !== 'string') throw new Error('ok() 参数顺序写反：必须是 (cond, label)')
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

// ★ SPDX license-list-data/text/BUSL-1.1.txt 的 Terms + Covenants 段，逐字内嵌。
//   不含参数区、不含 Notice（那是 MariaDB 网页说明，不是 SPDX 许可文本），
//   这样 Covenants 第 4 条「不得改写条款」有可机器判的锚点。
const OFFICIAL_BODY = String.raw`Terms

The Licensor hereby grants you the right to copy, modify, create derivative
works, redistribute, and make non-production use of the Licensed Work. The
Licensor may make an Additional Use Grant, above, permitting limited
production use.

Effective on the Change Date, or the fourth anniversary of the first publicly
available distribution of a specific version of the Licensed Work under this
License, whichever comes first, the Licensor hereby grants you rights under
the terms of the Change License, and the rights granted in the paragraph
above terminate.

If your use of the Licensed Work does not comply with the requirements
currently in effect as described in this License, you must purchase a
commercial license from the Licensor, its affiliated entities, or authorized
resellers, or you must refrain from using the Licensed Work.

All copies of the original and modified Licensed Work, and derivative works
of the Licensed Work, are subject to this License. This License applies
separately for each version of the Licensed Work and the Change Date may vary
for each version of the Licensed Work released by Licensor.

You must conspicuously display this License on each original or modified copy
of the Licensed Work. If you receive the Licensed Work in original or
modified form from a third party, the terms and conditions set forth in this
License apply to your use of that work.

Any use of the Licensed Work in violation of this License will automatically
terminate your rights under this License for the current and all other
versions of the Licensed Work.

This License does not grant you any right in any trademark or logo of
Licensor or its affiliates (provided that you may use a trademark or logo of
Licensor as expressly required by this License).

TO THE EXTENT PERMITTED BY APPLICABLE LAW, THE LICENSED WORK IS PROVIDED ON
AN “AS IS” BASIS. LICENSOR HEREBY DISCLAIMS ALL WARRANTIES AND CONDITIONS,
EXPRESS OR IMPLIED, INCLUDING (WITHOUT LIMITATION) WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND
TITLE.

MariaDB hereby grants you permission to use this License’s text to license
your works, and to refer to it using the trademark “Business Source License”,
as long as you comply with the Covenants of Licensor below.

Covenants of Licensor

In consideration of the right to use this License’s text and the “Business
Source License” name and trademark, Licensor covenants to MariaDB, and to all
other recipients of the licensed work to be provided by Licensor:

1. To specify as the Change License the GPL Version 2.0 or any later version,
   or a license that is compatible with GPL Version 2.0 or a later version,
   where “compatible” means that software provided under the Change License can
   be included in a program with software provided under GPL Version 2.0 or a
   later version. Licensor may specify additional Change Licenses without
   limitation.

2. To either: (a) specify an additional grant of rights to use that does not
   impose any additional restriction on the right granted in this License, as
   the Additional Use Grant; or (b) insert the text “None”.

3. To specify a Change Date.

4. Not to modify this License in any other way.`.trim()

const OFFICIAL_SHA256 = '20092e66cdf7c39bfe30c359bed5556b0e58a61cf29e648413751a2dd4ef2293'

const LICENSE = read('LICENSE')
const pkgText = read('package.json')
const pkg = JSON.parse(pkgText)
const pyproject = read('pyproject.toml')
const readme = read('README.md')
const llms = read('llms.txt')
const docsLlms = read('docs/llms.txt')
const landing = read('docs/index.html')
const releaseGuard = read('scripts/test-release-metadata.mjs')
const testAll = read('scripts/test-all.mjs')
const schemaDefaults = read('lib/schema-defaults.js')
const setup = read('scripts/setup.mjs')

console.log('=== 1. 官方条款正文逐字未改（Covenants 第 4 条） ===')
{
  ok(LICENSE.startsWith('Business Source License 1.1\n'), 'LICENSE 首行声明 BSL 1.1（不再是 MIT License）')
  ok(!LICENSE.startsWith('MIT License'), '旧 MIT 全文已被替换')
  const s = LICENSE.indexOf('Terms\n')
  const e = LICENSE.indexOf('\n-----------------------------------------------------------------------------', s)
  ok(s > 0 && e > s, '能定位条款正文段（Terms → 分隔线）')
  const body = LICENSE.slice(s, e).trim()
  ok(body === OFFICIAL_BODY, '★ 条款正文与 SPDX 官方 BUSL-1.1 逐字一致（零联网基准）')
  ok(createHash('sha256').update(body).digest('hex') === OFFICIAL_SHA256,
    '★ 官方正文 SHA-256 锁定（改一个字就红）')
  ok(body.includes('Licensor may specify additional Change Licenses without\n   limitation.'),
    '★ Covenants 允许并列指定额外 Change License（Apache-2.0 合规依据）')
  ok(body.includes('4. Not to modify this License in any other way.'),
    '★ Covenants 第 4 条在正文里（不得改写条款）')
  ok(!body.includes('2030-11-15') && !body.includes('Apache License, Version 2.0')
    && !body.includes('@yanfei0725'),
    '★ 参数没有塞进条款正文（参数区与正文严格分离）')
  ok(LICENSE.indexOf('PARAMETERS') < s, '参数区在条款正文之前')
}

console.log('=== 2. 五个参数逐字 + 「四年后」真的是四年 ===')
{
  ok(LICENSE.includes('Licensor:             @yanfei0725 (https://github.com/yanfei0725), the sole'),
    '★ Licensor = @yanfei0725 单一主体（用户第二次拍板）')
  ok(/^Licensor:\s+@yanfei0725 /mu.test(LICENSE), '★ Licensor 行以单一主体开头')
  ok((LICENSE.match(/^Licensor:/gmu) ?? []).length === 1,
    '★ 只有一个 Licensor 参数行（不靠多个 Licensor 蒙混）')
  ok(!LICENSE.includes('jointly the') && !LICENSE.includes('and @yanfei0725, jointly'),
    '★ 参数区不再出现双主体并列（jointly the / and @yanfei0725）')
  ok(LICENSE.includes('Licensed Work:        dsh-qwen-paint, versions 0.33.0 and later.'),
    '★ Licensed Work 明确「0.33.0 及以后」')

  ok(LICENSE.includes('Additional Use Grant: 您可以将授权作品'),
    '★ AUG 参数值就是用户给的中文原文（不再是 None）')
  ok(!LICENSE.includes('Additional Use Grant: None'),
    '★ 旧口径 AUG = None 已彻底移除')
  ok(LICENSE.includes('您可以将授权作品（Licensed Work）用于任何生产目的，但以下情况除外'),
    '★ 中文原文首句逐字：任何生产目的，除竞争性使用')
  ok(LICENSE.includes('(1) 将授权作品作为托管（hosted）或代管（managed）服务提供给第三方；'),
    '★ 竞争性使用 (1) 托管/代管服务逐字')
  ok(LICENSE.includes('(2) 将授权作品（或其修改版）嵌入、捆绑或包装为与授权方产品构成直接竞争的商业产品进行销售或分发。'),
    '★ 竞争性使用 (2) 直接竞品捆绑逐字')
  ok(LICENSE.includes('任何个人、团队或企业均可免费在生产环境中使用本授权作品。'),
    '★ 除竞争性使用外，任何个人/团队/企业免费生产使用逐字')
  ok(LICENSE.includes('[The Chinese text above is the governing text.')
    && LICENSE.includes('non-binding reference'),
    '★ 中文原文为准 / 英译非约束明确写出')
  ok(LICENSE.includes('hosted or managed service')
    && LICENSE.includes("directly competes with the Licensor's products")
    && LICENSE.includes('free\n                      of charge.'),
    '★ 英译覆盖两类竞争性使用与「免费」（国际可读，但不具约束力）')
  ok(LICENSE.includes('Covenants 2(a)') && LICENSE.includes('it widens, and does not narrow'),
    '★ Notes 写明附加授权只放宽不收窄（Covenants 第 2(a) 条）')
  ok(LICENSE.includes('ceases to apply on that date'),
    '★ Notes 写明 Change Date 转 Apache-2.0 后竞争性使用限制消失')
  ok(LICENSE.includes('Licensor is a single legal person: @yanfei0725')
    && LICENSE.includes('does NOT make\n  @奇迹与你 a Licensor under this BSL'),
    '★ Notes 明确单一法律主体，原作者历史版权署名不构成 BSL Licensor')
  ok(LICENSE.includes('Change Date:          2030-11-15'), '★ Change Date = 2030-11-15')
  ok(LICENSE.includes('Change License:       Apache License, Version 2.0'),
    '★ Change License = Apache License, Version 2.0（用户拍板）')

  const m = LICENSE.match(/Change Date:\s+(\d{4})-(\d{2})-(\d{2})/u)
  ok(m !== null, 'Change Date 可被解析为 ISO 日期')
  if (m) {
    const [, y, mo, d] = m
    const cd = Date.UTC(Number(y), Number(mo) - 1, Number(d))
    const base = Date.UTC(2026, 10, 15) // 2026-11-15（本轮换证日）
    const four = Date.UTC(2026 + 4, 10, 15)
    ok(cd === four, '★ Change Date 正好是换证日 2026-11-15 的四周年（不是随便写的日期）')
    ok(cd - base === (four - base) && cd > base, '★ Change Date 在未来且间隔 = 四年')
    ok(Number(mo) === 11 && Number(d) === 15, '★ 月日与换证日一致（11-15）')
  }
  ok(LICENSE.includes('GPLv3, which is "a later version" of'),
    '★ 参数区如实写明 Apache-2.0 的 Covenants 合规论证（不隐瞒法理瑕疵）')
  ok(LICENSE.includes('BSL 1.1 is NOT an OSI-approved open source license'),
    '★ 参数区如实写明「不是 OSI 核准的开源许可」')
  ok(LICENSE.includes('production use is free of charge for any individual, team')
    && LICENSE.includes('still requires a commercial license from the Licensor'),
    '★ 参数区如实写明新口径：除竞争性使用外免费，竞争性使用仍需商业许可')
  ok(LICENSE.includes('the earlier of that date and the fourth anniversary'),
    '★ 参数区写明「Change Date 与版本四周年取较早者」的自动转换机制')
}

console.log('=== 3. 已发布版本不追溯（法律硬边界） ===')
{
  ok(LICENSE.includes('Versions 0.32.1 and earlier were published under the'),
    '★ LICENSE 写明 0.32.1 及更早按 MIT 发布')
  ok(LICENSE.includes('those grants are perpetual, irrevocable'),
    '★ LICENSE 写明旧授权永久、不可撤销')
  ok(LICENSE.includes('are NOT re-licensed by this file'),
    '★ LICENSE 明确「不被本文件重新授权」')
  ok(readme.includes('`0.32.1` 及更早版本当初按 MIT 授权，该授权永久、不可撤销')
    && readme.includes('不因本次换证被追溯收回'),
    '★ README 写明已发布版本不受换证追溯')
  ok(readme.includes('从 `0.33.0` 起才适用 BSL 1.1'), '★ README 写明生效起点是 0.33.0')
  ok(llms.includes('0.32.1 及更早版本仍按 MIT 授权、不受换证影响'),
    '★ llms.txt 同步写明旧版本仍 MIT')
  // ★ 2026-11-15 修正（升 0.34.0 时暴露）：原来写死 pkg.version === '0.33.0'，
  //   版本一往前走就假红，属于「测试过期」而不是真 bug。真正要守的是
  //   「换证起点已生效且从未回退」——当前版本 >= 0.33.0，且元数据仍标 BUSL-1.1。
  const CHANGE_START = [0, 33, 0]
  const curVer = pkg.version.split('.').map(Number)
  const notBefore = (((curVer[0] - CHANGE_START[0]) || (curVer[1] - CHANGE_START[1])
    || (curVer[2] - CHANGE_START[2])) >= 0)
  ok(notBefore && pkg.license === 'BUSL-1.1',
    '★ 当前版本 ' + pkg.version + ' 已越过换证起点 0.33.0 且仍为 BSL 1.1')
  ok(!LICENSE.includes('Version 0.32.1 is hereby re-licensed'),
    '★ 没有任何「追溯重授权」措辞')
}

console.log('=== 4. 元数据 + 8 处文档口径一致 ===')
{
  ok(pkg.license === 'BUSL-1.1', '★ package.json license = BUSL-1.1（SPDX 标识符）')
  ok(!pkgText.includes('"license": "MIT"'), '★ 元数据里不再写 MIT')
  ok(Array.isArray(pkg.files) && pkg.files.includes('LICENSE'),
    '★ LICENSE 在 npm 打包白名单里（换的证会随包发出去）')
  ok(pyproject.includes('license = { file = "LICENSE" }'),
    '★ pyproject.toml 仍指向 LICENSE 文件（内容已换）')
  const classifiers = pyproject.split('\n').filter((l) => /^\s*"License ::/u.test(l))
  ok(classifiers.length === 1 && classifiers[0].includes('Other/Proprietary License'),
    '★ Registry classifier 改为 Other/Proprietary（BSL 非 OSI，不许冒充 OSI Approved）')
  ok(classifiers.every((l) => !l.includes('OSI Approved') && !l.includes('MIT')),
    '★ classifier 条目里不再有 OSI Approved :: MIT（注释里的说明不算）')

  const spots = [
    ['README 元信息行', readme, '**许可协议**：BSL 1.1（BUSL-1.1）'],
    ['README 许可章节标题', readme, '**BSL 1.1（Business Source License 1.1，SPDX `BUSL-1.1`）**'],
    ['llms.txt 版本行', llms, '许可协议 BSL 1.1（BUSL-1.1，非 OSI 开源许可）'],
    ['llms.txt LICENSE 行', llms, '：BSL 1.1（BUSL-1.1）'],
    ['docs/llms.txt 是什么', docsLlms, '版本 ' + pkg.version + '，BSL 1.1（BUSL-1.1，非 OSI 开源许可）许可'],
    ['docs/llms.txt LICENSE 行', docsLlms, ': BSL 1.1 (BUSL-1.1)'],
    ['落地页标签', landing, '<span class="tag">BSL 1.1</span>'],
    ['落地页 LICENSE 链接', landing, 'LICENSE（BSL 1.1）'],
  ]
  for (const [name, text, needle] of spots) ok(text.includes(needle), '★ ' + name + ' 口径一致（' + needle + '）')

  ok(readme.includes('**BSL 1.1 不是 OSI 核准的开源许可证**'), '★ README 明确非 OSI 开源')
  ok(readme.includes('**非生产使用**')
    && readme.includes('除下列「竞争性使用」外，任何个人、')
    && readme.includes('均可免费在生产环境中使用本作品'),
    '★ README 写明授权范围与新 AUG（除竞争性使用外免费生产使用）')
  ok(readme.includes('1. 将本作品作为**托管（hosted）或代管（managed）服务**提供给第三方；')
    && readme.includes('2. 将本作品（或其修改版）**嵌入、捆绑或包装为与授权方产品构成直接竞争的商业产品**'),
    '★ README 完整列出两类竞争性使用')
  ok(readme.includes('| Licensor | **@yanfei0725**（单一主体） |')
    && readme.includes('| Additional Use Grant | 除两类「竞争性使用」外，**生产使用免费**'),
    '★ README 参数表：单一主体 + 新 AUG 行')
  ok(readme.includes('**「竞争性使用」限制随之消失**') && readme.includes('**不收窄**'),
    '★ README 写明转 Apache-2.0 后限制消失、AUG 不收窄原权利')
  ok(llms.includes('Licensor 为**单一主体** `@yanfei0725`')
    && llms.includes('均可免费在生产环境中使用'),
    '★ llms.txt 同步单一主体与免费生产使用')
  ok(docsLlms.includes('Licensor 为**单一主体** `@yanfei0725`')
    && docsLlms.includes('**免费生产使用**'),
    '★ docs/llms.txt 同步单一主体与免费生产使用')
  ok(landing.includes('Licensor 为单一主体 @yanfei0725')
    && landing.includes('除「竞争性使用」（托管/代管服务、直接竞品捆绑）外可免费用于生产'),
    '★ 落地页同步单一主体与免费生产使用')
  ok(!readme.includes('`Additional Use Grant` 为 `None`') && !readme.includes('生产使用需向'),
    '★ README 旧口径（AUG = None / 生产使用需商业许可）已清除')
  ok(['Change Date', '**2030-11-15**', '**Apache License, Version 2.0**', 'Licensor', 'Licensed Work',
    'Additional Use Grant'].every((k) => readme.includes(k)),
    '★ README 许可章节五参数齐全')
  ok(landing.includes('"license": "https://github.com/yanfei0725/dsh-qwen-paint/blob/main/LICENSE"'),
    '★ 落地页 JSON-LD 的 license URL 保持（指向 LICENSE 文件，URL 本身不含许可证名）')
  ok(llms.includes('Change Date 2030-11-15，届时转 Apache-2.0'),
    '★ llms.txt 写明 Change Date 与转换目标')
}

console.log('=== 5. 第三方许可描述不被误改（本轮换的是本项目的证） ===')
{
  ok(readme.includes('ComfyUI-Qwen-Image-2.1-Speedup') && readme.includes('**MIT，纯 Python，无闭源件**'),
    '★ README 里第三方节点 frakd 的 MIT 描述保持原样')
  ok(schemaDefaults.includes('QwenImage21Speedup`（frakd，MIT，纯 Python 无闭源件）'),
    '★ lib/schema-defaults.js 的第三方 MIT 注释保持原样')
  ok(setup.includes('Qwen Research License') && setup.includes('禁止商用'),
    '★ Qwen 权重的「禁止商用」提示保持原样（属第三方许可，与本项目换证无关）')
  ok(readme.includes('第三方组件仍各自按其原许可') || readme.includes('`custom_nodes`）仍各自按其原许可'),
    '★ README 明确第三方组件许可不受影响')
}

console.log('=== 6. 发布护栏同步 + 脱敏 ===')
{
  ok(!releaseGuard.includes("'版本 ' + V + '，MIT'"),
    '★ 发布护栏不再硬锁「版本 V，MIT」（过期断言已定性改写）')
  ok(releaseGuard.includes("'版本 ' + V + '，BSL 1.1（BUSL-1.1'"),
    '★ 发布护栏改为锁新口径 BSL 1.1')
  ok(testAll.includes("file: 'test-license-bsl.mjs'"),
    '★ 本套测试登记进 SUITES（不在清单里的测试 = 没写测试）')
  const privatePat = /(?:\x43:\\Users\\|\x43:\/Users\/|\x4B:\/ai\/|\x4B:\\ai\\|npm_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,})/u
  ok(!privatePat.test(LICENSE), '★ LICENSE 脱敏零命中（无本机路径 / 凭据）')
  ok(!/\x41dministrator|WorkBuddy/u.test(LICENSE), '★ LICENSE 不含真实用户名 / 私有目录名')
  ok((LICENSE.match(/https:\/\/github\.com\/yanfei0725\/dsh-qwen-paint/gu) ?? []).length >= 1,
    '★ 商业许可联系渠道指向公开仓库（不写私人邮箱 / 绝对路径）')
  ok(LICENSE.includes('Copyright (c) 2026 @奇迹与你 (original work; MIT-licensed versions 0.32.1 and earlier)')
    && LICENSE.includes('Copyright (c) 2026 @yanfei0725 (optimized version; sole Licensor under the BSL above)'),
    '★ 文末版权两行：原作者仅对应 MIT 旧版本，@yanfei0725 为 BSL 唯一 Licensor')
  ok(!LICENSE.includes('@奇迹与你 (wonderandyou) and @yanfei0725'),
    '★ 全文不再出现双主体并列署名（单一主体落地）')
  ok(!LICENSE.includes('Additional Use Grant: None') && !LICENSE.includes('with Additional Use Grant: None'),
    '★ 全文不再有 AUG = None 的旧口径（参数区与 Notes 都已更新）')
  ok(LICENSE.includes('@奇迹与你') && LICENSE.includes('does NOT make'),
    '★ 原作者版权署名没有被抹掉（诚实记录历史权属，但不构成 Licensor）')
}

console.log(`\n=== test-license-bsl：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1) }
console.log('全部通过 ✓')
