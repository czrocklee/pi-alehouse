# Agent tools quickstart

Use `worker` for local diagnosis, review, edits or verification, and `scout`
for cited findings from files or the web. Review-only instructions are not
access controls. See the [tool contract](tool-contract.md) for exact fields,
[task dispatch](task-dispatch.md) for claims, and [security](security.md) for
permissions. Agents share your cwd; coordinate edits and Git writes.

Each JSON array is a separate walkthrough, not a batch API. Submit tool calls
in order unless noted. Replace `<INVALID_QUESTION_ID>` and
`<INVALID_RESULT_CURSOR>` with the exact tokens returned for that Agent; never
send the placeholders. Adapt names and paths to the task.

## 1. Independent work → wait → collect

Start these reviews independently. Give each task a short `label` and put its
instructions in `prompt`. If acceptance is unclear, check `agent_list` before
spawning again. An early wait reply can contain an alert, question or task
issue: handle it and wait on the remaining work. Read both results and follow
any `next_cursor` with its Agent.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"label":"Review parser source risks","prompt":"Review src/parser.ts without edits. Return findings, evidence and gaps."}},
  {"tool":"agent_spawn","arguments":{"agent":"beta","profile":"worker","reasoning_difficulty":2,"label":"Review parser documentation risks","prompt":"Review docs/parser.md without edits. Return findings, evidence and gaps."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha","beta"],"mode":"all","wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha"}},
  {"tool":"agent_read","arguments":{"agent":"beta"}}
]
```

## 2. Ask → settle → answer → bind the continuation

Wait for `needs_input` with a `question_id`, not just question text. Answer that
question explicitly; steering is not an answer. Submit beta **after the answer
call returns** so `after` binds to the continuation, not the asking task.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"label":"Implement agreed parser format","prompt":"If the format is undecided, ask_parent for the required choice. Otherwise implement the agreed parser format."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_answer","arguments":{"agent":"alpha","question_id":"<INVALID_QUESTION_ID>","answer":"Use the existing format; preserve compatibility."}},
  {"tool":"agent_spawn","arguments":{"agent":"beta","profile":"worker","reasoning_difficulty":3,"label":"Review completed parser changes","prompt":"Review the completed parser work and report remaining risks; do not edit.","after":["alpha"]}},
  {"tool":"agent_wait","arguments":{"agents":["alpha","beta"],"wait_ms":300000}}
]
```

## 3. Reuse → read an older task → page that same result

Continue alpha's specific earlier work once it is idle. `max_turns: 32` applies
only to the follow-up. Read task 1 explicitly to get its first page after reuse.
If there is no `next_cursor`, omit the final call; otherwise copy it without
`task` and keep the same Agent.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":3,"label":"Investigate parser edge cases","prompt":"Investigate parser edge cases. Return detailed findings and evidence."}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_run","arguments":{"agent":"alpha","continues":"Parser edge-case findings in this conversation","label":"Prioritize remaining parser issue","prompt":"Continue that investigation: summarize the highest-priority remaining issue.","max_turns":32}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha","task":1,"max_chars":32}},
  {"tool":"agent_read","arguments":{"agent":"alpha","cursor":"<INVALID_RESULT_CURSOR>"}}
]
```

## 4. Declare scope → work/check → inspect

This task needs the existing parser file, claims it for editing and declares
where its build output goes. Inspect the returned command/result and blockers;
`checks` names planned work, not a test command or evidence of success.

```json
[
  {"tool":"agent_spawn","arguments":{"agent":"alpha","profile":"worker","reasoning_difficulty":2,"label":"Fix and verify parser","prompt":"Fix src/parser.ts and run only the assigned parser unit check. Report the exact command, result, platform/tool versions and any unrun checks. Do not install dependencies; if unavailable, report the blocker.","dispatch":{"required_paths":["src/parser.ts"],"ownership":["src/parser.ts"],"build_dir":"build","checks":["parser unit check"]}}},
  {"tool":"agent_wait","arguments":{"agents":["alpha"],"wait_ms":300000}},
  {"tool":"agent_read","arguments":{"agent":"alpha"}}
]
```

## Illustration: scout return_to

If alpha's settled question needs research, use its exact returned token
(`questionId` below) and give beta a separate research brief. The worker's
`instruction` says how to act on findings it hasn't seen yet. This spawn admits
the worker continuation too; on an early observation return, inspect the rows
and wait on alpha as needed. Don't send another answer for the accepted pair.

```ts
await agent_spawn({
  agent: "beta",
  profile: "scout",
  reasoning_difficulty: 2,
  label: "Correlate parser reference sources",
  prompt: "Compare local parser notes with the cited public documentation. Return concise, cited findings.",
  return_to: {
    agent: "alpha",
    question_id: questionId,
    instruction: "If the cited findings establish a compatible fix, implement it; otherwise ask_parent with the unresolved choice and evidence.",
  },
});
```

Use the returned handoff notice: full delivery can release beta automatically.
If delivery failed or omitted text, read the scout result explicitly and kill
the scout when done. If `return_to` can't use an existing answer allow, follow
its [permission guidance](tool-contract.md#scout-return_to).

## Guardrails and recovery

- To defer a repeating question, wait explicitly on other Agents. Canceling a
  wait doesn't cancel child work.
- To stop work but keep the conversation, call `agent_interrupt`, then wait/read
  for settlement. To free capacity when no further follow-up is planned, call
  `agent_kill` (which can precede `agent_spawn` in the same batch); only
  `agent_status: "released"` confirms release. If cleanup stays uncertain, tell
  the user rather than retrying.
- To inspect the roster without draining messages, use `agent_list({})`. For new
  work blocked by Off, ask the user to enable delegation.
