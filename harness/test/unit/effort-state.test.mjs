import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PresetRouter, presetLabel, resolveRoute, strengths } from "../../dist/routing.js";
import { applyAuditedPreset, restorePresetRouter, validateWorkerEfforts, workerEffortCapabilities } from "../../dist/extension.js";
import { writePresetConfig } from "../support/preset-config.mjs";
import { difficultySlots } from "../../dist/core/contracts.js";
import { workerSlotDisplayOrder } from "../../dist/ui/preset-picker.js";

const team = (effort = {}) => ({ version: "v1", slots: Object.fromEntries(strengths.map((slot) => [slot,
  { model: "fixture/worker", ...(effort[slot] === undefined ? {} : { effort: effort[slot] }) }])) });
const registry = (levels = ["off", "high"]) => ({ parentThinking: "off",
  models: [{ provider: "fixture", id: "worker", levels }], supportedThinking: (model) => model.levels });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "harness-effort-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "presets.json");
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: team(), other: team({ d3: "high" }) } });
  const router = new PresetRouter(path); router.select("team");
  return { path, router };
}

test("hardest-first UI order leaves canonical difficulty mapping and selection digests unchanged", async (t) => {
  const { router } = await fixture(t);
  assert.equal(strengths, difficultySlots);
  assert.deepEqual(difficultySlots, ["d1", "d2", "d3", "d4", "d5"]);
  assert.deepEqual(workerSlotDisplayOrder, ["d5", "d4", "d3", "d2", "d1"]);
  const body = { version: "v1", slots: Object.fromEntries(strengths.map((slot) => [slot, { model: `fixture/${slot}` }])) };
  router.commit(router.prepare({ distinct: body }), "distinct");
  const selected = router.current(), digest = selected.digest;
  const input = { parentThinking: "off", supportedThinking: () => ["off"],
    models: strengths.map((slot) => ({ provider: "fixture", id: slot })) };
  for (const slot of workerSlotDisplayOrder) {
    const route = resolveRoute({ ...input, preset: selected, difficulty: Number(slot.slice(1)) });
    assert.equal(route.strength, slot);
    assert.equal(route.provider, "fixture");
    assert.equal(route.model, slot);
    assert.equal(route.selection_digest, digest);
  }
  const reordered = { ...body, slots: Object.fromEntries(workerSlotDisplayOrder.map((slot) => [slot, body.slots[slot]])) };
  const candidate = router.prepare({ distinct: reordered });
  assert.equal(router.inspect(candidate).find((preset) => preset.name === "distinct").digest, digest,
    "presentation/insertion order is not a new routing digest");
  assert.equal(router.current().digest, digest);
  assert.deepEqual(difficultySlots, ["d1", "d2", "d3", "d4", "d5"]);
});

test("committed candidate continuations require the exact own publication, never an external selection", async (t) => {
  const { path, router } = await fixture(t), original = router.prepare();
  assert(router.isCurrent(original));
  assert.throws(() => router.rebase(original), { code: "STALE_PRESET_SELECTION" });
  router.apply(original, "team", () => {}, { d1: "high" });
  const continued = router.rebase(original);
  assert(!router.isCurrent(original)); assert(router.isCurrent(continued));
  assert.equal(continued.activeName, "team");
  router.apply(continued, "team", () => {}, { d1: "off" });
  const next = router.rebase(continued);
  assert.deepEqual(router.current().effort_overrides, { d1: "off" });
  router.select("other");
  assert(!router.isCurrent(next));
  assert.throws(() => router.rebase(next), { code: "STALE_PRESET_SELECTION" }, "select must not masquerade as an own apply");
  router.select("team");
  assert.throws(() => router.apply(next, "team", () => {}, {}), { code: "STALE_PRESET_SELECTION" });
  const foreign = new PresetRouter(path).prepare();
  assert(!router.isCurrent(foreign));
  assert.throws(() => router.rebase(foreign), { code: "INVALID_PRESET_CANDIDATE" });
});

