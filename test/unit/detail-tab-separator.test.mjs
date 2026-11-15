import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

// Direct source tests for the framed agent tabs' separator: joins are a
// literal ASCII pipe (U+007C) painted with the muted border token, never the
// rule chrome a popover frame uses. Docked joins stay empty. Geometry, hit
// ranges and selection styling hold around it. These hold the contract at the
// helper seam, without a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailAgentStrip } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
const { POPOVER } = await jiti.import("../../src/shared/popover-frame.mjs");

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
const entry = (id, extra = {}) => ({ agent_id: id, input: { view: view(id, extra), live } });
const warned = (id) => entry(id, { history_error: "x" });
const questioned = (id) =>
  entry(id, {
    outcome: { status: "needs_input", question: "Q?", limit_reached: false },
  });
const three = () => [entry("aspen"), entry("birch"), entry("cedar")];
const strip = (overrides = {}) =>
  renderDetailAgentStrip({
    entries: three(),
    selected: "birch",
    width: 80,
    spinnerFrame: 0,
    theme,
    ...overrides,
  });
const pipes = (text) => [...text].filter((ch) => ch === "|").length;
const fgCall = (calls, color, text) =>
  calls.some(([kind, c, t]) => kind === "fg" && c === color && t === text);
const items = (text) => text.split("|").length;

/** Records every theme call, so token usage is provable, not assumed. */
const recording = () => {
  const calls = [];
  return {
    calls,
    theme: {
      fg: (color, text) => (calls.push(["fg", color, text]), text),
      bold: (text) => (calls.push(["bold", text]), text),
      underline: (text) => (calls.push(["underline", text]), text),
      bg: (color, text) => (calls.push(["bg", color, text]), text),
    },
  };
};
const noBg = (calls, where) =>
  assert.deepEqual(
    calls.filter(([kind]) => kind === "bg"),
    [],
    `${where}: the render never asks for a background fill`,
  );

test("framed tabs join by literal ASCII pipes, never rule chrome", () => {
  const rec = recording();
  const { text } = strip({ framed: true, theme: rec.theme });
  // Exactly one pipe per join: N-1 for N tabs.
  assert.equal(pipes(text), 2, text);
  assert.ok(text.includes("|"), text);
  // The literal U+007C code point, not a lookalike box glyph.
  assert.ok(!text.includes("\u2502"), "never U+2502");
  assert.ok(!text.includes("\u2500"), "never the rule glyph the frame draws");
  assert.ok(text.includes(POPOVER.h) === false, "never POPOVER.h");
  // The divider is the only borderMuted-styled fragment, and the rule token
  // and colour are never asked for.
  assert.deepEqual(
    rec.calls.filter(([kind, , t]) => kind === "fg" && t === "|"),
    [["fg", "borderMuted", "|"]],
    JSON.stringify(rec.calls),
  );
  assert.ok(
    !rec.calls.some(
      ([kind, color, t]) => kind === "fg" && t === POPOVER.h && color === "borderAccent",
    ),
    "the rule token is gone from the joins",
  );
  noBg(rec.calls, "strip");
});

test("arrows keep their flush joins: no pipe beside ‹ or ›", () => {
  const rec = recording();
  const { text } = strip({ framed: true, arrows: true, theme: rec.theme });
  assert.equal(pipes(text), 2, text);
  assert.doesNotMatch(text, /‹\|/, text);
  assert.doesNotMatch(text, /\|›/, text);
  // The step controls are dim chrome of their own, never muted-border joins.
  assert.ok(!fgCall(rec.calls, "borderMuted", "‹"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "borderMuted", "›"), JSON.stringify(rec.calls));
});

test("click ranges cover the padded tabs and never the pipe", () => {
  const { text, items } = strip({ framed: true });
  assert.equal(items.length, 3, text);
  for (const [index, item] of items.entries()) {
    const own = text.slice(item.from, item.to);
    // Each range is the tab's own padding, whole.
    assert.ok(own.startsWith(" ") && own.endsWith(" "), JSON.stringify(own));
    assert.ok(!own.includes("|"), JSON.stringify(own));
    // A pipe separates on the outside of every range, never inside one.
    if (index > 0) assert.equal(text[item.from - 1], "|", text);
    if (index < items.length - 1) assert.equal(text[item.to], "|", text);
  }
});

