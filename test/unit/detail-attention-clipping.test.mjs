import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// The footer suppresses its `!N` cue while the selected tab's own `?`/`!`
// marker is painted. These regressions hold that contract at the extremes:
// a tab too narrow to carry its marker must never silently erase the only
// warning on a short pane. Direct source via Jiti, no build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { renderDetailAgentStrip, renderDetailAttention, renderDetailFooter } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);

const theme = { fg: (_color, text) => text, bold: (text) => text };
const view = (id, extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: id,
  run_id: `run-${id}`,
  name: id,
  task: 1,
  description: "Current task",
  status: "completed",
  phase: "settled",
  execution_exited: true,
  finalization_pending: false,
  resident: true,
  resumable: false,
  pending_messages: 0,
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  effective_settings: {
    profile: "editor",
    model: "model",
    thinking: "high",
    parent_thinking: "high",
    thinking_resolution: "identity",
    preset: "default",
    preset_version: "v1",
    strength: "d3",
    difficulty: 3,
    tools: ["read"],
    cwd: "/workspace",
    context_mode: "none",
  },
  ...extra,
});
const live = { active_tools: [], tool_uses: 0, preview: "" };
const entry = (v) => ({ agent_id: v.agent_id, input: { view: v, live } });
const transcript = () => ({
  lineCount: () => 3,
  slice: (_width, from, take) =>
    Array.from({ length: Math.max(0, Math.min(take, 3 - from)) }, (_v, i) => `ROW${from + i}`),
  invalidate() {},
});

/** A complete pane at the given geometry; `entries` are shared by reference. */
function pane(t, { width, rows = 6, frame = true, entries, chosen, onStop }) {
  const p = new DetailPane({
    tui: { terminal: { columns: width, rows }, requestRender() {} },
    theme,
    frame,
    snapshot: () => entries,
    transcript,
    initial: chosen,
    done() {},
    ...(onStop ? { onStop } : {}),
  });
  t.after(() => p.dispose());
  return p;
}
const plain = (p, width) => p.render(width).map(stripTerminalSequences);

test("a clipped selected tab keeps its warning on the shortest framed pane", (t) => {
  const entries = [
    entry(view("aspen", { history_error: "history unavailable" })),
    entry(view("cedar")),
  ];
  const p = pane(t, { width: 20, entries, chosen: "aspen" });
  const painted = plain(p, 20);
  assert(
    painted.every((line) => visibleWidth(line) <= 20),
    painted.join("\n"),
  );
  const edge = painted.at(-1);
  // The warning rides the clipped tab itself, beside the real lifecycle glyph.
  // The footer's own controls share the row, so the nickname may be fully
  // ellipsized: the marker and the lifecycle glyph are what must survive.
  assert.match(edge, /✓/, edge);
  assert.match(edge, /!/, "the warning marker survives the narrower tab");
  assert.doesNotMatch(edge, /✗/, "a warning is not turned into a failure");
  assert.doesNotMatch(edge, /!\d/, "the marker it carries suppresses the !N cue");
});

test("a clipped selected tab keeps its warning on the shortest docked pane", (t) => {
  const entries = [
    entry(view("aspen", { history_error: "history unavailable" })),
    entry(view("cedar")),
  ];
  const p = pane(t, { width: 20, rows: 8, frame: false, entries, chosen: "aspen" });
  const edge = plain(p, 20).at(-1);
  assert.match(edge, /✓ .*!/, edge);
  assert(visibleWidth(edge) <= 20, edge);
});

test("twelve warned peers cannot clip the selected tab's warning away", (t) => {
  const ids = [
    ...Array.from({ length: 5 }, (_v, i) => `peer${i}`),
    "current-reviewer",
    ...Array.from({ length: 6 }, (_v, i) => `other${i}`),
  ];
  const entries = ids.map((id) => entry(view(id, { history_error: "history unavailable" })));
  const p = pane(t, { width: 40, entries, chosen: "current-reviewer" });
  const painted = plain(p, 40);
  assert(
    painted.every((line) => visibleWidth(line) <= 40),
    painted.join("\n"),
  );
  assert.match(painted.at(-1), /✓ current-reviewer !/, painted.at(-1));
});

