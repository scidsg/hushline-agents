#!/usr/bin/env bash
set -euo pipefail

LOCAL_PORT="${HUSHLINE_RUNNER_DASHBOARD_PORT:-8765}"
TAILSCALE_HTTPS_PORT="${HUSHLINE_RUNNER_DASHBOARD_TAILSCALE_HTTPS_PORT:-8443}"
LOCAL_URL="http://127.0.0.1:$LOCAL_PORT"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale CLI is not installed." >&2
  exit 1
fi

if ! curl --fail --silent --show-error "$LOCAL_URL/healthz" >/dev/null; then
  echo "Dashboard is not healthy at $LOCAL_URL." >&2
  exit 1
fi

if ! tailscale status --json >/dev/null 2>&1; then
  echo "Tailscale is installed but its daemon is not running or signed in." >&2
  echo "Start Tailscale and sign in, then rerun this script." >&2
  exit 1
fi

tailscale serve --yes --bg --https="$TAILSCALE_HTTPS_PORT" "$LOCAL_URL"
tailscale serve status
