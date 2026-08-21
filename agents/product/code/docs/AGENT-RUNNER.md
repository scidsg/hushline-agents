# Agent Runners

This document tracks the current state of the repo-managed agent automation used around Hush Line.

## Repo-Managed Agent State

| Script                                                | Role                           | Current State                                                 | PR / Output Surface                                               |
| ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `agents/product/code/scripts/code_agent.sh`            | GitHub issue implementation    | Paused on this host; configured for 10-minute launchd cadence | issue-specific branches and PRs                                   |
| `agents/product/code/scripts/mail_command_agent.py`     | Authenticated Mail-to-Codex requests | Optional GUI LaunchAgent; five-minute polling | `glenn@hushline.app` to `agent@hushline.app`; private local state |
| `agents/product/reporting/scripts/weekly_hushline_code_agent_report_runner.py` | Weekly local agent reporting   | Active, local Mail.app delivery and local report persistence  | configured email recipient; local `logs/weekly-agent-reports/`    |
| `agents/sales/scripts/sales_contact_agent.py` | Daily sales outreach from contact-form audit | Active when installed; Mail.app delivery gated by recipient-local 04:00-09:00 window | `sales@hushline.app`; local `logs/sales/` state and drafts |
| `agents/product/code/scripts/agent_issue_bootstrap.sh` | Local runtime/bootstrap helper | Active, manual helper used by issue and local workflows       | local Docker/bootstrap only                                       |
| `agents/product/code/scripts/open_runner_dashboard.sh` | Local runner dashboard         | Active as a GUI LaunchAgent at user login after reboot        | Terminal windows and local dashboard launch logs                  |

Social runner scripts are managed under `agents/social/`. Docs jobs listed below are
installed host context and should not be treated as repo-managed automation unless their
files are added under an explicit agent scope.

## Installed Host Jobs

| Label                                             | Scope                                | Schedule                                  | Source                                                  |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| org.scidsg.hushline-code-agent                    | Hush Line issue runner               | Disabled; configured for every 10 minutes | org.scidsg.hushline-code-agent.plist                    |
| com.hushline.social.whistleblower-news-post-agent | Whistleblower news article post      | Daily, random publish target 4-9 AM       | com.hushline.social.whistleblower-news-post-agent.plist |
| com.hushline.social.hushline-feature-post-agent   | Hush Line feature screenshot post    | Daily, random publish target 4-9 AM       | com.hushline.social.hushline-feature-post-agent.plist   |
| com.hushline.weekly-agent-report                  | Weekly local agent report            | Sunday at 10:30 PM                        | com.hushline.weekly-agent-report.plist                  |
| com.hushline.social.hushline-verified-user-post-agent | Verified-user callout post       | Random weekday Mon-Fri, random publish target 4-9 AM | com.hushline.social.hushline-verified-user-post-agent.plist |
| com.hushline.runner-dashboard                     | Local runner dashboard               | RunAtLoad in Aqua user session            | com.hushline.runner-dashboard.plist                     |
| com.hushline.mail-command-agent                   | Authenticated Mail-to-Codex requests | Every minute                               | com.hushline.mail-command-agent.plist                   |

## Runner Dashboard

Script: `agents/product/code/scripts/open_runner_dashboard.sh`

Install or refresh the GUI LaunchAgent with:

```bash
./agents/product/code/scripts/install_runner_dashboard_launch_agent.sh
```

The dashboard is installed in `~/Library/LaunchAgents/com.hushline.runner-dashboard.plist`.
Because it controls Terminal through AppleScript, it runs in the logged-in Aqua user session
after reboot rather than as a system daemon before login.

## Mail Command Agent

Script: `agents/product/code/scripts/mail_command_agent.py`

The optional mail command agent polls the native macOS Mail app every minute. Before each
scan, it explicitly asks Mail to check for new messages and waits five seconds for Mail and
the configured mail bridge to settle. If Mail reports the transient AppleEvent
`Connection is invalid (-609)` failure, the runner waits one second and retries the same
read-only mailbox scan once; other scan failures remain hard errors. It accepts two narrowly
scoped command sources:

- New Inbox messages whose visible and parsed `From` address is exactly
  `glenn@hushline.app`, whose `To` header includes `agent@hushline.app`, and whose first
  `Authentication-Results` header records aligned DKIM and DMARC passes for
  `hushline.app`.
- New messages in the `All Mail` mailbox of the Mail account that owns
  `agent@hushline.app`, with the same exact parsed `From` and `To` requirements. This is
  the same-account Proton path: a message sent between two addresses in one Proton
  mailbox can appear only in All Mail and may not receive external-delivery DKIM or DMARC
  headers. The message must instead contain exactly one Proton internal-origin marker;
  external or ambiguous origin markers are rejected.

