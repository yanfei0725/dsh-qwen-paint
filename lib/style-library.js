/**
 * lib/style-library.js —— 素材库（**不是图片库**）。
 *
 * ## 用户的定义（原话）
 *   「素材库指的是用户需要的**设计风格**、**用户的指令**、以及用户可以**自行装载各种 skill**」
 *   ⇒ 三块，全部是"出图前的输入"，不是一堆图片文件：
 *     ① **设计风格**：命名风格包（提示词前缀/后缀 + 负面词 + 画幅建议）
 *     ② **用户指令**：一段自由文本，每次生成都会带上（"不要卡通""要 35mm 胶片感"）
 *     ③ **可装载 skill**：把本机已装的技能（`~/.dsh/skills/*\/SKILL.md`）挂进来，
 *        取其名字与摘要作为风格指引
 *
 * ## 落盘
 *   `<outputDir>/../千问1素材库/`
 *     · `library.json` —— 当前选中的风格、用户指令、勾选的 skill
 *     · `styles/*.json` —— 用户自定义风格包（一个文件一个风格，可手写、可拷贝分享）
 *   内置风格不走文件，写在代码里（BUILTIN_STYLES），删文件删不掉它们。
 *
 * ## 一条硬规矩
 *   拼进 prompt 的东西**有上限**（见 LIMITS），且**逐段可见**：
 *   `composePrompt()` 返回 `{ text, parts }`，界面上能看清"这次到底加了什么"。
 *   悄悄往用户提示词里塞一长串东西，比不提供这个功能更糟。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LIBRARY_DIR_NAME = '千问1素材库'
export const LIBRARY_FILE = 'library.json'
export const STYLES_SUBDIR = 'styles'

/** 拼进 prompt 的长度上限（字符）。超了就截断并**如实说截断**。 */
export const LIMITS = Object.freeze({
  stylePrefix: 300,
  styleSuffix: 300,
  instruction: 600,
  skillsText: 500,
})

/**
 * 内置设计风格。`aspect` 与 `lib/config.js` 的 `ASPECTS` 键同名（0..6 的顺序见 pipeline-controls）。
 * ⚠ 内置项只给**风格词**，不给"画质承诺"（不写 4k/8k 之类空话）。
 */
export const BUILTIN_STYLES = [
  {
    id: 'none', name: '无（就用我自己的提示词）', prefix: '', suffix: '', negative: '', aspect: null, builtin: true,
  },
  {
    id: 'film', name: '胶片纪实', builtin: true, aspect: '3:2',
    prefix: '35mm film photograph, natural available light, subtle grain, ',
    suffix: ', documentary framing, true-to-life color',
    negative: 'cartoon, cgi, plastic skin, oversaturated',
  },
  {
    id: 'cinematic', name: '电影感', builtin: true, aspect: '16:9',
    prefix: 'cinematic still, anamorphic lens, shallow depth of field, motivated key light, ',
    suffix: ', volumetric haze, filmic contrast',
    negative: 'flat lighting, snapshot, watermark, text',
  },
  {
    id: 'anime', name: '动画赛璐璐', builtin: true, aspect: '3:4',
    prefix: 'anime cel-shaded illustration, clean line art, two-tone shading, ',
    suffix: ', expressive eyes, clean color separation',
    negative: 'photorealistic, 3d render, muddy colors',
  },
  {
    id: 'product', name: '产品图（干净背景）', builtin: true, aspect: '1:1',
    prefix: 'studio product shot, seamless backdrop, soft box lighting from above, ',
    suffix: ', crisp edges, no props',
    negative: 'clutter, harsh shadow, reflection artifacts',
  },
]

/** 素材库根目录：与成品同级的 `<outputDir>/../千问1素材库`。 */
export function libraryDir(outputDir) {
  const dir = typeof outputDir === 'string' && outputDir.trim() !== '' ? outputDir.trim() : '.'
  return path.join(path.dirname(dir), LIBRARY_DIR_NAME)
}

const clampText = (v, max) => String(v ?? '').slice(0, max)

