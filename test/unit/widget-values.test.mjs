import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  contextPercent,
  formatContextPercent,
  formatCost,
} from "../../dist/orchestration/ui/format.js";
import { isObservedCost, widgetCost } from "../../dist/orchestration/ui/widget-cost.js";
import {
  prepareWidgetRow,
  renderHeader,
  widgetColumns,
} from "../../dist/orchestration/ui/widget-row.js";
import { owner, render, run, theme } from "../support/widget-fixture.mjs";

test("partial widget costs truncate decimal observations without losing a cent to binary multiplication", () => {
  for (const [value, expected] of [
    [0.29, "≥$0.29"],
    [0.57, "≥$0.57"],
    [0.58, "≥$0.58"],
    [1.15, "≥$1.15"],
    [0.299, "≥$0.29"],
    [0.29999999999999993, "≥$0.29"],
    [0.009, "≥$0.00"],
    [0, "≥$0.00"],
    [1e-7, "≥$0.00"],
    [Number.MIN_VALUE, "≥$0.00"],
    // A formatter cannot infer the intention of an already-aggregated float.
    [0.01 + 0.06, "≥$0.06"],
  ])
    assert.equal(widgetCost(value, true), expected, String(value));
  assert.equal(widgetCost(0.009), "$0.01");
  assert.equal(widgetCost(1.005), "$1.01");
  // A measured sub-cent price is not a free Run; only a genuine zero says so.
  assert.equal(widgetCost(0), "$0.00");
  for (const tiny of [0.004, 1e-7, Number.MIN_VALUE]) assert.equal(widgetCost(tiny), "<$0.01");
  assert.equal(widgetCost(0.005), "$0.01");
  assert.equal(formatCost(0.299), "$0.299", "detail precision is unchanged");
  assert.match(widgetCost(Number.MAX_VALUE, true), /^≥\$\d+\.00$/);
  for (const invalid of [NaN, Infinity, -Infinity, -1])
    assert.throws(() => widgetCost(invalid, true), RangeError);
});

test("the heading never aggregates task prices; each row keeps its own cents", () => {
  for (const values of [
    [0.29, 0.29],
    [0.57, 0.58],
    [0.01, 0.06],
    [0.149, 0.149],
    [0.004, 0.006],
    Array.from({ length: 16 }, () => 0.01),
  ]) {
    const rows = values.map((cost, index) =>
      run(String(index), {
        status: "completed",
        name: `agent${index}`,
        cost,
        cost_partial: index === 0,
      }),
    );
    const heading = render(rows, {
      width: 200,
      owner: { ...owner, resident: rows.length, resident_limit: 16 },
    })[0];
    assert.doesNotMatch(heading, /latest|Σ|\$/, "heading never aggregates task prices");
    const partialLine = render([rows[0]], { width: 160 })[1];
    assert(partialLine.includes(widgetCost(values[0], true)), partialLine);
  }
  const measured = run("measured", { status: "completed", cost: 0.29 });
  const unknown = run("unknown", { status: "queued" });
  const mixed = render([measured, unknown], { width: 160 });
  assert.doesNotMatch(mixed[0], /latest|Σ|\$/);
  assert.match(mixed.slice(1).join("\n"), /\$0\.29/);
  assert.doesNotMatch(render([unknown], { width: 160 })[0], /latest|Σ|\$/);
  const zero = render([run("zero", { status: "completed", cost: 0 })]);
  assert.doesNotMatch(zero[0], /latest|Σ|\$/);
  assert.match(zero[1], /\$0\.00/);
});

