#!/usr/bin/env node
/**
 * hipfire-img generateWithHipfire 前置校验错误路径直测（2026-11-20 零触及清单）。
 *
 * 切片（前置校验段全在 I/O 之前——零 mock 零联网）：
 *   空 prompt 拒 / negative 明确报错（诚实条款：不支持就说不支持）/ 回环 URL 校验。
 *   transport=cli/http 的执行段需 execFile/fetch mock，ROI 低不在此文件。
 *
 * 纯离线。
 */
import { generateWithHipfire } from '../lib/hipfire-img.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('— 前置校验')
{
  const r = await generateWithHipfire({}, { prompt: '   ' })
  ok('★ 空 prompt → ok:false + 中文指引（不静默出默认图）',
    r.ok === false && String(r.error).includes('prompt 不能为空'), r.error)
  const r2 = await generateWithHipfire({}, { prompt: '一只猫', negative: '低质量' })
  ok("★ negative → 明确报错不支持（hipfire 两接口都无此参数——诚实条款：不支持就说不支持，不静默丢弃）",
    r2.ok === false && String(r2.error).includes('不支持负面提示词')
    && String(r2.error).includes("imageBackend: 'comfyui'"), String(r2.error).slice(0, 80))
  const r3 = await generateWithHipfire({ hipfireTransport: 'http', hipfireUrl: 'http://example.com:9000' }, { prompt: 'x' })
  ok('★ 非回环 hipfireUrl → assertLocalUrl 拒（配置信息不出网校验）',
    r3.ok === false && typeof r3.error === 'string' && r3.error !== '', JSON.stringify(r3))
  const r4 = await generateWithHipfire({ hipfireTransport: 'cli', hipfireExe: '' }, { prompt: 'x' })
  ok('★ cli 传输无 exe → 错误路径如实（不假装成功）',
    r4.ok === false && typeof r4.error === 'string' && r4.error !== '', JSON.stringify(r4).slice(0, 120))
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
