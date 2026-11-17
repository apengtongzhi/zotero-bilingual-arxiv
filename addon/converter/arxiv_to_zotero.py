#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arxiv_to_zotero.py — arXiv LaTeX 源码 -> 结构化双语 HTML（第一阶段）

与 bilingual_to_zotero.py / formula_svg.py 一样只用标准库，零 pip 依赖。
复用现有 CSS、MathJax 内联 SVG 公式渲染、图片 base64 内嵌。

设计要点
  1. 下载 arXiv e-print（tar.gz 或单个 tex.gz），安全解压
  2. 找主 .tex，递归展开 \\input / \\include，展开 \\newcommand 宏
  3. 抽结构化块：标题 / 段落 / 公式 / 表格 / 图片 / 列表
  4. 输出 arxiv_blocks.json（供翻译器消费）+ 带公式的 HTML 预览
  5. 翻译是可插拔接口：本脚本【不调用任何 LLM】。
     任意通道只要产出 {"block_id": "中文译文"} 的 JSON，
     用 --translation 传入即可合成逐块双语 HTML。

用法
  python3 arxiv_to_zotero.py --id 1706.03762 --out /path/out
  python3 arxiv_to_zotero.py --src /path/src.tar.gz --out /path/out
  python3 arxiv_to_zotero.py --id 1706.03762 --out /path/out --translation zh.json
