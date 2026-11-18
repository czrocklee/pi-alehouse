import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Direct source import: this regression must not depend on a build.
//
// The pane's bottom dock is one summary row under a plain separator, and the
// transcript window begins immediately after the header. There is no constant
// Transcript/Info/Tools row on either page: I/T stay keys, the footer carries an
// optional `. more` menu, and Info offers a page-local `← Transcript` link.
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
const home = await mkdtemp(join(tmpdir(), "alehouse-detail-dock-home-"));
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

const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailSummary } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
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
const live = (extra = {}) => ({ active_tools: [], tool_uses: 0, preview: "", ...extra });
const view = (extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: "amber",
  run_id: "run-amber",
  name: "amber",
  task: 1,
  description: "Dock fixture",
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
  turn_elapsed_ms: 1100,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});
/** The pane's own content width for a pane width, frame side and gutter included. */
const contentWidth = (width, frame) => {
  const inner = frame ? width - 2 : width;
  const gutter = frame ? 1 : 0;
  return inner - gutter * 2;
};
/** A plain separator row: docked it is the whole row, framed it sits between
 * the side, the gutter and the right border. */
const separatorRow = (frame) => (frame ? /^│ ─+ │$/ : /^─+$/);

function paneFixture(
  t,
  {
    frame = false,
    width = 120,
    rows = 40,
    count = 200,
    current = view(),
    generation = live(),
    onStop,
  } = {},
) {
  const terminal = { columns: width, rows };
  const modes = [];
  const sent = [];
  const source = {
    lineCount: () => count,
    slice: (_width, start, take) =>
      Array.from(
        { length: Math.max(0, Math.min(take, count - start)) },
        (_, i) => `ROW${start + i}`,
      ),
    setToolsExpanded: (expanded) => modes.push(expanded),
    invalidate() {},
  };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    initial: current.agent_id,
    done() {},
    snapshot: () => [{ agent_id: current.agent_id, input: { view: current, live: generation } }],
    transcript: () => source,
    onStop,
    onSteer(run, text) {
      sent.push([run, text]);
      return true;
    },
  });
  t.after(() => pane.dispose());
  const paint = (w = terminal.columns) => pane.render(w).map(stripTerminalSequences);
  const locate = (label, lines) => {
    const y = lines.findIndex((line) => line.includes(label));
    assert.ok(y >= 0, `missing ${label}`);
    return { x: visibleWidth(lines[y].slice(0, lines[y].indexOf(label))), y };
  };
  const clickAt = ({ x, y }, clickCount = 1) =>
    pane.handleMouse({ type: "click", button: "left", x, y, clickCount });
  const click = (label, lines) => clickAt(locate(label, lines));
  const metricsRow = (w = terminal.columns) =>
    renderDetailSummary({ view: current, live: generation }, theme, contentWidth(w, frame), {
      activity: false,
    })[0];
  const press = (x, y) => pane.handleMouse({ type: "press", button: "left", x, y });
  return {
    pane,
    terminal,
    modes,
    sent,
    current,
    generation,
    paint,
    locate,
    click,
    clickAt,
    press,
    metricsRow,
  };
}

test("the transcript window starts immediately after the header, with no constant page row", (t) => {
  const h = paneFixture(t);
  const lines = h.paint();
  assert.match(lines[0], /^amber \(worker\/d3\) {2}Dock fixture/, lines[0]);
  assert.match(lines[1], /^ROW\d+$/, "the body begins on the row after the title");
  const flat = lines.join("\n");
  for (const retired of ["Transcript · Info", "Tools collapsed", "Tools expanded"])
    assert.ok(!flat.includes(retired), `no constant ${retired} row: ${flat}`);
  assert.doesNotMatch(lines[0], /running/, "the title never carries the lifecycle status");
});

