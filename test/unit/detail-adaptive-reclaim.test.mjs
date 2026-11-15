import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Direct source regressions for the pane's two adaptive layouts: the bottom
// dock's model/effort reclaim after optional figures yield, and the title's
// untagged name floor. No build, model, credentials, network or real session.
//
// HOME, USERPROFILE and the XDG/Pi dirs are owned temp paths set before the SDK
// and source imports: pi-tui reads user configuration while it initializes.
const isolatedKeys = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
];
const previousEnv = Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "alehouse-detail-adaptive-reclaim-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
test.after(async () => {
  for (const key of isolatedKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

const { createJiti } = await import("jiti");
const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailSummary, renderDetailTitle } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);
const { addToLedger } = await jiti.import("../../src/orchestration/core/usage-ledger.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const ansi = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
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
const live = { active_tools: [], tool_uses: 12, preview: "" };
const row = (overrides = {}, width = 120, paint = theme) =>
  renderDetailSummary({ view: view(overrides), live }, paint, width, { activity: false })[0];
const plain = (text) => stripTerminalSequences(text);
const title = (overrides, width) =>
  stripTerminalSequences(renderDetailTitle({ view: view(overrides), live }, theme, width));

// ---- The dock: a surviving model/effort reclaims cells freed by drops ----

test("the model/effort text reclaims cells freed by a dropped total", () => {
  // The total drops at 92; the model then grows back into every freed cell,
  // stopping at the full original text rather than at the old five-cell floor.
  for (const [width, model] of [
    [92, "claude-opus-5/med…"],
    [91, "claude-opus-5/me…"],
    [80, "claud…"],
    [79, "clau…"],
  ]) {
    const text = plain(row({}, width));
    assert.equal(visibleWidth(text), width, `${width}: maximal fit: ${text}`);
    assert.ok(text.includes(` · ${model} · `), `${width}: ${text}`);
    assert.doesNotMatch(text, /total/, `${width}: the total stays dropped`);
  }
});

test("reclaim never reintroduces a dropped metric or reorders the ladder", () => {
  const cases = [
    {
      width: 92,
      model: "claude-opus-5/med…",
      absent: [/total/],
      present: [/↻3\/256/, /ctx ≈59k\/500k/, /↑80k \(75\.0%\) ↓5\.0k/, /\$1\.23/],
    },
    {
      width: 78,
      model: "claude-opus…",
      absent: [/total/, /%\)/],
      present: [/↻3\/256/, /ctx ≈59k\/500k/, /↑80k ↓5\.0k/, /\$1\.23/],
    },
    {
      width: 70,
      model: "claude-opus-5/me…",
      absent: [/total/, /%\)/, /↑/],
      present: [/↻3\/256/, /ctx ≈59k\/500k/, /\$1\.23/],
    },
    {
      width: 57,
      model: "claude-opus…",
      absent: [/total/, /%\)/, /↑/, /\$/],
      present: [/↻3\/256/, /ctx ≈59k\/500k/],
    },
    {
      width: 49,
      model: "claude-opus-…",
      absent: [/total/, /%\)/, /↑/, /\$/, /↻/],
      present: [/ctx ≈59k\/500k/],
    },
  ];
  for (const { width, model, absent, present } of cases) {
    const text = plain(row({}, width));
    assert.equal(visibleWidth(text), width, `${width}: maximal fit: ${text}`);
    assert.ok(text.includes(` · ${model} · `), `${width}: ${text}`);
    for (const pattern of absent) assert.doesNotMatch(text, pattern, `${width}: ${pattern}`);
    for (const pattern of present) assert.match(text, pattern, `${width}: ${pattern}`);
  }
});

test("reclaim respects the clock's reserved cells at ticks and minute boundaries", () => {
  // The clock reserves its widest same-magnitude spelling, so ordinary ticks
  // and the minute boundary leave the model's reclaimed cells unchanged. Only
  // a new minute digit adds one reserved cell and shortens the model by one.
  for (const [ms, clock, model] of [
    [59_900, "(59s)", "claude-opus-5/med…"],
    [60_000, "(1m00s)", "claude-opus-5/med…"],
    [62_000, "(1m02s)", "claude-opus-5/med…"],
    [600_000, "(10m00s)", "claude-opus-5/me…"],
    [6_000_000, "(100m00s)", "claude-opus-5/m…"],
  ]) {
    const text = plain(row({ turn_elapsed_ms: ms }, 92));
    assert.equal(visibleWidth(text), 92, `${ms}: ${text}`);
    assert.ok(text.includes(clock), `${ms}: ${text}`);
    assert.ok(text.includes(` · ${model} · `), `${ms}: ${text}`);
    assert.doesNotMatch(text, /total/, `${ms}: the total stays dropped`);
  }
});

