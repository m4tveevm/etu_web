#!/usr/bin/env python3
"""Подготовить цветные листинги исходников для XeLaTeX."""

import re
from pathlib import Path

from pygments import format, lex
from pygments.formatters import LatexFormatter
from pygments.lexers import get_lexer_for_filename
from pygments.styles.friendly import FriendlyStyle
from pygments.token import Error, Number, String


class ReportStyle(FriendlyStyle):
    styles = {**FriendlyStyle.styles, String: "#7A2440"}

report_dir = Path(__file__).resolve().parent
build_dir = report_dir / "build"
build_dir.mkdir(exist_ok=True)
formatter = LatexFormatter(
    style=ReportStyle,
    verboptions=(
        r"breaklines=true,breakanywhere=false,breaksymbolleft={},"
        r"breakindent=1em,tabsize=2,"
        r"fontsize=\fontsize{9.5bp}{10bp}\selectfont,"
        r"numbers=left,numbersep=6pt,xleftmargin=16pt"
    ),
)
(build_dir / "highlight-style.tex").write_text(
    formatter.get_style_defs(), encoding="utf-8"
)
report = (report_dir / "report.tex").read_text(encoding="utf-8")
for name in re.findall(r"\\listing\{([^}]+)\}", report):
    source = report_dir.parent / name
    text = source.read_text(encoding="utf-8")
    lexer = get_lexer_for_filename(name)
    tokens = lex(text, lexer)
    if source.suffix == ".scss":
        # ScssLexer в Pygments 2.21 ошибочно помечает единицу % как Error.
        tokens = (
            (Number if kind is Error and value == "%" else kind, value)
            for kind, value in tokens
        )
    (build_dir / f"{name}.tex").write_text(
        format(tokens, formatter), encoding="utf-8"
    )
