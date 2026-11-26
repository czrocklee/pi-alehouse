// The pinned SDK validator (pi-schema + coercion) must preserve the
// orchestration tools' closed schemas and constraints before any admission/callback.
// Reads installed SDK package metadata only; no session, provider, credentials,
// network or filesystem tool IO is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createOwnerTools } from "../../dist/orchestration/tools/parent-tools.js";
import { createChildTools } from "../../dist/orchestration/tools/child-tools.js";
import { bindParentToolContext } from "../../dist/orchestration/tools/parent-tool-context.js";
import { PARENT_TEXT_LIMITS } from "../../dist/orchestration/tools/argument-limits.js";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);
const corePackageURL = pathToFileURL(
  sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"),
);
const corePackage = JSON.parse(readFileSync(corePackageURL, "utf8"));
assert.equal(corePackage.name, "@earendil-works/pi-agent-core");
assert.equal(corePackage.version, "1.6.1");
assert.equal(
  corePackage.exports["."].import,
  "./dist/index.js",
  "review a changed pinned SDK ESM entry",
);
const { runToolCall } = await import(new URL(corePackage.exports["."].import, corePackageURL));
const { wrapToolDefinitions } = await import(
  new URL("core/tools/tool-definition-wrapper.js", sdkEntry)
);
const sdkVersion = JSON.parse(readFileSync(new URL("../package.json", sdkEntry), "utf8")).version;
assert.equal(sdkVersion, "1.6.1");

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let callId = 0;
async function invoke(definition, args, context = {}, hooks = {}) {
  const id = `schema-${++callId}`;
  const toolCall = { type: "toolCall", id, name: definition.name, arguments: args };
  const assistantMessage = {
    role: "assistant",
    api: "fixture",
    provider: "fixture",
    model: "controlled",
    content: [toolCall],
    stopReason: "toolUse",
    usage,
    timestamp: 0,
  };
  const tools = wrapToolDefinitions([definition], () => context);
  return runToolCall(toolCall, {
    tools,
    assistantMessage,
    context: { messages: [assistantMessage], tools, ...context },
    ...hooks,
  });
}

function ownerToolFixture() {
  const ownerId = randomUUID(),
    generation = randomUUID();
  const manager = { getSessionId: () => ownerId },
    registry = {};
  let admissionEffects = 0;
  const actionEffects = { lookup: 0, delivery: 0, answer: 0, publication: 0 };
  const controller = {
    identity: { owner_id: ownerId, generation },
    assertEffectAllowed() {},
    validateObservationEntry: (read) => read(),
    bindModelCommunication() {},
    findAgent() {
      actionEffects.lookup++;
      return { agent_id: "fixture-agent", run_id: "fixture-run" };
    },
    send() {
      actionEffects.delivery++;
      throw new Error("invalid text reached send");
    },
    answer() {
      actionEffects.answer++;
      throw new Error("invalid text reached answer");
    },
    observe() {
      actionEffects.publication++;
      throw new Error("invalid text reached publication");
    },
    submitPrepared() {
      admissionEffects++;
      throw new Error("invalid parameters reached admission");
    },
  };
  const context = { sessionManager: manager, modelRegistry: registry, cwd: "/fixture" };
  const tools = createOwnerTools({
    controller,
    context,
    profiles: {
      editor: { definition: "editor", tools: ["read"] },
      researcher: { definition: "researcher", tools: ["read"] },
    },
    getSupportedThinkingLevels: () => [],
    getPreset: () => {
      throw new Error("schema test must not resolve routing");
    },
  });
  return {
    tools,
    get admissionEffects() {
      return admissionEffects;
    },
    actionEffects,
    controller,
    manager,
    registry,
    context,
  };
}

const spawnArgs = (rest = {}) => ({
  agent: "otter",
  prompt: "Check the local change",
  label: "Check the local change",
  profile: "worker",
  reasoning_difficulty: 3,
  ...rest,
});
const isToolError = (result) => assert.equal(result.isError, true);

