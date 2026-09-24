#!/usr/bin/env bash
# Hermetic integrated policy gate. No installed agent files, Nix, or real models.
set -euo pipefail
if ! PI_EXECUTABLE="${PI_TEST_EXECUTABLE:-$(command -v pi || true)}" || [[ -z "$PI_EXECUTABLE" ]]; then
    echo "Pi is not installed or is not on PATH." >&2
    exit 1
fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_EXECUTABLE="$(readlink -f "$PI_EXECUTABLE")"
umask 077
scratch="$(mktemp -d -t pi-policy-fixture-XXXXXXXX)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home" "$scratch/agent" "$scratch/evidence"
unset PI_AGENT_ROUTER_PARENT_SESSION_ID PI_SUBAGENT_PARENT_SESSION \
    PI_IS_SUBAGENT PI_SUBAGENT_SESSION_ID PI_AGENT_ROUTER_SUBAGENT \
    PI_SUBAGENT_CHILD PI_SUBAGENT_RUN_ID PI_SUBAGENT_CHILD_AGENT PI_SUBAGENT_DEPTH \
    PI_SUBAGENT_NAME PI_SUBAGENT_ID PI_SUBAGENT_SESSION PI_SUBAGENT_ACTIVITY_FILE \
    PI_JEV_API_KEY_FILE PI_HARNESS_PERMISSION_ROOT PI_HARNESS_POLICY_ROOT AGENT_DASHBOARD_URL PI_ALEHOUSE_GROK_BILLING \
    OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY GOOGLE_API_KEY
export HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/home/.config" \
    PI_CODING_AGENT_DIR="$scratch/agent" PI_CODING_AGENT_SESSION_DIR="$scratch/sessions" \
    PI_AUTO_APPROVAL_MODE=shadow PI_JEV_APPROVAL_MODE=shadow PI_OFFLINE=1 PI_TELEMETRY=0
node "$ROOT_DIR/scripts/build.mjs"
node "$ROOT_DIR/scripts/check-render-fixture.mjs" "$ROOT_DIR" "$scratch/agent" "$scratch/evidence" jev
node "$ROOT_DIR/harness/test/support/managed-authority.mjs" "$ROOT_DIR" "$scratch/agent" "$scratch/evidence"
export PI_MANAGED_PERMISSIONS_ROOT="$ROOT_DIR/runtime/permission-system/vendor"
for gate in policy git-semantics managed-permissions jev seed; do
    timeout -k 5s 180s node "$ROOT_DIR/scripts/check-pi-$gate.mjs" "$ROOT_DIR" "$PI_EXECUTABLE" "$scratch/agent"
done
for gate in stats-core worker-stats stats-view stats-sdk ui; do
    timeout -k 5s 180s node "$ROOT_DIR/scripts/check-pi-$gate.mjs" "$PI_EXECUTABLE"
done
printf '%s\n' 'PASS: portable offline policy, git, authority, Jev, stats and UI gates (not release acceptance)'
