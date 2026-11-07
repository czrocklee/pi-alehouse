import {
  team,
  allSlotDefinitions,
  descendingSlots,
  fixture,
  controls,
  worker,
  virtual,
  fresh,
  tick,
  runtimeDouble,
  tuiControls,
  waitForPicker,
  paint,
  heavy,
  richModels,
  singleSlotFixture,
  chooseNative,
  assertOnlySlotChanged,
  floating,
  mouseClick,
  overlayConfig,
  boundedOverlay,
  measuredOverlay,
} from "../support/preferences-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { stageWorkerSelection } from "../../dist/orchestration/ui/preferences-controls.js";
import { PresetModelPopover } from "../../dist/orchestration/ui/preset-model-popover.js";
import { PresetRouter, strengths } from "../../dist/orchestration/routing.js";
import { validateSettings } from "../../src/shared/settings-store.mjs";

test("TUI slots pick through the native selector: titled, searchable, virtual-free, no default-setting path", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path, "utf8");
  const c = tuiControls(f, {
    inputs: ["custom"],
    selects: strengths.map(() => "inherit"),
    confirms: [true],
  });
  const editing = c.ui.editPreset();
  try {
    const light = await waitForPicker(c, 0);
    assert.match(
      paint(light),
      /custom: d5 model · new Agents only; main unchanged/,
      "the wrapper starts with the hardest slot",
    );
    assert(!paint(light).includes("set as default"), "no save-as-default handler is offered");
    assert.equal(light.component.focused, false, "the wrapper is IME-focusable");
    light.component.focused = true;
    assert.equal(light.component.focused, true);
    light.component.focused = false;
    assert(paint(light).includes("worker"), "the physical fixture model is listed");
    assert(!paint(light).includes("virtual-worker"), "virtual models are never listed");
    // A query that only matches the virtual model finds nothing and cannot settle.
    for (const key of ["v", "i", "r", "t"]) light.component.handleInput(key);
    assert(paint(light).includes("No matching models"), "a virtual-only query matches nothing");
    light.component.handleInput("\x13"); // save-as-default: no such handler here
    light.component.handleInput("\r");
    await tick();
    assert.equal(
      light.settled,
      false,
      "neither an empty selection nor the default path settles the dialog",
    );
    for (const key of ["\x7f", "\x7f", "\x7f", "\x7f"]) light.component.handleInput(key);
    for (const key of ["w", "o", "r", "k"]) light.component.handleInput(key);
    assert(paint(light).includes("worker"), "typing filters to the physical model");
    light.component.handleInput("\r");
    for (let index = 1; index < strengths.length; index++) {
      const slotPicker = await waitForPicker(c, index);
      assert(
        paint(slotPicker).includes(
          `custom: ${descendingSlots[index]} model · new Agents only; main unchanged`,
        ),
      );
      slotPicker.component.handleInput("\r"); // no query: the first physical model
    }
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(
    c.selectPrompts.map(({ prompt }) => prompt),
    descendingSlots.map((slot) => `custom: ${slot} default effort`),
    "the effort dialog follows every native model choice in descending slot order",
  );
  assert.deepEqual(
    c.selectPrompts[0].choices,
    ["Keep inherit", "inherit", "off"],
    "effort policies come from the selected model's metadata",
  );
  assert.equal(c.published.length, 1);
  assert.deepEqual(
    c.published[0].definition.slots,
    allSlotDefinitions("fixture/worker", "inherit"),
  );
  assert.ok(
    c.state.refreshCalls.length >= 1,
    "the native selector keeps its automatic catalog refresh",
  );
  assert.deepEqual(f.store.pending(), [], "the editor only returns an audited commit request");
  assert.equal(await readFile(f.path, "utf8"), before, "the catalogue file is never rewritten");
});

test("editing an existing preset preselects its current model in the native list", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { selects: ["inherit"] });
  const editing = c.ui.editPreset("team");
  const light = await waitForPicker(c, 0);
  const text = paint(light);
  assert.match(text, /team: d5 model/, "C/edit starts at the hardest slot too");
  assert(text.includes("✓"), "the current model is marked");
  assert(text.indexOf("✓") < text.indexOf("worker"), "the current model leads the list");
  light.component.handleInput("\r"); // no query: Enter takes the preselected model
  const standard = await waitForPicker(c, 1);
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(
    c.selectPrompts.map(({ prompt }) => prompt),
    ["team: d5 default effort"],
  );
  assert.deepEqual(c.published, [], "the flow is cancelled at the next slot");
});

test("Escape from the native picker publishes nothing and writes no file", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { inputs: ["custom"] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\u001b");
  await editing;
  assert.equal(light.settled, true);
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.selectPrompts, [], "no effort dialog runs after a cancel");
  assert.deepEqual(f.store.pending(), []);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("disposing the controls while the native picker is open settles the dialog and aborts its refresh", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path, "utf8");
  const c = tuiControls(f, {
    inputs: ["custom"],
    runtimeDouble: (models) => runtimeDouble({ models: [...models], pending: true }),
  });
  const editing = c.ui.editPreset();
  await waitForPicker(c, 0);
  await tick(3); // arm the pending refresh through the shared coordinator
  assert.ok(c.state.refreshCalls.length >= 1, "the native refresh was requested with a signal");
  c.ui.dispose();
  await assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  await tick(3);
  assert.equal(
    c.state.refreshCalls[0].signal.aborted,
    true,
    "the native refresh is aborted on dispose",
  );
  assert.deepEqual(c.published, []);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("a late callback from an already-finished picker cannot close the newer dialog", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], selects: ["inherit"] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\r"); // selects the first physical model
  const standard = await waitForPicker(c, 1);
  // The disposed light picker still receives input; its once-guard must not
  // reach the standard dialog's done.
  light.component.handleInput("\r");
  light.component.handleInput("\u001b");
  await tick(3);
  assert.equal(standard.settled, false, "the newer dialog stays open");
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("a factory queued across dispose asserts liveness and never mounts a native picker", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], deferCustom: true });
  const editing = c.ui.editPreset();
  await tick(); // the name dialog resolves, ui.custom queues the factory
  c.ui.dispose();
  c.runQueuedFactory();
  await assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  assert.deepEqual(c.pickers, [], "no native component was created for a retired session");
  assert.deepEqual(c.published, []);
});

