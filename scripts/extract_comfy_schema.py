#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从本机 ComfyUI 源码提取「节点 -> 必需输入名」契约，生成 comfy-node-contract.json。

## 为什么需要这个
   2026-10-16 真实用户反馈暴露了 3 个致命 bug，全是**节点输入名写错**：
     · `LoadImage` 写成 `upload`（正确是 `image`）
     · `LoadImageMask` 漏了必需的 `channel`
     · `ControlNetInpaintingAliMamaApply` 漏了 strength/start_percent/end_percent
   已有的测试只验"结构"，不验"输入名"，所以全部漏过。
   本脚本把 ComfyUI **源码里的真实 schema** 固化成 JSON，供
   `scripts/test-workflow-contract.mjs` 做离线断言 —— 这样"输入名写错"再也不可能溜过去。

## 解析两种节点写法
   ① 老式：`class X: def INPUT_TYPES(s): return {"required": {...}}`
   ② 新式：`class X(io.ComfyNode): def define_schema(cls): return io.Schema(inputs=[io.T.Image("image"), ...])`
   并处理 `class LoadImageMask(LoadImage)` 这种**继承 + 追加**（把基类的 required 并进来）。

## 用法
   python scripts/extract_comfy_schema.py [ComfyUI 根目录]
   默认根目录按常见位置探测；输出同目录下的 comfy-node-contract.json。
"""
import ast
import io as _io
import json
import os
import re
import sys

CANDIDATE_ROOTS = [
    r'X:\ComfyUI-rocm\ComfyUI',
    r'X:\ComfyUI-AMD\ComfyUI',
    r'D:\ComfyUI',
    r'C:\ComfyUI',
]

# 同时扫描这些目录下的 .py（ComfyUI 自带节点 + comfy_extras）
SCAN_SUBDIRS = ['', 'comfy_extras']


def find_root(argv):
    if len(argv) > 1:
        return argv[1]
    for r in CANDIDATE_ROOTS:
        if os.path.isfile(os.path.join(r, 'nodes.py')):
            return r
    return None


def const_str(node):
    """取 ast 常量字符串（兼容 py3.8+ 的 ast.Constant）。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def dict_keys(d):
    """从 `{"required": {...}, "optional": {...}}` 的 Dict 节点里取 (required, optional) 键集合。"""
    req, opt = set(), set()
    if not isinstance(d, ast.Dict):
        return req, opt
    for k, v in zip(d.keys, d.values):
        name = const_str(k)
        if name not in ('required', 'optional') or not isinstance(v, ast.Dict):
            continue
        bucket = req if name == 'required' else opt
        for kk in v.keys:
            s = const_str(kk)
            if s is not None:
                bucket.add(s)
    return req, opt


def schema_input_names(call):
    """从 `io.Schema(inputs=[io.X.Input("name"), ...])` 里取输入名。"""
    names = set()
    if not isinstance(call, ast.Call):
        return names
    for kw in call.keywords:
        if kw.arg != 'inputs' or not isinstance(kw.value, ast.List):
            continue
        for el in kw.value.elts:
            if (isinstance(el, ast.Call)
                    and isinstance(el.func, ast.Attribute)
                    and el.func.attr == 'Input'
                    and el.args):
                s = const_str(el.args[0])
                if s is not None:
                    names.add(s)
    return names


