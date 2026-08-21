#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${HUSHLINE_RUNNER_DASHBOARD_PORT:-8765}"

source "$SCRIPT_DIR/lib/runner-dashboard-network.sh"

HOST="$(resolve_runner_dashboard_host)"
URL="http://$HOST:$PORT/"

if ! curl --noproxy '*' --fail --silent --show-error "${URL}healthz" >/dev/null; then
  echo "Hush Line agent dashboard is not available at $URL" >&2
  echo "Install or restart it with:" >&2
  echo "  ./agents/product/code/scripts/install_runner_dashboard_launch_agent.sh" >&2
  exit 1
fi

open "$URL"
