#!/usr/bin/env bash

social_mastodon_enabled() {
  case "${HUSHLINE_SOCIAL_MASTODON_ENABLED:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
