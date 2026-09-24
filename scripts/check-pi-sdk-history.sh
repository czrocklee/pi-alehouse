#!/usr/bin/env bash
# Isolated SDK-log feasibility experiment. No real model, credentials or backend switch.
set -euo pipefail
umask 077
# This isolated SDK process must not inherit live subagent routing or approval.
unset PI_AGENT_ROUTER_PARENT_SESSION_ID PI_SUBAGENT_PARENT_SESSION \
    PI_IS_SUBAGENT PI_SUBAGENT_SESSION_ID PI_AGENT_ROUTER_SUBAGENT \
    PI_SUBAGENT_CHILD PI_SUBAGENT_RUN_ID PI_SUBAGENT_CHILD_AGENT PI_SUBAGENT_DEPTH \
    PI_SUBAGENT_NAME PI_SUBAGENT_ID PI_SUBAGENT_SESSION PI_SUBAGENT_ACTIVITY_FILE
export PI_AUTO_APPROVAL_MODE=shadow PI_JEV_APPROVAL_MODE=shadow
unset PI_JEV_API_KEY_FILE PI_HARNESS_PERMISSION_ROOT PI_HARNESS_POLICY_ROOT AGENT_DASHBOARD_URL PI_ALEHOUSE_GROK_BILLING
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ne 2 || "${1:-}" != --output ]]; then
    echo "Usage: $0 --output NEW_EVIDENCE_DIRECTORY" >&2
    exit 2
fi
if ! PI_EXECUTABLE="$(command -v pi)"; then
    echo "Pi is not installed or is not on PATH." >&2
    exit 1
fi
mkdir -m 700 -- "$2"
OUTPUT="$(cd -- "$2" && pwd)"
echo "SDK history evidence (including failures): $OUTPUT"
mkdir -m 700 -- "$OUTPUT/home" "$OUTPUT/agent"
install -m 600 "$ROOT_DIR/resources/harness-presets.json" "$OUTPUT/agent/harness-presets.json"
node "$ROOT_DIR/harness/test/support/managed-authority.mjs" "$ROOT_DIR" "$OUTPUT/agent" "$OUTPUT"
HOME="$OUTPUT/home" PI_CODING_AGENT_DIR="$OUTPUT/agent" PI_CODING_AGENT_SESSION_DIR="$OUTPUT/sessions" \
    PI_OFFLINE=1 PI_TELEMETRY=0 timeout -k 5s 120s \
    node "$ROOT_DIR/harness/test/host/sdk-history.mjs" \
    "$PI_EXECUTABLE" "$OUTPUT"
