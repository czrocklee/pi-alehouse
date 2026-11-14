import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// No SDK/source module may observe real HOME, Pi state or temporary caches.
const home = mkdtempSync("/tmp/alehouse-turn-limit-suffix-");
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ...["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
    `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
    join(home, "xdg", kind.toLowerCase()),
  ]),
  ...["TMPDIR", "TMP", "TEMP"].map((key) => [key, join(home, "tmp")]),
]) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const { createJiti } = await import("jiti");
const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");

// Exercise current source without a build or a dependency on dist output.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderWidget } = await jiti.import("../../src/orchestration/ui/widget-render.ts");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const CODE = { warning: 33, error: 31, dim: 90, muted: 35, text: 36, accent: 34 };
const styled = {
  fg: (color, text) => `\x1b[${CODE[color] ?? 37}m${text}\x1b[0m`,
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
const spans = (text) =>
  text.split("\x1b[").flatMap((part) => {
    const match = /^(\d+)m(.*)$/s.exec(part);
    return match && Number(match[1]) !== 0 ? [[Number(match[1]), match[2]]] : [];
  });

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
      assert.doesNotMatch(line, /\(\s*\)/, "no empty attention group trails a quiet row");
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
        assert.match(text, /\botter\b/, `${width}: ${text}`);
        if (title) {
          const titleAt = text.indexOf(title);
          if (width >= 56) assert(titleAt >= 0, `${width}: readable title fits: ${text}`);
          if (titleAt >= 0) {
            assert(titleAt < text.search(marker), text);
            const shown = text.slice(titleAt, text.search(marker)).trim();
            assert(
              visibleWidth(shown.replace(/…/g, "")) >= 4,
              `title clipping must retain >=4 literal cells: ${width}: ${text}`,
            );
          } else {
            // A tight row may omit the whole optional title, but only while
            // retaining the full identity/tag and complete terminal limit.
            assert.match(text, /otter \(worker\/d3\)/, `${width}: ${text}`);
            assert.match(text, marker, text);
            assert.doesNotMatch(text, /…/, `no lone ellipsis/partial title: ${text}`);
          }
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

test("pending, warnings and lifecycle attention merge into the task field before the trailing limit group", () => {
  for (const [status, extra, state] of [
    ["completed", {}, undefined],
    ["running", {}, undefined],
    ["running", { finishing: true }, /\b(?:finishing|finish)\b/],
    ["cancelling", {}, /\b(?:cancelling|cancel)\b/],
    ["queued", {}, /queued/],
    ["needs_input", { question: true }, /needs answer|answer\?/],
    ["needs_input", {}, /needs input|input\?/],
    ["failed", { error: "SDK broke" }, /failed/],
    ["cancelled", {}, /\b(?:cancelled|cancel)\b/],
  ]) {
    const row = run("otter", {
      status,
      ...extra,
      limit_reached: true,
      pending_messages: 2,
      has_run_warnings: true,
    });
    const before = structuredClone(row);
    const fullLifecycle = extra.finishing
      ? "finishing"
      : status === "cancelling" || status === "cancelled"
        ? status
        : undefined;
    for (const width of [40, 56, 83, 120, 160, 240]) {
      const result = frame([row], { width, theme: styled });
      const text = header(result, row.agent_id);
      assert.match(text, marker, `${status}/${width}: ${text}`);
      const warning = text.search(/run warning|warn|!/);
      const pending = text.search(/2 pending|2pend/);
      assert(warning >= 0 && pending > warning, text);
      // The merged group trails the title and precedes the limit group.
      if (text.includes("Review task")) assert(text.indexOf("Review task") < warning, text);
      assert(warning < text.search(marker), text);
      if (state) {
        assert.match(text, state);
        assert(pending < text.search(state), text);
        assert(text.search(state) < text.search(marker), text);
      }
      if (width >= 160) {
        assert.match(text, /Review task \(run warning · 2 pending[^()]*\) \(turn limit reached\)$/);
        if (status === "failed") assert.match(text, /failed: SDK broke/);
        if (fullLifecycle)
          assert(
            text.endsWith(
              `Review task (run warning · 2 pending · ${fullLifecycle}) (turn limit reached)`,
            ),
            `wide rows retain the full lifecycle spelling: ${text}`,
          );
      }
      if (fullLifecycle)
        assert(
          text.startsWith(status === "cancelled" ? "└─ ■ " : "└─ ⠋ "),
          `compact wording must not change the lifecycle glyph: ${text}`,
        );
      assert.equal(result.hits[1], row.agent_id);
      assert(result.lines.every((line) => visibleWidth(line) <= width));
      assert.deepEqual(row, before, "compact lifecycle painting is an immutable projection");
    }
  }
});

test("the full failure cause and limit group displace optional model and ordinary metrics", () => {
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
  // The title leads and the merged group carries the cause before the limit.
  assert(text.indexOf("Check diagno") < text.indexOf(`failed: ${error}`), text);
  assert.match(text, /Check.* \(turn limit reached\)$/);
  assert.doesNotMatch(text, /controlled\/off/);
  assert(result.lines.every((line) => visibleWidth(line) <= 120));
});

test("warning color belongs to the suffix, not the title; pressure and completed glyph retain their tints", () => {
  for (const status of ["completed", "running", "failed"]) {
    const th = styled;
    const row = run("otter", {
      status,
      limit_reached: true,
      description: "Review title",
      turns: 80,
      max_turns: 100,
      runtime: { activity: "idle", context: { tokens: 900, context_window: 1000 } },
    });
    const result = frame([row], { width: 240, theme: th });
    // A real failure keeps its state fact in the merged group before the limit.
    assert.match(
      header(result, row.agent_id),
      status === "failed"
        ? /Review title \(failed\) \(turn limit reached\)$/
        : /Review title \(turn limit reached\)$/,
    );
    const painted = spans(result.lines[result.hits.indexOf(row.agent_id)]);
    const titleAt = painted.findIndex(([, text]) => text === "Review title");
    assert(titleAt >= 0, header(result, row.agent_id));
    assert.deepEqual(
      painted.slice(titleAt),
      status === "failed"
        ? [
            [35, "Review title"],
            [90, "("],
            [31, "failed"],
            [90, ")"],
            [33, "(turn limit reached)"],
          ]
        : [
            [status === "running" ? 36 : 35, "Review title"],
            [33, "(turn limit reached)"],
          ],
      "the emitted suffix includes both warning-colored parentheses, never the title",
    );
    for (const [color, token] of [
      ["warning", "↻80/100"],
      ["error", "ctx 90%"],
      [
        status === "completed" ? "warning" : status === "failed" ? "error" : "accent",
        status === "completed" ? "✓" : status === "failed" ? "✗" : "⠋",
      ],
    ])
      assert.deepEqual(
        painted
          .filter(([, text]) => text.trim() === token)
          .map(([code, text]) => [code, text.trim()]),
        [[CODE[color], token]],
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

test("extremely small viewports keep bounded compact degradation", async (t) => {
  for (const width of [1, 2, 3, 5, 8, 12, 20, 24, 30]) {
    await t.test(`whole groups at ${width}`, () => {
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
      const text = header(result, "otter");
      assert.equal((text.match(/\(/g) ?? []).length, (text.match(/\)/g) ?? []).length, text);
      assert.doesNotMatch(text, /\([^)]*$|\(\s*\)|\([^)]*…|\([^)]*\(/, text);
      for (const group of text.match(/\([^)]*\)/g) ?? [])
        assert.match(
          group,
          /^\((?:turn limit reached|limit|(?:run warning|warn|!)(?: · | )2(?: pending|pend)(?: · | )failed)\)$/,
          text,
        );
      assert.doesNotMatch(
        text.replace(/\([^)]*\)/g, ""),
        /pending|pend|failed|warning|warn|limit|[()!]/,
        text,
      );
    });
  }
  // Include the 3-cell tree: quiet short limit costs 3+2+5+3+7=20;
  // with pending, 3+2+5+2+7+1+7=27 fits at 30, not 24.
  for (const [width, pending] of [
    [20, 0],
    [30, 2],
  ]) {
    await t.test(`complete short limit at ${width}/pending=${pending}`, () => {
      const row = run("otter", { limit_reached: true, pending_messages: pending });
      const before = structuredClone(row);
      const result = frame([row], { width });
      const text = header(result, "otter");
      assert.match(text, /\botter\b/, text);
      assert.match(text, /\(limit\)$/, text);
      if (pending) assert.match(text, /\(2pend\) \(limit\)$/, text);
      else assert.doesNotMatch(text, /pending|pend/, text);
      assert.doesNotMatch(text, /\([^)]*…|\([^)]*$/, text);
      assert(result.lines.every((line) => visibleWidth(line) <= width));
      assert.equal(result.hits[1], "otter");
      assert.deepEqual(row, before);
    });
  }
});
