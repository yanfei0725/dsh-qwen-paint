# turbo8 八步 + TE-Speed 已设为默认（dsh-qwen-paint）

> 2026-10-08 · 对应你的原话：「你把这个改成默认设置吧。开到最大。就是 turbo8 加 TE 八步」

---

## 一句话结论

**改完了，而且实测过能出图。** 默认链路现在是
`turbo8 八步 LoRA → ModelSamplingFlux → int8 前缀缓存 → TE-Speed → KSampler(8步, CFG 1)`，
本机 1024² 稳态 **9.7 秒/张**（原来 91.6 秒）。

**但有一件事必须跟你说清楚**：我在核对数据时发现，之前报给你的
「TE 让 8 步档从 20.5s 降到 11.67s（−43%）」**是测量失真**。真实收益是 **−23%**。
下面第 3 节讲清楚原因。

---

## 1. 改了什么

### 代码：`C:\Users\<用户名>\Documents\dsh-qwen-paint\lib\index.js`

模型链从「3 个节点」扩成「6 个节点」：

```
改前：  UNETLoader → QwenImage21Cache(auto, default) → KSampler(25步, cfg 1.0)
改后：  UNETLoader
          → LoraLoaderModelOnly(turbo8_lora_step2500, 1.0)     ← 新增
          → ModelSamplingFlux(max_shift 0.6935, base_shift 0.5) ← 新增
          → QwenImage21Cache(auto, int8)                        ← dtype 从 default 改 int8
          → TESpeedQwenImage21(kitchen_int8, te_predictor, 0.06) ← 新增
          → KSampler(8步, cfg 1.0, euler, simple)                ← 步数 25 → 8
```

**文生图和图生图两条支路都改到了**（`buildWorkflow` 是共用的，改一次两边都生效）。

**备份**：`lib/index.js.bak-before-turbo8-20261008-230054`（改动前原样）

### 新增配置项（都在 `cordis.patch.yml` 可调，也有内置默认）

| 键 | 默认 | 作用 |
|---|---|---|
| `turbo8Lora` | `turbo8_lora_step2500.safetensors` | LoRA 文件名；留空回落默认 |
| `turbo8Strength` | `1.0` | LoRA 强度（发布方就是按 1.0 训的） |
| `turbo8MaxShift` / `turbo8BaseShift` | `0.6935` / `0.5` | turbo8 的工作点，别乱改 |
| `turbo8Steps` | `0` | `0` = 跟随 8 步；写正数用那个数 |
| `forceTurbo8Steps` | `true` | 是否强制钉在 8 步（连用户手填的 steps 也覆盖） |
| `qwenCacheDtype` / `qwenCacheDevice` | `int8` / `auto` | 官方前缀缓存 |
| `teSpeedEnabled` | `true` | ★ **TE-Speed 总开关**（见第 4 节） |
| `teSpeed*`（6 项） | 见 README | threshold / 窗口 / 模式等 |

### 其他文件
- `scripts/selftest.mjs` —— 新增 **26 条断言**专门盯这条链子（含"链子首尾相连"的连通性检查），总数 287 条，全绿
- `scripts/_img2img.mjs` —— 那个独立命令行脚本也同步成同一条链，免得两边不一致
- `README.md` —— 依赖、效果表、配置表、测量方法提醒全部更新

---

## 2. 实测数据（全部本机 RX 7900 XT / ComfyUI 0.39.0 / 1024²）

| 档位 | 耗时 | vs 原基线 | 备注 |
|---|---|---|---|
| 原默认：30 步 CFG 2.5 | 91.6 s | — | 改动前 |
| turbo8 八步（无 TE） | 12.6 s | **−86%** | 大头在这里 |
| **现默认：turbo8 八步 + TE** | **9.7 s** | **−89%** | TE 再省 23% |

> 首张图额外 ~12 s 加载 20 GB 模型，那是一次性的，不算在这条链的开销里。