test("real SDK validates parent TypeBox enum schemas as the same closed wire enums", async () => {
  const fixture = ownerToolFixture();
  const spawn = fixture.tools.find((tool) => tool.name === "agent_spawn");
  const wait = fixture.tools.find((tool) => tool.name === "agent_wait");
  assert(spawn && wait);
  const { description: _profileDescription, ...profileSchema } =
    spawn.parameters.properties.profile;
  assert.deepEqual(profileSchema, { type: "string", enum: ["worker", "scout"] });
  assert.equal(Object.hasOwn(spawn.parameters.properties, "workspace"), false);
  assert.deepEqual(wait.parameters.properties.mode, {
    type: "string",
    enum: ["all", "any"],
    default: "all",
    description:
      "all (default): every selected task ends; any: one ends. Other events may return earlier.",
  });
  assert.equal(spawn.parameters.additionalProperties, false);
  assert.equal(spawn.parameters.properties.dispatch.additionalProperties, false);
  const returnTo = spawn.parameters.properties.return_to;
  assert.equal(returnTo.additionalProperties, false);
  assert.deepEqual(returnTo.required.toSorted(), ["agent", "instruction", "question_id"]);
  const prepared = spawn.prepareArguments(spawnArgs());
  assert.equal(prepared.profile, "worker", "the TypeBox Check layer accepts its local enum values");
  assert.equal(spawn.prepareArguments(spawnArgs({ profile: "scout" })).profile, "scout");
  assert.equal(fixture.admissionEffects, 0);

  // Bypass only the orchestration prepareArguments layer to exercise the actual
  // SDK's pi-schema validator directly against the project's registered schema.
  // The SDK coerces a valid numeric string; schema-invalid values never call
  // execute. The production adapter still performs its stricter raw-input check.
  const captured = [];
  const schemaProbe = {
    name: spawn.name,
    label: spawn.label,
    description: spawn.description,
    parameters: spawn.parameters,
    async execute(_id, args) {
      captured.push(args);
      return { content: [{ type: "text", text: "validated" }], details: undefined };
    },
  };
  const valid = await invoke(schemaProbe, spawnArgs({ reasoning_difficulty: "3" }));
  assert.equal(valid.isError, false);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].reasoning_difficulty, 3);
  const routed = spawnArgs({
    profile: "scout",
    return_to: {
      agent: "otter",
      question_id: `q_${"a".repeat(32)}`,
      instruction: "Use the attached findings.",
    },
  });
  assert.equal(spawn.prepareArguments(routed).return_to.instruction, "Use the attached findings.");
  assert.equal((await invoke(schemaProbe, routed)).isError, false);
  assert.equal(captured.length, 2);
  for (const args of [
    spawnArgs({ profile: "editor" }),
    spawnArgs({ profile: "researcher" }),
    spawnArgs({ workspace: "shared" }),
    spawnArgs({ workspace: "worktree" }),
    spawnArgs({ workspace: "elsewhere" }),
    spawnArgs({ extra: true }),
    spawnArgs({ dispatch: { ownership: ["src/orchestration"], extra: true } }),
    spawnArgs({ prompt: "" }),
    { ...routed, return_to: { ...routed.return_to, extra: true } },
    { ...routed, return_to: { ...routed.return_to, question_id: "q_bad" } },
    { ...routed, return_to: { ...routed.return_to, agent: "Not A Name" } },
    { ...routed, return_to: { ...routed.return_to, instruction: " " } },
    { ...routed, return_to: { ...routed.return_to, instruction: "x".repeat(16385) } },
    { ...routed, return_to: { agent: "otter", question_id: routed.return_to.question_id } },
    // The retired answer spelling is not an alias for instruction.
    { ...routed, return_to: { ...routed.return_to, answer: "Retired spelling" } },
  ]) {
    isToolError(await invoke(schemaProbe, args));
    assert.equal(captured.length, 2, "invalid model arguments cannot reach tool execution");
  }

  // The real adapter's TypeBox Check runs before SDK coercion. Fractional or
  // string difficulty must not turn into admitted work even though pi-schema's
  // generic integer coercion can normalize such values.
  const rawInputContext = {
    sessionManager: fixture.manager,
    modelRegistry: fixture.registry,
    cwd: fixture.context.cwd,
  };
  for (const args of [
    spawnArgs({ reasoning_difficulty: 3.5 }),
    spawnArgs({ reasoning_difficulty: "3" }),
    spawnArgs({ workspace: "shared" }),
    spawnArgs({ workspace: "worktree" }),
    spawnArgs({ workspace: null }),
    // The local TypeBox-backed enums must also close the raw TypeBox Check.
    spawnArgs({ profile: "editor" }),
    spawnArgs({ profile: "researcher" }),
    spawnArgs({ workspace: "elsewhere" }),
  ]) {
    isToolError(await invoke(spawn, args, rawInputContext));
  }
  // Profile/difficulty precedence is unchanged by the field-specific schema
  // diagnostics: these remain their own errors, not generic parameter failures.
  const errorCode = (response) => JSON.parse(response.result.content[0].text).error.code;
  // Literal-path syntax is enforced by the production raw check, not by the
  // intentionally narrower wire shape. Bypassing prepare here must not be
  // mistaken for the real tool admitting this declaration.
  const literalPath = spawnArgs({ dispatch: { ownership: ["src/orchestration/*"] } });
  assert.equal((await invoke(schemaProbe, literalPath)).isError, false);
  assert.equal(captured.length, 3);
  const rejectedPath = await invoke(spawn, literalPath, rawInputContext);
  isToolError(rejectedPath);
  assert.equal(errorCode(rejectedPath), "INVALID_DISPATCH");
  assert.equal(
    JSON.parse(rejectedPath.result.content[0].text).error.parameter,
    "dispatch.ownership.0",
  );
  assert.deepEqual(fixture.actionEffects, { lookup: 0, delivery: 0, answer: 0, publication: 0 });
  assert.equal(
    errorCode(await invoke(spawn, spawnArgs({ profile: "editor" }), rawInputContext)),
    "INVALID_PROFILE",
  );
  assert.equal(
    errorCode(await invoke(spawn, spawnArgs({ reasoning_difficulty: 3.5 }), rawInputContext)),
    "INVALID_DIFFICULTY",
  );
  assert.equal(fixture.admissionEffects, 0, "raw type/bound failures have no admission effects");
});

