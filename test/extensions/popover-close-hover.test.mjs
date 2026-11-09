import assert from "node:assert/strict";
import test from "node:test";
import { createPopoverCloseHover } from "../../src/shared/popover-close-hover.mjs";
import { popoverCloseHit } from "../../src/shared/popover-frame.mjs";

const inside = { type: "move", button: "none", x: 15, y: 0 };

function fixture(t, factory = createPopoverCloseHover, closeHit = popoverCloseHit) {
  let receive = () => undefined;
  let renders = 0;
  const calls = [];
  const host = {
    handleViewportInput(...args) {
      calls.push({ receiver: this, args });
      return receive(...args);
    },
  };
  const original = host.handleViewportInput;
  const tracker = factory({ host, closeHit, requestRender: () => renders++ });
  t.after(() => tracker.dispose());
  return {
    host,
    original,
    tracker,
    calls,
    get renders() {
      return renders;
    },
    route(fn) {
      receive = fn;
    },
    dispatch(event = inside, target = tracker) {
      receive = () => target.mouse(event);
      return host.handleViewportInput("native-input");
    },
  };
}

test("only the painted top-row closing tail accepts button-free movement", (t) => {
  const h = fixture(t);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "unpainted geometry is dead");
  h.tracker.paint(20);
  for (const x of [15, 16, 17, 18, 19]) {
    h.dispatch({ type: "move", x, y: 0 });
    assert.equal(h.tracker.hovered, true, `tail column ${x}`);
  }
  assert.equal(h.renders, 1, "repeated motion inside the same tail does not repaint");
  for (const event of [
    { ...inside, x: 14 },
    { ...inside, x: 20 },
    { ...inside, x: -1 },
    { ...inside, y: 1 },
    { ...inside, y: -1 },
    { type: "move", y: 0 },
    { type: "move", x: 15 },
    { ...inside, x: NaN },
    { ...inside, y: NaN },
    { ...inside, button: "left" },
    { ...inside, button: "right" },
    { ...inside, button: "middle" },
    ...["press", "release", "click", "drag", "wheel", "leave", "unknown"].map((type) => ({
      ...inside,
      type,
    })),
  ]) {
    h.dispatch();
    assert.equal(h.tracker.hovered, true);
    const before = h.renders;
    h.dispatch(event);
    assert.equal(h.tracker.hovered, false, JSON.stringify(event));
    assert.equal(h.renders, before + 1);
    h.dispatch(event);
    assert.equal(h.renders, before + 1, "remaining outside is not another repaint");
  }
});

test("the supplied shared hit test is the sole authority for close eligibility", (t) => {
  let enabled = false;
  const widths = [];
  const h = fixture(t, createPopoverCloseHover, (width) => {
    widths.push(width);
    return enabled ? popoverCloseHit(width) : undefined;
  });
  h.tracker.paint(20);
  h.dispatch();
  assert.equal(
    h.tracker.hovered,
    false,
    "a normally valid tail cannot override supplied eligibility",
  );
  assert(widths.includes(20), "paint consults the supplied hit test");
  enabled = true;
  h.tracker.paint(20);
  h.dispatch();
  assert.equal(h.tracker.hovered, true);
  enabled = false;
  h.tracker.paint(20);
  assert.equal(h.tracker.hovered, false, "revoked shared eligibility retires hover");
  assert.equal(h.host.handleViewportInput, h.original);
});

test("native dispatch with no normalized revalidation clears an earlier hover", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  for (const raw of [
    "outside-root-move",
    "other-overlay",
    "keyboard",
    "focus-in",
    "focus-out",
    "wheel",
    "native-consumed",
  ]) {
    h.dispatch();
    assert.equal(h.tracker.hovered, true);
    const before = h.renders;
    h.route(() => ({ consume: true }));
    assert.deepEqual(h.host.handleViewportInput(raw), { consume: true });
    assert.equal(h.tracker.hovered, false, raw);
    assert.equal(h.renders, before + 1);
  }
});

