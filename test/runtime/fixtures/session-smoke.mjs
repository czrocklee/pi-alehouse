// Offline host-SDK packaging smoke, never a production SDK composition.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialize } from "../../../scripts/init.mjs";
import { packageRoot } from "../../../bin/runtime-support.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR;
assert(agentDir);
globalThis.fetch = () => { throw new Error("Unexpected network request in offline session smoke"); };
const keyFile = process.env.PI_JEV_API_KEY_FILE;
initialize({ agentDir });
const invalidPreset = process.argv.includes("--invalid-preset");
if (invalidPreset) {
  const path = join(agentDir, "harness-presets.json");
  const preserved = JSON.stringify({ version: 2, defaultPreset: "missing", presets: {} });
  writeFileSync(path, preserved);
  initialize({ agentDir });
  assert.equal(readFileSync(path, "utf8"), preserved, "init must preserve the user's invalid catalogue");
}
// Existing permissive policies must not widen the immutable runtime floor.
writeFileSync(join(agentDir, "extensions/pi-permission-system/config.json"), JSON.stringify({
  yoloMode: true, permission: { "*": "allow", path: "allow", path_write: "allow" },
}));
initTheme(undefined, false);
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
const loader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [join(packageRoot, "composition.ts")] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const model = { id: "no-network", name: "No network fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://invalid.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const { session } = await createAgentSession({ cwd: agentDir, agentDir, resourceLoader: loader, modelRuntime: runtime,
  model, thinkingLevel: "off", settingsManager, sessionManager: SessionManager.inMemory(agentDir), tools: ["read", "bash"] });
const errors = [];
try {
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  assert.deepEqual(errors, [], "all real parent session_start handlers must complete");
  const jiti = createJiti(import.meta.url);
  const entry = await jiti.import(join(packageRoot, "runtime/permission-system/index.ts"));
  const vendor = await jiti.import(join(packageRoot, "runtime/permission-system/vendor/src/service.ts"));
  const { getParser } = await jiti.import(join(packageRoot, "runtime/permission-system/vendor/src/access-intent/bash/parser.ts"));
  const tree = (await getParser()).parse("git status --short");
  assert(tree && !tree.rootNode.hasError, "private parser resolves its installed WASM dependencies");
  tree.delete();
  const service = entry.getPermissionsService(session.sessionId);
  assert(service, "generated wrapper exports the ready parent authority");
  assert.equal(service, vendor.getPermissionsService(session.sessionId));
  const extension = loader.getExtensions().extensions[0];
  if (invalidPreset) {
    assert(!extension.tools.has("spawn_agent"), "preset failure returns before management registration");
    const blocked = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "invalid-preset-read", toolName: "read", input: { path: "fixture.txt" } });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Harness initialization did not complete/);
    assert.throws(() => extension.handlers.get("user_bash")[0]({ command: "true" }), /Harness initialization did not complete/);
    await assert.rejects(session.extensionRunner.emitUserBash({ type: "user_bash", command: "true", excludeFromContext: false }), /Harness initialization did not complete/);
    console.log("PASS: preserved invalid preset leaves real SDK tool and user_bash latches blocked");
  } else {
  assert.equal(await extension.handlers.get("tool_call")[0]({ toolName: "read", input: { path: "fixture.txt" } }), undefined,
    "composition latch becomes ready only after the real authority");
  assert(extension.tools.has("spawn_agent"), "harness registers its tools during session_start");
  assert(!session.getActiveToolNames().includes("spawn_agent"), "Off seed keeps workers inactive");
  assert.equal(service.checkPermission("path_read", join(agentDir, "auth.json")).state, "deny");
  assert.equal(service.checkPermission("path_read", join(agentDir, "web-search.json")).state, "deny");
  assert.equal(service.checkPermission("path_write", join(packageRoot, "composition.ts")).state, "deny");
  assert.equal(service.checkPermission("path_write", join(packageRoot, "runtime/manifest.json")).state, "deny");
  assert(keyFile);
  assert.equal(process.env.PI_JEV_API_KEY_FILE, undefined, "Jev still scrubs its key-file path");
  assert.equal(service.checkPermission("path_read", keyFile).state, "deny", "the key path was protected before Jev scrubbed it");
  console.log("PASS: one real host parent starts Off, one canonical authority ready, no network");
  }
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
