import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { isOffPreset, presetLabel, PresetRouter, resolveRoute, resolveSlotRoute, strengths, validEffortOverrides } from "../../dist/routing.js";
import { presetConfig, starterConfig, writePresetConfig } from "../support/preset-config.mjs";
import harnessExtension, { applyAuditedPreset, restorePresetRouter } from "../../dist/extension.js";
import { validDifficulty } from "../../dist/core/contracts.js";

// Fixed mock-registry assertions: these values belong to test/support/presets.json,
// not the operator's editable production catalogue.
const builtins = {
  "fixture-strong": ["openai-codex/fixture-standard-model", "openai-codex/fixture-standard-model", "openai-codex/fixture-strong-model"],
  "fixture-balanced": ["openai-codex/fixture-light-model", "openai-codex/fixture-standard-model", "openai-codex/fixture-standard-model"],
  "fixture-light": ["openai-codex/fixture-light-model", "openai-codex/fixture-light-model", "openai-codex/fixture-standard-model"],
  "fixture-reviewed": ["openai-codex/fixture-light-model", "xai/fixture-review-model", "openai-codex/fixture-standard-model"],
  "fixture-compatible": ["openai-codex/fixture-light-model", "deepseek/fixture-compatible-model", "openai-codex/fixture-standard-model"],
};
const body = (version, model, thinking) => ({ version,
  models: { light: `${model}/light`, standard: `${model}/standard`, strong: `${model}/strong` },
  ...(thinking ? { thinking } : {}) });
const config = presetConfig;
const defaultName = () => starterConfig().defaultPreset;

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
  { name: "missing defaultPreset", content: JSON.stringify({ version: 2, presets: {} }), code: "INVALID_PRESET_CONFIG", error: /defaultPreset/ },
  { name: "unknown defaultPreset", content: JSON.stringify(config({}, { defaultPreset: "absent" })), code: "INVALID_PRESET_CONFIG", error: /defaultPreset/ },
  { name: "malformed JSON", content: "{broken", code: "INVALID_PRESET_CONFIG", error: /Could not parse/ },
  { name: "invalid schema", content: JSON.stringify(config({}, { typo: true })), code: "INVALID_PRESET_CONFIG", error: /unsupported field: typo/ },
  { name: "removed saved preset", content: JSON.stringify(config({})), saved: "retired-team", code: "PRESET_NOT_FOUND" },
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
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => "startup-fixture",
    getBranch: () => scenario.saved ? [{ type: "custom", customType: "harness:preset-selection:v1", data: { name: scenario.saved } }] : [] },
    ui: { notify: (message, level) => notices.push({ message, level }), setStatus: (...args) => statuses.push(args) } };
  const start = () => handlers.get("session_start")({}, ctx);
  if (scenario.throws) await assert.rejects(start, scenario.throws);
  else {
    await assert.doesNotReject(start);
    assert.equal(notices.length, 1); assert.equal(notices[0].level, "error");
    const failure = JSON.parse(notices[0].message);
    assert.equal(failure.code, scenario.code); assert.equal(failure.config_path, path);
    assert.match(failure.resolution, /restart Pi/);
    if (scenario.error) assert.match(failure.error, scenario.error);
    if (scenario.saved) assert.equal(failure.requested, scenario.saved);
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
  const expectedThinking = {
    "fixture-strong": [{}, {}, {}],
    "fixture-balanced": [{}, {}, {}],
    "fixture-light": [{}, {}, {}],
    "fixture-reviewed": [{}, { minimal: "low", max: "xhigh" }, {}],
    "fixture-compatible": [{}, { minimal: "high", low: "high", medium: "high", xhigh: "max" }, {}],
  };
  const expectedEffort = {
    "fixture-strong": ["high", "xhigh", "high"],
    "fixture-balanced": ["xhigh", "high", "xhigh"],
    "fixture-light": ["xhigh", "max", "high"],
    "fixture-reviewed": ["xhigh", "high", "xhigh"],
    "fixture-compatible": ["xhigh", "max", "xhigh"],
  };
  for (const [name, ids] of Object.entries(builtins)) {
    const snapshot = router.select(name);
    assert.deepEqual([snapshot.models.light, snapshot.models.standard, snapshot.models.strong], ids);
    assert.deepEqual([snapshot.thinking.light, snapshot.thinking.standard, snapshot.thinking.strong], expectedThinking[name]);
    assert.equal(snapshot.version, name === "fixture-reviewed" ? "fixture-v2" : "fixture-v1");
    assert.deepEqual([snapshot.effort.light, snapshot.effort.standard, snapshot.effort.strong], expectedEffort[name]);
    assert.deepEqual(snapshot.effort, snapshot.effort_defaults);
    assert.deepEqual(snapshot.effort_overrides, {});
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
    const { digest: _digest, ...selection } = snapshot;
    const legacyDigest = createHash("sha256").update(JSON.stringify(selection)).digest("hex");
    assert.notEqual(snapshot.digest, legacyDigest, "rating-to-slot mapping must be part of preset identity");
    assert.equal(snapshot.digest, createHash("sha256").update(JSON.stringify({ ...selection,
      difficultySlots: ["light", "light", "standard", "strong", "strong"] })).digest("hex"));
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
    assert.deepEqual(snapshot.models, body.models);
    assert.deepEqual(snapshot.thinking, Object.fromEntries(strengths.map((slot) => [slot, body.thinking?.[slot] ?? {}])));
    const effort = Object.fromEntries(strengths.map((slot) => [slot, body.effort?.[slot] ?? "inherit"]));
    assert.deepEqual(snapshot.effort_defaults, effort);
    assert.deepEqual(snapshot.effort, effort);
    assert.deepEqual(snapshot.effort_overrides, {});
  }
});

