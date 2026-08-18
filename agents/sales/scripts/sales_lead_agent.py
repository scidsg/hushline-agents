#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html.parser
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from email import policy
from email.parser import Parser
from email.utils import getaddresses, parseaddr
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SALES_ACCOUNT = "sales@hushline.app"
BRIEF_RECIPIENT = "glenn@hushline.app"
STATE_FILE_ENV = "HUSHLINE_SALES_LEAD_AGENT_STATE_FILE"
DEFAULT_MAX_MESSAGES = 50
MAX_MESSAGES = 200
MAX_MESSAGE_CONTENT_CHARS = 50_000
MAX_STATE_ENTRIES = 5_000
MAIL_RECORD_FIELD_COUNT = 7
MAX_EMAIL_ADDRESS_CHARS = 254
MAX_EMAIL_LOCAL_PART_CHARS = 64
MAX_EMAIL_DOMAIN_CHARS = 253
MAX_EMAIL_DOMAIN_LABEL_CHARS = 63
MAX_LINK_DOMAINS_BEFORE_WARNING = 4
MIN_RELEVANT_SENTENCE_CHARS = 8
MAX_COMPANY_SIGNATURE_WORDS = 8
QUALIFIED_SCORE = 5
HIGH_CONFIDENCE_SCORE = 8
MAX_OPEN_QUESTIONS = 5
MAX_CLAIMED_NAME_WORDS = 4
MIN_COMPANY_DOMAIN_TOKEN_CHARS = 3
IDENTITY_RESEARCH_ENV = "HUSHLINE_SALES_LEAD_AGENT_IDENTITY_RESEARCH"
IDENTITY_RESEARCH_TIMEOUT_SECONDS = 4.0
MAX_RESEARCH_PAGE_BYTES = 512_000
MAX_STRUCTURED_DATA_OBJECTS = 10_000
RESEARCH_USER_AGENT = "HushLineSalesLeadAgent/1.0 (+https://hushline.app)"
COMPANY_RESEARCH_PATHS = ("/", "/about", "/team", "/leadership", "/people", "/staff")
MAIL_APP_TIMEOUT_SECONDS = 300
OSASCRIPT_TIMEOUT_SECONDS = MAIL_APP_TIMEOUT_SECONDS + 30
APPLE_EVENT_TIMEOUT_CODE = "-1712"
FIELD_SEPARATOR = chr(31)
RECORD_SEPARATOR = chr(30)
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
PERSONAL_EMAIL_DOMAINS = {
    "aol.com",
    "gmail.com",
    "hotmail.com",
    "icloud.com",
    "live.com",
    "outlook.com",
    "proton.me",
    "protonmail.com",
    "yahoo.com",
}

MAIL_APP_UNREAD_APPLESCRIPT = r"""
on replaceText(sourceText, oldText, newText)
  set AppleScript's text item delimiters to oldText
  set textItems to every text item of sourceText
  set AppleScript's text item delimiters to newText
  set sourceText to textItems as text
  set AppleScript's text item delimiters to ""
  return sourceText
end replaceText

on cleanField(sourceValue)
  set sourceText to sourceValue as text
  set sourceText to my replaceText(sourceText, character id 31, " ")
  set sourceText to my replaceText(sourceText, character id 30, " ")
  return sourceText
end cleanField

on run argv
  set fromAddress to item 1 of argv
  set maxMessages to (item 2 of argv) as integer
  set maxContentChars to (item 3 of argv) as integer
  set fieldSeparator to character id 31
  set recordSeparator to character id 30
  set outputText to ""

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

    try
      set accountInbox to mailbox "INBOX" of matchingAccount
    on error
      set accountInbox to mailbox "Inbox" of matchingAccount
    end try
    set candidateMessages to every message of accountInbox whose read status is false
    set candidateCount to count of candidateMessages
    if candidateCount > maxMessages then set candidateCount to maxMessages

    repeat with messageIndex from 1 to candidateCount
      set mailMessage to item messageIndex of candidateMessages
      set localID to id of mailMessage as text
      set internetMessageID to ""
      try
        set internetMessageID to message id of mailMessage as text
      end try
      set messageSender to sender of mailMessage as text
      set messageSubject to subject of mailMessage as text
      set receivedAt to date received of mailMessage as text
      set messageHeaders to all headers of mailMessage as text
      set messageContent to content of mailMessage as text
      if length of messageContent > maxContentChars then
        set messageContent to text 1 thru maxContentChars of messageContent
      end if

      set outputText to outputText & my cleanField(localID) & fieldSeparator
      set outputText to outputText & my cleanField(internetMessageID) & fieldSeparator
      set outputText to outputText & my cleanField(messageSender) & fieldSeparator
      set outputText to outputText & my cleanField(messageSubject) & fieldSeparator
      set outputText to outputText & my cleanField(receivedAt) & fieldSeparator
      set outputText to outputText & my cleanField(messageContent) & fieldSeparator
      set outputText to outputText & my cleanField(messageHeaders) & recordSeparator
    end repeat
  end tell
  return outputText
end run
"""

MAIL_APP_DELIVER_LEAD_APPLESCRIPT = r"""
on run argv
  set fromAddress to item 1 of argv
  set recipientAddress to item 2 of argv
  set targetLocalID to item 3 of argv as integer
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

    try
      set accountInbox to mailbox "INBOX" of matchingAccount
    on error
      set accountInbox to mailbox "Inbox" of matchingAccount
    end try

    set sourceMessage to missing value
    repeat with mailMessage in every message of accountInbox
      if id of mailMessage is targetLocalID then
        set sourceMessage to mailMessage
        exit repeat
      end if
    end repeat
    if sourceMessage is missing value then
      error "Source message is no longer available in the sales inbox"
    end if

    with timeout of 300 seconds
      set qualifiedForward to forward sourceMessage with opening window
      delay 1
      tell qualifiedForward
        set content to messageBody & return & return & content
        set visible to false
        set sender to fromAddress
        make new to recipient at end of to recipients with properties {address:recipientAddress}
        send
      end tell
      set read status of sourceMessage to true
    end timeout
  end tell
end run
"""

