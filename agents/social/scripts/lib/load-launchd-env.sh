#!/usr/bin/env bash

launchd_env_trim() {
  local value="$1"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

launchd_env_strip_quotes() {
  local value="$1"
  local first=""
  local last=""

  if (( ${#value} >= 2 )); then
    first="${value:0:1}"
    last="${value: -1}"
    if [[ ( "$first" == "'" && "$last" == "'" ) || ( "$first" == '"' && "$last" == '"' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

launchd_env_file_mode() {
  local env_file="$1"
  local mode=""

  mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || true)"
  if [[ "$mode" =~ ^[0-7]+$ ]]; then
    printf '%s\n' "$mode"
    return
  fi

  mode="$(stat -c '%a' "$env_file" 2>/dev/null || true)"
  if [[ "$mode" =~ ^[0-7]+$ ]]; then
    printf '%s\n' "$mode"
  fi
}

launchd_env_file_uid() {
  local env_file="$1"
  local uid=""

  uid="$(stat -f '%u' "$env_file" 2>/dev/null || true)"
  if [[ "$uid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$uid"
    return
  fi

  uid="$(stat -c '%u' "$env_file" 2>/dev/null || true)"
  if [[ "$uid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$uid"
  fi
}

validate_launchd_env_file() {
  local env_file="$1"
  local scope="${2:-gui}"
  local owner_user="${3:-}"
  local env_mode=""
  local env_uid=""
  local owner_uid=""

  if [[ ! -f "$env_file" ]]; then
    echo "Error: missing env file: $env_file" >&2
    return 1
  fi

  if [[ ! -r "$env_file" ]]; then
    echo "Error: env file is not readable: $env_file" >&2
    return 1
  fi

  env_mode="$(launchd_env_file_mode "$env_file")"
  if [[ -n "$env_mode" ]] && (( 10#$env_mode > 600 )); then
    echo "Error: $env_file should be mode 600 or stricter; found $env_mode" >&2
    return 1
  fi

  if [[ "$scope" != "daemon" || -z "$owner_user" ]]; then
    return 0
  fi

  owner_uid="$(id -u "$owner_user" 2>/dev/null || true)"
  if [[ -z "$owner_uid" ]]; then
    echo "Error: expected daemon env file owner does not exist: $owner_user" >&2
    return 1
  fi

  env_uid="$(launchd_env_file_uid "$env_file")"
  if [[ -z "$env_uid" ]]; then
    echo "Error: could not determine env file owner: $env_file" >&2
    return 1
  fi

  if [[ "$env_uid" != "$owner_uid" ]]; then
    echo "Error: daemon env file must be owned by target user $owner_user; found uid $env_uid" >&2
    return 1
  fi
}

export_launchd_env_file() {
  local env_file="$1"
  local line=""
  local line_no=0
  local trimmed=""
  local key=""
  local value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    trimmed="$(launchd_env_trim "$line")"

    if [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]]; then
      continue
    fi

    if [[ "$trimmed" == export[[:space:]]* ]]; then
      trimmed="$(launchd_env_trim "${trimmed#export}")"
    fi

    if [[ ! "$trimmed" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "Error: unsupported env syntax in $env_file:$line_no; expected KEY=VALUE" >&2
      return 1
    fi

    key="${trimmed%%=*}"
    value="${trimmed#*=}"
    value="$(launchd_env_strip_quotes "$value")"
    export "$key=$value"
  done < "$env_file"
}

resolve_launchd_env_file() {
  local repo_dir="$1"
  local requested_env_file="${HUSHLINE_SOCIAL_ENV_FILE:-}"
  local default_env_file="$repo_dir/.env.launchd"

  if [[ -n "$requested_env_file" ]]; then
    if [[ -f "$requested_env_file" ]]; then
      printf '%s\n' "$requested_env_file"
      return
    fi

    echo "Error: HUSHLINE_SOCIAL_ENV_FILE points to a missing file: $requested_env_file" >&2
    return 1
  fi

  printf '%s\n' "$default_env_file"
}

load_launchd_env_file() {
  local repo_dir="$1"
  local env_file=""

  env_file="$(resolve_launchd_env_file "$repo_dir")"
  export HUSHLINE_SOCIAL_ENV_FILE="$env_file"

  if [[ -f "$env_file" ]]; then
    export_launchd_env_file "$env_file"
  fi
}
