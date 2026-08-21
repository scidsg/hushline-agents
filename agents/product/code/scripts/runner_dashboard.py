#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import threading
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_ACTIVITY_DAYS = 14
DEFAULT_REFRESH_SECONDS = 15
MAX_LOG_TAIL_BYTES = 2_000_000
MAX_STATE_BYTES = 5_000_000
MAX_NEWS_ARCHIVE_BYTES = 1_000_000
MAX_URL_LENGTH = 2_000
MAX_PORT = 65_535
PORT_ENV = "HUSHLINE_RUNNER_DASHBOARD_PORT"
TAILSCALE_IPV4_NETWORK = ipaddress.ip_network("100.64.0.0/10")

DATE_RE = re.compile(r"(?P<date>20\d{2}-\d{2}-\d{2})")
STATE_RE = re.compile(r"^\s*state = (?P<state>[a-z-]+)\s*$", re.MULTILINE)
EXIT_CODE_RE = re.compile(r"^\s*last exit code = (?P<code>-?\d+)\s*$", re.MULTILINE)
RUN_COUNT_RE = re.compile(r"^\s*runs = (?P<count>\d+)\s*$", re.MULTILINE)

START_RE = re.compile(r"\b(starting|resuming|checking|running)\b", re.IGNORECASE)
SUCCESS_RE = re.compile(
    r"\b(complete|completed|published|sent|forwarded|ready for review|no changes required)\b",
    re.IGNORECASE,
)
FAILURE_RE = re.compile(
    r"\b(error|failed|failure|fatal|traceback|timed out|blocked:)\b",
    re.IGNORECASE,
)
ACTIVITY_RE = re.compile(
    r"\b(starting|completed|published|sent|forwarded|opened (?:a )?(?:draft )?pr)\b",
    re.IGNORECASE,
)
NEWS_ARCHIVE_DATE_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")
LINKEDIN_POST_ID_RE = re.compile(r"^urn:li:(?:share|ugcPost):\d+$")
NEWS_PLATFORM_LABELS = {
    "linkedin": "LinkedIn",
    "mastodon": "Mastodon",
    "bluesky": "Bluesky",
}
NEWS_PUBLIC_HOSTS = {
    "linkedin": {"linkedin.com", "www.linkedin.com"},
    "mastodon": {"mastodon.social", "www.mastodon.social"},
    "bluesky": {"bsky.app", "www.bsky.app"},
}


@dataclass(frozen=True)
class RunnerSpec:
    key: str
    name: str
    group: str
    label: str
    cadence: str
    log_paths: tuple[Path, ...]


@dataclass(frozen=True)
class LogSignal:
    status: str
    last_event_date: str | None


@dataclass(frozen=True)
class LaunchctlSignal:
    loaded: bool
    state: str
    exit_code: int | None
    runs: int | None


LaunchctlReader = Callable[[str], LaunchctlSignal]


class HeaderWriter(Protocol):
    def send_header(self, keyword: str, value: str) -> None: ...


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the private Hush Line agent dashboard.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=int(os.environ.get(PORT_ENV, DEFAULT_PORT)))
    parser.add_argument("--repo-dir", type=Path, default=default_repo_dir())
    parser.add_argument("--home-dir", type=Path, default=Path.home())
    return parser.parse_args(argv)


def default_repo_dir() -> Path:
    return Path(__file__).resolve().parents[4]