test("arming Stop never erases every warning beside its whole confirmation", (t) => {
  const entries = ["aspen", "cedar"].map((id) =>
    entry(
      view(id, {
        history_error: "history unavailable",
        status: "running",
        phase: "executing",
        execution_exited: false,
      }),
    ),
  );
  const p = pane(t, { width: 61, entries, chosen: "aspen", onStop() {} });
  const before = plain(p, 61).at(-1);
  assert.match(before, /⠋ aspen ! {2}⠋ cedar !/, before);
  p.handleInput("s");
  const painted = plain(p, 61);
  assert(
    painted.every((line) => visibleWidth(line) <= 61),
    painted.join("\n"),
  );
  const edge = painted.at(-1);
  // The selected tab keeps its own marker beside the whole confirmation, so
  // the footer's `!N` cue would only repeat it.
  assert.match(edge, /╰── ⠋ ! ─/, edge);
  assert.match(edge, /⠋/, "the real lifecycle glyph stays");
  assert.doesNotMatch(edge, /!1/, "the painted marker suppresses the cue");
  assert.match(edge, /best-effort · Ctrl\+S · Esc cancel · confirm stop/, edge);
  assert.ok(
    edge.includes("best-effort · Ctrl+S · Esc cancel · confirm stop"),
    "the confirmation stays complete",
  );
});

test("a non-ASCII nickname cannot clip the warning away", (t) => {
  const entries = [
    entry(view("审查员配置", { history_error: "history unavailable" })),
    entry(view("cedar")),
  ];
  const p = pane(t, { width: 24, entries, chosen: "审查员配置" });
  const painted = plain(p, 24);
  assert(
    painted.every((line) => visibleWidth(line) <= 24),
    painted.join("\n"),
  );
  // The footer's own controls share the row, so the nickname may be
  // ellipsized: the lifecycle glyph and the marker are what must survive.
  assert.match(painted.at(-1), /✓ 审查/, painted.at(-1));
  assert.match(painted.at(-1), /!/, painted.at(-1));
});

test("a question keeps its `?` through a clipped tab as well", (t) => {
  const entries = [
    entry(
      view("aspen", {
        outcome: { status: "needs_input", question: "Which branch?", limit_reached: false },
      }),
    ),
    entry(view("cedar")),
  ];
  const p = pane(t, { width: 20, entries, chosen: "aspen" });
  const edge = plain(p, 20).at(-1);
  assert.match(edge, /✓/, edge);
  assert.match(edge, /\?/, "the question marker survives the narrower tab");
  assert.doesNotMatch(edge, /✗/, "a question is not turned into a failure");
});

// ---- The clipped strip and the footer's cue recompute, at the helper seam ----

const warned = ["aspen", "cedar"].map((id) => entry(view(id, { history_error: "x" })));

/** A theme that records every fg/bold call, for exact colour assertions. */
const recording = () => {
  const calls = [];
  return {
    calls,
    theme: {
      fg: (color, text) => (calls.push(["fg", color, text]), text),
      bold: (text) => (calls.push(["bold", text]), text),
    },
  };
};
const fgCall = (calls, color, text) =>
  calls.some(([kind, c, t]) => kind === "fg" && c === color && t === text);

test("attention overflow dims its separators and accents only the info key", () => {
  const { theme, calls } = recording();
  const input = entry(view("aspen", { history_error: "unavailable", pending_messages: 1 })).input;
  const [row] = renderDetailAttention(input, theme, 72, { maxRows: 1 });
  assert.match(row, / · \+1 · info$/);
  assert.ok(fgCall(calls, "dim", " · +1 · "));
  assert.ok(fgCall(calls, "dim", "nfo"));
  assert.ok(fgCall(calls, "accent", "i"));
});

test("the detail menu hint dims its label without dimming its shortcut", () => {
  const { theme, calls } = recording();
  const { text } = renderDetailFooter({
    entries: [],
    selected: "",
    width: 48,
    below: 0,
    available: false,
    confirming: false,
    menu: true,
    spinnerFrame: 0,
    theme,
    framed: true,
  });
  assert.match(text, /\. more$/);
  assert.ok(fgCall(calls, "dim", "more"));
  assert.ok(fgCall(calls, "accent", "."));
});

