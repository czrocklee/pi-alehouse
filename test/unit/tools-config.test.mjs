import {
  model,
  preset,
  code,
  runOf,
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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { createOwnerTools } from "../../dist/orchestration/tools/parent-tools.js";
import {
  cleanupToolNames,
  managementToolNames as delegationTools,
  workerToolSelection,
} from "../../dist/orchestration/tools/tool-names.js";
import { digest } from "../../dist/orchestration/runtime/context-snapshot.js";
import { fixture, until } from "../support/controller-fixture.mjs";

test("resolver exposes bounded abstract choices and incompatibility without model inventory", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  for (const invalid of [null, "3", 0, -1, 6, 1.5, NaN, Infinity]) {
    await assert.rejects(
      call("agent_spawn", create({ reasoning_difficulty: invalid })),
      (error) => {
        assert.deepEqual(JSON.parse(error.message).error, {
          code: "INVALID_DIFFICULTY",
          parameter: "reasoning_difficulty",
          resolution: "Use an integer from 1 to 5 for reasoning_difficulty.",
        });
        return true;
      },
    );
  }
  await assert.rejects(call("agent_spawn", create({ profile: "unknown" })), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "INVALID_PROFILE");
    assert.deepEqual(result.allowed, ["worker", "scout"]);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
    return true;
  });
  state.model = { ...model, levels: ["off"] };
  state.catalog = [state.model];
  state.thinking = "low";
  await assert.rejects(call("agent_spawn", create(), "unsupported-parent"), (error) => {
    assert.deepEqual(JSON.parse(error.message).error, {
      code: "THINKING_INCOMPATIBLE",
      parameter: "parent_thinking",
      reason: "no_supported_thinking_level",
      reasoning_difficulty: 3,
      parent_thinking: "low",
      resolution:
        'Ask the user to set this worker preset slot\'s fixed effort to "off", or change the parent Pi thinking level or worker preset. Do not change reasoning_difficulty to bypass configuration errors.',
    });
    return true;
  });
  assert.deepEqual(f.controller.list(), []);
  assert.equal(f.ports.length, 0);
});

test("missing or invalid parent thinking is a host error and cannot reinterpret accepted requests or reuse", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  await call("agent_spawn", create(), "accepted-host-state");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
  for (const [index, value] of [undefined, null, "", "unknown"].entries()) {
    state.thinking = value;
    assert.equal((await call("agent_spawn", create(), "accepted-host-state")).action.agent, "orca");
    await assert.rejects(
      call("agent_spawn", create({ agent: `w${index}` }), `invalid-host-state-${index}`),
      (error) => {
        const result = JSON.parse(error.message).error;
        assert.equal(result.code, "PARENT_THINKING_UNAVAILABLE");
        assert.match(result.message, /Pi did not provide/);
        assert.match(result.resolution, /Ask the user/);
        assert.match(
          result.resolution,
          /Do not change reasoning_difficulty to bypass configuration errors\.$/,
        );
        assert.equal(result.parameter, undefined);
        assert.equal(result.parent_thinking, undefined);
        return true;
      },
    );
  }
  state.thinking = undefined;
  const queued = call("agent_spawn", create({ agent: "queued" }), "queued-missing-thinking");
  state.thinking = "off";
  await assert.rejects(
    queued,
    code("PARENT_THINKING_UNAVAILABLE"),
    "queued admission retains the missing snapshot",
  );
  assert.equal(f.controller.list().length, 1);
  assert.equal(f.ports.length, 1);
  state.thinking = undefined;
  await call("agent_run", run("orca", { prompt: "again" }), "reuse-without-parent-thinking");
  assert.equal(routed(f, "orca").thinking, "off");
  assert.equal(routed(f, "orca").parent_thinking, "off");
  await until(() => f.ports[0].streaming);
  f.ports[0].finish();
  await settle(f, "orca");
});