def runner_specs(repo_dir: Path, home_dir: Path) -> tuple[RunnerSpec, ...]:
    logs = repo_dir / "logs"
    return (
        RunnerSpec(
            "code",
            "Code agent",
            "Engineering",
            "org.scidsg.hushline-code-agent",
            "Every 10 minutes (paused by policy)",
            (home_dir / ".codex/logs/hushline-code-agent.log",),
        ),
        RunnerSpec(
            "mail",
            "Mail command agent",
            "Engineering",
            "com.hushline.mail-command-agent",
            "Every 5 minutes",
            (
                logs / "mail-command-agent/mail-command-agent.stdout.log",
                logs / "mail-command-agent/mail-command-agent.stderr.log",
            ),
        ),
        RunnerSpec(
            "sales-lead",
            "Sales lead agent",
            "Sales",
            "com.hushline.sales.lead-agent",
            "Every 5 minutes",
            (logs / "sales/sales-lead-agent.log",),
        ),
        RunnerSpec(
            "sales-outreach",
            "Sales contact agent",
            "Sales",
            "com.hushline.sales.contact-agent",
            "Daily delivery window",
            (logs / "sales/sales-contact-agent.log",),
        ),
        RunnerSpec(
            "social-feature",
            "Feature post agent",
            "Social",
            "com.hushline.social.hushline-feature-post-agent",
            "Daily",
            (
                logs / "social/hushline-feature-post-agent.stdout.log",
                logs / "social/hushline-feature-post-agent.stderr.log",
            ),
        ),
        RunnerSpec(
            "social-news",
            "Whistleblower news agent",
            "Social",
            "com.hushline.social.whistleblower-news-post-agent",
            "Daily",
            (
                logs / "social/whistleblower-news-post-agent.stdout.log",
                logs / "social/whistleblower-news-post-agent.stderr.log",
            ),
        ),
        RunnerSpec(
            "social-verified",
            "Verified-user post agent",
            "Social",
            "com.hushline.social.hushline-verified-user-post-agent",
            "Weekly",
            (
                logs / "social/hushline-verified-user-post-agent.stdout.log",
                logs / "social/hushline-verified-user-post-agent.stderr.log",
            ),
        ),
        RunnerSpec(
            "weekly-report",
            "Weekly agent report",
            "Reporting",
            "com.hushline.weekly-agent-report",
            "Sunday at 10:30 PM",
            (
                logs / "weekly-agent-report.stdout.log",
                logs / "weekly-agent-report.stderr.log",
            ),
        ),
    )


def read_tail(path: Path, max_bytes: int = MAX_LOG_TAIL_BYTES) -> str:
    if path.is_symlink() or not path.is_file():
        return ""
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > max_bytes:
                handle.seek(-max_bytes, os.SEEK_END)
                handle.readline()
            return handle.read(max_bytes).decode("utf-8", errors="replace")
    except OSError:
        return ""


def line_date(line: str) -> str | None:
    match = DATE_RE.search(line)
    if not match:
        return None
    try:
        return date.fromisoformat(match.group("date")).isoformat()
    except ValueError:
        return None


def log_signal(paths: tuple[Path, ...]) -> LogSignal:
    last_status = "unknown"
    last_date: str | None = None
    for path in paths:
        for line in read_tail(path).splitlines():
            candidate_date = line_date(line)
            if candidate_date:
                last_date = max(last_date or candidate_date, candidate_date)
            if FAILURE_RE.search(line):
                last_status = "failed"
            elif SUCCESS_RE.search(line):
                last_status = "succeeded"
            elif START_RE.search(line):
                last_status = "started"
    return LogSignal(status=last_status, last_event_date=last_date)


