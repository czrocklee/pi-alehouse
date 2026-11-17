import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Direct source import: this regression must not depend on a build.
//
// The pane's actions menu is a painted overlay, so every assertion here reads
// pixels through `stripTerminalSequences` and clicks the exact cells of a
// painted label. No private field is inspected: a behaviour that cannot be
// observed through render/handleInput/handleMouse is not part of this contract.
//
// HOME and the XDG dirs are owned temp paths set before the SDK and source
// imports: pi-tui reads user configuration while its module initializes. The
// fixture uses a controlled view and an in-memory transcript only -- no model,
// credentials, network or real session.
const isolatedKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
];
const previousEnv = Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "alehouse-detail-menu-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
test.after(async () => {
  for (const key of isolatedKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

const { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } =
  await import("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[a";
const SHIFT_DOWN = "\x1b[b";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const TAB = "\t";
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
/** A settled Run keeps the painted glyphs static, so whole-paint comparisons
 * describe layout rather than the spinner's 120 ms animation. */
const view = (agent_id = "amber", extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  task: 1,
  description: "Menu fixture",
  effective_settings: settings,
  status: "completed",
  phase: "done",
  execution_exited: true,
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
const running = (agent_id = "amber", extra = {}) =>
  view(agent_id, { status: "running", phase: "executing", execution_exited: false, ...extra });

function paneFixture(t, options = {}) {
  const {
    width = 120,
    rows = 40,
    frame = false,
    count = 200,
    current = view(),
    peers = [],
    onStop,
    onSteer,
    expandToolsKey,
    row = (index) => `ROW${index}`,
  } = options;
  const terminal = { columns: width, rows };
  const modes = [];
  const stops = [];
  const done = [];
  const state = { count, current, peers, hidden: false };
  const entries = () =>
    [state.current, ...state.peers].map((entry) => ({
      agent_id: entry.agent_id,
      input: { view: entry, live },
    }));
  const source = {
    lineCount: () => state.count,
    slice: (_width, start, take) =>
      Array.from({ length: Math.max(0, Math.min(take, state.count - start)) }, (_, index) =>
        row(start + index),
      ),
    setToolsExpanded: (expanded) => modes.push(expanded),
    invalidate() {},
  };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    initial: state.current.agent_id,
    done: () => done.push(true),
    snapshot: entries,
    freshSnapshot: entries,
    visible: () => !state.hidden,
    transcript: () => source,
    ...(onStop ? { onStop: (run_id) => stops.push(run_id) } : {}),
    ...(onSteer
      ? {
          onSteer: (run_id, text) => {
            onSteer(run_id, text);
            return true;
          },
        }
      : {}),
    ...(expandToolsKey ? { expandToolsKey } : {}),
  });
  t.after(() => pane.dispose());
  const raw = (paintWidth = terminal.columns) => pane.render(paintWidth);
  const paint = (paintWidth = terminal.columns) => raw(paintWidth).map(stripTerminalSequences);
  const locate = (label, lines = paint(), from = 0) => {
    for (let y = lines.length - 1; y >= from; y--) {
      const at = lines[y].indexOf(label);
      if (at >= 0) return { x: visibleWidth(lines[y].slice(0, at)), y };
    }
    return assert.fail(`missing painted ${label}: ${lines.join("\n")}`);
  };
  const click = (at, clickCount = 1) =>
    pane.handleMouse({ type: "click", button: "left", x: at.x, y: at.y, clickCount });
  const press = (at) => pane.handleMouse({ type: "press", button: "left", x: at.x, y: at.y });
  return {
    pane,
    terminal,
    state,
    modes,
    stops,
    done,
    raw,
    paint,
    locate,
    click,
    press,
    hide() {
      state.hidden = true;
    },
    show() {
      state.hidden = false;
    },
  };
}

/** The menu's tools row is the one label that never appears anywhere else. */
const menuPainted = (lines) =>
  lines.some((line) => line.includes("Expand tools") || line.includes("Collapse tools"));
const assertMenu = (lines, message = "expected the actions menu") =>
  assert.ok(menuPainted(lines), `${message}: ${lines.join("\n")}`);
const assertNoMenu = (lines, message = "expected no actions menu") =>
  assert.ok(!menuPainted(lines), `${message}: ${lines.join("\n")}`);

/** The only escapes a controlled transcript row emits: SGR and OSC 8. */
const escapeAt = (line, index) => {
  if (line[index] !== "\x1b") return undefined;
  const rest = line.slice(index);
  // eslint-disable-next-line no-control-regex -- parse the controlled SGR span literally
  const sgr = /^\x1b\[([0-9;]*)m/.exec(rest);
  if (sgr)
    return {
      kind: "sgr",
      params: sgr[1] === "" ? [0] : sgr[1].split(";").map(Number),
      length: sgr[0].length,
    };
  // eslint-disable-next-line no-control-regex -- parse the controlled OSC 8 link literally
  const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
  if (osc) return { kind: "osc", length: osc[0].length };
  // eslint-disable-next-line no-control-regex -- skip the controlled CSI introducer literally
  const csi = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(rest);
  if (csi) return { kind: "other", length: csi[0].length };
  return { kind: "other", length: 1 };
};
const applySgr = (state, params) => {
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param === 0) {
      state.bold = false;
      state.italic = false;
      state.background = undefined;
    } else if (param === 1) state.bold = true;
    else if (param === 3) state.italic = true;
    else if (param === 22) state.bold = false;
    else if (param === 23) state.italic = false;
    else if (param === 49) state.background = undefined;
    else if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107))
      state.background = param;
    else if (param === 48) {
      // Extended background: 48;5;n or 48;2;r;g;b. The rest is its payload.
      state.background = params.slice(index).join(";");
      return;
    }
  }
};
/** The SGR state a terminal would be in at `column`, read from the raw line.
 * ANSI is never stripped here: the painted bytes are the contract. */
