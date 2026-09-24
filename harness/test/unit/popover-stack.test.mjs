import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { POPOVER_DOCK_ROWS, POPOVER_MIN_ROWS, focusOrigin, focusRevealed, joinPopoverStack, stackedOverlayOptions }
  from "../../../lib/popover-stack.mjs";

/** The SDK's own compositor, so anchoring, margins and clamping are real. */
function screen(rows = 24, columns = 100) {
  const terminal = { rows, columns, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  let renders = 0;
  tui.requestRender = () => { renders++; };
  const paint = () => {
    // Two passes, as the renderer would after a height change asked for one.
    for (let pass = 0; pass < 2; pass++) tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows);
  };
  return { tui, terminal, paint, renders: () => renders };
}

/** A popover of fixed size that reports its paint to its stack member. */
function popover(harness, { height, width, minWidth = 1, nonCapturing = true }) {
  const member = joinPopoverStack(harness.tui);
  const box = { height, render: (w) => { const lines = Array(box.height).fill("x".repeat(w)); member.measure(lines.length); return lines; },
    invalidate() {} };
  const handle = harness.tui.showOverlay(box, stackedOverlayOptions(member, { width, minWidth, nonCapturing }));
  return { member, box, handle, bounds: () => handle.getBounds(), close() { handle.hide(); member.leave(); } };
}

test("bottom-right popovers stack upward at one shared width above the footer, oldest lowest", () => {
  const h = screen();
  const usage = popover(h, { height: 6, width: 40 });
  const routing = popover(h, { height: 9, width: 70 });
  h.paint();
  const [low, high] = [usage.bounds(), routing.bounds()];
  assert.equal(low.row + low.height, h.terminal.rows - POPOVER_DOCK_ROWS, "the first rests on the footer row");
  assert.equal(high.row + high.height, low.row, "the next sits directly on top, with no overlap or gap");
  for (const bounds of [low, high]) assert.equal(bounds.col + bounds.width, h.terminal.columns, "right-aligned");
  assert.deepEqual([low.width, high.width], [70, 70], "the widest preference sizes every member");
  assert.equal(low.col, high.col, "left edges line up as well as right edges");

  // Opening a third moves nobody; growth below pushes those above up.
  const third = popover(h, { height: 3, width: 20 });
  usage.box.height = 8;
  h.paint();
  assert.equal(usage.bounds().row + usage.bounds().height, h.terminal.rows - POPOVER_DOCK_ROWS);
  assert.equal(routing.bounds().row + routing.bounds().height, usage.bounds().row);
  assert.equal(third.bounds().row + third.bounds().height, routing.bounds().row);
  assert.equal(third.bounds().width, 70, "a narrower newcomer uses the same column");

  // Closing one drops everything above it into its place.
  usage.close();
  h.paint();
  assert.equal(routing.bounds().row + routing.bounds().height, h.terminal.rows - POPOVER_DOCK_ROWS);
  assert.equal(third.bounds().row + third.bounds().height, routing.bounds().row);
  routing.close(); h.paint();
  assert.equal(third.bounds().width, 20, "closing the widest member shrinks the remaining column");
  assert.equal(third.bounds().row + third.bounds().height, h.terminal.rows - POPOVER_DOCK_ROWS);
  third.close();
});

test("shared width follows content, minimum widths, focus order and terminal resizes without remounting", () => {
  const h = screen(32, 120);
  let contentWidth = 40;
  const low = popover(h, { height: 5, width: () => contentWidth });
  const high = popover(h, { height: 7, width: 60, minWidth: 76 });
  const check = (expected) => {
    h.paint();
    const [bottom, top] = [low.bounds(), high.bounds()];
    assert.deepEqual([bottom.width, top.width], [expected, expected]);
    assert.equal(bottom.col, top.col);
    assert.equal(bottom.col + bottom.width, h.terminal.columns);
    assert.equal(bottom.row + bottom.height, h.terminal.rows - POPOVER_DOCK_ROWS);
    assert.equal(top.row + top.height, bottom.row);
  };
  check(76);
  contentWidth = 96; check(96);
  low.handle.focus(); check(96); // SDK paint order now differs from column order.
  h.terminal.columns = 42; check(42);
  h.terminal.columns = 140; check(96);
  contentWidth = 30; check(76);
  high.close(); h.paint();
  assert.equal(low.bounds().width, 30);
  low.close();
});

