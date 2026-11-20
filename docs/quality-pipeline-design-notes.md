# quality-pipeline 设计注释（2026-11-21）

> 逐字保留 `lib/quality-pipeline.js` 头部设计说明；该文件头部只留一行锚点，
> 以符合 lib 合计 ≤ 2,097,152 B 的体积红线。逐字可逆。

## quality-pipeline-note-001（原 lib/quality-pipeline.js L1-24）

```
/**
 * lib/quality-pipeline.js —— Qwen-Image 2.1 / T8 画质管线（2026-11-20）。
 *
 * ## 它做什么
 * 把用户提供的画质优化清单做成**纯函数 + 真实 ComfyUI 节点工作流片段**：
 *   ① 采样调度：原版2.1 优化 sigma + 分段 CFG；T8 锁官方 sigma / Euler / CFG=1
 *   ② 后处理：解码后接真实存在的节点（AdjustBrightness → AdjustContrast → ImageSharpen）
 *   ③ 提示词侧：结构化模板（主体/光照/材质/镜头/色彩）+ 两套负面词
 *   ④ 护栏：避开 RealESRGAN 默认、T8 堆后处理等坑
 *
 * ## ★★ 节点真实性（本机 /object_info 快照 1686 节点实测）
 *   ✅ 存在：AdjustBrightness / AdjustContrast / ImageSharpen / CurveEditor / ColorMatch
 *   ❌ 不存在：UnsharpMask / CLAHE / BilateralBlur / Gamma / Levels / ImageEnhance
 *   ⚠ CurveEditor 输出 CURVE，但**本机无任何节点消费 CURVE** ⇒ 接不进图像链。
 *      故"S 型曲线"用 AdjustBrightness(抬暗) + AdjustContrast(压高光) 的弱强度组合近似，
 *      不用 CurveEditor（接了必然整单拒收）。
 *   ⇒ 本模块只构造真实存在的节点，绝不编造 class_type。
 *
 * ## 设计红线
 *  1. 纯函数优先：所有表/判断都能纯 JS 测，不依赖 GPU、不下载、不加显存。
 *  2. T8 与 原版2.1 是两套东西，不混用。
 *  3. 后处理只在高质量档生效；T8 预览档一律 none。
 *  4. 这层是"可选增强"，默认不改变现有出图链；由 quality-fix 预设显式驱动。
 */
```
