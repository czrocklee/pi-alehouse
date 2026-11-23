import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Direct source tests: the pane integration is a separate lane; these exercise
// the pure title, bottom-dock and footer-menu layout helpers, no build needed.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailTitle, renderDetailSummary, renderDetailFooter } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
const { addToLedger } = await jiti.import("../../src/orchestration/core/usage-ledger.ts");
const { widgetCost } = await jiti.import("../../src/orchestration/ui/widget-cost.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const ansi = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
/** Records every colour a paint asks for, keeping the text itself plain. */
const recorder = () => {
  const calls = [];
  return {
    calls,
    theme: { fg: (color, text) => (calls.push([color, text]), text), bold: (t) => t },
  };
};

const settings = (overrides = {}) => ({
  provider: "anthropic",
  model: "claude-opus-5",
  thinking: "medium",
  parent_thinking: "medium",
  thinking_resolution: "identity",
  profile: "editor",
  difficulty: 3,
  strength: "d3",
  preset: "team",
  preset_version: "v2",
  selection_digest: "1".repeat(64),
  cwd: "/workspace/project",
  tools: ["read", "grep", "find", "ls"],
  definition_digest: "0".repeat(64),
  context_mode: "none",
  ...overrides,
});
const spend = (input, output, cache_read, cache_write, cost, model = "anthropic/claude-opus-5") =>
  addToLedger(undefined, { input, output, cache_read, cache_write, cost }, model);
const view = (overrides = {}) => ({
  owner_id: "o",
  generation: "g",
  agent_id: "a-19b7",
  run_id: "r-8f3a",
  name: "reviewer",
  task: 4,
  description: "Review the lifecycle contract",
  effective_settings: settings(),
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 93_000,
  turn_elapsed_ms: 1_100,
  turns: 3,
  max_turns: 256,
  runtime: { activity: "generating", context: { tokens: 59_000, context_window: 500_000 } },
  usage: spend(20_000, 5_000, 60_000, 0, 1.234),
  cleanup_errors: [],
  discarded_inputs: [],
  ...overrides,
});
const live = (overrides = {}) => ({ active_tools: [], tool_uses: 12, preview: "", ...overrides });
const input = (v = {}, l = {}) => ({ view: view(v), live: live(l) });
const row = (v = {}, width = 120, options = {}) =>
  renderDetailSummary(input(v), theme, width, { activity: false, ...options })[0];

// ---- The bottom dock: one status-led metrics row ----

test("the dock is one glyph-led row: model, turns, context, usage, cost, elapsed, turn clock", () => {
  const rows = renderDetailSummary(input(), theme, 120);
  assert.equal(rows.length, 1, "the default dock is exactly one row");
  const text = rows[0];
  const order = [
    /^⠋ · /,
    /claude-opus-5\/medium/,
    /↻3\/256/,
    /ctx ≈59k\/500k/,
    /↑80k \(75\.0%\) ↓5\.0k/,
    /\$1\.23/,
    /1m33s/,
    /turn 1s$/,
  ];
  let at = -1;
  for (const pattern of order) {
    const found = text.slice(at + 1).search(pattern);
    assert.ok(found >= 0, `${pattern}: ${text}`);
    at += found + 1;
  }
  assert.ok(visibleWidth(text) <= 120, text);
  // Normal running work is glyph-only at the metrics start; the context keeps
  // its own `ctx` label, the elapsed time is bare, and the live turn clock is
  // last. No context percent, tool-call count, ≤ turns form or task repetition.
  assert.doesNotMatch(text, /running/, "a normal running status needs no label");
  for (const retired of [/≈\S+ \d+%/, /▸/, /≤/, /total/, /\(1s\)/, /Review the lifecycle contract/])
    assert.doesNotMatch(text, retired, `${retired}: ${text}`);
  assert.ok(text.includes(widgetCost(1.234)), "cost reuses the widget's exact cents");
  assert.equal(renderDetailSummary(input(), theme, 120, { activity: false }).length, 1);
});

test("the Fast icon prefixes an intact model label without displacing other metrics", () => {
  const data = input({
    effective_settings: settings({
      provider: "openai-codex",
      model: "gpt-6.2-sol",
      thinking: "xhigh",
    }),
  });
  for (const glyph of ["⚡", "⚡⚡"]) {
    const paint = recorder();
    const wide = renderDetailSummary(data, paint.theme, 120, { modelSpeedGlyph: glyph })[0];
    assert.ok(wide.includes(` · ${glyph} gpt-6.2-sol/xhigh · `));
    assert(paint.calls.some(([tone, text]) => tone === "warning" && text === glyph));
    assert.doesNotMatch(renderDetailSummary(data, theme, 20, { modelSpeedGlyph: glyph })[0], /⚡/);
    for (let width = 0; width <= 120; width++) {
      const ordinary = renderDetailSummary(data, ansi, width)[0];
      const decorated = renderDetailSummary(data, ansi, width, { modelSpeedGlyph: glyph })[0];
      assert(visibleWidth(decorated) <= width);
      const plain = stripTerminalSequences(decorated);
      if (plain.includes("⚡")) assert.ok(plain.includes(`· ${glyph} gpt-6.2-sol/xhigh`));
      assert.equal(plain.replace(`${glyph} `, ""), stripTerminalSequences(ordinary));
    }
  }
  assert.doesNotMatch(renderDetailSummary(data, theme, 120)[0], /⚡/);
});

test("the current-turn clock is whole, floored seconds at the very end", () => {
  assert.match(row({ turn_elapsed_ms: 18_000 }), /turn 18s$/);
  assert.match(row({ turn_elapsed_ms: 1_100 }), /turn 1s$/);
  assert.match(row({ turn_elapsed_ms: 62_000 }), /turn 1m02s$/);
  assert.match(row({ turn_elapsed_ms: 59_900 }), /turn 59s$/);
  assert.match(row({ turn_elapsed_ms: 900 }), /turn 0s$/);
  // No decimal tenth survives the floor, at any magnitude: one spelling per
  // magnitude, so a tick never changes the clock's own shape.
  for (const ms of [1_100, 9_900, 59_900, 60_500, 599_900])
    assert.doesNotMatch(row({ turn_elapsed_ms: ms }), /turn \d+(?:m\d{2})?\.\d+s/);
});

test("the clock rides only an actually live running turn", () => {
  for (const [label, overrides] of [
    ["finishing", { finalization_pending: true }],
    ["exited", { execution_exited: true }],
    ["queued", { status: "queued" }],
    ["untimed", { turn_elapsed_ms: undefined }],
    ["settled", { status: "completed", execution_exited: true }],
  ]) {
    const text = row(overrides);
    assert.doesNotMatch(text, /turn \d/, `${label}: ${text}`);
    assert.doesNotMatch(text, /\(\d+(?:m\d{2})?s\)/, `${label}: no parenthesized clock`);
  }
});

test("a minute-long turn tints the clock as a warning, presentation only", () => {
  const quickPaint = recorder();
  renderDetailSummary(input(), quickPaint.theme, 120, { activity: false });
  assert.ok(
    quickPaint.calls.some(([color, text]) => color === "dim" && text === "turn 1s"),
    "a sub-minute clock stays dim",
  );
  const slow = recorder();
  renderDetailSummary(input({ turn_elapsed_ms: 62_000 }), slow.theme, 120, { activity: false });
  assert.ok(
    slow.calls.some(([color, text]) => color === "warning" && text === "turn 1m02s"),
    "a minute-long clock is a warning cue",
  );
});

test("the trailing clock reserves nothing after it", () => {
  // No trailing padding: the painted row ends at the clock's own last cell.
  for (const ms of [900, 9_000, 30_000, 59_900, 300_000, 599_900]) {
    const text = row({ turn_elapsed_ms: ms }, 120);
    assert.equal(text, text.trimEnd(), `${ms}: no trailing reservation hole`);
    assert.match(text, /turn \d+(?:m\d{2})?s$/, `${ms}: the clock closes the row`);
  }
  // The clock's own growth never shifts the figures before it: they are all
  // painted before the last segment, so no reservation is needed.
  const prefix = (ms) => {
    const text = row({ turn_elapsed_ms: ms }, 120);
    return text.slice(0, text.indexOf(" · turn "));
  };
  const base = prefix(900);
  for (const ms of [900, 9_000, 59_900, 60_000, 599_000, 600_000, 6_000_000])
    assert.equal(prefix(ms), base, `${ms}: preceding figures hold their columns`);
  // Ten and a hundred minutes each add one clock cell, only at the end.
  for (const [ms, clock] of [
    [600_000, "turn 10m00s"],
    [6_000_000, "turn 100m00s"],
  ]) {
    const text = row({ turn_elapsed_ms: ms });
    assert.ok(text.endsWith(clock), `${ms}: ${text}`);
    assert.ok(visibleWidth(text) <= 120, `${ms}: ${text}`);
  }
});

test("the figures before the clock hold their columns while it ticks", () => {
  const prefix = (ms) => {
    const text = row({ turn_elapsed_ms: ms }, 120);
    return text.slice(0, text.indexOf(" · turn "));
  };
  const base = prefix(1_100);
  for (const ms of [1_100, 9_900, 10_000, 18_000, 59_900, 60_000, 599_000])
    assert.equal(prefix(ms), base, `${ms}: the prefix is stable`);
  // The row is not padded to a reserved width: the clock is the last cell.
  assert.ok(!row({ turn_elapsed_ms: 1_100 }, 120).includes("  "), "no reserved gap");
});

test("the status glyph follows the caller's spinner frame", () => {
  const glyphs = [0, 1, 2, 3].map(
    (frame) =>
      renderDetailSummary(input(), theme, 40, { activity: false, spinnerFrame: frame })[0][0],
  );
  assert.deepEqual(glyphs, ["⠋", "⠙", "⠹", "⠸"]);
});

// ---- Unknowns, floors and the exact figures ----

test("context keeps only its token figures, tinted by the true percent", () => {
  const context = (tokens) => ({
    activity: "generating",
    context: { tokens, context_window: 500_000 },
  });
  const hot = recorder();
  renderDetailSummary(input({ runtime: context(459_000) }), hot.theme, 60, { activity: false });
  assert.ok(hot.calls.some(([color, text]) => color === "error" && text === "ctx ≈459k/500k"));
  const warm = recorder();
  renderDetailSummary(input({ runtime: context(350_000) }), warm.theme, 60, { activity: false });
  assert.ok(warm.calls.some(([color, text]) => color === "warning" && text === "ctx ≈350k/500k"));
  const cool = recorder();
  renderDetailSummary(input({ runtime: context(59_000) }), cool.theme, 60, { activity: false });
  assert.ok(cool.calls.some(([color, text]) => color === "dim" && text === "ctx ≈59k/500k"));
  // Unknown tokens stay unknown: no invented zero or percent; the ctx label
  // marks the estimate without inventing a figure.
  const unknown = row({ runtime: context(null) }, 60);
  assert.match(unknown, /ctx \?\/500k/);
  assert.doesNotMatch(unknown, /0%|\?%/);
});

test("usage is the Run's cumulative input with its cache hit, and its output", () => {
  assert.match(row(), /↑80k \(75\.0%\) ↓5\.0k/);
  // One-decimal hit rate on the shared compact token spellings.
  assert.match(row({ usage: spend(61_200, 3_100, 19_900, 0, null) }), /↑81k \(24\.5%\) ↓3\.1k/);
  // A partial response leaves floors, and the ratio is never fabricated.
  const partial = addToLedger(
    spend(20_000, 5_000, 60_000, 0, 1.5),
    { input: null, output: 0, cache_read: null, cache_write: 100, cost: null },
    "anthropic/claude-opus-5",
  );
  const text = row({ usage: partial });
  assert.match(text, /↑≥80k ↓5\.0k/);
  assert.doesNotMatch(text, /%\)/);
  assert.match(text, /≥\$1\.50/);
  // Unknown components are "?", never zero, never a ratio.
  const unknown = row({ usage: spend(1_000, 50, null, null, null) });
  assert.match(unknown, /↑\? ↓50/);
  assert.doesNotMatch(unknown, /≥|%\)/);
  // A partial output keeps its own floor without touching the input group.
  const outputFloor = addToLedger(
    spend(20_000, 5_000, 60_000, 0, null),
    { input: 0, output: null, cache_read: 0, cache_write: 0, cost: null },
    "anthropic/claude-opus-5",
  );
  assert.match(row({ usage: outputFloor }), /↑80k \(75\.0%\) ↓≥5\.0k/);
  // An overflowed sum is unknown, not a rate: no 0.0% against Infinity.
  const overflow = row({ usage: spend(1e308, 5_000, 1e308, 1e308, null) });
  assert.match(overflow, /↑\? ↓5\.0k/);
  assert.doesNotMatch(overflow, /%\)|0\.0%/);
});

