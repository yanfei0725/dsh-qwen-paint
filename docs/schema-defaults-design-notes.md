# lib/schema-defaults.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### schema-defaults-note-001（原 lib/schema-defaults.js L1-10）

```js
/**
 * dsh-qwen-paint —— 参数 schema、默认值与生图意图提示词（2026-11-10 从 lib/config.js 拆出，P0a 腾门禁）。
 *
 * 只放纯数据（不依赖 GPU 探测 / ComfyUI 客户端）：
 *   DEFAULTS / PARAMETERS / OUTPUT_SCHEMA / DRAW_INTENT_MODES / NO_SELF_DRAW_RULE /
 *   buildDrawIntentPrompt / INLINE_IMAGE_PROMPT / defaultOutputBase / defaultOutputDir
 *   TURBO8_STEPS / DEFAULT_TURBO8_LORA / BASE_STEPS / BASE_CFG
 *
 * 行为完全不变：config.js re-export 这些名字，所有 import 方（index.js / describe.js）不用改。
 */
```

### schema-defaults-note-002（原 lib/schema-defaults.js L53-69）

```js
  /**
   * ★ 2026-11-12：联网「参考图检索」端点（可选，默认 = 占位符 ⇒ 不可出站）。
   *
   * 与上面的 allowRemoteComfy 是**两回事**：那个管的是「提示词 / 图片 → ComfyUI」，
   * 这个管的是「查询词 → 用户自己配的外部 https 检索端点」，两者不互相放行。
   *
   * 默认 '<API_ENDPOINT>' 是**占位符**，lib/reference-web.js 的同意门会直接判
   * ENDPOINT_REQUIRED —— 所以装好插件后依旧纯离线，不会偷偷联网。
   * 想启用必须同时满足：
   *   ① 自己把它换成合法的外部 https 地址（回环 / 内网 / 云元数据一律拒绝）；
   *   ② **每次检索**都由调用方显式传 consent: true（面板上就是每点一次按钮）。
   * 出站载荷由白名单重新构造，只有 query / limit / media，不含提示词、seed、
   * 本机路径或凭据；只返回候选 URL，插件不下载远程字节，由用户选定后走本地上传。
   *
   * ⚠ 字面量必须与 lib/reference-web.js 的 WEB_ENDPOINT_PLACEHOLDER 一致，
   *   由 scripts/test-reference-config.mjs 锁住，防止两处漂移。
   */
```

### schema-defaults-note-003（原 lib/schema-defaults.js L76-93）

```js
  /**
   * ★★★ 2026-10-09：**生图意图判定策略** —— 这是本轮"联动性"改造的核心。
   *
   * 背景：原来只靠一段很长的 systemPrompt 让模型"自己领悟"用户想不想画图。
   * 问题有两个：① 模型可能仍判断不准（该画时没画、不该画时去画）；
   * ② 用户说"帮我画个流程图"这类**指的不是本工具**时，会被误判成生图请求。
   *
   * 四档（由紧到松）：
   *   `'off'`    不做任何生图意图引导 —— 只在用户**明确点名**要画图时才会用到。
   *              适合"只想要个安静工具"的人。
   *   `'strict'` 只在用户**明确表达**要生成图片时才画（「画一张…」「生成图片」等），
   *              且要求**画面描述具体**；模糊的一律**先问一句**再画。
   *              适合怕误触发的人。
   *   `'auto'`（默认）**判断是生图请求就画**；但若请求**明显不属于本工具**
   *              （如"画个流程图/思维导图/表格"这类通常要文字或其它工具的场景），
   *              先澄清一句再决定。平衡"响应快"与"不误画"。
   *   `'eager'`  只要沾边就画（最积极）。适合确定自己只用它画图的人。
   */
```

### schema-defaults-note-004（原 lib/schema-defaults.js L96-100）

```js
  /** 成品落盘目录（工作区约定：一律放「千问1生图」）。 */
  // ★★ 2026-10-07：出图目录**不再硬编码**。原来写死 C:\Users\<你的用户名>\Desktop\千问1生图，
  //    有两个问题：① 泄露 Windows 用户名（发出去的包里带着它）；
  //    ② **别人装上后用不了** —— 那个目录在他们机器上不存在，出图会写失败。
  //    改成按当前用户的桌面推算，profile 里显式配了 outputDir 时仍以配置为准。
```

