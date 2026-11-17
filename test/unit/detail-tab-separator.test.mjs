import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import {
  detailEntry,
  detailView,
  fgCall,
  plainTheme as theme,
  recordingTheme as recording,
  sgrTheme,
} from "../support/detail-fixture.mjs";

// Direct source tests for the agent tabs' separator: every edge uses the tabs'
// own padding, never an ASCII pipe or the rule chrome a popover frame uses.
// Geometry, hit ranges and selection styling hold around it. These hold the
// contract at the helper seam, without a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailAgentStrip } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
const { POPOVER } = await jiti.import("../../src/shared/popover-frame.mjs");

const entry = (id, extra) => detailEntry(detailView(id, extra));
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
const noBg = (calls, where) =>
  assert.deepEqual(
    calls.filter(([kind]) => kind === "bg"),
    [],
    `${where}: the render never asks for a background fill`,
  );

test("framed tabs are separated by their own padding, never a pipe or rule", () => {
  const rec = recording();
  const { text } = strip({ framed: true, theme: rec.theme });
  // No separator is painted at all: each tab's padding does the work.
  assert.equal(pipes(text), 0, text);
  assert.ok(!text.includes("|"), text);
  assert.ok(!text.includes("\u2502"), "never U+2502");
  assert.ok(!text.includes("\u2500"), "never the rule glyph the frame draws");
  assert.ok(text.includes(POPOVER.h) === false, "never POPOVER.h");
  // Two spaces between adjacent tab labels: the trailing and leading padding.
  assert.match(text, /✓ aspen {2}✓ birch {2}✓ cedar/, text);
  // No divider is styled, because none is painted.
  assert.deepEqual(
    rec.calls.filter(([, , t]) => t === "|"),
    [],
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

test("arrows sit flush against the padded tabs, with no separator", () => {
  const rec = recording();
  const { text } = strip({ framed: true, arrows: true, theme: rec.theme });
  assert.equal(pipes(text), 0, text);
  assert.doesNotMatch(text, /‹\|/, text);
  assert.doesNotMatch(text, /\|›/, text);
  // The step controls are dim chrome of their own, never muted-border joins.
  assert.ok(!fgCall(rec.calls, "borderMuted", "‹"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "borderMuted", "›"), JSON.stringify(rec.calls));
});

test("click ranges cover the padded tabs and never a separator", () => {
  const { text, items } = strip({ framed: true });
  assert.equal(items.length, 3, text);
  for (const [index, item] of items.entries()) {
    const own = text.slice(item.from, item.to);
    // Each range is the tab's own padding, whole.
    assert.ok(own.startsWith(" ") && own.endsWith(" "), JSON.stringify(own));
    assert.ok(!own.includes("|"), JSON.stringify(own));
    // No separator sits between adjacent ranges: the padding is adjacent.
    if (index > 0) assert.equal(item.from, items[index - 1].to, text);
  }
});

test("the selected tab's style is intact: no separator joins its underline", () => {
  const rec = recording();
  // The SGR theme proves the painted spans; the recording theme proves the
  // styling calls. One render each, same geometry.
  const { text } = strip({ framed: true, theme: sgrTheme });
  strip({ framed: true, theme: rec.theme });
  const open = text.indexOf("\u001b[4m");
  const close = text.indexOf("\u001b[24m", open);
  assert.ok(close > open, "the underline is closed");
  assert.equal(
    stripTerminalSequences(text.slice(open, close + "\u001b[24m".length)),
    "birch",
    "only the selected nickname is underlined",
  );
  // No selection styling or accent reaches a separator, because none exists.
  assert.ok(!text.slice(open, close).includes("|"), text);
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

test("hidden peers still summarize +N with attention counts beside the padding", () => {
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
  // Two questions and three warnings behind one summary, separated from the
  // selected tab by the same padding alone.
  assert.match(text, / \+5 \?2 !3 /, text);
  assert.equal(pipes(text), 0, text);
});

test("docked tabs keep the same padding-only adjacency", () => {
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
  // The tabs' own padding separates them: ranges are adjacent.
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
      assert.equal(pipes(text), 0, at);
      for (const name of names) assert.ok(text.includes(name), at);
    }
  }
});
