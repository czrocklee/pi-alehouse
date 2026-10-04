import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { packCommunication } from "../../dist/core/communication-packer.js";

// Actual model schemas, checked/prepared arguments and tool action bodies.
// The core admission/IO boundary is a capture-only mock, not a claim/preflight,
// lifecycle, publication-commit or SDK acceptance test.
function adapter({ notes = false, pressure = false } = {}) {
  const state = { active: true }, submissions = [];
  const manager = { getSessionId: () => "owner" }, registry = {
    getAll: () => [{ provider: "fixture", id: "controlled", levels: ["off"] }],
  };
  const context = {
    get sessionManager() { if (!state.active) throw new Error("stale after publication"); return manager; },
    modelRegistry: registry, cwd: "/tmp", thinkingLevel: "off",
  };
  // Saturation must precede the optional warning phase: a complete mandatory
  // alert plus a worst-byte question, not a result that the warning outranks.
  const published = packCommunication({ reason: pressure ? "alert" : "snapshot", tasks: [{
    row: { agent: "otter", task: 1, status: pressure ? "needs_input" : "running", ...(pressure ? { has_question: true } : {}) }, settled: pressure,
    ...(pressure ? { question_id: `q_${"a".repeat(32)}`, question: "\0".repeat(8192),
      result: { text: "retained", offset: 0, retained_chars: 16384, total_chars: 16384,
        cursor: { owner: "owner", generation: "generation", run: "prior", version: "v" } } } : {}),
    ...(notes ? { time_wrapped: true, dispatch_notes: ["tree_shared", "tree_lock_unknown"] } : {}),
  }], alerts: pressure ? [{ agent: "otter", task: 1, label: "\0".repeat(120), message: "\0".repeat(8192) }] : [], finished: [] }).result;
  Object.freeze(published.content[0]); Object.freeze(published.content); Object.freeze(published);
  const controller = {
    identity: { owner_id: "owner", generation: "generation" },
    assertEffectAllowed() {}, validateObservationEntry(read) { return read(); },
    bindModelCommunication() {}, list: () => [], agentName: () => "orca",
    findAgent: (name) => name === "orca" ? { agent_id: "agent-id", run_id: "prior" } : undefined,
    view: () => ({ name: "orca", status: "completed", has_question: false,
      ...(notes ? { time_wrapped: true, dispatch_notes: ["tree_shared", "tree_lock_unknown"] } : {}) }),
    async submitPrepared(id, input, prepare) {
      submissions.push({ id, request: prepare(input) });
      return { run_id: "accepted", name: input.agent };
    },
    async observe() { state.active = false; return published; },
  };
  const preset = { name: "fixture", version: "v1", digest: "a".repeat(64),
    models: { d1: "fixture/controlled", d2: "fixture/controlled", d3: "fixture/controlled", d4: "fixture/controlled", d5: "fixture/controlled" },
    effort: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" },
    effort_defaults: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" }, effort_overrides: {},
  };
  const tools = createOwnerTools({ controller, context,
    profiles: Object.fromEntries(["reader", "editor", "researcher"].map((name) => [name, { definition: `${name} definition`, tools: ["read"] }])),
    getPreset: () => preset, getSupportedThinkingLevels: (model) => model.levels,
  });
  const tool = (name) => tools.find((value) => value.name === name);
  const args = (name, rest = {}) => name === "agent_spawn" ?
    { agent: "otter", prompt: "task", profile: "reader", reasoning_difficulty: 3, ...rest } : { agent: "orca", prompt: "task", ...rest };
  const execute = (name, raw, id = "dispatch") => tool(name).execute(id, raw, undefined, undefined, context);
  return { tool, args, execute, submissions, published, state };
}
const invalid = (error) => ["INVALID_PARAMETERS", "INVALID_DISPATCH"].includes(JSON.parse(error.message).error.code);