### schema-defaults-note-005（原 lib/schema-defaults.js L104-110）

```js
  /**
   * ComfyUI 自己的 output 目录。**留空（默认）= 直接走 /view**（推荐、通用）。
   *
   * ★ 通用化：原默认写死某个绝对路径，那只对作者机器有意义
   *   —— 别人装到别处必然"先白读一次失败、再走 /view"。取图本来就以 `/view` 为准
   *   （见 fetchImageBytes 的说明），本地目录只是老版本 ComfyUI 的兜底，留空即可。
   */
```

### schema-defaults-note-006（原 lib/schema-defaults.js L117-129）

```js
  /* ------------------------------------------------- 加速链（★ 2026-10-08 默认开启） ----
   * ★★★ 默认链路：turbo8 八步 LoRA + 官方 int8 前缀缓存 + TE-Speed 跳步缓存。
   *   本机稳态实测：91.6s（原 30 步基线）→ 9.7s，**快 89%**。
   *   其中 turbo8 是大头（→12.6s），TE-Speed 再省 23%（→9.7s）。
   *   ⚠ 首次出图还要额外 ~12s 加载模型（20 GB），那部分不是这条链的开销。
   *
   *   想完全退回**改动前**的老链路（25 步、无 LoRA、无缓存）：
   *     ① 先把下面 `forceTurbo8Steps` 设为 false、`turbo8Steps` 设为 25；
   *     ② 再把 `turbo8Lora` / `qwenCacheDtype` / `teSpeed*` 一并还原（LoRA 与缓存
   *        两个节点现在是**无条件**接在链子上的，只改步数并不能回到老状态）。
   *   简言之：这组开关是**微调**用的，不是一键开关。
   */
  /** turbo8 八步蒸馏 LoRA 文件名。留空 = 用内置默认 `turbo8_lora_step2500.safetensors`。 */
```

### schema-defaults-note-007（原 lib/schema-defaults.js L137-159）

```js
  /* ---------------------------------------------------------------- 极速档（4 步）---- */
  /**
   * ★★★ 2026-10-12（用户要求）：**极速档（4 步）** —— 默认关。
   *
   * 开启后整条链换成「4 步蒸馏」的工作点：步数 4 + 4 步 LoRA + 配套采样位移。
   *
   * ## 实测（2026-10-12 真机 A/B，1024²、CFG 1.0、热态）
   *   · 8 步 turbo8：**12.1 s**（热、不切 LoRA）
   *   · 4 步 Lightning：**6.0 ~ 7.5 s**
   *   ⇒ 约 **1.6 ~ 2×** 提速（步数只砍采样段；模型加载/VAE 解码/落盘不受影响）
   *
   * ## ⚠⚠ 代价（必须让用户知道，界面上也写了）
   *   **画面里有文字就会崩。** 实测同一 prompt、同一 seed：
   *   8 步能正确写出「午后」，4 步直接变成乱码。
   *   文字渲染是 Qwen-Image 的招牌能力，4 步蒸馏把它牺牲掉了。
   *   ⇒ 只适合"要快、画面里不需要文字"的场景。
   *
   * ## ⚠ 采样位移必须跟着换
   *   Lightning 官方 README 写明 `shift=3 in distillation`（`base_shift = max_shift = ln3`），
   *   而 turbo8 的工作点是 `ln2 ≈ 0.6935`。**拿 shift=2 跑 shift=3 蒸馏的 LoRA，
   *   画质会明显崩**（糊、五官走形）—— 实测同 seed 对比，换对位移后明显回血。
   *   所以这两个值必须与 LoRA 一起切换，不能只改步数。
   */
```

### schema-defaults-note-008（原 lib/schema-defaults.js L184-193）

```js
  /**
   * ★★ 2026-10-09 通用化新增：**turbo8 整条链的总开关**（默认开）。
   *
   * 与 `teSpeedEnabled` / `speedupEnabled` 的区别：那两个只管各自的节点，
   * 这个管"turbo8 这条链"整体（LoRA + ModelSamplingFlux + 8 步 / CFG 1）。
   * 设 false 会退回千问原生链路（`baseSteps` 步 / `baseCfg` CFG，默认 25 步 / 2.5）。
   *
   * ⚠ 一般**不需要**手动关它 —— 探测不到 turbo8 LoRA 时插件会自动降级（见 probeCapabilities）。
   *   这个开关是留给"我想强制对比原生画质"的场景。
   */
```

