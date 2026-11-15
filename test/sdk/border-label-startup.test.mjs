import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ExtensionRunner, initTheme } from "@earendil-works/pi-coding-agent";
import { fixture, task, until } from "../support/controller-fixture.mjs";
import { writePresetConfig } from "../support/preset-config.mjs";

// Install owned HOME/XDG before initTheme and the dynamic jiti extension graph
// below, so resource discovery on those paths cannot use the operator's state.
// Static ESM test/SDK utility imports above evaluate before this setup.
const home = await mkdtemp(join(tmpdir(), "alehouse-border-labels-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
test.after(() => rm(home, { recursive: true, force: true }));

initTheme(undefined, false);

// Direct-source jiti load of the real orchestration extension (the launcher's
// own entry), its Owner classes and the shared border-label registry: the
// committed dist build is refreshed by the full gate, so this lane pins the
// source under test. One jiti instance keeps the extension, its mounted panels
// and the chrome registry one module graph, so every assertion below observes
// the real process-wide state (`borderLabelsEnabled()`), never a fake callback.
const jiti = createJiti(import.meta.url, { fsCache: false });
const orchestrationExtension = (await jiti.import("../../src/orchestration/extension.ts")).default;
const { OwnerController } = await jiti.import("../../src/orchestration/core/owner-controller.ts");
const { FileOwnerLease } = await jiti.import("../../src/orchestration/runtime/owner-lease.ts");
const { borderLabelsEnabled } = await jiti.import("../../src/shared/popover-chrome.mjs");

/** One owner directory per test: several fresh extension instances (a same
 * process restart) share it, exactly like sequential sessions on one parent.
 * Child IO is the fixture's FakePort; the permission interface is injected, the
 * authority locator deliberately throws, and fetch fails the test. Each
 * session below opens its OWN genuine fixture Owner state machine and lease;
 * the class mocks only redirect the jiti-loaded extension's static opens to
 * the current session's live instance, never to a closed earlier one. */
async function ownerDirectory(t) {
  const h = await fixture(t);
  const c = { h, opens: { controller: 0, lease: 0 }, timers: new Set() };
  const root = h.directory,
    agentDir = join(root, "agent"),
    permissionRoot = join(root, "permission");
  const envKeys = [
    "PI_CODING_AGENT_DIR",
    "PI_ALEHOUSE_PERMISSION_ROOT",
    "PI_ALEHOUSE_POLICY_ROOT",
    "PI_ALEHOUSE_FLOCK",
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ALEHOUSE_PERMISSION_ROOT = permissionRoot;
  process.env.PI_ALEHOUSE_POLICY_ROOT = join(root, "unused-policy");
  process.env.PI_ALEHOUSE_FLOCK = "/unused-fixture-flock"; // The real fixture lease is injected below.
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writePresetConfig(join(agentDir, "alehouse-presets.json"));
  await mkdir(join(agentDir, "extensions/pi-alehouse"), { recursive: true });
  c.preferencesPath = join(agentDir, "extensions/pi-alehouse/config.json");
  c.root = root;
  for (const [name, tools] of [
    ["editor", "read"],
    ["researcher", "read, web_search, source_check, fetch_content, get_search_content"],
  ])
    await writeFile(
      join(agentDir, "agents", `${name}.md`),
      `---\ntools: [${tools}]\n---\nFixture only.\n`,
    );
  await mkdir(permissionRoot, { recursive: true });
  await writeFile(
    join(permissionRoot, "index.ts"),
    'throw new Error("Orchestration must reuse the explicitly injected permission interface");\n',
  );
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("border-label startup fixture attempted network IO");
  });
  // The jiti-loaded extension calls its own module graph's classes; mock those
  // exact objects, never a second class from a stale dist build. The mocks
  // resolve the current session's fixture at call time, so every fresh
  // instance genuinely opens a live Owner state machine and lease.
  t.mock.method(OwnerController, "open", async () => {
    c.opens.controller++;
    return c.h.controller;
  });
  t.mock.method(FileOwnerLease, "open", async () => {
    c.opens.lease++;
    return c.h.owner;
  });
  // Rescue only after assertions: a regression must fail, not keep node:test
  // alive with the redraw timers it failed to clear.
  const schedule = globalThis.setInterval,
    cancel = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    const timer = schedule(...args);
    c.timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => {
    c.timers.delete(timer);
    cancel(timer);
  });
  t.after(() => {
    for (const timer of c.timers) cancel(timer);
  });
  return c;
}

