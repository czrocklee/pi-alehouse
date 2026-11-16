import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";

// Direct source import: this regression must not depend on a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const settings = {
  provider: "fixture",
  model: "controlled",
  thinking: "off",
  parent_thinking: "off",
  thinking_resolution: "identity",
  profile: "editor",
  difficulty: 3,
  strength: "d3",
  preset: "fixture",
  preset_version: "v1",
  selection_digest: "2".repeat(64),
  cwd: "/tmp",
  tools: ["read"],
  definition_digest: "1".repeat(64),
};
const live = { active_tools: [], tool_uses: 0, preview: "" };
const view = (agent_id, extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  task: 1,
  description: `Task ${agent_id}`,
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});

// Real pinned SDK rendering and SGR press/release normalization, with all
// terminal writes discarded. The unframed case is a docked-style layout root,
// not a claim that regular-mode Pi forwards terminal-owned mouse input.
function chromeFixture(
  t,
  { frame = true, width = 120, count = 4, name = "peer", transcript = false, visible } = {},
) {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const terminal = { columns: width, rows: 40, write() {}, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  tui.requestRender = () => {};
  const selections = [],
    clicks = [],
    stopped = [];
  const views = Array.from({ length: count }, (_, i) => view(`${name}${i}`));
  const entries = views.map((v) => ({ agent_id: v.agent_id, input: { view: v, live } }));
  const rows = transcript
    ? {
        lineCount: () => 200,
        slice: (_width, start, take) =>
          Array.from({ length: Math.min(take, 200 - start) }, (_, i) => `ROW${start + i}`),
        invalidate() {},
      }
    : undefined;
  const pane = new DetailPane({
    tui,
    theme,
    frame,
    initial: `${name}0`,
    done() {},
    snapshot: () => entries,
    onSelect: (id) => selections.push(id),
    onStop: (id) => stopped.push(id),
    transcript: () => rows,
    visible,
  });
  const receive = pane.handleMouse.bind(pane);
  pane.handleMouse = (event) => {
    if (event.type === "click") clicks.push(event.clickCount);
    return receive(event);
  };
  if (frame) tui.showOverlay(pane, { anchor: "top-left", row: 0, col: 0, width });
  else tui.setLayoutRoot(pane);
  // Controlled SDK seams: initialize only the fake terminal and synchronously
  // paint frames so every rapid gesture can see the newly drawn chrome.
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
  const locate = (label, screen = paint()) => {
    const y = screen.findIndex((line) => line.includes(label));
    assert.ok(y >= 0, `missing ${label}`);
    return { x: visibleWidth(screen[y].slice(0, screen[y].indexOf(label))), y };
  };
  const send = (x, y, release) => {
    const raw = tui.parseSgrMouseEvent(`\x1b[<0;${x + 1};${y + 1}${release ? "m" : "M"}`);
    assert(raw);
    tui.handleMouseEvent(raw);
  };
  // Held-button motion: an SGR drag with the left button down.
  const drag = (x, y) => {
    const raw = tui.parseSgrMouseEvent(`\x1b[<32;${x + 1};${y + 1}M`);
    assert(raw);
    tui.handleMouseEvent(raw);
  };
  const click = (x, y) => {
    send(x, y, false);
    send(x, y, true);
  };
  return {
    pane,
    tui,
    terminal,
    selections,
    clicks,
    stopped,
    paint,
    locate,
    send,
    drag,
    click,
    advance: (ms) => {
      now += ms;
    },
  };
}

for (const frame of [false, true]) {
  test(`rapid › gestures navigate once per click through the SDK (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame });
    for (const expected of ["peer1", "peer2", "peer3"]) {
      // Repaint and relocate: activating a control can rearrange the strip.
      const arrow = h.locate("›");
      h.click(arrow.x, arrow.y);
      h.paint();
      assert.deepEqual(h.selections.slice(-1), [expected]);
      h.advance(50);
    }
    assert.deepEqual(h.selections, ["peer1", "peer2", "peer3"]);
    assert.deepEqual(
      h.clicks,
      [1, 2, 3],
      "each rapid gesture stays a component-counted click, never SDK text selection",
    );
  });

  test(`‹ wraps, and a visible peer tab click selects that Agent (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame });
    const back = h.locate("‹");
    h.click(back.x, back.y);
    h.paint();
    assert.deepEqual(h.selections, ["peer3"]);
    const tab = h.locate("peer2");
    h.click(tab.x, tab.y);
    assert.deepEqual(h.selections, ["peer3", "peer2"]);
    assert.deepEqual(h.clicks, [1, 1]);
  });

  test(`a chrome press claims without activating; a drag away never activates (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame });
    const arrow = h.locate("›");
    h.send(arrow.x, arrow.y, false);
    assert.deepEqual(h.selections, [], "press alone never navigates");
    h.drag(arrow.x + 6, arrow.y - 2);
    h.send(arrow.x + 6, arrow.y - 2, true);
    assert.deepEqual(h.selections, [], "a moved release never activates");
    assert.deepEqual(h.clicks, []);
    assert.equal(h.tui.hasActiveSelection(), false, "claiming the press starts no selection");
    const fresh = h.locate("›");
    h.click(fresh.x, fresh.y);
    assert.deepEqual(h.selections, ["peer1"], "a later unmoved gesture still navigates");
  });

  test(`stale terminal geometry voids painted chrome hits (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame });
    const arrow = h.locate("›");
    h.terminal.columns = 100; // Resize without an intervening repaint.
    h.click(arrow.x, arrow.y);
    assert.deepEqual(h.selections, [], "the old paint's hit is void after a resize");
    const fresh = h.locate("›");
    h.click(fresh.x, fresh.y);
    assert.deepEqual(h.selections, ["peer1"], "a fresh paint restores the control");
  });

  test(`rapid Stop clicks still only arm; chrome claiming never confirms (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame });
    const stop = h.locate("[S Stop]");
    h.click(stop.x, stop.y);
    const confirmation = h.locate("[Confirm stop]");
    assert.equal(confirmation.y, stop.y);
    assert.deepEqual(h.stopped, [], "the initial click only arms confirmation");
    for (let repeat = 0; repeat < 2; repeat++) {
      h.advance(50);
      h.click(stop.x, stop.y);
      h.paint();
    }
    assert.deepEqual(h.stopped, [], "double and triple clicks never confirm");
    assert.deepEqual(h.clicks, [1, 2, 3]);
    h.advance(501);
    const armed = h.locate("[Confirm stop]");
    h.click(armed.x, armed.y);
    assert.deepEqual(h.stopped, ["run-peer0"]);
  });
}

test("a hidden pane never activates chrome from a stale paint", (t) => {
  let shown = true;
  const h = chromeFixture(t, { frame: true, visible: () => shown });
  const arrow = h.locate("›");
  shown = false; // Permission yield hides the mounted pane without disposing it.
  h.click(arrow.x, arrow.y);
  assert.deepEqual(h.selections, []);
  shown = true;
  const fresh = h.locate("›", h.paint());
  h.click(fresh.x, fresh.y);
  assert.deepEqual(h.selections, ["peer1"]);
});

test("a mid-gesture page transition voids the painted chrome target", (t) => {
  const h = chromeFixture(t, { frame: false, transcript: true });
  const arrow = h.locate("›");
  h.send(arrow.x, arrow.y, false); // The press is claimed by the current paint.
  h.pane.handleInput("i"); // The page flips before the release.
  h.send(arrow.x, arrow.y, true);
  assert.deepEqual(h.selections, [], "the released click finds no live chrome paint");
  const fresh = h.locate("›", h.paint());
  h.click(fresh.x, fresh.y);
  assert.deepEqual(h.selections, ["peer1"]);
});

test("plain transcript presses keep ordinary SDK text selection", (t) => {
  const h = chromeFixture(t, { frame: true, transcript: true });
  // Locate the actual text cells: the framed pane has a width-dependent
  // gutter, and starting in that gutter intentionally starts no selection.
  const { x, y } = h.locate("ROW");
  h.send(x, y, false);
  h.drag(x, y + 2);
  h.send(x, y + 2, true);
  assert.equal(h.tui.hasActiveSelection(), true, "a transcript drag still selects text");
  assert.deepEqual(h.selections, []);
  assert.deepEqual(h.clicks, []);
});

test("a framed transcript gutter press never starts a whole-screen selection", (t) => {
  const h = chromeFixture(t, { frame: true, transcript: true });
  const { x, y } = h.locate("ROW");
  assert.ok(x > 1, "the framed transcript has a gutter before its text");
  h.send(x - 1, y, false);
  h.drag(x, y + 2);
  h.send(x, y + 2, true);
  assert.equal(h.tui.hasActiveSelection(), false, "gutter presses are not text-body presses");
  assert.deepEqual(h.selections, []);
  assert.deepEqual(h.clicks, []);
});

for (const frame of [false, true]) {
  test(`footer menu routes Info, tools and the tail through SDK clicks (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame, transcript: true });
    let screen = h.paint();
    assert.ok(
      screen.some((line) => /ROW\d+/.test(line)),
      "transcript body is shown",
    );
    const height = h.pane.render(120).length;
    const bodyY = screen.findIndex((line) => /ROW\d+/.test(line));

    // The footer's [⋯] opens the compact actions menu over the bottom of the
    // viewport: no pane row and no scroll position changes.
    const trigger = h.locate("[⋯]");
    h.click(trigger.x, trigger.y);
    screen = h.paint();
    assert.equal(h.pane.render(120).length, height, "the menu costs no pane row");
    assert.equal(
      screen.findIndex((line) => /ROW\d+/.test(line)),
      bodyY,
      "opening the menu does not scroll the body",
    );
    assert.ok(
      screen.some((line) => line.includes("Expand tools")),
      "the menu lists the tools toggle",
    );

    const tools = h.locate("Expand tools");
    h.click(tools.x, tools.y);
    screen = h.paint();
    assert.ok(
      screen.some((line) => /ROW\d+/.test(line)),
      "toggling tools keeps the body",
    );
    assert.ok(
      !screen.some((line) => line.includes("Expand tools")),
      "activating an item closes the menu",
    );

    const reopen = h.locate("[⋯]");
    h.click(reopen.x, reopen.y);
    assert.ok(
      h.paint().some((line) => line.includes("Collapse tools")),
      "the menu follows the expansion state",
    );
    const collapse = h.locate("Collapse tools");
    h.click(collapse.x, collapse.y);
    assert.ok(
      h.paint().some((line) => /ROW\d+/.test(line)),
      "collapsing keeps the body",
    );

    const infoTrigger = h.locate("[⋯]");
    h.click(infoTrigger.x, infoTrigger.y);
    const info = h.locate("Info");
    h.click(info.x, info.y);
    assert.ok(!h.paint().some((line) => /ROW\d+/.test(line)), "Info replaces the transcript body");
    const back = h.locate("← Transcript");
    h.click(back.x, back.y);
    assert.ok(
      h.paint().some((line) => /ROW\d+/.test(line)),
      "the page-local ← Transcript restores the body",
    );

    h.pane.handleInput("\x1b[A"); // Scroll one row away from the live tail.
    screen = h.paint();
    const tailY = screen.findIndex((line) => line.includes("more"));
    assert.ok(tailY >= 0, "the tail cue appears after scrolling away");
    const tailX = visibleWidth(screen[tailY].slice(0, screen[tailY].indexOf("more")));
    h.click(tailX, tailY);
    assert.ok(
      !h.paint().some((line) => line.includes("more")),
      "the tail click jumps back and resumes following",
    );
  });
}