test("thinking resolution is identity-first and otherwise uses the automatic ceiling", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.thinking = "low";
  state.model = { ...model, levels: ["off", "high"] };
  state.catalog = [state.model];
  // A stale config map must not change the ceiling or override a supported identity.
  state.preset = {
    ...preset("mapped", "fixture/controlled", "v2"),
    thinking: { d3: { low: "off", high: "off" } },
  };
  const mapped = await call("agent_spawn", create({ agent: "mapped" }), "mapped");
  assert.equal("settings" in mapped, false);
  const route = routed(f, "mapped");
  assert.deepEqual(
    [
      route.preset,
      route.preset_version,
      route.parent_thinking,
      route.thinking,
      route.thinking_resolution,
    ],
    ["mapped", "v2", "low", "high", "automatic_mapping"],
  );
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "mapped");

  state.thinking = "high";
  await call("agent_spawn", create({ agent: "identity" }), "identity");
  assert.equal(
    routed(f, "identity").thinking,
    "high",
    "supported identity is not rounded or overridden by a stale map",
  );
  assert.equal(routed(f, "identity").thinking_resolution, "identity");
  await until(() => f.ports[1]?.streaming);
  f.ports[1].finish();
  await settle(f, "identity");

  state.thinking = "low";
  state.model = { ...model, levels: ["off"] };
  state.catalog = [state.model];
  state.preset = preset("no-positive", "fixture/controlled", "v3");
  await assert.rejects(call("agent_spawn", create({ agent: "bad" }), "no-positive"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE");
    assert.equal(result.reason, "no_supported_thinking_level");
    assert.equal(result.parent_thinking, "low");
    assert.equal("thinking" in result, false);
    assert.match(result.resolution, /fixed effort to "off"/);
    assert.match(result.resolution, /change the parent Pi thinking level or worker preset/);
    assert.match(
      result.resolution,
      /Do not change reasoning_difficulty to bypass configuration errors\.$/,
    );
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
    return true;
  });
  for (const [index, levels] of [[], ["unknown"]].entries()) {
    state.model = { ...model, levels };
    state.catalog = [state.model];
    await assert.rejects(
      call("agent_spawn", create({ agent: `empty${index}` }), `empty-levels-${index}`),
      (error) => {
        const result = JSON.parse(error.message).error;
        assert.equal(result.reason, "no_supported_thinking_level");
        assert.doesNotMatch(result.resolution, /fixed effort/);
        assert.match(
          result.resolution,
          /Do not change reasoning_difficulty to bypass configuration errors\.$/,
        );
        assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
        return true;
      },
    );
  }
  assert.equal(f.controller.list().length, 2);
  assert.equal(f.ports.length, 2, "invalid metadata must not create a child");
  state.thinking = "off";
  state.model = { ...model, levels: ["high"] };
  state.catalog = [state.model];
  state.preset = preset("no-off", "fixture/controlled", "v4");
  await assert.rejects(call("agent_spawn", create({ agent: "no-off" }), "no-off"), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE");
    assert.equal(result.reason, "off_unsupported");
    assert.equal(result.parent_thinking, "off");
    assert.match(result.resolution, /change the parent Pi thinking level/);
    return true;
  });
});

test("each new Agent inherits current parent thinking while reuse remains pinned", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }),
    { state, call } = toolsFor(f);
  state.thinking = "off";
  await call("agent_spawn", create({ agent: "first" }), "parent-off");
  state.thinking = "high";
  await call("agent_spawn", create({ agent: "second" }), "parent-high");
  assert.deepEqual(
    [routed(f, "first").parent_thinking, routed(f, "first").thinking],
    ["off", "off"],
  );
  assert.deepEqual(
    [routed(f, "second").parent_thinking, routed(f, "second").thinking],
    ["high", "high"],
  );
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[0].finish();
  f.ports[1].finish();
  await settle(f, "first");
  await settle(f, "second");
  state.thinking = "off";
  await call("agent_run", run("second", { prompt: "again" }), "reuse-pinned-thinking");
  assert.deepEqual(
    [routed(f, "second").parent_thinking, routed(f, "second").thinking],
    ["high", "high"],
  );
  await until(() => f.ports[1].calls.length === 2);
  f.ports[1].finish();
  await settle(f, "second");
});

test("queued creations snapshot parent thinking before admission waits", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 2 } }),
    { state, call } = toolsFor(f);
  state.thinking = "off";
  const firstPromise = call("agent_spawn", create({ agent: "first" }), "queued-parent-off");
  state.thinking = "high";
  const secondPromise = call("agent_spawn", create({ agent: "second" }), "queued-parent-high");
  state.thinking = "off";
  await Promise.all([firstPromise, secondPromise]);
  assert.equal(routed(f, "first").parent_thinking, "off");
  assert.equal(routed(f, "first").thinking, "off");
  assert.equal(routed(f, "second").parent_thinking, "high");
  assert.equal(routed(f, "second").thinking, "high");
  await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
  f.ports[0].finish();
  f.ports[1].finish();
  await settle(f, "first");
  await settle(f, "second");
});