### schema-defaults-note-009（原 lib/schema-defaults.js L246-252）

```js
  /**
   * ★★ 2026-10-09 通用化新增：**没有 turbo8 时的回退采样参数**。
   *
   * 别人机器上没装 turbo8 LoRA 时（探测不到 → basic 档），绝不能还按 8 步 / CFG 1 跑
   * —— 那是 LoRA 的工作点，缺 LoRA 会得到一张糊图。此时用这里的两项，
   * 即千问原生工作点：25 步 / CFG 2.5。调用方显式传 steps 时仍以调用方为准。
   */
```

### schema-defaults-note-010（原 lib/schema-defaults.js L261-274）

```js
  /**
   * ★★ 2026-10-09：**自动配置厂商专用加速环境**（默认 true）。
   *
   * `true`  → 插件加载后**自动检测**本机缺哪个厂商专用加速包，缺就**自动下载安装**
   *           （白名单内、且仅当前平台适用的那些，见 `ACCEL_PACKS` / `packAppliesToOs`）。
   *           全过程在后台跑、失败只写日志，**绝不影响出图**。
   * `false` → 只报告不下载，需要时手动调 `check_acceleration(action:'install')`。
   *
   * ★ 发行包体积说明：包里**只带这套"下载器"逻辑，不预置任何已下载的文件** ——
   *   所以必须真的到网上去取。这也是包只有 ~500 KB 的原因（大头是 UI 动画）。
   *
   * ⚠ 会真的改动用户环境（git clone / pip install 第三方代码），
   *   介意的话设为 false 即可 —— 出图功能不受任何影响，只是少了厂商专用加速。
   */
```

### schema-defaults-note-011（原 lib/schema-defaults.js L334-347）

```js
  /**
   * ComfyUI 启动时的**注意力后端**参数。
   *   这是实测唯一有效的启动参数轴（两轮独立复现，RX 7900 XT / ROCm）：
   *     'quad'    → `--use-quad-cross-attention`   10.739s →  9.328s（**+15.1%**）
   *     'pytorch' → `--use-pytorch-cross-attention` 10.739s → 10.766s（−0.3%，无效）
   *     'default' → 不加任何参数                    10.739s
   *   满叠栈（TE + Speedup）上 quad 仍有效：9.709s → 8.278s（+17.3%）。
   *   画质无损（同 seed PSNR 39.5/41.4 dB，清晰度 166.3 vs 基线 164.6）。
   *
   * ★★ 2026-10-09 通用化：默认值由写死的 'quad' 改为 **'auto'** ——
   *   上面那 +15% 是 **AMD / ROCm** 上的结论，N 卡未必有、个别版本还可能直接不支持。
   *   'auto' 会在启动前查一次 GPU 厂商：AMD / Radeon / ATI → quad，其余 → 不加参数。
   *   想固定就显式写 'quad' / 'pytorch' / 'default'。
   */
```

### schema-defaults-note-012（原 lib/schema-defaults.js L363-387）