test("session effort replay is branch-local, per preset, resettable and backward-readable", async (t) => {
  const { path, router } = await fixture(t);
  const session = SessionManager.inMemory("/tmp");
  const root = session.appendCustomEntry("fixture:root", {});
  const audit = (snapshot) => session.appendCustomEntry("harness:preset-selection:v1", snapshot);
  router.apply(router.prepare(), "team", audit, { d1: "high", d2: "low", d3: "inherit", d4: "medium", d5: "max" });
  router.apply(router.prepare(), "other", audit, { d5: "off" });
  router.apply(router.prepare(), "off", audit);
  const leaf = session.getLeafId();
  session.branch(root);
  session.appendCustomEntry("harness:preset-selection:v1", { name: "team", effort_overrides: { d1: "max" } });
  session.branch(leaf);
  const records = () => session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "harness:preset-selection:v1")
    .map((entry) => entry.data);
  const restored = restorePresetRouter(path, records());
  assert.equal(restored.current().name, "off");
  assert.deepEqual(restored.select("team").effort_overrides, { d1: "high", d2: "low", d3: "inherit", d4: "medium", d5: "max" });
  assert.equal(presetLabel(restored.current()), "team@v1*");
  assert.deepEqual(restored.select("other").effort_overrides, { d5: "off" });
  restored.apply(restored.prepare(), "team", audit, {});
  const reset = restorePresetRouter(path, records());
  assert.deepEqual(reset.current().effort_overrides, {});
  assert.equal(presetLabel(reset.current()), "team@v1");
  assert.deepEqual(reset.select("other").effort_overrides, { d5: "off" });
  const legacy = restorePresetRouter(path, [{ name: "team", version: "old", digest: "0".repeat(64) }]);
  assert.equal(legacy.current().effort.d3, "inherit");
  assert.deepEqual(legacy.current().effort_overrides, {});
  const fresh = restorePresetRouter(path, []);
  assert.deepEqual(fresh.select("team").effort_overrides, {}, "a new session must not inherit another session's overrides");
});

test("malformed saved effort fails visibly without guessing; removed inactive presets don't block a valid selection", async (t) => {
  const { path } = await fixture(t);
  for (const effort_overrides of [null, [], "high", { d1: "ultra" }, { typo: "high" }, { d1: undefined }, { light: "high" }]) {
    assert.throws(() => restorePresetRouter(path, [{ name: "team", effort_overrides }]), { code: "INVALID_SAVED_EFFORT" });
  }
  for (const record of [{ name: "off", effort_overrides: {} }, { effort_overrides: {} },
    { name: "team", effort_overrides: { d3: "private-rejected-effort" } }]) {
    const before = structuredClone(record);
    assert.throws(() => restorePresetRouter(path, [record]), (error) => {
      assert.equal(error.code, "INVALID_SAVED_EFFORT");
      assert.deepEqual(Object.keys(error.details).sort(), ["record", "resolution"]);
      assert.equal(error.details.record, "harness:preset-selection:v1");
      assert.match(error.details.resolution, /branch record failed worker configuration validation/);
      assert.match(error.details.resolution, /named non-Off preset and valid policies/);
      assert.match(error.details.resolution, /d1, d2, d3, d4, d5.*version-2 settings rules/);
      assert.match(error.details.resolution, /fresh session or fork from before the invalid harness:preset-selection:v1 record and restart Pi/);
      assert.match(error.details.resolution, /Do not rewrite historical journal records/);
      assert.doesNotMatch(JSON.stringify(error.details), /legacy|light\/standard\/strong|private-rejected-effort|config_path/);
      return true;
    });
    assert.deepEqual(record, before, "rejection must not rewrite the saved branch record");
  }
  const restored = restorePresetRouter(path, [{ name: "removed", effort_overrides: { d1: "high" } }, { name: "team" }]);
  assert.equal(restored.current().name, "team");
  assert.throws(() => restorePresetRouter(path, [{ name: "removed", effort_overrides: { d1: "high" } }]), { code: "PRESET_NOT_FOUND" });
});

test("effort editor capabilities preview the automatic ceiling and do not reject an unsupported positive that can round up", async (t) => {
  const { router } = await fixture(t), preset = router.current(), input = registry();
  const before = structuredClone(preset);
  assert.equal(Object.hasOwn(preset, "thinking"), false, "normalized snapshots carry no config map");
  assert.deepEqual(workerEffortCapabilities(preset, "d3", input), { levels: ["off", "high"], inherited: "off" });
  input.parentThinking = "low";
  // low is absent, but high is a higher positive. Every inherit slot ceilings; a missing map is not a rejection.
  for (const slot of ["d1", "d3", "d5"]) {
    assert.deepEqual(workerEffortCapabilities(preset, slot, input), { levels: ["off", "high"], inherited: "high" }, slot);
  }
  input.models = [{ provider: "fixture", id: "worker", levels: ["off"] }];
  const noPositive = workerEffortCapabilities(preset, "d1", input);
  assert.deepEqual(noPositive.levels, ["off"]);
  assert.equal(noPositive.inherited, undefined);
  assert.match(noPositive.inheritError, /Current parent thinking has no supported inherited level under the automatic rule/);
  input.models = [{ provider: "fixture", id: "worker", levels: ["high"] }];
  input.parentThinking = "off";
  const offUnsupported = workerEffortCapabilities(preset, "d3", input);
  assert.equal(offUnsupported.inherited, undefined);
  assert.match(offUnsupported.inheritError, /under the automatic rule/);
  input.parentThinking = undefined;
  input.models = [{ provider: "fixture", id: "worker", levels: ["off", "high"] }];
  assert.match(workerEffortCapabilities(preset, "d3", input).inheritError, /Parent thinking is unavailable/);
  assert.deepEqual(preset, before, "inherit preview must not replace an effective fixed/default policy");
  for (const models of [[], [...input.models, ...input.models]]) {
    const result = workerEffortCapabilities(preset, "d3", { ...input, models });
    assert.deepEqual(result.levels, []); assert.match(result.error, /unavailable or ambiguous/);
  }
});

