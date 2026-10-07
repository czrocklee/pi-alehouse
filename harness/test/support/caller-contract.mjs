import assert from "node:assert/strict";

// Inspect serialized caller metadata, not source literals. Presence checks
// guard assembly; scripted runtime tests check mechanics, not model decisions.
export function assertCallerTools(tools) {
  const names = ["agent_answer", "agent_interrupt", "agent_kill", "agent_list", "agent_read", "agent_run", "agent_send", "agent_spawn", "agent_wait"];
  // Provider-visible lists also carry built-in and other extensions' tools.
  const byName = new Map(JSON.parse(JSON.stringify(tools)).filter((tool) => names.includes(tool.name)).map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()].sort(), names);
  for (const tool of byName.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    const serialized = JSON.stringify(tool);
    assert.doesNotMatch(serialized, /run_id|agent_id|\bRun\b|\bcancel/, `${tool.name} exposes no internal IDs or Run/cancel vocabulary`);
  }
  const spawn = byName.get("agent_spawn"), fields = spawn.parameters.properties;
  assert.deepEqual(spawn.parameters.required.sort(), ["agent", "profile", "prompt", "reasoning_difficulty"]);
  assert.match(fields.agent.description, /short nickname from one theme you choose for this session, not a task name. Never reused/);
  assert.doesNotMatch(fields.agent.description, /orca|otter/, "example names get copied into every session");
  assert.match(fields.prompt.description, /Complete instructions/);
  assert.match(fields.label.description, /agent_list, not instructions. Default: the prompt's first line/);
  assert.deepEqual(fields.profile.enum, ["editor", "reader", "researcher"]);
  assert.match(fields.profile.description, /reader:.*cannot edit files; editor: may edit files; researcher: web search and fetch.*no Bash or edits.*untrusted. Git mutations stay with you/);
  assert.match(fields.profile.description, /permission-gated; no profile is an OS sandbox/);
  const difficulty = fields.reasoning_difficulty.description;
  assert.equal(fields.reasoning_difficulty.type, "integer");
  assert.equal(fields.reasoning_difficulty.minimum, 1); assert.equal(fields.reasoning_difficulty.maximum, 5);
  assert.equal(Object.hasOwn(fields, "difficulty"), false, "the legacy score parameter is not a provider-visible alias");
  assert.match(difficulty, /Picks the Agent's model; fixed for its lifetime/);
  assert.match(difficulty, /not its workload, importance or cost, from easiest \(1\) to hardest \(5\)/);
  assert.match(difficulty, /1=run given checks or apply decided changes.*2=small, well-scoped fix or check.*3=implement a given design, review a change.*4=competing hypotheses or complex constraints.*5=no known approach/);
  assert.doesNotMatch(difficulty, /light|standard|strong|slot/i);
  assert.match(fields.inherit_context.description, /Default false.*text copy.*without tool calls or results.*64 KiB/);
  assert.match(fields.after.description, /must complete first.*reference, not instructions.*\(question, failure, interrupt\).*fails without starting/);
  assert.match(fields.wait_ms.description, /accepted task.*question.*issue.*alerts.*Default 0.*snapshot.*never interrupts/);
  assert.match(fields.max_turns.description, /per task, default 256.*partial result/);
  assert.match(fields.max_duration_ms.description, /per task.*asked to stop/);
  for (const key of ["model", "effort", "strength", "thinking", "name", "description", "message", "difficulty"]) assert.equal(key in fields, false, key);
  assert.match(spawn.description, /share your checkout without isolation, and cannot delegate. Only researcher Agents can use the web/);
  assert.match(spawn.description, /settled needs_input.*question_id.*answer it with agent_answer, never agent_send/);
  assert.match(spawn.description, /Spawn a fresh Agent for each new piece of work, including reviews and tasks needing another reasoning_difficulty; use agent_run only for a follow-up that builds on an Agent's earlier work/);
  assert.match(spawn.description, /Capacity is limited: kill finished Agents/);
  assert.match(spawn.description, /check agent_list before repeating it/);
  assert.match(spawn.description, /action, reason, agents and alerts/);
  const run = byName.get("agent_run"), runFields = run.parameters.properties;
  assert.deepEqual(run.parameters.required.sort(), ["agent", "builds_on", "prompt"]);
  assert.deepEqual(Object.keys(runFields).sort(), ["after", "agent", "builds_on", "dispatch", "label", "prompt", "wait_ms"],
    "profile, reasoning_difficulty, context and budgets belong to the Agent; dispatch belongs to each task");
  assert.deepEqual(Object.keys(runFields).slice(0, 3), ["agent", "builds_on", "prompt"], "the reuse reason comes before the prompt it justifies");
  for (const tool of [spawn, run]) {
    const dispatch = tool.parameters.properties.dispatch;
    assert.equal(dispatch.type, "object"); assert.equal(dispatch.additionalProperties, false);
    assert(!tool.parameters.required.includes("dispatch"));
    assert.deepEqual(Object.keys(dispatch.properties).sort(), ["checks", "inputs", "ownership", "tree"]);
    assert.match(dispatch.description, /not authorize tool calls.*full-suite validation explicitly to one task/);
    for (const [field, limit] of [["inputs", 8], ["ownership", 16], ["checks", 16]]) {
      const array = dispatch.properties[field];
      assert.equal(array.type, "array"); assert.equal(array.minItems, 1); assert.equal(array.maxItems, limit);
      assert.equal(array.uniqueItems, true); assert.equal(array.items.minLength, 1); assert.equal(array.items.maxLength, 512);
      assert.equal(typeof array.items.pattern, "string");
    }
    assert.equal(dispatch.properties.tree.type, "string"); assert.equal(dispatch.properties.tree.minLength, 1);
    assert.equal(dispatch.properties.tree.maxLength, 512);
    assert.match(dispatch.properties.checks.items.description, /globs allowed.*not evidence.*skip gates/);
  }
  assert.match(run.description, /existing, idle Agent a follow-up task that builds on its earlier work.*A running Agent is busy.*agent_send.*cannot bypass an unanswered question.*agent_answer/);
  assert.match(run.description, /re-reads that whole conversation \(context_tokens on its latest task\), while a fresh Agent starts from only your prompt, so for new or unrelated work spawn instead/);
  assert.equal(runFields.builds_on.minLength, 1); assert.equal(runFields.builds_on.maxLength, 512);
  assert.match(runFields.builds_on.description, /earlier work of this Agent that this task continues.*Not sent to the Agent. If nothing specific, or its result alone is enough \(spawn with after: \[agent\]\), use agent_spawn instead/);
  const send = byName.get("agent_send"), sendFields = send.parameters.properties;
  assert.deepEqual(send.parameters.required.sort(), ["agent", "message"]);
  assert.deepEqual(Object.keys(sendFields).sort(), ["agent", "message", "wait_ms"], "a message has no task fields");
  assert.equal(sendFields.message.maxLength, 16384);
  assert.match(sendFields.message.description, /Never an answer \(use agent_answer\) or another task/);
  assert.doesNotMatch(sendFields.message.description, /agent_run/, "another task is a spawn decision, not a run");
  assert.match(send.description, /target never drifts.*action.delivery is joined.*steered.*not_delivered/);
  assert.match(send.description, /Never answers a question or starts another task: use agent_answer for questions; agent_spawn for new work, agent_run for a follow-up/);
  assert.doesNotMatch(send.description, /delivery.*answered\b/);
  const answer = byName.get("agent_answer"), answerFields = answer.parameters.properties;
  assert.deepEqual(answer.parameters.required.sort(), ["agent", "answer", "question_id"]);
  assert.deepEqual(Object.keys(answerFields).sort(), ["agent", "answer", "question_id", "wait_ms"]);
  assert.equal(answerFields.question_id.pattern, "^q_[0-9a-f]{32}$");
  assert.equal(answerFields.question_id.minLength, 34); assert.equal(answerFields.question_id.maxLength, 34);
  assert.equal(answerFields.answer.minLength, 1); assert.equal(answerFields.answer.maxLength, 16384);
  assert.match(answerFields.question_id.description, /Copy question_id exactly.*never infer it from the Agent name or task number/);
  assert.match(answer.description, /pending question.*exact question_id.*next task.*finished needs_input.*idle and reusable.*Stale or reserved.*never redirect/);
  assert.match(answer.description, /workers_disabled.*enable delegation.*hidden tool/);
  for (const tool of [spawn, run, send, answer]) {
    assert.equal(tool.parameters.properties.wait_ms.minimum, 0);
    assert.equal(tool.parameters.properties.wait_ms.maximum, 300000);
  }
  const wait = byName.get("agent_wait"), waitFields = wait.parameters.properties;
  assert.equal(waitFields.agents.maxItems, 16);
  assert.equal(waitFields.wait_ms.maximum, 300000);
  assert.equal(waitFields.mode.default, "all");
  assert.match(wait.description, /tasks selected when called; selection stays fixed/);
  assert.match(wait.description, /question.*task issue.*harness fault.*alert.*Completion may leave alerts pending/);
  assert.match(wait.description, /Reading a question does not answer it/);
  assert.match(wait.description, /Unanswered questions return again.*to defer, set agents to other Agents.*also limits alerts to those Agents/);
  assert.match(waitFields.agents.description, /current, pending-question or latest tasks.*alerts from any of their tasks.*Omit for unfinished tasks.*answerable questions when delegation is enabled.*all Agents' alerts.*old\/killed tasks/);
  assert.match(waitFields.mode.description, /all \(default\).*every selected task.*any: one.*already ended.*may return sooner/);
  assert.match(wait.description, /workers_disabled allows inspection, not starting, steering or answering.*enable delegation/);
  assert.match(wait.description, /Timeout\/abort never interrupts workers/);
  const read = byName.get("agent_read"), readFields = read.parameters.properties;
  assert.match(read.description, /full question takes priority over alerts.*any task of this Agent.*separate from result pages.*Keep next_cursor.*original result after reuse/);
  assert.match(readFields.agent.description, /Current task, else pending-question task, else latest.*cursor selects its original task.*question_truncated/);
  assert.match(readFields.max_chars.description, /result_omitted\/result_truncated.*omitted_chars is text never retained/);
  assert.match(read.description, /workers_disabled.*enable delegation before answering with agent_answer/);
  for (const tool of [answer, wait, read]) assert.doesNotMatch(JSON.stringify(tool), /\bOwner\b|\bbound\b|\binbox\b/);
  assert.match(byName.get("agent_interrupt").description, /not exit evidence.*keeps its conversation.*agent_run.*consumes no alerts or finished/);
  assert.match(byName.get("agent_kill").description, /permanently, interrupting any task.*never reused.*alerts stay pending.*killed; exiting.*cleanup_uncertain/);
  assert.match(byName.get("agent_list").description, /Read-only roster.*has_question is current pending-question state, not a historical outcome.*question_id.*agent_answer/);
  assert.match(byName.get("agent_list").description, /unavailable is a boolean.*unavailable_reason.*never consume alerts or finished/);
  for (const tool of byName.values()) assert.doesNotMatch(tool.description, /prefer the default timeout|extra get\b|progress_omitted|finished_omitted/);
}

export function assertNoOrchestrationPrompt(prompt) {
  assert.doesNotMatch(prompt, /## Active harness delegation interface/,
    "harness must not append a second orchestration instruction block");
  assert.doesNotMatch(prompt, /Worker delegation is disabled by the user|Workers off: new, resumed and steered work/,
    "Off notices belong to UI and non-context metadata, never injected messages");
}
