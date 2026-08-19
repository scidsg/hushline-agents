#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import Any, TextIO

AUTHORIZED_SENDER = "glenn@hushline.app"
AGENT_ADDRESS = "agent@hushline.app"
CODEX_MODEL = "gpt-5.6-sol"
CODEX_REASONING_EFFORT = "high"
STATE_VERSION = 1
DEFAULT_POLL_OVERLAP_SECONDS = 600
MAX_LOOKBACK_SECONDS = 90 * 24 * 60 * 60
MAX_BODY_CHARACTERS = 100_000
MAX_REPLY_CHARACTERS = 20_000
MAX_STATE_MESSAGES = 1_000
CODEX_TIMEOUT_SECONDS = 4 * 60 * 60

STATE_DIR_ENV = "HUSHLINE_MAIL_COMMAND_AGENT_STATE_DIR"
WORKSPACE_DIRS_ENV = "HUSHLINE_MAIL_COMMAND_AGENT_WORKSPACE_DIRS"

MAIL_EXPORT_APPLESCRIPT = r"""
on writeUtf8(textValue, outputPath)
  set fileHandle to open for access POSIX file outputPath with write permission
  try
    set eof fileHandle to 0
    write textValue to fileHandle as «class utf8»
    close access fileHandle
  on error errorMessage number errorNumber
    try
      close access fileHandle
    end try
    error errorMessage number errorNumber
  end try
end writeUtf8

on run argv
  set allowedSender to item 1 of argv
  set targetRecipient to item 2 of argv
  set inboxLookbackSeconds to (item 3 of argv) as integer
  set allMailLookbackSeconds to (item 4 of argv) as integer
  set exportDirectory to item 5 of argv
  set inboxCutoffDate to (current date) - inboxLookbackSeconds
  set exportedIds to {}

  tell application "Mail" to check for new mail
  delay 5

  tell application "Mail"
    set recentMessages to every message of inbox whose date received is greater than inboxCutoffDate
    repeat with mailMessage in recentMessages
      set senderText to ""
      try
        set senderText to sender of mailMessage as text
      end try
      set recipientMatched to false
      try
        repeat with recipientRecord in to recipients of mailMessage
          set recipientAddress to address of recipientRecord as text
          ignoring case
            if recipientAddress is targetRecipient then set recipientMatched to true
          end ignoring
        end repeat
      end try

      set senderMatched to false
      ignoring case
        if senderText contains allowedSender then set senderMatched to true
      end ignoring

      if senderMatched and recipientMatched then
        set internalId to id of mailMessage as text
        set exportId to "inbox-" & internalId
        set rawSource to source of mailMessage as text
        set headerText to rawSource
        set headerDivider to return & linefeed & return & linefeed
        set dividerOffset to offset of headerDivider in rawSource
        if dividerOffset is greater than 0 then
          set headerText to text 1 thru (dividerOffset + 3) of rawSource
        end if
        set bodyText to ""
        try
          set bodyText to content of mailMessage as text
        end try
        my writeUtf8(headerText, exportDirectory & "/" & exportId & ".headers")
        my writeUtf8(bodyText, exportDirectory & "/" & exportId & ".body")
        set end of exportedIds to "inbox" & tab & internalId
      end if
    end repeat

    if allMailLookbackSeconds is greater than 0 then
      set allMailCutoffDate to (current date) - allMailLookbackSeconds
      repeat with mailAccount in every account
        set accountAddresses to email addresses of mailAccount
        if accountAddresses contains targetRecipient then
          try
            set allMailMailbox to mailbox "All Mail" of mailAccount
            set recentAllMailMessages to every message of allMailMailbox ¬
              whose date sent > allMailCutoffDate
            repeat with mailMessage in recentAllMailMessages
              set senderText to ""
              try
                set senderText to sender of mailMessage as text
              end try
              set recipientMatched to false
              try
                repeat with recipientRecord in to recipients of mailMessage
                  set recipientAddress to address of recipientRecord as text
                  ignoring case
                    if recipientAddress is targetRecipient then set recipientMatched to true
                  end ignoring
                end repeat
              end try

              set senderMatched to false
              ignoring case
                if senderText contains allowedSender then set senderMatched to true
              end ignoring

              if senderMatched and recipientMatched then
                set internalId to id of mailMessage as text
                set exportId to "all_mail-" & internalId
                set rawSource to source of mailMessage as text
                set headerText to rawSource
                set headerDivider to return & linefeed & return & linefeed
                set dividerOffset to offset of headerDivider in rawSource
                if dividerOffset is greater than 0 then
                  set headerText to text 1 thru (dividerOffset + 3) of rawSource
                end if
                set bodyText to ""
                try
                  set bodyText to content of mailMessage as text
                end try
                my writeUtf8(headerText, exportDirectory & "/" & exportId & ".headers")
                my writeUtf8(bodyText, exportDirectory & "/" & exportId & ".body")
                set end of exportedIds to "all_mail" & tab & internalId
              end if
            end repeat
          end try
        end if
      end repeat
    end if
  end tell

  set priorDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outputText to exportedIds as text
  set AppleScript's text item delimiters to priorDelimiters
  return outputText
end run
"""

