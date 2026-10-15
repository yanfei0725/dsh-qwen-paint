#!/usr/bin/env python3
"""生成 `workflows/` 下的工作流模板。

## 为什么要"生成"而不是手写 JSON
手写 JSON 模板迟早会和 `api.build_workflow` 漂移 —— 代码改了、模板没改，
于是"照模板跑"和"照代码跑"是两种行为（本项目最反感的一类问题）。
⇒ 所以模板**由代码生成**，两边永远一致。改了 `api.py` 只需重跑本脚本。
"""

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import api as qapi  # noqa: E402

OUT = os.path.join(ROOT, "workflows")
# ⚠ 文件名一律用 **ASCII**：实测 comfy-cli 打包 zip 时处理非 ASCII 路径会失败
#   （报 "File not found. Not including in zip"），模板就漏发了。
os.makedirs(OUT, exist_ok=True)


def dump(name, wf):
    body = qapi.strip_meta(wf)
    path = os.path.join(OUT, name)
    # ⚠ 用 io.open 显式写 + newline='\n'，写完立即在本进程内回读复查
    # （本项目踩过"当场写成功、事后文件没了"的坑）
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with io.open(path, "r", encoding="utf-8") as f:
        back = json.load(f)
    assert len(back) == len(body), f"{name}: 回读节点数不一致 {len(back)} != {len(body)}"
    return len(body)


# ① 文生图
wf1 = qapi.build_workflow(
    prompt="一只橘猫趴在黄昏的屋顶上，逆光，胶片质感",
    negative_prompt="模糊、变形、低分辨率",
    width=1024, height=1024, seed=0,
    precision="auto", shift_preset="auto", wrapper_mode="auto")

# ② 图生图（改图）：参考图来自 LoadImage 节点 "100"
wf2 = qapi.build_workflow(
    prompt="把这张图改成夜晚，加霓虹灯",
    width=1024, height=1024, seed=0,
    reference_image_node=("100", 0))
wf2["100"] = {"class_type": "LoadImage", "inputs": {"image": "example.png"}}

# ③ ControlNet：控制图来自 LoadImage 节点 "101"
wf3 = qapi.build_workflow(
    prompt="按这张边缘图重画，赛博朋克风格",
    width=1024, height=1024, seed=0,
    control_image_node=("101", 0),
    control_net_name="qwen_canny.safetensors",
    control_strength=0.8)
wf3["101"] = {"class_type": "LoadImage", "inputs": {"image": "control.png"}}

n1 = dump("01-t2i.json", wf1)
n2 = dump("02-img2img.json", wf2)
n3 = dump("03-controlnet.json", wf3)

readme = """# 工作流模板（ComfyUI **API 格式**）

这些文件由 `scripts/make_workflows.py` **从 `api.build_workflow` 生成**，
**不是手抄的** —— 所以永远不会和代码漂移。改了 `api.py` 重跑一次即可。

| 文件 | 节点数 | 用途 |
|---|---:|---|
| `01-t2i.json` | {n1} | 文生图 |
| `02-img2img.json` | {n2} | 给参考图改图（latent 取自参考图尺寸） |
| `03-controlnet.json` | {n3} | 给控制图（边缘/深度/姿态）做结构约束 |

## 怎么用

**① 程序化（推荐）**
```bash
python scripts/generate.py --prompt "..." --size 1024x1024 --seed 42
```

**② 接进你自己的工作流**
把里面的节点拷进你的 JSON，按 `[节点id, 输出序号]` 重新接线即可 ——
它们是**普通 ComfyUI 节点**，不是黑盒，你想插放大、插批处理都行。

**③ 直接提交**
```python
import json, sys; sys.path.insert(0, ".")
import api
wf = json.load(open("workflows/01-t2i.json", encoding="utf-8"))
print(api.submit(wf))
```

## ⚠ 两条注意
- 这是 **API 格式**（给 `/prompt` 提交用的），**不是**带界面坐标的 UI 格式。
- 模板里的模型名是**占位**（`unet_name` 等为空或示例），
  请按你机器上 `models/` 里**实际的文件名**替换，否则 ComfyUI 会报找不到文件。
""".format(n1=n1, n2=n2, n3=n3)

with io.open(os.path.join(OUT, "README.md"), "w", encoding="utf-8", newline="\n") as f:
    f.write(readme)

print(f"✓ 01-t2i.json ({n1} 节点)")
print(f"✓ 02-img2img.json ({n2} 节点)")
print(f"✓ 03-controlnet.json ({n3} 节点)")
print("✓ workflows/README.md")
