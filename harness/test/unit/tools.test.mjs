import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildTools as createCommunicationTools } from "../../dist/tools/child-tools.js";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { Check } from "typebox/value";
import { assertCallerTools } from "../support/caller-contract.mjs";
import { blockedDelegationToolNames as blockedDelegationTools, cleanupToolNames, managementToolNames as delegationTools,
  workerToolSelection } from "../../dist/tools/tool-names.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { ParentHistoryError } from "../../dist/core/ports.js";
import { deferred, ended, fixture, tick, until } from "../support/controller-fixture.mjs";

for (const [name, key] of [["notify_parent", "message"], ["ask_parent", "question"]]) {
  test(`${name} rechecks post-validation mutations before callback side effects`, async () => {
    const calls = { notify: [], question: [] };
    const callbacks = { notify: (value) => calls.notify.push(value), question: (value) => calls.question.push(value) };
    const tool = createCommunicationTools(() => callbacks, { accepting: true, stopped: false }).find((tool) => tool.name === name);
    for (const value of [undefined, null, 42, [], ["array has slice"], {}, "", " \t\n", "\u3000", "x".repeat(8193)]) {
      const args = { [key]: "valid before tool_call" };
      assert(Check(tool.parameters, args)); args[key] = value;
      await assert.rejects(tool.execute("call", args), { code: "INVALID_PARAMETERS" });
    }
    await assert.rejects(tool.execute("call", { [key]: "valid", extra: true }), { code: "INVALID_PARAMETERS" });
    assert.deepEqual(calls, { notify: [], question: [] });
    await tool.execute("call", { [key]: "x".repeat(8192) });
    assert.deepEqual(calls, name === "ask_parent"
      ? { notify: [], question: ["x".repeat(8192)] }
      : { notify: ["x".repeat(8192)], question: [] });
  });
  test(`${name} retains Run input-gate checks`, async () => {
    let calls = 0;
    const callbacks = { notify: () => calls++, question: () => calls++ };
    for (const [current, gate] of [[undefined, { accepting: true, stopped: false }],
      [callbacks, { accepting: false, stopped: false }], [callbacks, { accepting: true, stopped: true }]]) {
      const tool = createCommunicationTools(() => current, gate).find((tool) => tool.name === name);
      await assert.rejects(tool.execute("call", { [key]: "valid" }), { code: "RUN_INPUT_CLOSED" });
    }
    assert.equal(calls, 0);
  });
}

const model = { provider: "fixture", id: "controlled", levels: ["off", "high"] };
const preset = (name = "fixture", modelId = "fixture/controlled", version = "v1", thinking = {}) => ({
  name, version, models: { light: modelId, standard: modelId, strong: modelId },
  thinking: { light: {}, standard: {}, strong: {}, ...thinking }, digest: "a".repeat(64),
  effort: { light: "inherit", standard: "inherit", strong: "inherit" },
  effort_defaults: { light: "inherit", standard: "inherit", strong: "inherit" }, effort_overrides: {},
});
const profiles = () => Object.fromEntries(["editor", "reader"].map((name) => [name, { definition: `${name} definition`, tools: ["read"] }]));
const code = (value) => (error) => JSON.parse(error.message).error.code === value;
// Replies carry only caller choices; routing is asserted on the host-side view.
const routed = (f, reply) => f.controller.view(reply.run_id).effective_settings;
function toolsFor(f, hooks = {}) {
  const state = { active: true, model, thinking: "off", catalog: [model], preset: preset(), entries: [] };
  const manager = { getSessionId: () => f.owner_id,
    buildSessionProjection: () => ({ messages: state.entries.map((entry) => entry.message) }) };
  const registry = { getAll: () => state.catalog };
  const ctx = {
    get sessionManager() { if (!state.active) throw new Error("SDK stale context"); return manager; },
    get modelRegistry() { return registry; },
    get cwd() { return "/tmp"; }, get model() { return state.model; }, get thinkingLevel() { return state.thinking; },
  };
  const source = profiles();
  const options = { controller: f.controller, context: ctx, profiles: source,
    getSupportedThinkingLevels: (model) => model.levels, getPreset: () => structuredClone(state.preset), ...hooks };
  const tools = createOwnerTools(options);
  const tool = (name) => tools.find((item) => item.name === name);
  const call = async (name, args, id = name, context = ctx, signal) => {
    const result = await tool(name).execute(id, args, signal, undefined, context);
    assert.equal(result.details, undefined); return JSON.parse(result.content[0].text);
  };
  return { state, ctx, source, options, tools, tool, call };
}
const create = (rest = {}) => ({ prompt: "task", description: "task", profile: "reader",
  difficulty: 3, ...rest });

test("serialized tool schemas explain task fields and independent capability/routing choices", async (t) => {
  const f = await fixture(t), { tools } = toolsFor(f);
  assertCallerTools(tools);
  assert.deepEqual(f.controller.list(), [], "description checks must not dispatch work");
});

test("only prompt carries the assignment; labels and default-disabled context do not", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  state.entries = [{ message: { role: "user", content: "PARENT_CONTEXT_NOT_INHERITED" } }];
  const prompt = "Inspect source only; no edits. Return findings and evidence.";
  const run = await call("spawn_agent", create({ prompt, description: "RUN_LABEL_NOT_INSTRUCTIONS", name: "AGENT_LABEL" }));
  await until(() => f.ports[0]?.streaming);
  assert.equal(f.ports[0].calls[0].prompt, prompt);
  assert.equal(f.controller.view(run.run_id).effective_settings.context_snapshot, undefined);
  f.ports[0].finish("findings"); await ended(f.controller, run);
});

test("identical arguments deduplicate only the same host call ID, not a fresh model call", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { call } = toolsFor(f);
  const args = create({ description: "Recoverable task label", difficulty: 1 });
  const first = await call("spawn_agent", args, "host-call-1");
  assert.equal((await call("spawn_agent", args, "host-call-1")).run_id, first.run_id);
  await assert.rejects(call("spawn_agent", { ...args, difficulty: 2 }, "host-call-1"), code("REQUEST_CONFLICT"),
    "a different rating conflicts even when both ratings use the light slot");
  const second = await call("spawn_agent", args, "host-call-2");
  assert.notEqual(second.run_id, first.run_id); assert.notEqual(second.agent_id, first.agent_id);
  const listed = await call("list_agents", {});
  assert.deepEqual(listed.agents.map((row) => row.run_id), [first.run_id, second.run_id]);
  assert(listed.agents.every((row) => row.description === args.description && !("prompt" in row)));
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  for (const port of f.ports) port.finish();
  await ended(f.controller, first); await ended(f.controller, second);
});

test("simple separate schemas reject mixed and post-gate mutated inputs before admission", async (t) => {
  const f = await fixture(t), { tools, tool, call } = toolsFor(f);
  assert.deepEqual(tools.map((x) => x.name).sort(), [...delegationTools].sort());
  assert(Object.isFrozen(delegationTools));
  assert.throws(() => delegationTools.splice(0), TypeError);
  assert.throws(() => delegationTools.push("mutated"), TypeError);
  for (const item of tools) {
    assert.equal(item.parameters.type, "object"); assert.equal(item.parameters.additionalProperties, false);
    for (const forbidden of ["anyOf", "oneOf", "allOf"]) assert(!JSON.stringify(item.parameters).includes(`"${forbidden}"`));
  }
  assert.throws(() => tool("spawn_agent").prepareArguments(create({ agent_id: "agent" })), code("INVALID_PARAMETERS"));
  assert.doesNotThrow(() => tool("spawn_agent").prepareArguments(create()), "thinking is harness-owned and normally absent");
  assert.throws(() => tool("spawn_agent").prepareArguments(create({ thinking: "off" })), code("OBSOLETE_PARAMETER"));
  assert.throws(() => tool("spawn_agent").prepareArguments(create({ model: "fixture/controlled" })), code("OBSOLETE_PARAMETER"));
  for (const args of [create({ strength: "standard" }), create({ strength: "strong", difficulty: 5 })]) {
    assert.throws(() => tool("spawn_agent").prepareArguments(args), code("OBSOLETE_PARAMETER"));
    await assert.rejects(call("spawn_agent", args), code("OBSOLETE_PARAMETER"));
  }
  for (const key of ["effort", "effort_source", "effort_overrides"]) {
    assert.throws(() => tool("spawn_agent").prepareArguments(create({ [key]: "high" })), code("OBSOLETE_PARAMETER"));
    await assert.rejects(call("spawn_agent", create({ [key]: "high" })), code("OBSOLETE_PARAMETER"));
  }
  for (const [key, value] of [["model", "fixture/controlled"], ["provider", "fixture"], ["thinking", "high"],
    ["effort", "high"], ["effort_source", "user_override"], ["effort_overrides", { standard: "high" }],
    ["difficulty", 4], ["strength", "strong"], ["tools", ["write"]]]) {
    assert.throws(() => tool("resume_agent").prepareArguments({ agent_id: "agent", prompt: "task", [key]: value }),
      (error) => code("IMMUTABLE_SETTING")(error) && !error.message.includes("fixture/controlled"));
  }
  const mutated = tool("spawn_agent").prepareArguments(create()); mutated.owner_id = "forged";
  await assert.rejects(call("spawn_agent", mutated), code("INVALID_PARAMETERS"));
  const rescored = tool("spawn_agent").prepareArguments(create()); rescored.difficulty = 2.5;
  await assert.rejects(call("spawn_agent", rescored), code("INVALID_DIFFICULTY"));
  const obsolete = tool("spawn_agent").prepareArguments(create()); obsolete.strength = "light";
  await assert.rejects(call("spawn_agent", obsolete), code("OBSOLETE_PARAMETER"));
  await assert.rejects(call("spawn_agent", create({ cwd: "/other" })), code("INVALID_PARAMETERS"));
  await assert.rejects(call("read_run", { run_id: "id", path: "/private/session.jsonl" }), code("INVALID_PARAMETERS"));
  for (const max_duration_ms of [0, 86400001, 1.5]) {
    assert.throws(() => tool("spawn_agent").prepareArguments(create({ max_duration_ms })), code("INVALID_PARAMETERS"));
    assert.throws(() => tool("resume_agent").prepareArguments({ agent_id: "agent", prompt: "x", max_duration_ms }), code("INVALID_PARAMETERS"));
  }
  assert.deepEqual(f.controller.list(), []); assert.equal(f.ports.length, 0);
});

