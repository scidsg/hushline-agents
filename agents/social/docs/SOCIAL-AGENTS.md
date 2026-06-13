# Hush Line Social Agents

This repository owns the complete Hush Line social agent implementation: launchd
wrappers, agent shell entrypoints, Node planners/publishers, rendering libraries,
templates, assets, prereq checks, package files, tests, and LaunchAgent/LaunchDaemon
templates.

The `hushline-social` repository is only the runtime archive/env checkout. It may contain
generated archives and `.env.launchd`, but it must not own agent source code.

## Repository Layout

Default sibling layout:

```text
parent/
  hushline-agents/
  hushline-social/
  hushline-screenshots/
```

Set `HUSHLINE_SOCIAL_REPO_DIR` when the social archive/env checkout is not a sibling of
`hushline-agents`. Set `HUSHLINE_SCREENSHOTS_REPO_DIR` when screenshots are elsewhere.

## Schedules

Default local-time launchd schedules:

- `com.hushline.social.whistleblower-news-post-agent`: daily at 04:00, publishes at a random target between 04:00 and 09:00
- `com.hushline.social.hushline-feature-post-agent`: daily at 04:00, publishes at a random target between 04:00 and 09:00
- `com.hushline.social.hushline-verified-user-post-agent`: Monday through Friday at 04:00, selects one weekday per week, then publishes at a random target between 04:00 and 09:00

The scheduled posting agents plan and publish through one launchd job per content type.
Direct manual runs do not apply randomized timing or weekly weekday selection unless
`HUSHLINE_SOCIAL_RANDOMIZE_POST_WINDOW=1` is set.

LinkedIn is always published first. Mastodon is an optional second target; enable it
with `HUSHLINE_SOCIAL_MASTODON_ENABLED=1`, `MASTODON_INSTANCE_URL`, and
`MASTODON_ACCESS_TOKEN` in the launchd env file.

## Install

GUI user LaunchAgents:

```bash
./agents/social/scripts/install_launch_agent.sh --scope gui
```

Server LaunchDaemons:

```bash
sudo ./agents/social/scripts/install_launch_agent.sh --scope daemon
```

Prereq check:

```bash
./agents/social/scripts/check_launchd_prereqs.sh --scope gui
./agents/social/scripts/check_launchd_prereqs.sh --scope daemon
```

The installer reads `hushline-social/.env.launchd` by default. Override with
`--env-file /path/to/.env.launchd` or `HUSHLINE_SOCIAL_ENV_FILE`.

For daemon installs, the env file must be mode `600` or stricter and owned by the
target launchd user selected by `sudo`. The prereq checker reads only simple
`KEY=VALUE` or `export KEY=VALUE` entries; shell commands, substitutions, and other
shell syntax are not supported in `.env.launchd`.

Required publishing env:

- `LINKEDIN_ACCESS_TOKEN`
- `LINKEDIN_AUTHOR_URN`

Optional Mastodon publishing env:

- `HUSHLINE_SOCIAL_MASTODON_ENABLED=1`
- `MASTODON_INSTANCE_URL` using `https://`
- `MASTODON_ACCESS_TOKEN`
- `MASTODON_VISIBILITY` set to `public`, `unlisted`, `private`, or `direct`; defaults to `public`

## Manual Runs

Use the wrappers so env loading, locking, retries, and repo updates match
scheduled runs:

```bash
./agents/social/scripts/run_whistleblower_news_post_agent_launchd.sh
./agents/social/scripts/run_hushline_feature_post_agent_launchd.sh
./agents/social/scripts/run_hushline_verified_user_post_agent_launchd.sh
```

Date overrides:

```bash
./agents/social/scripts/run_whistleblower_news_post_agent_launchd.sh --date YYYY-MM-DD
./agents/social/scripts/run_hushline_feature_post_agent_launchd.sh --date YYYY-MM-DD
./agents/social/scripts/run_hushline_verified_user_post_agent_launchd.sh --date YYYY-MM-DD
```

Manual daily plan-and-publish flow:

```bash
./agents/social/scripts/run_manual_daily_post_launchd.sh --date YYYY-MM-DD
```

## Logs

Launchd stdout and stderr logs are written under:

```text
hushline-agents/logs/social/
```

The combined wrapper log defaults to:

```text
hushline-agents/logs/social/social-daily.log
```

## Boundaries

- Change all social agent code, templates, package files, tests, deploy templates, and
  social runner docs in this repository.
- Keep generated archives in the configured social archive checkout unless a workflow
  explicitly writes them elsewhere.
- Do not commit `.env.launchd`, Codex transcripts, access tokens, private keys, or
  unsanitized runtime logs.
