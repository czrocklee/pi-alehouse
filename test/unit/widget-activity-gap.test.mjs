import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, styleTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

// Load the production source, not a potentially stale dist renderer.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderRunningLines } = await jiti.import("../../src/orchestration/ui/widget-render.ts");

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const italic = (text) => styleTextWithAnsi(text, undefined, undefined, { italic: true });
const italicTheme = { ...plainTheme, italic };
const run = (overrides = {}) => ({
  agent_id: "a-editor",
  run_id: "r-current",
  resident: true,
  name: "editor",
  profile: "editor",
  model: "test-model",
  difficulty: 3,
  effort: "medium",
  description: "Review the compact activity gap",
  status: "running",
  finishing: false,
  execution_exited: false,
  turns: 2,
  max_turns: 20,
  elapsed_ms: 193_000,
  turn_elapsed_ms: 1_200,
  tool_uses: 3,
  active_tools: [],
  preview: "",
  question: false,
  limit_reached: false,
  pending_messages: 0,
  has_run_warnings: false,
  ...overrides,
});
const activity = (current, theme = plainTheme, width = 100) =>
  renderRunningLines(current, 0, theme, width)[1];

test("the compact gap between clock and activity is exactly one ASCII space", () => {
  for (const [current, tail] of [
    [run(), "thinking…"],
    [run({ channel: "thinking", thinking: "" }), "thinking…"],
    [run({ channel: "text", preview: "" }), "replying…"],
    [run({ channel: "thinking", thinking: "考虑中" }), "thinking: 考虑中"],
    [run({ channel: "text", preview: "回复 👩‍💻" }), "replying: 回复 👩‍💻"],
    [run({ active_tools: [{ name: "read", detail: "src/文件.ts" }] }), "reading src/文件.ts"],
    [run({ active_tools: [{ name: "bash", detail: "printf hello" }] }), "running printf hello"],
    [run({ active_tools: [{ name: "grep", detail: "gap|pattern" }] }), "searching gap|pattern"],
  ]) {
    const line = activity(current);
    assert.equal(stripTerminalSequences(line), `  ⎿  1.2s ${tail}`);
    // Exact equality pins precisely one space; this only documents the intent.
    assert.ok(line.includes(`1.2s ${tail}`), JSON.stringify(line));
    assert.doesNotMatch(line, / · /, "no dot separator");
  }
});

test("without a current turn the subline has neither clock nor stray gap", () => {
  for (const current of [
    run({ turn_elapsed_ms: undefined }),
    run({ finishing: true }),
    run({ status: "cancelling" }),
  ]) {
    const line = activity(current);
    assert.match(line, /^ {2}⎿ {2}\S/, JSON.stringify(line));
    assert.doesNotMatch(line, / · |^\s{3,}\S/);
  }
  assert.equal(
    stripTerminalSequences(activity(run({ turn_elapsed_ms: undefined }))),
    "  ⎿  thinking…",
  );
  assert.equal(stripTerminalSequences(activity(run({ finishing: true }))), "  ⎿  finishing…");
  assert.equal(stripTerminalSequences(activity(run({ status: "cancelling" }))), "  ⎿  cancelling…");
});

test("the clock stays upright and warning-tinted at one minute while the activity italicizes", () => {
  for (const [turn_elapsed_ms, clock, color] of [
    [1_200, "1.2s", "dim"],
    [61_000, "1m01s", "warning"],
  ]) {
    const paints = [];
    const theme = {
      bold: (text) => text,
      fg: (paint, text) => {
        paints.push([paint, text]);
        return text;
      },
      italic,
    };
    const [header, line] = renderRunningLines(
      run({ channel: "text", preview: "检查 👩‍💻", turn_elapsed_ms }),
      0,
      theme,
      100,
    );
    assert.ok(
      paints.some(([paint, text]) => paint === color && text === clock),
      JSON.stringify(paints),
    );
    assert.ok(
      paints.every(([paint, text]) => paint !== "dim" || text !== " "),
      "the gap is a plain space, not a painted separator",
    );
    assert.equal(stripTerminalSequences(line), `  ⎿  ${clock} replying: 检查 👩‍💻`);
    assert.equal(line, `  ⎿  ${clock} ` + italic("replying: 检查 👩‍💻"));
    assert.equal(header, stripTerminalSequences(header), "the header stays upright");
  }
});

test("CJK, emoji and dirty text clip after the gap without overrunning the width", () => {
  const dirty = "\u001b[31m检查\u001b[0m 👩‍💻 é\u0007\u202e\t tail";
  for (const state of [
    { channel: "thinking", thinking: dirty },
    { channel: "text", preview: dirty },
    { active_tools: [{ name: "bash", detail: dirty }] },
  ]) {
    for (const width of [10, 12, 16, 20, 40, 100]) {
      const current = run(state);
      const line = activity(current, plainTheme, width);
      assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
      assert.doesNotMatch(stripTerminalSequences(line), /[\p{Cc}\p{Bidi_Control}]/u);
      const styled = activity(current, italicTheme, width);
      assert.equal(stripTerminalSequences(styled), stripTerminalSequences(line));
      assert.ok(visibleWidth(styled) <= width, `${width}: styled overrun`);
    }
    const full = stripTerminalSequences(activity(run(state), plainTheme, 200));
    assert.match(full, /^ {2}⎿ {2}1\.2s /);
    assert.ok(full.includes("检查 👩‍💻"), full);
  }
});
