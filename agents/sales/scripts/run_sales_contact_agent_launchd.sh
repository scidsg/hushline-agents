#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_DOCS_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-docs"
DOCS_REPO_DIR="${HUSHLINE_SALES_AGENT_DOCS_REPO_DIR:-$DEFAULT_DOCS_REPO_DIR}"
ENV_FILE="${HUSHLINE_SALES_AGENT_ENV_FILE:-$AGENTS_REPO_DIR/.env.sales.launchd}"
COMBINED_LOG_FILE="${HUSHLINE_SALES_AGENT_COMBINED_LOG_FILE:-$AGENTS_REPO_DIR/logs/sales/sales-contact-agent.log}"
LOCK_DIR="$AGENTS_REPO_DIR/logs/sales/sales-contact-agent.lock"
DATE_OVERRIDE=""
DRY_RUN=0

source "$AGENTS_REPO_DIR/agents/social/scripts/lib/load-launchd-env.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

setup_log_capture() {
  mkdir -p "$(dirname "$COMBINED_LOG_FILE")"
  exec > >(tee -a "$COMBINED_LOG_FILE")
  exec 2> >(tee -a "$COMBINED_LOG_FILE" >&2)
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
      --date)
        DATE_OVERRIDE="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./agents/sales/scripts/run_sales_contact_agent_launchd.sh
  ./agents/sales/scripts/run_sales_contact_agent_launchd.sh --dry-run
  ./agents/sales/scripts/run_sales_contact_agent_launchd.sh --date 2026-06-10

Behavior:
  - chooses the highest-ranked uncontacted company from the assessed contact-form audit
  - gates delivery to a deterministic random time between 04:00 and 09:00 in the recipient's timezone
  - sends exactly one tactful sales email through Mail.app from sales@hushline.app
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

run_agent() {
  local -a command=(
    python3
    "$AGENTS_REPO_DIR/agents/sales/scripts/sales_contact_agent.py"
    --docs-repo-dir
    "$DOCS_REPO_DIR"
  )

  if [[ -n "$DATE_OVERRIDE" ]]; then
    command+=(--date "$DATE_OVERRIDE")
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    command+=(--dry-run)
  else
    command+=(--send-when-due)
  fi

  "${command[@]}"
}

mkdir -p "$AGENTS_REPO_DIR/logs/sales"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "sales-contact-agent is already running. Exiting." >&2
  exit 0
fi
trap cleanup EXIT

setup_log_capture
load_sales_env_file
parse_args "$@"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] Starting sales-contact-agent."
run_agent