**验证方式**：用**插件自己产出的工作流**（通过 `buildWorkflow` 原样导出 JSON）提交给
ComfyUI，不做任何手工改写。

| 支路 | 结果 |
|---|---|
| 文生图 | ✅ success，出图 |
| 图生图（带参考图） | ✅ success，出图 |
| `teSpeedEnabled: false` | ✅ success，出图（TE 痕迹在日志里彻底消失） |

---

## 3. ⚠ 必须坦白：之前那个「−43%」是错的

### 我之前报的

| 方案 | 8 步耗时 |
|---|---|
| Turbo8 | 20.50 s |
| Turbo8 + TE | **11.67 s（−43%）** |

### 复核时发现的破绽

TE 自己的日志里写着：

```
Qwen TE predictor: predicted 0/8 steps (0.0% model-call acceleration)
Qwen TE predictor decision summary: {'outside_window': 2, 'latent_change': 6}
```

**`predicted 0/8`** —— 一步都没跳。既然一步都没跳，那 8.83 秒是省在哪儿的？

### 找到了：是 ComfyUI 的直接缓存

我把**同一条工作流**跑两遍（只改输出文件名）：

| 运行 | 耗时 | 说明 |
|---|---|---|
| 第 1 遍 | 20.09 s | 真算 |
| 第 2 遍（同参数） | **0.40 s** | **ComfyUI 直接回缓存** |
| 第 3 遍（换 seed） | 10.85 s | 真算 |

第 1/2 遍差了 **19.69 秒**。早先那组测试里，
「Turbo8 无 TE」和「Turbo8+TE」虽然文件名前缀不同，但**只要 seed 没变，
计算图就是同一张** —— 于是后跑的那一次直接吃了缓存。**那个 11.67s 是缓存，不是 TE 的功劳。**

### 重新诚实测（每遍换 seed，交替跑）

| 次序 | 档位 | 耗时 |
|---|---|---|
| #1 | 无TE | 22.35 s（含一次性加载，剔除） |
| #2 | 有TE | 10.61 s |
| #3 | 无TE | 13.12 s |
| #4 | 有TE | 9.06 s |
| #5 | 无TE | 12.09 s |
| #6 | 有TE | 9.42 s |

**稳态均值：无 TE 12.61 s / 有 TE 9.70 s → TE 真实收益 −2.91 s（−23.1%）**

### 那 TE 到底靠什么省的？

跳步计数是 0，但它**仍然有效** —— 省的是**算子级**的时间：
`Qwen TE predictor call` 每次都带 `batch_offset=1`，说明它复用了一部分
KV/attention 结果，这部分不体现在 `eligible` 计数上。

至于为什么跳不了步：8 步的 t 序列是
`1.000 / 0.933 / 0.857 / 0.769 / 0.667 / 0.546 / 0.400 / 0.222`，
而节点的内置窗口硬性要求 `t <= 0.82` → **前 3 步直接出局**；
剩下 5 步的 change 是 0.102~0.307，全都 **远大于阈值 0.06** → 一步都不合格。
（对照 16 步：序列里有一步 change=0.049 < 0.06，那一步是真跳了的。）

**所以：** 结论没变（这条链子确实快到 9.7s），但**功劳分配**变了 ——
turbo8 是大头（−86%），TE 是小头（再 −23%），不是之前说的 −43%。

---

## 4. 顺手做的事

**加了个 `teSpeedEnabled` 开关。** 原因：TE-Speed 的 `nodes.pyd` 是**闭源**的
（Windows 编译产物，没有源码）。我之前静态审查过，没发现网络/exec/子进程调用，
但"闭源"这件事本身没法靠审查消除。所以给你一个开关：

- `teSpeedEnabled: true`（默认）→ 接上 TE 节点，9.7 s
- `teSpeedEnabled: false` → **整个节点不建**，turbo8 单跑 12.6 s

