#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_DOCS_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-docs"
DOCS_REPO_DIR="${HUSHLINE_SALES_AGENT_DOCS_REPO_DIR:-$DEFAULT_DOCS_REPO_DIR}"
ENV_FILE="${HUSHLINE_SALES_AGENT_ENV_FILE:-$AGENTS_REPO_DIR/.env.sales.launchd}"
SCOPE="gui"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_GROUP="$(id -gn "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
GUI_TARGET_DIR=""
SYSTEM_TARGET_DIR="/Library/LaunchDaemons"

source "$AGENTS_REPO_DIR/agents/social/scripts/lib/load-launchd-env.sh"

if [[ -z "$APP_HOME" ]]; then
  APP_HOME="$HOME"
fi

GUI_TARGET_DIR="$APP_HOME/Library/LaunchAgents"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope)
        SCOPE="$2"
        shift 2
        ;;
      --env-file)
        ENV_FILE="$2"
        shift 2
        ;;
      --docs-repo-dir)
        DOCS_REPO_DIR="$2"
        shift 2
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./agents/sales/scripts/install_launch_agent.sh
  ./agents/sales/scripts/install_launch_agent.sh --scope gui
  sudo ./agents/sales/scripts/install_launch_agent.sh --scope daemon

The sales agent uses Mail.app and must send from sales@hushline.app.
EOF
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done

  case "$SCOPE" in
    gui|daemon) ;;
    *)
      echo "--scope must be one of: gui, daemon" >&2
      exit 1
      ;;
  esac
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

render_plist() {
  local template_path="$1"
  local target_path="$2"
  local repo_dir_escaped=""
  local docs_repo_dir_escaped=""
  local home_dir_escaped=""
  local env_file_escaped=""
  local user_name_escaped=""
  local group_name_escaped=""

  repo_dir_escaped="$(escape_sed_replacement "$AGENTS_REPO_DIR")"
  docs_repo_dir_escaped="$(escape_sed_replacement "$DOCS_REPO_DIR")"
  home_dir_escaped="$(escape_sed_replacement "$APP_HOME")"
  env_file_escaped="$(escape_sed_replacement "$ENV_FILE")"
  user_name_escaped="$(escape_sed_replacement "$APP_USER")"
  group_name_escaped="$(escape_sed_replacement "$APP_GROUP")"

  sed \
    -e "s|__REPO_DIR__|$repo_dir_escaped|g" \
    -e "s|__DOCS_REPO_DIR__|$docs_repo_dir_escaped|g" \
    -e "s|__HOME_DIR__|$home_dir_escaped|g" \
    -e "s|__ENV_FILE__|$env_file_escaped|g" \
    -e "s|__USER_NAME__|$user_name_escaped|g" \
    -e "s|__GROUP_NAME__|$group_name_escaped|g" \
    "$template_path" > "$target_path"

  plutil -lint "$target_path" >/dev/null
}

install_gui_unit() {
  local target_plist="$GUI_TARGET_DIR/com.hushline.sales.contact-agent.plist"
  mkdir -p "$GUI_TARGET_DIR"
  render_plist \
    "$AGENTS_REPO_DIR/agents/sales/deploy/launchd/com.hushline.sales.contact-agent.plist" \
    "$target_plist"
  launchctl bootout "gui/$APP_UID" "$target_plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$APP_UID" "$target_plist"
  launchctl enable "gui/$APP_UID/com.hushline.sales.contact-agent"
}

install_daemon_unit() {
  local target_plist="$SYSTEM_TARGET_DIR/com.hushline.sales.contact-agent.plist"
  mkdir -p "$SYSTEM_TARGET_DIR"
  render_plist \
    "$AGENTS_REPO_DIR/agents/sales/deploy/launchd/com.hushline.sales.contact-agent.daemon.plist" \
    "$target_plist"
  launchctl bootout system "$target_plist" >/dev/null 2>&1 || true
  launchctl bootstrap system "$target_plist"
  launchctl enable "system/com.hushline.sales.contact-agent"
}

main() {
  parse_args "$@"
  require_cmd launchctl
  require_cmd osascript
  require_cmd plutil
  require_cmd sed

  if [[ "$SCOPE" == "daemon" && $EUID -ne 0 ]]; then
    echo "Daemon installs require sudo because they write to $SYSTEM_TARGET_DIR." >&2
    exit 1
  fi

  if [[ ! -d "$DOCS_REPO_DIR" ]]; then
    echo "Missing docs repo: $DOCS_REPO_DIR" >&2
    exit 1
  fi

  validate_launchd_env_file "$ENV_FILE" "$SCOPE" "$APP_USER"
  export_launchd_env_file "$ENV_FILE"

  if [[ "${HUSHLINE_SALES_AGENT_FROM:-}" != "sales@hushline.app" ]]; then
    echo "Set HUSHLINE_SALES_AGENT_FROM=sales@hushline.app in $ENV_FILE" >&2
    exit 1
  fi

  mkdir -p "$AGENTS_REPO_DIR/logs/sales"

  case "$SCOPE" in
    gui)
      install_gui_unit
      ;;
    daemon)
      install_daemon_unit
      ;;
  esac

  cat <<EOF
Installed launchd job ($SCOPE):
- ${SCOPE/daemon/system}/com.hushline.sales.contact-agent

Logs:
- $AGENTS_REPO_DIR/logs/sales/sales-contact-agent.log
- $AGENTS_REPO_DIR/logs/sales/sales-contact-agent.stdout.log
- $AGENTS_REPO_DIR/logs/sales/sales-contact-agent.stderr.log

Next steps:
- env file: $ENV_FILE
- docs repo: $DOCS_REPO_DIR
- dry run: $AGENTS_REPO_DIR/agents/sales/scripts/run_sales_contact_agent_launchd.sh --dry-run
EOF
}

main "$@"