A matching Inbox address without the required authentication results is rejected and
never passed to Codex. Attachments are not passed to Codex.

For each authenticated message, the runner passes the subject and Mail.app plain-text
body to a fresh, ephemeral `codex exec` invocation using `gpt-5.6-sol` at high reasoning.
Codex runs in the `workspace-write` sandbox with automatic approval review; the configured
repository directories are the only additional writable roots. Repository `AGENTS.md`
files remain authoritative. Codex can complete a clear request, ask a concise clarifying
question, or report that it is blocked. The wrapper sends the final response from
`agent@hushline.app` only to `glenn@hushline.app`; the model is instructed not to send
mail itself. Responses use Mail's native reply action, place the agent response in the
reply body above Mail's normal quoted original, and retain standard reply-thread headers.
Before sending, the wrapper refuses an empty body and verifies that the native reply has
exactly one recipient—`glenn@hushline.app`—with no CC or BCC recipients.

The local state file stores only a SHA-256 digest of each processed `Message-ID`, status,
timestamps, and a non-sensitive result label. Subjects and bodies are not logged. The
state prevents duplicate actions across overlapping polls. A failed Codex task is not
automatically rerun because it may have partially changed local or remote state; the
runner emails that failure and requires Glenn to inspect the logs before resending.

Install or refresh the logged-in user's LaunchAgent:

```bash
./agents/product/code/scripts/install_mail_command_agent_launch_agent.sh
```

Installation verifies that Mail.app can send from `agent@hushline.app`, verifies Codex
authentication, copies the executable to a private application-support directory,
initializes the cursor at the current time, and loads the job. Existing email is therefore
never interpreted as a new command. When an existing installation first gains All Mail
support, the runner migrates the prior Sent cursor when available; otherwise it establishes
a separate All Mail cursor before scanning, so historical messages are not executed.
Reinstalling preserves existing cursors so mail that arrived since the prior poll is not
skipped. The Aqua user session is required because the runner uses Mail.app automation.

Operational checks:

```bash
"$HOME/Library/Application Support/Hush Line Agents/bin/mail_command_agent.py" --diagnose
"$HOME/Library/Application Support/Hush Line Agents/bin/mail_command_agent.py" --dry-run
launchctl print "gui/$(id -u)/com.hushline.mail-command-agent"
tail -F "$HOME/hushline-agents/logs/mail-command-agent/mail-command-agent.stdout.log" \
  "$HOME/hushline-agents/logs/mail-command-agent/mail-command-agent.stderr.log"
```

The default writable repository set is `hushline`, `hushline-agents`, `hushline-docs`,
`hushline-finance`, `hushline-social`, and `hushline-quotes` when those sibling checkouts
exist. Override the colon-separated list with
`HUSHLINE_MAIL_COMMAND_AGENT_WORKSPACE_DIRS` when installing. Override the Codex profile
directory with `HUSHLINE_MAIL_COMMAND_AGENT_CODEX_HOME`. A deployment from an isolated
worktree can keep logs in the durable checkout by setting
`HUSHLINE_MAIL_COMMAND_AGENT_LOG_DIR="$HOME/hushline-agents/logs/mail-command-agent"`.

## Code Agent

Script: `agents/product/code/scripts/code_agent.sh`

This runner runs directly in the local repo and performs a narrow local gate before opening a PR.

## Operational Contract

The code runner has two ordered jobs: drain trusted Dependabot maintenance, then turn one
assigned GitHub issue into one reviewed pull request.

1. Pull and clean the latest base branch before any PR or issue work.
2. Read every open Dependabot Security-tab alert and process every open, non-draft, same-repository PR authored by the exact trusted Dependabot identity, oldest first.
3. For each dependency PR, inspect release/advisory and open-alert context plus affected package usage across application, tests, build, CI, and operations; apply all required compatibility and security work.
4. Run Python and Node vulnerability audits first, verify changed Node lockfiles with an integrity-enforcing clean install, then run `make lint` and `make test`.
5. Require GitHub to report every commit in the dependency branch range as remotely verified. A contiguous tail of locally verified runner commits using the retired runner email is replaced, with an exact force-with-lease, by one signed commit using the mapped `hushline-dev` identity.
6. When the active branch ruleset explicitly grants `hushline-dev` pull-request bypass, wait for every check to finish successfully, require an unchanged and mergeable head with no unresolved review threads, then use the bypass only for the review gate and squash-merge. Without that explicit bypass, retain the approval and protected auto-merge path.
7. When alerts remain after the Dependabot PR queue drains, create or resume the dedicated signed `codex/dependabot-security-remediation` PR, validate it, and merge it through the same protection-aware policy.
8. Keep ordinary issue work deferred while any Dependabot PR or security alert remains open, but continue assessing other open Dependabot PRs when one is awaiting approval.
9. After dependency maintenance drains, select exactly one assigned issue from the configured project queue, or the issue passed with `--issue`.
10. Make the smallest safe code, test, or documentation changes needed for that issue.
11. Before opening or updating an issue PR, run `make lint` and `make test`; if either fails, repair the failure and rerun the checks.
12. Open or update the issue PR only when there are meaningful non-log changes and local validation is clean.
13. Poll the open issue PR for actionable comments, review threads, change requests, and failing checks.
13. Address and resolve actionable feedback, push the issue PR update, and continue polling until the PR is closed.

