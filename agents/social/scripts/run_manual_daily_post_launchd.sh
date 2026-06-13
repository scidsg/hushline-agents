#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
export HUSHLINE_SOCIAL_REPO_DIR="$REPO_DIR"
source "$AGENTS_REPO_DIR/agents/social/scripts/lib/load-launchd-env.sh"
source "$AGENTS_REPO_DIR/agents/social/scripts/lib/social-platforms.sh"
source "$AGENTS_REPO_DIR/agents/social/scripts/lib/update-run-repos.sh"
LOCK_DIR="$REPO_DIR/.tmp/manual-daily-post.lock"
ENV_FILE=""
COMBINED_LOG_FILE="${HUSHLINE_SOCIAL_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/social/social-daily.log}"
AUTO_GIT_PULL="${HUSHLINE_SOCIAL_GIT_PULL:-1}"
AUTO_GIT_CLEAN="${HUSHLINE_SOCIAL_GIT_CLEAN:-1}"
DATE_OVERRIDE=""
ARCHIVE_KEY=""

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
  ./agents/social/scripts/run_manual_daily_post_launchd.sh
  ./agents/social/scripts/run_manual_daily_post_launchd.sh --date 2026-03-26

Behavior:
  - loads launchd-style env from .env.launchd
  - updates hushline-social and ../hushline-screenshots like the scheduled planner wrapper
  - chooses the next available daily archive container for the requested date
  - runs the daily planner for that archive container
  - publishes the rendered result to LinkedIn, plus Mastodon when enabled
  - pushes that dated archive container after all enabled network publishers succeed
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

weekday_number() {
  date -j -f "%Y-%m-%d" "$1" "+%u"
}

skip_if_weekend() {
  local target_date=""
  local weekday=""
  target_date="$(effective_date)"
  weekday="$(weekday_number "$target_date")"
  if [[ "$weekday" == "6" || "$weekday" == "7" ]]; then
    echo "Skipping manual daily post flow for weekend date $target_date."
    exit 0
  fi
}

update_repo() {
  update_daily_planning_repos "$REPO_DIR" "$AUTO_GIT_PULL" "$AUTO_GIT_CLEAN"
}

resolve_next_archive_key() {
  local target_date="$1"
  local archive_root="$REPO_DIR/previous-posts"
  local max_suffix=-1
  local path=""
  local name=""
  local suffix=0

  for path in "$archive_root/$target_date" "$archive_root/$target_date"-*; do
    [[ -d "$path" ]] || continue
    name="$(basename "$path")"

    if [[ "$name" == "$target_date" ]]; then
      (( max_suffix < 0 )) && max_suffix=0
      continue
    fi

    if [[ "$name" =~ ^${target_date}-([0-9]+)$ ]]; then
      suffix="${BASH_REMATCH[1]}"
      if (( suffix > max_suffix )); then
        max_suffix="$suffix"
      fi
    fi
  done

  if (( max_suffix < 0 )); then
    ARCHIVE_KEY="$target_date"
    return
  fi

  ARCHIVE_KEY="$target_date-$((max_suffix + 1))"
}

if ! mkdir -p "$REPO_DIR/.tmp"; then
  echo "Failed to create temp directory under $REPO_DIR/.tmp" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Manual daily post flow is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

load_launchd_env_file "$REPO_DIR"
ENV_FILE="$HUSHLINE_SOCIAL_ENV_FILE"

setup_log_capture
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting manual daily post wrapper."

parse_args "$@"
skip_if_weekend
update_repo
resolve_next_archive_key "$(effective_date)"

echo "Selected archive container: $ARCHIVE_KEY"

cd "$REPO_DIR"
"$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_social_planner.sh" --date "$(effective_date)" --archive-key "$ARCHIVE_KEY"
linkedin_cmd=(
  "$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_linkedin_publisher.sh"
  --date "$(effective_date)"
  --archive-key "$ARCHIVE_KEY"
)

if social_mastodon_enabled; then
  linkedin_cmd+=(--no-push)
fi

"${linkedin_cmd[@]}"

if social_mastodon_enabled; then
  "$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_mastodon_publisher.sh" \
    --date "$(effective_date)" \
    --archive-key "$ARCHIVE_KEY"
else
  echo "Mastodon publisher disabled; set HUSHLINE_SOCIAL_MASTODON_ENABLED=1 to enable it."
fi
