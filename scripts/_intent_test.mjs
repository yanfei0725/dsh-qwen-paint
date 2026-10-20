/**
 * DSH 联动层自测 —— 生图意图判定策略 + 插件总开关
 *
 * 用法：node scripts/_intent_test.mjs
 *
 * 覆盖：
 *   ① 四档 drawTrigger 生成出的提示词确实语义不同（不是换个名字而已）
 *   ② 未知值 / undefined 都安全回落到 auto
 *   ③ 四档共通的输出纪律（一次一张、不写附加说明、思考极简）一个都不能少
 *   ④ enabled 开关的默认值与语义
 */

import { __internal as I } from '../lib/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let fail = 0
const assert = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

console.log('=== 1. 四档策略生成的提示词 ===')
const off = I.buildDrawIntentPrompt('off')
const strict = I.buildDrawIntentPrompt('strict')
const auto = I.buildDrawIntentPrompt('auto')
const eager = I.buildDrawIntentPrompt('eager')
for (const [k, t] of Object.entries({ off, strict, auto, eager })) {
  console.log(`  ${k.padEnd(7)} ${String(t.length).padStart(4)} 字`)
}

console.log('\n=== 2. 各档语义差异（关键：四档必须真的不同） ===')
assert('off：要求"不要主动揣测生图意图"', off.includes('不要主动揣测'))
assert('off：不含"第一个动作就是调用"这类激进指令', !off.includes('第一个动作就是调用'))
assert('strict：模糊请求要"先问一句"', strict.includes('先问一句'))
assert('strict：明确排除流程图/思维导图', strict.includes('流程图') && strict.includes('思维导图'))
assert('eager：沾边就"先画出来"', eager.includes('先画出来'))
assert('四档内容互不相同', new Set([off, strict, auto, eager]).size === 4)

// ★★ 2026-10-09：下面这两条是**事故的回归断言**，不许再退回去。
//   现场：用户说「画一幅表现双曲几何之美的数学艺术画」，旧文案里
//     · 排除清单含「示意图」→ 助手把"数学/几何/示意"往"图表类"上靠 → 不敢调工具；
//     · 又写「宁可先问一句，也不要画错」→ 助手于是**自己写渲染脚本去画**（更糟）。
//   所以：①"示意图"必须从排除清单里消失；②"宁可先问"必须换成"拿不准就画"。
console.log('\n=== 2b. 事故回归：判定标准已从"题材"改成"产物形态" ★★ ===')
assert('auto：已删除"宁可先问一句"（它会诱发不画/自己画）', !auto.includes('宁可先问一句'))
assert('auto：改成"拿不准就画一张"', auto.includes('拿不准就画一张'))
assert('auto：明确写了"题材完全不影响判断"', auto.includes('题材完全不影响判断'))
assert('auto：数学/几何可视化被显式点名为"要画"', auto.includes('数学/几何可视化'))
// "示意图"作为**排除项**出现过一次就足以误伤；这里要求四档里它只能以"要画"的语境出现。
for (const [k, t] of Object.entries({ off, strict, auto, eager })) {
  assert(`${k}：不含"宁可先问一句"`, !t.includes('宁可先问一句'))
}
assert('eager：显式写了抽象/数学题材也要画', eager.includes('数学/几何/抽象题材'))

// 「示意图」在**要画**的语境里出现是正当的（比如"物理示意图，照画"），
// 只有当它落在**排除句**里才是事故元凶。所以按句判定，不做全文子串匹配。
// （反面例子：'strict' 里的"组织架构图"含"架构图"二字，但它本来就该排除。）
{
  const EXCLUDE_MARKERS = ['不属于本工具', '不走本工具', '不用本工具', '不要调用', '不要画', '不画', '才不画']
  for (const [k, t] of Object.entries({ off, strict, auto, eager })) {
    const segs = String(t).split(/[。；]/u)
    const bad = segs.filter((s) => EXCLUDE_MARKERS.some((m) => s.includes(m)) && s.includes('示意图'))
    assert(`${k}：排除句里不含"示意图"（共 ${segs.length} 句）`, bad.length === 0)
  }
}

