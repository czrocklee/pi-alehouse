# Concepts

Pi Alehouse's harness uses four identities.  They are deliberately not interchangeable.

## Owner

An **Owner** is one harness controller bound to one live parent Pi session and
one owner generation.  It owns the FIFO scheduler, resident-Agent limit,
request-id idempotence, result memory, parent accounting handoff, and the local
owner lease.  Parent tools capture this Owner and the actual parent extension
context; there is no global registry, public service, or cross-owner lookup.

An Owner is memory-local.  Restarting Pi does not restore live Agent or Run IDs,
requests, reservations, or execution.  SDK journals may still be read through
`/harness-history`, but they do not rehydrate work. Switch/fork replacement
requires confirmed closure, not merely an idle or empty-looking Owner. A never-used Owner closes automatically before replacement;
once it has accepted any Run (including completed/released work), a real UI must
return literal `true` to the closure confirmation before draining starts. A
refusal, missing/throwing confirmation, headless context, concurrent target while
confirmation/drain is pending, or uncertain shutdown cancels and retains the
Owner. After confirmed closure the host SDK does not transactionally serialize
teardown, hooks, target loading, and replacement construction; wait for one
replacement operation to finish before starting another. `/tree` changes the same
session without creating a fresh Owner, so it never auto-closes and still requires
explicit `/harness-close`. A stale context, closed Owner, ambiguous parent history
write, or uncertain child cleanup fails closed rather than accepting work for the
wrong owner.

## Agent

An **Agent** is a resident reusable worker reservation with one immutable
admitted configuration:

- permission profile and rendered-definition digest;
- preset/version/digest, immutable difficulty (1–5), its internally resolved
  preset slot, exact provider/model, resolved thinking and recorded effort source;
- parent cwd and optional text-only inherited context snapshot;
- one child SDK session while it remains healthy and reusable.

Spawning does not isolate filesystem work: Agents share the parent's cwd and
checkout, including the Git index and any shared build outputs. Different Agent
IDs do not allocate separate worktrees, indexes or build directories.

An Agent can have only one current Run.  It is reusable only after execution,
input drain, history boundary handling, and cleanup state allow it.  Cancelling
is not sufficient.  An Agent lives until it is killed: an interrupted or
dependency-failed first task leaves it in place.  Killing an Agent is permanent; uncertain cleanup
leaves it reserved and is never force-released or automatically evicted.

Through model tools, every Agent has a caller-chosen **name**
(`^[a-z][a-z0-9-]{0,23}$`), unique per Owner and never reused after release.
The name is the model-facing address; `agent_id` remains the internal control
identity. Generic core names are optional display text and may repeat. Model
tool assembly explicitly binds the stricter naming/capacity contract for that
Owner's lifetime, after checking all retained Agents. An incompatible generic
Owner is rejected at assembly without renaming or consuming its history; its
ID-based lifecycle and result APIs remain available. Low-level model-envelope
packing is not a generic-name conversion API.

## Run

A **Run** is one queued or executing task on an Agent; parent tools call it a
*task* and never expose its ID.  It has its own internal `run_id`, request identity/digest, prompt boundary, deadline, turn budget,
outcome, result reference, telemetry, and optional SDK-history links.  A reused
Agent receives a new Run; it never changes the Agent's admitted routing or
permission configuration. Model replies derive a 1-based `task` sequence within
that Agent from enqueue order, without exposing the internal Run UUID. Labels
are auxiliary, not task identity. A question continuation is a new Run admitted
only by explicit `agent_answer`, never by `agent_send`.

Core lifecycle states are `queued`, `running`, `cancelling`, `completed`,
`needs_input`, `failed`, and `cancelled`; phases further distinguish
`initializing`, `executing`, `finalizing`, and `settled`. Model-facing task rows
project cancelling/cancelled as interrupting/interrupted and show finishing
until true settlement. A terminal outcome is not necessarily a complete answer:

- `completed` with `limit_reached` was stopped at the harness turn budget;
- `needs_input` has a separately recorded question;
- an unrecovered provider `length` stop is `failed`/`output_limit` with readable
  partial output;
- deadline expiry is `failed` with `deadline` stop/reason;
- unknown, `pending`, and `deferred` SDK stop reasons fail closed.

