# Development

Pi Alehouse is one root npm package for Linux. It builds without Nix; the
optional [Nix packaging](#nix-packaging) is a separate lane. The host supplies
Pi, its SDK/runtime, models and credentials. The root manifest sets
`pi.extensions: []`: `pi install` does not load Alehouse, and ordinary `pi`
does not acquire delegation. The launcher explicitly loads `src/composition.ts`
with `--no-extensions -e <absolute path>`. There is no separate orchestration
package, SDK fork or publication automation. Public release remains **PENDING**.

## Layout and responsibilities

| Path                                | Responsibility                                                            |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `bin/`, `src/composition.ts`        | Trusted launcher, init and explicit host composition.                     |
| `src/orchestration/`                | Internal Owner core, Pi adapter, model tools, history and UI projections. |
| `src/authority/`, `src/extensions/` | Permission patches, policy consumers and independent Pi integrations.     |
| `src/shared/`                       | Neutral helpers shared by orchestration and the independent footer.       |
| `resources/`, `scripts/build/`      | Prompt, policy and seed sources; generation and patching.                 |
| `generated/`, `dist/`               | Built runtime resources and development JS respectively; not source.      |

See [architecture](architecture.md) for ownership and dependency direction.
Read [security](security.md) and [limitations](limitations.md) before changing
boundaries. Keep model-visible details in the [tool contract](tool-contract.md),
routing in [routing](routing.md), and dispatch fields in [task dispatch](task-dispatch.md).

The build compiles orchestration into `dist/` and generates the matched agent
definitions, worker policy, seeds, extensions, shared helpers and integrity
manifest in `generated/`. The CLI loads the source composition and generated
resources, not `dist/`. Patch the source or generator, not built files. Keep the
private patched permission-system 32.0.3 copy's upstream LICENSE and runtime
assets. All consumers use the single generated authority entry. Web access uses
the package-local pinned `pi-web-access` 0.48.0, not a global extension.
Development pins Pi/AI/TUI 1.6.0 and TypeBox 1.3.27. These are not a production
host version lock or support matrix. Treat Pi components’ `render()` results
as read-only: Pi can reuse the same array across frames. Copy before changing
rows, and return a new array when the displayed content changes.

The immutable resource floor protects the running package and agent resources
against detectable model-tool writes. To edit this checkout with Alehouse,
use a **separately installed** CLI; do not weaken the floor or try to write from
the launcher in this same checkout. See the [resource floor](security.md#immutable-resource-floor-in-writable-installations).

## Task floor and validation ownership

1. Coordinate shared edits up front. Declare literal required paths and claimed
   outputs/build directories where applicable. Assign independent work without
   overlapping writers; the parent coordinates edits, builds and Git.
2. Keep changes focused. Use synthetic inputs, run only assigned focused checks,
   and review findings against the current contract. Fix valid findings or
   document why a change is not warranted.
3. Explicitly delegate **one validation owner** for the matched build, focused
   runtime checks and full portable gate. Freeze shared source, policy and
   schemas before the full gate. The gate builds its own matched inputs; do not
   repeat it in parallel or treat a competing build as equivalent evidence.
4. Record what actually ran, on which revision, generated inputs and platform.
   Report failures and checks that were unrun, blocked, interrupted, skipped or
   matched zero tests. Follow the [evidence guide](validation-evidence.md).

Dispatch preflight and local build-directory leases help coordinate declared
work. They are not an OS sandbox, a full-suite mutex or evidence that declared
`checks` ran. All Agents share the parent's cwd. Alehouse does not manage
worktrees. Use ordinary Git under normal permission; the [Git contract](git-read-proof.md)
explains the literal restrictions and why even queries are not a no-write guarantee.

A validation receipt can record partial execution-start source metadata and
check declarations, not source identity, actual command execution or a pass.
It needs a valid Run history boundary and successful end append; that append
is not fsync proof. Audit explicit local journals offline from the source tree:

```sh
node scripts/analyze-alehouse-journal.mjs JOURNAL.jsonl [JOURNAL.jsonl ...]
```

Output is JSON (`--json` is an alias). Invalid input fails the batch rather than
returning a partial report; that's separate from a single cold history read
being unavailable. For session-level counters use [offline session analysis](session-analysis.md).
Keep journals, transcripts and command output private and outside the source tree.

## Commands (repository root)

Use Linux, supported Node (`^22.19.0 || >=24`), npm, Bash, Git, ripgrep and
trusted util-linux `flock`. Use a local filesystem. Install locked development
inputs with `npm ci --ignore-scripts` before source checks. Dependency installs
may need registry access or a populated cache; the build and portable tests do
not require live provider calls.

- `npm run build` creates a matched runtime using the installed development inputs.
- `npm run lint` needs no build; it permits no warnings and does not autofix.
  Its targets are `src/orchestration`, `src/shared`, and `test/unit`, `test/sdk`,
  `test/packaging`, `test/host`, `test/tui` and `test/support`. It does not
  cover all source or tests: notably `src/authority`, `src/extensions`,
  `test/extensions` and `test/integration` are outside that command. See
  `package.json` and `eslint.config.mjs` for targets and file rules.
- After a fresh build, `npm run typecheck` checks orchestration, shared helpers,
  extensions and the generated authority. `npm run typecheck:extensions`
  omits the root orchestration check.
- `npm test` builds and runs package tests; `npm run test:built` requires an
  already matched build. For a focused built test, select a file directly,
  for example `node --test test/unit/core-performance.test.mjs`.
- The `test:unit`, `test:sdk` and `test:packaging` npm scripts each build first;
  `test:packaging` includes `test/integration/*.test.mjs`.
- `npm run test:policy` builds first. Use `npm run test:policy -- --built`
  only with a fresh matched build.

### Static quality gate

`npm run check` is the CI portable gate: lint, one matched build (including
orchestration typechecking), extension and authority types, package tests and
portable policy tests on that same build. `npm run format:check` is separate.

For the policy command or full gate, `PI_TEST_EXECUTABLE` selects the Pi CLI;
otherwise the scripts use `pi` on PATH. Prefer the pinned development CLI for
repeatable portable results, for example:

```sh
PI_TEST_EXECUTABLE="$PWD/node_modules/.bin/pi" npm run check
```

The standalone grammar check, `node scripts/checks/check-pi-git-grammar.mjs`,
uses development dependencies but does not need a build. It checks source
classification/tokenization, not full permission gates or Git execution.

### Tests and scope

- **Portable package:** `test/unit`, `test/sdk`, `test/packaging`,
  `test/extensions` and the package-discovered `test/integration` tests.
  These include pinned-SDK tests and offline real-composition fixtures using
  synthetic providers. The Codex WebSocket/SSE test binds an ephemeral IPv4
  loopback socket; it reports a skip if the sandbox denies that bind.
  `test/support` holds helpers, not a test lane. Default
  test globs are one directory deep; update discovery explicitly when needed.
- **Portable policy:** checks generated definitions and policy against the
  matched patched authority, not an ambient global install. It includes
  controlled Jev checks, not the separate installed-host Jev collector.
- **Controlled host:** `test/host` and explicitly invoked PTY tests in `test/tui`
  cover selected host loader, permission, lifecycle and terminal observations.
  Run the [collectors](validation-evidence.md#running-the-lanes) with separate
  authorization; do not run fixture entrypoints without their fixture paths.
- **Installed package and Nix:** use the instructions below for the exact
  artifact or generation. Neither is covered by a portable pass.

Use owned, isolated HOME, XDG and Pi state for tests that write state. Keep
per-file process isolation and sequential cases for fixtures that replace
process-global state or network entrypoints. Don't point tests at real auth,
models or session files. Use `ALEHOUSE_TEST_FLOCK` for a trusted absolute test
lock executable (for example `/usr/bin/flock` when present), and
`PI_ALEHOUSE_FLOCK` if the launcher can't find a trusted system candidate.
`PI_ALEHOUSE_GIT` can select a verified absolute Git for execution-start source
observations. The launcher doesn't resolve either from project PATH. Without
trusted Git, optional capture is unknown; it doesn't block ordinary tasks.

#### Jev audit ownership in user namespaces

Linux/procfs and `flock` are insufficient if the log directory's ownership
cannot be verified. The canonical log directory must belong to the current UID
and each ancestor must appear owned by that UID or root. An unmapped host
owner can appear as overflow UID 65534 and fail as `untrusted_directory_owner`.
Record the observed namespace and ownership view, and any failed or unrun
checks. Do not whitelist overflow UIDs or relax checks to obtain a pass. See
[audit recovery](jev-audit-recovery.md#user-namespace-ownership-limit).

## Matched resource migration

Treat the package, generated runtime, managed definitions, routing and
permission sources as one unit on upgrade or rollback. Rebuild whenever an
input changes, including prompt bodies. Preserve stable profile/config IDs,
`alehouse:*` records, child communication names, permission lifecycle events
and cross-extension symbols. Historical records remain literal, not live
state. Do not add retired tool aliases or hydrate old Runs and approvals.

### Compatibility index

- **Journal records:** `src/orchestration/history/run-journal.ts` defines the
  `alehouse:run-link:v1`, `alehouse:run-start:v1` and `alehouse:run-end:v1`
  boundaries; `usage-audit.ts` in the same directory records `alehouse:unreported-usage:v1`.
  `src/orchestration/extension.ts` defines `alehouse:preset-selection:v1` and
  `alehouse:delegation-mode:v1`. The parent messages `alehouse:human-cancellation:v1`
  and `alehouse:compaction-reminder:v1` come from `src/orchestration/runtime/`.
- **Events:** `src/orchestration/runtime/child-session.ts` emits `subagents:child:*`
  for session creation, binding and disposal. Under `src/orchestration/permissions/`,
  `approval-provenance.ts` and `readiness.ts` define the `pi-alehouse:approval:*`
  and `pi-alehouse:static-guard:*` exchanges. For `permissions:ui_prompt` and
  `permissions:decision`, see `src/orchestration/ui/permission-dialog-yield.ts`;
  the overlay event lives in `src/shared/overlay-protocol.mjs`.
- **Shared symbols:** search for the literal `Symbol.for` key on both sides of
  an integration. For example, `@gotgenes/pi-permission-system:session-services`
  is read by `src/authority/authority-guard.ts` and `src/extensions/jev-auto-approval.ts`.
- The retired `reader` profile is not runtime support. History can retain its
  literal ID; init leaves an existing user `agents/reader.md` untouched. See
  `test/sdk/history-and-accounting.test.mjs` and `test/integration/runtime.test.mjs`
  in a source checkout; don't restore retired reader capabilities.
- When adding an `OwnerController` or `RunCallbacks` surface, update the AST
  inventory, explicit effect/gate/projection classification and invocation cases
  in `test/unit/owner-guard-coverage.test.mjs`. Effect and gate entries need a
  synchronous guarded facade before effects or argument inspection. The inventory
  checks completeness, not whether classifications or projections are correct;
  review those separately.

### Quota reading callback

A trusted extension may install one optional, synchronous function at
`globalThis[Symbol.for('pi-alehouse:quota-reading:v1')]`. The observer checks for
it when a reading arrives, not just at startup. The function receives:

```ts
type QuotaReading = {
  provider: string; // Physical Codex provider ID captured at dispatch
  responseProvider?: string; // HTTP callback provider ID, when it differs
  observedAt: number; // Unix time in seconds; may be fractional
  windows: {
    pool: "codex";
    window: "primary" | "secondary";
    used_pct: number; // Percentage used, from 0 to 100
    duration_s?: number;
    resets_at?: number; // Unix time in seconds
  }[];
};
```

Alehouse parent and child sessions, and ordinary Pi with the footer loaded,
can emit readings from Codex response headers and stream events. If the HTTP
callback names a different provider from the physical dispatch, the reading
carries both IDs without treating them as equivalent. Recipients must confirm
that mapping independently or discard the reading. A differing WebSocket
callback identity is not reported.

Observation is scoped to the exact runtime receiver and the dispatch's session
ID. Calls through a different receiver pass through unchanged; the observer
never unwraps a proxy or substitutes the bound runtime. Only the newest live
registration for that session observes new dispatches. Releasing it restores
any previous live registration for future dispatches only; hooks captured
before it was covered remain silent. If the observer cannot restore the runtime
method on final release, it retains the dormant wrapper for rebind instead of
layering on another wrapper. Other wrappers are left intact; observation resumes
only if calls still reach the observer.

Each callback contains only the valid windows measured in that response or
event. The observer sends no cached snapshot and does not merge or deduplicate
readings. There is no replay or acknowledgement. Keep the function brief: its
result is ignored and throws do not affect the request or local display.
Without the callback, local Codex quota display still works. The observer does
not query providers or deliver readings over any transport.

### Build and verify a tarball

In a source checkout with locked development inputs, finish the required
checks first. `npm run check` already builds; when doing only an artifact build,
run `npm run build`. Pack only that matched tree. Plain `npm pack` rebuilds via
`prepack`; to package the already built and checked tree without rebuilding:

```sh
scratch=$(mktemp -d)
tarball="$scratch/$(npm pack --ignore-scripts --silent --pack-destination "$scratch")"
tar -tzf "$tarball"
sha256sum "$tarball"
```

Inspect the actual contents: source composition and launcher, matched
`generated/manifest.json` and runtime resources, private authority assets and
upstream license, and no test payloads, `dist/`, state or credentials. Do not
install an unbuilt checkout instead. For an authorized install check, install
that inspected tarball to a scratch prefix:

```sh
npm install --prefix "$scratch/install" --omit=dev --legacy-peer-deps --ignore-scripts "$tarball"
cli="$scratch/install/node_modules/.bin/pi-alehouse"
"$cli" --help
```

`--legacy-peer-deps` prevents a second Pi runtime from arriving through peer
auto-installation. Check the whole production dependency tree for absence of
Pi SDK/agent-core/TUI and TypeBox copies. The separate compatible host remains
mandatory. An empty cache can make an offline install fail (`ENOTCACHED`);
report it as such, not an offline pass. `--help` only checks the CLI entry.
For a separately authorized installed RPC smoke, use a scratch cwd, HOME,
XDG and `PI_CODING_AGENT_DIR`, the inspected CLI and an explicitly selected
host (`PI_ALEHOUSE_PI` with an absolute path). Keep the fixture offline with
no auth data, Jev key or optional network integrations. Run `"$cli" init` in
that environment, then start the CLI with `--mode rpc --no-session`. Verify
extension startup and command registration before sending `/alehouse-status`.
Then use `/alehouse-close` and confirm closure before exit. Use an RPC client
that waits for each response and sends only verified extension commands, no
model prompt. Record the tarball hash and exact host used.

### Reconcile resources and restart

Inventory and back up existing managed definitions and permission/config
sources before reconciling them manually. `pi-alehouse init` creates **only**
missing resources (five definitions, an Off routing catalogue and a permission
config). It does not repair a definition digest mismatch, replace files or
symlinks, touch credentials or settings, or enable models. Maintain user
choices and reconcile only the intended sources. For setup details see
[getting started](getting-started.md).

Confirm `/alehouse-close` completed, then stop old processes and start a
**fresh Pi process** with the matched package and definitions. Never reload
or swap code under an open Owner. Releasing all Agents is not closure. Apply
these rules to rollback too; do not infer safe lock cleanup from a PID or
elapsed time.

### One-time naming cutover

When coming from the previous namespace, stop **all** earlier Pi processes
sharing the agent directory or canonical tree. Old and current lease paths do
not coordinate, and an empty new directory doesn't prove closure. Preserve the
old configuration and journals. Init won't convert the previous catalogue or
record types. Reconcile `alehouse-presets.json` explicitly before enabling
work and start a fresh session; old selection records cannot restore it.

### Nix packaging

Use the [Nix guide](nix.md) to build the flake or inspect a prebuilt Home Manager generation. Update declarative sources, not deployed store links. Building or inspecting a generation does not activate it.

## Dependency upgrade script

`node scripts/upgrade-deps.mjs --help` describes the source-only workflow.
`--plan --package NAME` previews one selection without editing source, but can
query the registry. `--apply --package NAME` stages explicitly selected changes;
it requires a source checkout and refuses existing npm overrides, project
`.npmrc` or a shrinkwrap. This checkout's scoped development ESLint minimatch
overrides require manual review; do not remove them to force an upgrade.
Authority, Pi SDK, TypeBox and parser migrations stay manual.

For a Pi upgrade, review and retest the fullscreen integration seams:

- Check private `renderedOverlayLayouts` remains an array of painted bounds
  (`row`, `col`, `width`, `height`), including empty rows/layouts. Check native
  overlay hit dispatch and press/click capture cleanup, including cancellation.
- Check the stable TUI reference still resolves to the active renderer and old
  hooks detach from their original renderer after a switch. Verify that the
  public `Focusable.focused` setter sees focus leave and return (open Pi's
  transcript search and press `Esc` while holding a backdrop press).
- Run the focused SDK tests `test/sdk/centered-dismiss.test.mjs`,
  `test/sdk/panel-backdrop-mount.test.mjs`, `test/sdk/panel-close-gesture.test.mjs`,
  `test/sdk/popover-close-hover.test.mjs` and `test/sdk/popover-text-selection.test.mjs`
  against a matched build. Separately plan a physical-terminal smoke: select and
  copy before, during and after an overlay, and check hover. Record the terminal,
  host and results; automated SDK tests do not establish this manual result.

Review upstream API, policy, license and lockfile changes. Run upgrades serially
on a stable tree. `node scripts/upgrade-deps.mjs --verify` builds, runs the
portable gate and checks production and full dependency audits. It needs the
validation owner's coordination and approved registry access; offline, failed
or unknown audits aren't clean. None of these modes implements installation
migration, publication or deployment.

## Formatting

Use the pinned Prettier with explicit paths for focused edits, for example
`./node_modules/.bin/prettier --check docs/development.md`. `npm run format`
rewrites all supported files, so avoid it for a narrow change. Don't format
built output.

### Local commit checks

The optional `.githooks/pre-commit` runs lint and formatting on the working
tree, not just staged changes. Inspect `git config --show-origin --get core.hooksPath`
and `git rev-parse --git-path hooks/pre-commit` before opting in with
`git config --local core.hooksPath .githooks`; don't replace an existing hook
setup. These are convenience checks, not the portable gate.

For performance changes see [cache boundaries and offline benchmarks](performance.md).
A source or fixture pass does not authorize an install, live network/model
trial, human approval, deployment or publication.
