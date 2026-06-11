#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import html.parser
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc  # noqa: UP017 - launchd may run this with Apple's Python 3.9.

SALES_FROM_ENV = "HUSHLINE_SALES_AGENT_FROM"
SALES_ALLOWED_FROM = "sales@hushline.app"
DOCS_REPO_ENV = "HUSHLINE_SALES_AGENT_DOCS_REPO_DIR"
STATE_FILE_ENV = "HUSHLINE_SALES_AGENT_STATE_FILE"
OUTPUT_DIR_ENV = "HUSHLINE_SALES_AGENT_OUTPUT_DIR"
RECIPIENT_OVERRIDE_ENV = "HUSHLINE_SALES_AGENT_RECIPIENT_OVERRIDE"
LIVE_RESEARCH_ENV = "HUSHLINE_SALES_AGENT_LIVE_RESEARCH"
MAIL_APP_APPLESCRIPT_TIMEOUT_SECONDS = 300
MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS = MAIL_APP_APPLESCRIPT_TIMEOUT_SECONDS + 30
MAIL_APP_APPLE_EVENT_TIMEOUT_CODE = "-1712"
MAX_DRAFT_WORDS = 180

MAIL_APP_APPLESCRIPT = r"""
on run argv
  set fromAddress to item 1 of argv
  set recipientAddress to item 2 of argv
  set messageSubject to item 3 of argv
  set bodyPath to item 4 of argv

  set messageBody to read POSIX file bodyPath as «class utf8»

  tell application "Mail"
    set matchingAccount to missing value
    repeat with mailAccount in every account
      if email addresses of mailAccount contains fromAddress then
        set matchingAccount to mailAccount
        exit repeat
      end if
    end repeat

    if matchingAccount is missing value then
      error "Mail account not found for " & fromAddress
    end if

    with timeout of 300 seconds
      ignoring application responses
        set messageContent to messageBody & return & return
        set messageProps to {subject:messageSubject, content:messageContent, visible:false}
        set outgoingMessage to make new outgoing message with properties messageProps
        tell outgoingMessage
          set sender to fromAddress
          make new to recipient at end of to recipients with properties {address:recipientAddress}
          send
        end tell
      end ignoring
    end timeout
  end tell
end run
"""

FORBIDDEN_DRAFT_PHRASES = (
    "game changer",
    "revolutionize",
    "circle back",
    "just checking in",
    "touch base",
    "unlock",
    "synergy",
    "leverage our",
    "ai-powered",
)


class SalesAgentError(RuntimeError):
    pass


@dataclass(frozen=True)
class ContactFormRecord:
    rank: int
    domain: str
    homepage_final_url: str
    contact_final_url: str
    selected_contact_link: str
    form_action: str
    form_method: str
    field_count: int
    required_field_count: int
    required_high_risk_identity: str
    third_party_script_host_count: int
    third_party_script_hosts: str
    observed_request_count_after_input: int
    canary_request_count: int
    canary_hosts: str
    leaked_before_submit: bool
    post_method: bool
    no_third_party_scripts: bool
    no_observed_pre_submit_leak: bool
    csp_restricts_form_action: bool
    encryption_disclosed: bool
    privacy_respecting_tier: bool
    hardened_tier: bool


@dataclass(frozen=True)
class CompanyProfile:
    company_name: str
    organization_key: str
    industry: str
    timezone_name: str
    recipient_email: str
    regulatory_context: str


@dataclass(frozen=True)
class PageSummary:
    title: str = ""
    description: str = ""


@dataclass(frozen=True)
class SalesDraft:
    sender: str
    recipient: str
    subject: str
    body: str
    target: ContactFormRecord
    profile: CompanyProfile
    target_local_time: datetime