test("in a clipped tab the marker outranks the nickname, not the lifecycle glyph", () => {
  // The selected tab alone needs 11 columns; summaries do not fit beside it.
  for (const [width, label] of [
    [12, "aspen"],
    [8, "a…"],
    [7, "…"],
  ]) {
    const strip = renderDetailAgentStrip({
      entries: warned,
      selected: "aspen",
      width,
      spinnerFrame: 0,
      theme,
      framed: true,
    });
    assert.equal(strip.clipped, true, `${width}: the strip is the clipped fallback`);
    assert.match(strip.text, /!/, `${width}: ${strip.text}`);
    assert.equal(strip.markerVisible, true, `${width}: the marker is actually painted`);
    assert.match(strip.text, new RegExp(`✓[^!]*${label}`), `${width}: ${strip.text}`);
    assert(visibleWidth(strip.text) <= width, `${width}: ${strip.text}`);
  }
  // Below four columns even the glyph stands alone: the footer must supply the cue.
  for (const width of [1, 2, 3]) {
    const strip = renderDetailAgentStrip({
      entries: warned,
      selected: "aspen",
      width,
      spinnerFrame: 0,
      theme,
      framed: true,
    });
    assert.equal(strip.markerVisible, false, `${width}: nothing else fits`);
    assert(visibleWidth(strip.text) <= width, `${width}: ${strip.text}`);
  }
});

test("a whole selected tab carries its marker, so the footer cue stays suppressed", () => {
  const frame = renderDetailFooter({
    width: 80,
    entries: warned,
    selected: "aspen",
    below: 0,
    view: warned[0].input.view,
    available: false,
    confirming: false,
    hiddenNotes: 3,
    spinnerFrame: 0,
    theme,
    framed: false,
  });
  assert.match(frame.text, /✓ aspen !/, frame.text);
  assert.doesNotMatch(frame.text, /!3/, "the tab's own marker already says it");
});

test("a clipped tab without its marker forces the footer's required cue", () => {
  const frame = renderDetailFooter({
    width: 3,
    entries: warned.map((e) =>
      entry(
        view(e.agent_id, {
          history_error: "x",
          status: "running",
          phase: "executing",
          execution_exited: false,
        }),
      ),
    ),
    selected: "aspen",
    below: 0,
    view: view("aspen", {
      history_error: "x",
      status: "running",
      phase: "executing",
      execution_exited: false,
    }),
    available: false,
    confirming: false,
    messaging: false,
    hiddenNotes: 1,
    spinnerFrame: 0,
    theme,
    framed: true,
  });
  // The strip has no room for a complete marker, so the cue is laid out again
  // with the `!N` forced; the cue is the only thing that still fits.
  assert.match(frame.text, /^!1$/, frame.text);
  assert.doesNotMatch(frame.text, /⠋ !/, frame.text);
  assert(visibleWidth(frame.text) <= 3, frame.text);
});

test("a clipped marker keeps the strip's colours: ? warning, ! warning/error, never the lifecycle colour", () => {
  // completed + warning: the `!` must not wear the completed tab's success
  // colour -- the bug painted the whole clipped body in one lifecycle colour.
  const done = recording();
  const stripDone = renderDetailAgentStrip({
    entries: warned,
    selected: "aspen",
    width: 12,
    spinnerFrame: 0,
    theme: done.theme,
    framed: true,
  });
  assert.equal(stripDone.markerVisible, true);
  assert.ok(fgCall(done.calls, "success", "✓"), JSON.stringify(done.calls));
  assert.ok(fgCall(done.calls, "warning", "!"), JSON.stringify(done.calls));
  assert.ok(!fgCall(done.calls, "success", "!"), "a warning marker is never repainted as success");
  // running + question: the glyph keeps its accent, the `?` is warning-coloured.
  const running = (id, extra = {}) =>
    entry(
      view(id, {
        status: "running",
        phase: "executing",
        execution_exited: false,
        ...extra,
      }),
    );
  const ask = recording();
  renderDetailAgentStrip({
    entries: [
      running("aspen", {
        outcome: { status: "needs_input", question: "Q?", limit_reached: false },
      }),
      running("cedar"),
    ],
    selected: "aspen",
    width: 12,
    spinnerFrame: 0,
    theme: ask.theme,
    framed: true,
  });
  assert.ok(fgCall(ask.calls, "accent", "⠋"), JSON.stringify(ask.calls));
  assert.ok(fgCall(ask.calls, "warning", "?"), JSON.stringify(ask.calls));
  assert.ok(
    !fgCall(ask.calls, "accent", "?"),
    "a question marker is never repainted as the running accent",
  );
  // both at once: `?!` keeps each marker its own colour.
  const both = recording();
  const stripBoth = renderDetailAgentStrip({
    entries: [
      entry(
        view("aspen", {
          history_error: "x",
          outcome: { status: "needs_input", question: "Q?", limit_reached: false },
        }),
      ),
      entry(view("cedar")),
    ],
    selected: "aspen",
    width: 12,
    spinnerFrame: 0,
    theme: both.theme,
    framed: true,
  });
  assert.equal(stripBoth.markerVisible, true);
  assert.match(stripBoth.text, /✓ aspen \?!/);
  assert.ok(fgCall(both.calls, "warning", "?"), JSON.stringify(both.calls));
  assert.ok(fgCall(both.calls, "warning", "!"), JSON.stringify(both.calls));
});

