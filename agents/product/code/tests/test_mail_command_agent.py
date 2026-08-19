from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = ROOT / "agents/product/code/scripts/mail_command_agent.py"
PLIST_PATH = ROOT / "agents/product/code/deploy/launchd/com.hushline.mail-command-agent.plist"


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mail_command_agent", SCRIPT_PATH)
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def valid_headers() -> EmailMessage:
    raw = (
        b"From: Glenn Sorrentino <glenn@hushline.app>\r\n"
        b"To: Hush Line Agent <agent@hushline.app>\r\n"
        b"Subject: Update the homepage\r\n"
        b"Message-ID: <command-1@hushline.app>\r\n"
        b"Authentication-Results: mail.example; dkim=pass header.d=hushline.app; "
        b"dmarc=pass header.from=hushline.app\r\n\r\n"
    )
    parsed = BytesParser(policy=policy.default).parsebytes(raw)
    assert isinstance(parsed, EmailMessage)
    return parsed


def candidate(runner: ModuleType) -> Any:
    return runner.CandidateMessage(
        internal_id="42",
        message_id="<command-1@hushline.app>",
        subject="Update the homepage",
        body="Please update the intro headline.",
        headers=valid_headers(),
    )


def test_accepts_exact_sender_recipient_and_aligned_authentication() -> None:
    runner = load_runner()

    assert runner.validate_headers(valid_headers()) == (True, "authenticated")


@pytest.mark.parametrize(
    ("header_name", "header_value", "reason"),
    [
        ("From", "Attacker <attacker@example.com>", "from_mismatch"),
        ("To", "Someone <someone@example.com>", "recipient_mismatch"),
    ],
)
def test_rejects_wrong_identity(header_name: str, header_value: str, reason: str) -> None:
    runner = load_runner()
    headers = valid_headers()
    headers.replace_header(header_name, header_value)

    assert runner.validate_headers(headers) == (False, reason)


def test_rejects_visible_sender_without_dkim_and_dmarc() -> None:
    runner = load_runner()
    headers = valid_headers()
    del headers["Authentication-Results"]

    assert runner.validate_headers(headers) == (False, "authentication_failed")


def test_accepts_exact_same_account_command_from_trusted_all_mail() -> None:
    runner = load_runner()
    headers = valid_headers()
    del headers["Authentication-Results"]
    headers["X-Pm-Origin"] = "internal"

    assert runner.validate_candidate_headers(headers, "all_mail") == (
        True,
        "trusted_proton_internal",
    )


def test_all_mail_still_requires_exact_sender_and_recipient() -> None:
    runner = load_runner()
    headers = valid_headers()
    headers.replace_header("From", "Attacker <attacker@example.com>")
    del headers["Authentication-Results"]
    headers["X-Pm-Origin"] = "internal"

    assert runner.validate_candidate_headers(headers, "all_mail") == (False, "from_mismatch")


def test_all_mail_rejects_external_or_ambiguous_proton_origin() -> None:
    runner = load_runner()
    headers = valid_headers()
    del headers["Authentication-Results"]
    headers["X-Pm-Origin"] = "internal"
    headers["X-Pm-Origin"] = "external"

    assert runner.validate_candidate_headers(headers, "all_mail") == (
        False,
        "authentication_failed",
    )


def test_rejects_untrusted_mailbox_source() -> None:
    runner = load_runner()

    assert runner.validate_candidate_headers(valid_headers(), "archive") == (
        False,
        "invalid_mailbox_source",
    )


def test_uses_only_first_authentication_results_header() -> None:
    runner = load_runner()
    headers = valid_headers()
    del headers["Authentication-Results"]
    headers["Authentication-Results"] = "receiver.example; dkim=fail; dmarc=fail"
    headers["Authentication-Results"] = (
        "forged.example; dkim=pass header.d=hushline.app; dmarc=pass header.from=hushline.app"
    )

    assert runner.validate_headers(headers) == (False, "authentication_failed")


def test_prompt_preserves_task_and_repository_authority(tmp_path: Path) -> None:
    runner = load_runner()

    prompt = runner.build_prompt(candidate(runner), [tmp_path])

    assert "Update the homepage" in prompt
    assert "Please update the intro headline." in prompt
    assert "Follow all\nAGENTS.md instructions" in prompt
    assert "Do not send email\nyourself" in prompt
    assert "aligned DKIM and DMARC passed" in prompt


def test_all_mail_command_prompt_describes_proton_internal_trust(tmp_path: Path) -> None:
    runner = load_runner()
    task = candidate(runner)
    task = runner.CandidateMessage(
        internal_id=task.internal_id,
        message_id=task.message_id,
        subject=task.subject,
        body=task.body,
        headers=task.headers,
        mailbox_source="all_mail",
    )
    task.headers["X-Pm-Origin"] = "internal"

    prompt = runner.build_prompt(task, [tmp_path])

    assert "Proton marked the exact-address message as internally originated" in prompt


