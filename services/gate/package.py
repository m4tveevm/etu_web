#!/usr/bin/env python3
"""Package the gate and installed, pinned jose without network access."""

import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent
SOURCES = ("app.mjs", "cloud.mjs", "config.mjs", "cookies.mjs", "function.mjs", "http.mjs", "oidc.mjs")


def build(output):
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    jose = ROOT / "node_modules" / "jose"
    installed = json.loads((jose / "package.json").read_text())
    version = package["dependencies"]["jose"]
    if (version != "6.2.12" or installed["version"] != version
            or lock["packages"]["node_modules/jose"]["version"] != version
            or set(lock["packages"]) != {"", "node_modules/jose"}):
        raise ValueError("Run npm ci with the committed lockfile before packaging")
    files = {"index.js": ROOT / "function-entry.cjs",
             "services/gate/package.json": ROOT / "package.json",
             "services/gate/package-lock.json": ROOT / "package-lock.json",
             "services/quotes/contract.mjs": ROOT.parent / "quotes" / "contract.mjs"}
    files.update({f"services/gate/src/{name}": ROOT / "src" / name for name in SOURCES})
    for path in sorted(jose.rglob("*")):
        if path.is_symlink():
            raise ValueError("Symlinks are not allowed in the dependency archive")
        if path.is_file():
            files[f"services/gate/node_modules/jose/{path.relative_to(jose).as_posix()}"] = path
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w") as archive:
        for name, path in sorted(files.items()):
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"Expected a regular package file: {name}")
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "gate.zip")
    output = build(parser.parse_args().output)
    print(f"{output}: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
