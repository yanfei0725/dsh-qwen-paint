# history-admin / dag-planner / doctor 设计注释（2026-11-21）

> 逐字保留三文件头部设计说明；源文件只留锚点，以符合 lib 合计 ≤ 2,097,152 B 红线。逐字可逆。

## history-admin-note-001（原 lib/history-admin.js L1-14）

```
/**
 * lib/history-admin.js —— 生成历史的「可删改 + 冷热分离 + 参数化查询」层。
 *
 * 设计取舍：项目已有 SQLite 库（lib/history-store.js 的 images 表，支持
 * image/video/audio/other 四类 kind 与软删除）。本层**不改原表语义、不改原文件**，
 * 通过幂等 ALTER TABLE 补列 + 注入 SQL 执行器来扩展管理能力，
 * 这样原有的 test-history.mjs / test-history-export.mjs 行为完全不变。
 *
 * 隐私红线：
 *   · file_path 仍是相对出图目录的 POSIX 风格路径，导出接口不返回它；
 *   · 硬删除默认只删数据库记录，**绝不删磁盘文件**（除非调用方显式注入 unlink 并置 deleteFile）；
 *   · 导出 JSONL 只含脱敏统计字段，不含 prompt 全文、绝对路径、用户名、凭据。
 *   · 所有 SQL 一律参数化，过滤条件只走白名单键，杜绝拼接注入。
 */
```

## dag-planner-note-001（原 lib/dag-planner.js L1-11）

```
/**
 * lib/dag-planner.js —— 自适应自启动 DAG 编排（纯 JS、零 I/O）。
 *
 * 「自启动」在本项目里指 ComfyUI 进程自动拉起与看护（lib/comfy-launch.js
 * 的 ensureComfyUp）。本模块**不启动任何进程**，只在探测到后端未就绪时
 * 把 `ensure_comfy` 作为前置节点写进计划，由调用方决定谁去执行它。
 *
 * 现状里的编排是 lib/hybrid-runner.js 的固定串行 image→tts→video；
 * 这里补的是「按实际探测到的能力动态生成依赖图 + 环检测 + 取消 + 失败降级」。
 */
```

## 附注：2026-11-21 工具 parameters 投影事故

`query_history` / `doctor` / `run_dag` 三个 tool definition 曾缺 `parameters` 字段。
宿主 `projectToolSchema` 在**枚举工具表阶段**就 `snapshotJsonValue(parameters)`，
`undefined` 会抛错 ⇒ 整轮 run 全部失败（不是单工具不可用）。已给三者补齐
与各自 execute 实参对齐的 `parameters`，并用 `scripts/test-tool-parameters.mjs`
以宿主同款投影逻辑遍历全部外置工具，固化"发布前自测"。
