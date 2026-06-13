# Hush Line Agents

[![Tests](https://github.com/scidsg/hushline-agents/actions/workflows/tests.yml/badge.svg)](https://github.com/scidsg/hushline-agents/actions/workflows/tests.yml)
[![Dependency Graph](https://github.com/scidsg/hushline-agents/actions/workflows/dependabot/update-graph/badge.svg)](https://github.com/scidsg/hushline-agents/actions/workflows/dependabot/update-graph)

Automation for maintaining the [Hush Line](https://github.com/scidsg/hushline) project.

This repository contains role-based Hush Line agent definitions and all agent-owned
implementation files. Product application code and historical release evidence remain
in their owning repositories.

## Repository Layout

- `agents/`: all agent roles, operating instructions, scripts, tests, docs, and deploy
  templates owned by this repository.
- `agents/product/code/`: Hush Line issue runner, bootstrap helper, log sanitizer,
  runner dashboard, code-agent policy, operations docs, and tests.
- `agents/product/reporting/`: weekly local runner reporting script and tests.
- `agents/social/`: social agent package, launchd wrappers, Node planners/publishers,
  templates, assets, docs, tests, and LaunchAgent/LaunchDaemon templates.
- `agents/sales/`: sales contact agent, launchd wrappers, deploy templates, tests, and
  sales scoped operating instructions.
- `agents/product/AGENTS*.md`: product scoped agent roles, including accessibility,
  QA, and security.
- `agents/sales/AGENTS*.md`: sales scoped agent roles, including AE and SDR.

## Target Checkout

The scripts default to a sibling checkout:

```text
parent/
  hushline/
  hushline-agents/
  hushline-social/
```

Set `HUSHLINE_REPO_DIR` when the product checkout is elsewhere.
Set `HUSHLINE_SOCIAL_REPO_DIR` when the social archive/env checkout is elsewhere.
Set `HUSHLINE_SALES_AGENT_DOCS_REPO_DIR` when the docs checkout is elsewhere.

## Development

```bash
python3 -m pip install -e '.[dev]'
make lint
make test
```

## Security

- Never commit credentials, Codex transcripts, private keys, or unsanitized runner logs.
- Runtime logs are stored under `logs/` and ignored by Git.
- The weekly brief runner requires `HUSHLINE_WEEKLY_AGENT_REPORT_FROM` and
  `HUSHLINE_WEEKLY_AGENT_REPORT_TO`.
- The sales contact agent refuses to send unless `HUSHLINE_SALES_AGENT_FROM` is
  exactly `sales@hushline.app`.
- Agent-authored product changes always require human review.

## License

GNU Affero General Public License v3.0. See `LICENSE`.