Every queued issue is assumed to require a real change. Once the runner claims an issue, the only successful terminal outcome is a clean, usable PR. If an attempt does not complete a validated implementation, the issue stays claimed as `In Progress`; the next runner pass must resume that same assigned issue instead of selecting new work, returning it to the eligible queue, opening a diagnostic PR, or moving it to `Ready for Review`.

## Execution Flow

1. Parse arguments (`--issue` optional) and resolve runtime configuration.
2. Acquire a local runner lock and exit without doing any repository or Docker work if another Hush Line code-agent run is active.
3. Check Codex `/status` rate-limit data before repository, GitHub, or Docker work. If the 300-minute primary window has less than the configured minimum remaining quota, wait until after its reset time and re-check before proceeding.
4. Change into the repo (`$HOME/hushline` by default).
5. Hold the runner lock through all repository cleanup, including exit-time checkout/reset/clean work, so a launchd overlap cannot start a second issue while the prior run is still unwinding.
6. Normalize the local agent-only checkout by discarding local worktree changes and switching to the base branch.
7. Drain open Dependabot PRs before any ordinary PR guard or issue work:
   - fetch and normalize every open Dependabot alert from the repository Security tab; fail closed if alert access is unavailable
   - accept only the exact configured Dependabot identity, `main` base, same-repository branches, and the `dependabot/` head prefix
   - process oldest first and continue through the initial open set even if one PR needs independent approval
   - include every open alert in dependency assessment so one update can remediate all applicable advisories
   - inspect package use across the whole repository and apply necessary compatibility, security, test, or documentation updates
   - fail fast on Python and Node vulnerability audits before the expensive test suite
   - verify changed Node lockfiles with an integrity-enforcing `npm ci --ignore-scripts` clean install in an isolated temporary directory under the project's pinned Node 20 webpack service, so invalid registry metadata cannot reach CI or dirty the live asset workspace
   - preserve prior security fixes across repair attempts and regenerate lockfiles rather than hand-editing package-manager checksums
   - run lint and the full test suite after dependency audits and install-integrity checks pass
   - approve only an unchanged Dependabot-authored tip; never let the runner approve its own compatibility commit
   - enable protected squash auto-merge and defer ordinary issue work until every dependency PR closes
   - if alerts remain with no open Dependabot PR, create or resume the dedicated signed security-remediation branch and PR
   - never dismiss an alert, suppress an audit, self-approve runner-authored remediation, or bypass branch protections
   - refresh and clean `main` after the dependency pass
8. Resume monitoring any open bot-authored issue PR whose head branch matches the daily issue branch pattern before selecting new issue work. This makes PR polling restart-resilient after launchd unloads, crashes, or reboots.
9. Check cheap GitHub exit conditions before any new-work queue lookup or network sync/Docker work:
   - exit if any open human-authored PR exists
10. Select issue target before any network sync or Docker work:
   - resume the top open issue already in project status `In Progress`, otherwise
   - Use `--issue <n>` when provided (must still be open), otherwise
   - select the top open issue from project `Hush Line Roadmap`, column `Agent Eligible`.
11. Check remaining cheap GitHub exit conditions before any network sync or Docker work:

- for non-epic issues, exit if any other open PR exists from `hushline-dev`
- for child issues with a GitHub parent epic, allow the long-lived epic PR (head branch `codex/epic-<epic>`) and the current child issue PR (head branch `codex/daily-issue-<issue>`)
- for child issues with a GitHub parent epic, exit only if there are unrelated open bot PRs outside those allowed heads

12. Hard-refresh local state only after an issue is selected and skip guards pass:

- `git fetch origin`
- `git checkout main`
- `git reset --hard origin/main`
- `git clean -fd`

13. Move the selected issue into project status `In Progress`.
14. Configure bot git identity and signed commit settings.
15. Reset local Docker/runtime state:

