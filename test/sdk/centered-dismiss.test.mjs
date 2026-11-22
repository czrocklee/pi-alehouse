import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { createBackdropDismiss } from "../../src/shared/centered-dismiss.mjs";

const { createInteractiveTuiReference } = await import(
  new URL(
    "modes/interactive/tui-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

const backdrop = [4, 8];
const link = "https://example.invalid/transcript";

// Use the pinned compositor and SGR dispatch, but no real TTY, clipboard or browser.
function fixture(t) {
  const terminal = { columns: 80, rows: 24, write() {}, hideCursor() {} };
  const opened = [],
    dismissed = [],
    cleanup = [];
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copyOnSelect: false,
    openUrl: (url) => opened.push(url),
  });
  tui.requestRender = () => {};
  tui.requestViewRender = () => {};
  const root = {
    render: () =>
      Array.from({ length: terminal.rows }, (_, row) =>
        row === 3 ? `\x1b]8;;${link}\x1b\\Link\x1b]8;;\x1b\\` : "Root transcript text",
      ),
    invalidate() {},
  };
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  tui.beforeTerminalStart();
  t.after(() => {
    for (const remove of cleanup.reverse()) remove();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });

  const paint = () => tui.doRender();
  function mount(
    name = "center",
    { width = 20, height: initialHeight = 4, host = tui, afterDismiss } = {},
  ) {
    const clicks = [];
    let height = initialHeight;
    const tracker = createBackdropDismiss();
    const handle = tui.showOverlay(
      {
        get focused() {
          return tracker.focused;
        },
        set focused(value) {
          tracker.focused = value;
        },
        render: () => Array(height).fill(name),
        invalidate() {},
        handleMouse(event) {
          if (event.type !== "click") return;
          clicks.push([event.x, event.y]);
          return { handled: true, focus: true };
        },
      },
      { anchor: "center", width },
    );
    let stop =
      host &&
      tracker.attach(host, handle, () => {
        dismissed.push(name);
        dispose();
        handle.hide();
        paint();
        afterDismiss?.();
      });
    function dispose() {
      stop?.();
      stop = undefined;
    }
    cleanup.push(() => {
      dispose();
      handle.hide();
    });
    paint();
    function bounds() {
      const rect = handle.getBounds();
      assert(rect, "overlay must have painted bounds");
      return rect;
    }
    return {
      handle,
      clicks,
      dispose,
      bounds,
      cell(x = 1, y = 1) {
        const rect = bounds();
        return [rect.col + x, rect.row + y];
      },
      grow() {
        height += 2;
        paint();
      },
    };
  }

  const input = (data) => tui.handleTerminalInput(data);
  const send = (code, [x, y] = backdrop, end = "M") =>
    input(`\x1b[<${code};${x + 1};${y + 1}${end}`);
  const press = (point, code = 0) => send(code, point);
  const release = (point, code = 0) => send(code, point, "m");
  const drag = (point) => send(32, point);
  function click(point, code) {
    press(point, code);
    release(point, code);
  }
  paint();
  return { tui, root, opened, dismissed, mount, paint, input, press, release, drag, click, send };
}

test("backdrop dismissal requires a completed primary click", (t) => {
  const f = fixture(t);
  const panel = f.mount();
  assert.equal(panel.handle.isFocused(), true);
  f.release();
  assert.deepEqual(f.dismissed, [], "a release without a press does not dismiss");
  f.press();
  assert.deepEqual(f.dismissed, [], "press alone does not dismiss");
  f.paint();
  f.release();
  assert.deepEqual(f.dismissed, ["center"]);
  f.release();
  assert.deepEqual(f.dismissed, ["center"], "no duplicate dismissal");
});

test("inside clicks remain native", (t) => {
  const f = fixture(t);
  const panel = f.mount();
  f.click(panel.cell());
  assert.deepEqual(panel.clicks, [[1, 1]]);
  assert.deepEqual(f.dismissed, []);
});

for (const [name, point] of [
  ["root control", [2, 2]],
  ["painted link", [1, 3]],
]) {
  test(`a backdrop click over a ${name} dismisses without activating it`, (t) => {
    const f = fixture(t);
    f.mount();
    const actions = name === "painted link" ? f.opened : [];
    if (name === "root control") {
      f.root.handleMouse = ({ type, x, y }) => {
        if (type !== "click" || x !== point[0] || y !== point[1]) return;
        actions.push(name);
        return { handled: true };
      };
    }

    f.click(point);
    assert.deepEqual(f.dismissed, ["center"]);
    assert.deepEqual(actions, []);
    f.click(point);
    assert.deepEqual(actions, [name === "painted link" ? link : name]);
  });
}

