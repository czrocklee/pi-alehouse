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

Every Agent has a caller-chosen **name** (`^[a-z][a-z0-9-]{0,23}$`), unique per
Owner and never reused after release.  The name is the only model-facing
address; `agent_id` is the internal control identity.

## Run

A **Run** is one queued or executing task on an Agent; parent tools call it a
*task* and never expose its ID.  It has its own internal `run_id`, request identity/digest, prompt boundary, deadline, turn budget,
outcome, result reference, telemetry, and optional SDK-history links.  A reused
Agent receives a new Run; it never changes the Agent's admitted routing or
permission configuration.

The public lifecycle states are `queued`, `running`, `cancelling`, `completed`,
`needs_input`, `failed`, and `cancelled`; phases further distinguish
`initializing`, `executing`, `finalizing`, and `settled`.  Terminal status is not
necessarily a complete answer:

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

`agent_spawn` requires `agent`, `prompt`, `profile` and `difficulty`; `agent_run`
requires `agent` and `prompt`. Both take an optional `label`. `agent_send`
carries only a `message` for the current task.

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

The parent tool caller picks `profile` and required `difficulty` (integer 1–5)
for a new Agent. The fixed mapping is 1–2 → `light`, 3 → `standard`, and 4–5 →
`strong`; these remain preset routing slots, while difficulty is the immutable
Agent setting. The user chooses the parent model/thinking and active worker
preset and per-slot effort policy. The harness resolves one exact registered
worker model and either a fixed effort or inherited parent thinking (captured
at submission, with identity or an explicit compatibility map). Session effort
overrides are operator configuration, not model tool arguments. Reuse preserves
all accepted settings and does not accept or re-score difficulty.
Callers may choose only profile/difficulty, never a concrete worker model or
thinking level, cwd, owner, generation, session path, or history path.

`inherit_context: true` copies a bounded (64 KiB) **text** snapshot only.  It is
not an SDK history fork and carries neither tools nor routing settings.  It is
prefixed only on the Agent's first Run; reuse retains the original child
conversation without adding it again.

## Results, progress, and questions

Results are retained owner-local text with UTF-16/surrogate-safe cursors.  The
full recorded question and last output are independently readable through
`agent_read`; an omitted result tail is not recoverable.  Progress from
`notify_parent` is bounded, coalesced, at-most-once on an appropriate wait
return, and never a reliable delivery/ack protocol.  `ask_parent` records a
bounded question and asks the child to finish; it does not force immediate
termination, make the parent turn, wake a wait, or bypass a permission dialog.

Neither ordinary progress nor background completion starts a parent turn. The
harness does not automatically inject an Agent/Run roster after compaction.
`agent_list` exposes owner-local state on demand, including killed names;
its bounded labels are not full task assignments. Its rows add each Agent's
earlier task labels, last observed context use, observed cost and touched files,
so the parent can choose between reuse and a fresh Agent. Other harness replies
name Agents whose tasks finished since they were last shown (`finished`); see
the [tool contract](tool-contract.md#finished-tasks).

See [the tool contract](tool-contract.md) for exact budgets and reply behavior,
and [architecture](architecture.md) for history, accounting, and retention.