def parse_file(path):
    """返回 {类名: {'required': set, 'bases': [基类名], 'schema': set}}"""
    try:
        with _io.open(path, 'r', encoding='utf-8', errors='replace') as f:
            tree = ast.parse(f.read())
    except Exception:
        return {}
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        bases = []
        for b in node.bases:
            if isinstance(b, ast.Name):
                bases.append(b.id)
            elif isinstance(b, ast.Attribute):
                bases.append(b.attr)
        info = {'required': set(), 'optional': set(), 'bases': bases, 'schema': set(), 'uses_super': False}
        for item in node.body:
            if not isinstance(item, ast.FunctionDef):
                continue
            # 老式 INPUT_TYPES
            if item.name == 'INPUT_TYPES':
                # ★ 关键判据：**只有调用了 `super().INPUT_TYPES()` 的才是"继承+追加"**
                #   （如 `LoadImageMask(LoadImage)`），这种要把基类的键并进来。
                #   而像 `LoraLoaderModelOnly(LoraLoader)` 那样**完整重写** required 的
                #   （不调 super），基类的键就**不该**继承 —— 否则会凭空多出
                #   `clip` / `strength_clip` 这类该节点根本没有的键，把契约污染成假的。
                for sub in ast.walk(item):
                    if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                            and sub.func.id == 'super'):
                        info['uses_super'] = True
                for sub in ast.walk(item):
                    if isinstance(sub, ast.Return) and sub.value is not None:
                        r, o = dict_keys(sub.value)
                        info['required'] |= r
                        info['optional'] |= o
            # 新式 define_schema
            if item.name == 'define_schema':
                for sub in ast.walk(item):
                    if isinstance(sub, ast.Return) and sub.value is not None:
                        info['schema'] |= schema_input_names(sub.value)
        out[node.name] = info
    return out


def main():
    root = find_root(sys.argv)
    if root is None:
        print('找不到 ComfyUI 根目录（可传参指定）：', file=sys.stderr)
        print('  ' + ' / '.join(CANDIDATE_ROOTS), file=sys.stderr)
        return 1

    all_classes = {}
    scanned = []
    for sub in SCAN_SUBDIRS:
        d = os.path.join(root, sub) if sub else root
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith('.py'):
                continue
            p = os.path.join(d, fn)
            got = parse_file(p)
            if got:
                scanned.append(os.path.relpath(p, root).replace('\\', '/'))
                all_classes.update(got)

    # 处理继承：**仅当子类显式调用了 `super().INPUT_TYPES()`** 才把基类的键并进来
    #   （`LoadImageMask` 就是这种：super() 之后追加 `channel`）。
    #   完整重写 INPUT_TYPES 的子类（如 `LoraLoaderModelOnly`）不合并 —— 见上面的注释。
    for name, info in list(all_classes.items()):
        if not info.get('uses_super'):
            continue
        seen = set()
        stack = list(info['bases'])
        while stack:
            b = stack.pop()
            if b in seen:
                continue
            seen.add(b)
            base = all_classes.get(b)
            if base:
                info['required'] |= base['required']
                info['optional'] |= base['optional']
                info['schema'] |= base['schema']
                stack.extend(base['bases'])

    contract = {}
    for name, info in all_classes.items():
        req, opt, sch = set(info['required']), set(info['optional']), set(info['schema'])
        if not req and not opt and not sch:
            continue
        contract[name] = {
            'required': sorted(req),
            'optional': sorted(opt),
            # 新式 schema 里的输入也一并列出（来源不同，分开存便于追溯）
            'schemaInputs': sorted(sch),
        }

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'comfy-node-contract.json')
    # ★ 脱敏：盘符统一成占位 `X:`（与仓库其它发布文件的脱敏规则一致）。
    #   本机真实盘符不该出现在发布物里；同步回源目录时再还原。
    root_display = re.sub(r'^[A-Za-z]:', 'X:', root.replace('\\', '/'))
    payload = {
        '_comment': '由 scripts/extract_comfy_schema.py 从 ComfyUI 源码解析生成，勿手改。',
        '_sourceRoot': root_display,
        '_scannedFiles': sorted(scanned),
        'nodes': contract,
    }
    with _io.open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)

    print('根目录 :', root)
    print('扫描文件:', len(scanned))
    print('提取节点:', len(contract))
    for k in ('LoadImage', 'LoadImageMask', 'ControlNetInpaintingAliMamaApply', 'KSampler', 'VAEDecode'):
        if k in contract:
            c = contract[k]
            keys = c['required'] or c['schemaInputs']
            print(f'  {k}: {keys[:12]}')
    print('已写出:', out_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
