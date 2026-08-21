#!/usr/bin/env bash

resolve_runner_dashboard_host() {
  if [[ -n "${HUSHLINE_RUNNER_DASHBOARD_HOST:-}" ]]; then
    printf '%s\n' "$HUSHLINE_RUNNER_DASHBOARD_HOST"
    return 0
  fi
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Tailscale is required for direct dashboard IP access." >&2
    return 1
  fi

  local tailscale_ipv4=""
  tailscale_ipv4="$(tailscale ip -4)"
  tailscale_ipv4="${tailscale_ipv4%%$'\n'*}"
  if [[ -z "$tailscale_ipv4" ]]; then
    echo "Tailscale did not report an IPv4 address." >&2
    return 1
  fi
  printf '%s\n' "$tailscale_ipv4"
}