/** Start one fresh real extension instance on its own genuine fixture Owner
 * and dispatch session_start through the pinned SDK runner's notification emit
 * (the same seam ui-shutdown already exercises for shutdown). `preferences`
 * becomes the saved global config in the shared owner directory. */
async function startSession(t, c, preferences, options = {}) {
  const h = await fixture(t);
  c.h = h;
  const preferencesBytes = JSON.stringify(preferences, null, 2) + "\n";
  await writeFile(c.preferencesPath, preferencesBytes);
  const notifications = [],
    selectCalls = [],
    statusKeys = [];
  const handlers = new Map(),
    commands = new Map(),
    shortcuts = new Map();
  let activeTools = [],
    component,
    pane,
    closePane;
  const listeners = new Map();
  const bus = {
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel, data) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
  // A fullscreen host floats the framed detail pane, whose popover chrome is
  // the shared surface the border-label switch drives.
  const tui = { terminal: { columns: 100, rows: 40 }, mode: "fullscreen", requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    cwd: c.root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => h.owner_id,
      getBranch: () => [],
      getSessionFile: () => undefined,
    },
    modelRegistry: { runtime: { getModel() {}, getPhysicalModel() {}, streamSimple() {} } },
    ui: {
      async select(title, items) {
        selectCalls.push({ title, items: [...items] });
        return options.select ? options.select(title, items) : items[0];
      },
      setStatus(key, value) {
        if (value !== undefined) statusKeys.push(key);
      },
      setWidget(_key, factory) {
        component = factory ? factory(tui, theme) : undefined;
      },
      custom(factory) {
        return new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          pane = factory(tui, theme, {}, done);
          closePane = done;
        });
      },
      notify(text, level) {
        notifications.push({ text, level });
      },
    },
  };
  const pi = {
    events: bus,
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerShortcut: (name, spec) => shortcuts.set(name, spec),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool() {},
    getAllTools: () => [],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
    appendEntry() {},
  };
  const permission = {
    getPermissionsService: () => ({}),
    subscribeManagedBlocks() {
      throw new Error("Border-label startup fixture must not observe an SDK child");
    },
  };
  orchestrationExtension(pi, { permission, parentWebTools: () => [] });
  const errors = [];
  await ExtensionRunner.prototype.emit.call(
    {
      createContext: () => ctx,
      extensions: [{ path: "fixture:orchestration", handlers }],
      isSessionBeforeEvent: () => false,
      emitError: (error) => errors.push(error.error),
    },
    { type: "session_start" },
  );
  return {
    h,
    ctx,
    commands,
    shortcuts,
    handlers,
    errors,
    notifications,
    selectCalls,
    statusKeys,
    preferencesBytes,
    activeTools: () => [...activeTools],
    component: () => component,
    pane: () => pane,
    closePane: () => closePane?.(),
    async shutdown() {
      for (const stop of handlers.get("session_shutdown") ?? [])
        await stop({ reason: "quit" }, ctx);
    },
  };
}

const unchangedPreferences = async (path, bytes, when) =>
  assert.equal(
    await readFile(path, "utf8"),
    bytes,
    `${when}: preferences must stay byte-identical`,
  );

