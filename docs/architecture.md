# Architecture

Pi Alehouse's orchestration layer is a thin explicit Pi extension around an
Owner-local core. It is
not an independent agent runtime, service, extension-discovery mechanism, or
second Pi installation. The host supplies the parent `ExtensionContext`,
installed SDK/runtime, worker definitions, permission service, and policy
extensions. The orchestration layer does not copy credentials, create a second
auth/model runtime, pin a host runtime at launch, or bundle it for production.

## Source boundary

`src/composition.ts` remains the explicit composition entry and
`src/orchestration/routing.ts` remains the trusted
routing module. The layout below separates responsibilities without changing
the public contract; orchestration modules live under `src/orchestration/`.

| Area        | Files                                                                                                                                                                                                        | Responsibility                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition | `src/composition.ts`, `src/orchestration/{extension,routing}.ts`                                                                                                                                             | explicit host registration; trusted preset catalogue and resolution                                                                                       |
| Core        | `src/orchestration/core/{owner-controller,owner-helpers,owner-projection,result-window,contracts,ports,usage-ledger,result-text}`                                                                            | SDK-free Owner state, FIFO, identity/idempotence, limits, result paging, port contracts, conservative ledgers                                             |
| Runtime     | `src/orchestration/runtime/{agent-session,child-session,child-factory,child-web,host-module-bridge,host-modules,owner-lifecycle,owner-lease,activity-observer,execution-policy,context-snapshot,tool-usage}` | host SDK adapter, child assembly/disposal, researcher web instances, lease/lifecycle, observable activity, native compaction/retry policy, text snapshots |
| Tools       | `src/orchestration/tools/{parent-tools,child-tools,tool-names,replies}`                                                                                                                                      | fixed parent/child schemas and bounded model-facing projections                                                                                           |
| Permissions | `src/orchestration/permissions/{readiness,approval-provenance}`                                                                                                                                              | readiness and Run-bound approval witness only                                                                                                             |
| History     | `src/orchestration/history/{run-journal,history-reader,usage-audit,history-command}`                                                                                                                         | SDK metadata links/boundaries, bounded cold reads, unmerged-usage audit                                                                                   |
| UI          | `src/orchestration/ui/{agent-widget,agent-detail,transcript,preset-picker,panel-coordinator,permission-dialog-yield,overlay-request,popover,format}`                                                         | projections, panels, transcript, and UI coordination                                                                                                      |

`OwnerController` is the core coordinator. `AgentSessionPort` is the core
execution port; `PiAgentSessionAdapter` adapts the actual child SDK session.
`FileOwnerLease` owns the process-held local lock. `AdmittedAgentConfig` is the
immutable accepted configuration and `RunTelemetry` is a non-authoritative
runtime snapshot. UI reads controller views; **UI never owns SDK sessions** or
becomes another source of lifecycle truth. "UI as projections" forbids commands
from rendering and a UI-owned lifecycle state machine, not explicit human input:
a confirmed, Run-bound Stop intent is routed through the host to `Owner.cancel`.
The core owns acceptance, stop provenance, approval invalidation and actual drain.
The runtime adapter separately attempts a non-triggering parent-model notice;
message or display failures cannot undo an accepted cancellation. Cached widget
projections are presentation-only; independent inspection and command validation
still read fresh Owner state.

Owner-only helpers and projections are pure leaves: the controller resolves
original Runs, health, clocks, queue occupancy and leases before projecting.
They hold no second state store and cannot admit, schedule, commit or release
work. Shared UTF-16 page slicing serves the single `r1_` result-cursor protocol
used by core `getResult` and model `agent_read` alike; it adds no second
cursor protocol.

Within the orchestration layer, `src/orchestration/presentation/` owns width-independent text sanitation and
identifying tool arguments. Runtime observations and UI share those leaves;
terminal layout stays in UI. Runtime must not load UI implementations. Widget
rendering, detail fields and transcript caches are separate from the components
that own paint-bound input, Stop confirmation and overlay single-flight locks.

Shared pure presentation/accounting helpers live in `src/shared/`:
`token-format.mjs`, `popover-frame.mjs`, `overlay-protocol.mjs`, and
`usage-attribution.mjs`, with declaration files. They have no orchestration
runtime dependency so the independently bundled footer continues to work
without the orchestration layer. The footer's quota parsing, optional billing,
journal spend, layout and pinned panels live in separate `src/extensions/lib/`
modules. Its layout returns the
painted row and hit regions together; billing opt-in and stale-generation checks
remain independent of rendering.

## Ownership and lifecycle

