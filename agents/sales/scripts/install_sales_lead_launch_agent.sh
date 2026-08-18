#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"

if [[ -z "$APP_HOME" ]]; then
  APP_HOME="$HOME"
fi

TARGET_DIR="$APP_HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/com.hushline.sales.lead-agent.plist"
TEMPLATE="$AGENTS_REPO_DIR/agents/sales/deploy/launchd/com.hushline.sales.lead-agent.plist"

if [[ $EUID -eq 0 ]]; then
  echo "Install this Mail.app agent as the logged-in user, without sudo." >&2
  exit 1
fi

for command_name in launchctl osascript plutil sed; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

repo_dir_escaped="$(escape_sed_replacement "$AGENTS_REPO_DIR")"
home_dir_escaped="$(escape_sed_replacement "$APP_HOME")"

mkdir -p "$TARGET_DIR" "$AGENTS_REPO_DIR/logs/sales"
sed \
  -e "s|__REPO_DIR__|$repo_dir_escaped|g" \
  -e "s|__HOME_DIR__|$home_dir_escaped|g" \
  "$TEMPLATE" > "$TARGET_PLIST"
plutil -lint "$TARGET_PLIST" >/dev/null

launchctl bootout "gui/$APP_UID" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$APP_UID" "$TARGET_PLIST"
launchctl enable "gui/$APP_UID/com.hushline.sales.lead-agent"

cat <<EOF
Installed GUI LaunchAgent:
- gui/$APP_UID/com.hushline.sales.lead-agent

The job checks sales@hushline.app every five minutes and forwards each qualified original
to glenn@hushline.app with a prepended lead brief. macOS may request permission for the
terminal or runner to control Mail.

Dry run:
- $AGENTS_REPO_DIR/agents/sales/scripts/run_sales_lead_agent_launchd.sh --dry-run

Log (contains counts and errors, never message bodies):
- $AGENTS_REPO_DIR/logs/sales/sales-lead-agent.log
EOF
