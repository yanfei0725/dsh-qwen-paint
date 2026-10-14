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

    return finish()


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
