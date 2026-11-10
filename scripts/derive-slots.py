#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""报告 v3 §14.2「A 线」：用 Python ast 把 G1/G2 从手写声明变成**自动推导**。

第 12 节的 G1（字面量槽位）/ G2（模型加载器）原先靠人工写 sidecar / modelMap 维持，
节点一改名就漂移。本脚本解析 ComfyUI 节点定义源码里的 INPUT_TYPES，
自动产出「哪个节点类有哪些可绑定槽位 / 是模型加载器」。

用法：
  python scripts/derive-slots.py --self-test
  COMFYUI_ROOT=<ComfyUI 源码目录> python scripts/derive-slots.py --out assets/slots.json
  python scripts/derive-slots.py <任意 .py 列表>            # 不落盘，打印 JSON

零第三方依赖；离线可测（--self-test 用内嵌 fixture，不碰 ComfyUI）。
⚠ 产物 `assets/slots.json` 会进发布物/公开仓库：`_files` 一律只写**相对 ComfyUI
  源码根**的 POSIX 路径，绝不写本机盘符绝对路径（发布脱敏，见 scripts/pack.mjs 禁则）。
"""

import argparse
import ast
import json
import os
import sys
from pathlib import Path

# G1：节点输入名叫这些时，可由 values 自动绑定（与 lib/workflow-ast.js LITERAL_SLOTS 同源）
LITERAL_SLOTS = {
    "text", "seed", "width", "height", "steps", "cfg", "denoise",
    "image", "lora_name", "num_frames", "fps", "length", "frame_rate",
}
# G2：模型加载器特征输入
MODEL_INPUTS = {
    "unet_name", "ckpt_name", "vae_name", "lora_name", "clip_name",
    "clip_name1", "clip_name2", "control_net_name", "model_name",
}

SELF_TEST_FIXTURE = '''
class Wan22ImageToVideoLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"vae": ("VAE",), "width": ("INT",),
                            "height": ("INT",), "length": ("INT",),
                            "batch_size": ("INT",)},
                "optional": {"start_image": ("IMAGE",)}}
    RETURN_TYPES = ("LATENT",)

class UNETLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"unet_name": ("STRING",), "weight_dtype": ("STRING",)}}

class CLIPTextEncode:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"text": ("STRING",), "clip": ("CLIP",)}}

class NewStyleWan(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NewStyleWan",
            inputs=[
                io.Vae.Input("vae"),
                io.Int.Input("width", default=1280),
                io.Int.Input("height", default=704),
                io.Int.Input("length", default=49),
            ],
        )
'''


def input_keys_of(fn):
    """老式 schema：`INPUT_TYPES` 返回 dict，取 required/optional 下的**字面量键名**。"""
    keys = set()
    for sub in ast.walk(fn):
        if not isinstance(sub, ast.Dict):
            continue
        for k, v in zip(sub.keys, sub.values):
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                continue
            if k.value not in ("required", "optional"):
                continue
            if not isinstance(v, ast.Dict):
                continue
            for kk in v.keys:
                if isinstance(kk, ast.Constant) and isinstance(kk.value, str):
                    keys.add(kk.value)
    return keys


def schema_input_keys(fn):
    """新式 schema（ComfyUI ≥0.39 的 `io.ComfyNode`）：`define_schema()` 里
    `io.Int.Input("width", ...)` 的**第一个位置参数**就是输入名。"""
    keys = set()
    for sub in ast.walk(fn):
        if not isinstance(sub, ast.Call):
            continue
        f = sub.func
        if not (isinstance(f, ast.Attribute) and f.attr == "Input"):
            continue
        if sub.args and isinstance(sub.args[0], ast.Constant) and isinstance(sub.args[0].value, str):
            keys.add(sub.args[0].value)
    return keys


def derive_source(src, label):
    """解析一份源码，返回 {slots, modelLoaders, classes}。新老两种节点 schema 都认。"""
    tree = ast.parse(src, filename=label)  # ← 这就是 A 线的「AST」
    slots, loaders, classes = {}, {}, 0
    for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
        classes += 1
        for fn in cls.body:
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if "INPUT_TYPES" in fn.name:
                keys = input_keys_of(fn)
            elif fn.name == "define_schema":
                keys = schema_input_keys(fn)
            else:
                continue
            hits = sorted(keys & LITERAL_SLOTS)
            if hits:
                slots[cls.name] = hits
            model_hits = sorted(keys & MODEL_INPUTS)
            if model_hits:
                loaders[cls.name] = model_hits
    return {"classes": classes, "slots": slots, "modelLoaders": loaders}


def display_path(path, root):
    """产物里只留**相对 ComfyUI 源码根**的 POSIX 路径，绝不写本机绝对路径。
    root 未给定时退化成文件名（basename），一样不含盘符。"""
    p = Path(path)
    if root is not None:
        try:
            return p.relative_to(root).as_posix()
        except ValueError:
            pass
    return p.name


def derive_files(paths, root=None):
    out = {"_source": "python-ast", "_sourceRoot": "<COMFYUI>", "_files": [], "classes": 0,
           "slots": {}, "modelLoaders": {}}
    for p in paths:
        path = Path(p)
        if not path.is_file():
            continue
        try:
            # utf-8-sig 顺手吃掉 BOM（ComfyUI 的 nodes_mesh_io.py 带 U+FEFF，老写法会报 parse error）
            src = path.read_text(encoding="utf-8-sig", errors="replace")
            d = derive_source(src, str(path))
        except (SyntaxError, UnicodeError) as e:
            out.setdefault("_parseErrors", []).append(f"{display_path(path, root)}: {e}")
            continue
        out["_files"].append(display_path(path, root))
        out["classes"] += d["classes"]
        out["slots"].update(d["slots"])
        out["modelLoaders"].update(d["modelLoaders"])
    return out


def self_test():
    d = derive_source(SELF_TEST_FIXTURE, "<fixture>")
    assert d["slots"]["Wan22ImageToVideoLatent"] == ["height", "length", "width"], d
    assert d["slots"]["CLIPTextEncode"] == ["text"], d
    # 新式 io.ComfyNode.define_schema() 也要推得出来（ComfyUI ≥0.39 的节点都是这个形态）
    assert d["slots"]["NewStyleWan"] == ["height", "length", "width"], d
    assert d["modelLoaders"]["UNETLoader"] == ["unet_name"], d
    assert "CLIPTextEncode" not in d["modelLoaders"], d
    assert d["classes"] == 4, d
    print(json.dumps({"ok": True, "fixture": d}, ensure_ascii=False, indent=2))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--out")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--root", default=os.environ.get("COMFYUI_ROOT", ""),
                    help="ComfyUI 源码根目录；产物 _files 相对它，避免本机绝对路径")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    root = Path(args.root) if str(args.root).strip() else None
    paths = args.paths
    if not paths:
        # 默认扫 COMFYUI_ROOT 下的节点定义；没设就明确报错，不写死任何本机路径
        if root is None:
            print("未指定 .py 路径：请显式传路径，或设 COMFYUI_ROOT 指向 ComfyUI 源码根目录", file=sys.stderr)
            return 2
        paths = [str(root / "nodes.py")] + [str(p) for p in sorted((root / "comfy_extras").glob("nodes_*.py"))]
    out = derive_files(paths, root)
    if not out["_files"]:
        print("未扫到任何 .py —— 请显式传路径，或确认 ComfyUI 源码目录", file=sys.stderr)
        return 2
    text = json.dumps(out, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"written {args.out}: classes={out['classes']} slots={len(out['slots'])} loaders={len(out['modelLoaders'])}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
