/**
 * 断言风格：ok(名称, 条件)。全离线，零联网、零子进程。
 * 覆盖：三项社区能力只读发现 / 没证据不谎称 / 工具与端点 / 六处接线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMUNITY_FEATURE_TOOL, COMMUNITY_FEATURE_PATH,
  findVaeDtype, findComfyMcp, findWan225B, probeFeature,
  makeCommunityFeatureTool, communityFeatureRouteTable,
} from '../lib/community-features.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond) => { if (cond) pass++; else failures.push(name) }
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

console.log('=== 1. 纯发现 ===')
{
  const yes = findVaeDtype({ ok: true, objectInfo: { VAEDecode: { input: { dtype: [], samples: [] } } } })
  ok('VAE 真暴露 dtype → available', yes.available === true && yes.nodes[0].inputs.includes('dtype'))
  const no = findVaeDtype({ ok: true, objectInfo: { VAEDecode: { input: { samples: [] } } } })
  ok('VAE 没暴露 dtype → 需实测不谎称', no.available === false && /需实测/u.test(no.reason))
  const mcp = findComfyMcp({ ok: true, nodes: ['KSampler'] })
  ok('Comfy MCP 只发现原生 API', mcp.available === true && mcp.endpoints.includes('/prompt') && mcp.endpoints.includes('/history'))
  ok('object_info 不可达 → MCP unavailable', findComfyMcp({ ok: false, nodes: [] }).available === false)
  const wan = findWan225B({ ok: true, nodes: ['WanImageToVideo'] }, ['wan2.2_5b_fp16.safetensors'])
  ok('Wan 可疑节点/模型 → 仍标需真机验证', wan.available === true && /真机加载验证/u.test(wan.reason))
  const none = findWan225B({ ok: true, nodes: ['KSampler'] }, [])
  ok('Wan 无证据 → 需实测', none.available === false && /需实测/u.test(none.reason))
  ok('未知 feature 被拒', probeFeature('seedream', { ok: true, nodes: [] }).available === false)
}

console.log('=== 2. 工具与端点 ===')
{
  const tool = makeCommunityFeatureTool({
    objectInfoProbe: async () => ({ ok: true, nodes: ['VAEDecode'], objectInfo: { VAEDecode: { input: { samples: [] } } } }),
    listModelFiles: async () => [],
  })
  const r = await tool.execute({ feature: 'vae_dtype' })
  ok('工具名正确且返回缺证据结论', tool.name === COMMUNITY_FEATURE_TOOL && r.available === false && r.fallback.applied === false)
  ok('工具异常不抛', (await makeCommunityFeatureTool({ objectInfoProbe: async () => { throw new Error('x') } })
    .execute({ feature: 'comfy_mcp' })).available === false)
  const routes = communityFeatureRouteTable({})
  ok('端点一条 POST', routes.length === 1 && routes[0].path === COMMUNITY_FEATURE_PATH && routes[0].method === 'POST')
}

console.log('=== 3. 六处接线 ===')
{
  const reg = read('lib/tool-registry.js')
  ok('registry import', /from '\.\/community-features\.js'/u.test(reg))
  ok('registry 工具名', reg.includes("'probe_community_features'"))
  ok('registry 挂工具', /makeCommunityFeatureTool\(base\)/u.test(reg))
  ok('registry 挂端点', /communityFeatureRouteTable\(base\)/u.test(reg))
  ok('agent-guide 点名', /probe_community_features:/u.test(read('lib/agent-guide.js')))
  ok('tool-descriptions 点名', /probe_community_features:/u.test(read('lib/tool-descriptions.js')))
  ok('selftest 点名', read('scripts/selftest.mjs').includes("'probe_community_features'"))
  ok('根 llms.txt 反引号点名', /`probe_community_features`/u.test(read('llms.txt')))
  ok('docs/llms.txt 反引号点名', /`probe_community_features`/u.test(read('docs/llms.txt')))
  ok('本测试已登记 SUITES', read('scripts/test-all.mjs').includes('test-community-features.mjs'))
}

console.log('\n=== 结果 ===')
console.log(`通过 ${pass}，失败 ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  FAIL', f); process.exit(1) }
console.log('全部通过')
