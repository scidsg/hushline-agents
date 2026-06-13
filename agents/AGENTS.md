# AGENTS.md

All agent-owned files in this repository live under `agents/`.

## Scope Rules

- Product agents live in `agents/product/`.
- Social agents live in `agents/social/`.
- Sales agents live in `agents/sales/`.
- Agent code, tests, docs, launchd templates, role prompts, and operating policies must
  stay inside the relevant scope folder.
- Do not create replacement root-level `scripts/`, `docs/`, `tests/`, or `social/`
  folders for agent work.

## Shared Responsibilities

- Treat runner logs, transcripts, credentials, signing keys, tokens, prospect data, and
  operational schedules as sensitive.
- Keep product software changes in `scidsg/hushline`.
- Keep social content source, generated assets, publisher code, and archives in
  `scidsg/hushline-social`.
- Keep this repository focused on agent roles, runner wrappers, deployment templates,
  tests, and operational documentation.
- Prefer narrow, role-scoped changes over broad reorganizations.

## Validation

- Run `make lint` and `make test` before opening a PR.
- Add tests for behavior changes in scripts, launchd templates, sanitizers, reporting,
  or role dispatch logic.
- Keep manual testing instructions in PR descriptions, even when the manual check is
  not applicable.