test("configured default may be a named preset or off; saved branch selection wins", async (t) => {
  const path = await fixture(t);
  for (const defaultPreset of ["team", "off"]) {
    await writePresetConfig(path, { version: 2, defaultPreset, presets: { team: body("v1", "fixture"), other: body("v1", "other") } });
    const router = new PresetRouter(path);
    assert.equal(router.current().name, defaultPreset);
    assert.equal(restorePresetRouter(path, []).current().name, defaultPreset);
    assert.equal(restorePresetRouter(path, [{ name: "other" }]).current().name, "other");
    assert.equal(restorePresetRouter(path, [{ name: "other" }, { name: "off" }]).current().name, "off");
  }
});

test("reload keeps the active selection when the file's default changes", async (t) => {
  const path = await fixture(t);
  await writePresetConfig(path, { version: 2, defaultPreset: "team", presets: { team: body("v1", "fixture"), other: body("v1", "other") } });
  const router = new PresetRouter(path);
  router.select("other");
  await writePresetConfig(path, { version: 2, defaultPreset: "off", presets: { team: body("v2", "fixture"), other: body("v2", "other") } });
  const candidate = router.prepare();
  assert.equal(candidate.activeName, "other");
  assert.equal(router.commit(candidate, candidate.activeName).version, "v2");
  assert.equal(router.current().name, "other");
  assert.equal(new PresetRouter(path).current().name, "off");
});