```js
  /**
   * ★★★ 2026-10-12 新增（来自用户反馈）：**Spectrum 跳步加速**（跳过冗余 Qwen 前向）。
   *
   * ## 2026-10-12 真机实测（_spectrum_ab.mjs，1024² turbo8 链）
   *   | 变体 | 中位耗时 | vs 基线 |
   *   | --- | --- | --- |
   *   | A 基线（不接 Spectrum） | 13.1 s | — |
   *   | B Spectrum 默认（warmup=5 / tail=2） | 18.2 s | **+5.1 s（−27.7%）** |
   *   | C Spectrum 针对 8 步调（warmup=2 / tail=1） | 17.2 s | **+4.1 s（−23.4%）** |
   *   **结论：在 8 步 turbo8 链上，预测器自身开销 > 跳步收益 ⇒ 更慢**。
   *   ⇒ 默认**关**，且**实测数据替代 README 的乐观数字**。
   *   推断：≥ 20 步的原生链可能**会**有收益（可跳步数多）—— 本轮没测；
   *   那边有收益也仍然是**叠加项**，得**先对比**再定默认值。
   *
   * ## 默认关的其他理由
   *   ① 节点作者自述 *"not a paper-exact universal Qwen port"*、**不保证通用兼容**，且
   *      *"does not score image quality for you"* —— **它不替你评估画质**（本次 1024² 对比
   *      肉眼没差，但更大尺寸 / 更复杂 prompt 未必）。
   *   ② 它的默认 `warmup_steps=5` + `tail_actual_steps=2` 是给**常规步数**调的；turbo8 的 8 步
   *      链被吃掉 7 步，**只剩 1 步可跳**，预测器开销反而成了主要成本 —— 上面的数字就是证据。
   *   ③ 与 TE-Speed / Speedup / BlockCache **叠加**后的画质影响，本项目**没有实测数据**。
   *
   * ⇒ 打开方式：把 `spectrumEnabled` 设为 true（或点面板开关）。想更激进可以调小
   *   `spectrumWarmupSteps` / `spectrumTailActualSteps` —— ⚠ 越激进画质风险越高。
   */
```

### schema-defaults-note-013（原 lib/schema-defaults.js L402-419）

```js
  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文
   *   "Stochastic Adversarial Diffusion Acceleration"，arXiv 2507.17135）。
   *
   * 思路与 Spectrum 同源（跳过冗余 Qwen transformer 前向），但**走的是新的采样分布**
   * 而非仅靠历史外推；ComfyUI 实现见 `liming123332/comfyui-sada-icml`。
   *
   * ⚠ 必须如实告知的边界（与 Spectrum 同）：
   *   ① 本插件**没有自动下载**该节点 —— 装不装由用户决定（GDPR/版权/审慎）。
   *      缺件时回落到基础链路（实测已有 9 倍提速，叠加收益需自行 A/B）。
   *   ② 节点作者没给出 Qwen-Image 2.1 的画质保证 —— **必须先单张对比**。
   *   ③ 论文的 "1.2–2.0×" 是基准对比，**不是**本项目的工作点；本链只有 8 步
   *      （turbo8）/ 4 步（Lightning），实际可跳步数被 SADA 的 warmup/tail 吃掉后
   *      未必有正收益，**实测是唯一依据**。
   *
   * ⇒ **默认关**；开 = `sadaEnabled: true`（或点面板开关）。
   *   改完要**重启 ComfyUI**让它重新加载节点图。
   */
```

### schema-defaults-note-014（原 lib/schema-defaults.js L444-457）

```js
  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**OOM 自动回退**。
   *
   * 出图撞 OOM（"out of memory" / "OutOfMemoryError" / "CUDA OOM" /
   * "hip out of memory" / "MPS OOM" 任一）时，**自动**重跑一次：
   *   ① 强制 `vaeTiling='on'`（ComfyUI 自带 VAEDecodeTiled，零新增依赖）；
   *   ② 不动 turbo8 / 其它加速链（先让代价最小的开关上场）。
   * 如果还 OOM，把错误如实抛出（**绝不静默吞**）—— 让用户知道真的出问题了。
   *
   * 收益：本机 16GB 显存实测 1408² 撞过 OOM，开启后第二次就出了图。
   *
   * ⇒ **默认开**（OOM 是没商量余地的硬约束，回退比失败好）。
   *   关 = `oomAutoFallback: false`（不推荐；只在你明确知道在做什么时关）。
   */
```

### schema-defaults-note-015（原 lib/schema-defaults.js L460-479）

```js
  /**
   * ★★★ 2026-10-13（用户反馈）：**串行抽卡（排队模式）**。
   *
   * ## 为什么要这个
   *   `count > 1` 原来走 `EmptyLatentImage.batch_size = N` —— 那是**真并发**：
   *   N 份 latent **同时**占显存。8 GB 卡上这就是 OOM 直通车。
   *   串行模式改成「提交 1 张 → 等结果 → 落盘 → 再提交下一张」，
   *   显存里**始终只有一份 latent**。
   *
   * ## ⚠⚠ 必须澄清的一点（别照字面理解"释放显存"）
   *   用户原话是"释放显存后自动生成下一张"，但**真把主模型卸掉是错的**：
   *   下一张就得重新加载 ~13.5 GB 模型（实测冷启动 65 s），那才是灾难。
   *   串行的真正收益是「不同时持有 N 份 latent」，**主模型必须保持常驻**。
   *   ⇒ 所以串行**只做顺序提交，不做 freeComfyModels**。
   *
   * ## 三档
   *   `'auto'`（默认）—— 显存 < 16 GB 才串行（与 `vaeTiling` 的显存闸同源，判据一致）；
   *   `'on'`          —— 总是串行（晚上挂机抽卡用这个）；
   *   `'off'`         —— 走原来的并发批（大显存下更快，省 (N-1) 次排队往返）。
   */
```