test("virtual worker effort preview exposes no levels and fixed selection fails before audit", async (t) => {
  const { router } = await fixture(t), preset = router.current();
  const input = { ...registry(), models: [{ provider: "fixture", id: "worker", api: "pi-virtual" }],
    supportedThinking: () => assert.fail("virtual effort must not be queried") };
  assert.deepEqual(workerEffortCapabilities(preset, "d3", input), {
    levels: [], error: "Choose a physical worker model; virtual models route each request.",
  });
  const audited = [], latched = [];
  assert.throws(() => applyAuditedPreset({
    controller: { assertOwnerAvailable() {}, latchParentHistoryFailure: (error) => latched.push(error) },
    router, candidate: router.prepare(), name: "team", effort_overrides: { d1: "high" },
    validate: (selected) => validateWorkerEfforts(selected, input), audit: (snapshot) => audited.push(snapshot),
  }), (error) => error.code === "PRESET_MODEL_UNAVAILABLE" && /physical worker model/.test(error.details.error));
  assert.deepEqual(audited, []); assert.deepEqual(latched, []);
  assert.deepEqual(router.current(), preset);
});

test("d1-only Apply and restored validation ignore d5 inherit/off incompatibility; admission still resolves it", async (t) => {
  const { path } = await fixture(t), custom = team();
  custom.slots.d5.model = "openai-codex/fixture-strong-model";
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: custom } });
  const router = new PresetRouter(path); router.select("team");
  const input = registry();
  input.models.push({ provider: "openai-codex", id: "fixture-strong-model", levels: ["high"] });
  const records = [];
  const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: () => assert.fail("no history failure") };
  applyAuditedPreset({ controller, router, candidate: router.prepare(), name: "team", effort_overrides: { d1: "high" },
    validate: (preset) => validateWorkerEfforts(preset, input), audit: (snapshot) => records.push(snapshot) });
  assert.equal(records.length, 1);
  assert.deepEqual(router.current().effort_overrides, { d1: "high" });
  assert.match(workerEffortCapabilities(router.current(), "d5", input).inheritError, /under the automatic rule/);
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
    const fixed = router.apply(router.prepare(), "team", () => {}, { d5: "high" });
    assert.throws(() => validateWorkerEfforts(fixed, unavailable), (error) => {
      assert.equal(error.code, "PRESET_MODEL_UNAVAILABLE"); assert.equal(error.details.slot, "d5");
      assert.match(error.details.error, /unavailable or ambiguous/);
      assert.doesNotMatch(JSON.stringify(error.details), /difficulty|delegate|parameter/);
      return true;
    });
  }
});

test("Apply revalidates changed model support before audit and never poisons the Owner on validation failure", async (t) => {
  const { router } = await fixture(t), input = registry();
  const before = router.current(), candidate = router.prepare();
  assert(workerEffortCapabilities(before, "d1", input).levels.includes("high"));
  input.models[0].levels = ["off"]; // Registry changed after the editor opened.
  const latched = [], audited = [];
  const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: (error) => latched.push(error) };
  const apply = (overrides, validate = (preset) => validateWorkerEfforts(preset, input)) => applyAuditedPreset({
    controller, router, candidate, name: "team", effort_overrides: overrides, validate,
    audit: (snapshot) => audited.push(snapshot),
  });
  assert.throws(() => apply({ d1: "high" }), (error) => {
    assert.equal(error.code, "THINKING_INCOMPATIBLE");
    assert.equal(error.details.slot, "d1");
    assert.match(error.details.error, /does not support this fixed effort/);
    assert.match(error.details.resolution, /Choose a supported fixed level or inherit/);
    assert.doesNotMatch(JSON.stringify(error.details), /difficulty|delegate|parameter/);
    return true;
  });
  assert.deepEqual(audited, []); assert.deepEqual(latched, []); assert.deepEqual(router.current(), before);
  assert.throws(() => apply({}, () => router.select("other")), { code: "PRESET_SELECTION_IN_PROGRESS" });
  assert.deepEqual(audited, []); assert.deepEqual(latched, []); assert.deepEqual(router.current(), before);
  apply({ d1: "off" });
  assert.equal(audited.length, 1);
  assert.deepEqual(router.current().effort_overrides, { d1: "off" });
  assert.equal(presetLabel(router.current()), "team@v1*");
});
