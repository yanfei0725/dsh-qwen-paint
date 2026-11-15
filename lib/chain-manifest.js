/**
 * lib/chain-manifest.js —— 三条链的**统一声明式清单目录**（A1 收口，2026-11-15）。
 *
 * ## 要解决的问题
 *   此前 /workflows 只列 `workflows/*.json` 里的运行时清单（只有 video-wan22），
 *   生图链 / TTS 链虽然各自有 `workflows/contracts/*.contract.json` 与图结构指纹，
 *   却在总览里**只字未提** —— 看起来像「这两条链没清单化」，实际是清单散在
 *   三处、没有统一目录。本模块把它们合成一张可查询、可校验的总账。
 *
 * ## 为什么生图 / TTS 不做运行时清单提交（重要，别在后续改动里抹掉）
 *   生图链按 caps 折 basic/full、按参考图 / 控制图 / 批量分裂十几条分支；
 *   TTS 链的节点名要由 /object_info 在线探测决定。若再造一份 JSON 去「提交」，
 *   就会变成 JS 和 JSON 两边都能跑、两边都会悄悄漂的**半迁移** —— 比不做更糟。
 *   ⇒ 这两条链保持「代码构图 + 契约逐槽位对账 + 指纹锁漂移」，并在本目录里
 *     显式登记为 authoritative=contract。**这是有意的设计决策，不是未完成。**
 *
 * ## 硬规矩
 *   · 纯函数 + 只读 `workflow-manifest.js` / `graph-audit.js` 的目录枚举；
 *   · 不读 npm 包外的 `scripts/` 目录（发布白名单里没有它）；
 *   · 指纹夹具 id 在本模块重复一份，由 scripts/test-chain-manifest.mjs 锁
 *     「与 scripts/workflow-fingerprints.json 逐字相等」（允许重复、强制同步）。
 */
import { listContracts } from './graph-audit.js'
import { listManifests } from './workflow-manifest.js'

export const CHAIN_MANIFEST_VERSION = 1

/** 指纹夹具 id（与 scripts/workflow-fingerprints.json 的 fixtures 键逐字对应）。 */
export const FINGERPRINT_FIXTURES = Object.freeze([
  'image-basic', 'image-full', 'image-img2img', 'video-dmd', 'tts-custom-mp3',
])

export const CHAIN_AUTHORITIES = Object.freeze(['runtime', 'contract'])

/**
 * 链总账。每条都写明「清单在哪、谁构图、怎么核对」。
 * `authoritative=runtime` 恰好一条：只有视频链真的按 JSON 提交。
 */
export const CHAIN_DECLARATIONS = Object.freeze([
  {
    id: 'image-qwen21', kind: 'image', label: 'Qwen-Image 2.1 生图链',
    authoritative: 'contract', contract: 'image-qwen21',
    fingerprints: ['image-basic', 'image-full', 'image-img2img'],
    build: 'lib/config.js::buildWorkflow',
    verify: '/api/qwen-paint/contracts?build=1&id=image-qwen21',
    note: '分支十余条，运行时由代码构图；契约角色/参数逐槽位对账 + 三组指纹锁漂移。',
  },
  {
    id: 'video-wan22', kind: 'video', label: 'Wan 2.2 视频链',
    authoritative: 'runtime', manifest: 'video-wan22',
    fingerprints: ['video-dmd'],
    build: 'lib/video-workflow.js::buildVideoWorkflowFromManifest',
    verify: 'scripts/test-workflow-manifest.mjs（双轨逐字节一致）',
    note: '唯一按清单提交的运行时链；硬编码路径与清单路径必须逐字节相同。',
  },
  {
    id: 'tts-qwen3', kind: 'tts', label: 'Qwen3-TTS 普通合成链',
    authoritative: 'contract', contract: 'tts-qwen3',
    fingerprints: ['tts-custom-mp3'],
    build: 'lib/tts-workflow.js::buildTtsWorkflow',
    verify: 'scripts/test-workflow-contract.mjs（离线真构图核对）',
    note: '节点名由 /object_info 探测决定，端点不做在线探测，绝不假装核对过。',
  },
  {
    id: 'tts-voiceclone', kind: 'tts', label: 'Qwen3-TTS 语音克隆链',
    authoritative: 'contract', contract: 'tts-voiceclone',
    fingerprints: [],
    build: 'lib/speech-tool.js::buildVoiceCloneWorkflow',
    verify: 'scripts/test-workflow-contract.mjs（离线真构图核对）',
    note: '真节点名 FB_Qwen3TTSVoiceClone；克隆链没有独立指纹夹具，靠契约对账。',
  },
])

