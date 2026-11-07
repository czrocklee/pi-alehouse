import {
  code,
  viewOf,
  routed,
  settle,
  toolsFor,
  create,
  send,
  run,
} from "../support/owner-tools-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createOwnerTools } from "../../dist/orchestration/tools/parent-tools.js";
import {
  defaultDelegation,
  delegationGuideline,
  delegationModes,
  eagernessLevels,
} from "../../dist/orchestration/delegation.js";
import {
  blockedDelegationToolNames as blockedDelegationTools,
  managementToolNames as delegationTools,
  agentProfileNames,
  internalProfile,
  modelProfileNames,
  profileLabel,
} from "../../dist/orchestration/tools/tool-names.js";
import { fixture, task, until } from "../support/controller-fixture.mjs";
import { assertCallerTools } from "../support/caller-contract.mjs";

test("worker maps to editor and scout maps to researcher; retired public names are rejected", async (t) => {
  assert.deepEqual(agentProfileNames, ["editor", "researcher"]);
  assert.deepEqual(modelProfileNames, ["worker", "scout"]);
  assert.equal(internalProfile("worker"), "editor");
  assert.equal(internalProfile("scout"), "researcher");
  assert.equal(profileLabel("editor"), "worker");
  assert.equal(profileLabel("researcher"), "scout");
  assert.equal(profileLabel("reader"), "reader");
  assert.equal(profileLabel("scout"), "scout");
  const f = await fixture(t),
    { tool, call } = toolsFor(f);
  for (const profile of ["reader", "editor", "researcher"]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ profile })),
      code("INVALID_PROFILE"),
    );
    await assert.rejects(
      call("agent_spawn", create({ profile }), `retired-${profile}`),
      (error) => {
        const result = JSON.parse(error.message).error;
        assert.equal(result.code, "INVALID_PROFILE");
        assert.deepEqual(result.allowed, ["worker", "scout"]);
        return true;
      },
    );
  }
  assert.equal(Object.hasOwn(tool("agent_spawn").parameters.properties, "workspace"), false);
  for (const workspace of ["shared", "worktree", false, null, {}, "sandbox", "/tmp"]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ workspace })),
      code("INVALID_PARAMETERS"),
    );
    await assert.rejects(
      call("agent_spawn", create({ workspace }), `removed-${String(workspace)}`),
      code("INVALID_PARAMETERS"),
    );
  }
  assert.equal(f.controller.stats().runs, 0);
  assert.equal(f.ports.length, 0);
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  assert.equal(routed(f, "orca").profile, "editor");
  assert.equal(routed(f, "orca").cwd, "/tmp");
  assert.equal(Object.hasOwn(routed(f, "orca"), "workspace"), false);
  assert.equal((await call("agent_list", {})).agents[0].profile, "worker");
  await assert.rejects(
    call("agent_run", run("orca", { workspace: "worktree" })),
    code("INVALID_PARAMETERS"),
  );
  f.ports[0].finish();
  await settle(f, "orca");
  await call("agent_spawn", create({ agent: "otter", profile: "scout" }), "scout-admit");
  await until(() => f.ports[1]?.streaming);
  assert.equal(routed(f, "otter").profile, "researcher");
  assert.equal(routed(f, "otter").difficulty, 3);
  const roster = await call("agent_list", {});
  assert.equal(roster.agents.find((row) => row.agent === "otter").profile, "scout");
  assert.equal(roster.agents.find((row) => row.agent === "orca").profile, "worker");
  f.ports[1].finish();
  await settle(f, "otter");
});

test("serialized tool schemas explain task fields and independent capability/routing choices", async (t) => {
  const f = await fixture(t),
    { tools } = toolsFor(f);
  assertCallerTools(tools);
  assert.deepEqual(f.controller.list(), [], "description checks must not dispatch work");
});

test("model tool assembly accepts sixteen residents but rejects seventeen without constraining core", async (t) => {
  const supported = await fixture(t, { controller: { resident_limit: 16 } });
  assert.equal(toolsFor(supported).tools.length, 9);
  const larger = await fixture(t, { controller: { resident_limit: 17, queue_limit: 17 } });
  assert.throws(() => toolsFor(larger), { code: "UNSUPPORTED_MODEL_RESIDENT_LIMIT" });
  const runs = [];
  for (let index = 0; index < 17; index++)
    runs.push(await larger.controller.submit(`core-${index}`, task(`core task ${index}`)));
  await until(() => larger.ports[0]?.streaming);
  assert.equal(larger.controller.stats().resident, 17);
  for (const run of runs) larger.controller.cancel(run.run_id);
  larger.ports[0].finish("partial", "aborted");
  assert.equal(
    await larger.controller.waitForRuns(
      runs.map((run) => run.run_id),
      { mode: "all", timeout_ms: 3000 },
    ),
    "ready",
  );
});