test("Agent/Run API has only new names and closed migrated parameter schemas", async (t) => {
  const f = await fixture(t), { tools, tool, call, options } = toolsFor(f);
  assert.deepEqual(tools.map((item) => item.name).sort(), [
    "spawn_agent", "resume_agent", "list_agents", "release_agent", "wait_runs", "read_run", "steer_run", "cancel_run", "post_update",
  ].sort());
  assert(Object.isFrozen(blockedDelegationTools));
  for (const name of blockedDelegationTools) assert.throws(() => createOwnerTools({ ...options,
    profiles: { ...options.profiles, editor: { ...options.profiles.editor, tools: [name] } },
  }), { code: "INVALID_PROFILE_DEFINITION" });
  const spawn = tool("spawn_agent").parameters, resume = tool("resume_agent").parameters;
  assert.deepEqual(spawn.properties.profile.enum, ["editor", "reader"]);
  assert.equal("strength" in spawn.properties, false);
  assert(spawn.required.includes("difficulty")); assert.equal("difficulty" in resume.properties, false);
  assert.equal(spawn.properties.difficulty.minimum, 1); assert.equal(spawn.properties.difficulty.maximum, 5);
  assert.equal(Check(spawn, create({ profile: "unknown" })), false);
  assert.equal(Check(spawn, create({ difficulty: 0 })), false);
  assert.equal(Check(spawn, create({ difficulty: 3.5 })), false);
  assert.equal(Check(spawn, (({ difficulty: _difficulty, ...args }) => args)(create())), false);
  assert.equal("role" in spawn.properties, false); assert.equal("role" in resume.properties, false);
  assert(resume.required.includes("agent_id")); assert.equal("resume" in resume.properties, false);
  for (const [name, args, expected] of [
    ["spawn_agent", create({ role: "reviewer" }), "OBSOLETE_PARAMETER"],
    ["spawn_agent", create({ strength: "light" }), "OBSOLETE_PARAMETER"],
    ["spawn_agent", create({ difficulty: 2, strength: "light" }), "OBSOLETE_PARAMETER"],
    ["resume_agent", { agent_id: "agent", prompt: "task", difficulty: 4 }, "IMMUTABLE_SETTING"],
    ["resume_agent", { agent_id: "agent", prompt: "task", strength: "strong" }, "IMMUTABLE_SETTING"],
    ["resume_agent", { agent_id: "agent", prompt: "task", role: "reviewer" }, "OBSOLETE_PARAMETER"],
    ["resume_agent", { resume: "agent", prompt: "task" }, "INVALID_PARAMETERS"],
    ["resume_agent", { agent_id: "agent", resume: "agent", prompt: "task" }, "INVALID_PARAMETERS"],
    ["read_run", { run_id: "run", limit: 10 }, "INVALID_PARAMETERS"],
    ["read_run", { run_id: "run", max_chars: 10, limit: 10 }, "INVALID_PARAMETERS"],
    ["wait_runs", { run_ids: ["run"], mode: "other" }, "INVALID_PARAMETERS"],
  ]) {
    assert.throws(() => tool(name).prepareArguments(args), code(expected));
    await assert.rejects(call(name, args), code(expected));
  }
  for (const max_chars of [0, -1, 1.5, 16385, NaN]) {
    await assert.rejects(call("read_run", { run_id: "run", max_chars }), code("INVALID_PARAMETERS"));
  }
  for (const max_chars of [1, 16384]) assert(Check(tool("read_run").parameters, { run_id: "run", max_chars }));
  assert.equal(tool("wait_runs").parameters.properties.mode.default, "all");
  assert(Check(tool("wait_runs").parameters, { run_ids: ["run"] }));
  assert.equal(f.controller.list().length, 0); assert.equal(f.ports.length, 0);
});

test("read_run max_chars maps to UTF-16 paging without changing the separate full question", async (t) => {
  const f = await fixture(t), { call } = toolsFor(f);
  const run = await call("spawn_agent", create());
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Full recorded question");
  const text = "🚀" + "x".repeat(5000);
  f.ports[0].finish(text); await ended(f.controller, run);
  const normal = await call("read_run", { run_id: run.run_id });
  assert.equal(normal.text.length, 4096); assert.equal(normal.complete, false);
  const first = await call("read_run", { run_id: run.run_id, max_chars: 1 });
  assert.equal(first.text, "🚀"); assert.equal(first.question, "Full recorded question");
  const rest = await call("read_run", { run_id: run.run_id, cursor: first.next_cursor, max_chars: 16384 });
  assert.equal(first.text + rest.text, text); assert.equal(rest.complete, true);
});

test("resolver exposes bounded abstract choices and incompatibility without model inventory", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  for (const invalid of [undefined, null, "3", 0, -1, 6, 1.5, NaN, Infinity]) {
    const args = create({ difficulty: invalid });
    await assert.rejects(call("spawn_agent", args), (error) => {
      const result = JSON.parse(error.message).error;
      assert.deepEqual(result, { code: "INVALID_DIFFICULTY", parameter: "difficulty",
        resolution: "Use an integer from 1 to 5 to rate the task difficulty." });
      return true;
    });
  }
  await assert.rejects(call("spawn_agent", create({ profile: "unknown" })), (error) => {
    const result = JSON.parse(error.message).error; assert.equal(result.code, "INVALID_PROFILE");
    assert.deepEqual(result.allowed, ["editor", "reader"]);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false); return true;
  });
  const { difficulty: _difficulty, ...missing } = create();
  await assert.rejects(call("spawn_agent", missing), code("INVALID_PARAMETERS"));
  state.thinking = "low";
  await assert.rejects(call("spawn_agent", create(), "unsupported-parent"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.deepEqual(result, { code: "THINKING_INCOMPATIBLE", parameter: "parent_thinking",
      reason: "identity_unsupported_no_mapping", difficulty: 3, parent_thinking: "low",
      resolution: "Ask the user to change the parent Pi thinking level or worker preset. Do not change difficulty to bypass configuration errors." });
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false); return true;
  });
  assert.deepEqual(f.controller.list(), []); assert.equal(f.ports.length, 0);
});

test("missing or invalid parent thinking is a host error and cannot reinterpret accepted requests or resume", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  const first = await call("spawn_agent", create(), "accepted-host-state");
  await until(() => f.ports[0]?.streaming); f.ports[0].finish(); await ended(f.controller, first);
  for (const [index, value] of [undefined, null, "", "unknown"].entries()) {
    state.thinking = value;
    assert.equal((await call("spawn_agent", create(), "accepted-host-state")).run_id, first.run_id);
    await assert.rejects(call("spawn_agent", create(), `invalid-host-state-${index}`), (error) => {
      const result = JSON.parse(error.message).error;
      assert.equal(result.code, "PARENT_THINKING_UNAVAILABLE");
      assert.match(result.message, /Pi did not provide/); assert.match(result.resolution, /Ask the user/);
      assert.match(result.resolution, /Do not change difficulty to bypass configuration errors\.$/);
      assert.equal(result.parameter, undefined); assert.equal(result.parent_thinking, undefined);
      return true;
    });
  }
  state.thinking = undefined;
  const queued = call("spawn_agent", create(), "queued-missing-thinking");
  state.thinking = "off";
  await assert.rejects(queued, code("PARENT_THINKING_UNAVAILABLE"), "queued admission retains the missing snapshot");
  assert.equal(f.controller.list().length, 1); assert.equal(f.ports.length, 1);
  state.thinking = undefined;
  const resumed = await call("resume_agent", { agent_id: first.agent_id, prompt: "again" }, "resume-without-parent-thinking");
  assert.equal(routed(f, resumed).thinking, "off"); assert.equal(routed(f, resumed).parent_thinking, "off");
  await until(() => f.ports[0].streaming); f.ports[0].finish(); await ended(f.controller, resumed);
});

