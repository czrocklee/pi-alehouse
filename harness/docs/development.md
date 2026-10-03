# Development

Pi Alehouse is a single root npm package that builds without Nix; optional Nix
packaging lives in `flake.nix` and `nix/`. The harness is internal under
`harness/`; it is not another publishable package, standalone Pi extension manifest,
SDK fork, or second permission authority. The root manifest sets
`pi.extensions: []`: `composition.ts` is CLI-only, never auto-discovered or
installed as an extension by `pi install`. The CLI explicitly launches a host
Pi process with `--no-extensions -e <absolute composition.ts>`, keeping its
runtime and credentials host-provided. Development Pi/AI/TUI SDK packages are
pinned to 1.0.0. There is no npm publication automation or
public release acceptance. See the [root README](../../README.md).

## Layout and responsibilities

```text
composition.ts                            explicit Pi extension composition
bin/pi-alehouse.mjs                       launcher and absent-only init command
scripts/build.mjs                         offline runtime generation
resources/                                worker policy and neutral configuration seeds
runtime/                                 generated matched agents, policy, lib, authority
harness/src/extension.ts                  harness composition
harness/src/routing.ts                    trusted preset parser/resolution
harness/src/core/                        SDK-free Owner/FIFO/retention/accounting
harness/src/runtime/                     SDK adapter, child assembly, lease, lifecycle
harness/src/tools/                       fixed parent/child schemas and replies
harness/src/permissions/                 readiness and Run-bound provenance
harness/src/history/                     SDK journal links, bounded cold reads, audits
harness/src/ui/                          widget, panels, footer coordination
harness/test/{unit,sdk,host,packaging,tui,support}/
extensions/  lib/  permission-system/       internal integrations and authority patches
```

`OwnerController` retains the only Owner lifecycle authority; `AgentSessionPort`
is the core execution seam, `PiAgentSessionAdapter` the concrete Pi adapter,
`FileOwnerLease` the local lock. UI projects Owner state and owns no SDK session.
`harness/src/routing.ts` holds the trusted routing logic, **not** a hidden model
catalogue. The neutral generated `harness-presets.json` starts at `off` with
empty presets; normal routing/UI tests should use controlled test catalogues,
not a developer's personal model inventory. Shared independent helpers in
root `lib/` are bundled for both harness and footer; never make the footer
import harness runtime. Permission/policy code lives outside `harness/`.

The build generates `runtime/agents/{editor,reader,researcher,Explore,Plan,general-purpose}.md`,
`runtime/worker-policy.json`, `runtime/policy/`, `runtime/lib/`, and a **private
patched** `runtime/permission-system/vendor/` copy of pinned 32.0.3. Retain
upstream LICENSE, package imports and WASM assets in that copy. The
`runtime/permission-system/index.ts` wrapper is the single authority entry;
all consumers must use that identity. Root dependencies include the parser
runtime and pinned `pi-web-access` 0.35.0; do not resolve an ambient globally
installed web extension. Generated resources and CLI must match the source
revision. `pi-alehouse init` seeds only absent files into Pi's agent directory
(six agent definitions, a version-2 Off routing catalogue and a permission
config), never changes settings/auth or replaces existing policies/catalogues. Old
`harness:*` records, child tool/config names and `Symbol.for` keys remain
compatibility protocol, not reasons to rename public schemas. Parent management
tools are a model-facing API without caller compatibility; retired names stay
only in deny/exclusion lists.