### schema-defaults-note-016（原 lib/schema-defaults.js L487-502）

```js
  /**
   * ★ 2026-10-09 实测新增：prompt 精简。
   *
   *   先给实测上限（RX 7900 XT / 1024²，同一条 TE + Speedup + quad 栈，只变 prompt）：
   *       38 字  → 7.821 s
   *      329 字  → 8.088 s
   *     1974 字  → 8.194 s
   *   即：prompt 从 38 字加到 1974 字（52 倍）也只多花 0.373 s（**+4.8%**）。
   *   ⇒ 文本 token **没有被填充到固定长度**（否则长短 prompt 会一样快），
   *     但同时也说明「精简 prompt」的收益天花板就是 ~5%，
   *     而且**只有写超长 prompt 时才摸得到**，日常 prompt 几乎为 0。
   *
   *   所以这里默认只做**无损清理**（折叠空白、合并重复标点），语义不变；
   *   `maxPromptChars` 硬截断默认 **0 = 关闭**，因为它会改变出图，
   *   而换来的最多也就是那 4.8%。
   */
```

### schema-defaults-note-017（原 lib/schema-defaults.js L507-524）

```js
  /**
   * ★★★ 2026-10-09 **实测新增：BlockCache T8**（取代了失败的 ToMe）。
   *
   * ## 实测（图生图，RX 7900 XT / ROCm，2 个 seed 取平均，只在链上加这一个节点）
   *     基线              120.75 s
   *     +BlockCache T8     93.34 s   →  **+22.7%**（省 27.4 s）
   *
   * ## 为什么它能成、ToMe 不能
   *   ToMe 在千问 2.1 上因接口不兼容三条路全断（详见 resolvePlan 里 ToMe 的移除说明）。
   *   而 BlockCache T8 官方描述明确写着：
   *     · "preserving Core's reference/text KV cache" → **原生兼容前缀缓存**
   *     · "For editing, start with threshold 0.03"   → 图生图推荐起点就是保守值
   *   下面这些默认值**就是官方对 editing 的推荐值**，我没有自己调激进口径。
   *
   * ⚠ `blockCacheThreshold` 是唯一的"速度 ↔ 保真"旋钮：
   *   调大 → 跳得更多、更快，但官方原话是 "may change pose and details"（可能改姿态和细节）。
   *   想更稳可调到 0.02；想更快可试 0.05 —— 但**请自己看效果再定**。
   */
```

### schema-defaults-note-018（原 lib/schema-defaults.js L527-555）

```js
  /**
   * ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按尺寸自动选**（取代"一刀切"）。
   *
   * ## 为什么必须改（这是实测打脸，不是推测）
   *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
   *   **只能上一组**。上一轮我按"TE+Speedup 8.639 s < BlockCache 9.712 s"
   *   把 BlockCache 关了（blockCacheEnabled=false）。
   *
   *   但那个对比是**小尺寸 + 模型已驻留**的理想条件下测的。
   *   在 1408×1408 的真实场景里，ComfyUI 日志白纸黑字：
   *       Qwen TE predictor: predicted 0/8 steps (**0.0%** model-call acceleration)
   *       QwenImage21Speedup: 1 cached of 8 model forwards (**12.5%** skipped)
   *   ⇒ **TE 一步都没命中、Speedup 只跳 1 步，却独占着 wrapper 坑。**
   *
   *   而 BlockCache T8 的实测是**大尺寸**（基线 120.75 s）下 **+22.7%（省 27.4 s）**，
   *   且官方描述 "preserving Core's reference/text KV cache" ⇒ **原生兼容前缀缓存**，
   *   能跟 turbo8 + 前缀 KV 缓存**叠着用**。
   *
   * ## 所以：按出图尺寸自动选
   *   · 小尺寸（latent tokens ≤ 阈值）→ TE-Speed + Speedup（小尺寸实测 +25.4%）
   *   · 大尺寸（latent tokens >  阈值）→ BlockCache T8（大尺寸实测 +22.7%）
   *
   *   ⇒ 两边都拿到各自场景里**实测更好**的那一套，而不是拿一套去硬扛所有尺寸。
   *
   * ## 取值
   *   'auto'  按尺寸自动（默认）
   *   'te'    始终 TE-Speed + Speedup（不管尺寸）
   *   'bc'    始终 BlockCache T8（不管尺寸）
   */
```

