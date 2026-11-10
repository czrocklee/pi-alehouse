// Real pinned SDK extension dispatch with synthetic cost decisions only. No
// session prompt, provider call, credentials, network, timer or warming request.
// This proves the decision seam, not provider suppression/timing guarantees.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChildRunGate } from "../../dist/orchestration/runtime/agent-session.js";

// Per-file process isolation: resource discovery must never use the user's state.
const home = await mkdtemp(join(tmpdir(), "alehouse-cache-warming-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
test.after(() => rm(home, { recursive: true, force: true }));
const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { version } = JSON.parse(await readFile(new URL("../package.json", sdkEntry), "utf8"));
assert.equal(version, "1.5.2");

for (const configuredMode of [undefined, "streaming"]) {
  const mode = configuredMode ?? "idle";
  test(`real SDK: child gate stops warming with ${configuredMode ? "explicit streaming" : "default idle"} parent policy`, async (t) => {
    let networkCalls = 0;
    t.mock.method(globalThis, "fetch", () => {
      networkCalls++;
      assert.fail("cache-warming decision fixture attempted network IO");
    });
    t.after(() => assert.equal(networkCalls, 0));
    const settings = sdk.SettingsManager.inMemory(
      configuredMode ? { cacheWarming: configuredMode } : {},
    );
    assert.equal(settings.getCacheWarmingMode(), mode);
    const originalSettings = settings.getGlobalSettings();
    const earlierDecisions = [];
    const warm = (pi) => {
      pi.on("cache_warming_decision", (event) => {
        earlierDecisions.push(event.action);
        return { action: "warm" };
      });
    };
    const gate = new ChildRunGate();
    const loader = new sdk.DefaultResourceLoader({
      cwd: home,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [warm, gate.extension], // Trusted child assembly loads the gate LAST.
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    const runtime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new sdk.ModelRegistry(runtime);
    const runner = (extensions) =>
      new sdk.ExtensionRunner(
        extensions,
        loaded.runtime,
        home,
        sdk.SessionManager.inMemory(home),
        registry,
      );
    const parent = runner(loaded.extensions.slice(0, 1));
    const child = runner(loaded.extensions);
    const errors = [];
    parent.onError((error) => errors.push(error));
    child.onError((error) => errors.push(error));
    assert.equal(child.hasHandlers("cache_warming_decision"), true);

    // Pi 1.5.2's CacheWarmingDecisionEvent has no mode field. Exercise both
    // configured policies without inventing a field or running refresh timers.
    const decision = (action) => ({
      type: "cache_warming_decision",
      warmCost: 0.01,
      missCost: 0.1,
      continuationProbability: 1,
      action,
    });
    assert.equal(await parent.emitCacheWarmingDecision(decision("warm")), "warm");
    for (const accepting of [false, true]) {
      gate.accepting = accepting;
      for (const action of ["warm", "stop"]) {
        assert.equal(await child.emitCacheWarmingDecision(decision(action)), "stop");
      }
    }
    assert.equal(
      await parent.emitCacheWarmingDecision(decision("stop")),
      "warm",
      "the child's stop does not affect a parent runner's extension decision",
    );
    assert.deepEqual(earlierDecisions, ["warm", "warm", "stop", "warm", "stop", "stop"]);
    assert.deepEqual(errors, [], "no swallowed extension-handler errors");
    assert.equal(settings.getCacheWarmingMode(), mode, "parent/global policy is unchanged");
    assert.deepEqual(settings.getGlobalSettings(), originalSettings);
    assert.equal(Object.hasOwn(originalSettings, "cacheWarming"), configuredMode !== undefined);
  });
}