def read_launchctl(label: str) -> LaunchctlSignal:
    command = ["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"]
    try:
        result = subprocess.run(  # noqa: S603 - fixed command with repository-owned labels.
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return LaunchctlSignal(False, "unavailable", None, None)
    if result.returncode != 0:
        return LaunchctlSignal(False, "not-loaded", None, None)
    state_match = STATE_RE.search(result.stdout)
    exit_match = EXIT_CODE_RE.search(result.stdout)
    runs_match = RUN_COUNT_RE.search(result.stdout)
    return LaunchctlSignal(
        True,
        state_match.group("state") if state_match else "idle",
        int(exit_match.group("code")) if exit_match else None,
        int(runs_match.group("count")) if runs_match else None,
    )


def runner_status(spec: RunnerSpec, launchctl_reader: LaunchctlReader) -> dict[str, Any]:
    launchd = launchctl_reader(spec.label)
    logs = log_signal(spec.log_paths)
    if not launchd.loaded:
        status = "paused"
        action = "Not loaded"
    elif launchd.state == "running":
        status = "running"
        action = "Action in progress"
    elif launchd.exit_code not in (None, 0):
        status = "failed"
        action = f"Last action failed (exit {launchd.exit_code})"
    elif launchd.exit_code == 0:
        status = "healthy"
        action = "Last action succeeded"
    elif launchd.exit_code is None and logs.status == "failed":
        status = "failed"
        action = "Last action failed"
    elif logs.status == "started":
        status = "warning"
        action = "Completion not observed"
    else:
        status = "healthy"
        action = "Last action succeeded"
    return {
        "key": spec.key,
        "name": spec.name,
        "group": spec.group,
        "cadence": spec.cadence,
        "status": status,
        "action": action,
        "last_event_date": logs.last_event_date,
        "runs": launchd.runs,
    }


def lead_metrics(path: Path, *, today: date) -> dict[str, Any]:
    decisions: Counter[str] = Counter()
    qualified_by_day: Counter[str] = Counter()
    if path.is_symlink() or not path.is_file():
        return lead_metric_payload(decisions, qualified_by_day, today)
    try:
        if path.stat().st_size > MAX_STATE_BYTES:
            return lead_metric_payload(decisions, qualified_by_day, today)
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return lead_metric_payload(decisions, qualified_by_day, today)
    for entry in payload.get("processed", []):
        if not isinstance(entry, dict):
            continue
        decision = entry.get("decision")
        if not isinstance(decision, str):
            continue
        decisions[decision] += 1
        if decision not in {"forwarded", "brief_sent", "forwarded_with_brief", "delivered"}:
            continue
        processed_at = entry.get("processed_at")
        if isinstance(processed_at, str):
            try:
                qualified_by_day[datetime.fromisoformat(processed_at).date().isoformat()] += 1
            except ValueError:
                continue
    return lead_metric_payload(decisions, qualified_by_day, today)


def lead_metric_payload(
    decisions: Counter[str], qualified_by_day: Counter[str], today: date
) -> dict[str, Any]:
    qualified = sum(
        decisions[key] for key in ("forwarded", "brief_sent", "forwarded_with_brief", "delivered")
    )
    days = [(today - timedelta(days=offset)).isoformat() for offset in range(13, -1, -1)]
    return {
        "qualified": qualified,
        "screened_out": decisions["screened_out"],
        "blocked": decisions["blocked_high_risk"],
        "total": sum(decisions.values()),
        "qualified_by_day": [qualified_by_day[day] for day in days],
    }


def read_archive_json(path: Path) -> dict[str, Any] | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        if path.stat().st_size > MAX_NEWS_ARCHIVE_BYTES:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def bounded_text(payload: dict[str, Any], key: str, *, limit: int = 500) -> str | None:
    value = payload.get(key)
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split()).strip()
    return cleaned[:limit] or None


def safe_https_url(value: object, *, allowed_hosts: set[str] | None = None) -> str | None:
    if not isinstance(value, str) or len(value) > MAX_URL_LENGTH:
        return None
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not hostname or parsed.username or parsed.password:
        return None
    if allowed_hosts is not None and hostname not in allowed_hosts:
        return None
    return value


def parse_publication_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def publication_link(platform: str, receipt: dict[str, Any]) -> str | None:
    if platform == "linkedin":
        post_id = bounded_text(receipt, "post_id", limit=100)
        if post_id and LINKEDIN_POST_ID_RE.fullmatch(post_id):
            return f"https://www.linkedin.com/feed/update/{post_id}"
        return None
    field = "status_url" if platform == "mastodon" else "post_url"
    return safe_https_url(receipt.get(field), allowed_hosts=NEWS_PUBLIC_HOSTS[platform])


