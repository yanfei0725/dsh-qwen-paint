"""**给外部程序用的调用接口**（不是 ComfyUI 节点）。

## 为什么需要这一层
上面那五个节点是**在 ComfyUI 界面里拖着用**的。但如果你想：
  · 从 Python / 脚本 / 别的系统里**批量出图**；
  · 把千问这条优化链**嵌进你自己的工作流**（接你自己的采样器、放大链、批处理）；
  · 或者只是想省掉手动画图、改 JSON；
那就需要一层**函数式接口**：你给参数，我返回一张**可以直接 POST 给 ComfyUI `/prompt`** 的图。

## 三种用法，从粗到细
| 用法 | 适合 |
| --- | --- |
| `generate(...)` | 一键：构建 → 提交 → 等结果 → 返回图片。最省事 |
| `build_workflow(...)` | 只要那张图（API 格式 JSON），你自己决定怎么提交/改 |
| `submit(workflow)` / `wait_for(...)` | 只提交或只等结果，配合你自己的流程 |

## ⚠ 两个前提
1. ComfyUI 得**正在跑**（默认 `http://127.0.0.1:8188`）—— 本模块只跟本机对话，不碰外网。
2. `build_workflow` **不加载模型、不占显存**，它只是拼 JSON；提交时才会真正跑。

## 关于节点 id
返回的图里每个节点有个字符串 id（"1"、"2"…）。**接线靠 `[节点id, 输出序号]`**。
ComfyUI 提交的是**这张图本身**，所以你拿去随便改（加放大节点、换采样器）都行 ——
这也是"方便接入不同工作流"的关键：**它是图，不是黑盒**。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

DEFAULT_SERVER = "http://127.0.0.1:8188"


class IdAlloc:
    """递增分配节点 id，保证图里不撞车。"""

    def __init__(self, start=1):
        self.n = start

    def take(self):
        s = str(self.n)
        self.n += 1
        return s


def build_workflow(
    prompt: str,
    *,
    negative_prompt: str = "",
    width: int = 1024,
    height: int = 1024,
    unet_name: str = "",
    clip_name: str = "",
    vae_name: str = "",
    precision: str = "auto",
    weight_dtype: str = "default",
    shift_preset: str = "auto",
    apply_turbo_lora: bool = True,
    lora_name: str = "(自动挑)",
    lora_strength: float = 1.0,
    apply_prefix_cache: bool = True,
    cache_device: str = "auto",
    cache_dtype: str = "int8",
    wrapper_mode: str = "auto",
    enable_rdna3_fa: bool = True,
    seed: int = 0,
    steps: int | None = None,
    cfg: float | None = None,
    batch_size: int = 1,
    sampler_name: str = "euler",
    scheduler: str = "simple",
    decode_mode: str = "auto",
    tile_size: int = 512,
    overlap: int = 64,
    reference_image_node: tuple[str, int] | None = None,
    control_image_node: tuple[str, int] | None = None,
    control_net_name: str = "",
    control_strength: float = 0.8,
) -> dict:
    """拼出一张**ComfyUI API 格式**的图（可直接 POST 给 `/prompt`）。

    ## 参数分组
    - **模型**：`unet_name` / `clip_name` / `vae_name` / `precision` / `weight_dtype`
      留空字符串表示"让 ComfyUI 用你节点上的默认值"（提交前请在界面或这里补上）。
    - **档位**：`shift_preset`（auto / turbo8 / fast4 / native）；
      `steps` / `cfg` 留空则**由节点按实际档位自己决定**（推荐）。
    - **加速**：`wrapper_mode` / `enable_rdna3_fa` / 前缀缓存。
    - **图生图 / ControlNet**：通过 `reference_image_node` / `control_image_node`
      传入**已有节点的输出**（格式 `("节点id", 输出序号)`），方便你把我们的链接进你自己的图。

    ⚠ **本函数不校验模型文件是否存在** —— 那是 ComfyUI 的事（不存在它会给明确报错）。
      这么设计是为了让本模块**不依赖 ComfyUI 环境**（纯拼 JSON）。
    """
    ids = IdAlloc()
    wf: dict[str, dict] = {}

    # ① 优化加载器
    loader_id = ids.take()
    wf[loader_id] = {
        "class_type": "QwenImageOptimizedLoader",
        "inputs": {
            "unet_name": unet_name,
            "precision": precision,
            "weight_dtype": weight_dtype,
            "clip_name": clip_name,
            "vae_name": vae_name,
            "width": int(width),
            "height": int(height),
            "shift_preset": shift_preset,
            "apply_turbo_lora": bool(apply_turbo_lora),
            "lora_name": lora_name,
            "lora_strength": float(lora_strength),
            "apply_prefix_cache": bool(apply_prefix_cache),
            "cache_device": cache_device,
            "cache_dtype": cache_dtype,
        },
    }
    model_ref = [loader_id, 0]
    clip_ref = [loader_id, 1]
    vae_ref = [loader_id, 2]

    # ② 文本编码
    enc_id = ids.take()
    enc_inputs = {
        "clip": clip_ref,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "vae": vae_ref,
        "resolution": round((int(width) * int(height)) ** 0.5),
    }
    if reference_image_node is not None:
        enc_inputs["images"] = {"image_1": list(reference_image_node)}
    wf[enc_id] = {"class_type": "TextEncodeQwenImage21", "inputs": enc_inputs}
    positive_ref = [enc_id, 0]
    negative_ref = [enc_id, 1]

    # ③ latent：有参考图就用编码器第 3 个输出，否则造空的
    if reference_image_node is not None:
        latent_ref = [enc_id, 2]
    else:
        latent_id = ids.take()
        wf[latent_id] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": int(width), "height": int(height), "batch_size": int(batch_size)},
        }
        latent_ref = [latent_id, 0]

    # ④ 加速链
    accel_id = ids.take()
    wf[accel_id] = {
        "class_type": "QwenImageAccelChain",
        "inputs": {
            "model": model_ref,
            "wrapper_mode": wrapper_mode,
            "width": int(width),
            "height": int(height),
            "enable_rdna3_fa": bool(enable_rdna3_fa),
            "enable_spectrum": False,
            "enable_sada": False,
        },
    }

    # ⑤ ControlNet（可选）
    if control_image_node is not None and control_net_name:
        cn_load = ids.take()
        wf[cn_load] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": control_net_name}}
        cn_apply = ids.take()
        wf[cn_apply] = {
            "class_type": "ControlNetApplyAdvanced",
            "inputs": {
                "positive": positive_ref,
                "negative": negative_ref,
                "control_net": [cn_load, 0],
                "image": list(control_image_node),
                "strength": float(control_strength),
                "start_percent": 0.0,
                "end_percent": 1.0,
            },
        }
        positive_ref = [cn_apply, 0]
        negative_ref = [cn_apply, 1]

    # ⑥ 采样
    ks_inputs = {
        "model": [accel_id, 0],
        "seed": int(seed),
        "cfg": float(cfg) if cfg is not None else 1.0,
        "sampler_name": sampler_name,
        "scheduler": scheduler,
        "positive": positive_ref,
        "negative": negative_ref,
        "latent_image": latent_ref,
        "denoise": 1.0,
    }
    # steps 留空时不写死 —— 但 KSampler 必须要 steps，这里给一个按档位的兜底值。
    # ⚠ 真正的"按实际档位"由节点保证；这里只是让图能提交。
    ks_inputs["steps"] = int(steps) if steps is not None else 8
    ks_id = ids.take()
    wf[ks_id] = {"class_type": "KSampler", "inputs": ks_inputs}

    # ⑦ 解码
    dec_id = ids.take()
    wf[dec_id] = {
        "class_type": "QwenImageTiledDecode",
        "inputs": {
            "samples": [ks_id, 0],
            "vae": vae_ref,
            "mode": decode_mode,
            "tile_size": int(tile_size),
            "overlap": int(overlap),
            "fallback_on_oom": True,
        },
    }
    out_id = ids.take()
    wf[out_id] = {"class_type": "PreviewImage", "inputs": {"images": [dec_id, 0]}}

    # 顺手把"关键节点 id"挂出去，方便调用方接着改图
    wf["__meta__"] = {
        "loader": loader_id, "encoder": enc_id, "accel": accel_id,
        "sampler": ks_id, "decoder": dec_id, "output": out_id,
    }
    return wf


def strip_meta(workflow: dict) -> dict:
    """去掉 `__meta__` —— **提交给 ComfyUI 之前必须调用**。

    ⚠ ComfyUI 只认数字/字符串节点 id，多一个非常规键会被当成节点校验失败。
    """
    return {k: v for k, v in workflow.items() if k != "__meta__"}


def _http(url, payload=None, timeout=60):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def submit(workflow: dict, server: str = DEFAULT_SERVER, client_id: str = "qwen-image-optimized"):
    """把图提交给正在跑的 ComfyUI。返回 `{"prompt_id": ..., "node_errors": ...}`。

    ⚠ ComfyUI 会在**图有错**时直接返回 `node_errors` —— 那时 `prompt_id` 为空。
      调用方应检查它，别盲目去等结果。
    """
    return _http(f"{server.rstrip('/')}/prompt", {"prompt": strip_meta(workflow), "client_id": client_id})


def wait_for(prompt_id, server: str = DEFAULT_SERVER, timeout: float = 600, poll: float = 1.0):
    """轮询 `/history/<prompt_id>` 直到出图完成。返回 history 条目（含 outputs）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            hist = _http(f"{server.rstrip('/')}/history/{prompt_id}", timeout=30)
            if prompt_id in hist:
                return hist[prompt_id]
        except urllib.error.HTTPError:
            pass
        time.sleep(poll)
    raise TimeoutError(f"等 {prompt_id} 超时（{timeout}s）—— 可能是出图慢，或 ComfyUI 没在跑")


def generate(server: str = DEFAULT_SERVER, timeout: float = 600, **kwargs):
    """一步到位：构建 → 提交 → 等结果。

    返回 `{"prompt_id": ..., "images": [...], "history": {...}, "workflow": {...}}`。
    `images` 里是 ComfyUI 输出的图片信息（filename / subfolder / type），
    要用 `/view?filename=...` 去取。

    ⚠ 本函数**会真的出图**（占显存、花时间）；只是想拿图请用 `build_workflow`。
    """
    wf = build_workflow(**kwargs)
    res = submit(wf, server=server)
    if res.get("node_errors"):
        raise RuntimeError(f"工作流被 ComfyUI 拒收：{json.dumps(res['node_errors'], ensure_ascii=False)[:800]}")
    pid = res.get("prompt_id")
    if not pid:
        raise RuntimeError(f"提交没拿到 prompt_id：{json.dumps(res, ensure_ascii=False)[:400]}")
    hist = wait_for(pid, server=server, timeout=timeout)
    images = []
    for node_out in (hist.get("outputs") or {}).values():
        images += node_out.get("images") or []
    return {"prompt_id": pid, "images": images, "history": hist, "workflow": wf}