SALES_INTENT_PATTERNS: tuple[tuple[str, int, str], ...] = (
    (r"\b(demo|demonstration)\b", 3, "demo request"),
    (r"\b(pricing|price|quote|cost|budget)\b", 3, "pricing inquiry"),
    (r"\b(procurement|purchase|buy|contract|proposal|rfp|tender)\b", 3, "buying process"),
    (r"\b(evaluat(?:e|ing|ion)|pilot|trial|deploy|rollout|implement)\b", 3, "evaluation"),
    (r"\b(interested in|considering|looking for|need(?:ing)?|requirements?)\b", 2, "stated need"),
    (r"\b(partner|partnership|integrat(?:e|ion)|reseller)\b", 2, "partnership inquiry"),
)
USE_CASE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bhush\s*line\b", "Hush Line inquiry"),
    (r"\b(whistleblow(?:er|ing)?|speak[ -]?up)\b", "whistleblowing workflow"),
    (
        r"\b(anonymous|anonymity|confidential)\b.*\b(report|intake|tip|message|channel)\b",
        "anonymous reporting",
    ),
    (
        r"\b(ethics|compliance)\b.*\b(hotline|report|intake|channel|case)\b",
        "ethics and compliance reporting",
    ),
    (
        r"\b(secure|encrypted|private)\b.*\b(report|intake|tip|message|channel|form)\b",
        "secure reporting",
    ),
    (r"\b(tip[ -]?line|reporting channel|reporting system|intake channel)\b", "reporting channel"),
    (r"\b(misconduct|fraud|harassment|retaliation|wrongdoing)\b", "misconduct reporting"),
)
EXCLUSION_PATTERNS: tuple[tuple[str, int, str], ...] = (
    (r"\b(unsubscribe|newsletter|mailing list|view in browser)\b", -5, "bulk marketing"),
    (
        r"\b(job application|resume|résumé|curriculum vitae|open position|career)\b",
        -6,
        "employment inquiry",
    ),
    (r"\b(invoice|payment overdue|past due|receipt|billing statement)\b", -5, "billing message"),
    (
        r"\b(delivery status notification|undeliverable|mailer-daemon|failure notice)\b",
        -8,
        "delivery failure",
    ),
    (
        r"\b(seo services|guest post|link building|sponsored content|web development services)\b",
        -6,
        "vendor solicitation",
    ),
    (
        r"\b(password reset|verification code|one-time code|security alert)\b",
        -8,
        "automated account message",
    ),
    (
        r"\b(waste your time|worst idea|your (?:app|product) (?:is|sucks)|you(?:'re| are) "
        r"(?:an? )?(?:idiot|moron)|not buying anything)\b",
        -10,
        "abusive or troll message",
    ),
)
AUTOMATED_LOCAL_PARTS = {
    "alerts",
    "mailer-daemon",
    "news",
    "newsletter",
    "no-reply",
    "noreply",
    "notifications",
    "postmaster",
}


class SalesLeadAgentError(RuntimeError):
    pass


@dataclass(frozen=True)
class MailMessage:
    local_id: int
    message_id: str
    sender: str
    subject: str
    received_at: str
    content: str
    raw_headers: str = ""


@dataclass(frozen=True)
class SecurityAssessment:
    risk: str
    sender_validation: str
    authentication: str
    header_alignment: str
    identity_consistency: str
    affiliation_validation: str
    flags: tuple[str, ...]


@dataclass(frozen=True)
class IdentityResearch:
    status: str
    profile_url: str
    role: str
    company: str
    evidence: tuple[str, ...]
    sources: tuple[str, ...]


@dataclass(frozen=True)
class LeadAssessment:
    qualified: bool
    score: int
    person: str
    claimed_person: str
    role: str
    email: str
    company: str
    need: str
    use_cases: tuple[str, ...]
    scale: str
    urgency: str
    confidence: str
    reasons: tuple[str, ...]
    open_questions: tuple[str, ...]
    next_steps: tuple[str, ...]
    suggested_follow_up_subject: str
    suggested_follow_up_body: str
    security: SecurityAssessment
    identity_research: IdentityResearch


class StructuredIdentityParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_json_ld = False
        self._chunks: list[str] = []
        self.json_ld: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "script":
            return
        attributes = {name.casefold(): value or "" for name, value in attrs}
        if attributes.get("type", "").casefold() == "application/ld+json":
            self._in_json_ld = True
            self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._in_json_ld:
            self.json_ld.append("".join(self._chunks))
            self._in_json_ld = False
            self._chunks = []


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_state_file() -> Path:
    return Path(
        os.environ.get(
            STATE_FILE_ENV,
            repo_root() / "logs/sales/lead-agent/state.json",
        )
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Screen unread sales@hushline.app messages and send qualified lead briefs "
            "to glenn@hushline.app."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Assess without sending briefs or changing state.",
    )
    parser.add_argument("--state-file", type=Path, default=default_state_file())
    parser.add_argument("--max-messages", type=int, default=DEFAULT_MAX_MESSAGES)
    return parser.parse_args(argv)


def normalize_space(value: str, max_length: int = 500) -> str:
    cleaned = " ".join(value.replace("\x00", " ").split())
    if len(cleaned) <= max_length:
        return cleaned
    return cleaned[: max_length - 3].rstrip() + "..."


def parse_mail_records(raw_output: str) -> list[MailMessage]:
    messages: list[MailMessage] = []
    for raw_record in raw_output.split(RECORD_SEPARATOR):
        if not raw_record.strip():
            continue
        fields = raw_record.split(FIELD_SEPARATOR)
        if len(fields) != MAIL_RECORD_FIELD_COUNT:
            raise SalesLeadAgentError("Mail.app returned an invalid message record")
        try:
            local_id = int(fields[0])
        except ValueError as exc:
            raise SalesLeadAgentError("Mail.app returned an invalid local message ID") from exc
        messages.append(
            MailMessage(
                local_id=local_id,
                message_id=normalize_space(fields[1], 500),
                sender=normalize_space(fields[2], 500),
                subject=normalize_space(fields[3], 500),
                received_at=normalize_space(fields[4], 200),
                content=fields[5][:MAX_MESSAGE_CONTENT_CHARS],
                raw_headers=fields[6][:MAX_MESSAGE_CONTENT_CHARS],
            )
        )
    return messages


