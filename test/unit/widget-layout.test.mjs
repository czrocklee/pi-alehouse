import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget } from "../../dist/orchestration/ui/agent-widget.js";

// Pinned SDK allocation AND its real widget wrapper/spacer/mouse forwarding.
// No terminal process, model, network, or second implementation of dock shrink.
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createChatViewport } = await import(
  new URL("./modes/interactive/chat-viewport.js", sdk).href
);
const { InteractiveMode } = await import(
  new URL("./modes/interactive/interactive-mode.js", sdk).href
);
const { renderLayoutFrame } = await import(
  new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui")).href
);
initTheme(undefined, false);
const componentOf = (lines) => ({ render: () => lines, invalidate() {} });
const click = { type: "click", button: "left", x: 0, y: 0 };
const idle = (index) => ({
  run_id: `run-${index}`,
  agent_id: `agent-${index}`,
  name: `review-${index}`,
  description: "Idle resident",
  status: "completed",
  finalization_pending: false,
  resident: true,
  turns: 1,
  max_turns: 8,
  elapsed_ms: 1000,
  pending_messages: 0,
  cleanup_errors: [],
  effective_settings: {
    profile: "editor",
    difficulty: 3,
    model: "fixture",
    thinking: "off",
    cwd: "/w",
  },
});
function layoutFixture(t, rows, blocked, beerMugs = false) {
  const views = Array.from({ length: 12 }, (_, index) => idle(index)),
    opened = [];
  const widget = new AgentWidget(
    {
      list: () => structuredClone(views),
      stats: () => ({
        resident: 12,
        cleanup_uncertain: false,
        ...(blocked ? { parent_error: "BROKEN" } : {}),
      }),
    },
    12,
  );
  t.after(() => widget.dispose());
  if (beerMugs) widget.setBeerMugs(true);
  const terminal = { columns: 80, rows },
    tui = { terminal, mode: "fullscreen", requestRender() {} };
  const host = {
    ui: tui,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(),
    widgetContainerBelow: new Container(),
    renderWidgets: InteractiveMode.prototype.renderWidgets,
    renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer,
  };
  widget.setUi({
    setWidget: (...args) => InteractiveMode.prototype.setExtensionWidget.call(host, ...args),
  });
  widget.onOpen((id) => {
    opened.push(id);
  });
  widget.wake();
  widget.onTurnStart();
  const viewport = createChatViewport({
    document: componentOf(Array.from({ length: 40 }, (_, index) => `transcript ${index}`)),
    // One real queued prompt has a spacer, its text, and a dequeue hint.
    pendingMessages: componentOf(["", "queued prompt", "dequeue hint"]),
    status: componentOf(["status"]),
    editor: componentOf(["editor top", "editor input", "editor bottom"]),
    footer: componentOf(["footer workspace", "footer model"]),
    widgetsAbove: host.widgetContainerAbove,
    scrollbar: "hidden",
  });
  const paint = () => renderLayoutFrame(viewport.root, terminal.columns, terminal.rows, () => {});
  const boxOf = (frame) =>
    frame.root.children[1].children.find((box) => box.component === host.widgetContainerAbove);
  const linesOf = (frame) => boxOf(frame).lines.map(stripTerminalSequences);
  const pointer = (frame, y, x = 0) => {
    const box = boxOf(frame);
    const result = host.widgetContainerAbove.handleMouse({
      ...click,
      x,
      y,
      screenX: x,
      screenY: box.rect.y + y,
      width: terminal.columns,
      height: box.clip.height,
    });
    if (!result) return result;
    assert.equal(
      result.target.component,
      host.extensionWidgetsAbove.get("alehouse-agents"),
      "the SDK dispatched to the Agent widget",
    );
    assert.equal(result.target.originX, 0);
    assert.equal(
      result.target.originY,
      box.rect.y + 1,
      "the SDK transformed coordinates past its leading spacer",
    );
    return {
      handled: result.handled,
      ...(result.render === undefined ? {} : { render: result.render }),
    };
  };
  return { widget, views, opened, terminal, paint, boxOf, linesOf, pointer };
}

