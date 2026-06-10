#!/usr/bin/env bash

post_window_randomization_enabled() {
  [[ -n "${HUSHLINE_SOCIAL_LAUNCHD_SCOPE:-}" || "${HUSHLINE_SOCIAL_RANDOMIZE_POST_WINDOW:-0}" == "1" ]]
}

post_window_epoch() {
  local target_date="$1"
  local hour="$2"
  local minute="$3"

  date -j -f "%Y-%m-%d %H:%M:%S" \
    "$target_date $(printf '%02d' "$hour"):$(printf '%02d' "$minute"):00" \
    "+%s"
}

random_post_window_target_epoch() {
  local target_date="$1"
  local start_epoch=""
  local end_epoch=""
  local offset=0

  start_epoch="$(post_window_epoch "$target_date" 4 0)"
  end_epoch="$(post_window_epoch "$target_date" 9 0)"

  if (( end_epoch <= start_epoch )); then
    echo "Invalid post window for $target_date." >&2
    return 1
  fi

  offset=$((RANDOM % (end_epoch - start_epoch + 1)))
  printf '%s\n' "$((start_epoch + offset))"
}

sleep_until_post_window_target() {
  local target_epoch="$1"
  local label="$2"
  local now_epoch=""
  local wait_seconds=0

  if [[ -z "$target_epoch" ]]; then
    return 0
  fi

  now_epoch="$(date "+%s")"
  wait_seconds="$((target_epoch - now_epoch))"
  if (( wait_seconds <= 0 )); then
    echo "$label post window target has passed; publishing now."
    return 0
  fi

  echo "Waiting $wait_seconds seconds before publishing $label."
  sleep "$wait_seconds"
}

iso_week_key() {
  local target_date="$1"
  date -j -f "%Y-%m-%d" "$target_date" "+%G-%V"
}

weekday_number_for_date() {
  local target_date="$1"
  date -j -f "%Y-%m-%d" "$target_date" "+%u"
}

selected_weekday_for_week() {
  local target_date="$1"
  local week_key=""
  local checksum=""

  week_key="$(iso_week_key "$target_date")"
  checksum="$(printf '%s' "$week_key" | cksum)"
  checksum="${checksum%% *}"
  printf '%s\n' "$((checksum % 5 + 1))"
}
