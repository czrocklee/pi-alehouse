import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { inheritedThinkingPolicy, isOffPreset, presetLabel, PresetRouter, resolveRoute, resolveSlotRoute, selectPhysicalWorkerModel, strengths, thinkingLevels, validEffortOverrides } from "../../dist/routing.js";
import { digest } from "../../dist/runtime/context-snapshot.js";
import { createChildSessionFactory } from "../../dist/runtime/child-factory.js";
import { presetConfig, starterConfig, writePresetConfig } from "../support/preset-config.mjs";
import harnessExtension, { applyAuditedPreset, restorePresetRouter } from "../../dist/extension.js";
import { validDifficulty } from "../../dist/core/contracts.js";
import { validateSettings } from "../../../lib/settings-store.mjs";

// Fixed mock-registry assertions: these values belong to test/support/presets.json,
// not the operator's editable production catalogue.
const builtins = {
  "fixture-strong": ["openai-codex/fixture-standard-model", "openai-codex/fixture-standard-model", "openai-codex/fixture-strong-model"],
  "fixture-balanced": ["openai-codex/fixture-light-model", "openai-codex/fixture-standard-model", "openai-codex/fixture-standard-model"],
  "fixture-light": ["openai-codex/fixture-light-model", "openai-codex/fixture-light-model", "openai-codex/fixture-standard-model"],
  "fixture-reviewed": ["openai-codex/fixture-light-model", "xai/fixture-review-model", "openai-codex/fixture-standard-model"],
  "fixture-compatible": ["openai-codex/fixture-light-model", "deepseek/fixture-compatible-model", "openai-codex/fixture-standard-model"],
};
// New-only external definition helper; overrides are slot objects, never flat maps.
const body = (version, model, slots = {}) => {
  const defaults = { d1: { model: `${model}/light` }, d2: { model: `${model}/light` },
    d3: { model: `${model}/standard` }, d4: { model: `${model}/strong` }, d5: { model: `${model}/strong` } };
  return { version, slots: Object.fromEntries(Object.entries({ ...defaults, ...slots })
    .map(([slot, entry]) => [slot, { ...defaults[slot], ...entry }])) };
};
const config = presetConfig;
const defaultName = () => starterConfig().defaultPreset;
// Independent of routing's exported array: a reordered export must not move the expected ceiling.
const canonicalThinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const positiveThinking = canonicalThinking.slice(1);
function ceilingOracle(parent, rawSupported) {
  const supported = new Set();
  for (const level of rawSupported) if (canonicalThinking.includes(level)) supported.add(level);
  if (supported.has(parent)) return { thinking: parent, thinking_resolution: "identity" };
  if (parent === "off") return { error: "off_unsupported" };
  const enabled = positiveThinking.filter((level) => supported.has(level));
  if (enabled.length === 0) return { error: "no_supported_thinking_level" };
  const parentIndex = canonicalThinking.indexOf(parent);
  const higher = enabled.find((level) => canonicalThinking.indexOf(level) > parentIndex);
  return { thinking: higher ?? enabled[enabled.length - 1], thinking_resolution: "automatic_mapping" };
}
const policyDigest = (selection) => createHash("sha256").update(JSON.stringify({
  ...selection, difficultySlots: ["d1", "d2", "d3", "d4", "d5"], inheritedThinkingPolicy,
})).digest("hex");

test("exported routing slots are one-to-one with difficulty and the ceiling policy is tagged", () => {
  assert.deepEqual(strengths, ["d1", "d2", "d3", "d4", "d5"]);
  assert.equal(inheritedThinkingPolicy, "ceiling-v1");
  assert.deepEqual(thinkingLevels, canonicalThinking);
});

test("difficulty validator admits only integer ratings 1 through 5", () => {
  for (const rating of [1, 2, 3, 4, 5]) assert.equal(validDifficulty(rating), true);
  for (const rating of [undefined, null, "3", 0, 6, 1.5, NaN, Infinity, {}, []])
    assert.equal(validDifficulty(rating), false);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "harness-presets.json");
  await writePresetConfig(path);
  return path;
}

for (const scenario of [
  { name: "missing file", missing: true, code: "INVALID_PRESET_CONFIG" },
  { name: "legacy version 1", content: JSON.stringify({ version: 1, presets: {} }), code: "INVALID_PRESET_CONFIG", error: /version/ },
  { name: "legacy version 2", content: JSON.stringify({ version: 2, defaultPreset: "off", presets: {} }), code: "INVALID_PRESET_CONFIG", error: /version/ },
  { name: "missing defaultPreset", content: JSON.stringify({ version: 3, presets: {} }), code: "INVALID_PRESET_CONFIG", error: /defaultPreset/ },
  { name: "unknown defaultPreset", content: JSON.stringify(config({}, { defaultPreset: "absent" })), code: "INVALID_PRESET_CONFIG", error: /defaultPreset/ },
  { name: "malformed JSON", content: "{broken", code: "INVALID_PRESET_CONFIG", error: /Could not parse/ },
  { name: "invalid schema", content: JSON.stringify(config({}, { typo: true })), code: "INVALID_PRESET_CONFIG", error: /unsupported field: typo/ },
  { name: "removed saved preset", content: JSON.stringify(config({})), saved: "retired-team", code: "PRESET_NOT_FOUND" },
  { name: "legacy saved custom definitions", content: JSON.stringify(config({})), savedData: { name: "old", custom_presets: {
    old: { version: "old", models: { light: "p/m", standard: "p/m", strong: "p/m" } },
  } }, code: "INVALID_SAVED_PRESETS" },
  { name: "legacy saved effort overrides", content: JSON.stringify(config({})),
    savedData: { name: "fixture-strong", effort_overrides: { light: "high" } }, code: "INVALID_SAVED_EFFORT" },
  { name: "saved effort missing preset name", content: JSON.stringify(config({})),
    savedData: { effort_overrides: {} }, code: "INVALID_SAVED_EFFORT" },
  { name: "saved Off effort", content: JSON.stringify(config({})),
    savedData: { name: "off", effort_overrides: {} }, code: "INVALID_SAVED_EFFORT" },
  { name: "nonlegacy invalid saved effort", content: JSON.stringify(config({})),
    savedData: { name: "fixture-strong", effort_overrides: { d3: "private-rejected-effort" } }, code: "INVALID_SAVED_EFFORT" },
  { name: "nonlegacy malformed saved definition", content: JSON.stringify(config({})),
    savedData: { name: "fixture-strong", custom_presets: { "private-rejected-definition": {
      ...body("v1", "fixture"), version: 0,
    } } }, code: "INVALID_SAVED_PRESETS" },
  { name: "later host initialization failure", content: JSON.stringify(config({})), saved: "fixture-strong", throws: /Use the pi-alehouse launcher/ },
]) test(`preset startup: ${scenario.name} cannot publish a selection or report command success`, async (t) => {
  const path = await fixture(t);
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_HARNESS_PERMISSION_ROOT"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.PI_CODING_AGENT_DIR = dirname(path);
  delete process.env.PI_HARNESS_PERMISSION_ROOT; // Never reach real host authority in this fixture.
  if (scenario.missing) await rm(path);
  else await writeFile(path, scenario.content);
  const handlers = new Map(), commands = new Map(), notices = [], statuses = [], entries = [], tools = [];
  harnessExtension({ on(name, fn) {
    // This startup-failure fixture expects one handler per event. Fail loudly
    // if that changes rather than silently discarding an earlier handler.
    assert(!handlers.has(name), `Duplicate fixture handler: ${name}`);
    handlers.set(name, fn);
    return () => { if (handlers.get(name) === fn) handlers.delete(name); };
  }, registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {}, getAllTools: () => [], registerTool: (tool) => tools.push(tool),
    appendEntry: (...entry) => entries.push(entry) });
  const ctx = { hasUI: true, cwd: dirname(path), isProjectTrusted: () => true, sessionManager: { getSessionId: () => "startup-fixture",
    getBranch: () => scenario.savedData || scenario.saved ? [{ type: "custom", customType: "harness:preset-selection:v1",
      data: scenario.savedData ?? { name: scenario.saved } }] : [] },
    ui: { notify: (message, level) => notices.push({ message, level }), setStatus: (...args) => statuses.push(args) } };
  const start = () => handlers.get("session_start")({}, ctx);
  if (scenario.throws) await assert.rejects(start, scenario.throws);
  else {
    await assert.doesNotReject(start);
    assert.equal(notices.length, 1); assert.equal(notices[0].level, "error");
    const failure = JSON.parse(notices[0].message);
    assert.equal(failure.code, scenario.code);
    assert.match(failure.resolution, /restart Pi/);
    if (scenario.error) assert.match(failure.error, scenario.error);
    if (scenario.saved) assert.equal(failure.requested, scenario.saved);
    if (scenario.savedData) {
      assert.equal(failure.config_path, undefined, "a branch-record error must not point at the base catalogue");
      assert.equal(failure.record, "harness:preset-selection:v1");
      assert.match(failure.resolution, /branch record failed worker configuration validation/);
      assert.match(failure.resolution, /valid preset versions.*d1, d2, d3, d4, d5.*version-2 settings rules/);
      assert.match(failure.resolution, /fresh session or fork from before the invalid harness:preset-selection:v1 record and restart Pi/);
      assert.match(failure.resolution, /Do not rewrite historical journal records/);
      assert.doesNotMatch(failure.resolution, /Fix the preset configuration|legacy|light\/standard\/strong/);
      assert.doesNotMatch(JSON.stringify(failure), /private-rejected-effort|private-rejected-definition/);
      assert.equal(readFileSync(path, "utf8"), scenario.content);
    } else assert.equal(failure.config_path, path);
  }
  assert.equal(handlers.get("before_agent_start")?.({ systemPrompt: "base" }), undefined);
  assert.equal(handlers.get("tool_call")({ toolName: "read" }).block, true);
  // Repairing disk alone does not initialize the harness or authorize commands.
  await writeFile(path, JSON.stringify(config({})));
  for (const args of ["fixture-strong", "reload", ""]) {
    await commands.get("harness-preset").handler(args, ctx);
    const failure = JSON.parse(notices.at(-1).message);
    assert.equal(failure.code, "HARNESS_NOT_READY"); assert.match(failure.resolution, /startup error.*restart Pi/);
  }
  assert.deepEqual(entries, []); assert.deepEqual(statuses, []); assert.deepEqual(tools, []);
});

