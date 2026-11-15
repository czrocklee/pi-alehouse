import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// The host `Theme` styles through chalk, which detects colour support once at
// module load and reports none in a test pipe. Force its level before the SDK
// module is imported, so bold/underline paint their real closed SGR pairs.
// Test files run in their own process, so this stays file-local.
process.env.FORCE_COLOR = "3";
const { Theme } = await import("@earendil-works/pi-coding-agent");

// Direct source tests: the pane integration is a separate lane, these exercise
// the pure layout helpers only, without a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const {
  renderDetailTitle,
  renderDetailSummary,
  renderDetailAttention,
  renderDetailInfo,
  renderDetailFields,
  renderDetailAgentStrip,
  renderDetailFooter,
  renderDetailComposeHeading,
  getDetailAttentionNotes,
} = await jiti.import("../../src/orchestration/ui/agent-detail-fields.ts");
const { wrapPlainText: wrapText } = await jiti.import("../../src/orchestration/ui/text.ts");
const { addToLedger } = await jiti.import("../../src/orchestration/core/usage-ledger.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const cwd = "/workspace/project";
const spend = (input, output, cache_read, cache_write, cost, model = "anthropic/claude-opus-5") =>
  addToLedger(undefined, { input, output, cache_read, cache_write, cost }, model);
const view = (overrides = {}) => ({
  owner_id: "o",
  generation: "g",
  agent_id: "a-19b7",
  run_id: "r-8f3a",
  name: "reviewer",
  description: "Review the lifecycle contract of controller.ts",
  effective_settings: {
    provider: "anthropic",
    model: "claude-opus-5",
    thinking: "medium",
    parent_thinking: "medium",
    thinking_resolution: "identity",
    profile: "researcher",
    difficulty: 5,
    strength: "d5",
    preset: "team",
    preset_version: "v2",
    selection_digest: "1".repeat(64),
    cwd,
    tools: ["read", "grep", "find", "ls"],
    definition_digest: "0".repeat(64),
    context_mode: "none",
  },
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resumable: true,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 93_000,
  turn_elapsed_ms: 1_100,
  turns: 3,
  max_turns: 256,
  execution_elapsed_ms: 93_000,
  usage: spend(61_200, 3_100, 19_900, 0, null),
  cleanup_errors: [],
  discarded_inputs: [],
  ...overrides,
});
const live = (overrides = {}) => ({ active_tools: [], tool_uses: 12, preview: "", ...overrides });
const input = (v = {}, l = {}) => ({ view: view(v), live: live(l) });

// ---- The title row: identity, task and the reuse cue; status lives in the dock ----

test("the title carries identity, task and the reuse cue, never the lifecycle status", () => {
  // The pane's inlay pads the row and draws the rule to its close control, so
  // the helper itself returns content only and adds nothing for the frame.
  const title = renderDetailTitle(input(), theme, 100);
  assert.match(title, /^reviewer \(scout\/d5\) {2}Review the lifecycle contract/);
  assert(visibleWidth(title) <= 100, JSON.stringify(title));
  assert.match(title, /reviewer/);
  assert.match(title, /scout/);
  assert.doesNotMatch(title, /researcher/);
  assert.match(title, /Review the lifecycle contract/);
  assert.match(title, /r-8f3a/);
  assert(visibleWidth(title) <= 100, JSON.stringify(title));
  // The one bottom summary row owns lifecycle state, so the title never repeats it.
  for (const [status, pending] of [
    ["queued", false],
    ["running", true],
    ["completed", false],
    ["needs_input", false],
    ["failed", false],
    ["cancelled", false],
  ]) {
    const header = renderDetailTitle(input({ status, finalization_pending: pending }), theme, 80);
    assert(visibleWidth(header) <= 80, header);
    assert.doesNotMatch(
      header,
      /(?:◦|⠋|✓|\?|✗|■) (?:queued|running|finishing|completed|needs_input|failed|cancelled)/,
      `the title must not repeat the status: ${header}`,
    );
  }
});

test("the task cue and reuse marker outrank identity when narrow", () => {
  for (const width of [60, 44, 30, 20]) {
    const v = view({ task: 27, name: "nickname".repeat(50), description: "审查".repeat(60) });
    const before = structuredClone(v);
    const title = renderDetailTitle({ view: v, live: live() }, theme, width);
    assert(visibleWidth(title) <= width, `${width}: ${JSON.stringify(title)}`);
    assert.match(title, /#27/, `${width}: the reuse cue never scrolls away`);
    assert.match(title, /审查/, `${width}: the task cue keeps its reserved context`);
    assert.deepEqual(v, before, "fitting is a projection, not a metadata rewrite");
  }
  // A tagged identity keeps three cells, so a short name never becomes a lone
  // ellipsis beside its tag; the tag yields instead.
  for (const name of ["Ada", "艾达"]) {
    const floor = Math.min(3, visibleWidth(name));
    for (let width = 20; width <= 40; width++) {
      const title = stripTerminalSequences(renderDetailTitle(input({ name }), theme, width));
      assert(visibleWidth(title) <= width, `${name} ${width}: ${JSON.stringify(title)}`);
      const tagged = /^(.*?) \(scout\/d5\)/.exec(title);
      if (!tagged) continue;
      assert.ok(
        visibleWidth(tagged[1]) >= floor,
        `${name} ${width}: tagged identity ${JSON.stringify(tagged[1])}`,
      );
    }
  }
});

test("a title too narrow for identity degrades to the clipped task cue, safely", () => {
  const v = view({ task: 3, name: "nn", description: "审查".repeat(40) });
  for (const width of [12, 9]) {
    const title = renderDetailTitle({ view: v, live: live() }, theme, width);
    assert(visibleWidth(title) <= width, `${width}: ${JSON.stringify(title)}`);
    assert.doesNotMatch(title, /\p{Cc}/u, `${width}: no raw control reaches the title`);
  }
  assert.match(
    renderDetailTitle({ view: v, live: live() }, theme, 12),
    /#3/,
    "the reuse cue survives the narrowest identity budget",
  );
  const fallback = renderDetailTitle(input({ task: NaN }), theme, 100);
  assert.match(fallback, /r-8f3a/, "invalid task ordinals fall back to the Run ID");
  assert.doesNotMatch(fallback, /#(?:NaN|3)/);
});

test("title metadata is sanitized: no controls, bidi or raw ANSI can spoof chrome", () => {
  const raw = "bad\u001b[31mred\u001b[0m\u0007\u202ename\tline";
  const v = view({ name: raw, description: raw, run_id: raw });
  const title = renderDetailTitle({ view: v, live: live() }, theme, 100);
  assert.doesNotMatch(title, /[\p{Cc}\p{Bidi_Control}]/u);
  assert.match(title, /\\u202e/);
  assert.match(title, /\\x07/);
});

// ---- The compact summary: one dock row, plus an opt-in activity row ----

test("the summary packs status, turns, context, token flow, cost and the turn clock in one row", () => {
  const rows = renderDetailSummary(
    input(
      {
        runtime: { activity: "generating", context: { tokens: 231_000, context_window: 272_000 } },
      },
      {},
    ),
    theme,
    120,
    { activity: false },
  );
  assert.equal(rows.length, 1, "the bottom dock is exactly one row");
  const [row] = rows;
  assert.match(row, /running/, "lifecycle status leads the dock, not the title");
  assert.match(row, /↻3\/256/, "turns use a slash, never the retired ≤ form");
  assert.doesNotMatch(row, /≤/, "the dock never paints the retired ≤ turn form");
  assert.doesNotMatch(row, /▸/, "the dock never counts tool calls");
  assert.match(row, /ctx ≈231k\/272k/, "context keeps its ctx label");
  assert.doesNotMatch(row, /ctx ≈\S+ \d+%/, "the ctx label never gains a percent");
  assert.match(row, /↑/, "input flow leads the token segment");
  assert.match(row, /↓/, "output flow closes the token segment");
  assert.match(row, /\(\s*\d+(?:\.\d+)?%\s*\)/, "the cache-hit share is parenthesized");
  assert.doesNotMatch(row, /\$/);
  assert.match(row, /total 1m33s/, "elapsed is spelled out as a total");
  assert.match(row, /\(1s\)/, "the current-turn clock is parenthesized");
  assert(visibleWidth(row) <= 120, JSON.stringify(row));
});

test("the dock shows the current-turn clock only while a turn is timed", () => {
  const timed = renderDetailSummary(input(), theme, 120, { activity: false })[0];
  assert.match(timed, /\(1s\)/, timed);
  // Whole, floored seconds at every magnitude: no tenths survive the floor.
  for (const [ms, clock] of [
    [18_000, "(18s)"],
    [59_900, "(59s)"],
    [62_000, "(1m02s)"],
    [900, "(0s)"],
  ]) {
    const row = renderDetailSummary(input({ turn_elapsed_ms: ms }), theme, 120, {
      activity: false,
    })[0];
    assert.ok(row.includes(clock), `${ms}: ${row}`);
    assert.doesNotMatch(row, /\(\d+(?:m\d{2})?\.\d+s\)/, `${ms}: ${row}`);
  }
  for (const [label, overrides] of [
    ["settled", { status: "completed", execution_exited: true }],
    ["queued", { status: "queued" }],
    ["untimed", { turn_elapsed_ms: undefined }],
  ]) {
    const row = renderDetailSummary(input(overrides), theme, 120, { activity: false })[0];
    // The usage ratio is parenthesized too: only a clock-shaped group counts.
    assert.doesNotMatch(row, /\(\d+(?:m\d{2})?s\)/, `${label}: ${row}`);
  }
});

test("summary cost and context stay accurate: floors and unknowns are never zeros", () => {
  const priced = addToLedger(
    spend(1000, 100, 0, 0, 2.5),
    { input: 500, output: 50, cache_read: 0, cache_write: 0, cost: null },
    "anthropic/claude-opus-5",
  );
  const rows = renderDetailSummary(
    input({
      usage: priced,
      runtime: { activity: "generating", context: { tokens: null, context_window: 272_000 } },
    }),
    theme,
    90,
  ).join("\n");
  assert.match(rows, /≥\$2\.50/, "a partial observation is a cents floor");
  assert.doesNotMatch(rows, /\$2\.5(?!\d)/, "the retired three-decimal form is gone");
  assert.match(rows, /ctx \?\/272k/, "unknown context keeps the ctx label");
  assert.doesNotMatch(rows, /ctx \S+ \d+%/, "no percent is invented for it");
  const notReported = renderDetailSummary(input({ usage: undefined }), theme, 90, {
    activity: false,
  })[0];
  assert.doesNotMatch(notReported, /\$/, "no cost is invented");
  assert.doesNotMatch(notReported, /\?\/\d/, "no context is invented");
  const noCalls = renderDetailSummary(input({ usage: undefined }, { tool_uses: 0 }), theme, 90, {
    activity: false,
  })[0];
  assert.doesNotMatch(noCalls, /▸/, "the dock never counts tool calls");
  assert.match(notReported, /↻3\/256/, "turns remain real telemetry");
});

test("the summary drops the least urgent figures first and never exceeds the width", () => {
  const base = input(
    { runtime: { activity: "generating", context: { tokens: 45_000, context_window: 500_000 } } },
    {},
  );
  for (const width of [64, 48, 40, 28, 16, 8]) {
    const row = renderDetailSummary(base, theme, width, { activity: false })[0];
    assert(visibleWidth(row) <= width, `${width}: ${JSON.stringify(row)}`);
    if (width >= 64) assert.match(row, /↻3\/256/, `${width}: turns survive`);
    if (width >= 64) assert.match(row, /running/, `${width}: the status outlasts routine figures`);
  }
  // The total time is the first whole figure to yield, so it needs the full row.
  assert.match(
    renderDetailSummary(base, theme, 120, { activity: false })[0],
    /total 1m33s/,
    "elapsed is spelled out only while the row holds it",
  );
  // Elevated context pressure outlives routine turns/elapsed/cost figures.
  const hot = input({
    runtime: { activity: "generating", context: { tokens: 250_000, context_window: 272_000 } },
  });
  const row = renderDetailSummary(hot, theme, 40, { activity: false })[0];
  assert.match(row, /ctx ≈250k\/272k/, row);
  assert.doesNotMatch(row, /total 1m33s|↻3\/256/, "routine figures yield before elevated context");
});

test("the summary keeps one bounded activity row only when a caller allocates it", () => {
  const tools = renderDetailSummary(
    input({}, { active_tools: [{ name: "read", detail: "src/core/controller.ts" }] }),
    theme,
    60,
    { activity: true },
  );
  assert.equal(tools.length, 2, "the explicit compatibility row is retained");
  assert.match(tools[1], /reading src\/core\/controller\.ts/);
  const drafting = renderDetailSummary(
    input({}, { active_tools: [], channel: "text", preview: "turnStarted 在 turnEnd 里被清掉" }),
    theme,
    40,
    { activity: true },
  );
  assert.equal(drafting.length, 2);
  assert.match(drafting[1], /replying: /);
  for (const line of drafting) assert(visibleWidth(line) <= 40, JSON.stringify(line));
  // Settled work shows no fabricated generation row.
  assert.equal(
    renderDetailSummary(input({ status: "completed", execution_exited: true }), theme, 60, {
      activity: true,
    }).length,
    1,
  );
  // The dock itself never grows a second row: the pane asks for the metrics alone.
  assert.equal(
    renderDetailSummary(
      input({}, { active_tools: [{ name: "read", detail: "src/core/controller.ts" }] }),
      theme,
      60,
      { activity: false },
    ).length,
    1,
  );
  // A task row is not duplicated: the title owns the task.
  for (const line of renderDetailSummary(input(), theme, 90, { activity: false }))
    assert.doesNotMatch(line, /Review the lifecycle contract/);
});

// ---- Attention: at most two rows, highest priority first, +N for the rest ----

test("attention shows at most two rows ordered by what blocks progress soonest", () => {
  const rows = renderDetailAttention(
    input({
      outcome: { status: "needs_input", question: "Which branch?", limit_reached: true },
      unavailable_reason: "SESSION_UNAVAILABLE",
      owner_error: "flock lost",
      cleanup_errors: ["child did not exit"],
      history_error: "disk full",
      pending_messages: 2,
      discarded_inputs: ["stale steer"],
      dispatch_notes: ["tree_shared"],
    }),
    theme,
    100,
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\? asked: Which branch\?/);
  assert.match(rows[1], /✗ error|✗ owner/, "the next-highest severity follows");
  assert.match(rows[1], /\+7 · I info/, "hidden notes are counted with their Info key");
  for (const line of rows) assert(visibleWidth(line) <= 100, JSON.stringify(line));
});

test("attention rows stay single-line and bounded under CJK and narrow widths", () => {
  const rows = renderDetailAttention(
    input({
      outcome: { status: "needs_input", question: "审查".repeat(40), limit_reached: true },
      cleanup_errors: ["child did not exit"],
    }),
    theme,
    30,
  );
  assert.equal(rows.length, 2);
  for (const line of rows) {
    assert(visibleWidth(line) <= 30, JSON.stringify(line));
    assert(!/\n/.test(line));
  }
  assert.match(rows.at(-1), /\+1/, "the count survives where the wording yields");
});

test("attention renders drain and human-steer admission without acknowledging them", () => {
  const rows = renderDetailAttention(
    input({
      drain: { waiting_for: "sdk_idle", elapsed_ms: 1_200 },
      human_steered: true,
    }),
    theme,
    80,
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0], /! draining 1\.2s · awaiting SDK idle/);
  assert.match(rows[1], /✓ human steer admitted/);
  assert.doesNotMatch(rows.join("\n"), /deliver|acknowledg|consumed/i);
  assert.equal(renderDetailAttention(input(), theme, 80).length, 0, "no notes, no rows");
});

// ---- Info: the complete fields view, two columns when wide ----

test("info below the wide threshold is the existing single-column field view", () => {
  const narrow = renderDetailInfo(input(), theme, 100);
  assert.deepEqual(narrow, renderDetailFields(input(), theme, 100));
});

test("wide info lays the complete fields out in two balanced columns", () => {
  const long = `/parent/${"工作目录/".repeat(12)}project`;
  const base = input({
    effective_settings: { ...view().effective_settings, cwd: long },
    runtime: { activity: "generating", context: { tokens: 231_000, context_window: 272_000 } },
  });
  const rows = renderDetailInfo(base, theme, 120);
  assert.ok(rows.length < renderDetailFields(base, theme, 120).length, "two columns pack rows");
  for (const line of rows) assert(visibleWidth(line) <= 120, JSON.stringify(line));
  const text = rows.join("\n");
  // No field's data is truncated away: the long cwd is fully present, wrapped.
  let restored = "";
  for (const line of rows) {
    const match = line.match(/^\s*cwd\s(.*)$/);
    if (match) restored = match[1].trimEnd();
    else if (restored && /^\s{12}/.test(line)) restored += line.trim();
  }
  assert.equal(restored.replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  assert.match(text, /tokens\s+in 61\.2k/);
  assert.match(text, /≈231k\/272k/);
  assert.match(text, /task\s+Review the lifecycle contract/);
});

test("info columns keep CJK aligned and never exceed the width", () => {
  const base = input({
    description: "审查".repeat(30),
    name: "昵称".repeat(20),
  });
  for (const width of [110, 140, 200]) {
    const rows = renderDetailInfo(base, theme, width);
    assert.ok(rows.length > 0);
    for (const line of rows)
      assert(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
  }
});

// ---- The agent strip: one tab row when there is more than one agent ----

const strip = (overrides = {}) =>
  renderDetailAgentStrip({
    entries: [
      { agent_id: "a", input: input({ agent_id: "a", name: "alpha", run_id: "run-a" }) },
      { agent_id: "b", input: input({ agent_id: "b", name: "beta", run_id: "run-b" }) },
      { agent_id: "c", input: input({ agent_id: "c", name: "gamma", run_id: "run-c" }) },
    ],
    selected: "b",
    width: 80,
    spinnerFrame: 0,
    theme,
    ...overrides,
  });

test("the strip paints one tab row only when there is more than one agent", () => {
  assert.deepEqual(
    renderDetailAgentStrip({
      entries: [{ agent_id: "a", input: input() }],
      selected: "a",
      width: 80,
      spinnerFrame: 0,
      theme,
    }),
    { text: "", items: [], markerVisible: false },
  );
  const { text, items } = strip();
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /gamma/);
  assert.equal(items.length, 3);
  // Hit ranges are relative to the text and map onto stable-order agents.
  for (const item of items) {
    assert.ok(item.from >= 0 && item.to <= visibleWidth(text), JSON.stringify(item));
    assert.ok(text.includes({ a: "alpha", b: "beta", c: "gamma" }[item.agent_id]));
  }
  assert.deepEqual(
    items.map((item) => item.agent_id),
    ["a", "b", "c"],
    "stable order, no re-sorting by status",
  );
});

test("strip attention markers flag questions and warnings per agent", () => {
  const { text } = renderDetailAgentStrip({
    entries: [
      {
        agent_id: "a",
        input: input({
          name: "alpha",
          outcome: { status: "needs_input", question: "Q?", limit_reached: false },
        }),
      },
      { agent_id: "b", input: input({ name: "beta", cleanup_errors: ["boom"] }) },
      { agent_id: "c", input: input({ name: "gamma" }) },
    ],
    selected: "c",
    width: 80,
    spinnerFrame: 0,
    theme,
  });
  assert.match(text, /alpha \?/);
  assert.match(text, /beta !/);
  assert.doesNotMatch(text, /gamma [?!]/);
});

test("clipped peers are summarized as +N with attention counts; the selected tab stays visible", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    agent_id: `agent-${i}`,
    input: input({ agent_id: `agent-${i}`, name: `name-${"长".repeat(6)}${i}`, run_id: `r${i}` }),
  }));
  const withAttention = [
    { agent_id: "w1", input: input({ name: "w1", cleanup_errors: ["boom"] }) },
    {
      agent_id: "q1",
      input: input({
        name: "q1",
        outcome: { status: "needs_input", question: "Q?", limit_reached: false },
      }),
    },
    ...many,
  ];
  const { text, items } = renderDetailAgentStrip({
    entries: withAttention,
    selected: withAttention[10].agent_id,
    width: 60,
    spinnerFrame: 0,
    theme,
  });
  assert(visibleWidth(text) <= 60, JSON.stringify(text));
  assert.match(text, /\+\d+/, "hidden peers are counted");
  assert.match(text, /\?\d/, "hidden questions are counted");
  assert.match(text, /!\d/, "hidden warnings are counted");
  assert.ok(
    items.some((item) => item.agent_id === withAttention[10].agent_id),
    "the selected agent is always painted",
  );
  for (const item of items) assert.ok(item.to <= visibleWidth(text), JSON.stringify(item));
});

