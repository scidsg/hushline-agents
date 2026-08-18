from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
RUNNER_PATH = ROOT / "agents" / "sales" / "scripts" / "sales_lead_agent.py"
WRAPPER_PATH = ROOT / "agents" / "sales" / "scripts" / "run_sales_lead_agent_launchd.sh"
INSTALLER_PATH = ROOT / "agents" / "sales" / "scripts" / "install_sales_lead_launch_agent.sh"
PLIST_PATH = (
    ROOT / "agents" / "sales" / "deploy" / "launchd" / "com.hushline.sales.lead-agent.plist"
)


def authenticated_headers(sender: str, *, reply_to: str = "", dmarc: str = "pass") -> str:
    address = sender.rsplit("<", maxsplit=1)[-1].rstrip(">")
    headers = [
        f"From: {sender}",
        f"Return-Path: <{address}>",
        (
            "Authentication-Results: mx.hushline.app; "
            f"spf=pass smtp.mailfrom={address}; dkim=pass; dmarc={dmarc}"
        ),
    ]
    if reply_to:
        headers.append(f"Reply-To: {reply_to}")
    return "\n".join(headers) + "\n"


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("sales_lead_agent", RUNNER_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def lead_message(runner: ModuleType) -> Any:
    sender = "Jane Doe <jane.doe@acme.example>"
    return runner.MailMessage(
        local_id=42,
        message_id="lead-42@example.com",
        sender=sender,
        subject="Pricing and demo for a whistleblowing channel",
        received_at="Sunday, August 17, 2026 at 10:00:00 AM",
        content=(
            "Hello,\n\nCompany: Acme Corp\nRole: Director of Compliance\n"
            "We need an anonymous whistleblowing reporting channel for 500 employees. "
            "We are evaluating pricing and need to launch by October 15.\n\nThanks,\nJane Doe"
        ),
        raw_headers=authenticated_headers(sender),
    )


def test_qualified_lead_summary_contains_required_executive_fields() -> None:
    runner = load_runner()
    assessment = runner.assess_lead(lead_message(runner))

    assert assessment.qualified is True
    assert assessment.person == "Jane Doe"
    assert assessment.claimed_person == "Jane Doe"
    assert assessment.role == "Director of Compliance"
    assert assessment.company == "Acme Corp"
    assert "anonymous whistleblowing reporting channel" in assessment.need
    assert assessment.scale == "500 employees"
    assert assessment.urgency == "Time-bound — target or deadline: october 15."
    assert assessment.confidence == "High"
    assert assessment.security.risk == "Low"

    summary = runner.build_executive_summary(assessment)
    assert "Customer\n" in summary
    assert "Sender identity: Jane Doe" in summary
    assert "Claimed identity: Jane Doe" in summary
    assert "Claimed role: Director of Compliance" in summary
    assert "Claimed company: Acme Corp" in summary
    assert "LinkedIn identity verification\n" in summary
    assert "Status: Not confirmed" in summary
    assert "Profile: Not included" in summary
    assert "Do not use LinkedIn for outreach until a human confirms the profile." in summary
    assert "Opportunity\n" in summary
    assert "Need:" in summary
    assert "Scale: 500 employees" in summary
    assert "Urgency:" in summary
    assert "Qualification\nConfidence: High" in summary
    assert "Trust and fraud checks\nRisk: Low" in summary
    assert "Authentication: SPF pass; DKIM pass; DMARC pass" in summary
    assert "Identity consistency: Pass" in summary
    assert "Open questions\n- " in summary
    assert "Recommended next steps\n1. " in summary
    assert "Suggested follow-up email (draft only — not sent)" in summary
    assert "Subject: Next steps for Acme Corp's Hush Line evaluation" in summary
    assert "Hi Jane," in summary
    assert "Would you be open to a 30-minute discovery call" in summary
    assert "Best,\nGlenn" in summary


def test_authenticated_sender_supplied_profile_is_confirmed_with_evidence() -> None:
    runner = load_runner()
    original = lead_message(runner)
    message = runner.MailMessage(
        original.local_id,
        original.message_id,
        original.sender,
        original.subject,
        original.received_at,
        f"{original.content}\nhttps://www.linkedin.com/in/jane-doe/?trk=signature",
        original.raw_headers,
    )
    assessment = runner.assess_lead(message)

    research = runner.research_identity(message, assessment)

    assert research.status == "Confirmed from authenticated sender evidence"
    assert research.profile_url == "https://www.linkedin.com/in/jane-doe"
    assert research.role == "Claimed in authenticated message — Director of Compliance"
    assert research.company == "Domain-aligned claim — Acme Corp"
    assert "Original authenticated email" in research.sources
    assert any("exactly one LinkedIn profile URL" in item for item in research.evidence)
    summary = runner.build_executive_summary(runner.replace(assessment, identity_research=research))
    assert "Status: Confirmed from authenticated sender evidence" in summary
    assert "Profile: https://www.linkedin.com/in/jane-doe" in summary
    assert "Original authenticated email" in summary


def test_multiple_sender_supplied_profiles_are_never_guessed() -> None:
    runner = load_runner()
    original = lead_message(runner)
    message = runner.MailMessage(
        original.local_id,
        original.message_id,
        original.sender,
        original.subject,
        original.received_at,
        (
            f"{original.content}\nhttps://www.linkedin.com/in/jane-doe\n"
            "https://www.linkedin.com/in/jane-doe-2"
        ),
        original.raw_headers,
    )
    assessment = runner.assess_lead(message)

    research = runner.research_identity(message, assessment)

    assert research.status == "Not confirmed"
    assert research.profile_url == "Not included"
    assert "multiple LinkedIn profile URLs" in research.evidence[0]


def test_official_company_structured_person_record_confirms_exact_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    message = lead_message(runner)
    page = """
    <html><head><script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Person",
      "name": "Jane Doe",
      "jobTitle": "Director of Compliance",
      "worksFor": {"@type": "Organization", "name": "Acme Corp"},
      "sameAs": ["https://www.linkedin.com/in/jane-doe"]
    }
    </script></head></html>
    """
    monkeypatch.setattr(
        runner,
        "fetch_company_research_pages",
        lambda _domain, timeout_seconds: (("https://acme.example/team/jane-doe", page),),
    )

    research = runner.research_identity(message, runner.assess_lead(message))

    assert research.status == "Confirmed from official company evidence"
    assert research.profile_url == "https://www.linkedin.com/in/jane-doe"
    assert research.role == "Director of Compliance"
    assert research.company == "Acme Corp"
    assert research.sources == ("https://acme.example/team/jane-doe",)


def test_official_page_with_ambiguous_exact_name_never_returns_a_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    message = lead_message(runner)
    page = """
    <script type="application/ld+json">
    [
      {"@type":"Person","name":"Jane Doe","sameAs":"https://linkedin.com/in/jane-one"},
      {"@type":"Person","name":"Jane Doe","sameAs":"https://linkedin.com/in/jane-two"}
    ]
    </script>
    """
    monkeypatch.setattr(
        runner,
        "fetch_company_research_pages",
        lambda _domain, timeout_seconds: (("https://acme.example/team", page),),
    )

    research = runner.research_identity(message, runner.assess_lead(message))

    assert research.status == "Not confirmed"
    assert research.profile_url == "Not included"
    assert "multiple possible LinkedIn profiles" in research.evidence[0]


def test_company_page_does_not_match_a_different_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    message = lead_message(runner)
    page = """
    <script type="application/ld+json">
    {"@type":"Person","name":"Janet Doe","sameAs":"https://linkedin.com/in/janet-doe"}
    </script>
    """
    monkeypatch.setattr(
        runner,
        "fetch_company_research_pages",
        lambda _domain, timeout_seconds: (("https://acme.example/team", page),),
    )

    research = runner.research_identity(message, runner.assess_lead(message))

    assert research.status == "Not confirmed"
    assert research.profile_url == "Not included"


def test_official_person_at_a_different_company_is_not_confirmed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()
    message = lead_message(runner)
    page = """
    <script type="application/ld+json">
    {
      "@type":"Person",
      "name":"Jane Doe",
      "worksFor":{"@type":"Organization","name":"Different Company"},
      "sameAs":"https://linkedin.com/in/jane-doe"
    }
    </script>
    """
    monkeypatch.setattr(
        runner,
        "fetch_company_research_pages",
        lambda _domain, timeout_seconds: (("https://acme.example/team", page),),
    )

    research = runner.research_identity(message, runner.assess_lead(message))

    assert research.status == "Not confirmed"
    assert research.profile_url == "Not included"


@pytest.mark.parametrize(
    ("sender", "subject", "body"),
    [
        (
            "Newsletter <news@example.com>",
            "Whistleblowing news",
            "View in browser. Unsubscribe from this newsletter.",
        ),
        (
            "Candidate <person@gmail.com>",
            "Job application",
            "My resume is attached. I am interested in an open position.",
        ),
        (
            "SEO Team <hello@vendor.example>",
            "Secure reporting website proposal",
            "We offer SEO services and guest posts for your reporting channel.",
        ),
        (
            "Definitely Real Buyer <troll@example.com>",
            "Hush Line demo and pricing",
            "I need a demo, but only to waste your time. Your product is the worst idea.",
        ),
    ],
)
def test_non_lead_mail_is_screened_out(sender: str, subject: str, body: str) -> None:
    runner = load_runner()
    message = runner.MailMessage(1, "message-id", sender, subject, "date", body)

    assert runner.assess_lead(message).qualified is False


def test_company_fallback_reports_domain_without_inventing_a_name() -> None:
    runner = load_runner()
    message = runner.MailMessage(
        1,
        "message-id",
        "Pat Lee <pat@north-star.example>",
        "Demo request",
        "date",
        "We need a secure anonymous reporting channel.",
    )

    assert runner.extract_company(message) == "Not stated (sender domain: north-star.example)"


def test_explicit_hush_line_product_inquiry_is_relevant() -> None:
    runner = load_runner()
    sender = "Alex Morgan <alex@buyer.example>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line demo",
        "date",
        "Our team is evaluating Hush Line and would like a demo and pricing.",
        authenticated_headers(sender),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is True
    assert "Hush Line inquiry" in assessment.reasons


def test_personal_email_does_not_invent_company() -> None:
    runner = load_runner()
    message = runner.MailMessage(
        1,
        "message-id",
        "Pat Lee <pat@gmail.com>",
        "Demo request",
        "date",
        "I need an anonymous reporting channel.",
    )

    assert runner.extract_company(message) == "Not stated"


def test_open_questions_label_missing_customer_intelligence() -> None:
    runner = load_runner()
    sender = "Pat <pat@gmail.com>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line pricing",
        "date",
        "I need a secure reporting channel and would like pricing.",
        authenticated_headers(sender),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is True
    assert assessment.role == "Not stated"
    assert assessment.company == "Not stated"
    assert assessment.scale == "Not stated"
    assert "What is the sender's role in evaluation and approval?" in assessment.open_questions
    assert "What is the legal organization name and primary operating region?" in (
        assessment.open_questions
    )


def test_mail_record_parser_preserves_multiline_content() -> None:
    runner = load_runner()
    raw = (
        runner.FIELD_SEPARATOR.join(
            (
                "12",
                "internet-id",
                "Jane <jane@example.com>",
                "Subject",
                "date",
                "line 1\nline 2",
                "From: Jane <jane@example.com>\n",
            )
        )
        + runner.RECORD_SEPARATOR
        + "\n"
    )

    assert runner.parse_mail_records(raw) == [
        runner.MailMessage(
            12,
            "internet-id",
            "Jane <jane@example.com>",
            "Subject",
            "date",
            "line 1\nline 2",
            "From: Jane <jane@example.com>\n",
        )
    ]


@pytest.mark.parametrize(
    "address",
    [
        "missing-at.example",
        ".leading@example.com",
        "trailing.@example.com",
        "two..dots@example.com",
        "person@localhost",
        "person@[127.0.0.1]",
    ],
)
def test_invalid_sender_addresses_are_rejected(address: str) -> None:
    runner = load_runner()
    assert runner.validate_email_address(address) is False


def test_spoofed_from_header_blocks_an_otherwise_qualified_lead() -> None:
    runner = load_runner()
    message = runner.MailMessage(
        1,
        "message-id",
        "Jane Doe <jane@acme.example>",
        "Hush Line pricing and demo",
        "date",
        "We need an anonymous reporting channel for our company and want a demo.",
        authenticated_headers("Impostor <ceo@different.example>"),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is False
    assert assessment.security.risk == "High"
    assert "Mail sender and RFC From mismatch" in assessment.security.flags


def test_dmarc_failure_blocks_an_otherwise_qualified_lead() -> None:
    runner = load_runner()
    sender = "Jane Doe <jane@acme.example>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line pricing and demo",
        "date",
        "We need an anonymous reporting channel for our company and want a demo.",
        authenticated_headers(sender, dmarc="fail"),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is False
    assert assessment.security.risk == "High"
    assert "Sender authentication failed" in assessment.security.flags


def test_reply_to_mismatch_produces_brief_with_review_warning() -> None:
    runner = load_runner()
    sender = "Jane Doe <jane@acme.example>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line pricing and demo",
        "date",
        "We need an anonymous reporting channel for our company and want a demo.",
        authenticated_headers(sender, reply_to="jane@consultant.example"),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is True
    assert assessment.security.risk == "Review"
    assert "Reply-To domain differs from the sender domain" in assessment.security.flags


def test_urgent_payment_fraud_is_blocked() -> None:
    runner = load_runner()
    sender = "Jane Doe <jane@acme.example>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Urgent Hush Line demo",
        "date",
        (
            "We need an anonymous reporting channel and a demo. Immediately send a wire "
            "transfer to the confidential bank account today."
        ),
        authenticated_headers(sender),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is False
    assert assessment.security.risk == "High"
    assert "Urgent or secret payment request" in assessment.security.flags


def test_claimed_person_conflicting_with_sender_identity_is_high_risk() -> None:
    runner = load_runner()
    sender = "Glenn Sorrentino <glenn.sorrentino@proton.me>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line demo and pricing",
        "date",
        (
            "Company: Northstar Foundation\nRole: Director of Compliance\n"
            "We need an anonymous reporting channel and would like a demo.\n\n"
            "Thanks,\nAudry"
        ),
        authenticated_headers(sender),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is False
    assert assessment.person == "Glenn Sorrentino"
    assert assessment.claimed_person == "Audry"
    assert assessment.security.risk == "High"
    assert "Sender identity conflicts with the identity claimed in the message" in (
        assessment.security.flags
    )
    assert "personal email domain proton.me" in assessment.security.affiliation_validation


def test_matching_personal_sender_keeps_company_affiliation_unverified() -> None:
    runner = load_runner()
    sender = "Audry Chen <audry.chen@proton.me>"
    message = runner.MailMessage(
        1,
        "message-id",
        sender,
        "Hush Line demo and pricing",
        "date",
        (
            "Company: Northstar Foundation\nRole: Director of Compliance\n"
            "We need an anonymous reporting channel and would like a demo.\n\n"
            "Thanks,\nAudry Chen"
        ),
        authenticated_headers(sender),
    )

    assessment = runner.assess_lead(message)
    assert assessment.qualified is True
    assert assessment.security.risk == "Review"
    assert assessment.security.identity_consistency.startswith("Pass")
    assert assessment.security.affiliation_validation.startswith("Unverified")


def test_state_contains_no_prospect_content(tmp_path: Path) -> None:
    runner = load_runner()
    message = lead_message(runner)
    assessment = runner.assess_lead(message)
    state = {"version": 1, "processed": []}
    state_path = tmp_path / "state.json"

    runner.record_processed(state, message, assessment)
    runner.save_state(state_path, state)

    raw_state = state_path.read_text(encoding="utf-8")
    data = json.loads(raw_state)
    assert data["processed"][0]["decision"] == "brief_sent"
    assert "Jane" not in raw_state
    assert "Acme" not in raw_state
    assert "jane.doe" not in raw_state
    assert state_path.stat().st_mode & 0o777 == 0o600


def test_run_is_idempotent_and_dry_run_does_not_write_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = load_runner()
    message = lead_message(runner)
    state_path = tmp_path / "state.json"
    briefs_sent: list[int] = []
    monkeypatch.setattr(runner, "fetch_unread_messages", lambda _max: [message])
    monkeypatch.setattr(
        runner,
        "deliver_qualified_lead",
        lambda mail, _summary: briefs_sent.append(mail.local_id),
    )
    monkeypatch.setattr(
        runner,
        "research_identity",
        lambda _message, _assessment: runner.unconfirmed_identity("Test research result."),
    )

    assert runner.run(dry_run=True, state_file=state_path, max_messages=50) == (1, 1, 0, 0)
    assert not state_path.exists()
    assert briefs_sent == []

    assert runner.run(dry_run=False, state_file=state_path, max_messages=50) == (1, 1, 0, 0)
    assert briefs_sent == [42]
    assert runner.run(dry_run=False, state_file=state_path, max_messages=50) == (0, 0, 0, 0)
    assert briefs_sent == [42]


def test_delivery_sends_summary_and_original_as_one_forwarded_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del tmp_path
    runner = load_runner()
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["script"] = kwargs["input"]
        summary_path = Path(command[-2])
        original_message_path = Path(command[-1])
        captured["summary_path"] = summary_path
        captured["original_message_path"] = original_message_path
        assert summary_path.read_text(encoding="utf-8") == "Executive summary"
        assert original_message_path.name == "original-message.eml"
        assert original_message_path.parent.stat().st_mode & 0o777 == 0o700
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    runner.deliver_qualified_lead(lead_message(runner), "Executive summary")

    command = captured["command"]
    assert isinstance(command, list)
    assert command[:4] == [
        "/usr/bin/osascript",
        "-",
        "sales@hushline.app",
        "glenn@hushline.app",
    ]
    script = str(captured["script"])
    assert "set deliveryMessage to make new outgoing message" in script
    assert '"Begin forwarded message:"' in script
    assert "source of sourceMessage as text" in script
    assert "make new attachment" in script
    assert "serializedBody does not contain messageBody" in script
    assert script.count("        send deliveryMessage\n") == 1
    assert script.index("send deliveryMessage") < script.index(
        "set read status of sourceMessage to true"
    )
    summary_path = captured["summary_path"]
    assert isinstance(summary_path, Path)
    assert not summary_path.exists()
    original_message_path = captured["original_message_path"]
    assert isinstance(original_message_path, Path)
    assert not original_message_path.parent.exists()


def test_delivery_rejects_empty_summary_without_calling_mail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = load_runner()

    def unexpected_run(*_args: object, **_kwargs: object) -> None:
        pytest.fail("Mail must not be called for an empty executive summary")

    monkeypatch.setattr(runner.subprocess, "run", unexpected_run)

    with pytest.raises(runner.SalesLeadAgentError, match="empty executive summary"):
        runner.deliver_qualified_lead(lead_message(runner), "  \n")


def test_launchd_assets_are_gui_scoped_and_poll_every_five_minutes() -> None:
    wrapper = WRAPPER_PATH.read_text(encoding="utf-8")
    installer = INSTALLER_PATH.read_text(encoding="utf-8")
    plist = PLIST_PATH.read_text(encoding="utf-8")

    assert "sales_lead_agent.py" in wrapper
    assert "--dry-run" in wrapper
    assert "LaunchAgents" in installer
    assert "LaunchDaemons" not in installer
    assert "<integer>300</integer>" in plist
    assert "<true/>" in plist