MAIL_SEND_APPLESCRIPT = r"""
on run argv
  set fromAddress to item 1 of argv
  set toAddress to item 2 of argv
  set messageSubject to item 3 of argv
  set bodyPath to item 4 of argv
  set messageBody to read POSIX file bodyPath as «class utf8»

  tell application "Mail"
    set matchingAccount to missing value
    repeat with mailAccount in every account
      if (email addresses of mailAccount) contains fromAddress then
        set matchingAccount to mailAccount
        exit repeat
      end if
    end repeat
    if matchingAccount is missing value then
      error "Mail account not found for " & fromAddress
    end if

    set responseMessage to make new outgoing message
    set subject of responseMessage to messageSubject
    set content of responseMessage to messageBody
    set visible of responseMessage to false
    tell responseMessage
      set sender to fromAddress
      make new to recipient at end of to recipients with properties {address:toAddress}
      send
    end tell
  end tell
end run
"""

CODEX_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {
            "type": "string",
            "enum": ["completed", "needs_clarification", "blocked"],
        },
        "reply_body": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_REPLY_CHARACTERS,
        },
    },
    "required": ["status", "reply_body"],
    "additionalProperties": False,
}


class MailCommandAgentError(Exception):
    """Raised when the mail command agent cannot safely continue."""


@dataclass(frozen=True)
class CandidateMessage:
    internal_id: str
    message_id: str
    subject: str
    body: str
    headers: EmailMessage
    mailbox_source: str = "inbox"

    @property
    def state_key(self) -> str:
        return hashlib.sha256(self.message_id.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CodexResponse:
    status: str
    reply_body: str


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Process authenticated Mail.app commands from glenn@hushline.app addressed "
            "to agent@hushline.app."
        )
    )
    parser.add_argument(
        "--initialize",
        action="store_true",
        help="Create a fresh cursor at the current time without processing existing mail.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect new candidates without invoking Codex, replying, or advancing state.",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Verify Mail.app and Codex prerequisites without reading message bodies.",
    )
    return parser.parse_args(argv)


def now_epoch() -> int:
    return int(time.time())


def default_state_dir() -> Path:
    configured = os.environ.get(STATE_DIR_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    return (
        Path.home() / "Library" / "Application Support" / "Hush Line Agents" / "mail-command-agent"
    )


def default_workspace_dirs() -> list[Path]:
    configured = os.environ.get(WORKSPACE_DIRS_ENV, "").strip()
    if configured:
        candidates = [Path(value).expanduser() for value in configured.split(os.pathsep) if value]
    else:
        candidates = [
            Path.home() / "hushline",
            Path.home() / "hushline-agents",
            Path.home() / "hushline-docs",
            Path.home() / "hushline-finance",
            Path.home() / "hushline-social",
            Path.home() / "hushline-quotes",
        ]
    return [path.resolve() for path in candidates if path.is_dir()]


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def state_path(state_dir: Path) -> Path:
    return state_dir / "state.json"


def initial_state(timestamp: int) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "initialized_at": timestamp,
        "scan_since": timestamp,
        "messages": {},
    }


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MailCommandAgentError(f"Unable to read mail agent state: {error}") from error
    if state.get("version") != STATE_VERSION or not isinstance(state.get("messages"), dict):
        raise MailCommandAgentError("Unsupported or invalid mail agent state file.")
    return state


def write_json_private(path: Path, value: object) -> None:
    ensure_private_directory(path.parent)
    temp_path = path.with_name(f".{path.name}.tmp")
    temp_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp_path.chmod(0o600)
    temp_path.replace(path)


