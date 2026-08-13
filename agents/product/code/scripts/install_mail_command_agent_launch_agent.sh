#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"

if [[ -z "$APP_HOME" ]]; then
  APP_HOME="$HOME"
fi

TEMPLATE_PATH="$AGENTS_REPO_DIR/agents/product/code/deploy/launchd/com.hushline.mail-command-agent.plist"
SOURCE_SCRIPT="$AGENTS_REPO_DIR/agents/product/code/scripts/mail_command_agent.py"
TARGET_DIR="$APP_HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/com.hushline.mail-command-agent.plist"
INSTALL_DIR="$APP_HOME/Library/Application Support/Hush Line Agents/bin"
STATE_DIR="$APP_HOME/Library/Application Support/Hush Line Agents/mail-command-agent"
LOG_DIR="$AGENTS_REPO_DIR/logs/mail-command-agent"
CODEX_HOME_DIR="${HUSHLINE_MAIL_COMMAND_AGENT_CODEX_HOME:-$APP_HOME/.codex-hushline-agents}"
PRIMARY_WORKSPACE="${HUSHLINE_MAIL_COMMAND_AGENT_PRIMARY_WORKSPACE:-$APP_HOME/hushline}"
WORKSPACE_DIRS="${HUSHLINE_MAIL_COMMAND_AGENT_WORKSPACE_DIRS:-$APP_HOME/hushline:$APP_HOME/hushline-agents:$APP_HOME/hushline-docs:$APP_HOME/hushline-finance:$APP_HOME/hushline-social:$APP_HOME/hushline-quotes}"

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
  local install_dir home_dir state_dir log_dir codex_home primary_workspace workspace_dirs
  install_dir="$(escape_sed_replacement "$INSTALL_DIR")"
  home_dir="$(escape_sed_replacement "$APP_HOME")"
  state_dir="$(escape_sed_replacement "$STATE_DIR")"
  log_dir="$(escape_sed_replacement "$LOG_DIR")"
  codex_home="$(escape_sed_replacement "$CODEX_HOME_DIR")"
  primary_workspace="$(escape_sed_replacement "$PRIMARY_WORKSPACE")"
  workspace_dirs="$(escape_sed_replacement "$WORKSPACE_DIRS")"
  sed \
    -e "s|__INSTALL_DIR__|$install_dir|g" \
    -e "s|__HOME_DIR__|$home_dir|g" \
    -e "s|__STATE_DIR__|$state_dir|g" \
    -e "s|__LOG_DIR__|$log_dir|g" \
    -e "s|__CODEX_HOME__|$codex_home|g" \
    -e "s|__PRIMARY_WORKSPACE__|$primary_workspace|g" \
    -e "s|__WORKSPACE_DIRS__|$workspace_dirs|g" \
    "$TEMPLATE_PATH" > "$TARGET_PLIST"
  plutil -lint "$TARGET_PLIST" >/dev/null
}

usage() {
  cat <<'EOF'
Usage:
  ./agents/product/code/scripts/install_mail_command_agent_launch_agent.sh

Installs a GUI LaunchAgent that checks Mail.app every five minutes for authenticated
messages from glenn@hushline.app addressed to agent@hushline.app. Existing messages are
baselined during installation and are never treated as new commands.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_cmd codex
require_cmd install
require_cmd launchctl
require_cmd osascript
require_cmd plutil
require_cmd python3
require_cmd sed

if [[ ! -d "$PRIMARY_WORKSPACE" ]]; then
  echo "Missing primary workspace: $PRIMARY_WORKSPACE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$INSTALL_DIR" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$INSTALL_DIR" "$STATE_DIR"
install -m 700 "$SOURCE_SCRIPT" "$INSTALL_DIR/mail_command_agent.py"
render_plist

HOME="$APP_HOME" \
CODEX_HOME="$CODEX_HOME_DIR" \
HUSHLINE_MAIL_COMMAND_AGENT_STATE_DIR="$STATE_DIR" \
HUSHLINE_MAIL_COMMAND_AGENT_WORKSPACE_DIRS="$WORKSPACE_DIRS" \
  "$INSTALL_DIR/mail_command_agent.py" --diagnose

HOME="$APP_HOME" \
HUSHLINE_MAIL_COMMAND_AGENT_STATE_DIR="$STATE_DIR" \
  "$INSTALL_DIR/mail_command_agent.py" --initialize

launchctl bootout "gui/$APP_UID" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$APP_UID" "$TARGET_PLIST"
launchctl enable "gui/$APP_UID/com.hushline.mail-command-agent"

cat <<EOF
Installed launchd job:
- label: com.hushline.mail-command-agent
- schedule: every 5 minutes
- authorized sender: glenn@hushline.app
- agent address: agent@hushline.app
- executable: $INSTALL_DIR/mail_command_agent.py
- state: $STATE_DIR/state.json
- stdout: $LOG_DIR/mail-command-agent.stdout.log
- stderr: $LOG_DIR/mail-command-agent.stderr.log

If no cursor existed, it was initialized now so existing messages will not run as commands.
An existing cursor is preserved during refreshes so new requests are not skipped.
EOF
