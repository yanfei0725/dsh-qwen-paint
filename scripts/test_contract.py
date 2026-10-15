#!/usr/bin/env python3
"""契约测试：用**真实的 ComfyUI 环境**导入本包，逐项校验节点契约。

## 为什么需要（这不是"锦上添花"）
ComfyUI 对自定义节点的契约是**硬要求**：
  · 少了 `RETURN_TYPES` / `FUNCTION` / `CATEGORY` → 节点加载失败或点不动；
  · `FUNCTION` 指向一个不存在的方法 → **运行到那一步才炸**，用户当场懵；
  · `RETURN_NAMES` 与 `RETURN_TYPES` 数量不一致 → 界面接线对不上；
  · 节点 id 与 ComfyUI 已有节点**重名** → 直接冲突。
这些都能在**不加载任何模型、不占显存**的前提下静态测出来 —— 所以必须测。

## 用法
    <ComfyUI 的 python> scripts/test_contract.py [--comfy <ComfyUI 根目录>]
不传 `--comfy` 时按常见位置自动找。
"""

import argparse
import importlib.util
import os
import sys
import traceback

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANDIDATE_COMFY = [
    r"K:\ComfyUI-rocm\ComfyUI",
    r"D:\ComfyUI\ComfyUI",
    r"C:\ComfyUI\ComfyUI",
    os.path.join(PKG_DIR, "..", "ComfyUI"),
]

PASS, FAIL = [], []


def ok(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f" —— {detail}" if (detail and not cond) else ""))


def find_comfy(explicit):
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    for p in CANDIDATE_COMFY:
        p = os.path.abspath(p)
        if os.path.isdir(os.path.join(p, "comfy")):
            return p
    return None


