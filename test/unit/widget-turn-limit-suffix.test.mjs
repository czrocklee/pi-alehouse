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
  elapsed_ms: 12400,
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
const marker = /\((?:turn limit reached|limit)\)$/;

test("a lone reached limit adds no attention column or hole before any roster label", () => {
  const rows = [
    run("calm", { description: "Review calm", cost: 0.27 }),
    run("复核🦉", {
      description: "复核路径规范化及 lint 修复",
      limit_reached: true,
      turns: 120,
      cost: 12.3,
    }),
    run("last", { description: "Review last", cost: 0 }),
  ];
  for (const width of [120, 160, 240]) {
    const columns = widgetColumns(
      rows.map((row) => prepareWidgetRow(row)),
      width - 3,
    );
    assert(columns);
    assert.equal(columns.attention, 0, "the limit is not a shared attention cell");
    const baseline = frame(
      rows.map((row) => ({ ...row, limit_reached: false })),
      { width },
    );
    const result = frame(rows, { width });
    const starts = new Set();
    for (const row of rows) {
      const line = header(result, row.agent_id);
      const old = header(baseline, row.agent_id);
      starts.add(position(line, row.description));
      for (const token of ["worker/d3", "m/high"])
        assert.equal(position(line, token), position(old, token));
      for (const token of [
        `↻${row.turns}/256`,
        row.cost === 12.3 ? "$12.30" : row.cost ? "$0.27" : "$0.00",
        "12.4s",
      ])
        assert.equal(position(line, token, true), position(old, token, true));
      assert.match(line, /12\.4s {2}(?:Review|复核)/, "only the ordinary two-space gap");
      if (row.limit_reached) assert(line.endsWith(`${row.description} (turn limit reached)`), line);
      else assert(line.endsWith(row.description), line);
      assert.equal((line.match(/turn limit reached/g) ?? []).length, row.limit_reached ? 1 : 0);
    }
    assert.equal(starts.size, 1, "mixed CJK and quiet titles share their start");
  }
});

