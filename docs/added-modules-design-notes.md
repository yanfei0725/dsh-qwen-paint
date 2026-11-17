# 新增模块设计说明（注释外置）

> 由 scripts/ 一次性脚本从 lib/*.js 逐字外置，源码只留锚点。

### workflow-import-note-001（原 lib/workflow-import.js L1-23）

```js
/**
 * lib/workflow-import.js —— L2：外部 ComfyUI 工作流 JSON 导入（2026-11-17）。
 *
 * ## 用户诉求
 *   插件的工作流是清单化构建的（workflows/*.json + 条件补丁），用户想把自己
 *   在 ComfyUI 里搭好的现成工作流直接拿来用。本模块提供「贴进来 → 校验 →
 *   生成可绑定模板」的纯逻辑，让外部工作流成为可用模板，而不是要求用户读源码。
 *
 * ## 硬边界（先说清楚不做什么）
 *   · 只认 ComfyUI **API 格式**（`{"1":{class_type,inputs},...}`）。ComfyUI 界面
 *     「导出」默认给的 UI 格式（带 nodes/links 数组）**不做半吊子转换** ——
 *     如实报错并提示用「Export (API)」，否则静默转错比不转更糟。
 *   · **不写包内 workflows/ 目录**：那是随 npm 发布的只读清单，写进去会污染包、
 *     并让 test-workflow-manifest 的双轨逐字节断言失效。导入结果只进进程内注册表，
 *     重启即失效（明确写进返回说明），不假装持久化。
 *   · 不联网、不下载、不提交 ComfyUI —— 本模块零 IO 副作用，纯函数 + 内存注册表。
 *   · objectInfo 给了就按它核对节点覆盖；没给只做结构校验并如实标注 coverage.checked=false。
 *
 * ## 与既有模块的关系
 *   · 复用 workflow-ast.js 的 LITERAL_SLOTS（可绑定字面量槽位口径）；
 *   · 复用 workflow-manifest.js 的 SCHEMA_VERSION / 占位符约定（$param./$asset./$const.）；
 *   · 模板产物**结构**与清单一致，但不落盘、不进 listManifests()，所以不触碰任何指纹锁。
 */
```

### ws-preview-note-001（原 lib/ws-preview.js L1-15）

```js
/**
 * lib/ws-preview.js —— L1 渐进式流式预览（2026-11-17）。
 *
 * ## 数据从哪来
 *   ComfyUI 在 `ws://127.0.0.1:8188/ws?clientId=<id>` 上推两类消息：
 *   · JSON `executing` / `progress`：当前 prompt_id、采样步数/总步数（真进度，不是时间估算）；
 *   · **二进制**：前 4 字节 big-endian uint32 头（ComfyUI 固定 0x00000001 表示图片），
 *     从第 4 字节起是 PNG/JPEG 字节 —— 这就是采样过程的低分辨率预览帧。
 *
 * ## 诚实边界
 *   · 本模块只解析/缓存，不假装"已连上"：连接层（index.js）检测 globalThis.WebSocket，
 *     Node 20 没有全局 WS ⇒ 端点如实报 unavailable，进度仍走 progress.js 的历史耗时估算。
 *   · 预览帧是 ComfyUI **推什么就显什么**，不放大、不补帧、不伪造百分比。
 *   · 最多缓存 8 个 prompt × 每 prompt 最新 1 帧，超了挤最老的（内存有界）。
 */
```

### ws-preview-note-002（原 lib/ws-preview.js L120-128）

```js
/**
 * WS 桥接层：连本机 ComfyUI /ws，把 progress 与预览帧喂给 store。
 *
 * ★ 能力检测：Node 20 没有全局 WebSocket ⇒ 返回 { ok:false, reason }，
 *   端点如实报 unavailable；L1 是增强，不是出图前置条件，绝不能因为它失败拖累出图。
 *
 * @param {object} deps { comfyUrl, clientId?, store, WebSocketImpl?, log? }
 * @returns {{ ok:boolean, reason:string, close:()=>void }}
 */