test("one summary row sits directly above the footer, below a plain separator", (t) => {
  for (const frame of [false, true]) {
    const h = paneFixture(t, { frame });
    const lines = h.paint();
    const metrics = h.metricsRow();
    assert.equal(
      lines.length,
      frame ? 33 : 28,
      `frame=${frame}: the 70% docked / 84% floating cap`,
    );
    assert.ok(lines.at(-2).includes(metrics), `frame=${frame}: the whole metrics row is kept`);
    assert.match(lines.at(-3), separatorRow(frame), lines.at(-3));
    assert.equal(
      lines.filter((line) => separatorRow(frame).test(line)).length,
      1,
      "exactly one separator",
    );
    // The separator is text only: no control rides it, at any column.
    const y = lines.length - 3;
    for (const x of [0, 3, 60, 119]) {
      assert.equal(h.press(x, y), undefined, `frame=${frame}: press at ${x}`);
      assert.equal(h.clickAt({ x, y }), undefined, `frame=${frame}: click at ${x}`);
    }
    h.paint();
    assert.equal(h.modes.at(-1), false, "the separator never toggles tools");
    assert.ok(
      !h.paint().some((line) => line.includes("routing")),
      "the separator never opens Info",
    );
  }
});

test("the dock carries status and the current-turn clock, the title never does", (t) => {
  const h = paneFixture(t);
  const lines = h.paint();
  assert.doesNotMatch(lines[0], /running/);
  assert.match(lines.at(-2), /^│? {0,2}⠋ · /, lines.at(-2));
  assert.doesNotMatch(lines.at(-2), /running/, "normal running work is glyph-only");
  assert.match(
    lines.at(-2),
    /turn 1s/,
    "the current-turn clock rides the dock, floored to whole seconds",
  );
  // A settled Run keeps its status glyph but has no current turn to time.
  h.current.status = "completed";
  h.current.execution_exited = true;
  h.current.turn_elapsed_ms = undefined;
  const settled = h.paint();
  assert.match(settled.at(-2), /✓ · /, settled.at(-2));
  assert.doesNotMatch(settled.at(-2), /completed/, "completed is glyph-only too");
  assert.doesNotMatch(settled.at(-2), /turn \d/, settled.at(-2));
});

test("Info opens from I with a page-local back link on the first body row", (t) => {
  for (const frame of [false, true]) {
    const h = paneFixture(t, { frame });
    h.paint();
    h.pane.handleInput("i");
    const info = h.paint();
    assert.match(info[1], /← Transcript/, `frame=${frame}: the back link leads the page`);
    assert.ok(
      info.some((line) => line.includes("routing")),
      "the fields page is shown",
    );
    assert.ok(!info.some((line) => /ROW\d+/.test(line)), "the transcript is replaced");
    // It is a real control, not decoration.
    assert.deepEqual(h.click("← Transcript", info), { handled: true });
    assert.ok(
      h.paint().some((line) => /ROW\d+/.test(line)),
      "the link restores the transcript",
    );
    // I and Esc keep working without the link.
    h.pane.handleInput("i");
    h.paint();
    h.pane.handleInput("\x1b");
    assert.ok(h.paint().some((line) => /ROW\d+/.test(line)));
    assert.equal(h.pane.isOpen(), true, "Esc leaves the page before the pane");
  }
});

test("short panes drop the back link before I and Esc stop working", (t) => {
  const h = paneFixture(t, { frame: true, rows: 9 });
  h.paint();
  h.pane.handleInput("i");
  const info = h.paint();
  assert.ok(!info.some((line) => line.includes("← Transcript")), "no row is available for it");
  assert.ok(
    info.some((line) => /task\s+Dock fixture/.test(line)),
    "the fields page is still shown",
  );
  h.pane.handleInput("\x1b");
  assert.ok(
    h.paint().some((line) => /ROW\d+/.test(line)),
    "Esc still returns to the transcript",
  );
  h.pane.handleInput("i");
  h.paint();
  h.pane.handleInput("i");
  assert.ok(
    h.paint().some((line) => /ROW\d+/.test(line)),
    "I still toggles the page",
  );
});

test("the footer offers the actions menu only outside a draft or confirmation", (t) => {
  const h = paneFixture(t, { onStop() {} });
  const lines = h.paint();
  assert.ok(lines.at(-1).includes(". more"), lines.at(-1));
  assert.ok(lines.at(-1).indexOf(". more") < lines.at(-1).indexOf("message"));
  assert.match(lines.at(-1), /stop(?: ─╯)?$/, "Stop stays rightmost");
  // A draft owns the keyboard: no menu control, and `.` is draft text.
  h.pane.handleInput("m");
  h.pane.handleInput("a.b");
  assert.ok(!h.paint().at(-1).includes(". more"), "composing drops the menu control");
  assert.match(h.paint().at(-2), /› a\.b/, "the dot is text while composing");
  h.pane.handleInput("\x1b");
  // An armed Stop owns the whole row.
  h.paint();
  h.pane.handleInput("s");
  assert.ok(!h.paint().at(-1).includes(". more"), "confirmation drops the menu control");
  h.pane.handleInput("\x1b");
  assert.ok(h.paint().at(-1).includes(". more"));
});