def save_state(path: Path, state: dict[str, Any]) -> None:
    messages = state["messages"]
    if len(messages) > MAX_STATE_MESSAGES:
        oldest_first = sorted(
            messages,
            key=lambda key: int(messages[key].get("updated_at", 0)),
        )
        for key in oldest_first[: len(messages) - MAX_STATE_MESSAGES]:
            del messages[key]
    write_json_private(path, state)


def message_addresses(headers: EmailMessage, header_name: str) -> list[str]:
    values = headers.get_all(header_name, [])
    return [address.lower() for _name, address in getaddresses(values) if address]


def authentication_result_is_valid(headers: EmailMessage) -> bool:
    results = headers.get_all("Authentication-Results", [])
    if not results:
        return False
    trusted_result = " ".join(str(results[0]).split()).lower()
    dkim_passed = bool(
        re.search(r"(?:^|;)\s*dkim=pass\b[^;]*\bheader\.d=hushline\.app\b", trusted_result)
    )
    dmarc_passed = bool(
        re.search(
            r"(?:^|;)\s*dmarc=pass\b[^;]*\bheader\.from=hushline\.app\b",
            trusted_result,
        )
    )
    return dkim_passed and dmarc_passed


def proton_internal_origin_is_valid(headers: EmailMessage) -> bool:
    origins = [str(value).strip().lower() for value in headers.get_all("X-Pm-Origin", [])]
    return origins == ["internal"]


def validate_headers(headers: EmailMessage) -> tuple[bool, str]:
    return validate_candidate_headers(headers, "inbox")


def validate_candidate_headers(headers: EmailMessage, mailbox_source: str) -> tuple[bool, str]:
    from_addresses = message_addresses(headers, "From")
    if from_addresses != [AUTHORIZED_SENDER]:
        return False, "from_mismatch"
    to_addresses = message_addresses(headers, "To")
    if AGENT_ADDRESS not in to_addresses:
        return False, "recipient_mismatch"
    message_id = str(headers.get("Message-ID", "")).strip()
    if not message_id:
        return False, "missing_message_id"
    if mailbox_source == "all_mail":
        if authentication_result_is_valid(headers):
            return True, "authenticated"
        if proton_internal_origin_is_valid(headers):
            return True, "trusted_proton_internal"
        return False, "authentication_failed"
    if mailbox_source != "inbox":
        return False, "invalid_mailbox_source"
    if not authentication_result_is_valid(headers):
        return False, "authentication_failed"
    return True, "authenticated"


def parse_candidate(export_dir: Path, mailbox_source: str, internal_id: str) -> CandidateMessage:
    export_id = f"{mailbox_source}-{internal_id}"
    header_path = export_dir / f"{export_id}.headers"
    body_path = export_dir / f"{export_id}.body"
    try:
        parsed = BytesParser(policy=policy.default).parsebytes(header_path.read_bytes())
        body = body_path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise MailCommandAgentError(
            f"Unable to read Mail.app export {internal_id}: {error}"
        ) from error
    if not isinstance(parsed, EmailMessage):
        raise MailCommandAgentError("Mail.app exported an unsupported message format.")
    message_id = str(parsed.get("Message-ID", "")).strip()
    subject = str(parsed.get("Subject", "(no subject)"))[:998]
    return CandidateMessage(
        internal_id=internal_id,
        message_id=message_id,
        subject=subject,
        body=body[:MAX_BODY_CHARACTERS],
        headers=parsed,
        mailbox_source=mailbox_source,
    )