```

### cnet-preprocess-note-001（原 lib/cnet-preprocess.js L1-19）

```js
/**
 * lib/cnet-preprocess.js —— ControlNet 预处理（M4，2026-11-17）。
 *
 * 把「Canny / Depth / OpenPose 提取」搬进插件链路：过去插件只收成品控制图
 * （controlImage），预处理要用户自己在别处做；现在提供本机端点
 * `POST /api/qwen-paint/cnet-preprocess`：上传原图 → 单节点小工作流 → 产物
 * 落输出目录缓存 → 返回可直接填进 draw_image.controlImage 的本地路径 + 预览。
 *
 * ## 本文件的职责边界（刻意收窄）
 *   这里只有**纯逻辑**：候选节点表、节点选择、工作流构建、缓存键、缓存账本。
 *   所有 IO / 网络（上传、提交、等待、下载产物、落盘）由 index.js 的处理器注入 ——
 *   这样每一块都能被回归测试离线逐字节断言，不需要真机 ComfyUI。
 *
 * ## 候选节点是"探测后才知道"，不是"写死就支持"
 *   本机契约（scripts/comfy-node-contract.json，ComfyUI 0.39.0）里只有核心 `Canny`；
 *   Depth / OpenPose 属于社区预处理器包（如 comfyui_controlnet_aux），
 *   节点名因包而异。所以每种类型给**候选名单**，运行时按本机 /object_info
 *   探测到哪个用哪个；全都不在就如实报缺件 + 安装提示，绝不假装能跑。
 */
```

### resume-store-note-001（原 lib/resume-store.js L1-18）

```js
/**
 * lib/resume-store.js —— H4 视频分段续跑账本（2026-11-17）。
 *
 * ## 诚实边界（先说清楚，避免被当成"帧级续采样"）
 *   ComfyUI 的 KSampler 不支持从已完成的帧继续采样，所以本模块**不做帧级续跑**。
 *   它做的是**段级续跑**：长视频被切成多段逐段提交时，每段完成当场落账本；
 *   中断后以同一组参数重跑，校验 prompt/seed/帧参数一致的段直接复用产物，
 *   只重跑剩余段。段与段之间本来就不做帧间接续（见 hybrid-runner 的现有语义），
 *   所以跳过已完成段不会破坏成片连贯性 —— 这与"从中间帧续采样"是两回事。
 *
 * ## 一致性校验（不把不匹配的产物糊上去）
 *   每段的 key = sha256(规范化参数 JSON)：prompt / negative / 每段 seed / 帧数 /
 *   fps / 宽高 / 首帧文件名。**任一不同就是另一段**，绝不复用旧产物。
 *   首帧文件名参与 key：上游换了首帧（比如重画了封面图），整条链都得重跑。
 *
 * ## 纯逻辑
 *   本文件只做账本结构与 key 计算；文件 IO / fsync 由调用方注入（便于离线单测）。
 */
```

### workflow-import-endpoints-note-001（原 lib/workflow-import-endpoints.js L1-13）

```js
/**
 * lib/workflow-import-endpoints.js —— L2 外部工作流导入的本机端点层。
 *
 * · GET  /api/qwen-paint/workflow-import            列出已导入模板（不含 graph，轻量）
 * · GET  /api/qwen-paint/workflow-import?id=<id>    取单个模板详情（含 graph / params）
 * · POST /api/qwen-paint/workflow-import            导入 { id, label, kind, workflow }
 * · POST /api/qwen-paint/workflow-import  { action:'remove', id }  移除一个模板
 *
 * ## 安全边界（与 jobs / history/delete 同级）
 *   · 全部 isLocalRequest；写操作 POST only + guardWriteRequest；
 *   · 异常只回固定文案，不回吐 error.message（避免泄漏本机路径 / 内部细节）；
 *   · 模板只进进程内存注册表，重启即失效，不写磁盘、不联网、不提交 ComfyUI。
 */
