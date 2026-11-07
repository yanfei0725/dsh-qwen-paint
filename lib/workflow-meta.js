/**
 * 工作流元信息的唯一挂载/读取入口。
 *
 * ComfyUI 只接受数字节点键，所以 `__plan / __effective / __cnet` 必须挂在
 * workflow 对象上且不可枚举，不能被 `JSON.stringify` 带进提交载荷。
 * 以前 config.js 与 turbo-workflow.js 各自手写 defineProperty，消费方直接读
 * 魔法字段；任一处改名都会静默落到 undefined。这里把契约收敛成一对函数。
 */

export function attachWorkflowMeta(workflow, meta) {
  for (const [key, value] of Object.entries(meta)) {
    Object.defineProperty(workflow, key, {
      value: Object.freeze(value),
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
  return workflow
}

/**
 * 读取工作流元信息。缺失时返回 null，由调用方决定业务默认值。
 *
 * @returns {{plan: object|null, effective: object|null, cnet: object|null}}
 */
export function readWorkflowMeta(workflow) {
  return {
    plan: workflow?.__plan ?? null,
    effective: workflow?.__effective ?? null,
    cnet: workflow?.__cnet ?? null,
  }
}