- `docker compose down -v --remove-orphans`
- Remove all Docker containers (`docker rm -f $(docker ps -aq)`, when any exist)
- Kill processes listening on runner ports (`4566 4571 5432 8080` by default)

16. Start and seed stack:

- `docker compose up -d --build`
- `docker compose run --rm dev_data`
- retry the bootstrap sequence when Docker image pulls fail with transient registry/network errors (defaults: `3` attempts, `10`s delay via `HUSHLINE_DAILY_RUNTIME_BOOTSTRAP_ATTEMPTS` and `HUSHLINE_DAILY_RUNTIME_BOOTSTRAP_RETRY_DELAY_SECONDS`)

17. Create/update work branch:

- regular issues use `codex/daily-issue-<issue_number>` by default
- child issues with a parent epic still use `codex/daily-issue-<issue_number>` as the work branch
- child issues with a parent epic use `codex/epic-<epic_issue_number>` as the PR base branch
- if the epic base branch does not exist yet, create and push it from `main` before starting the child branch
- if the child issue branch already has an open PR, update that child PR instead of opening a duplicate

18. Run a bounded Codex issue loop until repository changes exist (max attempts configurable via `HUSHLINE_DAILY_MAX_ISSUE_ATTEMPTS`, default `10`).
    - The issue/fix prompts tell Codex to avoid local container-backed make validation by default, and to defer validation entirely to the runner when schema-affecting files are touched (`hushline/model/`, `migrations/`, `scripts/dev_data.py`, `scripts/dev_migrations.py`).
    - The fix prompt includes the current branch diff summary, the prior Codex summary, and an extracted failure signature so Codex can repair the current implementation instead of repeating a narrow patch against the same failing symptom.
    - Raw failed check output is intentionally withheld from Codex prompts because local check logs may contain sensitive operational data.
    - Codex transcript output is hidden from the live console by default and is captured in a temporary file for the duration of the run. Transcript output is excluded from the persisted runner log; only the final Codex summary is written into the run log. Operators can opt in to live console streaming when needed.
    - Each Codex attempt logs prompt size and pre/post worktree snapshots so clean-tree no-op runs are visible in the runner log.
19. Run required checks in a bounded self-heal loop (max attempts configurable via `HUSHLINE_DAILY_MAX_FIX_ATTEMPTS`, default `8`):
    - Before lint/test validation, if the working tree includes schema-affecting changes (`hushline/model/`, `migrations/`, `scripts/dev_data.py`, `scripts/dev_migrations.py`), rebuild the local runtime and reseed dev data so the live stack matches the current code.
    - `make lint`
    - `make test` (full suite)
    - The runner stops at the first failing gate, hands that failure back to Codex, and reruns from `make lint` on the next self-heal attempt.
    - Lint failures only run deterministic `make fix` self-heal when the failure looks auto-fixable (for example Ruff formatting/check or Prettier); non-auto-fixable lint failures go straight back to Codex.
    - Runtime-dependent tests self-heal by restarting the local stack and reseeding dev data, then retrying once.
    - The broader CI workflow matrix still runs on the PR after branch push; the runner no longer tries to mirror that entire matrix locally.
20. Persist a sanitized local run log to `logs/runs/run-<timestamp>-issue-<n>.txt`.
    - After each persist, prune older runner logs and keep only the newest `10` by default.
    - Persisted logs are sanitized before retention to remove developer filesystem paths, emails, Codex session metadata, and common credential patterns.
21. Commit, push branch, and open/update PR:
    - first push uses a normal push when remote branch is absent
    - existing remote branch uses `--force-with-lease` with one stale-info recovery retry.
    - child issues under a parent epic open/update a child PR whose base branch is the shared epic branch
    - the long-lived epic PR, when present, remains the only PR that targets `main`
22. Move the selected issue into project status `Ready for Review` once the PR exists.
23. After the PR exists and before feedback polling starts, parse the latest line-specific `make test` coverage snapshot for any files with missed statements. If no open coverage-gap issue exists, open one follow-up issue with the exact missing line ranges, explicit 100% / zero-miss acceptance criteria, and instructions that the follow-up PR is not complete if it would create another coverage-gap issue. If an open coverage-gap issue already exists, add the new snapshot as a comment on that issue instead of opening another ticket. Ensure the coverage-gap issue is in the `Hush Line Roadmap` project in the `Agent Eligible` status.
24. For child PRs targeting an epic branch, record `Linked issue: #<n>` in the PR body instead of relying on GitHub's default-branch-only close keywords.
25. A dedicated workflow closes that linked child issue after the child PR is merged into the epic branch.
26. State that the runner log is retained locally by `hushline-agents` and use a plain-language narrative lead for broad audiences, followed by the structured PR body sections (`Summary`, `Context`, `Changed Files`, `Validation`, `Manual Testing`).
    - `Validation` lists automated checks run by the runner or CI.
    - `Manual Testing` lists human reviewer steps to exercise the changed feature after the PR opens. It is not a log of actions the LLM or runner performed.