```

### job-endpoints-note-001（原 lib/job-endpoints.js L1-22）

```js
/**
 * lib/job-endpoints.js —— 任务队列的前台操作端点（M3，2026-11-17）。
 *
 * · GET  /api/qwen-paint/jobs   队列列表 + 统计（只读）
 * · POST /api/qwen-paint/jobs   { action: 'cancel' | 'pause' | 'resume', id? }
 *
 * ## 为什么做这一层
 *   队列的 cancel/pause/resume 能力早已存在（manage_jobs 工具，lib/job-queue.js），
 *   但前台（lab 页队列区）只有"刷新队列"一个只读按钮 —— 用户在浏览器里
 *   看得到任务排着队，却动不了它。本端点把**同一份 queue 实例**暴露给前台，
 *   不复制、不代理、不另建队列（多实例队列必然漂移）。
 *
 * ## 安全边界（与 history/delete 同级）
 *   · 全部 isLocalRequest：cancel/pause 会真实改变生成行为，远程请求绝不能打得到；
 *   · 写操作 POST only + guardWriteRequest；
 *   · 异常只回固定文案，不回吐 error.message。
 *
 * ## 语义（对齐 lib/job-queue.js，不发明新语义）
 *   · cancel  pending → 直接移出队列；running → 经 AbortSignal 尽力通知 + 立即置终态；
 *   · pause   只停**派发新任务**，正在跑的不冻结；
 *   · resume  恢复派发并立即补泵。
 */
```

### config-note-001（原 lib/config.js L849-893）

```js
   * ★★★ 2026-10-11 新增；**2026-10-12 补上真正的优化**：**Apple Silicon（MPS，M1–M5）**。
   *
   * ## 原先为什么是空的（以及为什么那是错的）
   *   原注释写的是「ComfyUI 官方没给任何 Mac 专属启动参数 ⇒ args: []」。
   *   那句话本身没错，但**漏掉了一个关键事实**。去 ComfyUI 源码里核对：
   *
   *   `comfy/model_management.py` 里 `ENABLE_PYTORCH_ATTENTION` 的自动开启条件只有：
   *     · 显式 `--use-pytorch-cross-attention`
   *     · `is_nvidia()`（torch ≥ 2）
   *     · `is_intel_xpu() / is_ascend_npu() / is_mlu() / is_ixuca()`
   *     · AMD 且 aotriton 且 arch ∈ {gfx90a, gfx942, gfx950, gfx1100, gfx1101,
   *       gfx1150, gfx1151, gfx1170, gfx1171}（或 ROCm≥7 且 gfx1200/1201）
   *   —— **没有任何一条与 MPS 相关** ⇒ Mac 上它**恒为 False**
   *   ⇒ `comfy/ldm/modules/attention.py` 落到 `optimized_attention = attention_sub_quad`
   *     （日志原文 "Using sub quadratic optimization for attention, ..."）。
   *
   *   也就是说：**Mac 上默认根本没走 Metal 的融合 SDPA 内核**，走的是那个
   *   给 CPU / 低显存场景准备的次二次通用实现。
   *   ⇒ `--use-pytorch-cross-attention` 在 Mac 上**不是多余的显式声明**，
   *     而是**真正把它切到 PyTorch SDPA（MPS 上即 Metal 融合内核）**的开关。
   *     这正是"苹果端完全没有优化"的根因所在。
   *
   * ## 另一件 Mac 专属的事：`PYTORCH_ENABLE_MPS_FALLBACK`
   *   PyTorch 官方 MPS 环境变量（见官方 "MPS Environment Variables" 文档）。
   *   MPS 后端**未实现**的算子会自动回退到 CPU 执行，而不是直接抛错。
   *   默认 **开**：它只影响"本来就会失败"的路径，对已支持的算子**不改变任何数值结果**，
   *   属纯健壮性兜底（没有它时，链路里碰到一个未实现的算子整次出图就崩了）。
   *
   * ## ⚠ 几件**明确不加**的东西（都是查过源码/文档才敢不写的）
   *   · `--force-fp16` —— `should_use_fp16()` 对 MPS 直接 `return True`，
   *     Mac 上本来就是 fp16，加了等于没加。
   *   · `--force-non-blocking` —— `device_supports_non_blocking()` 对 MPS 恒 False
   *     （源码注释原文 "pytorch bug? mps doesn't support non blocking"）。
   *   · `--highvram` / `--lowvram` / `--novram` / `--reserve-vram` —— ComfyUI 里
   *     `if cpu_state == CPUState.MPS: vram_state = VRAMState.SHARED`，
   *     驻留档位在 MPS 上**根本不参与**；插件也已显式跳过（见 VRAM_ARGS 的 IS_MAC 分支）。
   *   · `--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention`
   *     —— 都是 CUDA / ROCm 专属内核，MPS 上不存在。
   *
   * ## ⚠ 诚实边界
   *   本机（Windows + ROCm）**没有 Mac 硬件** ⇒ 上面这条参数**没在真机实测过**。
   *   它的依据是 ComfyUI 与 PyTorch 的源码/官方文档（可复核），不是猜的；
   *   但"能跑多快"我给不出数字。想回到"一个参数都不加"：
   *   把 `comfyAttentionBackend` 设为 `default`。
   */
