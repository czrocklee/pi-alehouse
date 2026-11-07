import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { ended } from "./controller-fixture.mjs";

export const model = { provider: "fixture", id: "controlled", levels: ["off", "high"] };

export const preset = (name = "fixture", modelId = "fixture/controlled", version = "v1") => ({
  name,
  version,
  models: { d1: modelId, d2: modelId, d3: modelId, d4: modelId, d5: modelId },
  digest: "a".repeat(64),
  effort: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" },
  effort_defaults: { d1: "inherit", d2: "inherit", d3: "inherit", d4: "inherit", d5: "inherit" },
  effort_overrides: {},
});

export const profiles = () =>
  Object.fromEntries(
    ["editor", "researcher"].map((name) => [
      name,
      { definition: `${name} definition`, tools: ["read"] },
    ]),
  );

export const code = (value) => (error) => JSON.parse(error.message).error.code === value;

// Replies name Agents only; tests reach the host-side view through the controller.
export const runOf = (f, agent) => f.controller.findAgent(agent).run_id;

export const viewOf = (f, agent) => f.controller.view(runOf(f, agent));

export const routed = (f, agent) => viewOf(f, agent).effective_settings;

export const settle = (f, agent) => ended(f.controller, { run_id: runOf(f, agent) });

export function toolsFor(f, hooks = {}) {
  const state = {
    active: true,
    model,
    thinking: "off",
    catalog: [model],
    preset: preset(),
    entries: [],
  };
  const manager = {
    getSessionId: () => f.owner_id,
    buildSessionProjection: () => ({ messages: state.entries.map((entry) => entry.message) }),
  };
  const registry = { getAll: () => state.catalog };
  const ctx = {
    get sessionManager() {
      if (!state.active) throw new Error("SDK stale context");
      return manager;
    },
    get modelRegistry() {
      return registry;
    },
    get cwd() {
      return "/tmp";
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinking;
    },
  };
  const source = profiles();
  const options = {
    controller: f.controller,
    context: ctx,
    profiles: source,
    getSupportedThinkingLevels: (model) => model.levels,
    getPreset: () => structuredClone(state.preset),
    ...hooks,
  };
  const tools = createOwnerTools(options);
  const tool = (name) => tools.find((item) => item.name === name);
  const call = async (name, args, id = name, context = ctx, signal) => {
    const result = await tool(name).execute(id, args, signal, undefined, context);
    assert.equal(result.details, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const reply = JSON.parse(result.content[0].text);
    if (
      [
        "agent_spawn",
        "agent_run",
        "agent_send",
        "agent_answer",
        "agent_wait",
        "agent_read",
      ].includes(name)
    ) {
      assert(Array.isArray(reply.agents));
      if (Object.hasOwn(reply, "reason")) {
        assert.equal(typeof reply.reason, "string");
        assert(!["snapshot", "done"].includes(reply.reason));
      }
      for (const key of ["alerts_pending", "finished_pending"])
        if (Object.hasOwn(reply, key)) assert(reply[key] > 0);
      assert.equal(Object.hasOwn(reply, "pending"), false);
      for (const row of reply.agents) {
        for (const key of [
          "context_tokens",
          "time_wrapped",
          "recovery_hint",
          "earlier_labels",
          "touched",
          "touched_omitted",
          "elapsed_s",
        ])
          assert.equal(Object.hasOwn(row, key), false, key);
        assert.notEqual(row.result, "", "empty results are absent");
      }
      for (const retired of [
        "agent",
        "status",
        "delivery",
        "result",
        "question",
        "progress",
        "progress_omitted",
        "agents_omitted",
        "pending_omitted",
      ])
        assert.equal(
          Object.hasOwn(reply, retired),
          false,
          `${name} must preserve the unified envelope, not flatten ${retired}`,
        );
    }
    return reply;
  };
  return { state, ctx, source, options, tools, tool, call };
}

export const create = (rest = {}) => ({
  agent: "orca",
  prompt: "task",
  label: "task",
  profile: "worker",
  reasoning_difficulty: 3,
  ...rest,
});

export const send = (agent, rest = {}) => ({ agent, message: "task", ...rest });

export const run = (agent, rest = {}) => ({
  agent,
  prompt: "task",
  continues: "its earlier findings",
  label: "task",
  ...rest,
});

export const literalDispatch = {
  prepare(declaration, context) {
    const path = (word) => ({
      path: `${context.cwd}/${word}`,
      canonical: `${context.cwd}/${word}`,
    });
    return {
      declaration: structuredClone(declaration),
      inputs: (declaration.inputs ?? []).map(path),
      ownership: (declaration.ownership ?? []).map(path),
      ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree) }),
    };
  },
  async start() {
    return {};
  },
};

export const quickstartFlows = [
  ...readFileSync(
    new URL("../../docs/agent-tools-quickstart.md", import.meta.url),
    "utf8",
  ).matchAll(/```json\n([\s\S]*?)\n```/g),
].map((match) => JSON.parse(match[1]));
