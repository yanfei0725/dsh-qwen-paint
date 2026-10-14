"""qwen-image-optimized —— 共享工具层。

这里放**所有节点共用**的东西：档位定义、文件探测、可用性检查、日志。

## 设计原则（与 DSH 版插件一致，是本项目反复踩坑后定下的）
1. **绝不挂一个不存在的节点** —— ComfyUI 遇到未知 class_type 会**整单拒收**，
   所以任何加速件都必须先探测、缺了就**跳过**。
2. **跳过必须留痕** —— 每个节点都输出一份 `report` 字符串，如实写明
   「接了什么、跳过了什么、为什么」。**静默降级**是本项目最反感的行为。
3. **绝不假装成功** —— 文件不在就说不在，节点没装就说没装，绝不回落到一个"看起来在跑"的假路径。
"""

import logging
import re

LOG = logging.getLogger("qwen-image-optimized")

# ─────────────────────────────────────────────────────────────────────────────
# 精度档
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠ 为什么按**文件名标记**挑、而不是写死文件名：
#   各家重打包的命名五花八门。写死一个名字，一旦对不上就会出现
#   「界面说用上了 BF16、实际跑的还是 int8」—— 这正是 DSH 版踩过的假报告。
#   所以：按标记挑；挑不到就**如实回落**并写进 report。
PRECISION_TIERS = ["auto", "bf16", "fp8", "int8", "gguf"]

# 采样位移档（决定 steps/cfg 的工作点）
SHIFT_PRESETS = ["auto", "turbo8", "fast4", "native"]

# turbo8 / fast4 的工作点（与 DSH 版一致，来自各自蒸馏方的训练设定）
PRESET_WORKPOINT = {
    #             steps, cfg, max_shift, base_shift
    "turbo8": (8, 1.0, 0.6935, 0.5),
    "fast4": (4, 1.0, 1.0986, 1.0986),
    "native": (25, 2.5, 1.15, 0.5),
}


def _folder_list(kind):
    """安全地列某个模型目录下的文件名。取不到就返回空表（**不抛**）。"""
    try:
        import folder_paths
        return [str(x) for x in folder_paths.get_filename_list(kind)]
    except Exception as exc:  # pragma: no cover - 环境相关
        LOG.warning("列 %s 目录失败：%s", kind, exc)
        return []


def pick_unet_by_tier(tier, files=None):
    """按**精度档**从已装的主模型文件里挑一个。

    返回 `(文件名, 说明)`；挑不到返回 `(None, 原因)` —— **绝不假装挑到了**。

    判据（与 DSH 版 `pickUnetForTier` 同一套，便于两边行为一致）：
      · gguf  → `.gguf` 结尾
      · int8  → 含 `int8`
      · fp8   → 含 `fp8`
      · bf16  → 含 `bf16`/`bfloat16`；没有再退一步找「完全无量化标记」的原生文件
      · auto  → 返回 None（由调用方走自己的默认逻辑）
    """
    files = _folder_list("diffusion_models") if files is None else [str(f) for f in files]
    tier = str(tier or "auto").lower()
    if tier == "auto":
        return None, "精度档=auto，交给调用方决定"
    if not files:
        return None, "ComfyUI 的 diffusion_models 目录里没有任何文件"

    def _best(cands):
        # 优先带 qwen image 2.1 字样的，其次任意一个
        qwen = [f for f in cands if re.search(r"qwen[_\-.]?image", f, re.I)]
        pool = qwen or cands
        return sorted(pool)[0]

    if tier == "gguf":
        m = [f for f in files if f.lower().endswith(".gguf")]
        return (_best(m), "") if m else (None, "没有 .gguf 主模型（需先装 ComfyUI-GGUF 并放入 GGUF 权重）")
    if tier == "int8":
        m = [f for f in files if re.search(r"int8", f, re.I)]
        return (_best(m), "") if m else (None, "没有带 int8 标记的主模型")
    if tier == "fp8":
        m = [f for f in files if re.search(r"fp8", f, re.I)]
        return (_best(m), "") if m else (None, "没有带 fp8 标记的主模型")
    if tier == "bf16":
        m = [f for f in files if re.search(r"bf16|bfloat16", f, re.I)]
        if m:
            return _best(m), ""
        plain = [f for f in files
                 if not f.lower().endswith(".gguf")
                 and not re.search(r"int8|fp8|q[2-8]_[0-9k]", f, re.I)]
        return (_best(plain), "（没有显式 bf16 标记，回落到无量化标记的原生文件）") if plain \
            else (None, "没有 bf16 / 无量化标记的主模型")
    return None, f"未知精度档：{tier}"