test("the strip cannot be spoofed with ANSI, controls or CJK width tricks", () => {
  const raw = "bad\u001b[31mred\u001b[0m\u0007\u202ename\tline";
  const { text, items } = renderDetailAgentStrip({
    entries: [
      { agent_id: "a", input: input({ name: raw, run_id: "r-a" }) },
      { agent_id: "b", input: input({ name: "审查", run_id: "r-b" }) },
    ],
    selected: "a",
    width: 40,
    spinnerFrame: 0,
    theme,
  });
  assert.doesNotMatch(text, /[\p{Cc}\p{Bidi_Control}]/u);
  for (const item of items) assert.ok(item.to <= visibleWidth(text));
  for (const width of [8, 12, 20]) {
    const narrow = renderDetailAgentStrip({
      entries: [
        { agent_id: "a", input: input({ name: "alpha", run_id: "r-a" }) },
        { agent_id: "b", input: input({ name: "beta", run_id: "r-b" }) },
      ],
      selected: "b",
      width,
      spinnerFrame: 0,
      theme,
    });
    assert(visibleWidth(narrow.text) <= width, `${width}: ${JSON.stringify(narrow.text)}`);
    for (const item of narrow.items)
      assert.ok(item.from >= 0 && item.to <= visibleWidth(narrow.text), "no target outside text");
  }
});

