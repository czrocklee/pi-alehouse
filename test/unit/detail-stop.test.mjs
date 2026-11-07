import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  DetailPane,
  renderDetailFields,
  renderDetailTitle,
  wrapText,
} from "../../dist/orchestration/ui/agent-detail.js";
import { AgentWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { PanelCoordinator } from "../../dist/orchestration/ui/panel-coordinator.js";
import { ended, fixture, settings, task, until } from "../support/controller-fixture.mjs";

initTheme(undefined, false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const live = { active_tools: [], tool_uses: 0, preview: "" };
// Raw Ctrl+S works without Kitty; plain CR/LF must never substitute for it.
const CONFIRM = "\x13";
const CONFIRM_HINT = "best-effort · Ctrl+S · Esc cancel · [Confirm stop]";
function monotonicClock(t, initial = 1000) {
  let now = initial;
  t.mock.method(performance, "now", () => now);
  return {
    advance: (ms) => {
      now += ms;
    },
  };
}
const accepted = { result: "cancel_requested", already_stopping: false };
const view = (agent_id = "a", extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id,
  run_id: `run-${agent_id}`,
  name: agent_id,
  description: "Stop fixture",
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
const entry = (v) => ({ agent_id: v.agent_id, input: { view: v, live } });
function paneFixture(
  t,
  { frame = false, onStop, views = [view()], transcript = () => undefined, paneTheme = theme } = {},
) {
  let closes = 0,
    snapshots = 0,
    renders = 0;
  const terminal = { columns: 120, rows: 40 };
  const pane = new DetailPane({
    tui: {
      terminal,
      requestRender() {
        renders++;
      },
    },
    theme: paneTheme,
    frame,
    initial: views[0]?.agent_id ?? "a",
    snapshot: () => {
      snapshots++;
      return views.map(entry);
    },
    transcript,
    done: () => {
      closes++;
    },
    onStop,
  });
  t.after(() => pane.dispose());
  return {
    pane,
    views,
    terminal,
    frame,
    get closes() {
      return closes;
    },
    get snapshots() {
      return snapshots;
    },
    get renders() {
      return renders;
    },
  };
}
function clickLabel(pane, lines, label, offset = 0, clickCount) {
  const footer = lines.at(-1),
    at = footer.indexOf(label);
  assert(at >= 0, `expected painted ${label}`);
  return pane.handleMouse({
    type: "click",
    button: "left",
    x: visibleWidth(footer.slice(0, at)) + offset,
    y: lines.length - 1,
    ...(clickCount === undefined ? {} : { clickCount }),
  });
}
function assertInlineConfirmation(before, after) {
  assert.equal(after.length, before.length, "arming does not change pane height");
  assert.deepEqual(
    after.slice(0, -1),
    before.slice(0, -1),
    "title, body and scroll window stay in place",
  );
  assert(
    stripTerminalSequences(after.at(-1)).includes(CONFIRM_HINT),
    "the complete best-effort and cancellation hint is painted",
  );
  assert.doesNotMatch(after.at(-1), /\[S Stop\]/);
}
function assertRightmostLabel(lines, label, width, frame) {
  assert(lines.every((line) => visibleWidth(line) <= width));
  const footer = stripTerminalSequences(lines.at(-1)),
    at = footer.indexOf(label);
  assert(at >= 0, `expected painted ${label}`);
  assert.equal(
    visibleWidth(footer.slice(0, at)) + visibleWidth(label),
    width - (frame ? 3 : 0),
    "action ends at the right edge of the footer inlay",
  );
  assert.equal(
    footer.slice(at + label.length),
    frame ? " ─╯" : "",
    "only frame chrome follows the action",
  );
  assert.match(
    footer.slice(0, at),
    /\b(?:run(?:ning)?|queued|finish(?:ing)?)\b/,
    "live status remains before the action",
  );
}
function arm(pane, width = 120, key = "s") {
  const before = pane.render(width);
  assert.match(before.at(-1), /\[S Stop\]/);
  pane.handleInput(key);
  const lines = pane.render(width);
  assertInlineConfirmation(before, lines);
  return lines;
}

for (const frame of [false, true])
  for (const key of ["s", "S"]) {
    test(`Stop intent requires painted deliberate confirmation (frame=${frame}, key=${key})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, {
        frame,
        onStop: (id) => {
          stopped.push(id);
          h.views[0].status = "cancelling";
          h.views[0].stop_reason = "user_cancel";
        },
      });
      h.pane.handleInput(key);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "before paint there is no displayed target");
      const before = h.pane.render(120);
      h.pane.handleInput(key);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "unpainted confirmation is not actionable");
      const lines = h.pane.render(120);
      assertInlineConfirmation(before, lines);
      assertRightmostLabel(lines, "[Confirm stop]", 120, frame);
      for (const input of ["s", "S", "\r", "\n", "\x1b[13;5u", "sure", "please"])
        h.pane.handleInput(input);
      assert.deepEqual(stopped, [], "printing and Enter never execute Stop");
      h.pane.handleInput("\x1b");
      assert.equal(h.closes, 0, "Esc cancels confirmation, not the pane");
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, []);
      arm(h.pane, 120, key);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, ["run-a"]);
      assert.equal(h.closes, 0);
      const footer = h.pane.render(120).at(-1);
      assert.match(footer, /cancelling/);
      assert.doesNotMatch(footer, /\[S Stop\]/);
      h.pane.handleInput(key);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, ["run-a"], "already-stopping work is not stopped again");
      h.pane.handleInput("\x1b");
      h.pane.handleInput(key);
      h.pane.handleInput(CONFIRM);
      assert.equal(h.closes, 1);
      assert.deepEqual(stopped, ["run-a"], "retired input is inert");
    });
  }

for (const frame of [false, true])
  for (const word of ["sure", "please", "Sure", "Please"]) {
    test(`typing ${word} and Enter cannot cancel (frame=${frame})`, (t) => {
      const h = paneFixture(t, { frame, onStop: () => assert.fail("typing is not confirmation") });
      h.pane.render(120);
      // Per-key rendering simulates the focused dispatcher, not just a pasted word.
      for (const char of word) {
        h.pane.handleInput(char);
        h.pane.render(120);
      }
      h.pane.handleInput("\r");
      h.pane.render(120);
      h.pane.handleInput("\n");
      assert.equal(h.closes, 0);
    });
  }

for (const frame of [false, true])
  test(`Stop and confirm click geometry follows painting (frame=${frame})`, (t) => {
    const stopped = [];
    const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
    const minimum = frame ? 62 : 56;
    const widths = [...Array.from({ length: 121 - minimum }, (_, i) => minimum + i), 160, 240];
    for (const width of widths) {
      for (const edge of ["first", "last"]) {
        const lines = h.pane.render(width),
          before = stopped.length;
        assertRightmostLabel(lines, "[S Stop]", width, frame);
        const footer = lines.at(-1),
          x = visibleWidth(footer.slice(0, footer.indexOf("[S Stop]"))),
          y = lines.length - 1;
        assert.equal(h.pane.handleMouse({ type: "click", button: "right", x, y }), undefined);
        assert.equal(h.pane.handleMouse({ type: "click", button: "left", x, y: y - 1 }), undefined);
        for (const offset of [-1, "[S Stop]".length]) {
          assert.equal(clickLabel(h.pane, lines, "[S Stop]", offset), undefined);
          assert.doesNotMatch(
            h.pane.render(width).at(-1),
            /\[Confirm stop\]/,
            "adjacent columns do not arm intent",
          );
        }
        if (width >= 80) assert.match(footer, /Esc.*\[S Stop\]/, "navigation precedes Stop");
        assert.deepEqual(
          clickLabel(h.pane, lines, "[S Stop]", edge === "first" ? 0 : "[S Stop]".length - 1),
          { handled: true },
        );
        clickLabel(h.pane, lines, "[S Stop]");
        h.pane.handleInput(CONFIRM);
        assert.equal(stopped.length, before, "first click and unpainted input only arm intent");
        const confirmation = h.pane.render(width);
        assertInlineConfirmation(lines, confirmation);
        assertRightmostLabel(confirmation, "[Confirm stop]", width, frame);
        const confirmX = width - (frame ? 3 : 0) - "[Confirm stop]".length;
        assert.equal(
          h.pane.handleMouse({ type: "click", button: "right", x: confirmX, y }),
          undefined,
        );
        assert.equal(
          h.pane.handleMouse({ type: "click", button: "left", x: confirmX, y: y - 1 }),
          undefined,
        );
        for (const offset of [-1, "[Confirm stop]".length]) {
          assert.equal(clickLabel(h.pane, confirmation, "[Confirm stop]", offset), undefined);
        }
        assert.equal(
          clickLabel(h.pane, confirmation, "Ctrl+S"),
          undefined,
          "the keyboard hint is not a second click target",
        );
        assert.equal(stopped.length, before);
        assert.deepEqual(
          clickLabel(
            h.pane,
            confirmation,
            "[Confirm stop]",
            edge === "first" ? 0 : "[Confirm stop]".length - 1,
          ),
          { handled: true },
        );
        h.pane.handleInput(CONFIRM);
        clickLabel(h.pane, confirmation, "[Confirm stop]");
        assert.equal(
          stopped.length,
          before + 1,
          "consumed confirmation cannot execute twice without repaint",
        );
        assert.equal(stopped.at(-1), "run-a");
      }
      assert.equal(h.closes, 0);
    }
  });

for (const frame of [false, true])
  for (const position of ["tail", "scrolled"])
    for (const pointer of [false, true]) {
      test(`inline intent preserves transcript, scroll and height (frame=${frame}, position=${position}, pointer=${pointer})`, (t) => {
        let count = 100;
        const rows = {
          lineCount: () => count,
          slice: (_width, start, take) =>
            Array.from(
              { length: Math.max(0, Math.min(take, count - start)) },
              (_, i) => `transcript-${start + i}`,
            ),
        };
        const h = paneFixture(t, {
          frame,
          transcript: () => rows,
          onStop: () => assert.fail("Esc is not confirmation"),
        });
        const tail = h.pane.render(120);
        assert(tail.at(-2).includes("transcript-99"), "normal pane follows the transcript tail");
        if (position === "scrolled") h.pane.handleInput("\x1b[5~");
        const before = h.pane.render(120);
        if (position === "scrolled") assert(!before.some((line) => line.includes("transcript-99")));
        if (pointer) clickLabel(h.pane, before, "[S Stop]");
        else h.pane.handleInput("s");
        const confirmation = h.pane.render(120);
        assertInlineConfirmation(before, confirmation);
        assertRightmostLabel(confirmation, "[Confirm stop]", 120, frame);
        for (const input of ["s", "S", "\r", "\n", "sure", "please"]) h.pane.handleInput(input);
        assertInlineConfirmation(before, h.pane.render(120));
        count++;
        const grown = h.pane.render(120);
        assert.equal(grown.length, before.length);
        assert.equal(grown[0], before[0]);
        if (position === "tail")
          assert(
            grown.at(-2).includes("transcript-100"),
            "confirmation keeps following live output",
          );
        else
          assert.deepEqual(
            grown.slice(0, -1),
            before.slice(0, -1),
            "growth cannot move a scrolled confirmation",
          );
        h.pane.handleInput("\x1b[A");
        const scrolled = h.pane.render(120);
        assert.equal(scrolled.length, before.length);
        assert.equal(scrolled[0], before[0]);
        assert.notDeepEqual(
          scrolled.slice(1, -1),
          grown.slice(1, -1),
          "scrolling still moves the normal transcript window",
        );
        assertRightmostLabel(scrolled, "[S Stop]", 120, frame);
        h.pane.handleInput(CONFIRM);
        const rearmed = arm(h.pane);
        assert.deepEqual(rearmed.slice(0, -1), scrolled.slice(0, -1));
        h.pane.handleInput("\x1b");
        assert.equal(h.closes, 0);
        const cancelled = h.pane.render(120);
        assert.deepEqual(
          cancelled.slice(0, -1),
          scrolled.slice(0, -1),
          "cancel preserves the new scroll window too",
        );
        assertRightmostLabel(cancelled, "[S Stop]", 120, frame);
        h.pane.handleInput(CONFIRM);
        h.pane.handleInput("\x1b");
        assert.equal(h.closes, 1, "second Esc closes only after cancelling intent");
      });
    }

for (const frame of [false, true])
  for (const width of [8, 14, 24, 32]) {
    test(`narrow/unrenderable confirmation drops intent (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
      const confirmation = arm(h.pane);
      const oldFooter = confirmation.at(-1),
        oldX = oldFooter.indexOf("[Confirm stop]");
      const lines = h.pane.render(width);
      assert(lines.every((line) => visibleWidth(line) <= width));
      assert(!lines.some((line) => line.includes("[Confirm stop]")));
      h.pane.handleInput(CONFIRM);
      h.pane.handleMouse({ type: "click", button: "left", x: oldX, y: confirmation.length - 1 });
      h.pane.render(120);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "widening must not restore old intent");
      arm(h.pane);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, ["run-a"], "a fresh deliberate interaction works");
    });
  }

for (const frame of [false, true])
  for (const stage of ["intent", "confirmation"]) {
    for (const change of ["columns", "rows", "invalidate"])
      for (const pointer of [false, true]) {
        test(`stale paint is retired before input (frame=${frame}, stage=${stage}, change=${change}, pointer=${pointer})`, (t) => {
          const stopped = [];
          const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
          const lines = stage === "confirmation" ? arm(h.pane) : h.pane.render(120);
          const label = stage === "confirmation" ? "[Confirm stop]" : "[S Stop]";
          if (change === "invalidate") h.pane.invalidate();
          else h.terminal[change] = change === "rows" ? 4 : 12;
          // No render between changing the terminal/invalidation and old input.
          if (pointer) clickLabel(h.pane, lines, label);
          else h.pane.handleInput(stage === "confirmation" ? CONFIRM : "S");
          assert.deepEqual(stopped, []);
          assert.equal(h.closes, 0);
          h.terminal.columns = 120;
          h.terminal.rows = 40;
          h.pane.handleInput(CONFIRM);
          assert.doesNotMatch(
            h.pane.render(120).at(-1),
            /\[Confirm stop\]/,
            "restored dimensions and repaint cannot resurrect old intent",
          );
          h.pane.handleInput(CONFIRM);
          assert.deepEqual(stopped, []);
          arm(h.pane);
          h.pane.handleInput(CONFIRM);
          assert.deepEqual(stopped, ["run-a"], "only a fresh deliberate interaction executes");
        });
      }
  }

for (const change of ["columns", "rows"])
  test(`resize followed by repaint alone drops confirmation (${change})`, (t) => {
    const h = paneFixture(t, { onStop: () => assert.fail("old confirmation was retired") });
    arm(h.pane);
    h.terminal[change]++;
    // The new terminal still has room, but its old confirmation intent is stale.
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
    h.terminal.columns = 120;
    h.terminal.rows = 40;
    h.pane.render(120);
    h.pane.handleInput(CONFIRM);
  });

for (const frame of [false, true])
  for (const width of [80, 121])
    for (const pointer of [false, true]) {
      test(`component width alone retires inline confirmation (frame=${frame}, width=${width}, pointer=${pointer})`, (t) => {
        const stopped = [];
        const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
        const old = arm(h.pane);
        const repainted = h.pane.render(width);
        assert.deepEqual(
          h.terminal,
          { columns: 120, rows: 40 },
          "terminal dimensions did not change",
        );
        assert.doesNotMatch(repainted.at(-1), /\[Confirm stop\]/);
        assertRightmostLabel(repainted, "[S Stop]", width, frame);
        if (pointer) clickLabel(h.pane, old, "[Confirm stop]");
        else h.pane.handleInput(CONFIRM);
        assert.deepEqual(
          stopped,
          [],
          "old confirmation cannot execute against changed paint width",
        );
        h.pane.render(120);
        h.pane.handleInput(CONFIRM);
        assert.doesNotMatch(
          h.pane.render(120).at(-1),
          /\[Confirm stop\]/,
          "restoring paint width cannot restore intent",
        );
        assert.deepEqual(stopped, []);
        arm(h.pane, width);
        h.pane.handleInput(CONFIRM);
        assert.deepEqual(stopped, ["run-a"]);
      });
    }

for (const change of ["columns", "rows"])
  test(`Esc still backs out before resized confirmation repaints (${change})`, (t) => {
    const h = paneFixture(t, { onStop: () => assert.fail("Esc is never Stop") });
    arm(h.pane);
    h.terminal[change] = 4;
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 0, "first Esc backs out of confirmation");
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 1, "second Esc closes the pane");
  });