27. Refresh the local run log after PR creation, including the opened PR URL, coverage gap issue URL when created, and post-check steps.
28. Poll the open PR until it closes. When the monitor sees human/reviewer feedback (discussion comments, change-request reviews, or unresolved review threads), it invokes Codex on the PR branch immediately, reruns `make lint` and `make test`, commits and pushes any fix, resolves addressed review threads, and resumes polling. When the only actionable item is a failing check, it waits for pending PR checks to settle before invoking Codex so transient in-progress checks do not trigger unnecessary fixes.
29. Return to a clean `main` on normal completion or PR closure.
    - If the run fails after creating branch work, cleanup resets the checkout back to a clean base branch.
    - A new scheduled pass discards local worktree changes and switches back to the base branch before evaluating GitHub queue guards.

## ASCII Workflow (Current)

```text
+---------------------------------+
| Start: code_agent |
+---------------------------------+
      |
      v
+-------------------------------+
| Parse args (--issue optional) |
+-------------------------------+
      |
      v
+-----------------------------------------------+
| Resolve env/config + start log capture        |
| Log: model + reasoning effort                 |
+-----------------------------------------------+
      |
      v
+-----------------------------------------------+
| Acquire runner lock                           |
| Already active? skip + exit                   |
+-----------------------------------------------+
      |
      v
+--------------------------------------------------+
| Normalize agent-only checkout                 |
| Discard dirty work + switch to base branch    |
+--------------------------------------------------+
      |
      v
+------------------------------------------------+
| Refresh + clean main                           |
+------------------------------------------------+
      |
      v
+------------------------------------------------+
| Open trusted Dependabot PRs?                   |
| Read Security-tab alerts                       |
| Assess whole-app impact, repair, audit, test   |
| Approve unchanged bot tip + enable auto-merge  |
+------------------------------------------------+
      |
      +-- alerts remain, no PR --> [Open/resume protected security-remediation PR]
      |
      +-- PR/alert still open --> [Report dependency maintenance pending; defer issue work]
      |
      v
+------------------------------------------------+
| Cheap GitHub guards + issue selection:         |
| human PRs, In Progress, or project queue       |
+------------------------------------------------+
      |
      +-- no issue / blocked by human PR --> [Hourly idle /status if due, then skip]
      |
      v
+-----------------------------------------------+
| Assigned issue exists: check Codex /status    |
| 5h quota below floor? wait, then re-check     |
+-----------------------------------------------+
      |
      v
+----------------------------------------------+
| Resolve parent epic + child/epic branch rules |
+----------------------------------------------+
      |
      v
+----------------------------------------------+
| Mark issue In Progress via project status     |
+----------------------------------------------+
      |
      v
+----------------------------------------------+
| Configure bot git identity                    |
| Docker reset, port cleanup, stack up, seed    |
+----------------------------------------------+
      |
      v
+----------------------------------------------+
| Load issue metadata + checkout work branch   |
| Build initial issue prompt                   |
+----------------------------------------------+
      |
      v
+------------------------------------+
| Issue attempt loop                 |
| Run Codex from prompt              |
+------------------------------------+
      |
      v
+------------------------+
| Any repo changes?      |--no--> [Retry issue attempt]
+------------------------+
      |
      yes
      |
      v
+-----------------------------------------------+
| Fix/self-heal loop                            |
| Run: lint, test                               |
+-----------------------------------------------+
      |
      v
+------------------------+
| Checks pass?           |--no--> [Build fix prompt + run Codex + retry]
+------------------------+
      |
      yes
      |
      v
+------------------------+
| Still has changes?     |--no--> [Rebuild issue prompt + retry issue loop]
+------------------------+
      |
      yes
      |
      v
+----------------------------------------------+
| Persist local run log (logs/runs/run-...)   |
| git add/commit/push branch                    |
| Build PR body + create/update PR              |
| Mark issue Ready for Review                   |
| Append PR URL to run log                      |
| Commit/push updated run log if changed        |
+----------------------------------------------+
      |
      v
+----------------------------------------------+
| Cleanup after successful handoff/PR close     |
| Reset failed runs back to clean main          |
+----------------------------------------------+
```

## Required Commands

