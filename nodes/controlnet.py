"""ControlNet：按结构（边缘 / 深度 / 姿态）约束生成。

这是把 ComfyUI 自带的 `ControlNetLoader` + `ControlNetApplyAdvanced`
两个节点合成一个，省掉手动接线；**不引入任何第三方依赖**。

⚠ 权重需你自己放进 `ComfyUI/models/controlnet/`（本包**不自动下载**任何权重）。
"""

import folder_paths

CATEGORY = "Qwen Image Optimized/ControlNet"


class QwenImageControlNetApply:
    """加载 ControlNet 权重并施加到正/负条件上。"""

    @classmethod
    def INPUT_TYPES(cls):
        cnets = folder_paths.get_filename_list("controlnet")
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "image": ("IMAGE",),
                "control_net_name": (cnets,),
                "strength": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 10.0, "step": 0.01}),
                "start_percent": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "end_percent": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "STRING")
    RETURN_NAMES = ("positive", "negative", "report")
    FUNCTION = "apply"
    CATEGORY = CATEGORY
    DESCRIPTION = "千问 ControlNet：加载权重并施加到条件上（结构约束）。权重需自备，本包不下载。"

    def apply(self, positive, negative, image, control_net_name,
              strength, start_percent, end_percent):
        from nodes import ControlNetApplyAdvanced, ControlNetLoader

        cnet = ControlNetLoader().load_controlnet(control_net_name)[0]
        pos, neg = ControlNetApplyAdvanced().apply_controlnet(
            positive, negative, cnet, image, strength, start_percent, end_percent)
        report = (
            "【ControlNet】\n"
            f"  ✔ 已施加：{control_net_name}\n"
            f"    · strength={strength} 生效区间={start_percent}→{end_percent}\n"
            "  ℹ 若结构约束太强导致画面发僵，把 strength 降到 0.5~0.7 试试。"
        )
        return (pos, neg, report)
