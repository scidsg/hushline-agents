#!/usr/bin/env bash

ensure_git_checkout() {
  local repo_dir="$1"
  local label="$2"

  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Missing git checkout for ${label}: $repo_dir" >&2
    return 1
  fi
}

unarchived_publication_records() {
  local repo_dir="$1"
  local relative_path=""

  {
    git -C "$repo_dir" diff --name-only HEAD -- \
      previous-posts \
      previous-article-posts \
      previous-verified-user-posts
    git -C "$repo_dir" ls-files --others --exclude-standard -- \
      previous-posts \
      previous-article-posts \
      previous-verified-user-posts
  } | sort -u | while IFS= read -r relative_path; do
    case "$relative_path" in
      previous-posts/*/*-publication.json|\
      previous-article-posts/*/*-publication.json|\
      previous-verified-user-posts/*/*-publication.json)
        printf '%s\n' "$relative_path"
        ;;
    esac
  done
}

protect_unarchived_publications() {
  local repo_dir="$1"
  local label="$2"
  local records=""

  records="$(unarchived_publication_records "$repo_dir")"
  if [[ -z "$records" ]]; then
    return
  fi

  echo "Refusing to clean ${label}; publication records have not been archived:" >&2
  printf '%s\n' "$records" >&2
  echo "Archive these records before another scheduled run so published-post history is not lost." >&2
  return 1
}

update_git_checkout() {
  local repo_dir="$1"
  local label="$2"
  local auto_git_pull="$3"
  local auto_git_clean="$4"

  ensure_git_checkout "$repo_dir" "$label" || return $?

  if [[ "$auto_git_pull" != "1" ]]; then
    echo "Automatic git pull skipped for ${label}."
    return
  fi

  if [[ "$auto_git_clean" == "1" ]]; then
    protect_unarchived_publications "$repo_dir" "$label" || return $?
    echo "Resetting tracked changes in ${label}."
    git -C "$repo_dir" reset --hard HEAD
    echo "Removing untracked files in ${label}."
    git -C "$repo_dir" clean -fd
  else
    if ! git -C "$repo_dir" diff --quiet --ignore-submodules HEAD --; then
      echo "Refusing to git pull with unstaged tracked changes in ${label}: $repo_dir" >&2
      return 1
    fi

    if ! git -C "$repo_dir" diff --cached --quiet --ignore-submodules --; then
      echo "Refusing to git pull with staged changes in ${label}: $repo_dir" >&2
      return 1
    fi

    if [[ -n "$(git -C "$repo_dir" ls-files --others --exclude-standard)" ]]; then
      echo "Refusing to git pull with untracked files in ${label}: $repo_dir" >&2
      return 1
    fi
  fi

  echo "Running git pull --ff-only for ${label}."
  git -C "$repo_dir" pull --ff-only
}

update_daily_planning_repos() {
  update_git_checkout "$1" "hushline-social" "$2" "$3"
}
