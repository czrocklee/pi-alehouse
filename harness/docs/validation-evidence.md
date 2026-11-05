# Portable validation scope

This page states what each validation lane can and cannot establish. It is
**not public release acceptance**: [limitations](limitations.md) and
[release-policy.json](../release-policy.json) remain PENDING, and no inherited
test baseline, fixture exit code or local observation grants acceptance.

It deliberately holds no run log. Record each run in the commit that changes
the validated code or pins, so the record stays tied to the exact tree it
observed: command, exit code, Node/Pi versions, source revision,
generated-runtime hash, test counts (passed, failed, skipped) and every lane or
gate left unrun. Earlier per-upgrade records remain in git history. Zero
matched tests is not success. Do not migrate private acceptance reports,
session fingerprints, transcripts, authorization packets, or unrelated personal
observations into public evidence.

## Lanes

| Lane | Intended evidence | Not established |
| --- | --- | --- |
| Root `npm ci --ignore-scripts && npm run build && npm run check` | Lockfile installation, matched generated runtime, lint/type checks, package unit/SDK/packaging tests and portable policy checks when scripts pass | Real provider quality, deployability, human UI, fresh host compatibility |
| Portable policy suite (separate from package tests) | Generated worker definitions, static guard, policy-aware grep and patched permission authority under synthetic controlled calls | OS sandboxing, arbitrary scripts/paths or live human authorization |
| Controlled host integration suite (explicit invocation) | Built entrypoint, actual host SDK/loader, child tool allowlist, parent/scout web isolation (internal `researcher`), footer/Stats/UI registration, lease and shutdown with synthetic provider/UI | Remote model use, safe reload, transactionally atomic cancellation or durable recovery |
| Optional Jev controlled lane | Review provenance and forwarded asks with fabricated responses in isolated process; defer and no-key paths | Human authorization, calibrated judgments, permission grants for other contexts |
| PTY/history probes | Selected terminal and journal behavior, negative reload/IO observations | Human-TUI acceptance, fsync/power-loss guarantees |
| Built tarball install (`--omit=dev --legacy-peer-deps --ignore-scripts`) and installed-tarball RPC smoke | The package carries no Pi SDK/runtime and its CLI can open, status and close an Owner against a separately supplied host Pi without a model request | Editing, human rendering, web requests, billing or live-provider behavior |

Keep fixtures offline and output outside the checkout; never make real-model calls or copy Pi auth/session data into public reports. A controlled provider reports synthetic behavior only. In particular, SDK post-guard queue/message acceptance and unsupported live-Owner `/reload` must be tested as limitations, not relabelled safe because a selected schedule produced no post-cancel provider call. Only an actual controlled run can record an outcome. Permission authority selection must use the **built matched patched runtime**; a mutable global install or missing fixture is not a pass. A test report should distinguish failures, skipped checks and suites that matched zero tests.

## Running the lanes

From the repository root of a Linux checkout:

```sh
npm ci --ignore-scripts
npm run build
npm run check          # lint, types, package tests, then the portable policy gates
npm run test:policy    # the portable policy gates alone
```

`PI_TEST_EXECUTABLE` selects the Pi CLI the policy gates use (otherwise `pi`
on PATH); pointing it at the development CLI in `node_modules/.bin/pi` checks
the pinned SDK rather than whatever host Pi is installed. Supply trusted
absolute `flock` and Git paths and owned HOME/state directories as described in
[tests and scope](development.md#tests-and-scope). Jev audit tests reject log
directories whose ancestors appear owned by an unmapped UID, as in some
sandboxes; see
[Jev audit ownership in user namespaces](development.md#jev-audit-ownership-in-user-namespaces).
Such a run has unrun coverage, not a pass.

Controlled host lanes need separate authorization and write evidence outside
the checkout:

```sh
npm run test:integration
./scripts/collect-pi-harness-evidence.sh --jev-only --output NEW_DIR
./scripts/check-pi-sdk-history.sh --output ANOTHER_NEW_DIR
```

The production tarball install and its checks are described under
[commands](development.md#commands-repository-root).

## Existing contract regressions to preserve

- Core: Owner FIFO/idempotence, four executing per admitted provider/twelve Owner-wide resident reservations, result budgets and paging, Off with retained work, cleanup quarantine, non-regressing usage floor and unreported residue. These are the current regression targets.
- SDK/host: verified capabilities, controlled prompt/input races, natural-finish steer fallback, real SDK replacement confirmation, worker web exclusion, scout isolation (internal `researcher`) and parent tool visibility.
- Security: `editor` guarded writes, shell ask behavior, static guard and policy search, approval provenance/defer, and failure-closed readiness against the matched generated authority.
- UI: permission dialog yield, widget/detail/picker/footer/Stats projection, overlay protocol, and non-atomic replacement warnings; scripted UI is not a person.
- Negative/optional: unsafe-live-reload assertions and separately invoked Jev tests. A passed *negative* assertion documents an unsupported operation; it does not authorize that operation.

## Current evidence and gaps

Recorded runs are limited observations, not a completed public acceptance
review. No run establishes npm publication, live-provider trials, external
reviewer calibration, human approval acceptance, complete billing, general
cross-version support, atomic cancellation, safe reload or end-to-end recovery.
Do not reuse a prior local GO as a deployment gate. See
[development](development.md) for commands and [security](security.md) for what
permission tests cannot prove.
