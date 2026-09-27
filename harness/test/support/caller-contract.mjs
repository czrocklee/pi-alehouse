import assert from "node:assert/strict";

// Inspect serialized caller metadata, not source literals. Presence checks
// guard assembly; scripted runtime tests check mechanics, not model decisions.
export function assertCallerTools(tools) {
  const names = ["agent_interrupt", "agent_kill", "agent_list", "agent_read", "agent_run", "agent_send", "agent_spawn", "agent_wait"];
  // Provider-visible lists also carry built-in and other extensions' tools.
  const byName = new Map(JSON.parse(JSON.stringify(tools)).filter((tool) => names.includes(tool.name)).map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()].sort(), names);
  for (const tool of byName.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    const serialized = JSON.stringify(tool);
    assert.doesNotMatch(serialized, /run_id|agent_id|\bRun\b|\bcancel/, `${tool.name} exposes no internal IDs or Run/cancel vocabulary`);
  }
  const spawn = byName.get("agent_spawn"), fields = spawn.parameters.properties;
  assert.deepEqual(spawn.parameters.required.sort(), ["agent", "difficulty", "profile", "prompt"]);
  assert.match(fields.agent.description, /short nickname, one theme per session.*not a task name. Never reused/);
  assert.match(fields.prompt.description, /Complete instructions/);
  assert.match(fields.label.description, /agent_list, not instructions. Default: the prompt's first line/);
  assert.deepEqual(fields.profile.enum, ["editor", "reader"]);
  assert.match(fields.profile.description, /reader:.*cannot edit files; editor: may edit files. Git mutations stay with you/);
  assert.match(fields.profile.description, /permission-gated; neither profile is an OS sandbox/);
  const difficulty = fields.difficulty.description;
  assert.match(difficulty, /Picks the Agent's model; fixed for its lifetime/);
  assert.match(difficulty, /1=clear method.*2=routine local analysis.*3=independent investigation.*4=competing hypotheses.*5=no established approach/);
  assert.match(difficulty, /Not workload, importance or cost/);
  assert.doesNotMatch(difficulty, /light|standard|strong|slot/i);
  assert.match(fields.inherit_context.description, /Default false.*text copy.*without tool calls or results.*64 KiB/);
  assert.match(fields.after.description, /must complete first.*reference, not instructions.*\(question, failure, interrupt\).*fails without starting/);
  assert.match(fields.wait_ms.description, /finish or ask. Default 0.*never interrupts/);
  assert.match(fields.max_turns.description, /per task, default 256.*partial result/);
  assert.match(fields.max_duration_ms.description, /per task.*asked to stop/);
  for (const key of ["model", "effort", "strength", "thinking", "name", "description", "message"]) assert.equal(key in fields, false, key);
  assert.match(spawn.description, /share your checkout without isolation.*no web, no delegation/);
  assert.match(spawn.description, /ends its task with a question \(needs_input\); answer it with agent_send/);
  assert.match(spawn.description, /Capacity is limited: kill idle Agents/);
  assert.match(spawn.description, /check agent_list before repeating it/);
  assert.match(spawn.description, /Give an existing Agent its next task with agent_run/);
  const run = byName.get("agent_run"), runFields = run.parameters.properties;
  assert.deepEqual(run.parameters.required.sort(), ["agent", "prompt"]);
  assert.deepEqual(Object.keys(runFields).sort(), ["after", "agent", "label", "prompt", "wait_ms"],
    "profile, difficulty, context and budgets belong to the Agent");
  assert.match(run.description, /existing, idle Agent its next task.*A running Agent is busy: add to its task with agent_send.*unanswered question must be answered with agent_send/);
  const send = byName.get("agent_send"), sendFields = send.parameters.properties;
  assert.deepEqual(send.parameters.required.sort(), ["agent", "message"]);
  assert.deepEqual(Object.keys(sendFields).sort(), ["agent", "message", "wait_ms"], "a message has no task fields");
  assert.equal(sendFields.message.maxLength, 16384);
  assert.match(send.description, /current task, as it is when you call.*steered.*joined.*answered.*not_delivered, the task had ended, so nothing was sent/);
  assert.match(send.description, /Never starts other work: use agent_run/);
  const wait = byName.get("agent_wait").description;
  assert.match(wait, /all \(default\).*early when one asks, fails, is interrupted or hits its turn limit/);
  assert.match(wait, /one long wait beats many short ones/);
  assert.match(wait, /Timing out never interrupts tasks. Results never arrive on their own/);
  assert.match(byName.get("agent_read").description, /next_cursor.*omitted_chars were too long to keep/);
  assert.match(byName.get("agent_interrupt").description, /keeps its conversation, so agent_run can redirect it/);
  assert.match(byName.get("agent_kill").description, /permanently, interrupting any task.*never reused.*killed; exiting.*cleanup_uncertain/);
  assert.match(byName.get("agent_list").description, /Nothing is pushed to you/);
  for (const tool of byName.values()) assert.doesNotMatch(tool.description, /jargon|not proof of exit|never retained|routing\/configuration/);
  for (const tool of byName.values()) assert.doesNotMatch(tool.description, /prefer the default timeout|extra get\b/);
}

export function assertNoOrchestrationPrompt(prompt) {
  assert.doesNotMatch(prompt, /## Active harness delegation interface/,
    "harness must not append a second orchestration instruction block");
  assert.doesNotMatch(prompt, /Worker delegation is disabled by the user|Workers off: new, resumed and steered work/,
    "Off notices belong to UI and non-context metadata, never injected messages");
}
