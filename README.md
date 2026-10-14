# qwen-image-optimized · 千问 2.1 优化节点包（ComfyUI）

把 DSH 版插件里验证过的那套**千问 2.1 加速与容错逻辑**，做成一个**真正的 ComfyUI 自定义节点包**。

> **不依赖 DSH，不需要 DSH 调用** —— 直接装进 `ComfyUI/custom_nodes/` 就能用。
>
> ⚠ 与同仓库 `main` 分支上的 `dsh-qwen-paint` **不是一回事**：那个是 DSH 插件（Node/JS，
> 通过 HTTP 调本机 ComfyUI），本包是 ComfyUI 节点（Python，跑在 ComfyUI 里）。

---

## 一、装法

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yanfei0725/dsh-qwen-paint -b comfyui-node qwen-image-optimized
```
重启 ComfyUI，在节点菜单里搜「千问 2.1」或 `Qwen Image`。

**本包不下载任何权重、不装任何第三方节点。** 缺什么会在节点的 `report` 输出里告诉你缺什么。

---

## 二、五个节点

| 节点 id | 界面名 | 作用 |
|---|---|---|
| `QwenImageOneClick` | 千问 2.1 一键出图 | **填 prompt + 选尺寸 + 选档位 → 直接出图**。内部串好下面四个 |
| `QwenImageOptimizedLoader` | 千问 2.1 优化加载器 | 精度档选型 + turbo LoRA + 采样位移 + 前缀缓存，输出 MODEL/CLIP/VAE |
| `QwenImageAccelChain` | 千问 2.1 加速链 | BlockCache T8 / TE-Speed / Speedup / RDNA3-FA，按**互斥规则**自动挑 |
| `QwenImageTiledDecode` | 千问 2.1 分块解码 | 大图 VAE 分块解码；普通解码真 OOM 时**自动回退**分块重试 |
| `QwenImageControlNetApply` | 千问 2.1 ControlNet | 加载权重并施加到条件上（结构约束） |

**两种用法**
- **不想接线** → 用 `QwenImageOneClick`；
- **想自己接线**（插额外 LoRA / ControlNet / 换采样器）→ 用 `QwenImageOptimizedLoader` + `QwenImageAccelChain` + `QwenImageTiledDecode`。

⚠ **一键节点复用另外四个的实现**（直接实例化调用），**不存在第二套逻辑** ——
否则"一键"和"手动接线"迟早跑出两种行为。

---

## 三、档位

**精度档**（`precision`）：`auto` / `bf16`（全精度）/ `fp8` / `int8` / `gguf`
- 按**文件名标记**从你已装的文件里挑；**挑不到就如实回落**并在 `report` 里写明原因 —— 绝不假装用上了。

**工作点档**（`shift_preset`）：`auto` / `turbo8`（8 步 / CFG 1.0）/ `fast4`（4 步）/ `native`（25 步 / CFG 2.5）
- turbo8 / fast4 会**同时**接上对应 LoRA 与采样位移 —— 位移与 LoRA 必须配套，拿错会明显掉画质。
- 想要**更精细的文字渲染**就用 `native`（原生工作点），代价是约 3 倍采样时间。

**加速链**（`wrapper_mode`）：`auto` / `blockcache` / `te_speedup` / `none`
- ⚠⚠ `BlockCache T8` 与 `TE-Speed / Speedup` **争抢同一组 `DIFFUSION_MODEL` wrapper**，
  同时挂会让 ComfyUI 抛 `ValueError`、**整单失败**。本节点**永远只挂一套**，另一套写进 report 说明"已让位"。
- `auto` 按尺寸选：`> 1024²` 走 BlockCache T8，否则走 TE-Speed + Speedup。
- `RDNA3 FlashAttention` 不冲突，可叠加（只对 RDNA3 / gfx1100 生效，节点自带回退）。

---

## 四、三条设计原则（都是踩坑换来的，写在这里免得后人再踩）

1. **绝不挂一个不存在的节点。** ComfyUI 遇到未知 `class_type` 会**整单拒收** ——
   所以加速件一律先探测，缺了就跳过。
2. **跳过必须留痕。** 每个节点都输出 `report` 字符串，如实写明
   「接了什么 / 跳过了什么 / 为什么」。**静默降级**是本项目最反感的行为。
3. **绝不假装成功。** 文件不在就说不在，节点没装就说没装，
   绝不回落到一个"看起来在跑"的假路径。

---

## 五、测试

```bash
<ComfyUI 的 python> scripts/test_contract.py --comfy <ComfyUI 根目录>
```

本机实测（ComfyUI `K:/ComfyUI-rocm/ComfyUI`，Python 3.12）：**46 项全部通过**。
覆盖：精度档挑选（含"缺文件必须返回 None"）、包可导入、
五个节点的完整契约（INPUT_TYPES / RETURN_TYPES / RETURN_NAMES / FUNCTION 真实存在 / CATEGORY）、
节点 id 与 ComfyUI 现有节点不冲突、探测机制自检。

⚠ **知情声明**：契约测试是**静态**的（不加载模型、不占显存）。
本包在**真机上出图**的效果（尤其 bf16 / ControlNet）**尚未在本机端到端验证**。

---

## 六、上架 ComfyUI Registry

`pyproject.toml` 已按[官方规范](https://docs.comfy.org/registry/specifications)填好。
发布前需你做两件事（只有仓库所有者能做）：

1. **核对 `PublisherId`**（现为 `gitonnet`）—— 必须与你 Registry 个人页 `@` 后面那串**完全一致**。
   ⚠ 它**不等于** GitHub 用户名：本项目用户名是 `yanfei0725`，Publisher ID 是 `gitonnet`。
   写错会报 `Failed to validate token`。
2. **建 API Key**，然后二选一：
   - 自动：`Settings → Secrets → Actions` 建 `REGISTRY_ACCESS_TOKEN`，改 `pyproject.toml` 的 version 推送即发；
   - 手动：`pip install comfy-cli` → `comfy node publish`。

> ⚠ **一个需要你决定的隐患**：ComfyUI Registry 是按仓库**默认分支**的 `pyproject.toml`
> 来跟踪更新的，而本包放在 `comfyui-node` 分支、`main` 上是 DSH 版的 `pyproject.toml`。
> ⇒ 首次发布没问题，但**后续自动更新可能读到 main 上那个**。
> 若要长期维护，建议把本包**拆成独立仓库**，或把 `comfyui-node` 设为默认分支。

## 许可

MIT —— 见 LICENSE。