test("only agent_spawn carries the delegation guideline, as static text", async (t) => {
  const f = await fixture(t),
    { tools, options } = toolsFor(f);
  for (const tool of tools) {
    assert.deepEqual(
      tool.promptGuidelines,
      tool.name === "agent_spawn" ? [delegationGuideline(defaultDelegation)] : undefined,
      tool.name,
    );
  }
  const lines = new Set();
  for (const mode of delegationModes)
    for (const eagerness of eagernessLevels) {
      const line = delegationGuideline({ mode, eagerness });
      const registered = createOwnerTools({ ...options, guideline: line });
      assertCallerTools(registered);
      for (const tool of registered) {
        assert.deepEqual(
          tool.promptGuidelines,
          tool.name === "agent_spawn" ? [line] : undefined,
          `${mode}/${eagerness}: ${tool.name}`,
        );
      }
      assert.doesNotMatch(
        line,
        /\d|\$\{|undefined|\n/,
        "no counts, dates or interpolation in a cached prompt prefix",
      );
      assert.doesNotMatch(
        line,
        /agent_(spawn|run|send|wait|read|kill|list|interrupt)|profile|difficulty/,
        "organization strategy only; tool semantics stay in schemas",
      );
      lines.add(line);
    }
  assert.equal(
    lines.size,
    10,
    "each autonomous mode × eagerness is distinct; Manual ignores eagerness",
  );
});

test("only prompt carries the assignment; labels, names and default-disabled context do not", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.entries = [{ message: { role: "user", content: "PARENT_CONTEXT_NOT_INHERITED" } }];
  const prompt = "Inspect source only; no edits. Return findings and evidence.";
  const reply = await call(
    "agent_spawn",
    create({ agent: "label-agent", prompt, label: "TASK_LABEL_NOT_INSTRUCTIONS" }),
  );
  assert.deepEqual(
    reply,
    {
      action: { type: "agent_spawn", agent: "label-agent", task: 1 },
      agents: [
        { agent: "label-agent", task: 1, status: "running", label: "TASK_LABEL_NOT_INSTRUCTIONS" },
      ],
    },
    "a receipt carries no IDs or settings",
  );
  await until(() => f.ports[0]?.streaming);
  assert.equal(f.ports[0].calls[0].prompt, prompt);
  assert.equal(viewOf(f, "label-agent").effective_settings.context_snapshot, undefined);
  f.ports[0].finish("findings");
  await settle(f, "label-agent");
});

