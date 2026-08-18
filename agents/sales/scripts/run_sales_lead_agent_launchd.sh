#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${HUSHLINE_SALES_AGENT_ENV_FILE:-$AGENTS_REPO_DIR/.env.sales.launchd}"
COMBINED_LOG_FILE="${HUSHLINE_SALES_LEAD_AGENT_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/sales/sales-lead-agent.log}"
LOCK_DIR="$AGENTS_REPO_DIR/logs/sales/sales-lead-agent.lock"
DRY_RUN=0

source "$AGENTS_REPO_DIR/agents/social/scripts/lib/load-launchd-env.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

load_sales_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi
  validate_launchd_env_file "$ENV_FILE" "gui"
  export_launchd_env_file "$ENV_FILE"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./agents/sales/scripts/run_sales_lead_agent_launchd.sh
  ./agents/sales/scripts/run_sales_lead_agent_launchd.sh --dry-run

Screens unread mail for sales@hushline.app. Each qualified original is forwarded once to
glenn@hushline.app with a prepended executive summary. The agent never replies to senders.
EOF
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
}

mkdir -p "$AGENTS_REPO_DIR/logs/sales"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "sales-lead-agent is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

mkdir -p "$(dirname "$COMBINED_LOG_FILE")"
exec > >(tee -a "$COMBINED_LOG_FILE")
exec 2> >(tee -a "$COMBINED_LOG_FILE" >&2)

load_sales_env_file
parse_args "$@"

command=(python3 "$AGENTS_REPO_DIR/agents/sales/scripts/sales_lead_agent.py")
if [[ "$DRY_RUN" == "1" ]]; then
  command+=(--dry-run)
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting sales-lead-agent."
"${command[@]}"
