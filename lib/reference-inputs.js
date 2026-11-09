/**
 * 参考图入参归一与上传结果核对。
 *
 * 多图上传失败不能静默补空位：全失败是错误，部分失败要保留成功的图并
 * 明确告诉调用方。抽成纯函数，便于不启 ComfyUI 直接回归。
 *
 * ★ 2026-11-09（issue #1）：上限 3 → 16。
 *   依据 ComfyUI 源码 `comfy_extras/nodes_qwen.py` 的 `TextEncodeQwenImage21`：
 *
 *     io.Autogrow.Input("images", template=io.Autogrow.TemplateNames(
 *         io.Image.Input("image"), names=[f"image_{i}" for i in range(1, 17)], min=0))
 *
 *   也就是**节点侧本来就有 image_1 … image_16 十六个槽位**，`min=0` 表示可以一个都不给。
 *   旧上限 3 来自 `TextEncodeQwenImageEditPlus`（只有 image1..3），那是"编辑链"的编码器；
 *   2.1 的原生编码器能收 16 张，所以限制只在插件接口层 —— 这里把它放开。
 *   超过 16 张必须在**入口**报错，绝不静默截断（用户传 20 张却只用了 16 张是最坏的失败方式）。
 */

/** 节点侧真实槽位数（image_1 … image_16）。 */
export const MAX_REFERENCE_IMAGES = 16

/**
 * 张数闸门：超过槽位就抛错（入口与工作流组装两处共用同一句文案）。
 * @throws 超过 {@link MAX_REFERENCE_IMAGES} 张时
 */
export function assertReferenceCount(paths) {
  if (Array.isArray(paths) && paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `参考图最多 ${MAX_REFERENCE_IMAGES} 张（ComfyUI 的 TextEncodeQwenImage21 只有 `
      + `image_1…image_${MAX_REFERENCE_IMAGES} 这些槽位），本次给了 ${paths.length} 张。`
      + '请自己先取舍：多余的不是"不重要"，是**没有槽位可接**，静默丢掉只会让结果与预期不符。',
    )
  }
}

/**
 * 把 `references` 数组 / 单图 `reference` 归一成路径列表。
 * @throws 超过 {@link MAX_REFERENCE_IMAGES} 张时抛出（明确报错，不静默丢弃）
 */
export function normalizeReferencePaths(args) {
  const paths = (Array.isArray(args?.references) ? args.references : [])
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => r.trim())
  const single = typeof args?.reference === 'string' ? args.reference.trim() : ''
  if (paths.length === 0 && single !== '') paths.push(single)
  assertReferenceCount(paths)
  return paths
}

export function reconcileReferenceUploads(paths, uploaded) {
  const references = (Array.isArray(uploaded) ? uploaded : [])
    .filter((r) => typeof r === 'string' && r !== '')
  if (paths.length > 0 && references.length !== paths.length) {
    const detail = `${paths.length} 张参考图只成功上传 ${references.length} 张`
    if (references.length === 0) throw new Error(`${detail}，无法继续。请检查文件路径和 ComfyUI 上传接口。`)
    return { references, warning: `${detail}；本次只使用成功上传的那几张，不静默补空位` }
  }
  return { references, warning: '' }
}
