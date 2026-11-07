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
