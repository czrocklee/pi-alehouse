import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Isolate SDK initialization before importing either the SDK or the pane.
const directory = mkdtempSync(join(tmpdir(), "alehouse-detail-toolbar-"));
const environment = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
  "TMPDIR",
];
const previous = new Map(environment.map((key) => [key, process.env[key]]));
for (const key of environment) {
  process.env[key] = join(directory, key);
  mkdirSync(process.env[key]);
}
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});
const require = createRequire(import.meta.url);
assert.equal(require("@earendil-works/pi-tui/package.json").version, "1.5.2");
const { createJiti } = await import("jiti");
const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");

// Direct source import: this regression must not depend on a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailSummary, renderDetailToolbar } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");

const plain = { fg: (_color, text) => text, bold: (text) => text };
const ansi = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
/** Records every color a paint asks for, while keeping the text itself plain. */
const recorder = () => {
  const calls = [];
  return { calls, theme: { fg: (color, text) => (calls.push(color), text), bold: (t) => t } };
};

const toolbar = (overrides = {}) =>
  renderDetailToolbar({
    metrics: "x".repeat(20),
    theme: plain,
    width: 120,
    info: false,
    toolsExpanded: false,
    keys: true,
    ...overrides,
  });
// The complete right group, in cells: Transcript, dot, Info, gap, Tools + state.
const CONTROLS = (() => {
  const wide = toolbar({ width: 300 });
  assert.ok(wide);
  return 300 - wide.items[0].from;
})();
// Two spaces, the bar itself, two more spaces.
const SEPARATOR = 5;

test("helper: whole metrics and the complete control group merge when both fit", () => {
  const out = toolbar();
  assert.ok(out);
  assert.equal(visibleWidth(out.text), 120);
  assert.ok(out.text.startsWith("x".repeat(20)), "the metrics lead the row, untrimmed");
  assert.match(out.text, /Transcript · Info {3}Tools collapsed$/);
  assert.equal(out.items.at(-1).to, 120, "the group ends flush at the right edge");
});

test("helper: the equal boundary fits and one cell short declines", () => {
  const boundary = 20 + CONTROLS + SEPARATOR;
  const at = toolbar({ width: boundary });
  assert.ok(at, `${boundary} cells hold metrics, controls and separator exactly`);
  assert.equal(visibleWidth(at.text), boundary);
  assert.equal(at.text.indexOf("│"), 22, "only the separator's two spaces precede the bar");
  assert.equal(toolbar({ width: boundary - 1 }), undefined, "one cell short falls back");
  assert.equal(toolbar({ width: 0 }), undefined);
  assert.equal(toolbar({ width: 59.5 }), undefined);
  assert.equal(toolbar({ width: Number.NaN }), undefined);
});

test("helper: the separator is an isolated borderMuted bar before the group", () => {
  const { calls, theme } = recorder();
  const out = toolbar({ theme });
  assert.ok(out);
  const bar = out.text.indexOf("│");
  assert.ok(bar >= 0);
  assert.equal(out.text.split("│").length - 1, 1, "exactly one bar");
  assert.equal(out.text.slice(bar + 1, bar + 3), "  ", "exactly two spaces after the bar");
  assert.ok(out.text.slice(0, bar).endsWith("  "), "at least two spaces before it");
  assert.ok(calls.includes("borderMuted"));
  assert.equal(out.items[0].from, bar + 3, "the controls begin right after the bar");
});

test("helper: all three controls carry visible cell ranges", () => {
  const out = toolbar();
  assert.deepEqual(
    out.items.map((item) => item.kind),
    ["transcript", "info", "tools"],
  );
  let end = 0;
  for (const item of out.items) {
    assert.ok(item.from >= end, "ranges are ordered and never overlap");
    assert.ok(item.to > item.from, "every control is visible");
    assert.ok(item.to <= 120, "ranges stay inside the row");
    end = item.to;
  }
});