test("cost reuses the widget's cents exactly, with floors for partial spend", () => {
  assert.ok(row().includes(widgetCost(1.234)));
  assert.match(row({ usage: spend(20_000, 5_000, 60_000, 0, 0.004) }), /<\$0\.01/);
  assert.match(row({ usage: spend(20_000, 5_000, 60_000, 0, 0) }), /\$0\.00/);
  const partial = addToLedger(
    spend(20_000, 5_000, 60_000, 0, 2.5),
    { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: null },
    "anthropic/claude-opus-5",
  );
  assert.match(row({ usage: partial }), /≥\$2\.50/);
  // No ledger, no cost: nothing is invented.
  assert.doesNotMatch(row({ usage: undefined }), /\$/);
  assert.match(row({ usage: undefined }), /↻3\/256/, "turns remain real telemetry");
});

test("dock pairs Run and Agent cost, preserving floors and unknowns", () => {
  const usage = spend(1, 1, 0, 0, 0.4);
  const partial = addToLedger(
    usage,
    { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: null },
    "anthropic/claude-opus-5",
  );
  for (const [u, total, expected] of [
    [usage, { amount: 1.25, partial: false }, "$0.40/1.25"],
    [partial, { amount: 1.25, partial: true }, "≥$0.40/1.25"],
    [usage, { amount: 1.25, partial: true }, "$0.40/≥1.25"],
    [undefined, { amount: 1.25, partial: false }, "?/$1.25"],
    [usage, undefined, "$0.40/?"],
  ])
    assert.ok(row({ usage: u, agent_cost: total }).includes(expected), expected);
  assert.doesNotMatch(row({ usage: undefined, agent_cost: undefined }), /\$/);
});

