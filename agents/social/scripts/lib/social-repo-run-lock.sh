#!/usr/bin/env bash

social_repo_lock_timeout_seconds() {
  local timeout="${HUSHLINE_SOCIAL_REPO_LOCK_TIMEOUT_SECONDS:-3600}"
  if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]]; then
    echo "HUSHLINE_SOCIAL_REPO_LOCK_TIMEOUT_SECONDS must be a positive integer." >&2
    return 1
  fi
  printf '%s\n' "$timeout"
}

with_social_repo_run_lock() (
  local repo_dir="$1"
  local run_label="$2"
  shift 2

  local lock_dir="$repo_dir/.tmp/social-repo-run.lock"
  local lock_pid_file="$lock_dir/pid"
  local timeout=""
  local deadline=0
  local announced_wait=0
  local owner_pid=""
  local stale_lock_dir=""

  timeout="$(social_repo_lock_timeout_seconds)" || return $?
  deadline=$((SECONDS + timeout))
  mkdir -p "$repo_dir/.tmp"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    owner_pid=""
    if [[ -f "$lock_pid_file" ]]; then
      owner_pid="$(tr -cd '0-9' < "$lock_pid_file")"
    fi
    if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
      stale_lock_dir="${lock_dir}.stale.$$"
      if mv "$lock_dir" "$stale_lock_dir" 2>/dev/null; then
        rm -f "$stale_lock_dir/pid"
        rmdir "$stale_lock_dir"
        echo "Recovered a stale shared social repository lock owned by process ${owner_pid}."
        continue
      fi
    fi

    if (( announced_wait == 0 )); then
      echo "Waiting for the shared social repository lock before ${run_label}."
      announced_wait=1
    fi
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting ${timeout} seconds for the shared social repository lock before ${run_label}." >&2
      return 1
    fi
    sleep 1
  done

  printf '%s\n' "$$" > "$lock_pid_file"

  cleanup_social_repo_run_lock() {
    rm -f "$lock_pid_file"
    rmdir "$lock_dir" 2>/dev/null || true
  }
  trap cleanup_social_repo_run_lock EXIT

  echo "Acquired the shared social repository lock for ${run_label}."
  "$@"
)