test("thinking resolution is identity-first and uses only explicit compatible mappings", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  state.thinking = "low";
  state.preset = preset("mapped", "fixture/controlled", "v2", { standard: { low: "high", high: "off" } });
  const mapped = await call("spawn_agent", create(), "mapped");
  assert.deepEqual(mapped.settings, { profile: "reader", difficulty: 3 });
  const route = routed(f, mapped);
  assert.deepEqual([route.preset, route.preset_version, route.parent_thinking, route.thinking, route.thinking_resolution],
    ["mapped", "v2", "low", "high", "preset_mapping"]);
  await until(() => f.ports[0]?.streaming); f.ports[0].finish(); await ended(f.controller, mapped);

  state.thinking = "high";
  const identity = await call("spawn_agent", create(), "identity");
  assert.equal(routed(f, identity).thinking, "high", "a configured map cannot override supported identity");
  assert.equal(routed(f, identity).thinking_resolution, "identity");
  await until(() => f.ports[1]?.streaming); f.ports[1].finish(); await ended(f.controller, identity);

  state.thinking = "low";
  state.preset = preset("bad-target", "fixture/controlled", "v3", { standard: { low: "medium" } });
  await assert.rejects(call("spawn_agent", create(), "bad-target"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE"); assert.equal(result.reason, "mapped_target_unsupported");
    assert.equal(result.parent_thinking, "low"); assert.equal("thinking" in result, false);
    assert.match(result.resolution, /change the parent Pi thinking level or worker preset/);
    assert.match(result.resolution, /Do not change difficulty to bypass configuration errors/);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false); return true;
  });
  state.thinking = "off"; state.model = { ...model, levels: ["high"] }; state.catalog = [state.model];
  state.preset = preset("no-off", "fixture/controlled", "v4");
  await assert.rejects(call("spawn_agent", create(), "no-off"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE"); assert.equal(result.reason, "identity_unsupported_no_mapping");
    assert.equal(result.parent_thinking, "off"); assert.match(result.resolution, /change the parent Pi thinking level/); return true;
  });
});

test("each new creation inherits current parent thinking while resume remains pinned", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { state, call } = toolsFor(f);
  state.thinking = "off";
  const first = await call("spawn_agent", create(), "parent-off");
  state.thinking = "high";
  const second = await call("spawn_agent", create(), "parent-high");
  assert.deepEqual([routed(f, first).parent_thinking, routed(f, first).thinking], ["off", "off"]);
  assert.deepEqual([routed(f, second).parent_thinking, routed(f, second).thinking], ["high", "high"]);
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[0].finish(); f.ports[1].finish(); await ended(f.controller, first); await ended(f.controller, second);
  state.thinking = "off";
  const resumed = await call("resume_agent", { agent_id: second.agent_id, prompt: "again" }, "resume-pinned-thinking");
  assert.deepEqual([routed(f, resumed).parent_thinking, routed(f, resumed).thinking], ["high", "high"]);
  await until(() => f.ports[1].calls.length === 2); f.ports[1].finish(); await ended(f.controller, resumed);
});

test("queued creations snapshot parent thinking before admission waits", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { state, call } = toolsFor(f);
  state.thinking = "off";
  const firstPromise = call("spawn_agent", create(), "queued-parent-off");
  state.thinking = "high";
  const secondPromise = call("spawn_agent", create(), "queued-parent-high");
  state.thinking = "off";
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(routed(f, first).parent_thinking, "off"); assert.equal(routed(f, first).thinking, "off");
  assert.equal(routed(f, second).parent_thinking, "high"); assert.equal(routed(f, second).thinking, "high");
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[0].finish(); f.ports[1].finish(); await ended(f.controller, first); await ended(f.controller, second);
});

