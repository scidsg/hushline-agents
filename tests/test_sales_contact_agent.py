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


def test_selects_highest_ranked_uncontacted_company_and_skips_public_sector(
    tmp_path: Path,
) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)

    records = runner.load_contact_form_records(csv_path)
    target, profile = runner.select_next_target(records, {"sent": []})

    assert target.domain == "microsoft.com"
    assert profile.company_name == "Microsoft"
    assert profile.recipient_email == "sales@microsoft.com"


def test_selection_uses_organization_state_to_avoid_duplicate_company(tmp_path: Path) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)

    records = runner.load_contact_form_records(csv_path)
    target, profile = runner.select_next_target(
        records,
        {"sent": [{"organization_key": "microsoft"}]},
    )

    assert target.domain == "workers.dev"
    assert profile.company_name == "Cloudflare"


def test_draft_is_specific_short_and_mentions_price(tmp_path: Path) -> None:
    runner = load_runner()
    csv_path = tmp_path / "audit.csv"
    write_audit_csv(csv_path)
    records = runner.load_contact_form_records(csv_path)
    target, profile = runner.select_next_target(records, {"sent": []})

    draft = runner.build_draft(
        target,
        profile,
        sender="sales@hushline.app",
        recipient_override=None,
        send_date=date(2026, 6, 11),
        research_timeout_seconds=0.01,
    )

    assert draft.sender == "sales@hushline.app"
    assert draft.recipient == "sales@microsoft.com"
    assert "$5/mo" in draft.body
    assert "rank 6" in draft.body
    assert "showed a few practical concerns: a GET-style submission path" in draft.body
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
    assert not runner.within_send_window(late.astimezone(UTC), target)


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
    assert "ignoring application responses" in script


def test_launchd_wrapper_dry_run_bypasses_send_window_gate() -> None:
    script = WRAPPER_PATH.read_text(encoding="utf-8")
    dry_run_branch = script.split('if [[ "$DRY_RUN" == "1" ]]; then', 1)[1].split(
        "else",
        1,
    )[0]

    assert "command+=(--dry-run)" in dry_run_branch
    assert "command+=(--send-when-due)" not in dry_run_branch
