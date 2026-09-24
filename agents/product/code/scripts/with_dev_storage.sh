#!/usr/bin/env bash
set -euo pipefail

# Wrap the host-specific launcher so the guard runs before it can start Docker.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if (( $# == 0 )); then
  echo "Usage: with_dev_storage.sh command [arguments...]" >&2
  exit 2
fi
python3 "$SCRIPT_DIR/dev_storage.py"
exec "$@"