The extension creates one Owner only during the parent session start. Every
parent tool verifies the captured parent session manager, cwd, model registry,
Owner ID, and generation again after awaits; stale results never route into a
replacement owner. Switch/fork replacement guards pass only after irreversible
Owner closure. A never-used Owner (`hasAcceptedRuns: false`) starts core shutdown synchronously
before the guard's first await and replacement proceeds automatically only after
that shutdown confirms closed. Once any Run was accepted—even completed or
released—the guard requires `ctx.hasUI` and a literal `true` from its confirmation
before it starts the same drain; false, undefined, throw, or headless UI cancels
without starting shutdown. The confirmation warns that it stops all Owner work,
including work accepted while the dialog is open, and that closure remains
permanent if a later hook vetoes or the destination fails. While confirmation or
drain is pending, one guard owns one target and concurrent guard attempts are
cancelled rather than sharing its decision. Once that guard returns after closure,
the host SDK does not serialize downstream teardown, other hooks, target loading,
or replacement construction: this is not an atomic close-and-replace transaction.
Wait for each replacement operation to finish before starting another. `/tree`
changes the current session in place without a fresh Owner, so it always
keeps the explicit `/alehouse-close` gate and never auto-closes. One Owner has one
FIFO admission queue, per-provider execution slots, twelve resident reservations, and
memory-only request idempotence. Retained `concurrency` (default 4) is the
maximum active Runs per immutable admitted `settings.provider`: the exact
registered provider ID, shared by that provider's models, not by API, base URL
or credentials. Two provider IDs pointing to the same account/backend still
have separate slots: this is an Owner-local scheduler, not an account or
cross-process rate limiter. The
earliest dependency-ready queued Run with remaining provider capacity starts;
a saturated provider or unmet dependency does not head-of-line block another
provider. Initialization and cancellation/drain hold the slot until actual
execution exit; finalization does not. Resident 12 (including queued and
completed-unreleased) and queue 16 stay Owner-wide. `/alehouse-status`
`stats.active` is the summed total; `concurrency_scope: "provider"` and
`providers: [{provider, active, queued, limit}]` show the per-provider breakdown.
`limits.concurrency` is the per-provider cap. The extension uses core's shared
`DEFAULT_OWNER_LIMITS` rather than overriding these defaults. Every unsettled task pins its Agent's reservation, so the queue can never hold
more than the resident cap; under the default limits `QUEUE_FULL` is
unreachable and the resident cap bounds admission first — the queue limit only
bites when it is configured below the resident limit.

Admission reserves a configured worst-case output budget for each unsettled Run.
A same tool-call ID with identical task fields returns its accepted Run; a
conflicting digest fails. A new tool-call ID is not semantic deduplication.
Queued admission rechecks ownership/context after asynchronous child creation
before SDK queue mutation. A child can be quarantined and retired, but the
host's post-guard input boundary is not atomic; see
[limitations](limitations.md).

A Run goes through initialization, prompt/input dispatch, adapter drain,
history finalization, and child cleanup. Execution has a turn limit, not a
wall-clock deadline or timed wrap-up message. Cancellation and turn-limit stops
only request the existing cooperative stop path. On actual
execution exit, the Controller frees that **execution slot** and can schedule a
queued peer before history finalization completes. The Run's **Agent
reservation** and the Owner lease remain held through finalization and required
cleanup; uncertain cleanup is never released or reused. The explicit
close/shutdown path seals admission, cancels/drains children, and permanently
closes the Owner; it has no force-unlock or repair API. UI teardown errors cannot
skip that drain. Queue-clear failures likewise cannot substitute for delivery/idle
drain or suppress an SDK abort attempt. If the SDK idle wait fails without proof
of idle, the adapter retains its Run and usage subscription while passively
checking idle; it neither retries execution nor releases the slot on that error.

Subscribed SDK events invoke Owner control callbacks (`inputEntered`, `output`,
`turnStart`, `turnEnd`). A thrown control callback quarantines the session as
`run_callback_failed`, suppresses later control callbacks for that Run, attempts
synchronous approval revocation and requests a tracked abort even if revocation
fails. SDK event/usage observation continues through drain;
the failure cannot become successful or authorize reuse. Optional `runtime`
and `drain` observer failures remain nonfatal. This boundary does not isolate
arbitrary third-party SDK listeners.

`FileOwnerLease` uses a private local Linux lock directory and a configured
absolute util-linux `flock`, with inode/ownership checks. It prevents
simultaneous local Owners for a parent session; it is not proof that detached
processes exited, a distributed lock, or recovery from abrupt process loss.
Lock files/directories persist to preserve inode identity and have no automatic
pruning. Do not remove them while a Pi process could hold a lease.

## Profiles and working directory

