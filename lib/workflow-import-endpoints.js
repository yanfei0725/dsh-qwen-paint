// 设计说明已外置 → docs/added-modules-design-notes.md#workflow-import-endpoints-note-001（原 L1-13）
import { inspectWorkflow, nodeCoverage, detectBindableSlots, buildTemplate } from './workflow-import.js'

export function makeWorkflowImportHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
    registry, loadObjectInfo, log,
  } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 日志不可用无所谓 */ } }

  const handlersHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      const u = new URL(req.url, 'http://127.0.0.1')
      const id = u.searchParams.get('id') ?? ''
      if (id !== '') {
        const rec = registry.get(id)
        if (rec === null) { respondJson(res, { ok: false, reason: '模板不存在' }, 404); return }
        respondJson(res, {
          ok: true,
          template: rec.template,
          note: '模板来自本机导入的 ComfyUI API 格式 JSON；仅存进程内存，插件重启后需重新导入。',
        })
        return
      }
      respondJson(res, {
        ok: true,
        schema: 'dsh-qwen-paint/workflow-import@1',
        templates: registry.list(),
        note: '用 POST 提交 { id, label, workflow } 导入外部 ComfyUI API 格式工作流；'
          + '模板只存进程内存，重启失效，不写包内 workflows/ 清单。',
      })
      return
    }
    if (method !== 'POST') { respondJson(res, { ok: false, reason: 'GET / POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return

    try {
      const body = (await readJsonBody(req)) ?? {}
      if (String(body?.action ?? '') === 'remove') {
        const removed = registry.remove(body?.id)
        respondJson(res, { ok: removed, action: 'remove', id: body?.id ?? '' })
        return
      }

      const inspected = inspectWorkflow(body?.workflow)
      if (!inspected.ok) {
        respondJson(res, {
          ok: false, reason: '工作流结构校验失败', errors: inspected.errors.slice(0, 20),
          note: '只接受 ComfyUI API 格式（{"1":{class_type,inputs}}）；UI 格式请用 ComfyUI 的 Export (API) 重新导出。',
        }, 400)
        return
      }

      // 本机 /object_info 覆盖核对：探测失败不阻断导入，只是如实标 checked=false。
      let objectInfo = null
      try { objectInfo = await loadObjectInfo() } catch { objectInfo = null }
      const coverage = nodeCoverage(inspected.graph, objectInfo)
      const slots = detectBindableSlots(inspected.graph)
      const template = buildTemplate(inspected.graph, {
        id: body?.id, label: body?.label, kind: body?.kind,
      })
      const rec = registry.put(template, {
        note: coverage.checked ? coverage.note : '本机 objectInfo 未探测到，节点覆盖未核对',
      })

      respondJson(res, {
        ok: true,
        id: rec.id,
        label: template.label,
        kind: template.kind,
        summary: inspected.summary,
        warnings: inspected.warnings.slice(0, 20),
        coverage,
        bindableSlots: slots.slice(0, 100),
        note: '模板已生成（字面量槽位换成 $param./$asset. 占位符）。仅存进程内存，重启需重新导入；'
          + '当前版本提供校验与模板导出，尚未接入 runDraw 交付链路。',
      })
    } catch (error) {
      warn(`工作流导入失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '工作流导入失败（详见插件日志）' }, 500)
    }
  }

  return { handlersHandler }
}

/** 挂到 host 的 reg() 上；返回路径 → handler 清单，便于测试核对。 */
export function workflowImportRouteTable(handlers) {
  return [['/api/qwen-paint/workflow-import', handlers.handlersHandler]]
}