test("CJK, emoji and ANSI reclaim terminal cells without splitting graphemes", () => {
  for (const [model, width, expected] of [
    ["測試模型", 92, "測試模型/medium"],
    ["測試模型", 49, "測試模型/med…"],
    ["測試模型", 45, "測試模型…"],
    ["👩‍💻👩‍💻👩‍💻", 92, "👩‍💻👩‍💻👩‍💻/medium"],
    ["👩‍💻👩‍💻👩‍💻", 49, "👩‍💻👩‍💻👩‍💻/medium"],
    ["👩‍💻👩‍💻👩‍💻", 45, "👩‍💻👩‍💻👩‍💻/m…"],
  ]) {
    const overrides = { effective_settings: settings({ model }) };
    const text = plain(row(overrides, width));
    assert.ok(visibleWidth(text) <= width, `${model} ${width}: ${text}`);
    assert.ok(text.includes(` · ${expected} · `), `${model} ${width}: ${text}`);
    assert.doesNotMatch(text, /total/, `${model} ${width}: the total stays dropped`);
    assert.doesNotMatch(text, /\p{Cc}/u, `${model} ${width}: no raw control reaches the dock`);
    // ANSI paint must measure by terminal cells, not escape bytes.
    assert.equal(
      plain(row(overrides, width, ansi)),
      text,
      `${model} ${width}: ANSI paint keeps the same cells`,
    );
  }
});

test("a shortened model keeps its floor, and a full model is never padded to it", () => {
  for (const width of [92, 91, 80, 78, 70, 57, 49, 45]) {
    const model = plain(row({}, width)).split(" · ")[1];
    assert.ok(visibleWidth(model) >= 5, `${width}: shortened model ${JSON.stringify(model)}`);
  }
  // A full model shorter than the floor stays whole and unpadded.
  const short = plain(row({ effective_settings: settings({ model: "m", thinking: "" }) }, 92));
  assert.match(short, / · m · /, short);
  assert.ok(visibleWidth(short) <= 92, short);
  // Reclaim stops at the full original text instead of padding to the row.
  const full = plain(row({ effective_settings: settings({ model: "m", thinking: "medium" }) }, 92));
  assert.match(full, / · m\/medium · /, full);
  assert.doesNotMatch(full, /total/, full);
  assert.equal(visibleWidth(full), 82, full);
});

// ---- The title: an untagged name keeps the tagged name floor ----

test("an untagged name keeps the tagged name floor at the task boundary", () => {
  // Ada needs three cells, so 16/17 cells fall back to the whole name plus cue;
  // the task returns at 18 rather than surviving beside a lone ellipsis.
  for (const width of [16, 17]) {
    const text = title({ name: "Ada", task: 1 }, width);
    assert.ok(visibleWidth(text) <= width, `${width}: ${text}`);
    assert.match(text, /^Ada\s+· #1$/, `${width}: ${text}`);
    assert.doesNotMatch(text, /Review/, `${width}: the task yields before a lone ellipsis`);
  }
  const at18 = title({ name: "Ada", task: 1 }, 18);
  assert.match(at18, /^Ada {2}Review/, at18);
  assert.match(at18, /#1$/, at18);
  // The run-id fallback cue is wider, so the same boundary shifts by its cells.
  for (const width of [21, 22]) {
    const text = title({ name: "Ada", task: NaN }, width);
    assert.ok(visibleWidth(text) <= width, `${width}: ${text}`);
    if (width === 21) {
      assert.match(text, /^Ada\s+· r-8f3a$/, text);
      assert.doesNotMatch(text, /Review/, text);
    } else {
      assert.match(text, /^Ada {2}Review/, text);
      assert.match(text, /r-8f3a$/, text);
    }
  }
});

test("the untagged task candidate respects each name's own floor, cue and width", () => {
  for (const name of ["Ada", "Alexandra-the-long-nickname", "艾达", "👩‍💻"]) {
    const floor = Math.min(3, visibleWidth(name));
    for (let width = 6; width <= 60; width++) {
      const text = title({ name, task: 1 }, width);
      assert.ok(visibleWidth(text) <= width, `${name} ${width}: ${text}`);
      assert.doesNotMatch(text, /[\p{Cc}\p{Bidi_Control}]/u, `${name} ${width}: controls`);
      assert.doesNotMatch(
        text,
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
        `${name} ${width}: split surrogate`,
      );
      assert.doesNotMatch(text, /\u200d(?:…|$)/, `${name} ${width}: dangling ZWJ`);
      if (width >= 5) assert.match(text, /#1/, `${name} ${width}: whole cue`);
      // A task candidate is identity + two spaces + task + cue. Its identity
      // must keep the same floor as the tagged candidate.
      const head = /^(.*?) {2}(?=\S)/.exec(text)?.[1];
      if (head && text.includes("Review"))
        assert.ok(
          visibleWidth(head) >= floor,
          `${name} ${width}: identity ${JSON.stringify(head)} keeps fewer than ${floor} cells`,
        );
    }
  }
});