- `git`
- `gh`
- `codex`
- `docker`
- `make`
- `node`
- `lsof` (optional; used for port cleanup)
- `osascript` and configured macOS Mail.app accounts for the weekly agent report runner
  and sales contact agent

## Manual Run

```bash
./agents/product/code/scripts/code_agent.sh
```

## Weekly Agent Brief Runner

Script: `agents/product/reporting/scripts/weekly_hushline_code_agent_report_runner.py`

This runner scans the local runner logs monitored on this machine and builds a plain-text `Hush Line Weekly Agent Brief` for the shared agents workspace. The email is written as an executive weekly: an executive snapshot, workstream scorecard, leadership watchlist, capacity/usage readout, supporting workstream notes for Engineering, Social, Administrative, and in-flight Finance activity, and then a technical operational appendix. It persists a timestamped local copy before sending through the native macOS Mail app. Mail.app delivery uses a bounded AppleScript timeout and sends asynchronously once the message is handed to Mail. If Mail reports its own AppleEvent timeout after that handoff, or if the outer `osascript` process exceeds its timeout while waiting on Mail.app, the runner logs a warning and exits successfully so slow Mail.app network delivery does not fail the LaunchAgent run after the local report has already been written.

Default log files:

- `~/.codex/logs/hushline-code-agent.log`
- `~/tor-code-agent/logs/tor-agent.err.log`
- `~/.codex-hushline-agents/log/codex-tui.log`
- `~/.codex-hushline-agents/sessions`
- `logs/social/social-daily.log`
- `logs/weekly-agent-report.stdout.log`
- `logs/weekly-agent-report.stderr.log`

Delivery is fixed in code:

- From: `HUSHLINE_WEEKLY_AGENT_REPORT_FROM`
- To: `HUSHLINE_WEEKLY_AGENT_REPORT_TO`

Additional log files can be supplied with repeated `--log-file` arguments or the colon-separated `HUSHLINE_WEEKLY_AGENT_REPORT_LOG_FILES` environment variable. The runner deduplicates narrative highlights so repeated stdout/stderr lines do not inflate the executive summary, while preserving raw completed work, skipped/no-op checks, work/check activity, attention items, and usage detail in the appendix. Usage attribution is intentionally conservative: `/status` percentages are assigned to the runner log that captured them, while token telemetry from the shared Codex workspace is reported as shared unless the source log identifies a specific runner.

Persisted report bodies are written to `logs/weekly-agent-reports/weekly-agent-report-<timestamp>.txt` by default. The directory is intentionally ignored by git. The default retention is the newest `12` reports; override it with `--report-retention` or `HUSHLINE_WEEKLY_AGENT_REPORT_RETENTION`. Override the report directory with `--report-output-dir` or `HUSHLINE_WEEKLY_AGENT_REPORT_OUTPUT_DIR`.

Monitor the installed LaunchAgent stdout/stderr logs:

```bash
tail -F "$HOME/hushline-agents/logs/weekly-agent-report.stdout.log" "$HOME/hushline-agents/logs/weekly-agent-report.stderr.log"
```

Control the installed LaunchAgent:

```bash
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.hushline.weekly-agent-report.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.hushline.weekly-agent-report.plist"
launchctl kickstart -k gui/$(id -u)/com.hushline.weekly-agent-report
launchctl print gui/$(id -u)/com.hushline.weekly-agent-report
```

Manual dry run:

```bash
./agents/product/reporting/scripts/weekly_hushline_code_agent_report_runner.py --dry-run
```

## Sales Contact Agent

Script: `sales/scripts/sales_contact_agent.py`

This runner uses the assessed contact-form audit data from `hushline-docs` to send
one outreach email per day from the local Mail.app account `sales@hushline.app`.
It picks the highest-ranked uncontacted commercial organization, skips public-sector
targets, resolves a public recipient email instead of guessing `sales@domain`,
avoids contacting the same organization twice when multiple domains map to one
company, monitors Mail.app for undeliverable responses after sends, and stores state
and drafts under ignored `logs/sales/`.

The launchd wrapper runs every 15 minutes. The Python runner chooses a deterministic
random send target between 04:00 and 09:00 in the recipient company's timezone, then
exits without sending until that target local time is due.

Required env file:

```bash
HUSHLINE_SALES_AGENT_FROM=sales@hushline.app
```

Install:

```bash
./sales/scripts/install_launch_agent.sh --scope gui
```

Manual dry run:

```bash
./sales/scripts/run_sales_contact_agent_launchd.sh --dry-run
```

More detail lives in `docs/SALES-AGENT.md`.

## Runner Dashboard Windows

Open the local runner monitoring layout:

