#!/usr/bin/env bash
set -euo pipefail
report_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${FONT_DIR:-}" ]]; then
    font_dir="$(cd -- "$FONT_DIR" && pwd)"
    for font in Times.TTF Timesbd.TTF Timesi.TTF Timesbi.TTF; do
        test -f "$font_dir/$font" || { echo "Не найден шрифт: $font_dir/$font" >&2; exit 1; }
    done
fi
cd "$report_dir"
mkdir -p build
if [[ -n "${font_dir:-}" ]]; then
    printf '\\def\\reportFontPath{\\detokenize{%s/}}\n' "$font_dir" > build/font-path.tex
else
    printf '%% Используется системный Times New Roman.\n' > build/font-path.tex
fi
python3 highlight.py
for pass in 1 2; do
    xelatex -interaction=nonstopmode -halt-on-error -file-line-error -output-directory=build report.tex > "build/pass-$pass.log" 2>&1 || {
        tail -n 60 "build/pass-$pass.log" >&2
        exit 1
    }
done
cp build/report.pdf report.pdf
printf 'Отчёт готов: %s/report.pdf\n' "$report_dir"
