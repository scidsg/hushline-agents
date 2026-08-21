#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT="${HUSHLINE_RUNNER_DASHBOARD_PORT:-8765}"

source "$SCRIPT_DIR/lib/runner-dashboard-network.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
HOST="$(resolve_runner_dashboard_host)"

exec python3 \
  "$AGENTS_REPO_DIR/agents/product/code/scripts/runner_dashboard.py" \
  --host "$HOST" \
  --port "$PORT" \
  --repo-dir "$AGENTS_REPO_DIR"
