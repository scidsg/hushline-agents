#!/usr/bin/env bash
set -euo pipefail

CODE_AGENT_CMD=$(cat <<'CMD'
cd "$HOME/hushline"
printf '\033]0;Code Agent Logs\007'
printf 'Watching live code agent logs at %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
tail -n 80 -F  "$HOME/.codex/logs/hushline-code-agent.log"
#  "$HOME/.codex/logs/hushline-daily-coverage.stdout.log" \
#  "$HOME/.codex/logs/hushline-daily-coverage.stderr.log"
#  "$HOME/tor-code-agent/logs/tor-agent.out.log" \
#  "$HOME/tor-code-agent/logs/tor-agent.err.log"
CMD
)

SOCIAL_AGENT_CMD=$(cat <<'CMD'
cd "$HOME/hushline-agents"
printf '\033]0;Social Live Log\007'
mkdir -p "$HOME/hushline-agents/logs/social"
touch "$HOME/hushline-agents/logs/social/social-daily.log"
printf 'Watching combined social live log at %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
printf 'File: %s\n\n' "$HOME/hushline-agents/logs/social/social-daily.log"
tail -n 160 -F "$HOME/hushline-agents/logs/social/social-daily.log"
CMD
)

SOCIAL_LAUNCHD_CMD=$(cat <<'CMD'
cd "$HOME/hushline-agents"
printf '\033]0;Social Launchd Logs\007'
mkdir -p "$HOME/hushline-agents/logs/social"
touch \
  "$HOME/hushline-agents/logs/social/daily-planner.stdout.log" \
  "$HOME/hushline-agents/logs/social/daily-planner.stderr.log" \
  "$HOME/hushline-agents/logs/social/linkedin-daily.stdout.log" \
  "$HOME/hushline-agents/logs/social/linkedin-daily.stderr.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly.stdout.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly.stderr.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly-linkedin.stdout.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly-linkedin.stderr.log"
printf 'Watching LaunchAgent stdout/stderr logs at %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
tail -n 80 -F \
  "$HOME/hushline-agents/logs/social/daily-planner.stdout.log" \
  "$HOME/hushline-agents/logs/social/daily-planner.stderr.log" \
  "$HOME/hushline-agents/logs/social/linkedin-daily.stdout.log" \
  "$HOME/hushline-agents/logs/social/linkedin-daily.stderr.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly.stdout.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly.stderr.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly-linkedin.stdout.log" \
  "$HOME/hushline-agents/logs/social/verified-user-weekly-linkedin.stderr.log"
CMD
)

WEEKLY_REPORT_CMD=$(cat <<'CMD'
cd "$HOME/hushline-agents"
printf '\033]0;Weekly Agent Report Logs\007'
printf 'Watching weekly report logs at %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
touch \
  "$HOME/hushline-agents/logs/weekly-agent-report.stdout.log" \
  "$HOME/hushline-agents/logs/weekly-agent-report.stderr.log"
tail -n 80 -F \
  "$HOME/hushline-agents/logs/weekly-agent-report.stdout.log" \
  "$HOME/hushline-agents/logs/weekly-agent-report.stderr.log"
CMD
)

CODEX_CMD=$(cat <<'CMD'
cd "$HOME/hushline"
printf '\033]0;Codex\007'
codex
exec zsh -l
CMD
)

COMMANDS_CMD=$(cat <<'CMD'
cd "$HOME/hushline"
printf '\033]0;Manual Commands\007'
exec zsh -l
CMD
)

export CODE_AGENT_CMD
export SOCIAL_AGENT_CMD
export SOCIAL_LAUNCHD_CMD
export WEEKLY_REPORT_CMD
export CODEX_CMD
export COMMANDS_CMD

osascript <<'APPLESCRIPT'
on openRunnerWindow(windowTitle, commandText, windowBounds)
  tell application "Terminal"
    activate
    set createdTab to do script commandText
    delay 0.3
    set bounds of front window to windowBounds
    set custom title of createdTab to windowTitle
  end tell
end openRunnerWindow

tell application "Finder"
  set screenBounds to bounds of window of desktop
end tell

set screenLeft to item 1 of screenBounds
set screenTop to item 2 of screenBounds
set screenRight to item 3 of screenBounds
set screenBottom to item 4 of screenBounds
set screenWidth to screenRight - screenLeft
set screenHeight to screenBottom - screenTop

set leftRight to screenLeft + (screenWidth / 2)
set rightLeft to leftRight
set oneQuarter to screenTop + (screenHeight / 4)
set halfHeight to screenTop + (screenHeight / 2)
set threeQuarters to screenTop + ((screenHeight * 3) / 4)

set codeAgentBounds to {screenLeft, screenTop, leftRight, oneQuarter}
set socialAgentBounds to {screenLeft, oneQuarter, leftRight, halfHeight}
set socialLaunchdBounds to {screenLeft, halfHeight, leftRight, threeQuarters}
set weeklyReportBounds to {screenLeft, threeQuarters, leftRight, screenBottom}
set codexBounds to {rightLeft, screenTop, screenRight, halfHeight}
set commandsBounds to {rightLeft, halfHeight, screenRight, screenBottom}

openRunnerWindow("Code Agent Logs", system attribute "CODE_AGENT_CMD", codeAgentBounds)
openRunnerWindow("Social Live Log", system attribute "SOCIAL_AGENT_CMD", socialAgentBounds)
openRunnerWindow("Social Launchd Logs", system attribute "SOCIAL_LAUNCHD_CMD", socialLaunchdBounds)
openRunnerWindow("Weekly Agent Report Logs", system attribute "WEEKLY_REPORT_CMD", weeklyReportBounds)
openRunnerWindow("Codex", system attribute "CODEX_CMD", codexBounds)
openRunnerWindow("Manual Commands", system attribute "COMMANDS_CMD", commandsBounds)
APPLESCRIPT