"""
import argparse
import base64
import gzip
import html as html_mod
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bilingual_to_zotero as bz
import formula_svg

UA = "mktero-bilingual-arxiv/0.1 (local research tool)"
FORMULA_RE = formula_svg.FORMULA_RE

# 样式统一：三种入口（md / 文件夹 / arXiv LaTeX）共用 bilingual_to_zotero.CSS。
# 引用/参考文献样式已并入那份 CSS，这里不再附加任何私有样式。
EXTRA_CSS = ""


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


def log(*a):
    print("  ·", *a)


# ---------------------------------------------------------------- 通用工具
def read_braced(s, i):
    """s[i] 必须是 '{'，做花括号配对，返回 (内容, 结束位置+1)。"""
    if i >= len(s) or s[i] != "{":
        return "", i
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        elif c == "\\" and j + 1 < len(s):
            j += 1
        j += 1
    return s[i + 1:], len(s)


def strip_comments(text):
    """去掉未转义的 % 注释（保留 \\%）。"""
    out = []
    for line in text.splitlines():
        buf, i = [], 0
        while i < len(line):
            if line[i] == "%" and (i == 0 or line[i - 1] != "\\"):
                break
            buf.append(line[i])
            i += 1
        out.append("".join(buf))
    return "\n".join(out)


# ---------------------------------------------------------------- 下载与解压
# GhostScript 的可执行文件。插件拉起本脚本时 PATH 往往只有
# /usr/bin:/bin:/usr/sbin:/sbin，Homebrew 装的 gs 不在里面，
# 于是 shutil.which("gs") 返回 None，PDF/eps 图全部「未能定位」。
GS_CANDIDATES = [
    "/opt/homebrew/bin/gs",
    "/usr/local/bin/gs",
    "/opt/local/bin/gs",
    "/usr/bin/gs",
    "/snap/bin/gs",
]


def find_ghostscript():
    got = shutil.which("gs")
    if got:
        return got
    for c in GS_CANDIDATES:
        try:
            if Path(c).is_file():
                return c
        except OSError:
            continue
    return None


def fetch_source(arxiv_id, cache_dir, proxy=""):
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", arxiv_id)
    dest = cache_dir / (safe + ".gz")
    if dest.exists() and dest.stat().st_size > 1000:
        log("命中源码缓存：%s" % dest.name)
        return dest
    url = "https://export.arxiv.org/e-print/" + urllib.parse.quote(arxiv_id, safe="")
    log("下载 e-print：%s" % url)
    # curl 在本机对 arxiv 已验证可用，且比 urllib 更少受代理环境影响
    cmd = ["curl", "-sS", "-L", "--fail", "--max-time", "120", "-A", UA,
           "-o", str(dest), url]
    if proxy:
        cmd[1:1] = ["--proxy", proxy]
    r = subprocess.run(cmd, capture_output=True, timeout=150)
    if r.returncode != 0 or not dest.exists() or dest.stat().st_size < 1000:
        raise RuntimeError("arXiv 源码下载失败：%s" %
                           r.stderr.decode("utf-8", "replace")[-300:])
    log("下载完成：%.2f MB" % (dest.stat().st_size / 1048576))
    return dest


def unpack_source(gz, work_dir):
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    if tarfile.is_tarfile(str(gz)):
        with tarfile.open(str(gz), "r:*") as tf:
            members = []
            for m in tf.getmembers():
                p = Path(m.name)
                # 防路径穿越；跳过设备文件
                if p.is_absolute() or ".." in p.parts or not (m.isfile() or m.isdir()):
                    continue
                members.append(m)
            tf.extractall(str(work_dir), members=members)
        n = sum(1 for _ in work_dir.rglob("*") if _.is_file())
        log("解压 tar.gz：%d 个文件" % n)
    else:
        with gzip.open(str(gz), "rb") as f:
            data = f.read()
        (work_dir / "main.tex").write_bytes(data)
        log("单个 tex.gz：%.2f KB" % (len(data) / 1024))
    return work_dir


def find_main_tex(work_dir):
    cands = []
    for p in Path(work_dir).rglob("*.tex"):
        try:
            t = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "\\documentclass" in t and "\\begin{document}" in t:
            cands.append((len(t), p))
    if not cands:
        tex = list(Path(work_dir).rglob("*.tex"))
        if not tex:
            raise RuntimeError("源码里找不到任何 .tex 文件")
        return max(tex, key=lambda p: p.stat().st_size)
    # 主文件通常是骨架（最短），优先 main / ms / paper
    cands.sort(key=lambda x: (0 if x[1].stem.lower() in ("main", "ms", "paper", "arxiv") else 1, x[0]))
    p = cands[0][1]
    log("主文件：%s" % p.relative_to(work_dir))
    return p


# 必须有单词边界：否则 \includegraphics 会被误当成 \include 文件引用吞掉
INPUT_RE = re.compile(r"\\(?:input|include)(?![A-Za-z])\s*(?:\{([^}]*)\}|([^\s,;]+))")


def expand_inputs(text, base, depth=0, seen=None):
    if depth > 12:
        return text
    seen = seen if seen is not None else set()

    def repl(m):
        ref = (m.group(1) or m.group(2) or "").strip()
        if not ref:
            return ""
        p = (Path(base) / ref).resolve()
        if not p.suffix:
            p = p.with_suffix(".tex")
        if not p.exists() or str(p) in seen:
            return ""
        seen.add(str(p))
        # 子文件同样要去注释：否则 \input 进来的 % 注释会泄漏进表格/正文
        sub = strip_comments(p.read_text(encoding="utf-8", errors="replace"))
        return "\n" + expand_inputs(sub, p.parent, depth + 1, seen) + "\n"

    return INPUT_RE.sub(repl, text)


MACRO_HEAD = re.compile(r"\\(?:newcommand|renewcommand|providecommand)\s*\*?\s*")


def collect_macros(text):
    macros = {}
    for m in MACRO_HEAD.finditer(text):
        i, name = m.end(), None
        if i < len(text) and text[i] == "{":
            inner, j = read_braced(text, i)
            name, i = inner.strip().lstrip("\\"), j
        else:
            mm = re.match(r"\\([A-Za-z@]+)", text[i:])
            if mm:
                name, i = mm.group(1), i + mm.end()
        if not name:
            continue
        nargs = 0
        mm = re.match(r"\s*\[(\d+)\]", text[i:])
        if mm:
            nargs, i = int(mm.group(1)), i + mm.end()
        mm = re.match(r"\s*\{", text[i:])
        if not mm:
            continue
        i += mm.end() - 1
        body, _ = read_braced(text, i)
        macros[name] = (nargs, body)
    return macros


def expand_macros(text, macros, rounds=2):
    for _ in range(rounds):
        for name, (nargs, body) in list(macros.items()):
            pat = re.compile(r"\\" + re.escape(name) + r"(?![A-Za-z])")
            if nargs == 0:
                text = pat.sub(lambda m, b=body: " " + b + " ", text)
            elif nargs == 1:
                text = re.sub(
                    r"\\" + re.escape(name) + r"(?![A-Za-z])\s*\{([^{}]*)\}",
                    lambda m, b=body: b.replace("#1", m.group(1)), text,
                )
    return text


def drop_braced_commands(text, names):
    """整段删掉 \\title{...} / \\author{...} / \\bibliography{...} 这类命令。
    read_braced 支持嵌套花括号，	hanks{} 里再套 	extbf{} 也不会漏。
    """
    for name in names:
        for _ in range(20):
            m = re.search(r"\\" + name + r"\s*(?:\[[^\]]*\])?\s*\{", text)
            if not m:
                break
            _, j = read_braced(text, m.end() - 1)
            text = text[:m.start()] + "\n\n" + text[j:]
    return text


def document_body(text):
    m = re.search(r"\\begin\{document\}", text)
    body = text[m.end():] if m else text
    m2 = re.search(r"\\end\{document\}", body)
    body = body[:m2.start()] if m2 else body
    # 元信息已经在页头用 extract_metadata 抽过了，这里必须删干净：
    # 否则整段 	itle / uthor / 	hanks 会变成正文第一段
    body = drop_braced_commands(body, (
        "thanks", "title", "author", "date", "institute", "affiliation",
        "bibliographystyle", "bibliography", "addbibresource", "bibliographyfont",
    ))
    # \printbibliography / \maketitle 这类无参命令
    body = re.sub(r"\\(?:printbibliography|printbibliographies)\b", "", body)
    # 关键词环境：保留内容，只换掉外壳（正文里会有用）
    body = re.sub(r"\\begin\{(IEEEkeywords|keywords)\}([\s\S]*?)\\end\{\1\}",
                  lambda mm: "\n\n" + mm.group(2).strip() + "\n\n", body)
    return body


FORMAT_ENV_RE = re.compile(
    r"\\begin\{(center|flushleft|flushright|small|large|normalsize)\}"
    r"([\s\S]*?)\\end\{\1\}"
)


def extract_metadata(text, arxiv_id=""):
    """从展开后的 preamble/正文抽 title 与作者列表，供页头与 meta 区使用。"""
    title, authors = "", []

    def grab(cmd):
        m = re.search(r"\\" + cmd + r"\s*\{", text)
        if not m:
            return ""
        inner, _ = read_braced(text, m.end() - 1)
        return clean_meta(inner)

    def clean_meta(s):
        s = re.sub(r"\\(?:thanks|footnote|email|AND|texorpdfstring)\s*\{([^{}]*)\}",
                   "", s)
        s = re.sub(r"\\(?:and|AND|\\)\s*", " ", s)
        s = re.sub(r"\\[A-Za-z@]+\s*(?:\{[^{}]*\})?", "", s)
        s = s.replace("{", "").replace("}", "").replace("~", " ")
        return re.sub(r"\s+", " ", s).strip()

    title = grab("title")
    author_raw = ""
    m = re.search(r"\\author\s*\{", text)
    if m:
        author_raw, _ = read_braced(text, m.end() - 1)
        # 先剥掉 \thanks{...} / \email{...} / \footnote{...}（带嵌套括号）
        def strip_note(s, cmd):
            while re.search(r"\\" + cmd + r"\s*\{", s):
                mm = re.search(r"\\" + cmd + r"\s*\{", s)
                _, j = read_braced(s, mm.end() - 1)
                s = s[:mm.start()] + " " + s[j:]
            return s
        for cmd in ("thanks", "footnote", "email"):
            author_raw = strip_note(author_raw, cmd)
        # 按 \AND 切分作者；每段取单位/换行前的姓名
        ORG = re.compile(r"universit|institut|college|laborator|research|brain|"
                         r"inc\b|ltd\b|corp|academy|school|department|google|microsoft|"
                         r"deepmind|facebook|amazon|apple\b", re.I)
        # LaTeX 重音/特殊字母命令还原（{\L}ukasz -> Łukasz 等）
        accents = {r"\L": "Ł", r"\l": "ł", r"\O": "Ø", r"\o": "ø",
                   r"\ae": "æ", r"\AE": "Æ", r"\oe": "œ", r"\OE": "Œ",
                   r"\ss": "ß", r"\aa": "å", r"\AA": "Å"}
        for cmd, ch in accents.items():
            author_raw = re.sub(re.escape(cmd) + r"\b", ch, author_raw)
            author_raw = author_raw.replace("{" + ch + "}", ch)
        for seg in re.split(r"\\AND|\\and|\\\\", author_raw):
            seg = re.sub(r"\\[A-Za-z@]+\s*\{[^{}]*\}", " ", seg)
            seg = re.sub(r"\\[A-Za-z@]+", " ", seg)
            seg = re.sub(r"\[\d+\]", " ", seg)        # 去 [1] 脚注标记
            seg = seg.replace("{", "").replace("}", "").replace("~", " ")
            seg = re.sub(r"\s+", " ", seg).strip(" ,;.:\n")
            # 按换行取第一行为姓名；.org 单位行直接跳过
            first = seg.split("\n")[0].strip()
            name = " ".join(first.split()[:4])
            if (not name or ORG.search(name) or not 2 < len(name) < 60
                    or name in authors):
                continue
            authors.append(name)
            if len(authors) >= 12:
                break
    if not title:
        title = arxiv_id or "arXiv 论文"
    return title, authors


def strip_layout(text):
    """清掉纯排版命令，保留内容；结构化环境（figure/table/...）不动。"""
    # center / flush 等环境：去掉外壳，内容留作普通段落
    text = FORMAT_ENV_RE.sub(lambda m: "\n\n" + m.group(2).strip() + "\n\n", text)
    # \textcolor{red}{正文} -> 正文；\color{red} -> 删
    text = re.sub(r"\\textcolor\s*\{[^{}]*\}\s*\{([^{}]*)\}",
                  lambda m: m.group(1), text)
    text = re.sub(r"\\color(?:box)?\s*\{[^{}]*\}", "", text)
    # 带长度的空白命令
    text = re.sub(r"\\(?:vspace|hspace|vskip|hskip)\*?\s*(?:\{[^}]*\}|[^\s{]+)", "", text)
    # 裸格式命令
    text = re.sub(
        r"\\(?:large|Large|LARGE|huge|small|footnotesize|scriptsize|tiny|normalsize|"
        r"centering|noindent|maketitle|newpage|clearpage|linebreak|pagebreak|"
        r"raggedright|raggedleft|sloppy|bfseries|itshape|ttfamily|rmfamily|sffamily|"
        r"upshape|mdseries|itshape|em)(?![A-Za-z])", "", text)
    return text


# ---------------------------------------------------------------- 结构化解析
class Blocks:
    def __init__(self):
        self.items = []
        self.stash = {}

    def hold(self, kind, data):
        key = "\x00BLK%d\x00" % len(self.stash)
        self.stash[key] = (kind, data)
        return "\n\n" + key + "\n\n"

    def add(self, kind, **kw):
        d = {"id": "b%03d" % len(self.items), "type": kind}
        d.update(kw)
        self.items.append(d)
        return d


HEAD_RE = re.compile(r"\\(section|subsection|subsubsection|paragraph|subparagraph)\*?\s*")
HEAD_LVL = {"section": 2, "subsection": 3, "subsubsection": 4,
            "paragraph": 5, "subparagraph": 6}


def parse_blocks(text):
    B = Blocks()

    def keep(kind, data):
        return B.hold(kind, data)

    # display 定界符
    text = re.sub(r"\\\[([\s\S]*?)\\\]",
                  lambda m: "\n\n$$" + m.group(1) + "$$\n\n", text)
    # 数学环境（含 align / equation / gather ...）
    text = re.sub(
        r"\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math)\}"
        r"([\s\S]*?)\\end\{\1\}",
        lambda m: keep("math", m.group(2).strip()), text,
    )
    # 浮动体与列表（吃掉 \begin{figure}[h] / [t] 这类可选位置参数）
    text = re.sub(r"\\begin\{(figure\*?)\}\s*(?:\[[^\]]*\])?\s*([\s\S]*?)\\end\{\1\}",
                  lambda m: keep("figure", m.group(2)), text)
    text = re.sub(r"\\begin\{(table\*?)\}\s*(?:\[[^\]]*\])?\s*([\s\S]*?)\\end\{\1\}",
                  lambda m: keep("table", m.group(2)), text)
    text = re.sub(r"\\begin\{tabular\*?\}\s*\{[^}]*\}([\s\S]*?)\\end\{tabular\*?\}",
                  lambda m: keep("tabular", m.group(1)), text)
    text = re.sub(r"\\begin\{(itemize|enumerate)\}([\s\S]*?)\\end\{\1\}",
                  lambda m: keep("list", m.group(2)), text)

    # 摘要
    text = re.sub(r"\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}",
                  lambda m: "\n\n" + m.group(1).strip() + "\n\n", text)

    # 标题（手工扫描，需吃掉 {title}）
    out, i = [], 0
    while True:
        m = HEAD_RE.search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i:m.start()])
        j = m.end()
        if j < len(text) and text[j] == "{":
            title, nj = read_braced(text, j)
            # \section{Separate ... for {Text Modality}}：LaTeX 常用花括号
            # 保护大小写，渲染到 HTML 前要把这层壳去掉
            title = re.sub(r"\{([^{}\\]*)\}", r"\1", title)
            out.append("\n\n" + keep("heading", (HEAD_LVL[m.group(1)], title)) + "\n\n")
            i = nj
        else:
            out.append(m.group(0))
            i = j
    text = "".join(out)

    # 段落切分 + 还原占位
    for ch in re.split(r"\n\s*\n", text):
        ch = ch.strip()
        if not ch:
            continue
        keys = [k for k in B.stash if k in ch]
        if keys:
            for k in keys:
                kind, data = B.stash[k]
                extra = {}
                if kind == "heading":
                    extra["title_plain"] = data[1]   # 目录用原文标题
                B.add(kind, raw=data, **extra)
            leftover = ch
            for k in keys:
                leftover = leftover.replace(k, "")
            leftover = leftover.strip()
            if leftover:
                B.add("para", raw=leftover)
        else:
            B.add("para", raw=ch)
    return B.items


# ---------------------------------------------------------------- 引用编号
CITE_CMD = (r"\\(?:cite|citep|citet|citeauthor|citeyear|autocite|parencite|"
            r"textcite|citealp|citealt|footcite)[a-z]*")
CITE_RE = re.compile(CITE_CMD + r"\s*(?:\[[^\]]*\])*\s*\{([^}]*)\}")
REF_RE = re.compile(r"\\(?:ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}")
LABEL_RE = re.compile(r"\\label\s*\{([^}]*)\}")


def clean_bbl_text(s):
    """把 IEEEtran.bst 生成的 \\bibitem 正文清成可读的一行。"""
    # 宏定义 / 排版开关整行丢掉
    s = re.sub(r"\\(?:providecommand|csname|endcsname|typeout|BIBdecl|newblock|"
               r"BIBentry\w*|BIBforeignlanguage|spaceskip|fontdimen|language|"
               r"ifx|else|fi|expandafter|relax|protect)\b[^\n]*", " ", s)
    # 所有带参命令保留参数内容（\emph{...} / \bibinfo{...}{...} / \url{...} ...）
    for _ in range(5):
        s = re.sub(r"\\[A-Za-z@]+\s*\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\\[A-Za-z@]+", " ", s)
    s = s.replace("{", "").replace("}", "").replace("~", " ").replace("\\", "")
    s = s.replace("``", "\u201c").replace("''", "\u201d")
    s = s.replace("--", "\u2013")
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    return html_mod.escape(s)


def load_bbl(work_dir):
    """从 arXiv 源码自带的 .bbl 里读出真正的参考文献条目。

    很多论文（尤其 IEEEtran）会随源码提交编译好的 .bbl，里面是完整的
    作者/题名/期刊/年份；旧版只列 bibtex key（pokhrel2022understand 这种），
    等于没有参考文献。返回 (key_order, {key: 可读文本})。
    """
    try:
        files = sorted(Path(work_dir).glob("*.bbl"))
    except OSError:
        return [], {}
    if not files:
        return [], {}
    best_order, best_map = [], {}
    for f in files:
        try:
            raw = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        parts = re.split(r"\\bibitem\s*(?:\{([^}]*)\})?", raw)
        # split 结果：[前导, key1, 正文1, key2, 正文2, ...]
        order, entries = [], {}
        for i in range(1, len(parts) - 1, 2):
            key = (parts[i] or "").strip()
            body = parts[i + 1] if i + 1 < len(parts) else ""
            body = re.split(r"\\end\{thebibliography\}", body)[0]
            txt = clean_bbl_text(body)
            if key and len(txt) > 10:
                order.append(key)
                entries[key] = txt
        if len(order) > len(best_order):
            best_order, best_map = order, entries
    return best_order, best_map


class RefRegistry:
    """把 \cite{key} 映射成 [n]、把 \ref{tag} 映射成章节/图表号。

    arXiv 源码通常不含 .bbl，故按 key 首次出现顺序编号，保证正文引用一致；
    参考文献区列出 key→编号，用户可据此对照原文 bibliography。
    """

    def __init__(self, text, bbl_order=None, bib_entries=None):
        self.cite_num, self.cite_order = {}, []
        self.bib_entries = bib_entries or {}
        # 有 .bbl 时以它的顺序为准，正文编号才和文献列表对得上
        for key in (bbl_order or []):
            if key and key not in self.cite_num:
                self.cite_num[key] = len(self.cite_order) + 1
                self.cite_order.append(key)
        self.ref_map = {}
        self.fig_num, self.tab_num, self.sec_num = 0, 0, [0, 0, 0]

        # 文献：按首次出现顺序编号
        for m in CITE_RE.finditer(text):
            for key in m.group(1).split(","):
                key = key.strip()
                if key and key not in self.cite_num:
                    self.cite_num[key] = len(self.cite_order) + 1
                    self.cite_order.append(key)

        # 标签 -> 编号：按 label 在文中的出现顺序，结合前文最近的 section/figure/table
        # 先给每个 \label 记录它前面的上下文
        for m in LABEL_RE.finditer(text):
            tag = m.group(1)
            before = text[:m.start()]
            # 找该 label 所在/之前最近的结构命令
            secs = re.findall(r"\\(section|subsection|subsubsection)\*?\s*\{", before)
            # 这个 label 紧跟的结构命令（同一环境里）
            near = before[-400:]
            env_kind = None
            if re.search(r"\\begin\{figure", near) and not re.search(r"\\end\{figure", near):
                env_kind = "fig"
            elif re.search(r"\\begin\{table", near) and not re.search(r"\\end\{table", near):
                env_kind = "tab"
            if env_kind == "fig":
                self.fig_num += 1
                self.ref_map[tag] = "图 %d" % self.fig_num
            elif env_kind == "tab":
                self.tab_num += 1
                self.ref_map[tag] = "表 %d" % self.tab_num
            else:
                # 章节号：按 section/subsection 层级累加
                lvl = {"section": 0, "subsection": 1, "subsubsection": 2}
                # 统计各自出现次数
                nums = []
                for cmd in ("section", "subsection", "subsubsection"):
                    n = len(re.findall(r"\\" + cmd + r"\*?\s*\{", before))
                    if n:
                        nums.append((lvl[cmd], n))
                if nums:
                    # 用最近一层的编号组合，简化为依次拼接
                    self.ref_map[tag] = ".".join(str(n) for _, n in sorted(nums))
                else:
                    self.ref_map[tag] = tag

    def cite(self, keys):
        nums = []
        for k in keys.split(","):
            k = k.strip()
            if k in self.cite_num:
                nums.append(str(self.cite_num[k]))
        return "[%s]" % ",".join(nums) if nums else "[?]"

    def ref(self, tag):
        return self.ref_map.get(tag, tag)

    def bibliography_html(self):
        if not self.cite_order:
            return ""
        items = ""
        for k in self.cite_order:
            n = self.cite_num[k]
            txt = self.bib_entries.get(k) or html_mod.escape(k)
            items += '<li id="cite-%d"><span class="refnum">[%d]</span> %s</li>' % (n, n, txt)
        note = ("条目来自 arXiv 源码自带的 .bbl，编号与原文一致"
                if self.bib_entries else
                "源码未附带 .bbl，按首次引用顺序列出 BibTeX key")
        return ('<div class="bibliography"><h2>参考文献 / References</h2>'
                '<p class="meta-label">%s</p><ol>%s</ol></div>' % (note, items))


REFS = None   # 模块级引用表，由 main 初始化


def ref_span(val):
    """图 N 的交叉引用做成可点锚点，和 mktero 的 ref 样式保持一致。"""
    fm = re.match(r"^图\s*(\d+)$", str(val))
    if fm:
        return '<a class="ref" href="#fig-%s">%s</a>' % (fm.group(1), val)
    return '<span class="ref">%s</span>' % val


def render_inline_tex(s):
    """把 LaTeX 行内文本转成 HTML。

    关键：所有要产出 HTML 标签的元素（公式/引用/样式）都先抽成 \x00 占位符，
    全文 html.escape 之后再统一还原，杜绝标签被二次转义成可见文本。
    """
    slots = []

    def hold(html):
        slots.append(html)
        return "\x00SLOT%d\x00" % (len(slots) - 1)

    # 公式：保留 $...$ 原文，后续由 formula_svg 统一渲染
    s = re.sub(FORMULA_RE, lambda m: hold(m.group(0)), s)

    # 引用：用全局编号表，产出真标签（走占位符保护）
    def cite_repl(m):
        if REFS is None:
            return m.group(0)
        nums = []
        for k in m.group(1).split(","):
            k = k.strip()
            if k in REFS.cite_num:
                n = REFS.cite_num[k]
                nums.append('<a class="cite" href="#cite-%d">[%d]</a>' % (n, n))
        return hold("".join(nums)) if nums else hold('<span class="cite">[?]</span>')
    s = CITE_RE.sub(cite_repl, s)
    s = REF_RE.sub(
        lambda m: hold(ref_span(REFS.ref(m.group(1)) if REFS else m.group(1))), s)
    s = re.sub(r"\\url\s*\{([^}]*)\}", lambda m: m.group(1), s)
    s = re.sub(r"\\href\s*\{[^}]*\}\s*\{([^}]*)\}", lambda m: m.group(1), s)
    # 文本样式：内容先 escape，再包标签，整体占位保护
    for cmd, tag in (("textbf", "strong"), ("textit", "em"), ("emph", "em"),
                     ("texttt", "code"), ("textsf", "span"), ("textrm", "span")):
        def style_repl(m, t=tag):
            inner = html_mod.escape(m.group(1), quote=False)
            return hold("<%s>%s</%s>" % (t, inner, t))
        s = re.sub(r"\\" + cmd + r"\s*\{([^{}]*)\}", style_repl, s)
    s = re.sub(r"\\footnote\s*\{([^{}]*)\}",
               lambda m: "（注：%s）" % html_mod.escape(m.group(1), quote=False), s)
    s = re.sub(r"\\label\s*\{[^}]*\}", "", s)
    s = re.sub(r"\\([\&%_#$])", lambda m: m.group(1), s)
    s = s.replace("\\,", " ").replace("\\;", " ").replace("\\!", "")
    s = s.replace("\\ ", " ").replace("~", " ")
    s = s.replace("---", "—").replace("--", "–")
    # 未知带参命令保留内容，裸命令丢弃
    s = re.sub(r"\\[A-Za-z@]+\s*\{([^{}]*)\}", lambda m: m.group(1), s)
    s = re.sub(r"\\[A-Za-z@]+\*?", "", s)
    s = s.replace("{", "").replace("}", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = html_mod.escape(s, quote=False)
    # escape 之后统一还原占位符（标签保持为真 HTML）
    for k, frag in enumerate(slots):
        s = s.replace("\x00SLOT%d\x00" % k, frag)
    return s.strip()


PH = "\u27e6F%d\u27e7"              # 公式占位符 ⟦F0⟧
PH_CITE = "\u27e6cite_%s\u27e7"     # 文献引用占位符 ⟦cite_3⟧（编号稳定）
PH_REF = "\u27e6ref_%s\u27e7"       # 交叉引用占位符 ⟦ref_图 2⟧


def plain_text(s):
    """给翻译器用的纯文本：公式抽成占位符后清理命令，公式绝不进 LLM。

    返回 (可译文本, 公式原文列表)；译后用该列表把占位符还原成内联 SVG。
    """
    formulas = []

    def stash(m):
        formulas.append(m.group(0))
        return PH % (len(formulas) - 1)

    s = re.sub(FORMULA_RE, stash, s)
    # 引用占位符带编号/目标，译文里多个引用不会塌成同一个 [引用]
    def cite_ph(m):
        if REFS is None:
            return PH_CITE % "?"
        nums = [str(REFS.cite_num[k.strip()]) for k in m.group(1).split(",")
                if k.strip() in REFS.cite_num]
        return PH_CITE % ("_".join(nums) if nums else "?")
    s = CITE_RE.sub(cite_ph, s)
    def ref_ph(m):
        val = REFS.ref(m.group(1)) if REFS else m.group(1)
        return PH_REF % val
    s = REF_RE.sub(ref_ph, s)
    s = re.sub(r"\\[A-Za-z@]+\s*\{([^{}]*)\}", lambda m: m.group(1), s)
    s = re.sub(r"\\[A-Za-z@]+\*?", "", s)
    s = s.replace("{", "").replace("}", "").replace("~", " ")
    return re.sub(r"\s+", " ", s).strip(), formulas


# ---------------------------------------------------------------- 图表
INC_RE = re.compile(r"\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")


def find_captions(content):
    caps, i = [], 0
    while True:
        j = content.find("\\caption", i)
        if j < 0:
            break
        k = j + len("\\caption")
        mm = re.match(r"\s*(?:\[[^\]]*\])?\s*", content[k:])
        k += mm.end() if mm else 0
        if k < len(content) and content[k] == "{":
            t, nk = read_braced(content, k)
            caps.append(t)
            i = nk
        else:
            i = k
    return caps


def resolve_image(ref, work_dir, out_dir, gs_bin):
    ref = ref.strip()
    base = Path(ref)
    cands = [base] + [base.with_suffix(e) for e in
                      (".png", ".jpg", ".jpeg", ".pdf", ".eps", ".PNG", ".JPG")]
    p = next(((Path(work_dir) / c) for c in cands
              if (Path(work_dir) / c).is_file()), None)
    if p is None:
        # 有些源码把图放在 figures/ 子目录但引用里省略了目录
        name = base.name
        hits = [q for q in Path(work_dir).rglob(name + ".*") if q.is_file()]
        p = hits[0] if hits else None
    if p is None:
        return None
    if p.suffix.lower() in (".pdf", ".eps") and gs_bin:
        dst = Path(out_dir) / ("_fig_%d.png" % abs(hash(str(p))))
        if not dst.exists():
            try:
                subprocess.run(
                    [gs_bin, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-q",
                     "-sDEVICE=png16m", "-r130", "-sOutputFile=" + str(dst), str(p)],
                    capture_output=True, timeout=120,
                )
            except Exception:
                return None
        p = dst if dst.exists() else None
        if p is None:
            return None
    if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        return None
    mime = mimetypes.guess_type(p.name)[0] or "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(p.read_bytes()).decode("ascii"))


def render_figure(raw, work_dir, out_dir, gs_bin):
    refs = INC_RE.findall(raw)
    imgs, missing = [], 0
    for ref in refs[:4]:
        uri = resolve_image(ref, work_dir, out_dir, gs_bin)
        if uri:
            imgs.append(uri)
        else:
            missing += 1
    caps = find_captions(raw)
    cap = render_inline_tex(caps[0]) if caps else ""
    parts = ['<figure class="figure">']
    for u in imgs:
        parts.append('<img src="%s" alt="">' % u)
    if missing:
        parts.append('<figcaption class="caption">（%d 张图未能定位）%s</figcaption>' % (missing, cap))
    elif cap:
        parts.append("<figcaption>%s</figcaption>" % cap)
    parts.append("</figure>")
    return "".join(parts), cap


def render_table(raw):
    rows = []
    for chunk in re.split(r"\\\\(?:\[[^]]*\])?", raw):
        chunk = re.sub(r"\\(?:hline|cline\{[^}]*\}|toprule|midrule|bottomrule|cmidrule\{[^}]*\})",
                       "", chunk).strip()
        chunk = re.sub(r"^\\(?:begin|end)\{[^}]*\}", "", chunk).strip()
        if not chunk:
            continue
        cells = []
        for c in chunk.split("&"):
            c = c.strip()
            colspan = 1
            mm = re.match(r"\\multicolumn\{(\d+)\}\{[^}]*\}\{", c)
            if mm:
                colspan = int(mm.group(1))
                inner, _ = read_braced(c, mm.end() - 1)
                c = inner
            mm = re.match(r"\\multirow\{(\d+)\}\{[^}]*\}\{", c)
            if mm:
                inner, _ = read_braced(c, mm.end() - 1)
                c = inner
            c = re.sub(r"\\(?:hline|cline\{[^}]*\})", "", c)
            cells.append((colspan, render_inline_tex(c)))
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    h = ["<table><tbody>"]
    for ri, row in enumerate(rows):
        h.append("<tr>")
        tag = "th" if ri == 0 else "td"
        for cs, val in row:
            attr = ' colspan="%d"' % cs if cs > 1 else ""
            h.append("<%s%s>%s</%s>" % (tag, attr, val, tag))
        h.append("</tr>")
    h.append("</tbody></table>")
    return "".join(h)


# ---------------------------------------------------------------- 组装 HTML
def block_html(b, work_dir, out_dir, gs_bin):
    """返回 (原文 HTML, 可译纯文本, 公式原文列表)。"""
    kind, raw = b["type"], b.get("raw", "")
    if kind == "heading":
        lvl, title = raw
        h = "<h%d class=\"bi-head\">%s</h%d>" % (lvl, render_inline_tex(title), lvl)
        t, fs = plain_text(title)
        return h, t, fs
    if kind == "math":
        return '<div class="math-block">$$%s$$</div>' % raw, "", []
    if kind == "figure":
        h, cap = render_figure(raw, work_dir, out_dir, gs_bin)
        caps = find_captions(raw)
        t, fs = plain_text(caps[0]) if caps else ("", [])
        return h, ("图注：" + t) if t else "", fs
    if kind in ("table", "tabular"):
        return render_table(raw), "", []
    if kind == "list":
        items = re.findall(r"\\item\s+([\s\S]*?)(?=\\item\s|$)", raw)
        lis = "".join("<li>%s</li>" % render_inline_tex(x.strip()) for x in items if x.strip())
        t, fs = plain_text(" ".join(items))
        return "<ul>%s</ul>" % lis, t, fs
    h = "<p>%s</p>" % "<br>".join(
        render_inline_tex(x) for x in raw.splitlines() if x.strip())
    t, fs = plain_text(raw)
    return h, t, fs


def finalize_formulas(blocks_html, fmap):
    def repl(m):
        t = m.group(0)
        svg = fmap.get(t)
        return svg or ('<code class="math">%s</code>' % html_mod.escape(t, quote=False))
    return re.sub(FORMULA_RE, repl, blocks_html)


def restore_ph(zh, formulas, fmap):
    """把译文里的占位符还原：公式→内联 SVG，cite→可点编号，ref→图/表/节号。"""
    s = html_mod.escape(zh)
    # ⟦cite_1_2⟧ -> [1,2]（每个编号可点到参考文献区）
    def cite_back(m):
        nums = [n for n in m.group(1).split("_") if n.isdigit()]
        if not nums:
            return '<span class="cite">[?]</span>'
        return "".join('<a class="cite" href="#cite-%s">[%s]</a>' % (n, n) for n in nums)
    s = re.sub(r"\u27e6cite_([^\u27e7]*)\u27e7", cite_back, s)
    # ⟦ref_图 2⟧ -> 图 2
    def ref_back(m):
        val = m.group(1)
        fm = re.match(r"^图\s*(\d+)$", val)
        if fm:
            return '<a class="ref" href="#fig-%s">%s</a>' % (fm.group(1), val)
        return '<span class="ref">%s</span>' % val
    s = re.sub(r"\u27e6ref_([^\u27e7]*)\u27e7", ref_back, s)
    for i, f in enumerate(formulas or []):
        svg = fmap.get(f)
        if svg is None:
            svg = '<code class="math">%s</code>' % html_mod.escape(f, quote=False)
        s = s.replace(PH % i, svg)
    return s


def build_html(blocks, rendered, translation, fmap, math_css, note,
               title="", authors=None, arxiv_id=""):
    """排版完全对齐 Mktero 双语快照：真实标题+中文标题 / 目录 / 双语标题 / pair 对照。"""
    authors = authors or []
    tr = translation or {}

    # 页头：英文主标题 + 中文标题
    # 中文标题只认专门的 __title__ 键（由翻译器单独翻），不拿版权声明等普通段落冒充
    zh_title = tr.get("__title__", "").strip()

    parts = ['<div class="wrap">']
    parts.append('<h1 class="doc-title">%s</h1>' % html_mod.escape(title or "arXiv 论文"))
    if zh_title:
        parts.append('<p class="doc-title-zh">%s</p>' % html_mod.escape(zh_title))

    # 先扫一遍 heading，生成目录（锚点 sec-N，与 Mktero 一致）
    # 顺序与 Mktero 保持一致：标题 → 中文标题 → 目录 → meta
    toc, sec = [], [0]
    for b in blocks:
        if b["type"] == "heading":
            sec[0] += 1
            toc.append(("sec-%d" % sec[0], b, sec[0]))

    if toc:
        toc_items = []
        for sid, b, idx in toc:
            zh = tr.get(b["id"], "").strip()
            label = zh or re.sub(r"<[^>]+>", "", str(b.get("title_plain", "")))
            toc_items.append('<li><a href="#%s">%s</a></li>'
                             % (sid, html_mod.escape(label or ("章节 %d" % idx))))
        parts.append('<nav class="toc"><h2>目录</h2><ol>%s</ol></nav>' % "".join(toc_items))

    if authors:
        parts.append('<div class="meta"><p class="meta-label">作者 / Authors%s</p>'
                     '<p>%s</p></div>'
                     % ((" · arXiv:" + arxiv_id) if arxiv_id else "",
                        html_mod.escape(", ".join(authors))))
    elif arxiv_id:
        parts.append('<div class="meta"><p class="meta-label">arXiv:%s</p></div>'
                     % html_mod.escape(arxiv_id))
    if note:
        parts.append('<div class="arxiv-note">%s</div>' % html_mod.escape(note))

    # 正文：heading 双语合并成 bi-head；其余 pair 对照
    sec_i = 0
    fig_i = 0
    zh_n = 0
    for b, (h, plain, formulas) in zip(blocks, rendered):
        if b["type"] == "figure":
            fig_i += 1
            label = '<span class="figlabel">图 %d</span> ' % fig_i
            h = h.replace('<figure class="figure">',
                          '<figure class="figure" id="fig-%d">' % fig_i, 1)
            if "<figcaption" in h:
                h = re.sub(r"(<figcaption[^>]*>)", r"\1" + label, h, count=1)
            else:
                h = h.replace("</figure>", "<figcaption>%s</figcaption></figure>" % label)
        zh = tr.get(b["id"], "").strip()
        if b["type"] == "heading":
            sec_i += 1
            sid = "sec-%d" % sec_i
            # h 形如 <h2 class="bi-head">Introduction</h2>，取内部文字
            m = re.search(r"<h(\d)[^>]*>([\s\S]*?)</h\1>", h)
            lvl = m.group(1) if m else "2"
            en = re.sub(r"<[^>]+>", "", m.group(2)) if m else plain
            if zh:
                zh_n += 1
                parts.append(
                    '<h%s id="%s" class="bi-head"><span class="he">%s</span>'
                    '<span class="hz">%s</span></h%s>'
                    % (lvl, sid, html_mod.escape(en), html_mod.escape(zh), lvl)
                )
            else:
                parts.append('<h%s id="%s" class="bi-head">%s</h%s>'
                             % (lvl, sid, html_mod.escape(en), lvl))
            continue
        if zh:
            zh_n += 1
            parts.append(
                '<div class="pair"><div class="cell orig">%s</div>'
                '<div class="cell trans"><p>%s</p></div></div>'
                % (h, restore_ph(zh, formulas, fmap))
            )
        else:
            parts.append('<div class="solo orig">%s</div>' % h)

    # 参考文献区（对齐 Mktero 快照的附录风格）
    if REFS is not None:
        bib = REFS.bibliography_html()
        if bib:
            parts.append(bib)

    parts.append("</div>")
    # 用与 md/文件夹路线完全相同的 page() 生成 head/CSS/DOCTYPE，确保三种入口字节级一致
    html = bz.page("".join(parts), math_css)
    return html, zh_n


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default="", help="arXiv ID，如 1706.03762")
    ap.add_argument("--src", default="", help="本地已下载的 e-print（tar.gz / tex.gz）或源码目录")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--proxy", default="",
                    help="HTTP 代理，如 http://127.0.0.1:7897（插件会自动探测）")
    ap.add_argument("--name", default="arxiv-latex-preview", help="输出 HTML 文件名（不含扩展名）")
    ap.add_argument("--name-file", default="",
                    help="UTF-8 文件读取输出文件名，避免命令行传中文被系统损坏")
    ap.add_argument("--translation", default="",
                    help='译文 JSON：{"b003": "中文译文", ...}；不传则输出单语结构预览')
    ap.add_argument("--cache", default="", help="源码缓存目录（默认 <out>/_arxiv_cache）")
    ap.add_argument("--keep-source", action="store_true", help="保留解压后的源码目录")
    a = ap.parse_args()

    out_dir = Path(a.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    # 文件名优先从 UTF-8 文件读，绕开进程参数对中文/全角符号的编码损坏
    if a.name_file:
        nf = Path(a.name_file).expanduser().resolve()
        if nf.exists():
            got = nf.read_text(encoding="utf-8").strip()
            if got:
                a.name = got
    cache = Path(a.cache).resolve() if a.cache else out_dir / "_arxiv_cache"
    work = out_dir / "_arxiv_src"
    gs_bin = find_ghostscript()

    if a.src:
        src = Path(a.src).expanduser().resolve()
        if src.is_dir():
            work = src
        else:
            work = unpack_source(src, work)
    elif a.id:
        gz = fetch_source(a.id.strip(), cache, a.proxy)
        work = unpack_source(gz, work)
    else:
        sys.exit("需要 --id 或 --src")

    main_tex = find_main_tex(work)
    text = strip_comments(main_tex.read_text(encoding="utf-8", errors="replace"))
    text = expand_inputs(text, main_tex.parent)
    text = strip_comments(text)   # 展开/拼接后再兜一层，杜绝注释残留
    macros = collect_macros(text)
    if macros:
        log("自定义宏 %d 个，展开中" % len(macros))
    text = expand_macros(text, macros)
    # 元数据与引用表都在 \begin{document} 之前建立好（引用要扫全文）
    id_hint = a.id.strip() if a.id else (Path(a.src).stem if a.src else "")
    meta_title, meta_authors = extract_metadata(text, id_hint)
    global REFS
    bbl_order, bib_entries = load_bbl(work)
    if bib_entries:
        log("参考文献：从 %s 读到 %d 条完整条目" % (work.name, len(bib_entries)))
    REFS = RefRegistry(text, bbl_order=bbl_order, bib_entries=bib_entries)
    log("引用：%d 篇文献编号，%d 个交叉引用标签"
        % (len(REFS.cite_order), len(REFS.ref_map)))
    text = document_body(text)
    text = strip_layout(text)
    # \( ... \) 行内公式必须先归一成 $...$，否则里面所有希腊字母/变量都会丢
    text = formula_svg.normalize_math_delimiters(text)
    log("正文展开后 %.1f KB" % (len(text.encode("utf-8")) / 1024))

    blocks = parse_blocks(text)
    # 丢掉没有任何可见内容的空块（\maketitle 等留下的空段落）
    def has_content(b):
        if b["type"] in ("figure", "table", "tabular", "math"):
            return True
        return bool(re.sub(r"\\[A-Za-z@]+|[{}~\s]", "", str(b.get("raw", ""))))
    blocks = [b for b in blocks if has_content(b)]
    log("抽出结构化块 %d 个" % len(blocks))
    from collections import Counter
    log("块类型：" + ", ".join("%s=%d" % kv for kv in Counter(b["type"] for b in blocks).most_common()))

    rendered = [block_html(b, work, out_dir, gs_bin) for b in blocks]

    # 统一公式渲染（绝不降级：预览必须是完整公式）
    all_html = "".join(h for h, _, _ in rendered)
    # 单批卡住时快速跳过并进入逐个重试，避免整篇等 3 分钟
    fmap, math_css, stats = formula_svg.render(all_html, out_dir, batch_timeout=90)
    rendered = [(finalize_formulas(h, fmap), p, fs) for h, p, fs in rendered]
    log("公式渲染 %d/%d%s" % (stats[0], stats[1],
                            ("，%d 个降级" % stats[2]) if stats[2] else ""))

    translation = {}
    if a.translation:
        p = Path(a.translation).expanduser().resolve()
        if p.exists():
            translation = json.loads(p.read_text(encoding="utf-8"))
            log("译文 JSON：%d 条" % len(translation))
        else:
            log("警告：译文文件不存在，按单语输出")

    note = ""  # 正式产物不加调试提示，排版与 Mktero 快照一致
    html, zh_n = build_html(
        blocks, rendered, translation, fmap, math_css, note,
        title=meta_title, authors=meta_authors,
        arxiv_id=(a.id.strip() if a.id else ""),
    )

    # 结构化块清单：给翻译器消费。text 里的 ⟦Fn⟧ 是公式占位符，
    # 翻译时必须原样保留，译后由转换器还原成内联 SVG。
    out_blocks = []
    for b, (_, plain, formulas) in zip(blocks, rendered):
        d = dict(b)
        d.pop("raw", None)
        d["text"] = plain or ""
        if formulas:
            d["formulas"] = formulas
        out_blocks.append(d)
    (out_dir / "arxiv_blocks.json").write_text(
        json.dumps(out_blocks, ensure_ascii=False, indent=2), encoding="utf-8")

    final = out_dir / (safe_name(a.name, "arxiv-latex-preview") + ".html")
    final.write_text(html, encoding="utf-8")
    (out_dir / "_arxiv_result.txt").write_text(str(final.resolve()), encoding="utf-8")

    imgs = html.count("<img ")
    tabs = html.count("<table>")
    maths = html.count("<mjx-container")
    log("HTML：%s (%.2f MB)" % (final.name, final.stat().st_size / 1048576))
    log("图片 %d 张 | 表格 %d 个 | 公式容器 %d 个 | 双语块 %d 个" %
        (imgs, tabs, maths, zh_n))
    print("完成。")


if __name__ == "__main__":
    main()
