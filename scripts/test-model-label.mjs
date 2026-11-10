#!/usr/bin/env node
/**
 * 模型文件名预处理回归（host 侧 + 前端兜底 + 端点接线）。
 * 用户要求：_fp8 / _int8 / .safetensors 自动截断，下拉只显示干净名，参数挪到右侧灰字。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitModelLabel, preprocessFileLabels } from '../lib/model-label.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- 1. 纯函数 ----
const a = splitModelLabel('qwen_image_2.1_int8_convrot.safetensors')
ok('★ 主体名保留（qwen_image_2.1）', a.clean === 'qwen_image_2.1', a.clean)
ok('★ _int8 从展示名里截断', !a.clean.includes('int8') && a.params.includes('int8'))
ok('★ .safetensors 从展示名里截断', !a.clean.includes('safetensors') && a.ext === 'safetensors')
ok('★ 复杂参数集中到 meta（右侧灰字）', a.meta.includes('int8') && a.meta.includes('convrot') && a.meta.includes('safetensors'), a.meta)
const b = splitModelLabel('umt5_xxl_fp8_e4m3fn_scaled.safetensors')
ok('★ fp8_e4m3fn 也截断', !b.clean.includes('fp8') && b.meta.includes('fp8_e4m3fn'), `${b.clean} | ${b.meta}`)
const c = splitModelLabel('FramePackI2V_HY_fp8_e4m3fn.safetensors')
ok('★ 大小写不敏感', !c.clean.toLowerCase().includes('fp8'), `${c.clean} | ${c.meta}`)
const d = splitModelLabel('hunyuan-video-i2v-720p-Q4_K_M.gguf')
ok('★ GGUF 量化标记进 meta、扩展名也进 meta', d.ext === 'gguf' && /q4/.test(d.meta), `${d.clean} | ${d.meta}`)
ok('★ 干净名（无量化标记）原样保留', splitModelLabel('Hummingbird-XT-5B.safetensors').clean === 'Hummingbird-XT-5B')
ok('★ 空/非法输入不抛', splitModelLabel('').clean === '' && splitModelLabel(null).clean === '' && splitModelLabel(undefined).clean === '')
ok('★ 全被剥光时退回原名（不显示空下拉项）', splitModelLabel('_int8.safetensors').clean === '_int8.safetensors')
ok('★ 参数去重（同标记只列一次）', splitModelLabel('m_int8_int8.safetensors').params.length === 1)

// ---- 2. 批量下发 ----
const flat = preprocessFileLabels({ unet: ['a_int8.safetensors', 'b_fp8.gguf'], lora: ['c_int8.safetensors'] })
ok('★ preprocessFileLabels 覆盖所有分组', Object.keys(flat).length === 3)
ok('★ 扁平表里同时带 clean 与 meta', flat['a_int8.safetensors'].clean === 'a' && flat['a_int8.safetensors'].meta.includes('int8'))
ok('★ 空/坏 files 不抛', Object.keys(preprocessFileLabels(null)).length === 0
  && Object.keys(preprocessFileLabels({ unet: 'not-an-array' })).length === 0)

// ---- 3. 接线（两端规则同口径，别各写一套） ----
const host = read('lib/model-label.js')
const client = read('lib/client.js')
const idx = read('lib/index.js')
ok('★ host 侧纯函数不 import 任何模块（无循环依赖）', !/^\s*import\s/m.test(host))
ok('★ 前端有同口径本地兜底（旧 host 不下发时也不露裸名）',
  client.includes('splitModelLabelLocal') && client.includes('MODEL_PARAM_RE'))
const hostRe = (host.match(/const PARAM_RE = (\/.+\/[a-z]*)/) ?? [])[1]
const clientRe = (client.match(/const MODEL_PARAM_RE = (\/.+\/[a-z]*)/) ?? [])[1]
ok('★★ 两端正则逐字一致（防止显示名漂移）', Boolean(hostRe) && hostRe === clientRe, `${hostRe} VS ${clientRe}`)
ok('★ host 端点下发 fileLabels', idx.includes('preprocessFileLabels(caps?.files)'))
ok('★ 前端动态下拉用 fileLabels 的干净名', client.includes('infoOf(f).clean') && client.includes('caps?.fileLabels'))
ok('★ 右侧灰字元素存在且随选择更新',
  client.includes('qwen-paint-opt-select-meta') && client.includes("metaEl.textContent = sel._metaMap"))
ok('★ CSS 里灰字用 #6B7280、标签用 #9CA3AF',
  client.includes('#6B7280') && client.includes('#9CA3AF') && client.includes('gap: 8px'))
ok('★ host 改动只影响 capabilities 返回体，不碰出图载荷',
  !idx.includes('fileLabels') === false && idx.includes('respondJson(res, { ok: true, caps, fileLabels'))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