/** 读一个风格包文件并规范化（字段缺失按空串/空数组，非法就看不出是风格包 → 丢弃）。 */
function readStyleFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const id = String(raw.id ?? path.basename(file, '.json')).trim()
    const name = String(raw.name ?? id).trim()
    if (id === '' || name === '') return null
    return {
      id,
      name,
      prefix: clampText(raw.prefix, LIMITS.stylePrefix),
      suffix: clampText(raw.suffix, LIMITS.styleSuffix),
      negative: clampText(raw.negative, LIMITS.stylePrefix),
      aspect: typeof raw.aspect === 'string' && raw.aspect !== '' ? raw.aspect : null,
      builtin: false,
      file,
    }
  } catch {
    return null
  }
}

/** 列出全部风格（内置 + 用户目录）。同名 id：用户覆盖内置（方便改内置项）。 */
export function listStyles(outputDir) {
  const dir = path.join(libraryDir(outputDir), STYLES_SUBDIR)
  const user = []
  try {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.json')) continue
        const s = readStyleFile(path.join(dir, f))
        if (s !== null) user.push(s)
      }
    }
  } catch { /* 目录读不动就当没有用户风格，不影响内置 */ }
  const byId = new Map(BUILTIN_STYLES.map((s) => [s.id, s]))
  for (const s of user) byId.set(s.id, s)
  return [...byId.values()]
}

/** 读素材库状态（缺文件 → 默认：不选风格、无指令、不挂 skill）。 */
export function readLibrary(outputDir) {
  const file = path.join(libraryDir(outputDir), LIBRARY_FILE)
  const fallback = { selected: 'none', instruction: '', skills: [] }
  try {
    if (!existsSync(file)) return { ...fallback }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...fallback }
    return {
      selected: typeof raw.selected === 'string' && raw.selected !== '' ? raw.selected : 'none',
      instruction: clampText(raw.instruction, LIMITS.instruction),
      skills: Array.isArray(raw.skills) ? raw.skills.filter((x) => typeof x === 'string' && x !== '').slice(0, 12) : [],
    }
  } catch {
    return { ...fallback }
  }
}

/** 写素材库状态（合并 + 规范化）。写盘失败只回 saved:false，不影响出图。 */
export function writeLibrary(outputDir, patch) {
  const current = readLibrary(outputDir)
  const next = {
    selected: typeof patch?.selected === 'string' && patch.selected !== '' ? patch.selected : current.selected,
    instruction: patch?.instruction !== undefined ? clampText(patch.instruction, LIMITS.instruction) : current.instruction,
    skills: Array.isArray(patch?.skills) ? patch.skills.filter((x) => typeof x === 'string' && x !== '').slice(0, 12) : current.skills,
  }
  const dir = libraryDir(outputDir)
  const file = path.join(dir, LIBRARY_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { library: next, saved: true, reason: '' }
  } catch (error) {
    try { unlinkSync(`${file}.${process.pid}.tmp`) } catch { /* 没建出来就算了 */ }
    return { library: next, saved: false, reason: String(error?.message ?? error) }
  }
}

/** 技能根目录（可用 `skillsDir` 覆盖，便于测试注入）。 */
export function skillsRoots(cfg = {}) {
  if (Array.isArray(cfg.skillsDirs) && cfg.skillsDirs.length > 0) return cfg.skillsDirs.filter((d) => typeof d === 'string')
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return [path.join(home, 'skills')]
}

