import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { HarnessWidget } from "../../dist/ui/agent-widget.js";

// Pinned SDK allocation AND its real widget wrapper/spacer/mouse forwarding.
// No terminal process, model, network, or second implementation of dock shrink.
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", sdk).href);
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", sdk).href);
const { renderLayoutFrame } = await import(new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui")).href);
initTheme(undefined, false);
const componentOf = (lines) => ({ render: () => lines, invalidate() {} });
const click = { type: "click", button: "left", x: 0, y: 0 };
const idle = (index) => ({
  run_id: `run-${index}`, agent_id: `agent-${index}`, name: `复核${index}`, description: "Idle resident",
  status: "completed", finalization_pending: false, resident: true,
  turns: 1, max_turns: 8, elapsed_ms: 1000, pending_messages: 0, cleanup_errors: [],
  effective_settings: { profile: "editor", difficulty: 3, model: "fixture", thinking: "off", cwd: "/w" },
});
function layoutFixture(t, rows, blocked) {
  const views = Array.from({ length: 12 }, (_, index) => idle(index)), opened = [];
  const widget = new HarnessWidget({ list: () => structuredClone(views),
    stats: () => ({ resident: 12, cleanup_uncertain: false, ...(blocked ? { parent_error: "BROKEN" } : {}) }) }, 12);
  t.after(() => widget.dispose());
  const terminal = { columns: 80, rows }, tui = { terminal, mode: "fullscreen", requestRender() {} };
  const host = { ui: tui, extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    renderWidgets: InteractiveMode.prototype.renderWidgets,
    renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer };
  widget.setUi({ setWidget: (...args) => InteractiveMode.prototype.setExtensionWidget.call(host, ...args) });
  widget.onOpen((id) => { opened.push(id); });
  widget.wake(); widget.onTurnStart();
  const viewport = createChatViewport({
    document: componentOf(Array.from({ length: 40 }, (_, index) => `transcript ${index}`)),
    // One real queued prompt has a spacer, its text, and a dequeue hint.
    pendingMessages: componentOf(["", "queued prompt", "dequeue hint"]), status: componentOf(["status"]),
    editor: componentOf(["editor top", "editor input", "editor bottom"]),
    footer: componentOf(["footer workspace", "footer model"]), widgetsAbove: host.widgetContainerAbove,
    scrollbar: "hidden",
  });
  const paint = () => renderLayoutFrame(viewport.root, terminal.columns, terminal.rows, () => {});
  const boxOf = (frame) => frame.root.children[1].children.find((box) => box.component === host.widgetContainerAbove);
  const linesOf = (frame) => boxOf(frame).lines.map(stripTerminalSequences);
  const pointer = (frame, y, x = 0) => {
    const box = boxOf(frame);
    const result = host.widgetContainerAbove.handleMouse({ ...click, x, y, screenX: x, screenY: box.rect.y + y,
      width: terminal.columns, height: box.clip.height });
    if (!result) return result;
    assert.equal(result.target.component, host.extensionWidgetsAbove.get("harness-agents"), "the SDK dispatched to the Agent widget");
    assert.equal(result.target.originX, 0);
    assert.equal(result.target.originY, box.rect.y + 1, "the SDK transformed coordinates past its leading spacer");
    return { handled: result.handled, ...(result.render === undefined ? {} : { render: result.render }) };
  };
  return { widget, views, opened, terminal, paint, boxOf, linesOf, pointer };
}

for (const [rows, blocked] of [[15, false], [16, true], [18, false], [18, true], [36, false], [36, true]]) {
  test(`real SDK dock preserves readable pages and input chrome (rows=${rows}, blocked=${blocked})`, (t) => {
    const h = layoutFixture(t, rows, blocked);
    let frame = h.paint(), lines = h.linesOf(frame);
    assert.equal(lines[0], "", "the real SDK adds a leading widget spacer");
    const heading = lines.findIndex((line) => line.includes("Agents"));
    assert(heading >= 0 && lines[heading].includes("▸"));
    assert.deepEqual(h.pointer(frame, heading), { handled: true, render: true });
    let pageCount = 0;
    for (;;) {
      frame = h.paint(); lines = h.linesOf(frame);
      const box = h.boxOf(frame), screen = frame.lines.map(stripTerminalSequences);
      assert(frame.root.children[0].rect.height >= 2, "normal input chrome leaves multiple transcript rows");
      assert(screen.filter((line) => line.startsWith("transcript ")).length >= 2);
      for (const text of ["queued prompt", "dequeue hint", "status", "editor top", "editor input", "editor bottom",
        "footer workspace", "footer model"]) assert(screen.includes(text), `missing ${text}`);
      assert.equal(box.clip.height, box.lines.length, "actual SDK wrapper, Agents and controls are not clipped");
      assert(box.lines.length - 1 <= Math.min(12, Math.floor(rows / 3), rows - 12));
      assert(box.lines.every((line) => visibleWidth(line) <= h.terminal.columns));
      if (blocked) {
        const warning = lines.findIndex((line) => line.includes("owner blocked: BROKEN"));
        assert.equal(warning, heading + 1);
        assert.match(screen[box.rect.y + warning], /owner blocked: BROKEN/);
      }
      for (let y = 0; y < lines.length; y++) {
        if (lines[y].includes("✓")) assert.deepEqual(h.pointer(frame, y), { handled: true });
      }
      const y = lines.findIndex((line) => line.includes("[Next]"));
      assert(y >= 0 && y < box.clip.height, "page controls must be inside the allocated wrapper viewport");
      const [, current, total] = lines[y].match(/(\d+)\/(\d+)/);
      pageCount++;
      if (current === total) {
        assert.equal(h.pointer(frame, y, lines[y].indexOf("[Next]")), undefined);
        break;
      }
      assert.deepEqual(h.pointer(frame, y, lines[y].indexOf("[Next]")), { handled: true, render: true });
      assert(pageCount < 12, "page navigation makes progress through every resident");
    }
    assert(pageCount > 1);
    assert.deepEqual(h.opened, h.views.map((view) => view.agent_id));
    const held = h.paint().lines;
    assert.deepEqual(h.paint().lines, held);
  });
}

for (const [rows, blocked] of [[9, false], [9, true], [12, false], [12, true], [13, false], [14, true], [15, true]]) {
  test(`tiny SDK dock never advertises clipped pagination (rows=${rows}, blocked=${blocked})`, (t) => {
    const h = layoutFixture(t, rows, blocked), frame = h.paint(), lines = h.linesOf(frame);
    assert(!lines.some((line) => /[▸▾]|\[Prev\]|\[Next\]/.test(line)));
    for (let y = 0; y < lines.length; y++) assert.equal(h.pointer(frame, y), undefined);
    assert.deepEqual(h.opened, []);
    assert.equal(h.widget.agents().length, 12, "Alt+A still has a fresh inspection projection");
  });
}

test("shrinking the real dock retires old page coordinates before they can act", (t) => {
  const h = layoutFixture(t, 18, false);
  let frame = h.paint(), lines = h.linesOf(frame);
  h.pointer(frame, lines.findIndex((line) => line.includes("Agents")));
  frame = h.paint(); lines = h.linesOf(frame);
  const y = lines.findIndex((line) => line.includes("[Next]")), x = lines[y].indexOf("[Next]");
  h.terminal.rows = 9;
  assert.equal(h.pointer(frame, y, x), undefined, "terminal resize invalidates the old component paint");
  const tiny = h.paint();
  assert.equal(h.pointer(tiny, y, x), undefined, "clipped/absent page controls are not forwarded by the wrapper");
  assert(!h.linesOf(tiny).some((line) => line.includes("[Next]")));
  h.terminal.rows = 18;
  const restored = h.paint(), restoredLines = h.linesOf(restored);
  assert.match(restoredLines.find((line) => line.includes("[Next]")), /1\//);
  assert.deepEqual(h.opened, []);
});