for (const frame of [false, true]) {
  test(`the actions menu closes before the pane and needs painted geometry (frame=${frame})`, (t) => {
    const h = chromeFixture(t, { frame, transcript: true });
    h.paint();
    h.pane.handleInput(".");
    assert.ok(
      h.paint().some((line) => line.includes("Expand tools")),
      "'.' opens the compact menu",
    );
    h.pane.handleInput(".");
    assert.ok(!h.paint().some((line) => line.includes("Expand tools")), "'.' closes it again");
    h.pane.handleInput(".");
    h.pane.handleInput("\x1b");
    assert.ok(
      !h.paint().some((line) => line.includes("Expand tools")),
      "Esc closes the menu first",
    );
    assert.equal(h.pane.isOpen(), true, "the pane stays open");
    h.pane.handleInput("\x1b");
    assert.equal(h.pane.isOpen(), false, "the next Esc closes the pane");
  });
}

test("a stale terminal geometry cannot open the actions menu", (t) => {
  const h = chromeFixture(t, { frame: false, transcript: true });
  h.paint();
  h.terminal.rows = 20; // Resize without an intervening repaint.
  h.pane.handleInput(".");
  assert.ok(
    !h.paint().some((line) => line.includes("Expand tools")),
    "the old paint's menu is void after a resize",
  );
  h.pane.handleInput(".");
  assert.ok(
    h.paint().some((line) => line.includes("Expand tools")),
    "a fresh paint restores the menu",
  );
});

