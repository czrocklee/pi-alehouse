# Current limitations and release scope

This document defines Pi Alehouse's public support boundary.
[release-policy.json](../release-policy.json) remains **PENDING**: portable,
controlled-host, Jev, SDK-history and installed-tarball lanes establish only
their declared [validation scope](validation-evidence.md), and public release
review is not complete. No private operator's
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
  explicit `/alehouse-close`. Before exit use `/alehouse-close` and wait for
  confirmed closure. `/tree` always needs explicit close. Wait for each
  replacement to finish; guard closure is not atomic with downstream hooks or
  target loading. Never `/reload` with an open Owner. Unconfirmed drain is not
  safe-exit evidence, and releasing all Agents is not Owner closure.
- **Not implied:** npm publication, default `pi` delegation, a background
  service, remote model quality, real-provider trials,
  human UI acceptance, or deployment. Ordinary `pi` remains unchanged; the
  explicit launcher is not a hot-swappable backend for a running session.

See [validation scope](validation-evidence.md) for portable tests and gaps,
and [literal Git restrictions](git-read-proof.md) for the cooperative Git
contract: seed repository queries ask, broad user allows keep their ordinary
scope, and yolo satisfies ordinary asks — including worker Git mutations —
without Jev/checkpoint review.

## Lifecycle and cancellation

Esc interrupts the parent's wait, not child work. In Agent details each press
leaves one layer: the actions menu, then an armed Stop confirmation, then a
message draft, then Info, and finally the pane. **S** / the bottom-right, rightmost **[S Stop]** arms confirmation in the
footer without replacing the title/body/transcript or changing scroll or height.
The footer shows `best-effort · Ctrl+S · Esc cancel · [Confirm stop]`, with the
warning-colored bold action rightmost (ordinary Stop is dim);
**Ctrl+S** or a separate single click then requests cooperative cancellation through
the Owner; rapid double/triple clicks do not confirm. Initial Stop requires the
full inline confirmation hint to fit the footer beside a minimal selected tab
when several Agents exist; live status stays in the bottom info row. The normal pane
height must fit a known finite viewport with the previous five-row budget floor,
not full identity/task text in a separate confirmation body. At heights below that floor the pane may still paint its minimal
title/status/footer rows, but offers no Stop or compose authority.
Long or CJK task/name text alone no longer suppresses Stop. Ordinary typing,
plain Enter and repeated S never confirm Stop; neither Stop step accepts an
unpainted control. Confirmation binds the originally painted Owner/generation/Agent/Run;
user scrolling by keys or wheel, stale geometry, selection changes, replacement
work and permission hiding retire it rather than retargeting. Confirmation expires
after ten seconds of monotonic elapsed time, checked before rendering or acting
even without repaint; background transcript growth alone preserves it. Exited
execution, including finishing work, is never stoppable. The title reserves task
text and a valid task ordinal (`#N`), or an abbreviated Run ID, before optional
nickname/profile text. Ordinary metadata is sanitized independently of styled SDK
transcripts: whitespace is normalized readably, recognized terminal protocols
stripped and remaining control/bidirectional-control characters escaped, while
ZWJ/ZWNJ/variation selectors are preserved. Human-origin
metadata and a non-triggering parent message distinguish a new human stop from
model interruption, but optional metadata may yield under packing pressure and
message queuing is not model acknowledgement. Cancellation, turn-limit stop, and
explicit close use best-effort stop paths and quarantine uncertain sessions;
they do not roll back filesystem/provider effects, prove zero further provider
activity, prove child exit, or restore an old input safely. An execution slot
is freed only after actual execution exit; it can then run a queued peer before
history finalization completes. That slot is per admitted provider
(`concurrency`, default 4; models share it), Owner-local and not a
cross-process or account rate limiter: separate provider IDs sharing an account
still receive separate slots. Resident capacity is 12 Owner-wide. The Agent reservation and Owner lease remain
until finalization and cleanup confirm release. Runs have no wall-clock
execution deadline or timed wrap-up message; `max_duration_ms` is retired.
Turn limits cannot stop a single long-running tool or prove that it is hung.
Command/request-specific timeouts, observation waits and cleanup bounds remain
separate. Observed cost is telemetry, not a hard monetary budget.

A session that never confirms idle can keep its Run/slot and prevent Owner
closure indefinitely. The widget, detail pane and `/alehouse-status` show the
drain wait and its elapsed time; other healthy slots need not stop. There is no
new drain timeout, forced release or automatic retry. Pending tracked aborts
alone are not diagnosed as SDK idle failure. The stop path itself is bounded:
an SDK `abort()` that has not returned within 30 s (configurable by the host)
is reported as a stop failure, so the Run is quarantined as stop-uncertain
rather than awaiting the drain indefinitely.

The settle path is observable the same way but deliberately not bounded:
`stats()` reports `finalizing_waits` — which of its awaits (inputs, release,
history) a finalizing Run is parked on and for how long — and `stopping` for
stop requests that execution exit has not yet confirmed. These are diagnostics only; a wedged finalization keeps its
reservation, its Agent and the Owner lease exactly as before, because
converting a local wait into a timeout would either assume completion or
latch the whole Owner over one Agent's fault.

The host SDK retains the post-input-hook enqueue race and can continue original prompting
after pre-prompt compaction abort; this race is not fixed. The orchestration final gate re-aborts and
quarantines crossings, but cannot make provider admission atomic. Controlled
probes observed SDK user-message/queue acceptance after gate closure in selected
schedules; absence of a provider call in those tests is not a universal proof.
A human message from Agent details uses the same cooperative steering path and
the same limits (64 inputs per task, delegation Off rejects it). The fixed human
lead leaves 16236 UTF-16 units for normalized, trimmed message text within the
unchanged 16384-unit input bound; blank text is rejected before admission. The parent model
sees at most the optional `human_steered` marker, never the text, and that marker
may be omitted under byte pressure; a parent can therefore still redo work the
user steered away from. The draft is single-line, memory-only and lost on session
replacement.
Natural-finish steering has SDK-version-specific scheduling behavior and a
quarantined new-prompt fallback. These are known limitations under the documented cooperative contract, not
newly fixed SDK behavior or public acceptance.

`/reload` with an open Owner is unsupported. Pi 1.5.1 refuses reload while its
own session is busy, but an idle parent with live Alehouse children is not
protected by that check. Pi offers no pre-teardown reload veto; an extension
`session_shutdown` cancel/throw cannot provide one.
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
and never auto-closes: use explicit `/alehouse-close`. Releasing every Agent is not Owner closure. `/alehouse-close` is
a user command, not a model tool; it remains available and permanently disables
new admission through that Owner. An unconfirmed/throwing shutdown cancels and
retains reservations and lease semantics. The guard is opt-in and not a reload
guard. Do not promise atomic cancellation, reload safety, or input admission
safety.

