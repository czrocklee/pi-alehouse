import assert from "node:assert/strict";
import test from "node:test";
import { createPopoverTextSelection } from "../../src/shared/popover-text-selection.mjs";

const ANCHOR_KEY = Symbol.for("pi-alehouse.popover-text-selection.anchor.v1");
const METHODS = [
  "handleSelectionMouseEvent",
  "getSelectionPoint",
  "getWordSelection",
  "getLineSelection",
  "getSelectionColumns",
  "getSelectionBounds",
  "resetTextSelection",
];

// A deliberately small native-like host: real wrappers are installed over it,
// then a fresh press exercises the same two getSelectionPoint calls as pi-tui.
function fixture() {
  const entry = { component: {}, hidden: false, options: {}, focusOrder: 1 };
  const layout = { entry, row: 2, col: 5, width: 20, height: 10 };
  const host = {
    terminal: { columns: 80, rows: 24 },
    overlayStack: [entry],
    renderedOverlayLayouts: [layout],
    selectionAnchor: undefined,
    selectionFocus: undefined,
    selectionPressActive: false,
    resetCalls: 0,
    handleSelectionMouseEvent(event) {
      const anchorScrollView = this.selectionAnchor?.scrollView;
      const point = this.getSelectionPoint(event, anchorScrollView);
      if (event.release) {
        if (!this.selectionPressActive) return;
        this.selectionPressActive = false;
        this.selectionFocus = point;
        return;
      }
      if ((event.button & 32) !== 0) {
        this.selectionFocus = point;
        return;
      }
      this.selectionPressActive = true;
      const anchor = this.getSelectionPoint(event, undefined);
      this.selectionAnchor = anchor;
      this.selectionFocus = anchor;
    },
    getSelectionPoint(event, scrollView) {
      const point = { row: event.y, col: event.x };
      if (scrollView) point.scrollView = scrollView;
      return point;
    },
    getWordSelection(point) {
      return { start: { ...point, col: 0 }, end: { ...point, col: 5 } };
    },
    getLineSelection(point) {
      return { start: { ...point, col: 0 }, end: { ...point, col: 80 } };
    },
    getSelectionColumns(line, row, selection, minColumn = 0, maxColumn = line.length) {
      let start = Math.max(0, minColumn);
      let end = Math.min(line.length, maxColumn);
      if (row === selection.start.row) start = Math.max(start, selection.start.col);
      if (row === selection.end.row) end = Math.min(end, selection.end.col + 1);
      return { start, end };
    },
    getSelectionBounds() {
      if (!this.selectionAnchor || !this.selectionFocus) return undefined;
      return { start: this.selectionAnchor, end: this.selectionFocus };
    },
    resetTextSelection() {
      this.resetCalls += 1;
      this.selectionAnchor = undefined;
      this.selectionFocus = undefined;
      this.selectionPressActive = false;
    },
  };
  const press = (x = 6, y = 3) =>
    host.handleSelectionMouseEvent({ button: 0, x, y, release: false });
  return { host, entry, layout, press };
}

function originalMethods(host) {
  return Object.fromEntries(METHODS.map((method) => [method, host[method]]));
}

test("missing, incomplete and nonreplaceable hosts keep native methods untouched", () => {
  for (const host of [undefined, {}, { handleSelectionMouseEvent() {} }]) {
    const tracker = createPopoverTextSelection({ host, component: {} });
    assert.doesNotThrow(() => {
      tracker.paint({ x: 0, y: 0, width: 1, height: 1 });
      tracker.reset();
      tracker.dispose();
    });
  }

  const { host } = fixture();
  const original = originalMethods(host);
  Object.defineProperty(host, "getSelectionBounds", {
    value: original.getSelectionBounds,
    writable: false,
    configurable: false,
  });
  const tracker = createPopoverTextSelection({ host, component: {} });
  tracker.paint({ x: 1, y: 1, width: 2, height: 2 });
  tracker.dispose();
  for (const method of METHODS) assert.equal(host[method], original[method], method);
});

