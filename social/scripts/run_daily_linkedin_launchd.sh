#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
source "$AGENTS_REPO_DIR/social/scripts/lib/load-launchd-env.sh"
source "$AGENTS_REPO_DIR/social/scripts/lib/transient-retry.sh"
LOCK_DIR="$REPO_DIR/.tmp/daily-linkedin.lock"
ENV_FILE=""
COMBINED_LOG_FILE="${HUSHLINE_SOCIAL_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/social/social-daily.log}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

setup_log_capture() {
  mkdir -p "$(dirname "$COMBINED_LOG_FILE")"
  exec > >(tee -a "$COMBINED_LOG_FILE")
  exec 2> >(tee -a "$COMBINED_LOG_FILE" >&2)
}

effective_date() {
  local previous=""
  local arg=""

  for arg in "$@"; do
    if [[ "$previous" == "--date" ]]; then
      printf '%s\n' "$arg"
      return
    fi
    previous="$arg"
  done

  date +%Y-%m-%d
}

weekday_number() {
  date -j -f "%Y-%m-%d" "$1" "+%u"
}

skip_if_weekend() {
  local target_date=""
  local weekday=""
  target_date="$(effective_date "$@")"
  weekday="$(weekday_number "$target_date")"
  if [[ "$weekday" == "6" || "$weekday" == "7" ]]; then
    echo "Skipping daily LinkedIn publisher for weekend date $target_date."
    exit 0
  fi
}

effective_archive_key() {
  local previous=""
  local arg=""

  for arg in "$@"; do
    if [[ "$previous" == "--archive-key" ]]; then
      printf '%s\n' "$arg"
      return
    fi
    previous="$arg"
  done

  effective_date "$@"
}

wait_for_daily_archive() {
  local archive_key=""
  local archive_post_path=""
  local attempt=1
  local interval_seconds=""
  local max_attempts=""

  archive_key="$(effective_archive_key "$@")"
  archive_post_path="$REPO_DIR/previous-posts/$archive_key/post.json"
  interval_seconds="$(transient_retry_interval_seconds)"
  max_attempts="$(transient_retry_max_attempts)"

  while (( attempt <= max_attempts )); do
    if [[ -f "$archive_post_path" ]]; then
      return 0
    fi

    if (( attempt >= max_attempts )); then
      echo "Archived daily post not found after $max_attempts attempts: $archive_post_path" >&2
      return 1
    fi

    echo "Archived daily post is not ready yet: $archive_post_path"
    echo "Retrying daily LinkedIn publish in $interval_seconds seconds (${attempt}/${max_attempts})."
    sleep "$interval_seconds"
    attempt=$((attempt + 1))
  done
}

run_daily_linkedin_publisher() {
  cd "$REPO_DIR"
  "$AGENTS_REPO_DIR/social/scripts/agent_daily_linkedin_publisher.sh" "$@"
}

if ! mkdir -p "$REPO_DIR/.tmp"; then
  echo "Failed to create temp directory under $REPO_DIR/.tmp" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Daily LinkedIn publisher is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

load_launchd_env_file "$REPO_DIR"
ENV_FILE="$HUSHLINE_SOCIAL_ENV_FILE"

setup_log_capture
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting daily LinkedIn publisher wrapper."

skip_if_weekend "$@"
wait_for_daily_archive "$@"

run_with_transient_retry \
  "Daily LinkedIn publisher" \
  run_daily_linkedin_publisher \
  "$@"