test("the cumulative elapsed time is bare and precedes the live clock", () => {
  assert.match(row(), /· 1m33s · turn 1s$/);
  assert.doesNotMatch(row(), /total/);
  assert.doesNotMatch(row(), /\(1m33s\)/);
  assert.match(row({ elapsed_ms: 4_000 }), /· 4\.0s · turn 1s$/);
});

// ---- The adaptive ladder: what yields, and in which order ----

const pricedRow = (width) => row({ agent_cost: { amount: 12.45, partial: false } }, width);

test("the model shortens first; whole figures then yield least urgent first", () => {
  // One cell short of the full row: only the model shortens, nothing drops.
  assert.equal(
    pricedRow(101),
    "⠋ · claude-opus-5/medi… · ↻3/256 · ctx ≈59k/500k · ↑80k (75.0%) ↓5.0k · $1.23/12.45 · 1m33s · turn 1s",
  );
  assert.equal(
    pricedRow(99),
    "⠋ · claude-opus-5/me… · ↻3/256 · ctx ≈59k/500k · ↑80k (75.0%) ↓5.0k · $1.23/12.45 · 1m33s · turn 1s",
  );
  // The cumulative elapsed time is the least priority: it drops first.
  assert.equal(
    pricedRow(86),
    "⠋ · claude-opus… · ↻3/256 · ctx ≈59k/500k · ↑80k (75.0%) ↓5.0k · $1.23/12.45 · turn 1s",
  );
  // Then the cache percentage yields, while the token figures stay.
  assert.equal(
    pricedRow(76),
    "⠋ · claude-op… · ↻3/256 · ctx ≈59k/500k · ↑80k ↓5.0k · $1.23/12.45 · turn 1s",
  );
  // Then the whole usage group, then cost, then routine turns.
  assert.equal(pricedRow(63), "⠋ · claude-op… · ↻3/256 · ctx ≈59k/500k · $1.23/12.45 · turn 1s");
  assert.equal(pricedRow(49), "⠋ · claude-op… · ↻3/256 · ctx ≈59k/500k · turn 1s");
  // Routine turns yield before the live clock; the model reclaims their cells.
  assert.equal(pricedRow(44), "⠋ · clau… · ↻3/256 · ctx ≈59k/500k · turn 1s");
  assert.equal(pricedRow(43), "⠋ · claude-opus-… · ctx ≈59k/500k · turn 1s");
  // Then the shortened model: the glyph, context and live clock are essential.
  assert.equal(pricedRow(32), "⠋ · ctx ≈59k/500k · turn 1s");
  // The clock outlasts every routine figure, then yields before the context.
  assert.equal(pricedRow(26), "⠋ · ctx ≈59k/500k");
  assert.equal(pricedRow(17), "⠋ · ctx ≈59k/500k");
  // Once the context yields, the live clock returns beside the bare glyph.
  assert.equal(pricedRow(16), "⠋ · turn 1s");
  assert.equal(pricedRow(12), "⠋ · turn 1s");
  assert.equal(pricedRow(10), "⠋");
  assert.equal(pricedRow(1), "⠋");
  assert.equal(pricedRow(0), "");
});

