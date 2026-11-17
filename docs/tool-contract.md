# Tool contract

The nine management tools address one live parent session's **Owner**. An **Agent**
keeps a named conversation; its **tasks** are numbered from 1 in admission order.
Task numbers select reads, not commands. Internal IDs aren't model addresses and
history does not restore live state. See [Agent lifecycle](orchestration.md),
[worked calls](agent-tools-quickstart.md) and [dispatch declarations](task-dispatch.md).

## Inputs and availability

All objects are closed. `?` below means optional. Raw parent arguments are
checked before SDK coercion and checked again at execution after hooks. Text
is nonblank and preserved verbatim; lengths, `max_chars`, `lost_chars` and
handoff counts use UTF-16 code units, not code points, graphemes or bytes.

| Tool                            | Arguments                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `agent_spawn`                   | `agent, prompt, label, profile, reasoning_difficulty, return_to?, inherit_context?, dispatch?, after?, wait_ms?, max_turns?` |
| `agent_run`                     | `agent, continues, prompt, label, dispatch?, after?, wait_ms?, max_turns?`                                                   |
| `agent_send`                    | `agent, message, wait_ms?`                                                                                                   |
| `agent_answer`                  | `agent, question_id, answer, wait_ms?`                                                                                       |
| `agent_wait`                    | `agents?, mode?, wait_ms?`                                                                                                   |
| `agent_read`                    | `agent, task?, cursor?, max_chars?`                                                                                          |
| `agent_interrupt`, `agent_kill` | `agent`                                                                                                                      |
| `agent_list`                    | Empty object                                                                                                                 |

Text maxima: `prompt` 131072; `label` 72; `continues` 512; `message`, `answer`
and `return_to.instruction` 16384 each; `cursor` 1024. `label` is a concise,
verbatim title in the task's language, not instructions or background. The
child-facing inputs (`prompt`, `message`, `answer`, `return_to.instruction`)
may not contain Alehouse's reserved human steering lead.