const styleAt = (line, column) => {
  const state = { bold: false, italic: false, background: undefined };
  const segmenter = new Intl.Segmenter();
  let current = 0;
  let index = 0;
  while (index < line.length) {
    const escape = escapeAt(line, index);
    if (escape) {
      if (escape.kind === "sgr") applySgr(state, escape.params);
      index += escape.length;
      continue;
    }
    let end = index;
    while (end < line.length && !escapeAt(line, end)) end++;
    for (const { segment } of segmenter.segment(line.slice(index, end))) {
      const width = visibleWidth(segment);
      if (column >= current && column < current + width) return { ...state };
      current += width;
    }
    index = end;
  }
  return { ...state };
};
const assertClosed = (line, column, where) => {
  const style = styleAt(line, column);
  assert.equal(style.background, undefined, `${where}: no inherited background at ${column}`);
  assert.equal(style.bold, false, `${where}: no inherited bold at ${column}`);
  assert.equal(style.italic, false, `${where}: no inherited italic at ${column}`);
  assert.equal(
    getOsc8LinkAtColumn(line, column),
    undefined,
    `${where}: no inherited OSC 8 link at ${column}`,
  );
};
test("the default pane has no constant toolbar: one info row under a plain separator", (t) => {
  const h = paneFixture(t, { current: running(), onStop() {} });
  const lines = h.paint();
  assert.match(lines[1], /^ROW\d+$/, "the body begins on the row after the title");
  const flat = lines.join("\n");
  for (const retired of ["Transcript · Info", "Tools collapsed", "Tools expanded"])
    assert.ok(!flat.includes(retired), `no constant ${retired} row: ${flat}`);
  assert.match(lines.at(-3), /^─+$/, "a plain separator above the dock");
  assert.equal(lines.filter((line) => /^─+$/.test(line)).length, 1, "exactly one separator");
  // Normal running work leads the dock with its lifecycle glyph alone.
  assert.match(lines.at(-2), /⠋/, "one info row sits directly above the footer");
  assert.ok(!lines.at(-2).includes("running"));
  for (const x of [0, 40, 119]) {
    assert.equal(h.press({ x, y: lines.length - 3 }), undefined, `separator press at ${x}`);
    assert.equal(h.click({ x, y: lines.length - 3 }), undefined, `separator click at ${x}`);
  }
  const footer = lines.at(-1);
  assert.ok(footer.includes(". more"), `the footer carries the menu control: ${footer}`);
  assert.ok(footer.indexOf(". more") < footer.indexOf("stop"), "Stop stays outermost");
});

test("the . key opens the menu only from a painted footer", (t) => {
  const h = paneFixture(t);
  // Nothing has been laid out, so there is no painted control to toggle.
  h.pane.handleInput(".");
  assertNoMenu(h.paint());
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
});

test("the . more control opens the same menu, and a press alone never activates", (t) => {
  const h = paneFixture(t);
  const before = h.paint();
  const control = h.locate(". more", before);
  assert.deepEqual(h.press(control), { handled: true }, "the press is claimed");
  assert.deepEqual(h.paint(), before, "a press alone never toggles the menu");
  assert.deepEqual(h.click(control), { handled: true });
  const opened = h.paint();
  assertMenu(opened);
  assert.equal(opened.length, before.length, "the menu costs no pane row");
  const item = h.locate("Info", opened);
  assert.deepEqual(h.press(item), { handled: true });
  assert.ok(!h.paint().some((line) => line.includes("routing")), "a press never activates");
  assertMenu(h.paint());
  assert.deepEqual(h.click(item), { handled: true });
  assert.ok(
    h.paint().some((line) => line.includes("routing")),
    "the released click activates the painted item",
  );
});

