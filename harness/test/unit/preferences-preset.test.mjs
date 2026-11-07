import {
  team,
  allSlots,
  allSlotDefinitions,
  descendingSlots,
  fixture,
  controls,
  nearLimitPreferences,
  assertOnlySlotChanged,
} from "../support/preferences-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { PresetRouter, strengths } from "../../dist/routing.js";
import { restorePresetRouter, restorePresetDefinitions } from "../../dist/extension.js";
import { SettingsStore } from "../../../lib/settings-store.mjs";

test("preset editor creates a physical model preset only after confirmation and rejects stale publication", async (t) => {
  const f = await fixture(t);
  const c = controls(
    f,
    ["custom", ...strengths.flatMap(() => ["fixture/worker", "inherit"])],
    [true],
  );
  await c.ui.editPreset();
  assert.equal(c.published.length, 1);
  assert.equal(c.published[0].name, "custom");
  assert.deepEqual(
    c.published[0].definition.slots,
    allSlotDefinitions("fixture/worker", "inherit"),
  );
  assert.deepEqual(f.store.pending(), [], "the editor only returns an audited commit request");
  const stale = controls(f, ["other", ...strengths.flatMap(() => ["fixture/worker", "inherit"])]);
  stale.ctx.ui.confirm = async () => {
    f.router.select("team");
    return true;
  };
  await assert.rejects(stale.ui.editPreset(), { code: "STALE_PRESET_SELECTION" });
  assert.equal(stale.published.length, 0);
});

for (const name of [undefined, "team"])
  test(`preset ${name ? "editing" : "creation"} pairs model/effort dialogs d5 to d1 without changing slot identities`, async (t) => {
    const f = await fixture(t),
      policies = { d1: "off", d2: "low", d3: "medium", d4: "high", d5: "inherit" };
    const answers = descendingSlots.flatMap((slot) => [`fixture/${slot}`, policies[slot]]);
    const c = controls(f, [...(name ? [] : ["custom"]), ...answers], [true]);
    c.ctx.modelRegistry.getAll = () =>
      strengths.map((slot) => ({ provider: "fixture", id: slot, api: "fixture", reasoning: true }));
    await c.ui.editPreset(name);
    const target = name ?? "custom";
    assert.deepEqual(
      c.selectPrompts.map(({ prompt }) => prompt),
      descendingSlots.flatMap((slot) => [
        `${target}: ${slot} model (new Agents only)`,
        `${target}: ${slot} default effort`,
      ]),
    );
    assert.equal(c.published.length, 1);
    assert.deepEqual(
      c.published[0].definition.slots,
      Object.fromEntries(
        strengths.map((slot) => [slot, { model: `fixture/${slot}`, effort: policies[slot] }]),
      ),
      "each effort stays with the chosen slot, not the visual index",
    );
    assert.deepEqual(
      strengths,
      ["d1", "d2", "d3", "d4", "d5"],
      "dialog sequencing must not mutate canonical routing order",
    );
    assert.deepEqual(f.store.pending(), []);
  });

test("preset effort dialogs reject unoffered policies and forged Keep choices before publication", async (t) => {
  const f = await fixture(t),
    original = f.router.definition("team"),
    before = f.router.current();
  for (const name of [undefined, "team"])
    for (const policy of ["ultra", "high", "Keep high", "Keep inherit "]) {
      const c = controls(f, [...(name ? [] : ["custom"]), "fixture/worker", policy], [true]);
      await assert.rejects(
        c.ui.editPreset(name),
        { code: "THINKING_INCOMPATIBLE" },
        `${policy} is not an offered effort choice`,
      );
      assert.deepEqual(c.published, []);
      assert.deepEqual(c.confirmPrompts, [], "invalid policy never reaches Apply consent");
      assert.deepEqual(f.store.pending(), []);
      assert.deepEqual(f.router.definition("team"), original);
      assert.deepEqual(f.router.current(), before);
    }
});

