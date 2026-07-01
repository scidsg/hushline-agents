from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[4]
RUNNER_PATH = (
    ROOT / "agents" / "product" / "reporting" / "scripts" / "monthly_board_report_runner.py"
)
UTC = timezone.utc  # noqa: UP017 - keep the runner importable under Python 3.9.
GIT_EXECUTABLE = "/usr/bin/git"


@pytest.fixture(autouse=True)
def configured_report_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HUSHLINE_MONTHLY_BOARD_REPORT_FROM", raising=False)
    monkeypatch.delenv("HUSHLINE_MONTHLY_BOARD_REPORT_TO", raising=False)
    monkeypatch.delenv("HUSHLINE_MONTHLY_BOARD_REPORT_REPOS", raising=False)


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("monthly_board_report_runner", RUNNER_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def init_repo(path: Path) -> None:
    subprocess.run([GIT_EXECUTABLE, "init", str(path)], check=True, capture_output=True)
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(path), "config", "user.email", "test@example.com"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(path), "config", "user.name", "Test User"],
        check=True,
        capture_output=True,
    )


def commit_file(path: Path, name: str, body: str, message: str, commit_date: str) -> None:
    (path / name).write_text(body, encoding="utf-8")
    subprocess.run([GIT_EXECUTABLE, "-C", str(path), "add", name], check=True, capture_output=True)
    env = os.environ | {
        "GIT_AUTHOR_DATE": commit_date,
        "GIT_COMMITTER_DATE": commit_date,
    }
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(path), "commit", "-m", message],
        check=True,
        capture_output=True,
        env=env,
    )


def test_report_defaults_use_admin_sender_and_glenn_recipient() -> None:
    runner = load_runner()

    assert runner.report_from() == "admin@hushline.app"
    assert runner.report_to() == "glenn@hushline.app"


def test_last_day_gate_handles_variable_month_lengths() -> None:
    runner = load_runner()

    assert runner.is_last_day(date(2026, 2, 28))
    assert runner.is_last_day(date(2024, 2, 29))
    assert runner.is_last_day(date(2026, 4, 30))
    assert runner.is_last_day(date(2026, 7, 31))
    assert not runner.is_last_day(date(2026, 7, 30))


def test_collects_commits_and_renders_board_report(tmp_path: Path) -> None:
    runner = load_runner()
    repo = tmp_path / "hushline"
    repo.mkdir()
    init_repo(repo)
    commit_file(
        repo,
        "old.txt",
        "old",
        "Old work outside report window",
        "2026-06-20T10:00:00-07:00",
    )
    commit_file(
        repo,
        "security.txt",
        "security",
        "Tighten auth origin checks (#2301)",
        "2026-07-12T10:00:00-07:00",
    )
    commit_file(
        repo,
        "docs.txt",
        "docs",
        "Update governance documentation",
        "2026-07-20T10:00:00-07:00",
    )
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(repo), "tag", "-a", "v1.2.3", "-m", "Release v1.2.3"],
        check=True,
        capture_output=True,
        env=os.environ
        | {
            "GIT_COMMITTER_DATE": "2026-07-21T10:00:00-07:00",
        },
    )

    window = runner.report_window(date(2026, 7, 31), None)
    summary = runner.summarize_repo(runner.RepoSpec("Product", repo), window)
    report = runner.render_report([summary], window, datetime(2026, 8, 1, 1, 0, tzinfo=UTC))

    assert summary.commit_count == 2
    assert summary.likely_pr_count == 1
    assert summary.release_count == 1
    assert "Hush Line Monthly Board Report" in report
    assert "From: admin@hushline.app" in report
    assert "Period: July 2026 (2026-07-01 to 2026-07-31)" in report
    assert "Privacy, Safety, and Security:" in report
    assert "Product: Tighten auth origin checks (#2301)" in report
    assert "Documentation and Governance:" in report
    assert "releases: v1.2.3" in report
    assert "Old work outside report window" not in report


def test_commit_collection_scans_all_refs_not_only_current_branch(tmp_path: Path) -> None:
    runner = load_runner()
    repo = tmp_path / "repo"
    repo.mkdir()
    init_repo(repo)
    commit_file(
        repo,
        "base.txt",
        "base",
        "Base work outside report window",
        "2026-06-20T10:00:00-07:00",
    )
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(repo), "branch", "reporting-main"],
        check=True,
        capture_output=True,
    )
    commit_file(
        repo,
        "main.txt",
        "main",
        "Improve board-visible product workflow (#2401)",
        "2026-07-12T10:00:00-07:00",
    )
    subprocess.run(
        [GIT_EXECUTABLE, "-C", str(repo), "switch", "reporting-main"],
        check=True,
        capture_output=True,
    )

    summary = runner.summarize_repo(
        runner.RepoSpec("Product", repo),
        runner.report_window(date(2026, 7, 31), None),
    )

    assert summary.commit_count == 1
    assert summary.commits[0].subject == "Improve board-visible product workflow (#2401)"


def test_release_sort_handles_mixed_tag_styles() -> None:
    runner = load_runner()

    assert sorted(["v1.2.3", "2026-07", "release-10"], key=runner.release_sort_key) == [
        "2026-07",
        "release-10",
        "v1.2.3",
    ]