COMPANY_PROFILES: dict[str, CompanyProfile] = {
    "microsoft.com": CompanyProfile(
        "Microsoft",
        "microsoft",
        "enterprise software",
        "America/Los_Angeles",
        "sales@microsoft.com",
        "us_public_company",
    ),
    "skype.com": CompanyProfile(
        "Microsoft",
        "microsoft",
        "enterprise communications",
        "America/Los_Angeles",
        "sales@microsoft.com",
        "us_public_company",
    ),
    "workers.dev": CompanyProfile(
        "Cloudflare",
        "cloudflare",
        "internet infrastructure",
        "America/Los_Angeles",
        "sales@cloudflare.com",
        "us_public_company",
    ),
    "b-cdn.net": CompanyProfile(
        "Bunny.net",
        "bunny",
        "content delivery infrastructure",
        "Europe/Ljubljana",
        "sales@bunny.net",
        "eu_private_sector",
    ),
    "cnn.com": CompanyProfile(
        "CNN",
        "cnn",
        "media",
        "America/New_York",
        "sales@cnn.com",
        "us_media",
    ),
    "ubuntu.com": CompanyProfile(
        "Canonical",
        "canonical",
        "open source software",
        "Europe/London",
        "sales@canonical.com",
        "uk_private_sector",
    ),
    "stripe.com": CompanyProfile(
        "Stripe",
        "stripe",
        "payments",
        "America/Los_Angeles",
        "sales@stripe.com",
        "financial_services",
    ),
    "meraki.com": CompanyProfile(
        "Cisco Meraki",
        "cisco",
        "networking",
        "America/Los_Angeles",
        "sales@cisco.com",
        "us_public_company",
    ),
    "quickconnect.to": CompanyProfile(
        "Synology",
        "synology",
        "network storage",
        "Asia/Taipei",
        "sales@synology.com",
        "general_cross_border",
    ),
    "selectel.ru": CompanyProfile(
        "Selectel",
        "selectel",
        "cloud infrastructure",
        "Europe/Moscow",
        "sales@selectel.ru",
        "general_cross_border",
    ),
    "plesk.com": CompanyProfile(
        "Plesk",
        "plesk",
        "hosting software",
        "Europe/Zurich",
        "sales@plesk.com",
        "general_cross_border",
    ),
    "tp-link.com": CompanyProfile(
        "TP-Link",
        "tp-link",
        "networking hardware",
        "Asia/Shanghai",
        "sales@tp-link.com",
        "general_cross_border",
    ),
    "zendesk.com": CompanyProfile(
        "Zendesk",
        "zendesk",
        "customer service software",
        "America/Los_Angeles",
        "sales@zendesk.com",
        "us_public_company",
    ),
    "cloudns.net": CompanyProfile(
        "ClouDNS",
        "cloudns",
        "DNS infrastructure",
        "Europe/Sofia",
        "sales@cloudns.net",
        "eu_private_sector",
    ),
    "netangels.ru": CompanyProfile(
        "NetAngels",
        "netangels",
        "hosting",
        "Europe/Moscow",
        "sales@netangels.ru",
        "general_cross_border",
    ),
    "steamcommunity.com": CompanyProfile(
        "Valve",
        "valve",
        "gaming and digital distribution",
        "America/Los_Angeles",
        "business@valvesoftware.com",
        "us_private_sector",
    ),
    "mediatek.com": CompanyProfile(
        "MediaTek",
        "mediatek",
        "semiconductors",
        "Asia/Taipei",
        "sales@mediatek.com",
        "general_cross_border",
    ),
    "paloaltonetworks.com": CompanyProfile(
        "Palo Alto Networks",
        "palo-alto-networks",
        "cybersecurity",
        "America/Los_Angeles",
        "sales@paloaltonetworks.com",
        "us_public_company",
    ),
}


class SummaryParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_title = False
        self.title_parts: list[str] = []
        self.description = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "title":
            self.in_title = True
            return
        if tag.lower() == "meta" and attr_map.get("name", "").lower() == "description":
            self.description = attr_map.get("content", "").strip()

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_docs_repo_dir() -> Path:
    return Path(os.environ.get(DOCS_REPO_ENV, repo_root().parent / "hushline-docs"))


def default_audit_csv_path(docs_repo_dir: Path) -> Path:
    return docs_repo_dir / "docs/static/data/contact-form-study-2026-assessed-implementations.csv"


def default_state_file() -> Path:
    return Path(
        os.environ.get(
            STATE_FILE_ENV,
            repo_root() / "logs/sales/sales-contact-agent-state.json",
        )
    )


