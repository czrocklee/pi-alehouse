import assert from "node:assert/strict";
import test from "node:test";
import { contextSources, textSnapshot } from "../../dist/runtime/context-snapshot.js";
import { assertHostCapabilities, assertPermissionEnvHints, subagentEnvHintKeys } from "../support/host.mjs";

test("H16 text-only snapshot, summary preservation, explicit byte bound", () => {
  const messages = [
    { role: "user", content: "用户" },
    { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "EXCLUDED" }, { type: "toolCall", name: "EXCLUDED" }] },
    { role: "toolResult", content: [{ type: "text", text: "EXCLUDED" }] },
    { role: "compactionSummary", summary: "summary" },
  ];
  const text = textSnapshot(messages);
  assert.match(text, /用户/); assert.match(text, /summary/); assert.doesNotMatch(text, /EXCLUDED/);
  assert.throws(() => textSnapshot(messages, Buffer.byteLength(text) - 1), /CONTEXT_SNAPSHOT_TOO_LARGE/);
  const files = [{ path: "/tmp/agent/AGENTS.md", content: "a" }, { path: "/tmp/project/AGENTS.md", content: "b" }];
  assert.deepEqual(contextSources([...files, files[0]], "/tmp/agent").map((f) => f.origin), ["operator", "child-cwd"]);
  assert.throws(() => contextSources([...files, { ...files[0], content: "drift" }], "/tmp/agent"), /CONTEXT_SOURCE_CONFLICT/);
});

test("installed host must expose the current required API, without version negotiation", () => {
  const sdk = { createAgentSession() {},
    AgentSession: class { bindExtensions() {} abort() {} clearQueue() {} followUp() {} getFollowUpMessages() {} },
    ExtensionRunner: class { emitCacheWarmingDecision() {} },
    SettingsManager: class { getCacheWarmingMode() {} setCacheWarmingMode() {} } };
  const permission = { getPermissionsService() {} };
  const ai = { getCurrentSystemPrompt() {}, getCurrentTools() {} };
  assert(Object.values(assertHostCapabilities(sdk, permission, ai)).every(Boolean));
  // Every API a fixture calls unconditionally, including the ones an older host
  // would otherwise fail on much later as a bare "not a function".
  for (const [object, key] of [[sdk, "createAgentSession"], [sdk.AgentSession.prototype, "bindExtensions"],
    [sdk.AgentSession.prototype, "abort"], [sdk.AgentSession.prototype, "clearQueue"], [permission, "getPermissionsService"],
    [ai, "getCurrentSystemPrompt"], [ai, "getCurrentTools"], [sdk.ExtensionRunner.prototype, "emitCacheWarmingDecision"],
    [sdk.SettingsManager.prototype, "getCacheWarmingMode"], [sdk.SettingsManager.prototype, "setCacheWarmingMode"],
    [sdk.AgentSession.prototype, "followUp"], [sdk.AgentSession.prototype, "getFollowUpMessages"]]) {
    const original = object[key]; delete object[key];
    assert.throws(() => assertHostCapabilities(sdk, permission, ai), /MISSING_HOST_CAPABILITY/);
    object[key] = original;
  }
  // A host that predates the 0.86 provider/warming APIs must be named, not guessed at.
  assert.throws(() => assertHostCapabilities(sdk, permission, undefined),
    /MISSING_HOST_CAPABILITY: transcriptSystemPrompt, transcriptTools/);
});

test("installed permission hint drift requires updating the reviewed shell isolation contract", () => {
  assertPermissionEnvHints([...subagentEnvHintKeys].reverse());
  assert.throws(() => assertPermissionEnvHints([...subagentEnvHintKeys, "PI_SUBAGENT_NEW_HINT"]), /PERMISSION_ENV_HINTS_CHANGED/);
  assert.throws(() => assertPermissionEnvHints(subagentEnvHintKeys.slice(1)), /PERMISSION_ENV_HINTS_CHANGED/);
  assert.throws(() => assertPermissionEnvHints(undefined), /PERMISSION_ENV_HINTS_UNAVAILABLE/);
});