// ---- The bottom edge: agent tabs at the left, tail cue and actions at the right ----

const peer = (agent_id, overrides = {}) => ({
  agent_id,
  input: {
    view: view({ agent_id, run_id: `run-${agent_id}`, name: agent_id, ...overrides }),
    live: live(),
  },
});
const footer = (overrides = {}) => {
  const current =
    overrides.view ??
    view({
      agent_id: "a",
      name: "a",
      runtime: { activity: "generating", context: { tokens: 45_000, context_window: 500_000 } },
    });
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
    available: false,
    confirming: false,
    messaging: true,
    spinnerFrame: 0,
    theme,
    framed: false,
    ...overrides,
  });
};
// Hit ranges are terminal columns: slice by column, never by code point, so
// ANSI styling and wide glyphs cannot shift what a range names.
const slice = (frame, range, offset = 0) =>
  sliceByColumn(frame.text, range.from - offset, range.to - range.from);

test("the edge is tabs and actions only: no counters, status, context or key legend", () => {
  const frame = footer();
  assert.match(frame.text, /^‹ ⠋ a {2}⠋ b {2}⠋ c ›/);
  assert.match(frame.text, /Esc {2}\[M message\]$/);
  for (const repeated of [
    /agents/,
    /lines/,
    /\d+\/\d+/,
    /ctx/,
    /running/,
    /I info/,
    /T tools/,
    /←→/,
    /following/,
    /Esc close/,
  ])
    assert.doesNotMatch(frame.text, repeated);
  assert.ok(visibleWidth(frame.text) <= 120);
  // Every tab, `‹` and `›` names the Agent a click selects; `‹ ›` wrap around.
  const targets = frame.tabs.map((tab) => [slice(frame, tab).trim(), tab.agent_id]);
  assert.deepEqual(targets, [
    ["‹", "c"],
    ["⠋ a", "a"],
    ["⠋ b", "b"],
    ["⠋ c", "c"],
    ["›", "b"],
  ]);
});