test("a temporarily hidden widest popover keeps its column width until it leaves", () => {
  const h = screen();
  const low = popover(h, { height: 4, width: 40 });
  const high = popover(h, { height: 4, width: 90 });
  h.paint();
  high.handle.hide(); h.paint();
  assert.equal(low.bounds().width, 90, "stepping aside does not make the column jump");
  const before = h.renders();
  high.member.leave();
  assert.equal(h.renders(), before + 1, "removing the widest top member repaints lower members too");
  h.paint();
  assert.equal(low.bounds().width, 40);
  high.member.preferWidth(() => 200);
  high.member.measure(10);
  assert.equal(low.member.width, 40, "a late callback from a closed member cannot change the column");
  low.close();
});

test("a crowded column caps each popover to the rows left and hides one with no room", () => {
  const h = screen(16);
  const low = popover(h, { height: 10, width: 30 });
  const high = popover(h, { height: 10, width: 30 });
  h.paint();
  assert.equal(low.member.available(), 15);
  assert.equal(high.member.bottom, POPOVER_DOCK_ROWS + 10);
  assert.equal(high.bounds().height, 5, "clipped to what is left above the lower popover");
  assert.equal(high.bounds().row, 0);

  low.box.height = 13;
  h.paint();
  assert.equal(high.member.available(), 2);
  assert(high.member.available() < POPOVER_MIN_ROWS);
  assert.equal(high.bounds(), undefined, "no room for a frame: off screen rather than a sliver");
  // It covers nothing while hidden, so it reserves nothing for popovers above.
  const top = popover(h, { height: 1, width: 10 });
  assert.equal(top.member.bottom, POPOVER_DOCK_ROWS + 13);
  low.close(); high.close(); top.close();
});

test("height changes relayout only when someone above depends on them", () => {
  const h = screen();
  const low = popover(h, { height: 4, width: 30 });
  h.paint();
  const before = h.renders();
  low.box.height = 6; h.paint();
  assert.equal(h.renders(), before, "the top popover's height moves nobody");
  const high = popover(h, { height: 4, width: 30 });
  h.paint();
  const settled = h.renders();
  low.box.height = 7; h.paint();
  assert.equal(h.renders(), settled + 1, "one more layout for the popover above");
  // The stack's own requests only; hiding an overlay asks the SDK for a paint anyway.
  low.member.leave();
  assert.equal(h.renders(), settled + 2, "leaving relayouts the popovers above");
  high.member.leave();
  assert.equal(h.renders(), settled + 2, "the top leaving moves nobody");
  low.member.leave();
  assert.equal(h.renders(), settled + 2, "leaving twice is harmless");
  low.handle.hide(); high.handle.hide();
});

test("separately loaded modules share one column per TUI, and TUIs never share", async () => {
  const other = await import(`../../../lib/popover-stack.mjs?copy=${Date.now()}`);
  const h = screen(), elsewhere = screen();
  const first = joinPopoverStack(h.tui);
  first.measure(5);
  const second = other.joinPopoverStack(h.tui);
  first.preferWidth(() => 40); second.preferWidth(() => 76);
  assert.equal(first.width, 76, "a separately loaded bundle contributes to the same width");
  assert.equal(second.width, 76);
  assert.equal(second.bottom, POPOVER_DOCK_ROWS + 5, "a second bundle stacks above the first bundle's popover");
  assert.equal(joinPopoverStack(elsewhere.tui).bottom, POPOVER_DOCK_ROWS);
  first.leave(); second.leave();
  assert.equal(joinPopoverStack(h.tui).bottom, POPOVER_DOCK_ROWS);
});

