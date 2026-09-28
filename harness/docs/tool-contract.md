# Tool contract

The trusted host explicitly registers exactly eight parent management tools for
one Owner.  There is no discovery, owner registry, legacy alias, or child copy.
Every schema is closed (`additionalProperties: false`) and is validated before
SDK preparation and again at execution because Pi hooks can mutate arguments.
The host validates its captured Owner context both before and after work.
Registration is distinct from model visibility: the `off` preset hides all eight
tools before any work is accepted, or retains only inspection/cleanup tools
(`agent_wait`, `agent_read`, `agent_interrupt`, `agent_kill`, `agent_list`)
once this Owner has accepted tasks (including completed/killed results).

The model-facing vocabulary is an **Agent**, a named worker with its own
conversation, that does one **task** at a time, driven with process-style verbs.
Agents are addressed only by name. Run and Agent IDs, routing, presets, models
and effort stay internal; no schema or reply exposes them.

| Tool | Addresses | Contract |
| --- | --- | --- |
| `agent_spawn` | new `agent` | Create a named Agent and give it its first task. |
| `agent_run` | existing idle `agent` | Give the Agent its next task. |
| `agent_send` | existing `agent` | Add a message to the task current when called; never starts other work. |
| `agent_wait` | optional 1--16 `agents` | Wait for `all` (default) or `any` task condition. |
| `agent_read` | `agent` | Read the latest task's whole question and a page of its output. |
| `agent_interrupt` | `agent` | Stop the current task; the Agent stays. Not exit evidence. |
| `agent_kill` | `agent` | End the Agent permanently, interrupting a busy one first. |
| `agent_list` | none | Every resident Agent with its current or latest task and history. |

Earlier names (`delegate`, `wait_agents`, `read_result`, `message_agents`,
`cancel_task`, `release_agent`, `list_agents`, and the older `spawn_agent`,
`resume_agent`, `read_run`, `wait_runs`, `steer_run`, `post_update`, `cancel_run`)
are retired without aliases; they stay only in deny/exclusion lists. Error
codes, profile IDs, `harness:*` records and lifecycle events are unchanged
compatibility surface, including the internal `cancelled` Run status.