test("elevated turn pressure outlasts the shortened model", () => {
  const elevated = row({ turns: 205, max_turns: 256 }, 45);
  assert.match(elevated, /↻205\/256/);
  assert.doesNotMatch(elevated, /claude-opus-5/);
  assert.match(elevated, /≈59k\/500k/);
  assert.match(elevated, /turn 1s$/);
  const routine = row({}, 45);
  assert.match(routine, /↻3\/256/, "routine turns still fit at this width");
  assert.match(routine, /claud…/, "the remaining model reclaims room");
});

test("ambiguous lifecycle states keep readable labels; normal work is glyph-only", () => {
  const asked = row({
    status: "needs_input",
    outcome: { status: "needs_input", question: "Which branch?", limit_reached: false },
  });
  assert.match(asked, /^\? needs answer · /);
  const plain = row({ status: "needs_input" });
  assert.match(plain, /^\? needs input · /);
  assert.doesNotMatch(plain, /needs_input/);
  // The compact spellings match the widget's header too.
  assert.equal(
    row(
      {
        status: "needs_input",
        outcome: { status: "needs_input", question: "Which branch?", limit_reached: false },
      },
      12,
    ).trimEnd(),
    "? answer?",
  );
  assert.equal(row({ status: "needs_input" }, 12).trimEnd(), "? input?");
  // Every other ambiguous status keeps the shared runPresentation label.
  assert.match(row({ status: "queued" }), /^◦ queued · /);
  assert.match(row({ status: "cancelling" }), /^⠋ cancelling · /);
  assert.match(row({ status: "failed" }), /^✗ failed · /);
  assert.match(row({ status: "cancelled" }), /^■ cancelled · /);
  assert.match(row({ finalization_pending: true }), /^⠋ finishing · /);
  // Normal running and completed work start with the glyph alone.
  assert.match(row(), /^⠋ · /);
  assert.match(row({ status: "completed", execution_exited: true }), /^✓ · /);
  assert.doesNotMatch(row({ status: "completed", execution_exited: true }), /completed/);
});

