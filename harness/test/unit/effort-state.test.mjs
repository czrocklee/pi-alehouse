import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PresetRouter, presetLabel, resolveRoute } from "../../dist/routing.js";
import { applyAuditedPreset, restorePresetRouter, validateWorkerEfforts, workerEffortCapabilities } from "../../dist/extension.js";
import { writePresetConfig } from "../support/preset-config.mjs";

const team = (effort) => ({ version: "v1", models: { light: "fixture/worker", standard: "fixture/worker", strong: "fixture/worker" },
  thinking: { standard: { low: "high" } }, ...(effort ? { effort } : {}) });
const registry = (levels = ["off", "high"]) => ({ parentThinking: "off",
  models: [{ provider: "fixture", id: "worker", levels }], supportedThinking: (model) => model.levels });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "harness-effort-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "presets.json");
  await writePresetConfig(path, { version: 2, defaultPreset: "team", presets: { team: team(), other: team({ standard: "high" }) } });
  const router = new PresetRouter(path); router.select("team");
  return { path, router };
}

test("session effort replay is branch-local, per preset, resettable and backward-readable", async (t) => {
  const { path, router } = await fixture(t);
  const session = SessionManager.inMemory("/tmp");
  const root = session.appendCustomEntry("fixture:root", {});
  const audit = (snapshot) => session.appendCustomEntry("harness:preset-selection:v1", snapshot);
  router.apply(router.prepare(), "team", audit, { light: "high", standard: "inherit" });
  router.apply(router.prepare(), "other", audit, { strong: "off" });
  router.apply(router.prepare(), "off", audit);
  const leaf = session.getLeafId();
  session.branch(root);
  session.appendCustomEntry("harness:preset-selection:v1", { name: "team", effort_overrides: { light: "max" } });
  session.branch(leaf);
  const records = () => session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "harness:preset-selection:v1")
    .map((entry) => entry.data);
  const restored = restorePresetRouter(path, records());
  assert.equal(restored.current().name, "off");
  assert.deepEqual(restored.select("team").effort_overrides, { light: "high", standard: "inherit" });
  assert.equal(presetLabel(restored.current()), "team@v1*");
  assert.deepEqual(restored.select("other").effort_overrides, { strong: "off" });
  restored.apply(restored.prepare(), "team", audit, {});
  const reset = restorePresetRouter(path, records());
  assert.deepEqual(reset.current().effort_overrides, {});
  assert.equal(presetLabel(reset.current()), "team@v1");
  assert.deepEqual(reset.select("other").effort_overrides, { strong: "off" });
  const legacy = restorePresetRouter(path, [{ name: "team", version: "old", digest: "0".repeat(64) }]);
  assert.equal(legacy.current().effort.standard, "inherit");
  assert.deepEqual(legacy.current().effort_overrides, {});
  const fresh = restorePresetRouter(path, []);
  assert.deepEqual(fresh.select("team").effort_overrides, {}, "a new session must not inherit another session's overrides");
});

test("malformed saved effort fails visibly without guessing; removed inactive presets don't block a valid selection", async (t) => {
  const { path } = await fixture(t);
  for (const effort_overrides of [null, [], "high", { light: "ultra" }, { typo: "high" }, { light: undefined }]) {
    assert.throws(() => restorePresetRouter(path, [{ name: "team", effort_overrides }]), { code: "INVALID_SAVED_EFFORT" });
  }
  assert.throws(() => restorePresetRouter(path, [{ name: "off", effort_overrides: {} }]), { code: "INVALID_SAVED_EFFORT" });
  assert.throws(() => restorePresetRouter(path, [{ effort_overrides: {} }]), { code: "INVALID_SAVED_EFFORT" });
  const restored = restorePresetRouter(path, [{ name: "removed", effort_overrides: { light: "high" } }, { name: "team" }]);
  assert.equal(restored.current().name, "team");
  assert.throws(() => restorePresetRouter(path, [{ name: "removed", effort_overrides: { light: "high" } }]), { code: "PRESET_NOT_FOUND" });
});

test("effort editor capabilities use exact host metadata and distinguish inherited mapping from fixed availability", async (t) => {
  const { router } = await fixture(t), preset = router.current(), input = registry();
  const before = structuredClone(preset);
  assert.deepEqual(workerEffortCapabilities(preset, "standard", input), { levels: ["off", "high"], inherited: "off" });
  input.parentThinking = "low";
  assert.deepEqual(workerEffortCapabilities(preset, "standard", input), { levels: ["off", "high"], inherited: "high" });
  const incompatible = workerEffortCapabilities(preset, "light", input);
  assert.deepEqual(incompatible.levels, ["off", "high"]);
  assert.equal(incompatible.inherited, undefined);
  assert.match(incompatible.inheritError, /Current parent thinking has no supported inherited level/);
  input.parentThinking = undefined;
  assert.match(workerEffortCapabilities(preset, "standard", input).inheritError, /Parent thinking is unavailable/);
  assert.deepEqual(preset, before, "inherit preview must not replace an effective fixed/default policy");
  for (const models of [[], [...input.models, ...input.models]]) {
    const result = workerEffortCapabilities(preset, "standard", { ...input, models });
    assert.deepEqual(result.levels, []); assert.match(result.error, /unavailable or ambiguous/);
  }
});

