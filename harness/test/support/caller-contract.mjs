import assert from "node:assert/strict";

// Inspect serialized caller metadata, not source literals. Presence checks
// guard assembly; scripted runtime tests check mechanics, not model decisions.
export function assertCallerTools(tools) {
  const byName = new Map(JSON.parse(JSON.stringify(tools)).map((tool) => [tool.name, tool]));
  const spawn = byName.get("spawn_agent"), resume = byName.get("resume_agent");
  for (const tool of [spawn, resume]) {
    assert.equal(tool.parameters.additionalProperties, false);
    const fields = tool.parameters.properties;
    assert.match(fields.prompt.description, /Execution instructions for this Run/);
    assert.match(fields.description.description, /Run label.*Agent panel.*list_agents.*not execution instructions/);
    assert.match(fields.description.description, /fresh description on every Run, including resume/);
    assert.match(fields.wait_ms.description, /Interrupted waiting does not cancel/);
    assert.match(fields.max_duration_ms.description, /not proof of exit/);
    assert.match(fields.max_turns.description, /default 256.*partial result/);
  }
  assert.deepEqual(spawn.parameters.properties.profile.enum, ["editor", "reader"]);
  const profile = spawn.parameters.properties.profile.description;
  assert.match(profile, /reader: read\/review, no edit\/write or project writes/);
  assert.match(profile, /editor: authorized file edits.*Git mutations stay with the parent/);
  assert.match(profile, /permission-gated.*not OS sandboxes/);
  assert.equal("strength" in spawn.parameters.properties, false, "internal slots must not be caller-facing");
  assert.equal("difficulty" in resume.parameters.properties, false, "resume retains the original rating");
  assert(spawn.parameters.required.includes("difficulty"));
  const difficulty = spawn.parameters.properties.difficulty;
  assert.match(difficulty.description, /reasoning difficulty.*requirements in prompt/i);
  assert.match(difficulty.description, /1=clear method.*2=routine local analysis/);
  assert.match(difficulty.description, /3=independent investigation.*4=competing hypotheses.*5=exceptional problem/);
  assert.match(difficulty.description, /Do not adjust the score for workload, importance, cost,.*routing\/configuration errors/);
  assert.doesNotMatch(difficulty.description, /light|standard|strong|slot/i);
  const nickname = spawn.parameters.properties.name.description;
  assert.match(nickname, /task-independent nickname.*one theme per session.*distinct name per Agent.*kept on reuse/);
  assert.match(nickname, /orca, not orca-windows-foundations/);
  assert.match(nickname, /no project, platform or task suffixes.*description/);
  assert.equal("name" in resume.parameters.properties, false, "resume cannot rename the Agent");
  assert.match(spawn.parameters.properties.inherit_context.description, /Default false.*64 KiB.*not.*full history fork/);
  assert.match(spawn.description, /allocates resources from difficulty/);
  assert.equal("effort" in spawn.parameters.properties, false, "effort belongs to user routing, not model tool arguments");
  assert.match(spawn.description, /share the parent's cwd and checkout without isolation/);
  assert.match(spawn.description, /local tools only, no web or nested delegation/);
  assert.match(spawn.description, /same tool-call ID.*unchanged task fields.*fresh call can duplicate/);
  assert.match(resume.description, /Retains conversation.*settings fixed.*answer_to_run_id, not steer_run/);
  assert.match(resume.description, /Keep the nickname.*fresh current-task description on every resume/);
  assert.match(resume.parameters.properties.answer_to_run_id.description, /answer in prompt.*agent_id.*Run's Agent/);
  assert.match(byName.get("wait_runs").description, /pending_run_ids.*timeout\/interrupted neither means completion nor cancels work/);
  assert.match(byName.get("wait_runs").description, /Progress is coalesced, not a wake-up; timeout\/interruption claims none/);
  assert.match(byName.get("wait_runs").description, /Background completion does not start a parent turn/);
  assert.match(byName.get("list_agents").description, /No roster is automatically injected after compaction/);
  assert.match(byName.get("release_agent").description, /Releasing all Agents does not close the Owner/);
  assert.match(byName.get("release_agent").description, /replacement requires confirmed Owner closure.*reload with an open Owner is unsupported/);
  assert.match(byName.get("read_run").description, /complete refers to output coverage, not task success/);
  for (const tool of byName.values()) assert.doesNotMatch(tool.description, /prefer the default timeout|extra get\b/);
}

export function assertNoOrchestrationPrompt(prompt) {
  assert.doesNotMatch(prompt, /## Active harness delegation interface/,
    "harness must not append a second orchestration instruction block");
  assert.doesNotMatch(prompt, /Worker delegation is disabled by the user|Workers off: new, resumed and steered work/,
    "Off notices belong to UI and non-context metadata, never injected messages");
}