test("slot-object creation, model edit, save and restoration keep external definitions separate from normalized snapshots", async (t) => {
  const f = await fixture(t),
    records = [];
  const created = controls(
    f,
    ["custom", ...descendingSlots.flatMap(() => ["fixture/worker", "inherit"])],
    [true],
  );
  await created.ui.editPreset();
  const first = created.published[0];
  assert.deepEqual(Object.keys(first.definition).sort(), ["slots", "version"]);
  assert.deepEqual(first.definition.slots, allSlotDefinitions("fixture/worker", "inherit"));
  const overrides = { d1: "off", d5: "inherit" };
  const audit = (definition) => (selection) =>
    records.push({ ...selection, custom_presets: { custom: definition } });
  f.router.apply(first.candidate, "custom", audit(first.definition), overrides);
  const original = f.router.definition("custom");
  const edited = controls(f, ["fixture/other"]);
  edited.ctx.modelRegistry.getAll = () =>
    ["worker", "other"].map((id) => ({
      provider: "fixture",
      id,
      api: "fixture",
      reasoning: false,
    }));
  await edited.ui.editModel("custom", "d3");
  const next = edited.published[0];
  assertOnlySlotChanged(next.definition, original, "d3", "fixture/other");
  f.router.apply(next.candidate, "custom", audit(next.definition), overrides);
  const saving = controls(f, [], [true]);
  await saving.ui.saveDefault("global");
  const preferences = f.store.get("global");
  assert.deepEqual(preferences.presets.custom, next.definition);
  assert.deepEqual(preferences.effort.custom, {
    d1: "off",
    d2: null,
    d3: null,
    d4: null,
    d5: "inherit",
  });
  assert.deepEqual(restorePresetDefinitions(records), { custom: next.definition });
  for (const branch of [[], records]) {
    const restored = restorePresetRouter(f.path, branch, preferences);
    assert.deepEqual(
      restored.definition("custom"),
      {
        version: next.definition.version,
        slots: Object.fromEntries(
          strengths.map((slot) => [
            slot,
            {
              model: next.definition.slots[slot].model,
              effort: next.definition.slots[slot].effort ?? "inherit",
            },
          ]),
        ),
      },
      "definition projection normalizes optional effort and does not store thinking",
    );
    assert.equal(
      Object.hasOwn(restored.current(), "thinking"),
      false,
      "normalized snapshots drop thinking",
    );
    assert.deepEqual(restored.current().models, {
      ...allSlots("fixture/worker"),
      d3: "fixture/other",
    });
    assert.deepEqual(restored.current().effort_defaults, allSlots("inherit"));
    assert.deepEqual(restored.current().effort_overrides, overrides);
  }
  await assert.rejects(
    readFile(f.store.paths.global),
    { code: "ENOENT" },
    "saving still queues instead of writing the definition immediately",
  );
});

test("preset editor cancellation and duplicate/reserved names never modify catalogue", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path, "utf8");
  const duplicate = controls(f, ["team"]);
  await assert.rejects(duplicate.ui.editPreset(), { code: "PRESET_ALREADY_EXISTS" });
  const reserved = controls(f, ["reload"]);
  await assert.rejects(reserved.ui.editPreset(), { code: "INVALID_PRESET_NAME" });
  const malformed = controls(f, ["../../escape"]);
  await assert.rejects(malformed.ui.editPreset(), { code: "INVALID_PRESET_NAME" });
  const cancel = controls(f, ["custom", undefined]);
  await cancel.ui.editPreset();
  assert.deepEqual(cancel.published, []);
  const noModels = controls(f, ["custom"]);
  noModels.ctx.modelRegistry.getAll = () => [
    { provider: "fixture", id: "virtual", api: "pi-virtual" },
  ];
  await assert.rejects(noModels.ui.editPreset(), { code: "PRESET_MODEL_UNAVAILABLE" });
  assert.equal(await readFile(f.path, "utf8"), before);
});