### schema-defaults-note-019（原 lib/schema-defaults.js L566-589）

```js
  /**
   * ★★★★ 2026-10-10 新增：**RDNA3 FlashAttention**（无损提速）。
   *
   * ## 为什么它是"无损"
   *   它是**精确注意力**（memory-efficient 的等价实现），不改数学 ⇒ 不改成品。
   *   节点自带 `safely falls back for unsupported calls`：形状/精度不满足就回退到
   *   原生注意力，**不会算错**。
   *
   * ## 为什么值得开（本机实测证据）
   *   启动日志里注意力走的是 ComfyUI 自带的
   *   `Using sub quadratic optimization for attention`（quad 路径，实测 +15%）；
   *   而 `custom_nodes/RDNA3-Flash-Attention` **已经装了却没用**（日志里加载了 0.3 s）。
   *   它的 `_validation.py` 明确只支持 **gfx1100**（本机 RX 7900 XT 正是 gfx1100），
   *   需要 ROCm PyTorch ≥ 2.8（本机 2.9.1+rocm7.2.1）⇒ **平台完全匹配**。
   *   1408² 时注意力是采样的大头 ⇒ 接上它有望明显缩短那 45 s。
   *
   * ## 接线位置
   *   放在**模型链最末端**（KSampler 之前）—— 它 patch 的是
   *   `model_options.transformer_options.optimized_attention_override`，
   *   必须让**采样器拿到的那个 model** 带上它，所以放最后最稳。
   *
   * ⚠ 节点没装时自动跳过（能力门控），不影响出图。
   * ⚠ 想关掉：把本项设成 false（或删掉那一行）。
   */
```

### schema-defaults-note-020（原 lib/schema-defaults.js L601-620）

```js
  /**
   * ★★★ 2026-10-13（任务 #62②「SageAttention 收尾」）：**性能 / 兼容模式**的中文命名。
   *
   * ## 两档是什么
   *   · `'performance'`（默认，**性能模式**）—— 标准 INT8 量化注意力内核，
   *     走 ComfyUI 的 `--use-sage-attention` 全局开关，速度最快。
   *   · `'compatibility'`（**兼容模式**）—— 同样的全局开关，但**始终开启崩溃自动回退**：
   *     一旦启用后 ComfyUI 启动失败、且日志指向 sage-attention（例如 Blackwell / sm_120
   *     装了不匹配的构建、或 sageattention 没装却被强制开启），插件会**在本会话内自动关掉**
   *     `nvidiaSageAttention`，避免反复崩溃把后端彻底拉不起来。
   *
   * ## ⚠ 必须如实说明的边界
   *   ComfyUI 的 `--use-sage-attention` 是**全局开关、没有官方子模式参数**，
   *   所以本插件**没有**、也**没有编造**一个"模式"命令行参数 —— 这两档的区别只在
   *   **崩溃兜底策略**，不在命令行。性能模式假设构建正确、崩了就照常报错；
   *   兼容模式则把"崩了就自动禁用"当成默认行为，对 Blackwell 这类容易踩构建坑的卡更友好。
   *
   * ⚠ 本机是 AMD RX 7900 XT，**SageAttention 整条路径无法在本地实测**，
   *   以下结论仅来自官方文档与社区报告，未在本机验证过。
   */
```

### schema-defaults-note-021（原 lib/schema-defaults.js L656-670）

