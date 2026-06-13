# AGENTS.md

This repository contains Hush Line's role-based agents and the operational files those
agents own. All agent-related files belong under `agents/`.

## Layout

- `agents/AGENTS.md`: shared instructions for every agent scope.
- `agents/product/`: product-facing agents and automation.
- `agents/product/code/`: issue implementation runner, bootstrap helper, log sanitizer,
  code-agent docs, and tests.
- `agents/social/`: social agent package, launchd wrappers, Node planners/publishers,
  templates, assets, deploy templates, docs, and tests.
- `agents/product/reporting/`: weekly local runner reporting.
- `agents/sales/`: sales role agents and operating guidance.

Do not add new root-level `scripts/`, `docs/`, `tests/`, or `social/` trees for
agent-owned assets. Place new agent files in the narrowest matching `agents/<scope>/`
folder and add or update an `AGENTS.md` there when scope-specific rules are needed.

## Safety

- Treat GitHub credentials, Codex authentication, signing keys, transcripts, and runner logs as
  sensitive.
- Never commit secrets or unsanitized local logs.
- Keep product changes in the target `scidsg/hushline` repository.
- Keep social agent code, templates, tests, package files, and deploy templates in this
  repository under `agents/social/`.
- Use `scidsg/hushline-social` only as a runtime archive/env checkout, not as an agent
  source-code repository.
- Keep launchd schedules, runner wrappers, agent shell entrypoints, install scripts, and
  runner operations docs in this repository.
- Do not weaken signed-commit, branch-protection, dependency-audit, or human-review requirements.
- Only approved models documented by the Hush Line project may author production changes.
- Role agents may draft recommendations and artifacts, but human maintainers own final
  approval, publication, outreach, and merge decisions unless an explicit operating
  policy says otherwise.

## Commands

- Lint: `make lint`
- Test: `make test`

## Pull Requests

- Use signed commits.
- Explain behavioral and operational impact.
- Include validation and manual testing steps.
- Keep runner behavior changes covered by tests.
