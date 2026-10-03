# Current limitations and release scope

This document defines Pi Alehouse's public support boundary.
[release-policy.json](../release-policy.json) remains **PENDING**: the historical
root gate (847/847 package tests), controlled full/readonly,
Jev and SDK-history lanes, and installed-tarball RPC smoke passed in their
declared scopes, but public release review is not complete. No private operator's
local-use decision, inherited test pass, or historical observation grants
public acceptance. Test reports must declare their own scope.

## Release position

- **Cooperative-local-v1 is a documented operating contract, not a public GO.**
  Cancellation is cooperative/best-effort; no atomic admission, zero post-cancel
  provider activity, forced execution exit, rollback, or safe live-Owner reload
  is promised. The patched permission authority does not close these SDK gaps.
- **Required precautions:** use a matched generated runtime and fresh
  `pi-alehouse` process. Session replacement requires confirmed Owner closure:
  an unused Owner may auto-close; a used Owner requires UI confirmation or
  explicit `/harness-close`. Before exit use `/harness-close` and wait for
  confirmed closure. `/tree` always needs explicit close. Wait for each
  replacement to finish; guard closure is not atomic with downstream hooks or
  target loading. Never `/reload` with an open Owner. Unconfirmed drain is not
  safe-exit evidence, and releasing all Agents is not Owner closure.
- **Not implied:** npm publication, default `pi` delegation, a background
  service, Luna authorization, remote model quality, real-provider trials,
  human UI acceptance, or deployment. Ordinary `pi` remains unchanged; the
  explicit launcher is not a hot-swappable backend for a running session.

See [validation scope](validation-evidence.md) for portable tests and gaps.

## Lifecycle and cancellation

Esc interrupts the parent's wait, not child work.  Cancellation, deadline
expiry, and explicit close use best-effort stop paths and quarantine uncertain sessions;
they do not roll back filesystem/provider effects, prove zero further provider
activity, prove child exit, or restore an old input safely.  An execution slot
is freed only after actual execution exit; it can then run a queued peer before
history finalization completes.  The Agent reservation and Owner lease remain
until finalization and cleanup confirm release.  A deadline is not a hard
monetary or provider-output cap.  Observed cost is telemetry, not a budget.

A session that never confirms idle can keep its Run/slot and prevent Owner
closure indefinitely. The widget, detail pane and `/harness-status` show the
drain wait and its elapsed time; other healthy slots need not stop. There is no
new drain timeout, forced release or automatic retry. Pending tracked aborts
alone are not diagnosed as SDK idle failure. The stop path itself is bounded:
an SDK `abort()` that has not returned within 30 s (configurable by the host)
is reported as a stop failure, so the Run is quarantined as stop-uncertain
rather than awaiting the drain indefinitely.

The settle path is observable the same way but deliberately not bounded:
`stats()` reports `finalizing_waits` — which of its awaits (inputs, release,
history) a finalizing Run is parked on and for how long — and `stopping` for
stop requests that execution exit has not yet confirmed, including deadline
overruns. These are diagnostics only; a wedged finalization keeps its
reservation, its Agent and the Owner lease exactly as before, because
converting a local wait into a timeout would either assume completion or
latch the whole Owner over one Agent's fault.

Pi 0.87.1 retains the post-input-hook enqueue race and can continue original prompting
after pre-prompt compaction abort.  The harness final gate re-aborts and
quarantines crossings, but cannot make provider admission atomic.  Controlled
probes observed SDK user-message/queue acceptance after gate closure in selected
schedules; absence of a provider call in those tests is not a universal proof.
Natural-finish steering has SDK-version-specific scheduling behavior and a
quarantined new-prompt fallback. These are known limitations under the documented cooperative contract, not
newly fixed SDK behavior or public acceptance.

