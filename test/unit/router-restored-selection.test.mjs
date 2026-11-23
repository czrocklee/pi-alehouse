import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { decodeRecordedPreset, PresetRouter } from "../../dist/orchestration/routing.js";
import { PanelCoordinator } from "../../dist/orchestration/ui/panel-coordinator.js";
import {
  stageWorkerSelection,
  workerDefinitionForScope,
} from "../../dist/orchestration/ui/preferences-controls.js";
import { controls, fixture, team } from "../support/preferences-fixture.mjs";

async function saveCatalogue(f, presets) {
  await writeFile(f.path, JSON.stringify({ ...f.config, presets }));
}

function recordTeam(f) {
  return f.router.apply(f.router.prepare(), "team", () => {}, { d2: "off" });
}

const configuredOnly = { configuredOnly: true };

test("recorded snapshots are verified canonically without modifying audit data", async (t) => {
  const f = await fixture(t),
    snapshot = recordTeam(f);
  const reverse = (table) => Object.fromEntries(Object.entries(table).reverse());
  const record = {
    ...snapshot,
    models: reverse(snapshot.models),
    effort_defaults: reverse(snapshot.effort_defaults),
    effort: reverse(snapshot.effort),
    selected_at: 1,
    custom_presets: { extra: team() },
  };
  const bytes = JSON.stringify(record);
  const decoded = decodeRecordedPreset(record);
  assert.deepEqual(decoded, snapshot);
  assert.deepEqual(Object.keys(decoded.models), ["d1", "d2", "d3", "d4", "d5"]);
  assert.equal(JSON.stringify(record), bytes);
  assert.notEqual(decoded.models, record.models);
  assert.equal(decodeRecordedPreset({ name: "off", digest: "historical" }), undefined);
  assert.equal(decodeRecordedPreset({ name: "team", effort_overrides: {} }), undefined);

  const { effort: _omitted, ...partial } = record;
  for (const invalid of [
    { name: "off", models: {} },
    { name: "team", effort: undefined },
    partial,
    { ...record, name: "reload" },
    { ...record, version: 3 },
    { ...record, models: { ...record.models, extra: "fixture/worker" } },
    { ...record, models: { ...record.models, d1: "missing-provider" } },
    { ...record, effort_defaults: { ...record.effort_defaults, d4: "invalid" } },
    { ...record, effort_overrides: { d2: null } },
    { ...record, effort: { ...record.effort, d2: record.effort_defaults.d2 } },
    { ...record, digest: "0".repeat(64) },
  ]) {
    const before = structuredClone(invalid);
    assert.throws(() => decodeRecordedPreset(invalid), /Invalid recorded preset snapshot/);
    assert.deepEqual(invalid, before);
  }
});

test("a removed restored route is active only until a successful configured selection", async (t) => {
  const f = await fixture(t),
    snapshot = recordTeam(f);
  await saveCatalogue(f, { alternate: team("alternate") });
  const router = new PresetRouter(f.path, new Map([["team", { d2: "low" }]]), {}, snapshot);
  assert.deepEqual(router.current(), snapshot, "restoration owns the active overrides too");
  assert.deepEqual(router.customPresets(), {});
  assert.deepEqual(router.names(), ["off", "alternate", "team"]);
  assert.deepEqual(router.definition("team"), team());

  const reload = router.prepare(undefined, configuredOnly);
  assert.equal(reload.activeName, "team");
  assert.deepEqual(reload.names, ["off", "alternate"]);
  const audit = () => assert.fail("a missing configured name must not reach audit");
  assert.throws(() => router.apply(reload, "team", audit), { code: "PRESET_NOT_FOUND" });
  assert.deepEqual(router.current(), snapshot);

  const picker = router.prepare();
  assert.deepEqual(
    router.inspect(picker).find(({ name }) => name === "team"),
    snapshot,
  );
  const applied = router.apply(picker, "team", () => {}, { d3: "medium" });
  assert.deepEqual(applied.models, snapshot.models);
  assert.deepEqual(applied.effort_defaults, snapshot.effort_defaults);
  assert.deepEqual(applied.effort_overrides, { d3: "medium" });
  const next = router.rebase(picker);
  assert.deepEqual(
    router.inspect(next).find(({ name }) => name === "team"),
    applied,
  );
  assert.throws(
    () =>
      router.apply(next, "alternate", () => {
        throw new Error("audit");
      }),
    /audit/,
  );
  assert.deepEqual(router.current(), applied, "an audit failure does not unpin the live route");
  router.commit(next, "alternate");
  assert.deepEqual(router.rebase(next).names, ["off", "alternate"]);
  assert.equal(
    router.inspect(router.rebase(next)).some(({ name }) => name === "team"),
    false,
  );
  assert.throws(() => router.select("team"), { code: "PRESET_NOT_FOUND" });
  assert.throws(() => router.commit(picker, "team"), { code: "STALE_PRESET_SELECTION" });
});