test("real startup applies ui.borderLabels with !== false semantics across fresh instances", async (t) => {
  const c = await ownerDirectory(t);
  let instances = 0;
  for (const [saved, expected] of [
    [{ version: 2 }, true],
    [{ version: 2, ui: { borderLabels: false } }, false],
    [{ version: 2, ui: { borderLabels: true } }, true],
  ]) {
    const described = JSON.stringify(saved);
    const s = await startSession(t, c, saved);
    instances++;
    assert.deepEqual(s.errors, [], `startup with ${described} must not escape handler errors`);
    assert.equal(
      borderLabelsEnabled(),
      expected,
      `the process-wide switch after startup with ${described}`,
    );
    assert(
      s.commands.has("alehouse-settings"),
      `startup with ${described} completed far enough to register the settings command`,
    );
    assert(
      s.statusKeys.includes("alehouse-preset"),
      `startup with ${described} published the footer status, so it opened its own live Owner`,
    );
    assert.equal(c.opens.controller, instances, `each fresh instance opened its own Owner`);
    assert.equal(c.opens.lease, instances, `each fresh instance took its own lease`);
    assert(
      !s.notifications.some((entry) => entry.level === "error"),
      `startup with ${described} must not report a visible failure`,
    );
    await unchangedPreferences(c.preferencesPath, s.preferencesBytes, `startup with ${described}`);
    await s.shutdown();
    assert.equal(s.h.controller.stats().closed, true, `the instance's own Owner closed cleanly`);
    assert.equal(c.timers.size, 0, `shutdown of ${described} retained no redraw timers`);
    await unchangedPreferences(
      c.preferencesPath,
      s.preferencesBytes,
      `shutdown after ${described} without pending writes`,
    );
  }
});

test("the real /alehouse-settings row drives the shared switch and the mounted pane chrome", async (t) => {
  const c = await ownerDirectory(t);
  const s = await startSession(
    t,
    c,
    { version: 2, ui: { borderLabels: false } },
    {
      select: (_title, items) =>
        items.find((item) => /^Border labels: (on|off) \(all Alehouse panels\)$/.test(item)),
    },
  );
  assert.equal(borderLabelsEnabled(), false, "saved ui.borderLabels false is honored at startup");
  assert.deepEqual(s.errors, []);
  // A live Agent so the real alt+a path mounts the agents detail pane.
  const submitted = await s.h.controller.submit(
    "border-label-ui",
    task("Hold until settings", { name: "otter" }),
  );
  await until(() => s.h.ports[0]?.streaming);
  for (const turn of s.handlers.get("turn_start") ?? []) turn({}, s.ctx);
  const settings = s.commands.get("alehouse-settings");
  assert(settings, "the real extension registers /alehouse-settings");
  const toolsBefore = s.activeTools();

  // While the pane owns the interaction the settings command is an explicit
  // no-op, so the toggle below runs between mounts, like the real dialog flow.
  const opening = s.shortcuts.get("alt+a").handler();
  const mounted = s.pane();
  assert(mounted, "the real extension mounted the agents detail pane");
  await settings.handler("", s.ctx);
  assert.deepEqual(s.selectCalls, [], "settings must not open a dialog over the open pane");
  assert.equal(borderLabelsEnabled(), false, "the refused dialog must not flip the switch");
  const inset = mounted.render(100);
  assert.match(inset[0], /^╭─+╮$/u, "labels off: the top edge is a bare rule");
  assert.match(inset[1], /^│ {2}otter/u, "labels off: the title sits in the inset band");
  s.closePane();
  await opening;

  // The real settings row flips the process-wide switch; nothing is written.
  await settings.handler("", s.ctx);
  assert.equal(
    s.selectCalls.at(-1)?.items.find((item) => /^Border labels: off/.test(item)),
    "Border labels: off (all Alehouse panels)",
    "the settings row shows the live state before toggling",
  );
  assert.match(
    s.selectCalls.at(-1)?.title ?? "",
    /^Alehouse settings · Save: session · /,
    "the standalone settings dialog carries the Alehouse title",
  );
  assert.equal(borderLabelsEnabled(), true, "the real settings row flips the shared switch");
  assert.ok(
    s.notifications.some(({ text }) =>
      text.startsWith(
        "Border labels: on (all Alehouse panels) (session only; no configuration write).",
      ),
    ),
    "the session-scope toggle explains that no configuration write happened",
  );
  await unchangedPreferences(c.preferencesPath, s.preferencesBytes, "a session-only toggle");

  // The actually mounted chrome reads the same shared switch: the same real
  // mount path now paints the title on the pane's top border.
  const reopened = s.shortcuts.get("alt+a").handler();
  const onPane = s.pane();
  assert(onPane, "the real extension remounted the agents detail pane");
  const border = onPane.render(100);
  assert.match(border[0], /^╭─ otter/u, "labels on: the title is inlaid on the top edge");
  assert.ok(border[0].includes("✕"), "labels on: the close control stays on the top edge");
  assert.equal(border.length, inset.length - 4, "the inset band costs two rows per edge");
  assert.notEqual(border[0], inset[0]);

  // Owner/management state is untouched by the cosmetic toggle.
  assert.equal(s.h.ports.length, 1);
  assert.equal(s.h.ports[0].streaming, true);
  assert.equal(s.h.ports[0].stopped, 0);
  assert.equal(s.h.controller.view(submitted.run_id).status, "running");
  assert.deepEqual(
    s.activeTools(),
    toolsBefore,
    "cosmetic settings must not change management tools",
  );

  // And back off, through the same real row.
  s.closePane();
  await reopened;
  await settings.handler("", s.ctx);
  assert.equal(borderLabelsEnabled(), false, "the real settings row flips the switch back");
  const closing = s.shortcuts.get("alt+a").handler();
  const offPane = s.pane();
  const again = offPane.render(100);
  assert.match(again[0], /^╭─+╮$/u, "labels off again: the top edge is a bare rule");
  assert.equal(again.length, inset.length);
  s.closePane();
  await closing;
  // End the synthetic child before shutdown so the real drain confirms closure
  // instead of waiting out its cooperative-stop timeout.
  s.h.ports[0].finish("stopped", "aborted");
  await until(() => s.h.controller.view(submitted.run_id).status !== "running");
  await s.shutdown();
  await unchangedPreferences(
    c.preferencesPath,
    s.preferencesBytes,
    "shutdown after session-only toggles",
  );
  assert.deepEqual(s.errors, []);
  assert.equal(s.h.controller.stats().closed, true);
  assert.equal(c.timers.size, 0, "shutdown retained no widget or pane redraw timers");
});