`/reload` with an open Owner is unsupported.  Pi offers no pre-teardown reload
veto; an extension `session_shutdown` cancel/throw cannot provide one.
Switch/fork guards pass only after the Owner is confirmed closed. A never-used
Owner starts shutdown synchronously before the first guard await and may proceed
automatically; after any accepted Run, the host must have UI and its confirmation
must return literal `true` before shutdown starts. False, undefined, thrown, or
headless confirmation cancels without stopping work. The confirmation warns about
all Owner work, including work accepted while the dialog was open, and permanent
closure if a later veto/error prevents replacement. Confirmed closure also emits
a warning: workers are permanently closed in the current session even if replacement
is cancelled or fails. Successfully opening another session or restarting Pi creates
a fresh Owner; changing the preset cannot reopen the closed one. This applies to
automatic closure of an unused Owner too. One pending guard owns one
target only while confirmation/drain is pending; concurrent attempts then cancel
rather than sharing its decision. After that guard returns, Pi does not serialize
downstream teardown, other hooks, target loading, or replacement construction.
There is no atomic close-and-replace transaction, so wait for each replacement
operation to finish before another. `/tree` changes the current session in place
and never auto-closes: use explicit `/harness-close`. Releasing every Agent is not Owner closure. `/harness-close` is
a user command, not a model tool; it remains available and permanently disables
new admission through that Owner. An unconfirmed/throwing shutdown cancels and
retains reservations and lease semantics. The guard is opt-in and not a reload
guard. Do not promise atomic cancellation, reload safety, or input admission
safety.

Live IDs, resident reservations, idempotence memory, and pending alerts do
not survive a Pi restart.  There is no force release, force unlock, cleanup retry
endpoint, restart hydration, automatic expiry, or reliable notification delivery
service.  A Linux local `flock` lease is not distributed coordination or proof
that detached children have stopped.

Request idempotence keys on the tool-call ID, which Pi passes through from the
provider (both the OpenAI-compatible and Anthropic adapters adopt the provider's
ID verbatim) without validating uniqueness. A provider that reuses an ID across
assistant messages is trusted: identical arguments replay the earlier accepted
command fact — a repeated `agent_run` observes the old task instead of starting
a new one — while differing arguments fail `REQUEST_CONFLICT`. Observations are
not cached: a retry cannot restore alerts already consumed by successful local
publication. The
harness does not currently scope the key more tightly. The tool context can read
the session branch, so keying on the assistant entry that carries the call may
be possible, but that depends on Pi persisting the assistant message before
tool execution, including parallel calls, which has not been verified.

## Host SDK and runtime scope

Development API checks target Pi/AI/TUI 1.0.0 and TypeBox 1.3.27.  The launcher
uses the installed host SDK, not a bundled second SDK or a runtime version lock.
There is no version allowlist, compatibility fallback, or historical support
matrix.  Required APIs fail closed when absent/changed.  In particular, the
current host bridge must use `ModelRegistry.runtime` because the SDK exposes no
public canonical model-runtime getter; it validates required methods and relies
on actual-host smoke coverage. This is an observed bridge, not a stable upstream
promise. An installed-host Pi 0.87.1 RPC smoke created/statused/closed an Owner
without a model request. Pinned parent-only web access can warn that dynamic
tool activation is unavailable when upstream host-version detection cannot
resolve the aliased SDK; its eagerly available tools remain under normal parent
permissions. This warning does not authorize child web, a permission bypass,
or a second Pi runtime. Researcher children register no activation loader and
suppress their repeat of that warning.

Mistral-hosted GLM constrains all tool arguments to declared property order
(and whole-string patterns) whenever a request carries a strict tool, which
Pi's built-in tools are; arguments written out of order are dropped silently.
For `mistral-conversations` requests the parent and every child therefore send
non-strict tool schemas open (`additionalProperties: true`) and without
`pattern`. This shim keys on `ctx.model.api`; a virtual parent selection that
routes to Mistral does not expose that physical API at this boundary, so the
virtual-to-Mistral workaround remains unvalidated. Worker virtual slots are
rejected rather than relying on per-request dispatch. Only the wire copy changes: Pi validates arguments against the
registered schemas, and strict tools are sent unchanged.

Native compaction/retry remains SDK behavior inside a Run.  The SDK does not
expose all failed/cancelled/retried summary attempts or the actual routed model
for successful summaries; successful summary usage is instead keyed as
`compaction/<provider>/<requested-model>`.  The ledger retains observed floors
and partial flags; it cannot prove complete provider billing.  Child
cache-warming is stopped, but parent warming behavior is unchanged.

