/**
 * 视频模型清单 / 选型 / 下载护栏 —— 纯离线回归（不联网、不下载、不写文件）
 *
 * 重点锁住：
 *  · 官方清单解析与「服务器权威值」校验，绝不用记忆里的大小判完整
 *  · 清单拉不到就如实认输，不编造文件名 / URL
 *  · 默认不装、--check 不联网、非交互不替用户选
 *  · 只下载不上传；校验不过必删
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VIDEO_REPO, VIDEO_SOURCES, VIDEO_REPO_PAGES, VIDEO_OPTIMIZATIONS,
  parseHfTree, parseModelScopeFiles, parseCatalog, fetchVideoCatalog,
  videoWeightFiles, videoSupportFiles, recommendVideoPicks, classifyQuant,
  targetDirOf, downloadUrlsFor, verifyDownload, runVideoModelStep,
} from './video-model-catalog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
// 逐条输出 ✓：回归入口按标记数统计断言，套件自己喊「全部通过」但 0 项会被当假阳性
const ok = (cond, msg) => { if (cond) { passed += 1; console.log(`✓ ${msg}`) } else failures.push(msg) }
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

/* 真实抓到的响应片段（2026-11-12，本机代理）：只保留结构，不含任何本机信息 */
const HF_TREE = JSON.stringify([
  { type: 'directory', path: 'split_files', size: 0, oid: 'x' },
  { type: 'file', path: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
    size: 9999999999, lfs: { oid_sha256: 'a'.repeat(64) } },
  { type: 'file', path: 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
    size: 14285760000, lfs: { oid_sha256: 'b'.repeat(64) } },
  { type: 'file', path: 'split_files/vae/wan2.2_vae.safetensors',
    size: 1400000000, lfs: { oid_sha256: 'c'.repeat(64) } },
  { type: 'file', path: 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    size: 6700000000, lfs: { oid_sha256: 'd'.repeat(64) } },
  { type: 'file', path: 'README.md', size: 1234, oid: 'e'.repeat(40) },
])
const MS_FILES = JSON.stringify({
  Code: 200,
  Data: { Files: [
    { Type: 'tree', Path: 'split_files', Size: 0, Sha256: '' },
    { Type: 'blob', Path: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
      Size: 9999999999, Sha256: 'A'.repeat(64), IsLFS: true },
    { Type: 'blob', Path: '.gitattributes', Size: 2937, Sha256: 'f'.repeat(64) },
  ] },
})

/* ---------------------------------------------------------------- 解析 ---- */
{
  const hf = parseHfTree(HF_TREE)
  eq(hf.length, 5, 'HF tree：目录与无 size 的条目被过滤，剩 5 个文件')
  ok(hf.every((f) => f.size > 0 && f.path !== ''), 'HF tree：每条都有路径与正的权威大小')
  const ti2v = hf.find((f) => f.path.includes('ti2v'))
  eq(ti2v.sha256, 'a'.repeat(64), 'HF tree：LFS oid_sha256 被当作文件 SHA256')
  eq(hf.find((f) => f.path === 'README.md').sha256, '', 'HF tree：git blob oid 不冒充文件哈希')

  const ms = parseModelScopeFiles(MS_FILES)
  eq(ms.length, 2, 'ModelScope：tree 被过滤，只留 blob')
  eq(ms.find((f) => f.path.includes('ti2v')).sha256, 'a'.repeat(64), 'ModelScope：Sha256 统一小写')
  eq(parseCatalog(HF_TREE, 'hf').length, 5, 'parseCatalog 按 kind 分流（hf）')
  eq(parseCatalog(MS_FILES, 'modelscope').length, 2, 'parseCatalog 按 kind 分流（modelscope）')
  let threw = false
  try { parseModelScopeFiles('{"Code":404}') } catch { threw = true }
  ok(threw, 'ModelScope 非 200 响应必须抛错，不能当空清单蒙混过关')
}

/* ------------------------------------------------------------ 清单拉取 ---- */
{
  let calls = 0
  const cat = await fetchVideoCatalog({
    fetchText: (url) => { calls += 1; ok(url.includes('recursive=true'), '首源用 recursive 清单 API'); return HF_TREE },
  })
  eq(calls, 1, '首源成功就不再请求其他源')
  eq(cat.via, 'hf-mirror', '记录实际来源')
  eq(cat.files.length, 5, '合并结果条数正确')

  const fallback = await fetchVideoCatalog({
    fetchText: (url) => { if (url.includes('hf-mirror')) throw new Error('502'); return MS_FILES },
  })
  eq(fallback.via, 'modelscope', '首源失败会轮询到第二源')
  eq(fallback.files.length, 2, '第二源解析成功')

  const dead = await fetchVideoCatalog({ fetchText: () => { throw new Error('offline') } })
  eq(dead.files.length, 0, '★ 全源失败返回空清单，绝不兜底造假')
  eq(dead.errors.length, VIDEO_SOURCES.length, '每个源的失败原因都留痕')
  ok(dead.via === null, '全源失败不谎报来源')
}

