from __future__ import annotations

import os
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SOCIAL_PLIST_DIR = REPO_ROOT / "social" / "deploy" / "launchd"
CHECK_PREREQS_SCRIPT = REPO_ROOT / "social" / "scripts" / "check_launchd_prereqs.sh"
GIT = shutil.which("git") or "/usr/bin/git"
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from validate_social_plists import PlistValidationError, validate_plist_path  # noqa: E402


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


def test_social_plist_validator_accepts_launchd_templates() -> None:
    for plist_path in SOCIAL_PLIST_DIR.glob("com.hushline.social.*.plist"):
        validate_plist_path(plist_path)


def test_social_plist_validator_rejects_unknown_tags(tmp_path: Path) -> None:
    plist_path = tmp_path / "invalid.plist"
    plist_path.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hushline.invalid</string>
  <key>BadValue</key>
  <foo/>
</dict>
</plist>
""",
        encoding="utf-8",
    )

    with pytest.raises(PlistValidationError, match="unknown plist tag <foo>"):
        validate_plist_path(plist_path)


def test_social_plist_validator_rejects_multiple_top_level_objects(tmp_path: Path) -> None:
    plist_path = tmp_path / "invalid.plist"
    plist_path.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hushline.invalid</string>
</dict>
<dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
""",
        encoding="utf-8",
    )

    with pytest.raises(PlistValidationError, match="expected exactly one top-level plist object"):
        validate_plist_path(plist_path)


def _write_required_social_scripts(social_repo: Path) -> None:
    script_dir = social_repo / "scripts"
    script_dir.mkdir(parents=True)
    for script_name in [
        "plan-weekly-article-post.js",
        "plan-day.js",
        "publish-daily-linkedin.js",
        "render-verified-user-post.js",
    ]:
        (script_dir / script_name).write_text("// test stub\n", encoding="utf-8")


def _write_command_stubs(bin_dir: Path) -> None:
    bin_dir.mkdir()
    for command_name in ["codex", "launchctl", "node", "plutil", "swift"]:
        command_path = bin_dir / command_name
        command_path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        command_path.chmod(0o755)


def _init_social_repo(social_repo: Path) -> None:
    social_repo.mkdir()
    _write_required_social_scripts(social_repo)
    subprocess.run([GIT, "init"], cwd=social_repo, check=True, capture_output=True, text=True)
    subprocess.run(
        [GIT, "remote", "add", "origin", "https://github.com/scidsg/hushline-social.git"],
        cwd=social_repo,
        check=True,
        capture_output=True,
        text=True,
    )


def _run_prereq_checker(
    tmp_path: Path,
    env_text: str,
    *,
    owner_user: str | None = None,
) -> subprocess.CompletedProcess[str]:
    social_repo = tmp_path / "hushline-social"
    env_file = social_repo / ".env.launchd"
    bin_dir = tmp_path / "bin"
    env = os.environ.copy()

    _init_social_repo(social_repo)
    _write_command_stubs(bin_dir)
    env_file.write_text(env_text, encoding="utf-8")
    env_file.chmod(0o600)

    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["HUSHLINE_SOCIAL_REPO_DIR"] = str(social_repo)

    command = [
        str(CHECK_PREREQS_SCRIPT),
        "--scope",
        "daemon",
        "--env-file",
        str(env_file),
    ]
    if owner_user is not None:
        command.extend(["--owner-user", owner_user])

    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_prereq_checker_parses_env_without_executing_shell_payload(tmp_path: Path) -> None:
    marker = tmp_path / "env_sourced_as_root.txt"
    env_text = "\n".join(
        [
            "LINKEDIN_ACCESS_TOKEN=test-token",
            "LINKEDIN_AUTHOR_URN=urn:li:person:test",
            "OPENAI_API_KEY=test-openai-key",
            "HUSHLINE_SOCIAL_ARCHIVE_PUSH=0",
            f"MALICIOUS=$(touch {shlex.quote(str(marker))})",
        ]
    )

    result = _run_prereq_checker(tmp_path, env_text)

    assert result.returncode == 0, result.stderr
    assert "Launchd prerequisites look good for scope=daemon" in result.stdout
    assert not marker.exists()


def test_prereq_checker_rejects_non_assignment_env_syntax(tmp_path: Path) -> None:
    marker = tmp_path / "env_command_executed.txt"
    env_text = "\n".join(
        [
            "LINKEDIN_ACCESS_TOKEN=test-token",
            "LINKEDIN_AUTHOR_URN=urn:li:person:test",
            "OPENAI_API_KEY=test-openai-key",
            "HUSHLINE_SOCIAL_ARCHIVE_PUSH=0",
            f"touch {shlex.quote(str(marker))}",
        ]
    )

    result = _run_prereq_checker(tmp_path, env_text)

    assert result.returncode == 1
    assert "unsupported env syntax" in result.stderr
    assert not marker.exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="root-owned temp files cannot exercise mismatch")
def test_prereq_checker_rejects_unexpected_daemon_env_owner(tmp_path: Path) -> None:
    env_text = "\n".join(
        [
            "LINKEDIN_ACCESS_TOKEN=test-token",
            "LINKEDIN_AUTHOR_URN=urn:li:person:test",
            "OPENAI_API_KEY=test-openai-key",
            "HUSHLINE_SOCIAL_ARCHIVE_PUSH=0",
        ]
    )

    result = _run_prereq_checker(tmp_path, env_text, owner_user="root")

    assert result.returncode == 1
    assert "daemon env file must be owned by target user root" in result.stderr
