import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
for (const fault of ["widget", "panel", "all"]) test(`quit drains before later SDK teardown despite ${fault} UI faults`, async (t) => {
  const h = await fixture(t), log = [], errors = [], handlers = new Map(), shortcuts = new Map();
  const root = h.directory, agentDir = join(root, "agent"), permissionRoot = join(root, "permission");
  const envKeys = ["PI_CODING_AGENT_DIR", "PI_HARNESS_PERMISSION_ROOT", "PI_HARNESS_POLICY_ROOT", "PI_HARNESS_FLOCK"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HARNESS_PERMISSION_ROOT = permissionRoot;
  process.env.PI_HARNESS_POLICY_ROOT = join(root, "unused-policy");
  process.env.PI_HARNESS_FLOCK = "/unused-fixture-flock"; // The already-held real fixture lease is injected below.
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writePresetConfig(join(agentDir, "harness-presets.json"));
  for (const name of ["editor", "reader"]) {
    await writeFile(join(agentDir, "agents", `${name}.md`), "---\ntools: [read]\n---\nFixture only.\n");
  }
  const authority = join(permissionRoot, "node_modules/@gotgenes/pi-permission-system");
  await mkdir(authority, { recursive: true });
  await writeFile(join(permissionRoot, "package.json"), "{}");
  await writeFile(join(authority, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(join(authority, "index.js"), "export const getPermissionsService = () => ({});\n");
  await writeFile(join(permissionRoot, "index.ts"), 'export { getPermissionsService } from "./node_modules/@gotgenes/pi-permission-system/index.js";\n');
  t.mock.method(globalThis, "fetch", () => { assert.fail("shutdown fixture attempted network IO"); });
  t.mock.method(OwnerController, "open", async () => h.controller);
  t.mock.method(FileOwnerLease, "open", async () => h.owner);
  const shutdown = h.controller.shutdown.bind(h.controller);
  t.mock.method(h.controller, "shutdown", async (timeout) => { log.push("owner-shutdown"); return shutdown(timeout); });
  const clear = ChildActivityRegistry.prototype.clear;
  t.mock.method(ChildActivityRegistry.prototype, "clear", function () {
    log.push("activities-clear"); clear.call(this);
    if (failing && fault === "all") throw new Error("ACTIVITIES_CLEAR_FAILED");
  });
  const timers = new Set(), schedule = globalThis.setInterval, cancel = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args) => { const timer = schedule(...args); timers.add(timer); return timer; });
  t.mock.method(globalThis, "clearInterval", (timer) => { timers.delete(timer); cancel(timer); });
  // Rescue only after assertions: a regression must fail, not keep node:test
  // alive indefinitely with the very redraw timers it failed to clear.
  t.after(() => { for (const timer of timers) cancel(timer); });

  let failing = false, component, pane, authorityPresent = true;
  const listeners = new Map();
  const bus = {
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set(); set.add(handler); listeners.set(channel, set);
      return () => {
        set.delete(handler); log.push(`off:${channel}`);
        if (failing && fault === "all") throw new Error("UNSUBSCRIBE_FAILED");
      };
    },
    emit(channel, data) { for (const handler of listeners.get(channel) ?? []) handler(data); },
  };
  const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = { cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => h.owner_id, getBranch: () => [], getSessionFile: () => undefined },
    modelRegistry: { runtime: { getModel() {}, streamSimple() {} } },
    ui: {
      setStatus(_key, value) {
        if (value !== undefined) return;
        log.push("status-clear");
        if (failing && fault === "all") throw new Error("STATUS_CLEAR_FAILED");
      },
      setWidget(_key, factory) {
        if (factory) { component = factory(tui, theme); return; }
        log.push("widget-clear");
        if (failing && fault !== "panel") throw new Error("WIDGET_CLEAR_FAILED");
        component = undefined;
      },
      custom(factory) {
        return new Promise((resolve) => { pane = factory(tui, theme, {}, () => {
          log.push("pane-close"); resolve();
          if (failing && fault !== "widget") throw new Error("PANE_CLOSE_FAILED");
        }); });
      },
      notify() { if (failing && fault === "all") throw new Error("NOTIFY_FAILED"); },
    },
  };
  let activeTools = [];
  harnessExtension({ events: bus, on: (event, handler) => {
    const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list);
  }, registerShortcut: (name, spec) => shortcuts.set(name, spec), registerCommand() {}, registerTool() {},
  getAllTools: () => [], getActiveTools: () => [...activeTools], setActiveTools: (names) => { activeTools = [...names]; }, appendEntry() {} });
  t.after(async () => {
    failing = false;
    for (const stop of handlers.get("session_shutdown")) await stop({ reason: "quit" }, ctx);
  });
  for (const start of handlers.get("session_start")) await start({}, ctx);
  const run = await h.controller.submit("shutdown-ui", task("Hold until quit"));
  await until(() => h.ports[0]?.streaming);
  const child = h.ports[0], dispose = child.dispose.bind(child);
  t.mock.method(child, "dispose", async () => {
    assert.equal(authorityPresent, true, "the original parent authority must still exist during child disposal");
    log.push("child-dispose"); return dispose();
  });
  for (const turn of handlers.get("turn_start")) turn({}, ctx);
  assert.match(component.render(100).join("\n"), /Hold until quit/);
  const opening = shortcuts.get("alt+a").handler();
  assert(pane); assert.equal(timers.size, 2, "widget and pane redraw timers really started");
  t.after(() => { failing = false; pane?.dispose(); });
  failing = true;
  const quitting = ExtensionRunner.prototype.emit.call({
    createContext: () => ctx,
    extensions: [
      { path: "fixture:harness", handlers },
      { path: "fixture:later-authority", handlers: new Map([["session_shutdown", [() => {
        log.push("authority-teardown"); authorityPresent = false;
      }]]]) },
    ],
    isSessionBeforeEvent: () => false, emitError: (error) => errors.push(error.error),
  }, { type: "session_shutdown", reason: "quit" });
  await until(() => child.stopped > 0 || !authorityPresent);
  assert.equal(child.stopped, 1, "UI failure must not skip the core stop request");
  assert.equal(authorityPresent, true, "SDK teardown still awaits actual child exit");
  assert.equal(timers.size, 0, "redraw timers stop even while core is draining");
  child.finish("stopped", "aborted");
  await quitting; await opening;
  assert.equal(h.controller.view(run.run_id).status, "cancelled");
  assert.equal(h.controller.stats().closed, true);
  assert.equal(child.disposed, 1);
  for (const step of ["status-clear", "off:permissions:ui_prompt", "off:permissions:decision", "pane-close", "widget-clear", "activities-clear"]) {
    assert(log.includes(step), `cleanup was skipped: ${step}`);
    assert(log.indexOf(step) < log.indexOf("owner-shutdown"), `${step} must be attempted before drain`);
  }
  assert(log.indexOf("child-dispose") < log.indexOf("authority-teardown"));
  assert.equal(authorityPresent, false);
  assert([...listeners.values()].every((set) => set.size === 0));
  assert.deepEqual(errors, [], "best-effort UI failure does not escape SDK shutdown");
});