test("preset/profile/context snapshots pin at admission; same ID keeps first acceptance", async (t) => {
  const f = await fixture(t), { state, source, call } = toolsFor(f);
  state.entries = [
    { message: { role: "user", content: "USER_CONTEXT" } },
    { message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT_CONTEXT" }, { type: "thinking", thinking: "PRIVATE_REASONING" }] } },
    { message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL_TEXT" }] } },
  ];
  const args = create({ inherit_context: true });
  const starting = call("spawn_agent", args, "snapshot");
  args.prompt = "mutated caller";
  state.entries[0].message.content = "LATE_CONTEXT";
  source["reader"].definition = "mutated profile"; source["reader"].tools.push("write");
  const run = await starting;
  // Main-session settings are unrelated to worker routing. A later preset/config
  // change also cannot reinterpret this accepted tool-call ID.
  state.model = { provider: "parent", id: "changed", levels: ["off"] }; state.thinking = "high";
  state.preset = preset("broken", "missing/model", "v2");
  state.catalog = [state.model];
  assert.equal(run.max_duration_ms, 1_800_000);
  await until(() => f.ports[0]?.streaming);
  const view = f.controller.view(run.run_id);
  assert.equal(view.effective_settings.model, "controlled"); assert.equal(view.effective_settings.thinking, "off");
  assert.equal(view.effective_settings.parent_thinking, "off");
  assert.equal(view.effective_settings.thinking_resolution, "identity");
  assert.equal(view.effective_settings.preset, "fixture"); assert.equal(view.effective_settings.difficulty, 3);
  assert.equal(view.effective_settings.strength, "standard", "internal route retains its slot");
  assert.equal(view.effective_settings.definition_digest, digest("reader definition"));
  assert.deepEqual(view.effective_settings.tools, ["read"]);
  assert.equal(view.effective_settings.context_digest, digest("[user]\nUSER_CONTEXT\n\n[assistant]\nASSISTANT_CONTEXT"));
  assert(!JSON.stringify(run).includes("USER_CONTEXT"));
  // Even a now-oversized context and incompatible defaults cannot reinterpret an accepted ID.
  state.entries = [{ message: { role: "user", content: "x".repeat(65537) } }];
  const duplicate = await call("spawn_agent", create({ inherit_context: true }), "snapshot");
  assert.equal(duplicate.run_id, run.run_id); assert.equal(f.ports.length, 1);
  await assert.rejects(call("spawn_agent", create({ inherit_context: true, prompt: "conflict" }), "snapshot"), code("REQUEST_CONFLICT"));
  await assert.rejects(call("spawn_agent", create(), "changed-config"), code("PRESET_MODEL_UNAVAILABLE"));
  state.preset = preset(); state.catalog = [{ ...model, levels: ["off"] }];
  await assert.rejects(call("spawn_agent", create(), "changed-thinking"), code("THINKING_INCOMPATIBLE"));
  state.catalog = [model];
  await assert.rejects(call("spawn_agent", create({ inherit_context: true }), "oversized"), code("CONTEXT_SNAPSHOT_TOO_LARGE"));
  f.ports[0].finish("first"); await ended(f.controller, run);
  const resumed = await call("resume_agent", { agent_id: run.agent_id, prompt: "follow-up", max_duration_ms: 86400000 }, "resume");
  assert.equal(resumed.agent_id, run.agent_id); assert.notEqual(resumed.run_id, run.run_id);
  assert.equal(resumed.max_duration_ms, 86400000);
  assert.equal(resumed.settings.model, undefined); assert.equal(routed(f, resumed).preset, "fixture");
  assert.equal(resumed.settings.difficulty, 3); assert.equal("strength" in resumed.settings, false);
  assert.equal(routed(f, resumed).thinking, "off");
  assert.equal(routed(f, resumed).parent_thinking, "off"); assert.equal(routed(f, resumed).thinking_resolution, "identity");
  await until(() => f.ports[0].streaming); f.ports[0].finish("second"); await ended(f.controller, resumed);
  assert.equal((await call("read_run", { run_id: run.run_id })).text, "first");
  await assert.rejects(call("resume_agent", { agent_id: run.agent_id, prompt: "follow-up", max_duration_ms: 1 }, "resume"), code("REQUEST_CONFLICT"));
});

for (const compacted of [false, true]) test(`inherited SDK projection respects omission and replacement (compacted=${compacted})`, async (t) => {
  const sessionManager = SessionManager.inMemory("/tmp");
  sessionManager.appendMessage({ role: "user", content: "OLDER_CONTEXT", timestamp: 0 });
  const kept = sessionManager.appendMessage({ role: "user", content: "ORIGINAL_USER", timestamp: 1 });
  const failed = sessionManager.appendMessage({ role: "assistant", stopReason: "error", timestamp: 2,
    content: [{ type: "text", text: "OMITTED_DRAFT" + "x".repeat(65536) }] });
  sessionManager.appendContextEdit(failed, null);
  sessionManager.appendContextEdit(kept, { content: "REPLACED_USER" });
  sessionManager.appendMessage({ role: "assistant", stopReason: "stop", timestamp: 3,
    content: [{ type: "text", text: "RETRY_SUCCEEDED" }] });
  if (compacted) sessionManager.appendCompaction("SUMMARY", kept, 70000);
  const f = await fixture(t, { owner_id: sessionManager.getSessionId() });
  const { ctx, options } = toolsFor(f);
  const context = { ...ctx, sessionManager };
  const tools = createOwnerTools({ ...options, context });
  const result = await tools.find((tool) => tool.name === "spawn_agent").execute("projected-snapshot",
    create({ inherit_context: true }), undefined, undefined, context);
  const run = JSON.parse(result.content[0].text);
  await until(() => f.ports[0]?.streaming);
  const snapshot = (compacted ? "[compactionSummary]\nSUMMARY" : "[user]\nOLDER_CONTEXT") +
    "\n\n[user]\nREPLACED_USER\n\n[assistant]\nRETRY_SUCCEEDED";
  assert.equal(f.ports[0].calls[0].prompt, `${snapshot}\n\ntask`);
  assert.equal(f.controller.view(run.run_id).effective_settings.context_digest, digest(snapshot));
  assert(sessionManager.getEntries().some((entry) => entry.id === failed), "omission must not delete raw history");
  assert.equal(sessionManager.getEntry(kept).message.content, "ORIGINAL_USER", "replacement is context-only");
  f.ports[0].finish(); await ended(f.controller, run);
});

test("fixed owner binding rejects stale closures, foreign managers and queued context replacement", async (t) => {
  const f = await fixture(t), { state, ctx, options, call } = toolsFor(f);
  const foreign = { ...ctx, sessionManager: { getSessionId: () => f.owner_id } };
  await assert.rejects(call("spawn_agent", create(), "foreign", foreign), code("STALE_OWNER_CONTEXT"));
  assert.throws(() => createOwnerTools({ ...options, context: { ...ctx, sessionManager: { getSessionId: () => "another owner" } } }), { code: "OWNER_CONTEXT_MISMATCH" });
  const queued = call("spawn_agent", create(), "queue-stale"); state.active = false;
  await assert.rejects(queued, code("STALE_OWNER_CONTEXT"));
  await assert.rejects(call("list_agents", {}, "old", { ...foreign, sessionManager: options.context }), code("STALE_OWNER_CONTEXT"));
  assert.deepEqual(f.controller.list(), []); assert.equal(f.ports.length, 0);
});

test("wait abort is separate from Run cancellation; explicit release closes the capacity loop", async (t) => {
  const f = await fixture(t, { controller: { resident_limit: 1 } }), { call } = toolsFor(f);
  const run = await call("spawn_agent", create(), "one"); await until(() => f.ports[0]?.streaming);
  await assert.rejects(call("spawn_agent", create(), "full"), code("RESIDENT_LIMIT"));
  const abort = new AbortController(); abort.abort();
  assert.equal((await call("wait_runs", { run_ids: [run.run_id], mode: "all" }, "wait", undefined, abort.signal)).reason, "interrupted");
  assert.equal(f.ports[0].stopped, 0);
  await assert.rejects(call("release_agent", { agent_id: run.agent_id }), code("AGENT_BUSY"));
  assert.equal((await call("steer_run", { run_id: run.run_id, message: "continue" })).accepted, true);
  assert.equal((await call("cancel_run", { run_id: run.run_id })).cancel, "cancel_requested");
  assert.equal(f.controller.view(run.run_id).status, "cancelling");
  f.ports[0].finish("partial", "aborted"); await ended(f.controller, run);
  assert.deepEqual(await call("release_agent", { agent_id: run.agent_id }), { agent_id: run.agent_id, released: true });
  assert.equal((await call("read_run", { run_id: run.run_id })).text, "partial");
  const second = await call("spawn_agent", create(), "full"); await until(() => f.ports[1]?.streaming);
  const list = await call("list_agents", { limit: 1 }); assert.equal(list.agents[0].agent_id, second.agent_id); assert.equal(list.next_offset, undefined);
  const history = await call("list_agents", { include_released: true, limit: 1 }); assert.equal(history.agents[0].agent_id, run.agent_id);
  const tail = await call("list_agents", { include_released: true, offset: history.next_offset, limit: 1 }); assert.equal(tail.agents[0].agent_id, second.agent_id);
  f.ports[1].finish("done"); await ended(f.controller, second);
});

test("steer schema and post-gate recheck match the controller's exact message bound", async (t) => {
  const f = await fixture(t), { call, tool } = toolsFor(f);
  const run = await call("spawn_agent", create(), "bounds"); await until(() => f.ports[0]?.streaming);
  const args = { run_id: run.run_id, message: "x".repeat(16384) };
  assert.equal((await call("steer_run", args)).accepted, true);
  await until(() => f.ports[0].inputs.length === 1); assert.equal(f.ports[0].inputs[0].length, 16384);
  const ready = tool("steer_run").prepareArguments(args); ready.message += "x";
  assert.throws(() => tool("steer_run").prepareArguments(ready), code("INVALID_PARAMETERS"));
  await assert.rejects(call("steer_run", ready), code("INVALID_PARAMETERS"));
  assert.equal(f.ports[0].inputs.length, 1);
  f.ports[0].finish(); await ended(f.controller, run);
});

for (const off of [false, true]) test(`terminal steer returns the bounded result without input or execution (Off=${off})`, async (t) => {
  const admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => ({ ...admission }) } }), { call } = toolsFor(f);
  const cases = [
    { status: "completed", text: "C".repeat(5000), finish: (port) => port.finish("C".repeat(5000)) },
    { status: "failed", text: "failed output", runReason: "execution_error", finish: (port) => port.finish("failed output", "error", "synthetic failure") },
    { status: "needs_input", text: "waiting output", question: "What next?", finish: (port) => {
      port.callbacks.question("What next?"); port.finish("waiting output");
    } },
    { status: "cancelled", text: "cancelled output", cancel: true, finish: (port) => port.finish("cancelled output", "aborted") },
  ];
  for (let index = 0; index < cases.length; index++) {
    const expected = cases[index];
    admission.enabled = true;
    const run = await call("spawn_agent", create(), `terminal-${index}`);
    await until(() => f.ports[index]?.streaming);
    if (expected.cancel) await call("cancel_run", { run_id: run.run_id });
    expected.finish(f.ports[index]); await ended(f.controller, run);
    if (off) { admission.enabled = false; admission.revision++; }
    const events = f.events.length, calls = f.ports[index].calls.length;
    const reply = await call("steer_run", { run_id: run.run_id, message: "too late" });
    assert.equal(reply.accepted, false); assert.equal(reply.reason, "RUN_INPUT_CLOSED");
    assert.equal(reply.status, expected.status); assert.equal(reply.text, expected.text.slice(0, 4096));
    assert.equal(reply.complete, expected.text.length <= 4096);
    assert.equal(reply.question, expected.question); assert.equal(reply.run_reason, expected.runReason);
    assert.equal(f.events.length, events); assert.equal(f.ports[index].calls.length, calls);
    assert.deepEqual(f.ports[index].inputs, []);
    if (reply.next_cursor) {
      const rest = await call("read_run", { run_id: run.run_id, cursor: reply.next_cursor });
      assert.equal(reply.text + rest.text, expected.text); assert.equal(rest.complete, true);
    }
  }
  await assert.rejects(call("steer_run", { run_id: "unknown", message: "x" }), code("RUN_NOT_FOUND"));
});

for (const off of [false, true]) test(`steer keeps cancelling/finalizing RUN_INPUT_CLOSED errors (Off=${off})`, async (t) => {
  const admission = { enabled: true, revision: 0 };
  const finishGate = deferred(); let finishes = 0;
  t.after(() => finishGate.resolve());
  const f = await fixture(t, { controller: { admission: () => ({ ...admission }) }, history: async (point) => {
    if (point === "finish" && ++finishes === 2) await finishGate.promise;
  } });
  const { call } = toolsFor(f);
  const cancelling = await call("spawn_agent", create(), "cancelling"); await until(() => f.ports[0]?.streaming);
  await call("cancel_run", { run_id: cancelling.run_id });
  if (off) { admission.enabled = false; admission.revision++; }
  await assert.rejects(call("steer_run", { run_id: cancelling.run_id, message: "too late" }), code("RUN_INPUT_CLOSED"));
  f.ports[0].finish("cancelled", "aborted"); await ended(f.controller, cancelling);
  admission.enabled = true;
  const finishing = await call("spawn_agent", create(), "finishing"); await until(() => f.ports[1]?.streaming);
  f.ports[1].finish("done"); await until(() => f.controller.view(finishing.run_id).finalization_pending);
  if (off) { admission.enabled = false; admission.revision++; }
  await assert.rejects(call("steer_run", { run_id: finishing.run_id, message: "too late" }), code("RUN_INPUT_CLOSED"));
  assert.deepEqual(f.ports[1].inputs, []);
  finishGate.resolve(); await ended(f.controller, finishing);
});

test("a wait finishing after context invalidation suppresses reply, not accepted work or claims", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  const run = await call("spawn_agent", create(), "accepted"); await until(() => f.ports[0]?.streaming);
  const waiting = call("wait_runs", { run_ids: [run.run_id], mode: "all" });
  f.ports[0].callbacks.notify("claimed once, even if the old caller cannot receive it");
  state.active = false;
  f.ports[0].finish("kept");
  await assert.rejects(waiting, code("STALE_OWNER_CONTEXT"));
  assert.equal(f.controller.view(run.run_id).pending_messages, 0);
  assert.equal(f.controller.view(run.run_id).status, "completed");
  await ended(f.controller, run);
  assert.equal(f.controller.getResult(run.run_id).text, "kept");
});

