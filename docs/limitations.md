# Current limitations and release scope

This is the operating boundary for the explicit `pi-alehouse` launcher. See
[orchestration](orchestration.md) for Owner, Agent and Run behavior, and
[security](security.md) for tool policy, credentials and network boundaries.

## Release position

[Public release acceptance](../release-policy.json) is **PENDING**. The
`cooperative-local-v1` contract describes how to operate the launcher, not a
public release decision. Portable checks, controlled host tests and installed
package smokes establish only their stated [validation scope](validation-evidence.md).
None implies npm publication, deployment, live provider acceptance, human UI
acceptance, a hosted service or changes to ordinary `pi`.

Use a matched generated runtime with a fresh Pi process. For production,
[install a verified built tarball](getting-started.md#2-install-the-launcher)
with `--omit=dev --legacy-peer-deps --ignore-scripts`; host Pi is separate.

## Lifecycle and cancellation

| If you need to…                    | Do this                                                                                                          | Do not infer                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Stop waiting for a Run             | Press Esc or let the observation timeout expire.                                                                 | The Run was cancelled or an alert was acknowledged.                  |
| Stop child work                    | Request interruption or use the confirmed Stop action. Check `/alehouse-status` for execution and cleanup state. | Immediate exit, rollback or zero later filesystem/provider activity. |
| Free an Agent slot                 | Release the Agent and wait for confirmed cleanup.                                                                | Finishing a task or requesting a kill frees its Agent reservation.   |
| Leave, change, or reload a session | Use `/alehouse-close` and wait for confirmed closure before exit or reload; see replacement below.               | Idle, Off, or releasing every Agent closes the Owner.                |

**Cancellation is cooperative.** The Run gate seals new work and requests SDK
stop. The SDK can still accept queued input after its input hook or continue
prompting after a compaction abort. Alehouse re-aborts and quarantines known
crossings; it cannot make SDK or provider admission atomic. Steering can also
race natural completion. Do not assume the exact input was delivered or can
safely be replayed.

- There is no wall-clock execution deadline. A soft turn budget cannot stop a
  single long-running tool or enforce a cost ceiling. Tool/request timeouts,
  observation waits and stop/cleanup bounds are separate. An SDK `abort()`
  exceeding its stop budget (30 seconds by default) leaves stop uncertainty,
  not proof of exit.
- The four default execution slots are **per provider, per Owner**. Models on
  the same provider share that cap; providers sharing an account do not. An
  execution slot is freed after actual execution exit, before history and
  cleanup need necessarily finish. The twelve resident Agent reservations
  include queued Agents and uncertain cleanup. Neither limit is a provider
  account rate limiter.
- Execution drain and finalization can wait indefinitely. Inspect
  `/alehouse-status` and the [health view](interface.md#health-and-stats) for
  stopping work, idle waits and finalization (inputs, release, history).
  These are diagnostics, not timeouts. Uncertain cleanup keeps reservations
  and can prevent closure. There is no forced release or cleanup retry tool.

**Session replacement:** A switch or fork proceeds only after confirmed Owner
closure. A never-used Owner can close automatically; a used Owner requires
explicit UI confirmation or a prior `/alehouse-close`. Without confirmation
UI, close explicitly first. Confirmation covers all work, including work
accepted while the dialog was open. Closure is permanent in that Owner even
if a later hook vetoes the switch or the target fails to open. Wait for each
switch/fork to finish; the guard does not serialize later hooks or target
loading. `/tree` changes the session in place and always needs explicit close.
A new session or process can create a fresh Owner; a preset change cannot.

**Do not `/reload` with an open Owner.** Pi has no pre-teardown reload veto for
this purpose; an idle parent can still have live children. Local `flock`
coordination is neither distributed locking nor proof that detached processes
have stopped. Do not remove a lock file because of age, a PID check or an
unconfirmed drain. If closure cannot be confirmed, keep the diagnostic and
inspect rather than treating replacement or restart as a repair.

## Host SDK and runtime scope

The development SDK baseline is Pi/AI/TUI 1.6.0 and TypeBox 1.3.27. The installed
host supplies the runtime; there is no version allowlist, legacy fallback or
historical support matrix. Missing required API shapes block the affected
boundary. The model bridge uses `ModelRegistry.runtime` and checks its required
methods; that access is not an upstream stability promise. The package targets
Linux with trusted util-linux `flock`. Portable checks do not establish native
Windows/MSYS or general cross-platform support.

Pi validates tool calls through JSON Schema and may coerce values. Parent
management tools check raw arguments before coercion and recheck at execution;
child tools generally use Pi's coercion rules. TypeBox-only refinements are not
Pi schema guarantees. For `mistral-conversations`, Alehouse sends a more
permissive copy of non-strict schemas to avoid argument ordering constraints;
registered validation is unchanged. This shim and [`/fast`](routing.md#fast-requests)
see the session's selected model, not the resolved route of a virtual parent
model. A virtual parent routed to Mistral or Codex therefore does not receive
the corresponding rewrite. Child preset slots require physical models. See
[routing](routing.md) for local resolution; a locally valid selection does
not verify remote availability.

## Retention, history, and accounting

- **Live results are bounded, not durable.** Shipped Owner limits are 512
  cumulative Runs and 64 Mi UTF-16 result units, including reservations. They
  do not bound heap/RSS, prompt data or resident SDK memory. There is no
  automatic eviction; closing and using a new Owner is necessary when this
  limit prevents new work. Keep result cursors or use a named task read while
  that Owner remains; there is no all-history dump or restart hydration.
- **Acceptance is not delivery.** Alerts are bounded, not an outbox; a full
  queue rejects new alerts without evicting earlier ones. Successful local
  publication consumes the displayed alerts/finished reminders, not after SDK
  persistence, model receipt or user acknowledgement. They are not restored
  on SDK loss or restart. Unanswered questions remain visible when eligible;
  history alone cannot be answered. See the [tool contract](tool-contract.md).
- **Request replay depends on provider call IDs.** Within the relevant replay
  window, reusing an ID with identical arguments replays the earlier acceptance
  or delivery, not a new Run. Changed arguments can return `REQUEST_CONFLICT`.
  A replay does not restore previously consumed observations.
- **SDK journals are historical evidence.** They can contain sensitive content.
  Bounded cold reads can fail on changed, malformed, oversized or incomplete
  records. Per-Run unavailability does not edit the journal. The maintainer's
  offline journal analyzer validates its whole batch rather than salvaging a
  partial report. Neither path repairs history or recovers a live Owner.
- **Usage is an observation, not a bill.** The SDK does not expose all failed,
  cancelled or retried work, or the actual routed model used for compaction.
  Child usage can be merged only into a later parent tool result; later residue
  may remain `unreported_usage` even with an audit snapshot. Partial amounts
  are observed floors, not zero or complete billing. Child cache warming is
  stopped; the parent's host settings can still cause idle provider activity.
- **Jev active-file rotation does not bound its archives.** Plan for disk use.
  [Audit recovery](jev-audit-recovery.md) is offline, with all writers stopped;
  the recovery utility is maintainer-checkout only, not in the production
  tarball. It does not unlock an Owner or recover model activity.

## Task dispatch and validation scope

Use [task dispatch](task-dispatch.md) to declare inputs, ownership, build
directory and checks. All Agents share the parent's cwd; ownership claims and
local build-directory leases coordinate declared overlaps, not hidden IO or
separate hosts, agent directories or distinct tree identities. Alehouse does
not allocate, merge or clean worktrees. A healthy pending question keeps its
claims: answer it or explicitly abandon it and verify release rather than
passively waiting for its resources.

Scout `return_to` admits a source and a worker continuation together; stopping
one is not an atomic stop of both. Stopping the worker does not stop the scout.
A scout that was not fully delivered or could not be auto-released may still
need explicit release. The continuation cannot fetch omitted handoff text;
use the [documented result-read path](tool-contract.md#scout-return_to) to
recover retained text when available. Nothing here survives Owner restart as
a live continuation.

`checks` declarations are not execution proof. Execution-start `source_state`
is optional superproject metadata for supported local repository layouts, not
content identity or a whole-tree snapshot. Missing trusted Git or unsafe
configuration leaves it unknown, without blocking routine work. A receipt
needs a valid history boundary and a successful end append; the returned append
ID is not an fsync guarantee. Optional receipt failure can leave valid core
history without a receipt. Run notes can be omitted from model replies and
are not persisted. Have one explicitly delegated validation owner run the full
gate after shared inputs are stable; report what actually ran, not what was
declared or inferred.

## UI scope

Use the [interface guide](interface.md) for controls and layout. Floating panels
and mouse interaction depend on fullscreen mode and host/terminal support;
regular mode docks inspection. A small or unknown viewport may withhold a
control. A display marker, clipped preview or warning tint is not lifecycle,
permission, delivery or accounting proof. Transcript display is not secret
redaction, and rendered links are not trusted destinations. Scripted TUI
coverage is not human-terminal or multiplexer acceptance.

## Matched migration scope

[Reconcile the package, generated resources and managed user definitions](development.md#matched-resource-migration)
before upgrade or rollback. Absent-only init never repairs a digest mismatch,
rewrites existing files or converts older catalogue/selection records. Back up
user files and update them deliberately. A resumed branch restores its recorded
routing snapshot even if a same-name disk preset changed or was removed, but
still requires valid configuration. Older branches may lack historical routing
facts; do not guess them. If restoration is invalid, correct the configuration
or use `/new`; do not silently route to another model.

Close Owners and stop all affected Pi processes before changing generations.
[Earlier lease namespaces](development.md#one-time-naming-cutover) do not
coordinate with current leases; an empty new directory proves nothing about
old processes. Rollback also requires a fresh matched process. Do not mix
Jev writers against one sink. Nix activation, publication and provider or
human-approval trials require separate authorization and evidence.
