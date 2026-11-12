import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, styleTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

// Load the production source, not a potentially stale dist renderer.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderActivity } = await jiti.import("../../src/orchestration/ui/format.ts");
const { renderRunningLines } = await jiti.import("../../src/orchestration/ui/widget-render.ts");

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const italic = (text) => styleTextWithAnsi(text, undefined, undefined, { italic: true });
const italicTheme = { ...plainTheme, italic };
const live = (overrides = {}) => ({ preview: "", ...overrides });
const run = (overrides = {}) => ({
  agent_id: "a-editor",
  run_id: "r-current",
  resident: true,
  name: "editor",
  profile: "editor",
  model: "test-model",
  difficulty: 3,
  effort: "medium",
  description: "Review activity previews",
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

function recordingTheme() {
  const colors = [];
  const italics = [];
  return {
    colors,
    italics,
    theme: {
      bold: (text) => text,
      fg: (color, text) => {
        colors.push([color, text]);
        // Real ANSI, with closing color resets inside the eventual italic span.
        return styleTextWithAnsi(
          text,
          color === "muted" ? "\u001b[37m" : "\u001b[90m",
          undefined,
          {},
        );
      },
      italic: (text) => {
        italics.push(text);
        return italic(text);
      },
    },
  };
}

test("thinking and replying italicize the prefix together with the colored summary", () => {
  for (const [channel, field, prefix] of [
    ["thinking", "thinking", "thinking: "],
    ["text", "preview", "replying: "],
  ]) {
    const { theme, colors, italics } = recordingTheme();
    const result = renderActivity([], live({ channel, [field]: "检查 👩‍💻 summary" }), theme, 80);
    assert.deepEqual(
      colors.filter(([, text]) => text),
      [
        ["dim", prefix],
        ["muted", "检查 👩‍💻 summary"],
        ["dim", ", "], // Existing separator styling is evaluated even for one part.
      ],
    );
    assert.equal(italics.length, 1, "one whole activity, not separate prefix/detail styling");
    assert.equal(stripTerminalSequences(italics[0]), `${prefix}检查 👩‍💻 summary`);
    const colored = renderActivity(
      [],
      live({ channel, [field]: "检查 👩‍💻 summary" }),
      { ...theme, italic: undefined },
      80,
    );
    assert.equal(italics[0], colored, "italic receives the already-colored activity");
    assert.equal(result, italic(colored));
  }
});

test("optional italic preserves plain output, its receiver, and empty-width behavior", () => {
  const state = live({ channel: "text", preview: "summary" });
  assert.equal(renderActivity([], state, plainTheme, 80), "replying: summary");
  const theme = {
    ...plainTheme,
    calls: [],
    italic(text) {
      this.calls.push(text);
      return italic(text);
    },
  };
  assert.equal(renderActivity([], state, theme, 80), italic("replying: summary"));
  assert.deepEqual(theme.calls, ["replying: summary"]);
  assert.equal(renderActivity([], state, theme, 0), "");
  assert.equal(theme.calls.length, 1, "no style call for an empty activity");
});

test("empty thinking and replying placeholders are wholly italic", () => {
  for (const [state, expected] of [
    [live(), "thinking…"],
    [live({ channel: "thinking", thinking: "" }), "thinking…"],
    [live({ channel: "text", preview: "" }), "replying…"],
  ]) {
    assert.equal(renderActivity([], state, plainTheme, 80), expected);
    assert.equal(renderActivity([], state, italicTheme, 80), italic(expected));
  }
});

test("tool actions and arguments share italics regardless of path semantics", () => {
  for (const [name, detail, expected] of [
    ["read", "src/文件.ts", "reading src/文件.ts"],
    ["bash", "printf hello", "running printf hello"],
    ["grep", "thinking|replying", "searching thinking|replying"],
    ["alert_parent", "Review ready", "alerting you: Review ready"],
  ]) {
    const tools = [{ name, detail }];
    assert.equal(renderActivity(tools, live(), plainTheme, 80), expected);
    const { theme, colors, italics } = recordingTheme();
    const result = renderActivity(tools, live(), theme, 80);
    assert.equal(italics.length, 1);
    assert.equal(stripTerminalSequences(italics[0]), expected);
    assert.equal(result, italic(italics[0]));
    assert.equal(colors.find(([color]) => color === "muted")[1], detail);
    assert.equal(colors.find(([color]) => color === "dim")[1] + detail, expected);
  }
  for (const tools of [
    [
      { name: "read", detail: "a.ts" },
      { name: "bash", detail: "echo hello" },
    ],
    [{ name: "read" }, { name: "read" }, { name: "bash" }],
  ]) {
    const expected = renderActivity(tools, live(), plainTheme, 80);
    assert.equal(renderActivity(tools, live(), italicTheme, 80), italic(expected));
  }
});

test("sanitization, CJK/emoji graphemes and narrow clipping happen before italics", () => {
  const dirty = "\u001b[31m检查\u001b[0m 👩‍💻 é\u0007\u202e\t tail";
  const states = [
    [[], live({ channel: "thinking", thinking: dirty })],
    [[], live({ channel: "text", preview: dirty })],
    [[{ name: "bash", detail: dirty }], live()],
    [[{ name: "read", detail: `src/${dirty}/文件.ts` }], live()],
    [
      [
        { name: "read", detail: "中文.ts" },
        { name: "bash", detail: dirty },
      ],
      live(),
    ],
  ];
  for (const [tools, state] of states) {
    for (const width of [0, 1, 2, 8, 13, 20, 40, 100]) {
      const plain = renderActivity(tools, state, plainTheme, width);
      const styled = renderActivity(tools, state, italicTheme, width);
      assert.equal(styled, plain ? italic(plain) : "", `${width}: clip before styling`);
      assert.equal(stripTerminalSequences(styled), plain);
      assert.ok(visibleWidth(styled) <= width, `${width}: ${JSON.stringify(styled)}`);
      assert.doesNotMatch(plain, /[\p{Cc}\p{Bidi_Control}]/u);
    }
  }
  const full = renderActivity([], states[0][1], plainTheme, 100);
  assert.match(full, /检查 👩‍💻 é/);
  assert.match(full, /\\x07/);
  assert.match(full, /\\u202e/);
});

test("the first row, tree branch and current-turn clock remain upright", () => {
  for (const turn_elapsed_ms of [1_200, 61_000]) {
    const current = run({
      channel: "text",
      preview: "检查 👩‍💻",
      turn_elapsed_ms,
      pending_messages: 2,
    });
    const plain = renderRunningLines(current, 0, plainTheme, 100);
    const styled = renderRunningLines(current, 0, italicTheme, 100);
    const clock = turn_elapsed_ms === 1_200 ? "1.2s" : "1m01s";
    const prefix = `  ⎿  ${clock} `;
    assert.equal(styled[0], plain[0], "no first-row styling change");
    assert.equal(styled[1], prefix + italic("replying: 检查 👩‍💻"));
    assert.equal(stripTerminalSequences(styled[1]), plain[1]);
    assert.doesNotMatch(styled[1], /3m13s|turn /, "the clock is turn duration, not Run elapsed");
    const { theme, colors } = recordingTheme();
    renderRunningLines(current, 0, theme, 100);
    assert.ok(
      colors.some(
        ([color, text]) =>
          text === clock && color === (turn_elapsed_ms >= 60_000 ? "warning" : "dim"),
      ),
    );
  }
  for (const width of [12, 20, 32, 60]) {
    const current = run({ channel: "thinking", thinking: "检查 👩‍💻".repeat(10) });
    const plain = renderRunningLines(current, 0, plainTheme, width);
    const styled = renderRunningLines(current, 0, italicTheme, width);
    assert.equal(styled[0], plain[0], "narrow first-row rendering is unchanged");
    assert.deepEqual(styled.map(stripTerminalSequences), plain.map(stripTerminalSequences));
    for (const row of styled) assert.ok(visibleWidth(row) <= width);
  }
});

test("retry and cancellation system statuses stay upright, but active tools do not", () => {
  for (const overrides of [
    { runtime: { activity: "retrying" } },
    { status: "cancelling" },
    { finishing: true },
    { runtime: { activity: "compacting" } },
  ]) {
    const current = run(overrides);
    const { theme, italics } = recordingTheme();
    renderRunningLines(current, 0, theme, 100);
    assert.deepEqual(italics, [], "system status is not an ordinary activity preview");
    assert.deepEqual(
      renderRunningLines(current, 0, italicTheme, 100),
      renderRunningLines(current, 0, plainTheme, 100),
    );
    renderRunningLines(
      { ...current, active_tools: [{ name: "read", detail: "a.ts" }] },
      0,
      theme,
      100,
    );
    assert.equal(italics.length, 1, "real tools still use the shared activity style");
    assert.equal(stripTerminalSequences(italics[0]), "reading a.ts");
  }
});