test("Enter activates only the selected row that a paint has published", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(".");
  // No paint since the menu opened: the item has no published hit yet.
  h.pane.handleInput(ENTER);
  const stillOpen = h.paint();
  assertMenu(stillOpen);
  assert.ok(!stillOpen.some((line) => line.includes("routing")), "Enter stayed inert");
  // That paint published the selected row; Enter now activates it.
  h.pane.handleInput(ENTER);
  const info = h.paint();
  assertNoMenu(info);
  assert.ok(
    info.some((line) => line.includes("routing")),
    "Enter opened Info",
  );
});

test("Up/Down/Tab move the selection, and Enter waits for that row's paint", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(".");
  h.paint();
  h.pane.handleInput(DOWN);
  h.pane.handleInput(ENTER);
  const stillOpen = h.paint();
  assertMenu(stillOpen);
  assert.equal(h.modes.at(-1), false, "an unpainted selection never toggles tools");
  h.pane.handleInput(ENTER);
  const expanded = h.paint();
  assertNoMenu(expanded);
  assert.equal(h.modes.at(-1), true, "the painted second row toggles tools");

  // Tab moves off the page row; two Tabs come back to it.
  h.pane.handleInput(".");
  h.paint();
  h.pane.handleInput(TAB);
  h.paint();
  h.pane.handleInput(ENTER);
  const collapsed = h.paint();
  assertNoMenu(collapsed);
  assert.equal(h.modes.at(-1), false, "Tab reached the tools row");

  h.pane.handleInput(".");
  h.paint();
  h.pane.handleInput(TAB);
  h.paint();
  h.pane.handleInput(TAB);
  h.paint();
  h.pane.handleInput(ENTER);
  assert.ok(
    h.paint().some((line) => line.includes("routing")),
    "Tab wraps back to the painted page row",
  );
});

test("Esc closes the menu before the Info page, the draft and the pane", (t) => {
  const h = paneFixture(t, { current: running(), onSteer() {} });
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput(ESC);
  assertNoMenu(h.paint());
  assert.equal(h.pane.isOpen(), true, "the first Esc only closed the menu");

  h.pane.handleInput("i");
  assert.ok(h.paint().some((line) => line.includes("routing")));
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput(ESC);
  const page = h.paint();
  assertNoMenu(page);
  assert.ok(
    page.some((line) => line.includes("routing")),
    "the Info page is still open",
  );
  h.pane.handleInput(ESC);
  assert.ok(!h.paint().some((line) => line.includes("routing")), "the next Esc left Info");
  assert.equal(h.pane.isOpen(), true);

  h.pane.handleInput("m");
  for (const char of "menu.draft") h.pane.handleInput(char);
  const draft = h.paint();
  assert.ok(
    draft.some((line) => line.includes("menu.draft")),
    "the draft is open",
  );
  h.pane.handleInput(ESC);
  assert.ok(!h.paint().some((line) => line.includes("menu.draft")), "Esc discarded the draft");
  assert.equal(h.pane.isOpen(), true);
  h.pane.handleInput(ESC);
  assert.equal(h.pane.isOpen(), false);
  assert.equal(h.done.length, 1);
});

test("the footer omits the menu while composing or while Stop is armed", (t) => {
  const h = paneFixture(t, { current: running(), onStop() {}, onSteer() {} });
  assert.ok(h.paint().at(-1).includes(". more"));
  h.pane.handleInput("m");
  h.pane.handleInput(".");
  const composing = h.paint();
  assert.ok(!composing.at(-1).includes(". more"), "a draft owns the row");
  assert.ok(
    composing.some((line) => line.includes("› .")),
    "the dot is draft text",
  );
  assertNoMenu(composing);
  h.pane.handleInput(ESC);
  assert.ok(h.paint().at(-1).includes(". more"), "discarding the draft restores the control");

  h.paint();
  h.pane.handleInput("s");
  const armed = h.paint();
  assert.match(armed.at(-1), /confirm stop/);
  assert.ok(!armed.at(-1).includes(". more"), "a confirmation owns the row");
  h.pane.handleInput(".");
  assertNoMenu(h.paint());
  assert.match(h.paint().at(-1), /confirm stop/, "no menu over a confirmation");
  h.pane.handleInput(ESC);
  assert.ok(h.paint().at(-1).includes(". more"));
});

