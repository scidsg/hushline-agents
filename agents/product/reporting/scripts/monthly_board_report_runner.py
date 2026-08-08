#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REPORT_TITLE = "Hush Line Monthly Board Report"
REPORT_TO_ENV = "HUSHLINE_MONTHLY_BOARD_REPORT_TO"
REPORT_OUTPUT_DIR_ENV = "HUSHLINE_MONTHLY_BOARD_REPORT_OUTPUT_DIR"
REPORT_RETENTION_ENV = "HUSHLINE_MONTHLY_BOARD_REPORT_RETENTION"
REPORT_STATE_FILE_ENV = "HUSHLINE_MONTHLY_BOARD_REPORT_STATE_FILE"
REPOS_ENV = "HUSHLINE_MONTHLY_BOARD_REPORT_REPOS"
DEFAULT_REPORT_FROM = "admin@hushline.app"
DEFAULT_REPORT_TO = "glenn@hushline.app"
DEFAULT_REPORT_RETENTION = 24
LOCAL_TZ = ZoneInfo("America/Los_Angeles")
UTC = timezone.utc  # noqa: UP017 - launchd may run this with Apple's Python 3.9.
MAIL_APP_APPLESCRIPT_TIMEOUT_SECONDS = 300
MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS = MAIL_APP_APPLESCRIPT_TIMEOUT_SECONDS + 30
MAIL_APP_APPLE_EVENT_TIMEOUT_CODE = "-1712"
MAX_CATEGORY_ITEMS = 12
MAX_REPO_ITEMS = 8
DECEMBER = 12
COMMIT_LOG_FIELD_COUNT = 3
TAG_FIELD_COUNT = 2
GIT_EXECUTABLE = "/usr/bin/git"

MAIL_APP_APPLESCRIPT = r"""
on run argv
  set fromAddress to item 1 of argv
  set toAddress to item 2 of argv
  set messageSubject to item 3 of argv
  set bodyPath to item 4 of argv
  set messageBody to read POSIX file bodyPath

  with timeout of 300 seconds
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

      set reportMessage to make new outgoing message
      set subject of reportMessage to messageSubject
      set content of reportMessage to messageBody
      set visible of reportMessage to false
      tell reportMessage
        set sender to fromAddress
        make new to recipient at end of to recipients with properties {address:toAddress}
        ignoring application responses
          send
        end ignoring
      end tell
    end tell
  end timeout
end run
"""


@dataclass(frozen=True)
class RepoSpec:
    name: str
    path: Path


@dataclass(frozen=True)
class CommitRecord:
    repo: str
    sha: str
    committed_at: datetime
    subject: str


@dataclass(frozen=True)
class RepoSummary:
    spec: RepoSpec
    exists: bool
    commit_count: int
    likely_pr_count: int
    release_count: int
    releases: list[str]
    commits: list[CommitRecord]
    warning: str = ""


@dataclass(frozen=True)
class ReportWindow:
    month_key: str
    start_date: date
    end_date: date


