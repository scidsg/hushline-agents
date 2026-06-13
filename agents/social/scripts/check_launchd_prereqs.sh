#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
export HUSHLINE_SOCIAL_REPO_DIR="$REPO_DIR"
source "$AGENTS_REPO_DIR/agents/social/scripts/lib/load-launchd-env.sh"
source "$AGENTS_REPO_DIR/agents/social/scripts/lib/social-platforms.sh"
ENV_FILE="$REPO_DIR/.env.launchd"
SCOPE="gui"
OWNER_USER=""
EXIT_CODE=0

fail() {
  echo "ERROR: $*" >&2
  EXIT_CODE=1
}

warn() {
  echo "WARN: $*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing required command: $1"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope)
        SCOPE="$2"
        shift 2
        ;;
      --env-file)
        ENV_FILE="$2"
        shift 2
        ;;
      --owner-user)
        OWNER_USER="$2"
        shift 2
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./agents/social/scripts/check_launchd_prereqs.sh
  ./agents/social/scripts/check_launchd_prereqs.sh --scope daemon
  ./agents/social/scripts/check_launchd_prereqs.sh --env-file /path/to/.env.launchd
  ./agents/social/scripts/check_launchd_prereqs.sh --scope daemon --owner-user runner
EOF
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done

  case "$SCOPE" in
    gui|daemon) ;;
    *)
      echo "--scope must be one of: gui, daemon" >&2
      exit 1
      ;;
  esac

  if [[ "$SCOPE" == "daemon" && -z "$OWNER_USER" && $EUID -eq 0 ]]; then
    OWNER_USER="${SUDO_USER:-${USER:-root}}"
  fi
}

check_repo_paths() {
  local path=""
  for path in \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_whistleblower_news_post_agent_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_hushline_feature_post_agent_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_hushline_verified_user_post_agent_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_daily_planner_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_daily_linkedin_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_weekly_article_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_weekly_article_linkedin_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_verified_user_weekly_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/run_verified_user_weekly_linkedin_launchd.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_social_planner.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_linkedin_publisher.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/agent_daily_mastodon_publisher.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/agent_weekly_verified_user_runner.sh" \
    "$AGENTS_REPO_DIR/agents/social/scripts/agent_weekly_verified_user_linkedin_publisher.sh"; do
    if [[ ! -x "$path" ]]; then
      fail "expected executable agent script: $path"
    fi
  done

  for path in \
    "$AGENTS_REPO_DIR/agents/social/scripts/plan-weekly-article-post.js" \
    "$AGENTS_REPO_DIR/agents/social/scripts/plan-day.js" \
    "$AGENTS_REPO_DIR/agents/social/scripts/publish-daily-linkedin.js" \
    "$AGENTS_REPO_DIR/agents/social/scripts/publish-daily-mastodon.js" \
    "$AGENTS_REPO_DIR/agents/social/scripts/render-verified-user-post.js"; do
    if [[ ! -f "$path" ]]; then
      fail "expected social agent script: $path"
    fi
  done

  mkdir -p "$AGENTS_REPO_DIR/logs/social"
  mkdir -p "$REPO_DIR/logs" "$REPO_DIR/.tmp" "$REPO_DIR/previous-posts" "$REPO_DIR/previous-article-posts" "$REPO_DIR/previous-verified-user-posts"
}

load_env_file() {
  if ! validate_launchd_env_file "$ENV_FILE" "$SCOPE" "$OWNER_USER"; then
    EXIT_CODE=1
    return
  fi

  if ! export_launchd_env_file "$ENV_FILE"; then
    EXIT_CODE=1
  fi
}

check_required_env() {
  local name=""
  for name in LINKEDIN_ACCESS_TOKEN LINKEDIN_AUTHOR_URN; do
    if [[ -z "${!name:-}" ]]; then
      fail "missing required variable in $ENV_FILE: $name"
    fi
  done

  if social_mastodon_enabled; then
    for name in MASTODON_INSTANCE_URL MASTODON_ACCESS_TOKEN; do
      if [[ -z "${!name:-}" ]]; then
        fail "missing required variable in $ENV_FILE when HUSHLINE_SOCIAL_MASTODON_ENABLED=1: $name"
      fi
    done

    case "${MASTODON_INSTANCE_URL:-}" in
      https://*)
        ;;
      *)
        fail "MASTODON_INSTANCE_URL must use https when HUSHLINE_SOCIAL_MASTODON_ENABLED=1"
        ;;
    esac
  fi

  if [[ "$SCOPE" != "daemon" ]]; then
    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
      warn "OPENAI_API_KEY is not set in $ENV_FILE. GUI mode can rely on interactive Codex login, but daemon mode cannot."
    fi
    return
  fi

  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    fail "daemon mode requires OPENAI_API_KEY in $ENV_FILE so Codex can run without an interactive login session"
  fi

  if [[ "${HUSHLINE_SOCIAL_ARCHIVE_PUSH:-1}" != "1" ]]; then
    return
  fi

  if [[ -z "${HUSHLINE_SOCIAL_GITHUB_TOKEN:-}" ]]; then
    fail "daemon mode requires HUSHLINE_SOCIAL_GITHUB_TOKEN in $ENV_FILE for archive pushes over HTTPS"
  fi

  if [[ -z "${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB:-}" ]]; then
    fail "daemon mode requires HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB in $ENV_FILE for signed archive commits"
    return
  fi

  if [[ ! -r "${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB}" ]]; then
    fail "signing public key is not readable: ${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB}"
    return
  fi

  local private_key_path="${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB%.pub}"
  if [[ "$private_key_path" == "${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB}" ]]; then
    fail "HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB should point to a .pub file"
    return
  fi

  if [[ ! -r "$private_key_path" ]]; then
    fail "matching private signing key is not readable: $private_key_path"
  fi
}

check_git_remote() {
  local remote_name="${HUSHLINE_SOCIAL_ARCHIVE_REMOTE:-origin}"
  local remote_url=""

  remote_url="$(git -C "$REPO_DIR" remote get-url "$remote_name" 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    fail "git remote '$remote_name' is not configured"
    return
  fi

  if [[ "$SCOPE" == "daemon" && "${HUSHLINE_SOCIAL_ARCHIVE_PUSH:-1}" == "1" ]]; then
    case "$remote_url" in
      https://github.com/*) ;;
      *)
        fail "daemon mode currently supports archive push automation only with an HTTPS GitHub remote; found $remote_url"
        ;;
    esac
  fi
}

check_headless_signing() {
  if [[ "$SCOPE" != "daemon" || "${HUSHLINE_SOCIAL_ARCHIVE_PUSH:-1}" != "1" || -z "${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB:-}" ]]; then
    return
  fi

  if ! env -u SSH_AUTH_SOCK git -C "$REPO_DIR" \
    -c gpg.format=ssh \
    -c "user.signingkey=${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB}" \
    -c commit.gpgsign=true \
    commit-tree -S HEAD^{tree} -p HEAD -m "launchd signing probe" >/dev/null 2>&1; then
    fail "headless git signing probe failed for HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB=${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB}"
  fi
}

main() {
  parse_args "$@"

  require_cmd bash
  require_cmd codex
  require_cmd curl
  require_cmd git
  require_cmd launchctl
  require_cmd node
  require_cmd plutil
  require_cmd sed
  require_cmd swift

  check_repo_paths
  load_env_file
  check_required_env
  check_git_remote
  check_headless_signing

  if (( EXIT_CODE != 0 )); then
    exit "$EXIT_CODE"
  fi

  echo "Launchd prerequisites look good for scope=$SCOPE"
}

main "$@"