for (const scope of ["global", "workspace"])
  test(`one-shot ${scope} saving remembers only applied worker settings without changing scope or writing files`, async (t) => {
    const f = await fixture(t);
    f.router = new PresetRouter(f.path, new Map(), {
      team: team("custom"),
      unused: team("unused"),
    });
    f.router.apply(f.router.prepare(), "team", () => {}, { d1: "inherit", d5: "off" });
    f.store.setScope(scope === "global" ? "workspace" : "global");
    f.store.stage(scope, ["approval"], "manual");
    f.store.stage(scope, ["effort", "other", "d1"], "high");
    const before = f.router.current(),
      ongoingScope = f.store.scope,
      c = controls(f, [], [true]);
    await c.ui.saveDefault(scope);
    assert.equal(f.store.scope, ongoingScope);
    assert.deepEqual(f.router.current(), before);
    assert.deepEqual(c.published, []);
    assert.deepEqual(c.selectPrompts, [], "a direct save already has its destination");
    assert.equal(c.confirmPrompts.length, 1);
    assert(
      c.confirmPrompts[0].text.includes(f.store.paths[scope]),
      "the exact destination is confirmed",
    );
    assert.match(
      c.confirmPrompts[0].text,
      /current applied worker settings.*not a highlighted preset, slider preview or live parent thinking/,
    );
    assert.deepEqual(f.store.get(scope), {
      version: 2,
      approval: "manual",
      preset: "team",
      delegation: { mode: "lead", eagerness: "eager" },
      presets: { team: team("custom") },
      effort: {
        other: { d1: "high" },
        team: { d1: "inherit", d2: null, d3: null, d4: null, d5: "off" },
      },
    });
    await assert.rejects(readFile(f.store.paths[scope]), { code: "ENOENT" });
    assert(c.notifications.some(({ text }) => text.includes(`${scope} on normal exit`)));
  });

for (const source of ["base", "custom"])
  test(`saving a ${source} preset named toString treats it as data, not an inherited member`, async (t) => {
    const f = await fixture(t),
      before = Object.getOwnPropertyDescriptors(Object.prototype.toString);
    if (source === "base") {
      f.config.presets.toString = team();
      await writeFile(f.path, JSON.stringify(f.config));
      f.router = new PresetRouter(f.path);
      f.router.select("toString");
    } else f.router.commit(f.router.prepare({ toString: team("custom") }), "toString");
    const c = controls(f, [], [true]);
    await c.ui.saveDefault("global");
    const saved = f.store.get("global");
    assert.equal(saved.preset, "toString");
    assert(Object.hasOwn(saved.effort, "toString"));
    assert.deepEqual(saved.effort.toString, allSlots(null));
    assert.equal(Object.hasOwn(saved.presets ?? {}, "toString"), source === "custom");
    if (source === "custom") assert.deepEqual(saved.presets.toString, team("custom"));
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(Object.prototype.toString),
      before,
      "built-in functions remain untouched",
    );
  });

test("saving Off defaults preserves every effort and unrelated preference", async (t) => {
  const f = await fixture(t);
  f.store.stage("global", ["effort", "team"], { d1: "high", d3: "inherit", d5: null });
  f.store.stage("global", ["approval"], "judge");
  const effort = f.store.get("global").effort,
    c = controls(f, [], [true]);
  await c.ui.saveDefault("global");
  assert.equal(f.store.get("global").preset, "off");
  assert.deepEqual(f.store.get("global").effort, effort);
  assert.equal(f.store.get("global").approval, "judge");
  assert.equal(f.store.scope, "session");
  assert.deepEqual(c.published, []);
});

test("direct worker saves require confirmation, UI and workspace trust", async (t) => {
  const f = await fixture(t),
    c = controls(f, [], [false]);
  await c.ui.saveDefault("global");
  assert.deepEqual(f.store.pending(), []);
  c.ctx.hasUI = false;
  await assert.rejects(c.ui.saveDefault("global"), { code: "SETTINGS_UI_REQUIRED" });
  f.store = new SettingsStore({
    agentDir: join(f.root, "agent"),
    cwd: join(f.root, "work"),
    projectTrusted: false,
  });
  const denied = controls(f, [], [true]);
  await assert.rejects(denied.ui.saveDefault("workspace"), { code: "PROJECT_NOT_TRUSTED" });
  assert.deepEqual(
    denied.confirmPrompts,
    [],
    "an untrusted destination is never offered for consent",
  );
  assert.deepEqual(f.store.pending(), []);
});

