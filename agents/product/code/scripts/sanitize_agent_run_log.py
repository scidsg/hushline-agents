#!/usr/bin/env python3
"""Redact sensitive values from persisted agent run logs."""

from __future__ import annotations

import re
import sys
from pathlib import Path

EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])")
USER_PATH_RE = re.compile(r"/(?:Users|home)/[^\s\"']+")
URL_CREDENTIAL_RE = re.compile(r"(https?://)[^/@\s:]+:[^/@\s]+@", re.IGNORECASE)
AUTH_HEADER_RE = re.compile(r"\b(authorization\s*:\s*(?:bearer|basic))\s+[^,\s;]+", re.IGNORECASE)
AUTH_SCHEME_RE = re.compile(r"(^|[^\w])((?:Bearer|Basic))\s+[^,\s;]+", re.IGNORECASE)
COOKIE_HEADER_RE = re.compile(r"\b((?:set-)?cookie\s*:\s*).+", re.IGNORECASE)
AWS_ACCESS_KEY_RE = re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
COMMON_TOKEN_RE = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{20,})\b"
)
PRIVATE_KEY_BEGIN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
PRIVATE_KEY_END_RE = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY-----")
SECRET_ASSIGNMENT_RE = re.compile(
    r"(^|[\s\"'([{<,;])"
    r"(?P<key>(?:[A-Z0-9]+[_-])*"
    r"(?:api[_-]?key|x[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"id[_-]?token|token|secret|password|passwd|pwd|cookie|session(?:[_-]?id)?|"
    r"client[_-]?secret|private[_-]?key))"
    r"(?P<sep>\s*[:=]\s*|\s+)"
    r"[^,\s;]+",
    re.IGNORECASE,
)
EXPECTED_ARGC = 3
KEY_REPLACEMENTS = {
    "Runner Codex config:": "Runner Codex config: [redacted]",
    "Configured git identity:": "Configured git identity: [redacted]",
    "Run log file:": "Run log file: [redacted]",
    "Global log file:": "Global log file: [redacted]",
    "workdir:": "workdir: [redacted]",
    "model:": "model: [redacted]",
    "provider:": "provider: [redacted]",
    "approval:": "approval: [redacted]",
    "sandbox:": "sandbox: [redacted]",
    "reasoning effort:": "reasoning effort: [redacted]",
    "reasoning summaries:": "reasoning summaries: [redacted]",
    "session id:": "session id: [redacted]",
}


def sanitize_secret_values(line: str) -> str:
    line = URL_CREDENTIAL_RE.sub(r"\1[redacted]@", line)
    line = COOKIE_HEADER_RE.sub(r"\1[redacted]", line)
    line = AUTH_HEADER_RE.sub(r"\1 [redacted]", line)
    line = AUTH_SCHEME_RE.sub(r"\1\2 [redacted]", line)
    line = AWS_ACCESS_KEY_RE.sub("[redacted-aws-access-key]", line)
    line = COMMON_TOKEN_RE.sub("[redacted-token]", line)
    return SECRET_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}{match.group('key')}{match.group('sep')}[redacted]",
        line,
    )


def sanitize_text(text: str) -> str:
    sanitized_lines: list[str] = []
    in_private_key = False
    for line in text.splitlines():
        if in_private_key:
            if PRIVATE_KEY_END_RE.search(line):
                sanitized_lines.append(
                    PRIVATE_KEY_END_RE.sub("-----END [redacted-private-key]-----", line)
                )
                in_private_key = False
            else:
                sanitized_lines.append("[redacted-private-key]")
            continue

        if PRIVATE_KEY_BEGIN_RE.search(line):
            sanitized_lines.append(
                PRIVATE_KEY_BEGIN_RE.sub("-----BEGIN [redacted-private-key]-----", line)
            )
            if not PRIVATE_KEY_END_RE.search(line):
                in_private_key = True
            continue

        stripped = line.lstrip()
        replacement = next(
            (value for prefix, value in KEY_REPLACEMENTS.items() if stripped.startswith(prefix)),
            None,
        )
        if replacement is not None:
            indent = line[: len(line) - len(stripped)]
            sanitized_lines.append(f"{indent}{replacement}")
            continue

        sanitized_line = USER_PATH_RE.sub("[redacted-path]", line)
        sanitized_line = sanitize_secret_values(sanitized_line)
        sanitized_line = EMAIL_RE.sub("[redacted-email]", sanitized_line)
        sanitized_lines.append(sanitized_line)

    return "\n".join(sanitized_lines) + ("\n" if text.endswith("\n") else "")


def main() -> int:
    if len(sys.argv) != EXPECTED_ARGC:
        print("usage: sanitize_agent_run_log.py <input> <output>", file=sys.stderr)
        return 1

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    sanitized = sanitize_text(input_path.read_text(encoding="utf-8"))
    output_path.write_text(sanitized, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
