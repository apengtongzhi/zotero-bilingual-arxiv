#!/usr/bin/env python3
"""回归探针：确认 LaTeX 元信息与参考文献命令不会混进正文，且 .bbl 能解析。

由 scripts/sandbox_check.js 调用（放在文件里而不是 -c 字符串里，避免多层转义）。
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "addon" / "converter"))
import arxiv_to_zotero as a  # noqa: E402

tex = (
    r"\begin{document}"
    r"\title{A Paper}"
    r"\author{J. Doe \thanks{email x}}"
    r"\maketitle "
    r"\bibliographystyle{IEEEtran}\bibliography{reference}"
    r"\section{Method for {Text Modality}}"
    r" Body text. "
    r"\end{document}"
)
body = a.document_body(tex)

# .bbl 探针：用真实 IEEEtran.bst 的典型片段
bbl_dir = Path(tempfile.mkdtemp(prefix="mb-bbl-probe-"))
(bbl_dir / "paper.bbl").write_text(
    r"""\begin{thebibliography}{10}
\providecommand{\url}[1]{#1}
\bibitem{pokhrel2022understand}
S.~R. Pokhrel \emph{et~al.}, ``Understand-before-talk ({UBT}),''
  \emph{{IEEE} Trans. Veh. Technol.}, vol.~72, no.~3, pp. 3544--3556, 2022.
\bibitem{wang2022transformer}
Y.~Wang, ``Transformer-empowered {6G} networks,'' 2022.
\end{thebibliography}
""",
    encoding="utf-8",
)
order, entries = a.load_bbl(bbl_dir)
shutil.rmtree(bbl_dir, ignore_errors=True)

ref_sample = (
    r"\section{Intro}\label{sec:a}"
    r"\subsection{Sub}\label{sec:b}"
    r"\begin{figure}\caption{X}\label{fig:one}\end{figure}"
    r"\begin{figure}\caption{Y}\label{fig:two}\end{figure}"
    r"\section{Sim}\ref{fig:one} \ref{fig:two}"
)
rr = a.RefRegistry(ref_sample)
css = (Path(__file__).resolve().parent.parent.parent / "addon" / "converter"
       / "bilingual_to_zotero.py").read_text(encoding="utf-8")

print(json.dumps({
    "refs": {k: rr.ref(k) for k in ("fig:one", "fig:two", "sec:a", "sec:b")},
    "css_override": "mjx-container{display:inline-block!important" in css,
    "secnum_inline": ".bi-head .secnum{display:inline" in css,
    "img_full": ".figure img{width:100%!important" in css,
    "ieee_l1": [a.ieee_section_num([i, 0, 0], 0) for i in (1, 2, 4)],
    "ieee_l2": [a.ieee_section_num([2, i, 0], 1) for i in (1, 2)],
    "ieee_l3": [a.ieee_section_num([2, 1, i], 2) for i in (1, 2)],
    "ratio_full": a.graphics_design_ratio("trim=1 2 3 4, clip, scale=0.34"),
    "ratio_half": a.graphics_design_ratio("width=0.48\\linewidth"),
    "sup": a.clean_bbl_text(r"M. Liu, ``$I^2$VC,'' 2024."),
    "sub": a.clean_bbl_text(r"X. Li, ``H_\infty control,'' 2020."),
    "textsup": a.clean_bbl_text(r"A. B, ``Fast method\\textsuperscript{2},'' 2021."),
    "clean": ("A Paper" not in body and "J. Doe" not in body
              and "IEEEtran" not in body and "reference" not in body
              and "thanks" not in body and "email x" not in body),
    "has_section": r"\section" in body,
    "has_body": "Body text." in body,
    "bbl_order": order,
    "bbl_first": entries.get("pokhrel2022understand", ""),
}, ensure_ascii=False))