test("invalid saved settings refuse a fresh instance visibly and restore the default switch", async (t) => {
  const c = await ownerDirectory(t);
  const first = await startSession(t, c, { version: 2, ui: { borderLabels: false } });
  assert.equal(borderLabelsEnabled(), false, "the earlier session left the switch off");
  await first.shutdown();

  // A non-boolean leaf is schema-invalid: the next fresh instance in this same
  // process must refuse startup visibly, keep the file untouched and not
  // inherit the previous session's switch value. The refusal happens before
  // any lease or Owner is opened.
  const invalid = { version: 2, ui: { borderLabels: "on" } };
  const second = await startSession(t, c, invalid);
  assert.equal(
    borderLabelsEnabled(),
    true,
    "a refused startup restores the border-label default instead of inheriting the previous session",
  );
  const refusal = second.notifications.find(({ level }) => level === "error");
  assert(refusal, "the refused startup reports visibly");
  const body = JSON.parse(refusal.text);
  assert.equal(body.code, "SETTINGS_LOAD_FAILED");
  assert.deepEqual(body.config_paths, [
    c.preferencesPath,
    join(c.root, ".pi/extensions/pi-alehouse/config.json"),
  ]);
  assert.match(body.resolution, /no existing configuration was overwritten/u);
  assert.match(String(body.error), /ui\.borderLabels must be a boolean/u);
  await unchangedPreferences(c.preferencesPath, second.preferencesBytes, "a refused startup");
  assert.equal(c.opens.controller, 1, "the refused instance must not open a second Owner");
  assert.equal(c.opens.lease, 1, "the refused instance must not take a second lease");
  assert.deepEqual(second.errors, [], "the refusal is a visible report, not an escaped error");
  // The refused instance never initialized: its settings command says so
  // instead of silently acting on stale state.
  await second.commands.get("alehouse-settings").handler("", second.ctx);
  const notReady = second.notifications.filter(({ level }) => level === "error").at(-1);
  assert.equal(JSON.parse(notReady.text).code, "ORCHESTRATION_NOT_READY");
  await second.shutdown();
  await unchangedPreferences(
    c.preferencesPath,
    second.preferencesBytes,
    "shutdown of a refused instance",
  );
  assert.equal(c.timers.size, 0, "the refused instance retained no redraw timers");
});
