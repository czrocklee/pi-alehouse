import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import {
  APPROVAL_INDICATOR,
  CHANGES_INDICATOR,
  FOOTER_INDICATOR_CLICK_EVENT,
  HEALTH_INDICATOR,
  WORKER_PRESET_INDICATOR,
} from "../../src/shared/overlay-protocol.mjs";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createInteractiveTui, createInteractiveTuiReference } = await import(
  new URL("modes/interactive/tui-renderer.js", sdk)
);
const { createChatViewport } = await import(new URL("modes/interactive/chat-viewport.js", sdk));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { default: footerExtension } = await jiti.import("../../src/extensions/status-footer.ts");
const { bindChangesFooter } = await jiti.import("../../src/orchestration/ui/changes-footer.ts");
initTheme(undefined, false);

// Run genuine Pi footer mounting/status and native terminal mouse dispatch,
// with an in-memory Owner projection and no real terminal, session or provider.
function fixture(t, mode, toggle = async () => undefined, reportError = () => undefined) {
  let mouseTracking = false;
  const terminal = {
    columns: 100,
    rows: 24,
    write(text) {
      mouseTracking ||= text.includes("\x1b[?1006h");
    },
    hideCursor() {},
  };
  const renderer = createInteractiveTui({ tuiMode: mode, terminal, fullscreenCopyOnSelect: false });
  const tui = createInteractiveTuiReference(() => renderer);
  const counts = { reads: 0, toggles: 0, renders: 0 };
  const requestRender = renderer.requestRender.bind(renderer);
  renderer.requestRender = (...args) => {
    counts.renders++;
    requestRender(...args);
  };
  renderer.requestViewRender = renderer.requestImmediateRender = () => {};
  const statuses = new Map([
    [WORKER_PRESET_INDICATOR, "delegation: off"],
    [APPROVAL_INDICATOR, "approval: YOLO"],
    [HEALTH_INDICATOR, "●"],
  ]);
  const host = {
    ui: tui,
    footerContainer: new Container(),
    footerDataProvider: {
      getGitBranch: () => undefined,
      getExtensionStatuses: () => statuses,
      onBranchChange: () => () => {},
      setExtensionStatus: (key, text) =>
        text === undefined ? statuses.delete(key) : statuses.set(key, text),
    },
  };
  const ui = {
    notify: () => assert.fail("No notification should be printed from the footer"),
    setStatus: (key, text) => InteractiveMode.prototype.setExtensionStatus.call(host, key, text),
    setFooter: (factory) => InteractiveMode.prototype.setExtensionFooter.call(host, factory),
  };
  const ctx = {
    mode: "tui",
    cwd: "/fixture/宽",
    ui,
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ tokens: 12, contextWindow: 1000, percent: 1.2 }),
  };
  const handlers = new Map(),
    events = createEventBus();
  footerExtension({
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events,
  });
  handlers.get("session_start")({}, ctx);

  const document = new Text("Transcript text");
  const editor = new Text("Editor text");
  if (mode === "fullscreen") {
    renderer.setLayoutRoot(
      createChatViewport({
        document,
        pendingMessages: new Container(),
        status: new Container(),
        editor,
        footer: host.footerContainer,
      }).root,
    );
  } else {
    for (const component of [document, editor, host.footerContainer]) renderer.addChild(component);
  }
  renderer.beforeTerminalStart();

  let totals = {
    attempts: 0,
    paths: 0,
    reported: 0,
    added: 0,
    removed: 0,
    unknownPaths: 0,
    partial: false,
  };
  let subscriber;
  const unbind = bindChangesFooter(
    ui,
    events,
    {
      getOwnerChangeCounts() {
        counts.reads++;
        return totals;
      },
      subscribeOwnerChangeCounts(listener) {
        subscriber = listener;
        return () => {
          subscriber = undefined;
        };
      },
    },
    () => {
      counts.toggles++;
      return toggle();
    },
    reportError,
  );
  t.after(() => {
    unbind();
    handlers.get("session_shutdown")({}, ctx);
    host.customFooter.dispose();
    renderer.beforeTerminalStop({});
    renderer.afterTerminalStop({ preserveScreen: true });
  });
  return {
    terminal,
    events,
    renderer,
    unbind,
    statuses,
    counts,
    mouseTracking,
    update(next) {
      totals = { ...totals, ...next };
      subscriber?.();
    },
    row() {
      if (mode === "regular") return stripTerminalSequences(tui.render(terminal.columns).at(-1));
      renderer.doRender();
      return stripTerminalSequences(renderer.getScreenLines().at(-1));
    },
    click(x) {
      renderer.handleTerminalInput(`\x1b[<0;${x + 1};${terminal.rows}M`);
      renderer.handleTerminalInput(`\x1b[<0;${x + 1};${terminal.rows}m`);
    },
  };
}

function columnOf(row, label) {
  const index = row.indexOf(label);
  assert(index >= 0, row);
  return visibleWidth(row.slice(0, index));
}