test("ambiguous preset model keys fail without inventory; long tool-call IDs remain bounded and idempotent", async (t) => {
  const f = await fixture(t), { state, source, options, call } = toolsFor(f);
  state.catalog = [model, { ...model }];
  await assert.rejects(call("spawn_agent", create()), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "PRESET_MODEL_UNAVAILABLE"); assert.equal("preset" in result, false);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false); return true;
  });
  source["reader"].tools.push("resume_agent");
  assert.throws(() => createOwnerTools(options), { code: "INVALID_PROFILE_DEFINITION" });
  state.catalog = [model];
  const id = "sdk-call-".repeat(1000);
  const run = await call("spawn_agent", create(), id);
  assert.equal((await call("spawn_agent", create(), id)).run_id, run.run_id);
  await until(() => f.ports[0]?.streaming); f.ports[0].finish(); await ended(f.controller, run);
});

test("uncertain release remains an explicit negative receipt through the tool adapter", async (t) => {
  const f = await fixture(t, { cleanupUncertainExpected: true }), { call } = toolsFor(f);
  const run = await call("spawn_agent", create(), "uncertain-tool");
  await until(() => f.ports[0]?.streaming); f.ports[0].finish(); await ended(f.controller, run);
  f.ports[0].dispose = async () => ({ shutdownExited: false, errors: ["unknown"] });
  assert.deepEqual(await call("release_agent", { agent_id: run.agent_id }), {
    agent_id: run.agent_id, released: false, reason: "cleanup_uncertain",
  });
  assert.equal(f.controller.stats().resident, 1); assert.equal(f.controller.stats().closed, false);
  const listed = await call("list_agents", {});
  assert.equal(listed.agents.length, 1); assert.equal(listed.agents[0].agent_id, run.agent_id);
  assert.equal(listed.agents[0].unavailable_reason, "owner_cleanup_uncertain");
});

test("default listing skips released history before pagination, retaining busy, queued, idle and question Agents", async (t) => {
  const f = await fixture(t), { call, tool } = toolsFor(f);
  const old = [];
  for (let i = 0; i < 12; i++) {
    const run = await call("spawn_agent", create(), `old-${i}`); old.push(run);
    await until(() => f.ports[i]?.streaming); f.ports[i].finish(`old ${i}`); await ended(f.controller, run);
    await call("release_agent", { agent_id: run.agent_id });
  }
  assert.equal((await call("list_agents", {})).agents.length, 0);
  const busy = await call("spawn_agent", create(), "busy"); await until(() => f.ports[12]?.streaming);
  const queued = await call("spawn_agent", create(), "queued");
  const head = await call("list_agents", { limit: 1 });
  assert.equal(head.agents[0].run_id, busy.run_id); assert.equal(head.agents[0].status, "running");
  const tail = await call("list_agents", { limit: 1, offset: head.next_offset });
  assert.equal(tail.agents[0].run_id, queued.run_id); assert.equal(tail.agents[0].status, "queued"); assert.equal(tail.next_offset, undefined);
  f.ports[12].finish("idle"); await ended(f.controller, busy); await until(() => f.ports[13]?.streaming);
  const question = "Q".repeat(8192); f.ports[13].callbacks.question(question); f.ports[13].finish("waiting"); await ended(f.controller, queued);
  const live = await call("list_agents", {});
  assert.deepEqual(live.agents.map((run) => run.run_id), [busy.run_id, queued.run_id]);
  assert(live.agents.every((run) => run.resumable)); assert.equal(live.agents[1].has_question, true);
  assert.equal(live.agents[1].question, undefined); assert(Buffer.byteLength(JSON.stringify(live)) < 2048);
  assert.equal((await call("read_run", { run_id: queued.run_id })).question, question);
  const history = await call("list_agents", { include_released: true }); assert.equal(history.agents.length, 8);
  assert.equal(history.agents[0].run_id, old[0].run_id);
  const rest = await call("list_agents", { include_released: true, offset: history.next_offset });
  assert.deepEqual([...history.agents, ...rest.agents].map((run) => run.run_id), [...old.map((run) => run.run_id), busy.run_id, queued.run_id]);
  assert.equal((await call("read_run", { run_id: old[0].run_id })).text, "old 0");
  assert.throws(() => tool("list_agents").prepareArguments({ include_released: "yes" }), code("INVALID_PARAMETERS"));
  const changed = tool("list_agents").prepareArguments({ include_released: true }); changed.include_released = "yes";
  await assert.rejects(call("list_agents", changed), code("INVALID_PARAMETERS"));
});

test("a named Agent changes tasks on resume without changing nickname, identity or old Run labels", async (t) => {
  const f = await fixture(t), { call, tool } = toolsFor(f);
  const first = await call("spawn_agent", create({ name: "orca", prompt: "Inspect Windows startup",
    description: "Review Windows foundations" }), "windows-task");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish("reviewed Windows"); await ended(f.controller, first);
  const next = await call("resume_agent", { agent_id: first.agent_id, prompt: "Inspect GTK entry points",
    description: "Review GTK direct-entry safety" }, "gtk-task");
  await until(() => f.ports[0].calls.length === 2);
  assert.equal(next.agent_id, first.agent_id); assert.notEqual(next.run_id, first.run_id);
  const listed = (await call("list_agents", {})).agents;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "orca"); assert.equal(listed[0].description, "Review GTK direct-entry safety");
  assert.equal(f.controller.view(first.run_id).description, "Review Windows foundations");
  assert.deepEqual(f.controller.view(next.run_id).effective_settings, f.controller.view(first.run_id).effective_settings);
  assert.deepEqual(f.ports[0].calls.map((entry) => entry.prompt), ["Inspect Windows startup", "Inspect GTK entry points"]);
  assert.throws(() => tool("resume_agent").prepareArguments({ agent_id: first.agent_id, prompt: "Continue", name: "otter" }),
    code("IMMUTABLE_SETTING"));
  f.ports[0].finish("reviewed GTK"); await ended(f.controller, next);
});

test("on-demand labels recover unnamed task mappings and follow the latest Run without parent history", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { state, call } = toolsFor(f);
  const first = await call("spawn_agent", create({ prompt: "Inspect cancellation", description: "检查取消竞态" }), "race-task");
  const second = await call("spawn_agent", create({ prompt: "Inspect accounting", description: "检查压缩费用" }), "cost-task");
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  // The query must not depend on a parent summary preserving IDs or task text.
  state.entries = [{ message: { role: "compactionSummary", summary: "Delegated work is pending; task mapping omitted." } }];
  const listed = await call("list_agents", {});
  assert.deepEqual(listed.agents.map((row) => [row.agent_id, row.run_id, row.description, row.description_truncated]), [
    [first.agent_id, first.run_id, "检查取消竞态", false],
    [second.agent_id, second.run_id, "检查压缩费用", false],
  ]);
  assert(listed.agents.every((row) => row.status === "running" && !("name" in row)));
  assert.deepEqual(f.ports.map((port) => port.calls[0].prompt), ["Inspect cancellation", "Inspect accounting"],
    "task labels are metadata, never additional worker instructions");

  f.ports[0].finish("race findings"); await ended(f.controller, first);
  const resumed = await call("resume_agent", { agent_id: first.agent_id, prompt: "Review the fix",
    description: "复核取消修复" }, "review-task");
  await until(() => f.ports[0].calls.length === 2);
  const latest = (await call("list_agents", {})).agents;
  assert.deepEqual(latest.map((row) => [row.run_id, row.description]), [
    [resumed.run_id, "复核取消修复"], [second.run_id, "检查压缩费用"],
  ]);
  assert.equal(latest[0].status, "running"); assert.equal(f.ports[0].calls[1].prompt, "Review the fix");
  f.ports[0].finish("reviewed"); f.ports[1].finish("cost findings");
  await ended(f.controller, resumed); await ended(f.controller, second);
  const followUp = await call("resume_agent", { agent_id: first.agent_id, prompt: "Another task" }, "default-label");
  await until(() => f.ports[0].calls.length === 3);
  const defaulted = (await call("list_agents", {})).agents[0];
  assert.equal(defaulted.run_id, followUp.run_id); assert.equal(defaulted.description, "Follow-up task");
  assert.equal(defaulted.description_truncated, false, "omission never inherits the previous task label");
  f.ports[0].finish("done"); await ended(f.controller, followUp);

  const waited = await call("wait_runs", { run_ids: [first.run_id, second.run_id, resumed.run_id, followUp.run_id], mode: "all" });
  const result = await call("read_run", { run_id: first.run_id });
  for (const row of [first, second, resumed, followUp, result, ...waited.runs]) {
    assert.equal("description" in row, false); assert.equal("description_truncated" in row, false);
  }
  assert.equal(f.controller.view(first.run_id).description, "检查取消竞态", "resume does not rewrite old Run metadata");
});

test("a pending explicit release remains in the resident list until cleanup confirms release", async (t) => {
  const f = await fixture(t), { call } = toolsFor(f), gate = deferred();
  try {
    const run = await call("spawn_agent", create(), "cleaning"); await until(() => f.ports[0]?.streaming);
    f.ports[0].finish(); await ended(f.controller, run);
    f.ports[0].dispose = async () => { await gate.promise; return { shutdownExited: true, errors: [] }; };
    const releasing = call("release_agent", { agent_id: run.agent_id }); await until(() => f.controller.stats().cleaning === 1);
    assert.equal((await call("list_agents", {})).agents[0].agent_id, run.agent_id);
    gate.resolve(); assert.equal((await releasing).released, true);
    assert.equal((await call("list_agents", {})).agents.length, 0);
  } finally { gate.resolve(); }
});

