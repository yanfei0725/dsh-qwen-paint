# quality-fix-presets / quality-args 设计注释（2026-11-20）

> 逐字保留两文件的设计说明；源文件头部只留锚点，以符合 lib 合计 ≤ 2,097,152 B 红线。逐字可逆。

## quality-fix-note-001（原 lib/quality-fix-presets.js L1-20）

```
/**
 * lib/quality-fix-presets.js —— Qwen-Image 2.1 画质修复两档配方（2026-11-20）。
 *
 * ## 它是什么
 * 把用户给的画质修复配方固化成**可复用、可校验**的两档预设：
 *   · 快速预览：T8(turbo8 八步蒸馏) + Fix LoRA 强度 0.75 + 8 步 + CFG 1
 *   · 高质量输出：原版 2.1(原生链) + Fix LoRA 强度 1.0 + 20 步 + CFG 3
 * 两档共用同一个 `qwen_image_2.1_int8_convrot.safetensors` 基础模型 —— 差别只在
 * 是否挂 turbo8 LoRA、Fix LoRA 强度、步数、CFG（两档共用同一底座，差别只在这几项）。
 *
 * ## 设计红线（和 workflow-presets.js 同口径）
 *  1. **只描述配方，不改生成链**：本模块导出纯数据与纯函数，由 execute 层决定
 *     怎么把 set 套到 args 上；不 import config.js，不产生循环依赖。
 *  2. **键必须真实存在**：set 里的键都能映射到生图链的真实旋钮
 *     （steps / cfgOverride / fixLora / fixLoraStrength / turbo8Enabled）。
 *  3. **蒸馏链 CFG 锁 1**：快速档走 turbo8，CFG 必须是 1（>1 过曝崩边，这是
 *     config.js 已有的硬规则），所以快速档的 cfg 与链本身自洽。
 *  4. **不编造模型来源**：权重文件只按文件名登记，权威 size/sha256 见
 *     scripts/quality-fix-catalog.mjs；下载一律走 setup 脚本，默认不下载。
 */
```

## quality-fix-note-002（原 L27-38，两档预设字段说明）

```
/**
 * 两档预设。字段说明：
 *   steps            → 采样步数（args.steps）
 *   cfg              → 提示词引导（args.cfgOverride）
 *   fixLoraStrength  → Fix LoRA 强度
 *   turbo8Enabled    → 是否挂 turbo8 八步蒸馏 LoRA
 *   fixLora          → Fix LoRA 文件名
 *   sampler/scheduler→ 采样器与调度器（本机真实节点支持的值）
 *   vaeTiling        → VAE 分块解码（高质量档默认 on，见 config.js 的 plan.useVaeTiling）
 *   post             → 后处理档（由 quality-pipeline.js 消费）
 *   promptMode       → 结构化提示词/负面词档（由 quality-pipeline.js 消费）
 */
```

## quality-args-note-001（原 lib/quality-args.js L1-11）

```
/**
 * lib/quality-args.js —— 画质预设 → resolveDrawParams 参数桥（2026-11-20）。
 *
 * ## 为什么单独成文件
 * resolveDrawParams 在 index.js 里、已接近单文件上限；这里只做"预设 id → 参数覆盖"
 * 的纯映射，零 I/O、零副作用，能在测试里独立断言，不碰 index.js 构图逻辑。
 *
 * ## 接入契约
 * 输入 resolveDrawParams 已解析好的参数对象；若 preset 是 qualityfix-*，返回覆盖后的
 * 浅拷贝 + 说明；否则逐字返回原对象（默认行为零变化）。
 */
```
