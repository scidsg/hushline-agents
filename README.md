# Hush Line Agents

[![Tests](https://github.com/scidsg/hushline-agents/actions/workflows/tests.yml/badge.svg)](https://github.com/scidsg/hushline-agents/actions/workflows/tests.yml)
[![Dependency Graph](https://github.com/scidsg/hushline-agents/actions/workflows/dependabot/update-graph/badge.svg)](https://github.com/scidsg/hushline-agents/actions/workflows/dependabot/update-graph)

Automation for maintaining the [Hush Line](https://github.com/scidsg/hushline) project.

This repository contains the code-agent issue runner, local environment bootstrap helper,
sanitized run-log tooling, weekly local runner reporting, and Hush Line social launchd
runners. Product code, social content assets, and historical release evidence remain in
their owning repositories.

## Repository Layout

- `scripts/code_agent.sh`: selects eligible Hush Line issues, invokes Codex,
  validates changes, opens pull requests, and monitors review feedback.
- `scripts/agent_issue_bootstrap.sh`: resets and seeds the target Hush Line Docker environment.
- `scripts/sanitize_agent_run_log.py`: removes sensitive local metadata from persisted logs.
- `scripts/weekly_hushline_code_agent_report_runner.py`: summarizes local runner logs.
- `social/scripts/`: launchd wrappers and agent entrypoints for the Hush Line social
  planner and publishers.
- `social/deploy/launchd/`: LaunchAgent and LaunchDaemon templates for social jobs.
- `docs/AGENT-RUNNER.md`: operational configuration and behavior.
- `docs/SOCIAL-AGENTS.md`: social runner installation, schedules, and manual commands.
- `docs/AGENTIC-CODE-POLICY.md`: human-review policy for agent-authored changes.

## Target Checkout

The scripts default to a sibling checkout:

```text
parent/
  hushline/
  hushline-agents/
  hushline-social/
```

Set `HUSHLINE_REPO_DIR` when the product checkout is elsewhere.
Set `HUSHLINE_SOCIAL_REPO_DIR` when the social content checkout is elsewhere.

## Development

```bash
python3 -m pip install -e '.[dev]'
make lint
make test
```

## Security

- Never commit credentials, Codex transcripts, private keys, or unsanitized runner logs.
- Runtime logs are stored under `logs/` and ignored by Git.
- The weekly reporter requires `HUSHLINE_WEEKLY_AGENT_REPORT_FROM` and
  `HUSHLINE_WEEKLY_AGENT_REPORT_TO`.
- Agent-authored product changes always require human review.

## License

GNU Affero General Public License v3.0. See `LICENSE`.