The model API offers `worker` and `scout` only. Worker maps to the stable
internal `editor` profile ID; scout maps to the stable internal `researcher`
ID. Generated filenames and historical records keep those IDs. The public name
`researcher` is not an alias. See [security](security.md).
Worker handles local diagnosis, code review, design, implementation and
verification with local read/edit/write/Bash/Git/build tools under normal
permissions and no web tools; that absence is not network isolation. Scout has
read, grep, find, ls and the four web tools, and no model-facing Bash/edit/write.
It gathers, compares and summarizes information from local files and web
sources, including local-only tasks, and returns cited findings. Web material
is untrusted. Simple local command lookups belong to the caller. Neither profile is
an OS sandbox. Worker has no extra child-only blanket Git mutation deny and no
blanket Git allow. Ordinary repository Git queries/mutations use ordinary Bash
permission, not a second per-operation effect matrix. Only bounded literal Git version queries can
qualify for fixed-query automatic allowance. Raw configured denies/specific
asks, literal path/output/redirect facts and credential/resource/high-risk
protection remain. The [Git classifier](git-read-proof.md) does no subprocess
provenance probes or history/object walks.

Every Agent uses the parent's admitted cwd, including uncommitted files,
installed dependencies and existing outputs. The cwd remains immutable for the
Agent's lifetime. Child resource discovery and tool paths use that same cwd;
there is no separate checkout, source-policy alias registry or working-copy
lifecycle. The main agent coordinates shared edits and ordinary Git workflow.
Alehouse does not create, merge or delete worktrees. Existing user files and
historical journals are not migrated or removed.

## Task dispatch boundary

[Task dispatch](task-dispatch.md) adds optional inputs/ownership/tree/checks
without moving lifecycle authority out of core. Synchronous read-only runtime
preflight returns ordinary data for the target profile and lexical/canonical
path identities; core finally validates and atomically installs claims. Claims
span queue/execution/finalization/pending questions, transfer through answer
lineage and restore with pre-input question rollback. Fixed Run-ID predecessor
closures permit admission queuing only; pump rechecks before startup. Confirmed
final termination/necessary cleanup controls release, not optional observation
success or a requested stop.

Runtime owns checks-only execution-start superproject metadata capture at actual
child cwd through trusted Git, and tree-only local advisory leases. Capture is
not a claim that the source checkout was tested; linked worktree layouts may
remain unknown. These fixed metadata subprocesses are separate from model Git
command classification. Core owns their tracked timing,
lineage and cleanup. Source Git subprocess probes are asynchronous with
per-probe 2-second/4 MiB and aggregate 8-second/8 MiB limits, not hard-realtime
or kill guarantees; synchronous tree flock still blocks the event loop.
A failed optional observation is unknown/advisory, not an Owner fault. Turn-wrap
soft-budget input still invalidates approval; no wall-clock timer injects input
or stops a Run. Historical `deadline` outcomes remain read-only history; retired
`time_wrapped` facts are no longer interpreted by the current codec.
Actionable notes use the pre-commit projection/packer path, not reserved thin
rows or post-publication mutation. Host telemetry stays out of routine
parent-model replies.

Receipts extend the sole valid run-end append only when its history boundary
exists and append succeeds. Invalid optional receipts alone are soft-dropped
with validation_receipt_error: 'invalid_validation_receipt', a live cleanup
diagnostic and a recorded-history warning. Mandatory history/append errors
remain strict without retry. Receipts do not create sessions for unstarted tasks,
repair journals or guarantee coverage; trusted history/offline consumption does
not automatically feed a parent model. Claims/Run data remain memory-local.

## State, retention, and history

Live Agent/Run state, requests, results, and notifications are in memory. No
TTL/LRU, result truncation eviction, restart hydration, background delivery, or
second durable result database exists. By default an Owner admits at most 512
cumulative Runs and 64 Mi UTF-16 code units of retained **and reserved** result
text. Prompts, context/settings snapshots, other metadata, and resident SDK
memory are outside that result budget; it is not a total process-memory limit.
`history_output_chars` must be at least `output_chars`. Exceeding an admission
bound produces `OWNER_HISTORY_LIMIT`; existing IDs remain inspectable and
controllable until work finishes.

SDK journals are the sole history authority. The orchestration layer appends only bounded
links/boundaries and uses trusted SDK-derived paths for cold reads. Current
durable custom record names are compatibility surface:

- `alehouse:preset-selection:v1` in the parent branch;
- `alehouse:run-link:v1`, `alehouse:run-start:v1`, and `alehouse:run-end:v1`;
- `alehouse:unreported-usage:v1` audit checkpoints;
- `alehouse:human-cancellation:v1` parent custom messages for accepted human stops
  (model-visible, non-triggering; distinct from non-context custom entries).