for (const mode of ["fullscreen", "regular"]) {
  test(`Changes uses Pi's ${mode} footer and respects its native mouse mode`, (t) => {
    const f = fixture(t, mode);
    const fullscreen = mode === "fullscreen";
    assert.equal(f.mouseTracking, fullscreen);
    assert(!f.statuses.has(CHANGES_INDICATOR));
    assert.doesNotMatch(f.row(), /[+−]/u);
    const before = f.counts.renders;
    f.update({ attempts: 2, paths: 2, reported: 2, added: 12, removed: 3 });
    assert.equal(f.counts.renders, before + 1, "setStatus schedules paint");
    const line = f.row();
    const label = "+12 −3";
    assert.match(line, /\+12 −3 · off · YOLO · ●$/u);
    const x = columnOf(line, label);
    f.click(x);
    f.click(x + visibleWidth(label) - 1);
    assert.equal(f.counts.toggles, fullscreen ? 2 : 0);
    assert.equal(f.renderer.hasOverlay(), false, "Changes clicks never open Usage");

    if (fullscreen) {
      const saved = f.terminal.columns;
      const rightWidth = visibleWidth(line.slice(line.indexOf("↑")));
      const fraction = "12/1.0k";
      // Leave room for the fraction but not the space between it and Changes.
      f.terminal.columns = rightWidth + visibleWidth(fraction);
      const tight = f.row();
      assert(tight.includes(fraction));
      assert.doesNotMatch(tight, /[+−]/u);
      assert.match(tight, /off · YOLO · ●$/u);
      f.terminal.columns++;
      const oneMore = f.row();
      assert(oneMore.includes(fraction) && oneMore.includes(label), "both fit with the gap");
      f.terminal.columns = rightWidth - visibleWidth(label);
      assert.doesNotMatch(f.row(), /[+−]/u);
      f.terminal.columns = saved;
      assert.match(f.row(), /\+12 −3/u);
    }

    const { reads, renders } = f.counts;
    for (let frame = 0; frame < 5; frame++) f.row();
    assert.equal(f.counts.reads, reads, "paint does not read Owner counts");
    f.update({ attempts: 4, reported: 4 });
    assert.equal(f.counts.renders, renders, "history alone does not repaint Net counts");
    f.update({ unknownPaths: 1 });
    assert.match(f.row(), /\+12 −3 …/u);
    f.update({ added: 0, removed: 0, unknownPaths: 0 });
    const zero = f.row();
    assert.match(zero, /\+0 −0 · off · YOLO · ●$/u);
    const beforeZeroClick = f.counts.toggles;
    f.click(columnOf(zero, "+0 −0"));
    assert.equal(f.counts.toggles - beforeZeroClick, fullscreen ? 1 : 0);
    f.update({ paths: 0, attempts: 0, reported: 0 });
    assert(!f.statuses.has(CHANGES_INDICATOR), "zero without observations removes the status");
    f.update({ partial: true });

    // Click the stale span after unbinding but before the next paint.
    const staleX = columnOf(f.row(), "+? −?");
    f.unbind();
    assert(!f.statuses.has(CHANGES_INDICATOR));
    const retired = { key: CHANGES_INDICATOR, handled: false };
    f.events.emit(FOOTER_INDICATOR_CLICK_EVENT, retired);
    assert.equal(retired.handled, false);
    const toggles = f.counts.toggles;
    f.click(staleX);
    assert.equal(f.counts.toggles, toggles);
    assert.equal(f.renderer.hasOverlay(), false);
    f.update({ added: 9 });
    assert(!f.statuses.has(CHANGES_INDICATOR));
  });
}

test("Changes clicks report toggle failures only while the footer is bound", async (t) => {
  const errors = [];
  const sync = new Error("toggle threw");
  const rejected = new Error("toggle rejected");
  const retired = new Error("toggle settled after cleanup");
  const pending = Promise.withResolvers();
  let toggles = 0;
  const f = fixture(
    t,
    "fullscreen",
    () => {
      switch (toggles++) {
        case 0:
          throw sync;
        case 1:
          return Promise.reject(rejected);
        default:
          return pending.promise;
      }
    },
    (error) => {
      errors.push(error);
      throw new Error("error reporting failed too");
    },
  );
  f.update({ paths: 1, added: 3 });
  const click = () => {
    const payload = { key: CHANGES_INDICATOR, handled: false };
    f.events.emit(FOOTER_INDICATOR_CLICK_EVENT, payload);
    assert.equal(payload.handled, true, "the footer claims the click synchronously");
  };
  click();
  click();
  await Promise.resolve();
  assert.deepEqual(errors, [sync, rejected]);

  click();
  f.unbind();
  pending.reject(retired);
  await Promise.resolve();
  assert.deepEqual(errors, [sync, rejected]);
});

test("disposing Changes clears a status Pi stored before requestRender threw", (t) => {
  const f = fixture(t, "fullscreen");
  t.mock.method(
    f.renderer,
    "requestRender",
    () => {
      throw new Error("render failed after Pi stored the status");
    },
    { times: 1 },
  );
  assert.doesNotThrow(() => f.update({ paths: 1, added: 3 }));
  assert.equal(f.statuses.get(CHANGES_INDICATOR), "+3 −0", "Pi stored the partial publication");
  f.unbind();
  assert(!f.statuses.has(CHANGES_INDICATOR), "teardown must clear even uncertain state");
  assert.equal(f.statuses.get(APPROVAL_INDICATOR), "approval: YOLO");
});