test("a model that only the runtime snapshot knows fails fresh registry validation", async (t) => {
  const f = await fixture(t);
  const orphan = {
    provider: "fixture",
    id: "orphan",
    name: "Orphan",
    api: "fixture",
    reasoning: false,
  };
  const c = tuiControls(f, {
    inputs: ["custom"],
    registry: [worker],
    runtimeDouble: (models) => runtimeDouble({ models: [...models, orphan] }),
  });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  for (const key of ["o", "r", "p", "h"]) light.component.handleInput(key);
  light.component.handleInput("\r");
  await assert.rejects(editing, { code: "PRESET_MODEL_UNAVAILABLE" });
  assert.deepEqual(c.published, []);
});

test("a catalog refresh that adds a physical model feeds fresh metadata into the effort dialog", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, {
    inputs: ["custom"],
    selects: strengths.map(() => "high"),
    confirms: [true],
    runtimeDouble: (models) =>
      runtimeDouble({
        models,
        onRefresh: (state) => {
          state.models.push(fresh);
        },
      }),
  });
  const editing = c.ui.editPreset();
  try {
    for (const slot of [0, 1, 2, 3, 4]) {
      const picker = await waitForPicker(c, slot);
      await tick(3); // let the automatic refresh publish the new model
      for (const key of ["f", "r", "e", "s", "h"]) picker.component.handleInput(key);
      assert(paint(picker).includes("fresh"), "the refreshed model is selectable");
      picker.component.handleInput("\r");
    }
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(
    c.selectPrompts[0].choices,
    ["Keep inherit", "inherit", "off", "minimal", "low", "medium", "high"],
    "effort policies follow the refreshed model's metadata",
  );
  assert.deepEqual(c.published[0].definition.slots, allSlotDefinitions("fixture/fresh", "high"));
});

test("a host runtime without the selector's four methods fails closed", async (t) => {
  const f = await fixture(t);
  for (const runtime of [
    undefined,
    { getAvailableSnapshot: () => [], getModel: () => undefined, getError: () => undefined },
  ]) {
    const c = tuiControls(f, { inputs: ["custom"], modelRuntime: runtime });
    await assert.rejects(c.ui.editPreset(), { code: "MODEL_SELECTOR_UNAVAILABLE" });
    assert.deepEqual(c.published, []);
  }
});

test("rpc mode keeps the supported legacy list and never mounts the native picker", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, {
    mode: "rpc",
    inputs: ["custom"],
    selects: strengths.flatMap(() => ["fixture/worker", "inherit"]),
    confirms: [true],
  });
  await c.ui.editPreset();
  assert.deepEqual(c.pickers, [], "no native component in rpc mode");
  assert.deepEqual(
    c.selectPrompts.map(({ prompt }) => prompt),
    descendingSlots.flatMap((slot) => [
      `custom: ${slot} model (new Agents only)`,
      `custom: ${slot} default effort`,
    ]),
  );
  assert.equal(c.published.length, 1);
});

test("Tab toggles the native scope; scoped and all selections both reach the definition", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, {
    registry: [worker, heavy, virtual],
    inputs: ["custom"],
    selects: strengths.map(() => "inherit"),
    confirms: [true],
    scopedModels: [{ model: heavy, thinkingLevel: "high" }],
  });
  const editing = c.ui.editPreset();
  try {
    const light = await waitForPicker(c, 0);
    const scopedText = paint(light);
    assert(scopedText.includes("Scope: all | scoped"), "the native scope row is shown");
    assert(scopedText.includes("heavy"), "the scoped list starts with the session's scoped model");
    assert(!scopedText.includes("worker"), "the all-list stays out of the scoped view");
    light.component.handleInput("w"); // scoped: no match yet
    assert(
      paint(light).includes("No matching models"),
      "the scoped filter only sees scoped models",
    );
    for (const key of ["\x7f"]) light.component.handleInput(key);
    light.component.handleInput("\t"); // all
    const allText = paint(light);
    assert(
      allText.includes("worker") && allText.includes("heavy"),
      "Tab shows the full physical list",
    );
    assert(!allText.includes("virtual-worker"), "the all list is virtual-free");
    light.component.handleInput("\t"); // scoped again
    assert(!paint(light).includes("worker"), "Tab returns to the scoped list");
    light.component.handleInput("\r"); // scoped: the heavy model itself
    const standard = await waitForPicker(c, 1);
    assert(!paint(standard).includes("worker"), "each picker starts scoped");
    standard.component.handleInput("\t"); // all
    for (const key of ["w", "o", "r", "k"]) standard.component.handleInput(key);
    standard.component.handleInput("\r");
    for (let index = 2; index < strengths.length; index++) {
      const slotPicker = await waitForPicker(c, index);
      assert(
        paint(slotPicker).includes("heavy") && !paint(slotPicker).includes("worker"),
        "the scoped default returns",
      );
      slotPicker.component.handleInput("\r"); // scoped: the heavy model itself
    }
  } finally {
    for (const entry of c.pickers) entry.component.dispose?.();
  }
  await editing;
  assert.deepEqual(
    c.selectPrompts.map(({ prompt }) => prompt),
    descendingSlots.map((slot) => `custom: ${slot} default effort`),
  );
  // Effort stays its own dialog: options follow each selected model's
  // metadata, never the scoped entry's thinkingLevel hint.
  assert.deepEqual(
    c.selectPrompts[0].choices,
    ["Keep inherit", "inherit", "off", "minimal", "low", "medium", "high"],
    "the heavy model's own metadata drives its effort options",
  );
  assert(
    !c.selectPrompts[0].choices.includes("Keep high"),
    "the scoped thinkingLevel is not pre-applied",
  );
  assert.deepEqual(
    c.selectPrompts[1].choices,
    ["Keep inherit", "inherit", "off"],
    "the worker model's metadata drives its effort options",
  );
  assert.equal(c.published.length, 1);
  assert.deepEqual(c.published[0].definition.slots, {
    d1: { model: "fixture/heavy", effort: "inherit" },
    d2: { model: "fixture/heavy", effort: "inherit" },
    d3: { model: "fixture/heavy", effort: "inherit" },
    d4: { model: "fixture/worker", effort: "inherit" },
    d5: { model: "fixture/heavy", effort: "inherit" },
  });
});

