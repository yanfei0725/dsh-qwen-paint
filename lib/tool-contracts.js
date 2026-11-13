/**
 * DSH 工具 output 契约的公共外壳。
 *
 * `output` 是 DSH 注册时的强校验项；以前每个工具各写一份 schema/render，
 * 新增任务工具时容易漏 `render`。这里只统一“动态二进制结果”的外壳，
 * 文案仍由各工具传入。
 */
export function makeBinaryOutputContract({ description, render }) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      description,
    },
    render,
  }
}

/**
 * 严格结果 schema 的统一生成器（B3「统一 schema 生成」）。
 * 所有新工具都从这里出 schema，不再各写一份字面量；`additionalProperties: false`
 * 让 DSH 在注册时就能挡住"偷偷多回一个大字段"。
 */
export function makeDeclaredOutputSchema(properties, required = [], description = '') {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties,
  }
  if (required.length > 0) schema.required = [...required]
  if (description !== '') schema.description = description
  return schema
}

/**
 * 结果回包收口（B3「结果回包只留必要字段」）。
 *
 * 按 `output.schema.properties` 的声明白名单重建结果对象：
 *   · 未在 schema 里声明的调试字段 / 中间态 / 大对象一律不回给宿主；
 *   · 值为 `undefined` 的键不回（JSON 里本来也会被丢掉，这里提前收干净）；
 *   · schema 没声明 properties（诊断类 `additionalProperties: true`）→ 原样返回，
 *     **绝不误删动态报告**。
 *
 * 纯函数、零 I/O，便于离线断言。
 */
export function slimResult(schema, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const props = schema && typeof schema === 'object'
    && schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties)
    : []
  if (props.length === 0) return value
  const out = {}
  for (const key of props) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/**
 * 给工具套一层「按声明收口」的外壳：只包 `execute`，其余字段（含
 * `planWorkflow` / `shouldProbe` / `output`）原样保留，自测仍可直接调。
 * 这样 10 个工具的回包口径只需一处维护。
 */
export function withDeclaredOutput(tool) {
  if (!tool || typeof tool.execute !== 'function') return tool
  const original = tool.execute
  return {
    ...tool,
    async execute(...args) {
      const value = await original.apply(this, args)
      return slimResult(tool.output?.schema, value)
    },
  }
}
