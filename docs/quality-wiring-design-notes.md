# quality-wiring 设计注释（2026-11-21）

> 本文件逐字保留 `lib/quality-wiring.js` 的设计说明正文；该文件头部只留一行锚点，
> 以符合 lib 合计 ≤ 2,097,152 B 的体积红线（DSH Store 口径）。逐字可逆。

## quality-note-001（原 lib/quality-wiring.js L1-24）

```
/**
 * lib/quality-wiring.js —— 把 qualityfix-* 预设真正接进 ComfyUI 构图（2026-11-21）。
 *
 * ## 为什么单独成文件
 * quality-pipeline.js 只产出"配方数据/节点片段"，quality-args.js 只做"预设→args"。
 * 真正把 sigma / 后处理 / 分段 CFG 落到 workflow 节点上的一步之前**缺失**，
 * 导致 qualityfix-* 实际只改了 steps/cfg/negative。本文件补上这一环。
 *
 * ## 设计红线
 *  1. **纯函数 + 就地改 workflow**：输入构图对象，返回 { applied, reasons }，
 *     不改入参以外的任何东西；非画质档（quality 为 null/ok=false）逐字零副作用。
 *  2. **只用真实节点**：后处理 AdjustBrightness/AdjustContrast/ImageSharpen 本机有；
 *     ManualSigmas/SamplerCustomAdvanced 官方 turbo 链已在用；分段 CFG 用
 *     `ScheduledCFGGuider //Inspire`（Inspire-Pack）——**必须探测到才接**，没装就降级
 *     为固定 CFG，绝不把不存在的节点塞进图导致整单拒收。
 *  3. **节点号 900+**：全库构图确认 100–899 空闲、900 由 buildPostprocessNodes 用，
 *     sigma 相关用 910+，避免与 ControlNet(20-22/30-43)、attention(40/43) 撞号。
 *  4. **可降级、可解释**：每一项是否生效都写进 reasons，供上层如实回报。
 */
```

## quality-note-002（原 L59-67，链路开关提升说明）

分段 CFG 依赖的真实节点：`ScheduledCFGGuider //Inspire`（ComfyUI-Inspire-Pack 的
`inspire/sampler_nodes.py`，节点映射名含 `//Inspire` 后缀），输入
model/positive/negative/sigmas/from_cfg/to_cfg/schedule，输出 GUIDER + SIGMAS。
本机未安装 Inspire-Pack，故必须探测到才接。prompt 的社区寻源结论：ComfyUI 核心只有
CFGGuider（固定单值），没有逐步调 CFG 的节点；社区现成实现就是 Inspire-Pack 的
ScheduledCFGGuider，语义为 from_cfg→to_cfg 按 sigma 进度插值（linear/log/exp/cos）。

## quality-note-003（接线顺序）

构图收尾时：先接 sigma（会把 VAEDecode.samples 从 '8' 改指 '914'），
再接后处理（接在 VAEDecode 之后，SaveImage.images 改指后处理链尾）。
非画质档两项都是零副作用；缺 ManualSigmas/SamplerCustomAdvanced 则完全不接管采样；
缺 Inspire-Pack 则分段 CFG 降级为固定 CFGGuider 并把原因写进元信息如实回报。
