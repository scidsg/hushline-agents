#!/usr/bin/env bash

transient_retry_interval_seconds() {
  local value="${HUSHLINE_SOCIAL_TRANSIENT_RETRY_INTERVAL_SECONDS:-600}"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 0 )); then
    echo "HUSHLINE_SOCIAL_TRANSIENT_RETRY_INTERVAL_SECONDS must be a non-negative integer." >&2
    return 1
  fi

  printf '%s\n' "$value"
}

transient_retry_max_attempts() {
  local value="${HUSHLINE_SOCIAL_TRANSIENT_RETRY_MAX_ATTEMPTS:-12}"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "HUSHLINE_SOCIAL_TRANSIENT_RETRY_MAX_ATTEMPTS must be an integer greater than zero." >&2
    return 1
  fi

  printf '%s\n' "$value"
}

is_transient_connection_output() {
  local output_file="$1"

  if [[ ! -f "$output_file" ]]; then
    return 1
  fi

  if grep -Eiq \
    'Could not resolve host|Temporary failure in name resolution|Name or service not known|nodename nor servname provided|No route to host|Network is unreachable|Failed to connect to|Connection timed out|Connection reset by peer|Operation timed out|timed out|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ENOTFOUND|getaddrinfo|fetch failed|network error|network is unreachable' \
    "$output_file"; then
    return 0
  fi

  return 1
}

run_with_transient_retry() {
  local label="$1"
  shift

  local attempt=1
  local exit_code=0
  local interval_seconds=""
  local max_attempts=""
  local output_file=""
  local had_pipefail=0

  if set -o | grep -q '^pipefail[[:space:]]\+on$'; then
    had_pipefail=1
  fi

  interval_seconds="$(transient_retry_interval_seconds)"
  max_attempts="$(transient_retry_max_attempts)"
  set -o pipefail

  while (( attempt <= max_attempts )); do
    output_file="$(mktemp)"

    set +e
    "$@" 2>&1 | tee "$output_file"
    exit_code=$?
    set -e

    if (( exit_code == 0 )); then
      rm -f "$output_file"
      if (( had_pipefail == 0 )); then
        set +o pipefail
      fi
      return 0
    fi

    if ! is_transient_connection_output "$output_file" || (( attempt >= max_attempts )); then
      rm -f "$output_file"
      if (( had_pipefail == 0 )); then
        set +o pipefail
      fi
      return "$exit_code"
    fi

    echo "$label failed due to a transient connection error on attempt $attempt/$max_attempts. Retrying in $interval_seconds seconds."
    rm -f "$output_file"
    sleep "$interval_seconds"
    attempt=$((attempt + 1))
  done

  if (( had_pipefail == 0 )); then
    set +o pipefail
  fi
  return "$exit_code"
}