for (const { label, prefix, suffix, plainPrefix = "", plainSuffix = "" } of [
  { label: "CSI conceal", prefix: "\x1b[8m", suffix: "\x1b[0m" },
  { label: "CSI erase/cursor", prefix: "\x1b[2J\x1b[10;10H", suffix: "\x1b[1G\x1b[K" },
  {
    label: "OSC8",
    prefix: "\x1b]8;;https://example.invalid/hidden\x1b\\",
    suffix: "\x1b]8;;\x1b\\",
  },
  { label: "OSC title", prefix: "\x1b]0;spoof title\x07", suffix: "\x1b]2;another title\x1b\\" },
  {
    label: "raw C0/DEL/C1",
    prefix: "\x00\x08\x7f\x9b",
    suffix: "\x01\x9f",
    plainPrefix: "\\x00\\x08\\x7f\\x9b",
    plainSuffix: "\\x01\\x9f",
  },
])
  for (const frame of [false, true])
    test(`ordinary and inline identity are plain terminal text (${label}, frame=${frame})`, (t) => {
      const decorate = (text) => prefix + text + suffix;
      const plain = (text) => plainPrefix + text + plainSuffix;
      const agent_id = decorate("agent"),
        stopped = [];
      const original = view(agent_id, {
        name: decorate("name"),
        run_id: decorate("run"),
        description: decorate("task"),
      });
      const h = paneFixture(t, { frame, views: [original], onStop: (id) => stopped.push(id) });
      h.terminal.columns = 240;
      h.pane.render(240);
      h.pane.handleInput("\x1b[H");
      const ordinary = h.pane.render(240);
      assert(
        ordinary[0].includes(plain("name")),
        "a roomy ordinary title uses visible sanitized identity",
      );
      const body = ordinary.slice(1, -1).join("\n");
      assert(body.includes(plain("task")), "the ordinary task field is sanitized too");
      if (!plainPrefix)
        assert(
          body.includes("run · agent agent"),
          "terminal protocols are stripped before identity shortening",
        );
      const confirmation = arm(h.pane, 240);
      assertInlineConfirmation(ordinary, confirmation);
      for (const lines of [ordinary, confirmation]) {
        assert(
          lines.every((line) => !/\p{Cc}/u.test(line)),
          "no ANSI/OSC/raw controls may reach the pane",
        );
        const text = lines.join("\n");
        assert(!text.includes("spoof title"));
        assert(!text.includes("another title"));
        assert(!text.includes("https://example.invalid"));
        assert(lines.every((line) => visibleWidth(line) <= 240));
      }
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(
        stopped,
        [decorate("run")],
        "sanitized presentation never rewrites the bound original Run",
      );
      assert.equal(original.agent_id, agent_id);
      assert.equal(original.run_id, decorate("run"));
    });