test("a minimal file has no ghost mock-registry presets and old names have no special protection", async (t) => {
  const path = await fixture(t);
  await writePresetConfig(path, { version: 2, defaultPreset: "off", presets: {} });
  const router = new PresetRouter(path);
  assert.deepEqual(router.names(), ["off"]);
  assert.throws(() => router.select("fixture-strong"), { code: "PRESET_NOT_FOUND" });
  await writePresetConfig(path, { version: 2, defaultPreset: "fixture-strong", presets: { "fixture-strong": body("v9", "fixture") } });
  assert.equal(router.commit(router.prepare(), "fixture-strong").version, "v9");
  await writePresetConfig(path, { version: 2, defaultPreset: "off", presets: {} });
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
      error.details.resolution === "Use an integer from 1 to 5 to rate the task difficulty." &&
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

test("mock-registry slots enforce fixed default effort; explicit inherit uses identity and compatibility maps", async (t) => {
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
    for (const [difficulty, strength] of [[1, "light"], [2, "light"], [3, "standard"], [4, "strong"], [5, "strong"]]) {
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
      for (const parentThinking of levels) {
        const mapped = preset.thinking[strength][parentThinking];
        if (!model.levels.includes(parentThinking) && mapped === undefined) {
          assert.throws(() => resolveRoute({ preset, difficulty, parentThinking, models: catalogue,
            supportedThinking: (selected) => selected.levels }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
              error.details.reason === "identity_unsupported_no_mapping" && error.details.parent_thinking === parentThinking &&
              /change the parent Pi thinking level or worker preset/.test(error.details.resolution) &&
              /Do not change difficulty to bypass configuration errors/.test(error.details.resolution) &&
              error.details.difficulty === difficulty &&
              !JSON.stringify(error.details).includes(exact));
          continue;
        }
        const selected = resolveRoute({ preset, difficulty, parentThinking, models: catalogue,
          supportedThinking: (chosen) => chosen.levels });
        const identity = model.levels.includes(parentThinking);
        assert.equal(selected.difficulty, difficulty); assert.equal(selected.strength, strength);
        assert.equal(selected.thinking, identity ? parentThinking : mapped);
        assert.equal(selected.parent_thinking, parentThinking);
        assert.equal(selected.thinking_resolution, identity ? "identity" : "preset_mapping");
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

test("custom maps affect immutable digests, preserve identity, and reject unsupported targets at resolution", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ plain: body("v1", "fixture"),
    mapped: body("v1", "fixture", { standard: { low: "high" } }) })));
  const router = new PresetRouter(path), plain = router.select("plain"), mapped = router.select("mapped");
  assert.notEqual(plain.digest, mapped.digest);
  const model = { provider: "fixture", id: "standard", levels: ["low", "high"] };
  const identity = resolveRoute({ preset: mapped, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: (selected) => selected.levels });
  assert.equal(identity.thinking, "low"); assert.equal(identity.thinking_resolution, "identity");
  assert.equal(identity.effort_source, "preset");
  model.levels = ["off"];
  assert.throws(() => resolveRoute({ preset: mapped, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: (selected) => selected.levels }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
      error.details.reason === "mapped_target_unsupported" && error.details.thinking === "high" &&
      /change the parent Pi thinking level or worker preset/.test(error.details.resolution) &&
      /Do not change difficulty to bypass configuration errors/.test(error.details.resolution));

  const offMapped = { ...mapped, thinking: { ...mapped.thinking, standard: { off: "high" } } };
  assert.throws(() => resolveRoute({ preset: offMapped, difficulty: 3, parentThinking: "off", models: [model],
    supportedThinking: () => ["high"] }), (error) => error.code === "THINKING_INCOMPATIBLE" &&
      error.details.reason === "off_mapping_forbidden" && error.details.thinking === "high" &&
      /Do not change difficulty to bypass configuration errors\.$/.test(error.details.resolution));
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
  assert.equal(reloaded.version, "v2"); assert.equal(reloaded.models.standard, "changed-fixture/standard");

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
  assert.equal(team.models.standard, "fixture/standard");
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(team.models), true);
  assert.equal(Object.isFrozen(team.thinking), true);
  assert.equal(Object.isFrozen(team.thinking.light), true);
  assert.throws(() => { team.models.light = "changed/model"; }, TypeError);
  assert.throws(() => { team.thinking.light.low = "high"; }, TypeError);
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
  assert.equal(accepted.version, "v1"); assert.equal(accepted.models.standard, "deepseek-fixture/standard");
  assert.equal(changed.version, "v2"); assert.equal(changed.models.standard, "missing/standard");
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
    config({ team: body("v1", "fixture", { standard: { tiny: "high" } }) }),
    config({ team: body("v1", "fixture", { standard: { low: "tiny" } }) }),
    config({ team: body("v1", "fixture", { standard: { off: "high" } }) }),
    config({ team: body("v1", "fixture", { standard: { low: "high", extra: "max" } }) }),
    config({ team: body("v1", "fixture", { extreme: { low: "high" } }) }),
    ...[{ light: "ultra" }, { unknown: "high" }, [], null, "high"].map((effort) =>
      config({ team: { ...body("v1", "fixture"), effort } })),
    config({ team: { version: "v1", models: { ...body("v1", "fixture").models, standart: "fixture/typo" } } }),
    config({ team: { version: "v1", models: { ...body("v1", "fixture").models, fallback: "fixture/other" } } }),
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
  assert.equal(changed.models.standard, "fixture/standard");
  assert.equal(presetLabel(changed), "fixture-balanced@custom-v2");
});

test("all non-off presets show their versions; source overrides mark either kind", () => {
  assert.equal(presetLabel({ name: "mine", version: "v7" }), "mine@v7");
  assert.equal(presetLabel({ name: "fixture-balanced", version: "anything" }), "fixture-balanced@anything");
  assert.equal(presetLabel({ name: "mine", version: "v7", effort_overrides: { light: "inherit" } }), "mine@v7*");
  assert.equal(presetLabel({ name: "fixture-balanced", version: "anything", effort_overrides: { strong: "high" } }), "fixture-balanced@anything*");
});

test("effort override validator is closed and rejects explicit undefined members", () => {
  for (const overrides of [{}, { light: "inherit" }, { standard: "off", strong: "max" }, Object.create(null)])
    assert.equal(validEffortOverrides(overrides), true);
  const changing = { get light() { return "high"; } };
  const hidden = Object.defineProperty({}, "light", { value: "high" });
  for (const overrides of [null, undefined, [], "high", new Date(), changing, hidden, { light: undefined },
    { extra: "low" }, { light: "ultra" }, { light: null }, { [Symbol("slot")]: "low" }])
    assert.equal(validEffortOverrides(overrides), false);
});

test("custom effort defaults are inherited when omitted and override compatibility maps only when fixed", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: { ...body("v1", "fixture", { standard: { low: "high" } }),
    effort: { light: "off", standard: "high" } } })));
  const router = new PresetRouter(path), preset = router.select("team");
  assert.deepEqual(preset.effort_defaults, { light: "off", standard: "high", strong: "inherit" });
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
      error.details.reason === "fixed_effort_unsupported", "fixed policy must not use identity or compatibility maps");
  assert.throws(() => resolveRoute({ preset, difficulty: 4, parentThinking: undefined, models: [],
    supportedThinking: () => assert.fail("inherit requires parent before model lookup") }), { code: "PARENT_THINKING_UNAVAILABLE" });
  const inheriting = router.apply(router.prepare(), "team", () => {}, { standard: "inherit" });
  assert.equal(inheriting.effort.standard, "inherit");
  const mapped = resolveRoute({ preset: inheriting, difficulty: 3, parentThinking: "low", models: [model],
    supportedThinking: () => ["high"] });
  assert.equal(mapped.thinking, "high"); assert.equal(mapped.thinking_resolution, "preset_mapping");
  assert.equal(mapped.effort_source, "user_override");
  assert.equal(mapped.parent_thinking, "low");
});