test("framed tabs use ASCII pipes while the corner pad keeps its rule", () => {
  const frame = footer({ framed: true, messaging: false, below: 0 });
  assert.match(frame.text, /^‹ ⠋ a \| ⠋ b \| ⠋ c ›$/);
  assert.equal(frame.flush?.start, false, "an arrow keeps the corner's pad");
  assert.equal(frame.flush?.end, false);
  // Hit ranges are pane columns: past the frame's `╰─ ` offset.
  for (const tab of frame.tabs) assert.ok(tab.from >= 3, JSON.stringify(tab));
  const confirming = footer({ framed: true, available: true, confirming: true });
  assert.match(confirming.text, /^ ⠋ a \| \+2 /, confirming.text);
  assert.equal(confirming.flush?.start, true, "a padded tab meets the corner's rule");
  const lone = renderDetailFooter({
    width: 60,
    entries: [peer("a")],
    selected: "a",
    below: 0,
    view: view(),
    available: false,
    confirming: false,
    spinnerFrame: 0,
    theme,
    framed: true,
  });
  assert.equal(lone.text, "", "an edge with nothing on it is plain border");
});

test("the [M message] control is a hit range inside the painted row, offset by the frame", () => {
  for (const [framed, offset] of [
    [false, 0],
    [true, 3],
  ]) {
    const frame = footer({ framed });
    assert.ok(frame.messageAction, "messaging offers the message control");
    const { from, to } = frame.messageAction;
    assert.ok(from >= offset && to <= offset + 120, JSON.stringify(frame));
    assert.equal(slice(frame, frame.messageAction, offset), "[M message]");
  }
});

