import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DetailPane } from "../../dist/orchestration/ui/agent-detail.js";
import { humanSteerLead, requestHumanSteer } from "../../dist/orchestration/runtime/human-steer.js";
import { settings } from "../support/controller-fixture.mjs";

initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
const ENTER = "\r";
const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const paste = (text) => PASTE_START + text + PASTE_END;
// Inspect only user text: Input's trusted cursor marker/reverse video is expected.
const assertSafeDraft = (text) => {
  assert.doesNotMatch(text, /\p{Cc}|\p{Bidi_Control}/u);
};
const view = (agent_id = "a", extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  description: "Message fixture",
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  isolation: "shared",
  elapsed_ms: 0,
  turns: 1,
  max_turns: 8,
  cleanup_errors: [],
  discarded_inputs: [],
  ...extra,
});
function paneFixture(
  t,
  {
    frame = false,
    views = [view()],
    freshViews = views,
    accept = true,
    draft,
    steer = true,
    terminal = { columns: 120, rows: 40 },
  } = {},
) {
  const sent = [],
    drafts = [];
  let closes = 0,
    visible = true;
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    frame,
    initial: views[0].agent_id,
    snapshot: () => views.map((v) => ({ agent_id: v.agent_id, input: { view: v, live } })),
    freshSnapshot: () =>
      freshViews.map((v) => ({ agent_id: v.agent_id, input: { view: v, live } })),
    visible: () => visible,
    transcript: () => undefined,
    done: () => {
      closes++;
    },
    onStop: () => {},
    ...(steer
      ? {
          onSteer: (run_id, message) => {
            sent.push([run_id, message]);
            return accept;
          },
          onDraft: (value) => drafts.push(value),
          draft,
        }
      : {}),
  });
  t.after(() => pane.dispose());
  const footer = (width = 120) => stripTerminalSequences(pane.render(width).at(-1));
  const type = (text) => {
    for (const ch of text) pane.handleInput(ch);
  };
  return {
    pane,
    views,
    freshViews,
    terminal,
    setVisible(value) {
      visible = value;
    },
    sent,
    drafts,
    footer,
    type,
    get closes() {
      return closes;
    },
  };
}

for (const frame of [false, true])
  test(`message mode sends one typed line to the painted Run (frame=${frame})`, (t) => {
    const f = paneFixture(t, { frame });
    const before = f.pane.render(120);
    assert.match(stripTerminalSequences(before.at(-1)), /M message/);
    assert.match(stripTerminalSequences(before.at(-1)), /\[S Stop\]/);
    f.pane.handleInput("m");
    const composing = f.pane.render(120);
    assert.equal(composing.length, before.length, "message mode does not resize the pane");
    assert.deepEqual(composing.slice(0, -1), before.slice(0, -1));
    assert(composing.every((line) => visibleWidth(line) <= 120));
    assert.match(f.footer(), /› message this Agent.*Enter send · Esc cancel/);
    assert.doesNotMatch(f.footer(), /\[S Stop\]/);
    // Keys that navigate, stop or close outside message mode are plain text here.
    f.type("skip hls 别动 config");
    assert.match(f.footer(), /› skip hls 别动 config/);
    assert.deepEqual(f.sent, []);
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, [["run-a", "skip hls 别动 config"]]);
    assert.match(f.footer(), /\[S Stop\]/, "an accepted message leaves message mode");
    assert.equal(f.drafts.at(-1), undefined);
    assert.equal(f.closes, 0);
  });

test("Esc discards the draft first and only then closes the pane", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  f.type("draft");
  assert.deepEqual(f.drafts.at(-1)?.text, "draft");
  f.pane.handleInput(ESC);
  assert.equal(f.closes, 0);
  assert.equal(f.drafts.at(-1), undefined);
  assert.match(f.footer(), /M message/);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, []);
  f.pane.handleInput(ESC);
  assert.equal(f.closes, 1);
});

test("an empty message and a refused message stay in message mode", (t) => {
  const f = paneFixture(t, { accept: false });
  f.pane.render(120);
  f.pane.handleInput("m");
  f.pane.handleInput(ENTER);
  assert.match(f.footer(), /message is empty/);
  f.type("   ");
  const whitespace = f.drafts.at(-1);
  f.pane.handleInput(ENTER);
  assert.match(f.footer(), /message is empty/);
  assert.equal(f.drafts.at(-1), whitespace, "refusal does not change draft text");
  assert.equal(whitespace.text, "   ");
  assert.deepEqual(f.sent, []);
  f.type("keep me");
  assert.doesNotMatch(f.footer(), /message is empty/);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", "keep me"]]);
  assert.match(f.footer(), /keep me/, "a refused message keeps its text");
});

