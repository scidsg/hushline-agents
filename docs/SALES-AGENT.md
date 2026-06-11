# Sales Contact Agent

The sales contact agent sends one concise outreach email per day from the local
macOS Mail app account `sales@hushline.app`.

It uses the assessed contact-form audit CSV from `hushline-docs`, chooses the
highest-ranked uncontacted commercial organization with a resolved public
recipient email, builds a short plain-text email from the observed form
properties and a small company profile map, and stores contacted-organization
state under `logs/sales/`.

## Schedule

The launchd job runs every 15 minutes. The Python runner chooses a deterministic
random send target between 04:00 and 09:00 in the recipient company's timezone
and exits without sending until that local target time is due. This avoids
sending EU and Asia-Pacific outreach at US-local morning times.

## Required Mail Setup

Create a Mail.app account for:

```text
sales@hushline.app
```

The runner refuses to send from any other account. The Mail account must be
visible to AppleScript under Mail's configured accounts.

## Environment

Create `hushline-agents/.env.sales.launchd` with mode `600`:

```bash
HUSHLINE_SALES_AGENT_FROM=sales@hushline.app
```

Optional settings:

```bash
HUSHLINE_SALES_AGENT_DOCS_REPO_DIR=/Users/scidsg/hushline-docs
HUSHLINE_SALES_AGENT_STATE_FILE=/Users/scidsg/hushline-agents/logs/sales/sales-contact-agent-state.json
HUSHLINE_SALES_AGENT_OUTPUT_DIR=/Users/scidsg/hushline-agents/logs/sales/drafts
HUSHLINE_SALES_AGENT_LIVE_RESEARCH=1
HUSHLINE_SALES_AGENT_RECIPIENT_DISCOVERY=1
HUSHLINE_SALES_AGENT_RECIPIENT_OVERRIDE=maintainer@example.com
```

Use `HUSHLINE_SALES_AGENT_RECIPIENT_OVERRIDE` only for dry-run or controlled
delivery testing; it forces every selected company to one recipient.

## Install

GUI session:

```bash
./sales/scripts/install_launch_agent.sh --scope gui
```

Daemon:

```bash
sudo ./sales/scripts/install_launch_agent.sh --scope daemon
```

## Manual Runs

Dry run:

```bash
./sales/scripts/run_sales_contact_agent_launchd.sh --dry-run
```

Direct runner dry run:

```bash
HUSHLINE_SALES_AGENT_LIVE_RESEARCH=0 \
  ./sales/scripts/sales_contact_agent.py \
  --docs-repo-dir "$HOME/hushline-docs" \
  --dry-run
```

The direct runner supports `--date`, `--now`, `--state-file`, `--output-dir`,
`--recipient-override`, and `--bounce-monitor-seconds` for testing.

## Recipient Resolution

Before every live send, the runner searches the audited contact URL, selected
contact link, and homepage for public `mailto:` or visible email addresses. It
ranks sales, enterprise, business, partnership, contact, hello, and info
mailboxes, rejects operational mailboxes such as support, abuse, security,
legal, jobs, postmaster, and no-reply, and skips the company if it cannot find a
credible recipient. It does not synthesize `sales@domain` addresses.

## Delivery Monitoring

After Mail.app accepts a send handoff, the runner monitors Mail.app for five
minutes for delivery-failure messages that reference the recipient. If it sees
an undeliverable signal, it records the attempt under `failed` state instead of
`sent` and exits with an error so the operator can review the target.

## Message Guardrails

- one email per day, selected from uncontacted organizations in rank order
- no sends from anything except `sales@hushline.app`
- no guessed recipient addresses; live sends require a resolved public email
- five-minute Mail.app undeliverable monitoring after live sends
- short plain text body with the observed contact-form issue, the $5/mo secure
  intake offer, and one non-threatening regulatory context sentence
- no cliche sales phrases such as "game changer", "touch base", or "synergy"
- no committed logs, drafts, recipient state, or Mail output