test("preset/profile/context snapshots pin at admission; same ID keeps first acceptance", async (t) => {
  const f = await fixture(t),
    { state, source, call } = toolsFor(f);
  state.entries = [
    { message: { role: "user", content: "USER_CONTEXT" } },
    {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "ASSISTANT_CONTEXT" },
          { type: "thinking", thinking: "PRIVATE_REASONING" },
        ],
      },
    },
    { message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL_TEXT" }] } },
  ];
  const args = create({ inherit_context: true });
  const starting = call("agent_spawn", args, "snapshot");
  args.prompt = "mutated caller";
  state.entries[0].message.content = "LATE_CONTEXT";
  source["editor"].definition = "mutated profile";
  source["editor"].tools.push("write");
  const reply = await starting;
  // Main-session settings are unrelated to worker routing. A later preset/config
  // change also cannot reinterpret this accepted tool-call ID.
  state.model = { provider: "parent", id: "changed", levels: ["off"] };
  state.thinking = "high";
  state.preset = preset("broken", "missing/model", "v2");
  state.catalog = [state.model];
  await until(() => f.ports[0]?.streaming);
  const view = viewOf(f, "orca");
  assert.equal(Object.hasOwn(view, "max_duration_ms"), false);
  assert.equal(view.effective_settings.model, "controlled");
  assert.equal(view.effective_settings.thinking, "off");
  assert.equal(view.effective_settings.parent_thinking, "off");
  assert.equal(view.effective_settings.thinking_resolution, "identity");
  assert.equal(view.effective_settings.preset, "fixture");
  assert.equal(view.effective_settings.difficulty, 3);
  assert.equal(view.effective_settings.strength, "d3", "internal route retains its slot");
  assert.equal(view.effective_settings.definition_digest, digest("editor definition"));
  assert.deepEqual(view.effective_settings.tools, ["read"]);
  assert.equal(
    view.effective_settings.context_digest,
    digest("[user]\nUSER_CONTEXT\n\n[assistant]\nASSISTANT_CONTEXT"),
  );
  assert(!JSON.stringify(reply).includes("USER_CONTEXT"));
  // Even a now-oversized context and incompatible defaults cannot reinterpret an accepted ID.
  state.entries = [{ message: { role: "user", content: "x".repeat(65537) } }];
  assert.equal(
    (await call("agent_spawn", create({ inherit_context: true }), "snapshot")).action.agent,
    "orca",
  );
  assert.equal(f.ports.length, 1);
  await assert.rejects(
    call("agent_spawn", create({ inherit_context: true, prompt: "conflict" }), "snapshot"),
    code("REQUEST_CONFLICT"),
  );
  await assert.rejects(
    call("agent_spawn", create({ agent: "b" }), "changed-config"),
    code("PRESET_MODEL_UNAVAILABLE"),
  );
  state.preset = preset();
  state.catalog = [{ ...model, levels: ["off"] }];
  await assert.rejects(
    call("agent_spawn", create({ agent: "c" }), "changed-thinking"),
    code("THINKING_INCOMPATIBLE"),
  );
  state.catalog = [model];
  await assert.rejects(
    call("agent_spawn", create({ agent: "d", inherit_context: true }), "oversized"),
    code("CONTEXT_SNAPSHOT_TOO_LARGE"),
  );
  f.ports[0].finish("first");
  await settle(f, "orca");
  const first = runOf(f, "orca");
  assert.equal(
    (await call("agent_run", run("orca", { prompt: "follow-up" }), "reuse")).agents[0].status,
    "running",
  );
  assert.notEqual(runOf(f, "orca"), first);
  assert.equal(
    viewOf(f, "orca").max_turns,
    view.max_turns,
    "each task uses the Agent's turn limit",
  );
  assert.equal(Object.hasOwn(viewOf(f, "orca"), "max_duration_ms"), false);
  assert.equal(routed(f, "orca").preset, "fixture");
  assert.equal(routed(f, "orca").difficulty, 3);
  assert.equal(routed(f, "orca").thinking, "off");
  assert.equal(routed(f, "orca").parent_thinking, "off");
  assert.equal(routed(f, "orca").thinking_resolution, "identity");
  assert.equal(f.ports[0].calls[1].prompt, "follow-up", "reuse sends no context snapshot again");
  await until(() => f.ports[0].streaming);
  f.ports[0].finish("second");
  await settle(f, "orca");
  assert.equal((await call("agent_read", { agent: "orca" })).agents[0].result, "second");
  assert.equal(f.controller.getResult(first).text, "first", "earlier results are retained");
  await assert.rejects(
    call("agent_run", run("orca", { prompt: "different" }), "reuse"),
    code("REQUEST_CONFLICT"),
  );
  await assert.rejects(
    call("agent_run", run("orca", { prompt: "follow-up", continues: "something else" }), "reuse"),
    code("REQUEST_CONFLICT"),
    "continues is part of the request identity",
  );
  assert.equal(
    (await call("agent_run", run("orca", { prompt: "follow-up" }), "reuse")).agents[0].task,
    2,
    "an identical retry replays",
  );
});

