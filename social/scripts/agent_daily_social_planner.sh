#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_SOCIAL_REPO_DIR="$(cd "$AGENTS_REPO_DIR/.." && pwd)/hushline-social"
REPO_DIR="${HUSHLINE_SOCIAL_REPO_DIR:-$DEFAULT_SOCIAL_REPO_DIR}"
SCREENSHOTS_REPO_DIR="${HUSHLINE_SCREENSHOTS_REPO_DIR:-$(cd "$REPO_DIR/.." && pwd)/hushline-screenshots}"
SCREENSHOT_MAX_AGE_DAYS="${HUSHLINE_SCREENSHOT_MAX_AGE_DAYS:-21}"
SCREENSHOT_AUTO_SYNC="${HUSHLINE_SCREENSHOT_AUTO_SYNC:-1}"
SCREENSHOT_REMOTE_CHECK_ATTEMPTS="${HUSHLINE_SCREENSHOT_REMOTE_CHECK_ATTEMPTS:-3}"
SCREENSHOT_REMOTE_CHECK_TIMEOUT_SECONDS="${HUSHLINE_SCREENSHOT_REMOTE_CHECK_TIMEOUT_SECONDS:-12}"
ALLOW_STALE_SCREENSHOTS="${HUSHLINE_ALLOW_STALE_SCREENSHOTS:-0}"
ARCHIVE_PUSH_ENABLED="${HUSHLINE_SOCIAL_DAILY_PUSH_ON_RENDER:-0}"

DATE="$(date +%Y-%m-%d)"
ARCHIVE_KEY=""
CANDIDATE_COUNT=""
DARK_RATIO=""
NO_RENDER=0
NO_PUSH=0
FORCE_PUSH=0
ALLOW_WEEKEND=0
LAST_VALIDATION_OUTPUT=""
EXCLUDED_SCREENSHOTS=()

CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-high}"
CODEX_MAX_ATTEMPTS="${HUSHLINE_SOCIAL_CODEX_MAX_ATTEMPTS:-3}"
CODEX_RETRY_DELAY_SECONDS="${HUSHLINE_SOCIAL_CODEX_RETRY_DELAY_SECONDS:-30}"
VERBOSE_CODEX_OUTPUT="${VERBOSE_CODEX_OUTPUT:-0}"

PROMPT_FILE="$(mktemp)"
CODEX_OUTPUT_FILE="$(mktemp)"
CODEX_TRANSCRIPT_FILE="$(mktemp)"

cleanup() {
  rm -f "$PROMPT_FILE" "$CODEX_OUTPUT_FILE" "$CODEX_TRANSCRIPT_FILE"
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE="$2"
        shift 2
        ;;
      --archive-key)
        ARCHIVE_KEY="$2"
        shift 2
        ;;
      --candidate-count)
        CANDIDATE_COUNT="$2"
        shift 2
        ;;
      --dark-ratio)
        DARK_RATIO="$2"
        shift 2
        ;;
      --no-render)
        NO_RENDER=1
        shift
        ;;
      --no-push)
        NO_PUSH=1
        shift
        ;;
      --push-render-archive)
        FORCE_PUSH=1
        shift
        ;;
      --allow-weekend)
        ALLOW_WEEKEND=1
        shift
        ;;
      --help|-h)
        cat <<'EOF'
Usage:
  ./social/scripts/agent_daily_social_planner.sh --date 2026-03-19
  ./social/scripts/agent_daily_social_planner.sh --date 2026-03-19 --archive-key 2026-03-19-1

Behavior:
  - Prepares daily context and prompt artifacts under previous-posts/<archive-key>
  - Invokes Codex CLI in the local repo
  - Expects Codex to write previous-posts/<archive-key>/plan.json
  - Validates the plan and renders assets
  - Retries with alternate shortlisted screenshots when validation rejects a repetitive angle
  - Keeps the daily archive local by default
  - Pushes the daily archive only when --push-render-archive is passed or HUSHLINE_SOCIAL_DAILY_PUSH_ON_RENDER=1
  - Skips weekends unless --allow-weekend is passed
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

weekday_number() {
  date -j -f "%Y-%m-%d" "$1" "+%u"
}