test("explicit preset commands reload configuration instead of republishing a restored pin", async (t) => {
  const f = await fixture(t),
    snapshot = recordTeam(f),
    router = new PresetRouter(f.path, new Map(), {}, snapshot);
  const errors = [],
    audits = [];
  const panel = new PanelCoordinator({
    pi: { registerShortcut() {} },
    ready: () => true,
    router: () => router,
    publish: (candidate, name) => ({
      selection: router.apply(candidate, name, (record) => audits.push(record)),
      candidate: router.rebase(candidate),
    }),
    showError: (error) => errors.push(error.code),
  });
  const ctx = { mode: "rpc", ui: {} };
  await saveCatalogue(f, {});
  await panel.selectPreset("reload", ctx);
  assert.deepEqual(errors, ["PRESET_NOT_FOUND"]);
  assert.deepEqual(audits, []);
  assert.deepEqual(router.current(), snapshot);

  await saveCatalogue(f, { team: team("new-disk") });
  await panel.selectPreset("team", ctx);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].models.d1, "fixture/new-disk");
  assert.equal(router.current().models.d1, "fixture/new-disk");
});

test("the current pin does not replace configured or explicitly edited definitions", async (t) => {
  const f = await fixture(t),
    snapshot = recordTeam(f);
  await saveCatalogue(f, { team: team("new-disk"), other: team("alternate") });
  const existing = team("branch-custom"),
    router = new PresetRouter(f.path, new Map(), { team: existing }, snapshot);
  assert.deepEqual(router.current(), snapshot);
  assert.deepEqual(router.customPresets(), { team: existing });
  assert.deepEqual(router.definition("team"), team());
  assert.equal(
    router.commit(router.prepare(undefined, configuredOnly), "team").models.d1,
    "fixture/branch-custom",
  );
  assert.deepEqual(router.current().effort_overrides, snapshot.effort_overrides);

  f.router = new PresetRouter(f.path, new Map(), {}, snapshot);
  const c = controls(f, ["fixture/replacement"]);
  c.ctx.modelRegistry.getAll = () => [
    { provider: "fixture", id: "replacement", api: "fixture", reasoning: false },
  ];
  await c.ui.editModel("team", "d3");
  const { candidate, definition } = c.published[0];
  assert.deepEqual(definition.slots, {
    ...team().slots,
    d3: { model: "fixture/replacement", effort: "inherit" },
  });
  assert.equal(f.router.commit(candidate, "team").models.d3, "fixture/replacement");
  assert.deepEqual(f.router.customPresets(), { team: definition });
});

test("explicit scoped saves remember the exact pin, not another same-name model", async (t) => {
  const f = await fixture(t),
    snapshot = recordTeam(f);
  f.router = new PresetRouter(f.path, new Map(), {}, snapshot);
  assert.equal(f.router.rememberedDefinition("team"), undefined, "unchanged base is name-only");
  await saveCatalogue(f, {});
  const c = controls(f, [], [true]);
  await c.ui.saveDefault("global");
  assert.deepEqual(f.store.get("global").presets, { team: team() });
  assert.deepEqual(
    f.router.customPresets(),
    {},
    "explicitly remembering does not alter the catalogue",
  );
  assert.deepEqual(f.router.current(), snapshot);

  const changed = team("new-disk");
  await saveCatalogue(f, { team: changed });
  f.store.setScope("global");
  const previous = f.router.current();
  const selected = f.router.commit(f.router.prepare(undefined, configuredOnly), "team");
  assert.equal(
    f.router.rememberedDefinition("team"),
    undefined,
    "the new disk definition is now live",
  );
  stageWorkerSelection(
    f.store,
    selected,
    previous,
    false,
    undefined,
    workerDefinitionForScope(f.router, f.store, "global", "team"),
  );
  assert.deepEqual(
    f.store.get("global").presets,
    { team: changed },
    "pending earlier pin cannot shadow the live model",
  );
});

test("base-only preset names and model spellings still restore without coercion", async (t) => {
  const f = await fixture(t),
    unusual = team("valid on base only");
  await saveCatalogue(f, { constructor: team(), team: unusual });
  const configured = new PresetRouter(f.path),
    reserved = configured.select("constructor"),
    broad = configured.select("team");
  const read = (snapshot) =>
    new PresetRouter(f.path, new Map(), {}, decodeRecordedPreset(snapshot));
  assert.deepEqual(read(reserved).current(), reserved);
  assert.throws(() => read(reserved).rememberedDefinition("constructor"), /Invalid settings/);
  const restored = read(broad);
  assert.deepEqual(restored.current(), broad);
  assert.equal(
    restored.rememberedDefinition("team"),
    undefined,
    "a representable name can use the equivalent base body",
  );
  await saveCatalogue(f, {});
  assert.throws(() => restored.rememberedDefinition("team"), /Invalid settings/);
  assert.deepEqual(restored.current(), broad);
});