test("a scoped virtual entry is filtered once and never leaks through Tab", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, {
    registry: [worker, heavy, virtual],
    inputs: ["custom"],
    scopedModels: [{ model: virtual, thinkingLevel: "low" }, { model: worker }],
  });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(paint(light).includes("Scope: all | scoped"), "the filtered scope stays present");
  assert(paint(light).includes("worker"), "the physical scoped entry is listed");
  assert(!paint(light).includes("virtual-worker"), "the virtual scoped entry is filtered");
  light.component.handleInput("\t"); // all
  assert(!paint(light).includes("virtual-worker"), "the all list stays virtual-free too");
  light.component.handleInput("\t"); // scoped
  assert(!paint(light).includes("virtual-worker"), "Tab back still leaks nothing");
  light.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("an empty session scope keeps the native picker in all mode with no toggle", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], scopedModels: [] });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(!paint(light).includes("Scope:"), "no scope row for an unscoped session");
  assert(paint(light).includes("worker"), "the full physical list shows");
  light.component.handleInput("\t");
  const after = paint(light);
  assert(!after.includes("Scope:"), "Tab creates no scope for an unscoped session");
  assert(after.includes("worker"), "the list is unchanged by the inert toggle");
  light.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("each picker re-reads the session scope getter, so a mid-session change applies next slot", async (t) => {
  const f = await fixture(t);
  const scope = { current: [{ model: heavy, thinkingLevel: "high" }] };
  const c = tuiControls(f, {
    registry: [worker, heavy],
    inputs: ["custom"],
    selects: ["inherit"],
    scopedModels: () => scope.current,
  });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  assert(
    paint(light).includes("heavy") && !paint(light).includes("worker"),
    "the first picker reads the initial scope",
  );
  light.component.handleInput("\r"); // scoped: heavy
  scope.current = [{ model: worker }];
  const standard = await waitForPicker(c, 1);
  const standardText = paint(standard);
  assert(standardText.includes("worker"), "the next picker reads the changed scope");
  assert(!standardText.includes("heavy"), "the stale scope does not linger");
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, [], "the flow is cancelled at the second slot");
});

test("the scope array and its model metadata are never rewritten by the picker", async (t) => {
  const f = await fixture(t);
  const scopeEntry = { model: { ...heavy }, thinkingLevel: "high" };
  const scope = [scopeEntry];
  Object.freeze(scopeEntry.model);
  Object.freeze(scopeEntry);
  Object.freeze(scope);
  const before = structuredClone(scope);
  const c = tuiControls(f, {
    registry: [worker, heavy],
    inputs: ["custom"],
    selects: ["inherit"],
    scopedModels: scope,
  });
  const editing = c.ui.editPreset();
  const light = await waitForPicker(c, 0);
  light.component.handleInput("\r"); // scoped: heavy, via a refreshed model copy
  const standard = await waitForPicker(c, 1);
  standard.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(scope, before, "the frozen scope is byte-for-byte unchanged");
  assert.deepEqual(c.registry.models[1], heavy, "the registry metadata object is untouched");
  assert.deepEqual(c.published, []);
});

test("a host whose scope getter yields no array fails closed instead of fabricating a scope", async (t) => {
  const f = await fixture(t);
  const c = tuiControls(f, { inputs: ["custom"], scopedModels: () => undefined });
  await assert.rejects(c.ui.editPreset(), { code: "MODEL_SELECTOR_UNAVAILABLE" });
  assert.deepEqual(c.pickers, [], "no native component mounted");
  assert.deepEqual(c.published, []);
});

// Single-slot edits use the real router candidate/audit primitives and the real
// native selector. Doubles supply only catalogue IO and the operator's answers.
test("config slot.thinking is rejected exactly and does not rewrite live catalogues", async (t) => {
  const f = await fixture(t);
  const catalogueBefore = await readFile(f.path, "utf8");
  const revision = f.router.prepare().revision;
  const message =
    "Invalid settings: preset slot d3 thinking is not configurable; inherited thinking is resolved by the consumer (no automatic migration)";
  const body = team();
  body.slots.d3 = { ...body.slots.d3, thinking: { low: "medium" } };
  assert.throws(
    () => validateSettings({ version: 2, presets: { team: body } }),
    (error) => {
      assert.equal(error.message, message);
      return true;
    },
  );
  assert.equal(
    validateSettings({ version: 2, presets: { team: team() } }).presets.team.slots.d1.model,
    "fixture/worker",
  );
  assert.deepEqual(f.store.pending(), []);
  const rejectedPath = join(f.root, "rejected-presets.json");
  const rejected = structuredClone(f.config);
  rejected.presets.team.slots.d3 = { ...rejected.presets.team.slots.d3, thinking: { low: "high" } };
  const bytes = JSON.stringify(rejected);
  await writeFile(rejectedPath, bytes);
  assert.throws(
    () => new PresetRouter(rejectedPath),
    (error) => {
      assert.equal(error.code, "INVALID_PRESET_CONFIG");
      assert.equal(error.details.error, "Preset team.slots.d3 has unsupported field: thinking");
      return true;
    },
  );
  assert.equal(
    await readFile(rejectedPath, "utf8"),
    bytes,
    "rejection does not rewrite the rejected config",
  );
  assert.equal(
    await readFile(f.path, "utf8"),
    catalogueBefore,
    "the loaded catalogue is not rewritten",
  );
  assert.equal(f.router.current().name, "off");
  assert.equal(f.router.prepare().revision, revision);
  assert.deepEqual(f.store.pending(), []);
});

test("full slot-object preset editing preserves kept models and default effort without storing thinking", async (t) => {
  const overrides = { d1: "medium", d5: "off" };
  const f = await singleSlotFixture(t, { overrides }),
    original = f.router.definition("team");
  const answers = descendingSlots.flatMap((slot) => [
    slot === "d3" ? "fixture/fresh" : `Keep ${original.slots[slot].model}`,
    `Keep ${original.slots[slot].effort}`,
  ]);
  const c = controls(f, answers, [true]);
  c.ctx.modelRegistry.getAll = () => richModels;
  await c.ui.editPreset("team");
  assert.equal(c.published.length, 1);
  assertOnlySlotChanged(c.published[0].definition, original, "d3", "fixture/fresh");
  assert.deepEqual(
    f.router.definition("team"),
    original,
    "unpublished editor data cannot mutate the catalogue",
  );
  assert.deepEqual(
    f.router.current().effort_overrides,
    overrides,
    "slot defaults never rewrite session overrides",
  );
});

