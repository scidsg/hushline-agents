# AGENTS.md

Social agents support Hush Line's public education and adoption work. All social agent
code and related files live in this folder.

## Scope

- Launchd wrappers, install scripts, plist templates, prereq checks, runner docs, Node
  planners/publishers, templates, media assets, package files, and tests live in this
  folder.
- `scidsg/hushline-social` may be used as the runtime archive/env checkout for
  `previous-posts`, `previous-article-posts`, `previous-verified-user-posts`, logs, and
  `.env.launchd`; it must not own social agent source code.
- Social logs remain local under `logs/social/` and must not be committed.

## Scoped Workflows

- Whistleblower news post agent.
- Hush Line feature post agent.
- Hush Line verified-user post agent.
- Manual daily post launchd wrapper.

Scheduled post agents publish to LinkedIn first and optionally Mastodon second when
enabled by launchd environment.

## Responsibilities

- Keep launchd paths pointed at `agents/social/`.
- Validate plist syntax and shell syntax before PRs.
- Keep environment loading non-executing for untrusted `.env.launchd` values.
- Treat API keys, author URNs, account identifiers, screenshots, generated drafts, and
  local logs as sensitive operational data.
- Do not publish or schedule content autonomously unless the run has explicit maintainer
  approval.

## Validation

- Run `make lint` and `make test` after changes.
- For launchd changes, run `agents/social/scripts/check_launchd_prereqs.sh` manually
  when the local environment is available.