test("real SDK requires short spawn/run titles and raw checks enforce UTF-16 bounds", async () => {
  const fixture = ownerToolFixture();
  for (const [name, args] of [
    ["agent_spawn", spawnArgs()],
    [
      "agent_run",
      {
        agent: "otter",
        continues: "Earlier inspection",
        prompt: "Follow up",
        label: "Follow up on inspection",
      },
    ],
  ]) {
    const tool = fixture.tools.find((value) => value.name === name);
    assert(tool.parameters.required.includes("label"));
    assert.equal(tool.parameters.properties.label.maxLength, 72);
    let executions = 0;
    const schemaProbe = {
      name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id, input) {
        executions++;
        assert.equal(input.label, args.label);
        return { content: [{ type: "text", text: "validated" }], details: undefined };
      },
    };
    const { label: _label, ...missing } = args;
    for (const invalid of [
      missing,
      ...["", " ", "x".repeat(73)].map((label) => ({ ...args, label })),
    ]) {
      isToolError(await invoke(schemaProbe, invalid));
      isToolError(await invoke(tool, invalid, fixture.context));
    }
    assert.equal(executions, 0, "invalid titles cannot reach SDK tool execution");
    for (const label of ["x", "界".repeat(72), "🚀".repeat(36)]) {
      args.label = label;
      assert.equal((await invoke(schemaProbe, args)).isError, false);
      assert.equal(tool.prepareArguments(args).label, label);
    }
    const overlong = { ...args, label: "🚀".repeat(37) };
    assert.throws(() => tool.prepareArguments(overlong));
    isToolError(await invoke(tool, overlong, fixture.context));
  }
  assert.equal(fixture.admissionEffects, 0, "invalid titles never reach admission");
});