test("install is atomic and rolls back earlier methods when one definition fails", () => {
  const { host, entry } = fixture();
  const original = originalMethods(host);
  const proxy = new Proxy(host, {
    defineProperty(target, property, descriptor) {
      if (property === "getSelectionBounds") throw new Error("synthetic failure");
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
  const tracker = createPopoverTextSelection({ host: proxy, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 2, height: 2 });
  tracker.dispose();
  for (const method of METHODS) assert.equal(host[method], original[method], method);
});

test("malformed layouts and absent painted rectangles never admit a selection", () => {
  for (const layouts of [
    undefined,
    null,
    {},
    [{}],
    [{ entry: {}, row: 0, col: 0, width: 0, height: 0 }],
  ]) {
    const { host, entry, press } = fixture();
    host.renderedOverlayLayouts = layouts;
    const tracker = createPopoverTextSelection({ host, component: entry.component });
    tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
    assert.doesNotThrow(() => press());
    assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined);
    tracker.dispose();
  }

  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint(undefined);
  press();
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined);
  tracker.dispose();
});

test("a fresh press binds only an exact component body and clamps native points", () => {
  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.notEqual(host.selectionAnchor[ANCHOR_KEY], undefined);
  assert.equal(host.selectionAnchor.row, 3);
  assert.equal(host.selectionAnchor.col, 6);
  assert.equal(host.selectionAnchor.scrollView, undefined);

  // Drag far outside the body clamps to the declared rectangle.
  host.handleSelectionMouseEvent({ button: 32, x: 99, y: 99, release: false });
  assert.equal(host.selectionFocus.row, 10);
  assert.equal(host.selectionFocus.col, 23);
  assert.equal(host.selectionFocus.scrollView, undefined);

  const bounds = host.getSelectionBounds();
  assert(bounds);
  assert.equal(bounds.start.row, 3);
  assert.equal(bounds.end.row, 10);
  tracker.dispose();
});

test("chrome binds an empty gesture while foreign or hidden overlays stay native", () => {
  const { host, entry, layout, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });

  press(5, 2); // title/border cell, outside the declared body
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined, "chrome has a lifecycle owner");
  assert.equal(host.selectionPressActive, true, "native release must still synthesize clicks");
  assert.equal(host.getSelectionBounds(), undefined, "the owned chrome gesture selects no text");
  assert.deepEqual(host.getWordSelection(host.selectionAnchor), {
    start: host.selectionAnchor,
    end: host.selectionAnchor,
  });
  assert.deepEqual(host.getLineSelection(host.selectionAnchor), {
    start: host.selectionAnchor,
    end: host.selectionAnchor,
  });

  press(6, 3);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined);

  // A newer overlay under the pointer wins even when it is not registered.
  const newer = { component: {}, hidden: false, options: {}, focusOrder: 2 };
  host.overlayStack.push(newer);
  host.renderedOverlayLayouts.push({ entry: newer, row: 2, col: 5, width: 20, height: 10 });
  press(6, 3);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined);

  host.overlayStack.pop();
  host.renderedOverlayLayouts.pop();
  entry.hidden = true;
  press(6, 3);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined);
  assert.equal(layout.entry, entry);
  tracker.dispose();
});

test("paint geometry and viewport-key changes cancel only the owning member", () => {
  const { host, entry, press } = fixture();
  const owner = createPopoverTextSelection({ host, component: entry.component });
  const other = createPopoverTextSelection({ host, component: {} });
  owner.paint({ x: 1, y: 1, width: 18, height: 8 }, "a");
  other.paint({ x: 1, y: 1, width: 18, height: 8 }, "a");
  press(6, 3);
  assert.equal(host.resetCalls, 0);

  other.paint({ x: 1, y: 1, width: 17, height: 8 }, "b");
  other.reset();
  assert.equal(host.resetCalls, 0, "a non-owner cannot cancel the live selection");

  owner.paint({ x: 1, y: 1, width: 17, height: 8 }, "a");
  assert.equal(host.resetCalls, 1);
  assert.equal(host.selectionAnchor, undefined);

  press(6, 3);
  owner.paint({ x: 1, y: 1, width: 17, height: 8 }, "b");
  assert.equal(host.resetCalls, 2, "a viewport-key change cancels a bound selection");
  owner.dispose();
  other.dispose();
});

test("reset and dispose cancel owned selection, retire geometry and restore methods", () => {
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  tracker.reset();
  assert.equal(host.resetCalls, 1);
  assert.equal(host.selectionAnchor, undefined);
  press(6, 3);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined, "reset retires admission");
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  tracker.dispose();
  assert.equal(host.resetCalls, 2);
  for (const method of METHODS) assert.equal(host[method], original[method], method);
});