test("fixed effort requires exact SDK support with abstract actionable error, never maps or falls back", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const fixed = router.apply(router.prepare(), "fixture-balanced", () => {}, { standard: "max" });
  const model = { provider: "openai-codex", id: "fixture-standard-model" };
  const input = { preset: fixed, difficulty: 3, parentThinking: "off", models: [model], supportedThinking: () => ["off", "high"] };
  assert.throws(() => resolveRoute(input), (error) => error.code === "THINKING_INCOMPATIBLE" &&
    !Object.hasOwn(error.details, "key") && !Object.hasOwn(error.details, "parameter") &&
    error.details.reason === "fixed_effort_unsupported" && error.details.difficulty === 3 &&
    /preset effort configuration/.test(error.details.resolution) &&
    /Do not change difficulty to bypass configuration errors/.test(error.details.resolution) &&
    !/standard|fixture-standard-model/.test(JSON.stringify(error.details)));
  assert.throws(() => resolveRoute({ ...input, models: [] }), (error) => error.code === "PRESET_MODEL_UNAVAILABLE" &&
    !/standard|fixture-standard-model/.test(JSON.stringify(error.details)));
  const override = router.apply(router.prepare(), "fixture-balanced", () => {}, { standard: "off" });
  assert.equal(resolveRoute({ ...input, preset: override, parentThinking: undefined }).thinking, "off");
});

test("slot resolution matches admission without fabricating a task difficulty", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify(config({ team: { ...body("v1", "fixture", { standard: { low: "high" } }),
    effort: { light: "high" } } })));
  const preset = new PresetRouter(path).select("team");
  const input = { preset, parentThinking: "low", models: [
    { provider: "fixture", id: "light", levels: ["high"] },
    { provider: "fixture", id: "standard", levels: ["high"] },
    { provider: "fixture", id: "strong", levels: ["low"] },
  ], supportedThinking: (model) => model.levels };
  const slots = ["light", "light", "standard", "strong", "strong"];
  const resolutions = ["preset_fixed", "preset_fixed", "preset_mapping", "identity", "identity"];
  for (const difficulty of [1, 2, 3, 4, 5]) {
    const bySlot = resolveSlotRoute({ ...input, strength: slots[difficulty - 1] });
    assert.equal(Object.hasOwn(bySlot, "difficulty"), false);
    assert.equal(bySlot.thinking_resolution, resolutions[difficulty - 1]);
    assert.deepEqual(resolveRoute({ ...input, difficulty }), { ...bySlot, difficulty });
  }
  assert.throws(() => resolveSlotRoute({ ...input, strength: "strong", parentThinking: "off" }), (error) => {
    assert.equal(error.code, "THINKING_INCOMPATIBLE");
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
  const input = { standard: "high" };
  const router = new PresetRouter(path, new Map([["team", input], ["inactive", { light: "inherit" }]]));
  input.standard = "low";
  const team = router.select("team"), baseline = new PresetRouter(path).select("team");
  assert.deepEqual(team.effort_overrides, { standard: "high" });
  assert.equal(team.effort.standard, "high"); assert.equal(team.effort_defaults.standard, "inherit");
  assert.notEqual(team.digest, baseline.digest);
  const inspected = router.inspect(router.prepare()).find((preset) => preset.name === "team");
  assert.deepEqual(inspected, team);
  for (const target of [inspected.effort, inspected.effort_defaults, inspected.effort_overrides]) {
    assert(Object.isFrozen(target)); assert.throws(() => { target.standard = "off"; }, TypeError);
  }
  assert.equal(presetLabel(team), "team@v1*");
  router.select("fixture-balanced");
  assert.deepEqual(router.select("team").effort_overrides, { standard: "high" });
  await writeFile(path, JSON.stringify(config({ team: { ...body("v2", "fixture"), effort: { light: "high" } } })));
  const reloaded = router.commit(router.prepare(), "team");
  assert.equal(reloaded.version, "v2"); assert.equal(reloaded.effort.light, "high");
  assert.equal(reloaded.effort.standard, "high");
  assert.deepEqual(reloaded.effort_overrides, { standard: "high" });
  await writeFile(path, JSON.stringify(config({})));
  router.commit(router.prepare(), "fixture-balanced");
  assert.throws(() => router.select("team"), { code: "PRESET_NOT_FOUND" });
  await writeFile(path, JSON.stringify(config({ team: body("v3", "fixture"), inactive: body("v1", "fixture") })));
  assert.deepEqual(router.commit(router.prepare(), "team").effort_overrides, { standard: "high" });
  assert.deepEqual(router.select("inactive").effort_overrides, { light: "inherit" },
    "an inactive saved name becomes available if added later");
  router.select("team");
  const reset = router.apply(router.prepare(), "team", () => {}, {});
  assert.deepEqual(reset.effort_overrides, {}); assert.equal(reset.effort.standard, "inherit");
  assert.notEqual(reset.digest, reloaded.digest);
});

