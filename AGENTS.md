# AGENTS.md

This repository contains Hush Line's code-agent, social-agent, and runner automation.

## Safety

- Treat GitHub credentials, Codex authentication, signing keys, transcripts, and runner logs as
  sensitive.
- Never commit secrets or unsanitized local logs.
- Keep product changes in the target `scidsg/hushline` repository.
- Keep social content templates, assets, generated archives, and Node publisher/planner
  code in `scidsg/hushline-social`.
- Keep launchd schedules, runner wrappers, agent shell entrypoints, install scripts, and
  runner operations docs in this repository.
- Do not weaken signed-commit, branch-protection, dependency-audit, or human-review requirements.
- Only approved models documented by the Hush Line project may author production changes.

## Commands

- Lint: `make lint`
- Test: `make test`

## Pull Requests

- Use signed commits.
- Explain behavioral and operational impact.
- Include validation and manual testing steps.
- Keep runner behavior changes covered by tests.