class RunnerError(Exception):
    """Raised when the monthly report runner cannot complete safely."""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a deterministic monthly Hush Line board report through Mail.app.",
    )
    parser.add_argument(
        "--date",
        type=parse_date,
        help="Local date to evaluate. Defaults to today in America/Los_Angeles.",
    )
    parser.add_argument(
        "--month",
        type=parse_month,
        help="Report month in YYYY-MM format. Defaults to the evaluated date's month.",
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help=(
            "Repository to include as NAME=PATH. Can be repeated. Defaults to the local "
            "Hush Line product, agents, and finance operations checkouts when present."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the report instead of sending or updating idempotency state.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Bypass the last-day and already-sent gates.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write the generated report body to this path.",
    )
    parser.add_argument(
        "--report-output-dir",
        type=Path,
        help=(
            "Directory for persisted monthly report bodies. Defaults to "
            f"{REPORT_OUTPUT_DIR_ENV} or logs/monthly-board-reports."
        ),
    )
    parser.add_argument(
        "--report-retention",
        type=int,
        default=int(os.environ.get(REPORT_RETENTION_ENV, DEFAULT_REPORT_RETENTION)),
        help=(
            "Number of persisted monthly report files to keep. Set to 0 to disable pruning. "
            f"Default: {DEFAULT_REPORT_RETENTION}."
        ),
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        help=(
            "Path to the idempotency state file. Defaults to "
            f"{REPORT_STATE_FILE_ENV} or logs/monthly-board-reports/state.json."
        ),
    )
    parser.add_argument(
        "--no-persist",
        action="store_true",
        help="Do not write the default persisted report artifact.",
    )
    return parser.parse_args(argv)


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--date must use YYYY-MM-DD") from exc


def parse_month(value: str) -> date:
    if not re.match(r"^\d{4}-\d{2}$", value):
        raise argparse.ArgumentTypeError("--month must use YYYY-MM")
    try:
        return date.fromisoformat(f"{value}-01")
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--month must use YYYY-MM") from exc


def today_local() -> date:
    return datetime.now(LOCAL_TZ).date()


def month_end(month_start: date) -> date:
    if month_start.month == DECEMBER:
        next_month = date(month_start.year + 1, 1, 1)
    else:
        next_month = date(month_start.year, month_start.month + 1, 1)
    return date.fromordinal(next_month.toordinal() - 1)


def is_last_day(value: date) -> bool:
    return value == month_end(date(value.year, value.month, 1))


def report_window(effective_date: date, requested_month: date | None) -> ReportWindow:
    month_start = requested_month or date(effective_date.year, effective_date.month, 1)
    return ReportWindow(
        month_key=month_start.strftime("%Y-%m"),
        start_date=month_start,
        end_date=month_end(month_start),
    )


def report_from() -> str:
    return DEFAULT_REPORT_FROM


def report_to() -> str:
    return os.environ.get(REPORT_TO_ENV, DEFAULT_REPORT_TO).strip()


def default_repo_specs() -> list[RepoSpec]:
    root = repo_root()
    parent = root.parent
    specs = [
        RepoSpec("Hush Line product", parent / "hushline"),
        RepoSpec("Hush Line agents", root),
        RepoSpec("Finance operations", parent / "hushline-finance"),
    ]
    return [spec for spec in specs if spec.path.exists()]


def parse_repo_spec(value: str) -> RepoSpec:
    if "=" not in value:
        raise RunnerError(f"Repository spec must use NAME=PATH: {value}")
    name, raw_path = value.split("=", 1)
    name = name.strip()
    path = Path(raw_path).expanduser()
    if not name or not raw_path.strip():
        raise RunnerError(f"Repository spec must use NAME=PATH: {value}")
    return RepoSpec(name, path)


def repo_specs(cli_specs: list[str]) -> list[RepoSpec]:
    if cli_specs:
        return [parse_repo_spec(value) for value in cli_specs]

    env_value = os.environ.get(REPOS_ENV, "")
    if env_value:
        return [parse_repo_spec(value) for value in env_value.split(os.pathsep) if value]

    return default_repo_specs()


def run_git(path: Path, args: list[str]) -> str:
    result = subprocess.run(  # noqa: S603 - args are fixed git invocation lists.
        [GIT_EXECUTABLE, "-C", str(path), *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown git error"
        raise RunnerError(f"git failed for {path}: {detail}")
    return result.stdout


def window_datetimes(window: ReportWindow) -> tuple[datetime, datetime]:
    start = datetime.combine(window.start_date, time.min, tzinfo=LOCAL_TZ)
    end = datetime.combine(window.end_date, time.max, tzinfo=LOCAL_TZ)
    return start, end


def collect_commits(spec: RepoSpec, window: ReportWindow) -> list[CommitRecord]:
    start, end = window_datetimes(window)
    output = run_git(
        spec.path,
        [
            "log",
            "--all",
            f"--since={start.isoformat()}",
            f"--until={end.isoformat()}",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%ad%x1f%s",
        ],
    )
    commits: list[CommitRecord] = []
    for line in output.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) != COMMIT_LOG_FIELD_COUNT:
            continue
        sha, raw_date, subject = parts
        commits.append(
            CommitRecord(
                repo=spec.name,
                sha=sha,
                committed_at=datetime.fromisoformat(raw_date),
                subject=subject,
            ),
        )
    return commits


def collect_releases(spec: RepoSpec, window: ReportWindow) -> list[str]:
    start, end = window_datetimes(window)
    output = run_git(
        spec.path,
        [
            "for-each-ref",
            "refs/tags",
            "--format=%(creatordate:iso-strict) %(refname:short)",
        ],
    )
    releases = []
    for line in output.splitlines():
        parts = line.split(" ", 1)
        if len(parts) != TAG_FIELD_COUNT or not parts[0].strip():
            continue
        created_at = datetime.fromisoformat(parts[0])
        if start <= created_at.astimezone(LOCAL_TZ) <= end:
            releases.append(parts[1])
    return sorted(releases, key=release_sort_key)


def release_sort_key(value: str) -> tuple[tuple[int, str], ...]:
    parts: list[tuple[int, str]] = []
    for item in re.split(r"([0-9]+)", value):
        if not item:
            continue
        if item.isdigit():
            parts.append((0, f"{int(item):020d}"))
        else:
            parts.append((1, item.lower()))
    return tuple(parts)


def summarize_repo(spec: RepoSpec, window: ReportWindow) -> RepoSummary:
    if not spec.path.exists():
        return RepoSummary(spec, False, 0, 0, 0, [], [], "repository path does not exist")
    if not (spec.path / ".git").exists():
        return RepoSummary(spec, False, 0, 0, 0, [], [], "repository path is not a git checkout")
    try:
        commits = collect_commits(spec, window)
        releases = collect_releases(spec, window)
    except RunnerError as exc:
        return RepoSummary(spec, False, 0, 0, 0, [], [], str(exc))
    likely_pr_count = sum(1 for commit in commits if likely_pr_commit(commit.subject))
    return RepoSummary(
        spec=spec,
        exists=True,
        commit_count=len(commits),
        likely_pr_count=likely_pr_count,
        release_count=len(releases),
        releases=releases,
        commits=commits,
    )


def likely_pr_commit(subject: str) -> bool:
    return bool(re.search(r"\(#\d+\)$", subject)) or subject.startswith("Merge pull request")


CATEGORY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "Privacy, Safety, and Security",
        (
            "auth",
            "csp",
            "encrypt",
            "security",
            "privacy",
            "anonymous",
            "abuse",
            "csrf",
            "xss",
            "origin",
            "verified",
            "verification",
        ),
    ),
    (
        "Product Experience",
        (
            "ui",
            "ux",
            "onboarding",
            "conversation",
            "message",
            "profile",
            "directory",
            "receiver",
            "contact",
            "screenshot",
            "mobile",
        ),
    ),
    (
        "Operations and Automation",
        (
            "agent",
            "runner",
            "workflow",
            "launchd",
            "automation",
            "social",
            "linkedin",
            "report",
            "planner",
            "schedule",
        ),
    ),
    (
        "Finance and Administration",
        (
            "finance",
            "invoice",
            "billing",
            "quickbooks",
            "wells",
            "bank",
            "reconciliation",
            "board",
            "donor",
            "grant",
        ),
    ),
    (
        "Documentation and Governance",
        (
            "doc",
            "readme",
            "policy",
            "guide",
            "governance",
            "release",
            "changelog",
        ),
    ),
    (
        "Reliability and Maintenance",
        (
            "test",
            "lint",
            "ci",
            "fix",
            "bug",
            "refactor",
            "dependency",
            "deps",
            "upgrade",
            "migration",
        ),
    ),
)


