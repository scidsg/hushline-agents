#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
source "$AGENTS_REPO_DIR/social/scripts/lib/load-launchd-env.sh"
source "$AGENTS_REPO_DIR/social/scripts/lib/random-post-window.sh"
source "$AGENTS_REPO_DIR/social/scripts/lib/social-platforms.sh"
source "$AGENTS_REPO_DIR/social/scripts/lib/transient-retry.sh"
LOCK_DIR="$REPO_DIR/.tmp/hushline-verified-user-post-agent.lock"
COMBINED_LOG_FILE="${HUSHLINE_SOCIAL_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/social/social-daily.log}"
DATE_OVERRIDE=""

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

setup_log_capture() {
  mkdir -p "$(dirname "$COMBINED_LOG_FILE")"
  exec > >(tee -a "$COMBINED_LOG_FILE")
  exec 2> >(tee -a "$COMBINED_LOG_FILE" >&2)
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE_OVERRIDE="$2"
        shift 2
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./social/scripts/run_hushline_verified_user_post_agent_launchd.sh
  ./social/scripts/run_hushline_verified_user_post_agent_launchd.sh --date 2026-06-10

Behavior:
  - selects one weekday per ISO week for launchd runs
  - builds one verified-user post on that selected weekday
  - waits until a random target in the 04:00-09:00 local post window for launchd runs
  - publishes the archived verified-user post to LinkedIn, plus Mastodon when enabled
EOF
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
}

effective_date() {
  if [[ -n "$DATE_OVERRIDE" ]]; then
    printf '%s\n' "$DATE_OVERRIDE"
    return
  fi

  date +%Y-%m-%d
}

skip_unless_selected_weekday() {
  local target_date=""
  local selected_weekday=""
  local current_weekday=""

  if ! post_window_randomization_enabled; then
    return 0
  fi

  target_date="$(effective_date)"
  selected_weekday="$(selected_weekday_for_week "$target_date")"
  current_weekday="$(weekday_number_for_date "$target_date")"

  if [[ "$current_weekday" != "$selected_weekday" ]]; then
    echo "Skipping verified-user post for $target_date; selected weekday for this week is $selected_weekday."
    exit 0
  fi
}

plan_post() {
  "$AGENTS_REPO_DIR/social/scripts/run_verified_user_weekly_launchd.sh" --date "$(effective_date)"
}

publish_post() {
  local -a linkedin_cmd=(
    "$AGENTS_REPO_DIR/social/scripts/agent_daily_linkedin_publisher.sh"
    --allow-weekend
    --date "$(effective_date)"
    --date-root previous-verified-user-posts
  )

  if social_mastodon_enabled; then
    linkedin_cmd+=(--no-push)
  fi

  "${linkedin_cmd[@]}"

  if social_mastodon_enabled; then
    "$AGENTS_REPO_DIR/social/scripts/agent_daily_mastodon_publisher.sh" \
      --allow-weekend \
      --date "$(effective_date)" \
      --date-root previous-verified-user-posts
  else
    echo "Mastodon publisher disabled; set HUSHLINE_SOCIAL_MASTODON_ENABLED=1 to enable it."
  fi
}

if ! mkdir -p "$REPO_DIR/.tmp"; then
  echo "Failed to create temp directory under $REPO_DIR/.tmp" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "hushline-verified-user-post-agent is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

load_launchd_env_file "$REPO_DIR"
setup_log_capture
parse_args "$@"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting hushline-verified-user-post-agent."

skip_unless_selected_weekday

target_epoch=""
if post_window_randomization_enabled; then
  target_epoch="$(random_post_window_target_epoch "$(effective_date)")"
fi

plan_post
sleep_until_post_window_target "$target_epoch" "verified-user"
run_with_transient_retry "hushline-verified-user-post-agent" publish_post
