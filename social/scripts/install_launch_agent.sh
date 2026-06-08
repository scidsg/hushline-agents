#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
SCOPE="gui"
ENV_FILE="$REPO_DIR/.env.launchd"
APP_USER="${SUDO_USER:-${USER}}"
APP_UID="$(id -u "$APP_USER")"
APP_GROUP="$(id -gn "$APP_USER")"
APP_HOME="$(dscl . -read "/Users/$APP_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
GUI_TARGET_DIR=""
SYSTEM_TARGET_DIR="/Library/LaunchDaemons"

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
      --help|-h)
        cat <<'EOF'
Usage:
  ./scripts/install_launch_agent.sh
  ./scripts/install_launch_agent.sh --scope gui
  sudo ./scripts/install_launch_agent.sh --scope daemon

Scopes:
  gui     Installs LaunchAgents into ~/Library/LaunchAgents. Works for desktop sessions,
          but jobs can be missed when the user is logged out.
  daemon  Installs LaunchDaemons into /Library/LaunchDaemons as the target user. Use this
          on servers where jobs must keep running without a logged-in GUI session.
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
  local social_repo_dir_escaped=""
  local home_dir_escaped=""
  local env_file_escaped=""
  local user_name_escaped=""
  local group_name_escaped=""

  repo_dir_escaped="$(escape_sed_replacement "$AGENTS_REPO_DIR")"
  social_repo_dir_escaped="$(escape_sed_replacement "$REPO_DIR")"
  home_dir_escaped="$(escape_sed_replacement "$APP_HOME")"
  env_file_escaped="$(escape_sed_replacement "$ENV_FILE")"
  user_name_escaped="$(escape_sed_replacement "$APP_USER")"
  group_name_escaped="$(escape_sed_replacement "$APP_GROUP")"

  sed \
    -e "s|__REPO_DIR__|$repo_dir_escaped|g" \
    -e "s|__SOCIAL_REPO_DIR__|$social_repo_dir_escaped|g" \
    -e "s|__HOME_DIR__|$home_dir_escaped|g" \
    -e "s|__ENV_FILE__|$env_file_escaped|g" \
    -e "s|__USER_NAME__|$user_name_escaped|g" \
    -e "s|__GROUP_NAME__|$group_name_escaped|g" \
    "$template_path" > "$target_path"

  plutil -lint "$target_path" >/dev/null
}

install_gui_unit() {
  local template_path="$1"
  local target_plist="$2"
  local label="$3"

  render_plist "$template_path" "$target_plist"
  launchctl bootout "gui/$APP_UID" "$target_plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$APP_UID" "$target_plist"
  launchctl enable "gui/$APP_UID/$label"
}

install_daemon_unit() {
  local template_path="$1"
  local target_plist="$2"
  local label="$3"

  render_plist "$template_path" "$target_plist"
  launchctl bootout system "$target_plist" >/dev/null 2>&1 || true
  launchctl bootstrap system "$target_plist"
  launchctl enable "system/$label"
}

uninstall_gui_unit() {
  local target_plist="$1"
  local label="$2"

  launchctl bootout "gui/$APP_UID" "$target_plist" >/dev/null 2>&1 || true
  launchctl disable "gui/$APP_UID/$label" >/dev/null 2>&1 || true
  rm -f "$target_plist"
}

uninstall_daemon_unit() {
  local target_plist="$1"
  local label="$2"

  if [[ ! -e "$target_plist" ]]; then
    return
  fi

  launchctl bootout system "$target_plist" >/dev/null 2>&1 || true
  launchctl disable "system/$label" >/dev/null 2>&1 || true
  rm -f "$target_plist"
}

