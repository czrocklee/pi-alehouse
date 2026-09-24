# Architecture

Pi Alehouse's harness is a thin explicit Pi extension around an Owner-local core.  It is
not an independent agent runtime, service, extension-discovery mechanism, or
second Pi installation.  The host supplies the parent `ExtensionContext`,
installed SDK/runtime, worker definitions, permission service, and policy
extensions.  The harness does not copy credentials, create a second auth/model
runtime, pin a host runtime at launch, or bundle it for production.

## Source boundary

`src/extension.ts` remains composition and `src/routing.ts` remains the trusted
routing module.  The layout below separates responsibilities without changing
the public contract.

| Area | Files | Responsibility |
| --- | --- | --- |
| Composition | `src/extension.ts`, `src/routing.ts` | explicit host registration; trusted preset catalogue and resolution |
| Core | `core/{owner-controller,contracts,ports,usage-ledger,result-text}` | SDK-free Owner state, FIFO, identity/idempotence, limits, result paging, port contracts, conservative ledgers |
| Runtime | `runtime/{agent-session,child-session,child-factory,owner-lifecycle,owner-lease,activity-observer,execution-policy,context-snapshot,tool-usage}` | host SDK adapter, child assembly/disposal, lease/lifecycle, observable activity, native compaction/retry policy, text snapshots |
| Tools | `tools/{parent-tools,child-tools,tool-names,replies}` | fixed parent/child schemas and bounded model-facing projections |
| Permissions | `permissions/{readiness,approval-provenance}` | readiness and Run-bound approval witness only |
| History | `history/{run-journal,history-reader,usage-audit,history-command}` | SDK metadata links/boundaries, bounded cold reads, unmerged-usage audit |
| UI | `ui/{agent-widget,agent-detail,transcript,preset-picker,panel-coordinator,permission-dialog-yield,overlay-request,popover,format}` | projections, panels, transcript, and UI coordination |

`OwnerController` is the core coordinator.  `AgentSessionPort` is the core
execution port; `PiAgentSessionAdapter` adapts the actual child SDK session.
`FileOwnerLease` owns the process-held local lock.  `AdmittedAgentConfig` is the
immutable accepted configuration and `RunTelemetry` is a non-authoritative
runtime snapshot.  UI reads controller views; **UI never owns SDK sessions** or
becomes another source of lifecycle truth.

Shared pure presentation/accounting helpers live at the sibling
repository-root `lib/` boundary:
`token-format.mjs`, `popover-frame.mjs`, `overlay-protocol.mjs`, and
`usage-attribution.mjs`, with declaration files.  They have no harness runtime
dependency so the independently bundled footer continues to work without the
harness.

## Ownership and lifecycle

The extension creates one Owner only during the parent session start.  Every
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
keeps the explicit `/harness-close` gate and never auto-closes. One Owner has one
FIFO admission queue, four execution slots, eight resident reservations, and
memory-only request idempotence.

Admission reserves a configured worst-case output budget for each unsettled Run.
A same tool-call ID with identical task fields returns its accepted Run; a
conflicting digest fails.  A new tool-call ID is not semantic deduplication.
Queued admission rechecks ownership/context after asynchronous child creation
before SDK queue mutation.  A child can be quarantined and retired, but the
host's post-guard input boundary is not atomic; see
[limitations](limitations.md).

A Run goes through initialization, prompt/input dispatch, adapter drain,
history finalization, and child cleanup.  Its execution deadline starts only
when an execution slot is assigned and initialization begins.  `stop`,
cancellation, or deadline only requests the existing stop path.  On actual
execution exit, the Controller frees that **execution slot** and can schedule a
queued peer before history finalization completes.  The Run's **Agent
reservation** and the Owner lease remain held through finalization and required
cleanup; uncertain cleanup is never released or reused.  The explicit
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
absolute util-linux `flock`, with inode/ownership checks.  It prevents
simultaneous local Owners for a parent session; it is not proof that detached
processes exited, a distributed lock, or recovery from abrupt process loss.
Lock files/directories persist to preserve inode identity and have no automatic
pruning.  Do not remove them while a Pi process could hold a lease.

## State, retention, and history

Live Agent/Run state, requests, results, and notifications are in memory.  No
TTL/LRU, result truncation eviction, restart hydration, background delivery, or
second durable result database exists.  By default an Owner admits at most 512
cumulative Runs and 64 Mi UTF-16 code units of retained **and reserved** result
text.  Prompts, context/settings snapshots, other metadata, and resident SDK
memory are outside that result budget; it is not a total process-memory limit.
`history_output_chars` must be at least `output_chars`.  Exceeding an admission
bound produces `OWNER_HISTORY_LIMIT`; existing IDs remain inspectable and
controllable until work finishes.

SDK journals are the sole history authority.  The harness appends only bounded
links/boundaries and uses trusted SDK-derived paths for cold reads.  Current
durable custom record names are compatibility surface:

