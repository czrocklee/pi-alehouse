import assert from "node:assert/strict";
import test from "node:test";
import { createPopoverCloseControl } from "../../src/shared/popover-close-control.mjs";
import { popoverCloseHit } from "../../src/shared/popover-frame.mjs";

/** A painted control at a fixed width, on either a viewport-capable host or a
 * plain structural one that never reports hover. */
function fixture({
  width = 40,
  height = 3,
  columns = 100,
  rows = 24,
  viewport = true,
  replaceable = true,
  painted = true,
  closeHit = popoverCloseHit,
} = {}) {
  const host = {
    terminal: { columns, rows },
    ...(viewport
      ? {
          handleViewportInput(event) {
            // Structural native dispatch: pass normalized events to the panel,
            // but leave other native input undelivered to the close control.
            if (event && typeof event === "object") return control.mouse(event);
          },
        }
      : {}),
  };
  if (viewport && !replaceable)
    Object.defineProperty(host, "handleViewportInput", {
      value: host.handleViewportInput,
      configurable: false,
      writable: false,
    });
  let renders = 0;
  const control = createPopoverCloseControl({
    host,
    requestRender: () => renders++,
    closeHit,
  });
  if (painted) control.paint(width, true, height);
  return {
    control,
    host,
    renders: () => renders,
    resize(nextColumns = columns, nextRows = rows) {
      host.terminal.columns = nextColumns;
      host.terminal.rows = nextRows;
    },
  };
}

/** At width 40 the frame still paints its five-column tail ` ✕ ─╮` at x 35..39,
 * but the close hit is exactly the ✕ cell: x 36, one column wide. */
const press = (x, { y = 0, button = "left", width } = {}) => ({
  type: "press",
  button,
  x,
  y,
  ...(width === undefined ? {} : { width }),
});
const release = (x, { y = 0, button = "left", width } = {}) => ({
  type: "release",
  button,
  x,
  y,
  ...(width === undefined ? {} : { width }),
});
const click = (x, { y = 0, button = "left", width } = {}) => ({
  type: "click",
  button,
  x,
  y,
  ...(width === undefined ? {} : { width }),
});
const move = (x, { y = 0, button = "none", width } = {}) => ({
  type: "move",
  button,
  x,
  y,
  ...(width === undefined ? {} : { width }),
});
const drag = (x, { y = 0, width } = {}) => ({
  type: "drag",
  button: "left",
  x,
  y,
  ...(width === undefined ? {} : { width }),
});
const claimed = { handled: true, close: false };
const closing = { handled: true, close: true };

test("a left press on the ✕ cell claims without closing; a same-cell release closes", () => {
  const { control } = fixture();
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("a buttonless release also closes an armed gesture", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.deepEqual(control.mouse(release(36, { button: "none" })), closing);
});

test("leaving the hit during a claimed press cancels it permanently, consuming its release and click", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.equal(control.mouse(drag(36)), undefined); // same cell: the gesture survives
  assert.equal(control.mouse(drag(12)), undefined); // outside: cancelled, never revived
  assert.equal(control.mouse(drag(36)), undefined);
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
  // A fresh press starts a new gesture.
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("repeated same-coordinate motion within the single cell keeps the gesture armed", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.equal(control.mouse(drag(36)), undefined);
  assert.equal(control.mouse(drag(36)), undefined);
  assert.equal(control.mouse(move(36)), undefined);
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("a drag into either neighbor cell cancels the armed gesture", () => {
  const left = fixture();
  left.control.mouse(press(36));
  assert.equal(left.control.mouse(drag(35)), undefined);
  assert.deepEqual(left.control.mouse(release(36)), claimed);
  const right = fixture();
  right.control.mouse(press(36));
  assert.equal(right.control.mouse(drag(37)), undefined);
  assert.deepEqual(right.control.mouse(release(36)), claimed);
});

test("an armed release on a neighbor is consumed without closing", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.deepEqual(control.mouse(release(37)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
});

test("the tail's neighboring cells and other rows never arm or close", () => {
  const { control } = fixture();
  assert.equal(control.mouse(press(35)), undefined); // left neighbor: not claimed
  assert.equal(control.mouse(press(37)), undefined); // right neighbor: not claimed
  assert.equal(control.mouse(press(36, { y: 1 })), undefined); // same column, next row
  assert.equal(control.mouse(click(35)), undefined);
  assert.equal(control.mouse(click(37)), undefined);
  assert.equal(control.mouse(click(36, { y: 1 })), undefined);
});

test("a move onto the same column in another row cancels the armed gesture", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.equal(control.mouse(move(36, { y: 1 })), undefined);
  assert.deepEqual(control.mouse(release(36)), claimed);
});

test("the native synthetic click after a closing release is consumed, never closed twice", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.deepEqual(control.mouse(release(36)), closing);
  // The consumer closes the popover but keeps this control alive.
  assert.deepEqual(control.mouse(click(36)), claimed);
  // A later fresh click is a new gesture, not this one's synthetic echo.
  assert.deepEqual(control.mouse(click(36)), closing);
});

test("a structural press and click, without any release, still close", () => {
  const { control } = fixture();
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), closing);
});