test("real SDK parent preparation and post-hook execution enforce every UTF-16 text boundary", async () => {
  const fixture = ownerToolFixture();
  const bound = bindParentToolContext({
    controller: fixture.controller,
    boundContext: fixture.context,
  });
  const followup = {
    agent: "otter",
    continues: "Earlier inspection",
    prompt: "Follow up",
    label: "Follow up",
  };
  const cases = [
    ["agent_spawn", spawnArgs(), "label", PARENT_TEXT_LIMITS.label],
    ["agent_run", followup, "label", PARENT_TEXT_LIMITS.label],
    ["agent_spawn", spawnArgs(), "prompt", PARENT_TEXT_LIMITS.prompt],
    ["agent_run", followup, "prompt", PARENT_TEXT_LIMITS.prompt],
    ["agent_run", followup, "continues", PARENT_TEXT_LIMITS.continues],
    ["agent_send", { agent: "otter", message: "Steer" }, "message", PARENT_TEXT_LIMITS.message],
    [
      "agent_answer",
      { agent: "otter", question_id: `q_${"a".repeat(32)}`, answer: "yes" },
      "answer",
      PARENT_TEXT_LIMITS.answer,
    ],
    [
      "agent_spawn",
      spawnArgs({
        profile: "scout",
        return_to: { agent: "otter", question_id: `q_${"a".repeat(32)}`, instruction: "yes" },
      }),
      "return_to.instruction",
      PARENT_TEXT_LIMITS.instruction,
    ],
    ["agent_read", { agent: "otter", cursor: "cursor" }, "cursor", PARENT_TEXT_LIMITS.cursor],
  ];
  const mutate = (args, path, value) => {
    const keys = path.split(".");
    const target = keys.length === 2 ? args[keys[0]] : args;
    if (value === undefined) delete target[keys.at(-1)];
    else target[keys.at(-1)] = value;
    return args;
  };
  const set = (args, path, value) => mutate(structuredClone(args), path, value);
  const textAt = (token, size) =>
    token.repeat(Math.floor(size / token.length)) + "x".repeat(size % token.length);
  const failure = (response, path, limit, missing = false) => {
    isToolError(response);
    const detail = JSON.parse(response.result.content[0].text).error;
    assert.equal(detail.code, "INVALID_PARAMETERS");
    assert.equal(detail.parameter, path);
    assert.equal(Object.hasOwn(detail, "path"), false);
    assert.match(detail.resolution, new RegExp(`${limit} characters`));
    if (path === "label")
      assert.match(
        detail.resolution,
        missing ? /label is required.*nonblank task title/ : /label must be a nonblank task title/,
      );
  };
  for (const [name, args, path, limit] of cases) {
    const tool = fixture.tools.find((value) => value.name === name);
    let executions = 0;
    // Same production binding/schema, with an action probe instead of Owner IO.
    const probe = bound.define(name, tool.description, tool.parameters, (input) => {
      executions++;
      assert.deepEqual(input, expected);
      return { content: [{ type: "text", text: "validated" }], details: undefined };
    });
    let expected;
    for (const token of ["a", "🚀", "e\u0301", "👩‍💻"]) {
      expected = set(args, path, textAt(token, limit));
      assert.equal((await invoke(probe, expected, fixture.context)).isError, false);
      // Direct execution independently repeats the same raw check.
      await probe.execute("boundary-direct", expected, undefined, undefined, fixture.context);
      const overlong = textAt(token, limit + 1);
      failure(await invoke(tool, set(args, path, overlong), fixture.context), path, limit);
      let hookCalls = 0;
      failure(
        await invoke(tool, args, fixture.context, {
          beforeToolCall({ args: validated }) {
            hookCalls++;
            mutate(validated, path, overlong);
          },
        }),
        path,
        limit,
      );
      assert.equal(hookCalls, 1, "valid arguments reached the real SDK hook before mutation");
    }
    assert.equal(executions, 8, "exact maximum reaches action on real SDK and direct routes");
    for (const value of [undefined, null, 12, "", " \n\t"]) {
      if (name === "agent_read" && value === undefined) continue;
      failure(
        await invoke(tool, set(args, path, value), fixture.context),
        path,
        limit,
        value === undefined,
      );
      failure(
        await invoke(tool, args, fixture.context, {
          beforeToolCall({ args: validated }) {
            mutate(validated, path, value);
          },
        }),
        path,
        limit,
        value === undefined,
      );
    }
  }
  assert.equal(fixture.admissionEffects, 0);
  assert.deepEqual(fixture.actionEffects, { lookup: 0, delivery: 0, answer: 0, publication: 0 });
});