test("multiple members share one bridge and only the final dispose restores it", () => {
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const first = createPopoverTextSelection({ host, component: entry.component });
  const second = createPopoverTextSelection({ host, component: {} });
  first.paint({ x: 1, y: 1, width: 18, height: 8 });
  second.paint({ x: 1, y: 1, width: 18, height: 8 });
  const wrapper = host.handleSelectionMouseEvent;
  assert.notEqual(wrapper, original.handleSelectionMouseEvent);

  press(6, 3);
  second.dispose();
  assert.equal(host.handleSelectionMouseEvent, wrapper);
  assert.notEqual(host.selectionAnchor, undefined, "disposing a non-owner keeps the selection");
  first.dispose();
  assert.equal(host.selectionAnchor, undefined, "disposing the owner cancels it");
  for (const method of METHODS) assert.equal(host[method], original[method], method);
});

test("separately bundled imports share the host bridge and restore only once", async () => {
  const { createPopoverTextSelection: otherFactory } =
    await import("../../src/shared/popover-text-selection.mjs?unit-separate-instance");
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const first = createPopoverTextSelection({ host, component: entry.component });
  first.paint({ x: 1, y: 1, width: 18, height: 8 });
  const wrapper = host.handleSelectionMouseEvent;
  const second = otherFactory({ host, component: entry.component });
  second.paint({ x: 1, y: 1, width: 18, height: 8 });
  assert.equal(host.handleSelectionMouseEvent, wrapper, "one bridge serves both bundles");

  press(6, 3);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined);
  first.dispose();
  assert.equal(host.handleSelectionMouseEvent, wrapper);
  second.dispose();
  for (const method of METHODS) assert.equal(host[method], original[method], method);
});

test("foreign native anchors clear stale ownership without clamping unrelated selection", () => {
  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined);

  // Native focus-out/scrollbar/handled-control paths clear fields directly.
  host.selectionAnchor = { row: 20, col: 40 };
  host.selectionFocus = { row: 21, col: 41 };
  const bounds = host.getSelectionBounds();
  assert.deepEqual(bounds, { start: host.selectionAnchor, end: host.selectionFocus });
  assert.equal(host.resetCalls, 0, "a foreign anchor is not ours to cancel");

  // A new fresh root press chooses no domain and remains unbounded.
  press(40, 20);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined);
  assert.equal(host.selectionAnchor.col, 40);
  tracker.dispose();
});

test("a throwing live reset falls back to the captured original", () => {
  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  host.resetTextSelection = () => {
    throw new Error("live reset failed");
  };
  tracker.reset();
  assert.equal(host.resetCalls, 1, "the captured original still cancels");
  assert.equal(host.selectionAnchor, undefined);
  assert.equal(host.getSelectionBounds(), undefined);
  tracker.dispose();
});

test("when both reset paths fail the owned anchor stays suppressed until a fresh press", () => {
  const { host, entry, press } = fixture();
  const originalReset = host.resetTextSelection;
  host.resetTextSelection = () => {
    throw new Error("captured reset failed");
  };
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  tracker.reset();
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined, "the native anchor is still live");
  assert.equal(host.getSelectionBounds(), undefined, "bounds stay suppressed");
  assert.deepEqual(
    host.getSelectionColumns("abcdef", 3, {
      start: host.selectionAnchor,
      end: host.selectionFocus,
    }),
    { start: 0, end: 0 },
    "copy columns stay empty",
  );

  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.equal(host.getSelectionBounds()?.start.row, 3, "a fresh press replaces the tombstone");

  host.resetTextSelection = originalReset;
  tracker.dispose();
});

test("a partial hook takeover retires the bridge without stacking or overwriting the foreign hook", () => {
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const first = createPopoverTextSelection({ host, component: entry.component });
  const second = createPopoverTextSelection({ host, component: {} });
  first.paint({ x: 1, y: 1, width: 18, height: 8 });
  second.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.equal(host.resetCalls, 0);

  const foreign = () => ({ start: 0, end: 0 });
  host.getSelectionColumns = foreign;
  const third = createPopoverTextSelection({ host, component: {} });
  third.paint({ x: 1, y: 1, width: 18, height: 8 });

  assert.equal(host.resetCalls, 1, "the owned live selection is cancelled before retirement");
  assert.equal(host.selectionAnchor, undefined);
  assert.equal(host.getSelectionColumns, foreign, "the foreign replacement is preserved");
  for (const method of METHODS) {
    if (method === "getSelectionColumns") continue;
    assert.equal(host[method], original[method], `${method} is detached, not stacked`);
  }

  first.dispose();
  second.dispose();
  third.dispose();
  assert.equal(
    host.getSelectionColumns,
    foreign,
    "later cleanup never overwrites the foreign method",
  );
  for (const method of METHODS) {
    if (method === "getSelectionColumns") continue;
    assert.equal(host[method], original[method], `${method} remains restored`);
  }
});

