#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
source "$AGENTS_REPO_DIR/social/scripts/lib/load-launchd-env.sh"
LOCK_DIR="$REPO_DIR/.tmp/verified-user-weekly.lock"
ENV_FILE=""
COMBINED_LOG_FILE="${HUSHLINE_SOCIAL_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/social/social-daily.log}"
AUTO_GIT_PULL="${HUSHLINE_SOCIAL_GIT_PULL:-1}"
AUTO_GIT_CLEAN="${HUSHLINE_SOCIAL_GIT_CLEAN:-1}"

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

update_repo() {
  if [[ "$AUTO_GIT_PULL" != "1" ]]; then
    echo "Automatic git pull skipped."
    return
  fi

  if [[ "$AUTO_GIT_CLEAN" == "1" ]]; then
    echo "Resetting tracked changes before weekly verified-user run."
    git -C "$REPO_DIR" reset --hard HEAD
    echo "Removing untracked files before weekly verified-user run."
    git -C "$REPO_DIR" clean -fd
  else
    if ! git -C "$REPO_DIR" diff --quiet --ignore-submodules HEAD --; then
      echo "Refusing to git pull with unstaged tracked changes in $REPO_DIR." >&2
      exit 1
    fi

    if ! git -C "$REPO_DIR" diff --cached --quiet --ignore-submodules --; then
      echo "Refusing to git pull with staged changes in $REPO_DIR." >&2
      exit 1
    fi

    if [[ -n "$(git -C "$REPO_DIR" ls-files --others --exclude-standard)" ]]; then
      echo "Refusing to git pull with untracked files in $REPO_DIR." >&2
      exit 1
    fi
  fi

  echo "Running git pull --ff-only before weekly verified-user run."
  git -C "$REPO_DIR" pull --ff-only
}

if ! mkdir -p "$REPO_DIR/.tmp"; then
  echo "Failed to create temp directory under $REPO_DIR/.tmp" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Verified-user weekly runner is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

load_launchd_env_file "$REPO_DIR"
ENV_FILE="$HUSHLINE_SOCIAL_ENV_FILE"

setup_log_capture
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting verified-user weekly wrapper."

update_repo

cd "$REPO_DIR"
"$AGENTS_REPO_DIR/social/scripts/agent_weekly_verified_user_runner.sh" "$@"