test("real SDK accepts only a raw agent_run max_turns integer and forwards that override", async () => {
  const fixture = ownerToolFixture();
  const spawn = fixture.tools.find((tool) => tool.name === "agent_spawn");
  const run = fixture.tools.find((tool) => tool.name === "agent_run");
  assert(spawn && run);
  assert.equal(run.parameters.additionalProperties, false);
  assert.equal(Object.keys(run.parameters.properties).at(-1), "max_turns");
  assert.equal(run.parameters.required.includes("max_turns"), false);
  assert.equal(run.parameters.properties.max_turns.type, "integer");
  assert.equal(run.parameters.properties.max_turns.minimum, 1);
  assert.equal(run.parameters.properties.max_turns.maximum, 10000);
  const followup = () => ({
    agent: "otter",
    continues: "Earlier inspection",
    prompt: "Follow up",
    label: "Follow up",
  });
  // The raw Check reports the public field and the exact violated direction
  // instead of the old generic schema diagnostic; no raw value is echoed.
  const parameterError = (result, expected) => {
    isToolError(result);
    const detail = JSON.parse(result.result.content[0].text).error;
    assert.equal(detail.code, "INVALID_PARAMETERS");
    assert.equal(detail.parameter, "max_turns");
    assert.match(detail.resolution, expected);
  };
  // The probe uses the registered schema without prepareArguments, so it shows
  // what pi-schema itself rejects. Production rejection is the raw check below.
  const captured = [];
  const schemaProbe = {
    name: run.name,
    label: run.label,
    description: run.description,
    parameters: run.parameters,
    async execute(_id, args) {
      captured.push(structuredClone(args));
      return { content: [{ type: "text", text: "validated" }], details: undefined };
    },
  };
  assert.equal(schemaProbe.parameters, run.parameters);
  for (const max_turns of [1, 10000]) {
    assert.equal((await invoke(schemaProbe, { ...followup(), max_turns })).isError, false);
    assert.equal(captured.at(-1).max_turns, max_turns);
  }
  assert.equal((await invoke(schemaProbe, followup())).isError, false);
  assert.equal(Object.hasOwn(captured.at(-1), "max_turns"), false);
  for (const max_turns of [0, -1, 10001]) {
    isToolError(await invoke(schemaProbe, { ...followup(), max_turns }));
    assert.equal(captured.length, 3, "schema-invalid turn limits never reach the probe");
  }

  // prepareArguments runs before pi-schema coercion, including after a hook mutates
  // a value the SDK already accepted.
  const invalid = [0, -1, 10001, 1.5, "256", null, NaN, Infinity];
  for (const max_turns of invalid) {
    const expected =
      max_turns === 10001
        ? /at most 10000/
        : max_turns === 0 || max_turns === -1
          ? /at least 1/
          : /must be an integer/;
    parameterError(await invoke(spawn, spawnArgs({ max_turns }), fixture.context), expected);
    parameterError(await invoke(run, { ...followup(), max_turns }, fixture.context), expected);
    let hooks = 0;
    parameterError(
      await invoke(run, followup(), fixture.context, {
        beforeToolCall({ args }) {
          hooks++;
          args.max_turns = max_turns;
        },
      }),
      expected,
    );
    parameterError(
      await invoke(spawn, spawnArgs(), fixture.context, {
        beforeToolCall({ args }) {
          hooks++;
          args.max_turns = max_turns;
        },
      }),
      expected,
    );
    assert.equal(hooks, 2);
  }
  assert.equal(fixture.admissionEffects, 0);
  assert.deepEqual(fixture.actionEffects, {
    lookup: 0,
    delivery: 0,
    answer: 0,
    publication: 0,
  });

  const forwarded = [];
  fixture.controller.view = () => ({ status: "completed", has_question: false });
  fixture.controller.submitPrepared = (_id, submission, prepare) => {
    forwarded.push(prepare(submission));
    return { run_id: "accepted-run" };
  };
  fixture.controller.observe = async () => ({
    content: [{ type: "text", text: "observed" }],
    details: undefined,
  });
  for (const max_turns of [1, 10000, undefined]) {
    const args = followup();
    if (max_turns !== undefined) args.max_turns = max_turns;
    assert.equal((await invoke(run, args, fixture.context)).isError, false);
    const request = forwarded.at(-1);
    assert.equal(request.resume, "fixture-agent");
    assert.equal(request.prompt, args.prompt);
    assert.equal(request.description, args.label);
    assert.equal(Object.hasOwn(request, "continues"), false);
    assert.equal(Object.hasOwn(request, "settings"), false);
    if (max_turns === undefined) assert.equal(Object.hasOwn(request, "max_turns"), false);
    else assert.equal(request.max_turns, max_turns);
  }
  assert.equal(fixture.admissionEffects, 0);
  assert.equal(fixture.actionEffects.lookup > 0, true);
  assert.equal(fixture.actionEffects.delivery, 0);
  assert.equal(fixture.actionEffects.answer, 0);
  assert.equal(fixture.actionEffects.publication, 0);
});