test("the menu overlays the last viewport rows without changing height or scroll", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(PAGE_UP); // read away from the tail
  const before = h.paint();
  h.pane.handleInput(".");
  const opened = h.paint();
  assert.equal(opened.length, before.length, "the menu costs no pane row");
  const top = opened.findIndex((line) => line.includes("╭"));
  const bottom = opened.findIndex((line) => line.includes("╰"));
  assert.ok(top > 0 && bottom - top + 1 === 4, `a rounded four-row menu: ${opened.join("\n")}`);
  assert.deepEqual(opened.slice(0, top), before.slice(0, top), "rows above the menu stay put");
  assert.deepEqual(opened.slice(bottom + 1), before.slice(bottom + 1), "rows below stay put");
  assert.notDeepEqual(opened.slice(top, bottom + 1), before.slice(top, bottom + 1));
  h.pane.handleInput(ESC);
  assert.deepEqual(h.paint(), before, "closing restores the same window and scroll offset");
  h.pane.handleInput(DOWN);
  assert.equal(h.paint()[1], before[2], "the held offset still scrolls by one body row");
});

test("the menu overlays only its own columns and keeps the transcript on the left", (t) => {
  // Full-width transcript rows make the preserved prefix exact, not merely a
  // prefix of a short row: the popup starts at the helper's `from` edge.
  const row = (index) => `ROW${index} ${"-".repeat(240)}`;
  for (const [rows, boxed] of [
    [40, true],
    [8, false],
  ]) {
    const h = paneFixture(t, { rows, row });
    const before = h.paint();
    h.pane.handleInput(".");
    const opened = h.paint();
    assertMenu(opened);
    const page = h.locate("Info", opened);
    const tools = h.locate("Expand tools", opened);
    const edge = boxed ? h.locate("╭", opened).y : Math.min(page.y, tools.y);
    const from = boxed ? opened[edge].indexOf("╭") : Math.min(page.x, tools.x);
    assert.ok(from > 0, `rows=${rows}: the popup leaves transcript columns visible`);
    if (boxed)
      assert.ok(
        opened[edge].slice(from).startsWith("╭"),
        `rows=${rows}: the box starts at its reported left edge`,
      );
    const menuRows = boxed
      ? [edge, edge + 1, edge + 2, edge + 3]
      : [Math.min(page.y, tools.y), Math.max(page.y, tools.y)];
    for (const y of menuRows) {
      assert.equal(
        opened[y].slice(0, from),
        before[y].slice(0, from),
        `rows=${rows}: the transcript stays visible left of the popup`,
      );
      assert.notEqual(
        opened[y].slice(from),
        before[y].slice(from),
        `rows=${rows}: the popup paints only its own columns`,
      );
    }
    assert.equal(opened.length, before.length, `rows=${rows}: no pane row is added`);
    h.pane.handleInput(ESC);
    assert.deepEqual(h.paint(), before, `rows=${rows}: closing restores every column`);
  }
});

test("opening and closing the menu never breaks tail following", (t) => {
  const h = paneFixture(t);
  assert.ok(h.paint().some((line) => line.includes("ROW199")));
  h.pane.handleInput(".");
  h.paint();
  h.pane.handleInput(ESC);
  assert.ok(
    h.paint().some((line) => line.includes("ROW199")),
    "the tail is still followed",
  );
  h.state.count = 210;
  assert.ok(
    h.paint().some((line) => line.includes("ROW209")),
    "a growing transcript still follows the tail",
  );
});

test("Info's back link and the menu's Transcript item restore the held scroll", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(PAGE_UP);
  const held = h.paint();
  h.pane.handleInput("i");
  const info = h.paint();
  assert.match(info[1], /← Transcript/, "the page-local link leads the body");
  assert.ok(info.some((line) => line.includes("routing")));
  assert.deepEqual(h.click(h.locate("← Transcript", info)), { handled: true });
  assert.deepEqual(h.paint(), held, "the back link restores the held window");

  h.pane.handleInput("i");
  h.paint();
  h.pane.handleInput(".");
  const menu = h.paint();
  const item = h.locate("Transcript", menu);
  assert.ok(item.y > 1, "the menu item, not the page's own back link");
  assert.deepEqual(h.click(item), { handled: true });
  assert.deepEqual(h.paint(), held, "the menu item restores the same window");
});

test("a resize closes the menu and leaves its old hits inert", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(".");
  const item = h.locate("Info", h.paint());
  h.terminal.columns = 100;
  assertNoMenu(h.paint(), "a resize retired the menu");
  assert.equal(h.click(item), undefined, "the stale item cell is inert");
  assert.ok(!h.paint().some((line) => line.includes("routing")));

  h.terminal.columns = 120;
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  assertNoMenu(h.paint(110), "a geometry change retires the menu");
  assertNoMenu(h.paint(), "and it stays retired on the original width");
});