test("a single model edit retains an omitted inherit default and other slots' models", async (t) => {
  const f = await fixture(t);
  f.config.presets.team.slots.d3 = { model: "fixture/worker" };
  await writeFile(f.path, JSON.stringify(f.config));
  f.router = new PresetRouter(f.path);
  f.router.select("team");
  const original = f.router.definition("team"),
    c = controls(f, ["fixture/other"]);
  c.ctx.modelRegistry.getAll = () =>
    ["worker", "other"].map((id) => ({
      provider: "fixture",
      id,
      api: "fixture",
      reasoning: false,
    }));
  await c.ui.editModel("team", "d3");
  assertOnlySlotChanged(c.published[0].definition, original, "d3", "fixture/other");
  assert.deepEqual(
    c.published[0].definition.slots.d3,
    { model: "fixture/other", effort: "inherit" },
    "an omitted default keeps its inherited meaning",
  );
  assert.deepEqual(c.published[0].definition.slots.d2, { model: "fixture/worker", effort: "low" });
  assert.equal(
    Object.hasOwn(f.router.current(), "thinking"),
    false,
    "normalized snapshots do not carry thinking maps",
  );
  assert.deepEqual(
    f.router.current().effort_defaults.d3,
    "inherit",
    "normalized snapshots still resolve the omitted policy",
  );
  assert.deepEqual(
    f.router.current().effort_overrides,
    {},
    "a model edit does not rewrite independent session overrides",
  );
});

for (const slot of strengths) {
  test(`single-slot ${slot} edit preserves other models, fixed defaults and independent session effort overrides`, async (t) => {
    const overrides = { d1: "medium", d2: "high", d3: "off", d4: "low", d5: "off" };
    const f = await singleSlotFixture(t, { overrides }),
      original = f.router.definition("team");
    const before = await readFile(f.path, "utf8"),
      revision = f.router.prepare().revision,
      audits = [];
    f.store.setScope("global");
    const c = tuiControls(f, {
      registry: richModels,
      publishDefinition: (candidate, name, definition) => {
        assert.deepEqual(
          f.store.pending(),
          [],
          "only the publisher can stage a successfully audited definition",
        );
        const previous = f.router.current();
        const selected = f.router.inspect(candidate).find((item) => item.name === name);
        const next = f.router.apply(
          candidate,
          name,
          (snapshot) => audits.push(snapshot),
          selected.effort_overrides,
        );
        f.store.stage("global", ["presets", name], definition);
        stageWorkerSelection(f.store, next, previous, false);
      },
    });
    const editing = c.ui.editModel("team", slot);
    const picker = await waitForPicker(c, 0);
    assert.match(paint(picker), new RegExp(`team: ${slot} model`));
    assert.deepEqual(
      f.router.definition("team"),
      original,
      "a mounted picker is not a publication",
    );
    chooseNative(picker, "fresh");
    await editing;
    assert.equal(
      c.pickers.length,
      1,
      "one click edits exactly one slot, not the full five-slot workflow",
    );
    assert.deepEqual(c.selectPrompts, [], "fixed default effort is not edited or silently clamped");
    assert.deepEqual(c.inputPrompts, []);
    assert.deepEqual(
      c.confirmPrompts,
      [],
      "explicit native selection for the active preset needs no second approval",
    );
    assert.equal(c.published.length, 1);
    assert.equal(c.published[0].candidate.revision, revision);
    assertOnlySlotChanged(c.published[0].definition, original, slot, "fixture/fresh");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].effort_overrides, overrides);
    assert.deepEqual(f.router.current().effort_overrides, overrides);
    assert.deepEqual(
      f.router.current().effort_defaults,
      Object.fromEntries(strengths.map((key) => [key, original.slots[key].effort])),
    );
    assert.deepEqual(f.store.pending(), [
      { scope: "global", path: ["presets", "team"], value: c.published[0].definition },
    ]);
    assert.equal(
      await readFile(f.path, "utf8"),
      before,
      "the base catalogue and permission profiles are not rewritten",
    );
    await assert.rejects(readFile(f.store.paths.global), { code: "ENOENT" });
  });
}

test("single-slot same-model selection is an exact no-op without confirmation, publication or dirty state", async (t) => {
  const f = await singleSlotFixture(t),
    original = f.router.definition("team"),
    revision = f.router.prepare().revision;
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "d1");
  const picker = await waitForPicker(c, 0);
  assert(
    paint(picker).includes("✓"),
    "the exact existing model is preselected by the native component",
  );
  picker.component.handleInput("\r");
  await editing;
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.router.definition("team"), original);
  assert.equal(f.router.prepare().revision, revision);
});

test("single-slot native cancellation leaves the definition, defaults and catalogue unchanged", async (t) => {
  const f = await singleSlotFixture(t),
    original = f.router.definition("team"),
    before = await readFile(f.path, "utf8");
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "d3");
  const picker = await waitForPicker(c, 0);
  picker.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(c.selectPrompts, []);
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.router.definition("team"), original);
  assert.equal(await readFile(f.path, "utf8"), before);
});

for (const accepted of [false, true]) {
  test(`editing an inactive preset's single slot requires explicit enable consent (${accepted})`, async (t) => {
    const f = await singleSlotFixture(t, { active: false }),
      original = f.router.definition("team");
    const c = tuiControls(f, {
      registry: richModels,
      confirms: [accepted],
      publishDefinition: (candidate, name) => f.router.apply(candidate, name, () => {}),
    });
    const editing = c.ui.editModel("team", "d3");
    const picker = await waitForPicker(c, 0);
    chooseNative(picker, "fresh");
    await editing;
    assert.equal(c.confirmPrompts.length, 1);
    assert.equal(c.confirmPrompts[0].title, "Change d3 model and enable team?");
    assert(c.confirmPrompts[0].text.includes("fixture/fresh"));
    assert.equal(c.published.length, accepted ? 1 : 0);
    assert.deepEqual(f.store.pending(), []);
    assert.equal(f.router.current().name, accepted ? "team" : "off");
    if (accepted) assertOnlySlotChanged(c.published[0].definition, original, "d3", "fixture/fresh");
    else assert.deepEqual(f.router.definition("team"), original);
  });
}