test("whole wait replies bound questions, output, progress and diagnostics without losing continuations", async (t) => {
  const noisy = "\"\\\n\u0000文🚀", question = noisy.repeat(1200).slice(0, 8192), notice = question;
  const answer = "x".repeat(254) + "🚀" + noisy.repeat(600);
  let failParent = false;
  const f = await fixture(t, { history: (point) => {
    if (point === "begin" && failParent) throw new ParentHistoryError(noisy.repeat(600));
  } }), { call, tool, ctx } = toolsFor(f);
  const ids = []; let previous;
  for (let i = 0; i < 16; i++) {
    const run = previous ? await call("resume_agent", { agent_id: previous.agent_id, prompt: "next question", answer_to_run_id: previous.run_id }, `q-${i}`) :
      await call("spawn_agent", create({ name: noisy.repeat(40).slice(0, 256) }), "q-0");
    await until(() => f.ports[0]?.calls.length === i + 1);
    f.ports[0].callbacks.question(question);
    if (i === 15) f.ports[0].callbacks.notify(notice);
    f.ports[0].finish(answer, "success", noisy.repeat(400));
    await until(() => f.controller.view(run.run_id).phase === "settled");
    ids.push(run.run_id); previous = run;
  }
  // Include an actual owner-wide diagnostic, not just short happy-path replies.
  failParent = true;
  const damaged = await call("spawn_agent", create(), "parent-failure");
  await until(() => f.controller.view(damaged.run_id).phase === "settled");
  const raw = await tool("wait_runs").execute("bulk", { run_ids: ids, mode: "all" }, undefined, undefined, ctx);
  const reply = JSON.parse(raw.content[0].text);
  assert.equal(reply.runs.length, 16); assert.equal(reply.progress_claimed, 1);
  assert.equal(reply.progress_omitted, 1, "questions/results have priority over progress text");
  assert(reply.runs.every((run) => run.has_question && run.question_complete === false &&
    run.question_requires_get && ((run.error && run.owner_error) || run.diagnostic_omitted)));
  const includedText = reply.runs.reduce((count, run) => count + (run.question?.length ?? 0) + (run.text?.length ?? 0), 0);
  assert(includedText <= 16384);
  assert(Buffer.byteLength(JSON.stringify(raw), "utf8") <= 65536, "hard bound covers the model-facing content envelope");
  for (const run of reply.runs) {
    assert(run.text || run.result_requires_get, "a budget omission must name the get continuation");
    const rest = await call("read_run", { run_id: run.run_id,
      ...(run.next_cursor ? { cursor: run.next_cursor } : {}), max_chars: 16384 });
    assert.equal((run.text ?? "") + rest.text, answer); assert.equal(rest.question, question);
    assert.equal(rest.question_complete, true); assert.equal(rest.complete, true);
  }
  for (const count of [1, 4, 5, 15, 16]) {
    const batch = await call("wait_runs", { run_ids: ids.slice(0, count), mode: "all" });
    const textSize = batch.runs.reduce((size, run) => size + (run.question?.length ?? 0) + (run.text?.length ?? 0), 0);
    assert(textSize <= 16384);
    assert.equal(batch.progress, undefined, "notice was already claimed once");
    for (const run of batch.runs) {
      assert.equal(run.question_complete, run.question === question);
      assert.equal(!!run.question_requires_get, !run.question_complete);
    }
    if (count === 1) assert.equal(batch.runs[0].question_complete, true);
  }
  const status = await call("wait_runs", { run_ids: ids, mode: "all", include_results: false });
  assert(status.runs.every((run) => run.has_question && run.question_complete === false && run.text === undefined && run.result_requires_get));
  assert(Buffer.byteLength(JSON.stringify(status), "utf8") <= 65536);
  const dup = await call("wait_runs", { run_ids: [ids[0], ids[0]], mode: "all" });
  assert.equal(dup.runs.length, 1); assert.equal(dup.runs[0].question, question);
  assert.equal(dup.runs[0].question_complete, true); assert.equal(dup.runs[0].text, answer.slice(0, dup.runs[0].text.length));
  assert.equal(dup.runs[0].text + (await call("read_run", { run_id: ids[0], cursor: dup.runs[0].next_cursor })).text, answer);
  assert.equal((await f.controller.wait([ids[0]], { mode: "all", result_limit: 1 })).results[0].text, "x");
  for (const limit of [0, -1, 1.5, 16385, NaN]) await assert.rejects(f.controller.wait([ids[0]], { mode: "all", result_limit: limit }), { code: "INVALID_WAIT" });
});

test("all difficulty ratings route exact registered IDs, including a non-OpenAI fixture provider", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 3 } }), { state, call } = toolsFor(f);
  const routed = [
    { provider: "fixture-local", id: "small", levels: ["off"] },
    { provider: "fixture-local", id: "middle", levels: ["off", "high"] },
    { provider: "fixture-local", id: "large", levels: ["high"] },
  ];
  state.catalog = routed;
  state.preset = { ...preset(), name: "cross-provider", version: "v7", digest: "c".repeat(64), models: {
    light: "fixture-local/small", standard: "fixture-local/middle", strong: "fixture-local/large",
  }, thinking: { light: {}, standard: {}, strong: {} } };
  const requests = [create({ difficulty: 1 }), create({ difficulty: 3 }), create({ difficulty: 5 })];
  const inherited = ["off", "high", "high"];
  const runs = [];
  for (let index = 0; index < requests.length; index++) {
    state.thinking = inherited[index];
    runs.push(await call("spawn_agent", requests[index], `difficulty-${index}`));
  }
  await until(() => f.ports.length === 3 && f.ports.every((port) => port.streaming));
  for (let index = 0; index < runs.length; index++) {
    const view = f.controller.view(runs[index].run_id);
    assert.equal(view.effective_settings.model, routed[index].id);
    assert.equal(view.effective_settings.provider, "fixture-local");
    assert.equal(view.effective_settings.difficulty, requests[index].difficulty);
    assert.equal(view.effective_settings.strength, ["light", "standard", "strong"][index]);
    assert.equal(runs[index].settings.difficulty, requests[index].difficulty);
    assert.equal("strength" in runs[index].settings, false);
    assert.equal(view.effective_settings.parent_thinking, inherited[index]);
    assert.equal(view.effective_settings.thinking, inherited[index]);
    assert.equal(view.effective_settings.thinking_resolution, "identity");
    assert.equal(view.effective_settings.preset, "cross-provider");
    assert.equal(runs[index].settings.model, undefined, "ordinary output hides the concrete model");
    f.ports[index].finish("done");
  }
  for (const run of runs) await ended(f.controller, run);
});

test("missing preset models fail without exposing the catalogue", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  state.preset = preset("missing", "unregistered/exact", "v9");
  state.catalog = Array.from({ length: 50 }, (_, i) => ({ provider: "private", id: `secret-${i}`, levels: ["off"] }));
  await assert.rejects(call("spawn_agent", create()), (error) => {
    const result = JSON.parse(error.message).error;
    assert.deepEqual(result, { code: "PRESET_MODEL_UNAVAILABLE", difficulty: 3,
      resolution: "Ask the user to check the worker preset and model configuration. Do not change difficulty to bypass configuration errors." });
    assert.equal(JSON.stringify(result).includes("secret-"), false); return true;
  });
});

test("wait defaults and bounds are tool-local; explicit dispatch waiting does not alter task identity", async (t) => {
  const f = await fixture(t), { call, tool } = toolsFor(f);
  for (const value of [-1, 300001, 1.5]) {
    assert.throws(() => tool("spawn_agent").prepareArguments(create({ wait_ms: value })), code("INVALID_PARAMETERS"));
    assert.throws(() => tool("resume_agent").prepareArguments({ agent_id: "agent", prompt: "x", wait_ms: value }), code("INVALID_PARAMETERS"));
    assert.throws(() => tool("wait_runs").prepareArguments({ run_ids: ["run"], mode: "all", timeout_ms: value }), code("INVALID_PARAMETERS"));
  }
  const run = await call("spawn_agent", create({ wait_ms: 0 }), "background");
  assert.equal(run.wait, undefined);
  const seen = [], realWait = f.controller.wait.bind(f.controller);
  f.controller.wait = (ids, options) => {
    seen.push([options.mode, options.timeout_ms]);
    return realWait(ids, { ...options, timeout_ms: 0 });
  };
  await call("wait_runs", { run_ids: [run.run_id] });
  await call("wait_runs", { run_ids: [run.run_id], mode: "any", timeout_ms: 0 });
  await call("wait_runs", { run_ids: [run.run_id], mode: "all", timeout_ms: 1000 });
  await call("wait_runs", { run_ids: [run.run_id], mode: "all", timeout_ms: 300000 });
  const replay = await call("spawn_agent", create({ wait_ms: 300000 }), "background");
  assert.equal(replay.run_id, run.run_id); assert.equal(replay.wait.reason, "timeout");
  assert.equal(replay.reason, undefined, "the combined wait reason is nested, not a top-level Run outcome");
  assert.deepEqual(replay.wait.pending_run_ids, [run.run_id]);
  assert.deepEqual(seen, [["all", 300000], ["any", 0], ["all", 1000], ["all", 300000], ["all", 300000]]);
  assert.equal(f.controller.list().length, 1);
});