test("Esc dismisses a menu whose geometry expired before the repaint", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(".");
  const item = h.locate("Info", h.paint());
  // The terminal narrows, but no render is serviced before the key arrives:
  // the menu is still the layer the user sees, so Esc must dismiss it rather
  // than retire its stale geometry first and close the whole pane.
  h.terminal.columns = 100;
  h.pane.handleInput(ESC);
  assert.equal(h.pane.isOpen(), true, "the first Esc only closed the visible menu");
  assert.equal(h.click(item), undefined, "the stale menu item is inert");
  // A stale menuPaint cannot reopen it either: its painted geometry disagrees.
  h.pane.handleInput(".");
  const quiet = h.paint();
  assertNoMenu(quiet, "a stale menu paint never reopens the menu");
  assert.ok(!quiet.some((line) => line.includes("routing")), "no page was activated");
  h.pane.handleInput(ESC);
  assert.equal(h.pane.isOpen(), false, "the second Esc closes the pane");
  assert.equal(h.done.length, 1);
});

test("Esc dismisses a menu over Info after a silent resize, then leaves Info", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput("i");
  assert.ok(h.paint().some((line) => line.includes("routing")));
  h.pane.handleInput(".");
  const item = h.locate("Transcript", h.paint());
  assert.ok(item.y > 1, "the menu item, not the page's back link");
  // Rows change silently: the open menu is still the topmost layer.
  h.terminal.rows = 30;
  h.pane.handleInput(ESC);
  assert.equal(h.pane.isOpen(), true, "the first Esc only closed the visible menu");
  assert.equal(h.click(item), undefined, "the stale menu item is inert");
  assert.ok(
    h.paint().some((line) => line.includes("routing")),
    "the Info page is still open",
  );
  h.pane.handleInput(ESC);
  assert.ok(!h.paint().some((line) => line.includes("routing")), "the next Esc left Info");
  assert.equal(h.pane.isOpen(), true, "and did not close the pane");
  h.pane.handleInput(ESC);
  assert.equal(h.pane.isOpen(), false);
});

test("an Agent change, permission hiding, invalidation and disposal close the menu", (t) => {
  const h = paneFixture(t, { peers: [view("birch")] });
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.activate("birch");
  assertNoMenu(h.paint(), "an Agent selection closes the menu");
  assert.ok(h.paint().some((line) => line.includes("birch")));

  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.hide();
  assert.deepEqual(h.paint(), [], "a hidden pane paints nothing");
  h.show();
  assertNoMenu(h.paint(), "the menu did not survive hiding");

  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.invalidate();
  assertNoMenu(h.paint(), "invalidation retired the menu");

  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.dispose();
  assert.deepEqual(h.paint(), []);
  h.pane.handleInput(".");
  assert.deepEqual(h.paint(), []);
});

test("a replaced session target closes the menu", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.state.current.run_id = "run-replaced";
  assertNoMenu(h.paint(), "a stale menu target is retired");
});

test("an outside press closes the menu and claims its paired click", (t) => {
  const h = paneFixture(t, { current: running(), peers: [view("birch")], onStop() {} });
  h.paint();
  h.pane.handleInput(".");
  const opened = h.paint();
  const stop = h.locate("stop", opened);
  assert.deepEqual(h.press(stop), { handled: true });
  assertNoMenu(h.paint(), "the press closed the menu");
  assert.deepEqual(h.click(stop), { handled: true });
  const after = h.paint();
  assert.doesNotMatch(after.at(-1), /confirm stop/, "the paired click never reached Stop");
  assert.deepEqual(h.stops, []);

  h.pane.handleInput(".");
  const again = h.paint();
  const tab = h.locate("birch", again);
  assert.deepEqual(h.press(tab), { handled: true });
  assert.deepEqual(h.click(tab), { handled: true });
  assert.ok(
    h.paint().some((line) => line.includes("amber")),
    "the paired click never selected the other Agent",
  );

  h.paint();
  const fresh = h.locate("stop", h.paint());
  assert.deepEqual(h.click(fresh), { handled: true });
  assert.match(h.paint().at(-1), /confirm stop/, "a fresh gesture still arms Stop");
});

test("a double click while the menu is open never arms or confirms Stop", (t) => {
  const h = paneFixture(t, { current: running(), onStop() {} });
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  const stop = h.locate("stop", h.paint());
  assert.deepEqual(h.press(stop), { handled: true });
  assert.deepEqual(h.click(stop, 2), { handled: true });
  assert.doesNotMatch(h.paint().at(-1), /confirm stop/);
  h.paint();
  const fresh = h.locate("stop", h.paint());
  assert.deepEqual(h.click(fresh, 2), { handled: true });
  assert.doesNotMatch(h.paint().at(-1), /confirm stop/, "a multi-click gesture never arms");
  assert.deepEqual(h.stops, []);
});

