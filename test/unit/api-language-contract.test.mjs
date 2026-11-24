import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  agentInterruptDescription,
  agentKillDescription,
  agentReadDescription,
  agentRunDescription,
  agentWaitDescription,
  answerSchema,
  checkParentToolArguments,
  readSchema,
  runSchema,
  sendSchema,
  spawnSchema,
  waitSchema,
} from "../../dist/orchestration/tools/parent-schemas.js";
import { humanSteerLead } from "../../dist/orchestration/presentation/human-steer-text.js";

const spawn = {
  agent: "pine",
  prompt: "Review the local parser.",
  label: "检查解析器边界",
  profile: "worker",
  reasoning_difficulty: 3,
};
const follow = {
  agent: "pine",
  continues: "The parser edge-case review",
  prompt: "Continue the review.",
  label: "复查解析器",
};

test("schema defaults describe actual defaults, not a reused Agent's inherited turn budget", () => {
  for (const schema of [spawnSchema, runSchema, sendSchema, answerSchema])
    assert.equal(schema.properties.wait_ms.default, 0);
  assert.equal(waitSchema.properties.wait_ms.default, 300000);
  assert.equal(readSchema.properties.max_chars.default, 16384);
  assert.equal(spawnSchema.properties.inherit_context.default, false);
  assert.equal(spawnSchema.properties.max_turns.default, 256);
  assert.equal(Object.hasOwn(runSchema.properties.max_turns, "default"), false);
});

test("task titles admit non-English short phrases without an English word-count rule", () => {
  for (const [name, schema, args] of [
    ["agent_spawn", spawnSchema, spawn],
    ["agent_run", runSchema, follow],
  ]) {
    assert.deepEqual(checkParentToolArguments(name, schema, args), args);
    assert.doesNotMatch(schema.properties.label.description, /3[–-]8|word/);
    assert.match(schema.properties.label.description, /language/);
  }
});

test("continues remains required reasoning text, not child-facing input", () => {
  const args = { ...follow, continues: `Earlier investigation mentioning ${humanSteerLead}` };
  assert.deepEqual(checkParentToolArguments("agent_run", runSchema, args), args);
  const { continues: _omitted, ...missing } = follow;
  assert.throws(
    () => checkParentToolArguments("agent_run", runSchema, missing),
    (error) => error.code === "INVALID_PARAMETERS" && error.details.key === "continues",
  );
  assert.throws(
    () => checkParentToolArguments("agent_run", runSchema, { ...follow, prompt: humanSteerLead }),
    (error) => error.code === "INVALID_PARAMETERS" && error.details.key === "prompt",
  );
});

test("after rejects duplicates in schema while wait keeps its documented name deduplication", () => {
  const duplicates = ["oak", "oak"];
  assert.equal(Check(spawnSchema, { ...spawn, after: duplicates }), false);
  assert.throws(
    () => checkParentToolArguments("agent_spawn", spawnSchema, { ...spawn, after: duplicates }),
    (error) => error.code === "INVALID_PARAMETERS" && error.details.key === "after",
  );
  assert.equal(Check(waitSchema, { agents: duplicates }), true);
  assert.match(waitSchema.properties.agents.description, /Duplicate names are ignored/);
});

test("literal path restrictions retain exact diagnostics after passing the wire shape", () => {
  for (const path of ["app/[id]/page.tsx", "~/src", "@scope", "*.ts", " source "]) {
    const args = { ...spawn, dispatch: { required_paths: [path] } };
    assert.equal(Check(spawnSchema, args), true);
    assert.throws(
      () => checkParentToolArguments("agent_spawn", spawnSchema, args),
      (error) =>
        error.code === "INVALID_DISPATCH" &&
        error.details.key === "dispatch.required_paths.0" &&
        /literal path/.test(error.details.resolution),
    );
  }
  assert.equal(Check(spawnSchema, { ...spawn, dispatch: { required_paths: ["source\n"] } }), false);
});

test("observation and nonconsuming tools state their distinct communication effects", () => {
  assert.match(agentReadDescription, /this Agent's alerts and Owner-wide completion notices shown/);
  assert.match(agentWaitDescription, /Owner-wide completion notices shown/);
  assert.match(agentWaitDescription, /Returns immediately if nothing is pending/);
  for (const description of [agentInterruptDescription, agentKillDescription])
    assert.match(description, /no alerts or completion notices/);
  for (const schema of [spawnSchema, runSchema])
    assert.match(schema.properties.max_turns.description, /[Ss]oft turn budget/);
  assert.match(spawnSchema.properties.max_turns.description, /configurable grace/);
  assert.match(
    spawnSchema.properties.after.description,
    /completed with limit_reached still passes/,
  );
  assert.match(agentKillDescription, /free its slot when no further follow-up is planned/);
  assert.match(agentKillDescription, /precede agent_spawn in the same batch/);
  assert.match(
    runSchema.properties.continues.description,
    /[Ss]pecific earlier work in this Agent's context that this task builds on/,
  );
  assert.match(agentRunDescription, /Continue or iterate on an idle Agent's own earlier work/);
  assert.match(agentRunDescription, /New work \(even on a related topic or role\)/);
});
