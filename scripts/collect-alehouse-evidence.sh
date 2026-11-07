#!/usr/bin/env bash
# Isolated Alehouse experiments, not a production admission check. Never installs Pi.
set -euo pipefail

# Isolated parents must not inherit process-based subagent identity/routing.
# SDK fixtures audit these against the selected permission SUBAGENT_ENV_HINT_KEYS.
unset PI_AGENT_ROUTER_PARENT_SESSION_ID PI_SUBAGENT_PARENT_SESSION \
    PI_IS_SUBAGENT PI_SUBAGENT_SESSION_ID PI_AGENT_ROUTER_SUBAGENT \
    PI_SUBAGENT_CHILD PI_SUBAGENT_RUN_ID PI_SUBAGENT_CHILD_AGENT PI_SUBAGENT_DEPTH \
    PI_SUBAGENT_NAME PI_SUBAGENT_ID PI_SUBAGENT_SESSION PI_SUBAGENT_ACTIVITY_FILE
# Defense in depth: only --jev-only enables Jev enforcement for its probe.
export PI_JEV_APPROVAL_MODE=shadow
unset PI_JEV_API_KEY_FILE PI_ALEHOUSE_PERMISSION_ROOT PI_ALEHOUSE_POLICY_ROOT AGENT_DASHBOARD_URL PI_ALEHOUSE_GROK_BILLING

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$ROOT_DIR/test"
write_validation_summary() {
    # The summary records this completed evidence lane; it is not a deployment gate.
    node "$TESTS/support/release-policy.mjs" --write-validation-summary --checks-passed "$1" "$2"
}
release_notice() {
    node "$TESTS/support/release-policy.mjs" --print-release-notice
}
if ! PI_EXECUTABLE="${PI_TEST_EXECUTABLE:-$(command -v pi || true)}" || [[ -z "$PI_EXECUTABLE" ]]; then
    echo "Pi is not installed or is not on PATH." >&2
    exit 1
fi
# Offline lanes never even receive the original agent/auth directory.
INSTALLED_AGENT_DIR="/nonexistent/alehouse-offline-auth-forbidden"
TOOLS_ONLY=false
PERMISSIONS_ONLY=false
JEV_ONLY=false
ALL=false
if [[ "${1:-}" == --tools-only ]]; then
    TOOLS_ONLY=true
    shift
elif [[ "${1:-}" == --permissions-only ]]; then
    PERMISSIONS_ONLY=true
    shift
elif [[ "${1:-}" == --jev-only ]]; then
    JEV_ONLY=true
    shift
elif [[ "${1:-}" == --all ]]; then
    ALL=true
    shift