for (const beerMugs of [false, true])
  for (const [rows, blocked] of [
    [15, false],
    [16, true],
    [18, false],
    [18, true],
    [36, false],
    [36, true],
    [39, true],
  ]) {
    test(`real SDK dock preserves readable pages and input chrome (rows=${rows}, blocked=${blocked}, beerMugs=${beerMugs})`, (t) => {
      const h = layoutFixture(t, rows, blocked, beerMugs);
      let frame = h.paint(),
        lines = h.linesOf(frame);
      assert.equal(lines[0], "", "the real SDK adds a leading widget spacer");
      const heading = lines.findIndex((line) => line.includes("Subagents"));
      assert(heading >= 0 && lines[heading].startsWith(`${beerMugs ? "🍺" : "▸"} Subagents`));
      assert.doesNotMatch(lines[heading], beerMugs ? /^[▸▾●○]|Subagents \d/ : /🍺|🍻|Subagents \d/);
      assert.deepEqual(h.pointer(frame, heading), { handled: true, render: true });
      let pageCount = 0;
      for (;;) {
        frame = h.paint();
        lines = h.linesOf(frame);
        const box = h.boxOf(frame),
          screen = frame.lines.map(stripTerminalSequences);
        assert(
          frame.root.children[0].rect.height >= 2,
          "normal input chrome leaves multiple transcript rows",
        );
        assert(screen.filter((line) => line.startsWith("transcript ")).length >= 2);
        for (const text of [
          "queued prompt",
          "dequeue hint",
          "status",
          "editor top",
          "editor input",
          "editor bottom",
          "footer workspace",
          "footer model",
        ])
          assert(screen.includes(text), `missing ${text}`);
        assert.equal(
          box.clip.height,
          box.lines.length,
          "actual SDK wrapper, Agents and controls are not clipped",
        );
        assert(box.lines.length - 1 <= Math.min(13, Math.floor(rows / 3), rows - 12));
        assert(box.lines.every((line) => visibleWidth(line) <= h.terminal.columns));
        if (blocked) {
          const warning = lines.findIndex((line) => line.includes("owner blocked: BROKEN"));
          assert.equal(warning, heading + 1);
          assert.match(screen[box.rect.y + warning], /owner blocked: BROKEN/);
        }
        for (let y = 0; y < lines.length; y++) {
          if (/^[├└]─ ✓/.test(lines[y])) assert.deepEqual(h.pointer(frame, y), { handled: true });
        }
        const y = lines.findIndex((line) => line.includes("[Next]"));
        assert(
          y >= 0 && y < box.clip.height,
          "page controls must be inside the allocated wrapper viewport",
        );
        const [, current, total] = lines[y].match(/(\d+)\/(\d+)/);
        pageCount++;
        if (current === total) {
          assert.equal(h.pointer(frame, y, lines[y].indexOf("[Next]")), undefined);
          break;
        }
        assert.deepEqual(h.pointer(frame, y, lines[y].indexOf("[Next]")), {
          handled: true,
          render: true,
        });
        assert(pageCount < 12, "page navigation makes progress through every resident");
      }
      assert(pageCount > 1);
      assert.deepEqual(
        h.opened,
        h.views.map((view) => view.agent_id),
      );
      const held = h.paint().lines;
      assert.deepEqual(h.paint().lines, held);
    });
  }

for (const beerMugs of [false, true])
  for (const rows of [39, 60]) {
    test(`real SDK dock fits heading and all twelve completed Agents without pagination (rows=${rows}, beerMugs=${beerMugs})`, (t) => {
      const h = layoutFixture(t, rows, false, beerMugs);
      let frame = h.paint(),
        lines = h.linesOf(frame);
      const heading = lines.findIndex((line) => line.includes("Subagents"));
      assert.equal(heading, 1, "the real SDK adds exactly one leading widget spacer");
      assert.equal(lines[heading], `${beerMugs ? "🍺" : "▸"} Subagents (full) · ✓12`);
      assert.deepEqual(h.pointer(frame, heading), { handled: true, render: true });
      frame = h.paint();
      lines = h.linesOf(frame);
      const box = h.boxOf(frame),
        screen = frame.lines.map(stripTerminalSequences);
      assert.equal(lines[0], "");
      assert.equal(lines[heading], `${beerMugs ? "🍻" : "▾"} Subagents (full) · ✓12`);
      assert.equal(
        lines.length - 1,
        13,
        "the widget is exactly heading plus twelve Agent rows, excluding SDK spacer",
      );
      assert.equal(lines.filter((line) => /^[├└]─ ✓/.test(line)).length, 12);
      assert(
        !lines.some((line) => /\[Prev\]|\[Next\]|\+\d+ more/.test(line)),
        "the entire roster fits without controls or overflow",
      );
      assert.equal(
        box.clip.height,
        box.lines.length,
        "the SDK wrapper and all Agent rows are unclipped",
      );
      assert(box.lines.length - 1 <= Math.min(13, Math.floor(rows / 3), rows - 12));
      assert(box.lines.every((line) => visibleWidth(line) <= h.terminal.columns));
      assert(
        frame.root.children[0].rect.height >= 2,
        "normal input chrome leaves multiple transcript rows",
      );
      assert(screen.filter((line) => line.startsWith("transcript ")).length >= 2);
      for (const text of [
        "queued prompt",
        "dequeue hint",
        "status",
        "editor top",
        "editor input",
        "editor bottom",
        "footer workspace",
        "footer model",
      ])
        assert(screen.includes(text), `missing ${text}`);
      for (let y = heading + 1; y < lines.length; y++) {
        assert.equal(
          screen[box.rect.y + y],
          lines[y],
          "each Agent row is actually visible on screen",
        );
        assert.deepEqual(h.pointer(frame, y), { handled: true });
      }
      assert.deepEqual(
        h.opened,
        h.views.map((view) => view.agent_id),
        "every resident opens through real SDK mouse forwarding",
      );
      assert.deepEqual(h.paint().lines, frame.lines, "idle repaint preserves the complete roster");
    });
  }

