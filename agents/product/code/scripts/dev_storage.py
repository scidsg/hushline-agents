#!/usr/bin/env python3
"""Verify an explicitly configured external development volume before runner work."""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

GIB = 1024**3


def validate(config: dict[str, Any], volume: dict[str, Any]) -> None:
    mount = Path(config["mount"])
    root = Path(config["root"])
    if (
        volume.get("Locked", False)
        or volume.get("VolumeUUID") != config["volume_uuid"]
        or volume.get("MountPoint") != str(mount)
        or volume.get("Internal", True)
    ):
        raise RuntimeError("Expected external development volume is not mounted")
    if not root.is_dir() or not root.resolve().is_relative_to(mount.resolve()):
        raise RuntimeError("Development directory is missing or outside its volume")
    if (
        root.stat().st_dev != mount.stat().st_dev
        or mount.stat().st_dev == Path.home().stat().st_dev
    ):
        raise RuntimeError("Development path resolves to the internal disk")
    if shutil.disk_usage(root).free < int(config.get("minimum_external_free_gib", 20)) * GIB:
        raise RuntimeError("External development volume is below its free-space reserve")
    if shutil.disk_usage(Path.home()).free < int(config.get("minimum_internal_free_gib", 10)) * GIB:
        raise RuntimeError("Internal disk is below its free-space reserve")
    for source in config.get("links", []):
        path = Path(source)
        if not path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError("A configured development-storage link is missing or redirected")


def main() -> None:
    path = os.environ.get("HUSHLINE_DEV_STORAGE_CONFIG")
    if not path:
        return
    config = json.loads(Path(path).read_text())
    result = subprocess.run(  # noqa: S603 -- fixed binary and arguments, no shell.
        ["/usr/sbin/diskutil", "info", "-plist", config["mount"]],
        capture_output=True,
        check=True,
        timeout=20,
    )
    validate(config, plistlib.loads(result.stdout))
    print("External development volume and free-space reserves verified.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
        print(
            "Blocked: external development storage is unavailable or below reserve.",
            file=sys.stderr,
        )
        sys.exit(1)