test("one host shares a wrapper and transfers hover between independently painted overlays", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const wrapper = h.host.handleViewportInput;
  let otherRenders = 0;
  const other = createPopoverCloseHover({
    host: h.host,
    closeHit: popoverCloseHit,
    requestRender: () => otherRenders++,
  });
  t.after(() => other.dispose());
  other.paint(20);
  assert.equal(h.host.handleViewportInput, wrapper);
  h.dispatch(inside, other);
  assert.equal(h.host.handleViewportInput, wrapper);
  assert.equal(h.tracker.hovered, false);
  assert.equal(other.hovered, true);
  assert.equal(h.renders, 2);
  assert.equal(otherRenders, 1);
  h.dispatch(inside, other);
  assert.equal(otherRenders, 1);
  other.dispose();
  assert.equal(other.hovered, false);
  assert.equal(h.host.handleViewportInput, h.original, "the last hover leaving releases the seam");
  h.dispatch();
  assert.equal(h.tracker.hovered, true);
  h.tracker.dispose();
  assert.equal(h.host.handleViewportInput, h.original);
});

test("separately imported helper instances share the same per-host bridge", async (t) => {
  const { createPopoverCloseHover: otherFactory } =
    await import("../../src/shared/popover-close-hover.mjs?separate-hover-test-instance");
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const wrapper = h.host.handleViewportInput;
  const other = otherFactory({ host: h.host, closeHit: popoverCloseHit, requestRender() {} });
  t.after(() => other.dispose());
  other.paint(20);
  assert.equal(h.host.handleViewportInput, wrapper, "do not stack independent module wrappers");
  h.dispatch();
  h.dispatch(inside, other);
  assert.equal(h.tracker.hovered, false);
  assert.equal(other.hovered, true);
  h.tracker.dispose();
  assert.equal(h.host.handleViewportInput, wrapper);
  other.dispose();
  assert.equal(h.host.handleViewportInput, h.original);
});

test("disable, narrow paint, resized geometry, reset and disposal retire stale hover", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  h.tracker.paint(20, false);
  assert.equal(h.tracker.hovered, false);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "a hidden close cannot be hovered");
  for (const width of [0, 1, 8]) {
    h.tracker.paint(width);
    h.dispatch({ ...inside, x: Math.max(0, width - 1) });
    assert.equal(h.tracker.hovered, false, `narrow width ${width}`);
  }
  h.tracker.paint(9);
  h.dispatch({ ...inside, x: 4 });
  assert.equal(h.tracker.hovered, true, "nine columns is the shared minimum");
  h.tracker.paint(30);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "old width's tail is no longer a hit");
  h.dispatch({ ...inside, x: 25 });
  assert.equal(h.tracker.hovered, true);
  h.tracker.reset();
  assert.equal(h.tracker.hovered, false);
  assert.equal(h.host.handleViewportInput, h.original, "reset releases the last bridge reference");
  h.dispatch({ ...inside, x: 25 });
  assert.equal(h.tracker.hovered, false, "reset also retires painted geometry");
  h.tracker.paint(20);
  h.dispatch();
  assert.equal(h.tracker.hovered, true, "a fresh paint may reacquire after reset");
  h.tracker.dispose();
  h.tracker.dispose();
  h.tracker.paint(20);
  h.tracker.mouse(inside);
  assert.equal(h.tracker.hovered, false, "dispose is permanent and idempotent");
  assert.equal(h.host.handleViewportInput, h.original);
});

test("silent pointer retirement detaches the bridge without scheduling another paint", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const before = h.renders;
  h.tracker.reset(false);
  assert.equal(h.tracker.hovered, false);
  assert.equal(h.host.handleViewportInput, h.original);
  assert.equal(h.renders, before);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "silent reset still retires pointer geometry");
  h.tracker.paint(20);
  h.dispatch();
  assert.equal(h.renders, before + 1);
  h.tracker.reset();
  assert.equal(h.renders, before + 2, "standalone reset retains its default repaint");
});

