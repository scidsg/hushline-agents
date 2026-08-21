#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT="${HUSHLINE_RUNNER_DASHBOARD_PORT:-8765}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

exec python3 \
  "$AGENTS_REPO_DIR/agents/product/code/scripts/runner_dashboard.py" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --repo-dir "$AGENTS_REPO_DIR"