Live IDs, resident reservations, idempotence memory, and pending alerts do
not survive a Pi restart. There is no force release, force unlock, cleanup retry
endpoint, restart hydration, automatic expiry, or reliable notification delivery
service. A Linux local `flock` lease is not distributed coordination or proof
that detached children have stopped.

Request idempotence keys on the tool-call ID, which Pi passes through from the
provider (both the OpenAI-compatible and Anthropic adapters adopt the provider's
ID verbatim) without validating uniqueness. A provider that reuses an ID across
assistant messages is trusted: identical arguments replay the earlier accepted
command fact — a repeated `agent_run` observes the old task instead of starting
a new one — while differing arguments fail `REQUEST_CONFLICT`. Observations are
not cached: a retry cannot restore alerts already consumed by successful local
publication. The
orchestration layer does not currently scope the key more tightly. The tool context can read
the session branch, so keying on the assistant entry that carries the call may
be possible, but that depends on Pi persisting the assistant message before
tool execution, including parallel calls, which has not been verified.

## Host SDK and runtime scope

Development API checks target Pi/AI/TUI 1.5.2 and TypeBox 1.3.27. The launcher
uses the installed host SDK, not a bundled second SDK or a runtime version lock.
There is no version allowlist, compatibility fallback, or historical support
matrix. Unsupported host or event shapes fail closed; a discriminator's
introduction version is not a supported-host matrix, and a development SDK pin
is not production-host validation. Required APIs fail closed when absent/changed. In particular, the
current host bridge must use `ModelRegistry.runtime` because the SDK exposes no
public canonical model-runtime getter; it validates required methods and relies
on actual-host smoke coverage. This is an observed bridge, not a stable upstream
promise. Pinned parent-only web access can warn that dynamic
tool activation is unavailable when upstream host-version detection cannot
resolve the aliased SDK; its eagerly available tools remain under normal parent
permissions. This warning does not authorize child web, a permission bypass,
or a second Pi runtime. In Co-worker, Lead and Supervisor those parent tools are
hidden and refused regardless of eagerness: scouts handle even small web
lookups. Manual and Off restore the upstream web-tool selection. The parent
can still fetch through Bash, which guidance forbids but does not enforce;
history and scout quotations can also contain page text. Results remain
untrusted. If no usable scout is available, the user must choose Manual or Off
for direct web access (see [security](security.md#parent-web-access)). Scout
children (internal `researcher`) register no activation loader and suppress
their repeat of that warning.

Pi validates and coerces tool arguments with pi-schema's JSON Schema validator,
not TypeBox's. TypeBox-only refinements, codecs and custom formats are not
enforced at that layer, so orchestration tool schemas use plain JSON Schema constraints.
Parent management tools also run a TypeBox `Check` on the raw arguments before
Pi coerces them (a numeric string is not an integer there), and execution keeps
its own checks. Child tools rely on Pi's validation and accept its coercion,
such as a number given for a string field. Validation error text is upstream
wording, not a contract.

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

Native compaction/retry remains SDK behavior inside a Run. The SDK does not
expose all failed/cancelled/retried summary attempts or the actual routed model
for successful summaries; successful summary usage is instead keyed as
`compaction/<provider>/<requested-model>`. The ledger retains observed floors
and partial flags; it cannot prove complete provider billing. Child
cache-warming is stopped, including the idle warming that Pi 1.5.1 enables by
default. Alehouse leaves the parent's warming policy and persisted settings to
the host; parent idle warming can incur provider activity and cost after a run. Since
Pi 1.4, a compaction summary may use the model's output limit, reduced to fit
the context; `reserveTokens` controls when compaction starts, not summary
length, so summaries can add output, latency and observed cost.

The delegation guideline on `agent_spawn` (see
[tool contract](tool-contract.md)) renders in the default system prompt's
Guidelines section. Division of work and eagerness are guidance only: Manual
does not block delegation, and model adherence has not been measured. Parent
web-tool hiding and call refusal are enforced separately. A custom `SYSTEM.md`
or `--system-prompt` replaces that prompt, and with it the guideline, not the
web-tool restriction.

## Retention, history, and accounting

Owner-memory results are bounded by cumulative Run/result limits but not by
heap/RSS. Prompts, settings/context snapshots, metadata, and resident SDK
memory are outside result accounting. There is no automatic eviction; hitting
the limit requires closing the Owner for new admissions.

Jev audit rotation bounds only the active file, not archived history or total
disk use. Archives are retained without automatic deletion. Its Linux-only
synchronous writer requires procfs `/proc/self/fd` and trusted util-linux flock;
unsafe paths, exhausted contention waits or IO/cleanup failures defer automatic
approval. The persistent regular lock file is not removed; the kernel releases
its OFD lock on process death. This is not an Owner lease, and successful append/
rotation is not fsync or crash durability. Kernel waiting and synchronous IO can
still block the event loop; the contention budget is not a hard filesystem bound.

Jev also requires verifiable ownership throughout the canonical audit directory's
ancestry: the leaf must belong to the current UID and every ancestor to that UID
or root. A user namespace with unmapped host root can display ancestors such as
`/home` or `/tmp` as overflow UID 65534 (`nobody`). Such a view is unsupported for
Jev audit/recovery, even with healthy logs, procfs and flock: ownership rejection
makes Jev automatic allows defer and can fail the offline Jev test lanes. The
`untrusted_directory_owner` diagnostic points to namespace UID/GID mappings, not
the lock executable. Numeric overflow IDs are not trusted exceptions, and retry
or offline log recovery cannot establish the hidden owner. See
[the namespace limit](jev-audit-recovery.md#user-namespace-ownership-limit).

This does not silently repair legacy directory locks, old link/unlink double
links or partial JSONL tails. [Audit recovery](jev-audit-recovery.md) is a separate,
explicit offline operator action with dry-run inspection and retained evidence,
not a model tool or an Owner force-unlock. Writer shutdown is an operator
precondition, not something a PID/TTL or confirmation flag proves. The old
unlocked logger ignores the new protocol; mixed-generation operation is unsafe.
Stop every writer before upgrade/rollback and use a fresh matched Pi process.
Safe shared log-directory permissions are preserved; unsafe writable ancestors
or a changed/unprotected symlink target still defer rather than weaken checks.

The [tool contract](tool-contract.md) defines communication and retention.
Every reply carries its reason, including snapshot/done; zero
alerts_pending/finished_pending,
the redundant pending array and empty result text are absent. Positive counts,
notification semantics, original-Run provenance and atomic publication remain.
There is no metadata-only read view; other tools, arguments, execution
features and retained artifacts are unchanged.
One FIFO preserves accepted alert order across Runs. Child-origin limits remain
64 per Owner / 16 per Agent; optional orchestration feedback has separate limits of
16 per Owner / one pending per Agent, for at most 80 entries total. Reserved
admission quota is not delivery priority. There is no per-Run queue, coalescing,
eviction or rejected-call drop counter.
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
show question identity with delegation_off. Unanswered questions return again;
to defer one, explicitly name other Agents in `agents`, which also limits alerts
to those Agents. Preset changes do not rebind a wait. Alert wakes matching
observers, not the parent model, parent Bash or a new
turn; ask asks the child to end rather than forcing suspension. Only a true
healthy pending needs-input settlement can be explicitly answered. Historical
questions are not permission or an actionable continuation.

Optional scout `return_to` does not add atomic cancellation, isolation, a
deadline, reserved capacity, restart recovery or a second admission after the
scout finishes. One call installs both ordinary Runs or neither. Caller
abort/timeout cancels the observation only. Stopping the worker does not stop
the scout. The scout is released only after the continuation's `input_entered`
has taken its whole result; a cut, undelivered, reused, asking or ending scout
remains resident until explicit kill. The length sentence appended to the scout's
task is guidance, not enforcement: a longer result is still cut, and the worker
cannot fetch the rest. `return_to.instruction` is the worker's conditional
continuation instruction, written before the scout's findings exist; it is not a
preknown answer or the scout's prompt. `agent_answer.answer` remains the
explicit answer field; model `instruction` maps to the internal core `answer`
field.
Source failure can
fail the pending continuation and reopen the original question only while that
continuation is pre-input and the worker is healthy. After input entry, nothing
here restores the question. All parent-model result observations of the source,
including spawn/send/wait and explicit `agent_read` by name/task/cursor, replace
raw source text with a short orchestration-authored notice identifying the source and
exact original worker continuation name/task. It reports pending until that
continuation's `input_entered`, delivered only after it, or not delivered if it
ended before input. Once not delivered, or delivered with retained text omitted from the bounded handoff, an explicit `agent_read` of the source returns its real retained result pages with normal cursors; other observations' notice says so and counts any omitted UTF-16 units. Later failure/kill does not undo observed delivery. The exact
link stays sticky after either Agent's reuse/kill or Off. No raw paging/omission
flags or source result cursors accompany the notice. Ordinary scouts without
`return_to` retain normal output/paging. Internal `getResult`, dependency handoff,
human UI and history retain true raw source text unchanged. Alerts, questions
and labels remain visible; this is not an OS sandbox or zero-information-flow
guarantee, and adds no model-visible flag, read mode or permission. Same-request replay returns the source Run and its linked continuation;
a different `return_to` conflicts and does not start another pair. The parent
authority's `checkToolCallPermission("agent_answer", ctx)` decision used by
compound prepare is made under the principal its own tool gate binds and
includes session always-allow and managed yolo; a selected deny still survives
yolo. It does not consult the authorizer chain, so an `ask` that a chain link
would approve is still refused here. That query
is not a new grant, and `getToolPermission` is not a substitute. The source link
is live Owner metadata for the current Owner only. Journals do not persist or
recover it, and existing journal names and data stay literal. This text is not
acceptance of the feature. An offline permission-interface observation does not
mean the feature's tests passed.

Question/result/alert text shares 16384 UTF-16 units and the
double-JSON content envelope is capped at 65536 UTF-8 bytes. Labels/tokens/diagnostics count against
the byte limit, even when outside the text budget. A complete first alert is
reserved for reason=alert; full worst-case question and alert cannot always fit
together. Read prioritizes the complete recorded question; unshown alerts stay
pending. Mandatory control rows and truncation flags stay intact;
the model tool adapter requires resident ≤16 (production twelve), while core can
support more. Model tool assembly also explicitly binds lifetime-valid unique
model names, rejecting incompatible existing generic history before exposing
tools; final admission prevents later incompatible work. Generic core names
remain optional/repeatable display text. Low-level `observe` requires
model-representable snapshots; it is not generic identity conversion. A refused
binding preserves pending alerts but does not make their bodies model-readable;
`getResult` reads retained result text, not the alert FIFO. No accepted facts are
silently filtered or renamed. Increasing adapter bounds needs a new packing
proof, not silent truncation. Handoff notices pack whole as normal result strings
or yield with `response_limit_reached`, never as fake pages; `max_chars` applies
to raw pages, not bounded notices. Fixed-width recovery cursors are reserved for
bound terminal windows of real retained result pages with remaining text,
including packing-omitted pages after Agent reuse;
the conservative retained-envelope fixture stays under the 65536-byte cap,
reserving the longer of queue-wait and terminal outcome reasons and excluding
the retired pending-name array. Whole optional labels can yield with
response_limit_reached; there is no metadata-only view. Keep
returned result cursors to continue a page, or use a positive safe
`agent_read.task` to restart that named Agent's retained task from page one.
Task/cursor are mutually exclusive; ordinals never target commands. No all-history
dump, new registry, restart hydration or persistence is added. Result r1_ cursors
remain stateless 128-bit Owner/generation/Run/version locators with accepted
negligible collision risk, not permission grants. Named task reads remain
available after kill in the same Owner, not after restart. Timeout/abort do not drain
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
settled_seq, not a second log or cursor. Candidates are Owner-wide for every
observation, not limited to its bound tasks, and only rows actually shown are
consumed, so nothing is consumed silently. Showing that original task's terminal
row commits its bit;
a running row with the same Agent name, alert/list/UI/count never does. A
finished label is optional and checked against that original Run; omission
neither delays consumption nor resets the bit. Result/history remain rereadable
and pending questions can reopen without resetting the bit. Joined `agent_send`
messages and host-side live history projections are bounded Owner-memory state,
not restored from journals. Live Run context, usage and elapsed time remain UI
observations; retired timed warnings are not interpreted by the current codec.
Task descriptions stay on their Runs, without a separate earlier-label or
touched-path summary. Every task row, including list/interrupt, may carry a
bounded, nonyieldable `outcome_reason` from the closed set; unknown internal
reasons map to `other`, finishing rows have none, and historical records stay
byte-literal. Model task/finished rows attribute the first accepted explicit
human stop request as `interrupted_by: "human"`; internal records, snapshots
and history retain `cancellation_source`, and attribution is not proof the task
stopped. The top-level observation `reason` and `error.reason` are separate and
unchanged. Old notify/progress/send-answered logs stay readable literally,
never rewritten or hydrated as new pending work. Handed-off text is another child's retained
final output, bounded and framed as reference; it is not verified.

SDK journals are the only historical transcript source, but are not immediate
durability or power-loss proof. Raw JSONL can be large after compaction; cold
reads have a file cap rather than an RAM cap and can fail on malformed, changed,
or incomplete boundaries. A failed cold read is per-run unavailability for that
observation only: stored records are never rewritten to make it succeed, and
the offline analyzer's strict whole-batch failure is a separate audit behavior,
not per-run recovery. History cannot resume work, repair records, browse
arbitrary paths, or bypass permissions.

Pi's public extension context lacks a parent usage writer. `UsageLedger.total`
is derived from its `byModel` shares; live runtime observations and final facts
merge as a non-regressing observed-floor envelope. That observation state is
distinct from parent handoff: child spend can be merged only into a later parent
tool result. This usage hook may append accounting without modifying the
already-published communication body; it is not a message ACK. Spend settling
after the last such result remains
`unreported_usage` and gets a non-billable audit snapshot when possible; abrupt
process loss may prevent even that. Partial usage means incomplete observation,
not zero price; unreported residue is a separate gap. Neither is repaired by a
footer or audit entry. Pi 1.5's `usage.cost.totalFromProvider` distinguishes
provider-billed totals from catalog estimates. The orchestration ledger retains the
SDK-observed amounts, not this source distinction; its totals are not proof of
actual billing. Adding child ledger costs to a tool's provider-reported usage
therefore clears that claim for the combined total.

## Permission and isolation scope

[Runtime feedback](runtime-feedback.md) observes only the managed authority's
own returned blocks. Its bounded exact-tool counter is partial, not semantic
retry detection or reason classification; silence is unknown. Generic
model-recovery hints are not generated. Concrete errors and Owner/cursor
resolutions neither diagnose model ability nor authorize migration or retry.
The linked contract lists unobserved paths and publication limits.

The orchestration layer depends on, but does not own, generated worker policy, permission
authority, static guards, search policy, and Jev review policy. The
permission-aware search tool keeps its 1–500 match-limit and 0–10 context-line
clamps and reports the effective values when it normalizes a request; the
schema adds no maximum and no new deny. New model
requests offer only `worker` and `scout`. Worker maps to stable internal
`editor`, with local read/edit/write/Bash/Git/build tools under normal permission
for local diagnosis, code review, design, implementation and verification. It has
no web tools; that is not network isolation. A review assignment is not an
enforced readonly ceiling. Scout maps to stable internal `researcher` and
keeps read, grep, find, ls and the four web tools, with no model-facing
Bash/edit/write. It gathers, compares and summarizes information from local
files and web sources, including local-only tasks, and returns cited findings.
Web material is untrusted. Simple local command lookups belong to the caller. No model-facing
Bash does not mean web tools have no subprocess or file effects: upstream
features can still clone, run helpers and cache. A citation is not a safety guarantee. Reasoning
difficulty is independent; scout is not a cheap, shallow or quick tier. Basic
credential/resource/high-risk protection and user-configured denies remain.
No profile is an OS sandbox.

The former public name `researcher` is unsupported, not an alias. Generated
filenames, config paths, historical records and `#researcher-web-access` keep
the internal ID. There is no live session migration. No legacy profile aliases
or capabilities are supported. Opaque programs can
perform internal IO outside the classifier's view. Redirect-buried argv belongs only to the last command of a redirected
body; completed spellings add restrictions, never ALLOW. Dynamic `cd` targets
keep an unknown, yolo-satisfiable base; the speculative HOME-stability fold is
retired. See [redirect-buried argv](security.md#redirect-buried-argv-and-home-cd).

The static guard refuses only hard denies. Shapes a static Bash allow cannot
prove safe (dynamic reader operands, indirect file lists, inline environment,
expanding heredocs, non-literal printf/sha256sum/rg forms) fall back to
ordinary approval instead: the authority sets every allow aside for that
program, including project/agent-scope allows and session grants, while the
full policy's restrictions still apply (a deny default with an allowlist
therefore denies an excluded program). Under yolo they run like any other ask,
so their dynamic paths stay invisible to path rules; the exclusion decides who
approves, not what the shell expands. There is no session grant for an
excluded ask in this version: without yolo each call is approved once. A
worker forwards the requested command, and the serving parent evaluates the
exclusion again against its own allows, so the parent must be the same build
as the child (the existing new-process contract; no older wire shape is
accepted). Missing or malformed forwarded access facts are rejected before
approval; a Bash tool's path gates still use their own path surfaces. Literal
redirect targets are path-checked by syntax, preserving decoded filename bytes
through cwd and canonical-path resolution rather than applying tool-input
cleanup a second time. Non-literal targets and arbitrary programs' internal IO
remain outside the classifier. Ordinary agent frontmatter still outranks global
rules, so a worker profile's `bash: "*": ask` can turn a global specific
non-privilege Bash deny into an ask that yolo satisfies unless the separate
static guard refuses its literal form. The narrow exception is the authority's
[configured privilege-command deny floor](security.md#configured-privilege-command-denies):
a selected ordered global Bash deny for an actual literal `sudo`, `doas` or `su`
execution survives profile/project rules, session grants and yolo, including
recognized wrappers and substitutions inside expanding heredocs. This is not a
claim to detect privilege execution inside opaque scripts, generated command
names or unsupported wrapper syntax. A synchronous advisory query without the
parser/source needed for this floor cannot report an automatic grant; it returns
a fail-closed ask instead. Other scope precedence is unchanged. See
[static-allow exclusion](security.md#static-guard-static-allow-exclusion-and-redirect-targets).

Nested delegation is excluded for every child. Only scout (internal `researcher`) has web tools;
worker has no web tool table. Scout fetch schemas and capability wording
allow only absolute HTTP(S) URLs, never local-video paths. Scout `web_search`
has no `workflow` or `model` and always resolves `workflow: "none"`, even when
configuration would inherit `summary-review`; `fetch_content` answer/extract
and video analysis remain upstream residual risks. Scout file reads
and web calls together can move project content to the network; source hygiene forbids that but cannot enforce it (see
[researcher web access](security.md#researcher-web-access)). Tool availability
is not authorization.

Child skills default to discovery on unless `childSkills` is false or this launch
uses `--no-skills` / `-ns`. The choice is sampled when a child session is created,
not when an Agent is queued; existing sessions retain their resources. Skill-name
permissions depend on the advertised catalog and do not provide universal file
protection, including for hidden known skill paths. Off reduces discovery, not
file-read authority. Existing policies whose missing `skill` rule falls back to
`ask` can add manual/Jev-mode human approvals; init does not update them and Jev
never auto-allows the skill surface. See [skill permission scope](security.md#skill-discovery-and-permissions).

[Git literal restrictions](git-read-proof.md) inventory identifiable literal
file operands, historical path spellings, explicit outputs and redirects, not
arbitrary historical content. Repository queries and mutations use ordinary
Bash permission; only bounded literal Git version queries can qualify for
fixed-query automatic allowance. There is no blanket Git allow, extra
worker-only blanket mutation deny or second per-operation effect authorization
matrix. Commands, environment, executable selection and leading `cd` stay
unchanged. Raw configured denies/specific asks and independent path/output/
redirect facts remain. A selected deny survives grants/yolo; normal yolo can
satisfy ordinary asks, not invalid-config fail-closed asks.

There are no command-classification Git subprocess provenance probes,
history/object walks or unattributed-sentinel workflow. Literal historical
paths can use safely observed conventional repository-root aliases; unknown
roots remain unknown. Bare objects, patch output, batch stdin and arbitrary
history do not have complete file-by-file protection. Ordinary Git access
exposes repository history; do not delegate repositories needing that content
separation. Path rules do not intercept every internal Git syscall or helper.
Native Git may refresh index caches and take locks, including `index.lock`.
No zero-write, automatic retry, safe lock deletion or atomic repository snapshot
is promised. An operator may explicitly launch with `GIT_OPTIONAL_LOCKS=0`;
the product does not inject it, and it disables neither required writer locks
nor all IO. Portable path tests are not native Windows/MSYS Git validation.

### Shared working directory

All Agents use the parent's working directory, including pending local changes,
dependencies and outputs. Concurrent edits and Git state are not isolated;
coordinate them explicitly. Alehouse does not create or manage worktrees,
choose an alternate child cwd, or merge and clean working copies. Existing user
worktrees and historical records are left untouched.

Jev review concurrency is independent of worker capacity: up to four root and
eight distinct subagent reviews can be in flight. Extra reviews defer with
`review_overloaded` to ordinary human handling; duplicate in-flight packets
coalesce. Parallel tool calls can exceed this even with fewer workers, so twelve
resident Agents do not promise twelve simultaneous automatic approvals.

Automated review requires its external policy, key, complete current provenance,
and supported context. It can defer and leave a human ask; it is not calibrated
model-quality evidence or a new grant authority. Context snapshots are bounded
text, not history forks, and history/diagnostics may contain sensitive model
content. The orchestration layer does not copy credentials, although authorized real SDK
use can refresh an auth file.

## Task dispatch and validation scope

[Task dispatch](task-dispatch.md) is bounded declaration/observation, not a DAG,
OS sandbox or general test scheduler. Only a single explicitly delegated
validation owner may run the full gate; others stay focused. Declared `checks`
do not prove execution, and undeclared effects or different
agentDir/host/build-directory (internal tree) identities are not automatically
coordinated. Profile/external preflight is
approximate: ask/unknown is not a grant; child gates may be stricter. Literal
paths and lexical/canonical aliases do not provide hardlink tracking or atomic
filesystem protection. Required paths must exist when actually checked, whereas
ownership/build directory may name new outputs. Required paths are revalidated,
not held resource locks. Pump/answer rechecks
retain strict claimed-resource equality. Pump rechecks can wait for a free slot on that Run's own provider; failing a task
whose dependency settled without completing does not. The admission wait for a
release already under way is bounded (10 s) and does not make parallel
tool-batch order a guarantee.

Claims and existing tree leases span healthy pending questions and answer
continuations; reopening a question before input entry restores its claim.
Cleanup uncertainty, including sticky tree-lease close failure, still retains
resources; later SDK cleanup success does not clear that failure. Local tree
contention is advisory, not exclusivity evidence. Synchronous flock blocks the
event loop even when contention is nonblocking. There is no execution-time timer
or timed warning input: a blocked tool cannot read queued steering until it
returns. Turn-limit stops and manual cancellation remain cooperative. Historical
`deadline` outcomes remain readable literally, not active Run controls or new
parent-model telemetry; retired `time_wrapped` facts are no longer interpreted
by the current codec and read as explicitly unavailable.

Checks-only `source_state` is superproject-only partial non-atomic metadata,
with submodules ignored: not a content fingerprint, validated source version
or whole-tree clean proof. Capture only supports repository-root conventional
`.git` directories; other layouts remain unknown. Fixed --untracked-files=normal
covers non-ignored untracked entries but ignores/global excludes, indexes and
Git/platform semantics remain; empty status is not whole-disk clean. Even global
LFS clean/process configuration or core.fsmonitor=false makes capture unknown
under the conservative key-presence guard, without blocking ordinary tasks.
Source Git subprocess probes
are asynchronous with per-probe 2-second/4 MiB and aggregate 8-second/8 MiB
limits, not hard-realtime bounds or cancellation/kill guarantees. Trusted Git
absence/unsafe configuration/failed capture is unknown, not a failure of
ordinary tasks. A receipt requires a valid history boundary and a successful
sole end append; the returned SDK append ID is not disk/fsync proof.
Unstarted/missing-boundary Runs leave offline coverage gaps. A bad optional
receipt is dropped with validation_receipt_error: 'invalid_validation_receipt',
a live cleanup diagnostic and recorded-history warning; mandatory core checks
and append failures stay strict and never trigger a second append. It is consumed through trusted history/offline
audit, not automatically by the parent model, and skips no validation gate.
Run notes and optional public note projections are memory-only; they may yield
and cannot be guaranteed recoverable after omission or Agent reuse. Retired
`time_wrapped` warning facts are no longer interpreted by the current codec or
the offline analyzer, are not parent-model telemetry, and live stats emit no
such counter.
No new notes cursor, persistent ACK or task hydration is promised.
The journal analyzer remains strict JSON-only; --json is an explicit alias, not
salvage mode, and failure does not mean zero usage. A needs-input resource
conflict needs answer or explicit abandonment/kill with confirmed release,
not passive waiting/after on the original question Run.
Worker L1 guidance says report a denied-operation limit without retrying the
same class. Partial exact-tool managed-block observations are not semantic L2
retry classification and do not establish the operation or deny reason.

## UI scope

`ui.borderLabels` is one appearance switch for all Alehouse-owned panel border
chrome, defaulting to on. Off retains the frame and moves labels and close/action
controls into interior rows with separators; native Pi and third-party UI are
outside this switch. Additional rows reduce the body budget and can make a tiny
panel or its controls unavailable. Switching retires old painted targets and
armed pane actions; it does not submit actions or change Owner authority.

Worker thinking previews contain only provider-visible thinking text or reasoning
summaries; hidden or encrypted reasoning is not decoded. Summaries can arrive
late or never arrive. The `thinking…` placeholder does not prove public thinking
is being streamed. Current-message thinking and prose keep bounded, left-anchored
logical-line prefixes: an overlong line is ellipsized on the right and may stop
visibly growing until a new line begins. This favors readability over a scrolling
last-token ticker. Compact previews are not a full or token-by-token transcript;
Agent details retain Pi's native transcript separately. Each active-tool summary
and supplemental detail preview is one row. Commands are bounded identifying
argument previews, not a shell parser or content redactor: a command may contain
an embedded heredoc/body snippet even though it cannot grow the compact fields
into multiline content. Full command text remains in the native transcript.
Leading Markdown cleanup is deliberately heuristic: unfinished `**` is removed
only before a Unicode letter/number, preserving leading `**/*.ts` globs but still
treating literal `**kwargs` as markup. Leading list/bold-looking code can resemble
markup, whereas inline code/globs stay unchanged. Complete and unfinished multiline terminal string-protocol payloads
are omitted from previews rather than displayed as false last lines. Real tools
stay visible while cooperative cancellation/drain is pending; this observation
is not proof of execution exit, and detailed drain diagnostics remain separate.

Well-formed current `ask_parent`/`alert_parent` transcript calls use the host's
Input background for literal bodies, with right-aligned titles above and outside
that background, not ordinary tool-card framing. Bodies use tool-argument encoding:
protocol payloads and Unicode whitespace survive, controls/backslashes stay distinguishable, tabs
are visible `\x09` and LF keeps paragraphs. Matching requires exactly one own
enumerable data-property string, nonblank and at most 8192 UTF-16 units; accessors
and extra own keys (including symbols/hidden keys) stay raw without invoking
recorded getters. Proxy traps are not effect-free or resource-bounded.

Recorded receipts remain separate and use `plainText`, not faithful argument
encoding: recognized protocol payloads disappear, whitespace is normalized and
literal/encoded control spellings may coincide. Failed receipts with zero
SDK-measured non-whitespace cells get an `Error` line, retaining any nonblank
normalized text below it. This metric is not a complete blank-glyph or pixel
visibility detector. With no recorded result a dim `No recorded result` line
appears outside the background; any final result, even empty content, or a
synthetic failure clears it. It asserts neither live execution nor failure,
delivery or parent acknowledgement. Incoming messages with an exact live
message-object origin show `From parent`, `From user` or `Alehouse input`.
The parent label identifies the dispatched envelope, not authorship of its
embedded reference material. Origins are a presentation-only in-memory sidecar,
not journal metadata or permission evidence; retained messages keep it after
child disposal, but reloaded objects do not recover it. Unknown messages retain
`Input`, with the existing exact human-lead qualified fallback (text recognition,
not authenticated authorship). Neither body equality nor history position
establishes origin. Malformed and retired tool records stay literal.

Origin capture observes the public child Agent's `prompt`/`steer` methods in a
single ticket-admitted async dispatch and binds at most one exact user object.
The initial prompt also requires the SDK's `preflightResult('started')` hook,
currently documented for internal RPC use. These are compatibility seams, not
a public SDK provenance API. Missing/nonreplaceable methods, changed message
shapes, lost dispatch context or failed presentation observation leave the label
unknown without changing execution. Inputs, queues, provider text and journal
records are not rewritten to carry origin markers. Trusted in-process code is
not isolated by this observation.

The Subagents roster aligns identity, configuration and compact metrics before
the final variable-length task label when width permits. Columns use spaces,
not additional vertical dividers, and metrics follow configuration rather than
anchoring to the terminal's right edge. Within metric columns, the turn marker
and context label align left and values align right, with any padding between
them; absent context observations remain a bare right-aligned dash.
Optional model/ordinary metrics yield before essential facts, bounded causes and
the preferred title allocation; the 24-cell title preference excludes the suffix
width. Tight rows retain compact facts in the trailing task field, never a separate
attention prefix. Questions precede live execution, then attention/queued/recent
failed and finished tasks, stably
within each group. Only unanswered questions and pending messages bypass normal
finished-row linger; historical warnings and reached turn limits do not keep old
rows permanently visible. Released diagnostics still expire. Compact overflow
reserves a live identity when header space permits, drops previews before Agent
identities, and counts hidden attention. Compact columns use only individually
painted Agent headers: neither collapsed queued records nor overflow-only records
contribute columns or padding. Expanded pages share their complete eligible
roster's geometry; resident heading counts retain their full scope. Pending,
warning and lifecycle text share the final task field as parenthetical suffixes,
such as `Review gate (1 pending)` or `Review choice (needs answer)`; there is no
separate attention column or shared empty attention padding. Task text yields
to complete essential suffix facts under width pressure. Titles fit whole when
short, or retain at least four literal cells before an ellipsis; otherwise the
optional title is omitted rather than taking preferred nickname cells. Each
row plans its own failure detail allowance (at most 60 cells), independent of a
sibling's title length. Short-limit alternatives participate in fitting as well
as painting, including at the grid boundary. Reached turn limits remain a final
warning-colored `(turn limit reached)` group, shortened to `(limit)` when
necessary, after any other group. In impossible budgets clock/tag, an unfitting
limit, or finally the whole attention group may be omitted; structured counts
and marker words are not clipped into plausible partial facts. These remain independent
observations beside any lifecycle state, not proof that a soft-limit wrap-up
stopped execution. Moving these labels does not acknowledge alerts, answer
questions or alter retained error facts. The heading has no
cost rollup, and compact
rows omit tool-call counts; actual tool activity and detail counts remain.
Per-Agent widget costs use cents and retain `≥` for partial observations:
finite observations are interpreted by their shortest decimal spellings before
rounding (or truncating partial lower bounds). Unknown prices are not zero,
and a measured price below half a cent reads `<$0.01`, so only a reported zero
reads `$0.00`. No epsilon guesses away an already-aggregated upstream
just-below-cent value. Context uses whole percentages, and detail fields retain
finer precision. Context at 70%/90% and turns at 80% receive warning/error tints
from unrounded observations, not budget enforcement; the shown percentage never
rounds up across a threshold the observation has not reached (69.9% reads 69%). The activity clock displays a duration
without the `turn` prefix, but remains **turn** elapsed time, not tool/thinking
duration. It moves into the
header when that Agent's activity subline is omitted, without duplication in
ordinary pairs; at extreme widths it can yield whole before structured facts
are truncated. Exited/finishing execution has no current-turn clock. Activity
labels and content share the host theme's italic styling, while the clock and
tree indentation remain upright; actual italic appearance depends on terminal
font support. Its 60-second tint is only a presentation cue, not a hung-tool
diagnosis or lifecycle timer. In Agent details the metrics moved to one bottom
info row above the Agent-tab footer, under a plain separator that carries no
text, controls or hit targets; there is no merged toolbar and no labeled section
rule. Its live-turn clock is floored to whole seconds uniformly, while the
60-second tint still reads the raw unrounded observation. The figures keep a
fixed display order but yield separately under width pressure: the model text
shortens first, then the total, cache percentage, whole usage group, cost and
routine turns drop. The shortened model yields before elevated turns, and the
status compacts before context yields; numeric figures are never clipped
mid-figure and only the model text may be shortened. A shortened model that
survives that ladder regains leftover cells only after the optional fields have
dropped; regained width never reintroduces a dropped field or reorders the
yield priority. The row reserves the
critical ones (lifecycle status, its turn clock, elevated context/turn
pressure); no completeness ratio is invented, an unknown share is omitted rather
than rendered as zero, and a partial cost keeps its `≥` floor. The title's
identity tag needs the nickname to fit whole or keep three terminal cells
including its ellipsis, and the tag-less task title requires that same
nickname floor; where the task and a recognizable name cannot fit, the nickname
plus its Run cue wins over a bare ellipsis name. Page and tool controls live in the footer's actions menu
and their keys. That `[⋯]` control is reserved in the footer, so optional peers,
message and tail forms yield before it; it is absent when no Agent is selected
or the caller's minimum width, current geometry or two-option menu viewport
cannot fit it. The menu is an overlay: it changes neither the pane's height nor the scroll
position, adds hit targets only while painted, and closes on selection, resize,
permission hiding, an armed Stop, a started draft or a stale target. Body scroll
aliases and the wheel close it and apply the body-scroll request in the same
event, subject to normal bounds (no extra dismiss-only press); its own Up/Down
move the selection. An
outside press that dismisses it is claimed and cannot also activate Stop or a
newly exposed control. Repeated clicks are not filtered globally. A partial
diagnostic overflow is counted on the last painted note row and on the menu's
Info item; the footer's `!N` cue is only the no-note-row fallback, never a
duplicate. At known small supported heights the pane keeps the minimal bottom
status by shrinking the body below three rows; a known budget under the
title/status/footer three rows paints no pane. Non-finite geometry admits no
Stop or compose commands, and command admission keeps the previous five-row
floor. Relative scrolling with no body rows preserves reading/following intent;
Home/End remain explicit choices.
The selected Agent tab uses accent/bold and optional host underline, not a solid
background fill; terminal transparency and underline appearance remain host
properties. Normal `agent_busy` is not a session-error or attention cue, without
changing core resumability or admission. Genuine diagnostics retain their cues.
Timer comparisons may reuse a detached frame for the next actual paint;
unpainted geometry is never activated as a click target or command evidence.

Close-button hover is presentation-only and requires fullscreen mouse-motion
reports. The optional adapter observes the host's private `handleViewportInput`
method because Pi 1.5 has no component mouse-leave event and its first input
listener consumes mouse reports. A missing/nonreplaceable adapter leaves
ordinary clicking and keyboard controls usable, but cannot supply hover or
native-interruption observation. The adapter forwards native dispatch unchanged
and clears stale feedback after outside motion, wheel, focus and
keyboard input; keyboard input may leave a stationary pointer unhighlighted
until it moves again. This is an implementation compatibility seam, not a new
public SDK guarantee. Panel hiding clears hover; gesture observation can remain
until a pending claimed press is consumed or interrupted. Final disposal retires
both. No polling or mouse capture is added. Hover retirement does not clear
keyboard navigation state. Pointer targets are retired independently on a
move/hide and require a fresh paint before activation; stale cached SDK mouse bounds are not permission
to activate a hidden control. The `✕` close target is exactly its 1×1 terminal
cell, not the surrounding spaces or frame. A claimed left press closes only on
release within that same cell; observed movement outside it, reset or changed
painted geometry cancels the gesture. This is panel-local
press/release handling, not a global change to the SDK's click synthesis.
Window focus loss is not delivered as a component mouse event. On the supported
native viewport adapter, a dispatch not delivered to the panel interrupts its
old close intent without parsing input or changing native capture/selection.
This covers the host's focus reset and a fresh outside-origin gesture; a new
right/middle press delivered to the panel also ends the old close intent.
Missing or nonreplaceable viewport support still permits ordinary component
close/keyboard events, but cannot observe native interruptions that never reach
the component. That unsupported-host fallback is not an OS focus/capture
guarantee or real-terminal acceptance.

Fullscreen alternate-screen rendering is required for floating worker panels and
click input. Regular mode deliberately docks the detail/picker to avoid
scrollback contamination; its footer retains totals but does not open the usage
popover. Fullscreen Delegation shares the pinned Context/usage column through a
raw overlay rather than a blocking SDK custom prompt. Later popovers wait off
screen when the remaining row budget is too small; a Delegation picker opened
that way also posts a notice, because it is otherwise invisible. Ordinary SDK prompt events
close Delegation and temporarily hide pinned footer panels; permission prompts
retain their synchronous priority protocol. Generic prompt events are delivered
asynchronously by the host, not an atomic global UI transaction: an end can
reach a handler before its start, so the Delegation gate keeps a signed balance.
The raw path reads pi-tui's module keybindings, which are the host's only
because Pi resolves an extension's pi-tui to its own instance (aliased or
embedded modules); a host that loads a separate copy would see default keys. Multiplexers
can further limit mouse motion. The pinned SDK's overlay sizing
options carry width, minWidth and maxHeight but no maxWidth option; the floating
detail pane therefore caps its width by computing a numeric column count from
the mounted pane's own terminal (88% of the live width, at most 164 columns),
falling back to the plain 88% percentage when that width is unknown. A stub or
structural host without a column count gets the uncapped percentage width.
Child transcripts use renderer-only projections from the live public SDK
registry, including native renderers present on built-in tool definitions.
Missing, failed or detached lookups use bounded generic cards; closed children
keep their history, not a live renderer-registry lease. Already-created cards
rebuild on binding changes, not on every streaming token. Binding-token readers
must be synchronous and keep the same identity until a real binding change;
allocating a fresh token on every read is unsupported. A thrown read suspends
custom display callbacks and shows bounded raw records; a later successful
read, including `undefined`, starts a new display epoch and replays history.
This is display recovery, not Owner/session recovery. Historical native
cards do not enable argument-complete/execution-started previews that could
read the current worktree; recorded results remain the source of the display.
Renderer callbacks are trusted extension code, not an OS isolation boundary or
a guarantee of no IO. Final styled rows keep SGR and complete OSC 8 links while
filtering other terminal protocols and exposing remaining control/bidi codes
outside preserved protocols. Tabs remain visible `\x09`. SGR can conceal glyphs,
and OSC 8 parameters/URIs can retain Unicode bidi; links are not validated
or trusted destinations. This is not secret redaction or a general guarantee
about callback behavior or visible text.
PTY/UI fixtures and scripted permission RPC are not
human-TUI acceptance. Expanded Agent inspection is paginated within a widget
budget (at most thirteen lines and one third of terminal height, with a further
reserve for normal SDK input chrome and transcript space), not an unbounded
roster in the input dock. Tall editors, additional queued prompts, other extensions
and tiny viewports can still constrain available space; expansion is suppressed
when its known budget cannot show controls, and `Alt+A` remains the
inspection fallback. Ordinary nonfull idle headings are hidden in regular/unknown
modes; full capacity and attention facts remain visible. Idle widget repaints
reuse detached presentation snapshots, not fresh command-admission evidence;
out-of-band idle changes appear only on the next explicit refresh.

Tool-argument display encoding preserves protocol payload text, Unicode
whitespace and code indentation instead of stripping or normalizing them.
Backslashes and controls get distinct visible spellings; ambiguous projected
keys become markers, never overwrites. This does not change execution arguments
or the permission authority. Compact argument fields are still width-bounded;
Activity/Info consumers keep their existing encoding and parameter whitespace,
without re-encoding paths. Ordinary metadata/generated-preview normalization
remains separate.

Cards retain private pristine projected input snapshots; renderer callbacks
and raw fallbacks get separate work copies, including `context.args`. Result
blocks select only visual text/image fields: extra metadata (even SDK
`textSignature`) is not forwarded or charged against body capacity. Details have
an independent 20,000 inspection/value-visit budget and 24-level bound; argument
copies use the same limits, and body field reads have their own 20,000 cap.
Hidden property checks are charged, repeated non-JSON aliases become markers,
and strings are not character-truncated. This is not a total CPU/RSS bound:
one complete property enumeration or arbitrary Proxy code may still be costly.

Tool cards revoke bridge-supplied invalidation handles when retired and isolate
synchronous callback/component failures with bounded raw fallbacks.
Promise-returning display code is rejected, not awaited. These display guards
are not an OS isolation boundary: they do not cancel arbitrary extension-owned
timers or revoke independently retained component references.

Interactive preset editing reuses the host's native `/model` selector with a
physical-model-only view; RPC uses a standard list instead. The native selector
may refresh provider catalogues and update host credential/cache state, just as
`/model` does. Selection itself does not switch the main model or save Pi's model
defaults. Fullscreen model selection is a near-click/centered popover that
yields to known permission prompts; regular TUI stays docked. Mouse item matching
uses the native public component tree and rendered labels, not private list
state. In a recognized layout the floating wrapper refuses clicks and Enter
confirmation when the selected model identity cannot be verified. Unknown
layouts stay keyboard-only, and Enter is accepted only while the native paint
has a single, fully visible selection arrow; ambiguous items have no mouse
target. Very small
viewports refuse unseen selections. Controlled selector tests use synthetic
runtimes, not live providers.

The prompt queue yield protects permission dialogs only within the known process
queue protocol. Queue-owned AbortSignals retire stalled native select/confirm/input
dialogs before advancing the FIFO, while preserving caller cancellation. Pi's
native inline dialog stacking does not replace this queue/yield protocol. Pi 1.4's
`editor()` exposes no signal/dismiss API: a stalled editor can remain until the
user closes it. Shortcut-created UI contexts can also bypass the queue. This is
not an atomic global UI transaction and `/reload` does not replace its existing
wrapper.

## Matched migration scope

New package, generated agents/policy/seeds/integrity manifest and managed user
definitions/permissions must match in a fresh Pi process; no open-Owner reload or
runtime swap. The public name `scout` follows the same rule: it does not rewrite
installed `researcher.md`, alias the old public name, or migrate a live session.
The launcher verifies managed definition digests, including prompt-body changes.
Absent-only init never repairs existing mismatches automatically;
reconcile deliberately as an operator, without automatic writes to existing
user files, replacing user symlinks or weakening permission floors. Rollback must
coordinate the same resources; see
[matched resource migration](development.md#matched-resource-migration).
The [one-time naming cutover](development.md#one-time-naming-cutover) also requires
all earlier processes to stop: current lease paths do not coordinate with a
previous namespace, and previous catalogues and record types are not converted.
Nix validation/activation, host collectors, live model/network trials, human
approval and publication require separate authorization and scoped evidence.

## Routing and configuration scope

Presets validate local routing configuration and current SDK metadata, not
provider credentials or remote availability. The required
`alehouse-presets.json` base catalogue remains separate and is never overwritten
by the UI. It requires version 3 with five independent `slots.d1`–`slots.d5`
objects containing `model` and optional `effort`. Any per-slot `thinking` field
is rejected, including an empty `thinking: {}`, as are flat preset-level
model/effort/thinking tables. Inherited
thinking uses current SDK metadata: identity first, otherwise the nearest
higher supported enabled level capped at the highest enabled level. It never
crosses the off boundary and does not guarantee equivalent compute or cost.
A non-reasoning model that supports only `off` fails `inherit` of an enabled
parent on purpose; set fixed `effort` to `off` for that slot if that is intended.
Empty or unknown-only capability metadata is not support for `off` and does not
automatically disable enabled thinking. Fixed efforts remain strict. Effort
override tables remain separate from these definitions.
Optional version-2 scoped preferences live in
`<agentDir>/extensions/pi-alehouse/config.json` and, only for a trusted project,
`<current-cwd>/.pi/extensions/pi-alehouse/config.json`; workspace lookup does
not search for a Git root. Fresh sessions use preferences before catalogue
defaults, while valid existing branch records keep precedence. Saved names
resolve against the current base catalogue directory, except for custom model
definitions explicitly stored in preferences/session records. Existing branch
records are evidence, not immutable catalogue pins. Older configuration versions
and three-slot definitions/effort overrides are rejected, including those in
restored session selections, as is any per-slot `thinking` field. No
compatibility expansion or automatic file migration is performed. Already-written
catalogue and preference configuration files must be corrected explicitly.
If a restored selection contains a retired definition, start a fresh session or
fork from before that invalid record; an unsupported saved selection fails
closed rather than silently defaulting to a different model or effort.
Historical Run journals retain their old slots and digests as display-only
data and are never rewritten. Display-only retention is raw literal
preservation, not a legacy compatibility renderer: retired slot/digest shapes
are not semantically re-decoded into current selections.

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

These constraints define support. If an operation needs a guarantee not listed
here—especially default-entrypoint replacement, atomic stop/reload, durable recovery,
complete cost accounting, automated approval, or human TUI acceptance—it is out
of scope until explicitly reviewed and accepted.