def test_summarize_repo_returns_warning_for_unreadable_git_repo(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    repo = tmp_path / "empty"
    repo.mkdir()
    init_repo(repo)

    def fail_collect(_spec: object, _window: object) -> object:
        raise runner.RunnerError("simulated git ownership failure")

    monkeypatch.setattr(runner, "collect_commits", fail_collect)

    summary = runner.summarize_repo(
        runner.RepoSpec("Empty", repo),
        runner.report_window(date(2026, 7, 31), None),
    )

    assert summary.exists is False
    assert "simulated git ownership failure" in summary.warning
    assert summary.commit_count == 0


def test_month_argument_does_not_bypass_last_day_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = load_runner()
    sent = []
    monkeypatch.setattr(runner, "send_with_mail_app", lambda _subject, _body: sent.append(True))

    result = runner.main(
        [
            "--date",
            "2026-07-01",
            "--month",
            "2026-07",
            "--state-file",
            str(tmp_path / "state.json"),
            "--repo",
            f"Missing={tmp_path / 'missing'}",
        ],
    )

    assert result == 0
    assert sent == []
    assert "not the last day" in capsys.readouterr().out
    assert not (tmp_path / "state.json").exists()


def test_main_skips_non_last_day_without_state_or_send(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = load_runner()
    sent = []
    monkeypatch.setattr(runner, "send_with_mail_app", lambda _subject, _body: sent.append(True))

    result = runner.main(
        [
            "--date",
            "2026-07-30",
            "--state-file",
            str(tmp_path / "state.json"),
            "--repo",
            f"Missing={tmp_path / 'missing'}",
        ],
    )

    assert result == 0
    assert sent == []
    assert "not the last day" in capsys.readouterr().out
    assert not (tmp_path / "state.json").exists()


def test_main_persists_sends_and_records_idempotency(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    repo = tmp_path / "repo"
    repo.mkdir()
    init_repo(repo)
    commit_file(
        repo,
        "runner.txt",
        "runner",
        "Add monthly board report workflow (#2400)",
        "2026-07-12T10:00:00-07:00",
    )
    output_dir = tmp_path / "reports"
    state_file = tmp_path / "state.json"
    sent: list[tuple[str, str]] = []

    def fake_send(subject: str, body: str) -> bool:
        sent.append((subject, body))
        return True

    monkeypatch.setattr(runner, "send_with_mail_app", fake_send)

    result = runner.main(
        [
            "--date",
            "2026-07-31",
            "--repo",
            f"Agents={repo}",
            "--report-output-dir",
            str(output_dir),
            "--state-file",
            str(state_file),
        ],
    )
    second_result = runner.main(
        [
            "--date",
            "2026-07-31",
            "--repo",
            f"Agents={repo}",
            "--report-output-dir",
            str(output_dir),
            "--state-file",
            str(state_file),
        ],
    )

    reports = list(output_dir.glob("monthly-board-report-2026-07-*.txt"))
    state = runner.load_state(state_file)
    assert result == 0
    assert second_result == 0
    assert len(sent) == 1
    assert sent[0][0] == "Hush Line Monthly Board Report - July 2026"
    assert "Add monthly board report workflow" in sent[0][1]
    assert len(reports) == 1
    assert runner.state_has_sent(state, "2026-07")


def test_dry_run_prints_without_persisting_or_sending(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = load_runner()
    sent = []
    monkeypatch.setattr(runner, "send_with_mail_app", lambda _subject, _body: sent.append(True))

    result = runner.main(
        [
            "--dry-run",
            "--date",
            "2026-07-31",
            "--repo",
            f"Missing={tmp_path / 'missing'}",
            "--report-output-dir",
            str(tmp_path / "reports"),
            "--state-file",
            str(tmp_path / "state.json"),
        ],
    )

    assert result == 0
    assert sent == []
    assert "Hush Line Monthly Board Report" in capsys.readouterr().out
    assert not (tmp_path / "reports").exists()
    assert not (tmp_path / "state.json").exists()


def test_send_with_mail_app_uses_admin_mail_account(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = load_runner()
    calls = []

    class Result:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(command: list[str], **kwargs: object) -> Result:
        calls.append((command, kwargs))
        return Result()

    monkeypatch.setattr(runner.subprocess, "run", fake_run)

    sent = runner.send_with_mail_app("Subject", "Body")

    assert len(calls) == 1
    assert sent is True
    command, kwargs = calls[0]
    assert command[:2] == ["/usr/bin/osascript", "-"]
    assert command[2:5] == ["admin@hushline.app", "glenn@hushline.app", "Subject"]
    script = kwargs["input"]
    assert isinstance(script, str)
    assert 'tell application "Mail"' in script
    assert "with timeout of 300 seconds" in script
    assert kwargs["timeout"] == runner.MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS


def test_mail_timeout_does_not_mark_month_sent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = load_runner()
    repo = tmp_path / "repo"
    repo.mkdir()
    init_repo(repo)
    commit_file(
        repo,
        "runner.txt",
        "runner",
        "Add monthly board report workflow (#2400)",
        "2026-07-12T10:00:00-07:00",
    )
    state_file = tmp_path / "state.json"

    def fake_send(_subject: str, _body: str) -> bool:
        return False

    monkeypatch.setattr(runner, "send_with_mail_app", fake_send)

    result = runner.main(
        [
            "--date",
            "2026-07-31",
            "--repo",
            f"Agents={repo}",
            "--report-output-dir",
            str(tmp_path / "reports"),
            "--state-file",
            str(state_file),
        ],
    )

    assert result == 1
    assert not state_file.exists()
    assert "delivery was not confirmed" in capsys.readouterr().out


def test_send_with_mail_app_reports_timeout_as_unconfirmed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = load_runner()

    def fake_run(command: list[str], **_kwargs: object) -> object:
        raise runner.subprocess.TimeoutExpired(command, runner.MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS)

    monkeypatch.setattr(runner.subprocess, "run", fake_run)

    assert runner.send_with_mail_app("Subject", "Body") is False
    assert "not marking this monthly report as sent" in capsys.readouterr().err