test("light-only Apply and restored validation ignore strong inherit/off incompatibility; admission still resolves it", async (t) => {
  const { path } = await fixture(t), custom = team();
  custom.models.strong = "openai-codex/fixture-strong-model";
  await writePresetConfig(path, { version: 2, defaultPreset: "team", presets: { team: custom } });
  const router = new PresetRouter(path); router.select("team");
  const input = registry();
  input.models.push({ provider: "openai-codex", id: "fixture-strong-model", levels: ["high"] });
  const records = [];
  const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: () => assert.fail("no history failure") };
  applyAuditedPreset({ controller, router, candidate: router.prepare(), name: "team", effort_overrides: { light: "high" },
    validate: (preset) => validateWorkerEfforts(preset, input), audit: (snapshot) => records.push(snapshot) });
  assert.equal(records.length, 1);
  assert.deepEqual(router.current().effort_overrides, { light: "high" });
  assert.match(workerEffortCapabilities(router.current(), "strong", input).inheritError, /Current parent thinking/);
  const restored = restorePresetRouter(path, records).current();
  assert.doesNotThrow(() => validateWorkerEfforts(restored, input), "startup must not warn about temporary inheritance");
  assert.equal(resolveRoute({ ...input, preset: restored, difficulty: 1 }).thinking, "high");
  assert.throws(() => resolveRoute({ ...input, preset: restored, difficulty: 5 }), { code: "THINKING_INCOMPATIBLE" });
  input.parentThinking = "high";
  assert.equal(resolveRoute({ ...input, preset: restored, difficulty: 5 }).thinking, "high", "inherit follows spawn-time parent, not Apply-time parent");
  input.parentThinking = undefined;
  assert.doesNotThrow(() => validateWorkerEfforts(restored, input));
  assert.throws(() => resolveRoute({ ...input, preset: restored, difficulty: 5 }), { code: "PARENT_THINKING_UNAVAILABLE" });
});

test("saving inherit tolerates missing/ambiguous models; every fixed slot still requires exact model support", async (t) => {
  const { router } = await fixture(t), preset = router.current(), input = registry();
  for (const models of [[], [...input.models, ...input.models]]) {
    const unavailable = { ...input, models, supportedThinking: () => assert.fail("inherit is not resolved when saving") };
    assert.doesNotThrow(() => validateWorkerEfforts(preset, unavailable));
    const fixed = router.apply(router.prepare(), "team", () => {}, { strong: "high" });
    assert.throws(() => validateWorkerEfforts(fixed, unavailable), (error) => {
      assert.equal(error.code, "PRESET_MODEL_UNAVAILABLE"); assert.equal(error.details.slot, "strong");
      assert.match(error.details.error, /unavailable or ambiguous/);
      assert.doesNotMatch(JSON.stringify(error.details), /difficulty|spawn_agent|parameter/);
      return true;
    });
  }
});

test("Apply revalidates changed model support before audit and never poisons the Owner on validation failure", async (t) => {
  const { router } = await fixture(t), input = registry();
  const before = router.current(), candidate = router.prepare();
  assert(workerEffortCapabilities(before, "light", input).levels.includes("high"));
  input.models[0].levels = ["off"]; // Registry changed after the editor opened.
  const latched = [], audited = [];
  const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: (error) => latched.push(error) };
  const apply = (overrides, validate = (preset) => validateWorkerEfforts(preset, input)) => applyAuditedPreset({
    controller, router, candidate, name: "team", effort_overrides: overrides, validate,
    audit: (snapshot) => audited.push(snapshot),
  });
  assert.throws(() => apply({ light: "high" }), (error) => {
    assert.equal(error.code, "THINKING_INCOMPATIBLE");
    assert.equal(error.details.slot, "light");
    assert.match(error.details.error, /does not support this fixed effort/);
    assert.match(error.details.resolution, /Choose a supported fixed level or inherit/);
    assert.doesNotMatch(JSON.stringify(error.details), /difficulty|spawn_agent|parameter/);
    return true;
  });
  assert.deepEqual(audited, []); assert.deepEqual(latched, []); assert.deepEqual(router.current(), before);
  assert.throws(() => apply({}, () => router.select("other")), { code: "PRESET_SELECTION_IN_PROGRESS" });
  assert.deepEqual(audited, []); assert.deepEqual(latched, []); assert.deepEqual(router.current(), before);
  apply({ light: "off" });
  assert.equal(audited.length, 1);
  assert.deepEqual(router.current().effort_overrides, { light: "off" });
  assert.equal(presetLabel(router.current()), "team@v1*");
});