for (const change of ["removed", "virtual"]) {
  test(`single-slot selection fails fresh registry validation when the painted model becomes ${change}`, async (t) => {
    const f = await singleSlotFixture(t),
      original = f.router.definition("team");
    const c = tuiControls(f, {
      registry: richModels,
      runtimeDouble: (models) => runtimeDouble({ models: [...models] }),
    });
    const editing = c.ui.editModel("team", "d1");
    const rejected = assert.rejects(editing, { code: "PRESET_MODEL_UNAVAILABLE" });
    const picker = await waitForPicker(c, 0);
    const index = c.registry.models.findIndex((model) => model.id === "fresh");
    c.registry.models.splice(
      index,
      1,
      ...(change === "virtual" ? [{ ...fresh, api: "pi-virtual" }] : []),
    );
    chooseNative(picker, "fresh"); // The real native snapshot still contains the old physical model.
    await rejected;
    assert.deepEqual(c.published, []);
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(f.store.pending(), []);
    assert.deepEqual(f.router.definition("team"), original);
  });
}

test("single-slot stale routing revision fails closed instead of overwriting a newer selection", async (t) => {
  const f = await singleSlotFixture(t),
    original = f.router.definition("team");
  const c = tuiControls(f, { registry: richModels, confirms: [true] });
  const editing = c.ui.editModel("team", "d5");
  const rejected = assert.rejects(editing, { code: "STALE_PRESET_SELECTION" });
  const picker = await waitForPicker(c, 0);
  f.router.select("off");
  chooseNative(picker, "fresh");
  await rejected;
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  assert.equal(f.router.current().name, "off");
  assert.deepEqual(f.router.definition("team"), original);
});

test("single-slot session retirement and missing UI cannot publish or stage a model choice", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { registry: richModels });
  const editing = c.ui.editModel("team", "d1");
  const rejected = assert.rejects(editing, { code: "SETTINGS_SESSION_CHANGED" });
  const picker = await waitForPicker(c, 0);
  c.retire();
  chooseNative(picker, "fresh");
  await rejected;
  assert.deepEqual(c.published, []);
  assert.deepEqual(f.store.pending(), []);
  const noUi = tuiControls(f, { registry: richModels });
  noUi.ctx.hasUI = false;
  await assert.rejects(noUi.ui.editModel("team", "d1"), { code: "SETTINGS_UI_REQUIRED" });
  assert.deepEqual(noUi.pickers, []);
});

test("single-slot invalid preset/off/slot arguments throw OrchestrationError before opening any native picker", async (t) => {
  const f = await singleSlotFixture(t);
  for (const [name, slot] of [
    ["missing", "d1"],
    ["off", "d1"],
    ["team", "all"],
    ["team", "light"],
  ]) {
    const c = tuiControls(f, { registry: richModels });
    await assert.rejects(c.ui.editModel(name, slot), { name: "OrchestrationError" });
    assert.deepEqual(c.pickers, []);
    assert.deepEqual(c.selectors, []);
    assert.deepEqual(c.state.refreshCalls, []);
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(c.published, []);
    assert.deepEqual(f.store.pending(), []);
  }
});

test("native model popover uses dynamic near-click absolute placement and clamps after resize", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { ...floating, registry: richModels });
  const editing = c.ui.editModel("team", "d1", { row: 3, col: 5 });
  const picker = await waitForPicker(c, 0),
    before = overlayConfig(picker);
  boundedOverlay(before, c.tui.terminal);
  assert.equal(before.row, 4, "the picker opens immediately below the absolute click row");
  assert.equal(before.col, 5);
  const originalBounds = measuredOverlay(picker, c.tui.terminal);
  assert.equal(originalBounds.row, 4);
  assert.equal(originalBounds.col, 5);
  c.tui.terminal.rows = 9;
  c.tui.terminal.columns = 34;
  const after = overlayConfig(picker);
  boundedOverlay(after, c.tui.terminal);
  assert.notDeepEqual(after, before, "placement is not frozen to the original terminal dimensions");
  measuredOverlay(picker, c.tui.terminal);
  picker.component.handleInput("\u001b");
  await editing;
  assert.deepEqual(c.published, []);
});

test("native model popover with no click position is centered rather than using stale coordinates", async (t) => {
  const f = await singleSlotFixture(t);
  const c = tuiControls(f, { ...floating, registry: richModels });
  const editing = c.ui.editModel("team", "d1");
  const picker = await waitForPicker(c, 0),
    config = overlayConfig(picker);
  boundedOverlay(config, c.tui.terminal);
  assert.equal(config.anchor ?? "center", "center");
  assert.equal(config.row, undefined, "the native center anchor owns row placement");
  assert.equal(config.col, undefined, "the native center anchor owns column placement");
  const bounds = measuredOverlay(picker, c.tui.terminal);
  assert.equal(bounds.row, Math.floor((c.tui.terminal.rows - bounds.height) / 2));
  assert.equal(bounds.col, Math.floor((c.tui.terminal.columns - bounds.width) / 2));
  picker.component.handleInput("\u001b");
  await editing;
});

for (const modelPopover of [undefined, () => false]) {
  test(`native model picker stays docked when popover capability is ${modelPopover ? "false" : "absent"}`, async (t) => {
    const f = await singleSlotFixture(t);
    const c = tuiControls(f, { registry: richModels, modelPopover, tuiMode: "regular" });
    const editing = c.ui.editModel("team", "d1", { row: 8, col: 20 });
    const picker = await waitForPicker(c, 0);
    assert.notEqual(picker.options?.overlay, true);
    assert.match(paint(picker), /team: d1 model/);
    picker.component.handleInput("\u001b");
    await editing;
    assert.deepEqual(c.published, []);
  });
}

