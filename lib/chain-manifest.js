// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-chain-manifest
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
