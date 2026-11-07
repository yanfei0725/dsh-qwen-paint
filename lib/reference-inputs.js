/**
 * 参考图入参归一与上传结果核对。
 *
 * 多图上传失败不能静默补空位：全失败是错误，部分失败要保留成功的图并
 * 明确告诉调用方。抽成纯函数，便于不启 ComfyUI 直接回归。
 */

export function normalizeReferencePaths(args) {
  const paths = (Array.isArray(args?.references) ? args.references : [])
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => r.trim())
    .slice(0, 3)
  const single = typeof args?.reference === 'string' ? args.reference.trim() : ''
  if (paths.length === 0 && single !== '') paths.push(single)
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
