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

- `com.hushline.social.daily-planner`: 06:00, Monday through Friday
- `com.hushline.social.linkedin.daily`: 06:10, Monday through Friday
- `com.hushline.social.weekly-article`: 11:50 every Wednesday
- `com.hushline.social.linkedin.weekly-article`: 12:00 every Wednesday
- `com.hushline.social.verified-user.weekly`: 12:00 every Monday
- `com.hushline.social.linkedin.verified-user.weekly`: 12:10 every Monday

Weekend dates are skipped by the daily planner and daily LinkedIn publisher.
Verified-user jobs are scheduled for Monday, but manual runs accept explicit dates.

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

## Manual Runs

Use the wrappers so env loading, locking, weekend guards, retries, and repo updates match
scheduled runs:

```bash
./social/scripts/run_daily_planner_launchd.sh
./social/scripts/run_daily_linkedin_launchd.sh
./social/scripts/run_weekly_article_launchd.sh
./social/scripts/run_weekly_article_linkedin_launchd.sh
./social/scripts/run_verified_user_weekly_launchd.sh
./social/scripts/run_verified_user_weekly_linkedin_launchd.sh
```

Date overrides:

```bash
./social/scripts/run_daily_planner_launchd.sh --date YYYY-MM-DD
./social/scripts/run_daily_linkedin_launchd.sh --date YYYY-MM-DD
./social/scripts/run_weekly_article_launchd.sh --date YYYY-MM-DD
./social/scripts/run_weekly_article_linkedin_launchd.sh --date YYYY-MM-DD
./social/scripts/run_verified_user_weekly_launchd.sh --date YYYY-MM-DD
./social/scripts/run_verified_user_weekly_linkedin_launchd.sh --date YYYY-MM-DD
```

Manual daily plan-and-publish flow:

```bash
./social/scripts/run_manual_daily_post_launchd.sh --date YYYY-MM-DD
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
