# lib/describe.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### describe-note-007（原 lib/describe.js L1-23）

```js
/**
 * dsh-qwen-paint —— 优化面板描述（describeOptimization / genericOptimizations）
 * ============================================================================
 * ★★ 2026-10-13：从 lib/config.js **拆出来**的，原因只有一个 ——
 *
 *   `lib/config.js` 涨到 **264,530 B**，超过了 **DSH Store 的单文件上限
 *   262,144 B**（256 KiB）。这不是"看着不舒服"，是**上架/复检会被机器人拦下**。
 *
 *   而 `describeOptimization` 一个函数就占 52 KB，是文件里最大的一块 ——
 *   抽走它 + `genericOptimizations`，config.js 立刻降到 ~209 KB，留出 ~50 KB 余量。
 *
 * ⚠ 为什么只抽这两块、不抽数据表：
 *   这两块是**纯展示逻辑**（把探测结果翻译成人话），不参与工作流构建，
 *   与其它符号的耦合最少 —— 拆它风险最低。DEFAULTS / GPU_PROFILES 那些表
 *   被 buildWorkflow 等热路径到处引用，拆动它们收益小、风险大。
 *
 * ## 循环 import（与 index.js ↔ config.js **同一套路**，已验证可用）
 *   本文件 import config.js，而 config.js 又 import 本文件的两个函数（为了
 *   保持旧的 import 路径不变）。ESM 的 **live binding** 让这件事成立：
 *   本文件顶层**只在调用时**才读 config 的绑定，不在模块求值期读 ⇒ 不会 TDZ。
 *   ⚠ 前提：本文件顶层**不能**出现"读 config 绑定并求值"的语句（比如
 *     `const X = DEFAULTS.y`）。要加常量请放进函数体内，或放到 config.js。
 */
```

### describe-note-008（原 lib/describe.js L37-43）

```js
/**
 * ★★★ 2026-10-14（「专业卡版」）：三个**多选一档位**的选项表。
 *
 * ⚠ 这些是**纯字面量**，不读 config 的绑定 —— 满足本文件顶部"顶层不得读 config 绑定"的约束。
 * ⚠ 取值必须与 config.js 的 `VRAM_MODES` / `PRECISION_TIERS` / `TEXT_CONTROL_MODES` **一致**，
 *   否则会出现"面板给了一个端点不认的值"= 假控件。回归里有断言钉死这一点。
 */
```

### describe-note-009（原 lib/describe.js L79-82）

```js
  // ★★★ 2026-10-10 修 bug：TE-Speed / Speedup / BlockCache **三者互斥，且由出图尺寸决定谁上**
  //   （见 `pickWrapperSet`）。而 `plan.useTe/useSpeedup` 是"被 BlockCache 挤掉之后"的**静态**结果 ——
  //   直接报它会出现"报告说未启用、实际 1024² 正在用 TE+Speedup"的假报告。
  //   ⇒ 这里报**策略**，不报布尔值（与真正提交的工作流一致）。
```

### describe-note-010（原 lib/describe.js L444-448）

```js
/* ------------------------------------------------------------------ *
 * describeOptimization 的逐项装配 / 档位构造 —— 从大函数里拆出的模块级函数。
 * 全部依赖经 c 注入；item() 仍 push 进调用方传入的同一个 detail。
 * 拆此不改任何文案与状态判定，便于单独复核与回归。
 * ------------------------------------------------------------------ */
```

### describe-note-011（原 lib/describe.js L523-528）

```js
  // TE-Speed / Speedup：**依赖 turbo8 链路**，所以"不可启用"是一个独立状态 ——
  // 这也是那条要求「哪些不能启用」最典型的落点。
  //
  // ★ 2026-10-09：新增 `superseded`（被取代）—— BlockCache 与 TE-Speed/Speedup
  //   三者争抢同一组 DIFFUSION_MODEL wrapper，BlockCache 生效时后两者**主动让位**，
  //   不是"被配置关了"也不是"没装"。显示成 off 会让用户去修一个不该开的开关。
```

### describe-note-012（原 lib/describe.js L599-606）

```js
  // ★ 2026-10-09 新增：BlockCache T8（取代 ToMe 的图生图加速）
  //   它是**插件节点**，没装时整单会被 ComfyUI 拒收 —— 必须靠探测开关兜住，
  //   所以这里也要如实告诉用户"装了就能用"还是"没装"。
  //   ★ 让位关系要说清楚：BlockCache 生效时 TE-Speed / Speedup 是**主动让位**
  //     （superseded），不是故障。用户若想换回去，这里给出确切做法。
  // ★★★ 2026-10-09 二次修正：不再是"要么一直开、要么一直关"，
  //   而是**按出图尺寸自动接管**（wrapperPolicy=auto）。文案必须跟着改，
  //   否则会出现"面板说 BlockCache 关着，但 1408 出图实际在用它"的假报告。
```

### describe-note-013（原 lib/describe.js L640-644）

```js
  // ★ 2026-10-10 新增：RDNA3 FlashAttention（**无损**加速，与上面三者不互斥）。
  //   它已经装在 custom_nodes 里、却一直没接进工作流（等于白装）—— 接上后如实展示。
  // ★★★ 2026-10-11：**按显卡门控** —— 这个节点只认 gfx1100（AMD RDNA3）。
  //   在 N 卡 / I 卡 / RDNA2 / RDNA4 上它既装不了也跑不了，列出来只会让用户白折腾，
  //   所以**直接不显示**（认不出显卡时照旧显示，见 appliesToGpu 的约定）。
```

