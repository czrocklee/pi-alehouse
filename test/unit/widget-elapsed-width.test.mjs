import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Exercise current source without a build or a dependency on dist output.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderWidget } = await jiti.import("../../src/orchestration/ui/widget-render.ts");
const { prepareWidgetRow, widgetColumns } = await jiti.import(
  "../../src/orchestration/ui/widget-row.ts",
);
const { formatMs } = await jiti.import("../../src/orchestration/ui/format.ts");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const styled = {
  fg: (color, text) =>
    `\x1b[${color === "warning" ? 33 : color === "error" ? 31 : 36}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
};
const run = (id, overrides = {}) => ({
  agent_id: id,
  run_id: `${id}-run`,
  resident: true,
  status: "completed",
  name: id,
  profile: "editor",
  difficulty: 3,
  model: "m",
  effort: "high",
  description: "Review task",
  turns: 3,
  max_turns: 256,
  elapsed_ms: 12_400,
  active_tools: [],
  preview: "",
  pending_messages: 0,
  has_run_warnings: false,
  limit_reached: false,
  question: false,
  finishing: false,
  ...overrides,
});
const frame = (runs, options = {}) =>
  renderWidget({
    runs,
    owner: { blocked: false, resident: runs.length, resident_limit: 12 },
    spinnerFrame: 0,
    width: 160,
    maxLines: 13,
    theme,
    shouldShowFinished: () => true,
    ...options,
  });
const header = (result, id) => stripTerminalSequences(result.lines[result.hits.indexOf(id)]);
const position = (line, token, end = false) => {
  const index = line.indexOf(token);
  assert(index >= 0, `${token}: ${line}`);
  return visibleWidth(line.slice(0, index)) + (end ? visibleWidth(token) : 0);
};
/** The elapsed column shares one width across the roster; 160 - 3 is the
 * painted row width the widget hands to widgetColumns. */
const elapsedWidth = (runs, width = 157) => {
  const columns = widgetColumns(
    runs.map((row) => prepareWidgetRow(row)),
    width,
  );
  assert(columns, "columns must fit the painted width");
  return columns.metrics.find((column) => column.key === "elapsed")?.width ?? 0;
};
const priced = (cost, amount = cost) => ({ cost, agent_cost: { amount, partial: false } });
const costToken = (row) => `$${row.cost.toFixed(2)}/${row.agent_cost.amount.toFixed(2)}`;

test("a lone 6m48s paints a 5-cell elapsed column with the ordinary two-space gap", () => {
  const row = run("otter", { elapsed_ms: 408_000, ...priced(1.45, 4.75) });
  assert.equal(formatMs(row.elapsed_ms), "6m48s");
  assert.equal(elapsedWidth([row]), 5, "the column hugs the longest visible value");
  const line = header(frame([row]), "otter");
  assert.equal(position(line, "6m48s") - position(line, "$1.45/4.75", true), 2);
  assert.match(line, /\$1\.45\/4\.75 {2}6m48s/);
});

test("identical 5-cell elapsed rows share the column without phantom padding", () => {
  const rows = [
    run("otter", { elapsed_ms: 408_000, ...priced(1.45, 4.75) }),
    run("badger", { elapsed_ms: 408_000, ...priced(12.3, 25) }),
    run("复核🦉", { elapsed_ms: 408_000, ...priced(0) }),
  ];
  assert.equal(elapsedWidth(rows), 5);
  const result = frame(rows);
  for (const row of rows) {
    const line = header(result, row.agent_id);
    assert.equal(position(line, "6m48s") - position(line, costToken(row), true), 2, line);
  }
});

test("mixed durations set one shared width from the longest visible value", () => {
  const durations = [0, 1_900, 59_900, 408_000, 600_000, 6_000_000];
  const rows = durations.map((elapsed_ms, index) =>
    run(`agent-${index}`, { elapsed_ms, ...priced(0.27, 1.25) }),
  );
  assert.equal(elapsedWidth(rows), 7, "100m00s is the longest visible value");
  const result = frame(rows);
  const ends = rows.map((row) =>
    position(header(result, row.agent_id), formatMs(row.elapsed_ms), true),
  );
  assert.equal(new Set(ends).size, 1, "numeric right ends share one column");
  const longest = header(result, "agent-5");
  assert.equal(position(longest, "100m00s") - position(longest, "$0.27/1.25", true), 2);
  // Short values may pad; they stay right-aligned instead of forcing a fixed
  // two-space gap per row.
  const shortest = header(result, "agent-0");
  assert.equal(position(shortest, "0.0s") - position(shortest, "$0.27/1.25", true), 2 + (7 - 4));
});

test("seconds-to-minute boundaries size the column from the actual value", () => {
  for (const [ms, text, width] of [
    [0, "0.0s", 4],
    [59_900, "59.9s", 5],
    [60_000, "1m00s", 5],
    [599_999, "9m59s", 5],
    [600_000, "10m00s", 6],
  ]) {
    assert.equal(formatMs(ms), text);
    const row = run("otter", { elapsed_ms: ms });
    assert.equal(elapsedWidth([row]), width, `${text} sizes its own column`);
  }
});

test("CJK/emoji/ANSI themes do not shift the roster, the turn clock or hits", () => {
  const rows = [
    run("复核🦉", {
      description: "复核路径规范化及 lint 修复",
      elapsed_ms: 408_000,
      ...priced(1.45, 4.75),
    }),
    run("runner", {
      status: "running",
      elapsed_ms: 1_200_000,
      turn_elapsed_ms: 75_000,
      active_tools: [],
    }),
  ];
  const plain = frame(rows);
  const fancy = frame(rows, { theme: styled });
  assert.deepEqual(fancy.hits, plain.hits, "click targets are theme-independent");
  assert.deepEqual(
    fancy.lines.map(stripTerminalSequences),
    plain.lines.map(stripTerminalSequences),
    "styling must not move any painted cell",
  );
  // The current-turn clock stays on the activity subline, tinted by its age.
  const clockAt = plain.hits.indexOf("runner") + 1;
  assert.ok(clockAt > 0, "the running Agent keeps an activity subline");
  assert.match(stripTerminalSequences(plain.lines[clockAt]), /1m15s/);
  assert.doesNotMatch(stripTerminalSequences(plain.lines[clockAt - 1]), /1m15s/);
  assert.ok(fancy.lines[clockAt].includes("\x1b[33m1m15s"), "warning tint survives");
});

test("widths 80–240 keep painted rows and pagination geometry inside the viewport", () => {
  const roster = [
    ...["r1", "r2", "r3", "r4", "r5"].map((id, index) =>
      run(id, {
        status: "running",
        elapsed_ms: [0, 1_900, 59_900, 408_000, 6_000_000][index],
        turn_elapsed_ms: 75_000,
        active_tools: [],
      }),
    ),
    ...["c1", "c2", "c3", "c4"].map((id) => run(id, { elapsed_ms: 600_000, ...priced(12.3) })),
  ];
  for (let width = 80; width <= 240; width++) {
    for (const [mode, result] of [
      ["compact", frame(roster, { width })],
      ["expanded", frame(roster, { width, expanded: true, maxLines: 7 })],
    ]) {
      for (const line of result.lines)
        assert.ok(
          visibleWidth(stripTerminalSequences(line)) <= width,
          `${mode} overflow at width ${width}: ${line}`,
        );
      assert.equal(result.hits.length, result.lines.length, `${mode} hits at width ${width}`);
      const { pagination } = result;
      if (pagination) {
        assert.ok(pagination.pages >= 2, `${mode} pages at width ${width}`);
        assert.ok(pagination.row < result.lines.length, `${mode} pagination row at width ${width}`);
        assert.match(stripTerminalSequences(result.lines[pagination.row]), /\d+\/\d+ Next/);
        if (pagination.next) assert.ok(pagination.next[1] <= width, `${mode} next at ${width}`);
      }
    }
  }
});

test("click-only pagination paints plain labels and visibleWidth hit ranges under ANSI", () => {
  const tints = { dim: "\x1b[2m", muted: "\x1b[36m" };
  const tinted = {
    fg: (color, text) => `${tints[color] ?? "\x1b[32m"}${text}\x1b[0m`,
    bold: (text) => text,
  };
  const roster = Array.from({ length: 9 }, (_, i) => run(`p${i}`));
  const options = { width: 80, maxLines: 7, expanded: true, theme: tinted };
  const first = frame(roster, options);
  assert.equal(first.pagination.pages, 2);
  const row = first.lines[first.pagination.row];
  assert.equal(
    stripTerminalSequences(row),
    "Prev 1/2 Next",
    "click-only controls carry no bracket mnemonics",
  );
  assert.ok(row.includes(`${tints.dim}Prev`), "the disabled Prev stays dim");
  assert.ok(row.includes(`${tints.muted}Next`), "the active Next is muted");
  assert.equal(first.pagination.prev, undefined, "page 0 paints no Prev hit range");
  assert.deepEqual(first.pagination.next, [9, 13], "Next starts past the visible prefix");
  const last = frame(roster, { ...options, page: 1 });
  const lastRow = last.lines[last.pagination.row];
  assert.equal(stripTerminalSequences(lastRow), "Prev 2/2 Next");
  assert.deepEqual(last.pagination.prev, [0, 4], "Prev owns the leading columns");
  assert.equal(last.pagination.next, undefined, "the last page paints no Next hit range");
  assert.ok(lastRow.includes(`${tints.muted}Prev`), "the active Prev is muted");
  assert.ok(lastRow.includes(`${tints.dim}Next`), "the disabled Next stays dim");
});