def categorize_commit(subject: str) -> str:
    text = subject.lower()
    for category, keywords in CATEGORY_RULES:
        if any(keyword in text for keyword in keywords):
            return category
    return "Other Progress"


def category_order() -> list[str]:
    return [category for category, _keywords in CATEGORY_RULES] + ["Other Progress"]


def format_count(value: int) -> str:
    return f"{value:,}"


def pluralize(count: int, singular: str, plural: str | None = None) -> str:
    label = singular if count == 1 else (plural or f"{singular}s")
    return f"{format_count(count)} {label}"


def month_label(window: ReportWindow) -> str:
    return window.start_date.strftime("%B %Y")


def format_commit(commit: CommitRecord) -> str:
    short_sha = commit.sha[:7]
    return f"{commit.repo}: {commit.subject} ({short_sha})"


def grouped_commits(summaries: list[RepoSummary]) -> dict[str, list[CommitRecord]]:
    grouped: dict[str, list[CommitRecord]] = defaultdict(list)
    for summary in summaries:
        for commit in summary.commits:
            grouped[categorize_commit(commit.subject)].append(commit)
    for commits in grouped.values():
        commits.sort(key=lambda commit: commit.committed_at, reverse=True)
    return grouped


def render_report(
    summaries: list[RepoSummary],
    window: ReportWindow,
    generated_at: datetime,
) -> str:
    total_commits = sum(summary.commit_count for summary in summaries)
    total_prs = sum(summary.likely_pr_count for summary in summaries)
    total_releases = sum(summary.release_count for summary in summaries)
    active_repos = [summary for summary in summaries if summary.commit_count > 0]
    warnings = [summary for summary in summaries if summary.warning]
    grouped = grouped_commits(summaries)

    lines = [
        REPORT_TITLE,
        "=" * len(REPORT_TITLE),
        "",
        (
            f"Period: {month_label(window)} "
            f"({window.start_date.isoformat()} to {window.end_date.isoformat()})"
        ),
        f"Generated: {generated_at.astimezone(LOCAL_TZ).strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"From: {report_from()}",
        f"To: {report_to()}",
        "Workspace: shared Hush Line agents",
        "",
        "Executive Snapshot",
        "------------------",
        (
            f"The month closed with {pluralize(total_commits, 'tracked commit')} across "
            f"{pluralize(len(active_repos), 'active repository', 'active repositories')}. "
            f"Local history shows {pluralize(total_prs, 'likely merged PR')} and "
            f"{pluralize(total_releases, 'tagged release')}."
        ),
    ]

    if total_commits == 0:
        lines.append(
            "No tracked commits were found in the configured local repositories for this period."
        )
    else:
        top_categories = [
            (category, len(grouped.get(category, [])))
            for category in category_order()
            if grouped.get(category)
        ][:3]
        if top_categories:
            category_text = ", ".join(
                f"{category.lower()} ({pluralize(count, 'item')})"
                for category, count in top_categories
            )
            lines.append(f"The strongest activity areas were {category_text}.")

    if warnings:
        lines.append(
            "Board attention: one or more configured repositories could not be read; see "
            "Operational Notes."
        )
    else:
        lines.append(
            "Board attention: no deterministic repository collection failures were captured."
        )

    lines.extend(["", "Accomplishments by Workstream", "---------------------------"])
    for category in category_order():
        commits = grouped.get(category, [])
        if not commits:
            continue
        lines.extend(["", f"{category}:"])
        for commit in commits[:MAX_CATEGORY_ITEMS]:
            lines.append(f"- {format_commit(commit)}")
        remaining = len(commits) - min(len(commits), MAX_CATEGORY_ITEMS)
        if remaining > 0:
            lines.append(f"- {pluralize(remaining, 'additional item')} in this workstream.")

    lines.extend(["", "Repository Detail", "-----------------"])
    for summary in summaries:
        if summary.warning:
            lines.append(f"- {summary.spec.name}: unavailable ({summary.warning}).")
            continue
        release_text = (
            f"; releases: {', '.join(summary.releases[:MAX_REPO_ITEMS])}"
            if summary.releases
            else ""
        )
        lines.append(
            f"- {summary.spec.name}: {pluralize(summary.commit_count, 'commit')}, "
            f"{pluralize(summary.likely_pr_count, 'likely PR')}"
            f"{release_text}."
        )

    lines.extend(["", "Operational Notes", "-----------------"])
    lines.append(
        "- This report is generated from local git history only; it does not infer financial "
        "authority, approve expenses, or modify operational records."
    )
    lines.append(
        "- The scheduled runner is idempotent by month key and sends only on the last local "
        "calendar day unless `--force` is used."
    )
    if warnings:
        for warning in warnings:
            lines.append(f"- {warning.spec.name}: {warning.warning}.")
    return "\n".join(lines).strip() + "\n"