main() {
  parse_args "$@"
  require_cmd launchctl
  require_cmd sed
  require_cmd plutil

  if [[ "$SCOPE" == "daemon" && $EUID -ne 0 ]]; then
    echo "Daemon installs require sudo because they write to $SYSTEM_TARGET_DIR." >&2
    exit 1
  fi

  mkdir -p "$AGENTS_REPO_DIR/logs/social"
  mkdir -p "$REPO_DIR/logs"
  mkdir -p "$REPO_DIR/.tmp"

  "$AGENTS_REPO_DIR/social/scripts/check_launchd_prereqs.sh" \
    --scope "$SCOPE" \
    --env-file "$ENV_FILE" \
    --owner-user "$APP_USER"

  uninstall_legacy_agent \
    "$GUI_TARGET_DIR/com.hushline.social.weekly-planner.plist" \
    "com.hushline.social.weekly-planner"

  case "$SCOPE" in
    gui)
      mkdir -p "$GUI_TARGET_DIR"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.daily-planner.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.daily-planner.plist" \
        "com.hushline.social.daily-planner"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.daily.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.daily.plist" \
        "com.hushline.social.linkedin.daily"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.weekly-article.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.weekly-article.plist" \
        "com.hushline.social.weekly-article"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.weekly-article.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.weekly-article.plist" \
        "com.hushline.social.linkedin.weekly-article"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.verified-user.weekly.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.verified-user.weekly.plist" \
        "com.hushline.social.verified-user.weekly"
      install_gui_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.verified-user.weekly.plist" \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.verified-user.weekly.plist" \
        "com.hushline.social.linkedin.verified-user.weekly"
      if [[ $EUID -eq 0 ]]; then
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.daily-planner.plist" \
          "com.hushline.social.daily-planner"
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.daily.plist" \
          "com.hushline.social.linkedin.daily"
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.weekly-article.plist" \
          "com.hushline.social.weekly-article"
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.weekly-article.plist" \
          "com.hushline.social.linkedin.weekly-article"
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.verified-user.weekly.plist" \
          "com.hushline.social.verified-user.weekly"
        uninstall_daemon_unit \
          "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.verified-user.weekly.plist" \
          "com.hushline.social.linkedin.verified-user.weekly"
      fi
      ;;
    daemon)
      mkdir -p "$SYSTEM_TARGET_DIR"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.daily-planner.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.daily-planner.plist" \
        "com.hushline.social.daily-planner"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.daily.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.daily.plist" \
        "com.hushline.social.linkedin.daily"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.weekly-article.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.weekly-article.plist" \
        "com.hushline.social.weekly-article"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.weekly-article.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.weekly-article.plist" \
        "com.hushline.social.linkedin.weekly-article"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.verified-user.weekly.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.verified-user.weekly.plist" \
        "com.hushline.social.verified-user.weekly"
      install_daemon_unit \
        "$AGENTS_REPO_DIR/social/deploy/launchd/com.hushline.social.linkedin.verified-user.weekly.daemon.plist" \
        "$SYSTEM_TARGET_DIR/com.hushline.social.linkedin.verified-user.weekly.plist" \
        "com.hushline.social.linkedin.verified-user.weekly"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.daily-planner.plist" \
        "com.hushline.social.daily-planner"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.daily.plist" \
        "com.hushline.social.linkedin.daily"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.weekly-article.plist" \
        "com.hushline.social.weekly-article"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.weekly-article.plist" \
        "com.hushline.social.linkedin.weekly-article"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.verified-user.weekly.plist" \
        "com.hushline.social.verified-user.weekly"
      uninstall_gui_unit \
        "$GUI_TARGET_DIR/com.hushline.social.linkedin.verified-user.weekly.plist" \
        "com.hushline.social.linkedin.verified-user.weekly"
      ;;
  esac

  cat <<EOF
Installed launchd jobs ($SCOPE):
- ${SCOPE/daemon/system}/com.hushline.social.daily-planner
- ${SCOPE/daemon/system}/com.hushline.social.linkedin.daily
- ${SCOPE/daemon/system}/com.hushline.social.weekly-article
- ${SCOPE/daemon/system}/com.hushline.social.linkedin.weekly-article
- ${SCOPE/daemon/system}/com.hushline.social.verified-user.weekly
- ${SCOPE/daemon/system}/com.hushline.social.linkedin.verified-user.weekly

Logs:
- $AGENTS_REPO_DIR/logs/social/daily-planner.stdout.log
- $AGENTS_REPO_DIR/logs/social/daily-planner.stderr.log
- $AGENTS_REPO_DIR/logs/social/linkedin-daily.stdout.log
- $AGENTS_REPO_DIR/logs/social/linkedin-daily.stderr.log
- $AGENTS_REPO_DIR/logs/social/weekly-article.stdout.log
- $AGENTS_REPO_DIR/logs/social/weekly-article.stderr.log
- $AGENTS_REPO_DIR/logs/social/weekly-article-linkedin.stdout.log
- $AGENTS_REPO_DIR/logs/social/weekly-article-linkedin.stderr.log
- $AGENTS_REPO_DIR/logs/social/verified-user-weekly.stdout.log
- $AGENTS_REPO_DIR/logs/social/verified-user-weekly.stderr.log
- $AGENTS_REPO_DIR/logs/social/verified-user-weekly-linkedin.stdout.log
- $AGENTS_REPO_DIR/logs/social/verified-user-weekly-linkedin.stderr.log
- $AGENTS_REPO_DIR/logs/social/social-daily.log

Next steps:
- env file: $ENV_FILE
- social repo: $REPO_DIR
- GUI scope is login-session scoped. Use daemon scope on servers that must keep running while logged out.
EOF

  if [[ "$SCOPE" == "gui" ]]; then
    cat <<EOF
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.daily-planner
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.linkedin.daily
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.weekly-article
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.linkedin.weekly-article
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.verified-user.weekly
- test with: launchctl kickstart -k gui/$APP_UID/com.hushline.social.linkedin.verified-user.weekly
EOF
  else
    cat <<EOF
- required daemon env vars: OPENAI_API_KEY, HUSHLINE_SOCIAL_GITHUB_TOKEN, HUSHLINE_SOCIAL_GIT_SIGNING_KEY_PUB, LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN
- optional Codex defaults: CODEX_MODEL=gpt-5.5, CODEX_REASONING_EFFORT=high
- test with: sudo launchctl kickstart -k system/com.hushline.social.daily-planner
- test with: sudo launchctl kickstart -k system/com.hushline.social.linkedin.daily
- test with: sudo launchctl kickstart -k system/com.hushline.social.weekly-article
- test with: sudo launchctl kickstart -k system/com.hushline.social.linkedin.weekly-article
- test with: sudo launchctl kickstart -k system/com.hushline.social.verified-user.weekly
- test with: sudo launchctl kickstart -k system/com.hushline.social.linkedin.verified-user.weekly
EOF
  fi
}

uninstall_legacy_agent() {
  local legacy_plist="$1"
  local label="$2"

  if [[ ! -f "$legacy_plist" ]]; then
    return
  fi

  launchctl bootout "gui/$APP_UID" "$legacy_plist" >/dev/null 2>&1 || true
  launchctl disable "gui/$APP_UID/$label" >/dev/null 2>&1 || true
  rm -f "$legacy_plist"
}

main "$@"
