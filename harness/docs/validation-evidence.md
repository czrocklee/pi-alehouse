# Portable validation scope

This records scoped source-extraction checks, **not public release acceptance**.
[Limitations](limitations.md) and [release-policy.json](../release-policy.json)
remain PENDING. The inherited harness had an 801-test baseline; the current
latest root check passed 847/847 package tests, including 26 runtime tests
(with a fresh-per-session harness readiness witness), eight immutable-resource-
protection regressions, two explicit-model rejection tests, two
publication-fixture checks and three panel-export privacy checks. Record command, exit code, Node/Pi versions,
source revision, generated-runtime hash and test counts on rerun; zero matched
tests is not success. Do not migrate private acceptance reports, session
fingerprints, transcripts, authorization packets, or unrelated personal
observations into public evidence.

## Lanes

| Lane | Intended evidence | Not established |
| --- | --- | --- |
| Root `npm ci --ignore-scripts && npm run build && npm run check` | Lockfile installation, matched generated runtime, lint/type checks, package unit/SDK/packaging tests and portable policy checks when scripts pass | Real provider quality, deployability, human UI, fresh host compatibility |
| Portable policy suite (separate from package tests) | Generated worker definitions, static guard, policy-aware grep and patched permission authority under synthetic controlled calls | OS sandboxing, arbitrary scripts/paths or live human authorization |
| Controlled host integration suite (explicit invocation) | Built entrypoint, actual host SDK/loader, child tool allowlist, parent-only web, footer/Stats/UI registration, lease and shutdown with synthetic provider/UI | Remote model use, safe reload, transactionally atomic cancellation or durable recovery |
| Optional Jev controlled lane | Review provenance and forwarded asks with fabricated responses in isolated process; defer and no-key paths | Human authorization, calibrated judgments, permission grants for other contexts |
| Optional Luna negative co-load lane | No unintended second authorizer in explicit harness process | Usable Luna automated review |
| PTY/history probes | Selected terminal and journal behavior, negative reload/IO observations | Human-TUI acceptance, fsync/power-loss guarantees |

Keep fixtures offline and output outside the checkout; never make real-model calls or copy Pi auth/session data into public reports. A controlled provider reports synthetic behavior only. In particular, SDK post-guard queue/message acceptance and unsupported live-Owner `/reload` must be tested as limitations, not relabelled safe because a selected schedule produced no post-cancel provider call. Only an actual controlled run can record an outcome. Permission authority selection must use the **built matched patched runtime**; a mutable global install or missing fixture is not a pass. A test report should distinguish failures, skipped checks and suites that matched zero tests.

## Observed checks and reproducible scope

From a Linux checkout with host Pi 0.87.1 available, the scoped source gate is:

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

The latest root `npm run check` passed **847/847 package tests** (including
26 runtime tests with a fresh-per-session harness readiness witness, eight
immutable-resource-protection regressions, two explicit-model rejection tests,
two publication-fixture checks and three panel-export privacy checks), plus the
portable policy gates. The
publication checks assert neutral Off/empty production routing and synthetic,
fixture-only model/policy scopes (`/tmp`, `/proc`, fixture-prefixed paths), not
a real provider. This is a package/static/controlled-SDK result, not a
real-model, human UI or deployability claim. An isolated
source-development host lane passed under controlled IO. The final full/readonly
collector, explicit Jev lane, and separate SDK-history lane also passed, each in
its declared controlled scope. Reproduce separately, outside a checkout for
evidence output:

```sh
npm run test:integration
./scripts/collect-pi-harness-evidence.sh --jev-only --output NEW_DIR
./scripts/check-pi-sdk-history.sh --output ANOTHER_NEW_DIR
```

The final collector pass followed a fixture-only timing correction: after the
abort budget is exhausted, the assertion observes an actual shutdown-dispatch
attempt before disposal rather than requiring every shutdown handler to finish.
Handler completion is asserted for settled cases. Existing late/no-idle-
certificate, retained-lock and cleanup-uncertainty checks remain; the corrected
fixture does **not** repair or expand runtime cancellation/shutdown guarantees.
Controlled routing fixtures now use only synthetic, fixture-prefixed preset and
model IDs with no personal cwd; live CLI trials require an explicitly supplied
model. These are test-isolation boundaries, not real-model validation.

The final built `npm pack` tarball installed into an isolated prefix with
`npm install --prefix TEMP/install --omit=dev --legacy-peer-deps --ignore-scripts
PACKAGE.tgz` and contained **no Pi SDK/runtime**. With a separately installed
host Pi 0.87.1 and isolated agent directory, its CLI initialized absent
resources and an RPC smoke flow created an Owner, read status and closed,
including the latest per-session readiness change, without a model request.
Reproduce against an isolated install/agent/session root, not real credentials.
This smoke establishes neither editing, human rendering, web requests, billing,
nor live-provider behavior. Parent-only pinned web access emitted an optional eager-tool warning:
upstream host-version detection could not resolve an aliased SDK path. Eager
availability remains subject to normal parent permissions; it is neither a
permission bypass nor a reason to bundle another Pi SDK. Child web remains
excluded.

## Existing contract regressions to preserve

- Core: Owner FIFO/idempotence, four executing/eight resident reservations, result budgets and paging, Off with retained work, cleanup quarantine, non-regressing usage floor and unreported residue.
- SDK/host: verified capabilities, controlled prompt/input races, natural-finish steer fallback, real SDK replacement confirmation, child web exclusion and parent tool visibility.
- Security: `reader` direct write ceiling, `editor` guarded writes, shell ask behavior, static guard and policy search, approval provenance/defer, and failure-closed readiness against the matched generated authority.
- UI: permission dialog yield, widget/detail/picker/footer/Stats projection, overlay protocol, and non-atomic replacement warnings; scripted UI is not a person.
- Negative/optional: unsafe-live-reload assertions and separately invoked Jev/Luna tests. A passed *negative* assertion documents an unsupported operation; it does not authorize that operation.

## Current evidence and gaps

The checks above are limited observations, not a completed public acceptance
review. The fixture-only privacy neutralization and final root/policy gate
passed in their declared scope; the policy lane can also run separately via
`npm run test:policy`. No npm publication, live-provider
trial, external reviewer calibration, human approval acceptance, complete
billing, general cross-version support, atomic cancellation, safe reload or
end-to-end recovery guarantee is established. Do not reuse a prior local GO
as a deployment gate. See [development](development.md) for commands and
[security](security.md) for what permission tests cannot prove.