def default_report_output_dir() -> Path:
    return Path(os.environ.get(REPORT_OUTPUT_DIR_ENV, repo_root() / "logs/monthly-board-reports"))


def default_state_file() -> Path:
    return Path(os.environ.get(REPORT_STATE_FILE_ENV, default_report_output_dir() / "state.json"))


def persist_report(report: str, output_dir: Path, window: ReportWindow) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"monthly-board-report-{window.month_key}-{timestamp}.txt"
    path.write_text(report, encoding="utf-8")
    return path


def prune_reports(output_dir: Path, retention: int) -> None:
    if retention <= 0 or not output_dir.exists():
        return
    reports = sorted(
        output_dir.glob("monthly-board-report-*.txt"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for path in reports[retention:]:
        path.unlink()


def load_state(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"sent_periods": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RunnerError(f"State file is invalid JSON: {path}") from exc
    if not isinstance(data, dict):
        raise RunnerError(f"State file must contain a JSON object: {path}")
    if not isinstance(data.get("sent_periods"), dict):
        data["sent_periods"] = {}
    return data


def state_has_sent(state: dict[str, object], month_key: str) -> bool:
    sent_periods = state.get("sent_periods")
    return isinstance(sent_periods, dict) and month_key in sent_periods


def mark_sent(path: Path, state: dict[str, object], window: ReportWindow, artifact: Path) -> None:
    sent_periods = state.setdefault("sent_periods", {})
    if not isinstance(sent_periods, dict):
        raise RunnerError("State sent_periods must be a JSON object")
    sent_periods[window.month_key] = {
        "sent_at": datetime.now(UTC).isoformat(),
        "artifact": str(artifact),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def send_with_mail_app(subject: str, body: str) -> bool:
    sender = report_from()
    recipient = report_to()
    if not sender or not recipient:
        raise RunnerError(f"{REPORT_TO_ENV} must resolve to a non-empty address.")

    body_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write(body)
            body_path = Path(tmp.name)

        command = ["/usr/bin/osascript", "-", sender, recipient, subject, str(body_path)]
        result = subprocess.run(  # noqa: S603 - fixed osascript invocation.
            command,
            input=MAIL_APP_APPLESCRIPT,
            text=True,
            capture_output=True,
            timeout=MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        print(
            "Warning: Mail.app send handoff exceeded the osascript timeout; "
            "not marking this monthly report as sent.",
            file=sys.stderr,
        )
        return False
    finally:
        if body_path is not None:
            body_path.unlink(missing_ok=True)

    if result.returncode == 0:
        return True
    detail = result.stderr.strip() or result.stdout.strip() or "no Mail.app output"
    if MAIL_APP_APPLE_EVENT_TIMEOUT_CODE in detail:
        print(
            "Warning: Mail.app reported an AppleEvent timeout after the send handoff; "
            "not marking this monthly report as sent.",
            file=sys.stderr,
        )
        return False
    raise RunnerError(f"Mail.app send failed: {detail}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    effective_date = args.date or today_local()
    window = report_window(effective_date, args.month)
    if not args.force and not is_last_day(effective_date):
        print(f"Skipped: {effective_date.isoformat()} is not the last day of the month.")
        return 0

    state_file = (args.state_file or default_state_file()).expanduser()
    if not args.dry_run and not args.force:
        state = load_state(state_file)
        if state_has_sent(state, window.month_key):
            print(f"Skipped: monthly board report already sent for {window.month_key}.")
            return 0
    else:
        state = {"sent_periods": {}}

    summaries = [summarize_repo(spec, window) for spec in repo_specs(args.repo)]
    report = render_report(summaries, window, datetime.now(UTC))

    if args.output:
        args.output.expanduser().write_text(report, encoding="utf-8")

    if args.dry_run:
        print(report, end="")
        return 0

    artifact = Path()
    if not args.no_persist:
        output_dir = (args.report_output_dir or default_report_output_dir()).expanduser()
        artifact = persist_report(report, output_dir, window)
        prune_reports(output_dir, args.report_retention)
        print(f"Persisted monthly board report: {artifact}")

    subject = f"{REPORT_TITLE} - {month_label(window)}"
    if not send_with_mail_app(subject, report):
        print("Skipped idempotency update because Mail.app delivery was not confirmed.")
        return 1
    mark_sent(state_file, state, window, artifact)
    print(f"Sent {REPORT_TITLE} for {window.month_key} from {report_from()} to {report_to()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except RunnerError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
