import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PreferencesControls } from "../../dist/orchestration/ui/preferences-controls.js";
import { createPresetModelSelector } from "../../dist/orchestration/runtime/preset-model-selector.js";
import { PresetRouter, strengths } from "../../dist/orchestration/routing.js";
import { SettingsStore } from "../../src/shared/settings-store.mjs";

export const defaultEfforts = { d1: "low", d2: "low", d3: "inherit", d4: "high", d5: "high" };

export const team = (model = "worker") => ({
  version: "v1",
  slots: Object.fromEntries(
    strengths.map((slot) => [slot, { model: `fixture/${model}`, effort: defaultEfforts[slot] }]),
  ),
});

export const allSlots = (value) => Object.fromEntries(strengths.map((slot) => [slot, value]));

export const allSlotDefinitions = (model, effort) =>
  Object.fromEntries(
    strengths.map((slot) => [slot, { model, ...(effort === undefined ? {} : { effort }) }]),
  );

export const descendingSlots = ["d5", "d4", "d3", "d2", "d1"];

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "alehouse-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "alehouse-presets.json");
  const config = { version: 3, defaultPreset: "off", presets: { team: team() } };
  await writeFile(path, JSON.stringify(config));
  const store = new SettingsStore({
    agentDir: join(root, "agent"),
    cwd: join(root, "work"),
    projectTrusted: true,
  });
  return {
    root,
    path,
    store,
    config,
    router: new PresetRouter(path),
    after: (cleanup) => t.after(cleanup),
  };
}

export function controls(f, answers = [], confirmations = []) {
  const notifications = [],
    published = [],
    confirmPrompts = [],
    selectPrompts = [];
  const beerMugs = { enabled: f.store.effective().ui?.beerMugs === true, calls: [] };
  let live = true;
  const ctx = {
    hasUI: true,
    ui: {
      select: async (prompt, choices) => {
        selectPrompts.push({ prompt, choices });
        return answers.shift();
      },
      input: async () => answers.shift(),
      confirm: async (title, text) => {
        confirmPrompts.push({ title, text });
        return confirmations.shift() ?? false;
      },
      notify: (text, level) => notifications.push({ text, level }),
    },
    modelRegistry: {
      getAll: () => [{ provider: "fixture", id: "worker", api: "fixture", reasoning: false }],
    },
  };
  const ui = new PreferencesControls({
    ctx,
    store: f.store,
    router: () => f.router,
    ready: () => live,
    beerMugs: {
      current: () => beerMugs.enabled,
      set: (enabled) => {
        beerMugs.enabled = enabled;
        beerMugs.calls.push(enabled);
      },
    },
    delegation: () => f.delegation ?? { mode: "lead", eagerness: "eager" },
    publishDefinition: (candidate, name, definition) =>
      published.push({ candidate, name, definition }),
  });
  return {
    ui,
    ctx,
    beerMugs,
    notifications,
    published,
    confirmPrompts,
    selectPrompts,
    retire: () => {
      live = false;
    },
  };
}

export function nearLimitPreferences(initial, spareBytes) {
  const document = { ...initial, presets: {} },
    max = 256 * 1024;
  const bytes = () => Buffer.byteLength(JSON.stringify(document)) + 1;
  const large = {
    version: "v".repeat(64),
    slots: allSlotDefinitions(`fixture/${"m".repeat(248)}`),
  };
  let index = 0;
  while (bytes() < max) document.presets[`filler${index++}`] = structuredClone(large);
  let excess = bytes() - (max - spareBytes);
  for (const body of Object.values(document.presets).slice(-2))
    for (const slot of strengths) {
      const cut = Math.min(excess, body.slots[slot].model.length - "fixture/m".length);
      body.slots[slot].model = body.slots[slot].model.slice(0, body.slots[slot].model.length - cut);
      excess -= cut;
    }
  assert.equal(excess, 0);
  assert.equal(bytes(), max - spareBytes);
  return document;
}

// Native model picker regressions. TUI preset slots reuse /model's native
// ModelSelectorComponent through a controlled ModelRuntime double: the real
// runtime, providers, auth and network are never touched here. The double's
// model list is shared with ctx.modelRegistry.getAll() so a refresh updates
// both, exactly like a host whose catalog was refreshed while open.
initTheme(undefined, false);

export const worker = {
  provider: "fixture",
  id: "worker",
  name: "Fixture Worker",
  api: "fixture",
  reasoning: false,
};

export const virtual = {
  provider: "fixture",
  id: "virtual-worker",
  name: "Fixture Virtual",
  api: "pi-virtual",
  reasoning: false,
};

export const fresh = {
  provider: "fixture",
  id: "fresh",
  name: "Fixture Fresh",
  api: "fixture",
  reasoning: true,
  thinkingLevelMap: { high: "high" },
};