An `agent_send` `steered` report is only admission to the child-input path, not delivery.
A cancellation request is only a request.  The execution slot is freed only
after actual execution exit; the Agent reservation and Owner lease remain until
finalization and required cleanup are confirmed.

## Dispatch, claims and validation observations

Optional spawn/run `dispatch` declares inputs (≤8), ownership (≤16), one tree
and checks (≤16), with strings bounded to 512 UTF-16 units. Inputs are existing
ordinary files/directories; output ownership/tree may be new. Literal paths
are not shell globs/expansions; lexical and nearest-existing-ancestor canonical
aliases identify scope/conflicts. Profile/external preflight is approximate,
not permission or a guarantee of successful tools.

A **claim** is Owner-local declared resource ownership, not the UI `touched`
list or OS isolation. It survives queued/running/finalizing phases and a healthy
pending question. Explicit answer inherits dispatch/the same claim lineage;
pre-input rollback that restores a question also restores its claim and existing
tree lease. Final termination and required confirmed cleanup permit release. A needs-input
claim conflict requires answer, or explicit abandonment/kill followed by
confirmed release, not after/passive waiting on the original question Run.
After exemptions bind predecessor Run IDs at admission, not dynamic names;
pump still rechecks inputs/resources before execution. A dependency that
settles without completing fails its queued dependents at once, without a slot.

Wall-clock **soft wrap** is a guarded warning attempt with a bounded Δ window,
not receipt/checkpoint or turn limit_reached. Its soft-budget input invalidates
the approval witness without changing the hard deadline. Optional time_wrapped
and notes yield during packing, with no guaranteed recovery or persistence.
The time flag is optionally tried after questions/FIFO alerts and before
results; long ASCII results do not inherently omit it. Run-local due may wait
for real original inputEntered/canInput or post-budget turnStart, never pre-run
injection or retry after a rejected attempt.

A validation **receipt** is optional valid-boundary run-end observation, not a
passed-check or permission certificate. Parent-declared checks trigger a
superproject-only partial metadata source observation, with submodules ignored,
not a content fingerprint. Status includes non-ignored untracked entries via
fixed --untracked-files=normal, not all disk contents. Invalid optional receipts
are locally dropped with an end marker/live diagnostic/recorded-history warning;
mandatory history and append errors remain strict, with no retry.
Missing boundaries mean coverage gaps; consumption
is trusted history/offline, not automatic parent-model context. Local tree locks
are advisory within one host/agentDir/canonical identity and synchronous flock
still blocks. See [task dispatch](task-dispatch.md) for the full contract.

## Session

A **Session** is Pi SDK conversation state.  The parent session belongs to Pi;
the child session belongs to its Agent.  The harness uses SDK session history as
the only historical transcript source.  It does not maintain a duplicate result
store, history hydration layer, or durable notification queue.

Raw child journals are not a durability receipt: Pi can buffer or reconstruct
entries, native compaction does not shrink raw JSONL, and a session may fail
between in-memory and on-disk transitions.  A Run drops its live session
reference after input drain/history finalization.  Retained owner-memory results
do not keep an SDK execution environment alive.

## Task fields, not roles

`agent_spawn` requires `agent`, `prompt`, `profile` and `reasoning_difficulty`; `agent_run`
requires `agent`, `builds_on` and `prompt`. Both take optional `label` and `dispatch`. `agent_send`
joins/steers the task bound when called; it never starts a continuation.
`agent_answer` takes `agent`, the exact pending `question_id`, and `answer`,
with optional wait_ms. It preserves the asking task's label, dispatch and Agent settings;
run cannot bypass an unanswered question.

- **`prompt`** is the execution instruction.  It may be up to 131072 UTF-16
  units at parent-tool admission, although permission provenance has stricter
  review limits.  It is not a name, a policy profile, or a routing request.
- **`label`** is a short task label (up to 120 UTF-16 units) for roster/UI use,
  stored as the Run's description and defaulting to the instructions' first
  nonblank line.  It is neither injected as a summary nor a
  substitute for the prompt.
- **`agent`** names the Agent.  It does not alter profile, permissions,
  routing, or identity.

The former **core `role` field is removed** and the closed `agent_spawn` schema
rejects it; put instructions in `prompt` and the label in `label`.  This does
**not** change Pi/SDK assistant messages:
`assistant message.role` remains the upstream message field and must not be
renamed or removed.