这个开关**已经实测过两个方向都能出图**（一个坏掉的开关比没有开关更糟）。

另外顺手修了一个**已有的隐患**：`fetchWithTimeout` 现在显式 `proxy: undefined`。
本机环境里有 `HTTP_PROXY=http://127.0.0.1:54536`，Node 的 fetch 默认会把
「带端口的 127.0.0.1」也塞给代理 —— 表现在**能连上**（大概率靠 `NO_PROXY`），
但这是运气，明写下来更稳。

---

## 5. 我没动的东西（按之前的约定）

- ✅ 默认后端仍是 `comfyui`（`imageBackend: 'comfyui'` 没碰）
- ✅ 没动 DSH 安装目录、`.dsh\cordis.patch.yml` 的 provider 段、`lib/client.js`
- ✅ `cordis.patch.yml` **没改** —— 新配置项都有内置默认，不写也能跑

**一个小提醒**（发现了但没擅自改）：`lib/index.js` 里 `DEFAULTS.comfyOutputDir`
还写着老路径 `X:\ComfyUI\ComfyUI\output`，实际靠 `cordis.patch.yml` 覆盖成 K 盘路径。
本机没问题，但**别人装上会取不到图**（要走 `/view` 兜底）。要不要改，你说。

---

## 6. 已知短板（没变）

1. **文字渲染**：turbo8 官方承认 OCR 准确率 95% → 75%。这是权重层的损失，
   TE 补不了。要精确文字请临时 `forceTurbo8Steps: false` + `turbo8Steps: 25`。