```bash
bash "$HOME/hushline-agents/scripts/open_runner_dashboard.sh"
```

The launcher opens six Terminal windows:

- left/top: code-agent logs
- left/upper-middle: social live combined log (`logs/social/social-daily.log`)
- left/lower-middle: social LaunchAgent stdout/stderr logs
- left/bottom: weekly-agent-report logs
- right/top: Codex in `hushline-agents`
- right/bottom: an interactive shell in `hushline`

Use the `Social Live Log` window when manually running social commands; wrappers append
their live progress to the combined social log even when the LaunchAgent-specific stdout
file is not being written by launchd.

To restore this after reboot, add the launcher command to a macOS login item or a user
LaunchAgent that runs after graphical login.

Send report:

```bash
make weekly-agent-report
```

Optional forced issue:

```bash
./agents/product/code/scripts/code_agent.sh --issue 1389
```

## Machine Setup

Each runner host needs its own signed-commit configuration. The code agent defaults to SSH signing and resolves the signing key in this order:

1. `HUSHLINE_BOT_GIT_SIGNING_KEY`
2. Existing git config when `gpg.format=ssh` and `user.signingkey` is already set for the checkout
3. `HUSHLINE_BOT_GIT_DEFAULT_SSH_SIGNING_KEY_PATH`, if explicitly set to a local `.pub` file path

Recommended per-host setup:

```bash
git -C /path/to/hushline config gpg.format ssh
git -C /path/to/hushline config user.signingkey "$HOME/.ssh/hushline_bot_signing.pub"
ssh-add "$HOME/.ssh/hushline_bot_signing"
```

Requirements:

- The matching public key must be added to the GitHub bot account as an SSH signing key.
- The matching private key must be available to `ssh-agent` before the runner starts.
- If the machine still has a global GPG signing key from another environment (for example `git config --global user.signingkey 102783C80AF9335A`), do not reuse it with the runner's SSH signing mode.
- On macOS, using `ssh-add --apple-use-keychain` is optional but not required by the runner.

The runner now performs an SSH signing preflight immediately after configuring git identity and fails early with an actionable error if the host is missing the expected key or the key is not loaded into `ssh-agent`.

## Environment Variables