test("the bridge preserves exact receiver, arguments, results and thrown errors", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const receiver = { marker: "borrowed receiver" };
  const args = [{ raw: "opaque" }, Symbol("extra"), undefined];
  const result = { consume: true, data: "unchanged" };
  h.route(() => result);
  assert.equal(h.host.handleViewportInput.apply(receiver, args), result);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].receiver, receiver);
  assert.deepEqual(h.calls[1].args, args);
  h.dispatch();
  const error = new Error("native input failure");
  h.route(() => {
    throw error;
  });
  assert.throws(
    () => h.host.handleViewportInput("throw"),
    (caught) => caught === error,
  );
  assert.equal(h.tracker.hovered, false, "finally retires hover even on a native failure");
  assert.equal(h.calls.length, 4, "the original is always called exactly once");
});

test("unsupported hosts remain untouched and never enable hover", (t) => {
  const readonly = {};
  const accessor = {};
  Object.defineProperty(readonly, "handleViewportInput", { value() {}, writable: false });
  Object.defineProperty(accessor, "handleViewportInput", {
    get: () => () => undefined,
    configurable: true,
  });
  for (const host of [
    undefined,
    {},
    { handleViewportInput: 1 },
    readonly,
    accessor,
    Object.freeze({ handleViewportInput() {} }),
  ]) {
    const before = host && Object.getOwnPropertyDescriptors(host);
    let renders = 0;
    const tracker = createPopoverCloseHover({
      host,
      closeHit: popoverCloseHit,
      requestRender: () => renders++,
    });
    t.after(() => tracker.dispose());
    tracker.paint(20);
    tracker.mouse(inside);
    assert.equal(tracker.hovered, false);
    tracker.reset();
    tracker.dispose();
    assert.equal(renders, 0);
    if (host) assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
  }
});

test("teardown preserves a later host wrapper instead of clobbering it", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const replacement = () => "new host owner";
  h.host.handleViewportInput = replacement;
  h.tracker.mouse(inside);
  assert.equal(h.tracker.hovered, false, "a mismatched seam cannot keep hover active");
  h.tracker.reset();
  h.tracker.dispose();
  assert.equal(h.host.handleViewportInput, replacement);
  assert.equal(h.host.handleViewportInput(), "new host owner");
});

test("restoring an inherited host method does not leave a shadow property", () => {
  const prototype = { handleViewportInput() {} };
  const host = Object.create(prototype);
  const before = Object.getOwnPropertyDescriptors(host);
  const tracker = createPopoverCloseHover({ host, closeHit: popoverCloseHit, requestRender() {} });
  tracker.paint(20);
  tracker.mouse(inside);
  assert.notEqual(host.handleViewportInput, prototype.handleViewportInput);
  tracker.dispose();
  assert.equal(host.handleViewportInput, prototype.handleViewportInput);
  assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
});

test("configurable readonly data methods support hover and restore their exact descriptor", () => {
  const host = {};
  const original = () => "native-result";
  Object.defineProperty(host, "handleViewportInput", {
    value: original,
    writable: false,
    configurable: true,
    enumerable: true,
  });
  const descriptor = Object.getOwnPropertyDescriptor(host, "handleViewportInput");
  const tracker = createPopoverCloseHover({ host, closeHit: popoverCloseHit, requestRender() {} });
  try {
    tracker.paint(20);
    tracker.mouse(inside);
    assert.equal(tracker.hovered, true);
    assert.notEqual(host.handleViewportInput, original);
    assert.equal(host.handleViewportInput("outside"), "native-result");
    assert.equal(tracker.hovered, false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(host, "handleViewportInput"), descriptor);
    tracker.mouse(inside);
    assert.equal(tracker.hovered, true);
  } finally {
    tracker.dispose();
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(host, "handleViewportInput"), descriptor);
});

test("terminal resize makes unpainted geometry dead until a fresh paint", (t) => {
  const h = fixture(t);
  h.host.terminal = { columns: 80, rows: 40 };
  h.tracker.paint(20);
  h.dispatch();
  h.host.terminal.columns = 81;
  h.dispatch();
  assert.equal(h.tracker.hovered, false);
  assert.equal(h.host.handleViewportInput, h.original);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "a second move cannot revive stale geometry");
  h.tracker.paint(20);
  h.dispatch();
  assert.equal(h.tracker.hovered, true);
  h.host.terminal.rows = 39;
  h.tracker.paint(20);
  assert.equal(h.tracker.hovered, false, "even unchanged panel width observes viewport resize");
});