test("a popover waits off screen until its own minimum fits, and is handed the keyboard when it appears", async () => {
  const h = screen(12);
  const editor = { render: () => [], invalidate() {}, handleInput() {} };
  h.tui.setFocus(editor);
  const usage = popover(h, { height: 9, width: 40 });
  h.paint();
  const member = joinPopoverStack(h.tui);
  const box = { render: (w) => Array(7).fill("x".repeat(w)), invalidate() {}, handleInput() {} };
  let reveals = 0, handle;
  const openedFrom = focusOrigin(h.tui);
  handle = h.tui.showOverlay(box, stackedOverlayOptions(member, { width: 50, minRows: 7, nonCapturing: false,
    onReveal: () => { reveals++; focusRevealed(h.tui, handle, openedFrom); } }));
  h.paint();
  assert.equal(member.available(), 2);
  assert.equal(handle.getBounds(), undefined, "2 rows cannot hold a 7-row layout, so it is not painted clipped");
  assert.equal(h.tui.getFocusedComponent(), editor, "Pi does not focus an overlay mounted off screen");

  usage.box.height = 5; h.paint();
  assert.equal(member.available(), 6);
  assert.equal(handle.getBounds(), undefined, "still one row short of its minimum");
  usage.close(); h.paint();
  assert.equal(handle.getBounds()?.height, 7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reveals, 1);
  assert.equal(h.tui.getFocusedComponent(), box, "revealed, it takes the keyboard it would have had");
  h.paint(); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reveals, 1, "only the hidden-to-visible edge reveals");
  handle.hide(); member.leave();
});

test("a revealed popover leaves the keyboard with a dialog that took it meanwhile", () => {
  const h = screen(12);
  const editor = { render: () => [], invalidate() {} }, dialog = { render: () => [], invalidate() {} };
  h.tui.setFocus(editor);
  const box = { render: (w) => ["x".repeat(w)], invalidate() {} };
  const handle = h.tui.showOverlay(box, { anchor: "bottom-right", width: 10, visible: () => false });
  h.tui.setFocus(dialog);
  focusRevealed(h.tui, handle, [editor]);
  assert.equal(h.tui.getFocusedComponent(), dialog);
  h.tui.setFocus(editor);
  focusRevealed(h.tui, handle, [editor]);
  assert.equal(h.tui.getFocusedComponent(), editor, "nor does a popover that is still off screen take it");
  handle.hide();
});

test("a popover revealed by closing the capturing popover below it takes the keyboard back from the editor", async () => {
  // The third review's repro: 14 rows, the approval popover open and focused,
  // then a picker that does not fit and waits off screen.
  const h = screen(14);
  const editor = { render: () => [], invalidate() {}, handleInput() {} };
  h.tui.setFocus(editor);
  const lowMember = joinPopoverStack(h.tui);
  const low = { render: (w) => { lowMember.measure(8); return Array(8).fill("a".repeat(w)); }, invalidate() {}, handleInput() {} };
  const lowHandle = h.tui.showOverlay(low, stackedOverlayOptions(lowMember, { width: 40, nonCapturing: false }));
  h.paint();
  assert.equal(h.tui.getFocusedComponent(), low);
  const member = joinPopoverStack(h.tui);
  const box = { render: (w) => Array(7).fill("x".repeat(w)), invalidate() {}, handleInput() {} };
  const origin = focusOrigin(h.tui);
  assert.deepEqual(origin, [low, editor], "the origin runs back through the popover holding the keyboard");
  let handle;
  handle = h.tui.showOverlay(box, stackedOverlayOptions(member, { width: 50, minRows: 7, nonCapturing: false,
    onReveal: () => focusRevealed(h.tui, handle, origin) }));
  h.paint();
  assert.equal(handle.getBounds(), undefined);
  lowHandle.hide(); lowMember.leave();
  assert.equal(h.tui.getFocusedComponent(), editor, "Pi hands the closed popover's focus back to the editor");
  h.paint();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.tui.getFocusedComponent(), box, "so the revealed picker takes it, not the editor");
  handle.hide(); member.leave();

  // While the popover the origin runs through is still open, focus moving to
  // the editor was someone's choice; a reveal does not undo it.
  h.tui.setFocus(editor);
  const again = joinPopoverStack(h.tui);
  const againHandle = h.tui.showOverlay(low, stackedOverlayOptions(again, { width: 40, nonCapturing: false }));
  h.paint();
  const upper = joinPopoverStack(h.tui);
  const upperOrigin = focusOrigin(h.tui);
  const upperHandle = h.tui.showOverlay(box, { anchor: "bottom-right", width: 10, visible: () => true, nonCapturing: true });
  h.tui.setFocus(editor);
  focusRevealed(h.tui, upperHandle, upperOrigin);
  assert.equal(h.tui.getFocusedComponent(), editor, "the editor keeps it while that popover is still open");
  upperHandle.hide(); upper.leave(); againHandle.hide(); again.leave();
});
