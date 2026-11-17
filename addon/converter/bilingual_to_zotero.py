#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bilingual_to_zotero.py

把 Mktero 导出的「英文原文段 / 中文译文段逐块交替」的【单篇】Markdown
转成可挂回 Zotero 的单文件 HTML（网页快照附件）与可选 PDF。

  - 按中文字符占比自动识别原文块 / 译文块，相邻两块配成一组对照
  - 图片从 assets/ 内嵌为 data URI，HTML 完全自包含、离线可用
  - 公式用 MathJax tex-svg 预渲染为内联 SVG（无外部字体/CDN 依赖）
  - 窄屏上下对照，宽屏 (>=1000px) 自动左右两栏；图片/表格强制上下

用法:
  python3 bilingual_to_zotero.py --md "/path/论文.md" --out /path/out
  python3 bilingual_to_zotero.py --md ... --out ... --no-pdf --no-math
"""

import argparse
import base64
import html as html_mod
import mimetypes
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import formula_svg

CHROME ="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = Path(__file__).resolve().parent
MATHJS = HERE / "vendor" / "tex-svg.js"

MATH_CONFIG = (
    "<script>window.MathJax={"
    "tex:{inlineMath:[['$','$']],displayMath:[['$$','$$']],processEscapes:false},"
    "svg:{fontCache:'local'},"
    "options:{skipHtmlTags:['script','noscript','style','textarea','pre','code']},"
    "startup:{typeset:true}"
    "};</script>"
)

CSS = r"""
:root{--ink:#1d1d20;--muted:#68686e;--line:#e6e7ea;--trans:#f5f7fa;--blue:#5b7fd6;--meta:#eef1f7}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
@page{size:A4;margin:14mm 16mm}
body{margin:0;background:#fff;color:var(--ink);
 font:15px/1.8 Georgia,"Iowan Old Style","Songti SC","Noto Serif CJK SC",serif}
.wrap{max-width:46rem;margin:0 auto;padding:1.6rem 1rem 3rem}
.doc-title{font:700 1.9rem/1.34 Georgia,"Songti SC",serif;margin:0 0 .7rem;letter-spacing:-.01em}
.doc-title-zh{margin:0 0 1.8rem;padding:.5rem .95rem;background:var(--trans);
 border-left:3px solid var(--blue);font-size:1.08rem;color:#2a2a2e}
.doc-sub{display:none}
.toc{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:.9rem 1.2rem;margin:0 0 2.2rem}
.toc h2{font:500 .92rem Georgia,serif;margin:0 0 .45rem;color:var(--muted)}
.toc ol{margin:0;padding-left:1.25rem;columns:2;column-gap:1.8rem}
.toc li{break-inside:avoid;margin:.12rem 0;font-size:.86rem;line-height:1.55}
.toc a{color:var(--ink);text-decoration:none}
.bi-head{display:block;margin:2.1rem 0 .95rem;line-height:1.35;break-after:avoid;border:0;padding:0}
.bi-head .he{display:block;font:700 1.3rem/1.35 Georgia,"Songti SC",serif;color:#17171a}
.bi-head .hz{display:block;margin-top:.42rem;padding:.42rem .9rem;background:var(--trans);
 border-left:3px solid var(--blue);font-size:1rem;color:#2a2a2e}
.pair{display:block;margin:0;break-inside:avoid}
.pair .cell{padding:0}
.pair .orig{background:transparent;color:var(--ink);padding:.15rem 0}
.pair .trans{background:var(--trans);border-left:3px solid var(--blue);
 padding:.5rem .95rem;margin:.2rem 0 1.15rem;color:#26262a}
.solo{padding:.15rem 0 .8rem}
.solo.trans{background:var(--trans);border-left:3px solid var(--blue);padding:.5rem .95rem;margin:0 0 1rem}
.pair p,.solo p{margin:.25rem 0}
.pair img,.solo img,.figure img{max-width:100%;height:auto;display:block;margin:.7rem auto}
.figure{margin:.5rem 0;text-align:center;break-inside:avoid}
.figure figcaption,.caption{font-size:.82rem;color:var(--muted);line-height:1.6;text-align:left}
.footnote{font-size:.82rem;color:var(--muted);line-height:1.6;text-align:left;margin:.5rem 0}
table{border-collapse:collapse;width:100%;font-size:.84rem;margin:.6rem 0;break-inside:avoid}
th,td{border:1px solid var(--line);padding:.35rem .55rem;text-align:left}
th{background:#fafbfc}
ul,ol{padding-left:1.4rem;margin:.35rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:#f2f3f5;padding:.05em .3em;border-radius:3px}
code.math{color:#0f6e56;background:#eef7f3}
mjx-container{display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden}
mjx-container[display="true"]{display:block;text-align:center;margin:.55rem 0}
.math-block{margin:.8rem 0;text-align:center;overflow-x:auto;break-inside:avoid}
a{color:#2f5fa8;text-decoration:none}
.meta{background:var(--meta);border-radius:8px;padding:.7rem 1rem;margin:0 0 1.2rem}
.meta .meta-label{font-size:.82rem;color:#5b6478;margin:0 0 .35rem}
/* 引用与参考文献（arXiv 路线；与 md 路线共用同一份 CSS） */
.cite{color:#2f5fa8;font-size:.84em;text-decoration:none}
.cite:hover{text-decoration:underline}
.ref{color:#2f5fa8;font-size:.94em}
.arxiv-note{background:#fff8e8;border:1px solid #f0d8a0;border-radius:8px;
 padding:.7rem 1rem;margin:0 0 1.4rem;font-size:.86rem;color:#6b5316;line-height:1.6}
.bibliography{margin:2rem 0 0;padding:1rem 1.2rem;background:#fafbfc;
 border:1px solid var(--line);border-radius:8px;break-inside:auto}
.bibliography h2{font:500 1rem Georgia,"Songti SC",serif;margin:0 0 .6rem;color:var(--ink)}
.bibliography ol{margin:0;padding-left:1.5rem;columns:2;column-gap:1.8rem}
.bibliography li{break-inside:avoid;margin:.18rem 0;font-size:.8rem;
 line-height:1.5;color:#3a3a3f;word-break:break-word}
@media print{
 body{font-size:10.8pt;line-height:1.72}
 .wrap{max-width:none;padding:0}
 .toc{break-inside:avoid}
 .bi-head{break-after:avoid}
 .pair,.figure,table{break-inside:avoid}
 .pair.long{break-inside:auto}
 p{orphans:3;widows:3}
 .doc-title{font-size:20pt}
 a{color:inherit}
}
"""


CJK_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")


def safe_name(s, fallback="Untitled"):
    """把论文标题变成合法文件名。

    标题里常有 / : * ? 等字符（如 "BERT: Pre-training"、"A/B Testing"），
    直接拼路径会抛 FileNotFoundError，或把文件写进别的目录。
    """
    t = str(s or "").strip()
    t = t.replace(":", "：").replace("/", "-").replace("\\", "-")
    t = re.sub(r'[*?"<>|\x00-\x1f]', "-", t)
    t = re.sub(r"\s+", " ", t).strip(" .-")
    return t[:120] or fallback


def text_units(s):
    """把一块 Markdown 拆成「汉字数 / 拉丁字母数」，忽略标记符号与 URL。"""
    t = re.sub(r"<!--[\s\S]*?-->", " ", s)
    t = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", t)   # 图片：只留 alt
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)    # 链接：只留文字
    t = re.sub(r"https?://\S+", " ", t)
    return len(CJK_RE.findall(t)), len(re.findall(r"[A-Za-z]", t))


def cjk_stats(s):
    cjk = len(CJK_RE.findall(s))
    total = len(re.sub(r"\s", "", s))
    return cjk, cjk / max(1, total)


def is_zh(block):
    """判断一块是中文译文还是英文原文。

    旧规则「至少 4 个汉字」会把「引言 / 摘要 / 结论 / 图 1」这类短标题判成英文，
    于是小标题配不上对、目录为空、双语标题缺失——短块必须单独放宽。
    """
    cjk, latin = text_units(block)
    if not cjk:
        return False
    words = latin / 4.5                      # 一个英文单词约 4.5 个字母的信息量
    ratio = cjk / (cjk + words)
    bare = block.strip()
    short = (bool(re.match(r"^#{1,6}\s", bare)) or bare.startswith("![")
             or (cjk + words) <= 8)
    if short:
        return ratio >= 0.5
    return cjk >= 3 and ratio >= 0.12


class ImgCache:
    def __init__(self, md_dir):
        self.md_dir = md_dir
        self.cache = {}
        self.embedded = 0
        self.missing = []
        self.formula_map = {}
        self.math_css = ""

    def get(self, ref):
        ref = ref.strip().split(" ")[0].replace("%20", " ")
        if ref.startswith(("http://", "https://", "data:")):
            return ref
        p = (self.md_dir / ref).resolve()
        if not p.exists():
            if ref not in self.missing:
                self.missing.append(ref)
            return ref
        if p not in self.cache:
            mime = mimetypes.guess_type(p.name)[0] or "image/png"
            self.cache[p] = "data:%s;base64,%s" % (
                mime,
                base64.b64encode(p.read_bytes()).decode("ascii"),
            )
            self.embedded += 1
        return self.cache[p]


def render_inline(text, imgs, math_on):
    """渲染行内 Markdown；公式先抽出占位，避免 html.escape 破坏 LaTeX 的 & 等字符。"""
    formulas = []

    def stash(m):
        formulas.append(m.group(0))
        return "\x00MATH%d\x00" % (len(formulas) - 1)

    text = re.sub(r"\$\$[\s\S]*?\$\$|\$[^$\n]+\$", stash, text)
    text = text.replace("\\[", "[").replace("\\]", "]")
    s = html_mod.escape(text, quote=False)

    def img_repl(m):
        alt, ref = m.group(1), m.group(2)
        alt = re.sub(r"\x00MATH\d+\x00", "[公式]", alt)
        return '<img src="%s" alt="%s">' % (
            imgs.get(ref),
            html_mod.escape(alt, quote=True),
        )

    s = re.sub(
        r"!\[(.*?)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", img_repl, s, flags=re.S
    )
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)

    for i, f in enumerate(formulas):
        svg = imgs.formula_map.get(f)
        rep = svg or ('<code class="math">%s</code>' % html_mod.escape(f, quote=False))
        s = s.replace("\x00MATH%d\x00" % i, rep)
    return s


def render_block(block, imgs, math_on):
    """返回 (kind, html, plain, level)。"""
    # 剥离 Mktero 控制注释行（mktero-section 由 build_body 单独处理）；
    # 其后的正文（表格 footnote / 作者 bio）需保留，不能整块丢弃
    block = re.sub(r"^\s*<!--\s*mktero-(?!section)[^\n]*-->\s*\n?", "", block, flags=re.I)
    if not block.strip():
        return "skip", "", "", 0
    if re.fullmatch(r"\s*\$\$[\s\S]*?\$\$\s*", block):
        return "math", '<div class="math-block">%s</div>' % render_inline(
            block.strip(), imgs, math_on
        ), "", 0
    lines = [l.rstrip() for l in block.splitlines() if l.strip()]
    if not lines:
        return "para", "", "", 0

    # 清理 blockquote 前缀（Mktero 把表格 footnote / 作者 bio 写成 > 引用）
    is_bq = bool(lines) and all(l.lstrip().startswith(">") for l in lines)
    if is_bq:
        lines = [l.lstrip()[1:].lstrip() for l in lines]

    # 孤立的图注标注残留（如 "0.0208 (+100%) / 0.124"）：渲染为图注样式而非正文
    if not is_bq and re.match(
        r"^\s*\d+\.\d+\s*\([+-]?\d+%\)\s*/\s*\d+\.\d+\s*$", block
    ):
        return "para", '<p class="caption">%s</p>' % render_inline(
            block.strip(), imgs, math_on
        ), block.strip(), 0

    m = re.match(r"^(#{1,6})\s+(.*)$", lines[0])
    if m and len(lines) == 1:
        lvl = len(m.group(1))
        inner = render_inline(m.group(2), imgs, math_on)
        return "heading", "<h%d>%s</h%d>" % (lvl, inner, lvl), m.group(2), lvl

    if len(lines) >= 2 and lines[0].lstrip().startswith("|") and re.match(
        r"^\s*\|?[\s:|-]+\|\s*$", lines[1]
    ):
        cells = lambda l: [c.strip() for c in l.strip().strip("|").split("|")]
        head = cells(lines[0])
        body = [cells(l) for l in lines[2:] if l.strip().startswith("|")]
        h = "<table><thead><tr>" + "".join(
            "<th>%s</th>" % render_inline(c, imgs, math_on) for c in head
        ) + "</tr></thead><tbody>"
        h += "".join(
            "<tr>" + "".join(
                "<td>%s</td>" % render_inline(c, imgs, math_on) for c in row
            ) + "</tr>"
            for row in body
        )
        return "table", h + "</tbody></table>", " ".join(lines), 0

    if len(lines) == 1 and re.fullmatch(r"\s*!\[.*\]\([^)]+\)\s*", lines[0]):
        m2 = re.match(r"\s*!\[(.*)\]\(([^)\s]+)", lines[0])
        alt, ref = m2.group(1), m2.group(2)
        clean_alt = re.sub(r"\$\$[\s\S]*?\$\$|\$[^$\n]+\$", "[公式]", alt)
        clean_alt = clean_alt.replace("\\[", "[").replace("\\]", "]")
        return "figure", '<figure class="figure"><img src="%s" alt="%s"><figcaption>%s</figcaption></figure>' % (
            imgs.get(ref),
            html_mod.escape(clean_alt, quote=True),
            render_inline(alt, imgs, math_on),
        ), alt, 0

    if all(re.match(r"^\s*[-*]\s+", l) for l in lines):
        h = "<ul>" + "".join(
            "<li>%s</li>" % render_inline(re.sub(r"^\s*[-*]\s+", "", l), imgs, math_on)
            for l in lines
        ) + "</ul>"
        return "list", h, " ".join(lines), 0

    # 内嵌 HTML 表格（Mktero 导出格式）：保留标签并内嵌图片/公式
    stripped = block.strip()
    if stripped.lower().startswith("<table") and stripped.lower().endswith("</table>"):
        return "table", render_html_table(stripped, imgs), " ".join(lines), 0

    if is_bq:
        h = '<p class="footnote">' + "<br>".join(
            render_inline(l, imgs, math_on) for l in lines
        ) + "</p>"
    else:
        h = "<p>" + "<br>".join(render_inline(l, imgs, math_on) for l in lines) + "</p>"
    return "para", h, " ".join(lines), 0


def render_html_table(html_str, imgs):
    """处理 Mktero 导出的内嵌 HTML 表格：保留标签，内嵌图片、渲染公式。"""
    formulas = []

    def stash(m):
        formulas.append(m.group(0))
        return "\x00MATH%d\x00" % (len(formulas) - 1)

    s = re.sub(r"\$\$[\s\S]*?\$\$|\$[^$\n]+\$", stash, html_str)

    def img_src_repl(m):
        ref = m.group(1).strip().split(" ")[0]
        return '<img src="%s">' % imgs.get(ref)

    s = re.sub(r'<img\b[^>]*\bsrc="([^"]+)"[^>]*>', img_src_repl, s)
    s = re.sub(r"!\[[^\]]*\]\(([^)\s]+)\)",
               lambda m: '<img src="%s">' % imgs.get(m.group(1)), s)

    for i, f in enumerate(formulas):
        svg = imgs.formula_map.get(f)
        rep = svg or ('<code class="math">%s</code>' % f)
        s = s.replace("\x00MATH%d\x00" % i, rep)
    return s


def strip_heading(html):
    return re.sub(r"^<h\d[^>]*>|</h\d>$", "", html)


def split_heading_runs(blocks):
    """把「多行标题挤在同一块」拆成单行块。

    真实导出里英文标题和中文标题经常只隔一个换行（没有空行），
    整块会被当成正文并排成「# EN<br># ZH」——拆开才能正常配成对照。
    """
    out = []
    for b in blocks:
        lines = [l for l in b.splitlines() if l.strip()]
        if len(lines) > 1 and all(re.match(r"^\s{0,3}#{1,6}\s+\S", l) for l in lines):
            out.extend(l.strip() for l in lines)
        else:
            out.append(b)
    return out


SECTION_ON = re.compile(r"^[ \t]*<!--\s*mktero-section", re.I)
SECTION_OFF = re.compile(r"^[ \t]*<!--\s*/mktero-section", re.I)


def isolate_section_markers(text):
    """让 <!-- mktero-section --> 独占一块。

    导出文件里收尾注释经常紧跟在上一行后面（没有空行），整块就变成
    「作者…\n<!-- /mktero-section -->」，按块判断时永远关不掉状态，
    后面所有多行块（表格、列表）都会被逐行拆散。
    """
    return re.sub(
        r"(?m)^[ \t]*(<!--\s*/?mktero-section[^>]*-->)[ \t]*$",
        r"\n\1\n", text,
    )


def expand_meta_blocks(blocks):
    """元信息区（<!-- mktero-section -->）里一行一条，拆开才能配成对照。"""
    out, in_meta = [], False
    for b in blocks:
        if SECTION_ON.match(b):
            in_meta = True
            out.append(b)
            continue
        if SECTION_OFF.match(b):
            in_meta = False
            out.append(b)
            continue
        if in_meta and "\n" in b:
            out.extend(l.strip() for l in b.splitlines() if l.strip())
        else:
            out.append(b)
    return out


def build_body(md_path, math_on, imgs):
    text = isolate_section_markers(md_path.read_text(encoding="utf-8"))
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    blocks = expand_meta_blocks(split_heading_runs(blocks))

    out, toc, pending = [], [], None
    sec = [0]
    pairs = [0]
    doc = {}

    def flush():
        nonlocal pending
        if pending is not None:
            out.append('<div class="solo orig">%s</div>' % pending[1])
            pending = None

    for b in blocks:
        if b.startswith("<!-- mktero-section"):
            flush()
            out.append('<div class="meta"><p class="meta-label">文章信息 / Article information</p>')
            continue
        if b.startswith("<!-- /mktero-section"):
            flush()
            out.append("</div>")
            continue

        item = render_block(b, imgs, math_on)
        if item[0] == "skip":
            continue
        zh = is_zh(b)

        if not zh and pending is None:
            pending = item
        elif zh and pending is not None:
            pk, ph, _, plvl = pending
            ck, ch, _, clvl = item
            if pk == "heading" and ck == "heading":
                lvl = clvl or plvl or 2
                if lvl == 1 and not toc and pairs[0] == 0:
                    doc["zh"] = re.sub(r"<[^>]+>", "", strip_heading(ch))
                else:
                    sec[0] += 1
                    sid = "sec-%d" % sec[0]
                    toc.append((sid, re.sub(r"<[^>]+>", "", strip_heading(ch))))
                    out.append(
                        '<h%d id="%s" class="bi-head"><span class="he">%s</span>'
                        '<span class="hz">%s</span></h%d>'
                        % (lvl, sid, strip_heading(ph), strip_heading(ch), lvl)
                    )
            else:
                long = " long" if len(ph) + len(ch) > 1200 else ""
                out.append(
                    '<div class="pair%s"><div class="cell orig">%s</div>'
                    '<div class="cell trans">%s</div></div>' % (long, ph, ch)
                )
            pairs[0] += 1
            pending = None
        elif zh:
            out.append('<div class="solo trans">%s</div>' % item[1])
        else:
            flush()
            pending = item
    flush()

    first = next((b for b in blocks if re.match(r"^#\s+", b)), "")
    title = re.sub(r"^#\s+", "", first.splitlines()[0]) if first else md_path.stem
    zh_title = (
        '<p class="doc-title-zh">%s</p>' % html_mod.escape(doc["zh"])
        if doc.get("zh") else ""
    )
    toc_html = ""
    if toc:
        toc_html = '<nav class="toc"><h2>目录</h2><ol>' + "".join(
            '<li><a href="#%s">%s</a></li>' % (s, t) for s, t in toc
        ) + "</ol></nav>"

    body = (
        '<div class="wrap"><h1 class="doc-title">%s</h1>'
        "%s%s%s</div>"
    ) % (html_mod.escape(title), zh_title, toc_html, "".join(out))
    return body, len(blocks), pairs[0], toc


def page(body, math_css=""):
    head = (
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>双语论文</title><style>" + CSS + math_css + "</style>"
    )
    return '<!DOCTYPE html><html lang="zh-CN"><head>%s</head><body>%s</body></html>' % (head, body)


def math_render(stage_path, final_path):
    with tempfile.TemporaryDirectory(prefix="bimj-") as td:
        cmd = [
            CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--user-data-dir=" + td, "--allow-file-access-from-files",
            "--virtual-time-budget=45000",
            "--dump-dom", stage_path.resolve().as_uri(),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=240)
    dom = r.stdout.decode("utf-8", "replace")
    n = dom.count("<mjx-container")
    if n == 0:
        return 0, "MathJax 未产出公式容器（将回退为等宽公式文本）"
    dom = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", "", dom, flags=re.I)
    if not dom.lstrip().lower().startswith("<!doctype"):
        dom = "<!DOCTYPE html>\n" + dom
    final_path.write_text(dom, encoding="utf-8")
    return n, ""


def make_pdf(html_path, pdf_path):
    chrome = formula_svg.CHROME
    if not chrome:
        return False, "未找到 Chrome/Chromium，跳过 PDF"
    with tempfile.TemporaryDirectory(prefix="bipdf-") as td:
        cmd = [
            chrome, "--headless", "--disable-gpu", "--no-sandbox",
            "--user-data-dir=" + td, "--no-pdf-header-footer",
            "--allow-file-access-from-files", "--virtual-time-budget=15000",
            "--print-to-pdf=" + str(pdf_path), html_path.resolve().as_uri(),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=240)
    ok = pdf_path.exists() and pdf_path.stat().st_size > 2000
    return ok, (r.stderr.decode("utf-8", "replace")[-300:] if not ok else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", required=True, help="单篇双语 .md 路径")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--name", default="", help="输出文件名（不含扩展名）")
    ap.add_argument("--name-file", default="",
                    help="UTF-8 文件，从中读取输出文件名（避免进程参数编码损坏）")
    ap.add_argument("--no-math", action="store_true", help="不渲染公式（降级为等宽文本）")
    ap.add_argument("--no-pdf", action="store_true", help="不生成 PDF")
    a = ap.parse_args()

    md_path = Path(a.md).expanduser().resolve()
    out_dir = Path(a.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if not md_path.exists():
        sys.exit("找不到 md 文件：%s" % md_path)

    name = ""
    if a.name_file:
        nf = Path(a.name_file).expanduser().resolve()
        if nf.exists():
            name = nf.read_text(encoding="utf-8").strip()
    if not name:
        name = a.name or md_path.parent.name.strip() or md_path.stem[:40].strip()
    name = safe_name(name, "Untitled")
    md_text = md_path.read_text(encoding="utf-8")
    imgs = ImgCache(md_path.parent)
    if a.no_math:
        print("  · 公式保留为 LaTeX 文本（--no-math）")
    else:
        fmap, fcss, _ = formula_svg.render(md_text, out_dir)
        imgs.formula_map = fmap
        imgs.math_css = fcss

    body, nblocks, npairs, toc = build_body(md_path, False, imgs)
    final = out_dir / (name + ".html")
    final.write_text(page(body, imgs.math_css), encoding="utf-8")

    print("  · 输入：%s" % md_path.name)
    print("  · 块数 %d，原文/译文配对 %d 组，目录 %d 节" % (nblocks, npairs, len(toc)))
    print("  · 内嵌图片 %d 张%s" % (
        imgs.embedded,
        ("，缺失 %d 张：%s" % (len(imgs.missing), ", ".join(imgs.missing[:3]))) if imgs.missing else "",
    ))
    print("  · HTML：%s (%.2f MB)" % (final, final.stat().st_size / 1048576))

    if not a.no_pdf and formula_svg.CHROME:
        pdf = out_dir / (name + ".pdf")
        ok, err = make_pdf(final, pdf)
        print("  · PDF：%s%s" % (
            ("%s (%.2f MB)" % (pdf, pdf.stat().st_size / 1048576)) if ok else "生成失败 " + err,
            "",
        ))
    # 回写实际产物路径，供 Zotero 插件读取（不依赖文件名猜测）
    (out_dir / "_mktero_result.txt").write_text(str(final.resolve()), encoding="utf-8")
    print("完成。")


if __name__ == "__main__":
    main()
