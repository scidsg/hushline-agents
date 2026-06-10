# Hush Line Social Agents

This repository owns the launchd wrappers, agent shell entrypoints, prereq checks, and
LaunchAgent/LaunchDaemon templates for Hush Line social automation.

The `hushline-social` repository remains the content checkout. It owns the Node planning
and publishing tools, templates, assets, generated archives, and `.env.launchd` secrets
file.

## Repository Layout

Default sibling layout:

```text
parent/
  hushline-agents/
  hushline-social/
  hushline-screenshots/
```

Set `HUSHLINE_SOCIAL_REPO_DIR` when the social checkout is not a sibling of
`hushline-agents`. Set `HUSHLINE_SCREENSHOTS_REPO_DIR` when screenshots are elsewhere.

## Schedules

Default local-time launchd schedules:

- `com.hushline.social.whistleblower-news-post-agent`: daily at 04:00, publishes at a random target between 04:00 and 09:00
- `com.hushline.social.hushline-feature-post-agent`: daily at 04:00, publishes at a random target between 04:00 and 09:00
- `com.hushline.social.hushline-verified-user-post-agent`: Monday through Friday at 04:00, selects one weekday per week, then publishes at a random target between 04:00 and 09:00

The scheduled posting agents plan and publish through one launchd job per content type.
Direct manual runs do not apply randomized timing or weekly weekday selection unless
`HUSHLINE_SOCIAL_RANDOMIZE_POST_WINDOW=1` is set.

## Install

GUI user LaunchAgents:

```bash
./social/scripts/install_launch_agent.sh --scope gui
```

Server LaunchDaemons:

```bash
sudo ./social/scripts/install_launch_agent.sh --scope daemon
```

Prereq check:

```bash
./social/scripts/check_launchd_prereqs.sh --scope gui
./social/scripts/check_launchd_prereqs.sh --scope daemon
```

The installer reads `hushline-social/.env.launchd` by default. Override with
`--env-file /path/to/.env.launchd` or `HUSHLINE_SOCIAL_ENV_FILE`.

For daemon installs, the env file must be mode `600` or stricter and owned by the
target launchd user selected by `sudo`. The prereq checker reads only simple
`KEY=VALUE` or `export KEY=VALUE` entries; shell commands, substitutions, and other
shell syntax are not supported in `.env.launchd`.

## Manual Runs

Use the wrappers so env loading, locking, retries, and repo updates match
scheduled runs:

```bash
./social/scripts/run_whistleblower_news_post_agent_launchd.sh
./social/scripts/run_hushline_feature_post_agent_launchd.sh
./social/scripts/run_hushline_verified_user_post_agent_launchd.sh
```

Date overrides:

```bash
./social/scripts/run_whistleblower_news_post_agent_launchd.sh --date YYYY-MM-DD
./social/scripts/run_hushline_feature_post_agent_launchd.sh --date YYYY-MM-DD
./social/scripts/run_hushline_verified_user_post_agent_launchd.sh --date YYYY-MM-DD
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

- Change launchd schedules, wrapper behavior, agent shell logic, install/prereq logic, and
  social runner docs in this repository.
- Change social post templates, content planning code, LinkedIn publishing code, assets,
  and generated archives in `hushline-social`.
- Do not commit `.env.launchd`, Codex transcripts, access tokens, private keys, or
  unsanitized runtime logs.
