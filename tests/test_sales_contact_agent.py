from __future__ import annotations

import csv
import importlib.util
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "sales" / "scripts" / "sales_contact_agent.py"
WRAPPER_PATH = ROOT / "sales" / "scripts" / "run_sales_contact_agent_launchd.sh"
UTC = timezone.utc  # noqa: UP017 - keep runner importable under Python 3.9.


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("sales_contact_agent", RUNNER_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_audit_csv(path: Path) -> None:
    fieldnames = [
        "rank",
        "domain",
        "form_fingerprint",
        "homepage_final_url",
        "contact_final_url",
        "selected_contact_link",
        "form_action",
        "form_method",
        "field_count",
        "required_field_count",
        "required_high_risk_identity",
        "third_party_script_host_count",
        "third_party_script_hosts",
        "tracker_hosts",
        "observed_request_count_after_input",
        "canary_request_count",
        "canary_hosts",
        "third_party_canary_hosts",
        "canary_request_details",
        "leaked_before_submit",
        "https_page",
        "https_action",
        "post_method",
        "no_third_party_scripts",
        "no_observed_pre_submit_leak",
        "no_required_high_risk_identity",
        "csp_present",
        "csp_restricts_form_action",
        "csp_restricts_framing",
        "privacy_notice_linked",
        "retention_disclosed",
        "encryption_disclosed",
        "protected_transport_tier",
        "privacy_respecting_tier",
        "hardened_tier",
        "full_observable_standard",
    ]
    rows = [
        {
            "rank": "1",
            "domain": "nist.gov",
            "homepage_final_url": "https://www.nist.gov/",
            "contact_final_url": "https://www.nist.gov/contact",
            "selected_contact_link": "https://www.nist.gov/contact",
            "form_action": "https://www.nist.gov/contact",
            "form_method": "post",
            "field_count": "10",
            "required_field_count": "0",
            "required_high_risk_identity": "",
            "third_party_script_host_count": "0",
            "third_party_script_hosts": "",
            "observed_request_count_after_input": "0",
            "canary_request_count": "0",
            "canary_hosts": "",
            "leaked_before_submit": "false",
            "https_page": "true",
            "https_action": "true",
            "post_method": "true",
            "no_third_party_scripts": "true",
            "no_observed_pre_submit_leak": "true",
            "no_required_high_risk_identity": "true",
            "csp_present": "true",
            "csp_restricts_form_action": "true",
            "csp_restricts_framing": "true",
            "privacy_notice_linked": "true",
            "retention_disclosed": "false",
            "encryption_disclosed": "false",
            "protected_transport_tier": "true",
            "privacy_respecting_tier": "true",
            "hardened_tier": "false",
            "full_observable_standard": "false",
        },
        {
            "rank": "6",
            "domain": "microsoft.com",
            "homepage_final_url": "https://www.microsoft.com/en-us",
            "contact_final_url": "https://support.microsoft.com/contactus",
            "selected_contact_link": "https://support.microsoft.com/contactus",
            "form_action": "https://support.microsoft.com/contactus",
            "form_method": "get",
            "field_count": "1",
            "required_field_count": "0",
            "required_high_risk_identity": "",
            "third_party_script_host_count": "3",
            "third_party_script_hosts": "ajax.aspnetcdn.com|js.monitor.azure.com|mem.gfx.ms",
            "observed_request_count_after_input": "1",
            "canary_request_count": "0",
            "canary_hosts": "",
            "leaked_before_submit": "false",
            "https_page": "true",
            "https_action": "true",
            "post_method": "false",
            "no_third_party_scripts": "false",
            "no_observed_pre_submit_leak": "true",
            "no_required_high_risk_identity": "true",
            "csp_present": "false",
            "csp_restricts_form_action": "false",
            "csp_restricts_framing": "false",
            "privacy_notice_linked": "true",
            "retention_disclosed": "false",
            "encryption_disclosed": "false",
            "protected_transport_tier": "false",
            "privacy_respecting_tier": "false",
            "hardened_tier": "false",
            "full_observable_standard": "false",
        },
        {
            "rank": "88",
            "domain": "workers.dev",
            "homepage_final_url": "https://www.cloudflare.com/",
            "contact_final_url": "https://www.cloudflare.com/resource/contact-enterprise-sales/",
            "selected_contact_link": "https://www.cloudflare.com/resource/contact-enterprise-sales/",
            "form_action": "https://www.cloudflare.com/resource/contact-enterprise-sales/",
            "form_method": "get",
            "field_count": "10",
            "required_field_count": "5",
            "required_high_risk_identity": "Phone: *",
            "third_party_script_host_count": "7",
            "third_party_script_hosts": "munchkin.marketo.net|www.googletagmanager.com",
            "observed_request_count_after_input": "0",
            "canary_request_count": "0",
            "canary_hosts": "",
            "leaked_before_submit": "false",
            "https_page": "true",
            "https_action": "true",
            "post_method": "false",
            "no_third_party_scripts": "false",
            "no_observed_pre_submit_leak": "true",
            "no_required_high_risk_identity": "false",
            "csp_present": "true",
            "csp_restricts_form_action": "true",
            "csp_restricts_framing": "true",
            "privacy_notice_linked": "true",
            "retention_disclosed": "false",
            "encryption_disclosed": "false",
            "protected_transport_tier": "false",
            "privacy_respecting_tier": "false",
            "hardened_tier": "false",
            "full_observable_standard": "false",
        },
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


@pytest.fixture(autouse=True)
def no_live_research(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSHLINE_SALES_AGENT_LIVE_RESEARCH", "0")


def test_selects_highest_ranked_uncontacted_company_with_resolved_recipient(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)

    def fake_resolve(
        record: object,
        _profile: object,
        *,
        recipient_override: str | None,
        timeout_seconds: float,
    ) -> object | None:
        del recipient_override, timeout_seconds
        if getattr(record, "domain") == "workers.dev":
            return runner.ResolvedRecipient(
                email="enterprise-sales@cloudflare.com",
                source="public page: https://www.cloudflare.com/contact",
            )
        return None

    monkeypatch.setattr(runner, "resolve_recipient_email", fake_resolve)

    records = runner.load_contact_form_records(csv_path)
    target, profile, recipient = runner.select_next_target(records, {"sent": [], "failed": []})

    assert target.domain == "workers.dev"
    assert profile.company_name == "Cloudflare"
    assert recipient.email == "enterprise-sales@cloudflare.com"


def test_recipient_discovery_prefers_sales_mailto_over_operational_addresses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    record = runner.ContactFormRecord(
        rank=1,
        domain="example.com",
        homepage_final_url="https://example.com/",
        contact_final_url="https://example.com/contact",
        selected_contact_link="https://example.com/contact",
        form_action="https://example.com/contact",
        form_method="post",
        field_count=1,
        required_field_count=0,
        required_high_risk_identity="",
        third_party_script_host_count=0,
        third_party_script_hosts="",
        observed_request_count_after_input=0,
        canary_request_count=0,
        canary_hosts="",
        leaked_before_submit=False,
        post_method=True,
        no_third_party_scripts=True,
        no_observed_pre_submit_leak=True,
        csp_restricts_form_action=True,
        encryption_disclosed=False,
        privacy_respecting_tier=False,
        hardened_tier=False,
    )

    def fake_pages(_record: object, _timeout_seconds: float) -> list[tuple[str, str]]:
        return [
            (
                "https://example.com/contact",
                '<a href="mailto:support@example.com">Support</a>'
                '<a href="mailto:sales@example.com">Sales</a>',
            )
        ]

    monkeypatch.setattr(runner, "fetch_candidate_email_pages", fake_pages)

    assert runner.page_email_candidates(record, 0.01) == [
        runner.ResolvedRecipient(
            email="sales@example.com",
            source="public page: https://example.com/contact",
        )
    ]


def test_selection_uses_organization_state_to_avoid_duplicate_company(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)

    def fake_resolve(
        record: object,
        _profile: object,
        *,
        recipient_override: str | None,
        timeout_seconds: float,
    ) -> object | None:
        del recipient_override, timeout_seconds
        return runner.ResolvedRecipient(
            email=f"sales@{getattr(record, 'domain')}",
            source="recipient override",
        )

    monkeypatch.setattr(runner, "resolve_recipient_email", fake_resolve)

    records = runner.load_contact_form_records(csv_path)
    target, profile, _recipient = runner.select_next_target(
        records,
        {"sent": [{"organization_key": "microsoft"}], "failed": []},
    )

    assert target.domain == "workers.dev"
    assert profile.company_name == "Cloudflare"


def test_draft_is_specific_short_and_mentions_price(tmp_path: Path) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)
    records = runner.load_contact_form_records(csv_path)
    target = next(record for record in records if record.domain == "workers.dev")
    profile = runner.profile_for_record(target)

    draft = runner.build_draft(
        target,
        profile,
        sender="sales@hushline.app",
        recipient=runner.ResolvedRecipient(
            email="enterprise-sales@cloudflare.com",
            source="public page: https://www.cloudflare.com/contact",
        ),
        send_date=date(2026, 6, 11),
        research_timeout_seconds=0.01,
    )

    assert draft.sender == "sales@hushline.app"
    assert draft.recipient == "enterprise-sales@cloudflare.com"
    assert draft.recipient_source == "public page: https://www.cloudflare.com/contact"
    assert "$5/mo" in draft.body
    assert "rank 88" in draft.body
    assert "a GET-style submission path" in draft.body
    assert "Sarbanes-Oxley" in draft.body
    assert len(draft.body.split()) <= 180
    for phrase in runner.FORBIDDEN_DRAFT_PHRASES:
        assert phrase not in draft.body.lower()


def test_send_when_due_uses_recipient_local_window() -> None:
    runner = load_runner()
    profile = runner.COMPANY_PROFILES["workers.dev"]
    target = runner.target_local_datetime(date(2026, 6, 11), profile)

    assert target.hour in {4, 5, 6, 7, 8}
    assert runner.within_send_window(target.astimezone(UTC), target)
    assert not runner.within_send_window((target - timedelta(minutes=1)).astimezone(UTC), target)
    late = datetime.combine(target.date(), runner.time(9, 0), tzinfo=target.tzinfo)
    assert runner.within_send_window(late.astimezone(UTC), target)
    next_day = datetime.combine(
        target.date() + timedelta(days=1), runner.time(4, 0), tzinfo=target.tzinfo
    )
    assert not runner.within_send_window(next_day.astimezone(UTC), target)


def test_refuses_non_sales_sender() -> None:
    runner = load_runner()

    with pytest.raises(runner.SalesAgentError, match="must be exactly sales@hushline.app"):
        runner.sales_from_address("hello@hushline.app")


def test_send_with_mail_app_uses_sales_account_and_fixed_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    runner.send_with_mail_app(
        "sales@hushline.app",
        "sales@example.com",
        "Subject",
        "Body",
    )

    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command[:5] == [
        "/usr/bin/osascript",
        "-",
        "sales@hushline.app",
        "sales@example.com",
        "Subject",
    ]
    script = kwargs["input"]
    assert isinstance(script, str)
    assert 'tell application "Mail"' in script
    assert "repeat with mailAccount in every account" in script
    assert "set outgoingMessage to make new outgoing message" in script
    assert script.index("set outgoingMessage to make new outgoing message") < script.index(
        "ignoring application responses"
    )
    assert "ignoring application responses" in script


def test_monitor_undeliverable_returns_bounce_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()

    monkeypatch.setattr(
        runner,
        "check_mail_app_undeliverable",
        lambda _recipient, _lookback_seconds: "undeliverable: Delivery Status Notification",
    )

    assert (
        runner.monitor_undeliverable(
            "sales@example.com",
            monitor_seconds=300,
            poll_seconds=15,
        )
        == "undeliverable: Delivery Status Notification"
    )


def test_launchd_wrapper_dry_run_bypasses_send_window_gate() -> None:
    script = WRAPPER_PATH.read_text(encoding="utf-8")
    dry_run_branch = script.split('if [[ "$DRY_RUN" == "1" ]]; then', 1)[1].split(
        "else",
        1,
    )[0]

    assert "command+=(--dry-run)" in dry_run_branch
    assert "command+=(--send-when-due)" not in dry_run_branch
