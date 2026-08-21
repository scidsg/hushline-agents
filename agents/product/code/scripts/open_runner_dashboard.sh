#!/usr/bin/env bash
set -euo pipefail

PORT="${HUSHLINE_RUNNER_DASHBOARD_PORT:-8765}"
URL="http://127.0.0.1:$PORT/"

if ! curl --fail --silent --show-error "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "Hush Line agent dashboard is not available at $URL" >&2
  echo "Install or restart it with:" >&2
  echo "  ./agents/product/code/scripts/install_runner_dashboard_launch_agent.sh" >&2
  exit 1
fi

open "$URL"