test("floating native selector retains rounded frame, IME search focus and native Tab scope filtering", async (t) => {
  const f = await fixture(t);
  f.router.select("team");
  const c = tuiControls(f, {
    ...floating,
    registry: [worker, heavy, virtual],
    scopedModels: [{ model: worker }],
  });
  const editing = c.ui.editModel("team", "d1");
  const picker = await waitForPicker(c, 0),
    native = c.selectors[0];
  assert.equal(
    picker.component.capturesViewportInput,
    true,
    "the floating presentation also preserves the native viewport-input capability",
  );
  const lines = picker.component.render(74).map(stripTerminalSequences);
  assert(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
  assert(lines[0].includes("×"));
  assert(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
  assert(lines.every((line) => visibleWidth(line) <= 74));
  picker.component.focused = true;
  assert.equal(native.focused, true);
  assert.equal(native.getSearchInput().focused, true, "IME focus reaches the actual native Input");
  picker.component.focused = false;
  assert.equal(native.getSearchInput().focused, false);
  assert(paint(picker).includes("Scope: all | scoped"));
  assert(!paint(picker).includes("heavy"), "the initial scope is the real session scope");
  picker.component.handleInput("\t");
  assert(paint(picker).includes("heavy"));
  for (const key of "hea") picker.component.handleInput(key);
  assert.equal(native.getSearchInput().getValue(), "hea");
  assert(paint(picker).includes("heavy"));
  assert(!paint(picker).includes("virtual-worker"));
  picker.component.handleInput("\t");
  assert(paint(picker).includes("No matching models"));
  assert.equal(native.getSearchInput().getValue(), "hea", "Tab preserves the native search text");
  picker.component.handleInput("\t");
  const namedLines = picker.component.render(74).map(stripTerminalSequences);
  assert(
    namedLines.some((line) => line.includes("heavy (Fixture Heavy) [fixture]")),
    "the real Pi 1.5 selector paints a distinct model name before the provider",
  );
  assert.match(
    namedLines.join("\n"),
    /→.*heavy/,
    "the restored selection is painted before Enter can accept it",
  );
  picker.component.handleInput("\r");
  await editing;
  assert.equal(c.published[0].definition.slots.d1.model, "fixture/heavy");
  assert.deepEqual(c.confirmPrompts, []);
  assert.deepEqual(f.store.pending(), []);
});

for (const input of ["keyboard", "continuation click"]) {
  test(
    `fully visible wrapped native model labels remain selectable via ${input}`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      f.router.select("team");
      const long = {
        ...worker,
        id: "very-long-physical-model-id-which-exceeds-the-popover-width",
        name: "Long",
      };
      const c = tuiControls(f, { ...floating, rows: 24, columns: 34, registry: [worker, long] });
      const editing = c.ui.editModel("team", "d1");
      const picker = await waitForPicker(c, 0);
      picker.component.render(34);
      picker.component.handleInput("\u001b[B");
      const lines = picker.component.render(34).map(stripTerminalSequences);
      assert(lines.some((line) => line.includes("[fixture]")));
      assert(
        picker.component.canSelect(),
        "a wrapped arrow and complete visible model group are a real selection",
      );
      if (input === "keyboard") picker.component.handleInput("\r");
      else {
        const y = lines.findIndex((line) => line.includes("h-exceeds-the-popover-width"));
        assert(y > 0, lines.join("\n"));
        mouseClick(picker, 3, y, 34, lines.length);
      }
      await editing;
      assert.equal(c.published[0].definition.slots.d1.model, `fixture/${long.id}`);
      assert.deepEqual(f.store.pending(), []);
    },
  );
}

test(
  "floating native mouse selection hits actual Pi 1.5 model-name text, never padding or stale rows",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
    const editing = c.ui.editModel("team", "d3");
    const picker = await waitForPicker(c, 0),
      width = 72;
    let lines = picker.component.render(width).map(stripTerminalSequences);
    const oldRow = lines.findIndex((line) => line.includes("heavy") && line.includes("[fixture]"));
    assert(oldRow >= 0, "a real native item, not a fixture-synthesized row, is painted");
    assert.match(
      lines[oldRow],
      /heavy \(Fixture Heavy\) \[fixture\]/,
      "the native row includes Pi 1.5's distinct name",
    );
    const oldX = lines[oldRow].indexOf("heavy");
    mouseClick(picker, width - 3, oldRow, width, lines.length);
    mouseClick(picker, 0, oldRow, width, lines.length);
    assert.equal(picker.settled, false, "right padding and the frame edge have no model target");
    for (const key of "work") picker.component.handleInput(key);
    mouseClick(picker, oldX, oldRow, width, lines.length);
    assert.equal(
      picker.settled,
      false,
      "a formerly-painted heavy row cannot survive filtering even before repaint",
    );
    for (const key of ["\x7f", "\x7f", "\x7f", "\x7f"]) picker.component.handleInput(key);
    lines = picker.component.render(width).map(stripTerminalSequences);
    const row = lines.findIndex((line) => line.includes("heavy") && line.includes("[fixture]"));
    const nameX = lines[row].indexOf("Fixture Heavy") + 2;
    assert(!lines[row].includes("→"), "pointer selection need not match the keyboard arrow");
    mouseClick(picker, nameX, row, width, lines.length);
    assert.equal(picker.settled, true, "clicking another visible model must settle the picker");
    await editing;
    assert.equal(c.published.length, 1);
    assert.equal(c.published[0].definition.slots.d3.model, "fixture/heavy");
    for (const slot of ["d1", "d2", "d4", "d5"])
      assert.equal(c.published[0].definition.slots[slot].model, "fixture/worker");
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(f.store.pending(), []);
  },
);

test(
  "fullscreen inline native selector forwards viewport-input capture",
  { timeout: 5000 },
  async (t) => {
    const f = await singleSlotFixture(t);
    const c = tuiControls(f, {
      tuiMode: "fullscreen",
      modelPopover: () => false,
      registry: richModels,
    });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0),
      native = c.selectors[0];
    assert.equal(c.tui.mode, "fullscreen");
    assert.equal(native.capturesViewportInput, true);
    assert.equal(
      picker.component.capturesViewportInput,
      true,
      "the focused inline custom component must keep viewport shortcuts with Pi's selector",
    );
    picker.component.handleInput("\u001b");
    await editing;
    assert.deepEqual(c.published, []);
  },
);