test("a running Run whose execution already exited keeps its readable label and no clock", () => {
  // `running` with `execution_exited` is ambiguous: the glyph alone would
  // claim live work. Keep the label, and never revive the live turn clock.
  const text = row({ execution_exited: true, turn_elapsed_ms: 1_100 });
  assert.match(text, /^⠋ running · /, text);
  assert.doesNotMatch(text, /turn \d/, text);
  assert.doesNotMatch(text, /\(\d+(?:m\d{2})?s\)/, text);
  assert.notEqual(text, row(), "only a live, unambiguous running turn is glyph-only");
});

test("the context pair is retained whenever the glyph and clock can hold it", () => {
  // The bare glyph plus the labelled context pair needs 17 cells; the live
  // clock needs 11. Context outlasts the clock, then the clock returns.
  for (let width = 0; width <= 40; width++) {
    const text = row({}, width);
    if (width >= 17) assert.ok(text.includes("ctx ≈59k/500k"), `${width}: ${text}`);
    else assert.doesNotMatch(text, /≈59k/, `${width}: ${text}`);
  }
  // Once the context yields, the freed row takes back the live clock at
  // 11..16 cells, never a needless bare glyph.
  assert.equal(row({}, 16).trimEnd(), "⠋ · turn 1s");
  assert.equal(row({}, 12).trimEnd(), "⠋ · turn 1s");
  assert.equal(row({}, 11).trimEnd(), "⠋ · turn 1s");
  assert.match(row({}, 10), /^⠋$/);
});

test("every width fits, and numeric facts are never clipped mid-figure", () => {
  for (let width = 0; width <= 120; width++) {
    const text = pricedRow(width);
    assert.ok(visibleWidth(text) <= width, `${width}: ${JSON.stringify(text)}`);
    if (width >= 1) assert.match(text, /⠋/, `${width}: the glyph survives`);
    if (text.includes("↻")) assert.match(text, /↻\d+\/\d+/, `${width}: whole turns`);
    if (text.includes("↑"))
      assert.match(text, /↑\S+(?: \(\d+(?:\.\d)?%\))? ↓\S+/, `${width}: whole usage`);
    // A surviving Agent amount without its Run side would have no currency sign.
    const costs = text.split(" · ").filter((part) => /\$|^[\d./?…]+$/.test(part));
    if (costs.length) assert.deepEqual(costs, ["$1.23/12.45"], `${width}: whole cost pair`);
  }
});