The delegation guideline on `agent_spawn` (see
[tool contract](tool-contract.md)) renders in the default system prompt's
Guidelines section. The delegation mode is guidance only: Manual does not block
delegation, and how strongly a model follows a mode or eagerness has not been
measured. A custom `SYSTEM.md` or `--system-prompt` replaces that
prompt, and with it the guideline; the tools themselves are unaffected.

## Retention, history, and accounting

Owner-memory results are bounded by cumulative Run/result limits but not by
heap/RSS. Prompts, settings/context snapshots, metadata, and resident SDK
memory are outside result accounting. There is no automatic eviction; hitting
the limit requires closing the Owner for new admissions.

The [tool contract](tool-contract.md) defines communication and retention.
One FIFO bounds accepted pending alerts at 64 per Owner / 16 per source Agent
across Runs; no per-Run queue, coalescing, eviction or rejected-call drop counter.
Old/killed sources still occupy quota. Multiple Agents/history can fill the
Owner; the per-Agent cap does not promise every Agent reserved space. Full queues
reject new alerts and advise retaining information in the final result rather
than loop-retrying. Repeat valid calls may create distinct events; no alert
call-ID deduplication or durable outbox/ACK protocol is provided.

Wait/read/inline observation scopes differ, and only fully displayed FIFO-prefix
alerts are consumed. Bound tasks never drift. No bound tasks/scoped alerts
returns nothing_pending without a timer. On default questions remain
level-triggered, independent of their finished bit; Off excludes already-terminal
questions only at first default binding, while explicit observation can still
show question identity with workers_disabled. Unanswered questions return again;
to defer one, explicitly name other Agents in `agents`, which also limits alerts
to those Agents. Preset changes do not rebind a wait. Alert wakes matching
observers, not the parent model, parent Bash or a new
turn; ask asks the child to end rather than forcing suspension. Only a true
healthy pending needs-input settlement can be explicitly answered. Historical
questions are not permission or an actionable continuation.

Question/result/alert text shares 16384 UTF-16 units and the double-JSON content
envelope is capped at 65536 UTF-8 bytes. Labels/tokens/diagnostics count against
the byte limit, even when outside the text budget. A complete first alert is
reserved for reason=alert; full worst-case question and alert cannot always fit
together. Read prioritizes the complete recorded question; unshown alerts stay
pending. Mandatory control rows, pending names and truncation flags stay intact;
the model tool adapter requires resident ≤16 (production eight), while core can
support more. Model tool assembly also explicitly binds lifetime-valid unique
model names, rejecting incompatible existing generic history before exposing
tools; final admission prevents later incompatible work. Generic core names
remain optional/repeatable display text. Low-level `observe` requires
model-representable snapshots; it is not generic identity conversion. A refused
binding preserves pending alerts but does not make their bodies model-readable;
`getResult` reads retained result text, not the alert FIFO. No accepted facts are
silently filtered or renamed. Increasing adapter bounds needs a new packing
proof, not silent truncation. Fixed-width recovery cursors are reserved for bound terminal
windows with remaining text, including wholly omitted pages after Agent reuse;
the conservative reservation bound is 65045 bytes. Keep returned cursors: task
ordinals are not historical-read parameters, and a convenience-only finished row
or wholly shown/empty result does not newly acquire an all-history selector.
Cursors are stateless 128-bit Owner/generation/Run/version locators with accepted
negligible collision risk, not permission grants. Timeout/abort do not drain
alerts or finished reminders.

Publication consumes only after constructing final local content and validating
all references, not after proof of SDK persistence, later tool_result hook fidelity,
model receipt, human ACK or crash durability. SDK loss after commit does not
requeue an alert. Reentrancy guards reject effects via supported synchronous
entrypoints before mutation/enqueue; observer failure is isolated. They do not
stop arbitrary trusted code directly mutating SDK internals or never returning.
Timer expiry is latched once and readiness wins over timeout; Node timer
resolution is not an exact absolute-time guarantee. Lifecycle waits share the
drain but never model publication; empty observations are not child-exit or
Owner-closure proof. Cooperative execution/lease limits above are unchanged.

