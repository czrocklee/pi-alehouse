import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  sliceByColumn,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ModelSelectionSession } = await jiti.import(
  "../../src/orchestration/ui/model-selection-session.ts",
);
const { createPresetModelSelector } = await jiti.import(
  "../../src/orchestration/runtime/preset-model-selector.ts",
);
initTheme(undefined, false);

const model = (id, name = id) => ({ id, name, provider: "fixture", api: "test" });
const alpha = model("alpha"),
  beta = model("beta"),
  f2 = "\x1bOQ";
const wideTitle = `─A${"界".repeat(20)}`;

async function fixture(t, { models = [alpha, beta], position, title = "Fixture" } = {}) {
  const terminal = { columns: 110, rows: 36, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  tui.requestViewRender = () => {};
  const root = { render: () => ["Main transcript"], invalidate() {} };
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  tui.beforeTerminalStart();
  const ref = createInteractiveTuiReference(() => tui);
  const host = {
    ui: ref,
    editor: { getText: () => "" },
    keybindings: getKeybindings(),
    extensionOverlays: new Map(),
  };
  const notices = [];
  // Native selector and compositor, but no real model registry, refresh I/O,
  // terminal, or async render timing. The SDK mounts the actual custom overlay.
  const runtime = {
    getAvailableSnapshot: () => models,
    getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    getError: () => undefined,
    refresh: async () => ({ aborted: false, errors: new Map() }),
  };
  let native;
  const session = new ModelSelectionSession(
    {
      ctx: {
        mode: "tui",
        scopedModels: [{ model: models[0] }],
        modelRegistry: { getAll: () => models },
        ui: {
          custom: (factory, options) =>
            InteractiveMode.prototype.showExtensionCustom.call(host, factory, options),
          notify: (...args) => notices.push(args),
        },
      },
      createModelSelector: (options) =>
        (native = createPresetModelSelector({ ...options, runtime })),
      modelPopover: () => true,
    },
    () => {},
  );
  const result = session.select(title, "d1", "", models, position);
  t.after(async () => {
    session.cancel();
    await result;
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [handle] = host.extensionOverlays.keys();
  assert(handle?.isFocused(), "Pi mounted and focused the model picker");

  const input = (data) => tui.handleTerminalInput(data);
  const send = (button, [x, y], release = false) =>
    input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const press = (xy) => send(0, xy);
  const release = (xy) => send(0, xy, true);
  const click = (xy) => {
    press(xy);
    release(xy);
  };
  const paint = () => {
    tui.doRender();
    const bounds = handle.getBounds();
    assert(bounds, "the picker is still mounted and painted");
    const lines = tui.getScreenLines().map(stripTerminalSequences);
    return { ...bounds, lines };
  };
  return {
    tui,
    terminal,
    handle,
    input,
    send,
    paint,
    press,
    release,
    click,
    result,
    native,
    notices,
  };
}

function point(paint, label) {
  const { row, height, lines } = paint;
  const y = lines.findIndex((line, i) => i >= row && i < row + height && line.includes(label));
  assert(y >= 0, `painted picker contains ${label}`);
  return [visibleWidth(lines[y].slice(0, lines[y].indexOf(label))), y];
}

const frameRow = ({ lines, row, col, width }, index) =>
  sliceByColumn(lines[row + index], col, width);

for (const borderLabels of [true, false]) {
  test(`centered model picker resizes live with ${borderLabels ? "border" : "inset"} labels`, async (t) => {
    setBorderLabelsEnabled(borderLabels);
    t.after(() => setBorderLabelsEnabled(true));
    const f = await fixture(t);
    f.input("\t"); // Native scope changes from scoped (alpha) to all (both).
    const initial = f.paint();
    point(initial, "beta [fixture]");
    const titleY = initial.row + (borderLabels ? 0 : 1);
    assert.match(initial.lines[titleY], /□.*✕/u);
    assert.doesNotMatch(initial.lines[titleY], /≡|Resize/u);
    assert.equal(initial.width, 80);
    assert.equal(f.native.getSearchInput().focused, true);
    const panel = f.tui.getFocusedComponent();
    assert.equal(panel.canSelect(alpha), true);
    const x = initial.col;
    const y = initial.row + initial.height - 1;
    assert.match(frameRow(initial, initial.height - 1), /^╰.*╯$/u);
    f.press([x, y]);
    const held = f.paint();
    assert.match(frameRow(held, 0), /^╓.*╮$/u);
    assert.match(frameRow(held, held.height - 1), /^╚═.*═╛$/u);
    const [, selectedY] = point(held, "alpha [fixture]");
    assert.match(frameRow(held, selectedY - held.row), /^║→ .*alpha \[fixture\].*│$/u);
    assert.equal(
      panel.canSelect(alpha),
      true,
      "the active side preserves the painted arrow identity",
    );
    assert.equal(panel.canSelect(beta), false, "dry validation still requires the native identity");
    if (!borderLabels) {
      assert.match(frameRow(held, 1), /^║.*✕.*│$/u);
      assert.match(frameRow(held, 2), /^╟─.*┤$/u);
      assert.match(frameRow(held, held.height - 3), /^╟─.*┤$/u);
    }
    f.send(32, [x + 4, y + 3]);
    const during = f.paint();
    assert.match(frameRow(during, during.height - 1), /^╚═.*═╛$/u);
    assert.equal(during.width, initial.width - 8, "the compositor reads live options during drag");
    assert.equal(
      during.height,
      initial.height + 6,
      "the full requested height is actually painted",
    );
    f.release([x + 4, y + 3]);
    assert.equal(f.handle.isFocused(), true, "release did not choose a model or blur its input");
    const released = f.paint();
    assert.match(frameRow(released, released.height - 1), /^╰.*╯$/u);
    f.input(f2);
    const modal = f.paint();
    assert.match(frameRow(modal, 0), /^╔═.*╗$/u);
    assert.match(frameRow(modal, modal.height - 1), /^╚═.*╝$/u);
    assert.match(frameRow(modal, borderLabels ? 0 : 1), /Resize/u);
    f.input("\x1b");
    assert.match(frameRow(f.paint(), 0), /^╭─.*╮$/u);
    const query = "hjklz";
    for (const key of query) f.input(key);
    const typed = f.paint();
    assert.equal(f.native.getSearchInput().getValue(), query);
    assert.equal(typed.width, during.width);
    assert.equal(typed.height, during.height);
    assert.doesNotMatch(typed.lines[typed.row + (borderLabels ? 0 : 1)], /Resize/u);
    for (let i = 0; i < query.length; i++) f.input("\x7f");
    for (const key of "beta") f.input(key);
    const filtered = f.paint();
    assert.equal(
      filtered.height,
      during.height,
      "filtered results leave framed padding, not a shorter window",
    );
    const lastBody = filtered.row + filtered.height - (borderLabels ? 2 : 4);
    assert(filtered.lines[lastBody].includes(`│${" ".repeat(filtered.width - 2)}│`));
    assert.equal(f.native.getSearchInput().getValue(), "beta");
    assert.equal(f.native.getSearchInput().focused, true);
    f.click(point(filtered, "□"));
    const maximized = f.paint();
    assert.equal(maximized.width, f.terminal.columns - 2);
    assert.equal(maximized.height, f.terminal.rows - 2);
    f.click(point(maximized, "▣"));
    const restored = f.paint();
    assert.equal(restored.width, filtered.width);
    assert.equal(restored.height, filtered.height);
    f.click(point(restored, "beta [fixture]"));
    assert.equal(f.tui.hasOverlay(), false, "the visible model click closes the picker");
    assert.equal(await f.result, "fixture/beta", "only the visible model click publishes");
  });

  test(`tight centered model title keeps its ellipsis and controls with ${borderLabels ? "border" : "inset"} labels`, async (t) => {
    setBorderLabelsEnabled(borderLabels);
    t.after(() => setBorderLabelsEnabled(true));
    const f = await fixture(t, { title: wideTitle });
    f.terminal.columns = 34;
    const initial = f.paint();
    assert.equal(initial.width, 32);
    const titleRow = borderLabels ? 0 : 1;
    assert.equal(
      sliceByColumn(frameRow(initial, titleRow), 3, 22),
      `─A${"界".repeat(9)}… `,
      "omit the wide glyph that straddles the truncation boundary, not the ellipsis",
    );
    if (borderLabels) {
      f.press([initial.col + 3, initial.row]); // A literal rule in the title, not an edge.
      assert.equal(frameRow(f.paint(), 0), frameRow(initial, 0));
      f.release([initial.col + 3, initial.row]);
    }
    f.click(point(initial, "□"));
    const maximized = f.paint();
    assert.equal(maximized.height, f.terminal.rows - 2);
    f.click(point(maximized, "▣"));
    const restored = f.paint();
    assert.equal(restored.height, initial.height);
    f.click(point(restored, "✕"));
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(await f.result, undefined);
  });
}

test("model keyboard resize is modal and a clipped native item cannot be applied", async (t) => {
  const long = model("long-model", "long descriptive name ".repeat(12).trimEnd());
  const f = await fixture(t, { models: [long] });
  const initial = f.paint();
  const panel = f.tui.getFocusedComponent();
  assert.equal(panel.canSelect(long), true);
  f.input(f2);
  point(f.paint(), "Resize");
  assert.equal(panel.canSelect(long), false, "resize immediately blocks model confirmation");
  for (let step = 0; step < 30; step++) {
    f.input("h");
    f.input("k");
  }
  const preview = f.paint();
  point(preview, "Resize");
  assert.equal(preview.width, 32);
  assert(preview.height < initial.height);
  assert.equal(f.native.getSearchInput().focused, true);
  assert.equal(f.native.getSearchInput().getValue(), "");
  f.input("\x1b");
  const restored = f.paint();
  assert.equal(restored.width, initial.width);
  assert.equal(restored.height, initial.height);

  f.input(f2);
  for (let step = 0; step < 30; step++) f.input("\x1b[A");
  f.input("\r"); // Commit the geometry, not the model.
  f.paint();
  assert.equal(f.handle.isFocused(), true);
  assert.equal(panel.canSelect(long), false, "an incomplete wrapped item is not selectable");
  f.input("\r");
  assert(f.notices.some(([message]) => /not fully visible/u.test(message)));
  assert.equal(f.handle.isFocused(), true);
  f.input("\x1b");
  assert.equal(f.tui.hasOverlay(), false, "Esc closes the picker after the rejected Enter");
  assert.equal(await f.result, undefined, "no model was applied from a clipped item");
});

test("checking current model identity cannot replace the last-painted pointer targets", async (t) => {
  const f = await fixture(t);
  f.input("\t"); // All models, initially with alpha selected.
  const initial = f.paint();
  const stale = point(initial, "alpha [fixture]");
  f.input("b"); // Native selection changes, but Pi has not painted it yet.
  const panel = f.tui.getFocusedComponent();
  assert.equal(panel.canSelect(beta), true, "dry validation observes the native selection");
  for (let click = 0; click < 2; click++) {
    f.click(stale);
    assert.equal(f.handle.isFocused(), true, "a dry layout must not publish a new pointer target");
  }
  f.click(point(f.paint(), "beta [fixture]"));
  assert.equal(await f.result, "fixture/beta");
});

test("a model press captured before terminal resize cannot apply after the new paint", async (t) => {
  const f = await fixture(t);
  const initial = f.paint();
  const stale = point(initial, "alpha [fixture]");
  f.press(stale);
  f.terminal.rows -= 4;
  const panel = f.tui.getFocusedComponent();
  assert.equal(panel.canSelect(alpha), false, "dry layout cannot admit a stale keyboard target");
  const resized = f.paint();
  assert.equal(panel.canSelect(alpha), true);
  assert.notEqual(resized.row, initial.row, "the compositor recentered the picker");
  const mouse = t.mock.method(panel, "handleMouse");
  f.release(stale);
  const capturedClick = mouse.mock.calls.find(({ arguments: [event] }) => event.type === "click");
  assert.equal(capturedClick?.arguments[0].y, stale[1] - initial.row, "Pi uses the old local row");
  assert.equal(f.handle.isFocused(), true, "the stale captured click did not choose the model");
  f.click(point(resized, "alpha [fixture]"));
  assert.equal(f.tui.hasOverlay(), false, "a fresh click closes the model picker");
  assert.equal(await f.result, "fixture/alpha");
});

test("confirmation before the new paint cannot dispose the native selector", async (t) => {
  const f = await fixture(t);
  f.paint();
  const dispose = t.mock.method(f.native, "dispose");
  f.terminal.rows -= 4;
  f.input("\r");
  f.input("\n"); // The search Input also accepts LF as a submit.
  assert.equal(dispose.mock.callCount(), 0);
  assert.equal(f.handle.isFocused(), true);
  assert(f.notices.some(([message]) => /Wait for the picker to repaint/u.test(message)));
  f.input("a");
  assert.equal(f.native.getSearchInput().getValue(), "a", "stale geometry does not block search");
  f.paint();
  f.input("\r");
  assert.equal(f.tui.hasOverlay(), false, "visible keyboard confirmation closes the picker");
  assert.equal(await f.result, "fixture/alpha");
});

test("a model picker opened at a click never gains centered resize after terminal shrink", async (t) => {
  const f = await fixture(t, { position: { row: 6, col: 90 }, title: wideTitle });
  const initial = f.paint();
  assert.equal(initial.row, 7);
  assert.doesNotMatch(initial.lines.join("\n"), /[≡□▣]|Resize/u);
  f.terminal.columns = 34; // The original absolute click is no longer in the viewport.
  f.paint();
  f.input(f2);
  const narrow = f.paint();
  assert.doesNotMatch(narrow.lines.join("\n"), /[≡□▣]|Resize/u);
  assert(frameRow(narrow, 0).includes(`─A${"界".repeat(10)}…`), "no space reserved for maximize");
  assert.equal(f.native.getSearchInput().focused, true);
  f.input("\x1b");
  assert.equal(f.tui.hasOverlay(), false, "Esc stays native and closes the selector");
  assert.equal(await f.result, undefined);
});