test("CJK and ANSI content is measured in cells, never code points", () => {
  const cjk = input({ effective_settings: settings({ model: "測試模型", thinking: "低" }) });
  for (const width of [60, 40, 30, 24, 16, 8]) {
    const text = renderDetailSummary(cjk, ansi, width, { activity: false })[0];
    assert.ok(visibleWidth(text) <= width, `${width}: ${JSON.stringify(text)}`);
    const bare = stripTerminalSequences(text);
    assert.doesNotMatch(bare, /\p{Cc}/u, `${width}: no raw control reaches the dock`);
  }
  // A shortened wide model still yields whole glyphs to an ellipsis rather
  // than exceeding the cell budget.
  const shortened = renderDetailSummary(cjk, theme, 86, { activity: false })[0];
  assert.ok(shortened.includes("測試模…"), `${shortened}: whole glyphs survive reclamation`);
  assert.ok(visibleWidth(shortened) <= 86, shortened);
});

test("the activity row is opt-in compatibility; the dock itself is one row", () => {
  const tools = input({}, { active_tools: [{ name: "read", detail: "src/core/controller.ts" }] });
  const both = renderDetailSummary(tools, theme, 60, { activity: true });
  assert.equal(both.length, 2, "the explicit compatibility row is retained");
  assert.match(both[1], /reading src\/core\/controller\.ts/);
  assert.equal(
    both[0],
    renderDetailSummary(tools, theme, 60, { activity: false })[0],
    "the metrics row itself is unchanged",
  );
  assert.equal(renderDetailSummary(tools, theme, 60).length, 1, "the default is metrics alone");
  // Settled work shows no fabricated generation row even when allocated.
  assert.equal(
    renderDetailSummary(input({ status: "completed", execution_exited: true }), theme, 60, {
      activity: true,
    }).length,
    1,
  );
});

// ---- The title row: identity, role/difficulty, task, Run cue ----