test("fixed mock-registry presets retain exact model, effort, and version configuration", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path);
  assert.equal(router.activePresetName(), defaultName());
  const expectedEffort = {
    "fixture-strong": ["high", "high", "xhigh", "high", "high"],
    "fixture-balanced": ["xhigh", "xhigh", "high", "xhigh", "xhigh"],
    "fixture-light": ["xhigh", "xhigh", "max", "high", "high"],
    "fixture-reviewed": ["xhigh", "xhigh", "high", "xhigh", "xhigh"],
    "fixture-compatible": ["xhigh", "xhigh", "max", "xhigh", "xhigh"],
  };
  for (const [name, ids] of Object.entries(builtins)) {
    const snapshot = router.select(name);
    assert.deepEqual(strengths.map((slot) => snapshot.models[slot]), [ids[0], ids[0], ids[1], ids[2], ids[2]]);
    assert.equal(Object.hasOwn(snapshot, "thinking"), false, "normalized snapshots drop the thinking table");
    assert.equal(snapshot.version, name === "fixture-reviewed" ? "fixture-v2" : "fixture-v1");
    assert.deepEqual(strengths.map((slot) => snapshot.effort[slot]), expectedEffort[name]);
    assert.deepEqual(snapshot.effort, snapshot.effort_defaults);
    assert.deepEqual(snapshot.effort_overrides, {});
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
    const { digest: _digest, ...selection } = snapshot;
    assert.equal(Object.hasOwn(selection, "thinking"), false);
    const legacyDigest = createHash("sha256").update(JSON.stringify(selection)).digest("hex");
    const slotsOnly = createHash("sha256").update(JSON.stringify({ ...selection,
      difficultySlots: ["d1", "d2", "d3", "d4", "d5"] })).digest("hex");
    const reversedTags = createHash("sha256").update(JSON.stringify({ ...selection,
      inheritedThinkingPolicy, difficultySlots: ["d1", "d2", "d3", "d4", "d5"] })).digest("hex");
    const reversedSlots = createHash("sha256").update(JSON.stringify({ ...selection,
      difficultySlots: ["d5", "d4", "d3", "d2", "d1"], inheritedThinkingPolicy })).digest("hex");
    const otherPolicy = createHash("sha256").update(JSON.stringify({ ...selection,
      difficultySlots: ["d1", "d2", "d3", "d4", "d5"], inheritedThinkingPolicy: "other-policy" })).digest("hex");
    assert.notEqual(snapshot.digest, legacyDigest, "rating-to-slot mapping must be part of preset identity");
    assert.notEqual(snapshot.digest, slotsOnly, "the ceiling policy tag is part of preset identity");
    assert.notEqual(snapshot.digest, reversedTags, "policy tag follows the canonical slot list");
    assert.notEqual(snapshot.digest, reversedSlots, "hashed slot order is canonical, not display order");
    assert.notEqual(snapshot.digest, otherPolicy);
    assert.equal(snapshot.digest, policyDigest(selection));
    assert.equal(presetLabel(snapshot), `${name}@${snapshot.version}`);
  }
});

test("real managed config is the complete valid catalogue and startup default", () => {
  const path = fileURLToPath(new URL("../../../resources/harness-presets.json", import.meta.url));
  const source = JSON.parse(readFileSync(path, "utf8"));
  const router = new PresetRouter(path);
  const names = Object.keys(source.presets).sort();
  assert.deepEqual(router.names(), ["off", ...names], "no implicit model presets survive outside the file");
  assert.equal(router.current().name, source.defaultPreset);
  assert.equal(source.defaultPreset, "off", "portable catalogue must not silently select a provider");
  const snapshots = new Map(router.inspect(router.prepare()).map((preset) => [preset.name, preset]));
  for (const [name, body] of Object.entries(source.presets)) {
    const snapshot = snapshots.get(name);
    assert(snapshot && !isOffPreset(snapshot), `configured preset ${name} must exist`);
    assert.equal(snapshot.version, body.version);
    assert.equal(presetLabel(snapshot), `${name}@${body.version}`);
    assert.deepEqual(snapshot.models, Object.fromEntries(strengths.map((slot) => [slot, body.slots[slot].model])));
    assert.equal(Object.hasOwn(snapshot, "thinking"), false);
    assert.equal(Object.hasOwn(body.slots.d1, "thinking"), false, "managed catalogue slots are model and effort only");
    const effort = Object.fromEntries(strengths.map((slot) => [slot, body.slots[slot].effort ?? "inherit"]));
    assert.deepEqual(snapshot.effort_defaults, effort);
    assert.deepEqual(snapshot.effort, effort);
    assert.deepEqual(snapshot.effort_overrides, {});
  }
});

test("configured default may be a named preset or off; saved branch selection wins", async (t) => {
  const path = await fixture(t);
  for (const defaultPreset of ["team", "off"]) {
    await writePresetConfig(path, { version: 3, defaultPreset, presets: { team: body("v1", "fixture"), other: body("v1", "other") } });
    const router = new PresetRouter(path);
    assert.equal(router.current().name, defaultPreset);
    assert.equal(restorePresetRouter(path, []).current().name, defaultPreset);
    assert.equal(restorePresetRouter(path, [{ name: "other" }]).current().name, "other");
    assert.equal(restorePresetRouter(path, [{ name: "other" }, { name: "off" }]).current().name, "off");
  }
});

test("reload keeps the active selection when the file's default changes", async (t) => {
  const path = await fixture(t);
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: body("v1", "fixture"), other: body("v1", "other") } });
  const router = new PresetRouter(path);
  router.select("other");
  await writePresetConfig(path, { version: 3, defaultPreset: "off", presets: { team: body("v2", "fixture"), other: body("v2", "other") } });
  const candidate = router.prepare();
  assert.equal(candidate.activeName, "other");
  assert.equal(router.commit(candidate, candidate.activeName).version, "v2");
  assert.equal(router.current().name, "other");
  assert.equal(new PresetRouter(path).current().name, "off");
});

test("a minimal file has no ghost mock-registry presets and old names have no special protection", async (t) => {
  const path = await fixture(t);
  await writePresetConfig(path, { version: 3, defaultPreset: "off", presets: {} });
  const router = new PresetRouter(path);
  assert.deepEqual(router.names(), ["off"]);
  assert.throws(() => router.select("fixture-strong"), { code: "PRESET_NOT_FOUND" });
  await writePresetConfig(path, { version: 3, defaultPreset: "fixture-strong", presets: { "fixture-strong": body("v9", "fixture") } });
  assert.equal(router.commit(router.prepare(), "fixture-strong").version, "v9");
  await writePresetConfig(path, { version: 3, defaultPreset: "off", presets: {} });
  router.commit(router.prepare(), "off");
  assert.deepEqual(router.names(), ["off"]);
});

test("off is an immutable reserved selection, ordered first, and select restores admission", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const expected = { name: "off", version: "off-v1",
    digest: createHash("sha256").update(JSON.stringify({ name: "off", version: "off-v1" })).digest("hex") };
  const candidate = router.prepare(), inspected = router.inspect(candidate);
  assert.deepEqual(candidate.names, router.names());
  assert.deepEqual(candidate.names, ["off", ...candidate.names.slice(1).sort()]);
  assert.equal(candidate.names[0], "off");
  assert.deepEqual(inspected[0], expected);
  assert.equal(isOffPreset(inspected[0]), true);
  assert.equal(Object.isFrozen(inspected[0]), true);
  assert.equal(Object.hasOwn(inspected[0], "models"), false);
  assert.equal(Object.hasOwn(inspected[0], "thinking"), false);
  assert.throws(() => { inspected[0].name = "changed"; }, TypeError);
  assert.equal(presetLabel(inspected[0]), "off");

  const off = router.select("off");
  assert.equal(isOffPreset(off), true);
  assert.equal(Object.isFrozen(off), true);
  assert.deepEqual(router.admissionState(), { enabled: false, revision: 1 });
  const restored = router.select(defaultName());
  assert.equal(isOffPreset(restored), false);
  assert.equal(restored.name, defaultName());
  assert.deepEqual(router.admissionState(), { enabled: true, revision: 1 });
});