def load_package(comfy_root):
    """按 **ComfyUI 自己的方式**加载本包（目录名带连字符，不能用普通 import）。"""
    sys.path.insert(0, comfy_root)
    module_name = "qwen_image_optimized"
    spec = importlib.util.spec_from_file_location(
        module_name,
        os.path.join(PKG_DIR, "__init__.py"),
        submodule_search_locations=[PKG_DIR],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--comfy", default=None)
    args = ap.parse_args()

    comfy_root = find_comfy(args.comfy)
    print("=" * 72)
    print("千问优化节点包 · 契约测试")
    print("=" * 72)
    print(f"包目录  : {PKG_DIR}")
    print(f"ComfyUI : {comfy_root or '(未找到 —— 跳过需要 ComfyUI 的部分)'}")
    print()

    # ── ① 纯函数（不依赖 ComfyUI）────────────────────────────────────────────
    print("① 纯函数：精度档挑文件")
    # ⚠ 直接按**文件路径**加载 `_common.py`，不走包的 `__init__.py` ——
    #   因为包 `__init__` 会连带 import 需要 ComfyUI 的模块（folder_paths 等），
    #   而这一节的用意正是"没有 ComfyUI 也能测"。
    spec0 = importlib.util.spec_from_file_location(
        "_qio_common", os.path.join(PKG_DIR, "nodes", "_common.py"))
    common = importlib.util.module_from_spec(spec0)
    spec0.loader.exec_module(common)
    files = ["qwen_image_2.1_int8_convrot.safetensors",
             "qwen_image_2.1_fp8.safetensors",
             "qwen_image_2.1_bf16.safetensors",
             "qwen-image-2.1-UC-Q4_K_M.gguf"]
    ok("bf16 档挑到 bf16 文件", common.pick_unet_by_tier("bf16", files)[0] == "qwen_image_2.1_bf16.safetensors")
    ok("fp8 档挑到 fp8 文件", common.pick_unet_by_tier("fp8", files)[0] == "qwen_image_2.1_fp8.safetensors")
    ok("int8 档挑到 int8 文件", common.pick_unet_by_tier("int8", files)[0] == "qwen_image_2.1_int8_convrot.safetensors")
    ok("gguf 档挑到 .gguf", common.pick_unet_by_tier("gguf", files)[0] == "qwen-image-2.1-UC-Q4_K_M.gguf")
    miss, why = common.pick_unet_by_tier("bf16", ["only_int8.safetensors"])
    ok("★ 缺文件时返回 None（不假装挑到）", miss is None and bool(why), f"{miss} / {why}")
    ok("auto 档返回 None（交给调用方）", common.pick_unet_by_tier("auto", files)[0] is None)

    if not comfy_root:
        print("\n（没有 ComfyUI 环境，节点契约部分跳过）")
        return finish()

    # ── ② 真实导入 ────────────────────────────────────────────────────────────
    print("\n② 用真实 ComfyUI 环境导入本包")
    try:
        mod = load_package(comfy_root)
        ok("包导入成功（无语法错 / 无导入错）", True)
    except Exception:
        ok("包导入成功", False)
        traceback.print_exc()
        return finish()

    mappings = getattr(mod, "NODE_CLASS_MAPPINGS", None)
    displays = getattr(mod, "NODE_DISPLAY_NAME_MAPPINGS", {})
    ok("NODE_CLASS_MAPPINGS 存在且非空", isinstance(mappings, dict) and len(mappings) > 0)
    ok("NODE_DISPLAY_NAME_MAPPINGS 覆盖所有节点",
       isinstance(displays, dict) and set(displays) >= set(mappings or {}),
       f"缺 {sorted(set(mappings or {}) - set(displays))}")

    # ── ③ 逐节点校验契约 ─────────────────────────────────────────────────────
    print("\n③ 逐节点契约")
    for node_id, cls in (mappings or {}).items():
        # INPUT_TYPES
        try:
            it = cls.INPUT_TYPES()
            has_it = isinstance(it, dict) and isinstance(it.get("required"), dict) and len(it["required"]) > 0
        except Exception as exc:
            it, has_it = None, False
            print(f"     (INPUT_TYPES 抛错: {exc})")
        ok(f"{node_id}：INPUT_TYPES 可调用且有 required", has_it)
        if has_it:
            # 每个 required 输入必须是 (type, ...) 或 (type, opts) 形状
            bad = []
            for k, v in it["required"].items():
                if not (isinstance(v, (tuple, list)) and len(v) >= 1):
                    bad.append(k)
            ok(f"{node_id}：required 输入形状合法", not bad, f"异常项 {bad}")
        # RETURN_TYPES / FUNCTION / CATEGORY
        rts = getattr(cls, "RETURN_TYPES", None)
        ok(f"{node_id}：有 RETURN_TYPES", isinstance(rts, (tuple, list)) and len(rts) > 0)
        rns = getattr(cls, "RETURN_NAMES", None)
        if rns is not None:
            ok(f"{node_id}：RETURN_NAMES 数量与 RETURN_TYPES 一致",
               len(rns) == len(rts), f"{len(rns)} vs {len(rts)}")
        fn_name = getattr(cls, "FUNCTION", None)
        ok(f"{node_id}：有 FUNCTION", isinstance(fn_name, str) and fn_name != "")
        if fn_name:
            ok(f"{node_id}：FUNCTION 指向的方法**真实存在**（否则运行到那步才炸）",
               callable(getattr(cls, fn_name, None)), f"缺方法 {fn_name}()")
        ok(f"{node_id}：有 CATEGORY", isinstance(getattr(cls, "CATEGORY", None), str))

    # ── ④ 与 ComfyUI 已有节点**不重名** ───────────────────────────────────────
    print("\n④ 节点 id 与 ComfyUI 现有节点不冲突")
    try:
        import nodes as comfy_nodes
        existing = set(comfy_nodes.NODE_CLASS_MAPPINGS.keys())
        clash = sorted(set(mappings or {}) & existing)
        ok("没有与现有节点重名的 id", not clash, f"冲突：{clash}")
    except Exception as exc:
        print(f"     (拿不到现有注册表: {exc})")

    # ── ⑤ 第三方加速件的可用性（**只报告，不判失败**）────────────────────────
    print("\n⑤ 加速件探测机制 + 本机可用性")
    # ⚠ 先验证**探测机制本身**是对的：裸 `import nodes` 只会注册 nodes.py 里的内置节点，
    #   comfy_extras 与 custom_nodes 是 ComfyUI 启动时才加载的 —— 所以这里必然"看不到"它们。
    #   用内置的 VAEDecodeTiled 做对照：它**应该**可见；看不到就说明 available() 写错了。
    ok("★ 探测机制正确（内置 VAEDecodeTiled 应可见）", common.available("VAEDecodeTiled"))
    print("     ↑ 下面这些在**裸导入**下必然显示未装 —— 它们是 ComfyUI 启动时才注册的，")
    print("       只有真跑起 ComfyUI 才看得到。这一节仅供参考，不代表你机器上真的没装。")
    for nid in ["QwenImage21Cache", "QwenImage21BlockCacheT8", "TESpeedQwenImage21",
                "QwenImage21Speedup", "ApplyRDNA3FlashAttention", "QwenSpectrumModelPatcher"]:
        print(f"     {'✔' if common.available(nid) else '·'} {nid}")

    # ── ⑥ ★★ 我调用的 ComfyUI API 是否**真实存在** ───────────────────────────
    #
    # ⚠⚠ 这一节是**血泪教训**加的，务必看懂：
    #   上面的契约测试只验"类结构"，**从不执行**节点的 load()/generate()。
    #   于是第一版里 `comfy.sd.load_vae(...)` **根本不存在**（当前版本只有
    #   `load_vae_patcher`）这种**一执行就崩**的错误，46 项测试全绿也没抓到。
    #   ⇒ 必须有这一节：把**运行时才会触碰的 API** 逐个断言存在。
    #   ⇒ 以后代码里新调了任何 ComfyUI API，**都要加到这张表里**。
    print("\n⑥ ★★ 运行时 API 存在性（专抓'一执行就崩'的那类错误）")
    try:
        import comfy.sd
        import comfy.utils
        import nodes as comfy_nodes
    except Exception as exc:
        ok("能导入 comfy.sd / comfy.utils / nodes", False, str(exc))
        return finish()

    API_CHECKS = [
        # (展示名, 取值函数) —— 取不到就说明这个 API 在当前版本不存在
        ("comfy.sd.load_diffusion_model", lambda: comfy.sd.load_diffusion_model),
        ("comfy.sd.load_clip", lambda: comfy.sd.load_clip),
        ("comfy.sd.load_vae_patcher", lambda: comfy.sd.load_vae_patcher),
        ("comfy.sd.CLIPType.QWEN_IMAGE", lambda: comfy.sd.CLIPType.QWEN_IMAGE),
        ("comfy.utils.load_torch_file", lambda: comfy.utils.load_torch_file),
        ("nodes.VAELoader", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["VAELoader"]),
        ("nodes.UNETLoader", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["UNETLoader"]),
        ("nodes.CLIPLoader", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["CLIPLoader"]),
        ("nodes.LoraLoaderModelOnly", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["LoraLoaderModelOnly"]),
        ("nodes.EmptyLatentImage", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["EmptyLatentImage"]),
        ("nodes.common_ksampler", lambda: comfy_nodes.common_ksampler),
        ("nodes.VAEDecode", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["VAEDecode"]),
        ("nodes.VAEDecodeTiled", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["VAEDecodeTiled"]),
        ("nodes.ControlNetLoader", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["ControlNetLoader"]),
        ("nodes.ControlNetApplyAdvanced", lambda: comfy_nodes.NODE_CLASS_MAPPINGS["ControlNetApplyAdvanced"]),
        ("comfy_extras.ModelSamplingFlux", lambda: __import__(
            "comfy_extras.nodes_model_advanced", fromlist=["ModelSamplingFlux"]).ModelSamplingFlux),
    ]
    for label, getter in API_CHECKS:
        try:
            getter()
            ok(f"存在：{label}", True)
        except Exception as exc:
            ok(f"存在：{label}", False, f"{type(exc).__name__}: {exc}")

    # ★ 反向锁：明确断言 comfy.sd 里**没有** load_vae —— 防止哪天有人又写回去
    ok("★ 反向锁：comfy.sd.load_vae 不存在（别再用它）", not hasattr(comfy.sd, "load_vae"))

    # ── ⑦ api.py：不依赖 ComfyUI 也能拼图 ────────────────────────────────────
    print("\n⑦ 调用接口 api.py（纯拼 JSON，不需要 ComfyUI 在跑）")
    sys.path.insert(0, PKG_DIR)
    try:
        import api as qapi
        wf = qapi.build_workflow("一只猫", width=1024, height=1024, seed=1)
        ok("build_workflow 返回 dict", isinstance(wf, dict) and len(wf) > 1)
        ok("★ 图里所有 class_type 都是字符串（拼错会当场暴露）",
           all(isinstance(v.get("class_type"), str) for k, v in wf.items() if k != "__meta__"))
        ok("★ 接线引用都指向图里存在的节点（断线会当场暴露）",
           _links_resolve(wf))
        ok("strip_meta 能去掉 __meta__（提交前必须调，否则 ComfyUI 拒收）",
           "__meta__" not in qapi.strip_meta(wf))
        wf2 = qapi.build_workflow("改图", reference_image_node=("99", 0))
        ok("图生图：给了参考图 → latent 取自编码器第 3 个输出",
           any(v.get("class_type") == "TextEncodeQwenImage21"
               and isinstance(v["inputs"].get("images"), dict) for v in wf2.values()))
        wf3 = qapi.build_workflow("按结构", control_image_node=("98", 0), control_net_name="cnet.safetensors")
        ok("ControlNet：给了控制图+权重 → 图里出现 ControlNet 两个节点",
           sum(1 for v in wf3.values() if str(v.get("class_type")).startswith("ControlNet")) == 2)
    except Exception as exc:
        ok("api.py 可用", False, f"{type(exc).__name__}: {exc}")
        traceback.print_exc()

    return finish()


def _links_resolve(workflow):
    """图里所有 `[节点id, 序号]` 形式的接线，是否都指向真实存在的节点。"""
    ids = set(workflow.keys())

    def walk(v):
        if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int):
            if v[0] not in ids:
                return False
            return True
        if isinstance(v, dict):
            return all(walk(x) for x in v.values())
        if isinstance(v, list):
            return all(walk(x) for x in v)
        return True

    for k, v in workflow.items():
        if k == "__meta__":
            continue
        if not walk(v.get("inputs", {})):
            return False
    return True


def finish():
    print()
    print("=" * 72)
    if FAIL:
        print(f"有 {len(FAIL)} 项失败 ✗")
        for f in FAIL:
            print("   ✗", f)
        return 1
    print(f"全部通过 ✓（{len(PASS)} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