export const tick = async (count = 1) => {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
};

/** A controlled ModelRuntime double. `models` is held by reference so callers
 * decide what the registry and the selector share; `pending` keeps the
 * refresh unsettled so a dispose-driven abort is deterministic. */
export function runtimeDouble({ models = [], onRefresh, pending } = {}) {
  const state = { models, refreshCalls: [] };
  return {
    state,
    runtime: {
      getAvailableSnapshot: () => [...state.models],
      getModel: (provider, id) =>
        state.models.find((model) => model.provider === provider && model.id === id),
      getError: () => undefined,
      refresh: async (options) => {
        state.refreshCalls.push(options);
        await onRefresh?.(state);
        if (pending) await new Promise(() => {});
        return { aborted: false, errors: new Map() };
      },
    },
  };
}

/** TUI-mode controls with a scripted native ui.custom, effort selects and a
 * main-model trap that preset editing must never touch. */
export function tuiControls(f, options = {}) {
  const registry = { models: [...(options.registry ?? [worker, virtual])] };
  const double = options.runtimeDouble
    ? options.runtimeDouble(registry.models)
    : runtimeDouble({ models: registry.models });
  const notifications = [],
    published = [],
    pickers = [],
    selectors = [],
    selectPrompts = [],
    inputPrompts = [],
    confirmPrompts = [];
  const answers = [...(options.selects ?? [])],
    confirmations = [...(options.confirms ?? [])],
    typed = [...(options.inputs ?? [])];
  const beerMugs = { enabled: f.store.effective().ui?.beerMugs === true, calls: [] };
  let live = true,
    queuedFactory;
  const mockTui = {
    mode: options.tuiMode ?? "regular",
    terminal: {
      rows: options.rows ?? 30,
      columns: options.columns ?? 100,
      hideCursor() {},
      showCursor() {},
      write() {},
    },
    requestRender() {},
  };
  const themeDouble = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
  };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: f.root,
    ui: {
      select: async (prompt, choices) => {
        selectPrompts.push({ prompt, choices });
        return answers.shift();
      },
      input: async (prompt, placeholder) => {
        inputPrompts.push({ prompt, placeholder });
        return typed.shift();
      },
      confirm: async (title, text) => {
        confirmPrompts.push({ title, text });
        return confirmations.shift() ?? false;
      },
      notify: (text, level) => notifications.push({ text, level }),
      custom: (factory, uiOptions) =>
        new Promise((resolve, reject) => {
          const run = () => {
            try {
              const entry = { settled: false, options: uiOptions };
              entry.done = (value) => {
                options.onPickerDone?.(value);
                entry.settled = true;
                resolve(value);
              };
              entry.component = factory(mockTui, themeDouble, { matches: () => false }, entry.done);
              pickers.push(entry);
            } catch (error) {
              reject(error);
            }
          };
          if (options.deferCustom) queuedFactory = run;
          else run();
        }),
    },
    modelRegistry: { getAll: () => [...registry.models] },
    // The public session-scope getter: read fresh each time a picker opens,
    // exactly like the SDK runner exposes the current session's scope. A
    // function value models a live getter; undefined models a host without
    // the capability so the helper's own guard can fail closed.
    get scopedModels() {
      // An absent option models an unscoped host ([]); a getter that itself
      // yields undefined models the missing capability and must fail closed
      // in the helper, never default to a fabricated scope.
      return typeof options.scopedModels === "function"
        ? options.scopedModels()
        : (options.scopedModels ?? []);
    },
    // Preset editing must never touch the main model or its SDK defaults.
    get model() {
      throw new Error("MAIN_MODEL_TOUCHED");
    },
  };
  const ui = new PreferencesControls({
    ctx,
    store: f.store,
    router: () => f.router,
    ready: () => live,
    beerMugs: {
      current: () => beerMugs.enabled,
      set: (enabled) => {
        beerMugs.enabled = enabled;
        beerMugs.calls.push(enabled);
      },
    },
    delegation: () => ({ mode: "lead", eagerness: "eager" }),
    // The UI layer owns no runtime value import: the selector constructor is
    // injected here exactly like the extension binds the acquired host runtime.
    createModelSelector: (pickerOptions) => {
      const selector = createPresetModelSelector({
        ...pickerOptions,
        runtime: "modelRuntime" in options ? options.modelRuntime : double.runtime,
      });
      selectors.push(selector);
      return selector;
    },
    ...(options.modelPopover ? { modelPopover: options.modelPopover } : {}),
    modelSelectionAllowed: options.modelSelectionAllowed,
    beforeModelClose: options.beforeModelClose,
    publishDefinition: (candidate, name, definition) => {
      published.push({ candidate, name, definition });
      options.publishDefinition?.(candidate, name, definition);
    },
  });
  f.after(() => ui.cancelModelSelection());
  return {
    ui,
    ctx,
    beerMugs,
    tui: mockTui,
    registry,
    state: double.state,
    pickers,
    selectors,
    selectPrompts,
    inputPrompts,
    confirmPrompts,
    notifications,
    published,
    retire: () => {
      live = false;
    },
    runQueuedFactory: () => {
      const run = queuedFactory;
      queuedFactory = undefined;
      run?.();
    },
  };
}