test("helper: the Info page keeps both pages and hides Tools", () => {
  const out = toolbar({ info: true });
  assert.ok(out);
  assert.deepEqual(
    out.items.map((item) => item.kind),
    ["transcript", "info"],
  );
  assert.ok(!out.text.includes("Tools"));
  assert.ok(!out.text.includes("collapsed"));
});

test("helper: a draft owns the keyboard, so the key accents go", () => {
  const keyed = recorder();
  assert.ok(toolbar({ theme: keyed.theme }));
  assert.equal(
    keyed.calls.filter((color) => color === "accent").length,
    2,
    "I on Info and T on Tools, never the T of Transcript",
  );
  const drafting = recorder();
  assert.ok(toolbar({ theme: drafting.theme, keys: false }));
  assert.equal(drafting.calls.filter((color) => color === "accent").length, 0);
});

test("helper: hidden notes keep their count on the Info control", () => {
  const out = toolbar({ hiddenNotes: 3 });
  assert.ok(out.text.includes("Info +3"));
  const info = out.items.find((item) => item.kind === "info");
  assert.equal(info.to - info.from, 7, '"Info" plus " +3" is one control');
  assert.ok(!toolbar().text.includes("+"));
  assert.ok(!toolbar({ hiddenNotes: 0 }).text.includes("+"));
  // The count widens the group, so the merge boundary moves with it.
  const boundary = 20 + CONTROLS + 3 + SEPARATOR;
  assert.ok(toolbar({ hiddenNotes: 3, width: boundary }));
  assert.equal(toolbar({ hiddenNotes: 3, width: boundary - 1 }), undefined);
});

test("helper: the divider is a plain full-width rule with no text", () => {
  const out = toolbar();
  const bare = stripTerminalSequences(out.divider);
  assert.equal(bare, "─".repeat(120));
  assert.ok(!/[^\u2500]/.test(bare), "no label rides the divider");
});

test("helper: ANSI, CJK and emoji metrics are measured in cells", () => {
  const metrics = ansi.fg("dim", "測試中".repeat(4) + "🛠️ ok");
  const cells = visibleWidth(metrics);
  const boundary = cells + CONTROLS + SEPARATOR;
  const styled = toolbar({ metrics, theme: ansi, width: boundary });
  assert.ok(styled, `${cells} cells fit exactly where an equally wide plain row fits`);
  assert.equal(visibleWidth(styled.text), boundary, "nothing overflows");
  assert.ok(styled.text.startsWith(metrics), "wide graphemes are never trimmed for buttons");
  assert.equal(toolbar({ metrics, theme: ansi, width: boundary - 1 }), undefined);
  const bare = stripTerminalSequences(styled.text);
  assert.ok(bare.includes("測試中".repeat(4)) && bare.includes("🛠️"));
});

// Review04: page and tool state must never change the merged group's allocation.
const controlStates = [
  { info: false, toolsExpanded: false },
  { info: false, toolsExpanded: true },
  { info: true, toolsExpanded: false },
  { info: true, toolsExpanded: true },
];

test("helper regression: every page/tool state reserves the longest exact-fit group", () => {
  const boundary = 20 + CONTROLS + SEPARATOR;
  for (const state of controlStates) {
    const label = JSON.stringify(state);
    assert.equal(toolbar({ ...state, width: boundary - 1 }), undefined, label);
    const at = toolbar({ ...state, width: boundary });
    assert.ok(at, label);
    assert.equal(visibleWidth(at.text), boundary, label);
    assert.equal(at.text.indexOf("│"), 22, label);
  }
});

test("helper regression: all four page/tool states keep page ranges and separator fixed", () => {
  const reference = toolbar({ hiddenNotes: 3 });
  const pages = reference.items.filter((item) => item.kind !== "tools");
  for (const state of controlStates) {
    const out = toolbar({ ...state, hiddenNotes: 3 });
    assert.ok(out);
    assert.equal(visibleWidth(out.text), 120);
    assert.equal(out.text.indexOf("│"), reference.text.indexOf("│"));
    assert.deepEqual(
      out.items.filter((item) => item.kind !== "tools"),
      pages,
    );
    assert.equal(out.divider, reference.divider);
  }
});

