# Current limitations and release scope

This document defines Pi Alehouse's public support boundary.
[release-policy.json](../release-policy.json) remains **PENDING**: the latest
root gate (847/847 package tests), controlled full/readonly,
Jev and SDK-history lanes, and final installed-tarball RPC smoke passed in their
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
alone are not diagnosed as SDK idle failure.

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

Live IDs, resident reservations, idempotence memory, and queued notifications do
not survive a Pi restart.  There is no force release, force unlock, cleanup retry
endpoint, restart hydration, automatic expiry, or reliable notification delivery
service.  A Linux local `flock` lease is not distributed coordination or proof
that detached children have stopped.

## Host SDK and runtime scope

Development API checks target Pi/AI/TUI 0.87.1 and TypeBox 1.3.27.  The launcher
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
or a second Pi runtime.

Native compaction/retry remains SDK behavior inside a Run.  The SDK does not
expose all failed/cancelled/retried summary attempts or the actual routed model
for successful summaries; successful summary usage is instead keyed as
`compaction/<provider>/<requested-model>`.  The ledger retains observed floors
and partial flags; it cannot prove complete provider billing.  Child
cache-warming is stopped, but parent warming behavior is unchanged.

## Retention, history, and accounting

Owner-memory results are bounded by cumulative Run/result limits but not by
heap/RSS.  Prompts, settings/context snapshots, metadata, and resident SDK
memory are outside result accounting.  There is no automatic eviction; hitting
the limit requires closing the Owner for new admissions.  Progress is bounded,
coalesced, and at-most-once—not durable messaging or an ACK protocol.
Queued `post_update` messages, the settled-Run `changes` log, and `list_agents`
history (earlier task labels, last context, touched paths) are the same kind of
owner-memory state: bounded, lost with the Owner, and never replayed from
history. `touched` lists only paths passed to successful `edit`/`write` calls,
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
tool result.  Spend settling after the last such result remains
`unreported_usage` and gets a non-billable audit snapshot when possible; abrupt
process loss may prevent even that.  Partial usage means incomplete observation,
not zero price; unreported residue is a separate gap.  Neither is repaired by a
footer or audit entry.

## Permission and isolation scope

The harness depends on, but does not own, generated worker policy, permission
authority, static guards, search policy, and Jev review policy.  Profiles are
not an OS sandbox; `reader` has no direct edit tools and denies detectable
path writes, but an opaque program remains an inspected shell ask, while OS permissions and global policy still
matter.  Child web/nested delegation is deliberately excluded by the harness
allowlist even though declared definitions may include web capability elsewhere.
Tool availability is not authorization.

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

The prompt queue yield protects permission dialogs only within the known process
queue protocol.  It is not an atomic global UI transaction and `/reload` does
not replace its existing wrapper.

## Routing and configuration scope

Presets validate local routing configuration and current SDK metadata, not
provider credentials or remote availability.  A successful selection's audit
ordering is in-memory ordering, not fsync, atomic persistence, or rollback.  An
ambiguous parent audit failure deliberately latches the Owner unavailable rather
than guessing what persisted.  Restart resolves the saved preset name against
current disk; records are evidence, not immutable catalogue pins.

These constraints define support.  If an operation needs a guarantee not listed
here—especially default-entrypoint replacement, atomic stop/reload, durable recovery,
complete cost accounting, automated approval, or human TUI acceptance—it is out
of scope until explicitly reviewed and accepted.
