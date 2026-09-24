#!/usr/bin/env bash
# Explicit opt-in: calls a REAL model with synthetic data via existing SDK auth.
# Does not install a backend, load private conversations, or change settings.
# SDK OAuth refresh may update the existing auth file IN PLACE.
set -euo pipefail
umask 077
# Process-subagent hints must not reach this trial; SDK fixtures audit this list.
unset PI_AGENT_ROUTER_PARENT_SESSION_ID PI_SUBAGENT_PARENT_SESSION \
    PI_IS_SUBAGENT PI_SUBAGENT_SESSION_ID PI_AGENT_ROUTER_SUBAGENT \
    PI_SUBAGENT_CHILD PI_SUBAGENT_RUN_ID PI_SUBAGENT_CHILD_AGENT PI_SUBAGENT_DEPTH \
    PI_SUBAGENT_NAME PI_SUBAGENT_ID PI_SUBAGENT_SESSION PI_SUBAGENT_ACTIVITY_FILE
export PI_AUTO_APPROVAL_MODE=shadow PI_JEV_APPROVAL_MODE=shadow
unset PI_JEV_API_KEY_FILE PI_HARNESS_PERMISSION_ROOT PI_HARNESS_POLICY_ROOT AGENT_DASHBOARD_URL PI_ALEHOUSE_GROK_BILLING
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT_DIR/harness"
if [[ $# -ne 4 && $# -ne 6 ]] || [[ "${1:-}" != --output ]] ||
    [[ "${3:-}" != --model ]] || [[ ! "${4:-}" =~ ^[^/[:space:]]+/[^[:space:]]+$ ]] || [[ $# -eq 6 && "$5" != --thinking ]]; then
    echo "Usage: $0 --output NEW_DIRECTORY --model PROVIDER/MODEL [--thinking LEVEL]" >&2
    exit 2
fi
if ! PI_EXECUTABLE="$(command -v pi)"; then
    echo "Pi is not installed or is not on PATH." >&2
    exit 1
fi
INSTALLED_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -m 700 -- "$2"
OUTPUT="$(cd -- "$2" && pwd)"
echo "Real-model trial evidence (including failures): $OUTPUT"
echo "NOTICE: SDK OAuth refresh may update your existing authentication file in place." >&2
mkdir -m 700 -- "$OUTPUT/home" "$OUTPUT/agent" "$OUTPUT/sessions"
install -m 600 "$ROOT_DIR/resources/harness-presets.json" "$OUTPUT/agent/harness-presets.json"
export P0_FLOCK
if [[ -z "${P0_FLOCK:-}" ]]; then
    for candidate in /usr/bin/flock /bin/flock /run/current-system/sw/bin/flock; do
        if [[ -x "$candidate" ]]; then P0_FLOCK="$candidate"; break; fi
    done
fi
[[ "${P0_FLOCK:-}" == /* ]] || { echo 'Trusted absolute flock required' >&2; exit 1; }
P0_FLOCK="$(readlink -f "$P0_FLOCK")"
npm run build --prefix "$ROOT_DIR"
node "$ROOT_DIR/scripts/check-render-fixture.mjs" "$ROOT_DIR" --json >"$OUTPUT/resources.json"
node "$HARNESS/test/support/managed-authority.mjs" "$ROOT_DIR" "$OUTPUT/agent" "$OUTPUT"
# The inner watchdog cancels and drains; this outer bound is only a last-resort
# process-death ceiling for this synthetic, read-only, no-Bash experiment.
# Set isolation before Node imports the host/permission modules. The installed
# root above is explicit: only ModelRuntime's authPath opts into real credentials.
HOME="$OUTPUT/home" PI_CODING_AGENT_DIR="$OUTPUT/agent" PI_CODING_AGENT_SESSION_DIR="$OUTPUT/sessions" \
    PI_TELEMETRY=0 \
    timeout -k 10s 420s node "$HARNESS/test/host/model-trial.mjs" "$PI_EXECUTABLE" "$INSTALLED_AGENT_DIR" \
    "$OUTPUT/resources.json" "$ROOT_DIR/resources/permissions.json" \
    "$OUTPUT" "$4" "${6:-minimal}"
