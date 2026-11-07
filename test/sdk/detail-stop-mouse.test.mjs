import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane } from "../../dist/orchestration/ui/agent-detail.js";
import { settings } from "../support/controller-fixture.mjs";

const theme = { fg: (_color, text) => text, bold: (text) => text };

// Real pinned SDK rendering and SGR press/release normalization, with all terminal
// writes discarded. The unframed case is a docked-style layout in fullscreen,
// not a claim that regular-mode Pi forwards terminal-owned mouse input.
function mouseFixture(t, frame, width, { status = "running" } = {}) {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const terminal = { columns: width, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  const stopped = [],
    clicks = [];
  const view = {
    owner_id: "owner",
    generation: "generation",
    agent_id: "a",
    run_id: "run-a",
    name: "a",
    description: "Mouse confirmation fixture",
    effective_settings: settings,
    status,
    phase: "executing",
    execution_exited: false,
    finalization_pending: false,
    resident: true,
    resumable: false,
    owner_blocked: false,
    pending_messages: 0,
    isolation: "shared",
    elapsed_ms: 0,
    turns: 1,
    max_turns: 8,
    cleanup_errors: [],
    discarded_inputs: [],
  };
  const pane = new DetailPane({
    tui,
    theme,
    frame,
    initial: "a",
    done() {},
    onStop: (id) => stopped.push(id),
    snapshot: () => [
      { agent_id: "a", input: { view, live: { active_tools: [], tool_uses: 0, preview: "" } } },
    ],
    transcript: () => undefined,
  });
  const receive = pane.handleMouse.bind(pane);
  pane.handleMouse = (event) => {
    if (event.type === "click") clicks.push(event.clickCount);
    return receive(event);
  };
  if (frame) tui.showOverlay(pane, { anchor: "top-left", row: 0, col: 0, width });
  else tui.setLayoutRoot(pane);
  // Controlled SDK seams: initialize only the fake terminal and synchronously
  // paint frames so every rapid click can see the newly drawn footer.
  tui.beforeTerminalStart();
  t.after(() => {
    pane.dispose();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  const paint = () => {
    tui.doRender();
    return tui.getScreenLines().map(stripTerminalSequences);
  };
  const locate = (label) => {
    const screen = paint(),
      y = screen.findIndex((line) => line.includes(label));
    assert(y >= 0, `missing ${label}`);
    return { x: visibleWidth(screen[y].slice(0, screen[y].indexOf(label))), y };
  };
  const send = (x, y, release) => {
    const raw = tui.parseSgrMouseEvent(`\x1b[<0;${x + 1};${y + 1}${release ? "m" : "M"}`);
    assert(raw);
    tui.handleMouseEvent(raw);
  };
  const click = (x, y) => {
    send(x, y, false);
    send(x, y, true);
  };
  return {
    pane,
    stopped,
    clicks,
    paint,
    locate,
    send,
    click,
    advance: (ms) => {
      now += ms;
    },
  };
}

for (const frame of [false, true])
  for (const width of [80, 120])
    for (let offset = 0; offset < "[S Stop]".length; offset++) {
      test(`rapid clicks cannot confirm Stop through the SDK (frame=${frame}, width=${width}, offset=${offset})`, (t) => {
        const h = mouseFixture(t, frame, width),
          initial = h.locate("[S Stop]");
        const x = initial.x + offset,
          y = initial.y;
        h.click(x, y);
        assert.deepEqual(h.stopped, [], "the initial click only arms confirmation");
        const confirmation = h.locate("[Confirm stop]");
        assert.equal(confirmation.y, y);
        assert(
          x >= confirmation.x && x < confirmation.x + "[Confirm stop]".length,
          "the original click lies in the new action",
        );
        h.advance(50);
        h.click(x, y);
        h.paint();
        assert.deepEqual(
          h.stopped,
          [],
          "a double-click must not cancel the task, even with an intervening repaint",
        );
        h.advance(50);
        h.click(x, y);
        h.paint();
        assert.deepEqual(h.stopped, [], "a triple-click must not confirm either");
        assert.deepEqual(
          h.clicks,
          [1, 2, 3],
          "button gestures use SDK component click counts, independent of changed label text",
        );
        h.advance(501);
        h.click(x, y);
        h.paint();
        assert.deepEqual(h.clicks, [1, 2, 3, 1]);
        assert.deepEqual(
          h.stopped,
          ["run-a"],
          "a later deliberate single click confirms the original Run",
        );
      });
    }

for (const frame of [false, true])
  for (const status of ["running", "queued"])
    for (const fits of [false, true]) {
      const minimum = (frame ? 62 : 56) + (status === "queued" ? 3 : 0);
      const width = minimum - (fits ? 0 : 1);
      test(`SDK footer honors the complete best-effort hint/status boundary (frame=${frame}, status=${status}, width=${width})`, (t) => {
        const h = mouseFixture(t, frame, width, { status });
        if (!fits) {
          assert(
            !h.paint().some((line) => line.includes("[S Stop]") || line.includes("[Confirm stop]")),
          );
          h.pane.handleInput("s");
          h.pane.handleInput("\x13");
          assert.deepEqual(h.stopped, []);
          return;
        }
        const initial = h.locate("[S Stop]");
        assert.equal(initial.x + "[S Stop]".length, width - (frame ? 3 : 0));
        h.click(initial.x + "[S Stop]".length - 1, initial.y);
        const confirmation = h.locate("[Confirm stop]");
        assert.equal(confirmation.x + "[Confirm stop]".length, width - (frame ? 3 : 0));
        assert(
          h.paint()[confirmation.y].includes("best-effort · Ctrl+S · Esc cancel · [Confirm stop]"),
        );
        h.advance(501);
        h.click(confirmation.x, confirmation.y);
        assert.deepEqual(h.stopped, ["run-a"]);
      });
    }

for (const frame of [false, true])
  for (const elapsed of [9999, 10000]) {
    test(`real SDK gesture cannot execute an expired unpainted confirmation (frame=${frame}, elapsed=${elapsed})`, (t) => {
      const h = mouseFixture(t, frame, 120),
        initial = h.locate("[S Stop]");
      h.click(initial.x, initial.y);
      const confirmation = h.locate("[Confirm stop]");
      h.advance(elapsed);
      // No intervening SDK render: press/release must reject stale action paint.
      h.click(confirmation.x + "[Confirm stop]".length - 1, confirmation.y);
      assert.deepEqual(h.stopped, elapsed < 10000 ? ["run-a"] : []);
      if (elapsed === 10000) {
        assert(h.paint().some((line) => line.includes("[S Stop]")));
        h.pane.handleInput("\x13");
        assert.deepEqual(h.stopped, []);
        const fresh = h.locate("[S Stop]");
        h.advance(501);
        h.click(fresh.x, fresh.y);
        const armed = h.locate("[Confirm stop]");
        h.advance(501);
        h.click(armed.x, armed.y);
        assert.deepEqual(
          h.stopped,
          ["run-a"],
          "only fresh painted gestures restore cancellation intent",
        );
      }
    });
  }

for (const frame of [false, true]) {
  test(`a held or moved Stop press does not arm confirmation (frame=${frame})`, (t) => {
    const h = mouseFixture(t, frame, 120),
      { x, y } = h.locate("[S Stop]");
    assert.equal(
      h.pane.handleMouse({ type: "press", button: "left", x: x - 1, y }),
      undefined,
      "text beside the button retains ordinary selection behavior",
    );
    h.send(x, y, false);
    assert(
      h.paint().some((line) => line.includes("[S Stop]")),
      "press alone does not arm",
    );
    h.send(x + 1, y, true);
    assert(
      h.paint().some((line) => line.includes("[S Stop]")),
      "a moved release does not arm",
    );
    assert.deepEqual(h.clicks, []);
    assert.deepEqual(h.stopped, []);
    h.advance(501);
    h.click(x, y);
    assert(
      h.paint().some((line) => line.includes("[Confirm stop]")),
      "a later unmoved gesture still works",
    );
  });

  test(`keyboard-armed Stop accepts a deliberate pointer or keyboard confirmation (frame=${frame})`, (t) => {
    const h = mouseFixture(t, frame, 120);
    h.paint();
    h.pane.handleInput("s");
    const { x, y } = h.locate("[Confirm stop]");
    h.click(x, y);
    assert.deepEqual(h.stopped, ["run-a"]);
    h.paint();
    h.pane.handleInput("s");
    h.paint();
    h.pane.handleInput("\x13");
    assert.deepEqual(
      h.stopped,
      ["run-a", "run-a"],
      "Ctrl+S remains a separate explicit confirmation",
    );
  });
}