test("off selection advances its disable revision only after successful real-to-off publication", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const original = router.current();
  assert.deepEqual(router.admissionState(), { enabled: true, revision: 0 });
  assert.throws(() => router.apply(router.prepare(), "off", () => { throw new Error("AUDIT_FAILED"); }), /AUDIT_FAILED/);
  assert.deepEqual(router.current(), original);
  assert.deepEqual(router.admissionState(), { enabled: true, revision: 0 });

  const stale = router.prepare();
  router.select("fixture-strong");
  assert.throws(() => router.apply(stale, "off", () => assert.fail("stale selection must not audit")),
    { code: "STALE_PRESET_SELECTION" });
  assert.deepEqual(router.admissionState(), { enabled: true, revision: 0 });

  let audited;
  const selected = router.apply(router.prepare(), "off", (snapshot) => { audited = snapshot; });
  assert.equal(isOffPreset(audited), true);
  assert.equal(isOffPreset(selected), true);
  assert.deepEqual(router.admissionState(), { enabled: false, revision: 1 });
  router.commit(router.prepare(), "off");
  assert.deepEqual(router.admissionState(), { enabled: false, revision: 1 }, "off-to-off reload does not disable again");
  router.select("fixture-light"); router.select("fixture-strong");
  assert.deepEqual(router.admissionState(), { enabled: true, revision: 1 }, "real preset switches remain admissible");
  router.select("off");
  assert.deepEqual(router.admissionState(), { enabled: false, revision: 2 });
});

test("invalid difficulty rejects before model and thinking resolution", async (t) => {
  const preset = new PresetRouter(await fixture(t)).current();
  for (const difficulty of [0, 6, 2.5, NaN, "3", undefined]) {
    let touched = false;
    assert.throws(() => resolveRoute({ preset, difficulty, parentThinking: "off",
      models: { filter() { touched = true; return []; } }, supportedThinking() { touched = true; return []; } }),
    (error) => error.code === "INVALID_DIFFICULTY" && error.details.key === "difficulty" &&
      error.details.resolution === "Use an integer from 1 to 5 for reasoning_difficulty." &&
      error.details.allowed === undefined);
    assert.equal(touched, false);
  }
});

test("off resolve rejects before model, difficulty, or thinking resolution", async (t) => {
  const router = new PresetRouter(await fixture(t)), off = router.select("off");
  let touched = false;
  assert.throws(() => resolveRoute({ preset: off, difficulty: 0, parentThinking: undefined,
    models: { filter() { touched = true; return []; } }, supportedThinking() { touched = true; return []; } }),
  { code: "WORKERS_DISABLED" });
  assert.equal(touched, false);
});

test("each difficulty has an independent model, fixed effort, automatic ceiling and digest contribution", async (t) => {
  const path = await fixture(t), slots = ["d1", "d2", "d3", "d4", "d5"];
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const definition = { version: "v1", slots: Object.fromEntries(slots.map((slot, index) => [slot,
    { model: `fixture/${slot}`, effort: levels[index] }])) };
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: definition } });
  const router = new PresetRouter(path), baseline = router.current();
  const models = slots.map((slot, index) => ({ provider: "fixture", id: slot, levels: [levels[index]] }));
  const input = { models, supportedThinking: (model) => model.levels, parentThinking: "minimal" };
  for (const [index, slot] of slots.entries()) {
    const fixed = resolveRoute({ ...input, preset: baseline, difficulty: index + 1 });
    assert.equal(fixed.strength, slot); assert.equal(fixed.model, slot);
    assert.equal(fixed.thinking, levels[index]); assert.equal(fixed.thinking_resolution, "preset_fixed");
    const inherited = router.apply(router.prepare(), "team", () => {}, { [slot]: "inherit" });
    assert.deepEqual(inherited.effort_overrides, { [slot]: "inherit" });
    for (const other of slots.filter((value) => value !== slot)) assert.equal(inherited.effort[other], baseline.effort[other]);
    const mapped = resolveRoute({ ...input, preset: inherited, difficulty: index + 1 });
    const expected = ceilingOracle("minimal", [levels[index]]);
    assert.equal(mapped.model, slot); assert.equal(mapped.thinking, expected.thinking);
    assert.equal(mapped.thinking, levels[index]);
    assert.equal(mapped.thinking_resolution, "automatic_mapping"); assert.equal(mapped.effort_source, "user_override");
    assert.notEqual(inherited.digest, baseline.digest);
    router.apply(router.prepare(), "team", () => {}, {});
    for (const [field, value] of [["model", "fixture/changed"], ["effort", "off"]]) {
      const changed = { ...definition, slots: { ...definition.slots, [slot]: { ...definition.slots[slot], [field]: value } } };
      await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: changed } });
      assert.notEqual(router.inspect(router.prepare()).find((preset) => preset.name === "team").digest, baseline.digest,
        `${field}.${slot} must contribute to selection identity`);
    }
    const rejected = { ...definition, slots: { ...definition.slots, [slot]: { ...definition.slots[slot], thinking: { minimal: "off" } } } };
    await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: rejected } });
    assert.throws(() => router.prepare(), (error) => error.code === "INVALID_PRESET_CONFIG" && /thinking/.test(error.details.error),
      `${slot}.thinking is rejected rather than hashed`);
    assert.deepEqual(router.current(), baseline);
    await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: definition } });
  }
});

test("slot-object defaults normalize independently and keep internal flat projections", async (t) => {
  const path = await fixture(t), definition = body("v1", "fixture", {
    d1: { effort: "off" }, d4: { effort: "inherit" }, d5: { effort: "high" },
  });
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: definition } });
  const router = new PresetRouter(path), selected = router.current();
  assert.deepEqual(selected.effort_defaults, { d1: "off", d2: "inherit", d3: "inherit", d4: "inherit", d5: "high" });
  assert.deepEqual(selected.effort, selected.effort_defaults);
  assert.equal(Object.hasOwn(selected, "thinking"), false);
  assert.deepEqual(selected.models, { d1: "fixture/light", d2: "fixture/light", d3: "fixture/standard", d4: "fixture/strong", d5: "fixture/strong" });
  assert.equal(Object.hasOwn(selected, "slots"), false, "runtime projectors retain normalized flat snapshots");
  const explicit = structuredClone(definition);
  for (const slot of ["d2", "d3"]) explicit.slots[slot].effort = "inherit";
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: explicit } });
  assert.equal(router.inspect(router.prepare()).find((preset) => preset.name === "team").digest, selected.digest);
  for (const slot of strengths) {
    const withThinking = structuredClone(definition);
    withThinking.slots[slot].thinking = {};
    await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: withThinking } });
    assert.throws(() => router.prepare(), (error) => error.code === "INVALID_PRESET_CONFIG" && /unsupported field: thinking/.test(error.details.error));
    assert.deepEqual(router.current(), selected);
  }
});

test("slot order and nested property order leave the policy-tagged digest unchanged", async (t) => {
  const path = await fixture(t), slots = ["d1", "d2", "d3", "d4", "d5"];
  const efforts = { d1: "off", d2: "low", d3: "inherit", d4: "high", d5: "max" };
  const definition = { version: "v1", slots: Object.fromEntries(slots.map((slot) => [slot,
    { model: `fixture/${slot}`, effort: efforts[slot] }])) };
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: definition } });
  const router = new PresetRouter(path), baseline = router.current();
  const { digest: _digest, ...selection } = baseline;
  assert.equal(baseline.digest, policyDigest(selection));
  assert.equal(Object.hasOwn(selection, "thinking"), false);
  const permutations = (values) => values.length === 0 ? [[]] : values.flatMap((value) =>
    permutations(values.filter((other) => other !== value)).map((rest) => [value, ...rest]));
  for (const order of permutations(slots)) {
    const reordered = { slots: Object.fromEntries(order.map((slot) => [slot,
      { effort: efforts[slot], model: definition.slots[slot].model }])), version: "v1" };
    await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: reordered } });
    assert.deepEqual(router.inspect(router.prepare()).find((preset) => preset.name === "team"), baseline);
  }
});

