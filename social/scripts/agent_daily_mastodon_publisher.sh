#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"

DATE_OVERRIDE=""
ARCHIVE_KEY=""
DATE_ROOT="previous-posts"
DRY_RUN=0
FORCE=0
NO_PUSH=0
ALLOW_WEEKEND=0
VISIBILITY=""

effective_archive_root() {
  printf '%s\n' "${DATE_ROOT#./}"
}

archive_kind_label() {
  local archive_root=""
  archive_root="$(effective_archive_root)"
  case "$archive_root" in
    previous-posts)
      printf '%s\n' "Daily"
      ;;
    previous-verified-user-posts)
      printf '%s\n' "Verified-user"
      ;;
    previous-article-posts)
      printf '%s\n' "Article-share"
      ;;
    *)
      printf '%s\n' "Archive"
      ;;
  esac
}

mastodon_already_published() {
  local publish_date=""
  local archive_key=""
  local archive_root=""
  local archive_label=""
  local remote="${HUSHLINE_SOCIAL_ARCHIVE_REMOTE:-origin}"
  local branch="${HUSHLINE_SOCIAL_ARCHIVE_BRANCH:-main}"
  local archive_path=""
  local remote_ref=""

  if (( FORCE == 1 )); then
    return
  fi

  publish_date="$(effective_date)"
  archive_key="$(effective_archive_key)"
  archive_root="$(effective_archive_root)"
  archive_label="$(archive_kind_label)"
  archive_path="$archive_root/$archive_key/mastodon-publication.json"
  remote_ref="refs/remotes/$remote/$branch"

  if [[ -f "$REPO_DIR/$archive_path" ]]; then
    echo "$archive_label container $archive_key for planned date $publish_date already has a local Mastodon publication record; skipping publish."
    exit 0
  fi

  if ! git -C "$REPO_DIR" fetch --quiet "$remote" "$branch:$remote_ref"; then
    echo "Failed to refresh $remote/$branch before checking Mastodon publication state." >&2
    exit 1
  fi

  if git -C "$REPO_DIR" cat-file -e "${remote}/${branch}:${archive_path}" 2>/dev/null; then
    echo "$archive_label container $archive_key for planned date $publish_date already has a Mastodon publication record on $remote/$branch; skipping publish."
    exit 0
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE_OVERRIDE="$2"
        shift 2
        ;;
      --archive-key)
        ARCHIVE_KEY="$2"
        shift 2
        ;;
      --date-root)
        DATE_ROOT="$2"
        shift 2
        ;;
      --visibility)
        VISIBILITY="$2"
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
      --allow-weekend)
        ALLOW_WEEKEND=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./social/scripts/agent_daily_mastodon_publisher.sh
  ./social/scripts/agent_daily_mastodon_publisher.sh --date 2026-03-18
  ./social/scripts/agent_daily_mastodon_publisher.sh --date 2026-03-18 --archive-key 2026-03-18-1
  ./social/scripts/agent_daily_mastodon_publisher.sh --date 2026-04-01 --date-root previous-article-posts
  ./social/scripts/agent_daily_mastodon_publisher.sh --dry-run

Behavior:
  - Loads the archived social post from the selected archive root
  - Finds the post for today or the supplied date
  - Publishes it to Mastodon
  - Writes mastodon-publication.json
  - Pushes the dated archive folder after successful publication
  - Skips weekends unless --allow-weekend is passed
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

effective_archive_key() {
  if [[ -n "$ARCHIVE_KEY" ]]; then
    printf '%s\n' "$ARCHIVE_KEY"
    return
  fi

  effective_date
}

weekday_number() {
  date -j -f "%Y-%m-%d" "$1" "+%u"
}

skip_if_weekend() {
  if (( ALLOW_WEEKEND == 1 )); then
    return
  fi

  local publish_date=""
  local weekday=""
  publish_date="$(effective_date)"
  weekday="$(weekday_number "$publish_date")"
  if [[ "$weekday" == "6" || "$weekday" == "7" ]]; then
    echo "Skipping daily Mastodon publisher for weekend date $publish_date."
    exit 0
  fi
}

push_archive() {
  if (( NO_PUSH == 1 )) || [[ "${HUSHLINE_SOCIAL_ARCHIVE_PUSH:-1}" != "1" ]]; then
    echo "Archive push skipped."
    return
  fi

  local -a cmd=(
    ./scripts/push_previous_posts_archive.sh
    --date "$(effective_date)"
    --archive-key "$(effective_archive_key)"
    --archive-root "$(effective_archive_root)"
  )
  (cd "$REPO_DIR" && "${cmd[@]}")
}

main() {
  parse_args "$@"
  skip_if_weekend
  mastodon_already_published

  local -a cmd=(node scripts/publish-daily-mastodon.js)
  [[ -n "$DATE_OVERRIDE" ]] && cmd+=(--date "$DATE_OVERRIDE")
  [[ -n "$ARCHIVE_KEY" ]] && cmd+=(--archive-key "$ARCHIVE_KEY")
  [[ -n "$DATE_ROOT" ]] && cmd+=(--date-root "$DATE_ROOT")
  [[ -n "$VISIBILITY" ]] && cmd+=(--visibility "$VISIBILITY")
  (( ALLOW_WEEKEND == 1 )) && cmd+=(--allow-weekend)
  (( DRY_RUN == 1 )) && cmd+=(--dry-run)
  (( FORCE == 1 )) && cmd+=(--force)

  (cd "$REPO_DIR" && "${cmd[@]}")

  if (( DRY_RUN == 0 )); then
    push_archive
  fi
}

main "$@"