test("message mode is offered only for a running Run with a host command", (t) => {
  for (const extra of [
    { status: "queued" },
    { status: "completed", execution_exited: true },
    { stop_reason: "user_cancel", status: "cancelling" },
    { execution_exited: true },
  ]) {
    const f = paneFixture(t, { views: [view("a", extra)] });
    assert.doesNotMatch(f.footer(), /M m/);
    f.pane.handleInput("m");
    assert.doesNotMatch(f.footer(), /›/);
  }
  const f = paneFixture(t, { steer: false });
  assert.doesNotMatch(f.footer(), /M m/);
  f.pane.handleInput("m");
  assert.doesNotMatch(f.footer(), /›/);
});

test("M never binds a replacement that has not been painted", (t) => {
  for (const changed of [
    { run_id: "replacement" },
    { owner_id: "other-owner" },
    { generation: "other-generation" },
    { agent_id: "replacement-agent" },
  ]) {
    const freshViews = [view()];
    const f = paneFixture(t, { freshViews });
    f.pane.render(120);
    freshViews[0] = view("a", changed);
    f.pane.handleInput("m");
    f.type("must not send");
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.drafts, []);
    assert.doesNotMatch(f.footer(), /›/);
  }
  const f = paneFixture(t);
  f.pane.render(120);
  f.views[0] = view("a", { run_id: "replacement" });
  f.pane.handleInput("m");
  assert.doesNotMatch(f.footer(), /›/, "a newer snapshot does not constitute a paint");
  f.pane.handleInput("m");
  f.type("now visible");
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["replacement", "now visible"]]);
});

test("M requires a visible paint with current renderable geometry", (t) => {
  for (const retire of [
    (f) => f.pane.invalidate(),
    (f) => f.pane.resetStopInteraction(),
    (f) => f.pane.resetCloseHover(),
    (f) => f.pane.handleInput(ESC),
    (f) => f.pane.render(5),
    (f) => f.pane.render(Number.NaN),
    (f) => {
      f.terminal.columns = 119;
    },
    (f) => {
      f.terminal.rows = 5;
    },
    (f) => {
      f.setVisible(false);
      f.pane.handleInput("m");
      f.setVisible(true);
    },
    (f) => {
      f.setVisible(false);
      assert.deepEqual(f.pane.render(120), []);
      f.setVisible(true);
    },
  ]) {
    const f = paneFixture(t);
    f.pane.handleInput("m");
    assert.deepEqual(f.drafts, [], "M before any paint has no target");
    f.pane.render(120);
    retire(f);
    f.pane.handleInput("m");
    f.type("no target");
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.drafts, []);
  }
  for (const terminal of [
    { columns: 120, rows: 5 },
    { columns: 120, rows: Number.NaN },
    { columns: Number.NaN, rows: 40 },
    { columns: 20, rows: 40 },
  ]) {
    const f = paneFixture(t, { terminal });
    f.pane.render(120);
    f.pane.handleInput("m");
    f.type("unpaintable");
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.drafts, []);
  }
});

test("a draft never reaches a replacement or ended Run", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  f.type("for the old task");
  f.views[0] = view("a", { run_id: "run-replacement" });
  assert.match(f.footer(), /for the old task.*task no longer running/);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, []);
  f.views[0] = view("a", { status: "completed", execution_exited: true });
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, []);
  f.views[0] = view("a");
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", "for the old task"]]);
});

test("drafts stay bound across same-Run paints, invalidation and permission hiding", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  f.type("sticky 中👩‍💻");
  f.pane.invalidate();
  f.pane.resetStopInteraction();
  f.setVisible(false);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [], "hidden input does not act");
  f.setVisible(true);
  assert.match(f.footer(), /sticky 中👩‍💻/);
  f.pane.render(5);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [], "an unrenderable composer does not submit");
  assert.match(f.footer(), /sticky 中👩‍💻/);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", "sticky 中👩‍💻"]]);
});