test("prepared and returned definitions detach every slot from live routing and reject thinking", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path), definition = { version: "v1", slots: Object.fromEntries(strengths.map((slot) => [slot,
    { model: `fixture/${slot}`, effort: "inherit" }])) };
  const expected = structuredClone(definition);
  assert.throws(() => router.prepare({ bad: { version: "v1", slots: { ...definition.slots,
    d1: { model: "fixture/d1", thinking: { low: "high" } } } } }), /thinking is not configurable/);
  const candidate = router.prepare({ team: definition });
  const baseline = router.inspect(candidate).find((preset) => preset.name === "team");
  assert.equal(Object.hasOwn(baseline, "thinking"), false);
  for (const slot of strengths) {
    definition.slots[slot].model = "mutated/model";
    definition.slots[slot].effort = "off";
  }
  assert.deepEqual(router.inspect(candidate).find((preset) => preset.name === "team"), baseline);
  assert.deepEqual(router.commit(candidate, "team"), baseline);
  const detached = router.definition("team"), custom = router.customPresets();
  assert.deepEqual(detached, expected); assert.deepEqual(custom.team, expected);
  for (const slot of strengths) assert.equal(Object.hasOwn(detached.slots[slot], "thinking"), false);
  for (const slot of strengths) {
    detached.slots[slot].model = "detached/model";
    detached.slots[slot].effort = "off";
    custom.team.slots[slot].effort = "medium";
  }
  assert.deepEqual(router.definition("team"), expected);
  assert.deepEqual(router.customPresets().team, expected);
  assert.deepEqual(router.current(), baseline);
  const rejected = structuredClone(expected);
  rejected.slots.d3.thinking = { low: "high" };
  await writePresetConfig(path, { version: 3, defaultPreset: "team", presets: { team: rejected } });
  assert.throws(() => router.prepare(), (error) => error.code === "INVALID_PRESET_CONFIG" && /unsupported field: thinking/.test(error.details.error));
  assert.deepEqual(router.current(), baseline);
});

test("scoped preferences require version 2 and explicit independent difficulty slots", () => {
  const definition = body("v1", "fixture");
  const valid = { version: 2, preset: "team", presets: { team: definition },
    effort: { team: { d1: "off", d2: "low", d3: null, d4: "high", d5: "max" } } };
  assert.deepEqual(validateSettings(valid), valid);
  const legacyModels = { light: "fixture/light", standard: "fixture/standard", strong: "fixture/strong" };
  for (const invalid of [
    { ...valid, version: 1 }, { ...valid, version: 3 },
    { ...valid, presets: { team: { version: "v1", models: legacyModels } } },
    { ...valid, presets: { team: { ...definition, models: legacyModels } } },
    ...strengths.map((missing) => ({ ...valid, presets: { team: { ...definition,
      slots: Object.fromEntries(Object.entries(definition.slots).filter(([slot]) => slot !== missing)) } } })),
    ...["light", "standard", "strong"].flatMap((slot) => [
      { ...valid, effort: { team: { [slot]: "high" } } },
      { ...valid, presets: { team: { ...definition, slots: { ...definition.slots, [slot]: { model: "fixture/legacy", effort: "high" } } } } },
      { ...valid, presets: { team: { ...definition, slots: { ...definition.slots, [slot]: { model: "fixture/legacy", thinking: { low: "high" } } } } } },
    ]),
    { ...valid, presets: { team: { ...definition, slots: { ...definition.slots, d3: { model: "fixture/standard", thinking: { low: "high" } } } } } },
    { ...valid, presets: { team: { ...definition, slots: { ...definition.slots, d1: { model: "fixture/light", thinking: {} } } } } },
  ]) assert.throws(() => validateSettings(invalid), /version|slot|unsupported|missing|thinking/i);
});

test("legacy versions and old or incomplete slot maps reject without changing live state", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path), original = router.current();
  const definition = body("v1", "fixture"), legacy = { light: "fixture/light", standard: "fixture/standard", strong: "fixture/strong" };
  const flat = { version: "v1", models: Object.fromEntries(strengths.map((slot) => [slot, `fixture/${slot}`])),
    effort: { d1: "off" }, thinking: { d3: { low: "high" } } };
  const invalid = [
    config({ team: flat }),
    config({ team: { ...definition, ...flat } }),
    ...["models", "effort", "thinking"].map((field) => config({ team: { ...definition, [field]: flat[field] } })),
    ...strengths.flatMap((slot) => [
      config({ team: { ...definition, slots: { ...definition.slots, [slot]: "fixture/old-scalar" } } }),
      config({ team: { ...definition, slots: { ...definition.slots, [slot]: { effort: "high" } } } }),
      config({ team: { ...definition, slots: { ...definition.slots, [slot]: { model: "fixture/model", thinking: null } } } }),
    ]),
    ...[1, 2].map((version) => ({ version, defaultPreset: "team", presets: { team: definition } })),
    config({ team: { version: "v1", models: legacy } }),
    config({ team: { ...definition, models: legacy } }),
    config({ team: { ...definition, slots: { ...definition.slots, light: { model: "fixture/light" } } } }),
    config({ team: { ...definition, effort: { standard: "high" } } }),
    config({ team: { ...definition, thinking: { strong: { low: "high" } } } }),
    ...strengths.map((missing) => config({ team: { ...definition,
      slots: Object.fromEntries(Object.entries(definition.slots).filter(([slot]) => slot !== missing)) } })),
  ];
  for (const value of invalid) {
    await writeFile(path, JSON.stringify(value));
    assert.throws(() => router.prepare(), { code: "INVALID_PRESET_CONFIG" });
    assert.deepEqual(router.current(), original);
  }
});

test("mock-registry slots enforce fixed default effort; explicit inherit uses the automatic ceiling", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const catalogue = [
    { provider: "openai-codex", id: "fixture-light-model", levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { provider: "openai-codex", id: "fixture-standard-model", levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { provider: "openai-codex", id: "fixture-strong-model", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    { provider: "xai", id: "fixture-review-model", levels: ["low", "medium", "high", "xhigh"] },
    { provider: "deepseek", id: "fixture-compatible-model", levels: ["off", "high", "max"] },
  ];
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const [name] of Object.entries(builtins)) {
    router.select(name);
    for (const [difficulty, strength] of [[1, "d1"], [2, "d2"], [3, "d3"], [4, "d4"], [5, "d5"]]) {
      const fixed = router.apply(router.prepare(), name, () => {}, {}), exact = fixed.models[strength];
      const model = catalogue.find((entry) => `${entry.provider}/${entry.id}` === exact);
      assert(model, `${name}/${strength}`);
      const defaultRoute = resolveRoute({ preset: fixed, difficulty, parentThinking: undefined,
        models: catalogue, supportedThinking: (chosen) => chosen.levels });
      assert.equal(defaultRoute.thinking, fixed.effort[strength]);
      assert.equal(defaultRoute.parent_thinking, undefined);
      assert.equal(defaultRoute.thinking_resolution, "preset_fixed");
      assert.equal(defaultRoute.effort_source, "preset");
      const preset = router.apply(router.prepare(), name, () => {}, { [strength]: "inherit" });
      assert.equal(Object.hasOwn(preset, "thinking"), false);
      for (const parentThinking of levels) {
        const expected = ceilingOracle(parentThinking, model.levels);
        if (expected.error) {
          assert.throws(() => resolveRoute({ preset, difficulty, parentThinking, models: catalogue,
            supportedThinking: (selected) => selected.levels }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
              error.details.reason === expected.error && error.details.parent_thinking === parentThinking &&
              !Object.hasOwn(error.details, "thinking") &&
              /change the parent Pi thinking level or worker preset/.test(error.details.resolution) &&
              /Do not change reasoning_difficulty to bypass configuration errors/.test(error.details.resolution) &&
              error.details.difficulty === difficulty &&
              !JSON.stringify(error.details).includes(exact));
          continue;
        }
        const selected = resolveRoute({ preset, difficulty, parentThinking, models: catalogue,
          supportedThinking: (chosen) => chosen.levels });
        assert.equal(selected.difficulty, difficulty); assert.equal(selected.strength, strength);
        assert.equal(selected.thinking, expected.thinking);
        assert.equal(selected.parent_thinking, parentThinking);
        assert.equal(selected.thinking_resolution, expected.thinking_resolution);
        assert.equal(selected.effort_source, "user_override");
        assert.equal(`${selected.provider}/${selected.model}`, exact);
      }
    }
  }
  const reviewed = router.select("fixture-reviewed");
  const olderReviewModel = { provider: "xai", id: "fixture-review-model-previous", levels: ["low", "medium", "high", "xhigh"] };
  assert.throws(() => resolveRoute({ preset: reviewed, difficulty: 3, parentThinking: "high",
    models: [...catalogue.filter((entry) => entry.id !== "fixture-review-model"), olderReviewModel], supportedThinking: (selected) => selected.levels }),
  { code: "PRESET_MODEL_UNAVAILABLE" }, "a missing exact model must not silently fall back to its previous version");
});

test("slot thinking is rejected and an injected table cannot change the automatic ceiling", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ plain: body("v1", "fixture"),
    mapped: body("v1", "fixture", { d3: { thinking: { low: "high" } } }) })));
  assert.throws(() => new PresetRouter(path), (error) => error.code === "INVALID_PRESET_CONFIG" && /thinking/.test(error.details.error));
  await writeFile(path, JSON.stringify(config({ plain: body("v1", "fixture") })));
  const plain = new PresetRouter(path).select("plain");
  const stale = { ...plain, thinking: { d3: { low: "off", off: "high", max: "minimal" } } };
  const model = { provider: "fixture", id: "standard" };
  const identity = resolveRoute({ preset: stale, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["low", "high"] });
  assert.equal(identity.thinking, "low"); assert.equal(identity.thinking_resolution, "identity");
  assert.equal(identity.effort_source, "preset");
  const capped = resolveRoute({ preset: stale, difficulty: 3, parentThinking: "max", models: [model],
    supportedThinking: () => ["low", "high"] });
  assert.equal(capped.thinking, "high", "no higher positive uses the highest enabled level, not the injected map");
  assert.equal(capped.thinking_resolution, "automatic_mapping");
  assert.throws(() => resolveRoute({ preset: stale, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["off"] }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
      error.details.reason === "no_supported_thinking_level" && !Object.hasOwn(error.details, "thinking") &&
      /change the parent Pi thinking level or worker preset/.test(error.details.resolution) &&
      /Do not change reasoning_difficulty to bypass configuration errors/.test(error.details.resolution));
  assert.throws(() => resolveRoute({ preset: stale, difficulty: 3, parentThinking: "off", models: [model],
    supportedThinking: () => ["high"] }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
      error.details.reason === "off_unsupported" && !Object.hasOwn(error.details, "thinking") &&
      /Do not change reasoning_difficulty to bypass configuration errors\.$/.test(error.details.resolution));
});

