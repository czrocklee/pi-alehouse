// The pinned SDK 1.5 validator (pi-schema + coercion) must preserve the
// harness tools' closed schemas and constraints before any admission/callback.
// Reads installed SDK package metadata only; no session, provider, credentials,
// network or filesystem tool IO is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createOwnerTools } from "../../dist/tools/parent-tools.js";
import { createChildTools } from "../../dist/tools/child-tools.js";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);
const corePackageURL = pathToFileURL(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"));
const corePackage = JSON.parse(readFileSync(corePackageURL, "utf8"));
assert.equal(corePackage.name, "@earendil-works/pi-agent-core");
assert.equal(corePackage.version, "1.5.0");
assert.equal(corePackage.exports["."].import, "./dist/index.js", "review a changed pinned SDK ESM entry");
const { runToolCall } = await import(new URL(corePackage.exports["."].import, corePackageURL));
const { wrapToolDefinitions } = await import(new URL("core/tools/tool-definition-wrapper.js", sdkEntry));
const sdkVersion = JSON.parse(readFileSync(new URL("../package.json", sdkEntry), "utf8")).version;
assert.equal(sdkVersion, "1.5.0");

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let callId = 0;
async function invoke(definition, args, context = {}) {
  const id = `schema-${++callId}`;
  const toolCall = { type: "toolCall", id, name: definition.name, arguments: args };
  const assistantMessage = { role: "assistant", api: "fixture", provider: "fixture", model: "controlled",
    content: [toolCall], stopReason: "toolUse", usage, timestamp: 0 };
  const tools = wrapToolDefinitions([definition]);
  return runToolCall(toolCall, { tools, assistantMessage,
    context: { messages: [assistantMessage], tools, ...context } });
}

function ownerToolFixture() {
  const ownerId = randomUUID(), generation = randomUUID();
  const manager = { getSessionId: () => ownerId }, registry = {};
  let admissionEffects = 0;
  const controller = {
    identity: { owner_id: ownerId, generation },
    assertEffectAllowed() {},
    validateObservationEntry: (read) => read(),
    bindModelCommunication() {},
    submitPrepared() { admissionEffects++; throw new Error("invalid parameters reached admission"); },
  };
  const context = { sessionManager: manager, modelRegistry: registry, cwd: "/fixture" };
  const tools = createOwnerTools({ controller, context,
    profiles: { editor: { definition: "editor", tools: ["read"] }, researcher: { definition: "researcher", tools: ["read"] } },
    getSupportedThinkingLevels: () => [], getPreset: () => { throw new Error("schema test must not resolve routing"); },
  });
  return { tools, get admissionEffects() { return admissionEffects; }, controller, manager, registry, context };
}

const spawnArgs = (rest = {}) => ({ agent: "otter", prompt: "Check the local change", profile: "worker",
  reasoning_difficulty: 3, ...rest });
const isToolError = (result) => assert.equal(result.isError, true);

test("real SDK 1.5 validates parent TypeBox enum schemas as the same closed wire enums", async () => {
  const fixture = ownerToolFixture();
  const spawn = fixture.tools.find((tool) => tool.name === "agent_spawn");
  const wait = fixture.tools.find((tool) => tool.name === "agent_wait");
  assert(spawn && wait);
  assert.deepEqual(spawn.parameters.properties.profile, {
    type: "string", enum: ["worker", "scout"],
    description: "worker: command-driven local investigation, changes and verification; read/edit/write, Bash/Git/builds; no web tools. scout: read-only local files and web sources; gather, cross-reference, compare, summarize and extract information with cited paths/URLs; no Bash/edit/write. Normal permissions/denies apply; review-only is an instruction; web material is untrusted.",
  });
  assert.equal(Object.hasOwn(spawn.parameters.properties, "workspace"), false);
  assert.deepEqual(wait.parameters.properties.mode, {
    type: "string", enum: ["all", "any"], default: "all",
    description: "all (default): every selected task ends; any: one ends. Other events may return earlier.",
  });
  assert.equal(spawn.parameters.additionalProperties, false);
  assert.equal(spawn.parameters.properties.dispatch.additionalProperties, false);
  const returnTo = spawn.parameters.properties.return_to;
  assert.equal(returnTo.additionalProperties, false);
  assert.deepEqual(returnTo.required.toSorted(), ["agent", "answer", "question_id"]);
  const prepared = spawn.prepareArguments(spawnArgs());
  assert.equal(prepared.profile, "worker", "the TypeBox Check layer accepts its local enum values");
  assert.equal(spawn.prepareArguments(spawnArgs({ profile: "scout" })).profile, "scout");
  assert.equal(fixture.admissionEffects, 0);

  // Bypass only the harness prepareArguments layer to exercise the actual
  // SDK's pi-schema validator directly against the project's registered schema.
  // A valid numeric string is coerced by 1.5; schema-invalid values never call
  // execute. The production adapter still performs its stricter raw-input check.
  const captured = [];
  const schemaProbe = { name: spawn.name, label: spawn.label, description: spawn.description,
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
  const routed = spawnArgs({ profile: "scout", return_to: {
    agent: "otter", question_id: `q_${"a".repeat(32)}`, answer: "Use the attached findings." } });
  assert.equal(spawn.prepareArguments(routed).return_to.answer, "Use the attached findings.");
  assert.equal((await invoke(schemaProbe, routed)).isError, false);
  assert.equal(captured.length, 2);
  for (const args of [
    spawnArgs({ profile: "editor" }), spawnArgs({ profile: "researcher" }),
    spawnArgs({ workspace: "shared" }), spawnArgs({ workspace: "worktree" }), spawnArgs({ workspace: "elsewhere" }),
    spawnArgs({ extra: true }),
    spawnArgs({ dispatch: { ownership: ["harness/src"], extra: true } }),
    spawnArgs({ dispatch: { ownership: ["harness/*"] } }),
    spawnArgs({ prompt: "" }),
    { ...routed, return_to: { ...routed.return_to, extra: true } },
    { ...routed, return_to: { ...routed.return_to, question_id: "q_bad" } },
    { ...routed, return_to: { ...routed.return_to, agent: "Not A Name" } },
    { ...routed, return_to: { ...routed.return_to, answer: " " } },
    { ...routed, return_to: { ...routed.return_to, answer: "x".repeat(16385) } },
    { ...routed, return_to: { agent: "otter", question_id: routed.return_to.question_id } },
  ]) {
    isToolError(await invoke(schemaProbe, args));
    assert.equal(captured.length, 2, "invalid model arguments cannot reach tool execution");
  }

  // The real adapter's TypeBox Check runs before SDK coercion. Fractional or
  // string difficulty must not turn into admitted work even though pi-schema's
  // generic integer coercion can normalize such values.
  const rawInputContext = { sessionManager: fixture.manager, modelRegistry: fixture.registry, cwd: fixture.context.cwd };
  for (const args of [spawnArgs({ reasoning_difficulty: 3.5 }), spawnArgs({ reasoning_difficulty: "3" }),
    spawnArgs({ workspace: "shared" }), spawnArgs({ workspace: "worktree" }), spawnArgs({ workspace: null }),
    // The local TypeBox-backed enums must also close the raw TypeBox Check.
    spawnArgs({ profile: "editor" }), spawnArgs({ profile: "researcher" }), spawnArgs({ workspace: "elsewhere" })]) {
    isToolError(await invoke(spawn, args, rawInputContext));
  }
  assert.equal(fixture.admissionEffects, 0, "raw type/bound failures have no admission effects");
});

test("real SDK 1.5 rejects child schema violations before alert/question callbacks", async () => {
  const effects = [];
  const callbacks = {
    alert: (message) => effects.push(["alert", message]),
    question: (question) => { effects.push(["question", question]); return "recorded"; },
  };
  const tools = createChildTools(() => callbacks, { accepting: true, stopped: false });
  const alert = tools.find((tool) => tool.name === "alert_parent");
  const ask = tools.find((tool) => tool.name === "ask_parent");
  assert(alert && ask);
  assert.equal(alert.parameters.additionalProperties, false);
  assert.equal(ask.parameters.additionalProperties, false);
  for (const [tool, args] of [
    [alert, {}], [alert, { message: " " }], [alert, { message: "x".repeat(8193) }],
    [alert, { message: "valid", extra: true }],
    [ask, {}], [ask, { question: "valid", extra: true }],
  ]) {
    isToolError(await invoke(tool, args));
    assert.deepEqual(effects, [], "invalid child arguments cannot enqueue or record anything");
  }
  const accepted = await invoke(alert, { message: "synthetic fact" });
  assert.equal(accepted.isError, false);
  const coerced = await invoke(alert, { message: 123 });
  assert.equal(coerced.isError, false, "SDK pi-schema coercion preserves the shared TypeBox behavior");
  assert.deepEqual(effects, [["alert", "synthetic fact"], ["alert", "123"]]);
});