test("Enter revalidates all draft identity fields through the fresh snapshot", (t) => {
  for (const changed of [
    { run_id: "replacement" },
    { owner_id: "other-owner" },
    { generation: "other-generation" },
    { agent_id: "replacement-agent" },
    { status: "completed", execution_exited: true },
    { status: "cancelling", stop_reason: "user_cancel" },
  ]) {
    const freshViews = [view()];
    const f = paneFixture(t, { freshViews });
    f.pane.render(120);
    f.pane.handleInput("m");
    f.type("original target");
    freshViews[0] = view("a", changed);
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, []);
    assert.equal(f.drafts.at(-1).target.run_id, "run-a");
    assert.equal(f.drafts.at(-1).text, "original target");
  }
});

test("selecting another Agent discards the draft", (t) => {
  const f = paneFixture(t, { views: [view("a"), view("b")] });
  f.pane.render(120);
  f.pane.handleInput("m");
  f.type("x");
  f.pane.activate("b");
  assert.equal(f.drafts.at(-1), undefined);
  assert.doesNotMatch(f.footer(), /›/);
});

test("a host-held draft is restored only for the same Run", (t) => {
  const target = { owner_id: "owner", generation: "generation", agent_id: "a", run_id: "run-a" };
  const same = paneFixture(t, { draft: { target, text: "carried over" } });
  assert.match(same.footer(), /› carried over/);
  same.pane.handleInput(ENTER);
  assert.deepEqual(same.sent, [["run-a", "carried over"]]);
  const other = paneFixture(t, {
    draft: { target: { ...target, run_id: "run-old" }, text: "stale" },
  });
  assert.doesNotMatch(other.footer(), /stale/);
  assert.equal(other.drafts.at(-1), undefined);
});

test("restored Unicode drafts put the caret at the end independently of keybindings", (t) => {
  const bindings = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorLineEnd": [] }));
  t.after(() => setKeybindings(bindings));
  const target = { owner_id: "owner", generation: "generation", agent_id: "a", run_id: "run-a" };
  const text = "原稿𠮷e\u0301👩‍💻✈️";
  const f = paneFixture(t, { draft: { target, text } });
  f.footer();
  f.pane.handleInput("追記");
  assert.equal(f.drafts.at(-1).text, text + "追記");
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", text + "追記"]]);
  const other = paneFixture(t, { draft: { target: { ...target, agent_id: "b" }, text } });
  assert.equal(other.drafts.at(-1), undefined);
  assert.doesNotMatch(other.footer(), /原稿/);
});

test("pasted terminal controls are sanitized before preview, draft storage and submit", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  const raw =
    "before\x1b[31mred\x1b[0m\x1b]52;c;c2VjcmV0\x07" +
    "\x1b]8;;https://invalid.example\x1b\\link\x1b]8;;\x1b\\" +
    "\x90dcs\x9c\x9d52;c;payload\x9c\x9b2J\x07\x00\x7f\u202eafter";
  f.pane.handleInput(paste(raw));
  const draft = f.drafts.at(-1).text;
  assertSafeDraft(draft);
  assert.match(draft, /^beforered/);
  assert.match(draft, /after$/);
  assert.doesNotMatch(draft, /c2VjcmV0/);
  const footer = f.pane.render(120).at(-1);
  // SDK cursor markers contain their own trusted BEL terminators.
  // eslint-disable-next-line no-control-regex -- hostile terminal-control regression
  assert.doesNotMatch(footer, /\x1b\]52|\x1b\[31m|[\x00\x7f-\x9f]/);
  assertSafeDraft(stripTerminalSequences(footer));
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", draft]]);
});

test("unsupported and unfinished pasted protocols cannot escape the input row", (t) => {
  for (const raw of [
    "\x1b",
    "\x1b[",
    "\x1b]52;c;unfinished",
    "\x1b_Payload",
    "\x9d52;c;unfinished",
  ]) {
    const f = paneFixture(t);
    f.pane.render(120);
    f.pane.handleInput("m");
    f.pane.handleInput(paste("safe" + raw));
    const text = f.drafts.at(-1).text;
    assertSafeDraft(text);
    assert.match(text, /^safe/);
    const footer = f.pane.render(120).at(-1);
    // eslint-disable-next-line no-control-regex -- allow only SDK cursor protocol introducers
    assert.doesNotMatch(footer, /\x1b(?!_pi:)/);
    assertSafeDraft(stripTerminalSequences(footer));
    f.pane.handleInput(ENTER);
    assert.deepEqual(f.sent, [["run-a", text]]);
  }
});