test("off-only inheritance recommends fixed off only when metadata supports it", { timeout: 5000 }, async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ plain: body("v1", "fixture") })));
  const preset = new PresetRouter(path).select("plain"), before = structuredClone(preset);
  const model = { provider: "fixture", id: "standard", reasoning: false };
  const sdkLevels = getSupportedThinkingLevels(model);
  assert.deepEqual(sdkLevels, ["off"], "the SDK exposes off-only support for a non-reasoning model");
  for (const levels of [sdkLevels, ["future", "off", "off"], [], ["future"]]) {
    const supportsOff = levels.includes("off");
    const input = { preset, difficulty: 3, models: [model], supportedThinking: () => levels };
    for (const parentThinking of positiveThinking) {
      assert.throws(() => resolveRoute({ ...input, parentThinking }), (error) => {
        assert.equal(error.code, "THINKING_INCOMPATIBLE");
        assert.equal(error.details.reason, "no_supported_thinking_level");
        assert.equal(error.details.resolution.includes('fixed effort to "off"'), supportsOff);
        assert.match(error.details.resolution, /Ask the user/);
        assert.match(error.details.resolution, /Do not change reasoning_difficulty to bypass configuration errors\.$/);
        assert(error.details.resolution.length <= 512, "model-facing guidance must not lose its ending to reply truncation");
        assert.equal(Object.hasOwn(error.details, "thinking"), false);
        return true;
      });
    }
    const fixed = { ...input, parentThinking: "high", preset: { ...preset, effort: { ...preset.effort, d3: "off" } } };
    if (supportsOff) {
      const route = resolveRoute(fixed);
      assert.equal(route.thinking, "off"); assert.equal(route.thinking_resolution, "preset_fixed");
      assert.equal(route.parent_thinking, "high", "the remedy is explicit effort, not a parent mutation");
      assert.equal(resolveRoute({ ...input, parentThinking: "off" }).thinking_resolution, "identity");
    } else {
      assert.throws(() => resolveRoute(fixed), (error) => error.code === "THINKING_INCOMPATIBLE" &&
        error.details.reason === "fixed_effort_unsupported");
      assert.throws(() => resolveRoute({ ...input, parentThinking: "off" }), (error) => {
        assert.equal(error.details.reason, "off_unsupported");
        assert.doesNotMatch(error.details.resolution, /fixed effort/);
        return true;
      });
    }
  }
  assert.deepEqual(preset, before, "error guidance must not apply an effort override");
});

test("audited application validates before side effects and never publishes after a throwing SDK append", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture") })));
  for (const stage of ["before-write", "after-append"]) {
    const router = new PresetRouter(path), original = router.current(), audit = [], latched = [];
    const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: (error) => latched.push(error) };
    assert.throws(() => applyAuditedPreset({ controller, router, candidate: router.prepare(), name: "team",
      audit: (snapshot) => {
        if (stage === "after-append") audit.push(snapshot);
        throw new Error(`AUDIT_${stage}`);
      },
    }), (error) => error.code === "PRESET_AUDIT_FAILED" && /ambiguous outcome/.test(error.details.resolution));
    assert.deepEqual(router.current(), original, `${stage} must preserve the old live router`);
    assert.equal(audit.length, stage === "after-append" ? 1 : 0, "fixture distinguishes pre-write from ambiguous append");
    assert.equal(latched.length, 1, "every attempted SDK append failure latches shared parent safety");
  }

  const router = new PresetRouter(path), controller = { assertOwnerAvailable() {}, latchParentHistoryFailure() { assert.fail("validation must not latch parent history"); } };
  let audits = 0;
  assert.throws(() => applyAuditedPreset({ controller, router, candidate: router.prepare(), name: "typo", audit: () => { audits++; } }),
    { code: "PRESET_NOT_FOUND" });
  const stale = router.prepare(); router.commit(router.prepare(), "team");
  assert.throws(() => applyAuditedPreset({ controller, router, candidate: stale, name: "team", audit: () => { audits++; } }),
    { code: "STALE_PRESET_SELECTION" });
  assert.equal(audits, 0, "rejected and stale candidates never audit");
});

test("audit reentrancy cannot bypass publication through select or nested apply", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture") })));
  const router = new PresetRouter(path), original = router.current();
  await writeFile(path, JSON.stringify(config({ other: body("v2", "other-fixture") })));
  const candidate = router.prepare(), latched = [];
  const controller = { assertOwnerAvailable() {}, latchParentHistoryFailure: (error) => latched.push(error) };
  assert.throws(() => applyAuditedPreset({ controller, router, candidate, name: "other", audit: () => {
    assert.throws(() => router.select("team"), { code: "PRESET_SELECTION_IN_PROGRESS" });
    assert.throws(() => router.apply(router.prepare(), "other", () => assert.fail("nested audit must not run")),
      { code: "PRESET_SELECTION_IN_PROGRESS" });
    throw new Error("OUTER_AUDIT_FAILURE");
  } }), { code: "PRESET_AUDIT_FAILED" });
  assert.deepEqual(router.current(), original);
  assert(router.names().includes("team")); assert.equal(router.names().includes("other"), false,
    "failed outer audit cannot publish its candidate catalogue");
  assert.equal(latched.length, 1);
  const recovered = router.apply(candidate, "other", () => {});
  assert.equal(recovered.name, "other", "the same candidate remains current, proving revision did not advance");
});

test("candidate refresh is atomic across typo, cancellation, removal, reload, and switch-away", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "deepseek-fixture"), other: body("v1", "grok-fixture") })));
  const router = new PresetRouter(path), accepted = router.select("team");

  // A disk read alone models a cancelled picker: neither catalogue nor active
  // snapshot changes, even though the selected preset was altered on disk.
  await writeFile(path, JSON.stringify(config({ team: body("v2", "changed-fixture"), other: body("v1", "grok-fixture") })));
  const cancelled = router.prepare();
  assert.equal(cancelled.activeName, "team"); assert.equal(router.current().version, "v1");
  assert.throws(() => router.commit(cancelled, "typo"), { code: "PRESET_NOT_FOUND" });
  assert.deepEqual(router.current(), accepted); assert(router.names().includes("team"));

  const reload = router.prepare(), reloaded = router.commit(reload, reload.activeName);
  assert.equal(reloaded.version, "v2"); assert.equal(reloaded.models.d3, "changed-fixture/standard");

  // Reload cannot remove its own active selection. A named switch may commit
  // the same candidate while moving away from that removed preset.
  await writeFile(path, JSON.stringify(config({ other: body("v3", "grok-fixture") })));
  const removed = router.prepare();
  assert.throws(() => router.commit(removed, removed.activeName), { code: "PRESET_NOT_FOUND" });
  assert.equal(router.current().version, "v2"); assert(router.names().includes("team"));
  const switched = router.commit(router.prepare(), "other");
  assert.equal(switched.name, "other"); assert.equal(switched.version, "v3");
  assert.equal(router.names().includes("team"), false);
});

test("candidate inspection is immutable and does not publish or select its disk catalogue", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path), original = router.current();
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture") })));
  const candidate = router.prepare(), inspected = router.inspect(candidate);
  const team = inspected.find((preset) => preset.name === "team");
  assert(team && !isOffPreset(team));
  assert.equal(team.models.d3, "fixture/standard");
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(team.models), true);
  assert.equal(Object.isFrozen(team.effort), true);
  assert.equal(Object.hasOwn(team, "thinking"), false);
  assert.throws(() => { team.models.d1 = "changed/model"; }, TypeError);
  assert.throws(() => { team.effort.d1 = "off"; }, TypeError);
  assert.deepEqual(router.current(), original, "inspection cannot select or reload");
  assert.equal(router.names().includes("team"), false, "prepared catalogue remains private until commit");
});