/* ------------------------------------------------------------ 选型与量化 ---- */
{
  const files = parseHfTree(HF_TREE)
  eq(classifyQuant('wan2.2_t2v_fp8_scaled.safetensors'), 'FP8 / 4-bit 量化', 'FP8 识别')
  eq(classifyQuant('qwen_Q4_K_M.gguf'), 'GGUF 量化', 'GGUF 识别')
  eq(classifyQuant('wan2.2_i2v_int8_convrot.safetensors'), 'INT8 量化', 'INT8 识别')
  eq(classifyQuant('wan2.2_ti2v_5B_fp16.safetensors'), 'FP16', 'FP16 识别')

  const weights = videoWeightFiles(files)
  eq(weights.length, 2, '视频主模型只取 diffusion_models 下的权重')
  ok(weights[0].size <= weights[1].size, '候选按体积从小到大排（低配优先）')
  eq(videoSupportFiles(files).length, 2, '配套 VAE / 文本编码器也来自真实清单')

  const nv = recommendVideoPicks(files, 'nvidia')
  eq(nv.ordered[0].name, 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
    '★ NVIDIA 路线优先 FP8（推荐项必须真实存在于清单）')
  const intel = recommendVideoPicks(files, 'intel')
  eq(intel.ordered[0].name, 'wan2.2_ti2v_5B_fp16.safetensors',
    '★ Intel/核显路线优先最小体积 5B')
  const amd = recommendVideoPicks(files, 'amd')
  ok(amd.ordered.length === 2, 'AMD 路线也只从真实清单里出候选')
  const capped = recommendVideoPicks(files, 'nvidia', { maxBytes: 10 * 1024 ** 3 })
  ok(capped.ordered.every((f) => f.size <= 10 * 1024 ** 3), 'maxBytes 上限生效（8GB 档位用）')
  ok(nv.optimizations.every((o) => typeof o.verified === 'boolean'),
    '每条配套优化都标了 verified，未核实的不冒充结论')
  ok(VIDEO_OPTIMIZATIONS.nvidia.some((o) => !o.verified), '用户提供的加速资料保持 unverified')
  ok(VIDEO_OPTIMIZATIONS.intel.some((o) => o.verified), '插件自己落实的共享内存档位标为已落实')

  // 清单里根本没有的文件，绝不能凭空冒出来
  const empty = recommendVideoPicks([], 'nvidia')
  eq(empty.ordered.length, 0, '空清单 → 零候选，不编造 Hummingbird 文件名')
}

/* ------------------------------------------------------- 落盘 / URL / 校验 ---- */
{
  eq(targetDirOf('split_files/diffusion_models/a.safetensors'), 'diffusion_models', 'diffusion_models 映射')
  eq(targetDirOf('split_files/vae/a.safetensors'), 'vae', 'VAE 映射')
  eq(targetDirOf('split_files/text_encoders/a.safetensors'), 'text_encoders', '文本编码器映射')
  eq(targetDirOf('random/a.safetensors'), null, '认不出的路径不下到错地方')

  const urls = downloadUrlsFor('split_files/diffusion_models/a.safetensors')
  eq(urls.length, 3, '★ 三个源：镜像 / 原站 / HF')
  ok(urls.some((u) => u.url.includes('hf-mirror.com')), '含镜像源')
  ok(urls.some((u) => u.url.includes('modelscope.cn')), '含 ModelScope 原站')
  ok(urls.every((u) => u.url.startsWith('https://')), '全部 https')
  ok(urls.every((u) => !u.url.includes('..')), 'URL 不含路径穿越')

  const expected = { size: 1000, sha256: 'a'.repeat(64) }
  eq(verifyDownload({ actualSize: 1000, actualSha256: 'a'.repeat(64), expected }).ok, true, '完全匹配')
  eq(verifyDownload({ actualSize: 999, actualSha256: 'a'.repeat(64), expected }).ok, false,
    '★ 大小不符直接拒绝（以清单权威值为准，不用记忆值）')
  eq(verifyDownload({ actualSize: 1000, actualSha256: 'b'.repeat(64), expected }).ok, false, '哈希不符拒绝')
  const noHash = verifyDownload({ actualSize: 1000, actualSha256: '', expected: { size: 1000, sha256: '' } })
  eq(noHash.ok, true, '清单没给哈希时只比大小')
  eq(noHash.hashChecked, false, '★ 如实标注「未做哈希校验」，不假装验过')
}

