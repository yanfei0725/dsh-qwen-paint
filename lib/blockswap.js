/** blockswap —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#ttsll2-space-blockswap */

export const BLOCKSWAP_BACKENDS = Object.freeze([
  {
    id: 'uniblockswap',
    label: 'UniBlockSwap · 通用 Block 交换（极限压显存）',
    license: 'MIT',
    repo: 'smthemex/ComfyUI_UniBlockSwap',
    nodePattern: /UniBlockSwap|BlockSwap/iu,
    mechanics: 'num block：-1 = 单块卸载；0 = 关闭 swap；>0 = 预缓存对应数量 block；≥ 总块数 = 关闭（等同 0）',
    note: 'ComfyUI ≥0.35 需临时关闭 dynamic 才生效（节点自带处理）；目的是极限压显存、避免共享显存，速度可能不如原生；klein9B Q8 ≈ 4.8G VRAM 为 repo 口径（unverified）',
    installHint: 'git clone https://github.com/smthemex/ComfyUI_UniBlockSwap 到 ComfyUI/custom_nodes（用户显式安装，插件不代装）',
    unverified: true,
  },
])

export const BLOCKSWAP_ENGINE_IDS = Object.freeze(BLOCKSWAP_BACKENDS.map((b) => b.id))

/** 从 /object_info 节点类名清单里发现 block 交换节点（模式发现，不猜）。 */
export function discoverBlockSwap({ installed = [] } = {}) {
  const names = (Array.isArray(installed) ? installed : []).map(String)
  const found = []
  for (const b of BLOCKSWAP_BACKENDS) {
    const hits = names.filter((n) => b.nodePattern.test(n))
    if (hits.length > 0) found.push({ id: b.id, nodeNames: hits })
  }
  return {
    available: found.length > 0,
    found,
    reason: found.length === 0
      ? '未发现 block 交换节点（UniBlockSwap 未安装）——低显存极限档不可用；安装为用户显式动作，插件不代装'
      : '',
  }
}

/**
 * accel-chain 的 blockswap 段：发现 + 机制说明 + 安装指引 + 低显存提示。
 * 节点未装时如实 available:false；装了也**不自动参与编排**（工作流补丁待真机核实槽位后另批）。
 */
export function buildBlockSwapSection({ installed = [], vramMb = null } = {}) {
  const disc = discoverBlockSwap({ installed })
  const lowvram = Number.isFinite(vramMb) && vramMb > 0 && vramMb <= 8192
  return {
    available: disc.available,
    found: disc.found,
    reason: disc.reason,
    backends: BLOCKSWAP_BACKENDS.map((b) => ({
      id: b.id, label: b.label, license: b.license, repo: b.repo,
      mechanics: b.mechanics, note: b.note, installHint: b.installHint, unverified: b.unverified,
    })),
    lowvram_note: lowvram
      ? '当前显存档较低：如需跑超出显存的大模型，可显式安装 UniBlockSwap（见 install_hint）——装好后插件会自动发现并在报告里给出建议，编排启用仍需用户拍板'
      : '',
    workflow_patching: 'needsSlotMapping —— 节点未在本机 /object_info 核实槽位前，不写任何工作流输入（诚实边界）',
    unverified: true,
  }
}