Finished reminders use each original Run's fixed finished_presented bit and
settled_seq, not a second log or cursor. Showing that original task's terminal
row commits its bit; a running row with the same Agent name, alert/list/UI/count
never does. Result/history remain rereadable and pending questions can reopen
without resetting the bit. Joined `agent_send` messages and `agent_list`
history (earlier task labels, last context, touched paths) likewise are bounded
Owner-memory state, lost with the Owner and never replayed from journals. Old
notify/progress/send-answered logs stay readable literally, never rewritten or
hydrated as new pending work. `touched` lists only paths passed to successful `edit`/`write` calls,
not files a shell command changed. Handed-off text is another child's retained
final output, bounded and framed as reference; it is not verified.

SDK journals are the only historical transcript source, but are not immediate
durability or power-loss proof.  Raw JSONL can be large after compaction; cold
reads have a file cap rather than an RAM cap and can fail on malformed, changed,
or incomplete boundaries.  History cannot resume work, repair records, browse
arbitrary paths, or bypass permissions.

Pi's public extension context lacks a parent usage writer.  `UsageLedger.total`
is derived from its `byModel` shares; live runtime observations and final facts
merge as a non-regressing observed-floor envelope.  That observation state is
distinct from parent handoff: child spend can be merged only into a later parent
tool result. This usage hook may append accounting without modifying the
already-published communication body; it is not a message ACK. Spend settling
after the last such result remains
`unreported_usage` and gets a non-billable audit snapshot when possible; abrupt
process loss may prevent even that.  Partial usage means incomplete observation,
not zero price; unreported residue is a separate gap.  Neither is repaired by a
footer or audit entry.

## Permission and isolation scope