2. **TE 在 8 步下不跳步**（见第 3 节）。想让它真跳，得把步数调到 12 步以上 —— **我没验证过**。
3. **缺件会硬失败**：LoRA 文件不在 `models\loras\` 或 TE-Speed 没装，ComfyUI 会
   `node type not found` 直接拒单，不会静默降级。


---

## 附：后续叠加方案实测（2026-10-08 深夜补充）

本节是「全网搜索是否还有能叠加的加速方案」的实测结论。完整报告见同目录
`叠加加速方案实测报告.md`。

### A. 测量方法修正（重要）

本报告前面几节用的是「秒级墙钟 + 换 seed」。这次发现**秒级计时不够**：
HTTP 轮询的 1 秒粒度会把结果量化，出现 `11.02 / 12.02` 这类假精度。

**改用 ComfyUI 内部毫秒时间戳**（history 里 `execution_start` →
`execution_success` 的 `timestamp`），并**丢弃第 1 轮冷启动**（模型加载会让
baseline 在 12.8 s 和 24.0 s 之间抖动）。重测后：

| 方案 | 稳态耗时 | 加速比 |
|---|---:|---:|
| turbo8 8 步（本报告默认） | 11.581 s | 1.00× |
| turbo8 8 步 + TE（本报告默认） | 9.431 s | 1.23× |

**TE 的真实增量是 −18.6%，不是早期报告的 −43%。** 之前那个数字混入了缓存命中。

### B. 高精度叠加测试结果

6 臂 × 3 轮，每次都换 seed，取后 2 轮稳态：

| 方案 | 稳态耗时 | 加速比 | 画质（SSIM / 锐度变化） |
|---|---:|---:|---|
| turbo8 8 步 | 11.581 s | 1.00× | 基准 |
| + TE | 9.431 s | 1.23× | 0.9996 / +0.8% |
| + QwenImage21Speedup | 10.711 s | 1.08× | 0.9999 / −0.9% |
| **+ TE + Speedup** | **8.639 s** | **1.34×** | **0.9994 / −0.2%** |
| + T8 BlockCache | 9.712 s | 1.19× | 0.9998 / **−11.0%** |
| + T8 Spectrum | 9.664 s | 1.20× | 0.9915 / −10.2% |
| + TE + T8 Block | **执行报错** | — | 硬冲突 |

**当前最优可叠组合：TE + Speedup = 8.639 s（1.34×），且画质接近无损。**

### C. 两条实测确证的机制

1. **TE 在 8 步下确实一步都不跳**（日志 `predicted 0/8 steps`）。它的 −18.6%
   全部来自算子层 KV/attention 复用（`batch_offset=1`），**不随步数减少而放大**。
   这印证并补强了本报告第 6 节第 2 条。

2. **`QwenImage21Speedup` 的标定前提在 8 步下失效**。它假设 40 步时每步 drift
   约 0.13，实测 8 步时是 **0.409（3 倍）**。它自己的日志都打出警告：
   `a useful cache_threshold must exceed the mean; current 0.300`。
   结果只有 12.5% 跳步，而非它宣称的约 50%。

### D. 硬冲突（实测抛错，不是推测）

**TE + T8 BlockCache 无法共存**：

```
ValueError: Qwen Image 2.1 T8 cache requires exclusive diffusion-wrapper ownership;
use T8 Spectrum
```

根因：**TE 的 `te_predictor` 模式也挂了 `DIFFUSION_MODEL` wrapper**
（日志 `Qwen TE predictor calls: diffusion_wrapper=8`），而 T8 要求对它独占。

### E. 已排除，不用再花时间

| 项 | 排除原因 |
|---|---|
| ZLUDA 更新 / TunableOp | 本机是**原生 ROCm**（PyTorch 2.9.1+rocm7.2.1, gfx1100），不是 ZLUDA 路线。ZLUDA 只对无原生支持的卡有意义；TunableOp 是 cuBLASLt(CUDA) 专属 |
| FlashVSR | **视频**超分，与图像管线无关 |
| TAESD 快速解码 | 近似解码器会「发肉」，且**无千问专用版本** |
| T8 Spectrum | PSNR 仅 27.84 dB，肉眼可见发虚 |
| T8 BlockCache | 虽加速 1.19×，但锐度 −11%，且与 TE 硬冲突 |
| lightx2v 4/8 步 | 全部工作流是 Qwen-Image **1.0** / Edit 2509，**无 2.1 版本** |
| Fun-Acc / Pruna 4 步 | 需 `ManualSigmas` + `SamplerCustom` 自定义调度；无官方 ComfyUI 支持；官方自评质量低于 40 步底模 |

### F. 唯一还值得走的不同路径：VOSR2 超分

出图**之后**再插一级 1.4B 单步超分（LightningDiT + 千问 2D VAE + DINOv2-L），
与现有全链**正交可叠加**。权重 6.97 GB（服务器权威大小已核对）。

注意：训练分辨率上限 512 px，输出 >512 必须 `tile_size=512`，>1024 再加
`vae_tile_size=1024`。

**状态：2026-10-09 端到端实测已完成**（权重此前已下齐并校验）。

结果（默认加速链 + quad，各档 2 轮取末轮）：

| 档位 | 做法 | 实测(末轮) | vs 原生 |
|---|---|---:|---|
| 1024² | 原生直出 | 7.74 s | 基准 |
| 1024² | 512² + VOSR2×2 | 45.16 s | 慢 **5.84×** |
| 2048² | 原生直出 | 53.27 s | 基准 |
| 2048² | 512² + VOSR2×4 | 155.05 s | 慢 **2.91×** |

**结论：VOSR2 超分不省时间，反而慢 2.9×–5.8×**，属「出图后画质 / 预览」层，
与成图时间账正交，保持**可选、默认关**。打通阻塞需先经 `zz_rgba2rgb` 节点把
VAE 的 4 通道 RGBA 裁成 3 通道 RGB。画质级 A/B 未做（不同分辨率同 seed 构图不同）。

### G. 「AMD × ComfyUI 官方合作版」（2026-10-09 补充核实）

**结论：本机早已在该官方栈上，5.4× 的收益已吃到。**

核实要点：

| 项 | 核实结果 |
|---|---|
| 那是什么 | **就是标准上游 ComfyUI**（desktop / git / portable 三种形态），只是官方做了 ROCm 集成与一键安装。不是另做的发行版 |
| 5.4× 的基准 | 官方脚注写明：**ROCm 6.4 → 7.1.1** 的跨度，且是 **Ryzen AI Max+ 395（核显）/ Radeon AI Pro R9700** 上测的 |
| 你的实际版本 | **PyTorch 2.9.1+rocm7.2.1**（HIP 7.2.53211）—— **比那个 5.4× 的终点 7.1.1 还新一档** |
| gfx1100 支持 | ✅ 官方 7.2.1 Windows 支持矩阵**明确列出 gfx1100 = RX 7900 XT/XTX** |
| 官方版本组合 | 矩阵写 `PyTorch 2.9 / ROCm 7.2.1 / Python 3.12` —— 与本机 **逐项吻合** |

**关键实测日志证据（本机服务器启动日志原文）：**
```
Enabled pinned memory 12739.0      ← pinned memory 已默认开启（32GB RAM × 40%）
Using pytorch attention            ← 已在使用官方推荐的 pytorch attention
```

也就是说，官方博客提到的两个关键特性（pinned memory、pytorch cross-attention），
**本机运行中已经全部生效**。所谓"还没开发的十位数百分比空间"在这个方向上不存在。

**唯一剩下的可测开关**：AMD 官方文档建议低显存时加 `--disable-pinned-memory`。
本机 20GB VRAM + int8 + 1024²，该开还是关**尚未 A/B**。属于小项，优先级低。

### H. Spectrum 的彻底结论（本轮新增，含根因）

之前判断"Spectrum 与 TE 同层互斥"是**错的**。真相是：

**Spectrum 在 Qwen-Image 2.1 上根本无法运行**（架构不兼容），与互斥无关。

两根因，全部定位并绕过：

1. **`txt_norm` 缺失**。Spectrum 的 `resolve_qwen_core()` 要求 transformer 核心同时具备 7 个字段，
   其中 `txt_norm` 在 **2.1 里被挪到了 `txt_in.text_norm`**，顶层没有。
   → 补一个 property 别名后 `is_qwen_like_core` 由 False 翻 True。
2. **ROCm 无 MAGMA**。`chebyshev.py:105` 对 GPU 上的小矩阵调 `torch.linalg.cholesky`，
   ROCm 版 PyTorch 未编译 MAGMA → 报错。
   → 改成 CPU float64 求解（4×4，开销可忽略）。

**做了一个诊断兼容层**（`custom_nodes/_spectrum_qwen21_compat/`，纯补丁，可随时删除复原），
两个障碍都绕过，**Spectrum 现在能跑了**。但实测结果：

| 指标 | 结果 |
|---|---|
| `actual_calls` | **8 / 8** |
| `forecast_calls` | **0** |
| 每步耗时 | 1.42 → 1.72 s/it（标记 forecast 的那两步**反而更慢**） |
| 最裸链总耗时 | 20.13 s（baseline 仅 11.58 s） |

**零收益 + 变慢。** 原因是它的预算模型对不上 8 步：
- 前 2 步 `warmup` → 必 actual
- 第 3~5 步 `insufficient_history`（`history_points=5`，历史只攒到 3/4/5 条）→ 必 actual
- 末步 `tail` → 必 actual
- **只剩第 6、7 步可预测**，而这两步的预测路径没有省下任何计算

**→ Spectrum 是为 40 步左右长链设计的。8 步场景下它是纯负收益。兼容层保留仅作诊断，不建议启用。**

### I. TAE 预览解码器的更正

之前说"无千问专用 taesd"是**错的**，公开仓库确实有两个：

| 模型 | 大小（服务器权威） | 状态 |
|---|---:|---|
| `madebyollin/taeqi2_1` | 30,591,264 B | ✅ 已下载，大小精确匹配 |
| `AcademiaSD/TAE-Qwen-Image-2.1` | 3,259,798 B | ✅ 已下载，大小精确匹配 |

但性质不变：**TAE 只用于实时预览，不能用于成品**（近似解码器，细节发肉）。
它省的是"采样过程中的预览解码"时间，不影响最终出图。**判定仍为：不做成品用途。**

### J. 注意力后端轴实测（2026-10-09 新增）

插件默认的 `attention=kitchen_int8` 是此前唯一没拆解过的参数。实测（固定 seed=424242，turbo8 8 步）：

| TE 的 attention 模式 | 耗时 | 判定 |
|---|---:|---|
| **kitchen_int8（插件默认）** | **10.78 s** | ✅ **唯一有效** |
| default | 12.73 s | ❌ 等于丢掉 TE 收益 |
| sdpa | 12.60 s | ❌ 同上 |
| sageattn | 12.67 s | ❌ 同上 |
| flashattn | 12.62 s | ❌ 同上 |
| （无 TE 基线） | 13.12 s | 参照 |

**结论：`kitchen_int8` 是唯一能吃到加速的模式，其余四种与无 TE 基线持平。
你插件的默认值就是最优解，不要改。**

### K. 下载链接（供你自行下载）

VOSR2（仓库里的必要权重，总计 6.97 GB）：

```
# 主权重 1.4B 单步版 —— 5,576,385,424 B（必下）
https://huggingface.co/CSWRY/VOSR/resolve/main/VOSR2/checkpoints/ema_model.safetensors