test("split bracketed paste keeps controls and pane keys private until sanitized completion", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  const raw = "中\x1b]52;c;hidden\x07\x1b[31m𠮷e\u0301👩‍💻✈️\r\n\t完";
  f.pane.handleInput("\x1b[");
  f.pane.handleInput("20");
  f.pane.handleInput("0~");
  // Includes standalone ESC, Enter and split surrogate halves: none is an action.
  for (let i = 0; i < raw.length; i++) {
    f.pane.handleInput(raw[i]);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.drafts, []);
    assert.doesNotMatch(f.footer(), /hidden|\[31m/);
  }
  for (const chunk of ["\x1b", "[20", "1", "~"]) f.pane.handleInput(chunk);
  const expected = "中𠮷e\u0301👩‍💻✈️    完";
  assert.equal(f.drafts.at(-1).text, expected);
  assertSafeDraft(f.drafts.at(-1).text);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", expected]]);
  assert.equal(f.closes, 0);
});

test("safe paste preserves middle-caret editing and undo cannot revive terminal controls", (t) => {
  const f = paneFixture(t);
  f.pane.render(120);
  f.pane.handleInput("m");
  f.pane.handleInput("左右");
  f.pane.handleInput("\x1b[D");
  f.pane.handleInput(paste("👩‍💻\x1b]52;c;secret\x07✈️"));
  assert.equal(f.drafts.at(-1).text, "左👩‍💻✈️右");
  f.pane.handleInput("中");
  assert.equal(f.drafts.at(-1).text, "左👩‍💻✈️中右");
  f.pane.handleInput("\x1f"); // Ctrl+-: undo the typed character, then the paste.
  assert.equal(f.drafts.at(-1).text, "左👩‍💻✈️右");
  f.pane.handleInput("\x1f");
  assert.equal(f.drafts.at(-1).text, "左右");
  f.pane.handleInput("\x7f");
  assert.equal(f.drafts.at(-1).text, "右");
  for (const draft of f.drafts) if (draft) assertSafeDraft(draft.text);
  f.pane.handleInput(ENTER);
  assert.deepEqual(f.sent, [["run-a", "右"]]);
});

test("restored and decoded keyboard controls are safe without destroying IME or emoji", (t) => {
  const target = { owner_id: "owner", generation: "generation", agent_id: "a", run_id: "run-a" };
  const f = paneFixture(t, { draft: { target, text: "中\x1b]52;c;secret\x07\x00" } });
  f.footer();
  assertSafeDraft(f.drafts.at(-1).text);
  f.pane.handleInput("\x1b[157u"); // Kitty-printable decoder can produce a C1 control.
  assertSafeDraft(f.drafts.at(-1).text);
  f.pane.handleInput("文字𠮷e\u0301👩‍💻✈️"); // One IME commit, not per-codepoint typing.
  assert.match(f.drafts.at(-1).text, /文字𠮷e\u0301👩‍💻✈️$/);
  f.pane.handleInput(paste("a\rb\nc\r\nd\u2028e\u0085f\tend"));
  assert.match(f.drafts.at(-1).text, /abcdef {4}end$/);
  assertSafeDraft(f.drafts.at(-1).text);
  f.pane.handleInput(ENTER);
  assert.equal(f.sent.length, 1);
  assertSafeDraft(f.sent[0][1]);
});

test("narrow empty-message refusal remains visible without changing the one-line layout", (t) => {
  for (const frame of [false, true]) {
    const f = paneFixture(t, { frame });
    const before = f.pane.render(30);
    f.pane.handleInput("m");
    f.pane.handleInput(" ");
    f.pane.handleInput(ENTER);
    const after = f.pane.render(30);
    assert.equal(after.length, before.length);
    assert.match(stripTerminalSequences(after.at(-1)), /empty/);
    assert(after.every((line) => visibleWidth(line) <= 30));
    assert.equal(f.drafts.at(-1).text, " ");
    assert.deepEqual(f.sent, []);
  }
});

test("narrow panes drop the hint before the input", (t) => {
  const f = paneFixture(t);
  f.pane.render(30);
  f.pane.handleInput("m");
  f.type("abc");
  const lines = f.pane.render(30);
  assert(lines.every((line) => visibleWidth(line) <= 30));
  assert.match(stripTerminalSequences(lines.at(-1)), /› abc/);
});

test("the host adapter marks the message as human and never publishes to the parent", () => {
  const calls = [];
  const result = requestHumanSteer(
    {
      steer: (...args) => {
        calls.push(args);
        return { accepted: true, event_id: "e" };
      },
    },
    "run-a",
    "  go back to the brief \n",
  );
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [
    ["run-a", `${humanSteerLead}\n\ngo back to the brief`, { source: "human" }],
  ]);
});