test("helper regression: Info reserves an inert Tools slot without its key accent", () => {
  const reference = toolbar();
  const info = reference.items.find((item) => item.kind === "info");
  const tools = reference.items.find((item) => item.kind === "tools");
  for (const toolsExpanded of [false, true]) {
    const { calls, theme } = recorder();
    const out = toolbar({ info: true, toolsExpanded, theme });
    assert.ok(out);
    assert.deepEqual(
      out.items,
      reference.items.filter((item) => item.kind !== "tools"),
    );
    assert.equal(out.text.slice(info.to), " ".repeat(120 - info.to));
    assert.equal(calls.filter((color) => color === "accent").length, 1, "only I is accented");
    for (let x = tools.from; x < tools.to; x++)
      assert.ok(!out.items.some((item) => x >= item.from && x < item.to), `inert slot ${x}`);
  }
});

test("helper regression: expanded keeps a trailing blank cell outside every hit range", () => {
  const collapsed = toolbar();
  const expanded = toolbar({ toolsExpanded: true });
  const before = collapsed.items.find((item) => item.kind === "tools");
  const after = expanded.items.find((item) => item.kind === "tools");
  assert.equal(after.from, before.from);
  assert.equal(after.to - after.from, "Tools expanded".length);
  assert.equal(after.to, before.to - 1);
  assert.ok(expanded.text.endsWith("Tools expanded "));
  assert.ok(!expanded.items.some((item) => before.to - 1 >= item.from && before.to - 1 < item.to));
});

// ---- Pane geometry ----

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
  description: "Toolbar fixture",
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
/** The pane's own content width for a pane width, frame side and gutter included. */
const contentWidth = (width, frame) => {
  const inner = frame ? width - 2 : width;
  const gutter = frame ? (inner >= 72 ? 2 : 1) : 0;
  return inner - gutter * 2;
};

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
    theme: plain,
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
    renderDetailSummary({ view: current, live: generation }, plain, contentWidth(w, frame), {
      activity: true,
    })[0];
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
    metricsRow,
  };
}

test("wide docked pane: the controls ride the metrics row and click through", (t) => {
  const h = paneFixture(t);
  const metrics = h.metricsRow();
  assert.ok(
    renderDetailToolbar({
      metrics,
      theme: plain,
      width: 120,
      info: false,
      toolsExpanded: false,
      keys: true,
    }),
    "the fixture width merges the row",
  );
  const lines = h.paint();
  assert.equal(h.locate("Transcript · Info", lines).y, 1, "the toolbar row sits under the title");
  assert.ok(lines[1].startsWith(metrics), "the whole metrics row is kept");
  assert.deepEqual(h.click("Info", lines), { handled: true });
  const info = h.paint();
  assert.ok(
    info.some((line) => line.includes("routing")),
    "Info opens the fields page",
  );
  assert.ok(!info.some((line) => /ROW\d+/.test(line)));
  assert.ok(!info[1].includes("Tools"), "the Info page hides the tools control");
  assert.deepEqual(h.click("Transcript", info), { handled: true });
  assert.ok(
    h.paint().some((line) => /ROW\d+/.test(line)),
    "Transcript restores the body",
  );
  assert.deepEqual(h.click("Tools", h.paint()), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
  assert.deepEqual(h.click("Tools", h.paint()), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), false, "activation is per click");
});