for (const frame of [false, true])
  test(`short ordinary Run and Agent controls are visibly escaped (frame=${frame})`, (t) => {
    const stopped = [];
    const h = paneFixture(t, {
      frame,
      views: [
        view("\x08agent", {
          run_id: "\x08run",
          name: "\x08name",
          description: "\x08task",
        }),
      ],
      onStop: (id) => stopped.push(id),
    });
    h.pane.render(120);
    h.pane.handleInput("\x1b[H");
    const lines = h.pane.render(120),
      body = lines.slice(1, -1).join("\n");
    assert(lines[0].includes("\\x08name"));
    assert(body.includes("\\x08run · agent \\x08agent"));
    assert(body.includes("\\x08task"));
    assertStopFits(h, 120, stopped, "\x08run");
  });

test("an unpainted Stop hint disables S, even when the body is renderable", (t) => {
  const h = paneFixture(t, { frame: true, onStop: () => assert.fail("Stop hint is not painted") });
  const lines = h.pane.render(14);
  assert(lines.length > 0);
  assert.doesNotMatch(lines.at(-1), /\[S Stop\]/);
  h.pane.handleInput("s");
  h.pane.render(120);
  h.pane.handleInput(CONFIRM);
  assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
});

function assertNoStopAction(h, width) {
  const lines = h.pane.render(width);
  assert(lines.length > 0, "the pane still renders when Stop does not fit");
  assert(lines.every((line) => visibleWidth(line) <= width));
  assert(!lines.some((line) => line.includes("[S Stop]") || line.includes("[Confirm stop]")));
  h.pane.handleInput("s");
  h.pane.handleInput("S");
  h.pane.handleInput(CONFIRM);
  h.pane.handleInput("\r");
  const y = lines.length - 1;
  h.pane.handleMouse({ type: "click", button: "left", x: 0, y });
  h.pane.handleMouse({ type: "click", button: "left", x: Math.max(0, width - 1), y });
  assert.equal(h.closes, 0);
  const again = h.pane.render(width);
  assert(!again.some((line) => line.includes("[S Stop]") || line.includes("[Confirm stop]")));
  h.pane.handleInput(CONFIRM);
}
function assertStopFits(h, width, stopped, run_id = "run-a") {
  const before = h.pane.render(width);
  assertRightmostLabel(before, "[S Stop]", width, h.frame);
  const lines = arm(h.pane, width);
  assertRightmostLabel(lines, "[Confirm stop]", width, h.frame);
  // pi-tui's truncateToWidth inserts SGR resets around ellipses even with this
  // plain theme. Permit only those exact title markers, never arbitrary ANSI;
  // separate title pieces can each be truncated. Body/footer stay control-free.
  assert(
    !lines.some((line, row) =>
      /\p{Cc}/u.test(
        row === 0
          ? line.replaceAll("\x1b[0m...\x1b[0m", "...").replaceAll("\x1b[0m…\x1b[0m", "…")
          : line,
      ),
    ),
    "only SDK title-truncation resets may accompany plain text",
  );
  h.pane.handleInput(CONFIRM);
  assert.deepEqual(stopped, [run_id]);
}