`agent_spawn` also carries the one policy no schema can express, as a Pi
`promptGuidelines` bullet in the parent system prompt: the user's
[delegation mode](routing.md#delegation-mode). Manual has its own line; every
other mode is one division-of-work sentence followed by one eagerness sentence
(`harness/src/delegation.ts`). The default, Co-worker × balanced, reads:

> Work alongside Agents: you and they each take parts of the task. Hand off
> independent pieces that would take you longer to do than to explain.

Pi renders it only while `agent_spawn` is active and rebuilds the prompt with
the tool loadout every turn, so it appears and disappears in the same request
as the tools: `off` has no text either way, and children (which never have
`agent_spawn`) and Pi without the harness never see it. Each line is static;
changing the mode re-registers `agent_spawn` with the new line, which costs one
prompt-cache miss and nothing else. Everything else a delegating model needs
stays in tool and parameter descriptions; do not grow these lines into a
briefing or repeat tool semantics in them.

## Agent names

An Agent name matches `^[a-z][a-z0-9-]{0,23}$`: a short, task-independent
nickname, one theme per session (`orca`, `otter`), not a task name such as
`orca-windows-foundations`. Task details belong in `label`. A name is unique per
Owner and stays taken after `agent_kill`, so a name always means the same Agent
and its history. A name addresses the Agent's current task, else its task whose
question is still unanswered (an answer interrupted before it started reopens
the question), else its latest task; `agent_read`, `agent_wait`,
`agent_interrupt`, `agent_list` and `agent_send` all use that task. `agent_spawn` with a known name fails `AGENT_EXISTS` and points
to `agent_run`; any other tool with an unknown name fails `AGENT_NOT_FOUND`
with `parameter` (`agent`, `after` or `agents`), the known names in `allowed`,
and a pointer to `agent_spawn`.

## Spawn

`agent_spawn` accepts `agent`, `prompt` (1--131072 UTF-16 units), `profile`
(`reader`, `editor` or `researcher`) and `difficulty` (integer `1`–`5`), all required, plus
optional `label` (1--120), `inherit_context`, `after` (1--4 other Agent names),
`wait_ms` (0--300000), and the per-task budgets `max_turns` (1--10000, default
256) and `max_duration_ms` (1--86400000, default 1800000).

Profile, difficulty, context and budgets belong to the Agent: they are fixed at
spawn and every later task of that Agent uses them. `agent_run` accepts none
of them, so one call never silently means "create" to the model and "reuse" to
the harness.

- `prompt` is the complete instruction for the first task. `label` is its task
  label in the panel and `agent_list`, defaulting to the first nonblank line of
  the instructions. Labels are never forwarded as instructions.
- `reader` investigates/reviews without direct edit/write tools or detectable
  project writes; `editor` performs authorized file edits; `researcher` searches
  and fetches the web with read-only file tools and no Bash, and the description
  tells the parent its results are web-derived and untrusted. Git mutations stay
  with the parent in all three. Bash and web calls remain permission-gated; no
  profile is an OS sandbox.
- `difficulty` describes the reasoning needed for this prompt's concrete task
  and requested quality, independently of permissions. It maps 1–2 to the
  preset's `light` slot, 3 to `standard`, and 4–5 to `strong`; see
  [difficulty](routing.md#difficulty). The parameter description gives the model
  the five scoring anchors, not this internal difficulty-to-slot mapping.
- `inherit_context` puts a text copy of the parent conversation (user and
  assistant text and compaction summaries; no tool calls or results) before the
  first task. Over 64 KiB fails `CONTEXT_SNAPSHOT_TOO_LARGE`. It is not a
  history fork.

Model, thinking, preset and effort are not parameters; the closed schema rejects
them, as it rejects the retired `role`, `strength`, `name` and `description`.
Parent thinking is captured before queued admission. The active trusted preset
maps difficulty to its slot and resolves exact child model/thinking; neither
spawning nor later tasks change the main model or main thinking. See
[routing](routing.md). Configuration/resolution errors may report `difficulty`
and `parent_thinking`; they are configuration problems for the user to fix in
the worker preset, effort policy, or inherited parent thinking, not a reason to
change difficulty. Fixed effort can resolve without parent thinking; `inherit`
still requires it. Only the user UI/configuration changes effort policy, never
already admitted Agent settings.

## Run and send

Each of these has one intent, so its effect never depends on timing.

`agent_run` gives an existing, idle Agent its next task: `agent`, `prompt`
(1--131072 units), and optional `label`, `after` and `wait_ms`. A task that is
finishing or stopping is waited out first (up to 30 s, outside the Owner's
submit queue). A running Agent fails `AGENT_BUSY` and an Agent with an
unanswered question fails `PENDING_QUESTION`; both errors name the tool to use
instead. It is never delivered into a running task.

`agent_send` adds a message (1--16384 units) to the Agent's addressed task (see
[Agent names](#agent-names)) **as of the call**. That target is bound at the call; it never
moves to a task started later, for example by an `agent_run` that got the Agent
first while this call waited. The reply's `delivery` is:

| Target task | Effect | `delivery` |
| --- | --- | --- |
| Queued or initializing (prompt not yet composed) | Placed before its prompt. | `joined` |
| Running and accepting input | Steered into it. | `steered` |
| Ended with an unanswered question (`needs_input`) | The answer starts a new Run on the same conversation, with the asking task's label and the Agent's budgets; the asking task stays settled. | `answered` |
| Ended any other way, or still stopping after the settle wait | Nothing is sent; the reply carries that task's outcome and result, as a wait entry would. | `not_delivered` |

A finishing or stopping target is waited out first (up to 30 s, outside the
submit queue), so a `not_delivered` reply carries its final result. A task whose
prompt was sent but whose SDK is not yet streaming fails `RUN_INPUT_NOT_READY`:
an explicit, side-effect-free failure to retry, never a redirect.
A killed, exiting, quarantined, or failed-to-initialize Agent fails
`AGENT_UNAVAILABLE`. Joined messages are memory-only, at most eight and 32768
units per Agent (`UPDATE_LIMIT`), placed before the prompt as the parent's
numbered messages; the Run view counts `delivered_updates`, and joined messages
of a task that never starts are recorded as its discarded inputs. Joined
messages are part of the approval witness's `task_prompt`; a steered message
invalidates its task's automatic approval. Delivery is not proof of action.

## After and handoff

`after` names other Agents whose current or latest task must settle before this
task starts; the dependency is fixed to those tasks at acceptance. A waiting
task holds no execution slot and its `max_duration_ms` has not started; its reply
shows `status: "queued"` with the unsettled Agents in `waiting_for`. It still
counts toward the queue limit. If any dependency settles other than `completed`
(including `needs_input`), the task fails with reason `dependency_not_completed`
without creating a session; the Agent stays and can be sent another task.

Each dependency's retained final output is placed before the instructions,
sharing a 16384-unit budget, with the Agent name, task label, status and an
omitted-character count. The block states that it is other agents' output, not
instructions. It is not part of the approval witness's `task_prompt`, which
holds only parent-authored text: joined messages and the prompt. Use it to
queue an author and a reviewer in one turn without reading and re-pasting.

## Acceptance and waiting

A duplicate tool-call ID with identical arguments replays its accepted result
before anything else: a spawn or run replays even if `wait_ms`, the preset file,
model metadata or parent thinking later changed, or the worker preset is now
Off, and names in `after` are bound to tasks only at first acceptance; a send
replays its original `delivery` without steering again, within a bounded
window of the most recent 512 sends. For a new request, the
host context, abort and admission are rechecked after any settle wait and
before any side effect; a call made while Off fails at once instead of waiting. Different
arguments under the same ID fail `REQUEST_CONFLICT`. Other representative
stable errors include `QUEUE_FULL`, `RESIDENT_LIMIT`, `OWNER_HISTORY_LIMIT`,
`AGENT_BUSY`, `AGENT_UNAVAILABLE`, `AGENT_EXISTS`, `AGENT_NOT_FOUND`,
`STALE_OWNER_CONTEXT`, and `OWNER_CLEANUP_UNCERTAIN`; callers consume `code` and
fields, not English text. `WORKERS_DISABLED` rejects every spawn, run and send while
Off, and unaccepted submissions that crossed a disable/re-enable boundary. It
does not allocate a failed task, poison Owner health, or stop accepted work.

`max_duration_ms` begins at slot assignment and initialization, not queue
admission. `wait_ms` begins **after** acceptance. Omit it or use zero for an
immediate task reply. A positive value waits for the resulting task (the new
one, or the one a message joined, steered or answered) and returns its wait entry
directly: the whole question or the result page, as for `agent_wait`. Esc/abort
of that wait returns the accepted task's state and does not interrupt it.

## Task replies

Every task projection carries `agent` and `status` (`queued`, `running`,
`finishing` while its outcome is being finalized, `needs_input`, `completed`,
`failed`, `interrupting`, or `interrupted`), plus when present `reason`,
`limit_reached` (a turn-capped task still settles `completed`), bounded `error`
and `owner_error`, `waiting_for`, and `unavailable` when the Agent cannot take
another task. Internally these remain the Run statuses `cancelling` and
`cancelled`.

## Results and waiting

`agent_wait` defaults to every Agent with a task in progress (none returns
`reason: "nothing_running"`), `mode: "all"`, and a five-minute wait, which is
also the maximum; explicit `wait_ms`, including zero, is honored. Reasons are
`done`, `attention`, `timeout`, `aborted` (the parent pressed Esc), and
`owner_blocked`; `timeout` and `aborted` never mean completion and never
interrupt tasks. `any` is level-triggered, so an already finished task
qualifies immediately. In `all` mode, a terminal `needs_input`, `failed`,
`interrupted`, or `completed` with `limit_reached` returns `attention` without
interrupting peers; a provisional outcome still finalizing does not qualify.
`pending` names the Agents still working. A new Owner fault returns
`owner_blocked` to already-pending waiters once.

Questions take priority in a shared 16384 UTF-16 text budget. Only an
answerable question — a `needs_input` task's — is shown; a task stopped while
asking (interrupted, failed) keeps its question readable through `agent_read`,
but its Agent's next task is `agent_run`. Results follow:
a lone finished task may use the whole budget, several share it with at least
4096 units each, and running tasks consume none. A question that did not fit is
marked `question_truncated`; a result that did not fit is marked
`result_omitted`; a continuing result carries `next_cursor`. Each of these
directs the caller to `agent_read`. The reply's JSON text inside its serialized
`content` envelope has an independent 64 KiB UTF-8 cap, including both JSON
escaping layers; when needed the text budget shrinks with
`response_limit_reached: true`, and a still-invalid reply fails
`WAIT_REPLY_TOO_LARGE`.

`agent_read` returns the latest task's projection, its whole recorded
`question`, and one page of its last assistant output as `result` (default and
maximum 16384 units), with `next_cursor` when retained output continues. A
cursor belongs to one task; it keeps paging that task even after the Agent
starts another, and a cursor from another Agent fails `INVALID_CURSOR`. A page
may exceed its limit by one unit to avoid splitting a surrogate pair.
`omitted_chars` counts text that was never retained and cannot be fetched.

`notify_parent` progress is not a wake-up. On a terminal condition, attention or
owner-blocked return, matching finished-task progress is claimed atomically and
shown under each Agent's `progress` (at most two messages per task and sixteen
total, within 2048 units; a cut message ends with `…`), with `progress_omitted`
counting the rest. Running peers retain theirs; timeout/abort claims none. This
is deliberately lossy at-most-once feedback, never an ACK queue; do not wait
merely to drain it.

## Interrupt, kill, list

`agent_interrupt` requests that the current task stop and returns its
projection (`interrupting`, then `interrupted` once stopped); wait for actual
settlement. The Agent keeps its conversation, so a following `agent_run` starts
a new task that redirects it. An Agent lives until `agent_kill`: a first task
interrupted or failed by its dependencies before starting leaves it in place,
and its next task creates the session and carries any inherited context.

`agent_kill` ends an Agent permanently. An idle Agent is released immediately.
A busy Agent's task is interrupted and the Agent is released once the task
settles. One 10 s deadline covers both stopping and cleanup; past it the reply
is `exiting` while tracked cleanup continues and unconfirmed resources stay
reserved. The reply's `status` is `killed`,
`exiting` (its task is still stopping; release follows automatically), or
`cleanup_uncertain` (release could not be confirmed; there is no force release,
retry, or automatic eviction). The name stays taken, and owner-memory results
stay readable through `agent_read`. Cleanup errors remain on the latest Run's
live detail view without rewriting its outcome or history.

`agent_list` takes no arguments and returns every resident Agent (at most the
resident cap) with its current or latest task: `agent`, `profile`, creation-time
`difficulty`, a 120-unit `label`, the task projection, `has_question`, and
`elapsed_s` while running. `has_question` appears only on a task still
awaiting an answer (`needs_input`), answerable with `agent_send`; a question
on a stopped task is readable with `agent_read`, but that Agent's next task is
`agent_run` — `agent_send` cannot deliver to it. An `unavailable` field
overrides an otherwise healthy status: the task facts stand, but the Agent
cannot take another task; report it to the user. Rows also carry owner-memory history for choosing
between `agent_run` and `agent_spawn`: `tasks` (count), up to four
`earlier_labels` (newest first), `context_pct` of the last observed context
window, cumulative observed `cost_usd` (with `cost_partial` when some responses
reported no cost), up to eight `touched` paths (relative to
cwd when inside it) from successful `edit`/`write` calls with
`touched_omitted`, and `idle_s` since the latest task settled. These are
observations, not a reservation or recommendation. Killed Agents are listed by
name under `killed` (the newest 32, with `killed_omitted`). A question's text
stays behind `agent_wait`/`agent_read`.

### Finished tasks

Every successful management reply may add `finished`: up to eight Agents, oldest
first, whose tasks settled and have not yet been shown (`agent`, `status`,
`reason`, `limit_reached`, `has_question` — the last only on an answerable
`needs_input` task), plus `finished_omitted` for those
left for a later reply or lost to the bounds. A settlement is consumed only when
a reply names that Agent (a task projection, wait entry, list row, or killed
name) or lists it under `finished`. It is kept for a later reply when adding it
would exceed the 65536-byte envelope, and a thrown error reply does not consume
it. At most 256 unshown settlements are kept per tool set; this is a convenience
in harness tools' own results, not a context injection or a delivery guarantee.

## Child tools

Children receive their rendered profile's local Pi tools plus exactly
`notify_parent` and `ask_parent`.  The management tools are explicitly excluded
from every child table, including retired names kept only in deny/exclusion
logic.  `notify_parent({ message })` and `ask_parent({ question })` each require
1--8192 nonblank UTF-16 units.  The latter records a question and asks the
child to finish; it does not force immediate termination or wake the parent.
The former records ordinary progress.  Both recheck the Run gate after SDK tool
hooks and fail `RUN_INPUT_CLOSED` when no bound task can accept them.

Declared `reader`/`editor` definitions expose web capability under the broader
permission configuration, but the effective **harness child allowlist excludes
their web**; only `researcher` receives web tools, from its own pi-web-access
instance.  Plain `pi` has no delegation at all.  See [security](security.md) for
the distinction between definition/policy authority and this fixed child table.