for (const compacted of [false, true])
  test(`inherited SDK projection respects omission and replacement (compacted=${compacted})`, async (t) => {
    const sessionManager = SessionManager.inMemory("/tmp");
    sessionManager.appendMessage({ role: "user", content: "OLDER_CONTEXT", timestamp: 0 });
    const kept = sessionManager.appendMessage({
      role: "user",
      content: "ORIGINAL_USER",
      timestamp: 1,
    });
    const failed = sessionManager.appendMessage({
      role: "assistant",
      stopReason: "error",
      timestamp: 2,
      content: [{ type: "text", text: "OMITTED_DRAFT" + "x".repeat(65536) }],
    });
    sessionManager.appendContextEdit(failed, null);
    sessionManager.appendContextEdit(kept, { content: "REPLACED_USER" });
    sessionManager.appendMessage({
      role: "assistant",
      stopReason: "stop",
      timestamp: 3,
      content: [{ type: "text", text: "RETRY_SUCCEEDED" }],
    });
    if (compacted) sessionManager.appendCompaction("SUMMARY", kept, 70000);
    const f = await fixture(t, { owner_id: sessionManager.getSessionId() });
    const { ctx, options } = toolsFor(f);
    const context = { ...ctx, sessionManager };
    const tools = createOwnerTools({ ...options, context });
    await tools
      .find((tool) => tool.name === "agent_spawn")
      .execute(
        "projected-snapshot",
        create({ inherit_context: true }),
        undefined,
        undefined,
        context,
      );
    await until(() => f.ports[0]?.streaming);
    const snapshot =
      (compacted ? "[compactionSummary]\nSUMMARY" : "[user]\nOLDER_CONTEXT") +
      "\n\n[user]\nREPLACED_USER\n\n[assistant]\nRETRY_SUCCEEDED";
    assert.equal(f.ports[0].calls[0].prompt, `${snapshot}\n\ntask`);
    assert.equal(routed(f, "orca").context_digest, digest(snapshot));
    assert(
      sessionManager.getEntries().some((entry) => entry.id === failed),
      "omission must not delete raw history",
    );
    assert.equal(
      sessionManager.getEntry(kept).message.content,
      "ORIGINAL_USER",
      "replacement is context-only",
    );
    f.ports[0].finish();
    await settle(f, "orca");
  });

test("ambiguous preset model keys fail without inventory; long tool-call IDs remain bounded and idempotent", async (t) => {
  const f = await fixture(t),
    { state, source, options, call } = toolsFor(f);
  state.catalog = [model, { ...model }];
  await assert.rejects(call("agent_spawn", create()), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "PRESET_MODEL_UNAVAILABLE");
    assert.equal("preset" in result, false);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
    return true;
  });
  source["editor"].tools.push("delegate");
  assert.throws(() => createOwnerTools(options), { code: "INVALID_PROFILE_DEFINITION" });
  state.catalog = [model];
  const id = "sdk-call-".repeat(1000);
  await call("agent_spawn", create(), id);
  assert.equal((await call("agent_spawn", create(), id)).action.agent, "orca");
  assert.equal(f.controller.stats().runs, 1);
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
});

test("all difficulty ratings route independent registered IDs and efforts, including a non-OpenAI fixture provider", async (t) => {
  const f = await fixture(t, { controller: { concurrency: 5 } }),
    { state, call, tool } = toolsFor(f);
  const slots = ["d1", "d2", "d3", "d4", "d5"],
    levels = ["off", "low", "medium", "high", "max"];
  const catalog = slots.map((slot, index) => ({
    provider: "fixture-local",
    id: slot,
    levels: [levels[index]],
  }));
  state.catalog = catalog;
  state.preset = {
    ...preset(),
    name: "cross-provider",
    version: "v7",
    digest: "c".repeat(64),
    models: Object.fromEntries(slots.map((slot) => [slot, `fixture-local/${slot}`])),
    effort: Object.fromEntries(slots.map((slot, index) => [slot, levels[index]])),
  };
  const difficulties = [1, 2, 3, 4, 5],
    inherited = ["off", "off", "off", "off", "off"];
  for (let index = 0; index < 5; index++) {
    state.thinking = inherited[index];
    const args = create({ agent: `d${index}`, reasoning_difficulty: difficulties[index] });
    assert(Check(tool("agent_spawn").parameters, args));
    assert.deepEqual(tool("agent_spawn").prepareArguments(args), args);
    const reply = await call(
      "agent_spawn",
      create({ agent: `d${index}`, reasoning_difficulty: difficulties[index] }),
      `difficulty-${index}`,
    );
    assert.equal("settings" in reply, false, "ordinary output hides routing");
  }
  await until(() => f.ports.length === 5 && f.ports.every((port) => port.streaming));
  for (let index = 0; index < 5; index++) {
    const settings = routed(f, `d${index}`);
    assert.equal(settings.model, catalog[index].id);
    assert.equal(settings.provider, "fixture-local");
    assert.equal(settings.difficulty, difficulties[index]);
    assert.equal(settings.strength, slots[index]);
    assert.equal(settings.parent_thinking, inherited[index]);
    assert.equal(settings.thinking, levels[index]);
    assert.equal(settings.thinking_resolution, "preset_fixed");
    assert.equal(settings.preset, "cross-provider");
    f.ports[index].finish("done");
  }
  for (let index = 0; index < 5; index++) await settle(f, `d${index}`);
  const rows = (await call("agent_list", {})).agents;
  assert.deepEqual(
    rows.map((row) => row.reasoning_difficulty),
    [1, 2, 3, 4, 5],
  );
  assert(
    rows.every((row) => !Object.hasOwn(row, "difficulty")),
    "legacy score field is never projected",
  );
  assert(
    rows.every((row) => !JSON.stringify(row).includes("fixture-local")),
    "the roster hides concrete models",
  );
});