test("real SDK bounds dispatch declarations and reports safe field-specific errors", async () => {
  const fixture = ownerToolFixture();
  const bound = bindParentToolContext({
    controller: fixture.controller,
    boundContext: fixture.context,
  });
  const followup = () => ({
    agent: "otter",
    continues: "Earlier inspection",
    prompt: "Follow up",
    label: "Follow up",
  });
  const paths = (prefix, count) =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}.txt`);
  const checks = (count) =>
    Array.from({ length: count }, (_, index) => `test/${index}/**/*.test.mjs`);
  const detailOf = (response) => {
    isToolError(response);
    return JSON.parse(response.result.content[0].text).error;
  };
  const thrownDetail = (read) => {
    try {
      read();
    } catch (error) {
      return JSON.parse(error.message).error;
    }
    assert.fail("expected a thrown parameter error");
  };
  const assertDetail = (detail, expected) => {
    assert.equal(detail.code, expected.code);
    if (expected.parameter instanceof RegExp)
      assert.match(detail.parameter ?? "", expected.parameter);
    else assert.equal(detail.parameter, expected.parameter);
    assert.equal(typeof detail.resolution, "string");
    assert(detail.resolution.length <= 512, "resolutions stay bounded");
    for (const pattern of [expected.resolution].flat()) assert.match(detail.resolution, pattern);
    // Raw values and unknown property names never cross the error boundary.
    for (const absent of expected.absent ?? []) assert.doesNotMatch(JSON.stringify(detail), absent);
  };
  for (const name of ["agent_spawn", "agent_run"]) {
    const tool = fixture.tools.find((value) => value.name === name);
    const dispatchSchema = tool.parameters.properties.dispatch;
    assert.equal(dispatchSchema.additionalProperties, false);
    assert.equal(dispatchSchema.properties.required_paths.maxItems, 32);
    assert.equal(dispatchSchema.properties.ownership.maxItems, 16);
    assert.equal(dispatchSchema.properties.checks.maxItems, 16);
    assert.equal(dispatchSchema.properties.build_dir.maxLength, 512);
    for (const field of ["required_paths", "ownership", "checks"]) {
      assert.equal(dispatchSchema.properties[field].minItems, 1);
      assert.equal(dispatchSchema.properties[field].uniqueItems, true);
      assert.equal(dispatchSchema.properties[field].items.maxLength, 512);
    }
    const args = (dispatch) =>
      name === "agent_spawn" ? spawnArgs({ dispatch }) : { ...followup(), dispatch };
    const executions = [];
    // Same production schema and raw checks, with an action probe instead of Owner IO.
    const probe = bound.define(name, tool.description, tool.parameters, (input) => {
      executions.push(structuredClone(input));
      return { content: [{ type: "text", text: "validated" }], details: undefined };
    });
    const accepted = async (dispatch) => {
      const input = args(dispatch);
      const prepared = tool.prepareArguments(input);
      assert.deepEqual(prepared.dispatch, dispatch);
      assert.notEqual(prepared.dispatch, dispatch, "prepare owns a detached copy");
      assert.equal((await invoke(probe, input, fixture.context)).isError, false);
      assert.deepEqual(executions.at(-1).dispatch, dispatch);
    };
    const rejected = async (dispatch, expected) => {
      const input = args(dispatch);
      assertDetail(
        thrownDetail(() => tool.prepareArguments(input)),
        expected,
      );
      assertDetail(detailOf(await invoke(tool, input, fixture.context)), expected);
      // Hooks run after preparation: a valid declaration mutated into this one
      // must be rejected again before any action or admission.
      const before = executions.length;
      let hookCalls = 0;
      assertDetail(
        detailOf(
          await invoke(probe, args({ required_paths: ["input-0.txt"] }), fixture.context, {
            beforeToolCall({ args: validated }) {
              hookCalls++;
              validated.dispatch = structuredClone(dispatch);
            },
          }),
        ),
        expected,
      );
      assert.equal(hookCalls, 1, "the valid declaration reached the real SDK hook");
      assert.equal(executions.length, before, "invalid hook arguments never reach action");
    };

    // The documented bounds are accepted by preparation, the pinned SDK schema
    // and the repeated post-hook raw check.
    await accepted({ required_paths: paths("input", 32) });
    await accepted({ ownership: paths("output", 16) });
    await accepted({ checks: checks(16) });
    await accepted({ required_paths: ["input-0.txt"], build_dir: "build-tree" });

    await rejected(
      { required_paths: paths("input", 33) },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.required_paths",
        resolution: [/at most 32/, /it has 33/],
        absent: [/input-32/],
      },
    );
    await rejected(
      { ownership: paths("output", 17) },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.ownership",
        resolution: [/at most 16/, /it has 17/],
        absent: [/output-16/],
      },
    );
    await rejected(
      { checks: checks(17) },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.checks",
        resolution: [/at most 16/, /it has 17/],
        absent: [/test\/16/],
      },
    );
    // Declared array bounds are preflighted before per-item schema errors, so a
    // count failure wins and never names an item index or raw value.
    await rejected(
      { required_paths: ["*.bad", ...paths("input", 32)] },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.required_paths",
        resolution: [/at most 32/, /it has 33/],
        absent: [/dispatch\.required_paths\.0/, /\*\.bad/],
      },
    );
    await rejected(
      {
        required_paths: Array.from({ length: 200 }, (_, index) =>
          index === 150 ? "*.bad" : `input-${index}.txt`,
        ),
      },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.required_paths",
        resolution: [/at most 32/, /it has 200/],
        absent: [/dispatch\.required_paths\.150/, /\*\.bad/],
      },
    );
    // TypeBox 1.3.27 maxLength uses approximate grapheme segmentation, so this
    // ASCII string fails the schema and the model-facing raw check names the
    // exact field/index and the 512 UTF-16-unit bound without echoing the value.
    await rejected(
      { required_paths: ["a".repeat(513)] },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch.required_paths.0",
        resolution: [/at most 512/, /characters/, /it has 513/],
        absent: [/a{32}/],
      },
    );
    // 512 astral characters pass TypeBox's approximate grapheme count but exceed
    // the UTF-16-unit bound; core dispatch validation rejects with the exact
    // field/index parameter and no raw value.
    await rejected(
      { required_paths: ["🚀".repeat(512)] },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.required_paths.0",
        resolution: [/dispatch\.required_paths\.0/, /at most 512/, /characters/, /received 1024/],
        absent: [/🚀/],
      },
    );
    await rejected(
      { ownership: ["src/orchestration/*"] },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.ownership.0",
        resolution: [/literal path/, /globs/],
        absent: [/src\/orchestration/],
      },
    );
    // Padding and glob/quote restrictions are checked by core dispatch
    // validation; the wire schema still rejects control characters.
    await rejected(
      { required_paths: [" input-0.txt"] },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.required_paths.0",
        resolution: [/dispatch\.required_paths\.0/, /padding/, /(leading|trailing)/i],
        absent: [/input-0/],
      },
    );
    await rejected(
      { build_dir: " build-tree" },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.build_dir",
        resolution: [/dispatch\.build_dir/, /padding/, /(leading|trailing)/i],
        absent: [/build-tree/],
      },
    );
    // The same per-item qualification applies to ownership and checks; checks
    // skip literal-path padding rules but keep the UTF-16-unit bound.
    await rejected(
      { ownership: [" output-0.txt"] },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.ownership.0",
        resolution: [/dispatch\.ownership\.0/, /padding/, /(leading|trailing)/i],
        absent: [/output-0/],
      },
    );
    await rejected(
      { checks: ["🚀".repeat(512)] },
      {
        code: "INVALID_DISPATCH",
        parameter: "dispatch.checks.0",
        resolution: [/dispatch\.checks\.0/, /at most 512/, /characters/, /received 1024/],
        absent: [/🚀/],
      },
    );
    // Unknown fields are rejected by their containing object without echoing
    // their names or values.
    const hostile = "hostile_unknown_field";
    await rejected(
      { required_paths: ["input-0.txt"], [hostile]: "hostile-value" },
      {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch",
        resolution: [/undeclared field/],
        absent: [new RegExp(hostile), /hostile-value/],
      },
    );
    // Retired internal dispatch keys are undeclared, not aliases. A hook that
    // swaps a valid public declaration for one must have no action or admission
    // effects, just like any other post-preparation mutation.
    for (const retired of [{ inputs: ["old.txt"] }, { tree: "old-build" }]) {
      await rejected(retired, {
        code: "INVALID_PARAMETERS",
        parameter: "dispatch",
        resolution: [/undeclared field/],
        absent: [/old\.txt|old-build/],
      });
      const before = executions.length;
      let hookCalls = 0;
      assertDetail(
        detailOf(
          await invoke(probe, args({ required_paths: ["input-0.txt"] }), fixture.context, {
            beforeToolCall({ args: validated }) {
              hookCalls++;
              validated.dispatch = structuredClone(retired);
            },
          }),
        ),
        {
          code: "INVALID_PARAMETERS",
          parameter: "dispatch",
          resolution: [/undeclared field/],
          absent: [/old\.txt|old-build/],
        },
      );
      assert.equal(hookCalls, 1, "the valid public declaration reached the SDK hook");
      assert.equal(executions.length, before, "a retired hook shape reaches no action");
    }
    // Required fields name the missing known field, not the whole schema.
    const missingAgent = name === "agent_spawn" ? spawnArgs() : followup();
    delete missingAgent.agent;
    const required = {
      code: "INVALID_PARAMETERS",
      parameter: "agent",
      resolution: [/agent/, /required/i],
    };
    assertDetail(
      thrownDetail(() => tool.prepareArguments(missingAgent)),
      required,
    );
    assertDetail(detailOf(await invoke(tool, missingAgent, fixture.context)), required);
  }
  // Root structural failures stay generic: no invented field or raw value.
  const run = fixture.tools.find((tool) => tool.name === "agent_run");
  for (const raw of [null, [], "not an object", 12]) {
    const detail = detailOf(await invoke(run, raw, fixture.context));
    assert.equal(detail.code, "INVALID_PARAMETERS");
    assert.equal(detail.parameter, undefined);
    assert.match(detail.resolution, /do not match this tool's schema/);
  }
  const extraDetail = thrownDetail(() =>
    fixture.tools
      .find((tool) => tool.name === "agent_spawn")
      .prepareArguments(spawnArgs({ extra_field: "raw-value" })),
  );
  assert.equal(extraDetail.code, "INVALID_PARAMETERS");
  assert.equal(extraDetail.parameter, undefined);
  assert.match(extraDetail.resolution, /undeclared field/);
  assert.doesNotMatch(JSON.stringify(extraDetail), /extra_field|raw-value/);
  assert.equal(fixture.admissionEffects, 0, "invalid dispatch never reaches admission");
  assert.deepEqual(fixture.actionEffects, {
    lookup: 0,
    delivery: 0,
    answer: 0,
    publication: 0,
  });
});

test("real SDK rejects combining question_id tokens with copy-token guidance", async () => {
  const fixture = ownerToolFixture();
  const answer = fixture.tools.find((tool) => tool.name === "agent_answer");
  const spawn = fixture.tools.find((tool) => tool.name === "agent_spawn");
  assert(answer && spawn);
  const validId = `q_${"a".repeat(32)}`;
  // 34 UTF-16 units but only 18 approximate graphemes: TypeBox minLength fails
  // even though the raw length is not short. The diagnostic must not claim the
  // token is under 34 UTF-16 units; it must ask for the exact pending token.
  const combiningId = `q_${"a\u0301".repeat(16)}`;
  assert.equal(combiningId.length, 34);
  const answerArgs = (question_id) => ({ agent: "otter", question_id, answer: "yes" });
  const routed = (question_id) =>
    spawnArgs({
      profile: "scout",
      return_to: { agent: "otter", question_id, instruction: "yes" },
    });
  const detailOf = (response) => {
    isToolError(response);
    return JSON.parse(response.result.content[0].text).error;
  };
  const thrownDetail = (read) => {
    try {
      read();
    } catch (error) {
      return JSON.parse(error.message).error;
    }
    assert.fail("expected a thrown parameter error");
  };
  const guidance = (detail, parameter) => {
    assert.equal(detail.code, "INVALID_PARAMETERS");
    assert.equal(detail.parameter, parameter);
    for (const fact of [/(copy|exact)/i, /(wait|read)/i, /token/i, /q_/, /32/, /(hex|lowercase)/i])
      assert.match(detail.resolution, fact);
    assert.doesNotMatch(detail.resolution, /at least 34/i);
    assert(!JSON.stringify(detail).includes(combiningId), "the raw token is never echoed");
  };

  guidance(
    thrownDetail(() => answer.prepareArguments(answerArgs(combiningId))),
    "question_id",
  );
  guidance(detailOf(await invoke(answer, answerArgs(combiningId), fixture.context)), "question_id");
  guidance(
    thrownDetail(() => spawn.prepareArguments(routed(combiningId))),
    "return_to.question_id",
  );
  guidance(
    detailOf(await invoke(spawn, routed(combiningId), fixture.context)),
    "return_to.question_id",
  );

  // Hooks run after preparation: a valid token mutated into the combining one
  // must be rejected again before any action or admission.
  let hooks = 0;
  guidance(
    detailOf(
      await invoke(answer, answerArgs(validId), fixture.context, {
        beforeToolCall({ args }) {
          hooks++;
          args.question_id = combiningId;
        },
      }),
    ),
    "question_id",
  );
  guidance(
    detailOf(
      await invoke(spawn, routed(validId), fixture.context, {
        beforeToolCall({ args }) {
          hooks++;
          args.return_to.question_id = combiningId;
        },
      }),
    ),
    "return_to.question_id",
  );
  assert.equal(hooks, 2);
  assert.equal(fixture.admissionEffects, 0);
  assert.deepEqual(fixture.actionEffects, {
    lookup: 0,
    delivery: 0,
    answer: 0,
    publication: 0,
  });
});

test("real SDK rejects child schema violations before alert/question callbacks", async () => {
  const effects = [];
  const callbacks = {
    alert: (message) => effects.push(["alert", message]),
    question: (question) => {
      effects.push(["question", question]);
      return "recorded";
    },
  };
  const tools = createChildTools(() => callbacks, { accepting: true, stopped: false });
  const alert = tools.find((tool) => tool.name === "alert_parent");
  const ask = tools.find((tool) => tool.name === "ask_parent");
  assert(alert && ask);
  assert.equal(alert.parameters.additionalProperties, false);
  assert.equal(ask.parameters.additionalProperties, false);
  for (const [tool, args] of [
    [alert, {}],
    [alert, { message: " " }],
    [alert, { message: "x".repeat(8193) }],
    [alert, { message: "valid", extra: true }],
    [ask, {}],
    [ask, { question: "valid", extra: true }],
  ]) {
    isToolError(await invoke(tool, args));
    assert.deepEqual(effects, [], "invalid child arguments cannot enqueue or record anything");
  }
  const accepted = await invoke(alert, { message: "synthetic fact" });
  assert.equal(accepted.isError, false);
  const coerced = await invoke(alert, { message: 123 });
  assert.equal(
    coerced.isError,
    false,
    "SDK pi-schema coercion preserves the shared TypeBox behavior",
  );
  assert.deepEqual(effects, [
    ["alert", "synthetic fact"],
    ["alert", "123"],
  ]);
});
