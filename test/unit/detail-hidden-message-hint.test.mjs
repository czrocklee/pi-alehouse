import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { DetailPane } = await jiti.import("../../src/orchestration/ui/agent-detail.ts");
const { renderDetailInfo } = await jiti.import("../../src/orchestration/ui/agent-detail-fields.ts");
initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
const settings = {
  provider: "fixture",
  model: "controlled",
  thinking: "off",
  parent_thinking: "off",
  thinking_resolution: "identity",
  profile: "editor",
  difficulty: 3,
  strength: "d3",
  preset: "fixture",
  preset_version: "v1",
  selection_digest: "2".repeat(64),
  cwd: "/workspace",
  tools: ["read"],
  definition_digest: "1".repeat(64),
};
const view = (index) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: `peer${index}`,
  run_id: `run-peer${index}`,
  name: `longnicknametest${index}`,
  task: 1,
  description: "Message hint fixture",
  effective_settings: settings,
  status: "running",
  phase: "executing",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  history_error: "Controlled history unavailable",
});
const entries = (views) =>
  views.map((current) => ({ agent_id: current.agent_id, input: { view: current, live } }));
function fixture(t, { rows = 40 } = {}) {
  const views = Array.from({ length: 3 }, (_value, index) => view(index));
  let fresh = views;
  let visible = true;
  let closes = 0;
  const sent = [];
  const terminal = { columns: 60, rows };
  const pane = new DetailPane({
    tui: { terminal, requestRender() {} },
    theme,
    initial: "peer0",
    snapshot: () => entries(views),
    freshSnapshot: () => entries(fresh),
    visible: () => visible,
    transcript: () => ({
      lineCount: () => 200,
      slice: (_width, start, take) =>
        Array.from(
          { length: Math.min(take, 200 - start) },
          (_value, index) => `ROW${start + index}`,
        ),
    }),
    done() {
      closes++;
    },
    onStop() {},
    onSteer(run, text) {
      sent.push([run, text]);
      return true;
    },
  });
  t.after(() => pane.dispose());
  const paint = () => pane.render(60).map(stripTerminalSequences);
  paint();
  pane.handleInput("\x1b[H");
  const initial = paint();
  assert.doesNotMatch(initial.at(-1), /\[M/, "the hint is omitted, not an unavailable geometry");
  assert.match(initial.at(-1), /\[S Stop\]$/);
  return {
    pane,
    views,
    sent,
    terminal,
    paint,
    fresh(value) {
      fresh = value;
    },
    visible(value) {
      visible = value;
    },
    get closes() {
      return closes;
    },
  };
}
const type = (pane, text) => {
  for (const character of text) pane.handleInput(character);
};

test("omitting the optional M hint preserves its original-Run keyboard shortcut", (t) => {
  const f = fixture(t);
  const before = structuredClone(f.views);
  f.pane.handleInput("m");
  assert(f.paint().some((line) => /Steer longnicknametest0 #1/.test(line)));
  type(f.pane, "Human correction");
  assert.match(f.paint().at(-2), /› Human correction/);
  f.pane.handleInput("\r");
  assert.deepEqual(f.sent, [["run-peer0", "Human correction"]]);
  assert.deepEqual(f.views, before, "the shortcut never rewrites its projected observations");
});

for (const key of ["owner_id", "generation", "run_id"]) {
  test(`a hidden M hint never bypasses fresh ${key} validation`, (t) => {
    const f = fixture(t);
    f.fresh(
      f.views.map((current, index) => (index ? current : { ...current, [key]: "replacement" })),
    );
    f.pane.handleInput("m");
    assert(!f.paint().some((line) => /Steer longnicknametest0/.test(line)));
    f.pane.handleInput("\r");
    assert.deepEqual(f.sent, []);
  });
}

for (const retire of ["hidden", "columns", "rows"]) {
  test(`the hidden M shortcut requires a fresh paint after ${retire} retirement`, (t) => {
    const f = fixture(t);
    if (retire === "hidden") f.visible(false);
    else f.terminal[retire]--;
    f.pane.handleInput("m");
    assert(!f.paint().some((line) => /Steer longnicknametest0/.test(line)));
    f.pane.handleInput("\r");
    assert.deepEqual(f.sent, []);
  });
}

test("Esc unwinds confirmation, draft, Info and pane as separate layers", (t) => {
  const f = fixture(t);
  f.pane.handleInput("i");
  assert(
    f.paint().some((line) => /routing/.test(line)),
    "paint Info before a new command",
  );
  f.pane.handleInput("m");
  type(f.pane, "Held draft");
  const composing = f.paint();
  const y = composing.length - 1;
  const index = composing[y].indexOf("[Stop]");
  assert(index >= 0);
  const x = visibleWidth(composing[y].slice(0, index));
  assert.deepEqual(f.pane.handleMouse({ type: "click", button: "left", x, y, clickCount: 1 }), {
    handled: true,
  });
  assert.match(f.paint().at(-1), /\[Confirm stop\]$/);
  f.pane.handleInput("\x1b");
  assert.match(f.paint().at(-2), /› Held draft/);
  assert(f.pane.isOpen());
  f.pane.handleInput("\x1b");
  const info = f.paint();
  assert(!info.some((line) => /› Held draft/.test(line)));
  assert(
    info.some((line) => /routing/.test(line)),
    "Info remains after discarding the draft",
  );
  assert(f.pane.isOpen());
  f.pane.handleInput("\x1b");
  assert(
    f.paint().some((line) => /\bROW0\b/.test(line)),
    "Info returns to the held transcript position",
  );
  assert(f.pane.isOpen());
  f.pane.handleInput("\x1b");
  assert.equal(f.pane.isOpen(), false);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.sent, [], "unwinding never submits a draft");
});

test("the Info tail cue counts the current page, without changing transcript follow intent", (t) => {
  const f = fixture(t, { rows: 24 });
  f.pane.handleInput("i");
  const info = f.paint();
  // The plain separator closes the Info page; the back link leads it and any
  // pinned notice sits directly above the separator.
  const separator = info.findLastIndex((line) => /^─+$/.test(line));
  assert(separator >= 0, info.join("\n"));
  const back = info.findIndex((line) => line.includes("← Transcript"));
  assert.equal(back, 1, "the page-local return link leads the body");
  let end = separator - 1;
  while (end > back && /^[✓?!]\s/.test(info[end])) end--;
  const shown = end - back;
  const total = renderDetailInfo(entries(f.views)[0].input, theme, 60).length;
  assert(total > shown, "the page really overflows its window");
  assert.match(info.at(-1), new RegExp(`↓ ${total - shown} more`));
  f.pane.handleInput("\x1b[F");
  assert.doesNotMatch(f.paint().at(-1), /↓/);
  f.pane.handleInput("\x1b");
  assert(
    f.paint().some((line) => /\bROW0\b/.test(line)),
    "Info scrolling does not change the held transcript",
  );
});
