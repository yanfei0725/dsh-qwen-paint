import { pathToFileURL } from 'node:url'
import { createRequire } from 'module'
// ★ 2026-10-09：改用相对路径（原先写死开发机绝对路径，既不可移植，也会让
//   pack.mjs 的隐私检查拦下整个打包）。
const require = createRequire(new URL('../package.json', import.meta.url))
const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname).href)
const { DEFAULTS, buildWorkflow } = mod.__internal

const cfg = { ...DEFAULTS }   // 用插件默认配置（模型名=千问默认）
cfg.comfyUrl = 'http://127.0.0.1:8188'
console.log('comfyUrl =', cfg.comfyUrl)
console.log('models: unet=%s clip=%s vae=%s lora=%s', cfg.unet, cfg.clip, cfg.vae, cfg.turbo8Lora)

function fetchWithTimeout(url, opts = {}) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(new Error('timeout')), opts.timeoutMs ?? 60000)
  try { return fetch(url, { ...opts, signal: c.signal }) } finally { clearTimeout(t) }
}

const wf = buildWorkflow(cfg, { prompt: '一只戴草帽的橘猫坐在窗台上，午后阳光', negative:'', width:1024, height:1024, steps:8, seed: 12345, reference:'' })
console.log('workflow 节点数 =', Object.keys(wf).length)

const t0 = Date.now()
const sub = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, { method:'POST', body: JSON.stringify({ prompt: wf, client_id:'smoke-'+Date.now() }), timeoutMs: 60000 })
const subJson = await sub.json()
if (subJson.prompt_id === undefined) { console.log('✗ ComfyUI 拒绝工作流：', JSON.stringify(subJson).slice(0,800)); process.exit(3) }
const pid = subJson.prompt_id
console.log('✓ 已提交 prompt_id =', pid)

// 等待结果（最多 120s）
let images=null
for (let i=0;i<60;i++){
  await new Promise(r=>setTimeout(r,2000))
  let hist
  try { const r = await fetchWithTimeout(`${cfg.comfyUrl}/history/${pid}`, {timeoutMs:20000}); hist = await r.json() } catch { continue }
  const e = hist?.[pid]; if(!e) continue
  const st = e.status ?? {}
  if (st.status_str==='error'){ const err=(st.messages||[]).find(m=>Array.isArray(m)&&m[0]==='execution_error'); console.log('✗ 执行失败：', JSON.stringify(err?.[1]??st).slice(0,800)); process.exit(5) }
  const found=[]
  for (const o of Object.values(e.outputs??{})) for (const im of o?.images??[]) if(im?.filename) found.push(im)
  if (found.length){ images=found; break }
}
if (!images){ console.log('✗ 120s 内未出图（可能挂起或模型加载慢）'); process.exit(4) }
console.log('✓ 出图成功，文件：', images.map(i=>i.filename).join(', '), '  用时', ((Date.now()-t0)/1000).toFixed(1)+'s')
