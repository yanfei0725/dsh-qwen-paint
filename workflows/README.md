# 工作流模板（ComfyUI **API 格式**）

这些文件由 `scripts/make_workflows.py` **从 `api.build_workflow` 生成**，
**不是手抄的** —— 所以永远不会和代码漂移。改了 `api.py` 重跑一次即可。

| 文件 | 节点数 | 用途 |
|---|---:|---|
| `01-一键出图.json` | 7 | 文生图 |
| `02-图生图改图.json` | 7 | 给参考图改图（latent 取自参考图尺寸） |
| `03-ControlNet结构约束.json` | 10 | 给控制图（边缘/深度/姿态）做结构约束 |

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
wf = json.load(open("workflows/01-一键出图.json", encoding="utf-8"))
print(api.submit(wf))
```

## ⚠ 两条注意
- 这是 **API 格式**（给 `/prompt` 提交用的），**不是**带界面坐标的 UI 格式。
- 模板里的模型名是**占位**（`unet_name` 等为空或示例），
  请按你机器上 `models/` 里**实际的文件名**替换，否则 ComfyUI 会报找不到文件。