test("long English/CJK/emoji/ANSI and empty labels reserve a terminal suffix at widths 40–240", () => {
  for (const description of [
    "Review lifecycle transitions and accounting ".repeat(12),
    "复核路径规范化及 lint 修复".repeat(12),
    "👩‍💻🦉 é Review ".repeat(20),
    "\x1b[31mReview ANSI title\x1b[0m ".repeat(20),
    "",
    " \n\t ",
  ]) {
    const row = run("otter", { description, limit_reached: true });
    const before = structuredClone(row);
    for (let width = 40; width <= 240; width++) {
      for (const th of [theme, styled]) {
        const result = frame([row], { width, theme: th });
        const text = header(result, row.agent_id);
        assert.match(text, marker, `${width}: ${text}`);
        assert.equal((text.match(/\((?:turn limit reached|limit)\)/g) ?? []).length, 1, text);
        const title = description.startsWith("👩")
          ? "👩‍💻"
          : description.startsWith("复核")
            ? "复"
            : description.includes("Review")
              ? "Re"
              : undefined;
        if (title) {
          assert(text.includes(title), `${width}: ${text}`);
          assert(text.indexOf(title) < text.search(marker), text);
          if (width >= 120) assert.match(text, /… \(turn limit reached\)$/);
        } else assert.doesNotMatch(text, /… \(/, "empty titles do not invent a label");
        if (width >= 120) assert.match(text, /\(turn limit reached\)$/);
        assert.doesNotMatch(text, /\p{Surrogate}/u);
        assert(result.lines.every((line) => visibleWidth(line) <= width));
        assert.equal(result.hits[1], row.agent_id);
      }
    }
    assert.deepEqual(row, before);
  }
});

test("pending, warnings and real lifecycle attention stay before the label, independently of the suffix", () => {
  for (const [status, extra, state] of [
    ["completed", {}, undefined],
    ["running", {}, undefined],
    ["running", { finishing: true }, /finishing/],
    ["cancelling", {}, /cancelling/],
    ["queued", {}, /queued/],
    ["needs_input", { question: true }, /needs answer|answer\?/],
    ["needs_input", {}, /needs input|input\?/],
    ["failed", { error: "SDK broke" }, /failed/],
    ["cancelled", {}, /cancelled/],
  ]) {
    const row = run("otter", {
      status,
      ...extra,
      limit_reached: true,
      pending_messages: 2,
      has_run_warnings: true,
    });
    for (const width of [40, 56, 83, 120, 160, 240]) {
      const result = frame([row], { width, theme: styled });
      const text = header(result, row.agent_id);
      assert.match(text, marker, `${status}/${width}: ${text}`);
      const warning = text.search(/run warning|warn|!/);
      const pending = text.search(/2 pending|2pend/);
      assert(warning >= 0 && pending > warning, text);
      assert(pending < text.search(marker), text);
      if (state) {
        assert.match(text, state);
        assert(pending < text.search(state), text);
        assert(text.search(state) < text.search(marker), text);
      }
      if (width >= 160) {
        assert.match(text, /Review task \(turn limit reached\)$/);
        if (status === "failed") assert.match(text, /failed: SDK broke/);
      }
      assert(result.lines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("the full failure cause and limit suffix displace optional model and ordinary metrics", () => {
  const error = "Error: SESSION_UNAVAILABLE (sdk_error): Error: SDK broke";
  const row = run("worker", {
    name: "",
    status: "failed",
    error,
    model: "controlled",
    effort: "off",
    limit_reached: true,
    description: "Check diagnostics",
  });
  const result = frame([row], { width: 120 });
  const text = header(result, row.agent_id);
  assert(text.includes(`failed: ${error}`), text);
  assert.match(text, /Check.* \(turn limit reached\)$/);
  assert.doesNotMatch(text, /controlled\/off/);
  assert(result.lines.every((line) => visibleWidth(line) <= 120));
});

test("warning color belongs to the suffix, not the title; pressure and completed glyph retain their tints", () => {
  for (const status of ["completed", "running", "failed"]) {
    const paints = [];
    const th = {
      ...styled,
      fg: (color, text) => {
        paints.push([color, text]);
        return styled.fg(color, text);
      },
    };
    const row = run("otter", {
      status,
      limit_reached: true,
      description: "Review title",
      turns: 80,
      max_turns: 100,
      runtime: { activity: "idle", context: { tokens: 900, context_window: 1000 } },
    });
    const result = frame([row], { width: 240, theme: th });
    assert.match(header(result, row.agent_id), /Review title \(turn limit reached\)$/);
    assert(paints.some(([color, text]) => color === "warning" && text === "(turn limit reached)"));
    assert(
      paints.some(
        ([color, text]) =>
          color === (status === "running" ? "text" : "muted") && text === "Review title",
      ),
    );
    assert(!paints.some(([color, text]) => color === "warning" && text.includes("Review")));
    for (const [color, token] of [
      ["warning", "↻80/100"],
      ["error", "ctx 90%"],
      [
        status === "completed" ? "warning" : status === "failed" ? "error" : "accent",
        status === "completed" ? "✓" : status === "failed" ? "✗" : "⠋",
      ],
    ])
      assert(
        paints.some(([tint, text]) => tint === color && text.trim() === token),
        `${color}:${token}`,
      );
  }
});

test("active sublines, clock placement, pagination and hits are untouched by the suffix", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    run(`live${index}`, {
      status: "running",
      turn_elapsed_ms: 61_000,
      channel: "thinking",
      thinking: "Inspect source",
      limit_reached: index % 2 === 0,
    }),
  );
  for (const maxLines of [3, 6, 13]) {
    for (const expanded of [false, true]) {
      for (let page = 0, pages = 1; page < pages; page++) {
        const options = {
          width: maxLines === 3 ? 40 : maxLines === 6 ? 80 : 160,
          maxLines,
          expanded,
          page,
          theme: styled,
        };
        const result = frame(rows, options);
        const baseline = frame(
          rows.map((row) => ({ ...row, limit_reached: false })),
          options,
        );
        pages = result.pagination?.pages ?? 1;
        assert.deepEqual(result.hits, baseline.hits);
        assert.deepEqual(result.pagination, baseline.pagination);
        for (const [index, line] of result.lines.entries()) {
          if (stripTerminalSequences(line).includes("⎿")) assert.equal(line, baseline.lines[index]);
          const id = result.hits[index];
          if (!id || stripTerminalSequences(line).includes("⎿")) continue;
          const text = stripTerminalSequences(line);
          assert.equal(
            text.includes("1m01s"),
            stripTerminalSequences(baseline.lines[index]).includes("1m01s"),
          );
          if (rows.find((row) => row.agent_id === id).limit_reached) assert.match(text, marker);
        }
      }
    }
  }
});

test("extremely small viewports keep bounded compact degradation", () => {
  for (const width of [1, 2, 3, 5, 8, 12, 20, 24, 30]) {
    const result = frame(
      [
        run("otter", {
          status: "failed",
          error: "SDK broke",
          limit_reached: true,
          pending_messages: 2,
          has_run_warnings: true,
        }),
      ],
      { width, theme: styled },
    );
    assert(
      result.lines.every((line) => visibleWidth(line) <= width),
      `${width}: ${result.lines}`,
    );
    assert.equal(result.hits[1], "otter");
  }
});
