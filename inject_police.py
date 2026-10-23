#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在原型图之上叠加 SVG 警帽+警服（奶龙警官）。原型图本体不动，保持 100% 相似。"""

TARGETS = [
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\src\page.html",
    r"C:\Users\15515\Desktop\大学作业\1\scam-sim\dist\scam-sim.html",
]

# 警帽+警服 叠加层（viewBox 0 0 100 100，坐标按原型图实测比例）
OVERLAY = (
'<svg class="mascot-ov" viewBox="0 0 100 100" aria-hidden="true">'
# 警帽帽檐（先画，垫在帽体下沿）
'<ellipse cx="47.7" cy="22" rx="21" ry="3.4" fill="#2f3e7c" stroke="#16130d" stroke-width="1.3"/>'
# 帽体（圆顶，盖住头顶）
'<path d="M29 22 C 29 4 66.4 4 66.4 22 Z" fill="#2f3e7c" stroke="#16130d" stroke-width="1.6"/>'
# 帽徽（金星）
'<path d="M47.7 9 l1.6 3.4 3.9 .5 -2.8 2.7 .7 3.9 -3.4 -1.8 -3.4 1.8 .7 -3.9 -2.8 -2.7 3.9 -.5z" fill="#f4c430" stroke="#16130d" stroke-width="0.9"/>'
# 肩章
'<rect x="18" y="42" width="13" height="8" rx="3" fill="#2f3e7c" stroke="#16130d" stroke-width="1.3"/>'
'<rect x="64.4" y="42" width="13" height="8" rx="3" fill="#2f3e7c" stroke="#16130d" stroke-width="1.3"/>'
'<circle cx="24.5" cy="46" r="1.5" fill="#f4c430"/>'
'<circle cx="70.9" cy="46" r="1.5" fill="#f4c430"/>'
# 警服胸/领（海军蓝横带）
'<path d="M18 47 Q 47.7 53 77 47 L 77 61 Q 47.7 67 18 61 Z" fill="#2f3e7c" stroke="#16130d" stroke-width="1.4"/>'
# 红领带
'<path d="M44 39 L51.4 39 L49 47 L47.7 55 L46.4 47 Z" fill="#d6342c" stroke="#16130d" stroke-width="1"/>'
# 警徽（胸标）
'<ellipse cx="47.7" cy="64" rx="6" ry="7" fill="#f4c430" stroke="#16130d" stroke-width="1.2"/>'
'<path d="M47.7 60 l1.2 2.5 2.8 .4 -2 2 0.5 2.8 -2.5 -1.3 -2.5 1.3 .5 -2.8 -2 -2 2.8 -.4z" fill="#16130d"/>'
'</svg>'
)

OLD_INJECT = 'if (el) el.innerHTML = \'<img class="mascot-img" alt="奶龙宝宝" src="\' + MASCOT_IMG + \'">\';'
NEW_INJECT = 'if (el) el.innerHTML = \'<img class="mascot-img" alt="奶龙警官" src="\' + MASCOT_IMG + \'">\' + MASCOT_OV;'

OLD_FORACH = "['mascotHero', 'mascotSide'].forEach((id) => {"
NEW_FORACH = "const MASCOT_OV = `" + OVERLAY + "`;\n['mascotHero', 'mascotSide'].forEach((id) => {"

CSS_DISC = ".mascot .disc{width:186px;height:186px;border-radius:50%;background:#fff;overflow:hidden;border:var(--bd);"
CSS_DISC_NEW = ".mascot .disc{width:186px;height:186px;border-radius:50%;background:#fff;overflow:hidden;border:var(--bd);position:relative;"
CSS_FACE = ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:#fff;overflow:hidden;border:var(--bd-thin);"
CSS_FACE_NEW = ".mascot-card .face{width:46px;height:46px;border-radius:13px;background:#fff;overflow:hidden;border:var(--bd-thin);position:relative;"
CSS_OV = "\n.mascot-ov{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}\n"

# 文案：奶龙宝宝 -> 奶龙警官（吉祥物标签）
TXT_FIXES = [
    ("上号！奶龙宝宝陪你练一轮", "上号！奶龙警官陪你练一轮"),
    ("奶龙宝宝在线", "奶龙警官在线"),
    ("奶龙宝宝 · 盯梢中", "奶龙警官 · 盯梢中"),
]

COMMENT_OLD = """/* ══════════════ 吉祥物：奶龙宝宝（原型图，100% 相似） ══════════════
 * 直接用用户给的原型照片（base64 内嵌），保证和原型 100% 一致；
 * 仍是「单文件、双击即用」——base64 内联不算外部依赖。
 * 容器背景改成白底，贴合原型图的白底；img 用 object-fit:contain 居中。
 */"""
COMMENT_NEW = """/* ══════════════ 吉祥物：奶龙警官（原型图 + SVG 警帽警服） ══════════════
 * 原型照片 base64 内嵌（本体 100% 相似），其上再叠一层 SVG 警帽+警服：
 *   - 本体是用户给的奶娃原型，绝不改；
 *   - 警帽/警服是矢量叠加层（.mascot-ov），任意尺寸清晰，吃设计令牌配色；
 *   - 容器 position:relative，img 铺满 + svg 绝对定位叠在上面。
 */"""

for path in TARGETS:
    with open(path, "r", encoding="utf-8") as f:
        s = f.read()
    for a, b in [(OLD_INJECT, NEW_INJECT), (OLD_FORACH, NEW_FORACH),
                 (CSS_DISC, CSS_DISC_NEW), (CSS_FACE, CSS_FACE_NEW),
                 (COMMENT_OLD, COMMENT_NEW)] + [(t, n) for t, n in TXT_FIXES]:
        assert a in s, f"NOT FOUND in {path}:\n{a[:60]}"
        s = s.replace(a, b)
    if ".mascot-ov{" not in s:
        s = s.replace(".mascot-img{width:100%;height:100%;object-fit:contain;display:block}",
                      ".mascot-img{width:100%;height:100%;object-fit:contain;display:block}" + CSS_OV)
    with open(path, "w", encoding="utf-8") as f:
        f.write(s)
    print("updated:", path)
print("done")
