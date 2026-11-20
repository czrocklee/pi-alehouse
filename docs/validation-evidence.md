# Validation scope and evidence

Public release remains **PENDING** in [release-policy.json](../release-policy.json).
A passing check describes only the lane, revision and environment exercised.
It is not approval to publish, deploy, activate a generation or run live trials.
See [limitations](limitations.md) for the supported operating boundaries.

## Lanes

| Lane                         | What a pass can establish                                                                                                        | What it does not establish                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Portable package             | Locked source dependencies, lint/types, a matched build, and local unit, pinned-SDK, packaging and scripted composition checks.  | Compatibility with an arbitrary installed host, or behavior of an installed artifact. |
| Portable policy              | Matched generated definitions, managed permission authority, guard/search and controlled policy checks.                          | OS isolation, arbitrary shell effects or live human approval.                         |
| Controlled host and PTY      | Selected loading, tools, permission forwarding, lifecycle and terminal behavior on the exact supplied host with synthetic IO.    | Real providers, human UI acceptance, or atomic input/cancellation.                    |
| Optional Jev and SDK history | Fabricated review and defer/forwarding behavior, or bounded SDK journal observations, respectively.                              | Reviewer calibration, human consent, crash durability or restart recovery.            |
| Installed tarball            | Exact artifact contents and production dependency tree; a separate RPC smoke can show startup, status and closure using host Pi. | Human rendering, live work or billing. `--help` alone isn't an RPC smoke.             |
| Nix and Home Manager         | Flake build, or inspection and controlled loading of a specified prebuilt generation, when separately run.                       | Activation, settings migration on a real profile, or the npm artifact's behavior.     |

A negative assertion about unsupported live-Owner reload or an SDK post-guard
race is evidence of that limit. It isn't a fix or authorization to try the
operation on a user's session. A matched portable build is not an installed
runtime swap.

## Running the lanes

The [single validation owner](development.md#task-floor-and-validation-ownership)
coordinates the portable build and gate. Use the
[source prerequisites and commands](development.md#commands-repository-root)
for `npm ci --ignore-scripts`, `npm run check` or the standalone
`npm run test:policy`. The latter rebuilds unless given `--built` with current
matched inputs. If a user namespace obscures audit path ownership, record
that limit; see [Jev audit ownership](development.md#jev-audit-ownership-in-user-namespaces).

Controlled collectors are separately authorized. From a Linux source checkout
with locked development dependencies and the [test prerequisites](development.md#tests-and-scope)
(including Python 3 for PTY), use fresh evidence paths outside source:

```sh
reports=$(mktemp -d)
PI_TEST_EXECUTABLE=/absolute/path/to/pi bash scripts/collect-alehouse-evidence.sh --all --output "$reports/host"
PI_TEST_EXECUTABLE=/absolute/path/to/pi bash scripts/collect-alehouse-evidence.sh --jev-only --output "$reports/jev"
bash scripts/checks/check-pi-sdk-history.sh --output "$reports/history"
```

`npm run test:integration` is the `--all` collector with a default temporary
output path. The host/Jev collectors run `check:package` first; the SDK-history
probe expects a fresh matched build and takes `pi` from PATH. Keep the fixtures
offline and isolated. Use the [tarball](development.md#build-and-verify-a-tarball)
and [Nix](development.md#nix-packaging) instructions for those separate lanes.

The separately authorized `scripts/run-alehouse-live-trial.sh` uses real auth.
Its Codex parent and all children use their catalogue output limits. Other
live trial parents retain the 2,048-token model override. For Codex, the
per-response limit includes reasoning and visible output; it is not a budget
for the trial as a whole. The JSON report records which limits were selected.

## Evidence and gaps

Keep raw outputs outside source. Tie a concise record to the commit or change
that it validates: source revision and dirty diff state, lockfile and generated
manifest hashes, artifact/generation identity if relevant, platform/Node/npm/Pi
versions, key configuration, commands, exit codes, test counts and evidence
paths. State explicitly what passed, failed, skipped, was blocked, interrupted,
matched zero tests, or wasn't run. A zero match isn't a pass, and an old run
isn't evidence for new source. Don't publish private transcripts, credentials,
session fingerprints or approval packets.

No routine lane establishes real-provider quality, complete billing, human
approval, safe live reload, forced exit or end-to-end recovery. Those gaps
remain visible; this page records no run outcomes or public acceptance.