skip_if_weekend() {
  if (( ALLOW_WEEKEND == 1 )); then
    return
  fi

  local weekday=""
  weekday="$(weekday_number "$DATE")"
  if [[ "$weekday" == "6" || "$weekday" == "7" ]]; then
    echo "Skipping daily social planner for weekend date $DATE."
    exit 0
  fi
}

build_context() {
  local -a cmd=(node "$REPO_DIR/scripts/plan-day.js" --date "$DATE")
  [[ -n "$ARCHIVE_KEY" ]] && cmd+=(--archive-key "$ARCHIVE_KEY")
  [[ -n "$CANDIDATE_COUNT" ]] && cmd+=(--candidate-count "$CANDIDATE_COUNT")
  [[ -n "$DARK_RATIO" ]] && cmd+=(--dark-ratio "$DARK_RATIO")
  local excluded=""
  if (( ${#EXCLUDED_SCREENSHOTS[@]} > 0 )); then
    for excluded in "${EXCLUDED_SCREENSHOTS[@]}"; do
      cmd+=(--exclude-screenshot "$excluded")
    done
  fi

  "${cmd[@]}"
}

reset_day_plan_artifacts() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  rm -f "$REPO_DIR/previous-posts/$archive_key/plan.json"
}

codex_plan_path() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  printf '%s\n' "$REPO_DIR/previous-posts/$archive_key/plan.json"
}

print_codex_failure_context() {
  if [[ -s "$CODEX_OUTPUT_FILE" ]]; then
    echo "Codex final message before failure:" >&2
    sed -n '1,60p' "$CODEX_OUTPUT_FILE" >&2
  fi

  if [[ -s "$CODEX_TRANSCRIPT_FILE" ]]; then
    echo "Codex transcript tail:" >&2
    tail -80 "$CODEX_TRANSCRIPT_FILE" >&2
  else
    echo "Codex produced no transcript output." >&2
  fi
}

run_codex_from_prompt() {
  local attempt=1
  local max_attempts="$CODEX_MAX_ATTEMPTS"
  local plan_path=""
  local rc=0

  if [[ ! "$max_attempts" =~ ^[0-9]+$ ]] || (( max_attempts < 1 )); then
    echo "HUSHLINE_SOCIAL_CODEX_MAX_ATTEMPTS must be an integer greater than zero." >&2
    return 1
  fi

  if [[ ! "$CODEX_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "HUSHLINE_SOCIAL_CODEX_RETRY_DELAY_SECONDS must be a non-negative integer." >&2
    return 1
  fi

  while (( attempt <= max_attempts )); do
    : > "$CODEX_OUTPUT_FILE"
    : > "$CODEX_TRANSCRIPT_FILE"
    plan_path="$(codex_plan_path)"

    if [[ "$VERBOSE_CODEX_OUTPUT" == "1" ]]; then
      echo "Codex execution started (attempt ${attempt}/${max_attempts}); streaming transcript to console."
    else
      echo "Codex execution started (attempt ${attempt}/${max_attempts}); transcript captured to a temporary file."
    fi

    set +e
    codex exec \
      --model "$CODEX_MODEL" \
      -c "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"" \
      --full-auto \
      --sandbox workspace-write \
      -C "$REPO_DIR" \
      -o "$CODEX_OUTPUT_FILE" \
      - < "$PROMPT_FILE" 2>&1 | {
        if [[ "$VERBOSE_CODEX_OUTPUT" == "1" ]]; then
          tee "$CODEX_TRANSCRIPT_FILE"
        else
          cat > "$CODEX_TRANSCRIPT_FILE"
        fi
      }
    rc=${PIPESTATUS[0]}
    set -e

    if (( rc == 0 )) && [[ ! -s "$plan_path" ]]; then
      echo "Codex execution completed but did not write a plan: $plan_path" >&2
      rc=1
    fi

    if (( rc == 0 )); then
      echo "Codex execution completed."
      if [[ -s "$CODEX_OUTPUT_FILE" ]]; then
        echo "Codex final message:"
        sed -n '1,60p' "$CODEX_OUTPUT_FILE"
        printf '\n'
      fi
      return 0
    fi

    echo "Codex execution failed (exit ${rc}) on attempt ${attempt}/${max_attempts}." >&2
    print_codex_failure_context

    if (( attempt >= max_attempts )); then
      return "$rc"
    fi

    echo "Retrying Codex execution in $CODEX_RETRY_DELAY_SECONDS seconds."
    sleep "$CODEX_RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

validate_and_render() {
  local -a cmd=(node "$REPO_DIR/scripts/validate-day-plan.js" --date "$DATE")
  local output=""
  local rc=0
  [[ -n "$ARCHIVE_KEY" ]] && cmd+=(--archive-key "$ARCHIVE_KEY")
  [[ -n "$CANDIDATE_COUNT" ]] && cmd+=(--candidate-count "$CANDIDATE_COUNT")
  [[ -n "$DARK_RATIO" ]] && cmd+=(--dark-ratio "$DARK_RATIO")
  (( NO_RENDER == 1 )) && cmd+=(--no-render)

  set +e
  output="$("${cmd[@]}" 2>&1)"
  rc=$?
  set -e

  LAST_VALIDATION_OUTPUT="$output"
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi

  return "$rc"
}

validation_retry_budget() {
  if [[ -n "$CANDIDATE_COUNT" ]]; then
    printf '%s\n' "$CANDIDATE_COUNT"
    return
  fi

  printf '%s\n' "12"
}

selected_screenshot_from_plan() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  local plan_path="$REPO_DIR/previous-posts/$archive_key/plan.json"

  if [[ ! -f "$plan_path" ]]; then
    return 1
  fi

  node -e 'const fs=require("fs"); const plan=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(plan?.post?.screenshot_file || ""));' "$plan_path"
}

candidate_count_from_context() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  local context_path="$REPO_DIR/previous-posts/$archive_key/context.json"

  if [[ ! -f "$context_path" ]]; then
    printf '%s\n' "0"
    return
  fi

  node -e 'const fs=require("fs"); const context=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(Array.isArray(context?.candidate_screenshots) ? context.candidate_screenshots.length : 0));' "$context_path"
}

is_retryable_validation_failure() {
  [[ "$LAST_VALIDATION_OUTPUT" == *"is too close to recent"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"overlaps too heavily with recent archive"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"duplicates recent archive headline"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"uses banned jargon"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"must directly describe notification"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Post opening hook"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Post CTA pattern"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Weekly admin-only cap already reached"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Weekly dark-mode cap already reached"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Model returned content_format"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Unknown content format"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"already reached the weekly cap"* ]]
}

is_message_overlap_validation_failure() {
  [[ "$LAST_VALIDATION_OUTPUT" == *"is too close to recent"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"overlaps too heavily with recent archive"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"duplicates recent archive headline"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Post opening hook"* ]] ||
    [[ "$LAST_VALIDATION_OUTPUT" == *"Post CTA pattern"* ]]
}

is_critic_validation_failure() {
  [[ "$LAST_VALIDATION_OUTPUT" == *"Editorial critic score"* ]]
}

build_critic_rewrite_prompt() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  local source_prompt="$REPO_DIR/previous-posts/$archive_key/prompt.txt"

  {
    cat "$source_prompt"
    printf '\n'
    printf '%s\n' "Rewrite request:"
    printf '%s\n' "The previous draft failed the editorial critic gate. Rewrite the same daily plan before rendering."
    printf '%s\n' "Keep the same JSON schema and continue to use one of the shortlisted screenshots."
    printf '%s\n' "Address the critic rationale below with a fresher hook, clearer audience value, stronger Hush Line relevance, and a non-repetitive CTA."
    printf '%s\n' "$LAST_VALIDATION_OUTPUT" | sed -n '1,30p'
  } > "$PROMPT_FILE"
}

build_validation_rewrite_prompt() {
  local archive_key="${ARCHIVE_KEY:-$DATE}"
  local source_prompt="$REPO_DIR/previous-posts/$archive_key/prompt.txt"
  local selected_screenshot="$1"

  {
    cat "$source_prompt"
    printf '\n'
    printf '%s\n' "Rewrite request:"
    printf '%s\n' "The previous draft failed archive-overlap validation. Rewrite the same daily plan before rendering."
    printf '%s\n' "Keep the same JSON schema and use the same screenshot: $selected_screenshot"
    printf '%s\n' "Use a meaningfully different angle, headline, opening hook, value proposition, and CTA from the rejected recent archive."
    printf '%s\n' "Do not reuse the rejected wording or merely swap synonyms; the validator compares shared message tokens."
    printf '%s\n' "Validation rejection:"
    printf '%s\n' "$LAST_VALIDATION_OUTPUT" | sed -n '1,40p'
  } > "$PROMPT_FILE"
}

array_contains() {
  local needle="$1"
  shift
  local value=""

  for value in "$@"; do
    if [[ "$value" == "$needle" ]]; then
      return 0
    fi
  done

  return 1
}

run_with_validation_retries() {
  local retry_budget=""
  local selected_screenshot=""
  local available_candidate_count=""
  local critic_retry_used=0
  local validation_rewrite_screenshot=""
  local validation_rewrite_used=0

  retry_budget="$(validation_retry_budget)"

  while true; do
    build_context
    reset_day_plan_artifacts

    cp "$REPO_DIR/previous-posts/$ARCHIVE_KEY/prompt.txt" "$PROMPT_FILE"
    run_codex_from_prompt

    while true; do
      if validate_and_render; then
        return 0
      fi

      if is_critic_validation_failure; then
        if (( critic_retry_used == 1 )); then
          echo "Editorial critic gate failed after one rewrite attempt; blocking daily planner before render/publish." >&2
          return 1
        fi

        critic_retry_used=1
        echo "Editorial critic gate requested a rewrite; retrying Codex once with critic feedback."
        build_critic_rewrite_prompt
        reset_day_plan_artifacts
        run_codex_from_prompt
        continue
      fi

      if is_message_overlap_validation_failure; then
        selected_screenshot="$(selected_screenshot_from_plan || true)"
        if [[ -z "$selected_screenshot" ]]; then
          echo "Validation failed, but the selected screenshot could not be recovered for an automatic rewrite." >&2
          return 1
        fi

        if (( validation_rewrite_used == 0 )); then
          validation_rewrite_used=1
          validation_rewrite_screenshot="$selected_screenshot"
          echo "Archive-overlap validation requested a rewrite; retrying Codex once with validator feedback."
          build_validation_rewrite_prompt "$selected_screenshot"
          reset_day_plan_artifacts
          run_codex_from_prompt
          continue
        fi
      fi

      break
    done

    if ! is_retryable_validation_failure; then
      return 1
    fi

    selected_screenshot="$(selected_screenshot_from_plan || true)"
    if [[ -z "$selected_screenshot" ]]; then
      echo "Validation failed, but the selected screenshot could not be recovered for an automatic retry." >&2
      return 1
    fi

    available_candidate_count="$(candidate_count_from_context)"
    if [[ "$available_candidate_count" =~ ^[0-9]+$ ]] && (( available_candidate_count <= 1 )); then
      echo "Validation failed after rewrite, and no alternate shortlisted screenshots are available for $selected_screenshot." >&2
      return 1
    fi

    if (( ${#EXCLUDED_SCREENSHOTS[@]} > 0 )) && array_contains "$selected_screenshot" "${EXCLUDED_SCREENSHOTS[@]}"; then
      echo "Validation failed again for already-excluded screenshot $selected_screenshot." >&2
      return 1
    fi

    EXCLUDED_SCREENSHOTS+=("$selected_screenshot")
    critic_retry_used=0
    validation_rewrite_screenshot=""
    validation_rewrite_used=0
    if (( ${#EXCLUDED_SCREENSHOTS[@]} >= retry_budget )); then
      echo "Daily planner exhausted its validation retry budget after excluding ${#EXCLUDED_SCREENSHOTS[@]} screenshots." >&2
      return 1
    fi

    echo "Retrying daily planner with excluded screenshot: $selected_screenshot"
  done
}

push_archive() {
  if (( NO_PUSH == 1 )); then
    echo "Archive push skipped."
    return
  fi

  if (( FORCE_PUSH == 0 )) && [[ "$ARCHIVE_PUSH_ENABLED" != "1" ]]; then
    echo "Archive push skipped."
    return
  fi

  local -a cmd=("$REPO_DIR/scripts/push_previous_posts_archive.sh" --date "$DATE")
  [[ -n "$ARCHIVE_KEY" ]] && cmd+=(--archive-key "$ARCHIVE_KEY")
  "${cmd[@]}"
}

verify_screenshot_source() {
  local manifest_path="$SCREENSHOTS_REPO_DIR/releases/latest/manifest.json"
  local local_release=""
  local local_captured_at=""
  local age_days=""
  local remote_status=""
  local freshness_status="stale"

  if [[ ! -d "$SCREENSHOTS_REPO_DIR/.git" ]]; then
    echo "Missing screenshots repo checkout: $SCREENSHOTS_REPO_DIR" >&2
    exit 1
  fi

  if [[ ! -f "$manifest_path" ]]; then
    echo "Missing latest screenshots manifest: $manifest_path" >&2
    exit 1
  fi

  local_release="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.release || ""));' "$manifest_path")"
  local_captured_at="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.capturedAt || ""));' "$manifest_path")"
  age_days="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const captured=new Date(m.capturedAt); const age=Math.floor((Date.now()-captured.getTime())/86400000); process.stdout.write(String(age));' "$manifest_path")"

  echo "Latest screenshots manifest: release=${local_release:-unknown} captured_at=${local_captured_at:-unknown} age_days=$age_days"

  if [[ "$age_days" =~ ^[0-9]+$ ]] && (( age_days <= SCREENSHOT_MAX_AGE_DAYS )); then
    freshness_status="fresh"
  fi

  echo "Checking upstream latest screenshots manifest."
  remote_status="$(remote_manifest_status "$manifest_path")"

  if [[ "$remote_status" == "match" ]]; then
    if [[ "$ALLOW_STALE_SCREENSHOTS" != "1" ]] && [[ "$freshness_status" != "fresh" ]]; then
      echo "Latest screenshots manifest is older than ${SCREENSHOT_MAX_AGE_DAYS} days." >&2
      echo "Set HUSHLINE_ALLOW_STALE_SCREENSHOTS=1 to override intentionally." >&2
      exit 1
    fi

    echo "Local latest screenshots manifest matches upstream."
    return
  fi

  if [[ "$remote_status" == "probe_failed" ]]; then
    if [[ "$ALLOW_STALE_SCREENSHOTS" == "1" ]]; then
      echo "Warning: unable to verify the upstream latest screenshots manifest, but continuing because HUSHLINE_ALLOW_STALE_SCREENSHOTS=1."
      return
    fi

    if [[ "$freshness_status" == "fresh" ]]; then
      echo "Warning: unable to verify the upstream latest screenshots manifest after ${SCREENSHOT_REMOTE_CHECK_ATTEMPTS} attempts, but the local latest manifest is still within the freshness window."
      return
    fi

    echo "Unable to verify the upstream latest screenshots manifest after ${SCREENSHOT_REMOTE_CHECK_ATTEMPTS} attempts." >&2
    echo "Set HUSHLINE_ALLOW_STALE_SCREENSHOTS=1 to override intentionally." >&2
    exit 1
  fi

  if [[ "$SCREENSHOT_AUTO_SYNC" == "1" ]]; then
    echo "Local latest screenshots manifest is stale. Syncing upstream latest snapshot."
    node "$REPO_DIR/scripts/sync-latest-screenshots.js" --dest "$SCREENSHOTS_REPO_DIR/releases/latest"

    local_release="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.release || ""));' "$manifest_path")"
    local_captured_at="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.capturedAt || ""));' "$manifest_path")"
    age_days="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const captured=new Date(m.capturedAt); const age=Math.floor((Date.now()-captured.getTime())/86400000); process.stdout.write(String(age));' "$manifest_path")"
    freshness_status="stale"
    if [[ "$age_days" =~ ^[0-9]+$ ]] && (( age_days <= SCREENSHOT_MAX_AGE_DAYS )); then
      freshness_status="fresh"
    fi

    echo "Synced screenshots manifest: release=${local_release:-unknown} captured_at=${local_captured_at:-unknown} age_days=$age_days"

    if [[ "$ALLOW_STALE_SCREENSHOTS" != "1" ]] && [[ "$freshness_status" != "fresh" ]]; then
      echo "Latest screenshots manifest is older than ${SCREENSHOT_MAX_AGE_DAYS} days after sync." >&2
      echo "Set HUSHLINE_ALLOW_STALE_SCREENSHOTS=1 to override intentionally." >&2
      exit 1
    fi

    remote_status="$(remote_manifest_status "$manifest_path")"
    if [[ "$remote_status" == "match" ]]; then
      echo "Local latest screenshots folder synced to upstream."
      return
    fi

    if [[ "$remote_status" == "probe_failed" ]]; then
      echo "Latest screenshot sync completed, but the upstream manifest could not be re-verified." >&2
      exit 1
    fi

    echo "Automatic latest screenshot sync did not produce an upstream-matching manifest." >&2
    exit 1
  fi

  if [[ "$ALLOW_STALE_SCREENSHOTS" == "1" ]]; then
    echo "Warning: local latest screenshots manifest does not match upstream, but continuing because HUSHLINE_ALLOW_STALE_SCREENSHOTS=1."
    return
  fi

  echo "Local latest screenshots manifest does not match upstream and automatic sync is disabled." >&2
  exit 1
}

remote_manifest_status() {
  local manifest_path="$1"
  local attempt=""
  local probe_file=""
  local probe_pid=""
  local timed_out=0
  local rc=0
  local local_release=""
  local local_captured_at=""
  local remote_manifest=""
  local remote_release=""
  local remote_captured_at=""
  local result="probe_failed"

  local_release="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.release || ""));' "$manifest_path")"
  local_captured_at="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.capturedAt || ""));' "$manifest_path")"

  for ((attempt = 1; attempt <= SCREENSHOT_REMOTE_CHECK_ATTEMPTS; attempt += 1)); do
    probe_file="$(mktemp)"
    (
      curl -fsSL https://raw.githubusercontent.com/scidsg/hushline-screenshots/main/releases/latest/manifest.json >"$probe_file" 2>&1
    ) &
    probe_pid=$!
    timed_out=0
    rc=0

    for ((i = 0; i < SCREENSHOT_REMOTE_CHECK_TIMEOUT_SECONDS; i += 1)); do
      if ! kill -0 "$probe_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    if kill -0 "$probe_pid" >/dev/null 2>&1; then
      timed_out=1
      kill "$probe_pid" >/dev/null 2>&1 || true
      wait "$probe_pid" >/dev/null 2>&1 || true
    else
      set +e
      wait "$probe_pid"
      rc=$?
      set -e
    fi

    if (( timed_out == 0 )) && (( rc == 0 )) && [[ -s "$probe_file" ]]; then
      remote_manifest="$(cat "$probe_file")"
      rm -f "$probe_file"
      remote_release="$(printf '%s' "$remote_manifest" | node -e 'let data=""; process.stdin.on("data",(chunk)=>data+=chunk); process.stdin.on("end",()=>{const m=JSON.parse(data); process.stdout.write(String(m.release || ""));});')"
      remote_captured_at="$(printf '%s' "$remote_manifest" | node -e 'let data=""; process.stdin.on("data",(chunk)=>data+=chunk); process.stdin.on("end",()=>{const m=JSON.parse(data); process.stdout.write(String(m.capturedAt || ""));});')"
      if [[ "$local_release" == "$remote_release" && "$local_captured_at" == "$remote_captured_at" ]]; then
        result="match"
      else
        result="mismatch"
      fi
      printf '%s\n' "$result"
      return 0
    fi

    if (( attempt < SCREENSHOT_REMOTE_CHECK_ATTEMPTS )); then
      sleep 1
    fi

    rm -f "$probe_file"
  done

  printf '%s\n' "$result"
  return 0
}

main() {
  parse_args "$@"
  if [[ -z "$ARCHIVE_KEY" ]]; then
    ARCHIVE_KEY="$DATE"
  fi
  skip_if_weekend

  require_cmd codex
  require_cmd node

  echo "Runner Codex config: model=$CODEX_MODEL reasoning_effort=$CODEX_REASONING_EFFORT verbose_codex_output=$VERBOSE_CODEX_OUTPUT"

  verify_screenshot_source
  run_with_validation_retries
  push_archive
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