test("a menu press claims without opening; a moved release never opens it", (t) => {
  const h = chromeFixture(t, { frame: false, transcript: true });
  h.paint();
  const trigger = h.locate("[⋯]");
  h.send(trigger.x, trigger.y, false);
  assert.ok(
    !h.paint().some((line) => line.includes("Expand tools")),
    "press alone never opens the menu",
  );
  h.drag(2, 2);
  h.send(2, 2, true);
  assert.ok(
    !h.paint().some((line) => line.includes("Expand tools")),
    "a moved release never opens the menu",
  );
  const fresh = h.locate("[⋯]");
  h.click(fresh.x, fresh.y);
  assert.ok(
    h.paint().some((line) => line.includes("Expand tools")),
    "an unmoved click opens the menu",
  );
});

for (const [rows, boxed] of [
  [10, false],
  [40, true],
]) {
  test(`the actions menu uses ${boxed ? "four rounded rows" : "two rows"} at ${rows}-row terminals`, (t) => {
    const h = chromeFixture(t, { frame: false, transcript: true });
    h.terminal.rows = rows;
    h.paint();
    h.pane.handleInput(".");
    const screen = h.paint();
    assert.ok(
      screen.some((line) => line.includes("Expand tools")),
      "the menu is painted",
    );
    assert.equal(
      screen.some((line) => line.includes("╭")),
      boxed,
      boxed ? "room for the rounded box" : "a short viewport stays borderless",
    );
    assert.equal(
      screen.some((line) => line.includes("╰")),
      boxed,
      "the box closes only when it opened",
    );
  });
}

test("a clickable +N summary selects the next hidden Agent", (t) => {
  const h = chromeFixture(t, { frame: false, width: 40, count: 8, name: "nick" });
  const screen = h.paint();
  const y = screen.findIndex((line) => /\+\d+/.test(line));
  assert.ok(y >= 0, "a clipped strip summarizes hidden peers");
  const token = /\+\d+/.exec(screen[y]);
  assert.ok(token);
  const x = visibleWidth(screen[y].slice(0, token.index));
  h.click(x, y);
  assert.equal(h.selections.length, 1);
  const selected = h.selections[0];
  assert.match(selected, /^nick\d+$/);
  assert.notEqual(selected, "nick0");
  assert.ok(
    h.paint().some((line) => line.includes(selected)),
    "the newly selected Agent's tab is shown",
  );
});
