#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Markdown 里的 $...$ / $$...$$ 公式分批用 MathJax 预渲染成自包含内联 SVG。

小页面渲染，避免大文档里 MathJax 来不及执行；结果直接插回最终 HTML，
Zotero 网页快照无需执行任何脚本即可显示公式。
"""
import html as html_mod
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 只用标准库，任何 python3 均可运行；浏览器缺失时公式降级为文本，不影响主流程
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]
CHROME = next((p for p in CHROME_CANDIDATES if Path(p).exists()), None)


def _resolve_mathjs():
    """定位 MathJax 的 tex-svg.js。

    正常情况：插件从 .xpi 安装时，JS 侧会把 converter/ 解压到
    <profile>/mktero-bilingual-converter/<版本>/，这里就有一份。

    但 2MB 的单文件走 Zotero 的 jar 通道解压并不总是成功（读出来可能是空串，
    解压目录里只剩一个空的 vendor/），于是留后路：直接从装好的 .xpi 里读。
    两者都拿不到就返回原路径，调用方会按「缺文件」降级成 LaTeX 文本。
    """
    local = HERE / "vendor" / "tex-svg.js"
    try:
        if local.exists() and local.stat().st_size > 4096:
            return local
    except OSError:
        pass

    candidates = []
    env_xpi = os.environ.get("MKTERO_XPI", "")
    if env_xpi:
        candidates.append(Path(env_xpi))
    # 安装态布局：<profile>/mktero-bilingual-converter/<ver>/ 的对门是
    # <profile>/extensions/*.xpi
    for parent in HERE.parents:
        try:
            candidates.extend(sorted(parent.glob("extensions/*.xpi")))
        except OSError:
            continue
        if len(candidates) > 6:
            break

    for xpi in candidates:
        try:
            if not xpi.is_file():
                continue
            with zipfile.ZipFile(xpi) as z:
                data = z.read("converter/vendor/tex-svg.js")
        except (OSError, KeyError, zipfile.BadZipFile):
            continue
        if len(data) <= 4096:
            continue
        out = Path(tempfile.gettempdir()) / "mktero-tex-svg.js"
        try:
            out.write_bytes(data)
            return out
        except OSError:
            continue
    return local


MATHJS = _resolve_mathjs()
CONFIG = (
    "window.MathJax={"
    "tex:{inlineMath:[['$','$']],displayMath:[['$$','$$']],processEscapes:false},"
    "svg:{fontCache:'local'},"
    "startup:{typeset:true}"
    "};"
)


def _replace_braced(tex, cmd, repl):
    """把 \\cmd{...} 换成 \\repl{...}，兼容命令与花括号间有空格，并支持嵌套括号。"""
    out, i = [], 0
    while True:
        j = tex.find(cmd, i)
        if j < 0:
            out.append(tex[i:])
            break
        out.append(tex[i:j])
        k = j + len(cmd)
        while k < len(tex) and tex[k].isspace():
            k += 1
        if k < len(tex) and tex[k] == "{":
            depth, m = 0, k
            while m < len(tex):
                if tex[m] == "{":
                    depth += 1
                elif tex[m] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                m += 1
            out.append(repl + "{" + tex[k + 1:m] + "}")
            i = m + 1
        else:
            out.append(cmd)
            i = k
    return "".join(out)


def adapt_tex(tex):
    """适配 MinerU 导出的 LaTeX 写法到 tex-svg.js 支持的命令集。"""
    return _replace_braced(tex, "\\boldsymbol", "\\pmb")
FORMULA_RE = r"\$\$[\s\S]*?\$\$|\$[^$\n]+\$"
STYLE_RE = re.compile(r"<style[^>]*>([\s\S]*?)</style>", re.I)


def collect(md_text):
    seen, out = set(), []
    for m in re.finditer(FORMULA_RE, md_text):
        t = m.group(0)
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _run_batch(chunk, out_dir, js_uri, tag, budget, timeout=180):
    """渲染一批公式，返回 (dict, MathJax CSS 片段列表)。"""
    if not CHROME:
        return {}, []
    cells = "".join(
        '<div id="f%d">%s</div>' % (j, html_mod.escape(adapt_tex(t)))
        for j, t in enumerate(chunk)
    )
    page = (
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        "<script>" + CONFIG + "</script>"
        '<script src="' + js_uri + '"></script></head><body>'
        + cells + "</body></html>"
    )
    tmp = out_dir / ("_formula_%s.html" % tag)
    tmp.write_text(page, encoding="utf-8")
    got, styles = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix="fmj-") as td:
            r = subprocess.run(
                [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                 "--user-data-dir=" + td, "--allow-file-access-from-files",
                 "--virtual-time-budget=%d" % budget,
                 "--dump-dom", tmp.resolve().as_uri()],
                capture_output=True, timeout=timeout,
            )
        dom = r.stdout.decode("utf-8", "replace")
        for s in STYLE_RE.findall(dom):
            if "mjx-container" in s and s not in styles:
                styles.append(s)
        if "<mjx-container" in dom:
            for j, t in enumerate(chunk):
                m = re.search(r'<div id="f%d"[^>]*>([\s\S]*?)</div>' % j, dom)
                if not m:
                    continue
                inner = m.group(1)
                if "<mjx-container" in inner:
                    got[t] = inner
    except Exception as e:
        print("  ! 公式批次 %s 失败：%s" % (tag, e), file=sys.stderr)
    finally:
        tmp.unlink(missing_ok=True)
    return got, styles


def render(md_text, out_dir, batch=4, verbose=True, batch_timeout=180):
    """返回 (dict: 公式文本 -> SVG HTML 片段, MathJax CSS 文本, 统计)。"""
    formulas = collect(md_text)
    if not MATHJS.exists() or not CHROME:
        return {}, "", (0, len(formulas), len(formulas))

    js_uri = MATHJS.resolve().as_uri()
    out_dir = Path(out_dir)
    result, styles = {}, []

    for start in range(0, len(formulas), batch):
        got, ss = _run_batch(formulas[start:start + batch], out_dir, js_uri,
                             str(start), 20000, timeout=batch_timeout)
        result.update(got)
        for s in ss:
            if s not in styles:
                styles.append(s)

    missing = [t for t in formulas if t not in result]
    if missing and verbose:
        print("  · 逐个重试 %d 个未渲染公式" % len(missing))
    for i, t in enumerate(missing):
        got, ss = _run_batch([t], out_dir, js_uri, "r%d" % i, 30000,
                             timeout=batch_timeout)
        result.update(got)
        for s in ss:
            if s not in styles:
                styles.append(s)

    failed = sum(1 for t in formulas if t not in result)
    css = "\n".join(styles)
    stats = (len(result), len(formulas), failed)
    if verbose:
        print("  · 公式预渲染：%d/%d 成功%s" % (
            stats[0], stats[1], ("，%d 个保留为 LaTeX 文本" % failed) if failed else "",
        ))
    return result, css, stats


if __name__ == "__main__":
    md = Path(sys.argv[1]).read_text(encoding="utf-8")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "out"
    res, css, st = render(md, out)
    print("unique:", st[1], "rendered:", st[0], "css bytes:", len(css))
    if res:
        k = next(iter(res))
        print("sample:", k[:60], "=>", res[k][:120])