test("the backdrop blocks new root drag captures but respects an existing native capture", (t) => {
  const f = fixture(t);
  const dragEvents = [];
  f.root.handleMouse = ({ type, x, y }) => {
    if (type !== "press" && type !== "drag" && type !== "release") return;
    dragEvents.push([type, x, y]);
    return type === "press" ? { capture: true } : { handled: true };
  };

  f.press();
  const panel = f.mount();
  const inside = panel.cell();
  f.drag(inside);
  f.release(inside);
  assert.deepEqual(dragEvents.splice(0), [
    ["press", ...backdrop],
    ["drag", ...inside],
    ["release", ...inside],
  ]);

  f.press();
  f.drag(inside);
  f.release(inside);
  assert.deepEqual(dragEvents, [], "the root never gets the new gesture");
  assert.equal(panel.handle.isFocused(), true);
  assert.deepEqual(panel.clicks, []);
  assert.deepEqual(f.dismissed, []);
});

test("the backdrop blocks new transcript selections, not native wheel scrolling", (t) => {
  const f = fixture(t);
  const scroll = new ScrollView(
    { render: () => Array(100).fill("background transcript"), invalidate() {} },
    { primary: true, scrollbar: "always" },
  );
  f.tui.setLayoutRoot(scroll);
  f.paint();
  const select = () => {
    f.press([1, 1]);
    f.drag([9, 1]);
    f.release([9, 1]);
    return f.tui.hasActiveSelection();
  };
  const dragBar = () => {
    const right = f.tui.terminal.columns - 1;
    const start = scroll.scrollTop;
    f.press([right, 15]);
    f.drag([right, 19]);
    f.release([right, 19]);
    return start !== scroll.scrollTop;
  };
  assert(dragBar(), "the visible root scrollbar can be dragged without an overlay");
  scroll.scrollTo(20);
  f.paint();
  const native = f.mount("native", { host: null });
  assert(select(), "native overlays allow transcript drag selection outside their bounds");
  assert(!dragBar(), "Pi already disables scrollbar grabs with a visible overlay");
  native.handle.hide();
  f.mount();
  assert(!select());
  assert(!dragBar());
  const before = scroll.scrollTop;
  f.send(65, [1, 1]);
  assert(scroll.scrollTop > before);
  assert.deepEqual(f.dismissed, []);
});

for (const [name, finish] of [
  ["release in a different cell", (f) => f.release([5, 8])],
  [
    "drag away and back",
    (f) => {
      f.drag([12, 8]);
      f.drag(backdrop);
      f.release();
    },
  ],
  [
    "terminal focus loss",
    (f) => {
      f.input("\x1b[O");
      f.input("\x1b[I");
      f.release();
    },
  ],
  [
    "terminal resize",
    (f) => {
      f.tui.terminal.columns++;
      f.paint();
      f.release();
    },
  ],
]) {
  test(`${name} cancels a backdrop gesture but not the next click`, (t) => {
    const f = fixture(t);
    const panel = f.mount();
    f.press();
    finish(f, panel);
    assert.deepEqual(f.dismissed, []);
    f.click();
    assert.deepEqual(f.dismissed, ["center"]);
  });
}

test("panel growth leaves a stationary backdrop click valid unless it covers the cell", (t) => {
  const f = fixture(t);
  const panel = f.mount();
  const { col, row } = panel.bounds();
  const covered = [col, row - 1];
  f.press(covered);
  panel.grow();
  assert.equal(panel.bounds().row, covered[1]);
  f.release(covered);
  assert.deepEqual(f.dismissed, []);
  assert.deepEqual(panel.clicks, [], "a newly covered cell gets no release or click");

  f.press();
  panel.grow();
  f.release();
  assert.deepEqual(f.dismissed, ["center"], "the cell is still unoccupied after repaint");
});

test("a second overlay painting over the pressed cell consumes the stale click", (t) => {
  const f = fixture(t);
  const lower = f.mount("lower", { width: 40, host: null });
  const upper = f.mount("upper");
  const { col, row } = lower.bounds();
  const covered = [col, row - 1];
  f.press(covered);
  lower.grow();
  assert.equal(lower.bounds().row, covered[1]);
  assert(upper.handle.isFocused());
  f.release(covered);
  assert.deepEqual(f.dismissed, []);
  assert.deepEqual(lower.clicks, []);
  f.click(covered);
  assert.deepEqual(lower.clicks, [[0, 0]], "only a fresh click acts on the exposed overlay");
});

for (const hidden of [true, false]) {
  test(`a ${hidden ? "hidden" : "visible but unfocused"} panel cannot dismiss`, (t) => {
    const f = fixture(t);
    const { handle } = f.mount();
    f.press();
    if (hidden) handle.setHidden(true);
    else handle.unfocus();
    f.paint();
    assert.equal(handle.isFocused(), false);
    if (!hidden) assert(handle.getBounds());
    f.release();
    f.click();
    assert.deepEqual(f.dismissed, []);
    if (hidden) handle.setHidden(false);
    else handle.focus();
    f.paint();
    f.click();
    assert.deepEqual(f.dismissed, ["center"]);
  });
}