test("after the menu closes, arming Stop changes only the footer row", (t) => {
  const h = paneFixture(t, { current: running(), onStop() {} });
  const before = h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput(ESC);
  const closed = h.paint();
  assert.deepEqual(
    closed.slice(0, -2),
    before.slice(0, -2),
    "closing the menu changes no body or separator row",
  );
  assert.doesNotMatch(closed.at(-1), /confirm stop/, "closing the menu never arms Stop");
  h.pane.handleInput("s");
  const armed = h.paint();
  assert.equal(armed.length, closed.length, "arming does not resize the pane");
  assert.deepEqual(armed.slice(0, -2), closed.slice(0, -2), "only the footer row changes");
  assert.match(armed.at(-1), /confirm stop/);
  assert.doesNotMatch(armed.at(-1), /\. more/);
});

test("I, T and the host's tools key keep working while the menu is open", (t) => {
  const h = paneFixture(t, { expandToolsKey: (data) => data === "\x05" });
  h.paint();
  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput("t");
  assertNoMenu(h.paint());
  assert.equal(h.modes.at(-1), true, "T still expands tools");

  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput("\x05");
  assertNoMenu(h.paint());
  assert.equal(h.modes.at(-1), false, "the configured tools key still toggles");

  h.pane.handleInput(".");
  assertMenu(h.paint());
  h.pane.handleInput("i");
  const info = h.paint();
  assertNoMenu(info);
  assert.ok(
    info.some((line) => line.includes("routing")),
    "I still opens Info",
  );
});

test("a narrow, short pane keeps a borderless two-row menu", (t) => {
  const h = paneFixture(t, { width: 16, rows: 8 });
  assert.ok(h.paint().at(-1).includes(". more"), h.paint().at(-1));
  h.pane.handleInput(".");
  const opened = h.paint();
  assertMenu(opened);
  assert.ok(
    !opened.some((line) => line.includes("╭") || line.includes("╰")),
    `no box at two menu rows: ${opened.join("\n")}`,
  );
  const info = h.locate("Info", opened);
  const tools = h.locate("Expand tools", opened);
  assert.equal(tools.y, info.y + 1, "the two menu rows are contiguous");
  assert.ok(
    !/ROW\d+/.test(opened[info.y + 2]),
    "the menu's last row is the viewport's last row, above the fixed dock",
  );
  assert.deepEqual(h.click(info), { handled: true });
  const page = h.paint();
  assert.ok(!page.some((line) => /ROW\d+/.test(line)), "the transcript was replaced");
  assert.ok(
    page.some((line) => line.includes("task")),
    "the Info page is shown",
  );
});

test("the menu closes inherited SGR and OSC 8 at both of its edges", (t) => {
  const link = "\x1b]8;;https://example.test/transcript\x07";
  // A styled row that runs past the menu's left edge leaves background, bold,
  // italic and a hyperlink open across it. The overlay must close all four
  // before its own cells and before the pane's right gutter/frame/scrollbar,
  // while leaving the transcript's own styling intact on the left.
  // The styled row must reach past the (now narrower) menu edge so the
  // preserved-prefix comparison covers painted transcript, not row padding.
  const row = (index) => `${link}\x1b[41;1;3mROW${index} ${"-".repeat(120)}`;
  for (const [frame, rows, boxed] of [
    [false, 40, true],
    [false, 8, false],
    [true, 40, true],
    [true, 8, false],
  ]) {
    const where = `frame=${frame} rows=${rows}`;
    const h = paneFixture(t, { frame, rows, row });
    const before = h.paint();
    h.pane.handleInput(".");
    const raw = h.raw();
    const opened = raw.map(stripTerminalSequences);
    assertMenu(opened, `${where}: expected the actions menu`);
    assert.equal(opened.length, before.length, `${where}: the menu costs no pane row`);
    const info = h.locate("Info", opened);
    const tools = h.locate("Expand tools", opened);
    const isBoxed = (opened[info.y - 1] ?? "").includes("╭");
    assert.equal(isBoxed, boxed, `${where}: the menu form`);
    const menuTop = isBoxed ? info.y - 1 : info.y;
    const from = isBoxed
      ? visibleWidth(raw[menuTop].slice(0, raw[menuTop].indexOf("╭")))
      : Math.min(info.x, tools.x);
    assert.equal(visibleWidth(raw[menuTop]), 120, `${where}: the row keeps its width`);
    // The transcript keeps its own styling left of the cut.
    const left = styleAt(raw[menuTop], from - 1);
    assert.equal(left.background, 41, `${where}: the styled prefix survives`);
    assert.equal(left.bold, true, `${where}: the prefix keeps bold`);
    assert.equal(left.italic, true, `${where}: the prefix keeps italic`);
    assert.equal(
      getOsc8LinkAtColumn(raw[menuTop], from - 1),
      "https://example.test/transcript",
      `${where}: the prefix keeps its link`,
    );
    // The menu's first cell starts a closed segment.
    assertClosed(raw[menuTop], from, where);
    // The pane's right gutter/frame/scrollbar is not painted with it either,
    // on either edge of the menu.
    if (frame) {
      const menuBottom = isBoxed ? menuTop + 3 : tools.y;
      for (const lineIndex of [menuTop, menuBottom])
        for (const column of [119, 118, 117]) assertClosed(raw[lineIndex], column, where);
    }
    // The overlay only replaces cells from its own edge; the text left of it
    // is byte-for-byte the transcript that was painted before it opened.
    assert.equal(
      opened[menuTop].slice(0, from),
      before[menuTop].slice(0, from),
      `${where}: the transcript text left of the menu is preserved`,
    );
  }
});