The patched permission authority's immutable process-local floor protects its
own executable package, generated resources, dependency/host code and selected
agent directory against detectable model-tool writes, independent of user
permission config. It also protects exact credential/web-config/key paths from
reads. For development tasks that edit this repository with Alehouse's model
tools, use a **separately installed CLI**, not the instance launched from this
checkout: a same-checkout runtime write-protects its own source. Keep source
build and installed runtime separate; a changed protected generation requires a
fresh Pi process. This is a permission floor, not an OS sandbox or protection
against opaque programs; see [security](security.md#immutable-resource-floor-in-writable-installations).

## Tool metadata and Off

The [tool contract](tool-contract.md) defines model-visible behavior;
[concepts](concepts.md) describes the underlying identities and lifecycle.
A portable gate is not deployment or an installed-runtime swap.

The shared policy states only task-fit/total-cost preference. No orchestration
paragraph or disabled-mode reminder is injected into the model prompt. Tool
metadata contains API semantics. The `finished` field is part of harness tool
results, never a rewrite of other context. All nine management tools (including
agent_answer) are registered once; initial Off exposes none, Off after accepted
work keeps wait/read/interrupt/kill/list unchanged. Off gates new tasks, steering
and answers; accepted child alert/ask work continues. Child communication is
exactly alert_parent/ask_parent: notify_parent is retired, denied and display-only
in historical journals, never a runtime alias or restart-hydration input. Cached tools are still execution-gated. Controlled entry fixtures
should inspect provider-visible declarations; switching Off cannot erase
historical context. Keep user workflow choices out of standing policy.

## Communication integration obligations

Owner owns one typed model/lifecycle observation collection and non-reentrant
drain. Entry and ready-to-publish external reads are guarded synchronous
read-only phases; effecting facades guard before any mutation or async enqueue.
Real abort/timer listeners may only latch signals/defer the same drain. A failed
validator/snapshot/publisher rejects only its observer, with zero communication
commit and no fabricated Owner cleanup fault. Lifecycle observers never call
model validators/publishers; actual execution/cleanup promises remain shutdown
proof. Empty observers are not confirmed closure. Lifecycle waits accept finite
0--2147483647 ms, including fractions; an omitted timeout arms no timer. These
are separate from the model's integer 0--300000 ms bounds/defaults. Validate
kill's duration before cancellation, question changes, exiting or disposal,
including idle and already released branches.

Every new public Owner entry or Run callback needs an explicit effect/gate/
projection classification in `test/unit/owner-guard-coverage.test.mjs`. Its
TypeScript AST inventory includes public getters and optional callbacks, not
private helpers or static construction; new member shapes require review.
Effecting async APIs must retain a synchronous guarded facade. The same named
cases exercise pre-effect rejection, swallowed violations and unchanged state;
projection cases must remain callable under the read-only gate. Update this
coverage with each API addition, including methods that can latch faults despite
sounding read-only. Classification review is still necessary: AST completeness
alone cannot prove an entry is harmless. Native signal listeners remain the
narrow latch-only exception, not a new public effecting path.

`OwnerController.list()` samples lease health once per batch and derives
ordinals from retained Runs in that call. Independent view calls and commands
check freshly; do not persist ordinal or authority caches or treat a projection
as command admission.

A waiter losing an alert publication keeps its registration, timer and original
timeout budget. Arm a timer only when still waiting; its callback latches expiry
without rechecking the clock. Zero waits check readiness and empty selection
before arming any timer.

Spawn/run/send/answer/wait/read produce the same envelope, including derived
task sequence and action facts. Task binding is separate from typed alert scope.
All bound rows/pending names remain complete; createOwnerTools must reject
resident >16 (extension fixes eight), leaving core capacity configurable. As the
last assembly step, it explicitly binds the Owner to model-compatible names:
all retained Agents, including released history, must have unique valid model
names. Failed binding has no effects; successful binding lasts for that Owner,
including Off, and final core admission rejects incompatible new work before
allocation. Replays remain before new-work validation. Unbound generic core
Owners retain optional, arbitrary or repeated display names. Low-level `observe`
is a model-packing seam with representability preconditions, not a conversion
of arbitrary generic history. Never filter or rename accepted facts to make an
incompatible Owner appear supported. Read prioritizes whole questions and pins cursor Run independently of Agent alerts;
inline observations see only their accepted/bound Run. Do not use legacy progress
claims or name-based finished consumption.

One Owner pending FIFO derives 64/16 quotas; closed/full callbacks fail before
acceptance. Questions are first-write-wins on Run; explicit answer uses the same
128-bit Owner/generation/Run token function for projection and validation, atomic
reservation/replay and real inputEntered cancellation boundaries. Per-Run
finished_presented/settled_seq are the sole finished-presentation state.
New answer admission must latch observed lease loss before token checks and
again after preparation; apparent lease recovery cannot reopen authority.
Observation admission-reader errors reject with zero publication rather than
masquerading as Off. Commands retain fail-closed admission and accepted replay.

Pure snapshots feed synchronous packing, double-JSON UTF-8 checks and final
ToolResult construction **before** reference validation and callback-free
all-or-none commit. Validate original task/label provenance against all retained
Runs, not just agreement between a snapshot and its own envelope. Keep bound
original Run references private and aligned with task rows. Finished candidates
link to those originals explicitly; other finished rows are an ordered prefix.
Never infer a Run association from matching names, task ordinals or statuses.
Capture reportedBlockAtStart at registration, including undefined. Fault commit
validates currentBlocked against snapshot.blocked, not another waiter's updated
reported marker; concurrent pre-edge waiters may report idempotently. Invalid
references reject with zero presentation changes and no automatic retry.
Settled result snapshots carry cursor identity even when their captured page
reaches EOF; live previews never do. Only the final packed page reaching EOF
omits next_cursor. Promise/thenable observation ports are interface errors, not
awaitable work. A fixed-width
37-character stateless cursor is reserved for every bound terminal window with
unshown retained text, even if the whole page is displaced after Agent reuse.
The conservative alert/control/token/cursor reservation bound is 65045 bytes;
see [packing budgets](tool-contract.md#budget-and-local-publication).
Tool success only passes that result through, without later
assertCurrent/serialization/withChanges/UI. onRunAccepted UI wake stays separate
best-effort before observation. The SDK tool_result hook may append usage, not
rewrite content or serve as alert ACK. UI projects pending counts only and never
consumes alerts or finished facts. Historical notify/progress/send-answered
formatting is read-only.

Coordinate one validation owner for build → focused tests → full portable gate
after shared source/policy/schema changes are frozen. Do not repeat the full gate
against an inconsistent shared checkout. Report unrun, interrupted and zero-match
checks honestly; synthetic seams do not establish host/model acceptance.

## Matched resource migration

Treat package, generated runtime, managed definitions and permission policy as
one migration unit:

- Keep core/tools/extension, runtime adapters, policy checks, worker sources,
  generators, UI and contract docs consistent. Generate runtime agents, policy,
  seeds and integrity manifests through the build, never by editing vendor output;
  retain the upstream permission-system LICENSE.
- Verify a **built tarball** before installation. Production uses
  `--omit=dev --legacy-peer-deps --ignore-scripts`; the host Pi runtime stays
  separately supplied. Tests or installation do not authorize publication or
  deployment.
- Inventory and back up existing managed definitions and permission/config
  sources before explicit manual reconciliation. `bin/runtime-support.mjs`
  checks exact definition digests, including worker-body changes. Absent-only
  init never repairs existing mismatches or overwrites files/symlinks. Preserve
  user choices and credentials; never copy credentials or silently enable models.
  Routing defaults to Off.
- Keep all nine management tools and retired names denied/excluded in children;
  allow only the intended `alert_parent`/`ask_parent` communication tools and
  retire `notify_parent` to an explicit deny, without an alias. Preserve Git,
  path, web, immutable-resource and lease boundaries. Keep profile/config IDs,
  `harness:*` records, lifecycle events and `Symbol.for` keys compatible.
- For declarative packaging, coordinate the package pin, module wiring,
  generated definitions and permission sources together. Reconcile their source,
  not deployed store links. Nix validation and activation require their own
  authorization and evidence; they are not npm build inputs.
- Confirm existing Owners are closed, then start a **fresh Pi process** with all
  matching resources. Never reload or swap runtime under an open Owner. Rollback
  must restore the same matched unit. Historical journals remain display-only;
  they do not recover pending alerts, answer reservations or live authority.

## Tests and scope

| Directory | Scope |
| --- | --- |
| `harness/test/unit` | helpers, in-process mocks, isolated local lease tests |
| `harness/test/sdk` | real pinned development SDK with controlled IO |
| `harness/test/host` | controlled installed-host SDK runs; **not** default package tests |
| `harness/test/packaging`, `test/runtime` | package/resource/CLI and legacy wrapper contracts; offline real-composition Agent spawns (child factory, researcher web, forwarded asks) with a scripted provider |
| `harness/test/tui` | explicitly invoked PTY/terminal interaction |
| `harness/test/support` | synthetic providers and fixtures |

Node package tests should keep per-file process isolation and sequential cases
for fixtures that mutate environment/timers/listeners. `harness/test/host/jev-approval.mjs`
replaces native network entrypoints for a dedicated process lifetime: do not
import it into a shared runner or restore real network functions before exit.
Host/PTY fixtures require explicit collectors and report controlled scope;
no fixture run authorizes real provider calls or human approvals. In local
lease tests, `HARNESS_FLOCK` takes precedence with `P0_FLOCK` compatibility
fallback; on Linux supply an absolute trusted util-linux path, e.g.
`HARNESS_FLOCK=/usr/bin/flock npm test`. The launcher uses
`PI_HARNESS_FLOCK` or checks trusted absolute util-linux candidates
(`/usr/bin/flock`, `/bin/flock`, `/run/current-system/sw/bin/flock`); it does
not use an arbitrary `flock` from PATH. This is not a sandbox/distributed lock.

## Static quality gate

Root `npm run check` runs lint, typecheck, package tests and the portable
policy suite. `npm run test:policy` is independently invocable;
`npm run test:integration` invokes a separate controlled host collector, not a
release or live-model gate. Record command output, counts and review outcomes
outside source; keep reusable contracts and test obligations here. See
[validation scope](validation-evidence.md).
Check exact script behavior and test counts before reporting a new result. ESLint's typed TS source rules and JS fixture/shared-helper lint run
with zero warnings and no autofix. The harness TS check retains strict and
`noUncheckedIndexedAccess`/unused binding checks; the shared `.mjs`/`.d.mts`
checker checks actual JS bodies and declarations in separate temporary trees
without executing helpers. The extension type gate checks a bounded existing
diagnostic baseline but rejects other diagnostics or abnormal termination.
This static analysis does not prove accounting arithmetic, permission semantics
or provider behavior. Preserve explicit Promise ownership and fail-closed error
paths. Node 22.19+ (or 24+) is needed by ESLint 10.

## Commands (repository root)

| Purpose | Command | Scope |
| --- | --- | --- |
| Install locked development deps | `npm ci --ignore-scripts` | Includes pinned Pi SDK for development; no install scripts/model calls. |
| Generate matching runtime | `npm run build` | Offline build; not a release. |
| Check portable package + policy | `npm run check` | Lint, type, package tests, policy. |
| Lint / types | `npm run lint`; `npm run typecheck` | Static only. |
| Package lanes | `npm test`; `npm run test:unit`; `npm run test:sdk`; `npm run test:packaging` | Controlled local tests. |
| Portable policy separately | `npm run test:policy` | Synthetic policy/authority checks. |
| Controlled host collector | `npm run test:integration` | Separately authorized controlled full/readonly suite; not a release gate. |
| Focused host fixtures | `harness/test/host/session-integration.mjs`, `run-lifecycle.mjs` | Invoke through the isolated collector with required host/fixture paths; never run bare npm scripts as proof. |
| Init absent resources | `node bin/pi-alehouse.mjs init` | Explicit eight-file seed, no overwrite; inspect conflicts. |
| Orchestration metrics | `node scripts/analyze-pi-session.mjs [--json] SESSION.jsonl` | Offline aggregates from one local parent transcript: cache hit rate, turns, steer/wait/list usage. Prints no transcript text; transcripts and reports are not source. |

After building/checking, `npm pack` produces a tarball with the generated
private authority, source composition and runtime assets; verify its contents,
including the upstream permission-system LICENSE. A production tarball install
must use `npm install --prefix TEMP/install --omit=dev --legacy-peer-deps
--ignore-scripts PACKAGE.tgz` (with a real temporary path and built tarball).
`--legacy-peer-deps` avoids npm automatically pulling its own Pi runtime for
transitive permission/web peer dependencies; the separate host Pi remains
mandatory. A normal source `npm ci` intentionally includes SDK development pins.
Neither install mode changes public release status from PENDING.

Existing collector script names and P0/P1 identifiers are compatibility
artifacts; do not transplant private evidence outputs. Optional Jev/Luna,
SDK-history and real-model lanes are never implicitly authorized by
`npm run check`. Controlled host fixture passes cannot certify human
interaction or live provider behavior. Do not
claim a command passed if it was not run, was interrupted, or matched zero tests.

## Maintainer rules

- Assert required host Pi capabilities and exercise host integration; never
  treat a private SDK field or local patch as a supported upstream contract.
- Preserve profile/config IDs, `harness:*` records, permission events and
  cross-extension symbols. Changes to child communication must keep code,
  policy and definitions matched, without retired aliases or historical-state
  hydration.
- Keep provider IO synthetic and reports outside the checkout. Never include
  credentials, approval packets or private session content in public evidence.
- Do not infer OS isolation, forced cancellation, cost completeness, real-model
  quality or durable recovery from a controlled green run. See
  [limitations](limitations.md) and [validation scope](validation-evidence.md).
