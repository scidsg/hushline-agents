#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
source "$AGENTS_REPO_DIR/social/scripts/lib/load-launchd-env.sh"
LOCK_DIR="$REPO_DIR/.tmp/weekly-article.lock"
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

skip_unless_wednesday() {
  local target_date=""
  local weekday=""
  target_date="$(effective_date "$@")"
  weekday="$(weekday_number "$target_date")"
  if [[ "$weekday" != "3" ]]; then
    echo "Skipping weekly article planner for non-Wednesday date $target_date."
    exit 0
  fi
}

if ! mkdir -p "$REPO_DIR/.tmp"; then
  echo "Failed to create temp directory under $REPO_DIR/.tmp" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Weekly article planner is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

load_launchd_env_file "$REPO_DIR"

setup_log_capture
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting weekly article planner wrapper."

skip_unless_wednesday "$@"

cd "$REPO_DIR"
node scripts/plan-weekly-article-post.js "$@"