- `harness:preset-selection:v1` in the parent branch;
- `harness:run-link:v1`, `harness:run-start:v1`, and `harness:run-end:v1`;
- `harness:unreported-usage:v1` audit checkpoints.

Record names and versions remain unchanged. New `harness:run-start:v1` entries
carry the Agent's difficulty alongside the existing internally resolved route
(slot, model, and thinking). Older entries without difficulty remain readable;
the reader leaves that value unknown rather than inferring or fabricating a
score. None of this routing detail reaches model-facing parent-tool replies.

`/harness-history` reads links from the current parent and an optional Run in
pages no larger than 16384 UTF-16 output units.  Default per-file cap is 8 MiB;
`--max-mib` explicitly selects 1--64 MiB and pagination preserves it.  It cannot
resume execution, repair logs, choose arbitrary paths, or grant permission.
Whole-file buffering/parsing and SDK reconstruction can use more memory than
the file-size cap, and compaction does not reduce raw JSONL.  Missing, changed,
incomplete, invalid, or over-cap boundaries are reported rather than repaired.
An SDK append ID is not a fsync/durability receipt.

## Accounting

`UsageLedger` is a monotonic observed floor, not a billing guarantee.  Its
`total` is always **derived from `byModel`**, never accumulated as an independent
second total.  The adapter observes ordinary assistant responses once per
response and attributes them to the answering `provider/model` where the SDK
supplies it.  Successful native compaction summaries are counted once under
`compaction/<provider>/<requested-model>`: the SDK does not expose their actual
routed response model.  It retains a union of incomplete components (`input`,
`output`, `cache_read`, `cache_write`, `cost`).  A missing value is unknown,
never silently assigned to another model or treated as zero.  A free reported
row and an unknown-cost row both remain representable.  Failed, cancelled, or
internally retried summaries can have hidden billing and therefore mark the
ledger partial. Failed/aborted assistant responses also mark observation incomplete:
the SDK may retain initialized zeros when a stream ends without a usage frame.
Reported figures remain counted, and a successful retry cannot erase that gap.
The independent footer also counts native SDK usage entries (including parent
cache warming), once and by their reported provider/model.

Runtime callbacks publish cumulative Run activity, independent context
occupancy, and optional usage.  Core validates/clones these snapshots and merges
live observations with final facts as a per-model/per-component non-regressing
floor envelope; final telemetry cannot erase earlier observed spend.  Context
occupancy is not inferred from cumulative billed tokens.  At Run settlement that
final envelope merges exactly once into parent handoff residue.  The next parent
tool result of any kind carries drainable totals in Pi's normal `usage` plus
`harnessModels` attribution; Pi itself files the flat total under
tools/summaries while the footer can display model rows.  `harnessPartial` and
per-row partial flags survive handoffs without changing totals.  The split must
be treated as a claim only when it is a genuine division of the accompanying
flat usage.  This live/final observation envelope is distinct from
`unreported_usage`, which is only parent-handoff residue.

The extension API cannot append usage directly to the parent `SessionManager`.
Thus a settlement after the last parent tool result remains `unreported_usage`.
`/harness-status` exposes the residue; orderly close and session shutdown attempt
a non-additive audit snapshot. Repeated reporting suppresses unchanged successful
snapshots, but an abrupt loss can still prevent them.  This accounting residue is distinct from a
partial ledger and is never fabricated as a tool/assistant usage message.

## Host and policy seams

The host runtime bridge currently uses `ModelRegistry.runtime`, validates the
methods it needs, and is exercised by host smoke coverage because the SDK has no
public canonical runtime getter.  Child sessions use native SDK auto-compaction
and bounded local retry policy (one agent-level retry, 1 s base / 5 s accepted
delay, provider-internal retries disabled, ten-minute provider request timeout).
They retain inherited reserve/keep settings.  The child cache-warming guard is
final and returns `stop`, preventing child idle warming outside Runs; parent
warming policy is unchanged.  Parent compaction never injects a roster, task
labels, or delegation reminders into model context; live harness state remains
available on demand through `list_agents`.

The patched permission authority, generated worker policy, static guard, search
policy, and optional Jev review policy are outside the internal harness, but
inside the Pi Alehouse source/build. Harness readiness and provenance bind a
Run to that authority; they do not create a new permission grant system.

The private permission-system patch adds `managed-resource-protection.ts` to
its generated vendor tree and clamps `PermissionManager.buildCheckResult`
**after** project/profile/session/yolo composition. The immutable process-local
snapshot, established before Jev scrubs its key-file path, write-protects
package/runtime/dependency/host code roots and the selected agent directory;
exact auth/web-config/Jev-key paths are read- and write-protected under lexical
and canonical aliases. Ancestor directory writes deny conservatively. Children
require the same snapshot; a mismatched later generation requires a new Pi
process. This guards detectable path effects in writable installs, not inode or
hardlink aliases, opaque-program effects, OS isolation, arbitrary trusted
in-process extensions or atomic stop. See [security](security.md#immutable-resource-floor-in-writable-installations).
