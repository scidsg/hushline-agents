#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATE=""
ARCHIVE_KEY=""
ARCHIVE_ROOT="previous-posts"
BRANCH="${HUSHLINE_SOCIAL_ARCHIVE_BRANCH:-main}"
REMOTE="${HUSHLINE_SOCIAL_ARCHIVE_REMOTE:-origin}"
DRY_RUN=0
GITHUB_TOKEN="${HUSHLINE_SOCIAL_GITHUB_TOKEN:-}"
SIGNING_KEY_PUB="${HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE="$2"
        shift 2
        ;;
      --archive-key)
        ARCHIVE_KEY="$2"
        shift 2
        ;;
      --archive-root)
        ARCHIVE_ROOT="$2"
        shift 2
        ;;
      --branch)
        BRANCH="$2"
        shift 2
        ;;
      --remote)
        REMOTE="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./scripts/push_previous_posts_archive.sh --date 2026-03-19
  ./scripts/push_previous_posts_archive.sh --date 2026-03-19 --archive-key 2026-03-19-1

Behavior:
  - stages ARCHIVE_ROOT/<archive-key> only
  - creates one archive commit
  - force-pushes the current HEAD to the configured remote branch with --force-with-lease
EOF
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done

  if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "--date must use YYYY-MM-DD format." >&2
    exit 1
  fi

  if [[ -z "$ARCHIVE_KEY" ]]; then
    ARCHIVE_KEY="$DATE"
  fi

  if [[ ! "$ARCHIVE_KEY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]+)?$ ]]; then
    echo "--archive-key must use YYYY-MM-DD or YYYY-MM-DD-N format." >&2
    exit 1
  fi

  if [[ "$ARCHIVE_KEY" != "$DATE" && "$ARCHIVE_KEY" != "$DATE"-* ]]; then
    echo "--archive-key must start with the requested --date." >&2
    exit 1
  fi

  if [[ -z "$ARCHIVE_ROOT" || "$ARCHIVE_ROOT" == /* || "$ARCHIVE_ROOT" == *".."* ]]; then
    echo "--archive-root must be a relative path inside the repo." >&2
    exit 1
  fi
}

main() {
  parse_args "$@"
  require_cmd git

  local archive_dir="$REPO_DIR/$ARCHIVE_ROOT/$ARCHIVE_KEY"
  local archive_rel="$ARCHIVE_ROOT/$ARCHIVE_KEY"
  local current_branch=""
  local remote_url=""
  local auth_header=""
  local -a git_commit_cmd=(git)
  local -a git_push_cmd=(git)
  if [[ ! -d "$archive_dir" ]]; then
    echo "Archive folder not found: $archive_dir" >&2
    exit 1
  fi

  cd "$REPO_DIR"
  current_branch="$(git branch --show-current)"
  if [[ "$current_branch" != "$BRANCH" ]]; then
    echo "Refusing to push: current branch is '$current_branch', expected '$BRANCH'." >&2
    exit 1
  fi

  remote_url="$(git remote get-url "$REMOTE")"

  if [[ -n "$SIGNING_KEY_PUB" ]]; then
    git_commit_cmd+=(
      -c
      "gpg.format=ssh"
      -c
      "user.signingkey=$SIGNING_KEY_PUB"
      -c
      "commit.gpgsign=true"
    )
  fi

  if [[ -n "$GITHUB_TOKEN" ]]; then
    case "$remote_url" in
      https://github.com/*)
        auth_header="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
        git_push_cmd+=(
          -c
          "credential.helper="
          -c
          "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth_header"
        )
        ;;
      *)
        echo "HUSHLINE_SOCIAL_GITHUB_TOKEN is set, but $REMOTE uses a non-GitHub HTTPS remote: $remote_url" >&2
        exit 1
        ;;
    esac
  fi

  git add -- "$archive_rel"

  if git diff --cached --quiet -- "$archive_rel"; then
    echo "No staged archive changes for $archive_rel."
    exit 0
  fi

  local commit_message="Archive social post for $ARCHIVE_KEY"

  if (( DRY_RUN == 1 )); then
    echo "Dry run: would commit $archive_rel and push HEAD to $REMOTE/$BRANCH with --force-with-lease."
    exit 0
  fi

  "${git_commit_cmd[@]}" commit -m "$commit_message" -- "$archive_rel"
  "${git_push_cmd[@]}" push -u --force-with-lease "$REMOTE" "HEAD:$BRANCH"
}

main "$@"