test("a bare left click on the ✕ cell closes; right and none clicks never do", () => {
  const { control } = fixture();
  assert.deepEqual(control.mouse(click(36)), closing);
  assert.equal(control.mouse(click(36, { button: "right" })), undefined);
  assert.equal(control.mouse(click(36, { button: "none" })), undefined);
  assert.equal(control.mouse(click(12)), undefined); // outside the hit
});

test("a press outside the hit is not claimed and cannot close through a later inside release or click", () => {
  const { control } = fixture();
  assert.equal(control.mouse(press(12)), undefined);
  assert.equal(control.mouse(release(36)), undefined);
  assert.deepEqual(control.mouse(click(36)), claimed); // consumed, never closed
  // A fresh inside press resets the suppression.
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("reset cancels the gesture and suppresses its stale release and click after the repaint", () => {
  const { control } = fixture();
  control.mouse(press(36));
  control.reset();
  control.paint(40, true, 3);
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
});

test("an unchanged repaint preserves the gesture, including a preliminary paint without a height", () => {
  const { control } = fixture();
  control.mouse(press(36));
  control.paint(40, true); // preliminary pass: height omitted, the prior value kept
  control.paint(40, true, 3); // unchanged geometry
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("a height-only geometry change cancels the gesture and suppresses its old release and click", () => {
  const { control } = fixture();
  control.mouse(press(36));
  control.paint(40, true, 5);
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
});

test("a hidden repaint cancels the gesture; repainting the control restores closing", () => {
  const { control } = fixture();
  control.mouse(press(36));
  control.paint(40, false, 3); // hidden: no close hit painted
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
  control.paint(40, true, 3);
  assert.deepEqual(control.mouse(click(36)), closing);
});

test("a terminal resize invalidates the painted geometry", () => {
  const { control, resize } = fixture();
  control.mouse(press(36));
  resize(80);
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
  assert.equal(control.mouse(click(36)), undefined); // stale geometry never closes
});

test("event.width must agree with the painted width and never widens the hit", () => {
  const wide = fixture({ width: 40 });
  assert.equal(wide.control.mouse(press(36, { width: 41 })), undefined); // disagrees
  assert.equal(wide.control.mouse(click(36, { width: 41 })), undefined);
  const narrow = fixture({ width: 12 }); // ✕ cell at x 8
  assert.equal(narrow.control.mouse(click(38, { width: 40 })), undefined); // no widening
  assert.equal(narrow.control.mouse(click(7, { width: 12 })), undefined); // left neighbor
  assert.deepEqual(narrow.control.mouse(click(8, { width: 12 })), closing); // agreeing width
});

test("a width mismatch clears hover without fabricating a new painted hit", () => {
  const { control, host, renders } = fixture();
  const original = host.handleViewportInput;
  assert.equal(control.mouse(move(36, { width: 41 })), undefined);
  assert.equal(control.hovered, false, "a stale move cannot start hover at the painted cell");
  assert.equal(control.mouse(move(37, { width: 41 })), undefined);
  assert.equal(control.hovered, false, "an event cannot create its own close cell");
  assert.equal(renders(), 0);
  control.mouse(move(36, { width: 40 }));
  assert.equal(control.hovered, true);
  control.mouse(move(36, { width: 41 }));
  assert.equal(control.hovered, false, "a stale move clears existing hover at the same cell");
  assert.equal(renders(), 2);
  assert.equal(host.handleViewportInput, original, "cleared hover leaves no idle observer");
  control.mouse(move(36));
  assert.equal(control.hovered, true, "an omitted width still uses the unmodified paint");
  control.dispose();
});

for (const stale of [move, drag])
  test(`a width mismatch during ${stale.name} cancels an armed gesture without falling through`, () => {
    const { control, host } = fixture();
    assert.deepEqual(control.mouse(press(36, { width: 40 })), claimed);
    assert.equal(host.handleViewportInput(stale(36, { width: 41 })), undefined);
    assert.equal(control.hovered, false);
    assert.deepEqual(control.mouse(release(36, { width: 40 })), claimed);
    assert.deepEqual(control.mouse(click(12, { width: 41 })), claimed);
    assert.equal(control.mouse(click(12, { width: 40 })), undefined);
    assert.deepEqual(control.mouse(press(36, { width: 40 })), claimed);
    assert.deepEqual(control.mouse(release(36, { width: 40 })), closing);
    control.dispose();
  });

test("unpainted, tiny and disposed controls never arm or close", () => {
  const unpainted = fixture({ painted: false });
  assert.equal(unpainted.control.mouse(click(36)), undefined);
  assert.equal(unpainted.control.mouse(press(36)), undefined);
  const tiny = fixture({ width: 8 }); // no room for a close hit
  assert.equal(tiny.control.mouse(click(4)), undefined);
  const gone = fixture();
  gone.control.dispose();
  assert.equal(gone.control.mouse(press(36)), undefined);
  assert.equal(gone.control.mouse(click(36)), undefined);
});

test("dispose cancels an armed gesture and still consumes its stale release and click", () => {
  const { control } = fixture();
  control.mouse(press(36));
  control.dispose();
  assert.deepEqual(control.mouse(release(36)), claimed);
  assert.deepEqual(control.mouse(click(36)), claimed);
});

test("a close that disposes the control still consumes the trailing synthetic click", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.deepEqual(control.mouse(release(36)), closing);
  control.dispose(); // the consumer's synchronous close callback
  assert.deepEqual(control.mouse(click(36)), claimed);
});

test("non-finite coordinates never close, arm or keep a gesture armed", () => {
  const { control } = fixture();
  assert.equal(control.mouse(click(Number.POSITIVE_INFINITY)), undefined);
  assert.equal(control.mouse(click(Number.NaN)), undefined);
  control.mouse(press(36));
  assert.equal(control.mouse(move(Number.NaN)), undefined);
  assert.deepEqual(control.mouse(release(36)), claimed);
});

test("active=false clears hover and cancels the old gesture without activating a new one", () => {
  const { control } = fixture();
  control.mouse(move(36));
  assert.equal(control.hovered, true);
  assert.equal(control.mouse(move(36), false), undefined);
  assert.equal(control.hovered, false);
  assert.deepEqual(control.mouse(press(36), true), claimed);
  assert.deepEqual(control.mouse(release(36), false), claimed); // cancelled and consumed
  assert.deepEqual(control.mouse(click(36), false), claimed);
  assert.equal(control.mouse(press(36), false), undefined); // never arms
  assert.equal(control.mouse(click(36), false), undefined);
  assert.equal(control.mouse(release(36), true), undefined); // still not armed
  // Once active again, a fresh press arms and closes normally.
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(release(36)), closing);
});

test("direct wheel and unknown events pass through without disturbing the gesture", () => {
  const { control } = fixture();
  control.mouse(press(36));
  assert.equal(
    control.mouse({ type: "wheel", button: "none", x: 36, y: 0, wheelDelta: -1 }),
    undefined,
  );
  assert.equal(control.mouse({ type: "unknown", x: 36, y: 0 }), undefined);
  assert.deepEqual(control.mouse(release(36)), closing);
});

for (const button of ["right", "middle"])
  test(`a fresh ${button} press ends the old close gesture without claiming the new release`, () => {
    const { control } = fixture();
    control.mouse(press(36));
    // The pinned native compositor abandons its prior target on any release.
    // Preserving armed here would reuse it for an unrelated later left release.
    assert.equal(control.mouse(press(36, { button })), undefined);
    assert.equal(control.mouse(release(36, { button })), undefined);
    assert.equal(control.mouse(release(36)), undefined);
    assert.deepEqual(
      control.mouse(click(12)),
      claimed,
      "one old captured click cannot activate a different body cell",
    );
    control.mouse(press(36));
    control.mouse(press(36, { button }));
    assert.equal(control.mouse(press(12)), undefined);
    assert.equal(control.mouse(release(12)), undefined);
    assert.equal(control.mouse(click(12)), undefined, "a fresh body press replaces suppression");
    assert.deepEqual(control.mouse(press(36)), claimed);
    assert.deepEqual(control.mouse(release(36)), closing, "a fresh close still works");
  });

for (const interruptedAfter of ["press", "cancelled press", "closing release"])
  test(`native keyboard interruption after ${interruptedAfter} releases ownership but consumes one old body click`, () => {
    const { control, host } = fixture();
    control.mouse(press(36));
    if (interruptedAfter === "cancelled press") control.mouse(drag(12));
    if (interruptedAfter === "closing release")
      assert.deepEqual(control.mouse(release(36)), closing);
    // This native dispatch does not deliver any component mouse event. Unlike
    // focusout, keyboard input can leave the SDK's old capture target intact.
    host.handleViewportInput("z");
    assert.equal(control.mouse(release(12)), undefined, "an unrelated release is not ours");
    assert.deepEqual(
      control.mouse(click(12)),
      claimed,
      "the potentially captured old click is consumed even on a different body cell",
    );
    assert.equal(control.mouse(click(12)), undefined, "only that first old click is consumed");
    assert.deepEqual(control.mouse(press(36)), claimed);
    assert.deepEqual(control.mouse(release(36)), closing);
    control.dispose();
  });

test("a fresh body press after native keyboard interruption keeps its own body click usable", () => {
  const { control, host } = fixture();
  control.mouse(press(36));
  host.handleViewportInput("z");
  assert.equal(control.mouse(press(12)), undefined);
  assert.equal(control.mouse(release(12)), undefined);
  assert.equal(control.mouse(click(12)), undefined, "fresh body input must not be suppressed");
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(control.mouse(release(36)), closing);
  control.dispose();
});

test("hover stays delegated: moves highlight the painted glyph and geometry changes clear it", () => {
  const { control, renders } = fixture();
  assert.equal(control.hovered, false);
  assert.equal(control.mouse(move(36)), undefined);
  assert.equal(control.hovered, true);
  assert.ok(renders() > 0);
  assert.equal(control.mouse(move(12)), undefined);
  assert.equal(control.hovered, false);
  control.mouse(move(36));
  assert.equal(control.hovered, true);
  const before = renders();
  control.paint(40, true, 4); // geometry change clears hover silently
  assert.equal(control.hovered, false);
  assert.equal(renders(), before);
  control.dispose();
});

for (const render of [false, true])
  test(`reset(${render}) clears an actual highlight ${render ? "with" : "without"} a repaint`, () => {
    const { control, renders } = fixture();
    control.mouse(move(36));
    assert.equal(control.hovered, true, "the reset must have real feedback to clear");
    const before = renders();
    control.reset(render);
    assert.equal(control.hovered, false);
    assert.equal(renders(), before + (render ? 1 : 0));
    control.dispose();
  });

test("hover and an armed gesture share one hit sample per paint or motion", () => {
  const widths = [];
  const { control } = fixture({
    closeHit: (width) => {
      widths.push(width);
      return popoverCloseHit(width);
    },
  });
  assert.deepEqual(widths, [40], "one painted hit is shared");
  assert.deepEqual(control.mouse(press(36)), claimed);
  assert.deepEqual(widths, [40, 40]);
  assert.equal(control.mouse(move(36)), undefined);
  assert.equal(control.hovered, true);
  assert.deepEqual(widths, [40, 40, 40], "one live hit drives both hover and gesture");
  assert.deepEqual(control.mouse(release(36)), closing);
  control.dispose();
});

test("an inset close control uses its painted row, including hover", () => {
  const { control } = fixture({
    closeHit: (width) => ({ ...popoverCloseHit(width), y: 1 }),
  });
  assert.equal(control.mouse(click(36)), undefined);
  assert.deepEqual(control.mouse(click(36, { y: 1 })), closing);
  control.mouse(move(36, { y: 1 }));
  assert.equal(control.hovered, true);
  control.mouse(move(36));
  assert.equal(control.hovered, false);
  control.dispose();
});

test("a moved close row retires both a pending gesture and unpainted targets", () => {
  let y = 0;
  const { control } = fixture({
    closeHit: (width) => ({ ...popoverCloseHit(width), y }),
  });
  assert.deepEqual(control.mouse(press(36)), claimed);
  y = 1;
  assert.deepEqual(control.mouse(release(36, { y })), claimed);
  assert.deepEqual(control.mouse(click(36, { y })), claimed);
  assert.equal(control.mouse(click(36, { y })), undefined, "not yet painted");
  control.paint(40, true, 3);
  assert.deepEqual(control.mouse(click(36, { y })), closing);
  control.dispose();
});

test("an inset close row outside the painted height has no target", () => {
  const { control } = fixture({
    height: 1,
    closeHit: (width) => ({ ...popoverCloseHit(width), y: 1 }),
  });
  assert.equal(control.mouse(click(36, { y: 1 })), undefined);
  control.mouse(move(36, { y: 1 }));
  assert.equal(control.hovered, false);
  control.dispose();
});

for (const adapter of ["missing", "nonreplaceable"])
  test(`${adapter} viewport adapter preserves bare-click and structural press/click compatibility`, () => {
    const { control } = fixture({
      viewport: adapter !== "missing",
      replaceable: adapter !== "nonreplaceable",
    });
    assert.equal(control.mouse(move(36)), undefined);
    assert.equal(control.hovered, false);
    assert.deepEqual(control.mouse(click(36)), closing);
    assert.deepEqual(control.mouse(press(36)), claimed);
    assert.deepEqual(control.mouse(click(36)), closing);
    assert.deepEqual(control.mouse(press(36)), claimed);
    control.mouse(drag(12));
    assert.deepEqual(control.mouse(release(36)), claimed);
    assert.deepEqual(control.mouse(click(36)), claimed);
    assert.deepEqual(control.mouse(press(36)), claimed);
    assert.deepEqual(control.mouse(release(36)), closing);
    control.dispose();
  });
