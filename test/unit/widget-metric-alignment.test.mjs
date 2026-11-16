import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { owner, run, theme } from "../support/widget-fixture.mjs";

const CODE = { warning: 33, error: 31, dim: 90, muted: 35, text: 36, accent: 34 };
const styled = {
  fg: (color, text) => `\x1b[${CODE[color] ?? 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

const frame = (runs, options = {}) =>
  renderWidget({
    runs,
    owner,
    theme,
    width: 160,
    maxLines: 13,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
    ...options,
  });
const header = (result, id) => stripTerminalSequences(result.lines[result.hits.indexOf(id)]);
const at = (line, token, end = false) => {
  const index = line.indexOf(token);
  assert(index >= 0, `${token}: ${line}`);
  return visibleWidth(line.slice(0, index)) + (end ? visibleWidth(token) : 0);
};
// Identify the cost itself before elapsed/task, not an unrelated later dash.
const costEnd = (line) => {
  const match = /(—|\$\d+\.\d{2}) +(?:12\.4s|62m03s) {2}Review task$/.exec(line);
  assert(match, `missing cost/elapsed/task suffix: ${line}`);
  return visibleWidth(line.slice(0, match.index)) + visibleWidth(match[1]);
};
const spans = (line) =>
  line.split("\x1b[").flatMap((part) => {
    const match = /^(\d+)m(.*)$/s.exec(part);
    return match && Number(match[1]) !== 0 ? [[Number(match[1]), match[2]]] : [];
  });

/** Mixed-width roster: CJK identity, differing turn/context/cost/elapsed
 * widths, missing snapshots and an unknown context observation. */
const roster = () => [
  run("复核", {
    name: "复核",
    description: "Review task",
    status: "running",
    turns: 23,
    max_turns: 65,
    cost: 0.27,
    runtime: { activity: "idle", context: { tokens: 170, context_window: 1000 } },
  }),
  run("calm", {
    name: "calm",
    description: "Review task",
    status: "completed",
    turns: 9,
    max_turns: 60,
    cost: 12.3,
    elapsed_ms: 3723000,
    runtime: { activity: "idle", context: { tokens: 50, context_window: 1000 } },
  }),
  run("mystery", { name: "mystery", description: "Review task", status: "completed" }),
  run("unknown", {
    name: "unknown",
    description: "Review task",
    status: "completed",
    runtime: { activity: "idle", context: { tokens: null, context_window: 1000 } },
  }),
];

test("metric labels align left and numbers right while extra width pads internally", () => {
  for (const expanded of [false, true]) {
    const result = frame(roster(), { expanded });
    const [busy, calm, mystery, unknown] = ["复核", "calm", "mystery", "unknown"].map((id) =>
      header(result, id),
    );
    // The requested example values, byte for byte: the label sits at the
    // shared left edge, the value at the shared right edge, and the extra
    // width becomes internal padding between them.
    // Sanity baseline: the widest row (busy) still matches exactly; the
    // padded calm assertion below is the real feature regression.
    assert(busy.includes("↻23/65  ctx 17%"), busy);
    assert(calm.includes("↻ 9/60  ctx  5%"), calm);

    // Turn marker and ctx label start at the shared metric left edge; all
    // four rows share it, including the unknown-context row.
    assert.equal(
      new Set([at(busy, "↻"), at(calm, "↻"), at(mystery, "↻"), at(unknown, "↻")]).size,
      1,
    );
    assert.equal(new Set([at(busy, "ctx"), at(calm, "ctx"), at(unknown, "ctx")]).size, 1);
    // Numeric suffixes share the right edge; the unknown row's value ends
    // there too (its turns come from the base snapshot: 3/256).
    assert.equal(
      new Set([
        at(busy, "23/65", true),
        at(calm, "9/60", true),
        at(mystery, "3/256", true),
        at(unknown, "3/256", true),
      ]).size,
      1,
    );
    assert.equal(
      new Set([at(busy, "17%", true), at(calm, "5%", true), at(unknown, "?", true)]).size,
      1,
    );

    // An absent context is a bare dash in the same column: no label, no
    // invented zero. Like every unlabeled cell it right-aligns to the
    // numeric edge and pads on the left instead of reserving label width.
    assert.doesNotMatch(mystery, /ctx/);
    assert.equal(at(mystery, "—", true), at(busy, "17%", true));
    assert(at(mystery, "—") > at(busy, "ctx"), "the dash pads left like unlabeled cells");
    assert(unknown.includes("ctx   ?"), unknown);
    assert.equal(at(unknown, "ctx"), at(busy, "ctx"));
    assert.equal(at(unknown, "?", true), at(busy, "17%", true));
    assert.doesNotMatch(unknown, /ctx\s+0%/);

    // Non-labeled metrics stay purely right-aligned: shorter values pad left.
    assert.equal(
      new Set([busy, calm, mystery, unknown].map(costEnd)).size,
      1,
      "unlabeled cost right-aligns and a missing cost keeps its dash",
    );
    assert(at(busy, "$0.27") > at(calm, "$12.30"), "shorter cost pads on the left");
    assert.equal(
      new Set(
        [busy, calm, mystery, unknown].map((line) =>
          at(line, line.includes("62m03s") ? "62m03s" : "12.4s", true),
        ),
      ).size,
      1,
      "unlabeled elapsed right-aligns",
    );

    // Task starts share one column and follow elapsed by exactly two spaces.
    const taskStarts = new Set(
      [busy, calm, mystery, unknown].map((line) => at(line, "Review task")),
    );
    assert.equal(taskStarts.size, 1, "all four task labels share one start column");
    for (const line of [busy, calm, mystery, unknown])
      assert.match(line, /(?:12\.4s|62m03s) {2}Review task$/, line);
    assert(result.lines.every((line) => visibleWidth(line) <= 160));
  }
});

test("severity tints wrap the whole realigned cell without changing thresholds", () => {
  const cases = [
    ["near", 55, 65, 920, CODE.warning, CODE.error, "ctx 92%"],
    ["calm", 9, 60, 50, CODE.dim, CODE.dim, "ctx  5%"],
    ["复核", 52, 65, 750, CODE.warning, CODE.warning, "ctx 75%"],
    ["below", 51, 65, 699, CODE.dim, CODE.dim, "ctx 69%"],
    ["unknown", 9, 60, null, CODE.dim, CODE.dim, "ctx   ?"],
    ["absent", 9, 60, undefined, CODE.dim, CODE.dim, "      —"],
  ];
  const result = frame(
    cases.map(([id, turns, max_turns, tokens]) =>
      run(id, {
        status: "completed",
        name: id,
        turns,
        max_turns,
        runtime:
          tokens === undefined
            ? undefined
            : { activity: "idle", context: { tokens, context_window: 1000 } },
      }),
    ),
    { theme: styled },
  );
  for (const [id, turns, max_turns, , turnColor, contextColor, contextText] of cases) {
    const value = `${turns}/${max_turns}`;
    const turnText = "↻" + " ".repeat(5 - visibleWidth(value)) + value;
    const actual = spans(result.lines[result.hits.indexOf(id)]).filter(
      ([_code, text]) => text.startsWith("↻") || text.startsWith("ctx ") || text === "      —",
    );
    assert.deepEqual(
      actual,
      [
        [turnColor, turnText],
        [contextColor, contextText],
      ],
      id,
    );
  }
});