test("focus loss and regain during a press cancels it but not a fresh click", (t) => {
  const f = fixture(t);
  const panel = f.mount();
  f.press();
  panel.handle.unfocus();
  panel.handle.focus();
  assert.equal(panel.handle.isFocused(), true);
  f.release();
  assert.deepEqual(f.dismissed, []);
  f.click();
  assert.deepEqual(f.dismissed, ["center"]);
});

test("modifiers, non-primary buttons and wheel events cannot dismiss", (t) => {
  const f = fixture(t);
  f.mount();
  const wheel = [];
  f.root.handleMouse = (event) => {
    if (event.type !== "wheel") return;
    wheel.push(event.wheelDelta);
    return { handled: true };
  };
  for (const code of [1, 2, 4, 8, 16]) {
    f.click(undefined, code);
    assert.deepEqual(f.dismissed, [], `SGR button code ${code}`);
  }
  f.press();
  f.release(undefined, 4);
  f.send(64);
  f.release();
  assert.equal(wheel.length, 1, "wheel is still routed natively");
  assert.deepEqual(f.dismissed, []);
});

test("disposal during a press disarms it and restores native input", (t) => {
  const f = fixture(t);
  const panel = f.mount();
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type !== "click") return;
    rootClicks++;
    return { handled: true };
  };
  f.press();
  panel.dispose();
  f.release();
  f.click();
  f.click(panel.cell());
  assert.equal(rootClicks, 1, "only the fresh backdrop click reaches the root");
  assert.deepEqual(f.dismissed, []);
  assert.deepEqual(panel.clicks, [[1, 1]]);
});

test("a successful dismissal cannot cascade or click through to a newly exposed root control", (t) => {
  const f = fixture(t);
  const lower = f.mount("lower");
  let exposed = false;
  const upper = f.mount("upper", {
    afterDismiss: () => {
      exposed = true;
    },
  });
  const activated = [];
  f.root.handleMouse = ({ type, x, y }) => {
    if (!exposed || type !== "click" || x !== backdrop[0] || y !== backdrop[1]) return;
    activated.push("new control");
    return { handled: true };
  };

  assert.equal(upper.handle.isFocused(), true);
  f.click();
  assert.deepEqual(f.dismissed, ["upper"]);
  assert.deepEqual(activated, []);
  assert.equal(lower.handle.isFocused(), true);

  f.click();
  assert.deepEqual(f.dismissed, ["upper", "lower"], "a fresh click can dismiss the lower panel");
  assert.deepEqual(activated, []);
  f.click();
  assert.deepEqual(activated, ["new control"], "native input resumes after the panels close");
});

test("an exposed part of another visible overlay uses native routing, not backdrop dismissal", (t) => {
  const f = fixture(t);
  // This overlay has no backdrop helper and claims only the synthesized click.
  const lower = f.mount("lower", { width: 40, host: null });
  const upper = f.mount("upper");
  assert.equal(upper.handle.isFocused(), true);
  const exposed = lower.cell();
  assert(exposed[0] < upper.bounds().col);
  f.click(exposed);
  assert.deepEqual(lower.clicks, [[1, 1]]);
  assert.deepEqual(upper.clicks, []);
  assert.equal(lower.handle.isFocused(), true);
  assert.deepEqual(f.dismissed, []);
});

test("the pinned interactive TUI reference registers backdrop clicks on its concrete renderer", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  let current = first.tui;
  const ref = createInteractiveTuiReference(() => current);
  first.mount("through reference", { host: ref });
  first.click();
  assert.deepEqual(first.dismissed, ["through reference"]);

  const previous = first.mount("old renderer", { host: ref });
  first.press();
  current = second.tui;
  first.release();
  assert.deepEqual(
    first.dismissed,
    ["through reference"],
    "an old press cannot dismiss after swap",
  );

  second.mount("native replacement", { host: null });
  let nativeClicks = 0;
  second.root.handleMouse = ({ type }) => {
    if (type !== "click") return;
    nativeClicks++;
    return { handled: true };
  };
  second.click();
  assert.equal(nativeClicks, 1, "the previous registration does not intercept replacement clicks");

  second.mount("new registration", { host: ref });
  previous.dispose();
  second.click();
  assert.deepEqual(second.dismissed, ["new registration"], "old cleanup must not detach new input");
  assert.equal(nativeClicks, 1);
});