// Reserve the full 50-column hint, one separator and compact live status (5).
// Framed chrome is width-6: running Stop starts at docked 56 / framed 62.
for (const frame of [false, true]) {
  const minimum = frame ? 62 : 56;
  for (const width of [24, 40, 46, 50, minimum - 1]) {
    test(`unfittable inline hint/status is not offered (frame=${frame}, width=${width})`, (t) => {
      const h = paneFixture(t, {
        frame,
        onStop: () => assert.fail("hidden Stop is not actionable"),
      });
      assertNoStopAction(h, width);
    });
  }
  for (const width of [minimum, minimum + 1, 80, 120]) {
    test(`Stop fits the full inline hint and live status (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
      assertStopFits(h, width, stopped);
    });
  }
  for (const rows of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    test(`non-finite terminal rows do not advertise Stop (frame=${frame}, rows=${rows})`, (t) => {
      const h = paneFixture(t, {
        frame,
        onStop: () => assert.fail("malformed geometry is not a Stop affordance"),
      });
      h.terminal.rows = rows;
      assertNoStopAction(h, 120);
    });
  }
  for (const rows of [6, 7, 8, 9])
    test(`normal pane height boundary gates Stop (frame=${frame}, rows=${rows})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
      h.terminal.rows = rows;
      if (rows < 8) assertNoStopAction(h, minimum);
      else {
        assert.equal(
          h.pane.render(minimum).length,
          rows === 8 ? 5 : 6,
          "normal pane uses its unchanged 70% height cap",
        );
        assertStopFits(h, minimum, stopped);
      }
      assert.deepEqual(stopped, rows < 8 ? [] : ["run-a"]);
    });
}
for (const frame of [false, true])
  for (const fits of [false, true]) {
    const width = (frame ? 65 : 59) - (fits ? 0 : 1);
    test(`queued compact status also fits alongside confirmation (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, {
        frame,
        views: [view("a", { status: "queued" })],
        onStop: (id) => stopped.push(id),
      });
      if (fits) assertStopFits(h, width, stopped);
      else {
        assertNoStopAction(h, width);
        assert.deepEqual(stopped, []);
      }
    });
  }
for (const frame of [false, true])
  for (const width of [56, 59, 62, 65, 80, 120]) {
    test(`real finishing execution offers no Stop at any width (frame=${frame}, width=${width})`, (t) => {
      const h = paneFixture(t, {
        frame,
        views: [view("a", { execution_exited: true, finalization_pending: true })],
        onStop: () => assert.fail("finishing execution has already exited"),
      });
      assertNoStopAction(h, width);
    });
  }

for (const frame of [false, true])
  test(`finishing retires an already armed live Run before repaint (frame=${frame})`, (t) => {
    const h = paneFixture(t, { frame, onStop: () => assert.fail("execution already exited") });
    arm(h.pane, 80);
    Object.assign(h.views[0], { execution_exited: true, finalization_pending: true });
    h.pane.handleInput(CONFIRM);
    assertNoStopAction(h, 80);
  });

for (const frame of [false, true])
  for (const field of ["name", "description", "agent_id", "run_id"]) {
    for (const [kind, value] of [
      ["long", "full target ".repeat(500)],
      ["CJK", "測".repeat(1000)],
      ["raw-control", "\x08".repeat(1000)],
    ]) {
      test(`long target text does not disable inline Stop (frame=${frame}, field=${field}, kind=${kind})`, (t) => {
        const stopped = [],
          original = view("a", { [field]: value });
        const h = paneFixture(t, { frame, views: [original], onStop: (id) => stopped.push(id) });
        h.terminal.rows = 8;
        const width = frame ? 62 : 56;
        assert.equal(h.pane.render(width).length, 5);
        assertStopFits(h, width, stopped, original.run_id);
        assert.equal(
          original[field],
          value,
          "display sanitizing/clipping does not mutate the bound identity/task",
        );
      });
    }
  }

for (const frame of [false, true])
  for (const input of [
    "\x1b[A",
    "\x1b[B",
    "k",
    "j",
    "\x1b[H",
    "\x1b[F",
    "\x1b[5~",
    "\x1b[6~",
    "wheel-up",
    "wheel-down",
  ])
    test(`deliberate scrolling disarms without changing normal scroll behavior (frame=${frame}, input=${JSON.stringify(input)})`, (t) => {
      const rows = {
        lineCount: () => 100,
        slice: (_width, start, take) =>
          Array.from(
            { length: Math.max(0, Math.min(take, 100 - start)) },
            (_, i) => `row-${start + i}`,
          ),
      };
      const options = {
        frame,
        transcript: () => rows,
        onStop: () => assert.fail("scrolling disarmed confirmation"),
      };
      const armed = paneFixture(t, options),
        normal = paneFixture(t, options);
      for (const h of [armed, normal]) {
        h.pane.render(120);
        h.pane.handleInput("\x1b[5~");
        h.pane.render(120);
      }
      arm(armed.pane);
      for (const h of [armed, normal]) {
        if (input.startsWith("wheel-"))
          h.pane.handleMouse({ type: "wheel", wheelDelta: input === "wheel-up" ? -1 : 1 });
        else h.pane.handleInput(input);
      }
      armed.pane.handleInput(CONFIRM);
      const actual = armed.pane.render(120),
        expected = normal.pane.render(120);
      assert.deepEqual(
        actual,
        expected,
        "armed and ordinary panes perform the same scroll, including follow-tail state",
      );
      assertRightmostLabel(actual, "[S Stop]", 120, frame);
      armed.pane.handleInput(CONFIRM);
    });

for (const frame of [false, true])
  test(`End at the tail still cancels pending intent (frame=${frame})`, (t) => {
    const h = paneFixture(t, {
      frame,
      onStop: () => assert.fail("even a no-motion scroll disarms"),
    });
    const before = arm(h.pane);
    h.pane.handleInput("\x1b[F");
    h.pane.handleInput(CONFIRM);
    const after = h.pane.render(120);
    assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
    assertRightmostLabel(after, "[S Stop]", 120, frame);
  });

for (const frame of [false, true])
  for (const elapsed of [9999, 10000, 10001])
    for (const pointer of [false, true]) {
      test(`monotonic confirmation expiry is exact without repaint (frame=${frame}, elapsed=${elapsed}, pointer=${pointer})`, (t) => {
        const clock = monotonicClock(t),
          stopped = [];
        const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
        const confirmation = arm(h.pane);
        clock.advance(elapsed);
        // Old painted geometry/input is deliberately used without a render.
        if (pointer)
          clickLabel(h.pane, confirmation, "[Confirm stop]", "[Confirm stop]".length - 1);
        else h.pane.handleInput(CONFIRM);
        assert.deepEqual(stopped, elapsed < 10000 ? ["run-a"] : []);
        if (elapsed >= 10000) {
          h.pane.handleInput(CONFIRM);
          assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
          h.pane.handleInput(CONFIRM);
          assert.deepEqual(stopped, [], "repaint does not restore expired intent");
          arm(h.pane);
          h.pane.handleInput(CONFIRM);
          assert.deepEqual(
            stopped,
            ["run-a"],
            "a freshly painted deliberate interaction is required",
          );
        }
      });
    }

for (const frame of [false, true])
  for (const event of ["render", "s", "press"]) {
    test(`expired intent cannot be refreshed by old paint (frame=${frame}, event=${event})`, (t) => {
      const clock = monotonicClock(t),
        stopped = [];
      const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
      const lines = arm(h.pane);
      clock.advance(10000);
      if (event === "render") assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
      else if (event === "s") h.pane.handleInput("s");
      else {
        const footer = lines.at(-1),
          x = visibleWidth(footer.slice(0, footer.indexOf("[Confirm stop]")));
        h.pane.handleMouse({ type: "press", button: "left", x, y: lines.length - 1 });
      }
      h.pane.handleInput(CONFIRM);
      assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
      assert.deepEqual(stopped, []);
    });
  }

for (const frame of [false, true])
  test(`unpainted confirmation also expires (frame=${frame})`, (t) => {
    const clock = monotonicClock(t);
    const h = paneFixture(t, {
      frame,
      onStop: () => assert.fail("unpainted/expired intent is inert"),
    });
    h.pane.render(120);
    h.pane.handleInput("s");
    clock.advance(10000);
    h.pane.handleInput(CONFIRM);
    assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
  });

for (const frame of [false, true])
  test(`repeated S and wall-clock changes cannot extend intent (frame=${frame})`, (t) => {
    const clock = monotonicClock(t),
      stopped = [];
    let wall = 0;
    t.mock.method(Date, "now", () => wall);
    const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
    arm(h.pane);
    wall = 1_000_000_000;
    clock.advance(9999);
    h.pane.handleInput("s");
    h.pane.handleInput("S");
    assert(
      h.pane.render(120).at(-1).includes("[Confirm stop]"),
      "wall time does not expire monotonic intent early",
    );
    wall = -1_000_000_000;
    clock.advance(1);
    h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [], "S, repaint and a backward wall clock cannot renew the deadline");
    assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
  });

for (const frame of [false, true])
  test(`Esc cancels the visible expired intent before repaint (frame=${frame})`, (t) => {
    const clock = monotonicClock(t);
    const h = paneFixture(t, { frame, onStop: () => assert.fail("Esc never stops work") });
    const before = arm(h.pane);
    clock.advance(10000);
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 0, "first Esc cancels even after the unpainted deadline");
    const after = h.pane.render(120);
    assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
    assertRightmostLabel(after, "[S Stop]", 120, frame);
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 1);
  });

for (const frame of [false, true])
  for (const change of ["expiry", "columns", "rows"])
    for (const repaint of [false, true]) {
      test(`timer invalidation preserves Esc semantics until repaint (frame=${frame}, change=${change}, repaint=${repaint})`, (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const clock = monotonicClock(t);
        const h = paneFixture(t, {
          frame,
          onStop: () => assert.fail("stale confirmation must never stop work"),
        });
        arm(h.pane);
        if (change === "expiry") clock.advance(10000);
        else h.terminal[change]++;
        const renders = h.renders;
        t.mock.timers.tick(120);
        assert(h.renders > renders, "the timer requests a repaint for stale confirmation");
        assert.equal(h.closes, 0, "a timer cannot close the pane");
        if (repaint) {
          assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
          h.pane.handleInput("\x1b");
          assert.equal(h.closes, 1, "after repaint removes confirmation, Esc closes normally");
        } else {
          h.pane.handleInput("\x1b");
          assert.equal(
            h.closes,
            0,
            "before repaint, first Esc cancels the still-visible confirmation",
          );
          assertRightmostLabel(h.pane.render(120), "[S Stop]", 120, frame);
          h.pane.handleInput("\x1b");
          assert.equal(h.closes, 1, "the next Esc closes the pane");
        }
      });
    }

for (const frame of [false, true])
  for (const count of [undefined, 0, 1, 2, 3])
    for (const confirming of [false, true]) {
      test(`button presses and click counts require a single deliberate click (frame=${frame}, count=${count}, confirming=${confirming})`, (t) => {
        const stopped = [];
        const h = paneFixture(t, { frame, onStop: (id) => stopped.push(id) });
        const lines = confirming ? arm(h.pane) : h.pane.render(120);
        const label = confirming ? "[Confirm stop]" : "[S Stop]";
        const footer = lines.at(-1),
          x = visibleWidth(footer.slice(0, footer.indexOf(label))),
          y = lines.length - 1;
        assert.deepEqual(h.pane.handleMouse({ type: "press", button: "left", x, y }), {
          handled: true,
        });
        assert.deepEqual(stopped, []);
        assert.deepEqual(clickLabel(h.pane, lines, label, 0, count), { handled: true });
        const single = count === undefined || count === 1;
        assert.deepEqual(stopped, confirming && single ? ["run-a"] : []);
        const repainted = h.pane.render(120);
        if (!confirming) assert.equal(repainted.at(-1).includes("[Confirm stop]"), single);
        else if (!single)
          assert(
            repainted.at(-1).includes("[Confirm stop]"),
            "multi-clicks do not consume confirmation either",
          );
      });
    }

for (const frame of [false, true])
  test(`Stop is dim while Confirm is warning and bold (frame=${frame})`, (t) => {
    const colors = [],
      bold = [];
    const paneTheme = {
      fg: (color, text) => {
        colors.push({ color, text });
        return color === "warning"
          ? `\x1b[33m${text}\x1b[39m`
          : color === "dim"
            ? `\x1b[2m${text}\x1b[22m`
            : text;
      },
      bold: (text) => {
        bold.push(text);
        return `\x1b[1m${text}\x1b[22m`;
      },
    };
    const h = paneFixture(t, { frame, paneTheme, onStop() {} });
    h.pane.render(120);
    assert(colors.some(({ color, text }) => color === "dim" && text.includes("[S Stop]")));
    assert(!colors.some(({ color, text }) => color === "warning" && text.includes("[S Stop]")));
    assert(!bold.some((text) => text.includes("[S Stop]")));
    colors.length = 0;
    bold.length = 0;
    const confirmation = arm(h.pane);
    assert(
      colors.some(({ color, text }) => color === "warning" && text.includes("[Confirm stop]")),
    );
    assert(bold.some((text) => text.includes("[Confirm stop]")));
    assert(stripTerminalSequences(confirmation.at(-1)).includes(CONFIRM_HINT));
  });

for (const frame of [false, true])
  for (const width of [frame ? 62 : 56, 80, 120]) {
    test(`task cue and ordinal survive long nickname, tail and Agent reuse (frame=${frame}, width=${width})`, (t) => {
      const stopped = [];
      const original = view("a", {
        name: "longnickname".repeat(20),
        description: "Build",
        task: 17,
        run_id: "run-old",
      });
      const rows = {
        lineCount: () => 100,
        slice: (_width, start, take) =>
          Array.from(
            { length: Math.max(0, Math.min(take, 100 - start)) },
            (_, i) => `history-${start + i}`,
          ),
      };
      const h = paneFixture(t, {
        frame,
        views: [original],
        transcript: () => rows,
        onStop: (id) => stopped.push(id),
      });
      h.terminal.rows = 8;
      const before = h.pane.render(width),
        title = stripTerminalSequences(before[0]);
      assert(
        title.includes("Build") && title.includes("#17"),
        "task and ordinal outrank nickname/profile at the minimum width",
      );
      assert(before.at(-2).includes("history-99"), "identity fields are scrolled off at the tail");
      assertInlineConfirmation(before, arm(h.pane, width));
      Object.assign(original, { description: "Check", task: 18, run_id: "run-new" });
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "old target cannot stop the new Run");
      const replacement = h.pane.render(width),
        nextTitle = stripTerminalSequences(replacement[0]);
      assert(nextTitle.includes("Check") && nextTitle.includes("#18"));
      assert(!nextTitle.includes("#17"));
      assert.notEqual(
        nextTitle,
        title,
        "reuse is visible even though name, transcript and scroll position are unchanged",
      );
      assert.deepEqual(replacement.slice(1, -1), before.slice(1, -1));
      assertInlineConfirmation(replacement, arm(h.pane, width));
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, ["run-new"]);
    });
  }

for (const task of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "17"]) {
  test(`invalid or absent task ordinal retains Run cue (${task})`, () => {
    const input = {
      view: view("a", { name: "nickname".repeat(30), description: "Build", task }),
      live,
    };
    const title = stripTerminalSequences(renderDetailTitle(input, 0, theme, 56));
    assert(title.includes("Build") && title.includes("run-a"));
    assert(!title.includes("#"), "only a valid immutable ordinal is presented as #N");
  });
}

test("ordinary and armed renders each take one snapshot, actions still read fresh authority", (t) => {
  const stopped = [];
  const h = paneFixture(t, { onStop: (id) => stopped.push(id) });
  h.pane.render(120);
  assert.equal(h.snapshots, 1);
  const beforeArm = h.snapshots;
  h.pane.handleInput("s");
  assert(h.snapshots > beforeArm, "arming validates current authority");
  const beforePaint = h.snapshots;
  h.pane.render(120);
  assert.equal(h.snapshots - beforePaint, 1, "armed paint reuses its one snapshot");
  h.views[0].generation = "replacement-generation";
  const beforeConfirm = h.snapshots;
  h.pane.handleInput(CONFIRM);
  assert(h.snapshots > beforeConfirm, "confirmation gets a new action-time snapshot");
  assert.deepEqual(stopped, []);
});

for (const [labelSource, description] of [
  ["explicit multiline", "First\tline\nSecond line"],
  ["default first nonblank line", "First\tline"],
]) {
  test(`task label whitespace stays readable (${labelSource})`, () => {
    const input = { view: view("a", { description }), live };
    const title = renderDetailTitle(input, 0, theme, 120),
      fields = renderDetailFields(input, theme, 120);
    assert(!/[\t\r\n]/u.test(title));
    assert(!title.includes("\\x09") && !title.includes("\\x0a"));
    const taskRows = fields.slice(0, fields.indexOf(""));
    assert.equal(
      taskRows
        .map((line) => line.replace(/^\s*task\s*/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      description.replace(/\s+/g, " "),
    );
    assert(fields.every((line) => !/\p{Cc}/u.test(line)));
    assert.equal(
      input.view.description,
      description,
      "display normalization never rewrites the Run label",
    );
  });
}

const unsafeMetadata = "\x1b[8mx\x1b[0m\x1b]0;spoof\x07\x08";
const metadataInput = (extra = {}, extraLive = {}) => ({
  view: view("a", extra),
  live: { ...live, ...extraLive },
});
for (const [field, input] of [
  ["task", metadataInput({ description: unsafeMetadata })],
  [
    "run/agent/session",
    metadataInput({
      run_id: unsafeMetadata,
      agent_id: unsafeMetadata,
      history_ref: { session_id: unsafeMetadata },
    }),
  ],
  [
    "routing",
    metadataInput({
      effective_settings: {
        ...settings,
        preset: unsafeMetadata,
        preset_version: unsafeMetadata,
        strength: unsafeMetadata,
      },
    }),
  ],
  [
    "effort",
    metadataInput({
      effective_settings: {
        ...settings,
        thinking: unsafeMetadata,
        parent_thinking: unsafeMetadata,
        thinking_resolution: "automatic_mapping",
      },
    }),
  ],
  ["model", metadataInput({ effective_settings: { ...settings, model: unsafeMetadata } })],
  ["cwd", metadataInput({ effective_settings: { ...settings, cwd: unsafeMetadata } })],
  ["tools", metadataInput({ effective_settings: { ...settings, tools: [unsafeMetadata] } })],
  ["phase", metadataInput({ phase: unsafeMetadata })],
  ["activity", metadataInput({ runtime: { activity: unsafeMetadata } })],
  ["model stop", metadataInput({ model_stop_reason: unsafeMetadata })],
  ["draft", metadataInput({}, { preview: unsafeMetadata })],
  [
    "active tools",
    metadataInput({}, { active_tools: [{ name: unsafeMetadata, detail: unsafeMetadata }] }),
  ],
  ["asked", metadataInput({ outcome: { question: unsafeMetadata } })],
  ["error", metadataInput({ outcome: { error: unsafeMetadata } })],
  ["reason", metadataInput({ outcome: { reason: unsafeMetadata } })],
  ["dispatch", metadataInput({ dispatch_notes: [unsafeMetadata] })],
  ["session", metadataInput({ unavailable_reason: unsafeMetadata })],
  ["owner", metadataInput({ owner_error: unsafeMetadata })],
  ["history", metadataInput({ history_error: unsafeMetadata })],
  ["cleanup", metadataInput({ cleanup_errors: [unsafeMetadata] })],
  ["discarded", metadataInput({ discarded_inputs: [unsafeMetadata] })],
])
  test(`all metadata values are sanitized before field styling/wrapping (${field})`, () => {
    const fields = renderDetailFields(input, theme, 120);
    assert(
      fields.every((line) => !/\p{Cc}/u.test(line)),
      "no user terminal sequence or raw control reaches any field row",
    );
    assert(
      fields.join("").includes("x\\x08"),
      "safe visible content and explicit unsafe-control escape remain",
    );
    assert(!fields.join("").includes("spoof"));
    assert(fields.every((line) => visibleWidth(line) <= 120));
  });

for (const frame of [false, true])
  test(`bidi is explicit while script and emoji joiners remain readable (frame=${frame})`, (t) => {
    const description = "a\u200cb 👩\u200d💻 \u202eRTL\u202c \u2066LTR\u2069";
    const h = paneFixture(t, { frame, views: [view("a", { description })], onStop() {} });
    h.pane.render(120);
    h.pane.handleInput("\x1b[H");
    const ordinary = h.pane.render(120),
      text = ordinary.join("\n");
    assert(!/\p{Bidi_Control}/u.test(text));
    for (const code of ["202e", "202c", "2066", "2069"]) assert(text.includes(`\\u${code}`));
    assert(text.includes("a\u200cb") && text.includes("👩\u200d💻"));
    assertInlineConfirmation(ordinary, arm(h.pane));
  });

test("detail grapheme wrapping preserves complete ZWJ emoji and combining clusters", () => {
  assert.deepEqual(wrapText("👩\u200d💻👩\u200d💻", 2), ["👩\u200d💻", "👩\u200d💻"]);
  assert.deepEqual(wrapText("e\u0301e\u0301", 1), ["e\u0301", "e\u0301"]);
});

const combiningTask = "a".repeat(73) + " \u0301 " + "測".repeat(39) + "A測";
test("word wrapping rechecks a wide character after a combining-only word break", () => {
  const source = `Task: ${combiningTask}`,
    lines = wrapText(source, 80);
  assert(
    lines.every((line) => visibleWidth(line) <= 80),
    "a word break must not leave an 81-column remainder",
  );
  assert.equal(
    lines.join("").replace(/ /g, ""),
    source.replace(/ /g, ""),
    "wrapping does not drop task characters",
  );
});

for (const frame of [false, true])
  test(`shrinking below normal pane height retires inline confirmation (frame=${frame})`, (t) => {
    const h = paneFixture(t, { frame, onStop: () => assert.fail("old confirmation was retired") });
    arm(h.pane);
    h.terminal.rows = 7;
    assertNoStopAction(h, 120);
    h.terminal.rows = 40;
    assert.match(h.pane.render(120).at(-1), /\[S Stop\]/);
    h.pane.handleInput(CONFIRM);
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[Confirm stop\]/);
  });

for (const overrides of [
  { status: "completed", execution_exited: true },
  { status: "failed", execution_exited: true },
  { status: "needs_input", execution_exited: true },
  { status: "cancelled", execution_exited: true },
  { status: "cancelling" },
  { execution_exited: true, finalization_pending: true },
  ...["deadline", "hard_budget", "user_cancel"].map((stop_reason) => ({ stop_reason })),
])
  test(`settled, draining and already-stopping work has no Stop action (${JSON.stringify(overrides)})`, (t) => {
    const h = paneFixture(t, {
      views: [view("a", overrides)],
      onStop: () => assert.fail("no live execution to stop"),
    });
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
    h.pane.handleInput("s");
    h.pane.handleInput(CONFIRM);
  });

for (const stage of ["intent", "confirmation"])
  for (const change of [
    "new-run",
    "owner",
    "generation",
    "agent-identity",
    "removed",
    "other-agent",
    "settled",
    "stopping",
    "selection",
    "navigation",
  ])
    test(`stale ${stage} never targets replacement work (${change})`, (t) => {
      const stopped = [];
      const h = paneFixture(t, { views: [view("a"), view("b")], onStop: (id) => stopped.push(id) });
      const lines = stage === "confirmation" ? arm(h.pane) : h.pane.render(120);
      const label = stage === "confirmation" ? "[Confirm stop]" : "[S Stop]";
      if (change === "new-run") h.views[0].run_id = "new-run-a";
      else if (change === "owner") h.views[0].owner_id = "replacement-owner";
      else if (change === "generation") h.views[0].generation = "replacement-generation";
      else if (change === "agent-identity") h.views[0].agent_id = "replacement-agent";
      else if (change === "removed") h.views.splice(0);
      else if (change === "other-agent") h.views.shift();
      else if (change === "settled") h.views[0].execution_exited = true;
      else if (change === "stopping") h.views[0].stop_reason = "deadline";
      else if (change === "selection") h.pane.activate("b");
      else h.pane.handleInput("\x1b[C");
      // Exercise old pointer geometry first, then keys, without a repaint.
      clickLabel(h.pane, lines, label);
      h.pane.handleInput("s");
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "no fallback or retargeting before repaint");
      h.pane.render(120);
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [], "repaint cannot re-arm a stale confirmation");
    });

test("empty roster with Stop handler and read-only panes offer no Stop", (t) => {
  for (const options of [
    { views: [], onStop: () => assert.fail("empty roster") },
    { onStop: undefined },
  ]) {
    const h = paneFixture(t, options);
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
    h.pane.handleInput("s");
    h.pane.handleInput(CONFIRM);
    h.pane.handleInput("\x1b");
    assert.equal(h.closes, 1);
  }
});

for (const close of ["dispose", "activate", "frame-close"])
  test(`closing discards confirmation (${close})`, (t) => {
    const h = paneFixture(t, { frame: true, onStop: () => assert.fail("closed pane") });
    arm(h.pane);
    if (close === "dispose") h.pane.dispose();
    else if (close === "activate") h.pane.activate("a");
    else h.pane.handleMouse({ type: "click", button: "left", x: 117, y: 0 });
    h.pane.handleInput(CONFIRM);
    assert.deepEqual(h.pane.render(120), []);
  });

function mockWidget(v = view(), { wake = () => {}, mode = "regular" } = {}) {
  return {
    agents: () => [
      {
        agent_id: v.agent_id,
        view: v,
        live,
        cwd: settings.cwd,
        entries: () => undefined,
        inFlight: () => undefined,
      },
    ],
    onOpen() {},
    tuiMode: () => mode,
    wake,
  };
}
function panelFixture(
  t,
  { widget, stopRun, notify = () => {}, ready = () => true, mode = "regular" },
) {
  const bus = createEventBus(),
    shortcuts = new Map();
  let pane,
    closes = 0;
  const panels = new PanelCoordinator({
    pi: { events: bus, registerShortcut: (key, spec) => shortcuts.set(key, spec) },
    widget,
    ready,
    router() {
      assert.fail("Stop does not need a routing selection");
    },
    publish() {},
    showError() {},
    stopRun,
  });
  panels.attachHost(
    {
      mode: "tui",
      ui: {
        notify,
        custom(factory, options) {
          return new Promise((resolve) => {
            pane = factory(
              { terminal: { columns: 120, rows: 40 }, requestRender() {} },
              theme,
              {},
              () => {
                closes++;
                resolve();
              },
            );
            if (mode === "fullscreen") options.onHandle?.({ setHidden() {} });
          });
        },
      },
    },
    bus,
  );
  t.after(() => panels.dispose());
  return {
    panels,
    bus,
    open: () => shortcuts.get("alt+a").handler(),
    get pane() {
      return pane;
    },
    get closes() {
      return closes;
    },
  };
}

for (const queued of [false, true])
  test(`panel Stop uses the real Owner path while Off (queued=${queued})`, async (t) => {
    const admission = { enabled: true, revision: 0 };
    const f = await fixture(t, { controller: { admission: () => ({ ...admission }) } });
    const first = await f.controller.submit("first", task("first"));
    await until(() => f.ports[0]?.streaming);
    const second = queued ? await f.controller.submit("second", task("second")) : undefined;
    const widget = new AgentWidget(f.controller, 8);
    widget.tuiMode = () => "regular";
    const stopped = [],
      notices = [];
    const h = panelFixture(t, {
      widget,
      stopRun: (id) => {
        stopped.push(id);
        return f.controller.cancel(id, { source: "human" });
      },
      notify: (message) => notices.push(message),
    });
    t.after(() => widget.dispose());
    const opening = h.open(),
      target = second ?? first;
    if (widget.agents()[0].agent_id !== target.agent_id) h.pane.activate(target.agent_id);
    arm(h.pane);
    admission.enabled = false;
    admission.revision++;
    h.pane.handleInput(CONFIRM);
    assert.deepEqual(stopped, [target.run_id]);
    assert.equal(h.closes, 0);
    assert.match(notices.at(-1), /^Cancellation requested/);
    if (queued) {
      await ended(f.controller, target);
      assert.equal(f.controller.view(first.run_id).status, "running", "the sibling is untouched");
      assert.equal(f.ports[0].stopped, 0);
      assert.equal(f.ports.length, 1, "the queued child was never created");
    } else {
      await until(() => f.ports[0].stopped === 1);
      assert.equal(f.controller.view(target.run_id).status, "cancelling");
      assert.equal(
        f.controller.view(target.run_id).execution_exited,
        false,
        "a request is not confirmed exit",
      );
      assert.equal(f.controller.stats().active, 1, "ownership remains until actual execution exit");
      h.pane.handleInput("s");
      h.pane.handleInput(CONFIRM);
      assert.deepEqual(stopped, [target.run_id]);
      f.ports[0].finish("partial", "aborted");
      await ended(f.controller, target);
    }
    assert.equal(f.controller.view(target.run_id).status, "cancelled");
    assert.equal(f.controller.view(target.run_id).cancellation_source, "human");
    assert.equal(
      f.controller.stats().resident,
      queued ? 2 : 1,
      "Stop is not Agent kill or Owner shutdown",
    );
    assert.equal(f.controller.stats().closed, false);
    assert.doesNotMatch(h.pane.render(120).at(-1), /\[S Stop\]/);
    h.panels.dispose();
    await opening;
  });

for (const brokenNotify of [false, true])
  for (const pointer of [false, true]) {
    test(`command failure is contained (broken notify=${brokenNotify}, pointer=${pointer})`, async (t) => {
      const notices = [];
      let stops = 0,
        wakes = 0;
      const h = panelFixture(t, {
        widget: mockWidget(view(), {
          wake: () => {
            wakes++;
          },
        }),
        stopRun: () => {
          stops++;
          throw new Error("CONTROLLED_STOP_FAILURE");
        },
        notify: (message) => {
          notices.push(message);
          if (brokenNotify) throw new Error("NOTIFY_FAILED");
        },
      });
      const opening = h.open(),
        lines = arm(h.pane);
      assert.doesNotThrow(() =>
        pointer ? clickLabel(h.pane, lines, "[Confirm stop]") : h.pane.handleInput(CONFIRM),
      );
      h.pane.handleInput(CONFIRM);
      assert.equal(stops, 1);
      assert.equal(wakes, 0);
      assert.equal(h.closes, 0);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Cancellation request failed:.*CONTROLLED_STOP_FAILURE/);
      h.panels.dispose();
      await opening;
    });
  }

for (const brokenNotify of [false, true])
  test(`accepted cancellation survives refresh failure (broken notify=${brokenNotify})`, async (t) => {
    let stops = 0,
      wakes = 0;
    const notices = [];
    const h = panelFixture(t, {
      widget: mockWidget(view(), {
        wake: () => {
          wakes++;
          throw new Error("REFRESH_FAILED");
        },
      }),
      stopRun: () => {
        stops++;
        return accepted;
      },
      notify: (message) => {
        notices.push(message);
        if (brokenNotify) throw new Error("NOTIFY_FAILED");
      },
    });
    const opening = h.open();
    arm(h.pane);
    assert.doesNotThrow(() => h.pane.handleInput(CONFIRM));
    h.pane.handleInput(CONFIRM);
    assert.equal(stops, 1);
    assert.equal(wakes, 1);
    assert.deepEqual(notices, ["Cancellation requested; display refresh failed"]);
    h.panels.dispose();
    await opening;
  });

for (const [result, expected] of [
  [accepted, "Cancellation requested"],
  [{ ...accepted, already_stopping: true }, "Cancellation already requested; still stopping"],
  [
    { result: "already_terminal", already_stopping: false },
    "Task already finished; no cancellation needed",
  ],
  [
    { result: "already_exited", already_stopping: false },
    "Task execution already exited; no cancellation needed",
  ],
  [{ ...accepted, warnings: ["CONTROLLED_WARNING"] }, "Cancellation requested; CONTROLLED_WARNING"],
])
  test(`Stop result has useful feedback (${expected})`, async (t) => {
    const notices = [];
    let stops = 0,
      wakes = 0;
    const h = panelFixture(t, {
      widget: mockWidget(view(), {
        wake: () => {
          wakes++;
        },
      }),
      stopRun: () => {
        stops++;
        return result;
      },
      notify: (message, kind) => notices.push({ message, kind }),
    });
    const opening = h.open();
    arm(h.pane);
    h.pane.handleInput(CONFIRM);
    assert.equal(stops, 1);
    assert.equal(wakes, 1);
    assert.deepEqual(notices, [
      { message: expected, kind: result.warnings?.length ? "warning" : "info" },
    ]);
    h.panels.dispose();
    await opening;
  });

for (const mode of ["regular", "fullscreen"])
  test(`current blocked actions explain; retired callbacks stay silent (${mode})`, async (t) => {
    let ready = true,
      stopped = 0;
    const notices = [];
    const h = panelFixture(t, {
      widget: mockWidget(view(), { mode }),
      mode,
      ready: () => ready,
      stopRun: () => {
        stopped++;
        return accepted;
      },
      notify: (message) => notices.push(message),
    });
    const opening = h.open();
    arm(h.pane);
    ready = false;
    h.pane.handleInput(CONFIRM);
    assert.equal(stopped, 0);
    assert.match(notices.at(-1), /not ready/);
    ready = true;
    arm(h.pane);
    // Capture the host-bound callback to exercise its own guard independently of
    // the pane's deliberately redundant identity/paint checks.
    const callback = h.pane.options.onStop;
    h.bus.emit("permissions:ui_prompt", { requestId: "stop-test-ask" });
    h.pane.handleInput(CONFIRM);
    assert.equal(stopped, 0, "hiding/closing clears confirmation immediately");
    const beforeBlockedCallback = notices.length;
    callback("run-a");
    if (mode === "regular")
      assert.equal(notices.length, beforeBlockedCallback, "retired pane callback is silent");
    if (mode === "fullscreen") {
      assert.match(notices.at(-1), /permission dialog/);
      h.bus.emit("permissions:decision", { requestId: "stop-test-ask" });
      h.pane.render(120);
      h.pane.handleInput(CONFIRM);
      assert.equal(stopped, 0, "reshowing does not restore confirmation");
    }
    h.panels.dispose();
    const before = notices.length;
    callback("run-a");
    h.pane.handleInput("s");
    h.pane.handleInput(CONFIRM);
    assert.equal(stopped, 0);
    assert.equal(notices.length, before, "retired host cannot be notified");
    await opening;
  });

test("command that retires its host produces no refresh or retired notification", async (t) => {
  let wakes = 0,
    stops = 0;
  const notices = [];
  const h = panelFixture(t, {
    widget: mockWidget(view(), {
      wake: () => {
        wakes++;
      },
    }),
    stopRun: () => {
      stops++;
      h.panels.dispose();
      return accepted;
    },
    notify: (message) => notices.push(message),
  });
  const opening = h.open();
  arm(h.pane);
  h.pane.handleInput(CONFIRM);
  assert.equal(stops, 1);
  assert.equal(wakes, 0);
  assert.deepEqual(notices, []);
  await opening;
});