def fetch_candidates(
    inbox_lookback_seconds: int, all_mail_lookback_seconds: int | None
) -> list[CandidateMessage]:
    bounded_inbox_lookback = max(1, min(inbox_lookback_seconds, MAX_LOOKBACK_SECONDS))
    bounded_all_mail_lookback = (
        0
        if all_mail_lookback_seconds is None
        else max(1, min(all_mail_lookback_seconds, MAX_LOOKBACK_SECONDS))
    )
    with tempfile.TemporaryDirectory(prefix="hushline-mail-agent-") as temp_dir_name:
        export_dir = Path(temp_dir_name)
        result = subprocess.run(  # noqa: S603 - fixed executable and data-only arguments.
            [
                "/usr/bin/osascript",
                "-",
                AUTHORIZED_SENDER,
                AGENT_ADDRESS,
                str(bounded_inbox_lookback),
                str(bounded_all_mail_lookback),
                str(export_dir),
            ],
            input=MAIL_EXPORT_APPLESCRIPT,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip() or "no Mail.app output"
            raise MailCommandAgentError(f"Mail.app scan failed: {detail}")
        exported_messages = [
            value.strip().partition("\t") for value in result.stdout.splitlines() if value.strip()
        ]
        if any(
            not separator or mailbox_source not in {"inbox", "all_mail"}
            for mailbox_source, separator, _internal_id in exported_messages
        ):
            raise MailCommandAgentError("Mail.app returned an invalid candidate identifier.")
        candidates = [
            parse_candidate(export_dir, mailbox_source, internal_id)
            for mailbox_source, _separator, internal_id in exported_messages
        ]
    candidates.reverse()
    return candidates


def build_prompt(message: CandidateMessage, workspace_dirs: list[Path]) -> str:
    workspace_lines = "\n".join(f"- {path}" for path in workspace_dirs)
    authentication_summary = (
        "Proton marked the exact-address message as internally originated"
        if message.mailbox_source == "all_mail" and proton_internal_origin_is_valid(message.headers)
        else "aligned DKIM and DMARC passed for hushline.app"
    )
    return f"""You are Hush Line's local Mail command agent.

The wrapper authenticated this message as:
- From: {AUTHORIZED_SENDER}
- To: {AGENT_ADDRESS}
- Authentication: {authentication_summary}

Glenn has authorized you to act on the task stated in the subject and body below. Follow all
AGENTS.md instructions in every repository you touch. Those repository policies remain
authoritative. Inspect current state before changing anything, preserve unrelated work, use only
approved models and workflows, and validate changes in proportion to their risk.

If the request is sufficiently clear, accomplish it fully. If a material choice is missing, do not
guess: ask the minimum concise clarifying question. Do not perform destructive, irreversible, or
external communication actions unless the email explicitly requests them. Do not send email
yourself; the trusted wrapper sends your final response only to {AUTHORIZED_SENDER}. Never include
secrets, tokens, private keys, raw private email headers, or sensitive unrelated data in the reply.

Available workspaces:
{workspace_lines}

<authorized_email_subject>
{message.subject}
</authorized_email_subject>

<authorized_email_body>
{message.body}
</authorized_email_body>

Return a concise, self-contained email reply. Use status "completed" when the requested work is
done, "needs_clarification" when Glenn must answer before work can safely continue, or "blocked"
when the task could not be completed. The reply must say what happened and include any important
validation, link, or next step.
"""


def primary_workspace(workspace_dirs: list[Path]) -> Path:
    preferred = (Path.home() / "hushline").resolve()
    for path in workspace_dirs:
        if path == preferred:
            return path
    if not workspace_dirs:
        raise MailCommandAgentError("No configured workspace directories exist.")
    return workspace_dirs[0]


def codex_command(workspace_dirs: list[Path], schema_path: Path, output_path: Path) -> list[str]:
    codex_binary = shutil.which("codex")
    if not codex_binary:
        raise MailCommandAgentError("codex is not available on PATH.")
    primary = primary_workspace(workspace_dirs)
    command = [
        codex_binary,
        "exec",
        "--model",
        CODEX_MODEL,
        "-c",
        f'model_reasoning_effort="{CODEX_REASONING_EFFORT}"',
        # Automatic approval review already selects the workspace-write sandbox. Codex CLI
        # rejects an explicit --sandbox flag when --approve-for-me is present.
        "--approve-for-me",
        "--ephemeral",
        "--cd",
        str(primary),
    ]
    for workspace in workspace_dirs:
        if workspace != primary:
            command.extend(["--add-dir", str(workspace)])
    command.extend(
        [
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(output_path),
            "-",
        ]
    )
    return command


def parse_codex_response(path: Path) -> CodexResponse:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MailCommandAgentError(
            f"Codex did not return a valid structured response: {error}"
        ) from error
    status = payload.get("status")
    reply_body = payload.get("reply_body")
    if status not in {"completed", "needs_clarification", "blocked"}:
        raise MailCommandAgentError("Codex returned an invalid response status.")
    if not isinstance(reply_body, str) or not reply_body.strip():
        raise MailCommandAgentError("Codex returned an empty reply.")
    return CodexResponse(status=status, reply_body=reply_body.strip()[:MAX_REPLY_CHARACTERS])


def run_codex(
    message: CandidateMessage, workspace_dirs: list[Path], response_path: Path
) -> CodexResponse:
    ensure_private_directory(response_path.parent)
    schema_path = response_path.with_suffix(".schema.json")
    write_json_private(schema_path, CODEX_RESPONSE_SCHEMA)
    response_path.unlink(missing_ok=True)
    try:
        result = subprocess.run(  # noqa: S603 - argument list is constructed without a shell.
            codex_command(workspace_dirs, schema_path, response_path),
            input=build_prompt(message, workspace_dirs),
            capture_output=True,
            text=True,
            check=False,
            timeout=CODEX_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise MailCommandAgentError("Codex task exceeded the four-hour timeout.") from error
    finally:
        schema_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise MailCommandAgentError(f"Codex task exited with status {result.returncode}.")
    response_path.chmod(0o600)
    return parse_codex_response(response_path)


def reply_subject(original_subject: str) -> str:
    normalized = " ".join(original_subject.replace("\r", " ").replace("\n", " ").split())
    if not normalized.lower().startswith("re:"):
        normalized = f"Re: {normalized}"
    return normalized[:998]


def send_reply(subject: str, body: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".txt", delete=False
    ) as body_file:
        body_file.write(body)
        body_path = Path(body_file.name)
    body_path.chmod(0o600)
    try:
        result = subprocess.run(  # noqa: S603 - fixed executable and data-only arguments.
            [
                "/usr/bin/osascript",
                "-",
                AGENT_ADDRESS,
                AUTHORIZED_SENDER,
                reply_subject(subject),
                str(body_path),
            ],
            input=MAIL_SEND_APPLESCRIPT,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    finally:
        body_path.unlink(missing_ok=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "no Mail.app output"
        raise MailCommandAgentError(f"Mail.app reply failed: {detail}")


def response_file(state_dir: Path, state_key: str) -> Path:
    return state_dir / "responses" / f"{state_key}.json"


def save_codex_response(path: Path, response: CodexResponse) -> None:
    write_json_private(
        path,
        {
            "status": response.status,
            "reply_body": response.reply_body,
        },
    )


def update_message_state(
    state: dict[str, Any], state_key: str, status: str, timestamp: int, **details: object
) -> None:
    state["messages"][state_key] = {
        "status": status,
        "updated_at": timestamp,
        **details,
    }


def process_candidate(  # noqa: PLR0913 - explicit dependencies keep the mail boundary testable.
    message: CandidateMessage,
    state: dict[str, Any],
    path: Path,
    state_dir: Path,
    *,
    workspace_dirs: list[Path],
    dry_run: bool,
) -> str:
    valid, reason = validate_candidate_headers(message.headers, message.mailbox_source)
    key = message.state_key
    short_key = key[:12]
    if not valid:
        if not dry_run:
            update_message_state(state, key, "rejected", now_epoch(), reason=reason)
            save_state(path, state)
        print(f"Rejected mail command {short_key}: {reason}.")
        return "rejected"

    prior = state["messages"].get(key)
    if prior:
        prior_status = prior.get("status")
        if dry_run:
            print(f"Skipped previously handled mail command {short_key}.")
            return "skipped"
        if prior_status == "ready_to_reply":
            output_path = response_file(state_dir, key)
            response = parse_codex_response(output_path)
            send_reply(message.subject, response.reply_body)
            update_message_state(state, key, "replied", now_epoch(), result=response.status)
            save_state(path, state)
            output_path.unlink(missing_ok=True)
            print(f"Delivered pending reply for mail command {short_key}: {response.status}.")
            return response.status
        if prior_status == "processing":
            interrupted_body = (
                "The local Codex run for this request ended unexpectedly and may have partially "
                "changed local or remote state. I will not rerun it automatically. Please check "
                "the mail-command-agent logs and current repository state before resending it."
            )
            send_reply(message.subject, interrupted_body)
            update_message_state(state, key, "interrupted_replied", now_epoch())
            save_state(path, state)
            print(f"Reported interrupted mail command {short_key} to the authorized sender.")
            return "blocked"
        print(f"Skipped previously handled mail command {short_key}.")
        return "skipped"
    if dry_run:
        print(f"Would process authenticated mail command {short_key}.")
        return "eligible"

    timestamp = now_epoch()
    update_message_state(state, key, "processing", timestamp)
    save_state(path, state)
    output_path = response_file(state_dir, key)
    try:
        response = run_codex(message, workspace_dirs, output_path)
    except MailCommandAgentError as error:
        response = CodexResponse(
            status="blocked",
            reply_body=(
                "I could not complete this request because the local Codex run failed. No "
                "automatic action retry will be attempted, because the task may have partially "
                "changed local state. Please check the mail-command-agent logs before resending "
                f"the request.\n\nFailure: {error}"
            ),
        )
        save_codex_response(output_path, response)

    update_message_state(state, key, "ready_to_reply", now_epoch(), result=response.status)
    save_state(path, state)
    send_reply(message.subject, response.reply_body)
    update_message_state(state, key, "replied", now_epoch(), result=response.status)
    save_state(path, state)
    output_path.unlink(missing_ok=True)
    print(f"Completed and replied to mail command {short_key}: {response.status}.")
    return response.status


def diagnose() -> int:
    codex_binary = shutil.which("codex")
    if not codex_binary:
        print("Codex: unavailable", file=sys.stderr)
        return 1
    mail_check = subprocess.run(  # noqa: S603 - fixed executable and fixed script.
        [
            "/usr/bin/osascript",
            "-e",
            (
                'tell application "Mail" to return '
                f'((email addresses of every account) as text) contains "{AGENT_ADDRESS}"'
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if mail_check.returncode != 0 or mail_check.stdout.strip().lower() != "true":
        print(f"Mail.app sender account {AGENT_ADDRESS}: unavailable", file=sys.stderr)
        return 1
    login_check = subprocess.run(  # noqa: S603 - resolved Codex executable, fixed arguments.
        [codex_binary, "login", "status"],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if login_check.returncode != 0:
        print("Codex authentication: unavailable", file=sys.stderr)
        return 1
    print(f"Mail.app sender account: {AGENT_ADDRESS}")
    print(f"Authorized command sender: {AUTHORIZED_SENDER}")
    print(f"Codex: {CODEX_MODEL} ({CODEX_REASONING_EFFORT})")
    return 0


def acquire_lock(state_dir: Path) -> TextIO | None:
    ensure_private_directory(state_dir)
    lock_file = (state_dir / "runner.lock").open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_file.close()
        return None
    return lock_file


def run(args: argparse.Namespace) -> int:
    if args.diagnose:
        return diagnose()
    state_dir = default_state_dir()
    ensure_private_directory(state_dir)
    lock_file = acquire_lock(state_dir)
    if lock_file is None:
        print("Skipped: another mail command agent run is active.")
        return 0
    try:
        path = state_path(state_dir)
        timestamp = now_epoch()
        state = load_state(path)
        if state is None:
            save_state(path, initial_state(timestamp))
            print("Initialized mail command cursor; existing messages will not be processed.")
            return 0
        if args.initialize:
            print("Mail command cursor already exists; existing state was preserved.")
            return 0

        scan_started_at = timestamp
        scan_since = int(state.get("scan_since", scan_started_at))
        inbox_lookback_seconds = scan_started_at - scan_since + DEFAULT_POLL_OVERLAP_SECONDS
        all_mail_scan_since = state.get("all_mail_scan_since", state.get("sent_scan_since"))
        all_mail_lookback_seconds = (
            None
            if all_mail_scan_since is None
            else scan_started_at - int(all_mail_scan_since) + DEFAULT_POLL_OVERLAP_SECONDS
        )
        candidates = fetch_candidates(inbox_lookback_seconds, all_mail_lookback_seconds)
        workspace_dirs = default_workspace_dirs()
        results = [
            process_candidate(
                message,
                state,
                path,
                state_dir,
                workspace_dirs=workspace_dirs,
                dry_run=args.dry_run,
            )
            for message in candidates
        ]
        if not args.dry_run:
            state["scan_since"] = scan_started_at
            state["all_mail_scan_since"] = scan_started_at
            state.pop("sent_scan_since", None)
            save_state(path, state)
            if all_mail_scan_since is None:
                print("Initialized All Mail cursor; existing messages were not processed.")
        eligible = sum(result not in {"rejected", "skipped"} for result in results)
        print(f"Mail command scan complete: candidates={len(candidates)} actionable={eligible}.")
        return 0
    finally:
        lock_file.close()


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    try:
        return run(parse_args(argv or sys.argv[1:]))
    except MailCommandAgentError as error:
        print(f"Mail command agent failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
