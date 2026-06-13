#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$AGENTS_REPO_DIR/deploy/launchd/com.hushline.runner-dashboard.plist"
LABEL="com.hushline.runner-dashboard"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"

if [[ -z "$APP_HOME" ]]; then
  APP_HOME="$HOME"
fi

TARGET_DIR="$APP_HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"

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
  local repo_dir_escaped=""
  local home_dir_escaped=""

  repo_dir_escaped="$(escape_sed_replacement "$AGENTS_REPO_DIR")"
  home_dir_escaped="$(escape_sed_replacement "$APP_HOME")"

  sed \
    -e "s|__REPO_DIR__|$repo_dir_escaped|g" \
    -e "s|__HOME_DIR__|$home_dir_escaped|g" \
    "$TEMPLATE_PATH" > "$TARGET_PLIST"

  plutil -lint "$TARGET_PLIST" >/dev/null
}

main() {
  require_cmd dscl
  require_cmd launchctl
  require_cmd plutil
  require_cmd sed

  mkdir -p "$TARGET_DIR"
  mkdir -p "$AGENTS_REPO_DIR/logs"

  render_plist

  launchctl bootout "gui/$APP_UID" "$TARGET_PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$APP_UID" "$TARGET_PLIST"
  launchctl enable "gui/$APP_UID/$LABEL"

  cat <<EOF
Installed launchd job:
- gui/$APP_UID/$LABEL

Plist:
- $TARGET_PLIST

Logs:
- $AGENTS_REPO_DIR/logs/runner-dashboard.stdout.log
- $AGENTS_REPO_DIR/logs/runner-dashboard.stderr.log

This LaunchAgent runs when the $APP_USER Aqua login session starts after reboot.
Test with: launchctl kickstart -k gui/$APP_UID/$LABEL
EOF
}

main "$@"
