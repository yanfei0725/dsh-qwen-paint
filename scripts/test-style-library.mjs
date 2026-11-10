#!/usr/bin/env node
/** 素材库（设计风格 / 用户指令 / 可装载 skill）+ 视频加速档面板项。纯离线。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BUILTIN_STYLES, LIMITS, LIBRARY_FILE, STYLES_SUBDIR,
  libraryDir, listStyles, readLibrary, writeLibrary,
  listSkills, skillsToText, composePrompt,
} from '../lib/style-library.js'
import { describeOptimization } from '../lib/describe.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const indexSrc = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
const describeSrc = readFileSync(path.join(ROOT, 'lib/describe.js'), 'utf8')
const panelSrc = readFileSync(path.join(ROOT, 'assets/panel.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-style-lib-'))
const outDir = path.join(tmp, '千问1生图')

console.log('— 风格库')
ok('内置风格 ≥ 3 个且 id 唯一', BUILTIN_STYLES.length >= 3
  && new Set(BUILTIN_STYLES.map((s) => s.id)).size === BUILTIN_STYLES.length)
ok('内置含「不启用（none）」这一档', BUILTIN_STYLES.some((s) => s.id === 'none'))
ok('每个内置风格都有 name；除 none 外都带 prefix/suffix', BUILTIN_STYLES.every((s) => s.name && (s.id === 'none' || s.prefix || s.suffix)))
ok('风格目录落在 outputDir 的同级（不写死 C 盘）', libraryDir(outDir) === path.join(tmp, '千问1素材库'))
ok('目录不存在时只回内置风格', listStyles(outDir).length === BUILTIN_STYLES.length)

const styleDir = path.join(libraryDir(outDir), STYLES_SUBDIR)
mkdirSync(styleDir, { recursive: true })
writeFileSync(path.join(styleDir, 'my.json'), JSON.stringify({
  id: 'my', name: '我的风格', prefix: 'isometric, ', suffix: ', clean vector',
}), 'utf8')
ok('用户 json 风格被列出来', listStyles(outDir).some((s) => s.id === 'my'))
writeFileSync(path.join(styleDir, 'none.json'), JSON.stringify({
  id: 'none', name: '覆盖内置的 none', prefix: 'OVERRIDE ',
}), 'utf8')
ok('同名 id：用户风格覆盖内置（方便改内置项）', listStyles(outDir).find((s) => s.id === 'none')?.name === '覆盖内置的 none')
writeFileSync(path.join(styleDir, 'bad.json'), '{broken', 'utf8')
ok('坏 json 被跳过、不抛', listStyles(outDir).some((s) => s.id === 'my'))

console.log('— 素材库状态（选择 / 指令 / skills）')
const empty = readLibrary(outDir)
ok('缺文件 → 默认 none / 空指令 / 空 skills',
  empty.selected === 'none' && empty.instruction === '' && empty.skills.length === 0)
const w1 = writeLibrary(outDir, { selected: 'film', instruction: '不要卡通', skills: ['archify'] })
ok('写盘成功 saved=true', w1.saved === true)
ok('落盘文件名就是 library.json', readFileSync(path.join(libraryDir(outDir), LIBRARY_FILE), 'utf8').includes('film'))
const r1 = readLibrary(outDir)
ok('往返一致', r1.selected === 'film' && r1.instruction === '不要卡通' && r1.skills[0] === 'archify')
writeLibrary(outDir, { skills: [] })
ok('二次写是合并：selected/instruction 不丢', readLibrary(outDir).selected === 'film' && readLibrary(outDir).instruction === '不要卡通')
writeLibrary(outDir, { instruction: 'x'.repeat(LIMITS.instruction * 3) })
ok('超长指令被截断到上限', readLibrary(outDir).instruction.length === LIMITS.instruction)
writeFileSync(path.join(libraryDir(outDir), LIBRARY_FILE), '{broken', 'utf8')
ok('坏状态文件退回默认值、不抛', readLibrary(outDir).selected === 'none')

console.log('— skill 装载')
const skillsRoot = path.join(tmp, 'skills')
mkdirSync(path.join(skillsRoot, 'alpha'), { recursive: true })
writeFileSync(path.join(skillsRoot, 'alpha/SKILL.md'),
  '---\nname: alpha\ndescription: 一支画架构图的技能\n---\n# 正文\n', 'utf8')
mkdirSync(path.join(skillsRoot, '_disabled'), { recursive: true })
writeFileSync(path.join(skillsRoot, '_disabled/SKILL.md'), '---\nname: nope\n---\n', 'utf8')
const skills = listSkills({ skillsDirs: [skillsRoot] })
ok('列出本机 skill（注入目录，不依赖真实家目录）', skills.some((s) => s.id === 'alpha'))
ok('下划线开头的禁用/备份目录不列', !skills.some((s) => s.id === '_disabled'))
ok('摘要取 frontmatter 的 description，不搬正文', skills.find((s) => s.id === 'alpha')?.desc.includes('画架构图'))
ok('技能条目含 id / name / desc 三字段', skills.every((s) => s.id && s.name && typeof s.desc === 'string'))
const st = skillsToText(['alpha', '不存在的'], skills)
ok('只把**已勾选且存在**的 skill 变成指引文本', st.includes('alpha') && !st.includes('不存在的'))

console.log('— 提示词组装')
const style = { prefix: '35mm, ', suffix: ', film grain' }
const c1 = composePrompt('一只红狐', { style, instruction: '不要卡通', skillsText: st })
ok('四段都拼进去且顺序是 风格→指令→技能', c1.text.includes('35mm, 一只红狐, film grain')
  && c1.text.indexOf('film grain') < c1.text.indexOf('不要卡通'))
ok('parts 逐段可展示（界面能说清「加了什么」）', c1.parts.length === 4)
ok('用户原始提示词仍在（文件名不受污染）', c1.text.includes('一只红狐'))
ok('空风格/空指令/空技能 → text 为空、parts 为空', (() => {
  const c = composePrompt('x', { style: null })
  return c.text === '' && c.parts.length === 0
})())
ok('超长段被截断且**记录**在 truncated（不静默）', (() => {
  const c = composePrompt('x', { style: { prefix: 'p'.repeat(LIMITS.stylePrefix * 2) } })
  return c.truncated.length === 1 && c.text.length <= LIMITS.stylePrefix + 1
})())

console.log('— 接线（不是只有模块）')
ok('★ host 注册了 GET/POST /api/comfy-pipeline/library', indexSrc.includes("path: '/api/comfy-pipeline/library'"))
ok('★ host 注册了 GET /api/comfy-pipeline/skills', indexSrc.includes("path: '/api/comfy-pipeline/skills'"))
ok('★ 生图链用 promptForModel（不是原始 prompt）', indexSrc.includes('prompt: promptForModel,'))
ok('★ 视频链也用 promptForModel', (indexSrc.match(/prompt: promptForModel,/g) ?? []).length >= 2)
ok('★ 文件名仍用原始 prompt（不被风格前缀污染）',
  indexSrc.includes('safeStem(prompt, 22)'))
ok('★ 面板有素材库区块（风格/指令/skills）',
  panelSrc.includes('cp-library') && panelSrc.includes('api/comfy-pipeline/library'))
ok('★ 可装载技能标题带中文引导（请装载美术 / 画风 / 配色相关的 skill）',
  panelSrc.includes('可装载的技能（') && panelSrc.includes('请装载美术、画风、配色相关的 skill'))
ok('★ 没装 skill 时仍给出「先装载美术/画风」引导',
  panelSrc.includes('请先装载美术、画风、配色相关的 skill'))
ok('★ describe.js 有视频加速档可见项', describeSrc.includes("key: 'vidaccel'"))
ok('★ 状态端点把 pick() 结果喂给优化面板', indexSrc.includes('videoAccel: videoAccelOf(caps)'))

console.log('— 视频加速档：行为验证')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)
const caps = mod.__internal.FULL_CAPS
const cfg = mod.__internal.DEFAULTS
const img = describeOptimization(cfg, caps, 'win32', { mode: 'image', videoAccel: { id: null, note: '不加速' } })
ok('生图模式不出现视频加速档', !img.detail.some((d) => d.key === 'vidaccel'))
const vid = describeOptimization(cfg, caps, 'win32', { mode: 'video', videoAccel: { id: null, note: '不加速：本机没有 Wan 适用档' } })
ok('★ 视频模式出现 vidaccel 项', vid.detail.some((d) => d.key === 'vidaccel'))
ok('★ 未装档时如实显示「不加速」，不写假的「已加速」',
  vid.detail.find((d) => d.key === 'vidaccel')?.now.includes('不加速'))
ok('★ vidaccel 计入总账（stats.total 与 detail 长度一致）', vid.stats.total === vid.detail.length,
  `stats=${vid.stats.total} detail=${vid.detail.length}`)
ok('★ 视频模式 summary 仍写明 DMD 固定 4 步', vid.summary.includes('DMD'))
ok('★ 图链专属项在视频模式被移出并在 filtered 里说明',
  !vid.detail.some((d) => /八步蒸馏|极速档|BlockCache/.test(String(d.name)))
  && vid.filtered.some((x) => x.includes('生图链专属')))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
