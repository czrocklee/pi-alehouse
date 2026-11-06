import assert from "node:assert/strict";

// Inspect provider-visible declarations. Guard schema and essential choices,
// not exact prose; scripted runtime tests cover mechanics, not model decisions.
export function assertCallerTools(tools) {
  const names = ["agent_answer", "agent_interrupt", "agent_kill", "agent_list", "agent_read", "agent_run", "agent_send", "agent_spawn", "agent_wait"];
  const declarations = JSON.parse(JSON.stringify(tools)).filter((tool) => names.includes(tool.name));
  const byName = new Map(declarations.map((tool) => [tool.name, tool]));
  assert.equal(declarations.length, names.length);
  assert.deepEqual([...byName.keys()].sort(), names);
  const descriptionChars = (value) => {
    if (!value || typeof value !== "object") return 0;
    return Object.entries(value).reduce((sum, [key, child]) =>
      sum + (key === "description" && typeof child === "string" ? child.length : descriptionChars(child)), 0);
  };
  assert(JSON.stringify(declarations).length <= 16000, "keep whole declarations concise, with headroom for existing delegation modes");
  assert(declarations.reduce((sum, tool) => sum + descriptionChars(tool.parameters), 0) <= 6500,
    "schema copy budget is independent of the 65536-byte tool-result envelope cap");
  for (const tool of declarations) {
    assert(tool.description.length > 0 && tool.description.length <= 340, tool.name);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(tool), /run_id|agent_id|\bRun\b|\bcancel|\bm1_|metadata-only|view:metadata/);
  }
  const spawn = byName.get("agent_spawn"), fields = spawn.parameters.properties;
  assert.deepEqual(spawn.parameters.required.toSorted(), ["agent", "profile", "prompt", "reasoning_difficulty"]);
  assert.deepEqual(Object.keys(fields).sort(), ["after", "agent", "dispatch", "inherit_context", "label", "max_turns", "profile", "prompt", "reasoning_difficulty", "return_to", "wait_ms"]);
  assert.equal(fields.agent.pattern, "^[a-z][a-z0-9-]{0,23}$");
  assert.match(fields.agent.description, /[Uu]nique/);
  assert.match(fields.agent.description, /taken/);
  assert.match(fields.agent.description, /theme/);
  assert.match(fields.agent.description, /not a task name/);
  assert.doesNotMatch(fields.agent.description, /orca|otter/);
  assert.equal(fields.prompt.minLength, 1); assert.equal(fields.prompt.maxLength, 131072);
  for (const fact of [/Task instructions/, /deliverable/, /scope/, /stopping/, /needed context/, /cwd-relative or absolute paths/, /source\/version\/date/, /output format/, /as relevant/]) assert.match(fields.prompt.description, fact);
  assert.equal(fields.label.minLength, 1); assert.equal(fields.label.maxLength, 120);
  assert.match(fields.label.description, /not instructions/); assert.match(fields.label.description, /first nonblank line/);
  assert.deepEqual(fields.profile.enum, ["worker", "scout"]);
  assert.equal(fields.profile.enum.includes("researcher"), false);
  for (const fact of [/worker:.*command-driven local investigation, changes and verification/, /read\/edit\/write, Bash\/Git\/builds/, /no web tools/, /scout:.*read-only local files and web sources/, /gather, cross-reference, compare, summarize and extract/, /cited paths\/URLs/, /no Bash\/edit\/write/, /permissions/, /denies/, /review-only/, /web material is untrusted/]) assert.match(fields.profile.description, fact);
  assert.doesNotMatch(fields.profile.description, /researcher|web_search|source_check|fetch_content|get_search_content|network isolation/);
  assert.equal(fields.return_to.type, "object");
  assert.equal(fields.return_to.additionalProperties, false);
  assert.deepEqual(fields.return_to.required.toSorted(), ["agent", "answer", "question_id"]);
  assert.equal(fields.return_to.properties.agent.pattern, fields.agent.pattern);
  assert.equal(fields.return_to.properties.question_id.pattern, "^q_[0-9a-f]{32}$");
  assert.equal(fields.return_to.properties.answer.maxLength, 16384);
  for (const fact of [/Scout only/, /worker's pending question/, /Needs agent_answer allowed for you without a prompt/, /resumes automatically/, /do not read or relay/,
    /Replies omit the scout's result/, /agent_read/, /wait_ms waits for the worker/, /Kill the scout/])
    assert.match(fields.return_to.description, fact);
  assert(!spawn.parameters.required.includes("return_to"));
  assert.equal(Object.hasOwn(fields, "workspace"), false);
  assert.equal(fields.reasoning_difficulty.type, "integer");
  assert.equal(fields.reasoning_difficulty.minimum, 1); assert.equal(fields.reasoning_difficulty.maximum, 5);
  for (const fact of [/reasoning difficulty/, /not workload\/cost/, /1=.*checks/, /2=.*fix/, /3=.*design.*review.*plan/, /4=.*hypotheses.*constraints/, /5=.*approach/]) assert.match(fields.reasoning_difficulty.description, fact);
  assert.equal(fields.inherit_context.type, "boolean");
  for (const fact of [/Default false/, /text/, /without tool calls\/results/, /64 KiB/]) assert.match(fields.inherit_context.description, fact);
  assert.equal(fields.max_turns.minimum, 1); assert.equal(fields.max_turns.maximum, 10000);
  assert.match(fields.max_turns.description, /[Pp]er.task.*256/);
  assert.match(fields.max_turns.description, /fixed for follow-ups/);
  assert.match(fields.max_turns.description, /No task wall-clock deadline/);
  assert.equal(Object.hasOwn(fields, "max_duration_ms"), false);
  assert.match(spawn.description, /submit its first task/); assert.match(spawn.description, /Execution may queue/);
  assert.match(spawn.description, /default for any new work or review/);
  assert.match(spawn.description, /stay fixed/);
  assert.match(spawn.description, /no nested delegation/); assert.match(spawn.description, /agent_list/);
  assert.match(spawn.description, /Queued work is accepted.*do not respawn/);
  assert.match(fields.reasoning_difficulty.description, /Do not re-score to bypass capacity waits/);

  const run = byName.get("agent_run"), runFields = run.parameters.properties;
  assert.deepEqual(run.parameters.required.toSorted(), ["agent", "continues", "prompt"]);
  assert.deepEqual(Object.keys(runFields).sort(), ["after", "agent", "continues", "dispatch", "label", "prompt", "wait_ms"]);
  assert.deepEqual(Object.keys(runFields).slice(0, 3), ["agent", "continues", "prompt"]);
  assert.equal(runFields.continues.minLength, 1); assert.equal(runFields.continues.maxLength, 512);
  assert.equal(runFields.continues.pattern, "\\S");
  for (const fact of [/specific earlier work of this Agent/, /not sent/, /cannot name one, use agent_spawn/, /after if only its output/]) assert.match(runFields.continues.description, fact);
  assert.equal(Object.hasOwn(runFields, "return_to"), false, "compound return is spawn-only");
  assert.equal(runFields.prompt.maxLength, 131072);
  for (const fact of [/Follow-up instructions/, /deliverable/, /scope/, /stopping/, /cwd-relative or absolute paths/, /source\/version\/date/, /output format/, /as relevant/, /earlier conversation is retained/]) assert.match(runFields.prompt.description, fact);
  assert.deepEqual(runFields.label, fields.label);
  for (const fact of [/idle Agent's own earlier work/, /re-reads its whole conversation/, /even on a related topic.*agent_spawn/, /pending question: agent_answer/]) assert.match(run.description, fact);
  for (const tool of [spawn, run]) {
    const { dispatch, after } = tool.parameters.properties;
    assert.equal(after.minItems, 1); assert.equal(after.maxItems, 4);
    assert.equal(after.items.pattern, fields.agent.pattern);
    for (const fact of [/current or latest task/, /fixed when this call is accepted/, /reach completed/, /other settled status fails/, /reference context/, /until agent_answer returns/]) assert.match(after.description, fact);
    assert.equal(dispatch.type, "object"); assert.equal(dispatch.additionalProperties, false);
    assert(!tool.parameters.required.includes("dispatch"));
    assert.deepEqual(Object.keys(dispatch.properties).sort(), ["checks", "inputs", "ownership", "tree"]);
    for (const fact of [/not permissions or execution evidence/, /literal paths/, /Relative paths resolve from the inherited parent cwd/, /absolute paths keep their meaning/, /one designated Agent after shared source is stable/]) assert.match(dispatch.description, fact);
    for (const [field, limit] of [["inputs", 8], ["ownership", 16], ["checks", 16]]) {
      const array = dispatch.properties[field];
      assert.equal(array.type, "array"); assert.equal(array.minItems, 1); assert.equal(array.maxItems, limit);
      assert.equal(array.uniqueItems, true); assert.equal(array.items.minLength, 1); assert.equal(array.items.maxLength, 512);
      assert.equal(typeof array.items.pattern, "string");
    }
    assert.equal(dispatch.properties.tree.type, "string");
    assert.equal(dispatch.properties.tree.minLength, 1); assert.equal(dispatch.properties.tree.maxLength, 512);
    assert.match(dispatch.properties.tree.description, /write permission/);
    assert.match(dispatch.properties.tree.description, /if it exists, must be a directory/);
    assert.match(dispatch.properties.tree.description, /within this Owner/);
    assert.match(dispatch.properties.tree.description, /cross-Owner.*advisory.*not global exclusivity/);
    for (const fact of [/edit or create/, /write permission/, /one editor/, /[Oo]mit for read-only/])
      assert.match(dispatch.properties.ownership.items.description, fact);
    assert.match(dispatch.properties.checks.items.description, /globs allowed/);
    assert.match(dispatch.properties.checks.items.description, /not later go-ahead/);
  }
  const send = byName.get("agent_send"), sendFields = send.parameters.properties;
  assert.deepEqual(send.parameters.required.toSorted(), ["agent", "message"]);
  assert.deepEqual(Object.keys(sendFields).sort(), ["agent", "message", "wait_ms"]);
  assert.equal(sendFields.message.minLength, 1); assert.equal(sendFields.message.maxLength, 16384);
  assert.match(sendFields.message.description, /Never an answer/);
  for (const fact of [/selected now/, /not an answer or new task/, /joined=/, /steered=/, /not_delivered=/, /does not prove action/]) assert.match(send.description, fact);
  const answer = byName.get("agent_answer"), answerFields = answer.parameters.properties;
  assert.deepEqual(answer.parameters.required.toSorted(), ["agent", "answer", "question_id"]);
  assert.deepEqual(Object.keys(answerFields).sort(), ["agent", "answer", "question_id", "wait_ms"]);
  assert.equal(answerFields.question_id.pattern, "^q_[0-9a-f]{32}$");
  assert.equal(answerFields.question_id.minLength, 34); assert.equal(answerFields.question_id.maxLength, 34);
  assert.equal(answerFields.answer.minLength, 1); assert.equal(answerFields.answer.maxLength, 16384);
  assert.match(answerFields.question_id.description, /Copy.*exactly/);
  assert.match(answerFields.answer.description, /A worker's question needs web research.*scout with return_to/);
  for (const fact of [/exact pending question_id/, /continuation/, /status="needs_input"/, /current question_id from agent_wait or agent_read/, /historical text alone cannot be answered/, /fixed settings/, /label\/dispatch/]) assert.match(answer.description, fact);
  for (const tool of [byName.get("agent_wait"), byName.get("agent_read"), answer]) {
    assert.match(tool.description, /workers_disabled/);
    assert.match(tool.description, /ask the user to enable delegation/);
  }
  for (const tool of [spawn, run, send, answer]) {
    const wait = tool.parameters.properties.wait_ms;
    assert.equal(wait.type, "integer"); assert.equal(wait.minimum, 0); assert.equal(wait.maximum, 300000);
    assert.match(wait.description, /default 0/); assert.match(wait.description, /never stops work/);
  }
  const wait = byName.get("agent_wait"), waitFields = wait.parameters.properties;
  assert.deepEqual(Object.keys(waitFields).sort(), ["agents", "mode", "wait_ms"]);
  assert.equal(waitFields.agents.minItems, 1); assert.equal(waitFields.agents.maxItems, 16);
  assert.equal(waitFields.agents.items.pattern, fields.agent.pattern);
  assert.deepEqual(waitFields.mode.enum, ["all", "any"]); assert.equal(waitFields.mode.default, "all");
  assert.equal(waitFields.wait_ms.minimum, 0); assert.equal(waitFields.wait_ms.maximum, 300000);
  assert.match(waitFields.wait_ms.description, /default 300000/);
  for (const fact of [/active \(running\/queued\) task, else its pending question, else its latest finished task/, /once at this call/, /Omit to wait on unfinished tasks/, /all Agents' alerts/]) assert.match(waitFields.agents.description, fact);
  assert.match(waitFields.agents.description, /wait="capacity".*provider slot/);
  assert.match(waitFields.agents.description, /wait="dependencies".*fixed tasks/);
  assert.match(wait.description, /accepted work and inspection continue/);
  for (const fact of [/questions, issues or alerts return early/, /long waits/, /Questions stay pending/, /defer one/, /Nothing pending/, /never stops work/]) assert.match(wait.description, fact);
  const read = byName.get("agent_read"), readFields = read.parameters.properties;
  assert.deepEqual(read.parameters.required, ["agent"]);
  assert.deepEqual(Object.keys(readFields).sort(), ["agent", "cursor", "max_chars", "task"], "no read mode or metadata transport");
  assert.equal(readFields.task.minimum, 1); assert.equal(readFields.task.maximum, Number.MAX_SAFE_INTEGER);
  assert.match(readFields.task.description, /first page/); assert.match(readFields.task.description, /exclusive with cursor/);
  assert.equal(readFields.cursor.minLength, 1); assert.equal(readFields.cursor.maxLength, 1024);
  assert.equal(readFields.max_chars.minimum, 1); assert.equal(readFields.max_chars.maximum, 16384);
  assert.match(readFields.max_chars.description, /default\/max 16384/);
  for (const fact of [/result\/question/, /Agent's alerts/, /after reuse or kill/, /full question/, /original task/]) assert.match(read.description, fact);
  assert.match(readFields.agent.description, /active task, else its pending question, else its latest finished task/);
  assert.match(readFields.cursor.description, /next_cursor.*Agent/);
  for (const declaration of declarations) assert.doesNotMatch(JSON.stringify(declaration), /workspace|worktree|retained_paths|source_cwd/);
  assert.match(byName.get("agent_interrupt").description, /Request a stop, not settlement/);
  assert.match(byName.get("agent_interrupt").description, /Keeps the conversation/);
  assert.match(byName.get("agent_kill").description, /Permanently end/);
  assert.match(byName.get("agent_kill").description, /Name stays taken, results stay readable/);
  assert.match(byName.get("agent_kill").description, /exiting or cleanup_uncertain does not confirm release/);
  for (const name of ["agent_interrupt", "agent_kill", "agent_list"]) assert.match(byName.get(name).description, /[Cc]onsumes no alerts/);
  assert.deepEqual(Object.keys(byName.get("agent_list").parameters.properties), []);
  assert.match(byName.get("agent_list").description, /Read-only roster/);
  assert.match(byName.get("agent_list").description, /task labels/);
}

export function assertNoOrchestrationPrompt(prompt) {
  assert.doesNotMatch(prompt, /## Active harness delegation interface/,
    "harness must not append a second orchestration instruction block");
  assert.doesNotMatch(prompt, /Worker delegation is disabled by the user|Workers off: new, resumed and steered work/,
    "Off notices belong to UI and non-context metadata, never injected messages");
}