def default_output_dir() -> Path:
    return Path(os.environ.get(OUTPUT_DIR_ENV, repo_root() / "logs/sales/drafts"))


def parse_bool(value: str) -> bool:
    return value.strip().lower() == "true"


def parse_int(value: str) -> int:
    return int(value.strip() or "0")


def load_contact_form_records(csv_path: Path) -> list[ContactFormRecord]:
    if not csv_path.exists():
        raise SalesAgentError(f"Contact-form audit CSV not found: {csv_path}")

    with csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        records = [
            ContactFormRecord(
                rank=parse_int(row["rank"]),
                domain=row["domain"].strip().lower(),
                homepage_final_url=row["homepage_final_url"].strip(),
                contact_final_url=row["contact_final_url"].strip(),
                selected_contact_link=row["selected_contact_link"].strip(),
                form_action=row["form_action"].strip(),
                form_method=row["form_method"].strip().lower(),
                field_count=parse_int(row["field_count"]),
                required_field_count=parse_int(row["required_field_count"]),
                required_high_risk_identity=row["required_high_risk_identity"].strip(),
                third_party_script_host_count=parse_int(row["third_party_script_host_count"]),
                third_party_script_hosts=row["third_party_script_hosts"].strip(),
                observed_request_count_after_input=parse_int(
                    row["observed_request_count_after_input"]
                ),
                canary_request_count=parse_int(row["canary_request_count"]),
                canary_hosts=row["canary_hosts"].strip(),
                leaked_before_submit=parse_bool(row["leaked_before_submit"]),
                post_method=parse_bool(row["post_method"]),
                no_third_party_scripts=parse_bool(row["no_third_party_scripts"]),
                no_observed_pre_submit_leak=parse_bool(row["no_observed_pre_submit_leak"]),
                csp_restricts_form_action=parse_bool(row["csp_restricts_form_action"]),
                encryption_disclosed=parse_bool(row["encryption_disclosed"]),
                privacy_respecting_tier=parse_bool(row["privacy_respecting_tier"]),
                hardened_tier=parse_bool(row["hardened_tier"]),
            )
            for row in reader
        ]
    return sorted(records, key=lambda record: record.rank)


def load_state(state_file: Path) -> dict[str, Any]:
    if not state_file.exists():
        return {"sent": []}
    with state_file.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SalesAgentError(f"State file must contain an object: {state_file}")
    sent = data.setdefault("sent", [])
    if not isinstance(sent, list):
        raise SalesAgentError(f"State file sent field must be a list: {state_file}")
    return data


def save_state(state_file: Path, state: dict[str, Any]) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    temp_path = state_file.with_suffix(f"{state_file.suffix}.tmp")
    temp_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp_path.replace(state_file)


def sent_organization_keys(state: dict[str, Any]) -> set[str]:
    keys = set()
    for entry in state.get("sent", []):
        if isinstance(entry, dict) and isinstance(entry.get("organization_key"), str):
            keys.add(entry["organization_key"])
    return keys


def is_sales_candidate(record: ContactFormRecord) -> bool:
    return not (record.domain.endswith(".gov") or record.domain == "www.gov.uk")


def profile_for_record(record: ContactFormRecord) -> CompanyProfile:
    if record.domain in COMPANY_PROFILES:
        return COMPANY_PROFILES[record.domain]

    domain_parts = record.domain.split(".")
    company_name = (
        domain_parts[-2].replace("-", " ").title() if len(domain_parts) > 1 else record.domain
    )
    timezone_name = timezone_for_domain(record.domain)
    return CompanyProfile(
        company_name=company_name,
        organization_key=record.domain,
        industry="digital services",
        timezone_name=timezone_name,
        recipient_email=f"sales@{record.domain.removeprefix('www.')}",
        regulatory_context="general_cross_border",
    )


def select_next_target(
    records: list[ContactFormRecord],
    state: dict[str, Any],
) -> tuple[ContactFormRecord, CompanyProfile]:
    contacted = sent_organization_keys(state)
    for record in records:
        if not is_sales_candidate(record):
            continue
        profile = profile_for_record(record)
        if profile.organization_key not in contacted:
            return record, profile
    raise SalesAgentError("No uncontacted sales candidates remain in the audit CSV.")