test("the menu cut drops a straddling wide glyph instead of splitting it", (t) => {
  let row = (index) => `ROW${index}`;
  const h = paneFixture(t, { row: (index) => row(index) });
  h.paint();
  h.pane.handleInput(".");
  const probe = h.paint();
  const edge = probe.findIndex((line) => line.includes("╭"));
  assert.ok(edge > 0, "a boxed menu");
  const from = probe[edge].indexOf("╭");
  h.pane.handleInput(ESC);
  assertNoMenu(h.paint());
  // The wide glyph starts one cell before the menu's left edge, so a cell-wise
  // cut has to drop it whole rather than paint half of it under the border.
  row = () => `${"a".repeat(from - 1)}漢${"b".repeat(10)}`;
  h.paint();
  h.pane.handleInput(".");
  const opened = h.paint();
  assertMenu(opened);
  const openedEdge = opened.findIndex((line) => line.includes("╭"));
  assert.equal(openedEdge, edge, "the menu keeps its row");
  assert.equal(opened[openedEdge].indexOf("╭"), from, "the menu still starts at its column");
  assert.equal(
    opened[openedEdge].slice(0, from),
    `${"a".repeat(from - 1)} `,
    "the straddling wide glyph is dropped whole and padded",
  );
  assert.equal(visibleWidth(opened[openedEdge]), 120, "no cell is added or lost");
});

test("partly pinned cleanup notes count in the menu, not twice in the footer", (t) => {
  const cleanup_errors = ["one", "two", "three"];
  for (const [rows, pinned, hidden] of [
    [40, 2, 1],
    [12, 1, 2],
    [10, 0, 3],
  ]) {
    const where = `rows=${rows}`;
    const h = paneFixture(t, { rows, current: view("amber", { cleanup_errors }) });
    h.paint();
    h.pane.handleInput(".");
    const lines = h.paint();
    const attention = lines.filter((line) => line.includes("cleanup:"));
    assert.equal(attention.length, pinned, `${where}: pinned attention rows`);
    if (pinned)
      assert.ok(
        attention.at(-1).includes(`+${hidden}`),
        `${where}: the last pinned row counts the rest: ${attention.at(-1)}`,
      );
    const menu = lines.find((line) => line.includes("Info"));
    assert.ok(
      menu?.includes(`Info +${hidden}`),
      `${where}: the menu carries the same count: ${menu}`,
    );
    if (pinned)
      assert.doesNotMatch(lines.at(-1), /!\d/, `${where}: the footer does not repeat the count`);
    else
      assert.match(
        lines.at(-1),
        new RegExp(`!${hidden}\\b`),
        `${where}: only an unpinned count reaches the footer`,
      );
  }
});

test("a fully pinned or absent attention set adds no overflow count", (t) => {
  for (const cleanup_errors of [[], ["one", "two"]]) {
    const where = `cleanup_errors=${cleanup_errors.length}`;
    const h = paneFixture(t, { rows: 40, current: view("amber", { cleanup_errors }) });
    h.paint();
    h.pane.handleInput(".");
    const lines = h.paint();
    assert.equal(
      lines.filter((line) => line.includes("cleanup:")).length,
      cleanup_errors.length,
      `${where}: every note is pinned`,
    );
    const menu = lines.find((line) => line.includes("Info"));
    assert.ok(menu?.includes("Info"), `${where}: the menu offers Info: ${menu}`);
    assert.ok(!menu.includes("+"), `${where}: no overflow count: ${menu}`);
    assert.doesNotMatch(lines.at(-1), /!\d/, `${where}: no footer count`);
  }
});