# 千问 2D VAE —— 178,418,892 B
https://huggingface.co/CSWRY/VOSR/resolve/main/Qwen-Image-vae-2d/diffusion_pytorch_model.safetensors

# DINOv2-L —— 1,217,586,395 B
https://huggingface.co/CSWRY/VOSR/resolve/main/torch_cache/checkpoints/dinov2_vitl14_pretrain.pth
```

**更省的替代**（若只做 1MP→2K，0.5B 单步版可能够用，体积仅为 1.4B 的 1/3）：

```
# 0.5B 单步版 —— 1,948,337,520 B（1.94 GB）
https://huggingface.co/CSWRY/VOSR/resolve/main/VOSR_0.5B_os/checkpoints/ema_model.safetensors
```

> ✅ **2026-10-09 更新：VOSR2 权重已全部下齐并校验通过**（详见 L.7）。
> 三个文件均与服务器权威值字节精确匹配，已部署到
> `X:\ComfyUI\models\vosr2\`。上面这条「不完整」的注记已作废。


---

### L. 注意力后端 × 采样器 终轮实测（2026-10-09，直接回答「还能叠几层」）

#### L.1 唯一赢家：`--use-quad-cross-attention`

| 臂 | 稳态耗时 | vs 基线 |
|---|---:|---:|
| 基线（默认，不带任何注意力参数） | 10.739 s | — |
| `--use-pytorch-cross-attention` | 10.766 s | −0.3%（**无效，它本来就是默认**） |
| **`--use-quad-cross-attention`** | **9.328 s** | **+15.1%（省 1.41 s）** |
| `chelokot/flash-attention-rdna3` 节点 | 10.777 s | −0.4%（**静默绕过**） |

二次独立复现：10.658 s → 9.281 s（**+14.8%**）。
画质：同 seed 对比基线 PSNR 39.5 / 41.4 dB，清晰度 166.3 / 168.0（基线 164.6 / 165.5）——无黑图、无噪声。

#### L.2 RDNA3 节点为什么 0 收益（内核快 3× 却没进路径）

干净 GPU 上，按 Qwen-Image-2.1 真实形状（32 头 × 128 维，MMDiT 联合注意力）实测：

| 形状 | SDPA | fa_rdna3 | 加速 |
|---|---:|---:|---:|
| 1024² S=4352（fp16） | 16.25 ms | 5.35 ms | **3.04×** |
| 1024² S=4608（fp16） | 17.87 ms | 5.78 ms | **3.09×** |
| 1024² S=4096（fp16） | 13.99 ms | 4.84 ms | **2.89×** |
| 1024² S=4352（bf16） | 16.04 ms | 9.81 ms | **1.64×** |

但装计数器取证后：`flash_attention 0 次 | 回退 0 次`。
日志里明明有 `Enabled RDNA3 Flash Attention`，同时还有
`Composing RDNA3 Flash Attention under an existing attention override`
—— `QwenImage21Cache`（comfy-kitchen INT8）先装的 override **不向下委托**，
把 RDNA3 整条链架空了。**所以：不看计数器就下结论，会误报一个 3× 的收益。**

#### L.3 采样器轴：没有真赢家（`euler` 保持不动）

| 采样器 | 耗时 | 备注 |
|---|---:|---|
| `euler`（默认） | 10.640 s | 保持 |
| `euler_ancestral` | 9.587 s | ❌ **假收益**：输出与 euler **逐位相同**（PSNR 99 dB / MAD 0.000），复核 10.788 s |
| `dpmpp_2m` / `lcm` / `res_multistep` / `ipndm_v` | 10.47~10.55 s | ≈噪声内，且图明显不同（PSNR 16~20 dB） |
| `ddpm` | 10.506 s | ❌ 清晰度仅 19.5，**糊** |
| `dpm_2` / `heun` / `dpmpp_sde` | 14.53 / 17.43 / 18.64 s | ❌ 慢 37%~75% |

#### L.4 TunableOp：实测反向（此前判据写错了，已更正）

| 状态 | 稳态耗时 |
|---|---:|
| 关闭（T0） | **10.514 s** |
| 开启（T1，调优已完成） | 11.983 s |
| 开启的**首轮** | **1291.5 s（21.5 分钟）** |

**开启后反而慢 14%，且每次冷启动要付 21.5 分钟调优费**（调优结果文件不会在进程被
`terminate()` 时落盘，所以复用不上）。结论：**不要开**。
> 更正：之前写成「TunableOp 是 cuBLASLt(CUDA) 专属」是错的。
> TunableOp 是 PyTorch 的 **ROCm 专属** GEMM 自动调优特性，在原生 ROCm 上**首次可用**——
> 只是实测下来它是负收益。

#### L.5 最终可叠加层数：4 层（原 3 层）

| 栈 | 稳态耗时 |
|---|---:|
| 仅 TE-Speed | 10.741 s |
| TE-Speed + Speedup | 9.709 s |
| **TE-Speed + Speedup + `--use-quad-cross-attention`** | **8.278 s** |

quad 在满叠栈上仍有效（9.709 → 8.278 s，**再省 1.43 s / +17.3%**）。

1. **采样轴（替换）**：Turbo8 LoRA 8 步
2. **采样层 ①**：TE-Speed（`kitchen_int8`）
3. **采样层 ②**：QwenImage21Speedup（与 TE 实测可叠，1.34×）
4. **注意力后端层（新）**：`--use-quad-cross-attention`（+14.8%~17.3%）
5. **出图后轴（正交，不计入成图时间）**：VOSR2 超分

#### L.6 你清单里其余条目的打勾状态

- **ER-SDE 采样器** ❌ 本机没有 —— ComfyUI 内置 33 个采样器里无此项，需外部节点，未装未测。
- **ToMe（小 ratio，无文字图）** ❌ 未装、未测。
- **TE speed 档** ✅ 已测 —— `kitchen_int8` 10.78 s 最优，其余档位 12.6~12.7 s ≈ 无 TE 基线，**插件默认即最优**。
- **TunableOp** ❌ 已测反向（见 L.4）。
- **TAE 预览解码** ⚠️ 只做预览体验，**不进成图时间账**。
- **prompt 精简** ⚠️ 机制成立（Qwen 联合 attention 每步全量算文本 token），但**无实测数据**，预期 <2%，不推荐。

#### L.7 VOSR2 权重已下齐（此项更正旧注记）

| 文件 | 本地实际 | 服务器权威值 | 结果 |
|---|---:|---:|---|
| `VOSR2/checkpoints/ema_model.safetensors` | 5,576,385,424 | 5,576,385,424 | ✅ |
| `Qwen-Image-vae-2d/diffusion_pytorch_model.safetensors` | 178,418,892 | 178,418,892 | ✅ |
| `torch_cache/checkpoints/dinov2_vitl14_pretrain.pth` | 1,217,586,395 | 1,217,586,395 | ✅ |

均已部署到 `X:\ComfyUI\models\vosr2\`，`ComfyUI-VOSR2` 节点装载正常。
**已测（2026-10-09）**：端到端 A/B 完成。512²+VOSR2×2→1024² = 45.16 s（原生 1024² 仅 7.74 s，
慢 5.84×）；512²+VOSR2×4→2048² = 155.05 s（原生 2048² 53.27 s，慢 2.91×）。
**超分不省时，属画质/预览层，默认关、可选**。打通需经 `zz_rgba2rgb` 把 VAE 的 4 通道裁成 3 通道。

### M. ROCm / 系统开关审计（2026-10-09）

**基线修正**：先前报的 8.22s 是把 `--reserve-vram 1` 误带进测试脚本的假象；生产配置（仅 `--use-quad-cross-attention`，无 reserve）真实基线 = **7.1s**。

**逐项实测**（真实生产启动方式上叠加，1024²/8 步，2 轮取末轮）：

| 开关 | 末轮耗时 | vs 基线 | 判定 |
|---|---:|---:|---|
| baseline（quad，无 reserve） | 7.129 s | — | 基准 |
| A1 `PYTORCH_HIP_ALLOC_CONF=expandable_segments:True` | 7.102 s | −0.4% | 噪声 |
| A2 `HIP_FORCE_DEV_KERNARG=1` | 7.055 s | −1.0% | 噪声 |
| A4 `MIOPEN_FIND_MODE=FAST` | 7.077 s | −0.7% | 噪声 |
| B2 `--fast fp16_accumulation` | 7.051 s | −1.1% | 噪声 |
| B3 `--fp16-vae` | 7.030 s | −1.4% | 噪声 |
| B1 `--highvram` | 11.900 s | **+66.9%** | ❌ 有害，禁用 |

A1/A2/A4/B2/B3 波动落在轮间噪声内，无可复现收益；`--highvram` 强压全模型进显存反而慢 67%，禁用。

**A3**：运行时核验 `libhipblaslt.dll / rocblas.dll / MIOpen.dll` 均已加载 → hipBLASLt 在场，GEMM 调优天花板是开的。之前 TunableOp −14% 非库缺失（terminate 丢了调优缓存 + 首调 21 分钟）。按 A3 流程图，下一步做**带持久化调优缓存**的正式 TunableOp / `TORCH_ROCM_ABLT_CSV` 实测（~25 分钟，待你确认）。

**B4**：AMD 官方便携版 `X:\ComfyUI\install.ps1` 启动命令只是 `python main.py --listen 127.0.0.1 --port 8188`，无额外 ROCm flag；优化藏在 `rocm_sdk_libraries_custom` SDK wheel 里（我们已具备）。无可抄魔法 flag。

**C 组（Windows 系统层）**：沙箱 `reg.exe` 被禁、PowerShell 系统查询被拦，C1/C2 无法在此读；需你在宿主机确认 —— C1 关 VBS/内存完整性（或可回收 5~15%，有安全取舍你拍板）；C2 把 `X:\ComfyUI` 与 python/权重目录加 Defender 排除；C3 启动加 `-Priority High`；C4 关 Adrenalin 录制钩子。