test(
  "floating native × closes only its own model selection without publishing or dirtying settings",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0),
      width = 68;
    const lines = picker.component.render(width).map(stripTerminalSequences),
      x = lines[0].indexOf("×");
    assert(x > 0);
    mouseClick(picker, x, 0, width, lines.length);
    await editing;
    assert.equal(picker.settled, true);
    assert.deepEqual(c.published, []);
    assert.deepEqual(c.confirmPrompts, []);
    assert.deepEqual(f.store.pending(), []);
  },
);

test(
  "short native popovers keep the selected arrow, input and scope visible rather than blindly accepting a hidden model",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    const many = Array.from({ length: 24 }, (_unused, index) => ({
      ...worker,
      id: `slot-${String(index).padStart(2, "0")}`,
      name: `Slot ${index}`,
    }));
    const c = tuiControls(f, {
      ...floating,
      registry: [worker, ...many],
      scopedModels: [{ model: worker }],
    });
    const editing = c.ui.editModel("team", "d5");
    const picker = await waitForPicker(c, 0);
    picker.component.handleInput("\t");
    for (const key of "slot") picker.component.handleInput(key);
    for (let index = 0; index < 18; index++) picker.component.handleInput("\u001b[B");
    assert.match(paint(picker), /→.*slot-18/);
    c.tui.terminal.rows = 10;
    c.tui.terminal.columns = 36;
    const config = overlayConfig(picker),
      lines = picker.component.render(36).map(stripTerminalSequences);
    assert(lines.length <= config.maxHeight && lines.length <= c.tui.terminal.rows);
    assert(lines.every((line) => visibleWidth(line) <= 36));
    assert(
      lines.some((line) => /→.*slot-18/.test(line)),
      "the native selected model survives viewport compression",
    );
    assert(lines.some((line) => line.includes("Scope: all | scoped")));
    assert(
      lines.some((line) => line.includes("> slot")),
      "the actual search Input stays visible",
    );
    picker.component.handleInput("\r");
    await editing;
    assert.equal(
      c.published[0].definition.slots.d5.model,
      "fixture/slot-18",
      "Enter accepts exactly the visible arrow row",
    );
    assert.deepEqual(f.store.pending(), []);
  },
);

// These view-only cases never start a terminal or a provider. Keep every
// interaction bounded so a broken selection cannot hang the portable gate.
for (const viewport of [
  { rows: 4, columns: 100 },
  { rows: 28, columns: 10 },
]) {
  test(
    `a painted pointer model cannot be applied after shrinking to ${viewport.rows}x${viewport.columns} before repaint`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      f.router.select("team");
      const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
      const editing = c.ui.editModel("team", "d1");
      const picker = await waitForPicker(c, 0),
        width = 72;
      const lines = picker.component.render(width).map(stripTerminalSequences);
      const row = lines.findIndex((line) => line.includes("heavy") && line.includes("[fixture]"));
      assert(row >= 0);
      Object.assign(c.tui.terminal, viewport);
      mouseClick(picker, lines[row].indexOf("heavy"), row, width, lines.length);
      assert.equal(
        picker.settled,
        false,
        "a pointer must recheck the current viewport, not the previous paint",
      );
      assert.deepEqual(c.published, []);
      c.ui.cancelModelSelection();
      await editing;
      assert.deepEqual(f.store.pending(), []);
    },
  );
}

for (const keyboardRecheck of [false, true]) {
  test(
    `dry ${keyboardRecheck ? "keyboard" : "pointer"} rechecks cannot authorize repeated clicks on an unpainted replacement`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      f.router.select("team");
      const c = tuiControls(f, { ...floating, registry: [worker, heavy] });
      const editing = c.ui.editModel("team", "d1");
      const picker = await waitForPicker(c, 0),
        width = 72;
      const lines = picker.component.render(width).map(stripTerminalSequences);
      const row = lines.findIndex((line) => line.includes("worker") && line.includes("[fixture]"));
      assert(row >= 0);
      const x = lines[row].indexOf("worker");
      for (const key of "hea") picker.component.handleInput(key);
      if (keyboardRecheck) assert.equal(picker.component.canSelect(worker), false);
      for (let click = 0; click < 2; click++) {
        mouseClick(picker, x, row, width, lines.length);
        assert.equal(
          picker.settled,
          false,
          "dry rechecks cannot replace the last-painted model identity",
        );
      }
      assert.deepEqual(c.published, []);
      c.ui.cancelModelSelection();
      await editing;
      assert.deepEqual(f.store.pending(), []);
    },
  );
}

for (const change of ["removed", "ambiguous"]) {
  test(
    `Enter on an unverified ${change} registry item warns and settles without applying`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      f.router.select("team");
      const before = f.router.definition("team");
      const c = tuiControls(f, {
        ...floating,
        registry: [worker, heavy],
        runtimeDouble: (models) => runtimeDouble({ models: [...models], pending: true }),
      });
      const editing = c.ui.editModel("team", "d1");
      const picker = await waitForPicker(c, 0);
      picker.component.render(74);
      c.registry.models.splice(0, 1, ...(change === "ambiguous" ? [worker, { ...worker }] : []));
      picker.component.handleInput("\r");
      assert.equal(
        picker.settled,
        true,
        "a disposed native selector must not strand the edit on identity failure",
      );
      await editing;
      assert(
        c.notifications.some(
          ({ text, level }) =>
            level === "warning" && /could not be verified.*Nothing changed.*reopen/.test(text),
        ),
      );
      assert.deepEqual(c.published, []);
      assert.deepEqual(f.store.pending(), []);
      assert.deepEqual(f.router.definition("team"), before);
    },
  );
}

test(
  "a previously visible model cannot be applied after the viewport shrinks before repaint",
  { timeout: 5000 },
  async (t) => {
    const f = await singleSlotFixture(t);
    const c = tuiControls(f, { ...floating, registry: richModels });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0);
    picker.component.render(74);
    assert.equal(picker.component.canSelect(), true);
    assert.equal(
      picker.component.canSelect({ provider: "missing", id: "hidden" }),
      false,
      "an identified tree cannot authorize a different model",
    );
    c.tui.terminal.rows = 4;
    c.tui.terminal.columns = 10;
    picker.component.handleInput("\r");
    await tick();
    assert.equal(
      picker.settled,
      false,
      "Enter must recheck the current viewport, not the previous paint",
    );
    assert.equal(picker.component.canSelect(), false);
    assert(
      c.notifications.some(
        ({ text, level }) => level === "warning" && /not fully visible/.test(text),
      ),
    );
    assert.deepEqual(c.published, []);
    c.ui.cancelModelSelection();
    await editing;
    assert.deepEqual(f.store.pending(), []);
  },
);