Initial Off exposes none of these tools. After accepted work, Off retains
wait/read/interrupt/kill/list; new work, steering and answers are rejected even
through cached handles. Accepted work may continue to ask or alert. The active
spawn tool contributes the user's [delegation guideline](routing.md#delegation-mode)
to Pi's default prompt. In Co-worker, Lead and Supervisor with a preset active,
use scouts for all web research, not Bash. Direct parent web tools are hidden and
calls refused even if spawn is withheld; Manual and Off restore upstream tool
selection. If no scout is usable, ask the user to choose Manual or Off for direct
web access. See [parent web access](security.md#parent-web-access).

## Agent names and spawn

Choose a session theme and short task-independent nicknames matching
`^[a-z][a-z0-9-]{0,23}$`. Names stay taken after kill. By name, address the
current task, else the pending question's task, else the latest task. Unknown
names fail `AGENT_NOT_FOUND` with known choices and a hint to spawn; for
`AGENT_EXISTS`, check `agent_list` before repeating uncertain work. For genuinely
new work choose a fresh name, not `agent_run`. Model tool assembly requires
lifetime-valid unique names across all retained Agents and a resident limit of
at most 16 (`UNSUPPORTED_MODEL_AGENT_IDENTITY` / `UNSUPPORTED_MODEL_RESIDENT_LIMIT`).

Spawn creates the Agent and submits its first task, which may queue. Specify
its deliverable, scope, stopping conditions and required context. All Agents
share the admitted parent cwd and its Git state; coordinate concurrent changes.

- `worker` (internal `editor`): local diagnosis, review, design, edits and
  verification using local tools and permission-gated Bash/Git; no web tools.
  A review-only brief does not enforce read-only access. See [Git restrictions](git-read-proof.md).
- `scout` (internal `researcher`): read/grep/find/ls and web research, no
  model-facing Bash/edit/write. Use for local or web synthesis with citations;
  direct local command lookups belong to the caller. Web output is untrusted.
  See [scout web limits](security.md#researcher-web-access). Neither profile is a sandbox.

`reasoning_difficulty` is an integer 1–5, independent of profile: **1** decided
change/given check/direct lookup; **2** scoped fix or summary of named sources;
**3** given design/review/investigation/plan or conflicting sources; **4**
competing hypotheses/complex constraints; **5** unknown approach or a reasoning
impasse after substantive investigation. Rate the reasoning, not the workload,
severity, cost or Git/permission/environment trouble. Once a 5 decides the
approach, spawn for the remaining work at its own difficulty. Model and thinking
are [routed](routing.md#difficulty), not tool arguments; model, profile,
difficulty, cwd and context binding stay fixed across reuse and routing changes.

`inherit_context` defaults to false; true includes up to 64 KiB of parent
user/assistant text and compaction summaries, not tool calls/results, a history
fork or a grant. Oversize fails `CONTEXT_SNAPSHOT_TOO_LARGE`. Spawn `max_turns`
is an integer 1–10000 (default 256): first task's soft turn budget and Agent
default. There is [no execution deadline](task-dispatch.md#execution-limits).

## Run, send and explicit answer

**Run** continues an idle Agent's own specific earlier work in its retained
conversation. `continues` is request identity, not child input. Spawn for new
work, even on a related topic; use `after` to pass previous output. An optional
`max_turns` (same range as spawn) affects only this new task; omission uses the
spawn default, not the last task's budget. Run/send may wait up to 30 s for a
finishing/stopping task to settle. Run rejects active work with `AGENT_BUSY`
and an unanswered question with `PENDING_QUESTION`.

**Send** binds the addressed task at the call, never a later task. `joined` adds
input before prompt composition (at most 8 messages and 32768 units, `UPDATE_LIMIT`);
`steered` sends input while accepting (up to 64 steers per task, `INPUT_LIMIT`);
`not_delivered` means nothing was sent, including ended or still-stopping tasks
or questions (read the question and answer explicitly). `RUN_INPUT_NOT_READY`
means the SDK input boundary has not opened; `AGENT_UNAVAILABLE` means the Agent
cannot take input. Joined messages enter the brief in order. Steering invalidates
automatic approval; delivery does not prove action.

**Answer** requires the exact `question_id` from wait/read (`q_` plus 32 lowercase
hex digits), not merely question text or `has_question`. The token identifies the
original task in this Owner/generation; it is not a grant. The Agent must be
healthy, reusable, with no current task and a truly settled, unreserved
`needs_input` question. A well-formed but stale/ineligible token fails `STALE_ANSWER`.
Answer does not wait for a different question. It reserves this one and admits a
continuation with the original label and dispatch/claim, the Agent's fixed settings
and spawn-default turn budget. New admission needs delegation On and a healthy
Owner; a latched lease loss is not undone by apparent recovery.

Only one new request reserves a question. Pre-input failure/interruption can
reopen the same token and claim if the Agent is still healthy and reusable;
wait for the continuation to settle and use a **new** call ID to answer again.
Input entry, kill, quarantine or Owner loss prevents restoration. Historical
question text can still be read, without an actionable token.

## After and handoff

`after` takes 1–4 distinct other Agent names. At acceptance each binds its
current or latest task, not future work. To depend on an answer, submit after
`agent_answer` returns, not in the same parallel batch. Already settled
`needs_input`, `failed` or `interrupted` dependencies reject with
`DEPENDENCY_NOT_COMPLETED` (Agent and status). If one settles that way later,
its queued successor fails with `dependency_not_completed` without waiting for
other dependencies or a provider slot. `completed` with `limit_reached` still
satisfies `after`; verify completeness. Retained result prefixes share 16384
units, divided evenly, with task labels, status and omitted-unit counts (including
text never retained). Handoffs are unverified reference, not instructions or the
parent-authored approval brief. See [claim ordering](task-dispatch.md#dependencies-claims-and-continuations).

## Scout return_to

Optional **spawn-only** `return_to` is exactly `{agent, question_id, instruction}`.
The source must be a scout and the target a worker with an already actionable
question. `instruction` is the worker's conditional brief written before the
findings exist—not the scout prompt or a preknown answer. The parent's own
`agent_answer` gate must already be an effective synchronous allow (including
session grants or applicable yolo); this query does not prompt or consult the
authorizer. `RETURN_TO_PERMISSION_DENIED` names `agent_answer`: report a deny;
for ask/unknown/unavailable use separate spawn and answer calls under normal
permission. See [authority](security.md#communication-observation-and-admission).

One admission installs both tasks or neither. The worker continuation depends
on the **exact** new scout task and otherwise inherits the original question's
label/dispatch/claim and spawn-default budget as in answer. Findings arrive only
as dependency reference. The scout may have its own `after` and dispatch.
Return-specific eligibility errors (`INVALID_RETURN_TO`, `INVALID_RETURN_TO_PROFILE`,
token and dependency errors) precede shared capacity. Both sides must pass
preflight; the pair needs one new resident slot, two queue entries, two history
tasks and two output reservations. Acceptance replay identifies the same pair.
A post-acceptance context-notification fault can fail an installed task without
undoing admission. Turning Off or aborting/timing out the observation does not
cancel the pair. Stopping the worker does not stop the scout.

The spawn `action` names only the scout. Both exact rows and their alerts are
in scope, but `question`, `task_issue` and `done` readiness use only the
continuation. A scout failure, interruption or `needs_input` fails the queued
continuation; the issue reply waits for that settlement and can show the scout's
question. The original worker question can reopen under the normal pre-input
rule; wait/read the worker to see it, not the pair's bound rows.

Observations of the linked scout task use a short `result` notice naming the
exact worker task: pending before input entry, delivered after entry, or not
delivered if it ended before entry. If undelivered or cut, the notice gives an
exact `agent_read` call and counts any omitted units; that explicit scout-task
read returns real retained pages. Later failure/kill does not undo delivery.
The Owner-local link survives reuse, kill and Off, not restart. Internal handoff,
human UI and history keep the real result; labels, alerts and questions remain visible.

The scout is asked to fit the handoff (16384 units here). After input entry, full
delivery releases an idle, healthy scout whose last task was the source, with no
pending question or release already in progress (`result_returned`). If cut,
undelivered, reused, asking or already ending, do not assume release; read if
needed and explicitly kill when appropriate. Unconfirmed cleanup is not release.

## Acceptance, selection and reasons

Within one Owner, tool-call IDs replay accepted facts: spawn/run/answer return
the original task and send the original delivery (last 512 records). Changed
command arguments, including `return_to`, fail `REQUEST_CONFLICT`; observation-only
`wait_ms` is not command identity. Observations run afresh: no re-admission,
new claim, steering or restoration of consumed alerts. Check `agent_list` if
acceptance is uncertain. New commands recheck context, abort, admission and
revision before effects; `DELEGATION_OFF` also rejects crossing a disable/re-enable.

Defaults: 12 resident Agents, 16 queued tasks, 4 active tasks per provider
(shared by its models), 512 retained tasks and 67108864 retained/reserved UTF-16
units of result text, reserving 1048576 units per task at admission. Queued tasks
use no slot and a busy provider does not block another. For `QUEUE_FULL`, wait
for room. `OWNER_HISTORY_LIMIT` has no eviction; ask the user to close the Owner
and start fresh after confirmed closure. `RESIDENT_LIMIT`/`RESOURCE_OWNED`/
`BUILD_DIR_BUSY` blocked **only** by release already underway can wait up to
10 s, then repeat admission. Conflicts are checked before capacity; a later kill
is not anticipated. Timeout or uncertain cleanup returns the rejection.

`wait_ms` is an integer 0–300000. Spawn/run/send/answer default to 0; wait defaults
to 300000. Wait `mode` defaults to `all`; `any` needs one selected task to end.
The timer starts after preparation, acceptance and any lifecycle settle. Prefer
long waits to polling. Esc/abort or timeout does not stop accepted work.

| Entry                                         | Bound tasks                                                               | Alert scope                                           |
| --------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Wait with `agents` (1–16 names, deduplicated) | Addressed tasks at invocation                                             | All tasks of those Agents                             |
| Wait without `agents`                         | Nonterminal tasks; also healthy settled pending questions if initially On | Owner-wide, including killed sources and later alerts |
| Read                                          | Addressed task, explicit ordinal or cursor's original task                | All tasks of that Agent                               |
| Spawn/run/send/answer                         | Accepted task or send's bound task                                        | That exact task                                       |
| Spawn with `return_to`                        | Exact pair; readiness uses only continuation                              | Those exact two tasks                                 |

Binding does not drift with reuse or mode changes. Default wait binds at most
one task per Agent, preferring current work. While Off, explicit wait/read can
still show pending tokens with `delegation_off`; a task already bound can also
ask after switching Off. Unanswered questions repeat independently of finished
reminders. To defer one, explicitly wait for other Agents (also narrows alerts).

Reads and zero-wait commands use `snapshot` (unless aborted), without reporting
a waiting-only Owner fault edge. Every wait, even zero, and positive command waits
use this priority: **aborted → owner_blocked → question → task_issue → done → alert
→ nothing_pending → timeout**. `owner_blocked` reports a new Owner fault edge:
concurrent pre-edge observers may report it, later waits don't repeat a reported
edge. `question` is a selected answerable question; `task_issue` a settled failure,
interruption or reached limit. `done` requires a nonempty terminal selection meeting
all/any, not an empty inbox. `alert` needs a complete scoped alert. No bound task
or scoped alert returns `nothing_pending` immediately. Readiness wins over the
latched timer; otherwise the same waiter keeps its original time budget.

## Unified observation envelope

Spawn/run/send/answer/wait/read return JSON text with `tasks` and `reason` (always,
including `snapshot`/`done`). Optional fields:

- `action: {type, agent, task, delivery?}`: the accepted command fact; `type`
  is the tool name, and only send has `delivery`. Wait/read have no action.
- `delegation_off`: guidance to ask the user to enable delegation; accepted work continues.
- `alerts: [{agent, task, label, message, source?}]`, `finished`: shown alerts and
  completion reminders. `alerts_pending` (scoped) and `finished_pending` (Owner-wide)
  are remaining counts after publication, absent at zero, not loss counters.
- `response_limit_reached: true`: material yielded during packing.

Rows retain `{agent, task, status}` and applicable `has_question`, `limit_reached`,
`unavailable`. Statuses: `queued`, `running`, `interrupting`, `finishing`,
`needs_input`, `completed`, `failed`, `interrupted`. Queued rows reserve
`queued_for: "dependencies" | "provider_capacity"` when applicable. Settled rows
reserve `outcome_reason` when present (distinct from the observation's `reason`
and a tool error's `error.reason`): `turn_limit`, `output_limit`,
`context_change_failed`, `dependency_not_completed`, `dependency_input_missing`,
`dispatch_preflight_failed`, `unexpected_abort`, `execution_error`,
`finalization_failed`, `input_not_observed` or `other` for unknown reasons.
Finishing is not settled. Optional metadata includes whole `label`,
`interrupted_by: "human"` (first accepted explicit Stop, not proof of stop), and
`human_steered: true` (direct user message admitted, not its text or delivery).
Diagnostics are `error`, `owner_error`, `unavailable_reason` and bounded
[`dispatch_notes`](task-dispatch.md#notes-receipts-and-coverage); live usage,
context and elapsed time belong in UI, not routine replies.

### Result cursors

`agent_read` takes either a positive safe integer `task` (page one of that
Agent's retained task) or the opaque `cursor` returned with that Agent; not both.
This works after reuse or kill in the same Owner. Unknown ordinal: `TASK_NOT_FOUND`.
`INVALID_CURSOR` covers malformed, wrong-Agent/Owner/task-version or invalid
UTF-16 offsets; use the exact Agent/cursor pair or restart with `task`. Omitting
both chooses the addressed task, not necessarily the one you were paging.

`max_chars` is 1–16384 (default 16384), for raw pages only; a page can add one
unit to avoid splitting a surrogate pair. Read prioritizes the whole recorded
`question`; a token may accompany it, and `question_truncated` marks packing cuts.
Empty result text omits `result`. `result_truncated` marks an incomplete live
preview (no cursor). Final `next_cursor` alone means more retained text, advancing
by the units shown, or staying at the same offset if packing displaced the
whole page. EOF has no cursor. `lost_chars` counts text never retained, not
packing loss. Cursors are fixed-width 37-character `r1_` locators: a 128-bit
Owner/generation/Run/result-version key and padded base36 offset, not a grant.

### Budget and local publication

Question, result and alert message text share **16384 UTF-16 units**. The complete
`{content:[{type:"text",text:JSON.stringify(reply)}]}` is limited to **65536 UTF-8
bytes** when JSON-encoded (both escaping layers count). Labels (projection cap
120 units), diagnostics, tokens and controls count toward bytes, not text units.
`max_chars` does not raise either limit. All bound control rows, question tokens
and cursors for remaining real terminal text are reserved. `alert` reserves one
complete scoped alert before allocating questions; a full question and a worst-case
alert need not both fit. Further alerts fit as a whole FIFO prefix, never skipping
a larger head. Optional attribution/labels precede result text, then diagnostics
and finished reminders use remaining space. Fixed 512-unit diagnostic clipping
alone is not packing pressure; diagnostics are not pageable. A scout handoff
notice fits whole or yields, with no raw paging flags or cursor. List/interrupt/kill
use the same byte cap and preserve controls while optional fields yield; if required
facts cannot fit (`COMMUNICATION_REPLY_TOO_LARGE`), read one task rather than blindly
repeating a command.

Publication constructs final local content and validates original references
before an all-or-none commit. Only the shown scoped alert prefix is removed.
Aborted, timed-out or rejected observations consume nothing. Validation/packing
failure rejects only that observer, without retry; reentrant effects are rejected
before mutation. Commit proves neither persistence nor receipt/ACK; later tool
result loss does not requeue anything.

### Finished presentation

Every observation considers truly settled, unpresented tasks Owner-wide. Showing
the original terminal row in `tasks` or `finished` marks it presented once; a
same-name running row, alert, UI, list or count never does. The optional `finished`
array shows up to eight additional rows in oldest-settled order, excluding bound
originals. Omitted labels do not defer presentation. Results remain readable;
questions can repeat or reopen without resetting the presentation bit.

## Interrupt, kill and list

Interrupt requests cooperative stop and returns a task row. Already settled,
exited or budget-stopping work keeps its outcome; observe settlement with wait/read.
The Agent remains reusable when healthy (even if its first task never started).
Kill stops and permanently releases the Agent, not its history or name. Its
single 10 s stop/cleanup bound returns `agent_status: "released" | "exiting" |
"cleanup_uncertain"`; only `released` confirms release, while tracked cleanup can
continue after `exiting`. No forced release or rollback. List returns `agents`
in creation order with profile, difficulty and addressed task facts (including
`waiting_for` on dependencies), and `released` with up to the 32 newest-created
released names, plus positive `released_omitted` if cut. None consumes alerts or
finished reminders. Compaction may queue a non-triggering reminder of outstanding
work/communication, without names or consumption.

Parent failures report `{error: {code, ...}}` with bounded context and resolution.
`INVALID_PARAMETERS` names known fields/indexes without echoing unknown names or
user text. Supplied invalid profile/difficulty checks (`INVALID_PROFILE`,
`INVALID_DIFFICULTY`) come first. Routing errors (`PRESET_MODEL_UNAVAILABLE`,
`PARENT_THINKING_UNAVAILABLE`, `THINKING_INCOMPATIBLE`) require configuration, not
re-rating. `STALE_OWNER_CONTEXT` can leave acceptance uncertain. For `OWNER_CLOSED`,
tell the user and start fresh only after confirmed closure; for
`OWNER_CLEANUP_UNCERTAIN`, `OWNER_INTERNAL_ERROR` or `OWNER_PARENT_UNAVAILABLE`,
tell the user without retry or force release. These don't diagnose model availability.

## Child tools

Children have no management tools or nested delegation. Their only communication
calls are `alert_parent({message})` and `ask_parent({question})`, each one nonblank
string of 1–8192 units. Calls revalidate after hooks, and closed Run input fails
`RUN_INPUT_CLOSED`. Known child input/admission errors use bounded wording
(`INVALID_PARAMETERS`, `INVALID_QUESTION`, `INVALID_ALERT`, `RUN_INPUT_CLOSED`,
`ALERT_TOO_LARGE`, `ALERT_QUEUE_FULL`); other errors are not rewritten.

Alert queues a decision-relevant fact, not routine progress. It wakes matching
observations, not the parent model or parent Bash. Duplicates can be distinct.
One FIFO includes old/killed sources; only publication frees their quota.
Child alerts allow 64 per Owner / 16 per Agent across tasks; independent
[runtime feedback](runtime-feedback.md) allows 16 per Owner / one per Agent
(`source: "managed"`), 80 total. Quota separation is not priority. `ALERT_QUEUE_FULL`
checks Owner then Agent, reports scope/limit and evicts nothing: don't loop-retry;
keep the fact in the result, or ask and end if a decision is essential. Alert
size checks the retained envelope, not just its body (`ALERT_TOO_LARGE`: shorten
substantially and retry once, or keep it in the result).

`ask_parent` records only the first question per task. Later valid asks leave
that question unchanged. In either case the ask receipt tells the child to end
its turn without calling more tools or repeating the question in its final reply.
An `alert_parent` receipt instead tells it to continue working. Neither receipt
settles the task. The parent can answer only after the task reaches a healthy
`needs_input` state.
