#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
TARGET_DIR=""
TARGET_PLIST=""
TEMPLATE_PATH="$AGENTS_REPO_DIR/agents/product/reporting/deploy/launchd/com.hushline.monthly-board-report.plist"

if [[ -z "$APP_HOME" ]]; then
  APP_HOME="$HOME"
fi

TARGET_DIR="$APP_HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/com.hushline.monthly-board-report.plist"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

render_plist() {
  local repo_dir
  local home_dir
  repo_dir="$(escape_sed_replacement "$AGENTS_REPO_DIR")"
  home_dir="$(escape_sed_replacement "$APP_HOME")"
  sed \
    -e "s|__REPO_DIR__|$repo_dir|g" \
    -e "s|__HOME_DIR__|$home_dir|g" \
    "$TEMPLATE_PATH" >"$TARGET_PLIST"
}

usage() {
  cat <<'EOF'
Usage:
  ./agents/product/reporting/scripts/install_monthly_board_report_launch_agent.sh

Installs the GUI LaunchAgent for the monthly board report runner.
The runner sends from admin@hushline.app and defaults to glenn@hushline.app.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_cmd launchctl
require_cmd osascript
require_cmd python3

mkdir -p "$TARGET_DIR"
mkdir -p "$AGENTS_REPO_DIR/logs/monthly-board-reports"
render_plist

launchctl bootout "gui/$APP_UID" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$APP_UID" "$TARGET_PLIST"

cat <<EOF
Installed launchd job:
- label: com.hushline.monthly-board-report
- plist: $TARGET_PLIST
- schedule: days 28-31 at 6:30 PM local; runner sends only on actual month end
- stdout: $AGENTS_REPO_DIR/logs/monthly-board-report.stdout.log
- stderr: $AGENTS_REPO_DIR/logs/monthly-board-report.stderr.log

Manual dry run:
$AGENTS_REPO_DIR/agents/product/reporting/scripts/monthly_board_report_runner.py --dry-run --force
EOF
