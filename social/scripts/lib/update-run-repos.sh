#!/usr/bin/env bash

resolve_screenshots_repo_dir() {
  local repo_dir="$1"
  local parent_dir=""
  if [[ -n "${HUSHLINE_SCREENSHOTS_REPO_DIR:-}" ]]; then
    printf '%s\n' "$HUSHLINE_SCREENSHOTS_REPO_DIR"
    return
  fi

  parent_dir="$(
    cd "$repo_dir/.." &&
      pwd
  )"
  printf '%s\n' "$parent_dir/hushline-screenshots"
}

ensure_git_checkout() {
  local repo_dir="$1"
  local label="$2"

  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Missing git checkout for ${label}: $repo_dir" >&2
    return 1
  fi
}

update_git_checkout() {
  local repo_dir="$1"
  local label="$2"
  local auto_git_pull="$3"
  local auto_git_clean="$4"

  ensure_git_checkout "$repo_dir" "$label"

  if [[ "$auto_git_pull" != "1" ]]; then
    echo "Automatic git pull skipped for ${label}."
    return
  fi

  if [[ "$auto_git_clean" == "1" ]]; then
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
  local repo_dir="$1"
  local auto_git_pull="$2"
  local auto_git_clean="$3"
  local screenshots_repo_dir=""
  local rc=0

  screenshots_repo_dir="$(resolve_screenshots_repo_dir "$repo_dir")"

  update_git_checkout "$repo_dir" "hushline-social" "$auto_git_pull" "$auto_git_clean" || rc=1
  update_git_checkout "$screenshots_repo_dir" "hushline-screenshots" "$auto_git_pull" "$auto_git_clean" || rc=1

  return "$rc"
}
