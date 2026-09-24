#!/usr/bin/env bash
# Isolated harness experiments, not a production admission check. Never installs Pi.
# Controlled evidence only, not a real-model trial or deployment acceptance.
# Compatibility entrypoint; forwards unchanged to collect-pi-harness-evidence.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/collect-pi-harness-evidence.sh" "$@"