def timezone_for_domain(domain: str) -> str:
    if domain.endswith(".uk"):
        return "Europe/London"
    if domain.endswith(".ru"):
        return "Europe/Moscow"
    if domain.endswith(".tw"):
        return "Asia/Taipei"
    if domain.endswith(".cn"):
        return "Asia/Shanghai"
    return "America/New_York"


def zoneinfo(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise SalesAgentError(f"Unknown timezone for sales target: {name}") from exc


def deterministic_window_minutes(send_date: date, organization_key: str) -> int:
    digest = hashlib.sha256(f"{send_date.isoformat()}:{organization_key}".encode()).hexdigest()
    return int(digest[:8], 16) % (5 * 60)


def target_local_datetime(send_date: date, profile: CompanyProfile) -> datetime:
    minutes = deterministic_window_minutes(send_date, profile.organization_key)
    local_zone = zoneinfo(profile.timezone_name)
    return datetime.combine(send_date, time(4, 0), tzinfo=local_zone) + timedelta(minutes=minutes)


def within_send_window(now: datetime, target: datetime) -> bool:
    local_now = now.astimezone(target.tzinfo)
    window_end = datetime.combine(target.date(), time(9, 0), tzinfo=target.tzinfo)
    return target <= local_now < window_end


def fetch_page_summary(url: str, timeout_seconds: float) -> PageSummary:
    if not url.startswith(("https://", "http://")):
        return PageSummary()
    request = urllib.request.Request(  # noqa: S310 - only http(s) URLs pass the scheme guard.
        url,
        headers={"User-Agent": "HushLineSalesAgent/1.0 (+https://hushline.app)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
            content_type = response.headers.get("content-type", "")
            if "text/html" not in content_type.lower():
                return PageSummary()
            raw_html = response.read(512_000).decode("utf-8", errors="replace")
    except OSError:
        return PageSummary()

    parser = SummaryParser()
    parser.feed(raw_html)
    title = normalize_space(" ".join(parser.title_parts))
    description = normalize_space(parser.description)
    return PageSummary(title=title, description=description)


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def bool_env_enabled(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def research_summary(record: ContactFormRecord, *, timeout_seconds: float) -> PageSummary:
    if not bool_env_enabled(LIVE_RESEARCH_ENV, default=True):
        return PageSummary()
    return fetch_page_summary(record.homepage_final_url, timeout_seconds)


def observed_problem_sentence(record: ContactFormRecord, profile: CompanyProfile) -> str:
    details: list[str] = []
    if record.form_method == "get" or not record.post_method:
        details.append("a GET-style submission path")
    if record.required_high_risk_identity:
        details.append(f"a required {record.required_high_risk_identity.lower()} field")
    if record.third_party_script_host_count:
        noun = (
            "third-party script host"
            if record.third_party_script_host_count == 1
            else "third-party script hosts"
        )
        details.append(f"{record.third_party_script_host_count} {noun}")
    if record.canary_request_count or record.leaked_before_submit:
        details.append("an observable pre-submit request containing test input")
    if not record.csp_restricts_form_action:
        details.append("no apparent CSP form-action restriction")

    if not details:
        details.append("sensitive inbound contact handled in a general-purpose form")

    joined = "; ".join(details[:3])
    return (
        f"In our contact-form audit, the {profile.company_name} intake we reviewed "
        f"at rank {record.rank} showed a few practical concerns: {joined}."
    )


def regulatory_sentence(profile: CompanyProfile) -> str:
    if profile.regulatory_context == "eu_private_sector":
        return (
            "For EU employers, the Whistleblower Protection Directive has made clear, "
            "confidential reporting channels a normal operating expectation."
        )
    if profile.regulatory_context == "uk_private_sector":
        return (
            "For UK employers, whistleblowing protections under the Public Interest "
            "Disclosure Act make a quiet, well-scoped reporting path useful."
        )
    if profile.regulatory_context == "financial_services":
        return (
            "For payments and financial-services teams, SEC, CFTC, and anti-retaliation "
            "programs make early internal reporting channels worth keeping simple."
        )
    if profile.regulatory_context == "us_public_company":
        return (
            "For US public companies, Sarbanes-Oxley and SEC whistleblower programs "
            "make internal reporting channels a normal governance concern."
        )
    if profile.regulatory_context == "us_media":
        return (
            "For media organizations, a separate secure intake helps keep sensitive "
            "source and employee concerns away from ordinary contact workflows."
        )
    return (
        "For teams operating across borders, employee reporting and anti-retaliation "
        "rules increasingly reward clear, confidential intake paths."
    )


def build_subject(profile: CompanyProfile) -> str:
    return f"Secure intake option for {profile.company_name}"


def build_body(
    record: ContactFormRecord,
    profile: CompanyProfile,
    page_summary: PageSummary,
) -> str:
    title_fragment = ""
    if page_summary.title:
        title_fragment = f" I looked at {page_summary.title[:90].rstrip()}."

    offer_sentence = (
        "Hush Line gives teams a separate secure intake for sensitive employee, customer, "
        "or public reports. It is hosted, privacy-focused, and $5/mo, so it can sit beside "
        "an existing contact or sales form without turning into a procurement project."
    )
    body = f"""Hi {profile.company_name} team,

{observed_problem_sentence(record, profile)}{title_fragment}

{offer_sentence}

{regulatory_sentence(profile)}

Would it be useful if I sent the specific finding and a suggested link placement?

Glenn
Hush Line"""
    return normalize_body(body)


def normalize_body(body: str) -> str:
    lines = [line.rstrip() for line in body.strip().splitlines()]
    return "\n".join(lines) + "\n"


def validate_draft(subject: str, body: str) -> None:
    text = f"{subject}\n{body}".lower()
    for phrase in FORBIDDEN_DRAFT_PHRASES:
        if phrase in text:
            raise SalesAgentError(f"Draft contains forbidden sales phrase: {phrase}")
    word_count = len(re.findall(r"\b[\w$./-]+\b", body))
    if word_count > MAX_DRAFT_WORDS:
        raise SalesAgentError(f"Draft is too long: {word_count} words")
    if "$5/mo" not in body:
        raise SalesAgentError("Draft must mention the $5/mo subscription.")


def sales_from_address(explicit_sender: str | None = None) -> str:
    sender = (explicit_sender or os.environ.get(SALES_FROM_ENV, SALES_ALLOWED_FROM)).strip()
    if sender.lower() != SALES_ALLOWED_FROM:
        raise SalesAgentError(f"{SALES_FROM_ENV} must be exactly {SALES_ALLOWED_FROM}.")
    return sender


def build_draft(  # noqa: PLR0913 - explicit call sites keep sales-send inputs auditable.
    record: ContactFormRecord,
    profile: CompanyProfile,
    *,
    sender: str,
    recipient_override: str | None,
    send_date: date,
    research_timeout_seconds: float,
) -> SalesDraft:
    page_summary = research_summary(record, timeout_seconds=research_timeout_seconds)
    recipient = (
        recipient_override or os.environ.get(RECIPIENT_OVERRIDE_ENV) or profile.recipient_email
    ).strip()
    subject = build_subject(profile)
    body = build_body(record, profile, page_summary)
    validate_draft(subject, body)
    return SalesDraft(
        sender=sender,
        recipient=recipient,
        subject=subject,
        body=body,
        target=record,
        profile=profile,
        target_local_time=target_local_datetime(send_date, profile),
    )


def draft_output_path(output_dir: Path, send_date: date, draft: SalesDraft) -> Path:
    safe_key = re.sub(r"[^a-z0-9.-]+", "-", draft.profile.organization_key.lower()).strip("-")
    return output_dir / f"{send_date.isoformat()}-{safe_key}.txt"


def persist_draft(output_dir: Path, send_date: date, draft: SalesDraft) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = draft_output_path(output_dir, send_date, draft)
    path.write_text(
        (
            f"From: {draft.sender}\n"
            f"To: {draft.recipient}\n"
            f"Subject: {draft.subject}\n"
            f"Target: {draft.target.domain} rank {draft.target.rank}\n"
            f"Target local send time: {draft.target_local_time.isoformat()}\n\n"
            f"{draft.body}"
        ),
        encoding="utf-8",
    )
    return path


def send_with_mail_app(sender: str, recipient: str, subject: str, body: str) -> None:
    if sender.lower() != SALES_ALLOWED_FROM:
        raise SalesAgentError(f"Refusing to send sales email from {sender!r}.")

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as temp:
        temp.write(body)
        body_path = temp.name
    try:
        command = ["/usr/bin/osascript", "-", sender, recipient, subject, body_path]
        try:
            result = subprocess.run(  # noqa: S603 - fixed executable with data-only arguments.
                command,
                input=MAIL_APP_APPLESCRIPT,
                capture_output=True,
                text=True,
                check=False,
                timeout=MAIL_APP_OSASCRIPT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            print(
                "Warning: Mail.app send handoff exceeded the osascript timeout; "
                "the persisted sales draft is available if delivery needs confirmation.",
                file=sys.stderr,
            )
            return
    finally:
        Path(body_path).unlink(missing_ok=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no Mail.app output"
        if is_mail_app_apple_event_timeout(detail):
            print(
                "Warning: Mail.app reported an AppleEvent timeout after the send handoff; "
                "the persisted sales draft is available if delivery needs confirmation.",
                file=sys.stderr,
            )
            return
        raise SalesAgentError(f"Mail.app send failed: {detail}")


def is_mail_app_apple_event_timeout(detail: str) -> bool:
    normalized_detail = detail.lower()
    return (
        MAIL_APP_APPLE_EVENT_TIMEOUT_CODE in detail
        and "appleevent timed out" in normalized_detail
        and "mail got an error" in normalized_detail
    )


def record_sent(
    state: dict[str, Any], draft: SalesDraft, send_date: date, draft_path: Path
) -> None:
    state.setdefault("sent", []).append(
        {
            "date": send_date.isoformat(),
            "domain": draft.target.domain,
            "rank": draft.target.rank,
            "organization_key": draft.profile.organization_key,
            "company_name": draft.profile.company_name,
            "recipient": draft.recipient,
            "subject": draft.subject,
            "draft_path": str(draft_path),
            "target_local_time": draft.target_local_time.isoformat(),
            "sent_at": datetime.now(UTC).isoformat(),
        }
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send one daily Hush Line sales contact email.")
    parser.add_argument("--docs-repo-dir", type=Path, default=default_docs_repo_dir())
    parser.add_argument("--audit-csv", type=Path)
    parser.add_argument("--state-file", type=Path, default=default_state_file())
    parser.add_argument("--output-dir", type=Path, default=default_output_dir())
    parser.add_argument("--date", dest="send_date")
    parser.add_argument("--now")
    parser.add_argument("--from-address")
    parser.add_argument("--recipient-override")
    parser.add_argument("--research-timeout", type=float, default=4.0)
    parser.add_argument("--send-when-due", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def parse_send_date(value: str | None, now: datetime) -> date:
    if value:
        return date.fromisoformat(value)
    return now.date()


def parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = parse_now(args.now)
    send_date = parse_send_date(args.send_date, now)
    audit_csv = args.audit_csv or default_audit_csv_path(args.docs_repo_dir)

    sender = sales_from_address(args.from_address)
    records = load_contact_form_records(audit_csv)
    state = load_state(args.state_file)
    target, profile = select_next_target(records, state)
    draft = build_draft(
        target,
        profile,
        sender=sender,
        recipient_override=args.recipient_override,
        send_date=send_date,
        research_timeout_seconds=args.research_timeout,
    )

    if args.send_when_due and not within_send_window(now, draft.target_local_time):
        print(
            "Not due yet: "
            f"{profile.company_name} target local send time is "
            f"{draft.target_local_time.isoformat()}"
        )
        return 0

    draft_path = persist_draft(args.output_dir, send_date, draft)
    if args.dry_run:
        print(f"Dry run wrote sales draft: {draft_path}")
        print(f"To: {draft.recipient}")
        print(f"Subject: {draft.subject}")
        return 0

    send_with_mail_app(draft.sender, draft.recipient, draft.subject, draft.body)
    record_sent(state, draft, send_date, draft_path)
    save_state(args.state_file, state)
    print(f"Sent sales email to {draft.profile.company_name} at {draft.recipient}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SalesAgentError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