test("a stale async-picker candidate cannot overwrite a newer selection", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "deepseek-fixture"), other: body("v1", "grok-fixture") })));
  const router = new PresetRouter(path), picker = router.prepare();
  router.commit(router.prepare(), "other");
  assert.throws(() => router.commit(picker, "team"), { code: "STALE_PRESET_SELECTION" });
  assert.equal(router.current().name, "other");
});

test("trusted config adds cross-provider presets and accepted snapshots remain immutable", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "deepseek-fixture") })));
  const router = new PresetRouter(path), accepted = router.select("team");
  await writeFile(path, JSON.stringify(config({ team: body("v2", "missing") })));
  const candidate = router.prepare(), changed = router.commit(candidate, candidate.activeName);
  assert.equal(accepted.version, "v1"); assert.equal(accepted.models.d3, "deepseek-fixture/standard");
  assert.equal(changed.version, "v2"); assert.equal(changed.models.d3, "missing/standard");
  const model = { provider: "deepseek-fixture", id: "standard" };
  assert.equal(resolveRoute({ preset: accepted, difficulty: 3, parentThinking: "off", models: [model],
    supportedThinking: () => ["off"] }).model, "standard");
  assert.throws(() => resolveRoute({ preset: changed, difficulty: 3, parentThinking: "off", models: [model],
    supportedThinking: () => ["off"] }), { code: "PRESET_MODEL_UNAVAILABLE" });
});

test("unknown config fields and reserved names are rejected without changing live state", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path), original = router.current();
  const invalid = [
    config({}, { fallback: "fixture-light" }),
    config({}, { credentials: { token: "not accepted" } }),
    config({ team: { ...body("v1", "fixture"), fallback: "fixture-light" } }),
    config({ team: { ...body("v1", "fixture"), credentials: "env" } }),
    config({ team: body("v1", "fixture", { d3: { thinking: { low: "high" } } }) }),
    config({ team: body("v1", "fixture", { d3: { thinking: {} } }) }),
    config({ team: body("v1", "fixture", { d3: { thinking: { tiny: "high" } } }) }),
    config({ team: body("v1", "fixture", { d3: { thinking: { low: "tiny" } } }) }),
    config({ team: body("v1", "fixture", { d3: { thinking: { off: "high" } } }) }),
    config({ team: body("v1", "fixture", { d3: { thinking: { low: "high", extra: "max" } } }) }),
    config({ team: body("v1", "fixture", { extreme: { model: "fixture/invalid", thinking: { low: "high" } } }) }),
    ...["ultra", [], null, "high-invalid"].map((effort) =>
      config({ team: body("v1", "fixture", { d1: { effort } }) })),
    config({ team: body("v1", "fixture", { d3: { typo: "high" } }) }),
    config({ team: { version: "v1", slots: { ...body("v1", "fixture").slots, standart: { model: "fixture/typo" } } } }),
    config({ team: { version: "v1", slots: { ...body("v1", "fixture").slots, fallback: { model: "fixture/other" } } } }),
    config({ off: body("v1", "fixture") }),
    config({ reload: body("v1", "fixture") }),
  ];
  for (const value of invalid) {
    await writeFile(path, JSON.stringify(value));
    assert.throws(() => router.prepare(), (error) => error.code === "INVALID_PRESET_CONFIG" &&
      typeof error.details?.error === "string" && error.details.error.length <= 512);
    assert.deepEqual(router.current(), original);
  }
});

test("missing and malformed config fail clearly; mock-registry names can be redefined atomically", async (t) => {
  const path = await fixture(t), router = new PresetRouter(path), original = router.current();
  assert.throws(() => router.select("absent"), { code: "PRESET_NOT_FOUND" });
  await writeFile(path, "{broken"); assert.throws(() => router.prepare(), { code: "INVALID_PRESET_CONFIG" });
  assert.deepEqual(router.current(), original);
  await rm(path); assert.throws(() => router.prepare(), { code: "INVALID_PRESET_CONFIG" });
  assert.deepEqual(router.current(), original);
  await writeFile(path, JSON.stringify(config({ "fixture-balanced": body("custom-v2", "fixture") })));
  const changed = router.commit(router.prepare(), "fixture-balanced");
  assert.equal(changed.version, "custom-v2");
  assert.equal(changed.models.d3, "fixture/standard");
  assert.equal(presetLabel(changed), "fixture-balanced@custom-v2");
});

test("all non-off presets show their versions; source overrides mark either kind", () => {
  assert.equal(presetLabel({ name: "mine", version: "v7" }), "mine@v7");
  assert.equal(presetLabel({ name: "fixture-balanced", version: "anything" }), "fixture-balanced@anything");
  assert.equal(presetLabel({ name: "mine", version: "v7", effort_overrides: { d1: "inherit" } }), "mine@v7*");
  assert.equal(presetLabel({ name: "fixture-balanced", version: "anything", effort_overrides: { d5: "high" } }), "fixture-balanced@anything*");
});

test("effort override validator is closed and rejects explicit undefined members", () => {
  for (const overrides of [{}, { d1: "inherit" }, { d3: "off", d5: "max" }, Object.create(null)])
    assert.equal(validEffortOverrides(overrides), true);
  const changing = { get d1() { return "high"; } };
  const hidden = Object.defineProperty({}, "d1", { value: "high" });
  for (const overrides of [null, undefined, [], "high", new Date(), changing, hidden, { d1: undefined },
    { extra: "low" }, { d1: "ultra" }, { d1: null }, { light: "high" }, { standard: "off" }, { strong: "max" }, { [Symbol("slot")]: "low" }])
    assert.equal(validEffortOverrides(overrides), false);
});

test("custom effort defaults are inherited when omitted and fixed effort never uses the ceiling", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture", {
    d1: { effort: "off" }, d2: { effort: "off" }, d3: { effort: "high" },
  }) })));
  const router = new PresetRouter(path), preset = router.select("team");
  assert.deepEqual(preset.effort_defaults, { d1: "off", d2: "off", d3: "high", d4: "inherit", d5: "inherit" });
  assert.deepEqual(preset.effort, preset.effort_defaults);
  const model = { provider: "fixture", id: "standard" };
  const route = resolveRoute({ preset, difficulty: 3, parentThinking: undefined, models: [model],
    supportedThinking: () => ["high"] });
  assert.equal(route.thinking, "high"); assert.equal(route.thinking_resolution, "preset_fixed");
  assert.equal(route.parent_thinking, undefined);
  assert.equal(resolveRoute({ preset, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["high"] }).parent_thinking, "low", "capture even when fixed effort ignores parent");
  assert.throws(() => resolveRoute({ preset, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["low"] }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
      error.details.reason === "fixed_effort_unsupported", "fixed policy must not use identity or the automatic ceiling");
  assert.throws(() => resolveRoute({ preset, difficulty: 4, parentThinking: undefined, models: [],
    supportedThinking: () => assert.fail("inherit requires parent before model lookup") }), { code: "PARENT_THINKING_UNAVAILABLE" });
  const inheriting = router.apply(router.prepare(), "team", () => {}, { d3: "inherit" });
  assert.equal(inheriting.effort.d3, "inherit");
  const mapped = resolveRoute({ preset: inheriting, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["high"] });
  assert.equal(mapped.thinking, "high"); assert.equal(mapped.thinking_resolution, "automatic_mapping");
  assert.equal(mapped.effort_source, "user_override");
  assert.equal(mapped.parent_thinking, "low");
});

test("fixed effort requires exact SDK support with abstract actionable error, never maps or falls back", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const fixed = router.apply(router.prepare(), "fixture-balanced", () => {}, { d3: "max" });
  const model = { provider: "openai-codex", id: "fixture-standard-model" };
  const input = { preset: fixed, difficulty: 3, parentThinking: "off", models: [model], supportedThinking: () => ["off", "high"] };
  assert.throws(() => resolveRoute(input), (error) => error.code === "THINKING_INCOMPATIBLE" &&
    !Object.hasOwn(error.details, "key") && !Object.hasOwn(error.details, "parameter") &&
    error.details.reason === "fixed_effort_unsupported" && error.details.difficulty === 3 &&
    /preset effort configuration/.test(error.details.resolution) &&
    /Do not change reasoning_difficulty to bypass configuration errors/.test(error.details.resolution) &&
    !/standard|fixture-standard-model/.test(JSON.stringify(error.details)));
  assert.throws(() => resolveRoute({ ...input, models: [] }), (error) => error.code === "PRESET_MODEL_UNAVAILABLE" &&
    !/standard|fixture-standard-model/.test(JSON.stringify(error.details)));
  const override = router.apply(router.prepare(), "fixture-balanced", () => {}, { d3: "off" });
  assert.equal(resolveRoute({ ...input, preset: override, parentThinking: undefined }).thinking, "off");
});