test("closed schemas reject unknown, mutated and malformed inputs before admission", async (t) => {
  const f = await fixture(t),
    { tools, tool, call, options } = toolsFor(f);
  assert.deepEqual(tools.map((x) => x.name).sort(), [...delegationTools].sort());
  assert(Object.isFrozen(delegationTools));
  assert(Object.isFrozen(blockedDelegationTools));
  assert.throws(() => delegationTools.splice(0), TypeError);
  assert.throws(() => delegationTools.push("mutated"), TypeError);
  for (const item of tools) {
    assert.equal(item.parameters.type, "object");
    assert.equal(item.parameters.additionalProperties, false);
    for (const forbidden of ["anyOf", "oneOf", "allOf"])
      assert(!JSON.stringify(item.parameters).includes(`"${forbidden}"`));
  }
  for (const name of blockedDelegationTools)
    assert.throws(
      () =>
        createOwnerTools({
          ...options,
          profiles: { ...options.profiles, editor: { ...options.profiles.editor, tools: [name] } },
        }),
      { code: "INVALID_PROFILE_DEFINITION" },
    );
  for (const key of [
    "agent_id",
    "run_id",
    "owner_id",
    "model",
    "provider",
    "thinking",
    "effort",
    "strength",
    "cwd",
    "tools",
    "name",
    "description",
    "role",
  ]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ [key]: "x" })),
      code("INVALID_PARAMETERS"),
      key,
    );
    await assert.rejects(
      call("agent_spawn", create({ [key]: "x" })),
      code("INVALID_PARAMETERS"),
      key,
    );
  }
  for (const agent of ["Orca", "orca windows", "1orca", "orca-windows-foundations-x", "", 42]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ agent })),
      code("INVALID_PARAMETERS"),
      String(agent),
    );
  }
  for (const args of [
    (({ profile: _profile, ...rest }) => rest)(create()),
    (({ reasoning_difficulty: _difficulty, ...rest }) => rest)(create()),
    create({ label: "x".repeat(121) }),
    create({ prompt: " " }),
    create({ prompt: "x".repeat(131073) }),
  ]) {
    assert.throws(() => tool("agent_spawn").prepareArguments(args), code("INVALID_PARAMETERS"));
  }
  const mutated = tool("agent_spawn").prepareArguments(create());
  mutated.owner_id = "forged";
  await assert.rejects(call("agent_spawn", mutated), code("INVALID_PARAMETERS"));
  const rescored = tool("agent_spawn").prepareArguments(create());
  rescored.reasoning_difficulty = 2.5;
  await assert.rejects(call("agent_spawn", rescored), code("INVALID_DIFFICULTY"));
  const reprofiled = tool("agent_spawn").prepareArguments(create());
  reprofiled.profile = "admin";
  await assert.rejects(call("agent_spawn", reprofiled), code("INVALID_PROFILE"));
  for (const max_duration_ms of [0, 1, 300000, 1800000, 86400001, 1.5]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ max_duration_ms })),
      code("INVALID_PARAMETERS"),
    );
    assert.throws(
      () => tool("agent_run").prepareArguments(run("orca", { max_duration_ms })),
      code("INVALID_PARAMETERS"),
    );
    assert.throws(
      () =>
        tool("agent_answer").prepareArguments({
          agent: "orca",
          question_id: "q_" + "a".repeat(32),
          answer: "continue",
          max_duration_ms,
        }),
      code("INVALID_PARAMETERS"),
    );
  }
  for (const wait_ms of [-1, 300001, 1.5]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ wait_ms })),
      code("INVALID_PARAMETERS"),
    );
    assert.throws(
      () => tool("agent_wait").prepareArguments({ wait_ms }),
      code("INVALID_PARAMETERS"),
    );
  }
  for (const after of [[], ["a", "b", "c", "d", "e"], ["Bad"]]) {
    assert.throws(
      () => tool("agent_spawn").prepareArguments(create({ after })),
      code("INVALID_PARAMETERS"),
    );
  }
  for (const [name, args] of [
    ["agent_read", { agent: "orca", path: "/private/session.jsonl" }],
    ["agent_read", { agent: "orca", limit: 10 }],
    ["agent_read", { agent: "orca", view: "metadata" }],
    ["agent_read", { agent: "orca", view: "result" }],
    ["agent_read", { agent: "orca", max_chars: 16385 }],
    ["agent_read", { agent: "orca", max_chars: 0 }],
    ["agent_read", { agent: "orca", task: 1, cursor: "garbage" }],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((task) => [
      "agent_read",
      { agent: "orca", task },
    ]),
    ["agent_wait", { mode: "other" }],
    ["agent_wait", { agents: [] }],
    ["agent_wait", { agents: Array.from({ length: 17 }, (_, i) => `a${i}`) }],
    ["agent_send", { agent: "orca" }],
    ["agent_send", { agent: "orca", message: "x", profile: "reader" }],
    ["agent_send", { agent: "orca", message: "x", label: "x" }],
    ["agent_send", { agent: "orca", message: "x", after: ["a"] }],
    ["agent_run", { agent: "orca" }],
    ["agent_run", { agent: "orca", prompt: "x", profile: "reader" }],
    ["agent_run", { agent: "orca", prompt: "x", max_turns: 3 }],
    ["agent_interrupt", { agent: "orca", run_id: "x" }],
    ["agent_list", { include_released: true }],
    ["agent_kill", {}],
    ["agent_answer", { agent: "orca", answer: "yes" }],
    ["agent_answer", { agent: "orca", question_id: "q_bad", answer: "yes" }],
    ["agent_answer", { agent: "orca", question_id: `q_${"a".repeat(32)}`, answer: " " }],
    [
      "agent_answer",
      { agent: "orca", question_id: `q_${"a".repeat(32)}`, answer: "x".repeat(16385) },
    ],
    ...["profile", "reasoning_difficulty", "difficulty", "budgets", "label", "after"].map((key) => [
      "agent_answer",
      {
        agent: "orca",
        question_id: `q_${"a".repeat(32)}`,
        answer: "yes",
        [key]: "forbidden",
      },
    ]),
  ]) {
    assert.throws(() => tool(name).prepareArguments(args), code("INVALID_PARAMETERS"), name);
    await assert.rejects(call(name, args), code("INVALID_PARAMETERS"), name);
  }
  assert.equal(tool("agent_wait").parameters.properties.mode.default, "all");
  assert(Check(tool("agent_wait").parameters, {}));
  assert(Check(tool("agent_list").parameters, {}));
  assert.deepEqual(f.controller.list(), []);
  assert.equal(f.ports.length, 0);
});