def fetch_unread_messages(max_messages: int) -> list[MailMessage]:
    if max_messages < 1 or max_messages > MAX_MESSAGES:
        raise SalesLeadAgentError(f"--max-messages must be between 1 and {MAX_MESSAGES}")
    command = [
        "/usr/bin/osascript",
        "-",
        SALES_ACCOUNT,
        str(max_messages),
        str(MAX_MESSAGE_CONTENT_CHARS),
    ]
    try:
        result = subprocess.run(  # noqa: S603 - fixed osascript command and trusted arguments.
            command,
            input=MAIL_APP_UNREAD_APPLESCRIPT,
            text=True,
            capture_output=True,
            check=False,
            timeout=OSASCRIPT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise SalesLeadAgentError("Timed out while reading the sales mailbox") from exc
    if result.returncode != 0:
        detail = normalize_space(result.stderr, 300)
        raise SalesLeadAgentError(f"Mail.app inbox read failed: {detail or 'unknown error'}")
    return parse_mail_records(result.stdout)


def extract_email(sender: str) -> str:
    matches = EMAIL_RE.findall(sender)
    return matches[-1].lower() if matches else "Not stated"


def validate_email_address(address: str) -> bool:
    if address == "Not stated" or len(address) > MAX_EMAIL_ADDRESS_CHARS or address.count("@") != 1:
        return False
    local_part, domain = address.rsplit("@", 1)
    if (
        not local_part
        or len(local_part) > MAX_EMAIL_LOCAL_PART_CHARS
        or local_part.startswith(".")
        or local_part.endswith(".")
        or ".." in local_part
        or not domain
        or domain.startswith("[")
    ):
        return False
    try:
        ascii_domain = domain.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    if len(ascii_domain) > MAX_EMAIL_DOMAIN_CHARS or "." not in ascii_domain:
        return False
    return all(
        label
        and len(label) <= MAX_EMAIL_DOMAIN_LABEL_CHARS
        and not label.startswith("-")
        and not label.endswith("-")
        and re.fullmatch(r"[A-Z0-9-]+", label, re.IGNORECASE)
        for label in ascii_domain.split(".")
    )


def email_domain(address: str) -> str:
    return address.rsplit("@", 1)[1].lower() if validate_email_address(address) else ""


def domains_align(first: str, second: str) -> bool:
    first = first.lower().strip(".")
    second = second.lower().strip(".")
    return bool(
        first
        and second
        and (first == second or first.endswith(f".{second}") or second.endswith(f".{first}"))
    )


def header_addresses(raw_headers: str, header_name: str) -> list[tuple[str, str]]:
    if not raw_headers:
        return []
    parsed = Parser(policy=policy.default).parsestr(raw_headers, headersonly=True)
    values = [str(value) for value in parsed.get_all(header_name, [])]
    return [(name, address.lower()) for name, address in getaddresses(values) if address]


def authentication_result(raw_headers: str, method: str) -> str:
    if not raw_headers:
        return "unavailable"
    parsed = Parser(policy=policy.default).parsestr(raw_headers, headersonly=True)
    authentication_headers = parsed.get_all("Authentication-Results", [])
    if not authentication_headers:
        if method == "spf":
            received_spf = " ".join(str(value) for value in parsed.get_all("Received-SPF", []))
            match = re.search(
                r"^\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b",
                received_spf,
                re.IGNORECASE,
            )
            return match.group(1).lower() if match else "unavailable"
        return "unavailable"
    trusted_edge_result = str(authentication_headers[0])
    match = re.search(
        rf"\b{re.escape(method)}\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b",
        trusted_edge_result,
        re.IGNORECASE,
    )
    return match.group(1).lower() if match else "unavailable"


def suspicious_link_flags(message: MailMessage, sender_domain: str) -> tuple[list[str], bool]:
    flags: list[str] = []
    high_risk = False
    urls = re.findall(r"https?://[^\s<>\"')]+", message.content, re.IGNORECASE)
    link_domains: set[str] = set()
    shorteners = {"bit.ly", "buff.ly", "cutt.ly", "is.gd", "tinyurl.com", "t.co"}
    for url in urls:
        host = (urlparse(url).hostname or "").lower().strip(".")
        if not host:
            continue
        link_domains.add(host)
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            flags.append("Message contains a link to an IP address")
            high_risk = True
        if host in shorteners:
            flags.append(f"Message uses URL shortener {host}")
    if len(link_domains) > MAX_LINK_DOMAINS_BEFORE_WARNING:
        flags.append("Message links to more than four distinct domains")
    if (
        sender_domain
        and link_domains
        and not any(domains_align(sender_domain, domain) for domain in link_domains)
    ):
        flags.append("No web link aligns with the sender domain")
    return flags, high_risk


def extract_claimed_person(content: str) -> str:
    explicit = re.search(r"(?im)^\s*(?:name|full name)\s*:\s*(.{2,100})$", content)
    if explicit:
        return normalize_space(explicit.group(1), 100).rstrip(".,;:")

    introduction = re.search(
        r"(?i)\b(?:my name is|I(?:'|’)m|I am)\s+"
        r"([A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,3})"
        r"(?=\s*(?:,|\.|\n|\s+(?:at|from|with|and)\b))",
        content,
        re.IGNORECASE,
    )
    if introduction:
        return normalize_space(introduction.group(1), 100).rstrip(".,;:")

    raw_lines = [line.strip() for line in content.splitlines()]
    signoffs = {
        "best",
        "best regards",
        "kind regards",
        "regards",
        "sincerely",
        "thanks",
        "thank you",
    }
    for index, line in enumerate(raw_lines[:-1]):
        if line.lower().rstrip(",.!:") not in signoffs:
            continue
        for raw_candidate in raw_lines[index + 1 :]:
            candidate = normalize_space(raw_candidate, 100).strip(" ,.;:")
            if not candidate:
                continue
            if (
                not EMAIL_RE.search(candidate)
                and 1 <= len(candidate.split()) <= MAX_CLAIMED_NAME_WORDS
                and re.fullmatch(
                    r"[A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,3}", candidate, re.IGNORECASE
                )
            ):
                return candidate
            break
    return "Not stated"


def normalized_name_tokens(value: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    tokens = tuple(re.findall(r"[a-z]+", normalized.casefold()))
    honorifics = {"dr", "miss", "mr", "mrs", "ms", "prof"}
    return tuple(token for token in tokens if token not in honorifics)


def names_are_consistent(sender_name: str, claimed_name: str) -> bool:
    sender_tokens = normalized_name_tokens(sender_name)
    claimed_tokens = normalized_name_tokens(claimed_name)
    if not sender_tokens or not claimed_tokens:
        return False
    return (
        sender_tokens == claimed_tokens
        or set(sender_tokens).issubset(claimed_tokens)
        or set(claimed_tokens).issubset(sender_tokens)
    )


def exact_person_name_match(first: str, second: str) -> bool:
    first_tokens = normalized_name_tokens(first)
    second_tokens = normalized_name_tokens(second)
    return bool(first_tokens and first_tokens == second_tokens)


def organizations_are_consistent(first: str, second: str) -> bool:
    ignored = {
        "company",
        "corp",
        "corporation",
        "inc",
        "limited",
        "llc",
        "ltd",
        "organization",
        "organisation",
    }

    def tokens(value: str) -> set[str]:
        return {
            token for token in re.findall(r"[a-z0-9]+", value.casefold()) if token not in ignored
        }

    first_tokens = tokens(first)
    second_tokens = tokens(second)
    return bool(
        first_tokens
        and second_tokens
        and (first_tokens.issubset(second_tokens) or second_tokens.issubset(first_tokens))
    )


def normalize_linkedin_profile_url(value: str) -> str | None:
    candidate = value.strip().rstrip(".,;:)>]}")
    try:
        parsed = urllib.parse.urlparse(candidate)
    except ValueError:
        return None
    host = (parsed.hostname or "").casefold().rstrip(".")
    if parsed.scheme.casefold() != "https" or host not in {"linkedin.com", "www.linkedin.com"}:
        return None
    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/")
    if not re.fullmatch(r"/in/[A-Z0-9._~%-]+", path, re.IGNORECASE):
        return None
    return urllib.parse.urlunparse(("https", "www.linkedin.com", path, "", "", ""))


def linkedin_profile_urls(value: str) -> tuple[str, ...]:
    candidates = re.findall(r"https://(?:www\.)?linkedin\.com/in/[^\s<>\"']+", value, re.I)
    normalized = (normalize_linkedin_profile_url(candidate) for candidate in candidates)
    return tuple(dict.fromkeys(url for url in normalized if url is not None))


def normalized_domain_host(value: str) -> str:
    return value.strip().rstrip(".").casefold().removeprefix("www.")


def url_host_allowed(url: str, allowed_domain: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = normalized_domain_host(parsed.hostname)
    domain = normalized_domain_host(allowed_domain)
    return host == domain or host.endswith(f".{domain}")


def host_resolves_to_public_addresses(host: str) -> bool:
    try:
        address_infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = {info[4][0] for info in address_infos}
    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(address).is_global for address in addresses)
    except ValueError:
        return False


def safe_public_company_url(url: str, allowed_domain: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return bool(
        parsed.hostname
        and url_host_allowed(url, allowed_domain)
        and host_resolves_to_public_addresses(parsed.hostname)
    )


class SameDomainPublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_domain: str) -> None:
        self.allowed_domain = allowed_domain
        super().__init__()

    def redirect_request(  # noqa: PLR0913 - urllib redirect hook signature.
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        if not safe_public_company_url(newurl, self.allowed_domain):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_company_research_pages(
    domain: str, *, timeout_seconds: float
) -> tuple[tuple[str, str], ...]:
    pages: list[tuple[str, str]] = []
    opener = urllib.request.build_opener(SameDomainPublicRedirectHandler(domain))
    for path in COMPANY_RESEARCH_PATHS:
        url = urllib.parse.urljoin(f"https://{domain}/", path)
        if not safe_public_company_url(url, domain):
            break
        request = urllib.request.Request(  # noqa: S310 - URL is restricted and validated.
            url,
            headers={"User-Agent": RESEARCH_USER_AGENT},
        )
        try:
            with opener.open(request, timeout=timeout_seconds) as response:
                final_url = response.geturl()
                content_type = response.headers.get("content-type", "")
                if (
                    not safe_public_company_url(final_url, domain)
                    or "text/html" not in content_type.casefold()
                ):
                    continue
                raw_html = response.read(MAX_RESEARCH_PAGE_BYTES).decode("utf-8", errors="replace")
        except OSError:
            continue
        pages.append((final_url, raw_html))
    return tuple(pages)


def json_objects(value: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    pending = [value]
    while pending and len(objects) < MAX_STRUCTURED_DATA_OBJECTS:
        item = pending.pop()
        if isinstance(item, dict):
            objects.append(item)
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return objects


def structured_name(value: Any) -> str:
    if isinstance(value, str):
        return normalize_space(value, 160)
    if isinstance(value, dict) and isinstance(value.get("name"), str):
        return normalize_space(value["name"], 160)
    return ""


def structured_person_matches(page_html: str, person: str) -> list[tuple[str, str, str]]:
    parser = StructuredIdentityParser()
    parser.feed(page_html)
    matches: list[tuple[str, str, str]] = []
    for raw_json in parser.json_ld:
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        for item in json_objects(payload):
            item_types = item.get("@type", [])
            if isinstance(item_types, str):
                item_types = [item_types]
            if not any(str(item_type).casefold() == "person" for item_type in item_types):
                continue
            name = structured_name(item.get("name"))
            if not exact_person_name_match(person, name):
                continue
            same_as = item.get("sameAs", [])
            if isinstance(same_as, str):
                same_as = [same_as]
            profile_urls = tuple(
                dict.fromkeys(
                    profile_url
                    for value in same_as
                    if isinstance(value, str)
                    if (profile_url := normalize_linkedin_profile_url(value)) is not None
                )
            )
            if len(profile_urls) != 1:
                continue
            role = structured_name(item.get("jobTitle"))
            company = structured_name(item.get("worksFor"))
            matches.append((profile_urls[0], role, company))
    return matches


def unconfirmed_identity(reason: str) -> IdentityResearch:
    return IdentityResearch(
        status="Not confirmed",
        profile_url="Not included",
        role="Not independently corroborated",
        company="Not independently corroborated",
        evidence=(reason, "Do not use LinkedIn for outreach until a human confirms the profile."),
        sources=(),
    )


def identity_research_enabled() -> bool:
    value = os.environ.get(IDENTITY_RESEARCH_ENV)
    return value is None or value.strip().casefold() in {"1", "true", "yes", "on"}


def research_identity(
    message: MailMessage,
    assessment: LeadAssessment,
    *,
    timeout_seconds: float = IDENTITY_RESEARCH_TIMEOUT_SECONDS,
) -> IdentityResearch:
    if not identity_research_enabled():
        return unconfirmed_identity("Identity research is disabled by local configuration.")
    if assessment.person == "Not stated":
        return unconfirmed_identity("The sender's personal identity is not stated clearly.")

    supplied_profiles = linkedin_profile_urls(message.content)
    identity_matches = assessment.security.identity_consistency.startswith("Pass")
    company_matches = assessment.security.affiliation_validation.startswith("Pass")
    authentication_passes = "DMARC pass" in assessment.security.authentication and (
        "DKIM pass" in assessment.security.authentication
        or "SPF pass" in assessment.security.authentication
    )
    if len(supplied_profiles) > 1:
        return unconfirmed_identity("The message supplies multiple LinkedIn profile URLs.")
    if supplied_profiles:
        if not (identity_matches and company_matches and authentication_passes):
            return unconfirmed_identity(
                "A LinkedIn URL was supplied, but sender identity, company alignment, and "
                "email authentication did not all pass."
            )
        return IdentityResearch(
            status="Confirmed from authenticated sender evidence",
            profile_url=supplied_profiles[0],
            role=f"Claimed in authenticated message — {assessment.role}",
            company=f"Domain-aligned claim — {assessment.company}",
            evidence=(
                "The sender supplied exactly one LinkedIn profile URL in the original message.",
                "The From identity matches the identity claimed in the message.",
                (
                    "The sender domain aligns with the claimed company and DMARC "
                    "authentication passed."
                ),
            ),
            sources=("Original authenticated email",),
        )

    sender_domain = email_domain(assessment.email)
    if (
        not sender_domain
        or sender_domain in PERSONAL_EMAIL_DOMAINS
        or not company_matches
        or not authentication_passes
    ):
        return unconfirmed_identity(
            "The sender domain cannot support strong official-company identity confirmation."
        )

    discovered: dict[str, tuple[str, str, set[str]]] = {}
    for source_url, page_html in fetch_company_research_pages(
        sender_domain, timeout_seconds=timeout_seconds
    ):
        for profile_url, role, company in structured_person_matches(page_html, assessment.person):
            if company and not organizations_are_consistent(company, assessment.company):
                continue
            current_role, current_company, sources = discovered.get(
                profile_url, (role, company, set())
            )
            sources.add(source_url)
            discovered[profile_url] = (current_role or role, current_company or company, sources)
    if len(discovered) != 1:
        reason = (
            "Official company pages yielded multiple possible LinkedIn profiles."
            if discovered
            else "No exact-name LinkedIn profile was published in official company structured data."
        )
        return unconfirmed_identity(reason)

    profile_url, (role, company, source_urls) = next(iter(discovered.items()))
    corroborated_role = role or "Not stated by official source"
    corroborated_company = company or assessment.company
    return IdentityResearch(
        status="Confirmed from official company evidence",
        profile_url=profile_url,
        role=corroborated_role,
        company=corroborated_company,
        evidence=(
            f"Official company structured data names {assessment.person}.",
            "That same structured Person record publishes exactly one LinkedIn profile URL.",
            f"Official role: {corroborated_role}; official company: {corroborated_company}.",
        ),
        sources=tuple(sorted(source_urls)),
    )


def company_matches_sender_domain(company: str, sender_domain: str) -> bool:
    if not company or company.startswith("Not stated") or not sender_domain:
        return False
    domain_text = re.sub(r"[^a-z0-9]", "", sender_domain.casefold())
    ignored_tokens = {
        "agency",
        "association",
        "company",
        "corp",
        "corporation",
        "foundation",
        "group",
        "inc",
        "limited",
        "llc",
        "ltd",
        "organization",
        "organisation",
    }
    company_tokens = [
        token
        for token in re.findall(r"[a-z0-9]+", company.casefold())
        if token not in ignored_tokens and len(token) >= MIN_COMPANY_DOMAIN_TOKEN_CHARS
    ]
    return any(token in domain_text for token in company_tokens)


def assess_message_security(message: MailMessage) -> SecurityAssessment:
    flags: list[str] = []
    high_risk = False
    mail_sender = extract_email(message.sender)
    sender_domain = email_domain(mail_sender)
    from_addresses = header_addresses(message.raw_headers, "from")
    sender_identity = extract_person(message.sender)
    claimed_identity = extract_claimed_person(message.content)
    claimed_company = extract_company(message)

    if not validate_email_address(mail_sender):
        sender_validation = "Fail — Mail sender address is missing or invalid"
        flags.append("Invalid Mail sender address")
        high_risk = True
    elif len(from_addresses) != 1 or not validate_email_address(from_addresses[0][1]):
        sender_validation = "Fail — RFC From header is missing, ambiguous, or invalid"
        flags.append("Invalid or ambiguous RFC From header")
        high_risk = True
    elif mail_sender != from_addresses[0][1]:
        sender_validation = "Fail — Mail sender and RFC From address do not match"
        flags.append("Mail sender and RFC From mismatch")
        high_risk = True
    else:
        sender_validation = "Pass — sender syntax and RFC From address agree"

    display_name = parseaddr(message.sender)[0].lower()
    if sender_domain != "hushline.app" and any(
        marker in display_name for marker in ("hush line", "hushline", "glenn hebert")
    ):
        flags.append("External sender display name may impersonate Hush Line staff")
        high_risk = True
    if sender_domain and sender_domain != "hushline.app" and "hushline" in sender_domain:
        flags.append("Sender domain resembles hushline.app")
        high_risk = True
    if sender_domain.startswith("xn--") or ".xn--" in sender_domain:
        flags.append("Sender uses an internationalized punycode domain")

    if claimed_identity == "Not stated":
        identity_consistency = "Not assessable — no personal identity is claimed in the message"
    elif sender_identity == "Not stated":
        identity_consistency = (
            "Review — claimed identity cannot be compared with the sender identity"
        )
        flags.append("Claimed personal identity cannot be matched to the sender")
    elif names_are_consistent(sender_identity, claimed_identity):
        identity_consistency = "Pass — sender and claimed personal identities are consistent"
    else:
        identity_consistency = (
            f"Fail — sender identity {sender_identity} differs from "
            f"claimed identity {claimed_identity}"
        )
        flags.append("Sender identity conflicts with the identity claimed in the message")
        high_risk = True

    if claimed_company.startswith("Not stated"):
        affiliation_validation = "Not assessable — no company affiliation is claimed"
    elif sender_domain in PERSONAL_EMAIL_DOMAINS:
        affiliation_validation = (
            f"Unverified — {claimed_company} is claimed from personal email domain {sender_domain}"
        )
        flags.append("Claimed company affiliation is not supported by the personal sender domain")
    elif company_matches_sender_domain(claimed_company, sender_domain):
        affiliation_validation = "Pass — claimed company is consistent with the sender domain"
    else:
        affiliation_validation = (
            f"Review — claimed company {claimed_company} does not align with {sender_domain}"
        )
        flags.append("Claimed company affiliation does not align with the sender domain")

    spf = authentication_result(message.raw_headers, "spf")
    dkim = authentication_result(message.raw_headers, "dkim")
    dmarc = authentication_result(message.raw_headers, "dmarc")
    authentication = f"SPF {spf}; DKIM {dkim}; DMARC {dmarc}"
    if dmarc == "fail" or (spf in {"fail", "softfail"} and dkim == "fail"):
        flags.append("Sender authentication failed")
        high_risk = True
    elif all(result == "unavailable" for result in (spf, dkim, dmarc)):
        flags.append("Sender authentication results are unavailable")
    elif dmarc != "pass":
        flags.append("DMARC did not produce a pass result")

    reply_to = header_addresses(message.raw_headers, "reply-to")
    return_path = header_addresses(message.raw_headers, "return-path")
    alignment_notes: list[str] = []
    if reply_to:
        reply_domain = email_domain(reply_to[0][1])
        if not domains_align(sender_domain, reply_domain):
            flags.append("Reply-To domain differs from the sender domain")
            alignment_notes.append("Reply-To mismatch")
    if return_path:
        return_domain = email_domain(return_path[0][1])
        if not domains_align(sender_domain, return_domain):
            flags.append("Return-Path domain differs from the sender domain")
            alignment_notes.append("Return-Path mismatch")
    header_alignment = ", ".join(alignment_notes) if alignment_notes else "No mismatch detected"

    link_flags, link_high_risk = suspicious_link_flags(message, sender_domain)
    flags.extend(link_flags)
    high_risk = high_risk or link_high_risk
    haystack = message_haystack(message)
    if re.search(
        r"\b(wire transfer|bank account|gift cards?|cryptocurrency|bitcoin)\b", haystack
    ) and re.search(
        r"\b(urgent(?:ly)?|immediately|today|secret|confidential|do not tell|bypass)\b",
        haystack,
    ):
        flags.append("Urgent or secret payment request")
        high_risk = True
    if re.search(
        r"\b(password|credentials?|sign in|log in|verify your account)\b", haystack
    ) and re.search(r"https?://", message.content, re.IGNORECASE):
        flags.append("Credential request includes an external link")
        high_risk = True

    unique_flags = tuple(dict.fromkeys(flags))
    if high_risk:
        risk = "High"
    elif unique_flags:
        risk = "Review"
    else:
        risk = "Low"
    return SecurityAssessment(
        risk=risk,
        sender_validation=sender_validation,
        authentication=authentication,
        header_alignment=header_alignment,
        identity_consistency=identity_consistency,
        affiliation_validation=affiliation_validation,
        flags=unique_flags,
    )


def extract_person(sender: str) -> str:
    email = extract_email(sender)
    display = sender
    if email != "Not stated":
        display = re.sub(rf"\s*<?{re.escape(email)}>?\s*", "", sender, flags=re.IGNORECASE)
    display = display.strip(" \t\"'<>")
    if display and display.lower() != email.lower():
        return normalize_space(display, 120)
    if email != "Not stated":
        local_part = email.split("@", 1)[0]
        if not re.fullmatch(r"[a-z]+[._-][a-z]+", local_part, re.IGNORECASE):
            return "Not stated"
        return " ".join(part.capitalize() for part in re.split(r"[._-]", local_part))
    return "Not stated"


def signature_lines(content: str) -> list[str]:
    lines = [normalize_space(line, 160) for line in content.splitlines()]
    return [line for line in lines if line][-12:]


def extract_company(message: MailMessage) -> str:
    content = message.content
    explicit_patterns = (
        r"(?im)^\s*(?:company|organization|organisation|employer)\s*:\s*(.{2,120})$",
        r"(?i)\b(?:I work (?:at|for)|I(?:'m| am) with|we(?:'re| are) (?:from|at))\s+"
        r"([A-Z][\w&.' -]{1,100})",
    )
    for pattern in explicit_patterns:
        match = re.search(pattern, content)
        if match:
            candidate = normalize_space(match.group(1), 120).rstrip(".,;:")
            candidate = re.split(r"\s+(?:and|because|regarding|about)\s+", candidate, maxsplit=1)[0]
            if candidate:
                return candidate

    lines = signature_lines(content)
    company_suffix = re.compile(
        r"\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|company|group|foundation|"
        r"university|college|school|agency|association|organization|organisation)\b",
        re.IGNORECASE,
    )
    for line in reversed(lines):
        looks_like_sentence = re.search(
            r"\b(we|our|need|looking|evaluating|interested|would|could|should)\b",
            line,
            re.IGNORECASE,
        )
        if (
            company_suffix.search(line)
            and not EMAIL_RE.search(line)
            and len(line.split()) <= MAX_COMPANY_SIGNATURE_WORDS
            and not looks_like_sentence
        ):
            return line

    email = extract_email(message.sender)
    if email == "Not stated":
        return "Not stated"
    domain = email.rsplit("@", 1)[1].lower()
    if domain in PERSONAL_EMAIL_DOMAINS:
        return "Not stated"
    return f"Not stated (sender domain: {domain})"


def extract_role(message: MailMessage) -> str:
    explicit = re.search(
        r"(?im)^\s*(?:title|role|job title)\s*:\s*(.{2,120})$",
        message.content,
    )
    if explicit:
        return normalize_space(explicit.group(1), 120).rstrip(".,;:")

    introduction = re.search(
        r"(?i)\bI(?:'m| am)\s+[^,\n]{2,100},\s*(?:the\s+)?"
        r"([^\n.]{2,100}?)(?:\s+(?:at|for|with)\s+[^\n.]+|[.\n])",
        message.content,
    )
    if introduction:
        return normalize_space(introduction.group(1), 120).rstrip(".,;:")

    role_terms = re.compile(
        r"\b(chief|officer|director|manager|lead|head|vice president|vp|president|"
        r"counsel|attorney|founder|owner|partner|executive|compliance|ethics|"
        r"procurement|security|operations|people|human resources|hr)\b",
        re.IGNORECASE,
    )
    company_suffix = re.compile(
        r"\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|company|group|foundation|"
        r"university|college|school|agency|association|organization|organisation)\b",
        re.IGNORECASE,
    )
    for line in signature_lines(message.content):
        if (
            role_terms.search(line)
            and not company_suffix.search(line)
            and not EMAIL_RE.search(line)
        ):
            return line
    return "Not stated"


def extract_scale(content: str) -> str:
    matches = re.findall(
        r"\b(?:approximately|about|around|roughly|over|more than|up to)?\s*"
        r"(\d[\d,]*)\s+(employees|staff|users|people|members|locations|offices|countries)\b",
        content,
        re.IGNORECASE,
    )
    if not matches:
        return "Not stated"
    unique_matches = dict.fromkeys(f"{quantity} {unit.lower()}" for quantity, unit in matches)
    return ", ".join(unique_matches)


def message_haystack(message: MailMessage) -> str:
    combined = f"{message.subject}\n{message.content}"
    return normalize_space(combined, MAX_MESSAGE_CONTENT_CHARS).lower()


def sender_is_automated(message: MailMessage) -> bool:
    email = extract_email(message.sender)
    if email == "Not stated":
        return False
    if email in {SALES_ACCOUNT, BRIEF_RECIPIENT}:
        return True
    local_part = email.split("@", 1)[0].lower()
    return local_part in AUTOMATED_LOCAL_PARTS


def detected_need_labels(haystack: str) -> list[str]:
    return [label for pattern, label in USE_CASE_PATTERNS if re.search(pattern, haystack)]


def relevant_sentence(message: MailMessage) -> str:
    text = re.sub(r"(?im)^>.*$", "", message.content)
    text = re.split(r"(?im)^-{2,}\s*(?:original message|forwarded message)", text, maxsplit=1)[0]
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text)
    patterns = [pattern for pattern, _, _ in SALES_INTENT_PATTERNS]
    patterns.extend(pattern for pattern, _ in USE_CASE_PATTERNS)
    for sentence in sentences:
        cleaned = normalize_space(sentence, 320).strip(" -")
        if len(cleaned) < MIN_RELEVANT_SENTENCE_CHARS:
            continue
        if any(re.search(pattern, cleaned, re.IGNORECASE) for pattern in patterns):
            cleaned = re.sub(r"^(?:hello|hi|dear)\b[^,]*,?\s*", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(
                r"^(?:we|i)\s+(?:are|'re|am|'m)\s+(?:interested in|looking for|evaluating)\s+",
                "Seeking ",
                cleaned,
                flags=re.IGNORECASE,
            )
            cleaned = re.sub(r"^we\s+need\s+", "Needs ", cleaned, flags=re.IGNORECASE)
            return cleaned or "See the original message for the stated need."
    if message.subject:
        return f"Inquiry regarding: {normalize_space(message.subject, 240)}"
    return "The specific need is not stated clearly."


def urgency_summary(haystack: str) -> str:
    if re.search(r"\b(asap|urgent(?:ly)?|immediately|right away|time[- ]sensitive)\b", haystack):
        return "High — the sender explicitly indicates urgency."
    if re.search(r"\b(today|tomorrow|this week|within \d+ (?:day|week)s?)\b", haystack):
        return "Near-term — the sender gives a short response or delivery window."
    deadline = re.search(
        r"\b(?:by|before|deadline(?: is| of)?|launch(?:ing)? in)\s+"
        r"((?:january|february|march|april|may|june|july|august|september|october|"
        r"november|december)(?:\s+\d{1,2})?(?:,?\s+\d{4})?|q[1-4](?:\s+\d{4})?|"
        r"\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b",
        haystack,
        re.IGNORECASE,
    )
    if deadline:
        return f"Time-bound — target or deadline: {normalize_space(deadline.group(1), 60)}."
    return "Not stated."


def build_open_questions(
    message: MailMessage, *, role: str, company: str, scale: str
) -> tuple[str, ...]:
    haystack = message_haystack(message)
    questions: list[str] = []
    if role == "Not stated":
        questions.append("What is the sender's role in evaluation and approval?")
    if company.startswith("Not stated"):
        questions.append("What is the legal organization name and primary operating region?")
    if scale == "Not stated":
        questions.append("How many employees, recipients, or reporting channels are in scope?")
    if not re.search(
        r"\b(current|existing|today|currently|replace|vendor|system|process)\b", haystack
    ):
        questions.append("What reporting process or vendor do they use today?")
    if not re.search(
        r"\b(decision|approv|stakeholder|buyer|procurement|legal|security review)\b", haystack
    ):
        questions.append("Who are the decision-makers and required reviewers?")
    if not re.search(r"\b(budget|price range|allocated|funding)\b", haystack):
        questions.append("What budget and procurement constraints apply?")
    if not re.search(
        r"\b(host|deploy|integration|sso|security requirement|data residency)\b", haystack
    ):
        questions.append("Are there deployment, integration, or security requirements?")
    return tuple(questions[:MAX_OPEN_QUESTIONS])


def build_next_steps(
    *, urgency: str, use_cases: tuple[str, ...], scale: str, open_questions: tuple[str, ...]
) -> tuple[str, ...]:
    if urgency.startswith(("High", "Near-term")):
        response_window = "Respond the same business day."
    elif urgency.startswith("Time-bound"):
        response_window = "Respond within one business day and confirm the target date."
    else:
        response_window = "Respond within two business days."
    focus = ", ".join(use_cases) if use_cases else "their stated reporting workflow"
    steps = [
        response_window,
        f"Offer a 30-minute discovery and product walkthrough focused on {focus}.",
    ]
    if scale != "Not stated":
        steps.append(f"Validate the stated scale ({scale}) and expected account structure.")
    if open_questions:
        steps.append(
            "Use discovery to resolve the open questions, starting with current process, "
            "decision-makers, timeline, and procurement/security requirements."
        )
    steps.append("Avoid making compliance, legal, security, or delivery commitments before review.")
    return tuple(steps)


def build_suggested_follow_up(  # noqa: PLR0913 - explicit inputs keep the draft deterministic.
    *,
    person: str,
    company: str,
    use_cases: tuple[str, ...],
    scale: str,
    urgency: str,
    open_questions: tuple[str, ...],
) -> tuple[str, str]:
    company_name = company if not company.startswith("Not stated") else "your organization"
    if company_name == "your organization":
        subject = "Next steps for your Hush Line inquiry"
    else:
        subject = f"Next steps for {company_name}'s Hush Line evaluation"

    greeting_name = person.split(maxsplit=1)[0] if person != "Not stated" else "there"
    use_case_text = ", ".join(use_cases[:2]) if use_cases else "your reporting workflow"
    opportunity_details = f"your interest in {use_case_text}"
    if scale != "Not stated":
        opportunity_details += f" for {scale}"

    lines = [
        f"Hi {greeting_name},",
        "",
        "Thank you for reaching out about Hush Line.",
        (
            f"Based on what you shared, I would be glad to learn more about "
            f"{company_name}'s needs and {opportunity_details}."
        ),
    ]
    if urgency != "Not stated.":
        lines.extend(("", f"I also noted your timing: {urgency}"))
    lines.extend(
        (
            "",
            (
                "Would you be open to a 30-minute discovery call and product walkthrough? "
                "We can cover your current process, required stakeholders, security and "
                "procurement needs, and implementation timeline."
            ),
        )
    )
    if open_questions:
        lines.extend(("", "Before or during the call, it would help to clarify:"))
        lines.extend(f"- {question}" for question in open_questions[:3])
    lines.extend(
        (
            "",
            "Please send a few times that work for your team.",
            "",
            "Best,",
            "Glenn",
        )
    )
    return subject, "\n".join(lines)


def assess_lead(message: MailMessage) -> LeadAssessment:
    haystack = message_haystack(message)
    security = assess_message_security(message)
    score = 0
    reasons: list[str] = []
    exclusion_detected = False

    for pattern, weight, reason in SALES_INTENT_PATTERNS:
        if re.search(pattern, haystack):
            score += weight
            reasons.append(reason)
    need_labels = detected_need_labels(haystack)
    if need_labels:
        score += 3
        reasons.append(need_labels[0])
    for pattern, weight, reason in EXCLUSION_PATTERNS:
        if re.search(pattern, haystack):
            score += weight
            reasons.append(reason)
            exclusion_detected = True
    if re.search(r"\b(we|our|team|employees|staff|organization|company|client)\b", haystack):
        score += 1
        reasons.append("organizational context")
    if urgency_summary(haystack) != "Not stated.":
        score += 1
        reasons.append("stated timeline")
    if sender_is_automated(message):
        score -= 10
        reasons.append("automated or internal sender")

    qualified = (
        score >= QUALIFIED_SCORE
        and bool(need_labels)
        and not exclusion_detected
        and security.risk != "High"
    )
    if qualified and score >= HIGH_CONFIDENCE_SCORE:
        confidence = "High"
    elif qualified:
        confidence = "Medium"
    else:
        confidence = "Low"

    unique_reasons = tuple(dict.fromkeys(reasons))
    use_cases = tuple(dict.fromkeys(need_labels))
    role = extract_role(message)
    company = extract_company(message)
    scale = extract_scale(message.content)
    urgency = urgency_summary(haystack)
    open_questions = build_open_questions(
        message,
        role=role,
        company=company,
        scale=scale,
    )
    follow_up_subject, follow_up_body = build_suggested_follow_up(
        person=extract_person(message.sender),
        company=company,
        use_cases=use_cases,
        scale=scale,
        urgency=urgency,
        open_questions=open_questions,
    )
    return LeadAssessment(
        qualified=qualified,
        score=score,
        person=extract_person(message.sender),
        claimed_person=extract_claimed_person(message.content),
        role=role,
        email=extract_email(message.sender),
        company=company,
        need=relevant_sentence(message),
        use_cases=use_cases,
        scale=scale,
        urgency=urgency,
        confidence=confidence,
        reasons=unique_reasons,
        open_questions=open_questions,
        next_steps=build_next_steps(
            urgency=urgency,
            use_cases=use_cases,
            scale=scale,
            open_questions=open_questions,
        ),
        suggested_follow_up_subject=follow_up_subject,
        suggested_follow_up_body=follow_up_body,
        security=security,
        identity_research=unconfirmed_identity(
            "Identity research runs only after the message qualifies as a lead."
        ),
    )


def build_executive_summary(assessment: LeadAssessment) -> str:
    reasons = ", ".join(assessment.reasons) if assessment.reasons else "limited evidence"
    use_cases = ", ".join(assessment.use_cases) if assessment.use_cases else "Not stated"
    lines = [
        "Executive summary",
        "",
        "Customer",
        f"Sender identity: {assessment.person}",
        f"Claimed identity: {assessment.claimed_person}",
        f"Claimed role: {assessment.role}",
        f"Claimed company: {assessment.company}",
        f"Email: {assessment.email}",
        "",
        "LinkedIn identity verification",
        f"Status: {assessment.identity_research.status}",
        f"Profile: {assessment.identity_research.profile_url}",
        f"Research role: {assessment.identity_research.role}",
        f"Research company: {assessment.identity_research.company}",
        "Evidence:",
    ]
    lines.extend(f"- {item}" for item in assessment.identity_research.evidence)
    lines.append("Sources:")
    lines.extend(f"- {source}" for source in assessment.identity_research.sources)
    if not assessment.identity_research.sources:
        lines.append("- No independent source met the confirmation threshold.")
    lines.extend(
        (
            "",
            "Opportunity",
            f"Need: {assessment.need}",
            f"Use case: {use_cases}",
            f"Scale: {assessment.scale}",
            f"Urgency: {assessment.urgency}",
            "",
            "Qualification",
            f"Confidence: {assessment.confidence}",
            f"Buying signals: {reasons}",
            "",
            "Trust and fraud checks",
            f"Risk: {assessment.security.risk}",
            f"Sender validation: {assessment.security.sender_validation}",
            f"Authentication: {assessment.security.authentication}",
            f"Header alignment: {assessment.security.header_alignment}",
            f"Identity consistency: {assessment.security.identity_consistency}",
            f"Company affiliation: {assessment.security.affiliation_validation}",
            "Security flags:",
        )
    )
    lines.extend(f"- {flag}" for flag in assessment.security.flags)
    if not assessment.security.flags:
        lines.append("- No basic phishing or fraud indicators detected.")
    lines.extend(
        (
            "",
            "Open questions",
        )
    )
    lines.extend(f"- {question}" for question in assessment.open_questions)
    if not assessment.open_questions:
        lines.append("- No material gaps identified from the initial message.")
    lines.extend(("", "Recommended next steps"))
    lines.extend(f"{index}. {step}" for index, step in enumerate(assessment.next_steps, start=1))
    lines.extend(
        (
            "",
            "Suggested follow-up email (draft only — not sent)",
            f"Subject: {assessment.suggested_follow_up_subject}",
            "Body:",
            assessment.suggested_follow_up_body,
        )
    )
    return "\n".join(lines)


def message_fingerprint(message: MailMessage) -> str:
    stable_value = message.message_id or (
        f"{message.local_id}\0{message.sender}\0{message.subject}\0{message.received_at}"
    )
    return hashlib.sha256(stable_value.encode("utf-8", errors="replace")).hexdigest()


def load_state(path: Path) -> dict[str, Any]:
    if path.is_symlink() or path.parent.is_symlink():
        raise SalesLeadAgentError(f"Refusing to read symlinked state file: {path}")
    if not path.exists():
        return {"version": 1, "processed": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SalesLeadAgentError(f"Could not read state file: {path}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("processed"), list):
        raise SalesLeadAgentError(f"State file has an invalid format: {path}")
    return data


def save_state(path: Path, state: dict[str, Any]) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise SalesLeadAgentError(f"Refusing to replace symlinked state file: {path}")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    processed = state.get("processed", [])[-MAX_STATE_ENTRIES:]
    payload = {"version": 1, "processed": processed}
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def processed_fingerprints(state: dict[str, Any]) -> set[str]:
    return {
        entry["fingerprint"]
        for entry in state.get("processed", [])
        if isinstance(entry, dict) and isinstance(entry.get("fingerprint"), str)
    }


def record_processed(
    state: dict[str, Any],
    message: MailMessage,
    assessment: LeadAssessment,
) -> None:
    state.setdefault("processed", []).append(
        {
            "fingerprint": message_fingerprint(message),
            "decision": (
                "blocked_high_risk"
                if assessment.security.risk == "High"
                else "brief_sent"
                if assessment.qualified
                else "screened_out"
            ),
            "score": assessment.score,
            "processed_at": datetime.now(UTC).isoformat(),
        }
    )


def deliver_qualified_lead(message: MailMessage, summary: str) -> None:
    summary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", prefix="hushline-sales-summary-", delete=False
        ) as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(summary)
            summary_path = Path(handle.name)
        command = [
            "/usr/bin/osascript",
            "-",
            SALES_ACCOUNT,
            BRIEF_RECIPIENT,
            str(message.local_id),
            str(summary_path),
        ]
        try:
            result = subprocess.run(  # noqa: S603 - fixed osascript command and trusted arguments.
                command,
                input=MAIL_APP_DELIVER_LEAD_APPLESCRIPT,
                text=True,
                capture_output=True,
                check=False,
                timeout=OSASCRIPT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            print(
                "Warning: Mail.app lead handoff timed out; treating it as accepted to avoid "
                "a duplicate delivery.",
                file=sys.stderr,
            )
            return
        if result.returncode != 0 and APPLE_EVENT_TIMEOUT_CODE not in result.stderr:
            detail = normalize_space(result.stderr, 300)
            raise SalesLeadAgentError(
                f"Mail.app brief delivery failed: {detail or 'unknown error'}"
            )
        if result.returncode != 0:
            print(
                "Warning: Mail.app reported an AppleEvent timeout after the lead handoff; "
                "treating it as accepted to avoid a duplicate delivery.",
                file=sys.stderr,
            )
    finally:
        if summary_path is not None:
            summary_path.unlink(missing_ok=True)


def run(*, dry_run: bool, state_file: Path, max_messages: int) -> tuple[int, int, int, int]:
    messages = fetch_unread_messages(max_messages)
    state = load_state(state_file)
    already_processed = processed_fingerprints(state)
    reviewed = 0
    briefs_sent = 0
    screened_out = 0
    security_blocked = 0

    for message in messages:
        if message_fingerprint(message) in already_processed:
            continue
        assessment = assess_lead(message)
        reviewed += 1
        if assessment.security.risk == "High":
            security_blocked += 1
        elif assessment.qualified:
            assessment = replace(
                assessment,
                identity_research=research_identity(message, assessment),
            )
            briefs_sent += 1
            if not dry_run:
                deliver_qualified_lead(message, build_executive_summary(assessment))
        else:
            screened_out += 1
        if not dry_run:
            record_processed(state, message, assessment)
            save_state(state_file, state)
            already_processed.add(message_fingerprint(message))

    return reviewed, briefs_sent, screened_out, security_blocked


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        reviewed, briefs_sent, screened_out, security_blocked = run(
            dry_run=args.dry_run,
            state_file=args.state_file,
            max_messages=args.max_messages,
        )
    except SalesLeadAgentError as exc:
        print(f"sales-lead-agent: {exc}", file=sys.stderr)
        return 1
    action = "would_send" if args.dry_run else "sent"
    print(
        f"Sales inbox screening complete: reviewed={reviewed}, briefs_{action}={briefs_sent}, "
        f"screened_out={screened_out}, security_blocked={security_blocked}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