/** 可序列化副本，供端点直接返回（不把冻结对象暴露出去）。 */
export function listChainDeclarations() {
  return CHAIN_DECLARATIONS.map((d) => ({ ...d, fingerprints: [...d.fingerprints] }))
}

/**
 * 总账体检：来源文件存在性、authoritative 合法性、runtime 唯一性、
 * 契约/清单/指纹是否被漏登记。返回错误数组（空 = 全过），不抛异常。
 * 参数可注入，便于离线单测。
 */
export function verifyChainDeclarations({
  contracts, manifests, fingerprints,
} = {}) {
  const errors = []
  const contractIds = new Set(Array.isArray(contracts) ? contracts : listContracts())
  const manifestIds = new Set(Array.isArray(manifests) ? manifests : listManifests())
  const fixtureIds = new Set(Array.isArray(fingerprints) ? fingerprints : FINGERPRINT_FIXTURES)
  const declaredContracts = new Set()
  const declaredManifests = new Set()
  let runtimeCount = 0

  for (const d of CHAIN_DECLARATIONS) {
    if (!CHAIN_AUTHORITIES.includes(d.authoritative)) {
      errors.push(`链 ${d.id} 的 authoritative 非法：${d.authoritative}`)
    }
    if (d.authoritative === 'runtime') runtimeCount += 1
    if (d.contract) {
      declaredContracts.add(d.contract)
      if (!contractIds.has(d.contract)) errors.push(`链 ${d.id} 指向不存在的契约 ${d.contract}`)
    }
    if (d.manifest) {
      declaredManifests.add(d.manifest)
      if (!manifestIds.has(d.manifest)) errors.push(`链 ${d.id} 指向不存在的清单 ${d.manifest}`)
    }
    if (d.authoritative === 'runtime' && !d.manifest) {
      errors.push(`链 ${d.id} 标 runtime 却没有 manifest`)
    }
    for (const fp of d.fingerprints) {
      if (!fixtureIds.has(fp)) errors.push(`链 ${d.id} 指向不存在的指纹夹具 ${fp}`)
    }
  }
  if (runtimeCount !== 1) errors.push(`runtime 链必须恰好 1 条，实际 ${runtimeCount} 条`)
  for (const id of contractIds) {
    if (!declaredContracts.has(id)) errors.push(`契约 ${id} 没有登记进链总账`)
  }
  for (const id of manifestIds) {
    if (!declaredManifests.has(id)) errors.push(`清单 ${id} 没有登记进链总账`)
  }
  return errors
}

/** 端点用的一句话总览。 */
export function summarizeChains() {
  const byAuthority = {}
  for (const d of CHAIN_DECLARATIONS) {
    byAuthority[d.authoritative] = (byAuthority[d.authoritative] || 0) + 1
  }
  return {
    version: CHAIN_MANIFEST_VERSION,
    count: CHAIN_DECLARATIONS.length,
    by_authority: byAuthority,
    runtime_chains: CHAIN_DECLARATIONS.filter((d) => d.authoritative === 'runtime').map((d) => d.id),
    note: 'authoritative=contract 的链已清单化（契约 + 指纹 + 构建后逐槽位对账），'
      + '但运行时仍由代码构图：这是为避免 JS/JSON 双轨半迁移的有意设计，不是未完成。',
  }
}
