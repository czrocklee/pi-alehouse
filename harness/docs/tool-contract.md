# Tool contract

This defines the parent/child communication contract. Packages, generated
resources and managed definitions/policy must match; see
[matched resource migration](development.md#matched-resource-migration).

The trusted host registers exactly **nine** parent management tools for one
Owner. There is no discovery, Owner registry, runtime alias or child copy.
Schemas are closed (`additionalProperties: false`); validation precedes SDK
preparation and repeats at execution because hooks can mutate arguments.
Captured Owner/context/generation identity is checked at entry and before
publication. Initial `off` hides all nine; after accepted work it retains only
`agent_wait`, `agent_read`, `agent_interrupt`, `agent_kill` and `agent_list`.
New tasks, steering and answers remain admission/revision-gated, even through
cached tool handles. Accepted child work may continue to alert or ask while Off.

The model addresses an **Agent** by name, not an internal Run UUID. A **task**
is a Run's 1-based rank among that Agent's Runs ordered by enqueue sequence,
derived for presentation. It is not a new execution-target parameter. Labels
are auxiliary (at most 120 UTF-16 units), never a substitute for task identity.
Routing, models, Owner IDs, generation and SDK session IDs stay internal.

| Tool | Intent |
| --- | --- |
| `agent_spawn` | Create a named Agent and give it its first task. |
| `agent_run` | Give an idle Agent a new task; cannot bypass an unanswered question. |
| `agent_send` | Join/steer the task bound at the call; never create a continuation. |
| `agent_answer` | Answer one explicit pending question and create a continuation Run. |
| `agent_wait` | Wait for bound tasks, a question, a task issue or scoped alerts. |
| `agent_read` | Snapshot a task page plus that Agent's cross-Run pending alerts. |
| `agent_interrupt` | Request a stop; not execution-exit evidence. |
| `agent_kill` | Permanently end an Agent. |
| `agent_list` | Read the roster without consuming communication. |

Retired management names (`delegate`, `wait_agents`, `read_result`,
`message_agents`, `cancel_task`, `release_agent`, `list_agents`, `spawn_agent`,
`resume_agent`, `read_run`, `wait_runs`, `steer_run`, `post_update`, `cancel_run`)
stay denied/excluded, without aliases. `notify_parent` is also retired and
explicitly denied, not registered as an alias of `alert_parent`. Historical
journals may still display it. Profile IDs, `harness:*` records, config paths,
lifecycle events and `Symbol.for` keys remain compatibility surface, including
internal `cancelling`/`cancelled` statuses.

`agent_spawn` carries the one policy no schema expresses: the user's
[delegation mode](routing.md#delegation-mode), as a Pi `promptGuidelines` bullet.
Manual has its own line; other modes combine one division-of-work sentence and
one eagerness sentence (`harness/src/delegation.ts`). The default,
Co-worker × balanced, reads:

> Work alongside Agents: you and they each take parts of the task. Hand off
> independent pieces that would take you longer to do than to explain.

Pi renders it only while `agent_spawn` is active, rebuilding the loadout every
turn. Off, children and ordinary Pi receive no such text. Changing the mode
re-registers this tool (one prompt-cache miss). Other semantics belong in tool
and parameter descriptions, not another orchestration briefing.

## Agent names and spawn

Names match `^[a-z][a-z0-9-]{0,23}$`: short task-independent nicknames, one theme
per session (`orca`, `otter`), not task labels. A name stays taken after kill.
Addressing selects current task, else the still-pending question's task, else
latest task; a read cursor instead pins its original result Run. Unknown names
fail `AGENT_NOT_FOUND` with `parameter`, known names in `allowed`, and a pointer
to spawn. Spawning a known name fails `AGENT_EXISTS` and points to run.

Tool assembly explicitly binds this naming contract for the Owner's lifetime,
including Off. It checks all retained Agents, including released history, before
exposing tools; incompatible existing state fails
`UNSUPPORTED_MODEL_AGENT_IDENTITY` without consuming or renaming anything.
Final core admission then also rejects incompatible direct/queued submissions,
while accepted-request replay remains intact. This is an adapter opt-in, not a
restriction on optional/repeated display names in an unbound generic core Owner.

Spawn requires `agent`, `prompt` (1--131072 UTF-16 units), `profile`
(`reader`, `editor`, `researcher`) and integer `difficulty` (1--5). Optional
fields are `label` (1--120), `inherit_context`, `after` (1--4 other names),
`wait_ms` (0--300000), `max_turns` (1--10000, default 256) and
`max_duration_ms` (1--86400000, default 1800000).

Profile, difficulty, context and budgets are fixed for the Agent at spawn;
later tasks cannot silently change them. Prompt is the full task instruction;
label defaults to its first nonblank line and is never forwarded as an
instruction. Reader denies direct/detectable writes; editor edits within
parent-configured scope; researcher has read-only file tools and web, no Bash,
and returns web-derived untrusted material. Git mutations stay with the parent.
Bash/web remain permission-gated; no profile is an OS sandbox.

Difficulty describes reasoning and quality, not permissions: 1--2 resolve to
`light`, 3 to `standard`, 4--5 to `strong`. Model-facing descriptions give the
five anchors, not this routing detail. Model/thinking/preset/effort and retired
`role`, `strength`, `name`, `description` are not schema inputs. Trusted routing
captures parent thinking before queued admission; neither later tasks nor
spawning change the main model/thinking. Resolution errors are configuration
problems, not reasons to change difficulty. Fixed effort need not inherit
parent thinking; inherited effort requires it. See [routing](routing.md).

`inherit_context` is at most 64 KiB of model-visible text (user/assistant text
and compaction summaries, no tool calls/results), not a history fork or a
permission grant. Oversize fails `CONTEXT_SNAPSHOT_TOO_LARGE` before creation.

## Run, send and explicit answer

`agent_run({agent, prompt, label?, after?, wait_ms?})` admits a new task only
when idle. Finishing/stopping is waited out for at most 30 s outside the submit
queue. Running fails `AGENT_BUSY`; a pending question fails `PENDING_QUESTION`
and points to explicit answer. Run never delivers into an existing task.

`agent_send({agent, message, wait_ms?})` takes 1--16384 nonblank units and binds
its target at the call, never redirecting to a task admitted later. Its action's
`delivery` is `joined` before prompt composition, `steered` while accepting
input, or `not_delivered` once ended/still stopping after bounded lifecycle
settle. **There is no `answered` branch.** A needs-input target returns its
question; when On, use `agent_answer`; when Off, ask the user to enable
delegation rather than calling the hidden tool. Settling send's target does not
consume alerts. An SDK input boundary not yet streaming fails
`RUN_INPUT_NOT_READY`; unavailable Agents fail `AGENT_UNAVAILABLE`.

Joined messages remain memory-only, at most eight/32768 units per Agent
(`UPDATE_LIMIT`), numbered before the prompt; `delivered_updates` counts them
and unstarted tasks record discarded inputs. They join the approval witness's
parent-authored task prompt. Steering invalidates automatic approval.
Delivery is not proof of action.

```ts
agent_answer({ agent, question_id, answer, wait_ms? })
```

Answer is 1--16384 nonblank UTF-16 units. No profile, difficulty, budgets, label
or after is accepted. The original task must already be truly settled
`needs_input`, still pending and unreserved, with no current Run and a healthy,
reusable Agent/Owner. Answer does not wait and then silently answer a future
question. It reserves the original question and admits a continuation with the
Agent's fixed settings/budgets and the asking task's label. New admission still
requires On, unchanged revision/context/generation and normal approval witness;
child output grants no authority. New answers check and latch real Owner lease
loss before eligibility and after preparation; apparent recovery does not clear
that latch. Accepted-request replay still returns the original fact.

Question identity is derived, without a lookup table or permission credential:

```text
q_ + lowercase_hex(first 16 bytes of SHA256(UTF8(JSON.stringify([
  "pi-alehouse/question/v1", owner_id, generation, original_run_id
]))))
```

The schema is `^q_[0-9a-f]{32}$` (34 characters, 128-bit digest). Display and
validation share this function. It rejects stale/cross-generation references
rather than relying on Agent/task names a new Owner could reuse; the negligible
collision risk is accepted, not claimed impossible. Pending identity is retained
while Off and explicit observations can still show its token with
`workers_disabled: true`; Off independently forbids admission.

Same request ID/arguments replay the accepted continuation; different arguments
fail `REQUEST_CONFLICT`. Different requests competing for one reference reserve
only once, never becoming steering. Before `inputEntered`, cancellation/failure
can release the reservation if the Agent remains reusable, reopening the same
token. The old request still replays its old continuation; a new request ID is
needed to answer again. After input entry, failure does not reopen the original
question. Kill, quarantine and Owner loss never restore answerability. Historical
questions remain readable but consumed/reserved/unavailable ones have no
actionable token. A finalizing continuation cannot expose the original token
early, even after reservation release.

## After and handoff

`after` binds dependencies to other Agents' tasks at acceptance. Queued tasks
hold no execution slot and their duration budget has not started; `waiting_for`
names unsettled dependencies. They still count toward queue capacity. Any
dependency not completing (including needs-input) fails the task with
`dependency_not_completed` without creating a session; the Agent remains.

Retained final output of dependencies shares a 16384-unit handoff budget, with
Agent/label/status and never-retained character count. It is framed as reference,
not instructions, and is not parent-authored approval witness text. It is not
verified. This permits queuing an author/reviewer without re-pasting results.

## Acceptance, selection and reasons

Request IDs replay **acceptance/delivery facts**, not cached observation results.
Spawn/run/answer reuse their original Run; send reuses original delivery within
its bounded 512-record window. Replays cannot restore already-published alerts.
Different arguments fail `REQUEST_CONFLICT`. New commands recheck context,
abort, admission and revision after preparation/settle and before effects.
`WORKERS_DISABLED` rejects new spawn/run/send/answer and submissions crossing a
disable/re-enable boundary without allocating failed work or poisoning Owner
health. Other errors include `QUEUE_FULL`, `RESIDENT_LIMIT`,
`OWNER_HISTORY_LIMIT`, `AGENT_UNAVAILABLE`, `STALE_OWNER_CONTEXT` and
`OWNER_CLEANUP_UNCERTAIN`.

Duration begins at slot assignment/initialization, not queue admission. Optional
observation time starts at registration **after** command acceptance/preparation
and any lifecycle settle. All wait_ms are 0--300000; commands default to zero,
wait defaults to 300000. Esc/abort cancels the observation, not accepted work.
Core-only lifecycle waits have independent semantics: finite 0--2147483647 ms,
fractions allowed, and no timer when omitted. Kill validates its duration before
any lifecycle effect; none of this widens model tool parameters.

Tasks bind once at invocation; preset changes do not rebind an existing wait.
Task condition selection and typed alert scope (`Owner / Agents / Run`) are
separate:

| Entry | Bound tasks | Alert scope |
| --- | --- | --- |
| Explicit wait, at most 16 names | Each addressed task at invocation | All Runs of those Agents, including old tasks |
| Default wait | Nonterminal tasks; when initially On, also healthy/reusable settled pending questions | Owner-wide, including historical/killed sources and newly arriving alerts |
| Read without/with cursor | Addressed task / original cursor Run | All Runs of the named Agent |
| Spawn/run/send/answer, zero or positive wait | Accepted/delivered fact's one Run | That Run only; no global drain |
| List/UI/interrupt/kill | Independent roster/lifecycle replies | No consumption |

Default selection contributes at most one task per Agent (current before
pending question). Off excludes already-terminal questions only at initial
default binding; explicit wait/read still inspect them. On questions are
level-triggered regardless of finished presentation. A selected running task
that later asks still returns its question after switching Off, with the disabled
flag. Off→On does not silently add excluded questions to an old wait.
Unanswered questions return again. To defer one, call `agent_wait` with `agents`
naming other Agents; this also narrows alerts to those Agents' tasks. No default
tasks and no scoped alerts returns `nothing_pending` before arming a timer, never
`done` via an empty set. A historical alert alone can trigger a default wait.

Commands with zero/omitted wait and read use **snapshot** policy: reason is
`snapshot` after context/abort checks; they do not consume waiting-only Owner
fault edges. Wait (even wait_ms=0) and positive command waits use this priority:

1. `aborted`: latched abort, no alert/finished consumption.
2. `owner_blocked`: a new Owner fault edge.
3. `question`: selected truly answerable pending question.
4. `task_issue`: settled failed/interrupted or limit-reached task.
5. `done`: nonempty bound set meets all/any terminal condition.
6. `alert`: pending alert in scope, with at least one complete message.
7. `nothing_pending`: no bound task and no scoped alert, immediately.
8. `timeout`: unique timer's deadline latch; no alert/finished consumption.
9. Otherwise keep the same waiter and timer.

Reason is the primary trigger, not task status, and done does not mean the inbox
is empty. Faults broadcast to observers already registered before the edge;
successful reporting commits its marker. One reporter does not disqualify its
concurrent peers, while later waits do not repeat a reported edge. Readiness
wins over timeout; Node timer granularity is not a strict absolute-time promise.

## Unified observation envelope

Spawn/run/send/answer/wait/read share one projection/publication path:

```ts
{
  action?: { type, agent, task, delivery? },
  reason,
  workers_disabled?: true,
  agents: TaskEntry[],
  alerts?: { agent, task, label, message }[],
  alerts_pending: number,
  pending?: string[],
  finished?: FinishedEntry[],
  finished_pending?: number,
  response_limit_reached?: true
}
```

Action is an accepted command fact: type is agent_spawn/run/answer for its new
Run, or agent_send with joined/steered/not_delivered on the bound target. Wait
and read have no action. `workers_disabled` says new work/answers are forbidden,
not that observation is forbidden or that the Owner is faulty; enable delegation
to answer. Pending counts describe this scope **after commit**, never lost
messages. Alerts are top-level and never part of a result page.

Each task row retains `{agent, task, status}` and applicable boolean
`has_question`, `limit_reached`, `unavailable`; diagnostics use
`unavailable_reason`, `error`, `owner_error`. Statuses include queued, running,
finishing, needs_input, completed, failed, interrupting and interrupted.
Question fields are `question_id`, `question`, `question_truncated`; historical
text need not have a token. Results use `result`, `next_cursor`, `result_omitted`,
`result_truncated` and `omitted_chars`. Truncation/omission control flags are
never silently removed by compact fallback. Omitted_chars means text never
retained, not packing loss. Live previews shortened by packing explicitly mark
result_truncated. Terminal cursors point to the actual displayed page end.
Every bound terminal window with remaining retained text reserves a cursor before
body packing, including wholly omitted pages (unchanged offset). Thus reuse of
that Agent during a bound wait cannot make the omitted original result
unaddressable. Keep returned cursors; Agent/task ordinals are not read selectors.

`agent_read` requests a result page (default/maximum max_chars 16384); a cursor
pins its original task even after reuse and fails `INVALID_CURSOR` on another
Agent. A page may exceed its request by one unit to avoid a split surrogate.
Read prioritizes the entire recorded question; alerts may stay pending when
that full question needs space. A task-3 read may present a task-2 alert of the
same Agent, but inline action.task=3 never receives task-2 alerts.

The model adapter requires effective resident capacity ≤16 at tool assembly
(`UNSUPPORTED_MODEL_RESIDENT_LIMIT` otherwise). Production uses eight. Core
can still support larger configurations. All bound control rows/pending names
are shown; there are no agents_omitted or pending_omitted fields.

### Result cursors

Treat model result cursors as opaque. Their internal form is `r1_<key>.<offset>`:
key is the canonical 22-character base64url encoding of the first 16 SHA256 bytes
of UTF-8 `JSON.stringify(["pi-alehouse/result-cursor/v1", owner, generation, run, version])`.
Offset is a safe nonnegative UTF-16 position in base36, padded to exactly 11
characters. The total width is always **37 ASCII characters**, so advancing a
page cannot grow its reserved metadata.

Lookup scans original retained settled Runs, requires a unique match and the
named Agent, and validates offset range and surrogate boundaries. No cursor
registry/cache or historical task selector is added. This is a locator, not
permission authority or a mathematically collision-free identity; the 128-bit
digest's negligible collision risk is accepted. Legacy core cursors remain
accepted, and core `getResult` still emits its legacy format. Syntax, identity,
range and surrogate-boundary errors all include recovery guidance: reuse the
Agent and cursor returned together. A cursorless read selects the current,
pending-question or latest task, not necessarily the old task a bad cursor was
intended to retrieve. Failed cursor validation commits no communication.

### Budget and local publication

Question, alert.message and result share 16384 UTF-16 units; label/token/control
and diagnostics are outside that text budget but inside the final **65536-byte**
double-JSON UTF-8 content envelope. Max_chars does not override this byte cap.
The conservative reservation proof includes 16 maximal task rows/pending names,
maximum safe-integer ordinals/counts, action/disabled/response-limit fields,
all six task flags, 16 recovery cursors, 16 question IDs, 16 empty question fields, a 120-NUL label
and a full 8192-NUL or lone-surrogate alert: **65045 bytes**, leaving **491 bytes**.
Metadata does not spend the 16384-unit body budget. This bound depends on the
exact fields, string/numeric bounds and array limits, not arbitrary JSON shapes.
Result text yields before its reserved cursor; wholly omitted pages keep their
original offset, partial pages advance by shown units, and EOF needs no cursor.
Packing retains thin controls and, for reason=alert, a complete first scoped
FIFO alert. Then it adds questions (marked if truncated), further complete FIFO
prefix alerts, result pages, bounded diagnostics and up to eight finished rows.
It stops at the first alert that cannot fit, never skips to a smaller later one.
Unshown alerts remain pending; fat diagnostics/finished entries yield first.
Each diagnostic has a fixed 512-unit display cap. That cap alone does not set
response_limit_reached; actual packing pressure does. Diagnostics are not
paginated, so repeated reads cannot retrieve text beyond this display cap.
A full 8192-unit question plus full worst-case alert cannot always fit together.

All model/lifecycle observations share one non-reentrant core drain. Readiness
is core-only until a reply is ready; entry/default admission reads and return
validation/publication use transient read-only phase guards. Supported effecting
entrypoints reject validator/publisher reentrancy **before** mutation or async
enqueue (`OBSERVATION_REENTRANCY`), even when a getter swallows the nested error.
Only real abort/timer listeners may latch signals and defer the same drain.
An observer error rejects/cleans that observer without consuming anything,
faulting the Owner, rejecting an accepted child alert or stalling finalization.

Snapshots become plain data; projection, byte checks and final ToolResult
construction are synchronous, without SDK/UI callbacks after snapshot. All
alert-prefix/finished/fault references validate before a callback-free all-or-none
commit. The successful tool wrapper only returns that final result. No context
recheck, body rewrite, serialization or legacy withChanges follows commit.
The separate SDK tool_result usage hook may append usage, never change the body.

Publication guarantees **local content construction before consumption**, not
SDK persistence, later-hook fidelity, model receipt, user ACK or crash recovery.
Lost SDK results do not requeue alerts. There is no automatic parent turn or
interruption of parent Bash. See [limitations](limitations.md).

### Finished presentation

Each original Run retains finished_presented=false and receives an Owner-local
monotonic settled_seq only on true settlement. Unpresented settled Runs are
considered oldest first; at most eight convenience rows fit. No secondary
finished log/cursor/unshown queue is maintained. `finished_pending` is the
remaining unpresented count, not historical loss.

Only a successful publication explicitly showing that **original task** with
its terminal status in agents or finished sets its bit. Private original-Run
references establish row identity; equal names, per-Agent task ordinals and
statuses never prove that two rows represent the same Run. Bound rows use
explicit original-Run links; convenience rows are the oldest-first prefix after
excluding those bound originals. A current running row,
Agent name in pending, an alert source, list/killed names, UI or count does not.
Result/history stay rereadable; questions remain level-triggered and can reopen
without resetting the bit. Interrupt/kill/list have independent replies and
consume neither alerts nor finished reminders.

## Interrupt, kill and list

Interrupt requests stop; wait for settlement, not just an interrupting status.
The Agent keeps its conversation for a later run. Even a first task stopped or
failed before session creation leaves an Agent whose next task can create it.

Kill is permanent: idle releases immediately, busy interrupts then releases
after settlement. A single 10 s deadline covers stopping/cleanup. Beyond it,
status is exiting while tracked cleanup continues; cleanup_uncertain retains
reservations, with no force-release/retry/eviction. Name/results remain retained;
cleanup diagnostics do not rewrite historical outcomes. Lifecycle waits share
the drain but have no model validator/publisher or presentation commit. Shutdown
still waits for actual execution/cleanup promises, not an empty observer set.

List is a read-only roster with profile/difficulty, label/task projection,
current pending-question identity via has_question, and elapsed_s when running.
Unavailable is a boolean availability fact with unavailable_reason diagnostics.
History observations include tasks count, four newest earlier_labels,
context_pct, cumulative cost_usd/cost_partial, eight successful-edit/write
`touched` paths plus touched_omitted, and idle_s. Bash changes are not touched
paths. Killed names include newest 32 plus killed_omitted. Questions are read
through wait/read, answered only through answer; roster facts grant no admission.

## Child tools

Children receive their profile's fixed local tools plus exactly:

```ts
alert_parent({ message: string })
ask_parent({ question: string })
```

Both closed schemas require 1--8192 nonblank UTF-16 units and revalidate after
SDK hooks against current Run/generation, accepting gate and stop/exit state.
Closed callbacks fail explicitly (`RUN_INPUT_CLOSED`), never report acceptance.
All nine management tools and retired names are excluded/denied in children.
Only researcher receives web tools, with its own instance; declared reader/editor
web capability is excluded by the effective harness allowlist. See
[security](security.md).

Alert is for decision-relevant facts, not routine progress. Successful acceptance
says it was queued and the child may continue, not that the parent read it. It
wakes matching observations without starting a parent model turn. Duplicate
valid calls may create distinct events; no call-ID alert deduplication cache.

One Owner FIFO holds at most 64 pending alerts and at most 16 per source Agent,
across all its Runs. Capacity is derived from that FIFO; old/killed sources still
occupy quota, and run/answer/reuse/kill do not release it. Only publication does.
Owner quota is checked first, then Agent; ALERT_QUEUE_FULL specifies scope/limit,
rejects without shifting old messages and says: do not loop-retry; retain the
information in the final result and continue possible work; if a parent decision
is essential, ask_parent and end. The child SDK-visible error text includes the code, scope, limit and this
recovery advice—not just inaccessible exception details. Shared SDK-free byte
admission checks the retained envelope shape before enqueue (ALERT_TOO_LARGE on failure), not message
JSON alone. Rejected calls are not accepted-message loss; there is no drop counter.

Ask is immutable **first-write-wins on the original Run**: first valid call
records the question; later valid calls succeed with already_recorded, explicitly
saying it was not replaced and the child must end. No body comparison. Invalid
input/closed gates still fail, with no truncation. Ask itself neither declares
settlement nor forces suspension; only normal true needs-input settlement may
make it answerable. Cancelled/failed/timeout questions remain historical text,
not actionable question tokens.

Old notify/progress/send-answered journals are display-only compatibility:
no rewriting, alias or hydration into new pending state. Matched package,
policy/definitions and a fresh Pi process are required; see
[matched resource migration](development.md#matched-resource-migration).