test("Stop stays outermost, after the docked Esc hint, with its fit safety and offsets", () => {
  const frame = footer({ available: true });
  assert.equal(frame.action.kind, "stop");
  assert.match(frame.text, /Esc {2}\[M message\] \[S Stop\]$/);
  assert.equal(frame.action.to, 120);
  assert.equal(frame.action.from, 120 - "[S Stop]".length);
  const framed = footer({ available: true, framed: true });
  assert.equal(framed.action.from, 3 + 120 - "[S Stop]".length);
  assert.doesNotMatch(framed.text, /Esc/, "framed, the close control replaces the hint");
  // The whole confirmation must fit beside a minimal selected tab.
  assert.equal(footer({ available: true, width: 54 }).action, undefined);
  assert.equal(footer({ available: true, width: 55 }).action?.to, 55);
  assert.equal(footer({ available: true, width: 20 }).action, undefined);
});

test("the actions menu is an optional footer control before Message and Stop", () => {
  const frame = footer({ menu: true, available: true });
  assert.ok(frame.menu, "menu: true paints the control");
  assert.equal(slice(frame, frame.menu), "[⋯]");
  const at = frame.text.indexOf("[⋯]");
  assert.ok(at >= 0, frame.text);
  assert.ok(at < frame.text.indexOf("[M message]"), "the menu precedes Message");
  assert.ok(
    frame.text.indexOf("[M message]") < frame.text.indexOf("[S Stop]"),
    "Stop stays rightmost",
  );
  assert.equal(footer().menu, undefined, "the control is opt-in");
  assert.equal(footer({ menu: false }).menu, undefined);
  // The caller decides: the pane suppresses the menu while a draft owns the
  // keyboard, and an armed Stop owns the whole row here.
  assert.ok(footer({ menu: true, composing: true }).menu, "the helper paints what it is told");
  assert.equal(footer({ menu: true, confirming: true, available: true }).menu, undefined);
  // Framed, the range is offset by the frame's side and pad.
  const framed = footer({ menu: true, framed: true });
  assert.ok(framed.menu.from >= 3, JSON.stringify(framed.menu));
  assert.equal(slice(framed, framed.menu, 3), "[⋯]");
  // It yields whole under width pressure, never as a clipped label.
  for (let width = 20; width <= 120; width++) {
    const narrow = footer({ menu: true, width });
    assert(visibleWidth(narrow.text) <= width, `${width}: ${narrow.text}`);
    if (narrow.menu) assert.equal(slice(narrow, narrow.menu), "[⋯]", `${width}`);
  }
});

test("the tail cue counts the rows below and jumps back to them", () => {
  assert.equal(footer().tail, undefined, "at the tail there is nothing to jump to");
  const colors = [];
  const recording = {
    ...theme,
    fg: (color, text) => {
      colors.push([color, text]);
      return text;
    },
  };
  const frame = footer({ below: 37, live: true, theme: recording, available: true });
  assert.match(frame.text, /↓ 37 more {2}Esc {2}\[M message\] \[S Stop\]$/);
  assert.equal(slice(frame, frame.tail), "↓ 37 more");
  assert.ok(colors.some(([color, text]) => color === "accent" && text === "↓ 37 more"));
  colors.length = 0;
  footer({ below: 37, theme: recording });
  assert.ok(
    colors.some(([color, text]) => color === "dim" && text === "↓ 37 more"),
    "a settled body is dim",
  );
});

test("under width pressure peers fold first, then arrows, then the tail (framed) or M (docked)", () => {
  const many = ["a", ..."bcdefghij"].map((id) => peer(id));
  for (const framed of [false, true])
    for (let width = 40; width <= 140; width++) {
      const frame = renderDetailFooter({
        width,
        entries: many,
        selected: "e",
        below: 120,
        view: many[4].input.view,
        available: true,
        confirming: false,
        messaging: true,
        spinnerFrame: 0,
        theme,
        framed,
      });
      const at = `${framed} ${width}: ${frame.text}`;
      assert(visibleWidth(frame.text) <= width, at);
      assert.match(frame.text, /⠋ e/, `${at}: the selected tab never yields`);
      if (width >= 55) assert.equal(frame.action?.to, (framed ? 3 : 0) + width, `${at}: Stop`);
      const folded = /\+\d/.test(frame.text);
      const arrows = /[‹›]/.test(frame.text);
      const tail = /↓ 120 more/.test(frame.text) ? 2 : /↓120/.test(frame.text) ? 1 : 0;
      const message = /\[M message\]/.test(frame.text) ? 2 : /\[M msg\]/.test(frame.text) ? 1 : 0;
      if (!arrows) assert.ok(folded, `${at}: arrows yield only after peers fold`);
      if (framed) {
        if (tail < 2) assert.ok(!arrows, `${at}: the tail cue yields after the arrows`);
        if (message < 2) assert.equal(tail, 0, `${at}: M yields after the tail cue`);
      } else {
        if (message < 2) assert.ok(!arrows, `${at}: M yields after the arrows`);
        if (tail < 2) assert.equal(message, 0, `${at}: docked, the tail cue outlasts M`);
      }
    }
});

