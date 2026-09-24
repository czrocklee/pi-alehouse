import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveManagedAuthority } from "./managed-authority.mjs";

// Reviewed process-subagent hints. SDK fixtures compare this list with the
// selected permission closure; shell regressions inject it into all wrappers.
export const subagentEnvHintKeys = Object.freeze([
  "PI_AGENT_ROUTER_PARENT_SESSION_ID", "PI_SUBAGENT_PARENT_SESSION",
  "PI_IS_SUBAGENT", "PI_SUBAGENT_SESSION_ID", "PI_AGENT_ROUTER_SUBAGENT", "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_DEPTH", "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ACTIVITY_FILE",
]);
export function assertPermissionEnvHints(actual) {
  assert(Array.isArray(actual), "PERMISSION_ENV_HINTS_UNAVAILABLE");
  assert.deepEqual([...actual].sort(), [...subagentEnvHintKeys].sort(),
    "PERMISSION_ENV_HINTS_CHANGED: review the selected hints and all wrapper unset lists");
}

// Required current API, not version negotiation, a fallback or host admission.
// `ai` is the installed host's, so every API a fixture calls unconditionally
// belongs here: an older host must fail as MISSING_HOST_CAPABILITY, never as a
// bare "not a function" raised later inside a provider stream or a hook emit.
export function assertHostCapabilities(sdk, permission, ai) {
  const capabilities = {
    createSession: typeof sdk.createAgentSession === "function",
    bindExtensions: typeof sdk.AgentSession?.prototype.bindExtensions === "function",
    abort: typeof sdk.AgentSession?.prototype.abort === "function",
    clearQueue: typeof sdk.AgentSession?.prototype.clearQueue === "function",
    permissionService: typeof permission.getPermissionsService === "function",
    // Pi 0.87.1 hands providers a TranscriptContext; the controlled fixture rebuilds
    // its snapshot API from the transcript with these two.
    transcriptSystemPrompt: typeof ai?.getCurrentSystemPrompt === "function",
    transcriptTools: typeof ai?.getCurrentTools === "function",
    // The child cache-warming veto and the fixtures that drive/observe it.
    cacheWarmingDecision: typeof sdk.ExtensionRunner?.prototype.emitCacheWarmingDecision === "function",
    cacheWarmingMode: typeof sdk.SettingsManager?.prototype.getCacheWarmingMode === "function"
      && typeof sdk.SettingsManager?.prototype.setCacheWarmingMode === "function",
    // Direct steer/followUp traverse input handlers in Pi 0.87.1; p1 seeds a real
    // follow-up queue through them and reads it back.
    followUp: typeof sdk.AgentSession?.prototype.followUp === "function",
    followUpQueue: typeof sdk.AgentSession?.prototype.getFollowUpMessages === "function",
  };
  const missing = Object.keys(capabilities).filter((name) => !capabilities[name]);
  assert.equal(missing.length, 0, `MISSING_HOST_CAPABILITY: ${missing.join(", ")}`);
  return capabilities;
}

export function assertThinkingSupported(model, thinking, getSupportedThinkingLevels) {
  const allowed = getSupportedThinkingLevels(model);
  assert(allowed.includes(thinking), `UNSUPPORTED_THINKING: ${thinking}; allowed: ${allowed.join(", ")}`);
}

