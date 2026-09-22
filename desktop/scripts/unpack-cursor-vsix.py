#!/usr/bin/env python3
"""Unpack an armada-agent vsix into Cursor's extensions dir.

Idle Reload only sees `~/.cursor/extensions/armada.armada-agent-x.y.z`.
`cursor --install-extension` is not used: it times out and must not be
spawned from Cursor's process tree.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path


def semver(text: str) -> tuple[int, int, int] | None:
    parts = text.strip().split(".")
    if len(parts) != 3:
        return None
    try:
        return tuple(int(p) for p in parts)  # type: ignore[return-value]
    except ValueError:
        return None


def vsix_version(path: Path) -> str:
    stem = path.stem
    if "-" not in stem:
        raise SystemExit(f"vsix name has no version: {path.name}")
    ver = stem.rsplit("-", 1)[1]
    if semver(ver) is None:
        raise SystemExit(f"vsix name has no version: {path.name}")
    return ver


def extensions_dir() -> Path:
    override = os.environ.get("ARMADA_CURSOR_EXTENSIONS", "").strip()
    if override:
        return Path(override)
    return Path.home() / ".cursor" / "extensions"


def file_url(fs_path: str) -> str:
    n = fs_path.replace("\\", "/")
    if len(n) >= 2 and n[1] == ":":
        return "file:///" + n[0].lower() + "%3A" + n[2:]
    if n.startswith("/"):
        return "file://" + n
    return "file:///" + n


def unpack(vsix: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(vsix) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            if any(part == ".." for part in name.split("/")):
                continue
            if name == "extension.vsixmanifest":
                rel = Path(".vsixmanifest")
            elif name.startswith("extension/"):
                rest = name[len("extension/") :]
                if not rest:
                    continue
                rel = Path(rest)
            else:
                continue
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    pkg_path = dest / "package.json"
    if not pkg_path.is_file():
        raise SystemExit("vsix-missing-package")
    pkg_ver = json.loads(pkg_path.read_text()).get("version")
    if pkg_ver != vsix_version(vsix):
        raise SystemExit(f"vsix package.json {pkg_ver} != filename {vsix_version(vsix)}")


def installed_version(ext_dir: Path) -> str | None:
    best: tuple[int, int, int] | None = None
    if not ext_dir.is_dir():
        return None
    for child in ext_dir.iterdir():
        name = child.name
        prefix = "armada.armada-agent-"
        if not name.startswith(prefix):
            continue
        ver = semver(name[len(prefix) :])
        if ver is None:
            continue
        if best is None or ver > best:
            best = ver
    if best is None:
        return None
    return ".".join(str(n) for n in best)


def upsert(manifest: Path, version: str, relative: str, fs_path: str) -> None:
    raw = manifest.read_text() if manifest.is_file() else ""
    arr = json.loads(raw) if raw.strip() else []
    if not isinstance(arr, list):
        raise SystemExit("extensions-json-invalid")
    location = {
        "$mid": 1,
        "fsPath": fs_path,
        "_sep": 1,
        "external": file_url(fs_path),
        "path": fs_path.replace("\\", "/"),
        "scheme": "file",
    }
    found = False
    for item in arr:
        ident = (item.get("identifier") or {}).get("id")
        if ident != "armada.armada-agent":
            continue
        item["version"] = version
        item["relativeLocation"] = relative
        item["location"] = location
        md = item.setdefault("metadata", {})
        md["installedTimestamp"] = int(time.time() * 1000)
        md["source"] = "vsix"
        md["pinned"] = True
        found = True
        break
    if not found:
        arr.append(
            {
                "identifier": {"id": "armada.armada-agent"},
                "version": version,
                "relativeLocation": relative,
                "location": location,
                "metadata": {
                    "isApplicationScoped": False,
                    "isMachineScoped": False,
                    "isBuiltin": False,
                    "installedTimestamp": int(time.time() * 1000),
                    "pinned": True,
                    "source": "vsix",
                },
            }
        )
    tmp = manifest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(arr, separators=(",", ":"), ensure_ascii=False))
    os.replace(tmp, manifest)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: unpack-cursor-vsix.py <armada-agent-x.y.z.vsix>")
    vsix = Path(sys.argv[1])
    if not vsix.is_file():
        raise SystemExit(f"vsix missing: {vsix}")
    ver = vsix_version(vsix)
    ext_dir = extensions_dir()
    have = installed_version(ext_dir)
    if have is not None and semver(have) >= semver(ver):  # type: ignore[operator]
        print(f"skipped-same-version {have}")
        return
    dest = ext_dir / f"armada.armada-agent-{ver}"
    ext_dir.mkdir(parents=True, exist_ok=True)
    unpack(vsix, dest)
    upsert(ext_dir / "extensions.json", ver, dest.name, str(dest))
    print(f"ok {ver}")


if __name__ == "__main__":
    main()
