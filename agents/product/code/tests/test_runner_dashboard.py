from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[4]
RUNNER_PATH = ROOT / "agents/product/code/scripts/runner_dashboard.py"
DASHBOARD_DIR = ROOT / "agents/product/code/dashboard"
PLIST_PATH = ROOT / "agents/product/code/deploy/launchd/com.hushline.runner-dashboard.plist"
INSTALLER_PATH = ROOT / "agents/product/code/scripts/install_runner_dashboard_launch_agent.sh"
RUN_SCRIPT_PATH = ROOT / "agents/product/code/scripts/run_runner_dashboard.sh"
NETWORK_SCRIPT_PATH = ROOT / "agents/product/code/scripts/lib/runner-dashboard-network.sh"


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("runner_dashboard", RUNNER_PATH)
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_log(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_lead_metrics_aggregate_decisions_without_exposing_records(tmp_path: Path) -> None:
    runner = load_runner()
    state_path = tmp_path / "logs/sales/lead-agent/state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "processed": [
                    {
                        "decision": "forwarded_with_brief",
                        "processed_at": "2026-08-17T12:00:00+00:00",
                        "fingerprint": "sensitive-value",
                    },
                    {
                        "decision": "brief_sent",
                        "processed_at": "2026-08-16T12:00:00+00:00",
                    },
                    {"decision": "screened_out"},
                    {"decision": "blocked_high_risk"},
                ]
            }
        ),
        encoding="utf-8",
    )

    metrics = runner.lead_metrics(state_path, today=date(2026, 8, 17))

    assert metrics["qualified"] == 2
    assert metrics["screened_out"] == 1
    assert metrics["blocked"] == 1
    assert metrics["total"] == 4
    assert metrics["qualified_by_day"][-2:] == [1, 1]
    assert "sensitive-value" not in json.dumps(metrics)


def test_activity_series_counts_bounded_high_level_events(tmp_path: Path) -> None:
    runner = load_runner()
    log_path = tmp_path / "agent.log"
    write_log(
        log_path,
        "\n".join(
            (
                "[2026-08-16 08:00:00 PDT] Starting code agent check.",
                "[2026-08-16 08:10:00 PDT] Completed work.",
                "[2026-08-16 08:11:00 PDT] Debug detail only.",
                "[2026-08-17 08:00:00 PDT] Starting code agent check.",
            )
        ),
    )
    specs = (runner.RunnerSpec("code", "Code", "Engineering", "example", "Daily", (log_path,)),)

    activity = runner.activity_series(specs, today=date(2026, 8, 17), days=2)

    engineering = next(item for item in activity["series"] if item["label"] == "Engineering")
    assert activity["labels"] == ["2026-08-16", "2026-08-17"]
    assert engineering["values"] == [2, 1]


def test_runner_status_shows_red_failure_for_nonzero_launchd_exit(tmp_path: Path) -> None:
    runner = load_runner()
    log_path = tmp_path / "agent.log"
    write_log(log_path, "[2026-08-17 08:00:00 PDT] Starting agent.\n")
    spec = runner.RunnerSpec("code", "Code", "Engineering", "example", "Daily", (log_path,))

    status = runner.runner_status(
        spec,
        lambda _label: runner.LaunchctlSignal(True, "idle", 2, 4),
    )

    assert status["status"] == "failed"
    assert status["action"] == "Last action failed (exit 2)"


def test_successful_launchd_exit_wins_over_stale_stderr(tmp_path: Path) -> None:
    runner = load_runner()
    log_path = tmp_path / "agent.log"
    write_log(log_path, "[2026-08-16 08:00:00 PDT] Error from an older run.\n")
    spec = runner.RunnerSpec("code", "Code", "Engineering", "example", "Daily", (log_path,))

    status = runner.runner_status(
        spec,
        lambda _label: runner.LaunchctlSignal(True, "idle", 0, 9),
    )

    assert status["status"] == "healthy"
    assert status["action"] == "Last action succeeded"


def test_successful_launchd_exit_wins_over_trailing_start_log(tmp_path: Path) -> None:
    runner = load_runner()
    log_path = tmp_path / "agent.log"
    write_log(log_path, "[2026-08-17 08:00:00 PDT] Starting agent.\n")
    spec = runner.RunnerSpec("code", "Code", "Engineering", "example", "Daily", (log_path,))

    status = runner.runner_status(
        spec,
        lambda _label: runner.LaunchctlSignal(True, "idle", 0, 9),
    )

    assert status["status"] == "healthy"
    assert status["action"] == "Last action succeeded"