for (const beerMugs of [false, true])
  for (const columns of beerMugs ? [16, 17, 19, 25] : [15, 16, 18, 24]) {
    test(`real SDK dock measures selected heading glyph and click bounds in columns (columns=${columns}, beerMugs=${beerMugs})`, (t) => {
      const h = layoutFixture(t, 39, false, beerMugs);
      h.terminal.columns = columns;
      let frame = h.paint(),
        lines = h.linesOf(frame);
      const heading = 1,
        text = lines[heading],
        width = visibleWidth(text),
        minimum = beerMugs ? 17 : 16;
      const collapsed = beerMugs ? "🍺" : "▸",
        expanded = beerMugs ? "🍻" : "▾";
      assert(text.includes("Subagents"));
      for (const glyph of [collapsed, expanded])
        assert.equal(visibleWidth(glyph), beerMugs ? 2 : 1);
      assert.doesNotMatch(text, beerMugs ? /^[▸▾●○]|Subagents \d/ : /🍺|🍻|Subagents \d/);
      assert(h.boxOf(frame).lines.every((line) => visibleWidth(line) <= columns));
      assert.equal(
        h.pointer(frame, heading, width),
        undefined,
        "the first column outside the heading is inert",
      );
      if (columns < minimum) {
        assert(text.startsWith(`${beerMugs ? "🍺" : "○"} Subagents`));
        assert.doesNotMatch(text, /[▸▾]|🍻/, "unavailable disclosure retains only a static icon");
        for (const x of [0, 1, width - 1])
          assert.equal(
            h.pointer(frame, heading, x),
            undefined,
            "the heading is inert when the capacity heading cannot fit",
          );
      } else {
        const capacity = columns === minimum ? "full" : "(full)",
          summary = columns === (beerMugs ? 25 : 24) ? " · ✓12" : "";
        assert.equal(text, `${collapsed} Subagents ${capacity}${summary}`);
        assert.equal(width, columns);
        assert.deepEqual(h.pointer(frame, heading, width - 1), { handled: true, render: true });
        frame = h.paint();
        lines = h.linesOf(frame);
        assert.equal(lines[heading], `${expanded} Subagents ${capacity}${summary}`);
        assert.equal(
          visibleWidth(lines[heading]),
          width,
          "expanded and collapsed glyphs have equal hit geometry",
        );
        assert.equal(
          h.pointer(frame, heading, width),
          undefined,
          "the expanded right edge is also exclusive",
        );
        assert.equal(lines.filter((line) => /^[├└]─ ✓/.test(line)).length, 12);
        assert(h.boxOf(frame).lines.every((line) => visibleWidth(line) <= columns));
        for (const x of beerMugs ? [0, 1] : [0]) {
          assert.deepEqual(
            h.pointer(frame, heading, x),
            { handled: true, render: true },
            "every terminal column occupied by the expanded glyph collapses disclosure",
          );
          frame = h.paint();
          lines = h.linesOf(frame);
          assert.equal(lines[heading], text);
          assert.deepEqual(
            h.pointer(frame, heading, x),
            { handled: true, render: true },
            "every terminal column occupied by the collapsed glyph expands disclosure",
          );
          frame = h.paint();
          lines = h.linesOf(frame);
          assert.equal(lines[heading], `${expanded} Subagents ${capacity}${summary}`);
        }
      }
      assert.deepEqual(h.opened, [], "heading icons never become an Agent identity");
    });
  }

