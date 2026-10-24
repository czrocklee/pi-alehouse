import assert from "node:assert/strict";

// Inspect serialized caller metadata, not source literals. Presence checks
// guard assembly; scripted runtime tests check mechanics, not model decisions.
export function assertCallerTools(tools) {
  const names = ["agent_answer", "agent_interrupt", "agent_kill", "agent_list", "agent_read", "agent_run", "agent_send", "agent_spawn", "agent_wait"];
  // Provider-visible lists also carry built-in and other extensions' tools.
  const byName = new Map(JSON.parse(JSON.stringify(tools)).filter((tool) => names.includes(tool.name)).map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()].sort(), names);
  assert([...byName.values()].reduce((sum, tool) => sum + tool.description.length, 0) <= 3600,
    "keep the nine tool descriptions concise; change this budget deliberately");
  for (const tool of byName.values()) {
    assert(tool.description.length <= 600, `${tool.name} description exceeds its copy budget`);
    assert.equal(tool.parameters.additionalProperties, false);
    const serialized = JSON.stringify(tool);
    assert.doesNotMatch(serialized, /run_id|agent_id|\bRun\b|\bcancel/, `${tool.name} exposes no internal IDs or Run/cancel vocabulary`);
  }
  const spawn = byName.get("agent_spawn"), fields = spawn.parameters.properties;
  assert.deepEqual(spawn.parameters.required.sort(), ["agent", "profile", "prompt", "reasoning_difficulty"]);
  assert.match(fields.agent.description, /Short nickname from one theme.*not a task name\. Never reused/);
  assert.doesNotMatch(fields.agent.description, /orca|otter/, "example names get copied into every session");
  assert.match(fields.prompt.description, /deliverable, scope, stopping conditions and full paths.*referenced file\/document/);
  assert.match(fields.prompt.description, /context not supplied by inherit_context or after/);
  assert.match(fields.label.description, /agent_list label, not instructions.*prompt's first line/);
  assert.deepEqual(fields.profile.enum, ["editor", "reader", "researcher"]);
  assert.match(fields.profile.description, /reader: project reads; built-in write only in runtime-assigned scratch, not Bash writes or arbitrary \/tmp paths; no edit\/web.*Builds and project edits need editor/);
  assert.doesNotMatch(fields.profile.description, /output root/i, "the generic trusted output-roots mechanism is retired");
  assert.match(fields.profile.description, /editor: scoped edit\/write.*researcher: web search\/fetch and read-only file tools; no Bash\/edits.*untrusted.*Git mutations stay with you/);
  assert.match(fields.profile.description, /permission-gated; profiles are not OS sandboxes/);
  const difficulty = fields.reasoning_difficulty.description;
  assert.equal(fields.reasoning_difficulty.type, "integer");
  assert.equal(fields.reasoning_difficulty.minimum, 1); assert.equal(fields.reasoning_difficulty.maximum, 5);
  assert.equal(Object.hasOwn(fields, "difficulty"), false, "the legacy score parameter is not a provider-visible alias");
  assert.match(difficulty, /Selects the Agent's fixed model/);
  assert.match(difficulty, /Rate task reasoning, not workload, importance or cost/);
  assert.match(difficulty, /1=execute given checks or decided changes.*2=small, scoped fix\/check.*3=implement a given design, review, investigate or plan.*4=resolve competing hypotheses or complex constraints.*5=find an approach where none is known/);
  assert.doesNotMatch(difficulty, /light|standard|strong|slot/i);
  assert.match(difficulty, /Do not re-score to bypass capacity waits/);
  assert.match(fields.inherit_context.description, /Default false.*text copy.*without tool calls or results.*64 KiB/);
  assert.match(fields.after.description, /All must complete.*question, failure or interrupt fails this task before starting.*admission rejects/);
  assert.match(fields.after.description, /current or latest tasks now.*16384 characters.*reference only.*name its Agent after agent_answer returns/);
  assert.match(fields.wait_ms.description, /accepted task, question, issue or alerts.*Default 0.*snapshot.*Timeout never stops/);
  assert.match(fields.wait_ms.description, /Queued wait: dependencies or capacity.*do not respawn queued work/);
  assert.match(fields.max_turns.description, /per task, default 256.*partial result/);
  assert.match(fields.max_duration_ms.description, /per task.*asked to stop/);
  for (const key of ["model", "effort", "strength", "thinking", "name", "description", "message", "difficulty"]) assert.equal(key in fields, false, key);
  assert.match(spawn.description, /Shared checkout, no isolation or delegation/);
  assert.match(spawn.description, /Spawn for new work\/reviews or different settings; agent_run is for that Agent's follow-ups/);
  assert.match(spawn.description, /Model, profile, reasoning difficulty, context and per-task budgets are fixed/);
  assert.match(spawn.description, /Queued work counts toward capacity.*kill finished reviewers\/accepted work first.*keep editors awaiting build\/test fixes/);
  assert.match(spawn.description, /check agent_list before repeating/);
  assert.match(spawn.description, /action, reason, agents, alerts; alerts do not mean completion/);
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
    assert.match(dispatch.description, /not permissions or execution evidence.*tool gates still apply.*full-suite validation explicitly to one task/);
    for (const [field, limit] of [["inputs", 8], ["ownership", 16], ["checks", 16]]) {
      const array = dispatch.properties[field];
      assert.equal(array.type, "array"); assert.equal(array.minItems, 1); assert.equal(array.maxItems, limit);
      assert.equal(array.uniqueItems, true); assert.equal(array.items.minLength, 1); assert.equal(array.items.maxLength, 512);
      assert.equal(typeof array.items.pattern, "string");
    }
    assert.equal(dispatch.properties.tree.type, "string"); assert.equal(dispatch.properties.tree.minLength, 1);
    assert.equal(dispatch.properties.tree.maxLength, 512);
    assert.match(dispatch.description, /Paths are literal.*no surrounding whitespace, shell expansion, globs, quotes, controls, \$, backslash or leading ~\/@/);
    assert.match(dispatch.properties.checks.items.description, /globs allowed.*prove no execution and skip no gate/);
    assert.match(dispatch.properties.checks.items.description, /finish without later go-ahead.*follow-up agent_run/);
    assert.match(dispatch.properties.tree.description, /Build-tree.*need write capability.*path_write.*Unfinished overlaps in this session reject/);
    assert.match(dispatch.properties.tree.description, /Other sessions only produce a tree_shared note; execution still starts/);
    assert.match(dispatch.properties.tree.description, /commands, other hosts and agent directories are not coordinated.*Omission neither forbids builds nor makes sharing safe.*no note does not prove a free tree/);
    assert.match(dispatch.properties.ownership.items.description, /Assign each shared file to one task; others report needed changes/);
    assert.match(dispatch.properties.ownership.items.description, /Reader scratch is runtime-assigned, not granted here/);
  }
  assert.match(run.description, /idle Agent a follow-up to its own work.*running Agent is busy.*agent_send or agent_wait.*Pending questions require agent_answer/);
  assert.match(run.description, /Each turn re-reads its conversation \(context_tokens\).*agent_spawn for new\/unrelated work or different settings/);
  assert.match(run.description, /Model\/profile\/reasoning difficulty\/budgets stay fixed despite routing changes/);
  assert.match(run.description, /Waits up to 30 s for an ending task/);
  assert.equal(runFields.builds_on.minLength, 1); assert.equal(runFields.builds_on.maxLength, 512);
  assert.match(runFields.builds_on.description, /earlier work of this Agent that the task continues; not sent to the Agent.*If none, spawn instead.*only its result is needed.*agent_spawn with after/);
  const send = byName.get("agent_send"), sendFields = send.parameters.properties;
  assert.deepEqual(send.parameters.required.sort(), ["agent", "message"]);
  assert.deepEqual(Object.keys(sendFields).sort(), ["agent", "message", "wait_ms"], "a message has no task fields");
  assert.equal(sendFields.message.maxLength, 16384);
  assert.match(sendFields.message.description, /Never an answer \(use agent_answer\) or another task/);
  assert.doesNotMatch(sendFields.message.description, /agent_run/, "another task is a spawn decision, not a run");
  assert.match(send.description, /task selected now, never a later task.*action.delivery: joined=.*steered=.*not_delivered=/);
  assert.match(send.description, /Not an answer or new task: use agent_answer, agent_spawn, or agent_run for follow-ups/);
  assert.doesNotMatch(send.description, /delivery.*answered\b/);
  const answer = byName.get("agent_answer"), answerFields = answer.parameters.properties;
  assert.deepEqual(answer.parameters.required.sort(), ["agent", "answer", "question_id"]);
  assert.deepEqual(Object.keys(answerFields).sort(), ["agent", "answer", "question_id", "wait_ms"]);
  assert.equal(answerFields.question_id.pattern, "^q_[0-9a-f]{32}$");
  assert.equal(answerFields.question_id.minLength, 34); assert.equal(answerFields.question_id.maxLength, 34);
  assert.equal(answerFields.answer.minLength, 1); assert.equal(answerFields.answer.maxLength, 16384);
  assert.match(answerFields.question_id.description, /Copy question_id exactly.*never derive it from an Agent name or task number/);
  assert.match(answer.description, /exact pending question_id.*continuation.*settled needs_input.*idle, reusable Agent.*stale\/reserved IDs fail, never redirect/);
  assert.match(answer.description, /workers_disabled.*user to enable delegation first/);
  assert.match(answer.description, /Keeps original model\/settings\/budgets despite routing changes.*asking task's label\/dispatch/);
  for (const tool of [spawn, run, send, answer]) {
    assert.equal(tool.parameters.properties.wait_ms.minimum, 0);
    assert.equal(tool.parameters.properties.wait_ms.maximum, 300000);
  }
  const wait = byName.get("agent_wait"), waitFields = wait.parameters.properties;
  assert.equal(waitFields.agents.maxItems, 16);
  assert.equal(waitFields.wait_ms.maximum, 300000);
  assert.equal(waitFields.mode.default, "all");
  assert.match(wait.description, /Wait on tasks selected now/);
  assert.match(wait.description, /question, task issue, harness fault or scoped alert.*completion may leave alerts pending/);
  assert.match(wait.description, /Complete displayed FIFO-prefix alerts are consumed/);
  assert.match(wait.description, /Questions remain pending until answered.*name other agents to defer one and narrow alert scope/);
  assert.match(waitFields.agents.description, /current task, else pending-question task, else latest.*alerts span all its tasks.*unfinished tasks, answerable questions when enabled.*all Agents' alerts including old\/killed sources.*Selection stays fixed/);
  assert.match(waitFields.mode.description, /all \(default\).*every selected task.*any: one.*already ended.*may return sooner/);
  assert.match(wait.description, /workers_disabled blocks new tasks, steering and answers.*user to enable delegation/);
  assert.match(wait.description, /Prefer long waits to polling; questions\/issues\/alerts return early/);
  assert.match(wait.description, /Timeout\/abort never stops workers/);
  const read = byName.get("agent_read"), readFields = read.parameters.properties;
  assert.match(read.description, /Full question first.*alerts span this Agent's tasks, independent of the page cursor.*Unshown alerts stay pending.*Keep next_cursor.*original result after reuse/);
  assert.match(readFields.agent.description, /Current task, else pending-question task, else latest.*cursor selects its original task.*question_truncated/);
  assert.match(readFields.max_chars.description, /result_omitted\/result_truncated.*omitted_chars is text never retained/);
  assert.match(readFields.cursor.description, /Copy next_cursor exactly with the Agent it came from.*continues that task's result after reuse/);
  assert.match(read.description, /workers_disabled.*enable delegation before agent_answer/);
  for (const tool of [answer, wait, read]) assert.doesNotMatch(JSON.stringify(tool), /\bOwner\b|\bbound\b|\binbox\b/);
  assert.match(byName.get("agent_interrupt").description, /Request a stop, not confirmed settlement.*completed, failed or needs_input.*Confirm with agent_wait or agent_read.*conversation remains.*agent_answer.*agent_run for follow-ups/);
  for (const name of ["agent_interrupt", "agent_kill", "agent_list"]) assert.match(byName.get(name).description, /[Nn]o pending alerts or completion notices/, name);
  assert.match(byName.get("agent_kill").description, /Permanently end an Agent.*interrupt its task.*Name stays taken, results readable, old alerts pending.*killed; exiting=cleanup continues; cleanup_uncertain=release unconfirmed, no retry/);
  assert.match(byName.get("agent_list").description, /Read-only roster.*has_question means currently pending.*question_id.*agent_answer when enabled/);
  assert.match(byName.get("agent_list").description, /unavailable is boolean; unavailable_reason gives diagnostics/);
  assert.match(byName.get("agent_list").description, /bounded history: earlier labels, context_tokens, successful edit\/write paths \(not Bash changes\)/);
  assert.doesNotMatch(byName.get("agent_list").description, /\bcost\b|idle/, "the roster shows no spend or idle time");
  // Host contract terms the model has no definition for.
  for (const tool of byName.values()) assert.doesNotMatch(JSON.stringify(tool), /prefer the default timeout|extra get\b|progress_omitted|finished_omitted|finished reminders|exit evidence|projection|starting offset/);
}

export function assertNoOrchestrationPrompt(prompt) {
  assert.doesNotMatch(prompt, /## Active harness delegation interface/,
    "harness must not append a second orchestration instruction block");
  assert.doesNotMatch(prompt, /Worker delegation is disabled by the user|Workers off: new, resumed and steered work/,
    "Off notices belong to UI and non-context metadata, never injected messages");
}