test("the selected tab's style is intact: the pipe is styled by nothing else", () => {
  const sgr = {
    fg: (_color, text) => text,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    underline: (text) => `\u001b[4m${text}\u001b[24m`,
  };
  const rec = recording();
  // The SGR theme proves the painted spans; the recording theme proves the
  // styling calls. One render each, same geometry.
  const { text } = strip({ framed: true, theme: sgr });
  strip({ framed: true, theme: rec.theme });
  const open = text.indexOf("\u001b[4m");
  const close = text.indexOf("\u001b[24m", open);
  assert.ok(close > open, "the underline is closed");
  assert.equal(
    stripTerminalSequences(text.slice(open, close + "\u001b[24m".length)),
    "birch",
    "only the selected nickname is underlined",
  );
  // The wrapped span is the nickname alone: the divider never joins it.
  assert.ok(!text.slice(open, close).includes("|"), text);
  // No selection styling or accent reaches the divider.
  assert.ok(!fgCall(rec.calls, "accent", "|"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "borderAccent", "|"), JSON.stringify(rec.calls));
  assert.deepEqual(
    rec.calls.filter(([kind]) => kind === "underline"),
    [["underline", "birch"]],
    JSON.stringify(rec.calls),
  );
  assert.deepEqual(
    rec.calls.filter(([kind]) => kind === "bold"),
    [["bold", "birch"]],
    JSON.stringify(rec.calls),
  );
});

test("hidden peers still summarize +N with attention counts beside the pipe joins", () => {
  const entries = [
    questioned("q1"),
    warned("w1"),
    questioned("q2"),
    warned("w2"),
    warned("w3"),
    entry("sel"),
  ];
  const { text } = strip({ entries, selected: "sel", width: 22, framed: true });
  assert.ok(visibleWidth(text) <= 22, text);
  assert.match(text, /sel/, text);
  // Two questions and three warnings behind one summary, joined to the
  // selected tab by the same single pipe.
  assert.match(text, / \+5 \?2 !3 \|/, text);
  // The summary is one element like a tab: the join count still matches the
  // painted elements minus one.
  assert.equal(pipes(text), items(text) - 1, text);
});

test("docked tabs keep their empty separator and adjacency", () => {
  const rec = recording();
  const { text, items: ranges } = strip({ framed: false, theme: rec.theme });
  assert.ok(!text.includes("|"), text);
  assert.ok(!text.includes("\u2502"), text);
  // No divider is ever styled, because none is painted.
  assert.deepEqual(
    rec.calls.filter(([, , t]) => t === "|"),
    [],
    JSON.stringify(rec.calls),
  );
  // Join allocation stays 0: the tabs' own padding separates them.
  assert.equal(ranges.length, 3);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].from, ranges[i - 1].to, text);
});

test("every width 1..200 fits ASCII, CJK and ANSI nicknames", () => {
  const raw = "bad\u001b[31mred\u001b[0m";
  const entries = [entry("alpha"), entry("审查"), entry(raw), entry("cedar")];
  // The narrowest width where every tab fits whole: all names painted, so
  // no peer is summarized. (Tiny widths clip the selected tab alone, which
  // paints no summary either.)
  const names = ["alpha", "审查", "cedar"];
  const fullFit = Array.from({ length: 200 }, (_, i) => i + 1).find((width) => {
    const { text } = strip({ entries, selected: "cedar", width, framed: true });
    return names.every((name) => text.includes(name));
  });
  for (const width of Array.from({ length: 200 }, (_, i) => i + 1)) {
    const { text, items: ranges } = strip({
      entries,
      selected: "cedar",
      width,
      framed: true,
    });
    const at = `${width}: ${JSON.stringify(text)}`;
    assert.ok(visibleWidth(text) <= width, at);
    for (const item of ranges)
      assert.ok(item.from >= 0 && item.to <= visibleWidth(text), `${at} ${JSON.stringify(item)}`);
    if (width >= fullFit) {
      assert.equal(pipes(text), 3, at);
      for (const name of names) assert.ok(text.includes(name), at);
    }
  }
});