```

### config-note-002（原 lib/config.js L1650-1702）

```js
 * 组装千问工作流。
 *
 * · 不给 `reference` → **文生图**（照 app.py build_workflow 的无参考图分支）
 * · 给了 `reference` → **图生图**（照 `scripts/_img2img.mjs`，那份在本机验证过）
 *
 * ★ 图生图有四个要点，一个都不能少：
 *   ① 加一个 `LoadImage` 节点读参考图
 *   ② `TextEncodeQwenImage21` **必须拿到 `vae`** —— 不给 vae 它就不会编码参考图
 *   ③ 参考图走 `images.image_1`（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的**第 2 号输出**（positive=0 / negative=1 / latent=2），
 *      并且**删掉 `EmptyLatentImage`** —— 所以图生图的 `resolution` 要用 sqrt(W*H)，
 *      它**直接决定输出尺寸**（文生图那边则由 EmptyLatentImage 决定，所以用固定值即可）
 *
 * ★★★ 2026-10-08 重大改动：**Turbo8 八步 + TE-Speed 变成默认链路**。
 *   （需求原文：「你把这个改成默认设置吧。开到最大。就是 turbo8 加 TE 八步」）
 *
 *   模型链（1 → 11 → 12 → 7 → 13 → KSampler）：
 *
 *     UNETLoader ──► LoraLoaderModelOnly(turbo8, 1.0)     ← 八步蒸馏 LoRA
 *                ──► ModelSamplingFlux(0.6935, 0.5)       ← turbo8 官方要求的采样位移
 *                ──► QwenImage21Cache(auto, int8)         ← 官方前缀 KV 缓存（int8 折半，几乎无损）
 *                ──► TESpeedQwenImage21(...)              ← 跳步缓存
 *                ──► KSampler(steps=8, cfg=1.0, euler, simple)
 *
 *   本机实测（RX 7900 XT / ComfyUI 0.39.0，都是 1024 档、每遍换 seed 的稳态值）：
 *     基线 30 步 CFG2.5            ── 91.6 s   （原默认）
 *     turbo8 八步（无缓存）        ── 12.6 s   （−86%）
 *     turbo8 八步 + TE-Speed       ──  9.7 s   （**−89%**）  ← 现在的默认
 *
 *   ⚠ 关于「TE 在这一档里到底做了多少」——查证过，别被老数字误导：
 *     · TE 的**整层跳过**（日志里的 `eligible`）在 8 步下是 **0 次**：8 步的 t 序列是
 *       1.000/0.933/0.857/0.769/0.667/0.546/0.400/0.222，而节点内置窗口硬性要求
 *       t<=0.82，前 3 步直接出局；剩下 5 步的 change 又都 > 0.06 阈值。
 *     · 但它**仍然有效**：每次 call 都会复用一部分 KV/attention（算子级省时），
 *       实测稳态 12.6 s → 9.7 s，**−23%**。
 *     · 早先报过的「−43%」是**测量失真**（撞上了 ComfyUI 对相同 prompt 的直接缓存）。
 *       ★ 教训：任何"快了多少"的对比，**每遍都必须换 seed**。
 *
 *   为什么是 8 步而不是 16 步：turbo8 就是**为 8 步训练的**（发布页写明 8 步 / CFG 1 /
 *   euler + simple）；16 步只会更慢而不会更准。
 *
 *   ⚠ 三条硬约束，别随手改掉：
 *     ① `ModelSamplingFlux` 的 width/height 必须是**字面量**。图生图那一支没有
 *        `EmptyLatentImage`（latent 从 TextEncode 的第 2 号输出拿），一旦写成节点连线，
 *        图生图会**直接引用到不存在的节点**。所以这里固定传 `width`/`height` 数字。
 *     ② `ModelSamplingFlux` 的宽度默认 **1024**，而 ModelSamplingFlux 的 max_shift 是按
 *        像素面积算的 —— 尺寸一变位移量就跟着变（实测 992² 与 1024² 出图不同）。
 *        要换默认尺寸，请把 `DEFAULTS.turbo8RefWidth/Height` 一起改。
 *     ③ `TESpeedQwenImage21` 是**插件节点**，装不上时 ComfyUI 会以
 *        "node type not found" 当场拒收整个任务（不会静默降级）。
 *
 * @param reference ComfyUI 里的参考图文件名（已经上传过去的）；空 = 文生图
 */