test("slot resolution matches admission without fabricating a task difficulty", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture", {
    d1: { effort: "high" }, d2: { effort: "high" },
  }) })));
  const preset = new PresetRouter(path).select("team");
  const input = { preset, parentThinking: "low", models: [
    { provider: "fixture", id: "light", levels: ["high"] },
    { provider: "fixture", id: "standard", levels: ["high"] },
    { provider: "fixture", id: "strong", levels: ["low"] },
  ], supportedThinking: (model) => model.levels };
  const slots = ["d1", "d2", "d3", "d4", "d5"];
  const resolutions = ["preset_fixed", "preset_fixed", "automatic_mapping", "identity", "identity"];
  for (const difficulty of [1, 2, 3, 4, 5]) {
    const bySlot = resolveSlotRoute({ ...input, strength: slots[difficulty - 1] });
    assert.equal(Object.hasOwn(bySlot, "difficulty"), false);
    assert.equal(bySlot.thinking_resolution, resolutions[difficulty - 1]);
    assert.deepEqual(resolveRoute({ ...input, difficulty }), { ...bySlot, difficulty });
  }
  assert.throws(() => resolveSlotRoute({ ...input, strength: "d5", parentThinking: "off" }), (error) => {
    assert.equal(error.code, "THINKING_INCOMPATIBLE");
    assert.equal(error.details.reason, "off_unsupported");
    assert.equal(Object.hasOwn(error.details, "difficulty"), false);
    assert.throws(() => resolveRoute({ ...input, difficulty: 5, parentThinking: "off" }), (admission) => {
      assert.deepEqual(admission.details, { ...error.details, difficulty: 5 });
      return true;
    });
    return true;
  });
});

test("restored overrides are per-preset, cloned, reflected in inspect and digest, and survive reload", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture") })));
  const input = { d3: "high" };
  const router = new PresetRouter(path, new Map([["team", input], ["inactive", { d1: "inherit" }]]));
  input.d3 = "low";
  const team = router.select("team"), baseline = new PresetRouter(path).select("team");
  assert.deepEqual(team.effort_overrides, { d3: "high" });
  assert.equal(team.effort.d3, "high"); assert.equal(team.effort_defaults.d3, "inherit");
  assert.notEqual(team.digest, baseline.digest);
  const inspected = router.inspect(router.prepare()).find((preset) => preset.name === "team");
  assert.deepEqual(inspected, team);
  for (const target of [inspected.effort, inspected.effort_defaults, inspected.effort_overrides]) {
    assert(Object.isFrozen(target)); assert.throws(() => { target.d3 = "off"; }, TypeError);
  }
  assert.equal(presetLabel(team), "team@v1*");
  router.select("fixture-balanced");
  assert.deepEqual(router.select("team").effort_overrides, { d3: "high" });
  await writeFile(path, JSON.stringify(config({ team: body("v2", "fixture", { d1: { effort: "high" } }) })));
  const reloaded = router.commit(router.prepare(), "team");
  assert.equal(reloaded.version, "v2"); assert.equal(reloaded.effort.d1, "high");
  assert.equal(reloaded.effort.d3, "high");
  assert.deepEqual(reloaded.effort_overrides, { d3: "high" });
  await writeFile(path, JSON.stringify(config({})));
  router.commit(router.prepare(), "fixture-balanced");
  assert.throws(() => router.select("team"), { code: "PRESET_NOT_FOUND" });
  await writeFile(path, JSON.stringify(config({ team: body("v3", "fixture"), inactive: body("v1", "fixture") })));
  assert.deepEqual(router.commit(router.prepare(), "team").effort_overrides, { d3: "high" });
  assert.deepEqual(router.select("inactive").effort_overrides, { d1: "inherit" },
    "an inactive saved name becomes available if added later");
  router.select("team");
  const reset = router.apply(router.prepare(), "team", () => {}, {});
  assert.deepEqual(reset.effort_overrides, {}); assert.equal(reset.effort.d3, "inherit");
  assert.notEqual(reset.digest, reloaded.digest);
});

test("effort changes audit atomically, reject malformed/Off/stale, and resist reentry and mutation", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const original = router.current(), stale = router.prepare();
  let audits = 0;
  const changing = { get d1() { return "high"; } };
  for (const overrides of [{ d1: undefined }, { wrong: "high" }, { d1: "ultra" }, changing, []]) {
    assert.throws(() => router.apply(router.prepare(), "fixture-balanced", () => { audits++; }, overrides),
      { code: "INVALID_PRESET_CONFIG" });
  }
  assert.throws(() => router.apply(router.prepare(), "off", () => { audits++; }, {}),
    { code: "INVALID_PRESET_CONFIG" });
  assert.equal(audits, 0); assert.deepEqual(router.current(), original);
  const source = { d1: "low" };
  assert.throws(() => router.apply(router.prepare(), "fixture-balanced", (audit) => {
    audits++; source.d1 = "max";
    audit.effort.d1 = "off"; audit.effort_overrides.d1 = "off";
    assert.throws(() => router.select("off"), { code: "PRESET_SELECTION_IN_PROGRESS" });
    assert.throws(() => router.apply(router.prepare(), "fixture-balanced", () => {}, {}), { code: "PRESET_SELECTION_IN_PROGRESS" });
    throw new Error("AUDIT_FAILED");
  }, source), /AUDIT_FAILED/);
  assert.deepEqual(router.current(), original);
  assert.equal(audits, 1);
  const chosen = router.apply(stale, "fixture-balanced", (audit) => { audits++;
    audit.effort.d1 = "off"; audit.effort_overrides.d1 = "off";
  }, { d1: "low" });
  assert.equal(chosen.effort.d1, "low"); assert.equal(chosen.effort_overrides.d1, "low");
  assert.equal(chosen.effort_defaults.d1, "xhigh");
  assert.notEqual(chosen.digest, original.digest);
  assert.equal(audits, 2);
  assert.throws(() => router.apply(stale, "fixture-balanced", () => { audits++; }, {}), { code: "STALE_PRESET_SELECTION" });
  assert.equal(audits, 2);
  const reset = router.apply(router.prepare(), "fixture-balanced", () => {}, {});
  assert.deepEqual(reset, original);
  const sameEffective = router.apply(router.prepare(), "fixture-balanced", () => {}, { d1: "xhigh" });
  assert.equal(sameEffective.effort.d1, original.effort.d1);
  assert.notEqual(sameEffective.digest, original.digest, "explicit source overrides affect the digest");
  assert.throws(() => new PresetRouter(router.configPath, new Map([["off", {}]])), { code: "INVALID_PRESET_CONFIG" });
  assert.throws(() => new PresetRouter(router.configPath, new Map([["fixture-balanced", changing]])),
    { code: "INVALID_PRESET_CONFIG" });
});

