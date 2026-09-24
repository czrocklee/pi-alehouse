#!/usr/bin/env bash
# Explicit opt-in: calls a REAL model via the canonical trial runner.
# SDK OAuth refresh may update the existing auth file IN PLACE.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run-pi-harness-live-trial.sh" "$@"
