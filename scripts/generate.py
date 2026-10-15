#!/usr/bin/env python3
"""命令行入口：不打开 ComfyUI 界面也能出图，方便接进脚本/批处理/别的工作流。

    # 出一张图（用当前 ComfyUI 里已装好的模型）
    python scripts/generate.py --prompt "一只在屋顶上的橘猫" --size 1024x1024

    # 指定模型 + 固定种子 + 存到本地
    python scripts/generate.py --prompt "..." --unet qwen_image_2.1_fp8.safetensors \\
        --clip qwen3vl_8b_w4a8.safetensors --vae qwen_image_2.1_vae_bf16.safetensors \\
        --seed 42 --save-dir ./out

    # 只生成图（JSON），不提交 —— 拿去自己改、或塞进别的工作流
    python scripts/generate.py --prompt "..." --dump-workflow wf.json --dry-run

⚠ 前提：ComfyUI 得**正在跑**（默认 http://127.0.0.1:8188）。本脚本只跟本机对话。
"""

import argparse
import json
import os
import sys

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PKG_DIR)

import api as qapi  # noqa: E402


def parse_size(text):
    w, h = (int(x) for x in text.lower().split("x"))
    return w, h


def main():
    p = argparse.ArgumentParser(description="千问 2.1 优化节点包 · 命令行出图")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative", default="")
    p.add_argument("--size", default="1024x1024", help="宽x高，例如 1024x1024 / 1152x896")
    p.add_argument("--unet", default="")
    p.add_argument("--clip", default="")
    p.add_argument("--vae", default="")
    p.add_argument("--precision", default="auto",
                   choices=["auto", "bf16", "fp8", "int8", "gguf"])
    p.add_argument("--preset", default="auto",
                   choices=["auto", "turbo8", "fast4", "native"],
                   help="工作点档位：turbo8 快；native 文字更准（约 3 倍时间）")
    p.add_argument("--wrapper", default="auto",
                   choices=["auto", "blockcache", "te_speedup", "none"])
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--steps", type=int, default=0, help="0 = 跟随档位（推荐）")
    p.add_argument("--cfg", type=float, default=0.0, help="0 = 跟随档位（推荐）")
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--server", default=qapi.DEFAULT_SERVER)
    p.add_argument("--timeout", type=float, default=600)
    p.add_argument("--save-dir", default="", help="把出的图存到这个目录")
    p.add_argument("--dump-workflow", default="", help="把生成的工作流 JSON 写到这个文件")
    p.add_argument("--dry-run", action="store_true", help="只拼图、不提交")
    args = p.parse_args()

    width, height = parse_size(args.size)
    wf = qapi.build_workflow(
        prompt=args.prompt, negative_prompt=args.negative,
        width=width, height=height,
        unet_name=args.unet, clip_name=args.clip, vae_name=args.vae,
        precision=args.precision, shift_preset=args.preset,
        wrapper_mode=args.wrapper, seed=args.seed,
        steps=(args.steps or None), cfg=(args.cfg or None),
        batch_size=args.batch)

    if args.dump_workflow:
        with open(args.dump_workflow, "w", encoding="utf-8") as f:
            json.dump(qapi.strip_meta(wf), f, ensure_ascii=False, indent=2)
        print(f"工作流已写到：{args.dump_workflow}")

    if args.dry_run:
        print(json.dumps(qapi.strip_meta(wf), ensure_ascii=False, indent=2))
        return 0

    print(f"提交到 {args.server} …")
    res = qapi.generate(server=args.server, timeout=args.timeout,
                        prompt=args.prompt, negative_prompt=args.negative,
                        width=width, height=height,
                        unet_name=args.unet, clip_name=args.clip, vae_name=args.vae,
                        precision=args.precision, shift_preset=args.preset,
                        wrapper_mode=args.wrapper, seed=args.seed,
                        steps=(args.steps or None), cfg=(args.cfg or None),
                        batch_size=args.batch)
    print(f"prompt_id: {res['prompt_id']}")
    if not res["images"]:
        print("⚠ 没拿到图片输出 —— 请到 ComfyUI 界面看该任务的报错。")
        return 1
    for img in res["images"]:
        print("  出图:", img.get("filename"), "|", img.get("subfolder"), "|", img.get("type"))

    if args.save_dir:
        os.makedirs(args.save_dir, exist_ok=True)
        base = args.server.rstrip("/")
        for img in res["images"]:
            url = f"{base}/view?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
            out = os.path.join(args.save_dir, img["filename"])
            try:
                with __import__("urllib.request").request.urlopen(url, timeout=120) as r, \
                        open(out, "wb") as f:
                    f.write(r.read())
                print("  已保存:", out)
            except Exception as exc:
                print(f"  ✗ 保存失败 {img.get('filename')}: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