The harness depends on, but does not own, generated worker policy, permission
authority, static guards, search policy, and Jev review policy.  Profiles are
not an OS sandbox; `reader` has no direct edit tools and denies detectable
path writes, but an opaque program remains an inspected shell ask, while OS permissions and global policy still
matter.  Nested delegation is excluded for every child.  Child web is limited
to `researcher`, which has no Bash; `reader`/`editor` web stays excluded by the
harness allowlist even though their declared definitions include it.  Researcher
file reads and web calls together can move project content to the network; its
prompt forbids that but cannot enforce it (see
[researcher web access](security.md#researcher-web-access)).  Tool availability
is not authorization.

[Managed Git read proof](git-read-proof.md) covers a restricted literal language,
not arbitrary Git syntax or unsafe configuration equivalence. Content proof
declines bare/separate-git-dir layouts, subdirectory execution and partial/promisor
configuration; configured index helpers can also withhold proof. Historical-file
show retains the exact `env git` lane, disables replacements and pins its tree at
hardening time. Bare log pathspecs after `--` are supported only when every word
passes the restricted literal grammar and normal path/external rules. Default
history formatting is explicitly medium. All proved diff execution and its
probes disable replacements, including summary-only diff; replacement-dependent
output equivalence is not promised. Status/diff with checked-out indexed
submodules receive no proof without explicit exact `--ignore-submodules=all`;
short submodule output is not protection from nested helpers. Probes do not run
from an effective cwd outside the session working-directory boundary, except
linked-worktree `mainRoot` layout verification. That exception grants no path
permission or other external probes. Each synchronous Git probe blocks the Node
event loop and can delay cancellation/timers; its five-second timeout and 4 MiB
output cap do not bound the whole multi-probe call. Probe failure returns to normal gates,
which may deny instead of asking. Unsupported env-wrapped configuration spellings
gain no managed proof, but the existing static deny-parity gap is not fixed by
this scope. No OS isolation or general inherited-environment guarantee follows.

Automated review requires its external policy, key, complete current provenance,
and supported context.  It can defer and leave a human ask; it is not calibrated
model-quality evidence or a new grant authority.  Luna is not loaded by the
normal launcher.  Context snapshots are bounded text, not history forks, and
history/diagnostics may contain sensitive model content.  The harness does not
copy credentials, although authorized real SDK use can refresh an auth file.

## UI scope

Fullscreen alternate-screen rendering is required for floating worker panels and
click input.  Regular mode deliberately docks the detail/picker to avoid
scrollback contamination; its footer retains totals but does not open the usage
popover.  Multiplexers can further limit mouse motion.  Pi's unexported native
tool renderers mean child transcripts fall back to plain tool argument/output
blocks for built-in tools.  PTY/UI fixtures and scripted permission RPC are not
human-TUI acceptance.

Interactive preset editing reuses the host's native `/model` selector with a
physical-model-only view; RPC uses a standard list instead. The native selector
may refresh provider catalogues and update host credential/cache state, just as
`/model` does. Selection itself does not switch the main model or save Pi's model
defaults. Fullscreen model selection is a near-click/centered popover that
yields to known permission prompts; regular TUI stays docked. Mouse item matching
uses the native public component tree and rendered labels, not private list
state; unknown layouts or ambiguous items stay keyboard-only. Very small
viewports refuse unseen selections. Controlled selector tests use synthetic
runtimes, not live providers.

The prompt queue yield protects permission dialogs only within the known process
queue protocol.  It is not an atomic global UI transaction and `/reload` does
not replace its existing wrapper.

## Matched migration scope

New package, generated agents/policy/seeds/integrity manifest and managed user
definitions/permissions must match in a fresh Pi process; no open-Owner reload or
runtime swap. The launcher verifies managed definition digests, including worker
body changes. Absent-only init never repairs existing mismatches automatically;
reconcile deliberately without replacing user symlinks or weakening permission
floors. Rollback must coordinate the same resources; see
[matched resource migration](development.md#matched-resource-migration).
Nix validation/activation, host collectors, live model/network trials, human
approval and publication require separate authorization and scoped evidence.

## Routing and configuration scope

Presets validate local routing configuration and current SDK metadata, not
provider credentials or remote availability. The required
`harness-presets.json` base catalogue remains separate and is never overwritten
by the UI. Optional version-1 scoped preferences live in
`<agentDir>/extensions/pi-alehouse/config.json` and, only for a trusted project,
`<current-cwd>/.pi/extensions/pi-alehouse/config.json`; workspace lookup does
not search for a Git root. Fresh sessions use preferences before catalogue
defaults, while valid existing branch records keep precedence. Saved names
resolve against the current base catalogue directory, except for custom model
definitions explicitly stored in preferences/session records. Existing branch
records are evidence, not immutable catalogue pins.

Startup/restoration never writes preferences and abandoned UI drafts are not
saved. Explicit persistent-scope user actions queue leaf patches; ordinary
`session_shutdown` flushes them, or **Save pending now** can do so sooner. A
settings conflict rejects all patches in that scope, while another scope may
flush independently. The writer uses a cooperative exclusive lock, refuses
symlink/read-only replacement, and publishes by atomic rename after identity
checks. Valid read-only settings can load; invalid settings fail visibly and
are not overwritten. Filesystem calls have no hard timeout, and atomic rename
is not a crash-durability guarantee. A failed write is reported; it is not
silently treated as saved. This preference writer is distinct from preset
selection's parent-session audit: that audit's synchronous in-memory ordering
is not fsync, filesystem persistence, or rollback. An ambiguous parent audit
failure deliberately latches the Owner unavailable rather than guessing what
was persisted.

A persistent approval preference is a request only. A same-session approval
record wins; judge restoration cannot exceed its launch cap, a wider saved
judge preference needs UI confirmation, and yolo always needs explicit
confirmation. These records and preferences do not bypass the permission
authority. Saving scoped settings does not make live-Owner `/reload`
supported; normal `session_shutdown` flushing is not a reload-safety guarantee.

These constraints define support.  If an operation needs a guarantee not listed
here—especially default-entrypoint replacement, atomic stop/reload, durable recovery,
complete cost accounting, automated approval, or human TUI acceptance—it is out
of scope until explicitly reviewed and accepted.