test("effort changes audit atomically, reject malformed/Off/stale, and resist reentry and mutation", async (t) => {
  const router = new PresetRouter(await fixture(t));
  const original = router.current(), stale = router.prepare();
  let audits = 0;
  const changing = { get light() { return "high"; } };
  for (const overrides of [{ light: undefined }, { wrong: "high" }, { light: "ultra" }, changing, []]) {
    assert.throws(() => router.apply(router.prepare(), "fixture-balanced", () => { audits++; }, overrides),
      { code: "INVALID_PRESET_CONFIG" });
  }
  assert.throws(() => router.apply(router.prepare(), "off", () => { audits++; }, {}),
    { code: "INVALID_PRESET_CONFIG" });
  assert.equal(audits, 0); assert.deepEqual(router.current(), original);
  const source = { light: "low" };
  assert.throws(() => router.apply(router.prepare(), "fixture-balanced", (audit) => {
    audits++; source.light = "max";
    audit.effort.light = "off"; audit.effort_overrides.light = "off";
    assert.throws(() => router.select("off"), { code: "PRESET_SELECTION_IN_PROGRESS" });
    assert.throws(() => router.apply(router.prepare(), "fixture-balanced", () => {}, {}), { code: "PRESET_SELECTION_IN_PROGRESS" });
    throw new Error("AUDIT_FAILED");
  }, source), /AUDIT_FAILED/);
  assert.deepEqual(router.current(), original);
  assert.equal(audits, 1);
  const chosen = router.apply(stale, "fixture-balanced", (audit) => { audits++;
    audit.effort.light = "off"; audit.effort_overrides.light = "off";
  }, { light: "low" });
  assert.equal(chosen.effort.light, "low"); assert.equal(chosen.effort_overrides.light, "low");
  assert.equal(chosen.effort_defaults.light, "xhigh");
  assert.notEqual(chosen.digest, original.digest);
  assert.equal(audits, 2);
  assert.throws(() => router.apply(stale, "fixture-balanced", () => { audits++; }, {}), { code: "STALE_PRESET_SELECTION" });
  assert.equal(audits, 2);
  const reset = router.apply(router.prepare(), "fixture-balanced", () => {}, {});
  assert.deepEqual(reset, original);
  const sameEffective = router.apply(router.prepare(), "fixture-balanced", () => {}, { light: "xhigh" });
  assert.equal(sameEffective.effort.light, original.effort.light);
  assert.notEqual(sameEffective.digest, original.digest, "explicit source overrides affect the digest");
  assert.throws(() => new PresetRouter(router.configPath, new Map([["off", {}]])), { code: "INVALID_PRESET_CONFIG" });
  assert.throws(() => new PresetRouter(router.configPath, new Map([["fixture-balanced", changing]])),
    { code: "INVALID_PRESET_CONFIG" });
});