test("invalid cost telemetry stays unknown without hiding valid neighboring prices", () => {
  for (const cost of [NaN, Infinity, -Infinity, -0.01, "0.29", "bad", null, {}, undefined]) {
    assert.equal(isObservedCost(cost), false);
    const invalid = run("invalid", { status: "completed", name: "Invalid", cost });
    assert.equal(prepareWidgetRow(invalid).cells.cost.text, "");
    for (const width of [70, 200]) {
      const unknown = render([invalid], { width }).join("\n");
      assert.doesNotMatch(unknown, /latest|Σ|\$|NaN|Infinity/);
      const mixed = render(
        [
          invalid,
          run("first", { status: "completed", name: "First", cost: 0.29 }),
          run("second", { status: "completed", name: "Second", cost: 0.58 }),
        ],
        { width },
      );
      assert.doesNotMatch(mixed[0], /latest|Σ|\$/);
      const body = mixed.slice(1).join("\n");
      assert.match(body, /\$0\.29/);
      assert.match(body, /\$0\.58/);
      assert.doesNotMatch(mixed.join("\n"), /NaN|Infinity|-\$|\$-|\$0\.00/);
    }
  }
  for (const cost of [0, -0, 0.29, Number.MIN_VALUE, Number.MAX_VALUE])
    assert.equal(isObservedCost(cost), true);
});

test("tool counts stay absent while aligned prices distinguish zero from missing cost/context", () => {
  const rows = [
    run("zero", { status: "completed", name: "Zero", tool_uses: 0 }),
    run("priced-zero", { status: "completed", name: "Free", tool_uses: 77, cost: 0 }),
    run("two", {
      status: "completed",
      name: "Two",
      tool_uses: 2,
      cost: 0.29,
      runtime: { activity: "idle", context: { tokens: 10, context_window: 100 } },
    }),
  ];
  for (const palette of [
    theme,
    {
      fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    },
  ]) {
    const body = render(rows, { width: 160, theme: palette }).slice(1).map(stripTerminalSequences);
    assert(
      body.every((line) => !/▸\d/.test(line)),
      "no per-Agent tool-count column",
    );
    assert.match(body[0], /—/, "only genuinely absent cost/context observations use placeholders");
    assert.doesNotMatch(body[0], /\$0\.00|ctx 0%/);
    assert.match(body[1], /\$0\.00/);
    assert.match(body[2], /\$0\.29/);
    const end = (line, token) => visibleWidth(line.slice(0, line.indexOf(token) + token.length));
    assert.equal(end(body[1], "$0.00"), end(body[2], "$0.29"));
    assert(body.every((line) => visibleWidth(line) <= 160));
  }
  assert.doesNotMatch(render([rows[0]])[1], /▸/, "an all-zero tools column may stay omitted");
});

test("prepared metric values are reused for layout and drawing, not sampled twice", () => {
  let reads = 0;
  const value = run("prepared", { status: "completed", name: "Prepared", cost_partial: true });
  Object.defineProperty(value, "cost", {
    get() {
      reads++;
      return 0.29;
    },
  });
  const row = prepareWidgetRow(value);
  const sampled = reads;
  assert(sampled > 0);
  const columns = widgetColumns([row], 180);
  assert(columns);
  const output = renderHeader(value, "✓", row.state, false, theme, 180, columns, row);
  assert.match(output, /≥\$0\.29/);
  assert.equal(reads, sampled, "geometry/painting reuse prepared cost rather than resampling it");
});

test("context numeric validation is shared while widget and details retain distinct precision", () => {
  for (const context of [
    undefined,
    { tokens: null, context_window: 100 },
    ...[0, -1, NaN, Infinity, 0.5].map((context_window) => ({ tokens: 10, context_window })),
    ...[-1, NaN, Infinity, 0.5].map((tokens) => ({ tokens, context_window: 100 })),
  ]) {
    assert.equal(contextPercent(context), undefined);
    assert.equal(formatContextPercent(context), "?");
    const row = prepareWidgetRow(
      run("invalid", { status: "completed", runtime: { activity: "idle", context } }),
    );
    assert.equal(row.context, undefined);
    if (context) assert.equal(row.cells.context.text, "ctx ?");
  }
  for (const [tokens, numeric, detailed, compact] of [
    [0, 0, "0.0%", "ctx 0%"],
    [267, 26.700000000000003, "26.7%", "ctx 27%"],
    [1100, 110.00000000000001, "110.0%", "ctx 110%"],
  ]) {
    const context = { tokens, context_window: 1000 };
    assert.equal(contextPercent(context), numeric);
    assert.equal(formatContextPercent(context), detailed);
    const row = prepareWidgetRow(
      run("valid", { status: "completed", runtime: { activity: "idle", context } }),
    );
    assert.equal(row.cells.context.text, compact);
  }
});