test("automatic ceiling covers every parent level and support subset, including disordered metadata and fixed strictness", () => {
  const preset = {
    name: "oracle", version: "v1", digest: "b".repeat(64),
    models: Object.fromEntries(strengths.map((slot) => [slot, "fixture/worker"])),
    effort: Object.fromEntries(strengths.map((slot) => [slot, "inherit"])),
    effort_defaults: Object.fromEntries(strengths.map((slot) => [slot, "inherit"])),
    effort_overrides: {},
    thinking: { d3: { low: "off", off: "max", minimal: "off", max: "minimal" } },
  };
  const model = { provider: "fixture", id: "worker" };
  const disorder = (levels) => [...levels].reverse().flatMap((level, index) =>
    index % 2 === 0 ? [level, level, "not-a-level", "HIGH", ""] : [level]);
  const resolveInherited = (parentThinking, raw) => resolveSlotRoute({
    preset, strength: "d3", parentThinking, models: [model], supportedThinking: () => raw,
  });
  const assertInherited = (parent, raw) => {
    const expected = ceilingOracle(parent, raw);
    if (expected.error) {
      assert.throws(() => resolveInherited(parent, raw), (error) => {
        assert.equal(error.code, "THINKING_INCOMPATIBLE");
        assert.equal(error.details.reason, expected.error);
        assert.equal(error.details.key, "parent_thinking");
        assert.equal(error.details.parent_thinking, parent);
        assert.equal(Object.hasOwn(error.details, "thinking"), false);
        assert.equal(Object.hasOwn(error.details, "difficulty"), false);
        assert.match(error.details.resolution, /change the parent Pi thinking level or worker preset/);
        assert.match(error.details.resolution, /Do not change reasoning_difficulty to bypass configuration errors/);
        assert.equal(JSON.stringify(error.details).includes("fixture/worker"), false);
        return true;
      }, `${parent} x [${raw.join(",")}]`);
      return;
    }
    const selected = resolveInherited(parent, raw);
    assert.equal(selected.thinking, expected.thinking, `${parent} x [${raw.join(",")}]`);
    assert.equal(selected.thinking_resolution, expected.thinking_resolution);
    assert.equal(selected.parent_thinking, parent);
    assert.equal(selected.effort_source, "preset");
  };
  assert.equal(canonicalThinking.length, 7);
  for (let mask = 0; mask < 128; mask++) {
    const supported = canonicalThinking.filter((_, index) => (mask & (1 << index)) !== 0);
    for (const parent of canonicalThinking) {
      assertInherited(parent, supported);
      assertInherited(parent, disorder(supported));
    }
    for (const effort of canonicalThinking) {
      const fixed = { ...preset, effort: { ...preset.effort, d3: effort }, effort_overrides: { d3: effort } };
      for (const raw of [supported, disorder(supported)]) {
        const run = () => resolveSlotRoute({
          preset: fixed, strength: "d3", parentThinking: "minimal", models: [model], supportedThinking: () => raw,
        });
        if (raw.includes(effort)) {
          const selected = run();
          assert.equal(selected.thinking, effort, `fixed ${effort} must not ceiling across [${raw.join(",")}]`);
          assert.equal(selected.thinking_resolution, "preset_fixed");
          assert.equal(selected.parent_thinking, "minimal");
          assert.equal(selected.effort_source, "user_override");
        } else {
          assert.throws(run, (error) => error.code === "THINKING_INCOMPATIBLE" &&
            error.details.reason === "fixed_effort_unsupported" && !Object.hasOwn(error.details, "key") &&
            error.details.parent_thinking === undefined, `fixed ${effort} x [${raw.join(",")}]`);
        }
      }
    }
  }
  for (const parentThinking of [undefined, null, "", "unknown", "OFF", "High", "minimal ", "auto", 0]) {
    let looked = false;
    assert.throws(() => resolveSlotRoute({
      preset, strength: "d3", parentThinking,
      models: { filter() { looked = true; return []; } },
      supportedThinking() { looked = true; return ["high"]; },
    }), { code: "PARENT_THINKING_UNAVAILABLE" });
    assert.equal(looked, false, String(parentThinking));
  }
  const fixedHigh = { ...preset, effort: { ...preset.effort, d3: "high" } };
  assert.equal(resolveSlotRoute({
    preset: fixedHigh, strength: "d3", parentThinking: undefined, models: [model],
    supportedThinking: () => ["nope", "high", "high"],
  }).thinking_resolution, "preset_fixed");
  assert.throws(() => resolveSlotRoute({
    preset: fixedHigh, strength: "d3", parentThinking: "low", models: [model],
    supportedThinking: () => ["max", "xhigh", "LOW"],
  }), (error) => error.code === "THINKING_INCOMPATIBLE" && error.details.reason === "fixed_effort_unsupported");
});

const virtualResolution = "Ask the user to configure a physical model for this worker preset slot. Virtual models route each request and cannot be pinned to an Agent. Do not change reasoning_difficulty to bypass configuration errors.";

test("virtual selected presets are rejected before thinking; physical chat models stay pinned", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: body("v1", "fixture", {
    d1: { effort: "off" }, d2: { effort: "off" }, d3: { effort: "high" },
  }) })));
  const preset = new PresetRouter(path).select("team");
  const physical = {
    light: { provider: "fixture", id: "light", api: "anthropic-messages" },
    standard: { provider: "fixture", id: "standard", api: "openai-completions" },
    strong: { provider: "fixture", id: "strong" },
  };
  const nonchat = [
    { provider: "typesafe", id: "jev-latest", api: "typesafe-system-one", type: "classifier" },
    { provider: "openrouter", id: "flux", api: "openrouter-images", type: "image" },
  ];
  const parentVirtual = { provider: "router", id: "auto", api: "pi-virtual", levels: ["off", "high", "max"] };
  const consulted = [];
  const catalogue = [parentVirtual, ...nonchat, physical.light, physical.standard, physical.strong];
  const supportedThinking = (model) => {
    consulted.push(`${model.provider}/${model.id}`);
    return ["off", "high"];
  };
  const input = { preset, parentThinking: "off", models: catalogue, supportedThinking };
  // Shared physical IDs are allowed across independent difficulty slots. Non-chat rows are not candidates.
  assert.equal(resolveRoute({ ...input, difficulty: 1 }).model, "light");
  assert.equal(resolveRoute({ ...input, difficulty: 2 }).thinking, "off");
  const fixed = resolveRoute({ ...input, difficulty: 3, parentThinking: undefined });
  assert.equal(fixed.provider, "fixture"); assert.equal(fixed.model, "standard");
  assert.equal(fixed.thinking, "high"); assert.equal(fixed.thinking_resolution, "preset_fixed");
  assert.equal(resolveRoute({ ...input, difficulty: 5, parentThinking: "high" }).model, "strong");
  assert.deepEqual(consulted, ["fixture/light", "fixture/light", "fixture/standard", "fixture/strong"]);
  for (const api of [undefined, "openai-completions", "anthropic-messages", "pi-messages", "custom-physical"]) {
    const model = { provider: "fixture", id: "standard", ...(api === undefined ? {} : { api }) };
    assert.equal(resolveRoute({ preset, difficulty: 3, parentThinking: undefined, models: [model],
      supportedThinking: () => ["high"] }).model, "standard", String(api));
  }

  const virtual = { provider: "fixture", id: "standard", api: "pi-virtual" };
  const rejectVirtual = (run, difficulty) => {
    assert.throws(run, (error) => {
      assert.equal(error.code, "PRESET_MODEL_UNAVAILABLE");
      assert.equal(error.details.reason, "virtual_model");
      assert.equal(error.details.model_kind, "virtual");
      assert.equal(error.details.resolution, virtualResolution);
      assert.equal(error.details.preset, "team");
      assert.doesNotMatch(JSON.stringify(error.details), /fixture\/standard|pi-virtual|jev-latest|flux/);
      if (difficulty === undefined) assert.equal(Object.hasOwn(error.details, "difficulty"), false);
      else assert.equal(error.details.difficulty, difficulty);
      return true;
    });
  };
  let thinkingLookups = 0;
  const supported = () => { thinkingLookups++; return ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; };
  rejectVirtual(() => resolveRoute({ preset, difficulty: 3, parentThinking: "high", models: [virtual], supportedThinking: supported }), 3);
  rejectVirtual(() => resolveRoute({ preset, difficulty: 3, parentThinking: undefined, models: [virtual], supportedThinking: supported }), 3);
  rejectVirtual(() => resolveSlotRoute({ preset, strength: "d3", parentThinking: "high", models: [virtual], supportedThinking: supported }));
  assert.equal(thinkingLookups, 0, "supported thinking must not admit a virtual worker");
  assert.throws(() => selectPhysicalWorkerModel([virtual], "fixture/standard", preset), (error) =>
    error.code === "PRESET_MODEL_UNAVAILABLE" && error.details.reason === "virtual_model" &&
    error.details.model_kind === "virtual" && !Object.hasOwn(error.details, "difficulty"));
  assert.throws(() => resolveRoute({ preset, difficulty: 3, parentThinking: "off", models: [virtual, { ...virtual, api: "openai-completions" }],
    supportedThinking: supported }), (error) => error.code === "PRESET_MODEL_UNAVAILABLE" &&
    !Object.hasOwn(error.details, "reason") && error.details.difficulty === 3,
  "a virtual and physical twin stay ambiguous; do not prefer either");
  assert.equal(thinkingLookups, 0);
  // Another virtual model in the chat catalogue is not a global parent rejection.
  assert.equal(resolveRoute({ ...input, difficulty: 1 }).provider, "fixture");
});

test("child construction rejects a runtime model that is no longer physical", async () => {
  const definition = "reader definition";
  const settings = { profile: "reader", definition_digest: digest(definition), tools: ["read"],
    provider: "fixture", model: "controlled" };
  const options = {
    ctx: {}, parentBus: {}, agentDir: "/tmp", permissionRoot: "tmp", policyRoot: "/tmp", parentId: "parent",
    profiles: { reader: { definition, body: "", tools: ["read"] } },
    settings() { throw new Error("settings unused"); }, parentHistory: {}, approvalBindings: {}, activities: {},
    parentPermission: () => ({}), getPermissionsService() { throw new Error("unused"); },
  };
  const calls = [];
  const virtual = createChildSessionFactory({ ...options, runtime: {
    getModel: (provider, id) => { calls.push(["listed", provider, id]); return { api: "pi-virtual", provider, id }; },
    getPhysicalModel: (provider, id) => { calls.push(["physical", provider, id]); return undefined; },
  } });
  await assert.rejects(virtual({ agent_id: "a", name: "orca", settings }), /no longer physical/);
  assert.deepEqual(calls, [["listed", "fixture", "controlled"], ["physical", "fixture", "controlled"]]);
  const missing = createChildSessionFactory({ ...options, runtime: {
    getModel: () => undefined,
    getPhysicalModel: () => { throw new Error("missing model must not ask for a physical twin"); },
  } });
  await assert.rejects(missing({ agent_id: "a", name: "orca", settings }), /no longer available/);
});
