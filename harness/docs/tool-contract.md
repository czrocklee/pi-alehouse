# Tool contract

This defines the parent/child communication contract. Packages, generated
resources and managed definitions/policy must match; see
[matched resource migration](development.md#matched-resource-migration).
For complete caller workflows, see the [Agent tools quickstart](agent-tools-quickstart.md).
This page owns tool inputs, selectors, replies and communication; paths, claims
and validation observations belong to [task dispatch](task-dispatch.md), authority to [security](security.md),
support limits to [limitations](limitations.md), and implementation/check ownership
to [development](development.md).

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
derived for presentation and accepted only as a read-only `agent_read` selector,
never as a command target. Labels are auxiliary (at most 120 UTF-16 units),
never a substitute for task identity.
Routing, models, Owner IDs, generation and SDK session IDs stay internal.

| Tool | Intent |
| --- | --- |
| `agent_spawn` | Create a named Agent and give it its first task. Optional scout `return_to` also admits one worker continuation. |
| `agent_run` | Give an idle Agent a follow-up task; cannot bypass an unanswered question. |
| `agent_send` | Join/steer the task bound at the call; never create a continuation. |
| `agent_answer` | Answer one explicit pending question and create a continuation Run. |
| `agent_wait` | Wait for bound tasks, a question, a task issue or scoped alerts. |
| `agent_read` | Read a selected task's result/question page and Agent alerts. |
| `agent_interrupt` | Request a stop; confirm settlement through wait or read. |
| `agent_kill` | Permanently end an Agent. |
| `agent_list` | Read the roster without consuming communication. |

Retired management names (`delegate`, `wait_agents`, `read_result`,
`message_agents`, `cancel_task`, `release_agent`, `list_agents`, `spawn_agent`,
`resume_agent`, `read_run`, `wait_runs`, `steer_run`, `post_update`, `cancel_run`)
stay denied/excluded, without aliases. `notify_parent` is also retired and
explicitly denied, not registered as an alias of `alert_parent`. Historical
journals may still display it. Supported profile IDs, `harness:*` records, config paths,
lifecycle events and `Symbol.for` keys remain compatibility surface, including
internal `cancelling`/`cancelled` statuses. Reader retirement removes only its
runtime support and private capability keys; existing records remain literal.

`agent_spawn` carries the one policy no schema expresses: the user's
[delegation mode](routing.md#delegation-mode), as a Pi `promptGuidelines` bullet.
Manual has its own line; other modes combine one division-of-work sentence and
one eagerness sentence (`harness/src/delegation.ts`), then a fixed sentence
about web research. The default, Co-worker × balanced, reads:

> Work alongside Agents: you and they each take parts of the task. Hand off
> independent pieces that would take you longer to do than to explain.
> Scouts do all web research, even small lookups; do not fetch pages through Bash.

Pi renders it only while `agent_spawn` is active, rebuilding the loadout every
turn. Off, children and ordinary Pi receive no such text. Changing the mode
re-registers this tool (one prompt-cache miss). Other semantics belong in tool
and parameter descriptions, not another orchestration briefing.

In Co-worker, Lead and Supervisor with a preset active, all web research goes
to scouts regardless of eagerness, including small lookups. The parent's
`agent_spawn.prepareLoadout` natively hides its registered pi-web-access tools
(`web_enable` included), aligning the SDK's structured prompt tool list.
The always-registered `context_with_system` also filters web-tool add/remove
deltas from each request's system messages, independently of spawn availability.
If spawn is excluded or withheld, canonical SDK sections may still list web
tools, but the wire projection omits their declarations. `before_agent_start`
passes the complete web registry, not just active names, to the patched
authority's forced tool-list renderer; names stay out even after permission
relaxation restores a tool. Hidden web calls are refused before permission
prompts with:

> Direct web tools are unavailable in this delegation mode. Use a scout for external research.

Canonical declarations stay intact; the harness does not mutate the active set
or record durable web removals. Manual and Off restore upstream selection, and
session resume does not inherit a harness removal. Cited findings are intended
to reduce direct untrusted exposure, not exclude all page text; findings remain
untrusted. If no usable scout is available, the user must choose Manual or Off
for direct web access. See [security](security.md#parent-web-access).

## Agent names and spawn

Names match `^[a-z][a-z0-9-]{0,23}$`: short task-independent nicknames, not task
labels, from one theme the model chooses per session. The description gives no
example names: models copied them into every session instead of choosing. A name stays taken after kill.
Addressing selects current task, else the still-pending question's task, else
latest task. For read only, `task` selects that Agent's retained task from its
first page; a cursor instead pins its original Run. Unknown names
fail `AGENT_NOT_FOUND` with `parameter`, known names in `allowed`, and a pointer
to spawn. Spawning a known name fails `AGENT_EXISTS`: it first points to
`agent_list`, since a repeated uncertain spawn is the common cause, then to a
new name for a new Agent, never to run: the caller asked for a new Agent.

Tool assembly explicitly binds this naming contract for the Owner's lifetime,
including Off. It checks all retained Agents, including released history, before
exposing tools; incompatible existing state fails
`UNSUPPORTED_MODEL_AGENT_IDENTITY` without consuming or renaming anything.
Final core admission then also rejects incompatible direct/queued submissions,
while accepted-request replay remains intact. This is an adapter opt-in, not a
restriction on optional/repeated display names in an unbound generic core Owner.

Spawn requires `agent`, `prompt` (1--131072 UTF-16 units), `profile`
(`worker` or `scout`) and integer `reasoning_difficulty` (1--5,
from easiest to hardest). Worker maps to stable internal `editor`; scout maps
to stable internal `researcher`. The public name `researcher` is unsupported,
not an alias. Accepted Agents are not renamed. Reasoning difficulty is
independent of profile.
Optional fields are `label` (1--120), `inherit_context`, `after` (1--4 other names),
`wait_ms` (0--300000), `max_turns` (1--10000, default 256), plus optional
`dispatch` and, on spawn only, `return_to`. Task execution has no wall-clock
deadline. The retired `max_duration_ms` parameter is rejected, not ignored.
`return_to` is specified under [Scout return_to](#scout-return_to); on
`agent_run` it is rejected, not ignored.

Spawn/run `dispatch` is closed plain data: `inputs` ≤8 paths, `ownership` ≤16
paths, `tree` one build-root path and `checks` ≤16 parent-declared identifiers;
supplied arrays are nonempty with unique entries, and each string is bounded
to 512 UTF-16 units. Paths have no leading/trailing whitespace and are literal,
not shell globs or expansions. See [task dispatch](task-dispatch.md) for exact path language,
profile/external preflight, claims, after rechecks and validation observations.
These declarations do not grant permissions or prove that checks ran. In
particular, `ownership` and `tree` are checked as `path_write`; omit `ownership`
for read-only tasks, and `tree` cannot create an output-root exception. Relative
paths use the Agent's cwd, shared with the parent; absolute paths keep their
meaning. Overlapping declared claims conflict within this Owner; cross-Owner
tree locks are advisory, not global exclusivity. Preflight permission errors
expose the target `profile` and checked `surface`, separately from missing-input
and wrong-type errors.

Profile, cwd, reasoning difficulty, context and turn limit are fixed for the
Agent at spawn; later tasks, steering and routing changes do not migrate them.
Use a new Agent for a different binding. Spawn creates the Agent and submits its
first task, which may queue rather than execute immediately. Prompt is the full
task instruction, including deliverable, scope, stopping conditions and
paths relative to the parent's cwd (or explicit absolute paths); label defaults to its
first nonblank line and is never forwarded as an instruction.

Worker is for local diagnosis, code review, design, implementation and
verification. It has local read/edit/write/Bash/Git/build tools under normal
permissions, without web. No web tools is not network isolation. If a task is
review-only, that instruction does not remove write capabilities. Workers can diff and run assigned checks. Worker has no extra
child-only blanket Git mutation deny and no blanket Git allow. Repository queries and mutations use ordinary Bash permission; only
bounded literal Git version queries can qualify for fixed-query automatic
allowance. Raw configured denies/specific asks, explicit literal paths/outputs,
redirects and credential/resource/high-risk protection remain. Normal yolo
applies to ordinary asks, not denies or invalid-config fail-closed asks. There
are no historical-provenance probes or second Git-operation authorization
matrix. See [Git restrictions](git-read-proof.md).

Scout has read, grep, find, ls and the four web tools, and no model-facing
Bash/edit/write. It gathers, compares and summarizes information from local
files and web sources, including local-only tasks, and returns cited findings
for the caller to decide on. Simple local command lookups (an installed version
or local Git history) belong to the caller. This does not authorize fetching
pages through Bash. Web material is untrusted. Its fetch inputs and descriptions
accept only absolute HTTP(S) URLs, not local video paths; timestamp/frame descriptions do
not promise local-video support. See
[researcher web access](security.md#researcher-web-access). No legacy profile
aliases or capabilities are supported. Bash/web remain permission-gated;
no profile is an OS sandbox.

All Agents share the parent's admitted cwd, including pending local changes,
dependencies and outputs. There is no workspace selector, checkout allocation,
policy rebinding or worktree lifecycle. The removed `workspace` argument is
rejected, not treated as an alias. The main agent coordinates edits and ordinary
Git workflow; existing user worktrees and historical records are untouched.

Difficulty describes reasoning and quality, not permissions: 1--5 resolve
one-to-one to `d1`--`d5`. Model-facing descriptions give the
five anchors, not this routing detail. Anchors 1--3 also name source work (a
direct lookup, a summary of named sources, reconciling conflicting sources),
so gathering is not automatically scored as an investigation; the rating
follows the task, not the profile. Complex review reasoning can warrant 4;
a final/adversarial label or severity alone does not raise the rating. Anchor 5
covers an unknown approach or a remaining reasoning impasse after substantive
investigation, such as an unresolved level-4 attempt. Failure alone, missing
inputs, configuration or environment issues do not qualify. A 5 diagnoses or
decides; once the approach is settled, hand implementation to a new Agent and
rate the remaining work by its own reasoning needs, not automatically 3. See
[routing](routing.md#difficulty). The caller field is
`reasoning_difficulty`; the former `difficulty` argument is rejected, not an
alias. Internal admitted settings and historical `harness:*` journal records
retain their `difficulty` field; only the model-facing projection uses the new
name. Model/thinking/preset/effort and retired
`role`, `strength`, `name`, `description` are not schema inputs. Trusted routing
captures parent thinking before queued admission; neither later tasks nor
spawning change the main model/thinking. Resolution errors are configuration
problems, not reasons to change `reasoning_difficulty`. Fixed effort need not inherit
parent thinking; inherited effort requires it. See [routing](routing.md).

`inherit_context` is at most 64 KiB of model-visible text (user/assistant text
and compaction summaries, no tool calls/results), not a history fork or a
permission grant. Oversize fails `CONTEXT_SNAPSHOT_TOO_LARGE` before creation.

## Run, send and explicit answer

`agent_run({agent, continues, prompt, label?, after?, wait_ms?, dispatch?})` admits a new task only
when idle. Finishing/stopping is waited out for at most 30 s outside the submit
queue. Running fails `AGENT_BUSY`; a pending question fails `PENDING_QUESTION`
and points to explicit answer. Run never delivers into an existing task.

Run requires `continues` (1--512 nonblank UTF-16 units, before `prompt`): name
the specific earlier work of this Agent being continued; if none can be named,
spawn, even on a related topic, with `after` when only an earlier result is
needed. The name marks continuation, not dependency (`after`); it replaces
`builds_on`. `continues` participates in request identity but is not forwarded
to the Agent or stored in `harness:*` records.
Reuse retains the conversation and fixed settings. For capacity, kill finished
Agents whose work is accepted before workers still needed for validation.

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

Answer is 1--16384 nonblank UTF-16 units. No profile, cwd,
reasoning_difficulty, turn limit, label or after is accepted. The original task must already be truly settled
`needs_input`, still pending and unreserved, with no current Run and a healthy,
reusable Agent/Owner. Answer does not wait and then silently answer a future
question. It reserves the original question and admits a continuation with the
Agent's fixed settings/turn limit and the asking task's label and dispatch. Its
resource claim lineage remains held across the pending question; pre-input
rollback that reopens the question also restores that claim, including any
existing tree lease. Final termination/required cleanup, not a stop request,
permits release. Resolve a needs-input claim conflict by answering its question,
or explicitly abandoning it, killing the Agent and awaiting confirmed release;
passive wait/after on that original Run is not a remedy. See
[claim lifecycle](task-dispatch.md#dependencies-claims-and-continuations).
New admission still
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
early, even after reservation release. Optional scout `return_to` admits this
same continuation in one spawn; see [Scout return_to](#scout-return_to). It is
not a delayed or hidden answer.

## After and handoff

`after` binds each named Agent's current or latest task at acceptance, once. It never follows a later answer
continuation; to wait for one, name the Agent after `agent_answer` returns, not
in the same tool batch. Naming a task that has already settled without
completing (needs-input, failed or interrupted) is rejected with
`DEPENDENCY_NOT_COMPLETED`, carrying that Agent and its status as `reason`,
before any Agent, name or task is allocated. Queued tasks hold no execution slot;
`waiting_for` names unsettled
dependencies. They still count toward queue capacity, and their Agents toward
resident capacity. Active work is capped at four Runs per admitted provider
(models share it); waiting on that provider does not block another. Queued rows
explain the wait without exposing model/provider routing: `wait: "dependencies"`
or `wait: "capacity"`. Capacity waits are normal scheduling, not a failed task;
wait for the accepted work rather than respawning it or changing difficulty
to bypass the queue. See
[architecture](architecture.md#ownership-and-lifecycle). Once any dependency settles without completing (including
needs-input), pump fails the task with `dependency_not_completed` at once,
without waiting for its other dependencies or that provider's free slot and without creating
a session. Its error names that Agent and status, e.g.
`DEPENDENCY_NOT_COMPLETED: otter (needs_input)`; its own successors then fail in
turn. The Agent remains.
Dispatch predecessor conflict exemptions use the fixed Run-ID transitive closure
at admission, not dynamic Agent names, and allow queuing rather than premature
execution. Inputs for after tasks defer existence checks; all dispatched tasks
recheck at pump when it can progress. Missing dependency input produces
`dependency_input_missing`; other deferred preflight failures produce
`dispatch_preflight_failed`. Pump failures use no session/slot. Inputs are
revalidated rather than locked; ownership/tree claims retain strict equality.

Retained final output of dependencies shares a 16384-unit handoff budget, with
Agent/label/status and never-retained character count. It is framed as reference,
not instructions, and is not parent-authored approval witness text. It is not
verified. This permits queuing an author/reviewer without re-pasting results.

## Scout return_to

Optional closed `agent_spawn.return_to` is `{agent, question_id, answer}`, all
required if present. Omitting it leaves the default one-Run spawn. It is not an
`agent_answer` alias, a delayed admission, a new tool or a child capability.
The public object is exactly those three fields. Source `profile` must be
`scout` (internal `researcher`); `agent` must name a healthy reusable `worker`
(internal `editor`) whose exact current question is already settled and
actionable: `needs_input`, pending, unreserved, no current Run. A non-scout
source or non-worker target fails closed (`INVALID_RETURN_TO` /
`INVALID_RETURN_TO_PROFILE`). `question_id` is the same `^q_[0-9a-f]{32}$` token.
`answer` is required parent text, 1--16384 nonblank UTF-16 units. Prepare maps
`agent` to internal `agent_id` before core admission. The source may still use
its own `after`; an already settled non-completed dependency is rejected before
install. One call does not recurse, reserve a capacity pool, start a service,
arm a lifecycle deadline or write an external store.

Coordinator admission installs two ordinary Runs or neither. The source is the
new scout Run. The worker continuation is preadmitted `after` that exact source
Run, with the original `answer_to`, dispatch and claim, and the Agent's fixed
settings and turn limit exactly as `agent_answer` admits them.
`return_to.answer` is the continuation `task_prompt` and parent-authored witness
text. Source output crosses only by the existing handoff prefix, shared
16384-unit budget and untrusted framing, outside `task_prompt`. Every `return_to`-specific
refusal (shape, profiles, token, answer, an already settled non-completed source
dependency) precedes shared capacity, so it is never reported as `QUEUE_FULL` or
`OWNER_HISTORY_LIMIT`. Those core refusals carry `parameter` and a resolution;
argument-schema rejections of malformed input come earlier and name no
`parameter`. Admission needs one free resident Agent slot (only the scout is
new) and two free queue entries, history Runs and output reservations; one free
entry of the last three is not enough, and a compound `QUEUE_FULL` resolution
says two entries are needed. Off, failed eligibility, either preflight or
any shortfall rejects before admission. The final lease probe before install is
read-only, so a reentrant lease adapter cannot change what was planned. An
accepted pair still runs if delegation is later turned Off.

From admission, all parent-model result observations of the source, including
spawn/send/wait and explicit `agent_read` by name, task or cursor, replace its
raw body with a short harness-authored human-readable handoff notice. The notice
identifies the source and the exact original worker continuation by Agent name
and task. It says pending until that continuation's `input_entered`, delivered
only after that boundary, or not delivered if it ended before input. Once not delivered, or delivered with retained text omitted from the bounded handoff, an explicit `agent_read` of the source returns its real retained result pages with normal cursors; other observations' notice says so and counts any omitted characters. Later worker
failure or kill does not undo observed input delivery. The sticky exact link
survives reuse or kill of either Agent and delegation Off; it never retargets.
No raw source paging/omission flags or source result cursors are exposed. No new
model-visible flag, read mode or permission is added. Scouts without `return_to`
retain normal output and paging. Internal `getResult`, dependency handoff, human
UI and history retain the true raw source text unchanged. Alerts, questions and
labels remain visible, so this is not an OS sandbox or zero-information-flow
guarantee. Publishing a terminal source row still follows the finished-bit rule.

Source failure, `needs_input` or interruption fails the pending continuation and
reopens the original question if the worker is healthy and the continuation has
not entered input. After input entry, or after kill, quarantine or Owner loss,
the question is not restored. Worker stop or kill does not cancel the scout; the
scout stays resident until explicit kill. The two cancellations are not one
transaction.

Compound observation `action` is `agent_spawn` for the source only. `done` is
the continuation only; the source ending alone is not `done`. Published rows are
the source and the continuation. Alert scope is exactly those two Runs, not
older Runs of either Agent. Readiness (question, task issue and `done`) uses
the continuation only. A scout that fails, asks or is interrupted fails the
continuation, so the reply returns `task_issue` only once that continuation has
settled, never showing a doomed continuation as queued; the scout row still
carries its status and any question. A turn-limited but completed scout hands
off normally and does not end the wait. A reopened original question is not added to them; wait or read the
worker. Caller abort or timeout cancels the observation, not the accepted Runs.
The caller request replays the source Run. Internal `return_to_run_id` on that
source links the continuation; the continuation request ID is derived and not
caller-submittable. Any different `return_to` is `REQUEST_CONFLICT`. `observe`
expands an `agent_spawn` of that source to the pair. Preflight is all-or-none
and install is callback-free. No installed Run starts or is dependency-failed
before its own notification returns, even if a consumer reenters and pumps. A
notification failure does not uninstall either record; that Run is at once
quarantined `context_change_failed` and dequeued, so nothing can start it, and
is finished as an error only after both notifications. `return_to_run_id` is the sticky exact internal link: live Owner
metadata for the current Owner only. It is never serialized into model tool
output and is not a journal field. `PiRunJournal` still writes its
explicit identity, routing, outcome and result fields, not the RunRecord or this
link. Existing journal names and data stay literal. Restart does not hydrate the
pair. The prepare-time allow
is [security](security.md#communication-observation-and-admission). This text is
not acceptance evidence and does not mean the feature's tests passed.

## Acceptance, selection and reasons

Request IDs replay **acceptance/delivery facts**, not cached observation results.
Spawn/run/answer reuse their original Run; send reuses original delivery within
its bounded 512-record window. A spawn `return_to` replays the same source and
continuation pair, not a second pair. Replays cannot restore already-published
alerts. Different arguments, including a different `return_to`, fail
`REQUEST_CONFLICT`. New commands recheck context,
abort, admission and revision after preparation/settle and before effects.
`WORKERS_DISABLED` rejects new spawn/run/send/answer and submissions crossing a
disable/re-enable boundary without allocating failed work or poisoning Owner
health. Other errors include `QUEUE_FULL`, `RESIDENT_LIMIT`,
`OWNER_HISTORY_LIMIT`, `AGENT_UNAVAILABLE`, `STALE_OWNER_CONTEXT` and
`OWNER_CLEANUP_UNCERTAIN`.

Owner errors share guidance at public admission and child-input boundaries:
`OWNER_CLOSED` is permanent closure, not fixed by routing or another Agent;
tell the user and start a fresh session only after confirmed closure.
`OWNER_CLEANUP_UNCERTAIN` requires telling the user, with no retry or force
release. `OWNER_INTERNAL_ERROR` and `OWNER_PARENT_UNAVAILABLE` likewise require
telling the user and not retrying. These are harness/session faults, not
provider/model availability evidence.

A new spawn/run/answer rejected with `RESIDENT_LIMIT`, `RESOURCE_OWNED` or
`BUILD_TREE_BUSY` only by Agents whose explicit kill/release is already under
way waits for such a release outside the submit queue, at most 10 s from the
call (abortable), then repeats the whole admission. Resource conflicts are
checked before capacity, and a conflicting holder that is not being released is
reported at once. Timeout, uncertain cleanup or any other blocker returns the
rejection unchanged. Only a release
already under way when admission rejects is waited for: parallel tool-batch
order is not a guarantee, and a later kill is not anticipated.

Execution has a turn limit but no wall-clock deadline or timed wrap-up input;
see [execution limits](task-dispatch.md#execution-limits). Turn wrap still uses
`soft_budget` and invalidates the approval witness
(`pi-harness:approval:invalidated`). Elapsed time remains an observation, not a
stop condition. Legacy `deadline`/`time_wrapped` history remains literal and
readable, never restored as active timers or injected reminders.

`agent_wait({agents?, mode?, wait_ms?})` accepts `mode: "all" | "any"`
(default `all`): all selected tasks must end, or any one must end. Questions,
issues and scoped alerts can return earlier in either mode.

Optional observation time starts at registration **after** command acceptance/preparation
and any lifecycle settle. All wait_ms are 0--300000; commands default to zero,
wait defaults to 300000. Prefer long waits to repeated polls; questions, issues
and alerts return early. Zero/short waits remain valid. Esc/abort cancels the
observation, not accepted work.
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
| Result read, default / task / cursor | Addressed task / selected ordinal / original cursor Run | All Runs of the named Agent |
| Spawn/run/send/answer, zero or positive wait | Accepted/delivered fact's one Run | That Run only; no global drain |
| Spawn with `return_to`, zero or positive wait | Shows source scout and worker continuation; readiness from the continuation only | Exactly those two Runs, not older Runs of either Agent |
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

Commands with zero/omitted wait and read use **snapshot** policy after
context/abort checks; they do not consume waiting-only Owner fault edges.
Snapshot replies omit public `reason`. Wait (even wait_ms=0) and positive
command waits use this priority:

1. `aborted`: latched abort, no alert/finished consumption.
2. `owner_blocked`: a new Owner fault edge.
3. `question`: selected truly answerable pending question.
4. `task_issue`: settled failed/interrupted or limit-reached task.
5. `done`: nonempty bound set meets all/any terminal condition. Compound
   `return_to` is the exception: question, task issue and `done` all use the
   worker continuation only.
6. `alert`: pending alert in scope, with at least one complete message.
7. `nothing_pending`: no bound task and no scoped alert, immediately.
8. `timeout`: unique timer's deadline latch; no alert/finished consumption.
9. Otherwise keep the same waiter and timer.

Reason is the primary trigger, not task status. Public `reason` is omitted for
snapshot and done; done does not mean the inbox is empty. Faults broadcast to
observers already registered before the edge;
successful reporting commits its marker. One reporter does not disqualify its
concurrent peers, while later waits do not repeat a reported edge. Readiness
wins over timeout; Node timer granularity is not a strict absolute-time promise.

## Unified observation envelope

Spawn/run/send/answer/wait/read share one projection/publication path:

```ts
{
  action?: { type, agent, task, delivery? },
  reason?: string, // omitted for snapshot and done
  workers_disabled?: true,
  agents: TaskEntry[],
  alerts?: { agent, task, label, message, source?: "harness" }[],
  alerts_pending?: number, // positive only
  finished?: FinishedEntry[],
  finished_pending?: number, // positive only
  response_limit_reached?: true
}
```

Action is an accepted command fact: type is agent_spawn/run/answer for its new
Run, or agent_send with joined/steered/not_delivered on the bound target.
Compound `return_to` keeps a single `agent_spawn` action on the source, not an
`agent_answer` action. Wait and read have no action. `workers_disabled` says new work/answers are forbidden,
not that observation is forbidden or that the Owner is faulty; enable delegation
to answer. Pending counts describe this scope **after commit**, never lost
messages. Alerts are top-level and never part of a result page.

Zero `alerts_pending`/`finished_pending` counts and the redundant `pending`
array are absent. Empty result text has no `result` field.

Task rows may carry a whole optional `label`, yielding under the cap with
`response_limit_reached`. No workspace, allocation or recovery-path metadata is
produced.

Each task row retains `{agent, task, status}` and applicable boolean
`has_question`, `limit_reached`, `unavailable`; diagnostics use
`unavailable_reason`, `error`, `owner_error`. Statuses include queued, running,
finishing, needs_input, completed, failed, interrupting and interrupted.
Optional `cancellation_source: "human"` on task/finished rows and list/interrupt
projections identifies the first accepted explicit human Stop. It is bounded
metadata, not a thin control, and may yield under envelope pressure. Default
model interruption, shutdown, and budget stops do not fabricate human origin;
a repeated Stop does not relabel an earlier request. The same source is retained
in new run-end outcomes for cold inspection. A separate best-effort
`harness:human-cancellation:v1` parent custom message requests no automatic retry
and does not trigger a model turn; publication is not model acknowledgement.
Queued rows retain `wait: "dependencies" | "capacity"` when that scheduling
condition applies; it is a mandatory bounded control, including in list/interrupt
projections, not optional diagnostic text. Dependency names remain in the roster's
`waiting_for`. Owner faults remain separately reported; an unavailable Owner is
not diagnosed as provider saturation. Routing identities remain host-only.
Live Run context, usage and elapsed time remain UI observations; legacy timed
warning attempts remain history-only facts. Task descriptions stay on their original Runs.
There is no separate touched-path/earlier-label summary or generic model-recovery
hint. Question fields are `question_id`, `question`, `question_truncated`;
historical text need not have a token. Real retained result pages use `result`, `next_cursor`, `result_omitted`,
`result_truncated` and `omitted_chars`. Truncation/omission control flags are
never silently removed by compact fallback. Omitted_chars means text never
retained, not packing loss. Live previews shortened by packing explicitly mark
result_truncated. Terminal cursors point to the actual displayed page end.
Every bound terminal window of real retained result pages with remaining text
reserves a cursor before body packing, including packing-omitted pages (unchanged
offset). Thus reuse of that Agent during a bound wait cannot make the
packing-omitted original page unaddressable. Keep returned cursors to continue
that page. A `return_to` source instead carries its whole handoff notice as
`result`, without a raw result window, paging/omission flags or source cursor.

`agent_read({agent, task?, cursor?, max_chars?})` reads a result/question page.
There is no `view` argument.
`task` is a positive safe integer selecting that Agent's retained task from its
first page, even after reuse or kill in this Owner. `task` and `cursor` are
mutually exclusive. Unknown ordinals fail `TASK_NOT_FOUND`; they are not targets
for send/answer/interrupt/kill/run. With neither selector, read chooses current,
else pending-question, else latest task. No new tool or registry is introduced.

For raw result pages, read requests `max_chars` (1--16384, default 16384); it
does not shorten a bounded handoff notice. A cursor
pins its original task even after reuse and fails `INVALID_CURSOR` on another
Agent. A page may exceed its request by one unit to avoid a split surrogate.
Read prioritizes the entire recorded question; alerts may stay pending when
that full question needs space. A task-3 read may present a task-2 alert of the
same Agent, but inline action.task=3 never receives task-2 alerts.

The model adapter requires effective resident capacity ≤16 at tool assembly
(`UNSUPPORTED_MODEL_RESIDENT_LIMIT` otherwise). Production uses twelve. Core
can still support larger configurations. All bound control rows
are shown; there is no agents_omitted field.

### Result cursors

Treat model result cursors as opaque. Their internal form is `r1_<key>.<offset>`:
key is the canonical 22-character base64url encoding of the first 16 SHA256 bytes
of UTF-8 `JSON.stringify(["pi-alehouse/result-cursor/v1", owner, generation, run, version])`.
Offset is a safe nonnegative UTF-16 position in base36, padded to exactly 11
characters. The total width is always **37 ASCII characters**, so advancing a
page cannot grow its reserved metadata.

Lookup scans original retained settled Runs, requires a unique match and the
named Agent, and validates offset range and surrogate boundaries. No cursor
registry/cache is added. The separate read-only task selector restarts page one.
This is a locator, not permission authority or a mathematically collision-free identity; the 128-bit
digest's negligible collision risk is accepted. Legacy core cursors remain
accepted, and core `getResult` still emits its legacy format. Syntax, identity,
range and surrogate-boundary errors all use `INVALID_CURSOR` with recovery
guidance: pass the Agent/cursor returned together, or omit
cursor and supply that Agent's task number to restart its first page. Omitting
both task and cursor selects current, pending-question or latest, not necessarily
the old task intended by a bad cursor. Failed cursor validation commits no
communication.

### Budget and local publication

Question, alert.message and result text share 16384 UTF-16 units. Whole optional
labels, tokens, controls and diagnostics are outside that text budget but
inside the final **65536-byte** double-JSON UTF-8 content envelope. `max_chars`
does not override this cap. The conservative retained-envelope fixture is
bounded below the cap with maximal control rows/counts, action/disabled/limit
fields, queue-wait reasons, result cursors, question IDs, empty question fields
and a complete worst-case tagged alert. It excludes the removed pending-name
array and depends on these exact fields and bounds.

Real result page text yields before its reserved cursor; packing-omitted pages
keep their original offset, partial pages advance by shown units, and EOF needs
no cursor. A handoff notice packs whole as a normal `result` string or yields
under budget pressure with `response_limit_reached`; it is not a fake page and
never advertises a raw source cursor.
Packing retains thin controls and, for reason=alert, a complete first scoped
FIFO alert. Questions are marked if truncated. Further alerts form a complete
FIFO prefix: packing stops at the first alert that cannot fit, never skipping
to a smaller later one. Unshown alerts remain pending. Bounded labels and human
Stop attribution precede result pages. Bounded diagnostics/notes and up to
eight finished rows use the remaining budget. There is no separate metadata
retrieval mode.

`dispatch_notes` (at most 2 × 120 units) remain optional. Model projections show
only `tree_shared`; other notes stay on the Run and detail pane. Legacy warning
facts and other host telemetry do not enter parent-model replies. Validation receipts
stay in trusted history/offline audit; see
[notes and receipts](task-dispatch.md#notes-receipts-and-coverage).
Each string diagnostic has a fixed 512-unit display cap. That cap alone does
not set response_limit_reached; actual packing pressure does. Diagnostics are
not paginated. A full 8192-unit question plus full worst-case alert cannot always
fit together.

Independent list/interrupt/kill replies reserve response_limit_reached and
enforce the same 65536-byte cap before serialization, preserving every control
row while whole optional fields yield. This is a pure core packing helper, not
a second tool-layer byte policy or a communication commit. It shares the byte
measurement/final serializer with result packing but retains the distinct
lifecycle/roster omission priority. Already-fitting replies exit the optional
field-removal loop early; the final byte guard remains. They consume no alerts
or finished reminders.
If required facts still cannot fit, COMMUNICATION_REPLY_TOO_LARGE advises reading
one Agent/task, not blindly repeating a management command.

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
positive remaining unpresented count, omitted at zero, not historical loss.

Only a successful publication explicitly showing that **original task** with
its terminal status in agents or finished sets its bit. Finished rows may carry
a whole optional label validated against that original Run. Label omission does
not delay consumption, reset the bit or create another reminder. Private
original-Run references establish row identity; equal names, per-Agent task ordinals and
statuses never prove that two rows represent the same Run. Bound rows use
explicit original-Run links; convenience rows are the oldest-first prefix after
excluding those bound originals. A current running row,
Agent name alone, an alert source, list/killed names, UI or count does not.
Result/history stay rereadable; questions remain level-triggered and can reopen
without resetting the bit. Interrupt/kill/list have independent replies and
consume neither alerts nor finished reminders.

## Interrupt, kill and list

Interrupt requests stop; wait for settlement, not just an interrupting status.
A task that already settled, already exited, or is already stopping for its
turn limit keeps that outcome (completed, failed or needs_input);
only a stop this call records settles interrupted.
The Agent keeps its conversation for a later run. Even a first task stopped or
failed before session creation leaves an Agent whose next task can create it.

Kill is permanent: idle releases immediately, busy interrupts then releases
after settlement. A single 10 s deadline covers stopping/cleanup. Beyond it,
status is exiting while tracked cleanup continues; cleanup_uncertain retains
reservations, with no force-release/retry/eviction. Admissions blocked only by a
release under way wait for it within their own bound (see acceptance above).
Kill's independent reply includes lifecycle status and consumes no
communication. Retained results remain readable with `agent_read`, including
historical task selection, within this Owner. Cleanup diagnostics do not rewrite historical
outcomes. Lifecycle waits share the drain but have no model validator/publisher
or presentation commit. Shutdown
still waits for actual execution/cleanup promises, not an empty observer set.

List is a read-only roster with `profile`/`reasoning_difficulty`, label/task
projection and `has_question`. Killed names
include newest 32 plus killed_omitted; use named/task read for retained results.
These are observations, not permission grants or source-checkout validation.
Public worker maps to stable internal editor without rewriting historical IDs.
Unavailable is a boolean fact with unavailable_reason diagnostics.

Run context, usage and elapsed time are live UI observations, not roster
telemetry; legacy timed warning attempts remain history-only facts. There is no dedicated
Agent summary, touched-history collection, earlier-label list or idle-duration
projection. Owner/cursor errors retain concrete guidance, not generic model
recovery hints. There is no redundant task count. Questions are read
through wait/read and answered only through answer; roster facts grant no
admission.

## Child tools

[Runtime feedback](runtime-feedback.md) can attempt one harness-origin alert per
Run after two distinct managed blocks of one tool. It uses a trusted metadata-only
callback, not `alert_parent`; only these entries carry `source: "harness"`.
The parent-facing summary is not feedback injected into the child. Reasons and
operation equivalence remain unknown; existing FIFO/publication rules apply,
with no automatic action.

Children receive their profile's fixed local tools plus exactly:

```ts
alert_parent({ message: string })
ask_parent({ question: string })
```

Both closed schemas require 1--8192 nonblank UTF-16 units and revalidate after
SDK hooks against current Run/generation, accepting gate and stop/exit state.
Closed callbacks fail explicitly (`RUN_INPUT_CLOSED`), never report acceptance.
All nine management tools and retired names are excluded/denied in children.
Only scout (internal `researcher`) receives web tools, with its own instance; worker has no web
tool table. See
[security](security.md#researcher-web-access).

Alert is for decision-relevant facts, not routine progress. Successful acceptance
says it was queued and the child may continue, not that the parent read it. It
wakes matching observations without starting a parent model turn. Duplicate
valid calls may create distinct events; no call-ID alert deduplication cache.

One Owner FIFO preserves order across both sources. Child-origin pending alerts
retain limits of 64 per Owner and 16 per Agent across its Runs. Harness-origin
feedback has independent limits of 16 per Owner and one pending per Agent, for
at most 80 physical entries. Neither lane consumes the other's admission quota
or evicts accepted messages; separate allowance is not delivery priority. Child
text cannot set the structural source tag; publication commit validates it
against the original queued entry. Old/killed sources still occupy their lane's
quota, and run/answer/reuse/kill do not release it. Only publication does.
Within each lane Owner quota is checked first, then Agent; ALERT_QUEUE_FULL specifies scope/limit,
rejects without shifting old messages and says: do not loop-retry; retain the
information in the final result and continue possible work; if a parent decision
is essential, ask_parent and end. The child SDK-visible error text includes the code, scope, limit and this
recovery advice—not just inaccessible exception details. Shared SDK-free byte
admission checks the retained envelope shape before enqueue (ALERT_TOO_LARGE on failure), not message
JSON alone. Rejected calls are not accepted-message loss; there is no drop counter.

Ask is immutable **first-write-wins on the original Run**: first valid call
records the question; later valid calls succeed with already_recorded, explicitly
saying it was not replaced and the child must stop calling tools and end its
turn so the task can settle for an answer. The first successful call gives the
same end-turn instruction. No body comparison. Invalid
input/closed gates still fail, with no truncation. Ask itself neither declares
settlement nor forces suspension; only normal true needs-input settlement may
make it answerable. Cancelled/failed questions remain historical text,
not actionable question tokens.

Old notify/progress/send-answered journals are display-only compatibility:
no rewriting, alias or hydration into new pending state. Matched package,
policy/definitions and a fresh Pi process are required; see
[matched resource migration](development.md#matched-resource-migration).
