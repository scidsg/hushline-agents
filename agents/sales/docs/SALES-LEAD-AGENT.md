# Sales Lead Agent

The sales lead agent screens unread messages in the local macOS Mail account
`sales@hushline.app`. For each qualified lead, it forwards the original message to
`glenn@hushline.app` with an executive summary prepended. It does not reply to the sender.

## Lead brief

Each qualified lead produces one native Mail forward. The agent prepends its plain-text
executive summary to the forward while preserving the original email and attachments
below it. The summary includes:

- the From/display identity separately from the personal identity claimed in the body or
  signature, plus any claimed role and email address;
- the claimed company, using an explicit statement or signature first and otherwise
  listing the sender domain as context without inventing a company name;
- a LinkedIn identity-verification section that includes a profile URL only when strong,
  auditable evidence ties that exact URL to the sender;
- the stated need, use case, and organizational scale;
- explicit urgency or deadline information;
- qualification confidence, buying signals, and evidence used;
- sender-address validation, SPF/DKIM/DMARC results, header alignment, and phishing or
  fraud warnings;
- material information gaps and discovery questions;
- prioritized next steps, including response timing and discovery focus.
- a suggested follow-up email subject and body tailored to the initial inquiry.

The suggested follow-up is a draft for Glenn. The agent never sends it to the prospect.

Missing information is labeled `Not stated`; the agent does not invent buyer details.

### LinkedIn identity verification

The agent never selects a likely-looking LinkedIn account from search results and never
clicks through candidate profiles. A profile URL is included only in either of these cases:

- an authenticated sender supplies exactly one LinkedIn profile URL, the From and claimed
  personal identities match, and the sender domain aligns with the claimed company; or
- an official page on the authenticated sender's company domain publishes an exact-name
  Schema.org `Person` record containing exactly one LinkedIn URL, with no conflicting
  company information.

The brief shows the confirmation basis, role and company with their provenance, and
evidence-source URLs. Multiple profiles, partial-name matches, company conflicts,
personal-email company claims, or missing evidence produce `Not confirmed`, omit the
candidate URL, and instruct the maintainer not to use LinkedIn for outreach until a human
confirms the identity.

Research requests are limited to fixed HTTPS paths on the authenticated sender's company
domain. Redirects must remain on that domain, every resolved address must be globally
routable, response bodies are bounded, and LinkedIn itself is never fetched or automated.
Set `HUSHLINE_SALES_LEAD_AGENT_IDENTITY_RESEARCH=0` to disable this research.

## Qualification policy

A message must contain both a relevant Hush Line use case and credible inbound intent,
such as a demo, pricing, procurement, evaluation, deployment, requirements, or
partnership request. Organizational context and explicit timelines strengthen the score.
Newsletters, automated notices, delivery failures, employment inquiries, billing mail,
and unrelated vendor solicitations are screened out.

Before delivery, the agent also checks the Mail sender against the RFC `From` header,
validates address syntax, summarizes SPF/DKIM/DMARC results, compares `Reply-To` and
`Return-Path` domains, and looks for Hush Line impersonation, punycode/lookalike domains,
IP-address and shortened links, credential harvesting, and urgent payment fraud. These are
basic local signals, not proof that a message is safe. High-risk messages remain unread and
do not produce a brief; lower-confidence authentication or alignment findings are included
in the lead brief for human review.

A personal identity claimed in the body or signature must be consistent with the From
display identity. A contradiction is High risk and blocks delivery. A company claimed
from a personal mailbox such as Proton, Gmail, or Outlook is labeled unverified; that alone
does not block delivery when the personal identities agree.

The rules are deterministic and local. Prospect message content is not sent to Codex,
OpenAI, a lead-enrichment service, or another external processor.

## Mail and state behavior

- Only unread messages in the `sales@hushline.app` account's Inbox are considered.
- The qualified lead is forwarded once from `sales@hushline.app` to
  `glenn@hushline.app`, with the executive summary above the original message. The source
  message is marked read only after Mail accepts the forward.
- Screened-out messages remain unread for human review but are not assessed again.
- State contains only a SHA-256 message fingerprint, decision, numeric score, and
  processing timestamp. It does not contain names, addresses, subjects, or message bodies.
- Logs contain aggregate counts and operational errors, not prospect content.

## Install

The agent requires a logged-in GUI session because it uses Mail.app. Do not install it as
a LaunchDaemon.

```bash
./agents/sales/scripts/install_sales_lead_launch_agent.sh
```

The LaunchAgent runs at login and every five minutes. On first use, macOS may ask for
permission to control Mail.

## Manual dry run

```bash
./agents/sales/scripts/run_sales_lead_agent_launchd.sh --dry-run
```

A dry run reads and scores pending unread messages, prints aggregate counts, and neither
sends messages nor updates state.

Runtime files are ignored under:

```text
logs/sales/lead-agent/state.json
logs/sales/sales-lead-agent.log
```
