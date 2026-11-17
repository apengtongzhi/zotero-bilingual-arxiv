#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 addon/ 打包成 xpi，并生成 Zotero 自动更新用的 update.json。

用法：
  python3 scripts/build.py                 # 本地打包，输出到 dist/
  python3 scripts/build.py --release-url BASE_URL

BASE_URL 形如 https://github.com/OWNER/REPO/releases/download/release
update.json 里的 update_link 由 BASE_URL + /bilingual-snapshot-<version>.xpi 组成。
release workflow 会传入真实 BASE_URL；本地开发可留空（用相对占位）。
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "addon"
DIST = ROOT / "dist"
MANIFEST = ADDON / "manifest.json"
XPI_NAME = "bilingual-snapshot.xpi"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release-url", default="",
                    help="release 下载基址，用于生成 update.json 的 update_link")
    a = ap.parse_args()

    if not MANIFEST.exists():
        sys.exit("找不到 " + str(MANIFEST))
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    version = m.get("version", "0.0.0")
    zinfo = m["applications"]["zotero"]
    addon_id = zinfo["id"]
    zmin = zinfo.get("strict_min_version", "7.0")
    zmax = zinfo.get("strict_max_version", "11.*.*")

    DIST.mkdir(parents=True, exist_ok=True)
    xpi = DIST / XPI_NAME

    # 打包：addon/ 下所有文件，按相对路径写入（跳过 __pycache__ / .DS_Store）
    skip = {"__pycache__", ".DS_Store", ".git"}
    files = []
    for p in sorted(ADDON.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ADDON)
        if any(part in skip for part in rel.parts):
            continue
        files.append((p, rel.as_posix()))
    with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED) as z:
        for src, rel in files:
            z.write(src, rel)
    print("打包完成: %s (%d 个文件, %d bytes)"
          % (xpi.name, len(files), xpi.stat().st_size))

    # 生成 update.json（Zotero 自动更新）
    sha = hashlib.sha256(xpi.read_bytes()).hexdigest()
    base = a.release_url.rstrip("/")
    link = (base + "/" + XPI_NAME) if base else XPI_NAME
    update = {
        "addons": {
            addon_id: {
                "updates": [{
                    "version": version,
                    "update_link": link,
                    "update_hash": "sha256:" + sha,
                    "applications": {
                        "zotero": {
                            "strict_min_version": zmin,
                            "strict_max_version": zmax
                        }
                    }
                }]
            }
        }
    }
    up = DIST / "update.json"
    up.write_text(json.dumps(update, indent=2, ensure_ascii=False) + "\n",
                  encoding="utf-8")
    print("更新清单: %s (version=%s, sha256=%s...)" % (up.name, version, sha[:12]))
    if not base:
        print("提示: 未传 --release-url，update_link 为相对占位；发布时务必传真实基址。")


if __name__ == "__main__":
    main()