test("missing preset models fail without exposing the catalogue", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.preset = preset("missing", "unregistered/exact", "v9");
  state.catalog = Array.from({ length: 50 }, (_, i) => ({
    provider: "private",
    id: `secret-${i}`,
    levels: ["off"],
  }));
  await assert.rejects(call("agent_spawn", create()), (error) => {
    assert.deepEqual(JSON.parse(error.message).error, {
      code: "PRESET_MODEL_UNAVAILABLE",
      reasoning_difficulty: 3,
      resolution:
        "Ask the user to check the worker preset and model configuration. Do not change reasoning_difficulty to bypass configuration errors.",
    });
    return true;
  });
});

test("a virtual selected preset is rejected even when its thinking levels match", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.thinking = "high";
  state.catalog = [
    { provider: "router", id: "auto", api: "pi-virtual", levels: ["off", "high", "xhigh", "max"] },
    {
      provider: "typesafe",
      id: "jev-latest",
      api: "typesafe-system-one",
      type: "classifier",
      levels: ["high"],
    },
  ];
  state.preset = preset("virtual-team", "router/auto", "v9");
  await assert.rejects(call("agent_spawn", create()), (error) => {
    assert.deepEqual(JSON.parse(error.message).error, {
      code: "PRESET_MODEL_UNAVAILABLE",
      reason: "virtual_model",
      reasoning_difficulty: 3,
      resolution:
        "Ask the user to configure a physical model for this worker preset slot. Virtual models route each request and cannot be pinned to an Agent. Do not change reasoning_difficulty to bypass configuration errors.",
    });
    assert.doesNotMatch(error.message, /router\/auto|pi-virtual|jev-latest|model_kind/);
    return true;
  });
  assert.equal(f.ports.length, 0);
});

test("worker routing leaves the parent model unchanged and reuse stays pinned", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  const parent = { provider: "parent-provider", id: "main-model", levels: ["off"] };
  state.model = parent;
  await call("agent_spawn", create({ wait_ms: 1 }), "parent-unchanged");
  assert.equal(state.model, parent);
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish("done");
  await settle(f, "orca");
  state.model = { provider: "parent-provider", id: "new-main", levels: ["high"] };
  state.preset = preset("changed", "missing/model", "v2");
  state.catalog = [state.model];
  await call("agent_run", run("orca", { prompt: "next", wait_ms: 1 }), "pinned-reuse");
  assert.equal(routed(f, "orca").preset, "fixture");
  assert.equal(routed(f, "orca").thinking, "off");
  assert.equal(routed(f, "orca").parent_thinking, "off");
  assert.equal(routed(f, "orca").thinking_resolution, "identity");
  await until(() => f.ports[0].calls.length === 2);
  f.ports[0].finish("again");
  await settle(f, "orca");
});

test("Off keeps pending question identity inspectable but hides and rejects new answers", async (t) => {
  const admission = { enabled: true, revision: 0 };
  const f = await fixture(t, { controller: { admission: () => ({ ...admission }) } });
  const { call } = toolsFor(f);
  await call("agent_spawn", create(), "setup");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Choose a branch?");
  f.ports[0].finish("decision needed");
  await settle(f, "orca");
  const question_id = (await call("agent_read", { agent: "orca" })).agents[0].question_id;
  admission.enabled = false;
  admission.revision++;
  assert.deepEqual(workerToolSelection([...delegationTools], false, true), [...cleanupToolNames]);
  const defaults = await call("agent_wait", {});
  assert.equal(defaults.reason, "nothing_pending");
  assert.equal(defaults.workers_disabled, true);
  assert.deepEqual(defaults.agents, []);
  for (const [name, args] of [
    ["agent_read", { agent: "orca" }],
    ["agent_wait", { agents: ["orca"], wait_ms: 0 }],
  ]) {
    const observed = await call(name, args);
    assert.equal(observed.workers_disabled, true);
    assert.equal(observed.agents[0].question_id, question_id);
    assert.equal(observed.agents[0].has_question, true);
  }
  const args = { agent: "orca", question_id, answer: "main" };
  await assert.rejects(call("agent_answer", args, "off-answer"), (error) => {
    assert(code("WORKERS_DISABLED")(error));
    assert.match(JSON.parse(error.message).error.resolution, /ask the user to enable it/);
    return true;
  });
  await assert.rejects(call("agent_run", run("orca"), "off-run"), code("WORKERS_DISABLED"));
  await assert.rejects(call("agent_send", send("orca"), "off-send"), code("WORKERS_DISABLED"));
  assert.equal(f.controller.stats().runs, 1);
  assert.equal(viewOf(f, "orca").question_id, question_id);
  admission.enabled = true;
  admission.revision++;
  const answer = await call("agent_answer", args, "enabled-answer");
  assert.deepEqual(answer.action, { type: "agent_answer", agent: "orca", task: 2 });
  await until(() => f.ports[0].calls.length === 2);
  f.ports[0].finish();
  await settle(f, "orca");
});