## Routing and context vocabulary

The parent tool caller picks `profile` and required `reasoning_difficulty`
(integer 1–5, easiest to hardest)
for a new Agent. The fixed mapping is one-to-one, 1 → `d1` through 5 → `d5`;
each preset slot independently selects a model and effort policy, while
difficulty is the immutable Agent setting. Slots may share models. The user chooses the parent model/thinking and active worker
preset and per-slot effort policy. The harness resolves one exact registered
worker model and either a fixed effort or inherited parent thinking (captured
at submission, with identity or the automatic supported-level rule; inheritance
never crosses the off boundary). Session effort
overrides are operator configuration, not model tool arguments. Reuse preserves
all accepted settings and does not accept or re-score difficulty.
Callers may choose only profile/reasoning_difficulty, never a concrete worker model or
thinking level, cwd, owner, generation, session path, or history path.

`inherit_context: true` copies a bounded (64 KiB) **text** snapshot only.  It is
not an SDK history fork and carries neither tools nor routing settings.  It is
prefixed only on the Agent's first Run; reuse retains the original child
conversation without adding it again.

## Alerts, questions, results and presentation

Results are retained Owner-local text with UTF-16/surrogate-safe cursors.
`agent_read` independently reads a recorded question and a result page; cursors
pin the original Run, even after Agent reuse. Each selected terminal result with
unread retained text reserves a fixed-width cursor before optional text packing;
a wholly omitted page keeps its starting offset. Text never retained
(omitted_chars) cannot be recovered; text omitted only by packing can be fetched
on a later page. Keep returned cursors: task ordinals are not historical-read
selectors. See [result cursor identity](tool-contract.md#result-cursors).

`alert_parent` records decision-relevant facts and wakes matching observations
while the child continues, without starting a parent turn or interrupting parent
Bash. One FIFO bounds accepted pending alerts at Owner 64 / Agent 16 across all
Runs, including old/killed sources. Full/closed gates reject new calls, never
evict accepted messages or count rejection as delivery loss. Only complete
scoped FIFO-prefix messages successfully published in local final content leave
the queue. This is not SDK persistence, model receipt, a durable outbox or ACK.
Historical notify/progress/send-answered journals remain read-only display, not
aliases or new pending-state hydration.

`ask_parent` records an immutable first-write question on the original Run and
asks the child to end; later valid asks succeed without replacing/comparing the
body. It does not force suspension or declare settlement. Only truly settled,
healthy pending needs-input questions, unreserved with no current Run, can be
answered. Their q_ + 32-hex token binds Owner/generation/original Run using a
128-bit SHA256 prefix; it is identity, not a permission credential. Explicit
answer reserves a continuation under normal admission/approval checks. Before
inputEntered, failure may reopen the same question on a reusable Agent; after
it, failure cannot. Historical questions remain readable without actionable
tokens. Off forbids new tasks/steering/answers but accepted child work continues.

Spawn/run/send/answer/wait/read share one envelope with reason, complete bound
Agent/task rows, optional action fact, top-level alerts, scoped pending count
and bounded finished reminders. Task conditions bind once; alert scopes are
separate: inline sees its selected Run only, explicit wait/read span the chosen
Agents' Runs, default wait receives all Owner alerts. Default On also selects
healthy pending questions level-triggered, independent of finished presentation;
unanswered questions return again. To defer one, pass `agents` naming other
Agents; this also limits alerts to those Agents. Off excludes already-terminal
questions only at first default binding. Explicit observations still show them
with workers_disabled. All-empty returns nothing_pending immediately, not
vacuous done. Timeout or abort ends observation, not worker execution. UI/list
are count/read-only projections and never consume communication.

The harness does not inject an Agent/Run roster after compaction. `agent_list`
exposes Owner-local state, including killed names, labels, earlier tasks, context,
cost and touched paths, not full assignments or admission authority. Finished
reminders use fixed finished_presented and settled_seq on each original Run;
only explicitly showing that task's terminal row commits its bit. Running rows
with the same Agent name, alerts/list/UI/count do not. Results stay rereadable
and pending questions can reopen without resetting that bit. See
[finished presentation](tool-contract.md#finished-presentation).

See [the tool contract](tool-contract.md) for exact budgets and reply behavior,
and [architecture](architecture.md) for history, accounting, and retention.