test(
  "a hidden keyboard choice warns then can apply after enlarging and repainting",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    const c = tuiControls(f, { ...floating, rows: 4, columns: 10, registry: [worker, heavy] });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0);
    picker.component.render(8);
    picker.component.handleInput("\r");
    assert.equal(picker.settled, false);
    assert(
      c.notifications.some(
        ({ text, level }) => level === "warning" && /not fully visible/.test(text),
      ),
    );
    Object.assign(c.tui.terminal, { rows: 28, columns: 100 });
    for (const key of "hea") picker.component.handleInput(key);
    assert.match(paint(picker, 74), /→.*heavy/);
    picker.component.handleInput("\r");
    assert.equal(picker.settled, true);
    await editing;
    assert.equal(c.published.length, 1);
    assert.equal(c.published[0].definition.slots.d1.model, "fixture/heavy");
    assert.deepEqual(f.store.pending(), []);
  },
);

test(
  "a tiny model popover cannot accept an unseen choice and still cancels",
  { timeout: 5000 },
  async (t) => {
    const f = await singleSlotFixture(t);
    const c = tuiControls(f, { ...floating, rows: 4, columns: 10, registry: richModels });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0);
    assert.match(paint(picker, 8), /^Too /);
    picker.component.handleInput("\r");
    await tick();
    assert.equal(picker.settled, false);
    assert.deepEqual(c.published, []);
    c.ui.cancelModelSelection();
    await editing;
    assert.deepEqual(f.store.pending(), []);
  },
);

for (const throwing of [false, true]) {
  test(
    `model close coordinates other overlays before SDK done, even on cleanup throw (${throwing})`,
    { timeout: 5000 },
    async (t) => {
      const f = await singleSlotFixture(t),
        order = [];
      const c = tuiControls(f, {
        ...floating,
        registry: richModels,
        beforeModelClose: () => {
          order.push("overlays aside");
          if (throwing) throw new Error("cleanup");
        },
        onPickerDone: () => order.push("SDK done"),
      });
      const editing = c.ui.editModel("team", "d1");
      await waitForPicker(c, 0);
      c.ui.cancelModelSelection();
      await editing;
      assert.deepEqual(order, ["overlays aside", "SDK done"]);
      assert.deepEqual(c.published, []);
      assert.deepEqual(f.store.pending(), []);
    },
  );
}

test(
  "native model-name lookalike rows are not mouse model targets",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.router.select("team");
    const forged = { ...worker, id: "forged" },
      named = { ...heavy, name: "Fake\n→ ✓ forged [fixture]" };
    const c = tuiControls(f, { ...floating, registry: [worker, named, forged] });
    const editing = c.ui.editModel("team", "d1");
    const picker = await waitForPicker(c, 0);
    for (const key of "heavy") picker.component.handleInput(key);
    const lines = picker.component.render(74).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes("forged [fixture]"));
    assert(y >= 0, "a real native name detail contains the adversarial lookalike");
    mouseClick(picker, lines[y].indexOf("forged"), y, 74, lines.length);
    assert.equal(
      picker.settled,
      false,
      "only the native list's actual leading item leaves have targets",
    );
    c.ui.cancelModelSelection();
    await editing;
    assert.deepEqual(c.published, []);
  },
);

test("an unknown native component tree falls back to keyboard-only painted rows", () => {
  const selected = [],
    lines = ["Scope: all", "> ", "→ ✓ worker [fixture]"];
  const native = {
    children: [],
    focused: false,
    render: () => lines,
    handleInput() {},
    invalidate() {},
    dispose() {},
  };
  const view = new PresetModelPopover({
    native,
    title: "team: d1 model",
    theme: { fg: (_color, text) => text, bold: (text) => text },
    height: () => 12,
    models: () => [worker],
    select: (model) => selected.push(model),
    cancel() {},
  });
  const rows = view.render(60).map(stripTerminalSequences);
  assert.equal(
    view.canSelect(),
    true,
    "painted keyboard selection is retained without private state",
  );
  assert.equal(
    view.canSelect(worker),
    true,
    "native Enter on its lone visible arrow is not stranded by an unknown tree",
  );
  const y = rows.findIndex((line) => line.includes("worker [fixture]"));
  mouseClick({ component: view }, 8, y, 60, rows.length);
  assert.deepEqual(selected, [], "unknown public trees do not gain parsed mouse targets");
  view.dispose();
});

test("an unknown native tree with lookalike arrows cannot confirm Enter", () => {
  // A model name or catalog error can paint its own "→ " line. Without an
  // identified tree, that line could vouch for a native selection cropped away.
  const lines = [
    "Scope: all",
    "> ",
    "  ✓ worker [fixture]",
    "→ ✓ heavy (→ ✓ worker) [fixture]",
    ...Array.from({ length: 12 }, (_, index) => `    other-${index} [fixture]`),
    "→ ✓ worker [fixture]",
  ];
  const native = {
    children: [],
    focused: false,
    render: () => lines,
    handleInput() {},
    invalidate() {},
    dispose() {},
  };
  const view = new PresetModelPopover({
    native,
    title: "team: d1 model",
    theme: { fg: (_color, text) => text, bold: (text) => text },
    height: () => 8,
    models: () => [worker],
    select() {},
    cancel() {},
  });
  const rows = view.render(60).map(stripTerminalSequences);
  assert(
    !rows.some((line) => line.includes("│→ ✓ worker [fixture]")),
    "the second arrow is cropped from the popover",
  );
  assert.equal(
    view.canSelect(),
    false,
    "several native arrows do not identify the Enter selection",
  );
  assert.equal(view.canSelect(worker), false);
  assert.equal(view.selectionIssue(worker), "identity_unverified");
  view.dispose();
});