console.log('\n=== 2c. 事故回归：四档共通的"不许自己画"铁律 ★★ ===')
// 这条是**根因**：全篇没有任何一句话禁止助手绕过工具自己用代码出图。
// 断言要覆盖"禁止"本身、被点名的手段清单、以及"别自作主张改需求/追加方案"。
for (const [k, t] of Object.entries({ off, strict, auto, eager })) {
  assert(`${k}：禁止自己出图`, t.includes('不许自己') && t.includes('错误行为'))
  assert(`${k}：点名禁止 Python/Matplotlib`, t.includes('Python/Matplotlib'))
  assert(`${k}：点名禁止 SVG / HTML / Canvas`, t.includes('SVG') && t.includes('Canvas'))
  assert(`${k}：点名禁止字符画`, t.includes('字符画'))
  assert(`${k}：不许擅自改需求/追加方案`, t.includes('别自作主张改需求'))
  assert(`${k}：不许出图后问"要不要我改用代码画"`, t.includes('要不要我改用代码画'))
}

console.log('\n=== 3. 健壮性 ===')
assert('未知策略回落到 auto（不抛错）', I.buildDrawIntentPrompt('乱写的值') === auto)
assert('undefined 也回落到 auto', I.buildDrawIntentPrompt(undefined) === auto)
assert('DEFAULTS.drawTrigger 默认 auto', I.DEFAULTS.drawTrigger === 'auto')
assert('DEFAULTS.enabled 默认 true（装上即用）', I.DEFAULTS.enabled === true)

console.log('\n=== 4. 四档共通纪律一个都不能少 ===')
for (const [k, t] of Object.entries({ off, strict, auto, eager })) {
  assert(`${k}：含"一次只生一张"`, t.includes('一次只生一张'))
  assert(`${k}：含"不写耗时/尺寸"`, t.includes('耗时多少秒'))
  assert(`${k}：含"思考过程保持极简"`, t.includes('思考过程保持极简'))
}

console.log('\n=== 5. 内联展示段落（与策略无关，恒定生效） ===')
assert('含 Markdown 图片语法要求', I.INLINE_IMAGE_PROMPT.includes('Markdown 图片语法'))
assert('含"不要只给路径"', I.INLINE_IMAGE_PROMPT.includes('不要只给路径'))

console.log('\n=== 6. 界面档位 vs host 策略（跨文件一致性）★ ===')
{
  // 界面上那四档必须和 host 的 DRAW_INTENT_MODES 严格对应 ——
  // 名字对不上就会出现"点了没反应"或"选了是别的档"，而这种错**永远不会报错**，
  // 只会表现为"这功能好像坏了"。所以做成断言钉死。
  const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  const block = /const TRIGGER_CHOICES = \[([\s\S]*?)\n\s*\]/u.exec(src)
  if (!block) {
    assert('client.js 里能找到 TRIGGER_CHOICES', false)
  } else {
    const ids = [...block[1].matchAll(/id: '([a-z]+)'/gu)].map((m) => m[1])
    const hostKeys = Object.keys(I.DRAW_INTENT_MODES)
    console.log(`  界面提供: ${ids.join(', ')}`)
    console.log(`  host 策略: ${hostKeys.join(', ')}`)
    assert('四档齐全', ids.length === 4)
    assert('界面每个档位 host 都认识', ids.every((id) => hostKeys.includes(id)))
    assert('host 每个档位界面都能选到', hostKeys.every((k) => ids.includes(k)))
  }
}

console.log('\n=== 7. 工具描述里的边界（模型最先看到的就是它）★ ===')
{
  const tool = I.makeDrawTool({}, { timeoutMs: 1000 }, () => {}, () => {}, () => {})
  const d = tool?.description ?? ''
  assert('工具描述存在且非空', d.length > 100)
  assert('工具名是 draw_image', tool.name === 'draw_image')
  // 事故回归：描述里必须有"严禁自己画"，否则模型在读到 systemPrompt 之前就可能跑偏。
  assert('描述明确"严禁自己写 Python/Matplotlib/PIL"出图', d.includes('严禁自己写 Python/Matplotlib/PIL'))
  assert('描述写明本工具是"出图的唯一途径"', d.includes('唯一途径'))
  assert('描述把边界收窄到"可编辑的结构化图表"', d.includes('可编辑的结构化图表'))
  assert('描述不含"先与用户确认"这类劝退话', !d.includes('先与用户确认'))
  assert('描述显式点名"数学/几何可视化"属于要画的范围', d.includes('数学/几何可视化'))
  assert('描述写"拿不准就调本工具画一张"', d.includes('拿不准就调本工具画一张'))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
