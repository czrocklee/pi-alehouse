import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Public current-source projections only: no build, dist, host, provider or network.
// Run with HOME/XDG/PI/TMP isolated in the invoking shell, before these imports.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderWidget } = await jiti.import("../../src/orchestration/ui/widget-render.ts");
const { renderHeader, prepareWidgetRow, headerState } = await jiti.import(
  "../../src/orchestration/ui/widget-row.ts",
);
const plain = { fg: (_color, text) => text, bold: (text) => text };
const colors = { error: 31, warning: 33, dim: 90, muted: 35, text: 36, accent: 34, success: 32 };
const styled = {
  fg: (color, text) => `\x1b[${colors[color] ?? 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};
const run = (id, overrides = {}) => ({
  agent_id: id,
  run_id: `${id}-run`,
  resident: true,
  status: "completed",
  name: "otter",
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
const frame = (runs, options = {}) => {
  const result = renderWidget({
    runs,
    owner: { blocked: false, resident: runs.length, resident_limit: 12 },
    spinnerFrame: 0,
    width: 160,
    maxLines: 13,
    theme: plain,
    shouldShowFinished: () => true,
    ...options,
  });
  assert(result.lines.every((line) => visibleWidth(line) <= (options.width ?? 160)));
  return result;
};
const paintedHeader = (result, id) => {
  const index = result.hits.indexOf(id);
  assert(index >= 0, `missing identity hit ${id}: ${result.lines}`);
  return result.lines[index];
};
const header = (result, id) => stripTerminalSequences(paintedHeader(result, id));
const warningPending = { has_run_warnings: true, pending_messages: 1 };
const question = () =>
  run("question", { ...warningPending, status: "needs_input", question: true });
const rawHeader = (row, width) =>
  renderHeader(
    row,
    "⠋",
    headerState(row),
    row.status === "running" || row.status === "cancelling",
    plain,
    width,
    null,
    prepareWidgetRow(row, true),
  );
const legalGroups = /\((?:worker\/d3|123pend|123 pending|limit|turn limit reached)\)/g;
const assertWholeGroups = (line, label) => {
  assert.doesNotMatch(line.replace(legalGroups, ""), /[()]/, `${label}: ${line}`);
  assert.doesNotMatch(line, /\(lim…|\(turn[^)]*…|123pen…/, `${label}: ${line}`);
};

// Decode the final ANSI stream, not calls made to theme.fg (which may be discarded).
// One foreground entry per UTF-16 unit keeps offsets aligned with String.indexOf.
const ansiCells = (ansi) => {
  let text = "";
  const foreground = [];
  let color;
  let start = 0;
  // ANSI is the subject of this parser, not an accidental control in a matcher.
  // eslint-disable-next-line no-control-regex
  for (const match of ansi.matchAll(/\x1b\[([\d;]*)m/g)) {
    const chunk = ansi.slice(start, match.index);
    text += chunk;
    foreground.push(...Array(chunk.length).fill(color));
    for (const code of (match[1] || "0").split(";").map(Number)) {
      if (code === 0 || code === 39) color = undefined;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) color = code;
    }
    start = match.index + match[0].length;
  }
  const tail = ansi.slice(start);
  text += tail;
  foreground.push(...Array(tail.length).fill(color));
  assert.equal(text, stripTerminalSequences(ansi));
  return { text, foreground };
};
const assertTint = (cells, token, tint, from = 0) => {
  const at = cells.text.indexOf(token, from);
  assert(at >= 0, `${token}: ${cells.text}`);
  assert.deepEqual(
    cells.foreground.slice(at, at + token.length),
    Array(token.length).fill(colors[tint]),
    `${tint} ${token}: ${cells.text}`,
  );
  return at;
};

test("53→54 columns never trade a full identity/tag for an unreadable question title", () => {
  for (const width of [53, 54]) {
    const line = header(frame([question()], { width }), "question");
    assert.match(line, /otter \(worker\/d3\)/, `${width}: ${line}`);
    assert.match(
      line,
      /\((?:run warning · 1 pending · needs answer|warn 1 pending needs answer|! 1pend answer\?)\)$/,
      line,
    );
  }
});

for (const [status, extra, compact] of [
  ["cancelling", {}, "cancel"],
  ["running", { finishing: true }, "finish"],
]) {
  test(`40 columns preserve full name/tag and shared compact ${compact}, omitting title`, () => {
    const row = run("lifecycle", { ...warningPending, status, ...extra, description: "Task" });
    const line = header(frame([row], { width: 40, maxLines: 2 }), "lifecycle");
    const expected = `└─ ⠋ otter (worker/d3)  (! 1pend ${compact})`;
    assert.equal(visibleWidth(expected), 40, "the required complete row is feasible");
    assert.equal(line, expected);
  });
}

test("40-column CJK failure keeps a two-character name prefix, whole tag and facts, no title ellipsis", () => {
  const row = run("cjk", {
    ...warningPending,
    name: "复核🦉",
    description: "复核路径规范化及 lint 修复".repeat(3),
    status: "failed",
    error: "SDK broke",
  });
  const line = header(frame([row], { width: 40 }), "cjk");
  assert.match(line, /复核[^ ]* \(worker\/d3\)/, line);
  assert.match(line, /\(! 1pend failed\)$/, line);
  assert.doesNotMatch(line, /(?: {2}| → )…\s*\(/, line);
});

test("clipped optional titles require four literal cells, excluding ellipsis", () => {
  const description = "Review controller lifecycle and pending input";
  for (let width = 40; width <= 60; width++) {
    const line = header(frame([{ ...question(), description }], { width }), "question");
    const title = line.match(/(?: {2}| → )((?:R[^()]*)|…)\s+\((?:!|warn|run warning)/)?.[1];
    if (title !== undefined) {
      const literal = title.trimEnd().replace(/…$/, "").trimEnd();
      assert(
        visibleWidth(literal) >= 4,
        `${width}: unreadable title ${JSON.stringify(title)}: ${line}`,
      );
      assert(description.startsWith(literal), `${width}: ${line}`);
    }
    assert.doesNotMatch(line, /(?: {2}| → )…\s*\(/, `${width}: ${line}`);
    assert.match(line, /1 pending|1pend/, `${width}: essential facts cannot vanish`);
  }
});

test("a complete short title is allowed below the four-cell truncation minimum", () => {
  const row = run("short", { description: "B", pending_messages: 1 });
  const line = header(frame([row], { width: 56 }), "short");
  assert.match(line, /B \(1 pending\)$/, line);
});

for (const description of ["", "B"]) {
  test(`two-row detail budgets preserve beta's wrapped cause with ${JSON.stringify(description)} title in either order`, () => {
    const rows = [
      run("alpha", {
        name: "alpha",
        status: "failed",
        description: "Review controller lifecycle and pending input".slice(0, 44),
        error: "boom",
      }),
      run("beta", {
        name: "beta",
        status: "failed",
        description,
        error: "Error: SESSION_UNAVAILABLE (sdk_error): Error: SDK broke because reset",
      }),
    ];
    for (const ordered of [rows, rows.toReversed()]) {
      const result = frame(ordered, { width: 120 });
      const beta = header(result, "beta");
      assert.match(beta, /SDK broke/, beta);
      assert.match(header(result, "alpha"), /failed: boom/, "alpha keeps its own cause");
      const detail = beta.match(/failed: (.*)\)$/)?.[1];
      assert(detail, `missing failure detail: ${beta}`);
      assert(visibleWidth(detail) <= 60, `the per-row detail ceiling remains 60 cells: ${beta}`);
    }
  });
}