test("spawn returns a whole question and explicit answer continues it; UI failure cannot erase acceptance", async (t) => {
  const f = await fixture(t),
    accepted = [];
  const { call } = toolsFor(f, {
    onRunAccepted(view) {
      accepted.push(view);
      throw new Error("paint failed");
    },
  });
  let returned = false;
  const first = call("agent_spawn", create({ wait_ms: 300000 }), "question").then((reply) => {
    returned = true;
    return reply;
  });
  await until(() => f.ports[0]?.streaming);
  assert.equal(accepted.length, 1);
  assert.equal(returned, false);
  const question = "甲🚀".repeat(2000); // Fits in the shared budget: no arbitrary 2K question cut.
  f.ports[0].callbacks.question(question);
  f.ports[0].finish("need an answer");
  const asking = await first,
    question_id = asking.agents[0].question_id;
  assert.match(question_id, /^q_[0-9a-f]{32}$/);
  assert.deepEqual(asking, {
    action: { type: "agent_spawn", agent: "orca", task: 1 },
    reason: "question",
    agents: [
      {
        agent: "orca",
        task: 1,
        status: "needs_input",
        label: "task",
        has_question: true,
        question_id,
        question,
        result: "need an answer",
      },
    ],
  });
  const unsent = await call(
    "agent_send",
    send("orca", { message: "not an answer" }),
    "no-implicit-answer",
  );
  assert.deepEqual(unsent.action, {
    type: "agent_send",
    agent: "orca",
    task: 1,
    delivery: "not_delivered",
  });
  assert.equal(unsent.agents[0].question_id, question_id);
  assert.equal(f.controller.stats().runs, 1);
  const args = { agent: "orca", question_id, answer: "answer", wait_ms: 300000 };
  const next = call("agent_answer", args, "answer");
  await until(() => f.ports[0].calls.length === 2);
  f.ports[0].finish("accepted answer");
  assert.deepEqual(await next, {
    action: { type: "agent_answer", agent: "orca", task: 2 },
    agents: [
      { agent: "orca", task: 2, status: "completed", label: "task", result: "accepted answer" },
    ],
  });
  assert.equal(accepted.length, 2);
  assert.equal(
    (await call("agent_answer", { ...args, wait_ms: 1 }, "answer")).agents[0].result,
    "accepted answer",
  );
  assert.equal(f.ports[0].calls.length, 2);
  await assert.rejects(
    call("agent_answer", { ...args, answer: "different" }, "answer"),
    code("REQUEST_CONFLICT"),
  );
});

test("effort changes only new Agents; queued work, same-ID retries and reuse keep the admitted policy", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  await call("agent_spawn", create({ agent: "first" }), "effort-first");
  await until(() => f.ports[0]?.streaming);
  assert.equal(
    (await call("agent_spawn", create({ agent: "queued" }), "effort-queued")).agents[0].status,
    "queued",
  );
  state.preset.effort = { d1: "inherit", d2: "inherit", d3: "high", d4: "inherit", d5: "inherit" };
  state.preset.effort_overrides = { d3: "high" };
  assert.equal(
    (await call("agent_spawn", create({ agent: "queued" }), "effort-queued")).agents[0].status,
    "queued",
  );
  assert.equal(routed(f, "queued").thinking, "off");
  await call("agent_spawn", create({ agent: "fresh" }), "effort-fresh");
  assert.equal(routed(f, "fresh").thinking, "high");
  assert.equal(routed(f, "fresh").thinking_resolution, "preset_fixed");
  assert.equal(routed(f, "fresh").effort_source, "user_override");
  assert.equal(state.thinking, "off", "worker fixed thinking cannot change parent thinking");
  for (const [index, agent] of ["first", "queued", "fresh"].entries()) {
    await until(() => f.ports[index]?.streaming);
    f.ports[index].finish();
    await settle(f, agent);
  }
  state.preset.effort.d3 = "off";
  await call("agent_run", run("fresh", { prompt: "Continue" }), "effort-reuse");
  assert.equal(routed(f, "fresh").thinking, "high");
  assert.equal(routed(f, "fresh").thinking_resolution, "preset_fixed");
  await until(() => f.ports[2].streaming);
  f.ports[2].finish();
  await settle(f, "fresh");
  await call("agent_spawn", create({ agent: "reset" }), "effort-reset");
  assert.equal(routed(f, "reset").thinking, "off");
  assert.equal(routed(f, "reset").thinking_resolution, "preset_fixed");
});