test("the actions menu overlays the bottom viewport without height or scroll change", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput("\x1b[5~"); // scroll away from the tail
  const before = h.paint();
  h.pane.handleInput(".");
  const opened = h.paint();
  assert.equal(opened.length, before.length, "the menu costs no height");
  assert.notDeepEqual(opened, before, "the menu is painted over the viewport");
  assert.equal(opened[0], before[0], "the title does not move");
  assert.deepEqual(opened.at(-2), before.at(-2), "the summary dock does not move");
  assert.deepEqual(opened.at(-1), before.at(-1), "the footer does not move");
  h.pane.handleInput("\x1b");
  assert.deepEqual(h.paint(), before, "Esc closes the menu and restores the same window");
  assert.equal(h.pane.isOpen(), true, "closing the menu never closes the pane");
});

test("the . more control opens the same menu as the . key", (t) => {
  const h = paneFixture(t);
  const before = h.paint();
  assert.deepEqual(h.click(". more", before), { handled: true });
  const opened = h.paint();
  assert.notDeepEqual(opened, before);
  assert.equal(opened.length, before.length);
  // The control stays painted and closes it again.
  assert.deepEqual(h.click(". more", opened), { handled: true });
  assert.deepEqual(h.paint(), before);
});

test("the separator and dock keep the frame inset", (t) => {
  const h = paneFixture(t, { frame: true });
  const lines = h.paint();
  assert.match(lines.at(-3), /^│ ─+ │$/, lines.at(-3));
  assert.match(lines.at(-2), /^│ \S/, lines.at(-2));
  // The dock is padded to the frame's inner width, so the right border closes it.
  assert.equal(visibleWidth(lines.at(-2)), 120);
  assert.match(lines.at(-2), /│$/, lines.at(-2));
});

test("arming Stop changes only the final row, never the dock or the window", (t) => {
  for (const frame of [false, true]) {
    const h = paneFixture(t, { frame, onStop() {} });
    const before = h.paint();
    h.pane.handleInput("s");
    const armed = h.paint();
    assert.equal(armed.length, before.length, `frame=${frame}: arming does not resize the pane`);
    assert.deepEqual(
      armed.slice(0, -1),
      before.slice(0, -1),
      `frame=${frame}: only the edge changes`,
    );
    assert.match(armed.at(-1), /confirm stop/);
    assert.doesNotMatch(armed.at(-1), /\. more|message/);
  }
});

test("the dock keeps its rows across pages and tool expansion", (t) => {
  const h = paneFixture(t);
  const transcript = h.paint();
  const dock = (lines) => lines.slice(-2);
  h.pane.handleInput("t");
  assert.equal(h.paint().length, transcript.length, "tools expansion reuses the same rows");
  assert.deepEqual(dock(h.paint()), dock(transcript), "the dock does not move");
  h.pane.handleInput("i");
  // A short Info page is content-sized, but its dock rows are the same ones.
  assert.deepEqual(dock(h.paint()), dock(transcript), "Info keeps the same dock");
  h.pane.handleInput("i");
  assert.equal(h.paint().length, transcript.length, "returning to Transcript restores the rows");
});

test("hidden notes with no notice row still reach the footer cue", (t) => {
  // Nine docked rows leave room for the separator and dock, but no notice row.
  const h = paneFixture(t, {
    rows: 9,
    current: view({ cleanup_errors: ["first fault", "second fault"] }),
  });
  const lines = h.paint();
  assert.match(lines.at(-1), /!2/, lines.at(-1));
  assert.ok(!lines.some((line) => line.includes("first fault")), "no notice row was painted");
  h.pane.handleInput("i");
  h.paint(); // lay the page out before its own scroll keys have geometry
  h.pane.handleInput("\x1b[F");
  assert.ok(
    h.paint().some((line) => line.includes("first fault")),
    "Info lists them",
  );
});