def last_news_post(social_repo_dir: Path) -> dict[str, Any]:
    unavailable = {"available": False}
    archive_root = social_repo_dir / "previous-article-posts"
    if archive_root.is_symlink() or not archive_root.is_dir():
        return unavailable

    candidates: list[tuple[datetime, dict[str, Any]]] = []
    try:
        archive_dirs = tuple(archive_root.iterdir())
    except OSError:
        return unavailable
    for archive_dir in archive_dirs:
        if (
            archive_dir.is_symlink()
            or not archive_dir.is_dir()
            or not NEWS_ARCHIVE_DATE_RE.fullmatch(archive_dir.name)
        ):
            continue
        post = read_archive_json(archive_dir / "post.json")
        if post is None:
            continue

        receipts: dict[str, tuple[datetime, str | None]] = {}
        for platform in NEWS_PLATFORM_LABELS:
            receipt = read_archive_json(archive_dir / f"{platform}-publication.json")
            if receipt is None:
                continue
            published_at = parse_publication_time(receipt.get("published_at"))
            if published_at is not None:
                receipts[platform] = (published_at, publication_link(platform, receipt))
        if not receipts:
            continue

        latest_publication = max(value[0] for value in receipts.values())
        linked_platform = next(
            (
                platform
                for platform in ("linkedin", "mastodon", "bluesky")
                if platform in receipts and receipts[platform][1]
            ),
            None,
        )
        planned_date = bounded_text(post, "planned_date", limit=10)
        if planned_date is None or not NEWS_ARCHIVE_DATE_RE.fullmatch(planned_date):
            planned_date = archive_dir.name
        payload = {
            "available": True,
            "planned_date": planned_date,
            "published_at": latest_publication.isoformat().replace("+00:00", "Z"),
            "source": bounded_text(post, "source", limit=120),
            "title": bounded_text(post, "title") or bounded_text(post, "headline"),
            "article_url": safe_https_url(post.get("article_url")),
            "platform": NEWS_PLATFORM_LABELS.get(linked_platform) if linked_platform else None,
            "public_url": receipts[linked_platform][1] if linked_platform else None,
        }
        candidates.append((latest_publication, payload))

    if not candidates:
        return unavailable
    return max(candidates, key=lambda item: item[0])[1]


def previous_day_platform_status(social_repo_dir: Path, *, today: date) -> dict[str, Any]:
    planned_date = (today - timedelta(days=1)).isoformat()
    archive_dir = social_repo_dir / "previous-posts" / planned_date
    platforms: dict[str, bool] = {}
    for platform in NEWS_PLATFORM_LABELS:
        receipt = read_archive_json(archive_dir / f"{platform}-publication.json")
        platforms[platform] = bool(
            receipt
            and receipt.get("platform") == platform
            and receipt.get("planned_date") == planned_date
            and parse_publication_time(receipt.get("published_at")) is not None
            and publication_link(platform, receipt) is not None
        )
    return {"planned_date": planned_date, "platforms": platforms}