test("a partially clipped label keeps the marker's own colours", () => {
  const rec = recording();
  const strip = renderDetailAgentStrip({
    entries: [entry(view("current-reviewer", { history_error: "x" })), entry(view("cedar"))],
    selected: "current-reviewer",
    width: 12,
    spinnerFrame: 0,
    theme: rec.theme,
    framed: true,
  });
  // The nickname yields columns but keeps its selected accent; neither the
  // lifecycle glyph nor the marker inherits that nickname color.
  assert.match(strip.text, /✓ curre… !/);
  assert.ok(fgCall(rec.calls, "success", "✓"), JSON.stringify(rec.calls));
  assert.ok(fgCall(rec.calls, "accent", "curre…"), JSON.stringify(rec.calls));
  assert.ok(fgCall(rec.calls, "warning", "!"), JSON.stringify(rec.calls));
  // At four columns the glyph and the single-cell marker both fit whole, so
  // the marker is painted and the footer cue can stay suppressed.
  const tiny = recording();
  const stripTiny = renderDetailAgentStrip({
    entries: warned,
    selected: "aspen",
    width: 4,
    spinnerFrame: 0,
    theme: tiny.theme,
    framed: true,
  });
  assert.equal(stripTiny.markerVisible, true);
  assert.ok(fgCall(tiny.calls, "warning", "!"), JSON.stringify(tiny.calls));
  // Below four columns even the glyph stands alone: nothing is painted beside
  // it, so the footer's forced cue is the only warning left.
  for (const width of [3, 2, 1]) {
    const none = recording();
    const stripNone = renderDetailAgentStrip({
      entries: warned,
      selected: "aspen",
      width,
      spinnerFrame: 0,
      theme: none.theme,
      framed: true,
    });
    assert.equal(stripNone.markerVisible, false, `${width}`);
    assert.ok(
      !none.calls.some(([, , text]) => text === "!"),
      `${width}: ${JSON.stringify(none.calls)}`,
    );
  }
});

test("the forced cue keeps its warning colour when the marker cannot fit", () => {
  const rec = recording();
  const frame = renderDetailFooter({
    width: 3,
    entries: ["aspen", "cedar"].map((id) =>
      entry(
        view(id, {
          history_error: "x",
          status: "running",
          phase: "executing",
          execution_exited: false,
        }),
      ),
    ),
    selected: "aspen",
    below: 0,
    view: view("aspen", {
      history_error: "x",
      status: "running",
      phase: "executing",
      execution_exited: false,
    }),
    available: false,
    confirming: false,
    messaging: false,
    hiddenNotes: 1,
    spinnerFrame: 0,
    theme: rec.theme,
    framed: true,
  });
  assert.ok(fgCall(rec.calls, "warning", "!1"), JSON.stringify(rec.calls));
  assert.ok(
    !rec.calls.some(([, , text]) => text === "!"),
    "no marker was painted beside the forced cue",
  );
  assert.match(frame.text, /^!1$/);
});

test("an unmarked selected tab never grew a marker to keep the cue suppressed", () => {
  const entries = [entry(view("aspen")), entry(view("cedar", { history_error: "x" }))];
  const frame = renderDetailFooter({
    width: 55,
    entries,
    selected: "aspen",
    below: 0,
    view: entries[0].input.view,
    available: false,
    confirming: false,
    hiddenNotes: 2,
    spinnerFrame: 0,
    theme,
    framed: true,
  });
  assert.match(frame.text, /^!2 /, frame.text);
  assert.doesNotMatch(frame.text, /✓ aspen [?!]/, "no marker is invented");
});