test("worker routing leaves the parent model unchanged and resume stays pinned", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  const parent = { provider: "parent-provider", id: "main-model", levels: ["off"] };
  state.model = parent;
  const first = await call("spawn_agent", create({ wait_ms: 1 }), "parent-unchanged");
  assert.equal(state.model, parent); assert.equal(first.settings.model, undefined);
  assert.deepEqual(first.settings, { profile: "reader", difficulty: 3 });
  await until(() => f.ports[0]?.streaming); f.ports[0].finish("done"); await ended(f.controller, first);
  state.model = { provider: "parent-provider", id: "new-main", levels: ["high"] };
  state.preset = preset("changed", "missing/model", "v2"); state.catalog = [state.model];
  const resumed = await call("resume_agent", { agent_id: first.agent_id, prompt: "next", wait_ms: 1 }, "pinned-resume");
  assert.equal(routed(f, resumed).preset, "fixture"); assert.equal(routed(f, resumed).thinking, "off");
  assert.equal(routed(f, resumed).parent_thinking, "off"); assert.equal(routed(f, resumed).thinking_resolution, "identity");
  await until(() => f.ports[0].calls.length === 2); f.ports[0].finish("again"); await ended(f.controller, resumed);
});

test("accepted-request retries invoke the UI safeguard while Off without admitting new work", async (t) => {
  const admission = { enabled: true, revision: 0 }, observed = [];
  const f = await fixture(t, { controller: { admission: () => ({ ...admission }) } });
  let active = ["read", ...delegationTools];
  const { call } = toolsFor(f, { onRunAccepted(view) {
    observed.push({ run_id: view.run_id, enabled: admission.enabled });
    active = workerToolSelection(active, admission.enabled, f.controller.hasAcceptedRuns);
  } });
  const run = await call("spawn_agent", create(), "retry-off");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish("kept"); await ended(f.controller, run);
  admission.enabled = false; admission.revision++;
  active = ["read", "other-extension"]; // Missing cleanup tools, e.g. after a UI update failed.
  assert.equal((await call("spawn_agent", create(), "retry-off")).run_id, run.run_id);
  assert.deepEqual(observed, [{ run_id: run.run_id, enabled: true }, { run_id: run.run_id, enabled: false }]);
  assert.deepEqual(active, ["read", "other-extension", ...cleanupToolNames]);
  assert.equal(f.controller.stats().runs, 1); assert.equal(f.ports[0].calls.length, 1);
  await assert.rejects(call("spawn_agent", create(), "fresh-off"), code("WORKERS_DISABLED"));
  assert.equal(observed.length, 2, "rejected work cannot invoke the accepted callback");
});

test("create and resume can return complete question/output directly, and UI failure cannot erase acceptance", async (t) => {
  const f = await fixture(t), accepted = [];
  const { call } = toolsFor(f, { onRunAccepted(view) { accepted.push(view); throw new Error("paint failed"); } });
  let returned = false;
  const first = call("spawn_agent", create({ wait_ms: 300000 }), "question").then((reply) => { returned = true; return reply; });
  await until(() => f.ports[0]?.streaming);
  assert.equal(accepted.length, 1); assert.equal(returned, false);
  const question = "甲🚀".repeat(2000); // Fits in the shared budget: no arbitrary 2K question cut.
  f.ports[0].callbacks.question(question); f.ports[0].finish("need an answer");
  const asked = await first;
  assert.equal(asked.status, "needs_input"); assert.equal(asked.resumable, true);
  assert.equal(asked.wait.runs[0].question, question); assert.equal(asked.wait.runs[0].question_complete, true);
  assert.equal(asked.wait.runs[0].complete, true);
  const args = { agent_id: asked.agent_id, prompt: "answer", answer_to_run_id: asked.run_id, wait_ms: 300000 };
  const next = call("resume_agent", args, "answer");
  await until(() => f.ports[0].calls.length === 2); f.ports[0].finish("accepted answer");
  const result = await next;
  assert.equal(result.status, "completed"); assert.equal(result.wait.runs[0].text, "accepted answer");
  assert.equal(result.wait.runs[0].complete, true); assert.equal(accepted.length, 2);
  const replay = await call("resume_agent", { ...args, wait_ms: 1 }, "answer");
  assert.equal(replay.run_id, result.run_id); assert.equal(f.ports[0].calls.length, 2);
  await assert.rejects(call("resume_agent", { ...args, prompt: "different" }, "answer"), code("REQUEST_CONFLICT"));
});

test("accepted waits neither hold admission nor cancel workers on timeout or parent interruption", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), accepted = [];
  const { call } = toolsFor(f, { onRunAccepted: (view) => accepted.push(view) });
  const before = new AbortController(); before.abort();
  await assert.rejects(call("spawn_agent", create({ wait_ms: 300000 }), "pre-abort", undefined, before.signal), code("TOOL_INTERRUPTED"));
  assert.equal(f.controller.list().length, 0);
  const abort = new AbortController();
  const first = call("spawn_agent", create({ wait_ms: 300000 }), "held", undefined, abort.signal);
  await until(() => f.ports[0]?.streaming);
  const peer = await call("spawn_agent", create(), "peer");
  await until(() => f.ports[1]?.streaming);
  assert.equal(accepted.length, 2, "another submit is not behind the first wait");
  abort.abort(); const interrupted = await first;
  assert.equal(interrupted.run_id, accepted[0].run_id);
  assert.equal(interrupted.wait.reason, "interrupted");
  assert.deepEqual(interrupted.wait.pending_run_ids, [interrupted.run_id]);
  assert.equal(f.ports[0].stopped, 0); assert.equal(f.controller.view(peer.run_id).status, "running");
  const timed = await call("spawn_agent", create({ wait_ms: 1 }), "held");
  assert.equal(timed.run_id, interrupted.run_id); assert.equal(timed.wait.reason, "timeout");
  f.ports[0].finish("first done"); await ended(f.controller, interrupted);
  const resumeAbort = new AbortController();
  const resumed = call("resume_agent", { agent_id: interrupted.agent_id, prompt: "next", wait_ms: 300000 }, "next", undefined, resumeAbort.signal);
  await until(() => f.ports[0].calls.length === 2);
  resumeAbort.abort(); const resumedReply = await resumed;
  assert.equal(resumedReply.wait.reason, "interrupted"); assert.equal(f.ports[0].stopped, 0);
});

test("abort immediately after admission keeps the Run identity; stale contexts still suppress combined replies", async (t) => {
  const f = await fixture(t), abort = new AbortController();
  const { call, state } = toolsFor(f, { onRunAccepted: () => abort.abort() });
  const accepted = await call("spawn_agent", create({ wait_ms: 300000 }), "accepted-abort", undefined, abort.signal);
  assert.equal(accepted.wait.reason, "interrupted"); assert.equal(f.controller.list().length, 1);
  const pending = call("spawn_agent", create({ wait_ms: 300000 }), "accepted-abort");
  await until(() => f.ports[0]?.streaming); state.active = false; f.ports[0].finish("kept");
  await assert.rejects(pending, code("STALE_OWNER_CONTEXT"));
  assert.equal(f.controller.getResult(accepted.run_id).text, "kept");
});

test("only completed Runs spend result budget; progress is coalesced once without waking the model", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 8 } }), { call } = toolsFor(f), runs = [];
  for (let index = 0; index < 8; index++) runs.push(await call("spawn_agent", create(), `budget-${index}`));
  await until(() => f.ports.length === 8 && f.ports.every((port) => port.streaming));
  let returned = false;
  const waiting = call("wait_runs", { run_ids: runs.map((run) => run.run_id), mode: "any" }).then((reply) => { returned = true; return reply; });
  for (let index = 0; index < 64; index++) f.ports[0].callbacks.notify(`progress ${index}: ${"甲🚀".repeat(2000)}`);
  await tick(); assert.equal(returned, false);
  f.ports[0].finish("x".repeat(4000));
  const reply = await waiting;
  assert.equal(reply.runs[0].text.length, 4000); assert.equal(reply.runs[0].complete, true);
  assert.deepEqual(reply.pending_run_ids, runs.slice(1).map((run) => run.run_id));
  assert.equal(reply.progress_claimed, 64); assert.equal(reply.progress_omitted, 62);
  assert(reply.progress.reduce((sum, event) => sum + event.text.length, 0) <= 2048);
  assert.equal(f.controller.view(runs[0].run_id).pending_messages, 0);
  const again = await call("wait_runs", { run_ids: runs.map((run) => run.run_id), mode: "any" });
  assert.equal(again.reason, "condition"); assert.equal(again.progress, undefined);
});

test("mixed-length questions and results are not truncated when their aggregate fits", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 4 } }), { call } = toolsFor(f), runs = [];
  for (let index = 0; index < 4; index++) runs.push(await call("spawn_agent", create(), `mixed-${index}`));
  await until(() => f.ports.length === 4 && f.ports.every((port) => port.streaming));
  for (let index = 0; index < 4; index++) {
    f.ports[index].callbacks.question(index === 0 ? "Q".repeat(6000) : "short?");
    f.ports[index].finish(index === 0 ? "A".repeat(4000) : "short result");
  }
  // This tests aggregate projection, not a model wait loop. Stabilize all four
  // terminal records before requesting their combined payload once.
  await until(() => f.controller.list().every((run) => run.status === "needs_input"));
  const all = await call("wait_runs", { run_ids: runs.map((run) => run.run_id), mode: "all" });
  assert(all.runs.every((run) => run.question_complete && run.complete));
  assert.equal(all.runs[0].question.length, 6000); assert.equal(all.runs[0].text.length, 4000);
});