def activity_series(
    specs: tuple[RunnerSpec, ...], *, today: date, days: int = DEFAULT_ACTIVITY_DAYS
) -> dict[str, Any]:
    labels = [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
    allowed = set(labels)
    groups: dict[str, Counter[str]] = {
        "Engineering": Counter(),
        "Social": Counter(),
        "Sales": Counter(),
        "Reporting": Counter(),
    }
    for spec in specs:
        seen_lines: set[tuple[str, str]] = set()
        for path in spec.log_paths:
            for line in read_tail(path).splitlines():
                event_date = line_date(line)
                if event_date not in allowed or not ACTIVITY_RE.search(line):
                    continue
                dedupe_key = (event_date, line.strip())
                if dedupe_key in seen_lines:
                    continue
                seen_lines.add(dedupe_key)
                groups[spec.group][event_date] += 1
    colors = {
        "Engineering": "#7d25c1",
        "Social": "#287a70",
        "Sales": "#b25b00",
        "Reporting": "#4966a8",
    }
    return {
        "labels": labels,
        "series": [
            {
                "key": group.lower(),
                "label": group,
                "color": colors[group],
                "values": [counts[label] for label in labels],
            }
            for group, counts in groups.items()
        ],
    }


def build_snapshot(
    repo_dir: Path,
    home_dir: Path,
    *,
    now: datetime | None = None,
    launchctl_reader: LaunchctlReader = read_launchctl,
    social_repo_dir: Path | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    specs = runner_specs(repo_dir, home_dir)
    runners = [runner_status(spec, launchctl_reader) for spec in specs]
    activity = activity_series(specs, today=current.date())
    leads = lead_metrics(repo_dir / "logs/sales/lead-agent/state.json", today=current.date())
    social_repo = social_repo_dir or repo_dir.parent / "hushline-social"
    news_post = last_news_post(social_repo)
    previous_day_status = previous_day_platform_status(
        social_repo, today=current.astimezone().date()
    )
    failed = sum(item["status"] == "failed" for item in runners)
    running = sum(item["status"] == "running" for item in runners)
    healthy = sum(item["status"] == "healthy" for item in runners)
    paused = sum(item["status"] == "paused" for item in runners)
    activity_7d = sum(sum(series["values"][-7:]) for series in activity["series"])
    return {
        "generated_at": current.isoformat(),
        "refresh_seconds": DEFAULT_REFRESH_SECONDS,
        "summary": {
            "healthy": healthy,
            "running": running,
            "failed": failed,
            "paused": paused,
            "total": len(runners),
            "activity_7d": activity_7d,
            "qualified_leads": leads["qualified"],
        },
        "runners": runners,
        "activity": activity,
        "leads": leads,
        "last_news_post": news_post,
        "previous_day_post_status": previous_day_status,
    }


def static_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "dashboard"


def bind_host_is_private(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or (
        isinstance(address, ipaddress.IPv4Address) and address in TAILSCALE_IPV4_NETWORK
    )


def security_headers(handler: HeaderWriter, content_type: str) -> None:
    csp = (
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
        "style-src 'self'; script-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'none'"
    )
    handler.send_header("Content-Type", content_type)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Security-Policy", csp)
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Frame-Options", "DENY")


def make_handler(
    repo_dir: Path, home_dir: Path, social_repo_dir: Path | None = None
) -> type[BaseHTTPRequestHandler]:
    asset_root = static_dir()

    class DashboardHandler(BaseHTTPRequestHandler):
        server_version = "HushLineDashboard/1.0"

        def do_GET(self) -> None:
            route = self.path.split("?", 1)[0]
            if route == "/api/dashboard":
                self.send_json(build_snapshot(repo_dir, home_dir, social_repo_dir=social_repo_dir))
                return
            if route == "/healthz":
                self.send_json({"status": "ok"})
                return
            assets = {
                "/": ("index.html", "text/html; charset=utf-8"),
                "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
                "/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
            }
            asset = assets.get(route)
            if asset is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_asset(asset_root / asset[0], asset[1])

        def do_POST(self) -> None:
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

        def send_json(self, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode()
            self.send_response(HTTPStatus.OK)
            security_headers(self, "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_asset(self, path: Path, content_type: str) -> None:
            try:
                body = path.read_bytes()
            except OSError:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            security_headers(self, content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, message_format: str, *args: object) -> None:
            del message_format, args

    return DashboardHandler


def serve(
    repo_dir: Path,
    home_dir: Path,
    host: str,
    port: int,
    *,
    social_repo_dir: Path | None = None,
) -> None:
    if not bind_host_is_private(host):
        raise ValueError("The dashboard must bind to loopback or a Tailscale IPv4 address")
    if port < 1 or port > MAX_PORT:
        raise ValueError("Dashboard port must be between 1 and 65535")
    server = ThreadingHTTPServer((host, port), make_handler(repo_dir, home_dir, social_repo_dir))

    def stop_server(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    print(f"Hush Line agent dashboard listening on http://{host}:{port}", flush=True)
    server.serve_forever(poll_interval=0.5)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        serve(args.repo_dir.resolve(), args.home_dir.resolve(), args.host, args.port)
    except (OSError, ValueError) as exc:
        print(f"runner-dashboard: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
