# Agent tools quickstart

Use this as a caller workflow, not a standing system prompt. The
[tool contract](tool-contract.md) owns schemas, selection and replies;
[workspaces](workspaces.md) owns paths/binding/retention; [task dispatch](task-dispatch.md)
owns claims and validation. [Security](security.md), [limitations](limitations.md)
and [development](development.md) own authority, support and implementation/checks.

| Need | Tool |
| --- | --- |
| New independent work or review | `agent_spawn` (creates Agent + submits first task; may queue) |
| Continue this Agent's earlier work | `agent_run` (required `builds_on`; fixed settings/conversation) |
| Correct an unfinished task | `agent_send` (delivery is not action) |
| Answer a settled pending question | `agent_answer` |
| Wait for events/end | `agent_wait` (`all`/`any`; prefer long waits) |
| Read results, old task or next page | `agent_read` |
| Request task stop, retain conversation | `agent_interrupt`, then wait/read for settlement |
| Permanently end Agent | `agent_kill` (not deletion; exiting/cleanup_uncertain is not release) |
| Inspect roster without consuming alerts/finished reminders | `agent_list` |

The JSON below lists **tool calls**, not tool returns or a batch API. Names and
paths are illustrative; adapt them to the assigned task. Each section is a
separate session example. `<INVALID_QUESTION_ID>` and `<INVALID_RESULT_CURSOR>`
are deliberately invalid tokens: never send them. Substitute only exact values
from actual controlled/live returns, keeping their Agent/task association.
The registered-tool protocol tests read these calls and substitute actual fixture
returns; no example claims a real provider result or improved model choices.

## 1. Independent work → wait → collect

Submit the two independent tasks (they may run concurrently), then wait. Do not
repeat an uncertain spawn: inspect `agent_list` first. A wait can return early
for alerts, questions or task issues; handle them, then wait on remaining tasks.
Collect both results and keep reading any returned `next_cursor` with its Agent
until absent. A completed status or declared check is not correctness evidence.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"prompt":"Review src/parser.ts without edits. Return findings, evidence and gaps."}},
  {"tool":"agent_spawn","arguments":{"agent":"beta","profile":"worker","reasoning_difficulty":2,"prompt":"Review docs/parser.md without edits. Return findings, evidence and gaps."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha","beta"],"mode":"all","wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha"}},
  {"tool":"agent_read","arguments":{"agent":"beta"}}
]
```

## 2. Ask → settle → answer → bind the continuation

Child `ask_parent` records the first question, then instructs the child to stop
calling tools and end its turn; it does **not** force suspension. Wait until the
asking task truly settles as `needs_input` with a current `question_id` from
wait/read. Historical text or `has_question` alone is not answerability. Do not
send an answer through `agent_send` or bypass it with `agent_run`.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"prompt":"If the format is undecided, ask_parent for the required choice, then stop calling tools and end your turn. Otherwise implement the agreed parser format."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_answer","arguments":{"agent":"alpha","question_id":"<INVALID_QUESTION_ID>","answer":"Use the existing format; preserve compatibility."}},
  {"tool":"agent_spawn","arguments":{"agent":"beta","profile":"worker","reasoning_difficulty":3,"prompt":"Review the completed parser work and report remaining risks; do not edit.","after":["alpha"]}},
  {"tool":"agent_wait","arguments":{"agents":["alpha","beta"],"wait_ms":300000}}
]
```

Wait for `agent_answer` to **return before** submitting beta; never rely on order
within a parallel batch. `after` binds alpha's current or latest task once, passes
its output as reference, and never follows future tasks/answers. Every dependency
must reach `completed`; needs_input/failed/interrupted cannot satisfy it.

## 3. Reuse → read an older task → page that same result

Read a returned task number before reuse if needed; the positive task selector
restarts that retained task at page one. The example uses task 1 because this
separate workflow creates exactly one task before its follow-up. The first
result is assumed long enough to return a cursor; if none is returned, omit the
last call. Never combine `task` and `cursor`, and never move a cursor to another
Agent. Both remain Owner-local, not restart recovery.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"prompt":"Investigate parser edge cases. Return detailed findings and evidence."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_run","arguments":{"agent":"alpha","builds_on":"Your parser edge-case investigation","prompt":"Continue that investigation: summarize the highest-priority remaining issue."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha","task":1,"max_chars":32}},
  {"tool":"agent_read","arguments":{"agent":"alpha","cursor":"<INVALID_RESULT_CURSOR>"}}
]
```

## 4. One worktree submission → work/check → inspect

No preliminary list or initialization task is needed to declare relative paths.
All relative paths, including `..`, use the Agent's execution cwd; absolute paths
keep their meaning. Source cwd still supplies policy/settings. Before binding,
source candidates are deny-only preflight, not existence or permission grants;
actual paths, boundaries, permissions, inputs and claims are checked before child
input. Different Agents' provisional paths are not guaranteed disjoint.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":2,"workspace":"worktree","prompt":"In your assigned workspace, fix src/parser.ts and run only the assigned parser unit check. Report the exact command, result, platform/tool versions and any unrun checks. Do not install dependencies; if unavailable, report the blocker.","dispatch":{"inputs":["src/parser.ts"],"ownership":["src/parser.ts"],"tree":"build","checks":["parser unit check"]}}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha"}}
]
```

Read actual workspace locations only from confirmed wait/read/list facts; do not
guess them. The fixture verifies binding/protocol, not a real parser check.
Worktrees contain committed local HEAD, not source dirty/untracked files,
dependencies or caches. No automatic install, merge or cleanup occurs. A healthy
created session survives binding preflight failure idle/reusable, but inspect the
distinct error and fix the assignment rather than blindly retrying. Integrate
accepted results explicitly; stop/release and manually clean retained worktrees
only after acceptance/discard. Neither workspace is a sandbox.

## Guardrails and recovery

- Initial Off hides all nine tools. After accepted work, wait/read/interrupt/kill/
  list remain available; new tasks, steering and answers require delegation On.
  Ask the user to enable it rather than calling a cached hidden tool.
- Default waits repeat pending questions. To defer one, explicitly wait on other
  Agents; this narrows alerts too. Timeout/abort of a wait never stops child work.
- Ownership/tree claims coordinate declared overlapping resources in one Owner;
  cross-Owner tree locks are advisory, not global exclusivity or a full-suite lock.
  Inputs are revalidated, not held locks. Assign one full-gate validation owner
  only after shared source is stable; other Agents run assigned focused checks.
- Provider slots free on execution exit; resident reservations/claims/leases have
  separate finalization/cleanup boundaries. Interrupting/exiting is not confirmed
  release. For cleanup uncertainty or Owner fault, tell the user; no force release,
  automatic retry or difficulty change repairs authority.
- Optional locations/labels can yield under the reply cap. Results use real cursor
  paging; there is no metadata-only/details mode or guaranteed recovery of an
  overlarge optional path. Alerts are queued, not acknowledged by the model.