```


### describe-note-001（原 lib/describe.js L227-262）

```js
  // ── 逐项列出"打算用什么"以及"能不能用" ──────────────────────────────
  //
  // ★★★ 2026-10-09 升级（需求方要求）：**从二元「已启用/未启用」升级为四态**。
  //
  //   需求原文：「你启用优化就应该是启用了哪些优化，这个也肯定要用区分啊
  //     你点进去就应该是告诉你启用了哪些优化，哪些可以启用哪些没启用，哪些不能启用」。
  //
  //   为什么必须分：原来的 whyOff 一句话里其实混着**三种完全不同的处境**，
  //   用户看完不知道该干什么 ——
  //     · 「没装 TE-Speed 节点」→ 装上就能快，**值得动手**；
  //     · 「被配置关了」        → 改一行配置就能快，**最容易修**；
  //     · 「依赖 turbo8 未生效」→ 上游没通，**现在做什么都没用**。
  //   三者显示成同一句灰字，等于把"能做的"和"做不了的"糊在一起，
  //   用户要么白折腾、要么以为插件坏了。
  //
  //   四态定义（`state` 字段，UI 直接照它上色，不再从文案里猜）：
  //     'on'        已启用 —— 正在生效
  //     'available' 可启用 —— 缺外部组件，装了就能生效（给出确切安装目标）
  //     'off'       可启用 —— 被配置关了，改配置即生效（给出确切配置键）
  //     'blocked'   不可启用 —— 依赖不满足 / 平台不支持，当前做什么都没用
  //     'superseded'  被取代 —— 与另一项结构互斥而主动让位（不是故障，也不需修）
  //
  //   `action` 是"该做什么"的一句话 —— 没有可做之事时给空串（UI 不显示那一行）。
  //   `whyOff` 保留：外部（含既有测试）可能还在读它。
  //
  // ★★★ 2026-10-09 新增 `toggle` 字段：**让用户自己开关**。
  //   需求原文：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
  //     TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
  //     请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
  //
  //   有 `toggle` 的项，前端会在那一行渲染一个可点的开关按钮。
  //   形状：{ key, on, canToggle, hint }
  //     · key       —— 开关标识，前端原样回传给 `?<key>=on|off`
  //     · on        —— 当前是开还是关（决定按钮外观）
  //     · canToggle —— false 时按钮置灰（缺节点等，切了也没用）
  //     · hint      —— 鼠标悬停/按钮下方的一句说明
```


### describe-note-002（原 lib/describe.js L1200-1215）

```js
  // ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（下拉；选项 = **实际探测到的文件**）。
  //
  // ## 为什么单独一栏（与 tiers 同源的理由）
  //   它也是"配置选择"而不是"优化点开关" ⇒ 不进 detail / stats，避免搅浑总账。
  //
  // ## ⚠⚠ 为什么这一栏**不含任何文件名**（关键设计）
  //   状态端点（`/api/qwen-paint/status.json`）有一条**既有底线**：
  //   **状态体不得出现本地路径 / 模型名**（回归里有断言钉死）。
  //   而权重下拉天然需要文件名 —— 两者冲突。
  //   ⇒ 解法：**状态体只给"这里有一个动态下拉"的描述**（name/key/hint/来源），
  //     真正的**选项与当前值由客户端另调 `/api/qwen-paint/capabilities` 取**（那个端点本就返回 caps）。
  //     这样底线不破，功能也有。
  //
  // ## ⚠ 另一个诚实点
  //   选项**只能来自 ComfyUI 真实存在的文件** —— 不给"手填文件名"的口子，
  //   也就**没有路径注入**的可能；服务端还会再校验一次（端点那边）。