- `HUSHLINE_REPO_DIR` (default sibling checkout `../hushline`)
- `HUSHLINE_REPO_SLUG` (default `scidsg/hushline`)
- `HUSHLINE_BASE_BRANCH` (default `main`)
- `HUSHLINE_BOT_LOGIN` (default `hushline-dev`)
- `HUSHLINE_DEPENDABOT_LOGIN` (default `app/dependabot`; exact trusted PR author identity)
- `HUSHLINE_DEPENDABOT_COMMIT_LOGIN` (default `dependabot[bot]`; exact trusted tip-commit author identity)
- `HUSHLINE_BOT_GIT_NAME` (default `HUSHLINE_BOT_LOGIN`)
- `HUSHLINE_BOT_GIT_EMAIL` (default `166439242+hushline-dev@users.noreply.github.com`, which GitHub maps to the `hushline-dev` account for remote signature verification)
- `HUSHLINE_BOT_LEGACY_GIT_NAME` (default `Glenn`; retired runner display name accepted only with the configured legacy email and a valid local signature)
- `HUSHLINE_BOT_LEGACY_GIT_EMAIL` (default `git-dev@scidsg.org`; the only retired runner identity eligible for locally verified tail normalization)
- `HUSHLINE_BOT_GIT_GPG_FORMAT` (default `ssh`)
- `HUSHLINE_BOT_GIT_SIGNING_KEY` (optional; when unset the runner reuses existing SSH git signing config if available)
- `HUSHLINE_BOT_GIT_DEFAULT_SSH_SIGNING_KEY_PATH` (optional; no default)
- `HUSHLINE_DAILY_PROJECT_OWNER` (default owner from `HUSHLINE_REPO_SLUG`)
- `HUSHLINE_DAILY_PROJECT_TITLE` (default `Hush Line Roadmap`)
- `HUSHLINE_DAILY_PROJECT_COLUMN` (default `Agent Eligible`)
- `HUSHLINE_DAILY_PROJECT_STATUS_FIELD_NAME` (default `Status`)
- `HUSHLINE_DAILY_PROJECT_STATUS_IN_PROGRESS` (default `In Progress`)
- `HUSHLINE_DAILY_PROJECT_STATUS_READY_FOR_REVIEW` (default `Ready for Review`)
- `HUSHLINE_DAILY_PROJECT_ITEM_LIMIT` (default `200`)
- `HUSHLINE_DAILY_BRANCH_PREFIX` (default `codex/daily-issue-`)
- `HUSHLINE_DAILY_EPIC_BRANCH_PREFIX` (default `codex/epic-`)
- `HUSHLINE_DEPENDABOT_SECURITY_BRANCH` (default `codex/dependabot-security-remediation`)
- `HUSHLINE_DAILY_KILL_PORTS` (default `4566 4571 5432 8080`)
- `HUSHLINE_DAILY_RUN_LOG_RETENTION` (default `10`)
- `HUSHLINE_DAILY_RUN_LOG_DIR` (default `logs/runs/` in the `hushline-agents` checkout)
- `HUSHLINE_DAILY_MAX_ISSUE_ATTEMPTS` (default `10`; positive integer)
- `HUSHLINE_DAILY_MAX_FIX_ATTEMPTS` (default `8`; positive integer)
- `HUSHLINE_DAILY_CODEX_STATUS_CHECK_ENABLED` (default `1`; set `0` to skip Codex `/status` rate-limit checks)
- `HUSHLINE_DAILY_CODEX_STATUS_CHECK_TIMEOUT_SECONDS` (default `15`; positive integer)
- `HUSHLINE_DAILY_CODEX_STATUS_RESET_BUFFER_SECONDS` (default `60`; non-negative integer; extra wait after the 5h window reset before rechecking)
- `HUSHLINE_DAILY_CODEX_STATUS_MIN_REMAINING_PERCENT` (default `10`; integer percentage from `0` to `100`; wait for the 5h window reset when remaining primary quota is below this floor)
- `HUSHLINE_DAILY_CODEX_STATUS_STALE_RESET_RECHECK_SECONDS` (default `600`; positive integer; backoff before rechecking when Codex reports low remaining 5h quota but the reset timestamp has already passed)
- `HUSHLINE_DAILY_CODEX_STATUS_IDLE_CHECK_INTERVAL_SECONDS` (default `3600`; non-negative integer; when no issue work is assigned, perform at most one lightweight Codex `/status` check per interval, print the configured model, reasoning effort, and active Codex account, and do not wait on low quota)
- `HUSHLINE_DAILY_CODEX_STATUS_IDLE_CHECK_STATE_FILE` (default: a hidden sibling file next to `HUSHLINE_DAILY_RUNNER_LOCK_DIR`, for example `/tmp/.hushline-code-agent.lock.codex-status-last-check`; stores the last idle `/status` attempt timestamp without placing files inside the lock directory)
- `HUSHLINE_DAILY_GITHUB_READ_ATTEMPTS` (default `3`; positive integer; retries transient, fully verified GitHub reads before a startup guard fails closed)
- `HUSHLINE_DAILY_GITHUB_READ_RETRY_DELAY_SECONDS` (default `2`; non-negative integer; delay between verified GitHub read attempts)
- `HUSHLINE_DAILY_POST_PR_FEEDBACK_DELAY_SECONDS` (default `600`; non-negative integer; set `0` to skip continuous PR feedback monitoring; when enabled, the issue runner keeps the PR branch checked out and polls until the PR closes)
- `HUSHLINE_DAILY_RUNNER_LOCK_DIR` (default `${TMPDIR:-/tmp}/hushline-code-agent.lock`)
- `HUSHLINE_DEPENDABOT_MERGE_POLL_SECONDS` (default `30`; positive integer)
- `HUSHLINE_DEPENDABOT_MERGE_WAIT_SECONDS` (default `1800`; non-negative integer; maximum time to wait for protected checks or fallback auto-merge before continuing the dependency pass)
- `HUSHLINE_CODEX_MODEL` (default `gpt-5.6-sol`)
- `HUSHLINE_CODEX_REASONING_EFFORT` (default `high`)
- `HUSHLINE_DAILY_VERBOSE_CODEX_OUTPUT` (default `0`; set `1` to stream full Codex transcript output to the live console; transcript output is still excluded from persisted runner logs)
- `HUSHLINE_WEEKLY_AGENT_REPORT_FROM` (required for Mail.app delivery)
- `HUSHLINE_WEEKLY_AGENT_REPORT_TO` (required for Mail.app delivery)

## Issue Bootstrap Script

Script: `agents/product/code/scripts/agent_issue_bootstrap.sh`

Flow:

1. Ensure Docker is available; on macOS, attempt to start Docker Desktop automatically (`open -a Docker`).
2. Wait for Docker daemon readiness up to `HUSHLINE_DOCKER_START_TIMEOUT_SECONDS` (default `180`).
3. Build and seed required local services:
   - `docker compose build`
   - `docker compose down -v --remove-orphans`
   - `docker compose up -d postgres blob-storage`
   - `docker compose run --rm dev_data`