Record names and versions remain unchanged. New `alehouse:run-start:v1` entries
carry the Agent's difficulty alongside the existing internally resolved route
(slot, model, and thinking); entries without routing (a generic begin) remain
valid. Routing records without difficulty or thinking resolution are no longer
interpreted by the current codec: they read as explicitly unavailable, never
inferred, fabricated or silently converted. None of this routing detail reaches model-facing parent-tool replies.
New run-end outcomes may carry `cancellation_source: "human"`; older records
without it remain unattributed, never inferred or rewritten.

`/alehouse-history` reads links from the current parent and an optional Run in
pages no larger than 16384 UTF-16 output units. Default per-file cap is 8 MiB;
`--max-mib` explicitly selects 1--64 MiB and pagination preserves it. It cannot
resume execution, repair logs, choose arbitrary paths, or grant permission.
Whole-file buffering/parsing and SDK reconstruction can use more memory than
the file-size cap, and compaction does not reduce raw JSONL. Missing, changed,
incomplete, invalid, or over-cap boundaries are reported rather than repaired.
An SDK append ID is not a fsync/durability receipt.

## Accounting

`UsageLedger` is a monotonic observed floor, not a billing guarantee. Its
`total` is always **derived from `byModel`**, never accumulated as an independent
second total. The adapter observes ordinary assistant responses once per
response and attributes them to the answering `provider/model` where the SDK
supplies it. Successful native compaction summaries are counted once under
`compaction/<provider>/<requested-model>`: the SDK does not expose their actual
routed response model. It retains a union of incomplete components (`input`,
`output`, `cache_read`, `cache_write`, `cost`). A missing value is unknown,
never silently assigned to another model or treated as zero. A free reported
row and an unknown-cost row both remain representable. Failed, cancelled, or
internally retried summaries can have hidden billing and therefore mark the
ledger partial. Failed/aborted assistant responses also mark observation incomplete:
the SDK may retain initialized zeros when a stream ends without a usage frame.
Reported figures remain counted, and a successful retry cannot erase that gap.
The independent footer also counts native SDK usage entries (including parent
cache warming), once and by their reported provider/model.

Runtime callbacks publish cumulative Run activity, independent context
occupancy, and optional usage. Core validates/clones these snapshots and merges
live observations with final facts as a per-model/per-component non-regressing
floor envelope; final telemetry cannot erase earlier observed spend. Context
occupancy is not inferred from cumulative billed tokens. At Run settlement that
final envelope merges exactly once into parent handoff residue. The next parent
tool result of any kind carries drainable totals in Pi's normal `usage` plus
`alehouseModels` attribution; Pi itself files the flat total under
tools/summaries while the footer can display model rows. `alehousePartial` and
per-row partial flags survive handoffs without changing totals. The split must
be treated as a claim only when it is a genuine division of the accompanying
flat usage. This live/final observation envelope is distinct from
`unreported_usage`, which is only parent-handoff residue.

The extension API cannot append usage directly to the parent `SessionManager`.
Thus a settlement after the last parent tool result remains `unreported_usage`.
`/alehouse-status` exposes the residue; orderly close and session shutdown attempt
a non-additive audit snapshot. Repeated reporting suppresses unchanged successful
snapshots, but an abrupt loss can still prevent them. This accounting residue is distinct from a
partial ledger and is never fabricated as a tool/assistant usage message.

## Host and policy seams

The host runtime bridge currently uses `ModelRegistry.runtime`, validates the
methods it needs, and is exercised by host smoke coverage because the SDK has no
public canonical runtime getter. Child sessions use native SDK auto-compaction
and bounded local retry policy (one agent-level retry, 1 s base / 5 s accepted
delay, provider-internal retries disabled, ten-minute provider request timeout).
They retain inherited reserve/keep settings. The child cache-warming guard is
final and returns `stop`, preventing child idle warming outside Runs; parent
warming policy is unchanged. Parent compaction never injects a roster, task
labels, or delegation reminders into model context; live orchestration state remains
available on demand through `agent_list`.

The patched permission authority, generated worker policy, static guard, search
policy, and optional Jev review policy are outside the internal orchestration
layer, but inside the Pi Alehouse source/build. Orchestration readiness and
provenance bind a Run to that authority; they do not create a new permission
grant system.

The private permission-system patch adds `managed-resource-protection.ts` to
its generated vendor tree and clamps `PermissionManager.buildCheckResult`
**after** project/profile/session/yolo composition. The immutable process-local
snapshot, established before Jev scrubs its key-file path, write-protects
package/generated/dependency/host code roots and the selected agent directory;
exact auth/web-config/Jev-key paths are read- and write-protected under lexical
and canonical aliases. Ancestor directory writes deny conservatively. Children
require the same snapshot; a mismatched later generation requires a new Pi
process. This guards detectable path effects in writable installs, not inode or
hardlink aliases, opaque-program effects, OS isolation, arbitrary trusted
in-process extensions or atomic stop. See [security](security.md#immutable-resource-floor-in-writable-installations).