fi
if [[ $# -gt 0 ]]; then
    if [[ $# -ne 2 || "$1" != --output ]]; then
        echo "Usage: $0 [--all | --tools-only | --permissions-only | --jev-only] [--output NEW_EVIDENCE_DIRECTORY]" >&2
        exit 2
    fi
    # Refuse overwriting a previous report, symlinks, or unrelated directory.
    mkdir -m 700 -- "$2"
    OUTPUT="$(cd -- "$2" && pwd)"
else
    OUTPUT="$(mktemp -d -t alehouse-evidence-XXXXXXXX)"
fi
echo "Evidence (including failures): $OUTPUT"
scratch="$(mktemp -d -t alehouse-fixture-XXXXXXXX)"
trap 'rm -rf "$scratch"' EXIT
umask 077
# Trusted host executable, not a command resolved from a project's PATH.
export ALEHOUSE_TEST_FLOCK
if [[ -z "${ALEHOUSE_TEST_FLOCK:-}" ]]; then
    for candidate in /usr/bin/flock /bin/flock /run/current-system/sw/bin/flock; do
        if [[ -x "$candidate" ]]; then ALEHOUSE_TEST_FLOCK="$candidate"; break; fi
    done
fi
[[ "${ALEHOUSE_TEST_FLOCK:-}" == /* ]] || { echo 'Trusted absolute flock required' >&2; exit 1; }
ALEHOUSE_TEST_FLOCK="$(readlink -f "$ALEHOUSE_TEST_FLOCK")"
export PI_ALEHOUSE_FLOCK="$ALEHOUSE_TEST_FLOCK"
sha256sum "$ALEHOUSE_TEST_FLOCK" >"$OUTPUT/flock.sha256"
"$ALEHOUSE_TEST_FLOCK" --version >"$OUTPUT/flock-version.txt"
RESOURCE_DIR="$scratch/agent"
mkdir -p "$scratch/home"

if [[ ! -x "$ROOT_DIR/node_modules/.bin/tsc" || ! -x "$ROOT_DIR/node_modules/.bin/eslint" ]]; then
    echo "Run npm ci --ignore-scripts --prefix $ROOT_DIR first." >&2
    exit 1
fi
# Isolate before ALL npm / Node entrypoints, not only SDK probes.
export HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0
npm run lint --prefix "$ROOT_DIR"
# The canonical type gate includes orchestration, shared JS/declarations and extensions.
npm run typecheck --prefix "$ROOT_DIR"
npm test --prefix "$ROOT_DIR"
render_resources() {
    local target="$1" stage_output="$2" permissions_only="$3" jev_only="$4"
    mkdir -p "$target" "$stage_output"
    local lane=full
    if [[ "$permissions_only" == true ]]; then lane=readonly; fi
    if [[ "$jev_only" == true ]]; then lane=jev; fi
    node "$ROOT_DIR/scripts/checks/check-render-fixture.mjs" "$ROOT_DIR" "$target" "$stage_output" "$lane"
}
OUTPUT_ROOT="$OUTPUT"
if [[ "$ALL" == true ]]; then
    FULL_RESOURCE_DIR="$scratch/agent-full"
    READONLY_RESOURCE_DIR="$scratch/agent-readonly"
    FULL_OUTPUT="$OUTPUT_ROOT/full"
    READONLY_OUTPUT="$OUTPUT_ROOT/readonly"
    render_resources "$FULL_RESOURCE_DIR" "$FULL_OUTPUT" false false
    render_resources "$READONLY_RESOURCE_DIR" "$READONLY_OUTPUT" true false
    node "$TESTS/support/managed-authority.mjs" "$ROOT_DIR" "$FULL_RESOURCE_DIR" "$FULL_OUTPUT"
    node "$TESTS/support/managed-authority.mjs" "$ROOT_DIR" "$READONLY_RESOURCE_DIR" "$READONLY_OUTPUT"
    RESOURCE_DIR="$FULL_RESOURCE_DIR"
    OUTPUT="$FULL_OUTPUT"
else
    render_resources "$RESOURCE_DIR" "$OUTPUT" "$PERMISSIONS_ONLY" "$JEV_ONLY"
    node "$TESTS/support/managed-authority.mjs" "$ROOT_DIR" "$RESOURCE_DIR" "$OUTPUT"
fi
if [[ "$JEV_ONLY" == true ]]; then
    # Real child assembly/forwarding, fabricated model and reviewer responses.
    # No inherited key path or user HOME is visible to these processes.
    env -u PI_JEV_API_KEY_FILE HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" \
        timeout -k 5s 120s node "$ROOT_DIR/scripts/checks/check-pi-jev.mjs" "$ROOT_DIR" "$PI_EXECUTABLE" "$RESOURCE_DIR"
    env -u PI_JEV_API_KEY_FILE HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" \
        PI_CODING_AGENT_SESSION_DIR="$OUTPUT/jev-sessions" PI_JEV_APPROVAL_MODE=enforce-subagents PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/jev-approval.mjs" \
        "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT" \
        "$ROOT_DIR/test/policy/permissions.json"
    write_validation_summary "$OUTPUT" "core-and-jev-permissions"
    echo "Offline Jev integration checks passed; not live calibration. Evidence: $OUTPUT"
    release_notice
    exit 0
fi
run_permission_probe() {
    local resource_dir="$1" stage_output="$2" scope=core-and-readonly-permissions
    HOME="$scratch/home" PI_CODING_AGENT_DIR="$resource_dir" PI_CODING_AGENT_SESSION_DIR="$stage_output/readonly-sessions" \
        PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/readonly-permissions.mjs" \
        "$PI_EXECUTABLE" "$resource_dir" "$stage_output" \
        "$ROOT_DIR/test/policy/permissions.json"
    write_validation_summary "$stage_output" "$scope"
    echo "Permission checks passed ($scope); evidence-only. Evidence: $stage_output"
    release_notice
}
if [[ "$PERMISSIONS_ONLY" == true ]]; then
    run_permission_probe "$RESOURCE_DIR" "$OUTPUT"
    exit 0
fi
check_tool_layer() {
    # Test the current portable launcher and its explicit composition.
    # Capture argv without starting a real Pi.
    PI_CODING_AGENT_DIR="$RESOURCE_DIR" node "$TESTS/packaging/entry-package.mjs" "$ROOT_DIR" "$INSTALLED_AGENT_DIR" "$OUTPUT"
    HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/home/.config" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/entry.mjs" \
        "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT"
    HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/tools.mjs" \
        "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT"
    HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_CODING_AGENT_SESSION_DIR="$OUTPUT/controlled-model-sessions" \
        PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/model-trial.mjs" --controlled \
        "$PI_EXECUTABLE" "$INSTALLED_AGENT_DIR" "$RESOURCE_DIR" "$OUTPUT"
    # Three sequential isolated children, each with a 90s ceiling, plus teardown margin.
    HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 300s node "$TESTS/host/model-trial-failures.mjs" \
        "$PI_EXECUTABLE" "$INSTALLED_AGENT_DIR" "$RESOURCE_DIR" "$OUTPUT"
}
if [[ "$TOOLS_ONLY" == true ]]; then
    check_tool_layer
    write_validation_summary "$OUTPUT" "core-and-tools-only"
    echo "CHECKS: core and tools only passed. Evidence: $OUTPUT"
    release_notice
    exit 0
fi
# Immutable fixture module outside the project, without a Nix store dependency.
STORE_PROBE="$scratch/store-probe.mjs"
install -m 444 "$TESTS/packaging/store-probe.mjs" "$STORE_PROBE"
ALEHOUSE_TEST_REPORT_DIR="$OUTPUT" HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/session-integration.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT" "$STORE_PROBE"

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/run-lifecycle.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT"

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/run-lifecycle.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT" --natural-finish-steer

for boundary in initial steer soft-budget; do
    HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 120s node "$TESTS/host/run-lifecycle.mjs" \
        "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT" "--post-guard-$boundary"
done

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/run-lifecycle.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT" --initialization-failure

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/initialization-cleanup.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT"

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/session-replacement.mjs" \
    "$PI_EXECUTABLE" "$RESOURCE_DIR" "$OUTPUT"

check_tool_layer

HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
    timeout -k 5s 120s node "$TESTS/host/history-adapter.mjs" \
    "$PI_EXECUTABLE" "$OUTPUT"

# Pure JSONL polling checks belong to the TUI lane and never start Pi.
python3 "$TESTS/tui/test_driver.py"
for entry in builtin command; do
    ALEHOUSE_TEST_REPORT_DIR="$OUTPUT" HOME="$scratch/home" PI_CODING_AGENT_DIR="$RESOURCE_DIR" PI_OFFLINE=1 PI_TELEMETRY=0 \
        timeout -k 5s 55s python3 "$TESTS/tui/driver.py" "$PI_EXECUTABLE" \
        "$RESOURCE_DIR/extensions/managed-permissions/index.ts" \
        "$TESTS/tui/reload.mjs" "$OUTPUT" "$entry"
done

write_validation_summary "$OUTPUT" "core-and-full-suite"
if [[ "$ALL" == true ]]; then
    # This uses the separately rendered strict config; full-suite allowances are
    # confined to agent-full and cannot satisfy the readonly permission probe.
    run_permission_probe "$READONLY_RESOURCE_DIR" "$READONLY_OUTPUT"
    write_validation_summary "$OUTPUT_ROOT" "core-full-suite-and-readonly-permissions"
    echo "Evidence: $OUTPUT_ROOT (full suite: $FULL_OUTPUT; readonly permissions: $READONLY_OUTPUT)"
    echo "CHECKS: core, full suite, and readonly permissions passed."
    release_notice
else
    echo "Evidence: $OUTPUT"
    echo "CHECKS: passed (core and full suite; evidence collection only)."
    release_notice
fi