test("22 columns keep the full 123 pending count when header-clock pressure removes activity", () => {
  for (const maxLines of [2, 3]) {
    const row = run("count", { status: "running", pending_messages: 123, turn_elapsed_ms: 61_000 });
    const rows = maxLines === 2 ? [row] : [row, run("peer", { status: "running", name: "mink" })];
    const result = frame(rows, { width: 22, maxLines });
    const line = header(result, "count");
    assert.match(line, /\(123(?:pend| pending)\)/, `${maxLines}: ${line}`);
    assert(!result.lines.some((text) => stripTerminalSequences(text).includes("⎿")));
  }
});

test("30–34 columns keep complete count and either a whole limit group or no limit", () => {
  const row = run("count", {
    status: "running",
    pending_messages: 123,
    turn_elapsed_ms: 61_000,
    limit_reached: true,
  });
  for (let width = 30; width <= 34; width++) {
    const line = header(frame([row], { width, maxLines: 2 }), "count");
    assert.match(line, /\(123(?:pend| pending)\)/, `${width}: ${line}`);
    assertWholeGroups(line, width);
  }
});

test("raw public headers obey their own 1–45-cell budget without outer widget clipping", () => {
  const row = run("raw", {
    status: "running",
    pending_messages: 123,
    turn_elapsed_ms: 61_000,
    limit_reached: true,
  });
  for (let budget = 1; budget <= 45; budget++) {
    const line = rawHeader(row, budget);
    assert(visibleWidth(line) <= budget, `${budget}: raw ${visibleWidth(line)} cells: ${line}`);
  }
});

