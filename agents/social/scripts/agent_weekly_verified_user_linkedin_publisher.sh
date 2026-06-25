#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
export HUSHLINE_SOCIAL_REPO_DIR="$REPO_DIR"

DATE_OVERRIDE=""
DRY_RUN=0
FORCE=0
NO_PUSH=0
WAIT_SECONDS="${HUSHLINE_SOCIAL_VERIFIED_USER_PUBLISH_WAIT_SECONDS:-600}"
WAIT_INTERVAL_SECONDS="${HUSHLINE_SOCIAL_VERIFIED_USER_PUBLISH_WAIT_INTERVAL_SECONDS:-5}"

require_positive_integer() {
  local value="$1"
  local name="$2"

  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value <= 0 )); then
    echo "$name must be a positive integer; got: $value" >&2
    exit 1
  fi
}

linkedin_already_published() {
  local publish_date=""
  local remote="${HUSHLINE_SOCIAL_ARCHIVE_REMOTE:-origin}"
  local branch="${HUSHLINE_SOCIAL_ARCHIVE_BRANCH:-main}"
  local archive_path=""
  local remote_ref=""

  if (( FORCE == 1 )); then
    return
  fi

  publish_date="$(effective_date)"
  archive_path="previous-verified-user-posts/$publish_date/linkedin-publication.json"
  remote_ref="refs/remotes/$remote/$branch"

  if ! git -C "$REPO_DIR" fetch --quiet "$remote" "$branch:$remote_ref"; then
    echo "Failed to refresh $remote/$branch before checking verified-user publication state." >&2
    exit 1
  fi

  if git -C "$REPO_DIR" cat-file -e "${remote}/${branch}:${archive_path}" 2>/dev/null; then
    echo "Verified-user archive for $publish_date already has a LinkedIn publication record on $remote/$branch; skipping publish."
    exit 0
  fi
}

sync_remote_archive_files() {
  local publish_date=""
  local remote="${HUSHLINE_SOCIAL_ARCHIVE_REMOTE:-origin}"
  local branch="${HUSHLINE_SOCIAL_ARCHIVE_BRANCH:-main}"
  local remote_ref=""
  local archive_path=""
  local archive_file=""
  local -a archive_files=()

  publish_date="$(effective_date)"
  remote_ref="refs/remotes/$remote/$branch"
  archive_files=(
    "previous-verified-user-posts/$publish_date/post.json"
    "previous-verified-user-posts/$publish_date/social-card@2x.png"
  )

  if ! git -C "$REPO_DIR" fetch --quiet "$remote" "$branch:$remote_ref"; then
    return
  fi

  for archive_path in "${archive_files[@]}"; do
    if git -C "$REPO_DIR" cat-file -e "${remote}/${branch}:${archive_path}" 2>/dev/null; then
      archive_file="$REPO_DIR/$archive_path"
      mkdir -p "$(dirname "$archive_file")"
      git -C "$REPO_DIR" checkout --quiet "${remote}/${branch}" -- "$archive_path"
    fi
  done
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE_OVERRIDE="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --force)
        FORCE=1
        shift
        ;;
      --no-push)
        NO_PUSH=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./agents/social/scripts/agent_weekly_verified_user_linkedin_publisher.sh
  ./agents/social/scripts/agent_weekly_verified_user_linkedin_publisher.sh --date 2026-03-30
  ./agents/social/scripts/agent_weekly_verified_user_linkedin_publisher.sh --dry-run

Behavior:
  - Loads the archived weekly verified-user post from previous-verified-user-posts/YYYY-MM-DD
  - Publishes it to LinkedIn
  - Treats the pushed dated folder as the publication-state record across machines
  - Pushes the weekly archive folder after a successful publish
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

wait_for_archive() {
  local publish_date=""
  local archive_dir=""
  local post_path=""
  local image_path=""
  local elapsed=0

  publish_date="$(effective_date)"
  archive_dir="$REPO_DIR/previous-verified-user-posts/$publish_date"
  post_path="$archive_dir/post.json"
  image_path="$archive_dir/social-card@2x.png"

  while [[ ! -f "$post_path" || ! -f "$image_path" ]]; do
    sync_remote_archive_files
    if [[ -f "$post_path" && -f "$image_path" ]]; then
      break
    fi

    if (( elapsed >= WAIT_SECONDS )); then
      echo "Timed out waiting for verified-user archive files for $publish_date." >&2
      echo "Expected: $post_path and $image_path" >&2
      exit 1
    fi

    if (( elapsed == 0 )); then
      echo "Waiting for verified-user archive files for $publish_date..."
    fi

    sleep "$WAIT_INTERVAL_SECONDS"
    elapsed=$((elapsed + WAIT_INTERVAL_SECONDS))
  done
}

push_archive() {
  if (( NO_PUSH == 1 )) || [[ "${HUSHLINE_SOCIAL_ARCHIVE_PUSH:-1}" != "1" ]]; then
    echo "Archive push skipped."
    return
  fi

  (cd "$REPO_DIR" && "$AGENTS_REPO_DIR/agents/social/scripts/push_previous_posts_archive.sh" --date "$(effective_date)" --archive-root previous-verified-user-posts)
}

main() {
  parse_args "$@"
  require_positive_integer "$WAIT_SECONDS" "HUSHLINE_SOCIAL_VERIFIED_USER_PUBLISH_WAIT_SECONDS"
  require_positive_integer "$WAIT_INTERVAL_SECONDS" "HUSHLINE_SOCIAL_VERIFIED_USER_PUBLISH_WAIT_INTERVAL_SECONDS"
  linkedin_already_published
  wait_for_archive

  local -a cmd=(node "$AGENTS_REPO_DIR/agents/social/scripts/publish-daily-linkedin.js" --date-root previous-verified-user-posts --allow-weekend)
  [[ -n "$DATE_OVERRIDE" ]] && cmd+=(--date "$DATE_OVERRIDE")
  (( DRY_RUN == 1 )) && cmd+=(--dry-run)
  (( FORCE == 1 )) && cmd+=(--force)

  (cd "$REPO_DIR" && "${cmd[@]}")

  if (( DRY_RUN == 0 )); then
    push_archive
  fi
}

main "$@"
