/** Source-only public transcript regressions. Native definitions supply display
 * callbacks only: no command, write, execute hook, provider or network is run. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "alehouse-argument-fidelity-"));
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ...["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
    `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
    join(home, "xdg", kind.toLowerCase()),
  ]),
]) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { createJiti } = await import("jiti");
const { createBashToolDefinition, createWriteToolDefinition, getMarkdownTheme, initTheme } =
  await import("@earendil-works/pi-coding-agent");
const { validateToolArguments } = await import("@earendil-works/pi-ai");
initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const cwd = join(home, "never-executed");
const definitions = {
  bash: createBashToolDefinition(cwd),
  write: createWriteToolDefinition(cwd),
};

function pane(t, name, args, mode) {
  const toolCall = { type: "toolCall", id: "fidelity", name, arguments: args };
  const messages = [
    { role: "assistant", content: [toolCall], stopReason: "toolUse", timestamp: 1 },
  ];
  const before = structuredClone(messages);
  const seen = [];
  const native = definitions[name];
  // Validation is observation only. In particular, it must not erase the text
  // that the transcript subsequently projects, even for extra object keys.
  assert.deepEqual(validateToolArguments(native, toolCall), args);
  const renderers =
    mode === "native"
      ? {
          renderShell: native.renderShell,
          renderCall(args, theme, context) {
            assert.equal(context.args, args, "both callback argument views are one fresh copy");
            assert.equal(context.argsComplete, false);
            assert.equal(context.executionStarted, false);
            seen.push(structuredClone(args));
            return native.renderCall(args, theme, context);
          },
          renderResult: native.renderResult,
          execute() {
            assert.fail("transcript must not execute tools");
          },
        }
      : {};
  const content = new TranscriptContent({
    tui: { requestRender() {}, terminal: { columns: 240, rows: 40 } },
    cwd,
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => renderers,
    },
  });
  t.after(() => {
    content.dispose();
    assert.deepEqual(messages, before, "recorded argument bytes/data are never rewritten");
  });
  content.setToolsExpanded(true);
  const frame = content.frame(240);
  // Remove SDK paint and the write renderer's OSC8 path link only, not
  // arbitrary protocols (notably the OSC52 shell-source fixture above).
  const text = frame
    .slice(0, frame.lineCount)
    .join("\n")
    // eslint-disable-next-line no-control-regex -- match SDK SGR paint literally
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex -- match SDK OSC8 path links literally
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  assert.ok(!text.includes("\x1b"), "no raw ESC survives in native/raw argument rows");
  return { text, seen };
}

for (const mode of ["native", "raw"]) {
  for (const [label, command, expected] of [
    ["malformed CSI", "echo safe\x1b[ ; echo hidden ; m", "echo safe\\x1b[ ; echo hidden ; m"],
    [
      "complete OSC carrying shell source",
      "echo before\x1b]52;c;$(echo OSC_SHELL_SOURCE); echo hidden\x07 after",
      "echo before\\x1b]52;c;$(echo OSC_SHELL_SOURCE); echo hidden\\x07 after",
    ],
  ]) {
    test(`${mode}: ${label} remains literal evidence, not a stripped payload`, (t) => {
      const { text, seen } = pane(t, "bash", { command }, mode);
      assert.ok(text.includes(expected), "all ordinary shell-source text stays visible");
      assert.ok(text.includes("hidden"));
      if (mode === "native") {
        assert.ok(seen.length > 0);
        for (const args of seen) assert.equal(args.command, expected);
      }
    });
  }

  test(`${mode}: an extra ESC key cannot overwrite the real command`, (t) => {
    const args = {
      command: "echo REAL_COMMAND",
      "\x1b[mcommand": "echo SPOOF_COMMAND",
      "\x1bkey": "ESC_KEY_VALUE",
      "\\x1bkey": "LITERAL_KEY_VALUE",
    };
    const { text, seen } = pane(t, "bash", args, mode);
    assert.ok(text.includes("echo REAL_COMMAND"));
    if (mode === "native") {
      for (const received of seen) {
        assert.equal(received.command, "echo REAL_COMMAND");
        assert.equal(received["\\x1b[mcommand"], "echo SPOOF_COMMAND");
        assert.equal(received["\\x1bkey"], "ESC_KEY_VALUE");
        assert.equal(received["\\\\x1bkey"], "LITERAL_KEY_VALUE");
        assert.equal(Object.keys(received).length, 4, "encoded keys stay distinct");
      }
      assert.ok(!text.includes("SPOOF_COMMAND"), "native bash uses the actual command field");
    } else {
      for (const literal of [
        "\\x1b[mcommand: echo SPOOF_COMMAND",
        "\\x1bkey: ESC_KEY_VALUE",
        "\\\\x1bkey: LITERAL_KEY_VALUE",
      ])
        assert.ok(text.includes(literal), `${literal} remains independently readable`);
    }
  });

  test(`${mode}: backslash spellings and actual C0/C1/DEL/bidi controls stay distinct`, (t) => {
    const command = "echo A\tB\\x09 C\x00D\\x00 E\x7fF\\x7f G\x85H\\x85 I\u202eJ\\u202e";
    const expected =
      "echo A\\x09B\\\\x09 C\\x00D\\\\x00 E\\x7fF\\\\x7f G\\x85H\\\\x85 I\\u202eJ\\\\u202e";
    const { text, seen } = pane(t, "bash", { command }, mode);
    assert.ok(text.includes(expected), "control escapes cannot impersonate literal backslashes");
    if (mode === "native") for (const args of seen) assert.equal(args.command, expected);
  });

  test(`${mode}: write tabs escape while NBSP, ideographic spaces, graphemes and LF survive`, (t) => {
    const first = "TAB\tEND NBSP\u00a0END IDEO\u3000END";
    const second = "NEXT_LINE e\u0301 👍 👨‍👩‍👧‍👦";
    const args = { path: "recorded.txt", content: `${first}\n${second}` };
    const { text, seen } = pane(t, "write", args, mode);
    assert.ok(text.includes("TAB\\x09END"), "native replaceTabs cannot hide an actual tab");
    assert.ok(text.includes("NBSP\u00a0END"));
    assert.ok(text.includes("IDEO\u3000END"));
    assert.ok(text.includes(second), "combining marks and ZWJ sequences are intact");
    assert.ok(text.indexOf("\n", text.indexOf("TAB\\x09END")) < text.indexOf(second));
    if (mode === "native") {
      for (const received of seen) {
        assert.equal(received.content, `TAB\\x09END NBSP\u00a0END IDEO\u3000END\n${second}`);
      }
    }
  });
}