test("the plain divider row carries no hits", (t) => {
  const h = paneFixture(t);
  const lines = h.paint();
  const y = lines.findIndex((line) => /^─+$/.test(line));
  // Toolbar row, live activity row, divider: the last fixed row.
  assert.equal(y, 3, "the plain divider is the last fixed row");
  assert.match(lines[y + 1], /^ROW\d+$/, "the transcript window follows it");
  for (const x of [0, 3, 60, 119]) {
    assert.equal(
      h.pane.handleMouse({ type: "press", button: "left", x, y }),
      undefined,
      `press at ${x}`,
    );
    assert.equal(
      h.pane.handleMouse({ type: "click", button: "left", x, y, clickCount: 1 }),
      undefined,
      `click at ${x}`,
    );
  }
  assert.equal(h.modes.at(-1), false, "the old rule's controls never toggle from the divider");
  assert.ok(!h.paint().some((line) => line.includes("routing")), "Info never opened");
});

test("framed pane: the controls sit past the frame side and gutter on row 1", (t) => {
  const h = paneFixture(t, { frame: true });
  const metrics = h.metricsRow();
  assert.ok(
    renderDetailToolbar({
      metrics,
      theme: plain,
      width: 114,
      info: false,
      toolsExpanded: false,
      keys: true,
    }),
    "the framed fixture width merges the row",
  );
  const lines = h.paint();
  assert.equal(h.locate("Transcript · Info", lines).y, 1);
  assert.ok(lines[1].startsWith("│  "), "the frame side and gutter precede the row");
  assert.deepEqual(h.click("Tools", lines), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
  assert.deepEqual(h.click("Info", h.paint()), { handled: true });
  assert.ok(h.paint().some((line) => line.includes("routing")));
  assert.ok(
    lines.some((line) => /^│ {2}─+ {2}│$/.test(line)),
    "a plain divider runs between the frame sides",
  );
});

test("live activity and pinned notes keep the controls on the metrics row", (t) => {
  const h = paneFixture(t, {
    generation: live({
      active_tools: [{ name: "bash", detail: "npm test" }],
      tool_uses: 3,
      preview: "streaming reply",
    }),
    current: view({ cleanup_errors: ["first fault", "second fault"] }),
  });
  const lines = h.paint();
  assert.equal(h.locate("Transcript · Info", lines).y, 1);
  assert.ok(lines[2].includes("npm test"), "the activity row follows the toolbar row");
  assert.ok(lines[3].includes("first fault"), "the pinned notes follow the activity row");
  assert.deepEqual(h.click("Tools", lines), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
  assert.deepEqual(h.click("Info", h.paint()), { handled: true });
  assert.ok(h.paint().some((line) => line.includes("routing")));
});

for (const frame of [false, true])
  test(`a narrow pane falls back to the whole metrics row and the labeled rule (frame=${frame})`, (t) => {
    const h = paneFixture(t, { frame, width: 60 });
    const metrics = h.metricsRow();
    assert.equal(
      renderDetailToolbar({
        metrics,
        theme: plain,
        width: contentWidth(60, frame),
        info: false,
        toolsExpanded: false,
        keys: true,
      }),
      undefined,
      "the fixture width cannot hold whole metrics and controls together",
    );
    const lines = h.paint();
    const rule = lines.findIndex((line) => line.includes("Transcript · Info"));
    assert.ok(rule >= 2, "the labeled rule is the last fixed row");
    assert.match(lines[rule], /Tools collapsed/);
    assert.equal(
      lines.findIndex((line) => line.includes(metrics)),
      1,
      "the metrics row stands",
    );
    assert.ok(!lines[1].includes("Transcript"), "no controls ride the metrics row");
    assert.deepEqual(h.click("Tools", lines), { handled: true });
    h.paint();
    assert.equal(h.modes.at(-1), true);
    // The fallback costs no extra height: same fixed-row count as the merged row.
    const merged = paneFixture(t, { frame, width: 120 });
    assert.equal(h.paint().length, merged.paint().length, "no row is added or removed");
    assert.deepEqual(h.click("Info", h.paint()), { handled: true });
    assert.ok(h.paint().some((line) => line.includes("routing")));
  });

test("presses claim without activating, and stale geometry voids toolbar hits", (t) => {
  const h = paneFixture(t);
  const tools = h.locate("Tools", h.paint());
  assert.deepEqual(h.pane.handleMouse({ type: "press", button: "left", x: tools.x, y: tools.y }), {
    handled: true,
  });
  assert.equal(h.modes.at(-1), false, "a press alone never toggles");
  assert.deepEqual(
    h.pane.handleMouse({ type: "click", button: "left", x: tools.x, y: tools.y, clickCount: 1 }),
    { handled: true },
  );
  h.paint();
  assert.equal(h.modes.at(-1), true);
  h.terminal.columns = 100; // Resize without an intervening repaint.
  assert.equal(
    h.pane.handleMouse({ type: "click", button: "left", x: tools.x, y: tools.y, clickCount: 1 }),
    undefined,
    "the old paint's hit is void after a resize",
  );
  assert.equal(h.modes.at(-1), true, "a stale click never toggles");
  const fresh = h.paint(100);
  const moved = h.locate("Tools", fresh);
  assert.deepEqual(
    h.pane.handleMouse({ type: "click", button: "left", x: moved.x, y: moved.y, clickCount: 1 }),
    { handled: true },
  );
  h.paint();
  assert.equal(h.modes.at(-1), false, "a fresh paint restores the control");
});

test("a draft owns the keyboard, but the controls stay clickable", (t) => {
  const h = paneFixture(t);
  h.paint();
  h.pane.handleInput("m");
  h.pane.handleInput("hello draft");
  const composing = h.paint();
  assert.ok(composing.at(-2).includes("hello draft"));
  assert.equal(h.locate("Transcript · Info", composing).y, 1);
  assert.deepEqual(h.click("Tools", composing), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true, "clicks toggle while the keys are text");
  assert.ok(h.paint().at(-2).includes("hello draft"), "the draft is retained");
});

test("a fixed width migrates between merged and fallback as the metrics grow", (t) => {
  // 69 cells hold the short model's whole metrics (29), longest reserved
  // control group (35) and separator (5) exactly, even with Tools expanded.
  // A longer model name must fall back rather than trimming a metric.
  const model = { ...settings, model: "controlled-xyz" };
  const h = paneFixture(t, { width: 69, current: view({ effective_settings: model }) });
  const fallback = h.paint();
  const ruleTools = h.locate("Tools", fallback);
  assert.equal(ruleTools.y, 3, "fallback: the labeled rule is the last fixed row");
  assert.ok(!fallback[1].includes("Transcript"), "fallback: no controls ride the metrics row");
  assert.deepEqual(h.click("Tools", fallback), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
  model.model = "controlled"; // Same pane width: only the metrics shrank.
  const merged = h.paint();
  const toolbarTools = h.locate("Tools", merged);
  assert.equal(toolbarTools.y, 1, "merged: the controls ride the metrics row");
  assert.match(merged[3], /^─+$/, "merged: a plain divider is the last fixed row");
  // The fresh paint's old rule-row coordinates are divider now: no ghost hit.
  assert.equal(
    h.pane.handleMouse({
      type: "click",
      button: "left",
      x: ruleTools.x,
      y: ruleTools.y,
      clickCount: 1,
    }),
    undefined,
  );
  assert.equal(h.modes.at(-1), true, "a click on the divider never toggles");
  assert.deepEqual(h.click("Tools", merged), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), false);
  model.model = "controlled-xyz"; // And back: the metrics row is bare again.
  const narrow = h.paint();
  const ruleAgain = h.locate("Tools", narrow);
  assert.equal(ruleAgain.y, 3, "fallback returns at the same pane width");
  assert.equal(
    h.pane.handleMouse({
      type: "click",
      button: "left",
      x: toolbarTools.x,
      y: toolbarTools.y,
      clickCount: 1,
    }),
    undefined,
    "the old toolbar-row coordinates are the bare metrics row now",
  );
  assert.equal(h.modes.at(-1), false, "a click on the metrics row never toggles");
  assert.deepEqual(h.click("Tools", narrow), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
});

test("settlement drops the activity row, and the rule's old row never keeps its hits", (t) => {
  const h = paneFixture(t, { width: 60 });
  const running = h.paint();
  const rule = h.locate("Transcript · Info", running);
  assert.equal(rule.y, 3, "a live run's activity row precedes the labeled rule");
  assert.deepEqual(h.click("Tools", running), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), true);
  h.current.status = "completed"; // Settlement: the activity row disappears.
  h.current.execution_exited = true;
  const settled = h.paint();
  const moved = h.locate("Transcript · Info", settled);
  assert.equal(moved.y, 2, "the rule moves up over the settled run");
  assert.equal(
    h.pane.handleMouse({ type: "click", button: "left", x: rule.x, y: rule.y, clickCount: 1 }),
    undefined,
    "the old rule row is a transcript row now",
  );
  assert.equal(h.modes.at(-1), true, "a click on the transcript never toggles");
  assert.deepEqual(h.click("Tools", settled), { handled: true });
  h.paint();
  assert.equal(h.modes.at(-1), false);
});

test("a busy agent raises no warning and keeps the toolbar clickable", (t) => {
  const h = paneFixture(t, { current: view({ unavailable_reason: "agent_busy" }) });
  const lines = h.paint();
  assert.ok(
    !lines.some((line) => line.includes("agent_busy")),
    "reuse availability is not a session fault",
  );
  assert.equal(h.locate("Transcript · Info", lines).y, 1);
  assert.deepEqual(h.click("Info", lines), { handled: true });
  assert.ok(h.paint().some((line) => line.includes("routing")));
});

for (const frame of [false, true])
  test(`pane regression: Info Transcript double-click cannot become Tools (frame=${frame})`, (t) => {
    const h = paneFixture(t, { frame, width: 120 });
    h.click("Info", h.paint());
    const point = h.locate("Transcript", h.paint());
    point.x += 5; // The sixth cell: this overlapped Tools after the first repaint.
    assert.deepEqual(h.clickAt(point, 1), { handled: true });
    const between = h.paint();
    assert.ok(
      between.some((line) => /ROW\d+/.test(line)),
      "first click opens Transcript",
    );
    h.clickAt(point, 2); // SDK counts by component/position, not the repainted label.
    h.paint();
    assert.equal(h.modes.at(-1), false, "second click must not expand Tools");
    assert.equal(h.locate("Transcript", between).y, 1);
  });

test("fallback control: page double-click is inert and repeated Tools clicks still toggle", (t) => {
  const h = paneFixture(t, { width: 45 });
  h.click("Info", h.paint());
  const point = h.locate("Transcript", h.paint());
  point.x += 5;
  h.clickAt(point, 1);
  h.paint();
  h.clickAt(point, 2);
  h.paint();
  assert.equal(h.modes.at(-1), false);
  const tools = h.locate("Tools", h.paint());
  assert.equal(tools.y, 3);
  tools.x += 4; // A cell shared by both right-aligned state labels.
  for (const [clickCount, expanded] of [
    [1, true],
    [2, false],
    [3, true],
  ]) {
    assert.deepEqual(h.clickAt(tools, clickCount), { handled: true });
    h.paint();
    assert.equal(h.modes.at(-1), expanded, `clickCount=${clickCount} still activates Tools`);
  }
});

test("pane regression: 68 columns stay fallback when Tools expands or Info opens", (t) => {
  const h = paneFixture(t, { width: 68 });
  const collapsed = h.paint();
  const pages = h.locate("Transcript · Info", collapsed);
  assert.equal(h.locate("Tools", collapsed).y, 3);
  h.click("Tools", collapsed);
  const expanded = h.paint();
  assert.equal(h.modes.at(-1), true);
  assert.equal(h.locate("Tools", expanded).y, 3, "one shorter state cannot move to metrics");
  assert.deepEqual(h.locate("Transcript · Info", expanded), pages);
  h.click("Info", expanded);
  const info = h.paint();
  assert.deepEqual(h.locate("Transcript · Info", info), pages);
  h.click("Transcript", info);
  assert.equal(h.locate("Tools", h.paint()).y, 3);
});

test("pane regression: 60 columns keep both pages on the fallback rule in all four states", (t) => {
  const h = paneFixture(t, { width: 60 });
  const pages = h.locate("Transcript · Info", h.paint());
  assert.equal(pages.y, 3);
  for (const expanded of [false, true]) {
    if (expanded) h.click("Tools", h.paint());
    const transcript = h.paint();
    assert.equal(h.modes.at(-1), expanded);
    assert.deepEqual(h.locate("Transcript · Info", transcript), pages);
    h.click("Info", transcript);
    const info = h.paint();
    assert.deepEqual(h.locate("Transcript · Info", info), pages);
    assert.ok(!info[1].includes("Transcript"), "Info cannot opportunistically merge");
    assert.ok(info.some((line) => line.includes("routing")));
    h.click("Transcript", info);
    assert.deepEqual(h.locate("Transcript · Info", h.paint()), pages);
  }
});

test("pane regression: wide page positions are stable and reserved blanks have no hits", (t) => {
  const h = paneFixture(t);
  const initial = h.paint();
  const pages = h.locate("Transcript · Info", initial);
  const tools = h.locate("Tools", initial);
  assert.equal(pages.y, 1);
  for (const expanded of [false, true]) {
    if (expanded) h.click("Tools", h.paint());
    const transcript = h.paint();
    assert.deepEqual(h.locate("Transcript · Info", transcript), pages);
    assert.deepEqual(h.locate("Tools", transcript), tools);
    if (expanded) {
      const padding = { x: tools.x + "Tools expanded".length, y: tools.y };
      assert.equal(transcript[padding.y][padding.x], " ");
      assert.equal(h.clickAt(padding), undefined, "expanded tail padding is not a hit");
    }
    h.click("Info", transcript);
    const info = h.paint();
    assert.deepEqual(h.locate("Transcript · Info", info), pages);
    for (let x = tools.x; x < tools.x + "Tools collapsed".length; x++) {
      assert.equal(info[tools.y][x], " ", `Info reserves blank cell ${x}`);
      assert.equal(h.clickAt({ x, y: tools.y }), undefined, `Info slot ${x} has no action`);
    }
    h.paint();
    assert.equal(h.modes.at(-1), expanded, "blank slot cannot change hidden Tools state");
    h.click("Transcript", h.paint());
    assert.deepEqual(h.locate("Transcript · Info", h.paint()), pages);
    assert.equal(h.modes.at(-1), expanded, "page roundtrip preserves Tools state");
  }
});

test("toolbar controls preserve draft text and deliberate Stop confirmation semantics", (t) => {
  const stopped = [];
  const h = paneFixture(t, { onStop: (run) => stopped.push(run) });
  h.paint();
  h.pane.handleInput("m");
  h.pane.handleInput("keep toolbar draft");
  h.click("Info", h.paint());
  h.click("Transcript", h.paint());
  h.click("Tools", h.paint());
  assert.ok(h.paint().at(-2).includes("keep toolbar draft"));
  h.click("[Stop]", h.paint());
  const armed = h.paint();
  assert.ok(armed.at(-1).includes("[Confirm stop]"));
  assert.ok(armed.at(-2).includes("keep toolbar draft"));
  const confirm = h.locate("[Confirm stop]", armed);
  h.clickAt(confirm, 2);
  h.paint();
  h.clickAt(confirm, 3);
  h.paint();
  assert.deepEqual(stopped, [], "rapid second and third clicks never confirm Stop");
  h.pane.handleInput("\x1b");
  assert.ok(h.paint().at(-2).includes("keep toolbar draft"), "Esc only cancels Stop intent");
  h.click("[Stop]", h.paint());
  h.paint();
  h.pane.handleInput("\x13");
  assert.deepEqual(stopped, ["run-amber"]);
  assert.deepEqual(h.sent, [], "Stop never sends the draft");
  assert.ok(h.paint().at(-2).includes("keep toolbar draft"));
});