export async function loadHost(piExecutable) {
  const { permissionRoot, permissionEntry, authority } = resolveManagedAuthority(process.env.PI_CODING_AGENT_DIR);
  const executable = realpathSync(piExecutable);
  const require = createRequire(executable);
  let root = dirname(executable);
  while (!existsSync(join(root, "package.json"))) {
    assert.notEqual(root, dirname(root), "Pi package not found");
    root = dirname(root);
  }
  const packageAt = (path) => JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  assert.equal(packageAt(root).name, "@earendil-works/pi-coding-agent");
  const tuiRoot = dirname(require.resolve("@earendil-works/pi-tui/package.json"));
  const sdk = await import(pathToFileURL(join(root, "dist/index.js")));
  const tui = await import(pathToFileURL(join(tuiRoot, "dist/index.js")));
  // pi-ai exports only the ESM "import" condition; require.resolve(packageName)
  // throws ERR_PACKAGE_PATH_NOT_EXPORTED. Stay within this selected host's
  // installed closure rather than falling back to development dependencies.
  const aiEntry = join(dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(executable).href)), "dist/index.js");
  const ai = await import(pathToFileURL(aiEntry));
  const { createJiti } = require("jiti");
  // Public package export, not a private registry import. Pi's permission
  // service locator intentionally shares its map across jiti module copies.
  const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
    "@earendil-works/pi-ai": aiEntry,
    "@earendil-works/pi-tui": join(tuiRoot, "dist/index.js"),
  } });
  const serviceEntry = authority.selector.entryPoint;
  const managed = await jiti.import(serviceEntry);
  const publicApi = await jiti.import(join(permissionRoot, "src/service.ts"));
  assert.equal(managed.getPermissionsService, publicApi.getPermissionsService, "MANAGED_SERVICE_IDENTITY_CHANGED");
  // Event channel constants come from the same PRIVATE patched vendor. The
  // selected generated authority owns the service accessor, never npm fallback.
  const permission = { ...publicApi, ...managed };
  const capabilities = assertHostCapabilities(sdk, permission, ai);
  // Fixture-only audit: this constant is not a public package export. Source
  // movement or hint drift must fail visibly, never silently select a fallback.
  const { SUBAGENT_ENV_HINT_KEYS } = await jiti.import(join(permissionRoot, "src/authority/permission-forwarding.ts"));
  assertPermissionEnvHints(SUBAGENT_ENV_HINT_KEYS);
  return { sdk, ai, tui, permission, permissionRoot, permissionEntry, authority, root, require, capabilities,
    versions: { pi: packageAt(root).version, tui: packageAt(tuiRoot).version, permission: packageAt(permissionRoot).version },
  };
}

// Watchdog request only, not exit proof. Invoke abort immediately (before the
// first await), observing both synchronous throws and asynchronous rejections.
export async function requestAbort(session, errors) {
  try { await session.abort(); }
  catch (error) { errors.push(String(error)); }
}

// Fixture cleanup only: one deadline covers both abort and idle confirmation.
// A timeout is sticky failure, not exit evidence; callers must skip disposal.
// Promise.race observes late rejection without reviving a timed-out cleanup.
export async function abortAndWaitForIdle(session, timeoutMs = 5000) {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "INVALID_ABORT_TIMEOUT");
  let timer;
  try {
    await Promise.race([
      (async () => {
        await session.abort();
        await session.waitForIdle();
        assert.equal(session.isIdle, true, "EXECUTION_NOT_EXITED");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SESSION_ABORT_OR_IDLE_TIMEOUT")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function controlledProvider(ai) {
  const requests = [];
  let next = async () => ({ text: "fixture-result" });
  let waiting;
  const config = {
    baseUrl: "https://invalid.invalid/never-used", apiKey: "fixture-not-a-credential", api: "harness-fixture",
    models: [{ id: "controlled", name: "P0 controlled IO", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const request = { model, context: structuredClone({
        // Pi 0.87.1 provider inputs are TranscriptContext: derive current prompt
        // and tools from the transcript, retaining this fixture's snapshot API.
        systemPrompt: ai.getCurrentSystemPrompt(context.messages), messages: context.messages,
        tools: ai.getCurrentTools(context.messages).map(({ name, description, parameters }) => ({ name, description, parameters })),
      }), signal: options?.signal, maxTokens: options?.maxTokens };
      requests.push(request);
      const respond = next;
      waiting?.(request); waiting = undefined;
      void (async () => {
        const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "pending", timestamp: Date.now() };
        stream.push({ type: "start", partial: output });
        try {
          const response = await respond(request);
          output.content = response.tools
            ? [...(response.text === undefined ? [] : [{ type: "text", text: response.text }]), ...response.tools]
            : [{ type: "text", text: response.text ?? "fixture-result" }];
          output.stopReason = response.reason ?? (response.tools ? "toolUse" : "stop");
          output.errorMessage = response.error;
          if (output.stopReason === "error" || output.stopReason === "aborted") {
            stream.push({ type: "error", reason: output.stopReason, error: output });
          } else {
            stream.push({ type: "done", reason: output.stopReason, message: output });
          }
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally { stream.end(); }
      })();
      return stream;
    },
  };
  return { config, requests, respond: (fn) => { next = fn; },
    requested: () => new Promise((resolve) => { waiting = resolve; }),
  };
}