for (const change of [
  "preset",
  "effort",
  "definition",
  "delegation",
  "router",
  "retire",
  "dispose",
]) {
  test(`a worker save cannot stage an obsolete snapshot after ${change} during confirmation`, async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    f.store.stage("global", ["approval"], "manual");
    const pending = f.store.pending(),
      c = controls(f);
    c.ctx.ui.confirm = async () => {
      if (change === "preset") f.router.select("off");
      else if (change === "effort")
        f.router.apply(f.router.prepare(), "team", () => {}, { d1: "off" });
      else if (change === "definition")
        f.router.commit(f.router.prepare({ team: team("new") }), "team");
      else if (change === "delegation") f.delegation = { mode: "manual", eagerness: "reserved" };
      else if (change === "router") f.router = new PresetRouter(f.path);
      else if (change === "retire") c.retire();
      else c.ui.dispose();
      return true;
    };
    if (["retire", "dispose"].includes(change))
      await assert.rejects(c.ui.saveDefault("global"), { code: "SETTINGS_SESSION_CHANGED" });
    else {
      await c.ui.saveDefault("global");
      assert(
        c.notifications.some(
          ({ text, level }) => level === "warning" && text.includes("nothing was staged"),
        ),
      );
    }
    assert.deepEqual(f.store.pending(), pending);
    await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  });
}

test("worker save confirmation owns one destination, not the shared future save scope", async (t) => {
  const f = await fixture(t),
    c = controls(f);
  c.ctx.ui.confirm = async () => {
    f.store.setScope("workspace");
    return true;
  };
  await c.ui.saveDefault("global");
  assert.equal(f.store.scope, "workspace");
  assert.equal(f.store.get("global").preset, "off");
  assert.deepEqual(f.store.get("workspace"), { version: 2 });
});

test("one pending worker save owns its dialog and releases after cancellation", async (t) => {
  const f = await fixture(t),
    c = controls(f);
  let answer,
    confirmations = 0;
  c.ctx.ui.confirm = () => {
    confirmations++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const saving = c.ui.saveDefault("global");
  await c.ui.saveDefault("workspace");
  await c.ui.open();
  assert.equal(confirmations, 1);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(f.store.pending(), []);
  answer(false);
  await saving;
  c.ctx.ui.confirm = async () => true;
  await c.ui.saveDefault("workspace");
  assert.deepEqual(f.store.get("global"), { version: 2 });
  assert.equal(f.store.get("workspace").preset, "off");
});

test("worker snapshot preflight prevents partially queued saves at the single-file byte cap", async (t) => {
  const f = await fixture(t),
    document = nearLimitPreferences({ version: 2 }, 30);
  f.store.stage("global", ["presets"], document.presets);
  f.router.select("team");
  const pending = f.store.pending(),
    c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(f.store.pending(), pending, "not even the smaller first preset patch is queued");
  assert.equal(f.store.get("global").preset, undefined);
});

test("a final-fitting worker snapshot cannot partially stage an overflowing intermediate prefix", async (t) => {
  const f = await fixture(t),
    document = nearLimitPreferences(
      {
        version: 2,
        preset: "a",
        delegation: { mode: "manual", eagerness: "balanced" },
        effort: { team: allSlots(null) },
      },
      5,
    );
  for (const [key, value] of Object.entries(document))
    if (key !== "version") f.store.stage("global", [key], value);
  f.router.select("team");
  f.delegation = { mode: "supervisor", eagerness: "eager" };
  const final = { ...document, preset: "team", delegation: f.delegation };
  assert.equal(
    Buffer.byteLength(JSON.stringify(final)) + 1,
    256 * 1024 - 1,
    "the final document fits by one byte",
  );
  const pending = f.store.pending(),
    c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(
    f.store.pending(),
    pending,
    "preset must not queue before the larger mode patch fails",
  );
  assert.equal(f.store.get("global").preset, "a");
});

test("toString effort preflight respects the byte cap and leaves built-ins and pending patches untouched", async (t) => {
  const f = await fixture(t),
    before = Object.getOwnPropertyDescriptors(Object.prototype.toString);
  f.config.presets.toString = team();
  await writeFile(f.path, JSON.stringify(f.config));
  f.router = new PresetRouter(f.path);
  f.router.select("toString");
  const document = nearLimitPreferences(
    { version: 2, preset: "a", delegation: { mode: "lead", eagerness: "eager" } },
    30,
  );
  for (const [key, value] of Object.entries(document))
    if (key !== "version") f.store.stage("global", [key], value);
  const pending = f.store.pending(),
    c = controls(f, [], [true]);
  await assert.rejects(c.ui.saveDefault("global"), /document exceeds/);
  assert.deepEqual(f.store.pending(), pending);
  assert.equal(f.store.get("global").preset, "a");
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype.toString), before);
});
