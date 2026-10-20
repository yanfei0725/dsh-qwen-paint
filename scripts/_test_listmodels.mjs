// 临时自测：直接验证 listComfyModels 能否从本机 ComfyUI 拉到真实模型清单。
import { __internal } from '../lib/index.js'

const cfg = { comfyUrl: 'http://127.0.0.1:8188' }

const log = (level, msg) => console.log(`[${level}] ${msg}`)

console.log('== 调用 listComfyModels ==')
const t0 = Date.now()
const models = await __internal.listComfyModels(cfg, log, undefined)
const dt = Date.now() - t0
console.log(`\n== 耗时 ${dt}ms ==`)
for (const [label, list] of Object.entries(models)) {
  if (Array.isArray(list)) {
    console.log(`${label}: ${list.length} 个`)
    if (list.length) console.log('   ' + list.slice(0, 8).join('\n   '))
  } else {
    console.log(`${label}: （节点不存在 / 查询失败）null`)
  }
}
console.log('\nDONE')