def node_class(node_id):
    """从 ComfyUI 的全局注册表里取一个节点类；取不到返回 None。

    ⚠ 用**运行时注册表**而不是 `import` 第三方包：第三方节点的目录名/模块路径
      五花八门（有的还是编译好的 `.pyd`），按路径 import 极其脆弱。
      注册表是 ComfyUI 自己维护的权威来源。
    """
    try:
        import nodes as comfy_nodes
        return comfy_nodes.NODE_CLASS_MAPPINGS.get(node_id)
    except Exception:
        return None


def available(node_id):
    """该节点是否可用（已安装且注册）。"""
    return node_class(node_id) is not None


def declared_inputs(cls):
    """该节点**声明过**的输入名集合；读不到返回 None（表示"不限制"）。"""
    try:
        it = cls.INPUT_TYPES()
    except Exception:
        return None
    if not isinstance(it, dict):
        return None
    names = set()
    for bucket in ("required", "optional"):
        names.update((it.get(bucket) or {}).keys())
    return names


def call_patched_model(node_id, model, **kwargs):
    """调用一个「输入 MODEL、输出 MODEL」的补丁类节点。

    返回 `(新 model, 错误说明)`；失败时 `新 model` 为 None。

    ## 为什么这么写（三条，都是"别把整单搞崩"）
    1. **兼容两代节点 API**：ComfyUI 现在有老式（`INPUT_TYPES()` + `FUNCTION` 实例方法）
       与新式（`io.ComfyNode.execute()` 类方法）两代写法，两代都得支持，
       否则"用户装的是哪一代"就决定我们的节点能不能用。
    2. **只传它声明过的输入**：第三方节点各版本参数名会变（甚至加了/删了参数）。
       先问它 `INPUT_TYPES()`，**只把我们双方都有的键传过去** —— 这样版本漂移不会直接报错。
    3. **任何异常都转成可读原因**：加速件失败**绝不能**让整次出图崩掉，
       而是跳过它 + 在 report 里如实写明原因。
    """
    cls = node_class(node_id)
    if cls is None:
        return None, f"未安装节点 {node_id}"

    # ② 只保留对方声明过的键（读不到声明就不限制）
    names = declared_inputs(cls)
    if names:
        dropped = [k for k in kwargs if k not in names]
        kwargs = {k: v for k, v in kwargs.items() if k in names}
    else:
        dropped = []

    try:
        # ── 新式：io.ComfyNode ──
        if hasattr(cls, "execute"):
            out = cls.execute(model=model, **kwargs)
            result = getattr(out, "result", out)
            if isinstance(result, (tuple, list)) and result:
                return result[0], ""
            return result, ""
        # ── 老式：INPUT_TYPES + FUNCTION ──
        obj = cls()
        fn_name = getattr(cls, "FUNCTION", None) or "run"
        fn = getattr(obj, fn_name, None)
        if fn is None:
            return None, f"{node_id} 既没有 execute() 也没有 {fn_name}()"
        out = fn(model=model, **kwargs)
        if isinstance(out, (tuple, list)) and out:
            return out[0], ""
        return out, ""
    except Exception as exc:
        extra = f"（已按声明过滤掉：{', '.join(dropped)}）" if dropped else ""
        return None, f"{node_id} 调用失败：{type(exc).__name__}: {exc}{extra}"


class Report:
    """把「接了什么 / 跳过了什么」攒成一段人话，供节点的 report 输出。"""

    def __init__(self, title):
        self.title = title
        self.on = []
        self.off = []

    def ok(self, text):
        self.on.append(text)
        return self

    def skip(self, text):
        self.off.append(text)
        return self

    def render(self):
        lines = [self.title]
        if self.on:
            lines.append("  ✔ 已接上：")
            lines += [f"    · {t}" for t in self.on]
        if self.off:
            lines.append("  ⚠ 未接上：")
            lines += [f"    · {t}" for t in self.off]
        if not self.on and not self.off:
            lines.append("  （无变化）")
        return "\n".join(lines)