test("real SDK dock retires stale targets when appearance changes the available heading action", (t) => {
  const h = layoutFixture(t, 39, false);
  h.terminal.columns = 16;
  let frame = h.paint();
  assert.equal(h.linesOf(frame)[1], "▸ Subagents full");
  assert.deepEqual(h.pointer(frame, 1), { handled: true, render: true });
  frame = h.paint();
  assert.equal(h.linesOf(frame)[1], "▾ Subagents full");
  h.widget.setBeerMugs(true);
  assert.equal(h.pointer(frame, 1), undefined, "old disclosure is retired before repaint");
  assert.equal(h.pointer(frame, 2), undefined, "old Agent targets are retired before repaint");
  frame = h.paint();
  assert(h.linesOf(frame)[1].startsWith("🍺 Subagents"));
  for (const x of [0, 1, 15])
    assert.equal(
      h.pointer(frame, 1, x),
      undefined,
      "the wider mug cannot advertise expansion at sixteen columns",
    );
  h.widget.setBeerMugs(false);
  assert.equal(h.pointer(frame, 1), undefined);
  assert.equal(h.pointer(frame, 2), undefined);
  frame = h.paint();
  assert.equal(h.linesOf(frame)[1], "▾ Subagents full", "returning to arrows preserves expansion");
  assert.deepEqual(h.pointer(frame, 1, 15), { handled: true, render: true });
  assert.deepEqual(h.opened, []);
});

for (const beerMugs of [false, true])
  for (const [rows, blocked] of [
    [9, false],
    [9, true],
    [12, false],
    [12, true],
    [13, false],
    [14, true],
    [15, true],
  ]) {
    test(`tiny SDK dock never advertises clipped pagination (rows=${rows}, blocked=${blocked}, beerMugs=${beerMugs})`, (t) => {
      const h = layoutFixture(t, rows, blocked, beerMugs),
        frame = h.paint(),
        lines = h.linesOf(frame);
      assert(!lines.some((line) => /[▸▾]|🍻|\[Prev\]|\[Next\]/.test(line)));
      const heading = lines.find((line) => line.includes("Subagents"));
      if (heading) assert(heading.startsWith(`${beerMugs ? "🍺" : "○"} Subagents`));
      for (let y = 0; y < lines.length; y++) assert.equal(h.pointer(frame, y), undefined);
      assert.deepEqual(h.opened, []);
      assert.equal(h.widget.agents().length, 12, "Alt+A still has a fresh inspection projection");
    });
  }

test("real SDK diagnostic rows stay clickable without inflating resident summary counts", (t) => {
  const h = layoutFixture(t, 60, false);
  h.views.push({ ...idle(12), status: "failed", resident: false, name: "released diagnostic" });
  h.widget.wake();
  let frame = h.paint(),
    lines = h.linesOf(frame);
  const heading = lines.findIndex((line) => line.includes("Subagents"));
  assert.equal(lines[heading], "▸ Subagents (full) · ✓12");
  assert(lines.some((line) => line.includes("✗ released diagnostic")));
  assert.deepEqual(
    h.pointer(
      frame,
      lines.findIndex((line) => line.includes("✗ released diagnostic")),
    ),
    { handled: true },
  );
  h.pointer(frame, heading);
  frame = h.paint();
  lines = h.linesOf(frame);
  const arrow = lines[heading].indexOf("▾"),
    next = lines.findIndex((line) => line.includes("[Next]"));
  assert.equal(arrow, 0);
  assert(next >= 0);
  assert.deepEqual(h.pointer(frame, next, lines[next].indexOf("[Next]")), {
    handled: true,
    render: true,
  });
  frame = h.paint();
  lines = h.linesOf(frame);
  assert.equal(lines[heading].indexOf("▾"), arrow);
  assert.equal(lines[heading], "▾ Subagents (full) · ✓12");
  assert.deepEqual(
    h.pointer(
      frame,
      lines.findIndex((line) => line.includes("✗ released diagnostic")),
    ),
    { handled: true },
  );
  assert.deepEqual(h.opened, ["agent-12", "agent-12"]);
});

test("shrinking the real dock retires old page coordinates before they can act", (t) => {
  const h = layoutFixture(t, 18, false);
  let frame = h.paint(),
    lines = h.linesOf(frame);
  h.pointer(
    frame,
    lines.findIndex((line) => line.includes("Subagents")),
  );
  frame = h.paint();
  lines = h.linesOf(frame);
  const y = lines.findIndex((line) => line.includes("[Next]")),
    x = lines[y].indexOf("[Next]");
  h.terminal.rows = 9;
  assert.equal(
    h.pointer(frame, y, x),
    undefined,
    "terminal resize invalidates the old component paint",
  );
  const tiny = h.paint();
  assert.equal(
    h.pointer(tiny, y, x),
    undefined,
    "clipped/absent page controls are not forwarded by the wrapper",
  );
  assert(!h.linesOf(tiny).some((line) => line.includes("[Next]")));
  h.terminal.rows = 18;
  const restored = h.paint(),
    restoredLines = h.linesOf(restored);
  assert.match(
    restoredLines.find((line) => line.includes("[Next]")),
    /1\//,
  );
  assert.deepEqual(h.opened, []);
});