def test_codex_command_uses_approved_model_and_bounded_sandbox(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    primary = tmp_path / "hushline"
    secondary = tmp_path / "hushline-agents"
    primary.mkdir()
    secondary.mkdir()
    monkeypatch.setattr(runner.shutil, "which", lambda _command: "/usr/local/bin/codex")
    monkeypatch.setattr(runner.Path, "home", lambda: tmp_path)

    command = runner.codex_command(
        [primary.resolve(), secondary.resolve()], tmp_path / "schema.json", tmp_path / "out.json"
    )

    assert command[:4] == ["/usr/local/bin/codex", "exec", "--model", "gpt-5.6-sol"]
    assert 'model_reasoning_effort="high"' in command
    assert "--approve-for-me" in command
    assert "--sandbox" not in command
    assert "--ephemeral" in command
    assert "--dangerously-bypass-approvals-and-sandbox" not in command
    assert command[command.index("--cd") + 1] == str(primary.resolve())
    assert command[command.index("--add-dir") + 1] == str(secondary.resolve())


def test_process_candidate_runs_once_and_replies(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    state = runner.initial_state(100)
    path = tmp_path / "state.json"
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        runner,
        "run_codex",
        lambda *_args: runner.CodexResponse("completed", "The homepage was updated."),
    )
    monkeypatch.setattr(
        runner,
        "send_reply",
        lambda message, body: sent.append((message.subject, body)),
    )

    first = runner.process_candidate(
        candidate(runner), state, path, tmp_path, workspace_dirs=[tmp_path], dry_run=False
    )
    second = runner.process_candidate(
        candidate(runner), state, path, tmp_path, workspace_dirs=[tmp_path], dry_run=False
    )

    assert first == "completed"
    assert second == "skipped"
    assert sent == [("Update the homepage", "The homepage was updated.")]
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["messages"][candidate(runner).state_key]["status"] == "replied"


def test_failed_codex_run_is_not_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runner = load_runner()
    state = runner.initial_state(100)
    path = tmp_path / "state.json"
    sent: list[str] = []

    def fail(*_args: Any) -> None:
        raise runner.MailCommandAgentError("simulated failure")

    monkeypatch.setattr(runner, "run_codex", fail)
    monkeypatch.setattr(runner, "send_reply", lambda _message, body: sent.append(body))

    first = runner.process_candidate(
        candidate(runner), state, path, tmp_path, workspace_dirs=[tmp_path], dry_run=False
    )
    second = runner.process_candidate(
        candidate(runner), state, path, tmp_path, workspace_dirs=[tmp_path], dry_run=False
    )

    assert first == "blocked"
    assert second == "skipped"
    assert len(sent) == 1
    assert "No automatic action retry" in sent[0]


def test_dry_run_never_delivers_a_pending_reply(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    state = runner.initial_state(100)
    path = tmp_path / "state.json"
    task = candidate(runner)
    runner.update_message_state(state, task.state_key, "ready_to_reply", 101, result="completed")
    monkeypatch.setattr(
        runner,
        "send_reply",
        lambda *_args: pytest.fail("A dry run must not send mail"),
    )

    result = runner.process_candidate(
        task,
        state,
        path,
        tmp_path,
        workspace_dirs=[tmp_path],
        dry_run=True,
    )

    assert result == "skipped"


def test_pending_reply_is_retried_without_rerunning_codex(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    state = runner.initial_state(100)
    path = tmp_path / "state.json"
    task = candidate(runner)
    output_path = runner.response_file(tmp_path, task.state_key)
    runner.save_codex_response(output_path, runner.CodexResponse("completed", "Done."))
    runner.update_message_state(state, task.state_key, "ready_to_reply", 101, result="completed")
    runner.save_state(path, state)
    sent: list[str] = []
    monkeypatch.setattr(
        runner,
        "run_codex",
        lambda *_args: pytest.fail("Codex must not rerun while a reply is pending"),
    )
    monkeypatch.setattr(runner, "send_reply", lambda _message, body: sent.append(body))

    result = runner.process_candidate(
        task,
        state,
        path,
        tmp_path,
        workspace_dirs=[tmp_path],
        dry_run=False,
    )

    assert result == "completed"
    assert sent == ["Done."]
    assert not output_path.exists()


def test_initialize_baselines_existing_messages(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    monkeypatch.setenv(runner.STATE_DIR_ENV, str(tmp_path))
    monkeypatch.setattr(runner, "now_epoch", lambda: 12345)

    result = runner.run(runner.parse_args(["--initialize"]))

    assert result == 0
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["scan_since"] == 12345
    assert state["messages"] == {}


def test_reinstall_preserves_existing_cursor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    monkeypatch.setenv(runner.STATE_DIR_ENV, str(tmp_path))
    runner.save_state(tmp_path / "state.json", runner.initial_state(12345))
    monkeypatch.setattr(runner, "now_epoch", lambda: 99999)

    result = runner.run(runner.parse_args(["--initialize"]))

    assert result == 0
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["scan_since"] == 12345


def test_existing_install_baselines_all_mail_before_scanning(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    monkeypatch.setenv(runner.STATE_DIR_ENV, str(tmp_path))
    runner.save_state(tmp_path / "state.json", runner.initial_state(100))
    monkeypatch.setattr(runner, "now_epoch", lambda: 200)
    scans: list[tuple[int, int | None]] = []

    def record_scan(inbox: int, sent: int | None) -> list[Any]:
        scans.append((inbox, sent))
        return []

    monkeypatch.setattr(runner, "fetch_candidates", record_scan)
    monkeypatch.setattr(runner, "default_workspace_dirs", lambda: [tmp_path])

    result = runner.run(runner.parse_args([]))

    assert result == 0
    assert scans == [(700, None)]
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["all_mail_scan_since"] == 200
    assert "sent_scan_since" not in state


def test_existing_install_migrates_sent_cursor_to_all_mail(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = load_runner()
    monkeypatch.setenv(runner.STATE_DIR_ENV, str(tmp_path))
    prior_state = runner.initial_state(100)
    prior_state["sent_scan_since"] = 150
    runner.save_state(tmp_path / "state.json", prior_state)
    monkeypatch.setattr(runner, "now_epoch", lambda: 200)
    scans: list[tuple[int, int | None]] = []

    def record_scan(inbox: int, all_mail: int | None) -> list[Any]:
        scans.append((inbox, all_mail))
        return []

    monkeypatch.setattr(runner, "fetch_candidates", record_scan)
    monkeypatch.setattr(runner, "default_workspace_dirs", lambda: [tmp_path])

    result = runner.run(runner.parse_args([]))

    assert result == 0
    assert scans == [(700, 650)]
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["all_mail_scan_since"] == 200
    assert "sent_scan_since" not in state


def test_mail_export_limits_all_mail_commands_to_agent_account() -> None:
    runner = load_runner()

    assert "if accountAddresses contains targetRecipient then" in runner.MAIL_EXPORT_APPLESCRIPT
    assert (
        'set allMailMailbox to mailbox "All Mail" of mailAccount' in runner.MAIL_EXPORT_APPLESCRIPT
    )
    assert (
        'set end of exportedIds to "all_mail" & tab & internalId' in runner.MAIL_EXPORT_APPLESCRIPT
    )


def test_mail_export_refreshes_mail_before_scanning() -> None:
    runner = load_runner()
    script = runner.MAIL_EXPORT_APPLESCRIPT

    assert 'tell application "Mail" to check for new mail' in script
    assert "delay 5" in script
    assert script.index('tell application "Mail" to check for new mail') < script.index(
        "set recentMessages to every message of inbox"
    )


def test_launchd_template_checks_every_minute() -> None:
    plist = PLIST_PATH.read_text(encoding="utf-8")

    assert "<integer>60</integer>" in plist
    assert "com.hushline.mail-command-agent" in plist
    assert "mail_command_agent.py" in plist


def test_send_reply_is_pinned_to_agent_and_glenn(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = load_runner()
    calls: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    runner.send_reply(candidate(runner), "Done.")

    assert calls[0][2:4] == ["agent@hushline.app", "glenn@hushline.app"]
    assert calls[0][4:6] == ["inbox", "42"]


def test_send_reply_uses_native_mail_reply_with_recipient_guards() -> None:
    runner = load_runner()
    script = runner.MAIL_SEND_APPLESCRIPT

    assert "reply sourceMessage opening window false" in script
    assert "set content of responseMessage to messageBody" in script
    assert "Native reply has an unexpected recipient count" in script
    assert "Native reply recipient does not match the authorized sender" in script
    assert "unexpectedly includes a CC recipient" in script
    assert "unexpectedly includes a BCC recipient" in script
    assert "Refusing to send an empty agent response" in script
    assert script.count("      tell responseMessage to send\n") == 1


def test_send_reply_rejects_an_empty_body(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = load_runner()

    def unexpected_run(*_args: Any, **_kwargs: Any) -> None:
        pytest.fail("Mail must not be called for an empty agent response")

    monkeypatch.setattr(runner.subprocess, "run", unexpected_run)
    with pytest.raises(runner.MailCommandAgentError, match="empty agent response"):
        runner.send_reply(candidate(runner), "  \n")