/** 从 SKILL.md 里取 `name` 与一句摘要（去掉 frontmatter，取第一段正文）。 */
export function summarizeSkill(md, fallbackId) {
  // ⚠ 先把 CRLF 归一：Windows 上的 SKILL.md 多数是 CRLF，
  //   `^---\n` 匹不上 `---\r\n` 会导致 frontmatter 没被剥掉，摘要变成"--- name: xxx ..."
  const text = String(md ?? '').replace(/\r\n/g, '\n')
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  let name = fallbackId
  let desc = ''
  if (fm) {
    const nameHit = /^name:\s*(.+)$/m.exec(fm[1])
    if (nameHit) name = nameHit[1].trim().replace(/^["']|["']$/g, '')
    const descHit = /^description:\s*(.+)$/m.exec(fm[1])
    if (descHit) {
      const v = descHit[1].trim().replace(/^["']|["']$/g, '')
      // YAML 块标量（description: | 或 >）：取紧跟着的第一非空行
      desc = /^[|>][+-]?$/.test(v)
        ? (fm[1].split('\n').slice(fm[1].split('\n').indexOf(descHit[0]) + 1).map((x) => x.trim()).find((x) => x !== '') ?? '')
        : v
    }
  }
  if (desc === '') {
    const body = fm ? text.slice(fm[0].length) : text
    const para = body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s !== '' && !s.startsWith('#'))
    desc = (para ?? '').replace(/^#+\s*/, '')
  }
  return { name: String(name).slice(0, 80), desc: String(desc).replace(/\s+/g, ' ').slice(0, 160) }
}

/** 列出本机可用技能（目录名 + 名字 + 一句摘要）。读不动就空表。 */
export function listSkills(cfg = {}) {
  const out = []
  const seen = new Set()
  for (const root of skillsRoots(cfg)) {
    let dirs = []
    try { dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [] } catch { dirs = [] }
    for (const ent of dirs) {
      if (!ent.isDirectory() || ent.name.startsWith('_') || ent.name.startsWith('.')) continue
      const file = path.join(root, ent.name, 'SKILL.md')
      if (!existsSync(file)) continue
      if (seen.has(ent.name)) continue
      seen.add(ent.name)
      let md = ''
      try { md = readFileSync(file, 'utf8') } catch { md = '' }
      const { name, desc } = summarizeSkill(md, ent.name)
      out.push({ id: ent.name, name, desc })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 组装最终提示词。
 *
 * @returns {{ text: string, parts: Array<{kind:string,label:string,value:string}>, truncated: string[] }}
 *   · `text` 是送进工作流的那串（**文件名仍用用户原始提示词**，见 index.js）
 *   · `parts` 给界面/日志逐段展示：加了什么，一眼可见
 *   · `truncated` 记录哪段被截断了（不静默）
 */
export function composePrompt(userPrompt, { style, instruction = '', skillsText = '' } = {}) {
  const base = String(userPrompt ?? '').trim()
  const parts = []
  const truncated = []
  // ⚠ 风格前缀/后缀**保留原样的首尾空格**：内置风格写成 "...grain, " / ", documentary..."，
  //   trim 掉之后拼上用户提示词会变成 "...,一只红狐"（逗号后没空格）。提示词是给模型读的，
  //   这种接缝值得保住。parts 里展示的值才 trim。
  const take = (kind, label, value, max, keepSpacing = false) => {
    const raw = String(value ?? '')
    if (raw.trim() === '') return ''
    if (raw.length > max) truncated.push(`${label}已截断到 ${max} 字符`)
    const v = raw.slice(0, max)
    parts.push({ kind, label, value: v.trim() })
    return keepSpacing ? v : v.trim()
  }
  const prefix = take('style', '风格前缀', style?.prefix, LIMITS.stylePrefix, true)
  const suffix = take('style', '风格后缀', style?.suffix, LIMITS.styleSuffix, true)
  const instr = take('instruction', '用户指令', instruction, LIMITS.instruction)
  const skills = take('skills', '技能指引', skillsText, LIMITS.skillsText)

  // 一段都没加 → 明确返回空串，含义是「**不覆盖**」，调用方据此保持原始提示词不变。
  if (parts.length === 0) return { text: '', parts, truncated }
  const chunks = [prefix + base + suffix]
  if (instr !== '') chunks.push(instr)
  if (skills !== '') chunks.push(skills)
  return { text: chunks.filter((c) => c !== '').join('；'), parts, truncated }
}

/** 把勾选的 skill 变成一段"风格指引"文本（**只用名字与摘要**，不搬 skill 正文）。 */
export function skillsToText(selectedIds, skills) {
  const ids = Array.isArray(selectedIds) ? selectedIds : []
  const byId = new Map((Array.isArray(skills) ? skills : []).map((s) => [s.id, s]))
  const lines = []
  for (const id of ids) {
    const s = byId.get(id)
    if (!s) continue
    lines.push(s.desc === '' ? s.name : `${s.name}：${s.desc}`)
  }
  return lines.join(' | ')
}