for (const name of ["agent_spawn", "agent_run"]) {
  test(`${name} publishes a closed optional dispatch schema with bounded declarations`, () => {
    const a = adapter(), tool = a.tool(name), schema = JSON.parse(JSON.stringify(tool.parameters));
    const dispatch = schema.properties.dispatch;
    assert.equal(dispatch.type, "object"); assert.equal(dispatch.additionalProperties, false);
    assert(!schema.required.includes("dispatch"));
    assert.deepEqual(Object.keys(dispatch.properties).sort(), ["checks", "inputs", "ownership", "tree"]);
    assert.equal(dispatch.properties.tree.maxLength, 512);
    for (const [field, count] of [["inputs", 8], ["ownership", 16], ["checks", 16]]) {
      const array = dispatch.properties[field];
      assert.equal(array.minItems, 1); assert.equal(array.maxItems, count); assert.equal(array.uniqueItems, true);
      assert.equal(array.items.type, "string"); assert.equal(array.items.minLength, 1); assert.equal(array.items.maxLength, 512);
    }
    for (const declaration of [{}, { inputs: ["input/space name.txt"] }, {
      inputs: Array.from({ length: 8 }, (_, i) => `input-${i}`),
      ownership: Array.from({ length: 16 }, (_, i) => `output-${i}`), tree: "new/build-tree",
      checks: Array.from({ length: 16 }, (_, i) => `test/${i}/**/*.test.mjs`),
    }, { ownership: ["x".repeat(512)], tree: "t".repeat(512), checks: ["c".repeat(512)] }]) {
      const raw = a.args(name, { dispatch: declaration });
      assert(Check(schema, JSON.parse(JSON.stringify(raw))), "provider-visible schema accepts the bounded roundtrip");
      const prepared = tool.prepareArguments(raw);
      assert.deepEqual(prepared, raw); assert.notEqual(prepared, raw); assert.notEqual(prepared.dispatch, declaration);
      if (declaration.inputs) assert.notEqual(prepared.dispatch.inputs, declaration.inputs);
    }
    assert.match(dispatch.description, /not authorize tool calls.*full-suite validation explicitly to one task/);
    assert.match(dispatch.properties.checks.items.description, /globs allowed.*not evidence.*skip gates/);
  });

  test(`${name} rejects malformed dispatch in BOTH preparation and direct execution before core admission`, async () => {
    const a = adapter();
    const declarations = [null, false, "path", [], { unknown: "field" },
      { inputs: [] }, { ownership: [] }, { checks: [] }, { inputs: ["same", "same"] },
      { tree: "" }, { tree: " " }, { tree: 4 }, { inputs: "not-array" }, { checks: [4] },
      { inputs: Array.from({ length: 9 }, (_, i) => `i${i}`) },
      { ownership: Array.from({ length: 17 }, (_, i) => `o${i}`) },
      { checks: Array.from({ length: 17 }, (_, i) => `c${i}`) },
      ...["inputs", "ownership", "checks"].map((key) => ({ [key]: ["x".repeat(513)] })),
      { tree: "x".repeat(513) }, { checks: ["test\nname"] }, { checks: ["test\n"] }, { checks: ["\0"] },
    ];
    const forbiddenPaths = ["*.ts", "src/?", "src/[ab]", "src/{a,b}", "'src/a'", '"src/a"', "`src/a`", "$HOME/file", "a\\b", "~/src", "@src", "a\0b", "a\tb", "a\nb", "ordinary.txt\n", "a\x7fb"];
    for (const path of forbiddenPaths) for (const field of ["inputs", "ownership", "tree"])
      declarations.push({ [field]: field === "tree" ? path : [path] });
    for (const dispatch of declarations) {
      const raw = a.args(name, { dispatch });
      assert.equal(Check(a.tool(name).parameters, raw), false, "provider-visible schema rejects this malformed declaration too");
      assert.throws(() => a.tool(name).prepareArguments(raw), invalid, JSON.stringify(dispatch));
      await assert.rejects(a.execute(name, raw), invalid, JSON.stringify(dispatch));
    }
    assert.deepEqual(a.submissions, [], "malformed declarations never reach the core preparer");
  });

  test(`${name} revalidates dispatch after hooks mutate prepared arguments`, async () => {
    const a = adapter(), raw = a.args(name, { dispatch: { inputs: ["ordinary.txt"], checks: ["test/**/*.mjs"] } });
    const prepared = a.tool(name).prepareArguments(raw);
    prepared.dispatch.inputs[0] = "*.secret";
    await assert.rejects(a.execute(name, prepared), invalid);
    assert.equal(raw.dispatch.inputs[0], "ordinary.txt", "prepare owns a detached copy");
    const changed = a.tool(name).prepareArguments(raw); changed.dispatch.unknown = "injected";
    await assert.rejects(a.execute(name, changed), invalid);
    assert.deepEqual(a.submissions, []);
  });

  test(`${name} forwards detached dispatch to SubmitRequest and returns the exact prepacked optional diagnostics`, async () => {
    const a = adapter({ notes: true }), declaration = { inputs: ["ordinary.txt"], ownership: ["new/output"], tree: "build", checks: ["test/**/*.mjs"] };
    const raw = a.args(name, { dispatch: declaration });
    const result = await a.execute(name, raw);
    assert.equal(result, a.published, "no reserialization, post-observe validation or optional-field append");
    assert(Object.isFrozen(result)); assert.equal(a.state.active, false, "context became stale inside observation");
    assert.equal(a.submissions.length, 1); assert.deepEqual(a.submissions[0].request.dispatch, declaration);
    assert.notEqual(a.submissions[0].request.dispatch, declaration);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.agents[0].time_wrapped, true);
    assert.deepEqual(parsed.agents[0].dispatch_notes, ["tree_shared", "tree_lock_unknown"]);
    declaration.inputs.push("late-mutation"); assert.deepEqual(a.submissions[0].request.dispatch.inputs, ["ordinary.txt"]);
  });

  test(`${name} never resurrects optional diagnostics displaced before observation publication`, async () => {
    const a = adapter({ notes: true, pressure: true }), before = a.published.content[0].text;
    const envelope = JSON.parse(before);
    assert.equal(envelope.response_limit_reached, true);
    assert.equal(envelope.reason, "alert"); assert.equal(envelope.alerts[0].message, "\0".repeat(8192));
    assert(envelope.agents[0].question.length > 0); assert.equal(envelope.agents[0].question_truncated, true);
    assert.equal(envelope.agents[0].next_cursor.length, 37, "the original omitted result remains addressable");
    assert.equal(envelope.agents[0].time_wrapped, undefined); assert.equal(envelope.agents[0].dispatch_notes, undefined);
    const result = await a.execute(name, a.args(name, { dispatch: { checks: ["test/**/*.mjs"] } }));
    assert.equal(result, a.published); assert.equal(result.content[0].text, before);
    assert(Object.isFrozen(result), "publication was frozen before the tool got it");
    assert.equal(a.state.active, false, "even retained view metadata cannot justify a post-observe projection or append");
  });

  test(`${name} without dispatch preserves the existing request and publication bytes`, async () => {
    const a = adapter(), raw = a.args(name), prepared = a.tool(name).prepareArguments(raw);
    assert.equal(JSON.stringify(prepared), JSON.stringify(raw));
    const result = await a.execute(name, prepared);
    assert.equal(result, a.published);
    assert(!Object.hasOwn(a.submissions[0].request, "dispatch"));
    assert.equal(result.content[0].text, '{"reason":"snapshot","agents":[{"agent":"otter","task":1,"status":"running"}],"pending":["otter"],"alerts_pending":0,"finished_pending":0}');
    if (name === "agent_run") assert.equal(JSON.stringify(a.submissions[0].request), '{"resume":"agent-id","prompt":"task","description":"task"}');
  });
}

test("answer has no dispatch parameter; continuation inheritance belongs to core", async () => {
  const a = adapter(), answer = a.tool("agent_answer"), raw = { agent: "orca", question_id: `q_${"a".repeat(32)}`, answer: "yes", dispatch: {} };
  assert(!Object.hasOwn(answer.parameters.properties, "dispatch"));
  assert.throws(() => answer.prepareArguments(raw), invalid);
  await assert.rejects(a.execute("agent_answer", raw), invalid);
  assert.deepEqual(a.submissions, []);
});