test("while composing, the edge drops every key the draft would swallow", () => {
  const frame = footer({ composing: true, available: true, below: 4 });
  assert.match(frame.text, /⠋ a {2}⠋ b {2}⠋ c/, "tabs stay clickable");
  for (const lie of [/[‹›]/, /\[M/, /Esc/, /Enter/, /\[S Stop\]/])
    assert.doesNotMatch(frame.text, lie);
  assert.equal(frame.messageAction, undefined, "M is suppressed while typing");
  assert.match(frame.text, /↓ 4 more {2}\[Stop\]$/, "scrolling still works beside the draft");
  assert.equal(frame.action.kind, "stop");
  assert.equal(frame.action.from, 120 - "[Stop]".length);
});

test("an armed Stop folds every peer and keeps its whole hint", () => {
  for (const composing of [false, true]) {
    const frame = footer({ confirming: true, available: true, composing, below: 9 });
    assert.match(frame.text, /^ ⠋ a {2}\+2 /, frame.text);
    assert.match(frame.text, /best-effort · Ctrl\+S · Esc cancel · \[Confirm stop\]$/);
    assert.doesNotMatch(frame.text, /[‹›]|↓|\[M/);
    assert.equal(frame.action.kind, "confirm");
    assert.equal(frame.messageAction, undefined);
    assert.equal(slice(frame, frame.action), "[Confirm stop]");
  }
});

test("hidden attention rides the selected tab's marker, else a !N cue leads the edge", () => {
  assert.doesNotMatch(footer().text, /!\d/);
  assert.doesNotMatch(footer({ hiddenNotes: 0 }).text, /!0/);
  // An unmarked selected tab cannot carry it: the cue leads.
  assert.match(footer({ hiddenNotes: 7 }).text, /^!7 ‹ ⠋ a/);
  // A warning marks the tab itself, so the cue would repeat it.
  const marked = footer({
    hiddenNotes: 7,
    view: view({ agent_id: "a", name: "a", history_error: "x" }),
  });
  assert.match(marked.text, /⠋ a !/);
  assert.doesNotMatch(marked.text, /!7/);
  // A lone Agent has no tab: the cue leads and is never silently dropped.
  const lone = (width, overrides = {}) =>
    renderDetailFooter({
      width,
      entries: [peer("a")],
      selected: "a",
      below: 0,
      view: view({ agent_id: "a" }),
      available: false,
      confirming: false,
      messaging: true,
      hiddenNotes: 5,
      spinnerFrame: 0,
      theme,
      framed: false,
      ...overrides,
    });
  for (const width of [40, 28, 20, 12]) {
    const narrow = lone(width);
    assert(visibleWidth(narrow.text) <= width, `${width}: ${JSON.stringify(narrow.text)}`);
    assert.match(narrow.text, /^!5/, `${width}: the cue is never silently dropped`);
  }
  const stop = lone(56, { available: true, hiddenNotes: 9 });
  assert.match(stop.text, /^!9 .*\[S Stop\]$/);
  assert.equal(stop.action.to, 56);
  const tiny = lone(20, { hiddenNotes: 1_234_567 });
  assert.match(tiny.text, /!/);
  assert(visibleWidth(tiny.text) <= 20);
});

test("hit ranges slice by terminal column through real ANSI, CJK and emoji", () => {
  // The pinned SDK's public `Theme` class with a controlled token fixture --
  // not a live host instance and no private loader state. It still renders
  // the real SGR sequences, and it still offers a `selectedBg` background:
  // the selected tab must never ask for it. Selection is the nickname's own
  // accent+bold+underline, closed around the name alone.
  const host = new Theme(
    {
      accent: "#aa00aa",
      success: "#00aa00",
      error: "#cc0000",
      warning: "#cccc00",
      muted: "#999999",
      dim: "#777777",
      text: "#eeeeee",
      borderAccent: "#444444",
      borderMuted: "#333333",
      // Fallback targets for the optional tokens the fixture omits.
      thinkingXhigh: "#dddddd",
    },
    { selectedBg: "#123456" },
    "truecolor",
  );
  // The host theme really can paint that fill; the render simply must not.
  assert.ok(host.bg("selectedBg", "x").startsWith("\u001b[48;2;18;52;86m"));
  const names = ["审查员🚀", "beta"];
  const entries = names.map((name, index) => ({
    agent_id: `p${index}`,
    input: input({
      agent_id: `p${index}`,
      run_id: `run-p${index}`,
      name,
      status: "completed",
      execution_exited: true,
    }),
  }));
  for (const framed of [false, true]) {
    const frame = renderDetailFooter({
      width: 60,
      entries,
      selected: "p1",
      below: 0,
      view: entries[1].input.view,
      available: true,
      confirming: false,
      messaging: true,
      spinnerFrame: 0,
      theme: host,
      framed,
    });
    const offset = framed ? 3 : 0;
    assert.ok(frame.text.includes("\u001b["), `${framed}: real ANSI is painted`);
    // No background SGR anywhere on the edge, although the theme has one.
    assert.ok(!frame.text.includes("\u001b[48;"), `${framed}: the selected tab has no fill`);
    // `审查员🚀` is 8 cells but 4 code points: code-point slicing would shift
    // every following range, so each tab must name exactly its own Agent.
    const labels = { p0: "审查员🚀", p1: "beta" };
    for (const tab of frame.tabs) {
      const content = slice(frame, tab, offset);
      assert.equal(
        visibleWidth(content),
        tab.to - tab.from,
        `${framed} ${tab.agent_id}: a range covers exactly its columns`,
      );
      const label = stripTerminalSequences(content).trim();
      // `‹ ›` name the neighbour they select, so they may carry another
      // Agent's id: only a tab's own range must hold its own nickname.
      if (/^[‹›]$/.test(label)) continue;
      const own = labels[tab.agent_id];
      assert.ok(own, `${framed}: ${JSON.stringify(label)}`);
      assert.ok(label.includes(own), `${framed}: ${JSON.stringify(label)}`);
      for (const other of Object.values(labels).filter((name) => name !== own))
        assert.ok(!label.includes(other), `${framed}: ${JSON.stringify(label)}`);
    }
    // The selected tab: accent+bold+underline on the nickname alone.
    const selected = frame.tabs.find((tab) => tab.agent_id === "p1");
    const content = slice(frame, selected, offset);
    assert.ok(content.includes(host.getFgAnsi("accent")), `${framed}: the nickname is accented`);
    assert.ok(content.includes("\u001b[1m"), `${framed}: the nickname is bold`);
    assert.match(stripTerminalSequences(content), /beta/);
    // The underline opens exactly once and closes again inside the tab's own
    // columns, wrapping the nickname alone -- never the lifecycle glyph, the
    // padding or a peer.
    assert.equal(content.split("\u001b[4m").length - 1, 1, `${framed}: one underline`);
    const open = content.indexOf("\u001b[4m");
    const close = content.indexOf("\u001b[24m", open);
    assert.ok(close > open, `${framed}: the underline is closed`);
    assert.equal(
      stripTerminalSequences(content.slice(open, close + "\u001b[24m".length)),
      "beta",
      `${framed}: only the nickname is underlined`,
    );
    // The lifecycle glyph keeps its own colour: success, not the accent.
    assert.ok(content.includes(host.getFgAnsi("success")), `${framed}: the glyph keeps its colour`);
    // One column short of the range: the tab's own padding, never the label.
    const edge = sliceByColumn(frame.text, selected.to - offset - 1, 1);
    assert.equal(stripTerminalSequences(edge), " ", `${framed}: the boundary is a cell`);
    // The unselected peer carries neither the accent nor the underline.
    const peer = frame.tabs.find((tab) => tab.agent_id === "p0");
    const peerContent = slice(frame, peer, offset);
    assert.ok(
      !peerContent.includes(host.getFgAnsi("accent")),
      `${framed}: the peer is not accented`,
    );
    assert.ok(!peerContent.includes("\u001b[4m"), `${framed}: the peer is not underlined`);
  }
});

// ---- The compose heading: Steer name #N, Enter/Esc hints ----

test("the compose heading names its target and its keys", () => {
  const heading = renderDetailComposeHeading({
    width: 80,
    name: "reviewer",
    task: 27,
    sendable: true,
    theme,
  });
  assert.match(heading, /Steer reviewer #27/);
  assert.match(heading, /Enter send · Esc discard/);
  assert(visibleWidth(heading) <= 80);
  const ended = renderDetailComposeHeading({
    width: 80,
    name: "reviewer",
    sendable: false,
    theme,
  });
  assert.match(ended, /task ended · Esc discard/);
  assert.doesNotMatch(ended, /#/, "no task ordinal is invented");
  const empty = renderDetailComposeHeading({
    width: 80,
    name: "reviewer",
    task: 3,
    sendable: true,
    empty: true,
    theme,
  });
  assert.match(empty, /message is empty · Esc discard/);
});

test("the compose heading fits CJK names and narrow rows without breaking", () => {
  const raw = "昵称\u001b[31mx\u001b[0m\u0007\u202e\tname";
  for (const width of [60, 40, 24, 14]) {
    const heading = renderDetailComposeHeading({
      width,
      name: raw,
      task: 4,
      sendable: true,
      theme,
    });
    assert(visibleWidth(heading) <= width, `${width}: ${JSON.stringify(heading)}`);
    assert.doesNotMatch(heading, /[\p{Cc}\p{Bidi_Control}]/u);
  }
});

// ---- Summary hierarchy ----

test("elevated context and turn pressure survive a narrow dock without a percent", () => {
  const hot = input({
    runtime: { activity: "generating", context: { tokens: 259_000, context_window: 272_000 } },
  });
  // The labelled ratio stays at a narrow width; the percent never returns.
  const row = renderDetailSummary(hot, theme, 40, { activity: false })[0];
  assert.match(row, /ctx ≈259k\/272k/, row);
  assert.doesNotMatch(row, /≈\S+ \d+%/, "the retired context percent never returns");
  // Turns at >= 80% keep the same slash form.
  const turns = input({ turns: 205, max_turns: 256 });
  const turnsRow = renderDetailSummary(turns, theme, 40, { activity: false })[0];
  assert.match(turnsRow, /↻205\/256/, turnsRow);
  // Unknown figures stay unknown: no invented zeros, percents or prices.
  const unknown = input({
    usage: undefined,
    runtime: { activity: "generating", context: { tokens: null, context_window: 272_000 } },
  });
  const unknownRow = renderDetailSummary(unknown, theme, 48, { activity: false })[0];
  assert.match(unknownRow, /ctx \?\/272k/, unknownRow);
  assert.doesNotMatch(unknownRow, /\$/, unknownRow);
  assert.doesNotMatch(unknownRow, /0%|\?%/, "an unknown percent is never fabricated");
  // Every row fits its width, whatever survives.
  const both = input({
    turns: 205,
    max_turns: 256,
    runtime: { activity: "generating", context: { tokens: 259_000, context_window: 272_000 } },
  });
  for (const width of [48, 40, 30, 20, 13, 8]) {
    const squeezed = renderDetailSummary(both, theme, width, { activity: false })[0];
    assert(visibleWidth(squeezed) <= width, `${width}: ${JSON.stringify(squeezed)}`);
  }
});

test("the summary can skip its activity row when none is allocated for it", () => {
  const base = input({}, { active_tools: [{ name: "read", detail: "src/core/controller.ts" }] });
  const rows = renderDetailSummary(base, theme, 60, { activity: true });
  assert.equal(rows.length, 2, "the explicit activity row stays available to other callers");
  const metricsOnly = renderDetailSummary(base, theme, 60, { activity: false });
  assert.equal(metricsOnly.length, 1, "activity: false paints the metrics row only");
  assert.equal(metricsOnly[0], rows[0], "the metrics row itself is unchanged");
});

test("attention notes are one pure collection shared by rows and tab markers", () => {
  const base = input({
    outcome: { status: "needs_input", question: "Which branch?", limit_reached: true },
    unavailable_reason: "SESSION_UNAVAILABLE",
    owner_error: "flock lost",
    cleanup_errors: ["child did not exit"],
    history_error: "disk full",
    pending_messages: 2,
    discarded_inputs: ["stale steer"],
    dispatch_notes: ["tree_shared"],
    drain: { waiting_for: "sdk_idle", elapsed_ms: 1_200 },
    human_steered: true,
  });
  const notes = getDetailAttentionNotes(base);
  // Ordered by what blocks progress soonest, under stable category keys.
  assert.deepEqual(
    notes.map((note) => note.key),
    [
      "asked",
      "owner",
      "session",
      "cleanup",
      "drain",
      "turn-limit",
      "history",
      "pending-alerts",
      "dispatch",
      "discarded",
      "human-steer",
    ],
  );
  assert.equal(notes[0].text, "asked: Which branch?");
  assert.equal(notes[0].severity, "question");
  assert.equal(notes.at(-1).severity, "info", "a human steer admission is informational");
  // The rendered rows are exactly the collection's first two, +N for the rest.
  const rows = renderDetailAttention(base, theme, 100);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\? asked: Which branch\?/);
  assert.match(rows[1], /✗ owner: flock lost/);
  assert.match(rows[1], /\+9 · I info/);
  // A draining peer carries the warning marker its attention rows claim.
  const strip = (overrides = {}) =>
    renderDetailAgentStrip({
      entries: [
        {
          agent_id: "d",
          input: input({
            name: "draining",
            drain: { waiting_for: "sdk_idle", elapsed_ms: 100 },
          }),
        },
        { agent_id: "i", input: input({ name: "steered", human_steered: true }) },
        {
          agent_id: "q",
          input: input({
            name: "asking",
            outcome: { status: "needs_input", question: "Q?", limit_reached: false },
          }),
        },
        {
          agent_id: "e",
          input: input({
            name: "errored",
            outcome: { status: "failed", error: "boom", limit_reached: false },
          }),
        },
        { agent_id: "c", input: input({ name: "clean" }) },
      ],
      selected: "c",
      width: 90,
      spinnerFrame: 0,
      theme,
      ...overrides,
    }).text;
  assert.match(strip(), /draining !/);
  assert.match(strip(), /errored !/);
  assert.doesNotMatch(strip(), /steered [?!]/, "an admitted human steer is informational");
  assert.match(strip(), /asking \?/);
  assert.doesNotMatch(strip(), /asking !/, "a question is not a warning");
  assert.doesNotMatch(strip(), /clean [?!]/);
});

test("attention takes the caller's final row budget and transient extra notes", () => {
  const base = input({
    outcome: { status: "needs_input", question: "Which branch?", limit_reached: true },
    owner_error: "flock lost",
    cleanup_errors: ["child did not exit"],
    history_error: "disk full",
    pending_messages: 2,
    discarded_inputs: ["stale steer"],
    dispatch_notes: ["tree_shared"],
  });
  // Eight notes: asked, owner, cleanup, turn-limit, history, pending,
  // dispatch, discarded.
  const notes = getDetailAttentionNotes(base);
  assert.equal(notes.length, 8);
  // The default two rows are unchanged.
  const rows = renderDetailAttention(base, theme, 100);
  assert.equal(rows.length, 2);
  assert.match(rows.at(-1), /\+6 · I info/);
  // maxRows is the FINAL budget: one row counts all seven hidden notes.
  const one = renderDetailAttention(base, theme, 100, { maxRows: 1 });
  assert.equal(one.length, 1);
  assert.match(one[0], /\+7 · I info/);
  // Zero rows paint none; the caller counts the collection itself.
  assert.deepEqual(renderDetailAttention(base, theme, 100, { maxRows: 0 }), []);
  assert.equal(getDetailAttentionNotes(base).length, 8);
  // The budget may exceed two rows; only the notes bound it.
  const three = renderDetailAttention(base, theme, 100, { maxRows: 3 });
  assert.equal(three.length, 3);
  assert.doesNotMatch(three[0], /\+\d/);
  assert.match(three.at(-1), /\+5 · I info/);
  // Transient facts join the collection instead of pushing raw rows.
  const accepted = {
    key: "recent-steer",
    priority: 12,
    glyph: "✓",
    color: "dim",
    text: "Steer accepted · delivery unconfirmed",
  };
  const withExtra = renderDetailAttention(base, theme, 100, { extraNotes: [accepted] });
  assert.equal(withExtra.length, 2);
  assert.match(withExtra.at(-1), /\+7 · I info/, "the transient note is counted too");
  // A high-priority transient tops the order.
  const urgent = renderDetailAttention(base, theme, 100, {
    extraNotes: [{ ...accepted, key: "accepted", priority: 0, text: "Steer accepted" }],
  });
  assert.match(urgent[0], /✓ Steer accepted/);
  assert.match(urgent.at(-1), /\+7 · I info/);
  // An already-collected base collection renders without rebuilding.
  assert.deepEqual(
    renderDetailAttention(base, theme, 100, { notes }),
    renderDetailAttention(base, theme, 100),
  );
  assert.deepEqual(
    renderDetailAttention(base, theme, 100, { notes, extraNotes: [accepted] }),
    withExtra,
  );
  // Extra notes never leak into the pure collection of the view itself.
  assert.equal(getDetailAttentionNotes(base).length, 8);
});

test("info accepts the parent's bounded wrap callback for both layouts", () => {
  const wrapped = [];
  const wrap = (text, width) => {
    wrapped.push([text, width]);
    return wrapText(text, width);
  };
  // The single-column path delegates its wrapping to the callback.
  const narrow = renderDetailInfo(input(), theme, 100, wrap);
  assert.deepEqual(narrow, renderDetailInfo(input(), theme, 100));
  assert.ok(wrapped.length > 0, "the single-column path wraps through the callback");
  // The two-column path does too, with each column's own bound.
  wrapped.length = 0;
  const wide = renderDetailInfo(input({ description: "审查".repeat(30) }), theme, 120, wrap);
  assert.deepEqual(wide, renderDetailInfo(input({ description: "审查".repeat(30) }), theme, 120));
  assert.ok(wrapped.length > 0, "the two-column path wraps through the callback");
  assert.ok(
    wrapped.every(([, width]) => width === 47),
    "wrapping is bounded by the column, not the pane",
  );
});
