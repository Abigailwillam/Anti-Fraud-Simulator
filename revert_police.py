#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""撤销 inject_police.py：移除 SVG 警帽警服叠加层，还原到「奶龙宝宝（仅原型图）」状态。"""
import re

TARGETS = [
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\src\page.html",
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\dist\scam-sim.html",
]


def doit(path):
    with open(path, "r", encoding="utf-8") as f:
        s = f.read()
    log = []

    def rep(a, b, label):
        n = s.count(a)
        log.append(f"  [{label}] {n}x")
        return s.replace(a, b)

    # 1) 注入行：去掉 + MASCOT_OV，alt 改回 宝宝
    s = rep(
        "if (el) el.innerHTML = '<img class=\"mascot-img\" alt=\"奶龙警官\" src=\"' + MASCOT_IMG + '\">' + MASCOT_OV;",
        "if (el) el.innerHTML = '<img class=\"mascot-img\" alt=\"奶龙宝宝\" src=\"' + MASCOT_IMG + '\">';",
        "inject-line",
    )

    # 2) 删除 const MASCOT_OV = `...`; 整行（多行 SVG）
    before = s
    s = re.sub(r"const MASCOT_OV = `.*?`;\n", "", s, flags=re.S)
    log.append(f"  [MASCOT_OV-def] removed={'yes' if s != before else 'NO'}")

    # 3) disc 容器去掉 position:relative
    s = rep(
        ".mascot .disc{width:186px;height:186px;border-radius:50%;background:#fff;overflow:hidden;border:var(--bd);position:relative;",
        ".mascot .disc{width:186px;height:186px;border-radius:50%;background:#fff;overflow:hidden;border:var(--bd);",
        "disc-css",
    )

    # 4) face 容器去掉 position:relative
    s = rep(
        ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:#fff;overflow:hidden;border:var(--bd-thin);position:relative;",
        ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:#fff;overflow:hidden;border:var(--bd-thin);",
        "face-css",
    )

    # 5) 移除 .mascot-ov CSS 行
    before = s
    s = re.sub(r"\n\.mascot-ov\{[^}]*\}\n", "\n", s)
    log.append(f"  [mascot-ov-css] removed={'yes' if s != before else 'NO'}")

    # 6) 文案 警官 -> 宝宝
    s = rep("上号！奶龙警官陪你练一轮", "上号！奶龙宝宝陪你练一轮", "txt-bubble")
    s = rep("奶龙警官在线", "奶龙宝宝在线", "txt-live")
    s = rep("奶龙警官 · 盯梢中", "奶龙宝宝 · 盯梢中", "txt-stalk")

    # 7) 注释还原
    s = rep(
        "/* ══════════════ 吉祥物：奶龙警官（原型图 + SVG 警帽警服） ══════════════\n * 原型照片 base64 内嵌（本体 100% 相似），其上再叠一层 SVG 警帽+警服：\n *   - 本体是用户给的奶娃原型，绝不改；\n *   - 警帽/警服是矢量叠加层（.mascot-ov），任意尺寸清晰，吃设计令牌配色；\n *   - 容器 position:relative，img 铺满 + svg 绝对定位叠在上面。\n */",
        "/* ══════════════ 吉祥物：奶龙宝宝（原型图，100% 相似） ══════════════\n * 直接用用户给的原型照片（base64 内嵌），保证和原型 100% 一致；\n * 仍是「单文件、双击即用」——base64 内联不算外部依赖。\n * 容器背景改成白底，贴合原型图的白底；img 用 object-fit:contain 居中。\n */",
        "comment",
    )

    with open(path, "w", encoding="utf-8") as f:
        f.write(s)
    print("reverted:", path)
    print("\n".join(log))


for p in TARGETS:
    doit(p)
print("done")