/* ------------------------------------------------------------- 交互主流程 ---- */
{
  const mk = (over = {}) => ({
    vendor: 'intel', isTTY: true, want: null,
    log: () => {}, fetchText: () => HF_TREE,
    download: async () => ({ ok: true }),
    statSize: () => 9999999999,
    sha256Of: async () => 'a'.repeat(64),
    resolveDest: (f) => `/fake/${targetDirOf(f.path)}/${f.name}`,
    ...over,
  })
  const logs = []
  const log = (s) => logs.push(s)

  let net = 0
  const check = await runVideoModelStep(mk({ checkOnly: true, fetchText: () => { net += 1; return HF_TREE } }))
  eq(check.skipped, true, '--check 跳过')
  eq(net, 0, '★★ --check 一个网络请求都不发')
  eq(check.reason, 'check-only', '--check 的跳过原因如实记录')

  const nonTty = await runVideoModelStep(mk({ isTTY: false, log, fetchText: () => { net += 1; return HF_TREE } }))
  eq(nonTty.reason, 'non-interactive-default-no', '★ 非交互默认不装')
  eq(net, 0, '★ 默认不装时也不联网拉清单')

  const declined = await runVideoModelStep(mk({ ask: async () => 'n', log }))
  eq(declined.reason, 'user-declined', '用户说不装就不装')
  ok(logs.some((s) => s.includes('跳过视频模型') && s.includes('不受影响')),
    '跳过时明确说明不影响已有功能')

  const noCatalog = await runVideoModelStep(mk({
    want: 'yes', log, fetchText: () => { throw new Error('offline') },
  }))
  eq(noCatalog.reason, 'catalog-unavailable', '★ 清单拉不到 → 如实认输')
  ok(logs.some((s) => s.includes('不猜文件名')), '明确承诺不编造文件名')
  ok(logs.some((s) => s.includes('官方仓库页面')), '给出官方页面让用户自己找')
  ok(VIDEO_REPO_PAGES.every((p) => p.startsWith('https://')), '官方页面都是 https')

  let picked = 0
  const success = await runVideoModelStep(mk({
    want: 'yes', log, existsLocal: () => false,
    ask: async () => { picked += 1; return '1' },
  }))
  eq(picked, 1, '交互式只问一次选哪个')
  eq(success.installed.length, 1, '★ 明确同意 + 明确选择后才下载 1 个')
  eq(success.installed[0].name, 'wan2.2_ti2v_5B_fp16.safetensors', 'Intel 路线选到 5B（清单真实存在）')
  ok(logs.some((s) => s.includes('校验通过') && s.includes('SHA256')), '下载后按权威值校验并报告')

  const already = await runVideoModelStep(mk({ want: 'yes', log, existsLocal: () => true }))
  eq(already.reason, 'already-present', '本机已有推荐权重 → 不重复下载')
  eq(already.installed.length, 0, '已有文件不进安装列表')

  const noPick = await runVideoModelStep(mk({ want: 'yes', log, ask: async () => '' }))
  eq(noPick.reason, 'no-valid-pick', '直接回车 = 不装')
  const badPick = await runVideoModelStep(mk({ want: 'yes', log, ask: async () => '999' }))
  eq(badPick.reason, 'no-valid-pick', '越界编号不装（不越界取文件）')

  let sourcesTried = 0
  const switched = await runVideoModelStep(mk({
    want: 'yes', log, ask: async () => '1',
    download: async () => { sourcesTried += 1; return { ok: sourcesTried >= 2 } },
  }))
  eq(sourcesTried, 2, '★ 首源失败会换第二个源')
  eq(switched.installed.length, 1, '换源成功后装上')

  let deleted = null
  const bad = await runVideoModelStep(mk({
    want: 'yes', log, ask: async () => '1',
    statSize: () => 123, sha256Of: async () => 'a'.repeat(64),
    removeFile: (p) => { deleted = p },
  }))
  eq(bad.installed.length, 0, '校验不过绝不纳入已安装')
  ok(deleted !== null, '★★ 校验不过的文件一定删除，不将就使用')
  ok(logs.some((s) => s.includes('校验不过')), '如实报告校验失败')

  const noDest = await runVideoModelStep(mk({ want: 'yes', log, ask: async () => '1', resolveDest: () => null }))
  eq(noDest.reason, 'unknown-target', '认不出目标目录就不下')
}

/* ------------------------------------------------------------- 安全红线 ---- */
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'video-model-catalog.mjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
  ok(!/method\s*:\s*['"](?:POST|PUT|PATCH)/iu.test(code),
    '★ 代码里没有任何写远端的方法（只允许 GET 清单 / GET 文件）')
  ok(!/FormData|formData|multipart|uploadFile|writeFileSync/u.test(code),
    '★ 代码不构造上传表单、不写远端')
  ok(!/readFileSync|createReadStream|\bfs\./u.test(code),
    '★ 模块本身不读本机模型内容（杜绝把本机权重带出去）')
  ok(!/[A-Za-z]:\\Users\\|C:\\Users|\/home\/[a-z]/u.test(src),
    '★ 全文不写死任何本机绝对路径 / 用户名')
  ok(VIDEO_SOURCES.every((s) => s.apiUrl(VIDEO_REPO).startsWith('https://')), '所有清单 API 都是 https')
  ok(VIDEO_SOURCES.every((s) => s.fileUrl(VIDEO_REPO, 'a/b.safetensors').startsWith('https://')),
    '所有下载 URL 都是 https')
}

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
for (const f of failures) console.log(`  ✗ ${f}`)
if (failures.length) process.exit(1)
console.log('全部通过 ✓')