test("effort changes only new Agents; queued work, same-ID retries and resume keep the admitted policy", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  const first = await call("spawn_agent", create(), "effort-first");
  await until(() => f.ports[0]?.streaming);
  const queued = await call("spawn_agent", create(), "effort-queued");
  assert.equal(queued.status, "queued");
  state.preset.effort = { light: "inherit", standard: "high", strong: "inherit" };
  state.preset.effort_overrides = { standard: "high" };
  assert.equal((await call("spawn_agent", create(), "effort-queued")).run_id, queued.run_id);
  assert.equal(f.controller.view(queued.run_id).effective_settings.thinking, "off");
  const fresh = await call("spawn_agent", create(), "effort-fresh");
  assert.equal(routed(f, fresh).thinking, "high");
  assert.equal(routed(f, fresh).thinking_resolution, "preset_fixed");
  assert.equal(fresh.settings.effort_source, undefined, "user policy provenance is not a new model knob");
  assert.equal(f.controller.view(fresh.run_id).effective_settings.effort_source, "user_override");
  assert.equal(state.thinking, "off", "worker fixed thinking cannot change parent thinking");
  for (const [index, run] of [first, queued, fresh].entries()) {
    await until(() => f.ports[index]?.streaming);
    f.ports[index].finish(); await ended(f.controller, run);
  }
  state.preset.effort.standard = "off";
  const resumed = await call("resume_agent", { agent_id: fresh.agent_id, prompt: "Continue" }, "effort-resume");
  assert.equal(routed(f, resumed).thinking, "high");
  assert.equal(routed(f, resumed).thinking_resolution, "preset_fixed");
  await until(() => f.ports[2].streaming);
  f.ports[2].finish(); await ended(f.controller, resumed);
  const reset = await call("spawn_agent", create(), "effort-reset");
  assert.equal(routed(f, reset).thinking, "off");
  assert.equal(routed(f, reset).thinking_resolution, "preset_fixed");
});

test("fixed user effort works without a parent level but inherited policies still require it", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  state.thinking = undefined;
  state.preset.effort = { light: "inherit", standard: "high", strong: "inherit" };
  const fixed = await call("spawn_agent", create(), "fixed-without-parent");
  assert.equal(routed(f, fixed).thinking, "high");
  assert.equal(routed(f, fixed).parent_thinking, undefined);
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish(); await ended(f.controller, fixed);
  state.preset.effort.standard = "inherit";
  await assert.rejects(call("spawn_agent", create(), "inherit-without-parent"), code("PARENT_THINKING_UNAVAILABLE"));
  state.preset.effort.standard = "max";
  await assert.rejects(call("spawn_agent", create(), "fixed-unsupported"), (error) => {
    const details = JSON.parse(error.message).error;
    assert.equal(details.code, "THINKING_INCOMPATIBLE");
    assert.equal(Object.hasOwn(details, "parameter"), false, "preset policy failure must not advertise an effort tool parameter");
    assert.equal(details.reason, "fixed_effort_unsupported");
    assert.equal(details.model, undefined); assert.equal(details.strength, undefined);
    assert.match(details.resolution, /Do not change difficulty/);
    return true;
  });
});

test("thinking incompatibility identifies inherited level and route but hides the concrete model", async (t) => {
  const f = await fixture(t), { state, call } = toolsFor(f);
  state.thinking = "low";
  await assert.rejects(call("spawn_agent", create()), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE");
    assert.equal("preset" in result, false); assert.equal(result.difficulty, 3);
    assert.equal("strength" in result, false);
    assert.equal(result.parent_thinking, "low"); assert.equal(result.reason, "identity_unsupported_no_mapping");
    assert.equal(result.allowed, undefined); assert.equal(result.model, undefined);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
    return true;
  });
});

test("list_agents adds per-Agent history for choosing resume versus a fresh Agent", async (t) => {
  const f = await fixture(t), { call } = toolsFor(f);
  const first = await call("spawn_agent", create({ description: "Port tests", name: "otter" }));
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.runtime({ activity: "tool", context: { tokens: 50_000, context_window: 200_000 } });
  f.ports[0].callbacks.touched("src/a.ts");
  f.ports[0].finish(); await ended(f.controller, first);
  const second = await call("resume_agent", { agent_id: first.agent_id, prompt: "more", description: "Fix flaky test" });
  await until(() => f.ports[0].calls.length === 2); f.ports[0].finish(); await ended(f.controller, second);
  const [row] = (await call("list_agents", {})).agents;
  assert.equal(row.description, "Fix flaky test");
  assert.equal(row.runs, 2); assert.deepEqual(row.earlier_tasks, ["Port tests"]);
  assert.deepEqual(row.context, { tokens: 50_000, window: 200_000, percent: 25 });
  assert.deepEqual(row.touched, ["src/a.ts"]); assert.equal(row.observed_cost, 0);
  assert.equal(typeof row.idle_ms, "number");
  assert.equal("model" in row.settings, false, "routing details stay hidden");
});

test("harness replies report other Runs that settled since the previous reply, once", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { call } = toolsFor(f);
  const a = await call("spawn_agent", create({ description: "a" }), "a");
  const b = await call("spawn_agent", create({ description: "b" }), "b");
  assert.equal(b.changes, undefined);
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[0].finish("A done"); await ended(f.controller, a);
  const steered = await call("steer_run", { run_id: b.run_id, message: "hurry" });
  assert.deepEqual(steered.changes, [{ run_id: a.run_id, agent_id: a.agent_id, status: "completed" }]);
  assert.equal((await call("steer_run", { run_id: b.run_id, message: "again" }, "s2")).changes, undefined, "reported once");
  f.ports[1].finish("B done"); await ended(f.controller, b);
  const waited = await call("wait_runs", { run_ids: [b.run_id] });
  assert.equal(waited.changes, undefined, "a reply that already covers the Run does not repeat it");
  const c = await call("spawn_agent", create({ description: "c" }), "c");
  await until(() => f.ports.length === 3 && f.ports[2].streaming); f.ports[2].finish(); await ended(f.controller, c);
  await call("list_agents", {});
  assert.equal((await call("read_run", { run_id: a.run_id })).changes, undefined, "list_agents advances the cursor");
});

test("post_update reports delivery per Agent and never fails the whole batch for one target", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { call } = toolsFor(f);
  const busy = await call("spawn_agent", create({ description: "busy" }), "busy");
  const idle = await call("spawn_agent", create({ description: "idle" }), "idle");
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[1].finish(); await ended(f.controller, idle);
  const reply = await call("post_update", { agent_ids: [busy.agent_id, idle.agent_id, idle.agent_id, "missing"], message: "API renamed" });
  assert.deepEqual(reply.targets, [
    { agent_id: busy.agent_id, delivery: "steered", run_id: busy.run_id },
    { agent_id: idle.agent_id, delivery: "queued", pending_updates: 1 },
    { agent_id: "missing", delivery: "rejected", error: { code: "AGENT_NOT_FOUND", agent_id: "missing" } },
  ]);
  assert.equal(reply.changes, undefined, "targets already cover these Agents");
  await until(() => f.ports[0].inputs.length === 1);
  f.ports[0].finish(); await ended(f.controller, busy);
});

test("spawn_agent handoff_from queues a follow-up that reports what it waits for", async (t) => {
  const f = await fixture(t), { call } = toolsFor(f);
  const author = await call("spawn_agent", create({ description: "write" }), "author");
  const reviewer = await call("spawn_agent", create({ description: "review", prompt: "Review it.", handoff_from: [author.run_id] }), "reviewer");
  assert.equal(reviewer.status, "queued"); assert.deepEqual(reviewer.blocked_by, [author.run_id]);
  await until(() => f.ports[0]?.streaming); f.ports[0].finish("diff summary"); await ended(f.controller, author);
  await until(() => f.ports[1]?.streaming);
  assert.match(f.ports[1].calls[0].prompt, /diff summary\n\n--- End of handoff ---\n\nReview it\.$/);
  f.ports[1].finish(); await ended(f.controller, reviewer);
});

test("a list_agents page consumes only the settlements it shows", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }), { call } = toolsFor(f);
  const first = await call("spawn_agent", create({ description: "first" }), "first");
  const second = await call("spawn_agent", create({ description: "second" }), "second");
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[1].finish(); await ended(f.controller, second);
  const page = await call("list_agents", { limit: 1 });
  assert.deepEqual(page.agents.map((row) => row.run_id), [first.run_id]);
  assert.deepEqual(page.changes, [{ run_id: second.run_id, agent_id: second.agent_id, status: "completed" }],
    "a settlement outside the page is still reported");
  f.ports[0].finish(); await ended(f.controller, first);
  const shown = await call("list_agents", { limit: 1 }, "page-2");
  assert.equal(shown.changes, undefined, "the page shows the first Agent itself");
  assert.equal((await call("read_run", { run_id: second.run_id })).changes, undefined);
});