test("raw tiny headers omit impossible groups whole, never leave dangling parentheses", () => {
  const row = run("raw", {
    status: "running",
    pending_messages: 123,
    turn_elapsed_ms: 61_000,
    limit_reached: true,
  });
  for (let budget = 1; budget <= 45; budget++) assertWholeGroups(rawHeader(row, budget), budget);
});

const longReview = (id) =>
  run(id, {
    name: "reviewer",
    model: "gpt-5.6-sol",
    effort: "high",
    description: "Review controller lifecycle and pending input ".repeat(10),
    pending_messages: 3,
    has_run_warnings: true,
    runtime: { context: { tokens: 850, context_window: 1000 } },
    cost: 0.5,
  });
const assertReadableTitle = (line) => {
  const title = line.match(/(Review[^()]*) \(run warning · 3 pending\)$/)?.[1];
  assert(title, `missing readable title/facts: ${line}`);
  assert(
    visibleWidth(title.replace(/…$/, "").trimEnd()) >= 24,
    `title alone needs 24 literal cells: ${line}`,
  );
};

test("120 columns yield model restoration before sacrificing a 24-cell long task title", () => {
  const line = header(frame([longReview("review")], { width: 120 }), "review");
  assertReadableTitle(line);
});

test("160 columns can retain the model alongside a readable long title and complete facts", () => {
  const line = header(frame([longReview("review")], { width: 160 }), "review");
  assert.match(line, /gpt-5\.6-sol\/high/, line);
  assertReadableTitle(line);
});

test("82–89 column grid boundary retains an identifying SDK cause before optional long limit wording", () => {
  const row = run("failed", {
    status: "failed",
    error: "SDK broke",
    has_run_warnings: true,
    pending_messages: 2,
    limit_reached: true,
  });
  for (let width = 82; width <= 89; width++) {
    const line = header(frame([row], { width }), "failed");
    assert.match(line, /SDK/, `${width}: failure cause disappeared: ${line}`);
    assert.match(line, /2 pending|2pend/, `${width}: ${line}`);
    assert.match(line, /\((?:turn limit reached|limit)\)$/, `${width}: ${line}`);
  }
});

test("final ANSI failure stream orders independently colored facts, dim punctuation and warning limit", () => {
  const row = run("colors", {
    status: "failed",
    error: "SDK broke",
    has_run_warnings: true,
    pending_messages: 2,
    limit_reached: true,
  });
  const cells = ansiCells(paintedHeader(frame([row], { width: 240, theme: styled }), "colors"));
  const title = assertTint(cells, "Review task", "muted");
  const warning = assertTint(cells, "run warning", "error", title);
  const pending = assertTint(cells, "2 pending", "warning", warning);
  const failed = assertTint(cells, "failed: SDK broke", "error", pending);
  const limit = assertTint(cells, "(turn limit reached)", "warning", failed);
  assert(title < warning && warning < pending && pending < failed && failed < limit);
  assertTint(cells, "(", "dim", title);
  assertTint(cells, " · ", "dim", warning);
  assertTint(cells, " · ", "dim", pending);
  assertTint(cells, ")", "dim", failed);
});

test("final ANSI running stream keeps task text independent of warning/pending/limit tints", () => {
  const row = run("colors", {
    status: "running",
    has_run_warnings: true,
    pending_messages: 3,
    limit_reached: true,
  });
  const cells = ansiCells(paintedHeader(frame([row], { width: 240, theme: styled }), "colors"));
  const title = assertTint(cells, "Review task", "text");
  const warning = assertTint(cells, "run warning", "error", title);
  const pending = assertTint(cells, "3 pending", "warning", warning);
  const limit = assertTint(cells, "(turn limit reached)", "warning", pending);
  assert(title < warning && warning < pending && pending < limit);
  assertTint(cells, "(", "dim", title);
  assertTint(cells, " · ", "dim", warning);
  assertTint(cells, ")", "dim", pending);
});