test("a narrow menu keeps an attention count whole, never clipped", (t) => {
  // The count is a fact, never a clipped prefix. The inline mnemonic leaves
  // the 16-column floor's 12 option cells enough for this four-digit count,
  // so it is shown whole; the helper test covers a count that must drop.
  const cleanup_errors = Array.from({ length: 10_000 }, (_, index) => `e${index}`);
  const h = paneFixture(t, { width: 16, rows: 40, current: view("amber", { cleanup_errors }) });
  h.paint();
  h.pane.handleInput(".");
  const lines = h.paint();
  const info = h.locate("Info", lines);
  const label = lines[info.y].slice(info.x);
  assert.ok(label.startsWith("Info +9998"), label);
  assert.ok(!label.includes("+999 "), `the count is whole, not clipped: ${label}`);
  assert.ok(
    lines.some((line) => line.includes("+9998")),
    "the pinned rows still count what they hide",
  );
});

test("the Info page's menu return carries no overflow count", (t) => {
  const h = paneFixture(t, {
    rows: 40,
    current: view("amber", { cleanup_errors: ["one", "two", "three"] }),
  });
  h.paint();
  h.pane.handleInput("i");
  h.paint();
  h.pane.handleInput(".");
  const lines = h.paint();
  const item = h.locate("Transcript", lines);
  assert.ok(item.y > 1, "the menu item, not the page's back link");
  const label = lines[item.y].slice(item.x);
  assert.ok(label.startsWith("Transcript"), label);
  assert.ok(!label.includes("+"), `the return item advertises no count: ${label}`);
  assert.ok(
    lines.some((line) => line.includes("+1")),
    "the page itself still counts the notes it hides",
  );
});

test("every body scroll intent dismisses the menu, while Up/Down select", (t) => {
  for (const [name, key] of [
    ["j", "j"],
    ["k", "k"],
    ["shift+up", SHIFT_UP],
    ["shift+down", SHIFT_DOWN],
    ["home", HOME],
    ["end", END],
    ["pageUp", PAGE_UP],
    ["pageDown", PAGE_DOWN],
  ]) {
    const h = paneFixture(t);
    h.paint();
    h.pane.handleInput(".");
    assertMenu(h.paint());
    h.pane.handleInput(key);
    assertNoMenu(h.paint(), `${name} dismissed the menu`);
  }

  const wheel = paneFixture(t);
  wheel.paint();
  wheel.pane.handleInput(".");
  assertMenu(wheel.paint());
  assert.deepEqual(wheel.pane.handleMouse({ type: "wheel", wheelDelta: 1, x: 5, y: 5 }), {
    handled: true,
  });
  assertNoMenu(wheel.paint(), "the wheel dismissed the menu");

  // Ordinary Up/Down stay menu selection; only the shifted pair scrolls.
  for (const [name, key] of [
    ["Up", UP],
    ["Down", DOWN],
  ]) {
    const select = paneFixture(t);
    select.paint();
    select.pane.handleInput(".");
    select.paint();
    select.pane.handleInput(key);
    assertMenu(select.paint(), `${name} stayed on the menu`);
    select.pane.handleInput(ENTER);
    assertNoMenu(select.paint());
    assert.equal(select.modes.at(-1), true, `${name} reached the painted second row`);
  }
});

test("no menu control is painted where the menu could not be painted", (t) => {
  // The baseline: the same fixture at a supported geometry paints it, so the
  // absences below are the availability guard, not a blanket omission.
  const supported = paneFixture(t);
  assert.ok(supported.paint().at(-1).includes(". more"), "a supported geometry paints it");

  // A docked pane below the menu's 16-column floor.
  const narrow = paneFixture(t, { width: 15 });
  assert.ok(!narrow.paint().at(-1).includes(". more"), "no inert control below the floor");
  narrow.pane.handleInput(".");
  assertNoMenu(narrow.paint());

  // A viewport that cannot fit the pane's own rows.
  const short = paneFixture(t, { rows: 7 });
  assert.ok(!short.paint().at(-1).includes(". more"), "no control without a fitting viewport");
  short.pane.handleInput(".");
  assertNoMenu(short.paint());

  // A paint wider than the terminal it claims.
  const wide = paneFixture(t);
  assert.ok(!wide.paint(121).at(-1).includes(". more"), "no control past the terminal's columns");
  wide.pane.handleInput(".");
  assertNoMenu(wide.paint(121));

  // Non-finite terminal geometry cannot own a painted control.
  const invalid = paneFixture(t);
  invalid.terminal.columns = Number.NaN;
  assert.ok(!invalid.paint(120).at(-1).includes(". more"), "no control for invalid geometry");
  invalid.pane.handleInput(".");
  assertNoMenu(invalid.paint(120));
});