test("legacy difficulty and mixed score keys reject before allocation or preparation side effects", async (t) => {
  const f = await fixture(t),
    { tool, call } = toolsFor(f);
  const { reasoning_difficulty: _score, ...legacy } = create();
  for (const args of [
    { ...legacy, difficulty: 3 },
    create({ difficulty: 3 }),
    create({ difficulty: undefined }),
  ]) {
    assert.throws(() => tool("agent_spawn").prepareArguments(args), code("INVALID_PARAMETERS"));
    await assert.rejects(call("agent_spawn", args), code("INVALID_PARAMETERS"));
    assert.deepEqual(f.controller.list(), []);
    assert.equal(f.ports.length, 0);
    assert.equal(f.controller.stats().runs, 0);
    assert.equal(f.controller.stats().resident, 0);
  }
});

test("spawn creates and send addresses: each rejects the other's names with a pointer to the right tool", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f);
  await assert.rejects(call("agent_send", send("ghost")), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "AGENT_NOT_FOUND");
    assert.equal(result.agent, "ghost");
    assert.equal(result.parameter, "agent");
    assert.equal(result.allowed, undefined, "no names to offer");
    assert.match(result.resolution, /agent_spawn creates an Agent/);
    return true;
  });
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
  await assert.rejects(call("agent_spawn", create(), "again"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "AGENT_EXISTS");
    assert.equal(result.agent, "orca");
    assert.match(
      result.resolution,
      /check agent_list, it may be your own earlier spawn.*never reused.*for a new Agent, choose another name/,
    );
    assert.doesNotMatch(result.resolution, /agent_run/);
    return true;
  });
  await assert.rejects(
    call("agent_spawn", create({ agent: "otter", after: ["ghost"] }), "after-ghost"),
    (error) => {
      const result = JSON.parse(error.message).error;
      assert.equal(result.code, "AGENT_NOT_FOUND");
      assert.equal(result.parameter, "after");
      assert.deepEqual(result.allowed, ["orca"]);
      return true;
    },
  );
  await assert.rejects(
    call("agent_run", run("orca", { after: ["orca"] }), "after-self"),
    (error) => {
      const result = JSON.parse(error.message).error;
      assert.equal(result.code, "INVALID_PARAMETER");
      assert.equal(result.parameter, "after");
      return true;
    },
  );
  for (const name of ["agent_read", "agent_interrupt", "agent_kill"])
    await assert.rejects(call(name, { agent: "ghost" }), code("AGENT_NOT_FOUND"));
  await assert.rejects(call("agent_wait", { agents: ["ghost"] }), code("AGENT_NOT_FOUND"));
  assert.deepEqual(await call("agent_kill", { agent: "orca" }), {
    agent: "orca",
    status: "killed",
    label: "task",
  });
  await assert.rejects(call("agent_run", run("orca"), "released-reuse"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "AGENT_UNAVAILABLE");
    assert.equal(result.agent, "orca");
    assert.equal(result.reason, "explicitly_released");
    return true;
  });
  await assert.rejects(
    call("agent_spawn", create(), "released-name"),
    code("AGENT_EXISTS"),
    "a killed name stays taken",
  );
});

test("agent_run requires continues and never forwards it to the Agent", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f);
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
  const { continues: _omitted, ...missing } = run("orca");
  for (const args of [
    missing,
    run("orca", { continues: "" }),
    run("orca", { continues: " " }),
    run("orca", { continues: "x".repeat(513) }),
  ])
    await assert.rejects(call("agent_run", args, "invalid"), code("INVALID_PARAMETERS"));
  await call(
    "agent_run",
    run("orca", { prompt: "Review the parser fix", continues: "UNIQUE_CONTINUES_MARKER" }),
    "valid",
  );
  await until(() => f.ports[0].calls.length === 2);
  assert.match(
    JSON.stringify(f.ports[0].calls[1]),
    /Review the parser fix/,
    "the inspected call is the follow-up prompt",
  );
  assert.doesNotMatch(
    JSON.stringify(f.ports[0].calls),
    /UNIQUE_CONTINUES_MARKER/,
    "a reuse justification is for the parent, not the Agent's prompt",
  );
});