```js
  /**
   * ★★★ 2026-10-14（C2「专业卡版」）：**模型精度档**（面板可选）。
   *
   * ## 五档
   *   · `'auto'`（默认）—— 按探测到的模型文件自动挑（老行为）。
   *   · `'bf16'` —— **全精度 BF16**（专业卡 24 GB+；最高画质）。
   *   · `'fp8'`  —— **FP8**（12 GB+；画质接近 BF16，显存省一半）。
   *   · `'int8'` —— int8 safetensors（当前默认档）。
   *   · `'gguf'` —— GGUF Q4/Q5（低显存）。
   *
   * ⚠ **本机（AMD RX 7900 XT 20 GB）无法实测 BF16 / FP8** —— 相关档位是按
   *   官方发布格式与显存需求写的，**真机效果需你在 24 GB+ 卡上验**。
   * ⚠ 选了某个档但**模型文件不在**时，插件**如实报缺失**、并**回落**到可用档，
   *   绝不假装已经用上了（详见 `pickBestModel`）。
   */
```

### schema-defaults-note-022（原 lib/schema-defaults.js L673-683）

```js
  /**
   * ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（面板下拉，运行时切换）。
   *   · `mainModelOverride`       —— 主模型文件名（空 = 用自动挑的那个）
   *   · `loraOverride`       —— 额外 LoRA 文件名（空 = 不加）
   *   · `controlnetOverride` —— ControlNet 权重文件名（空 = 不用）
   *
   * ⚠ **取值必须确实存在于 ComfyUI 的模型清单里** —— 服务端会校验（白名单 = 实时探测到的文件列表），
   *   不在清单里的一律**拒绝**（否则手拼一个 URL 就能把任意路径塞进工作流）。
   * ⚠ 这些是**工作流参数**，**下次出图**即生效（不用重启 ComfyUI）。
   * ⚠ 主模型覆写**优先于**精度档（用户显式选的就该赢）。
   */
```

### schema-defaults-note-023（原 lib/schema-defaults.js L688-693）

```js
  /**
   * ★★★ 2026-10-14（C4「专业卡版」）：**通用 ControlNet** 的强度与生效区间。
   *   ⚠ 只有在「选中了 ControlNet 权重」**且**「本次传了控制图」**且**「两个节点都在」时才会接进工作流；
   *     否则**不接**，并在工具返回值里如实说明原因（不静默）。
   *   ⚠ 本机未实测（AMD 20 GB）—— 真机效果请自行验证。
   */
```

### schema-defaults-note-024（原 lib/schema-defaults.js L698-702）

```js
  // ★★ 0.18：600000（10 分钟）。
  //   旧值 300000 基于"模型已在页缓存"的假设；0.18 实测官方 Turbo 冷启动
  //   （从磁盘装载约 13–14 GB 权重 + 首次编译）单张就要 317 秒，旧上限会把
  //   一次成功的首图误判成超时。10 分钟只影响真正卡死的报错延迟，不影响正常出图。
  //   仍嫌久可在 cordis.patch.yml 调小。
```

### schema-defaults-note-025（原 lib/schema-defaults.js L724-729）

```js
  /** ★★★ 2026-10-19（用户要求）：抽卡「挑图」的两个开关 —— **都由用户自己决定是否启用**。
   *   · `aiPickBest`   = `'on'`：一次出多张时，AI 用 `read_image` 逐张查看，
   *     挑最好的一张推荐给用户并说明理由，其余一并列出；并**记住用户偏好**，下次按偏好挑。
   *   · `userPickBest` = `'on'`：面板把多张并排显示，让用户自己点选"哪张最好"（点开放大）。
   *   两者可以同时开（AI 先推荐，用户仍可自己点）。**默认都关 = 与升级前行为完全一致。**
   *   界面上的选择会**落盘**（见 uiStatePath），重启也记得住。 */
```

### schema-defaults-note-026（原 lib/schema-defaults.js L733-740）

```js
  /* ------------------------------------------------- CPU 加速档（★ 2026-11-13 新增） ---- */
  // 按 **CPU 指令集**选「怎么跑」，与按显卡厂商选内核的 GPU_PROFILES 是两个维度：
  // 同一张卡可以今天用 GPU 出图、明天强制纯 CPU，档位互不覆盖。
  //
  // ★ **默认 `off` = 一个启动参数、一个环境变量都不加**，行为与升级前完全一致。
  //   五档语义、每档真实加什么参数、哪些是"加速"哪些只是"省开销"，
  //   全部写在 `lib/cpu-profile.js` 的 `CPU_ACCEL_MODE_INFO`（那边是唯一实现，
  //   这里只放默认值 —— 免得两处各写一份、迟早对不上）。
```

