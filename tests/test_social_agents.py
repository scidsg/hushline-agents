from __future__ import annotations

import plistlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SOCIAL_PLIST_DIR = REPO_ROOT / "social" / "deploy" / "launchd"


def test_social_launchd_templates_execute_agents_repo_scripts() -> None:
    for plist_path in SOCIAL_PLIST_DIR.glob("com.hushline.social.*.plist"):
        plist = plistlib.loads(plist_path.read_bytes())

        program_args = plist["ProgramArguments"]
        assert len(program_args) == 1
        assert program_args[0].startswith("__REPO_DIR__/social/scripts/")
        assert "/hushline-social/" not in program_args[0]


def test_social_launchd_templates_pass_social_repo_dir_and_logs() -> None:
    for plist_path in SOCIAL_PLIST_DIR.glob("com.hushline.social.*.plist"):
        plist = plistlib.loads(plist_path.read_bytes())
        env = plist["EnvironmentVariables"]

        assert env["HUSHLINE_SOCIAL_REPO_DIR"] == "__SOCIAL_REPO_DIR__"
        assert env["HUSHLINE_SOCIAL_ENV_FILE"] == "__ENV_FILE__"
        assert (
            env["HUSHLINE_SOCIAL_COMBINED_LOG_FILE"] == "__REPO_DIR__/logs/social/social-daily.log"
        )
        assert plist["StandardOutPath"].startswith("__REPO_DIR__/logs/social/")
        assert plist["StandardErrorPath"].startswith("__REPO_DIR__/logs/social/")
