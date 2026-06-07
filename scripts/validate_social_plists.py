from __future__ import annotations

import plistlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SOCIAL_PLIST_DIR = REPO_ROOT / "social" / "deploy" / "launchd"


def main() -> None:
    for plist_path in sorted(SOCIAL_PLIST_DIR.glob("*.plist")):
        plistlib.loads(plist_path.read_bytes())


if __name__ == "__main__":
    main()