test("fixed user effort works without a parent level but inherited policies still require it", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.thinking = undefined;
  state.preset.effort = { d1: "inherit", d2: "inherit", d3: "high", d4: "inherit", d5: "inherit" };
  await call("agent_spawn", create(), "fixed-without-parent");
  assert.equal(routed(f, "orca").thinking, "high");
  assert.equal(routed(f, "orca").parent_thinking, undefined);
  await until(() => f.ports[0]?.streaming);
  f.ports[0].finish();
  await settle(f, "orca");
  state.preset.effort.d3 = "inherit";
  await assert.rejects(
    call("agent_spawn", create({ agent: "b" }), "inherit-without-parent"),
    code("PARENT_THINKING_UNAVAILABLE"),
  );
  state.preset.effort.d3 = "max";
  await assert.rejects(
    call("agent_spawn", create({ agent: "c" }), "fixed-unsupported"),
    (error) => {
      const details = JSON.parse(error.message).error;
      assert.equal(details.code, "THINKING_INCOMPATIBLE");
      assert.equal(
        Object.hasOwn(details, "parameter"),
        false,
        "preset policy failure must not advertise an effort tool parameter",
      );
      assert.equal(details.reason, "fixed_effort_unsupported");
      assert.equal(details.model, undefined);
      assert.equal(details.strength, undefined);
      assert.match(details.resolution, /Do not change reasoning_difficulty/);
      return true;
    },
  );
});

test("thinking incompatibility identifies inherited level and route but hides the concrete model", async (t) => {
  const f = await fixture(t),
    { state, call } = toolsFor(f);
  state.thinking = "off";
  state.model = { ...model, levels: ["high"] };
  state.catalog = [state.model];
  await assert.rejects(call("agent_spawn", create()), (error) => {
    const result = JSON.parse(error.message).error;
    assert.equal(result.code, "THINKING_INCOMPATIBLE");
    assert.equal("preset" in result, false);
    assert.equal(result.reasoning_difficulty, 3);
    assert.equal(Object.hasOwn(result, "difficulty"), false);
    assert.equal("strength" in result, false);
    assert.equal(result.parent_thinking, "off");
    assert.equal(result.reason, "off_unsupported");
    assert.equal(result.allowed, undefined);
    assert.equal(result.model, undefined);
    assert.equal(JSON.stringify(result).includes("fixture/controlled"), false);
    return true;
  });
});

test("an Agent with a pending question shows no context_tokens: only agent_answer can continue it", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f);
  await call("agent_spawn", create());
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.runtime({
    activity: "tool",
    context: { tokens: 50_000, context_window: 1_000_000 },
  });
  f.ports[0].callbacks.question("Choose a branch?");
  f.ports[0].finish("decision needed");
  await settle(f, "orca");
  const asking = (await call("agent_read", { agent: "orca" })).agents[0];
  assert.equal(asking.status, "needs_input");
  assert.equal(typeof asking.question_id, "string");
  assert.equal(asking.context_tokens, undefined);
  await assert.rejects(call("agent_run", run("orca"), "blocked"), code("PENDING_QUESTION"));
});