test("the title carries identity, role/difficulty, task and the Run cue, never status", () => {
  const title = renderDetailTitle(input(), theme, 100);
  assert.match(title, /^reviewer \(worker\/d3\) {2}Review the lifecycle contract · #4$/);
  assert.ok(visibleWidth(title) <= 100, title);
  for (const [status, pending] of [
    ["queued", false],
    ["running", true],
    ["completed", false],
    ["needs_input", false],
    ["failed", false],
    ["cancelled", false],
  ]) {
    const header = renderDetailTitle(input({ status, finalization_pending: pending }), theme, 80);
    assert.ok(visibleWidth(header) <= 80, header);
    assert.doesNotMatch(
      header,
      /(?:◦|⠋|✓|\?|✗|■) (?:queued|running|finishing|completed|needs_input|failed|cancelled)/,
      `the title must not repeat the status: ${header}`,
    );
  }
  assert.match(
    renderDetailTitle(
      input({ effective_settings: settings({ profile: "researcher", difficulty: 5 }) }),
      theme,
      100,
    ),
    /\(scout\/d5\)/,
  );
  assert.match(
    renderDetailTitle(input({ effective_settings: settings({ difficulty: 9 }) }), theme, 100),
    /\(worker\)/,
  );
  assert.doesNotMatch(
    renderDetailTitle(input({ effective_settings: settings({ difficulty: 9 }) }), theme, 100),
    /d9/,
  );
  // An unnamed Agent shows the role as its identity, with the difficulty tagged.
  assert.match(renderDetailTitle(input({ name: "" }), theme, 100), /^worker \(d3\)/);
  // Invalid task ordinals fall back to the Run ID.
  const fallback = renderDetailTitle(input({ task: NaN }), theme, 100);
  assert.match(fallback, /r-8f3a/);
  assert.doesNotMatch(fallback, /#(?:NaN|4)/);
});

test("the task text truncates first; the cue never scrolls away", () => {
  const long = input({ description: "审查".repeat(60), name: "nickname".repeat(10) });
  for (const width of [80, 60, 56]) {
    const title = renderDetailTitle(long, theme, width);
    assert.ok(visibleWidth(title) <= width, `${width}: ${title}`);
    assert.match(title, /#4/, `${width}: the cue never yields`);
    assert.match(title, /nickname/, `${width}: the identity is still whole`);
    assert.ok(title.includes("…"), `${width}: the long task is ellipsized`);
    assert.match(title, /审查/, `${width}: the task keeps whole glyphs`);
  }
  // The identity clips while the task keeps its reserved context.
  const shared = renderDetailTitle(long, theme, 52);
  assert.match(shared, /… · #4$/);
  assert.match(shared, /审查/);
  assert.match(shared, /worker\/d3/);
  // Then the tag yields before the task does, and the cue never yields.
  for (const width of [44, 30]) {
    const title = renderDetailTitle(long, theme, width);
    assert.ok(visibleWidth(title) <= width, `${width}: ${title}`);
    assert.match(title, /worker\/d3/, `${width}: the tag outlasts the name`);
    assert.match(title, /#4/, `${width}: the cue never yields`);
  }
  const untagged = renderDetailTitle(long, theme, 20);
  assert.match(untagged, /审查/, "20: the task floor outlasts the tag");
  assert.match(untagged, /#4/);
  assert.doesNotMatch(untagged, /worker\/d3/);
  // When the recognizable identity floor cannot fit beside task and cue,
  // the task yields entirely.
  const noTask = renderDetailTitle(long, theme, 15);
  assert.doesNotMatch(noTask, /审查/);
  assert.match(noTask, /#4/);
  assert.ok(visibleWidth(noTask) <= 15, `${noTask}`);
  assert.match(renderDetailTitle(long, theme, 12), /#4/);
});

test("title metadata is sanitized: no controls, bidi or raw ANSI can spoof chrome", () => {
  const raw = "bad\u001b[31mred\u001b[0m\u0007\u202ename\tline";
  const title = renderDetailTitle(input({ name: raw, description: raw, run_id: raw }), theme, 100);
  assert.doesNotMatch(title, /[\p{Cc}\p{Bidi_Control}]/u);
  assert.match(title, /\\u202e/);
  assert.match(title, /\\x07/);
});

test("a tagged identity keeps three cells, so a short name is never a lone ellipsis", () => {
  const floorOf = (name) => Math.min(3, visibleWidth(name));
  for (const name of ["Ada", "Alexandra-the-long-nickname", "艾达", "👩‍💻"]) {
    const floor = floorOf(name);
    for (let width = 6; width <= 60; width++) {
      const title = stripTerminalSequences(renderDetailTitle(input({ name }), theme, width));
      assert.ok(visibleWidth(title) <= width, `${name} ${width}: ${title}`);
      const tagged = /^(.*?) \(worker\/d3\)/.exec(title);
      if (!tagged) continue;
      assert.ok(
        visibleWidth(tagged[1]) >= floor,
        `${name} ${width}: tagged identity ${JSON.stringify(tagged[1])} keeps fewer than ${floor} cells`,
      );
      assert.notEqual(tagged[1], "…", `${name} ${width}: a lone ellipsis is not an identity`);
    }
  }
  // The concrete regression: Ada at 28/29 cells keeps her whole name and drops
  // the tag instead of degrading to a lone ellipsis beside it.
  for (const width of [28, 29]) {
    const title = stripTerminalSequences(renderDetailTitle(input({ name: "Ada" }), theme, width));
    assert.match(title, /^Ada {2}/, `${width}: ${title}`);
    assert.doesNotMatch(title, /worker\/d3/, `${width}: the tag yields before the name does`);
  }
  assert.match(
    stripTerminalSequences(renderDetailTitle(input({ name: "Ada" }), theme, 30)),
    /^Ada \(worker\/d3\)/,
    "one cell wider and the tag returns beside the whole name",
  );
});

test("the cue's own digit width is reserved, never taken from a tagged identity", () => {
  for (const task of [4, 1234, 123456]) {
    const marker = `#${task}`;
    for (let width = 6; width <= 60; width++) {
      const title = stripTerminalSequences(renderDetailTitle(input({ task }), theme, width));
      assert.ok(visibleWidth(title) <= width, `${marker} ${width}: ${title}`);
      const tagged = /^(.*?) \(worker\/d3\)/.exec(title);
      if (tagged)
        assert.ok(
          visibleWidth(tagged[1]) >= 3,
          `${marker} ${width}: tagged identity ${JSON.stringify(tagged[1])}`,
        );
      // A cue that fits is never clipped mid-figure, whatever its digit width.
      if (width >= 3 + visibleWidth(marker))
        assert.ok(title.includes(marker), `${marker} ${width}: whole cue ${title}`);
    }
  }
});

// ---- The footer's optional actions menu ----

const peer = (agent_id, overrides = {}) => ({
  agent_id,
  input: {
    view: view({ agent_id, run_id: `run-${agent_id}`, name: agent_id, ...overrides }),
    live: live(),
  },
});
const footer = (overrides = {}) => {
  const current = overrides.view ?? view({ agent_id: "a", name: "a" });
  return renderDetailFooter({
    width: 120,
    entries: [
      { agent_id: current.agent_id, input: { view: current, live: live() } },
      peer("b"),
      peer("c"),
    ],
    selected: current.agent_id,
    below: 0,
    view: current,
    available: true,
    confirming: false,
    messaging: true,
    spinnerFrame: 0,
    theme,
    framed: false,
    ...overrides,
  });
};
const slice = (frame, range, offset = 0) =>
  sliceByColumn(frame.text, range.from - offset, range.to - range.from);

test("the actions menu is an optional control before Message, Stop rightmost", () => {
  assert.equal(footer().menu, undefined, "the control is opt-in");
  assert.equal(footer({ menu: false }).menu, undefined);
  assert.ok(!footer().text.includes(". more"));
  const frame = footer({ menu: true });
  assert.ok(frame.menu, "menu: true paints the control");
  assert.equal(slice(frame, frame.menu), ". more");
  assert.match(frame.text, /\. more message stop$/);
  assert.ok(
    frame.text.indexOf(". more") < frame.text.indexOf("message"),
    "the menu precedes Message",
  );
  assert.ok(frame.text.indexOf("message") < frame.text.indexOf("stop"), "Stop stays rightmost");
  // Without Message the menu still precedes Stop.
  const noMessage = footer({ menu: true, messaging: false });
  assert.match(noMessage.text, /\. more stop$/);
  assert.ok(noMessage.menu);
  // Framed ranges are pane columns, past the frame's `╰─ ` offset.
  const framed = footer({ menu: true, framed: true });
  assert.ok(framed.menu.from >= 3, JSON.stringify(framed.menu));
  assert.equal(slice(framed, framed.menu, 3), ". more");
  assert.equal(framed.action.to, 3 + 120, "Stop stays flush at the right edge");
  // A draft owns the keyboard: the menu stays clickable, M does not.
  const drafting = footer({ menu: true, composing: true });
  assert.ok(drafting.menu);
  assert.equal(drafting.messageAction, undefined);
  assert.match(drafting.text, /\. more stop$/);
});

test("an armed confirmation hides the menu: only the final row changes", () => {
  const armed = footer({ menu: true, confirming: true });
  assert.equal(armed.menu, undefined);
  assert.equal(armed.messageAction, undefined);
  assert.doesNotMatch(armed.text, /more|message/);
  assert.match(armed.text, /best-effort · Ctrl\+S · Esc cancel · confirm stop$/);
  assert.equal(slice(armed, armed.action), "confirm stop");
  // Arming folds the peers into +N by design; the menu and message are gone.
  assert.match(armed.text, /\+2/);
});

test("the menu is reserved: it yields whole, never clipped, under width pressure", () => {
  let menuWithoutMessage = false;
  for (let width = 20; width <= 120; width++) {
    const frame = footer({ menu: true, width });
    assert.ok(visibleWidth(frame.text) <= width, `${width}: ${frame.text}`);
    if (frame.menu) assert.equal(slice(frame, frame.menu), ". more", `${width}`);
    if (frame.menu && !frame.messageAction) menuWithoutMessage = true;
    if (frame.action) assert.ok(frame.action.to <= width, `${width}: Stop stays inside`);
  }
  assert.ok(menuWithoutMessage, "the message yields before the reserved menu");
});

test("hidden attention keeps its cue with the menu present", () => {
  const frame = footer({ menu: true, hiddenNotes: 7 });
  assert.match(frame.text, /^!7/);
  assert.ok(frame.menu);
});

test("layout is a projection: title, dock and footer never mutate their input", () => {
  const cases = [
    (v) => renderDetailSummary({ view: v, live: live() }, theme, 40, { activity: false }),
    (v) => renderDetailSummary({ view: v, live: live() }, theme, 120, { activity: true }),
    (v) => renderDetailTitle({ view: v, live: live() }, theme, 40),
  ];
  for (const paint of cases) {
    const v = view();
    const before = structuredClone(v);
    paint(v);
    assert.deepEqual(v, before);
  }
  const entries = [peer("a"), peer("b"), peer("c")];
  const before = structuredClone(entries);
  renderDetailFooter({
    width: 40,
    entries,
    selected: "a",
    below: 5,
    view: entries[0].input.view,
    available: true,
    confirming: false,
    messaging: true,
    menu: true,
    hiddenNotes: 2,
    spinnerFrame: 0,
    theme,
    framed: true,
  });
  assert.deepEqual(entries, before);
});