test("a partial hook takeover is detected at the bounds gate without a new tracker", () => {
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined);

  host.getSelectionColumns = original.getSelectionColumns;
  assert.equal(host.getSelectionBounds(), undefined, "the same bounds invocation is suppressed");
  assert.equal(host.resetCalls, 1, "the owned selection is cancelled before retirement");
  assert.equal(host.selectionAnchor, undefined);
  assert.equal(
    host.getSelectionColumns,
    original.getSelectionColumns,
    "the foreign hook is retained",
  );
  for (const method of METHODS) {
    if (method === "getSelectionColumns") continue;
    assert.equal(host[method], original[method], `${method} is restored, not stacked`);
  }

  tracker.dispose();
  assert.equal(host.getSelectionColumns, original.getSelectionColumns);
});

test("a no-op live reset falls back to the captured original", () => {
  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  host.resetTextSelection = () => {};
  tracker.reset();
  assert.equal(host.resetCalls, 1, "the captured original actually clears the anchor");
  assert.equal(host.selectionAnchor, undefined);
  assert.equal(host.getSelectionBounds(), undefined);
  tracker.dispose();
});

test("when both reset paths are no-ops the owned anchor stays suppressed until a fresh press", () => {
  const { host, entry, press } = fixture();
  const originalReset = host.resetTextSelection;
  host.resetTextSelection = () => {};
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  tracker.reset();
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined, "the native anchor is still live");
  assert.equal(host.getSelectionBounds(), undefined, "bounds stay suppressed");
  assert.deepEqual(
    host.getSelectionColumns("abcdef", 3, {
      start: host.selectionAnchor,
      end: host.selectionFocus,
    }),
    { start: 0, end: 0 },
    "copy columns stay empty",
  );

  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.equal(host.getSelectionBounds()?.start.row, 3, "a fresh press replaces the tombstone");

  host.resetTextSelection = originalReset;
  tracker.dispose();
});

test("a terminal resize without repaint suppresses a fresh body press until paint", () => {
  const { host, entry, press } = fixture();
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  host.terminal.columns -= 1;
  press(6, 3);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined, "stale paint is not admitted");
  assert.equal(host.resetCalls, 1, "the fresh native gesture is cancelled");

  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined, "repaint admits the body again");
  assert.equal(host.getSelectionBounds()?.start.row, 3);
  tracker.dispose();
});

test("a retained retired bridge refuses new members even if hooks are restored", () => {
  const { host, entry, press } = fixture();
  const original = originalMethods(host);
  const originalReset = host.resetTextSelection;
  host.resetTextSelection = () => {
    throw new Error("captured reset failed");
  };
  const first = createPopoverTextSelection({ host, component: entry.component });
  first.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);

  const wrapperColumns = host.getSelectionColumns;
  host.getSelectionColumns = () => ({ start: 0, end: 0 });
  assert.equal(host.getSelectionBounds(), undefined);
  assert.notEqual(host.selectionAnchor?.[ANCHOR_KEY], undefined, "tombstone retained");

  // Restoring the foreign hook to our old wrapper makes installed() true again.
  host.getSelectionColumns = wrapperColumns;
  const third = createPopoverTextSelection({ host, component: entry.component });
  third.paint({ x: 1, y: 1, width: 18, height: 8 });
  press(6, 3);
  assert.equal(host.selectionAnchor?.[ANCHOR_KEY], undefined, "retired bridge is not revived");

  host.resetTextSelection = originalReset;
  host.getSelectionBounds();
  assert.equal(
    host.handleSelectionMouseEvent,
    original.handleSelectionMouseEvent,
    "the retired tombstone detaches when the gate sees it again",
  );
  first.dispose();
  third.dispose();
});

test("a structurally unsupported host caches failure instead of retrying every paint", () => {
  const { host, entry } = fixture();
  delete host.resetTextSelection;
  let reads = 0;
  const originalBounds = host.getSelectionBounds;
  Object.defineProperty(host, "getSelectionBounds", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return originalBounds;
    },
  });
  const tracker = createPopoverTextSelection({ host, component: entry.component });
  const afterCreate = reads;
  assert(afterCreate > 0, "the first install attempt reads the hook");
  tracker.paint({ x: 1, y: 1, width: 18, height: 8 });
  tracker.paint({ x: 1, y: 1, width: 17, height: 8 });
  tracker.reset();
  assert.equal(reads, afterCreate, "failed install is cached for the member");
  tracker.dispose();
});
