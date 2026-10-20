#!/usr/bin/env python3
"""Build a deterministic Cloud Functions archive from an explicit file list."""

from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent
FILES = ("index.js", "contract.mjs", "quotes.json", "package.json")
OUTPUT = ROOT / "dist" / "quotes.zip"


def main():
    OUTPUT.parent.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, "w") as archive:
        for name in FILES:
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())
    print(f"{OUTPUT}: {OUTPUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