test("routing changes before resume, replay and answer never re-resolve or migrate the bound model; Off replay stays observational", async (t) => {
  const admission = { enabled: true, revision: 0 },
    f = await fixture(t, { controller: { admission: () => ({ ...admission }) } });
  let presetReads = 0;
  const { state, call } = toolsFor(f, {
    getPreset() {
      presetReads++;
      assert.equal(
        presetReads,
        1,
        "resolveRoute must never run again for this accepted Agent or its replays",
      );
      return preset();
    },
  });
  const spawnArgs = create({ reasoning_difficulty: 3 });
  await call("agent_spawn", spawnArgs, "pinned-spawn");
  await until(() => f.ports[0]?.streaming);
  const bound = structuredClone(routed(f, "orca")),
    session = f.ports[0].session_id;
  f.ports[0].finish("first artifacts", "error", "synthetic provider error", "error");
  await settle(f, "orca");
  assert.equal(viewOf(f, "orca").outcome.reason, "execution_error");
  state.preset = preset("changed", "missing/replacement", "v2");
  state.catalog = [];
  state.thinking = "high";
  admission.enabled = false;
  admission.revision++;
  const replay = await call("agent_spawn", spawnArgs, "pinned-spawn");
  assert.equal(replay.workers_disabled, true);
  assert.equal(replay.agents[0].task, 1);
  assert.equal(Object.hasOwn(replay.agents[0], "recovery_hint"), false);
  assert.deepEqual(routed(f, "orca"), bound);
  assert.equal(f.ports[0].calls.length, 1);
  await assert.rejects(call("agent_run", run("orca"), "off-new-run"), code("WORKERS_DISABLED"));
  admission.enabled = true;
  admission.revision++;
  const runArgs = run("orca", { prompt: "Continue from the existing artifact" });
  const resumed = await call("agent_run", runArgs, "pinned-run");
  assert.equal(
    resumed.agents[0].recovery_hint,
    undefined,
    "an earlier failure does not stick to a new Run",
  );
  assert.deepEqual(routed(f, "orca"), bound);
  await until(() => f.ports[0].calls.length === 2);
  f.ports[0].callbacks.question("Which artifact should be used?");
  f.ports[0].finish("decision needed");
  await settle(f, "orca");
  const asking = (await call("agent_read", { agent: "orca" })).agents[0];
  assert.equal(asking.status, "needs_input");
  assert.equal(asking.recovery_hint, undefined);
  const answerArgs = {
    agent: "orca",
    question_id: asking.question_id,
    answer: "Use the retained artifact.",
  };
  state.preset = preset("changed-again", "missing/another", "v3");
  admission.enabled = false;
  admission.revision++;
  await assert.rejects(call("agent_answer", answerArgs, "off-answer"), code("WORKERS_DISABLED"));
  assert.equal(
    (await call("agent_read", { agent: "orca" })).agents[0].question_id,
    asking.question_id,
  );
  admission.enabled = true;
  admission.revision++;
  const answered = await call("agent_answer", answerArgs, "pinned-answer");
  assert.deepEqual(answered.action, { type: "agent_answer", agent: "orca", task: 3 });
  assert.deepEqual(routed(f, "orca"), bound);
  await until(() => f.ports[0].calls.length === 3);
  assert.equal(f.ports[0].calls[2].prompt, answerArgs.answer);
  f.ports[0].finish("answer artifacts", "error", "another synthetic error", "error");
  await settle(f, "orca");
  admission.enabled = false;
  admission.revision++;
  const answerReplay = await call("agent_answer", answerArgs, "pinned-answer");
  assert.equal(answerReplay.workers_disabled, true);
  assert.deepEqual(answerReplay.action, answered.action);
  assert.equal(Object.hasOwn(answerReplay.agents[0], "recovery_hint"), false);
  const runReplay = await call("agent_run", runArgs, "pinned-run");
  assert.equal(runReplay.agents[0].task, 2);
  assert.equal(runReplay.agents[0].status, "needs_input");
  assert.equal(
    runReplay.agents[0].recovery_hint,
    undefined,
    "replay projects its original outcome, not the latest task's failure",
  );
  assert.equal(presetReads, 1, "the resolveRoute preset dependency was read only at initial spawn");
  assert.deepEqual(routed(f, "orca"), bound);
  assert.equal(bound.difficulty, 3);
  assert.equal(f.ports.length, 1);
  assert.equal(f.ports[0].session_id, session);
  assert.equal(f.ports[0].calls.length, 3);
  assert.equal(f.controller.stats().runs, 3);
});

test("an interrupted answer that never started leaves the question answerable through the parent tools", async (t) => {
  const f = await fixture(t),
    { call } = toolsFor(f); // One execution slot.
  await call("agent_spawn", create(), "spawn");
  await until(() => f.ports[0]?.streaming);
  f.ports[0].callbacks.question("Which factor?");
  f.ports[0].finish("need a factor");
  await settle(f, "orca");
  await call("agent_spawn", create({ agent: "busy" }), "busy");
  await until(() => f.ports[1]?.streaming);
  const question_id = (await call("agent_read", { agent: "orca" })).agents[0].question_id;
  const firstAnswer = await call(
    "agent_answer",
    { agent: "orca", question_id, answer: "3" },
    "answer-1",
  );
  assert.deepEqual(firstAnswer.action, { type: "agent_answer", agent: "orca", task: 2 });
  assert.equal(firstAnswer.agents[0].status, "queued");
  await call("agent_interrupt", { agent: "orca" });
  await settle(f, "orca");

  const [row] = (await call("agent_list", {})).agents.filter((entry) => entry.agent === "orca");
  assert.equal(row.status, "needs_input");
  assert.equal(row.has_question, true);
  const restored = await call("agent_read", { agent: "orca" });
  assert.equal(restored.agents[0].question, "Which factor?");
  assert.equal(restored.agents[0].question_id, question_id);
  await assert.rejects(call("agent_run", run("orca"), "run"), code("PENDING_QUESTION"));
  const secondAnswer = await call(
    "agent_answer",
    { agent: "orca", question_id, answer: "4" },
    "answer-2",
  );
  assert.deepEqual(secondAnswer.action, { type: "agent_answer", agent: "orca", task: 3 });
  f.ports[1].finish();
  await settle(f, "busy");
  await until(() => f.ports[0].calls.length === 2);
  assert.equal(
    f.ports[0].calls[1].prompt,
    "4",
    "only the answer that ran reached the conversation",
  );
  f.ports[0].finish("done");
  await settle(f, "orca");
});
