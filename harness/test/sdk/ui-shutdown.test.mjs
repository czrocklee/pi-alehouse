import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner, initTheme } from "@earendil-works/pi-coding-agent";
import harnessExtension from "../../dist/extension.js";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { ChildActivityRegistry } from "../../dist/runtime/activity-observer.js";
import { fixture, task, until } from "../support/controller-fixture.mjs";
import { writePresetConfig } from "../support/preset-config.mjs";

initTheme(undefined, false);

// Real extension, Owner state machine/lease and SDK event dispatch. Child IO is
// FakePort; the authority locator below is deliberately NOT a permission test.
// No provider, user configuration, terminal or managed policy is loaded.
for (const [fault, beerMugs] of [
  ["widget", undefined],
  ["panel", true],
  ["all", false],
])
  test(`quit drains before later SDK teardown despite ${fault} UI faults (beerMugs: ${beerMugs ?? "missing"})`, async (t) => {
    const h = await fixture(t),
      log = [],
      errors = [],
      handlers = new Map(),
      shortcuts = new Map(),
      commands = new Map();
    const beerMugSelections = [];
    const root = h.directory,
      agentDir = join(root, "agent"),
      permissionRoot = join(root, "permission");
    const envKeys = [
      "PI_CODING_AGENT_DIR",
      "PI_HARNESS_PERMISSION_ROOT",
      "PI_HARNESS_POLICY_ROOT",
      "PI_HARNESS_FLOCK",
    ];
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_HARNESS_PERMISSION_ROOT = permissionRoot;
    process.env.PI_HARNESS_POLICY_ROOT = join(root, "unused-policy");
    process.env.PI_HARNESS_FLOCK = "/unused-fixture-flock"; // The already-held real fixture lease is injected below.
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writePresetConfig(join(agentDir, "harness-presets.json"));
    const preferencesPath = join(agentDir, "extensions/pi-alehouse/config.json");
    const preferencesBytes =
      JSON.stringify(
        { version: 2, ...(beerMugs === undefined ? {} : { ui: { beerMugs } }) },
        null,
        2,
      ) + "\n";
    await mkdir(join(agentDir, "extensions/pi-alehouse"), { recursive: true });
    await writeFile(preferencesPath, preferencesBytes);
    for (const name of ["editor"]) {
      await writeFile(
        join(agentDir, "agents", `${name}.md`),
        "---\ntools: [read]\n---\nFixture only.\n",
      );
    }
    await writeFile(
      join(agentDir, "agents", "researcher.md"),
      "---\ntools: [read, web_search, source_check, fetch_content, get_search_content]\n---\nFixture only.\n",
    );
    await mkdir(permissionRoot, { recursive: true });
    await writeFile(
      join(permissionRoot, "index.ts"),
      'throw new Error("Harness must reuse the explicitly injected permission interface");\n',
    );
    const permission = {
      getPermissionsService: () => ({}),
      subscribeManagedBlocks() {
        throw new Error("FakePort shutdown fixture must not observe an SDK child");
      },
    };
    t.mock.method(globalThis, "fetch", () => {
      assert.fail("shutdown fixture attempted network IO");
    });
    t.mock.method(OwnerController, "open", async () => h.controller);
    t.mock.method(FileOwnerLease, "open", async () => h.owner);
    const shutdown = h.controller.shutdown.bind(h.controller);
    t.mock.method(h.controller, "shutdown", async (timeout) => {
      log.push("owner-shutdown");
      return shutdown(timeout);
    });
    const clear = ChildActivityRegistry.prototype.clear;
    t.mock.method(ChildActivityRegistry.prototype, "clear", function () {
      log.push("activities-clear");
      clear.call(this);
      if (failing && fault === "all") throw new Error("ACTIVITIES_CLEAR_FAILED");
    });
    const timers = new Set(),
      schedule = globalThis.setInterval,
      cancel = globalThis.clearInterval;
    t.mock.method(globalThis, "setInterval", (...args) => {
      const timer = schedule(...args);
      timers.add(timer);
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (timer) => {
      timers.delete(timer);
      cancel(timer);
    });
    // Rescue only after assertions: a regression must fail, not keep node:test
    // alive indefinitely with the very redraw timers it failed to clear.
    t.after(() => {
      for (const timer of timers) cancel(timer);
    });

    let failing = false,
      component,
      pane,
      authorityPresent = true;
    const listeners = new Map();
    const bus = {
      on(channel, handler) {
        const set = listeners.get(channel) ?? new Set();
        set.add(handler);
        listeners.set(channel, set);
        return () => {
          set.delete(handler);
          log.push(`off:${channel}`);
          if (failing && fault === "all") throw new Error("UNSUBSCRIBE_FAILED");
        };
      },
      emit(channel, data) {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    };
    const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} };
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const ctx = {
      cwd: root,
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
        async select(_title, items) {
          const action = items.find((item) => /^Beer mugs: (on|off)$/.test(item));
          beerMugSelections.push(action);
          return action;
        },
        setStatus(_key, value) {
          if (value !== undefined) return;
          log.push("status-clear");
          if (failing && fault === "all") throw new Error("STATUS_CLEAR_FAILED");
        },
        setWidget(_key, factory) {
          if (factory) {
            component = factory(tui, theme);
            return;
          }
          log.push("widget-clear");
          if (failing && fault !== "panel") throw new Error("WIDGET_CLEAR_FAILED");
          component = undefined;
        },
        custom(factory) {
          return new Promise((resolve) => {
            pane = factory(tui, theme, {}, () => {
              log.push("pane-close");
              resolve();
              if (failing && fault !== "widget") throw new Error("PANE_CLOSE_FAILED");
            });
          });
        },
        notify() {
          if (failing && fault === "all") throw new Error("NOTIFY_FAILED");
        },
      },
    };
    let activeTools = [];
    harnessExtension(
      {
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
      },
      { permission, parentWebTools: () => [] },
    );
    t.after(async () => {
      failing = false;
      for (const stop of handlers.get("session_shutdown")) await stop({ reason: "quit" }, ctx);
    });
    for (const start of handlers.get("session_start")) await start({}, ctx);
    assert.equal(
      await readFile(preferencesPath, "utf8"),
      preferencesBytes,
      "startup must not rewrite existing preferences",
    );
    // session_start assembled the model tools and bound their naming contract.
    const run = await h.controller.submit(
      "shutdown-ui",
      task("Hold until quit", { name: "otter" }),
    );
    await until(() => h.ports[0]?.streaming);
    const child = h.ports[0],
      dispose = child.dispose.bind(child);
    t.mock.method(child, "dispose", async () => {
      assert.equal(
        authorityPresent,
        true,
        "the original parent authority must still exist during child disposal",
      );
      log.push("child-dispose");
      return dispose();
    });
    for (const turn of handlers.get("turn_start")) turn({}, ctx);
    const lines = component.render(100);
    assert.match(lines.join("\n"), /Hold until quit/);
    // This regular/unknown-mode host has no disclosure control: defaults retain
    // status dots, while only an explicit saved true enables the mug branding.
    assert.match(lines[0], beerMugs === true ? /^🍺 Subagents(?: ·|$)/u : /^● Subagents(?: ·|$)/u);
    assert.doesNotMatch(lines[0], /🍻|▸|▾|\btotal\b/u);
    const toolsBeforeToggle = [...activeTools],
      portsBeforeToggle = h.ports.length;
    const settings = commands.get("harness-settings");
    assert(settings, "the real extension registers /harness-settings");
    for (const enabled of [beerMugs !== true, beerMugs === true]) {
      await settings.handler("", ctx);
      assert.equal(
        beerMugSelections.at(-1),
        `Beer mugs: ${enabled ? "off" : "on"}`,
        "settings label reflects the live state before toggling",
      );
      const toggled = component.render(100);
      assert.match(
        toggled[0],
        enabled ? /^🍺 Subagents(?: ·|$)/u : /^● Subagents(?: ·|$)/u,
        "settings selection updates the mounted widget immediately",
      );
      assert.match(toggled.join("\n"), /Hold until quit/);
      assert.equal(
        await readFile(preferencesPath, "utf8"),
        preferencesBytes,
        "session-only toggles must not write preferences",
      );
      assert.equal(h.ports.length, portsBeforeToggle);
      assert.equal(child.streaming, true);
      assert.equal(child.stopped, 0);
      assert.equal(child.disposed, 0);
      assert.equal(h.controller.view(run.run_id).status, "running");
      assert.deepEqual(
        activeTools,
        toolsBeforeToggle,
        "cosmetic settings must not change management tools",
      );
    }
    assert.equal(beerMugSelections.length, 2, "each command opens exactly one settings selection");
    const opening = shortcuts.get("alt+a").handler();
    assert(pane);
    assert.equal(timers.size, 2, "widget and pane redraw timers really started");
    t.after(() => {
      failing = false;
      pane?.dispose();
    });
    failing = true;
    const quitting = ExtensionRunner.prototype.emit.call(
      {
        createContext: () => ctx,
        extensions: [
          { path: "fixture:harness", handlers },
          {
            path: "fixture:later-authority",
            handlers: new Map([
              [
                "session_shutdown",
                [
                  () => {
                    log.push("authority-teardown");
                    authorityPresent = false;
                  },
                ],
              ],
            ]),
          },
        ],
        isSessionBeforeEvent: () => false,
        emitError: (error) => errors.push(error.error),
      },
      { type: "session_shutdown", reason: "quit" },
    );
    await until(() => child.stopped > 0 || !authorityPresent);
    assert.equal(child.stopped, 1, "UI failure must not skip the core stop request");
    assert.equal(authorityPresent, true, "SDK teardown still awaits actual child exit");
    assert.equal(timers.size, 0, "redraw timers stop even while core is draining");
    child.finish("stopped", "aborted");
    await quitting;
    await opening;
    assert.equal(h.controller.view(run.run_id).status, "cancelled");
    assert.equal(h.controller.stats().closed, true);
    assert.equal(child.disposed, 1);
    for (const step of [
      "status-clear",
      "off:permissions:ui_prompt",
      "off:permissions:decision",
      "pane-close",
      "widget-clear",
      "activities-clear",
    ]) {
      assert(log.includes(step), `cleanup was skipped: ${step}`);
      assert(
        log.indexOf(step) < log.indexOf("owner-shutdown"),
        `${step} must be attempted before drain`,
      );
    }
    assert(log.indexOf("child-dispose") < log.indexOf("authority-teardown"));
    assert.equal(authorityPresent, false);
    assert([...listeners.values()].every((set) => set.size === 0));
    assert.deepEqual(errors, [], "best-effort UI failure does not escape SDK shutdown");
    assert.equal(
      await readFile(preferencesPath, "utf8"),
      preferencesBytes,
      "shutdown after session-only toggles must not rewrite preferences",
    );
  });