test("stable actual height and preliminary paints preserve hover without redundant repaint", (t) => {
  const h = fixture(t);
  h.host.terminal = { columns: 80, rows: 40 };
  h.tracker.paint(20, true, 3);
  h.dispatch();
  assert.equal(h.tracker.hovered, true);
  assert.equal(h.renders, 1);
  for (let i = 0; i < 3; i++) {
    h.tracker.paint(20);
    h.tracker.paint(20, true, 3);
    h.dispatch();
    assert.equal(h.tracker.hovered, true);
    assert.equal(h.renders, 1, "unchanged actual geometry is not another repaint");
  }
  h.tracker.paint(20, true, 7);
  assert.equal(h.tracker.hovered, false, "height-only growth retires the stationary highlight");
  assert.equal(h.renders, 1, "the current paint already emits the cleared highlight");
  assert.equal(h.host.handleViewportInput, h.original);
  h.tracker.paint(20);
  h.tracker.paint(20, true, 7);
  assert.equal(h.tracker.hovered, false, "painting does not fabricate new pointer motion");
  h.dispatch();
  assert.equal(h.tracker.hovered, true);
  h.tracker.paint(20);
  assert.equal(h.tracker.hovered, true, "an omitted interim height preserves the actual height");
  h.tracker.paint(20, true, 3);
  assert.equal(h.tracker.hovered, false, "the previous actual height survives interim paint");
  assert.equal(h.renders, 2, "geometry-only cleanup must not schedule another frame");
  assert.deepEqual(h.host.terminal, { columns: 80, rows: 40 });
});

test("invalid actual heights, reset and disposal retire height-bound close geometry", (t) => {
  const h = fixture(t);
  for (const height of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    h.tracker.paint(20, true, 3);
    h.dispatch();
    assert.equal(h.tracker.hovered, true);
    h.tracker.paint(20, true, height);
    assert.equal(h.tracker.hovered, false, `invalid actual height ${height}`);
    assert.equal(h.host.handleViewportInput, h.original);
    h.dispatch();
    assert.equal(h.tracker.hovered, false, "invalid-height paint leaves no live close hit");
  }
  h.tracker.paint(20, true, 7);
  h.dispatch();
  h.tracker.reset();
  assert.equal(h.tracker.hovered, false);
  h.dispatch();
  assert.equal(h.tracker.hovered, false, "reset cannot revalidate the old height-bound geometry");
  h.tracker.paint(20, true, 3);
  h.dispatch();
  assert.equal(h.tracker.hovered, true, "fresh actual geometry can reenable after reset");
  h.tracker.dispose();
  for (const height of [3, 7]) {
    h.tracker.paint(20, true, height);
    h.dispatch();
    assert.equal(h.tracker.hovered, false, "new heights cannot revive a disposed tracker");
  }
  assert.equal(h.host.handleViewportInput, h.original);
});

test("different TUI hosts do not clear each other's close hover", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  a.tracker.paint(20);
  b.tracker.paint(20);
  a.dispatch();
  b.dispatch();
  assert.equal(a.tracker.hovered, true);
  assert.equal(b.tracker.hovered, true);
  a.route(() => undefined);
  a.host.handleViewportInput("outside");
  assert.equal(a.tracker.hovered, false);
  assert.equal(b.tracker.hovered, true);
  assert.equal(a.host.handleViewportInput, a.original);
  assert.notEqual(b.host.handleViewportInput, b.original);
});

test("nested native dispatch revalidation preserves hover and exact nested results", (t) => {
  const h = fixture(t);
  h.tracker.paint(20);
  h.dispatch();
  const childResult = {};
  const outerResult = {};
  h.route((data) => {
    if (data === "child") {
      h.tracker.mouse(inside);
      return childResult;
    }
    assert.equal(h.host.handleViewportInput("child"), childResult);
    return outerResult;
  });
  assert.equal(h.host.handleViewportInput("outer"), outerResult);
  assert.equal(h.tracker.hovered, true, "child revalidation acknowledges its enclosing dispatch");
  assert.equal(h.renders, 1);
});