```


### describe-note-003（原 lib/describe.js L1096-1108）

```js
  // ★★★ 2026-10-09 新增：**显存驻留**才是整条工作流 90 秒 → 30~40 秒的真正解药。
  //   加速节点只省"采样那 8 步"（8~11 秒）；而整条工作流实测 90~150 秒，
  //   差额几乎全在**模型反复装卸**上（UNET 6.9 + CLIP 6.0 + VAE 0.64 ≈ 13.5 GB
  //   装不进当时可用的 12.09 GB）。所以这一项必须**显式列出来**，
  //   否则用户会以为"优化打了跟没打一样"——正是用户上次的原话。
  //   它由启动参数决定，不在工作流里，所以单独描述。
  //   ★★★ 2026-10-12：**macOS 上不列这一项**。
  //     依据（ComfyUI 源码）：MPS 上 `vram_state` 被强制成 `SHARED`，
  //     驻留档位**根本不参与**（详见 VRAM_ARGS 的 IS_MAC 分支）。
  //     而 `plan.residency` 是按**离散显存**算的 ⇒ Mac 上必然 `applicable: false`
  //     ⇒ 状态是 `blocked`（"不可启用"）⇒ 把一台完全正常的 Mac 报成"优化部分启用"。
  //     所以改成**放进"已隐藏"清单并写明原因**：不静默消失（用户知道为什么没这一项），
  //     也不误报成缺件。
```


### describe-note-004（原 lib/describe.js L406-414）

```js
  // ── 一切正常 ─────────────────────────────────────────────────────────
  // ★ 各项**全都要算进来**：早先这里只看了 turbo8 + 前缀缓存，于是"没装 TE-Speed"
  //   这种确实少了一层优化的情况，照样报"优化已启用"—— 报告等于骗人。
  //
  //   2026-10-09：改成按「**未解决**项」判定。三种"没生效"要分开看：
  //     · blocked / off / available → 真的没生效，**算未解决** → 不能报 full
  //     · superseded（被取代）      → 是主动让位，**不算未解决** → 不拉低 level
  //   原先用 `plan.useTe` 直接判定是错的 —— 让位后它必然是 false，
  //   会把一条完全健康的链路误报成"部分启用"。
```


### describe-note-005（原 lib/describe.js L194-208）

```js
  // ★★★ 2026-10-11 新增：**按显卡厂商过滤掉不适用的优化项**。
  //
  //   需求原文：「优化菜单没有动态过滤或者置灰啊。怎么 5060 还能弹出来 AMD R3 的优化呢？
  //     应该识别一下呀，识别是哪个显卡，就把不能用的优化直接隐藏掉。」
  //
  //   根因：`RDNA3 FlashAttention` 那一项原先**只看"节点装没装"、完全不看显卡** ——
  //     在 N 卡（如 RTX 5060）上会显示成「可启用：把 RDNA3-Flash-Attention 装进 custom_nodes」，
  //     而那个节点是 gfx1100（AMD RDNA3）专用的，装了也跑不了 ⇒ 纯误导。
  //
  //   约定（与"caps 缺省 = 能力齐全"一致）：**认不出显卡就不隐藏**。
  //     只有明确认到厂商、且该厂商不是这项要求的厂商时，才把它藏掉。
  //     —— 宁可多显示一项，也不能因为探测不到就把用户真能用的优化藏了。
  //
  //   `caps.gpu.name` 来自 ComfyUI `/system_stats` 的 `devices[0].name`
  //   （**实际用来算图的那张卡**，比 WMI 枚举更准）。拿不到时是空串。
```


### describe-note-006（原 lib/describe.js L154-161）

```js
  // ── ComfyUI 没在运行 ─────────────────────────────────────────────────
  // ★★★ 2026-10-09 修正（用户反馈「为什么我本机都显示优化状态未知啊，这个判断也太傻了吧」）：
  //   原先这里报的是「未检测到 ComfyUI，优化状态未知」。
  //   但"未知"是错的说法 —— 我们**很清楚**发生了什么：优化链本来就跑在 ComfyUI 里，
  //   它没启动，当然无从谈优化。这不是"不知道"，而是"还没轮到检测"。
  //   更关键的是：**插件自己就有能力把 ComfyUI 拉起来**（出图时 ensureComfyUp，
  //   启动时还会预热），所以对用户来说这就是一个"待会儿自然就绪"的正常状态，
  //   完全不需要他做任何事，更不该让他以为哪里坏了。
```