def test_snapshot_contains_only_aggregate_sales_data(tmp_path: Path) -> None:
    runner = load_runner()
    state_path = tmp_path / "logs/sales/lead-agent/state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "processed": [
                    {
                        "decision": "forwarded",
                        "processed_at": "2026-08-17T12:00:00+00:00",
                        "fingerprint": "do-not-serve",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    snapshot = runner.build_snapshot(
        tmp_path,
        tmp_path,
        now=datetime(2026, 8, 17, 12, tzinfo=UTC),
        launchctl_reader=lambda _label: runner.LaunchctlSignal(False, "not-loaded", None, None),
    )
    encoded = json.dumps(snapshot)

    assert snapshot["summary"]["qualified_leads"] == 1
    assert "do-not-serve" not in encoded
    assert "fingerprint" not in encoded
    assert "message" not in encoded.lower()


def test_running_worker_remains_in_healthy_summary_count(tmp_path: Path) -> None:
    runner = load_runner()

    snapshot = runner.build_snapshot(
        tmp_path,
        tmp_path,
        now=datetime(2026, 8, 21, 12, tzinfo=UTC),
        launchctl_reader=lambda label: (
            runner.LaunchctlSignal(True, "running", None, 3)
            if label == "com.hushline.sales.lead-agent"
            else runner.LaunchctlSignal(True, "idle", 0, 3)
        ),
    )

    assert snapshot["summary"]["running"] == 1
    assert snapshot["summary"]["healthy"] == snapshot["summary"]["total"]
    assert snapshot["summary"]["failed"] == 0


def test_last_outbound_sales_email_returns_latest_matching_email_preview(
    tmp_path: Path,
) -> None:
    runner = load_runner()
    drafts_dir = tmp_path / "drafts"
    drafts_dir.mkdir()
    draft_path = drafts_dir / "example.txt"
    draft_path.write_text(
        "From: sales@hushline.app\n"
        "To: private@example.com\n"
        "Recipient source: verified public page\n"
        "Subject: A safer reporting channel\n"
        "Target: example.com rank 1\n\n"
        "Hello Example Company,\n\nThis is the original message body.",
        encoding="utf-8",
    )
    state_path = tmp_path / "sales-contact-agent-state.json"
    state_path.write_text(
        json.dumps(
            {
                "sent": [
                    {
                        "company_name": "Older Company",
                        "subject": "Older subject",
                        "sent_at": "2026-08-20T12:00:00+00:00",
                    },
                    {
                        "company_name": "Example Company",
                        "subject": "A safer reporting channel",
                        "sent_at": "2026-08-21T15:30:00+00:00",
                        "recipient": "private@example.com",
                        "draft_path": str(draft_path),
                    },
                ],
                "failed": [
                    {
                        "company_name": "Failed Company",
                        "subject": "Failed subject",
                        "failed_at": "2026-08-22T15:30:00+00:00",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = runner.last_outbound_sales_email(state_path, drafts_dir=drafts_dir)

    assert result == {
        "available": True,
        "company_name": "Example Company",
        "sender": "sales@hushline.app",
        "recipient": "private@example.com",
        "subject": "A safer reporting channel",
        "sent_at": "2026-08-21T15:30:00Z",
        "body": "Hello Example Company,\n\nThis is the original message body.",
    }


def test_outbound_sales_email_does_not_read_draft_outside_allowed_directory(
    tmp_path: Path,
) -> None:
    runner = load_runner()
    drafts_dir = tmp_path / "drafts"
    drafts_dir.mkdir()
    outside_path = tmp_path / "outside.txt"
    outside_path.write_text(
        "From: sales@hushline.app\n"
        "To: person@example.com\n"
        "Subject: Subject\n\n"
        "Must not be exposed.",
        encoding="utf-8",
    )
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "sent": [
                    {
                        "company_name": "Example",
                        "recipient": "person@example.com",
                        "subject": "Subject",
                        "sent_at": "2026-08-21T15:30:00Z",
                        "draft_path": str(outside_path),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = runner.last_outbound_sales_email(state_path, drafts_dir=drafts_dir)

    assert result["available"] is True
    assert result["body"] is None
    assert "Must not be exposed" not in json.dumps(result)


def write_news_archive(
    social_repo: Path,
    archive_date: str,
    *,
    published_at: str,
    title: str,
) -> None:
    archive = social_repo / "previous-article-posts" / archive_date
    archive.mkdir(parents=True)
    (archive / "post.json").write_text(
        json.dumps(
            {
                "planned_date": archive_date,
                "source": "The Guardian",
                "title": title,
                "article_url": "https://www.theguardian.com/example",
                "social": {"linkedin": "must not be served"},
            }
        ),
        encoding="utf-8",
    )
    (archive / "linkedin-publication.json").write_text(
        json.dumps(
            {
                "platform": "linkedin",
                "post_id": "urn:li:share:7496642425214611457",
                "published_at": published_at,
            }
        ),
        encoding="utf-8",
    )


def test_last_news_post_returns_latest_published_archive_without_social_copy(
    tmp_path: Path,
) -> None:
    runner = load_runner()
    social_repo = tmp_path / "hushline-social"
    write_news_archive(
        social_repo,
        "2026-08-18",
        published_at="2026-08-18T19:00:00Z",
        title="Older accountability report",
    )
    write_news_archive(
        social_repo,
        "2026-08-21",
        published_at="2026-08-21T19:00:35Z",
        title="Current whistleblower report",
    )

    result = runner.last_news_post(social_repo)
    encoded = json.dumps(result)

    assert result == {
        "available": True,
        "planned_date": "2026-08-21",
        "published_at": "2026-08-21T19:00:35Z",
        "source": "The Guardian",
        "title": "Current whistleblower report",
        "article_url": "https://www.theguardian.com/example",
        "platform": "LinkedIn",
        "public_url": "https://www.linkedin.com/feed/update/urn:li:share:7496642425214611457",
    }
    assert "must not be served" not in encoded
    assert "social" not in encoded


def test_last_news_post_ignores_unpublished_and_unsafe_archives(tmp_path: Path) -> None:
    runner = load_runner()
    social_repo = tmp_path / "hushline-social"
    unpublished = social_repo / "previous-article-posts" / "2026-08-21"
    unpublished.mkdir(parents=True)
    (unpublished / "post.json").write_text(
        json.dumps({"planned_date": "2026-08-21", "title": "Draft only"}),
        encoding="utf-8",
    )
    unsafe = social_repo / "previous-article-posts" / "2026-08-20"
    unsafe.mkdir()
    (unsafe / "post.json").symlink_to(unpublished / "post.json")
    (unsafe / "bluesky-publication.json").write_text(
        json.dumps(
            {
                "published_at": "2026-08-20T19:00:00Z",
                "post_url": "javascript:alert(1)",
            }
        ),
        encoding="utf-8",
    )

    assert runner.last_news_post(social_repo) == {"available": False}


def test_last_social_post_status_uses_newest_archive_and_valid_publication_receipts(
    tmp_path: Path,
) -> None:
    runner = load_runner()
    social_repo = tmp_path / "hushline-social"
    older_archive = social_repo / "previous-posts" / "2026-08-20"
    older_archive.mkdir(parents=True)
    (older_archive / "post.json").write_text(
        json.dumps({"planned_date": "2026-08-20"}), encoding="utf-8"
    )
    archive = social_repo / "previous-posts" / "2026-08-21"
    archive.mkdir(parents=True)
    (archive / "post.json").write_text(json.dumps({"planned_date": "2026-08-21"}), encoding="utf-8")
    (archive / "linkedin-publication.json").write_text(
        json.dumps(
            {
                "platform": "linkedin",
                "planned_date": "2026-08-21",
                "published_at": "2026-08-21T19:00:00Z",
                "post_id": "urn:li:share:7496642425214611457",
            }
        ),
        encoding="utf-8",
    )
    (archive / "mastodon-publication.json").write_text(
        json.dumps(
            {
                "platform": "mastodon",
                "planned_date": "2026-08-21",
                "published_at": "not-a-date",
                "status_url": "https://mastodon.social/@hushlineapp/123",
            }
        ),
        encoding="utf-8",
    )
    (archive / "bluesky-publication.json").write_text(
        json.dumps(
            {
                "platform": "bluesky",
                "planned_date": "2026-08-20",
                "published_at": "2026-08-21T19:00:00Z",
                "post_url": "https://bsky.app/profile/hushline.app/post/abc",
            }
        ),
        encoding="utf-8",
    )

    assert runner.last_social_post_status(social_repo) == {
        "available": True,
        "planned_date": "2026-08-21",
        "platforms": {"linkedin": True, "mastodon": False, "bluesky": False},
    }


def test_dashboard_sends_strict_security_headers() -> None:
    runner = load_runner()

    class HeaderRecorder:
        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

        def send_header(self, name: str, value: str) -> None:
            self.headers[name] = value

    recorder = HeaderRecorder()
    runner.security_headers(recorder, "application/json; charset=utf-8")

    assert recorder.headers["Cache-Control"] == "no-store"
    assert "frame-ancestors 'none'" in recorder.headers["Content-Security-Policy"]
    assert recorder.headers["X-Frame-Options"] == "DENY"
    assert recorder.headers["Referrer-Policy"] == "no-referrer"


def test_dashboard_assets_are_hush_line_branded_and_dependency_free() -> None:
    html = (DASHBOARD_DIR / "index.html").read_text(encoding="utf-8")
    css = (DASHBOARD_DIR / "dashboard.css").read_text(encoding="utf-8")
    javascript = (DASHBOARD_DIR / "dashboard.js").read_text(encoding="utf-8")

    assert "Hush Line" in html
    assert "Agent Operations" in html
    assert "Last news post" in html
    assert "Last social post" in html
    assert "Success status" in html
    assert "Last successful outbound email" in html
    assert "#7d25c1" in css
    assert "Atkinson Hyperlegible" in css
    assert '"activity activity activity"' in css
    assert '"lead news delivery"' in css
    assert '"outbound outbound outbound"' in css
    assert "align-items: stretch" in css
    assert "https://" not in html
    assert "http://" not in html
    assert 'fetch("/api/dashboard"' in javascript
    assert "renderLastNewsPost" in javascript
    assert "renderLastSocialPostStatus" in javascript
    assert "renderLastOutboundSalesEmail" in javascript
    assert "smoothLinePath" in javascript
    assert 'svgElement("path"' in javascript


def test_launchd_and_tailscale_assets_keep_backend_private() -> None:
    plist = PLIST_PATH.read_text(encoding="utf-8")
    installer = INSTALLER_PATH.read_text(encoding="utf-8")
    run_script = RUN_SCRIPT_PATH.read_text(encoding="utf-8")
    network_script = NETWORK_SCRIPT_PATH.read_text(encoding="utf-8")

    assert "run_runner_dashboard.sh" in plist
    assert "<key>KeepAlive</key>" in plist
    assert "resolve_runner_dashboard_host" in run_script
    assert '--host "127.0.0.1"' in run_script
    assert '--host "$HOST"' in run_script
    assert "tailscale ip -4" in network_script
    assert "tailscale serve" not in network_script
    assert "tailscale funnel" not in network_script
    assert "0.0.0.0" not in run_script  # noqa: S104 - no all-interface bind.
    assert "require_cmd lsof" in installer
    assert "dashboard_sockets_ready" in installer
    assert '"-iTCP@127.0.0.1:${dashboard_port}"' in installer
    assert '"-iTCP@${dashboard_host}:${dashboard_port}"' in installer
    assert "Test from another Tailnet device" in installer


def test_server_rejects_non_loopback_bind(tmp_path: Path) -> None:
    runner = load_runner()

    with pytest.raises(ValueError, match="loopback or a Tailscale"):
        runner.serve(tmp_path, tmp_path, "0.0.0.0", 8765)  # noqa: S104 - rejection test.


def test_server_accepts_only_loopback_or_tailscale_addresses() -> None:
    runner = load_runner()

    assert runner.bind_host_is_private("127.0.0.1")
    assert runner.bind_host_is_private("::1")
    assert runner.bind_host_is_private("100.113.237.2")
    assert not runner.bind_host_is_private("192.168.1.164")
    assert not runner.bind_host_is_private("0.0.0.0")  # noqa: S104 - rejection test.


def test_dashboard_parser_accepts_loopback_and_tailscale_hosts() -> None:
    runner = load_runner()

    args = runner.parse_args(["--host", "127.0.0.1", "--host", "100.113.237.2", "--port", "8765"])

    assert args.hosts == ["127.0.0.1", "100.113.237.2"]
    assert args.port == 8765
