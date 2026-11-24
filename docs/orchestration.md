# Agents, tasks and sessions

Use a new Agent for independent work and a follow-up task when its existing conversation matters. For example, a worker that diagnosed a failing test can use that same context to fix it. If another Agent needs only the findings, pass the result as a dependency instead of reusing the conversation. See the [worked tool calls](agent-tools-quickstart.md).

## What lives how long?

| Object      | Lifetime and address                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**   | One controller for one live parent Pi session and generation. Owns admission, execution slots, retained results and the local lease. No cross-session lookup.                                     |
| **Agent**   | A named reservation for one profile, model, thinking setting and working directory. Reusing a healthy Agent reuses its child conversation. A name is unique within its Owner, even after release. |
| **Run**     | One task on an Agent. A follow-up gets a new Run and a new 1-based `task` number. That number selects a past task for reading; it cannot target a command at old work.                            |
| **Session** | Pi's conversation state. Parent and child have separate SDK sessions. Persisted journals can be inspected after restart; they do not restore a live Owner, queued work or pending questions.      |

Both profiles use the parent's current working directory as admitted, including uncommitted changes and build outputs. Alehouse does not isolate files or Git state. Use [dispatch](task-dispatch.md) to coordinate edits and reserve build directories. Neither declaration grants permission.

## Pick a profile

- **Worker** (`editor` internally): local reads, Bash, edits and writes under the applicable policy. Suitable for diagnosis, design, review, implementation or testing. A review-only prompt is not a read-only restriction. No web tools does not mean no network access.
- **Scout** (`researcher` internally): local read/search/list tools and the four tools supplied by `pi-web-access` 0.48.0; no model-facing Bash, edit or write. Use a scout for cited findings, including local-only research. Local files and web access together can expose data; see [security](security.md).

Only `worker` and `scout` are accepted in `agent_spawn`. `init` installs their two managed definitions and disables the built-in `Explore`, `Plan` and `general-purpose` definitions. Profile is independent of difficulty: [routing](routing.md) chooses the model and effort. An optional inherited context snapshot is bounded text for the first Run, not a fork of the parent session.

## Work through a task

| Situation                              | Parent tool                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegate independent work              | `agent_spawn` creates a named Agent and its first task.                                                                                              |
| Continue an Agent's earlier work       | `agent_run` starts a new task on an idle, reusable Agent.                                                                                            |
| Add information while work is pending  | `agent_send` joins or steers the bound task; it is not an answer to a settled question.                                                              |
| A child needs a decision               | `agent_answer` supplies the answer with the exact pending question ID. The continuation is a new Run.                                                |
| Wait for a change or retrieve a result | `agent_wait` observes; a timeout or Esc ends the wait, not the work. `agent_read` reads the bound task or pages a retained result.                   |
| Inspect, stop or release               | `agent_list` shows the roster; `agent_interrupt` requests a cooperative stop; `agent_kill` permanently releases the Agent once cleanup is confirmed. |

A child can `alert_parent` with information or `ask_parent` with a question. Neither starts a parent model turn. Children cannot delegate. Consult the [tool contract](tool-contract.md) for question handling, scout-to-worker handoff, replay and what a successful tool reply actually confirms.

## When a task looks stuck

An executing task holds one of four slots for its admitted provider; different models on that provider share the limit. An idle Agent still holds one of sixteen resident reservations. A queued task may be waiting for a dependency or a provider slot. A finishing task has exited execution but may still be draining inputs, releasing resources or recording history. Do not assume it is reusable or forcibly remove a lease.

Press **Alt+A** or run `/alehouse-status` to inspect progress. Check for an unanswered question before waiting again. A Run has a soft turn budget but no wall-clock execution deadline. A partial result can still be useful even if the task failed; a `completed` task with `limit_reached` is not proof that all requested work was done.

Each new worker or scout takes its agent-level retry settings from the **live parent session**, including in-memory overrides (`retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`, and `retry.maxAgentDelayMs`). Unset fields use Pi's defaults. An existing child keeps its settings across follow-up tasks. A transient error retries the model request within the same Run, not the whole task. With retries enabled and `maxRetries: 3`, that means at most four attempts including the first; cancellation or the Run's turn budget can stop it sooner. Alehouse sets `retry.provider.maxRetries` to `0` for the child so provider retries do not multiply those attempts. It does not change the parent's settings.

## Close or switch sessions

Turning the preset Off blocks new work but does not stop accepted tasks. Killing all Agents is not the same as closing the Owner. Use `/alehouse-close` and wait for confirmed closure before exit, `/tree` or upgrading. Do not `/reload` with an open Owner. A used Owner needs confirmation before a session replacement; an unused one can close automatically. If cleanup is uncertain, a timeout does not establish that the children have stopped. See [support limits](limitations.md).
