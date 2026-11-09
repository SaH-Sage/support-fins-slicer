#!/usr/bin/env python3
"""Download the pinned slicer engine (slicer/engine.json) into web/slicer/engine/
and verify its SHA-256. Run once after cloning, and in the deploy workflow.

    python3 slicer/fetch-engine.py
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = json.loads((ROOT / "slicer" / "engine.json").read_text())
OUT = ROOT / "web" / "slicer" / "engine"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, f in SPEC["files"].items():
        dest = OUT / name
        if dest.exists() and sha256(dest) == f["sha256"]:
            print(f"{name}: already current")
            continue
        print(f"{name}: downloading {f['url']}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(f["url"]) as r, tmp.open("wb") as w:
            while chunk := r.read(1 << 20):
                w.write(chunk)
        got = sha256(tmp)
        if got != f["sha256"]:
            tmp.unlink()
            print(f"{name}: checksum mismatch (got {got}, want {f['sha256']})", file=sys.stderr)
            return 1
        tmp.replace(dest)
        print(f"{name}: ok ({dest.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