### describe-note-014（原 lib/describe.js L666-669）

```js
  // ★★★ 2026-10-11 新增：**A 卡专属优化（可选，仅 AMD 显示）**。
  //   与 N 卡/I 卡的"厂商专属优化"同一套思路：只在适用的显卡上出现、**默认关**、用户自己决定。
  //   两项都**质量中性**（换后端 / 改加载时机，都不改计算结果 ⇒ **不牺牲原生画质**）。
  //   ⚠ 标记为 `optional`：默认关的项**不该**把面板拖成"优化部分启用"（见 item() 的说明）。
```

### describe-note-015（原 lib/describe.js L708-712）

```js
  // ★★★ 2026-10-11 新增：**N 卡 SageAttention（可选，仅 NVIDIA 显示）**。
  //   40 系（Ada）/ 50 系（Blackwell）的专属注意力加速 —— 与 A 卡的专属优化同一套模式：
  //   只在适用显卡上出现、默认按自检结果、用户可手动接管。
  //   ⚠ 与 A 卡那两项不同：`--use-sage-attention` 是**硬依赖** —— 没装还挂上，ComfyUI 起不来。
  //     所以"确认没装"时**把开关置灰**，而不是让用户点一下就崩。
```

### describe-note-016（原 lib/describe.js L762-769）

```js
  // ★★★ 2026-10-13（任务 #62③）：**NVFP4 量化模型提示（仅 Blackwell / 50 系）**。
  //   NVFP4 是 Qwen-Image-2.1 在 Blackwell（sm_120）上的低精度权重格式，配合支持的推理栈
  //   可显著提速（社区已有独立 checkpoint：`BennyDaBall/Qwen-Image-2.1-NVFP4`，3 GB 级）。
  //   ⚠ 只**检测 + 提示**，**绝不自动切换模型** —— NVFP4 是单独模型文件，得用户自己下载、
  //      放进 ComfyUI 的 models 目录，并在出图时显式指定该模型名。
  //   ⚠ 本插件开发机是 AMD RX 7900 XT，**NVFP4 路径无法在本机实测** ——
  //      此处如实标注：已验证的是"该 checkpoint 客观存在"，不是"本机跑过"。
  //   ⚠ `optional: true`：它不计入"优化是否完整"的判定（信息项，不是开关）。
```

### describe-note-017（原 lib/describe.js L787-795）

```js
  //
  //   这是本轮"苹果端完全没有优化"的正解落点。两件事：
  //     ① `--use-pytorch-cross-attention`（在 apple / mac_amd 档的 args 里）——
  //        ComfyUI 源码里 `ENABLE_PYTORCH_ATTENTION` **没有任何 MPS 分支**，
  //        所以 Mac 默认落到 `attention_sub_quad`（次二次通用实现）；
  //        这个参数才是把它切到 PyTorch SDPA（MPS 上即 Metal 融合内核）的开关。
  //        它由档案自动带上，**不作为开关**（面板只如实说明走了哪条路）。
  //     ② 注入给 ComfyUI 进程的 MPS 环境变量（见 DEFAULTS.appleMpsFallback 的说明）——
  //        这两条**可以关/可以开**，所以列成开关项。
```

### describe-note-018（原 lib/describe.js L870-874）

```js
    // ★★★ 关键设计：**这台机器会不会用到它？**
    //   只有"显存 < 16 GB"的机器才可能触发分块 ⇒ **只有那些机器上**，"节点缺失"才算真正的缺口。
    //   在 20 GB 这类机器上它根本不会被触发，把"没这个节点"列成缺件纯属噪音 ——
    //   而且会**把一台完全正常的机器报成"优化部分启用"**（这正是本项目反复修的那类假报告）。
    //   ⇒ 用 `optional` 标记（不进"优化是否完整"的判定），只在真可能用到的机器上算必需项。
```

### describe-note-019（原 lib/describe.js L947-950）

```js
  // ★★★ 2026-10-12 新增（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文）。
  //   与 Spectrum 同源（跳过部分 transformer 前向），但走**新的采样分布**。
  //   ⚠ 本机**未装**该节点（`custom_nodes/` 无 sada 痕迹）⇒ 默认关，**不自动下载**。
  //   论文的 "1.2–2.0×" 是基准对比，**不是**本项目的工作点。
```

### describe-note-020（原 lib/describe.js L1090-1100）

```js
  // ★★★ 2026-10-14（C1/C2/C5「专业卡版」）：三个**多选一档位**（下拉）。
  //
  // ## 为什么**不放进 `detail`**，而是单独一个 `tiers` 数组
  //   `detail` 里的每一项都是"优化点：开/关/可用/缺件"，会进 stats 总账与 reasons 待办。
  //   而档位是**配置选择器**（永远有一个当前值，不存在"没启用"）——
  //   塞进 detail 会把总账搅浑（例如让"可选项已开"计数虚高、或让探测失败时
  //   把档位误报成"未确认"）。所以**单独一栏**，互不干扰。
  //
  // ## 专业卡 / 轻量版怎么分
  //   定义：**显存 ≥ 24 GB 且 系统内存 ≥ 64 GB** → 专业卡档；否则轻量版。
  //   ⚠ 两版**都给**这三档（轻量版也能选，只是可选范围受显存限制）—— 区别只在提示语。
```