### schema-defaults-note-027（原 lib/schema-defaults.js L768-784）

```js
/**
 * ★★★ 生图意图判定 —— 把原先「一整段写死的长提示词」改为**按策略生成**。
 *
 * ## 为什么要改
 * 原来那段提示词是"越狠越好"地堆出来的（当天改过十七次），结果是：
 *   · 它对**所有**用户都一套话术，用户无法表达"我不想要这么激进的自动画图"；
 *   · 它只教模型"判断是生图就赶紧画"，却**没教它排除**"画个流程图/思维导图"这类
 *     看着像生图、实际不该用本工具的场景 —— 这才是最容易出错的边界；
 *   · 同一段话术在文件里抄了三份，改一次要改三处。
 *
 * ## 现在
 * 按 `cfg.drawTrigger` 四档生成，**核心事实（属于哪个档）只写一遍**，
 * 各档在此基础上增减。四档的定义见 DEFAULTS 里 `drawTrigger` 的注释。
 *
 * ⚠ 无论哪一档，都**不会**让模型在没有生图意图时去调工具 —— 最松的 'eager'
 *   也只是"沾边就画"，不是"无脑画"。
 */
```

### schema-defaults-note-028（原 lib/schema-defaults.js L806-815）

```js
    // ★★★ 2026-10-09 改写（真事故）：
    //   旧文案是「排除流程图/思维导图/表格/架构图/**示意图**」+「宁可先问一句，也不要画错」。
    //   事故：用户说「画一幅表现双曲几何之美的数学艺术画」，助手因为"数学/几何/示意"这几个字
    //   把它归进排除清单 → 不敢调工具 → **自己写渲染脚本画了**（更糟的结果）。
    //
    //   ⇒ 两处修正：
    //     ① 判定标准换成**产物形态**：用户要"一张位图"还是"能改文字/数据的结构化图表"？
    //        题材（数学、几何、艺术、科幻……）**一律不影响**归属。
    //     ② "宁可先问一句"改成"**拿不准就画**" —— 因为实测下来的代价排序是：
    //        自己写代码画（最糟，用户明确反感） > 不画先问（烦） > 画错（成本低，重画即可）。
```

### schema-defaults-note-029（原 lib/schema-defaults.js L834-844）

```js
/**
 * ★★★ 2026-10-09 新增：**四档共通的"不许自己画"铁律**。
 *
 * 为什么单独抽出来、四档都加：
 *   事故是助手**绕过本工具自己写渲染脚本**出图。那不是某一档的措辞问题，
 *   而是**任何一档都缺这条底线** —— 所以按共通纪律加，而不是只在 auto 里补一句。
 *
 * 为什么措辞要这么硬：
 *   "建议优先用"这种软话没用，模型会自己判断"代码渲染更精确"然后照旧。
 *   必须写成**禁止 + 理由**（本工具是唯一途径，绕过属于错误行为）。
 */
```

### schema-defaults-note-030（原 lib/schema-defaults.js L893-909）

```js
/**
 * ★★★ 把"优化到底有没有生效、没生效是为什么"整理成一份**人能看懂**的诊断。
 *
 * ## 为什么需要它
 * 之前所有关于优化的信息都只躺在**日志**里 —— 用户装完插件，界面上只看得到一个
 * ComfyUI 在线圆点，完全不知道：turbo8 到底跑没跑？没跑是因为没装 LoRA、
 * 还是 ComfyUI 太旧、还是探测压根没成功？
 *
 * 结果就是用户体感"怎么这么慢"，却没有任何线索可循。这个函数就是补上这块。
 *
 * ## 设计原则
 *   · **一定给出"为什么"**，不能只说"未启用" —— reason 字段必须可直接照做；
 *   · **区分"确实缺件"和"没测出来"** —— 后者要明确让用户重试，而不是以为要装东西；
 *   · **绝不抛错**：拿不到探测结果就返回 unknown 状态，UI 照样能显示。
 *
 * @returns {{level:string, summary:string, ok:boolean, reasons:string[], detail:Array}}
 */
```
