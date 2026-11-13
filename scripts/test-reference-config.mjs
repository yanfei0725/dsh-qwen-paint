#!/usr/bin/env node
/**
 * test-reference-config.mjs —— 「角色参考 / 联网参考图」配置与文档一致性离线回归。
 *
 * 为什么单独一套：
 *   默认配置是不是「不可出站」、两处占位符会不会漂移、面板有没有第二条偷偷联网
 *   的路径、文档有没有如实披露第三类网络出口 —— 这些都不属于策略层 / 联网模块
 *   自己的职责，但**任何一处漂移都会让「默认拒绝」变成一句空话**。集中锁住。
 *
 * 纯 JS：不联网、不派生子进程、不读写外部文件、不生成任何图片 / 视频 / 音频。
 * 运行：node scripts/test-reference-config.mjs
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, PARAMETERS } from '../lib/schema-defaults.js'
import {
  WEB_ENDPOINT_PLACEHOLDER, ENDPOINT_REQUIRED,
  checkSearchEndpoint, assertWebConsent, describeWebReference,
} from '../lib/reference-web.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fails.push(name); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('[1] 默认配置：装好插件依旧纯离线')
ok('DEFAULTS.referenceSearchEndpoint 存在',
  Object.prototype.hasOwnProperty.call(DEFAULTS, 'referenceSearchEndpoint'))
ok('★ 默认值就是拒绝占位符，不是任何真实地址',
  DEFAULTS.referenceSearchEndpoint === WEB_ENDPOINT_PLACEHOLDER,
  String(DEFAULTS.referenceSearchEndpoint))
const gate = checkSearchEndpoint(DEFAULTS.referenceSearchEndpoint)
ok('★ 默认端点被同意门判 ENDPOINT_REQUIRED',
  gate.ok === false && gate.code === ENDPOINT_REQUIRED, JSON.stringify(gate))
ok('★★ 即使给了 consent:true，默认配置仍不能出站',
  assertWebConsent({ consent: true, endpoint: DEFAULTS.referenceSearchEndpoint, query: '角色设定' }).ok === false)
ok('★ 偏好不落配置：DEFAULTS 里没有 referenceStrategy（只存进程内存）',
  !Object.prototype.hasOwnProperty.call(DEFAULTS, 'referenceStrategy'))

console.log('\n[2] 工具契约：零漂移 + 如实披露')
const p = PARAMETERS?.properties?.referenceStrategy
ok('PARAMETERS.referenceStrategy 存在且是 string', Boolean(p) && p.type === 'string')
ok('★ 不是 required（不填 = 行为与升级前逐字节一致）',
  !PARAMETERS.required.includes('referenceStrategy'))
ok('描述写明「模型无关的通用兜底」', String(p?.description ?? '').includes('通用兜底'))
ok('描述写明联网检索须「每次显式同意」', String(p?.description ?? '').includes('每次显式同意'))

console.log('\n[3] 联网能力的自我披露')
const web = describeWebReference()
ok('describeWebReference 声明 defaultAction=deny', web.defaultAction === 'deny')
ok('★ 声明逐请求显式同意，不是一次性开关', web.consent === 'per-request-explicit')
ok('出站字段白名单只有 query / limit / media',
  JSON.stringify(web.outboundFields) === JSON.stringify(['query', 'limit', 'media']))

console.log('\n[4] 端点接线与前端不越界')
const indexSrc = read('lib/index.js')
ok('四个 /api/comfy-pipeline/reference* 端点都已注册',
  ['/reference', '/reference/prefer', '/reference/search', '/reference/adapt']
    .every((suffix) => indexSrc.includes("reg('/api/comfy-pipeline" + suffix + "'")))
const panelSrc = read('assets/panel.js')
ok('★ 面板里只有一条联网检索出口', (panelSrc.match(/consent: true/g) ?? []).length === 1)
ok('★ 面板绝不渲染 <img>（否则浏览器会自动下载远程字节）',
  !/el\(\s*['"]img['"]|createElement\(\s*['"]img['"]/u.test(panelSrc))
ok('★ 面板没有 ESM import（非 ESM 硬约束仍成立）', !/^[ \t]*import\s/m.test(panelSrc))

console.log('\n[5] 文档如实披露第三类网络出口')
const readme = read('README.md')
const install = read('INSTALL.md')
const llms = read('llms.txt')
ok('README 网络边界章节写出「默认拒绝」的联网检索',
  readme.includes('referenceSearchEndpoint') && /默认拒绝/.test(readme))
ok('INSTALL 可调项列出 referenceSearchEndpoint', install.includes('referenceSearchEndpoint'))
ok('llms.txt 披露可选出站与逐次同意',
  llms.includes('referenceSearchEndpoint') && /默认拒绝/.test(llms))

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length > 0) {
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