export const waitForPicker = async (controls, index) => {
  for (let attempt = 0; attempt < 100 && controls.pickers.length <= index; attempt++) await tick();
  assert.ok(controls.pickers.length > index, `native picker ${index} never mounted`);
  return controls.pickers[index];
};

export const paint = (entry, width = 100) =>
  entry.component
    .render(width)
    .map((line) => stripTerminalSequences(line))
    .join("\n");

// Native all/scoped scope: the picker reuses the public session scope, Tab
// toggles between the host's scoped models and the full physical catalogue,
// and neither the scope array nor its metadata is ever rewritten.
export const heavy = {
  provider: "fixture",
  id: "heavy",
  name: "Fixture Heavy",
  api: "fixture",
  reasoning: true,
  thinkingLevelMap: { high: "high" },
};

export const lightBase = { ...fresh, id: "light-base", name: "Light Base" };

export const standardBase = { ...fresh, id: "standard-base", name: "Standard Base" };

export const strongBase = { ...fresh, id: "strong-base", name: "Strong Base" };

export const richModels = [lightBase, standardBase, strongBase, fresh, virtual];

export async function singleSlotFixture(t, { active = true, overrides = {} } = {}) {
  const f = await fixture(t);
  f.config.presets.team = {
    version: "fixed-v1",
    slots: {
      d1: { model: "fixture/light-base", effort: "low" },
      d2: { model: "fixture/light-base", effort: "low" },
      d3: { model: "fixture/standard-base", effort: "inherit" },
      d4: { model: "fixture/strong-base", effort: "high" },
      d5: { model: "fixture/strong-base", effort: "high" },
    },
  };
  await writeFile(f.path, JSON.stringify(f.config));
  f.router = new PresetRouter(f.path, new Map([["team", overrides]]));
  if (active) f.router.select("team");
  return f;
}

export const chooseNative = (entry, query) => {
  for (const key of query) entry.component.handleInput(key);
  assert(paint(entry).includes(query), `the native filtered list must show ${query}`);
  entry.component.handleInput("\r");
};

export const assertOnlySlotChanged = (definition, original, slot, model) => {
  assert.match(definition.version, /^user-\d+$/);
  const expected = structuredClone(original);
  expected.version = definition.version;
  expected.slots[slot].model = model;
  for (const key of strengths)
    assert.equal(Object.hasOwn(definition.slots[key], "thinking"), false);
  assert.deepEqual(
    definition,
    expected,
    "only the requested model changes; default effort stays and thinking is not stored",
  );
};

export const floating = { modelPopover: () => true, tuiMode: "fullscreen", rows: 28, columns: 100 };

export const mouseClick = (entry, x, y, width, height) =>
  entry.component.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    ctrl: false,
    alt: false,
  });

export const overlayConfig = (entry) => {
  assert.equal(entry.options?.overlay, true);
  assert.equal(
    typeof entry.options.overlayOptions,
    "function",
    "popover placement is recomputed by the native host",
  );
  return entry.options.overlayOptions();
};

export const boundedOverlay = (config, terminal) => {
  for (const key of ["width", "maxHeight"]) assert.equal(typeof config[key], "number");
  assert(config.width > 0 && config.width <= terminal.columns);
  assert(config.maxHeight > 0 && config.maxHeight <= terminal.rows);
  if (config.row !== undefined) {
    assert.equal(typeof config.row, "number");
    assert(config.row >= 0 && config.row < terminal.rows);
  }
  if (config.col !== undefined) {
    assert.equal(typeof config.col, "number");
    assert(config.col >= 0 && config.col < terminal.columns);
  }
};

export const measuredOverlay = (entry, terminal) => {
  // No terminal is started: the real compositor computes and clamps geometry
  // against the controlled terminal, rather than a permissive fake doing so.
  const host = new TuiAltScreen(terminal, false, undefined, {});
  host.requestRender = () => {};
  const handle = host.showOverlay(entry.component, overlayConfig(entry));
  try {
    for (let index = 0; index < 2; index++)
      host.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows);
    const bounds = handle.getBounds();
    assert(bounds, "the native popover is visible to the real compositor");
    assert(bounds.row >= 0 && bounds.col >= 0);
    assert(bounds.row + bounds.height <= terminal.rows);
    assert(bounds.col + bounds.width <= terminal.columns);
    return bounds;
  } finally {
    handle.hide();
  }
};
