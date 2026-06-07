# Hush Line Agents

Automation for maintaining the [Hush Line](https://github.com/scidsg/hushline) project.

This repository contains the code-agent issue runner, local environment bootstrap helper,
sanitized run-log tooling, and weekly local runner reporting. Product code and historical
release evidence remain in the main Hush Line repository.

## Repository Layout

- `scripts/agent_daily_issue_runner.sh`: selects eligible Hush Line issues, invokes Codex,
  validates changes, opens pull requests, and monitors review feedback.
- `scripts/agent_issue_bootstrap.sh`: resets and seeds the target Hush Line Docker environment.
- `scripts/sanitize_agent_run_log.py`: removes sensitive local metadata from persisted logs.
- `scripts/weekly_hushline_code_agent_report_runner.py`: summarizes local runner logs.
- `docs/AGENT-RUNNER.md`: operational configuration and behavior.
- `docs/AGENTIC-CODE-POLICY.md`: human-review policy for agent-authored changes.

## Target Checkout

The scripts default to a sibling checkout:

```text
parent/
  hushline/
  hushline-agents/
```

Set `HUSHLINE_REPO_DIR` when the product checkout is elsewhere.

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
