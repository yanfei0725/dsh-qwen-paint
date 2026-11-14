/**
 * lib/comfy-upload.js —— 把本地文件送进 ComfyUI 的 `input/` 目录。
 *
 * ## 为什么单独一支
 *   图片（参考图 / 首帧）和音频（音轨 / 参考人声）走的是**同一个**上传端点，
 *   但错误消息、命名前缀、缺文件时的提示词各不相同。共用一份上传实现，
 *   三处调用方各自只提供「怎么称呼这个文件」。
 *
 * ## ★ 端点事实（ComfyUI 0.39.0，2026-11-14 真机实测）
 *   `POST /upload/image` **接受 wav**，返回 `{"name":"…wav","subfolder":"","type":"input"}` + HTTP 200。
 *   表单字段名固定叫 `image` —— 这不是笔误，是 ComfyUI 的端点约定；
 *   自作聪明改成 `audio` 会直接 400。
 *
 * ## 为什么名字要加前缀
 *   ComfyUI 按文件名落盘，`overwrite=true` 等于「后到的赢」。不同目录下的同名文件
 *   （refs/1/voice.wav 与 refs/2/voice.wav）会**静默**互相覆盖 —— 与图片侧 issue #1
 *   同一个坑。所以调用方传一个轮内唯一的前缀进来。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 把上传返回的裸文件名规范成 **`input/...`** 形式。
 *
 * ## ★★ 为什么必须有这一步（2026-11-14 真机实测，差点写成假接线）
 *   `VHS_LoadAudio.audio_file` 传**纯文件名** `a.wav`
 *     → 提交直接被拒：`prompt_outputs_failed_validation` / `custom_validation_failed`
 *   传 **`input/a.wav`**
 *     → `status_str: success`
 *   即：这个槽要的是**相对 ComfyUI 根目录**的路径，不是 `/upload/image` 返回的裸 `name`。
 *   回头看 `/object_info` 里它的 `default` 就是 `"input/"` —— 那是明示，不是随手写的占位。
 *
 * ⇒ 所以上传完成后统一规范成 `input/...`，调用方不用记这个约定；
 *   同时 workflow 构造层再兜一次底（防止有人直接手写工作流时传裸名）。
 *
 * @param {string} name 裸文件名或已带前缀的路径
 * @returns {string} 可直接塞进 `audio_file` 的值
 */
export function toComfyInputPath(name) {
  const s = String(name ?? '').trim().replace(/\\/gu, '/')
  if (s === '') return ''
  // 已带标注前缀（input/ output/ temp/ 或 [input] 之类）就原样，不重复加。
  if (/^(input|output|temp)\//u.test(s)) return s
  if (s.startsWith('[')) return s
  // 绝对路径不该走到这里（上传后拿到的永远是相对名）；真出现了也不猜，交给上层报错。
  if (/^[A-Za-z]:\//u.test(s) || s.startsWith('//')) return s
  return `input/${s}`
}

/**
 * @param {object} o
 * @param {object} o.cfg 插件配置（要 `comfyUrl`）
 * @param {string} o.filePath 本地绝对路径
 * @param {Function} o.fetchFn 注入的请求函数（带超时/回环校验的那一个）
 * @param {AbortSignal} [o.signal]
 * @param {string} o.namePrefix 上传名前缀（轮内唯一，防同名覆盖）
 * @param {string} o.kind 中文称呼，用于错误消息（'参考图' / '音轨'）
 * @returns {Promise<string>} **已规范成 `input/...`** 的 ComfyUI 侧路径
 */
export async function uploadToComfy({ cfg, filePath, fetchFn, signal, namePrefix, kind }) {
  const label = String(kind ?? '文件')
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到${label}：${filePath}（${error?.message ?? error}）`)
  }
  const uploadName = `${namePrefix}${path.basename(filePath)}`
  const form = new FormData()
  form.append('image', new Blob([bytes]), uploadName)
  form.append('overwrite', 'true')

  const res = await fetchFn(`${cfg.comfyUrl}/upload/image`, {
    method: 'POST', body: form, signal, timeoutMs: 120000,
  })
  if (!res?.ok) throw new Error(`${label}上传失败：HTTP ${res?.status}`)
  const data = await res.json()
  if (!data?.name) throw new Error(`${label}上传返回异常：${JSON.stringify(data).slice(0, 200)}`)
  const rel = data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  return toComfyInputPath(rel)
}