test("a throwing backdrop hit test neither blocks another panel nor breaks native input", (t) => {
  const f = fixture(t);
  const broken = {
    isFocused: () => true,
    getBounds() {
      throw new Error("bounds unavailable");
    },
  };
  let brokenDismissals = 0;
  const tracker = createBackdropDismiss();
  tracker.focused = true;
  t.after(
    tracker.attach(f.tui, broken, () => {
      brokenDismissals++;
    }),
  );
  f.mount();
  f.click([1, 3]);
  assert.deepEqual(f.dismissed, ["center"]);
  assert.deepEqual(f.opened, []);
  f.click([1, 3]);
  assert.deepEqual(f.opened, [link], "native fallback receives a fresh gesture");
  assert.equal(brokenDismissals, 0);
});

test("a failing release-time bounds check does not strand the native press target", (t) => {
  const f = fixture(t);
  const { handle } = f.mount("center", { host: null });
  let fail = false;
  const tracker = createBackdropDismiss();
  tracker.focused = true;
  const stop = tracker.attach(
    f.tui,
    {
      isFocused: handle.isFocused,
      getBounds() {
        if (fail) throw new Error("bounds unavailable");
        return handle.getBounds();
      },
    },
    () => f.dismissed.push("center"),
  );
  t.after(stop);
  f.press([1, 3]);
  fail = true;
  f.release([1, 3]);
  assert.deepEqual(f.dismissed, []);
  assert.deepEqual(f.opened, []);
  fail = false;
  f.click();
  assert.deepEqual(f.dismissed, ["center"]);
});

test("an unrelated zero-height overlay does not block dismissal", (t) => {
  const f = fixture(t);
  f.mount("empty", { height: 0, host: null });
  f.mount();
  f.click();
  assert.deepEqual(f.dismissed, ["center"]);
});

test("a focused empty target does not dismiss and root input remains native", (t) => {
  const f = fixture(t);
  const panel = f.mount("empty", { height: 0 });
  assert.equal(panel.handle.isFocused(), true);
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type === "click") rootClicks++;
    return { handled: true };
  };
  f.click();
  assert.deepEqual(f.dismissed, []);
  assert.equal(rootClicks, 1);
});

test("a throwing dismissal cannot escape or strand native capture", (t) => {
  const f = fixture(t);
  const panel = f.mount("center", { host: null });
  let calls = 0;
  const tracker = createBackdropDismiss();
  tracker.focused = true;
  const stop = tracker.attach(f.tui, panel.handle, () => {
    calls++;
    stop();
    panel.handle.hide();
    throw new Error("dismiss failed");
  });
  t.after(stop);
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type === "click") rootClicks++;
    return { handled: true };
  };
  f.click();
  assert.equal(calls, 1);
  assert.equal(rootClicks, 0);
  f.click();
  assert.equal(rootClicks, 1);
});

test("malformed layout declines a new backdrop press", (t) => {
  const f = fixture(t);
  f.mount();
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type === "click") rootClicks++;
    return { handled: true };
  };
  const layouts = f.tui.renderedOverlayLayouts;
  const malformed = { row: 100, col: 0, width: NaN, height: 1 };
  layouts.push(malformed);
  f.click();
  assert.deepEqual(f.dismissed, []);
  assert.equal(rootClicks, 1, "unverifiable press follows native routing");
});

test("a layout becoming malformed consumes the captured release", (t) => {
  const f = fixture(t);
  f.mount();
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type === "click") rootClicks++;
    return { handled: true };
  };
  const layouts = f.tui.renderedOverlayLayouts;
  f.press();
  layouts.push({ row: 100, col: 0, width: NaN, height: 1 });
  f.release();
  assert.deepEqual(f.dismissed, []);
  assert.equal(rootClicks, 0, "captured release does not click through");
  layouts.pop();
  f.click();
  assert.deepEqual(f.dismissed, ["center"]);
});

test("a non-forwarding focused handle leaves backdrop clicks native", (t) => {
  const f = fixture(t);
  const panel = f.mount("center", { host: null });
  const tracker = createBackdropDismiss();
  let dismissals = 0;
  t.after(
    tracker.attach(f.tui, panel.handle, () => {
      dismissals++;
    }),
  );
  let rootClicks = 0;
  f.root.handleMouse = ({ type }) => {
    if (type === "click") rootClicks++;
    return { handled: true };
  };
  assert.equal(panel.handle.isFocused(), true);
  f.click();
  assert.equal(dismissals, 0);
  assert.equal(rootClicks, 1);
  assert.equal(panel.handle.isFocused(), true);
});

test("missing host methods leave backdrop dismissal inert and disposable", () => {
  const handle = {
    isFocused: () => true,
    getBounds: () => ({ row: 4, col: 4, width: 20, height: 4 }),
  };
  const dispose = createBackdropDismiss().attach({ mode: "fullscreen" }, handle, () => {
    assert.fail("unsupported host dismissed");
  });
  dispose();
});
