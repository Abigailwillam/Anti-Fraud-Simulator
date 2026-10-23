#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64, re, sys

SRC_IMG = r"C:\Users\15515\Pictures\Screenshots\微信图片_20261023103649_77_61.jpg"
TARGETS = [
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\src\page.html",
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\dist\scam-sim.html",
]

with open(SRC_IMG, "rb") as f:
    b64 = base64.b64encode(f.read()).decode("ascii")

# 新吉祥物：直接用原型图（base64 内嵌，仍是单文件），与原型 100% 一致
NEW_JS = (
    "const MASCOT_IMG = 'data:image/jpeg;base64," + b64 + "';\n"
    "['mascotHero', 'mascotSide'].forEach((id) => {\n"
    "  const el = $(id);\n"
    "  if (el) el.innerHTML = '<img class=\"mascot-img\" alt=\"奶龙宝宝\" src=\"' + MASCOT_IMG + '\">';\n"
    "});"
)

# 注释头（SVG 说明 -> 图片说明），原样用于两文件
OLD_COMMENT = """/* ══════════════ 吉祥物：奶龙宝宝（奶娃） ══════════════
 * 用内联 SVG 而不是 emoji 或图片：
 *   - emoji 各平台长相不一，🐊🐲 都不是奶龙，认不出来；
 *   - 图片会让「单文件、双击即用」变成双文件，破坏交付形态；
 *   - 内联 SVG 直接吃设计令牌（--sun / --ink），换肤跟着走，
 *     且缩到 46px 的小头像位也还认得出是「圆滚滚的黄色小奶娃」。
 */"""

NEW_COMMENT = """/* ══════════════ 吉祥物：奶龙宝宝（原型图，100% 相似） ══════════════
 * 直接用用户给的原型照片（base64 内嵌），保证和原型 100% 一致；
 * 仍是「单文件、双击即用」——base64 内联不算外部依赖。
 * 容器背景改成白底，贴合原型图的白底；img 用 object-fit:contain 居中。
 */"""

# CSS 调整：容器白底 + 裁切；新增 .mascot-img
CSS_DISC_OLD = ".mascot .disc{width:186px;height:186px;border-radius:50%;background:var(--sun-soft);border:var(--bd);"
CSS_DISC_NEW = ".mascot .disc{width:186px;height:186px;border-radius:50%;background:#fff;overflow:hidden;border:var(--bd);"
CSS_FACE_OLD = ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:var(--sun-soft);border:var(--bd-thin);"
CSS_FACE_NEW = ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:#fff;overflow:hidden;border:var(--bd-thin);"
CSS_IMG_ADD = "\n.mascot-img{width:100%;height:100%;object-fit:contain;display:block}\n"

JS_PATTERN = re.compile(
    r"const MASCOT_SVG = `.*?`;\s*\['mascotHero', 'mascotSide'\]\.forEach\(\(id\) => \{.*?\}\);",
    re.DOTALL,
)

for path in TARGETS:
    with open(path, "r", encoding="utf-8") as f:
        s = f.read()
    assert OLD_COMMENT in s, f"comment not found in {path}"
    assert CSS_DISC_OLD in s, f"disc css not found in {path}"
    assert CSS_FACE_OLD in s, f"face css not found in {path}"
    assert JS_PATTERN.search(s), f"MASCOT_SVG block not found in {path}"

    s = s.replace(OLD_COMMENT, NEW_COMMENT)
    s = s.replace(CSS_DISC_OLD, CSS_DISC_NEW)
    s = s.replace(CSS_FACE_OLD, CSS_FACE_NEW)
    # 在 .disc svg 规则后追加 .mascot-img（只追加一次）
    if ".mascot-img{" not in s:
        s = s.replace(".mascot .disc svg{width:76%;height:76%;display:block}",
                      ".mascot .disc svg{width:76%;height:76%;display:block}" + CSS_IMG_ADD)
    s = JS_PATTERN.sub(NEW_JS, s)

    with open(path, "w", encoding="utf-8") as f:
        f.write(s)
    print("updated:", path)
print("done")
