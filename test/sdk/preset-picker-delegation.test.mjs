import {
  theme,
  keys,
  preset,
  offPreset,
  fixture,
  mouse,
  delegationState,
  nodeColumn,
} from "../support/preset-picker-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { delegationGuideline } from "../../dist/orchestration/delegation.js";
import { PresetPicker } from "../../dist/orchestration/ui/preset-picker.js";

test("the mode slider paints four nodes, fits or clips the current guideline, and applies keys at once", () => {
  const state = delegationState();
  const { picker, result } = fixture({ delegation: state.option, rows: 40 });
  const width = 100;
  let lines = picker.render(width).map(stripTerminalSequences);
  assert.match(lines[0], /Delegation/);
  assert.match(lines[1], /^│ Mode +○ Manual ─+ ● Co-worker ─+ ○ Lead ─+ ○ Supervisor +│$/);
  assert.match(lines[2], /Eagerness +‹ balanced ›/);
  const divider = lines.findIndex((line, index) => index > 2 && line.startsWith("├"));
  const guideline = lines
    .slice(3, divider)
    .map((line) => line.slice(1, -1).trim())
    .join(" ");
  assert.equal(
    guideline,
    delegationGuideline(state.current),
    "a wide panel shows the whole guideline",
  );
  assert(
    lines.some((line) => line.includes("Model preset")),
    "the preset list is titled Model preset",
  );
  for (const line of lines) assert.equal(visibleWidth(line), width, line);
  const narrow = picker.render(76).map(stripTerminalSequences);
  const narrowDivider = narrow.findIndex((line, index) => index > 2 && line.startsWith("├"));
  const clipped = narrow
    .slice(3, narrowDivider)
    .map((line) => line.slice(1, -1).trim())
    .join(" ");
  assert(
    clipped.endsWith("…"),
    "the longer web-routing guideline clips within the existing row budget",
  );
  assert(delegationGuideline(state.current).startsWith(clipped.slice(0, -1).trimEnd()));
  for (const line of narrow) assert.equal(visibleWidth(line), 76, line);

  picker.handleInput("\u001b[C"); // right
  assert.deepEqual(state.current, { mode: "lead", eagerness: "balanced" });
  picker.handleInput("\u001b[1;2C"); // shift+right
  assert.deepEqual(state.current, { mode: "lead", eagerness: "eager" });
  picker.handleInput("\u001b[1;2C");
  assert.equal(state.sets.length, 2, "clamped at the ends: no redundant apply");
  for (let i = 0; i < 5; i++) picker.handleInput("\u001b[D");
  assert.deepEqual(state.current, { mode: "manual", eagerness: "eager" });
  picker.handleInput("\u001b[1;2D");
  assert.deepEqual(state.current.eagerness, "eager", "eagerness is inert in Manual");
  lines = picker.render(76).map(stripTerminalSequences);
  assert.match(lines[2], /not used in Manual/);
  assert.match(lines[3], /Start or assign Agent work only when the user asks/);
  assert.deepEqual(result, [], "mode changes never close the panel or apply a preset");
});

test("pointer: hover does nothing; click a node; a drag previews and its release applies", () => {
  const state = delegationState();
  const { picker } = fixture({ delegation: state.option, pointer: true, rows: 40 });
  let lines = picker.render(76).map(stripTerminalSequences);
  const lead = nodeColumn(lines[1], "○ Lead"),
    supervisor = nodeColumn(lines[1], "○ Supervisor");
  assert(lead > 0 && supervisor > lead);

  const before = picker.render(76).join("\n");
  assert.equal(
    picker.handleMouse({ ...mouse("move", supervisor + 2, 1), button: "none" }),
    undefined,
    "hover is not handled",
  );
  assert.equal(picker.render(76).join("\n"), before, "hover changes nothing on screen");
  assert.equal(state.sets.length, 0);

  picker.handleMouse(mouse("click", lead + 1, 1));
  assert.deepEqual(state.current.mode, "lead");

  lines = picker.render(76).map(stripTerminalSequences);
  const manual = nodeColumn(lines[1], "○ Manual");
  assert.equal(picker.handleMouse(mouse("press", lead + 1, 1)).capture, true);
  picker.handleMouse(mouse("drag", manual + 3, 5));
  assert.equal(state.sets.length, 1, "dragging only previews");
  lines = picker.render(76).map(stripTerminalSequences);
  assert.match(lines[2], /preview · Manual/);
  assert.match(lines.slice(3, 6).join(" "), /Start or assign Agent work only/);
  picker.handleMouse(mouse("release", manual + 3, 5));
  assert.equal(state.current.mode, "manual", "release applies the nearest node, even off the row");

  const eager = delegationState({ mode: "lead", eagerness: "balanced" });
  const box = fixture({ delegation: eager.option, pointer: true, rows: 40 });
  lines = box.picker.render(76).map(stripTerminalSequences);
  const open = lines[2].indexOf("‹"),
    close = lines[2].indexOf("›");
  box.picker.handleMouse(mouse("click", close, 2));
  assert.equal(eager.current.eagerness, "eager");
  box.picker.render(76);
  box.picker.handleMouse(mouse("click", open, 2));
  box.picker.render(76);
  box.picker.handleMouse(mouse("click", open, 2));
  assert.equal(eager.current.eagerness, "reserved");
});

test("narrow or short panels keep a stepping mode row; Off dims the mode and says why", () => {
  const state = delegationState();
  const narrow = fixture({ delegation: state.option, pointer: true, rows: 40 });
  let lines = narrow.picker.render(44).map(stripTerminalSequences);
  for (const line of lines) assert.equal(visibleWidth(line), 44, line);
  const row = lines.findIndex((line) => line.includes("Mode ‹ Co-worker ›"));
  assert(row > 0, lines.join("\n"));
  narrow.picker.handleMouse(mouse("click", lines[row].indexOf("›"), row));
  assert.equal(state.current.mode, "lead");

  const short = fixture({ delegation: delegationState().option, rows: 12 });
  lines = short.picker.render(76).map(stripTerminalSequences);
  assert(
    lines.some((line) => line.includes("Mode ‹ Co-worker › ‹ balanced ›")),
    lines.join("\n"),
  );
  assert(lines.length <= Math.floor(12 * 0.8), "compact stays within its rows");

  const off = fixture({
    delegation: delegationState().option,
    rows: 40,
    presets: [offPreset(), preset("alpha")],
    activeName: "off",
  });
  lines = off.picker.render(76).map(stripTerminalSequences);
  assert(
    lines.some((line) => line.includes("Off: no Agent work")),
    lines.join("\n"),
  );
});

test("without a delegation option the picker is unchanged apart from its title", () => {
  const { picker } = fixture({ rows: 40 });
  const lines = picker.render(76).map(stripTerminalSequences);
  assert(!lines.some((line) => /│ Mode |Eagerness/.test(line)));
  picker.handleInput("\u001b[C");
  assert.equal(picker.selection(), "beta", "arrows do nothing without a mode");
});

test("pointer gestures end with any key or page switch; arrows edit effort, not mode, in the editor", () => {
  const state = delegationState();
  const { picker } = fixture({
    delegation: state.option,
    pointer: true,
    rows: 40,
    efforts: () => ({ levels: ["low", "high"] }),
  });
  let lines = picker.render(76).map(stripTerminalSequences);
  const supervisor = nodeColumn(lines[1], "○ Supervisor");
  picker.handleMouse(mouse("press", nodeColumn(lines[1], "○ Lead") + 1, 1));
  picker.handleMouse(mouse("drag", supervisor + 1, 1));
  assert.match(picker.render(76).map(stripTerminalSequences)[2], /preview · Supervisor/);
  picker.handleInput("\u001b[B"); // down: any key cancels the drag and its preview
  assert.doesNotMatch(picker.render(76).map(stripTerminalSequences)[2], /preview/);
  picker.handleMouse(mouse("release", supervisor + 1, 1));
  assert.equal(state.sets.length, 0, "the cancelled drag's release applies nothing");

  picker.handleInput("\u001b[A"); // restore the active beta highlight before editing
  picker.handleMouse(mouse("press", supervisor + 1, 1));
  picker.handleInput("e"); // the editor opens mid-drag
  picker.handleMouse(mouse("release", supervisor + 1, 1));
  picker.handleInput("\u001b[C"); // right adjusts effort in the editor
  assert.equal(state.sets.length, 0, "no mode change from the drag or from editor arrows");
  picker.handleInput("\u001b"); // back to the list
  lines = picker.render(76).map(stripTerminalSequences);
  assert.doesNotMatch(lines[2], /preview/, "no stale preview after the page switch");
  assert.equal(state.current.mode, "co-worker");
});

test("clipped eagerness and compact arrows create no pointer targets", () => {
  for (const width of [20, 25, 26, 30]) {
    const state = delegationState();
    const { picker } = fixture({ delegation: state.option, pointer: true, rows: 40 });
    const lines = picker.render(width).map(stripTerminalSequences);
    for (let y = 0; y < lines.length; y++)
      for (let x = 0; x < width; x++) {
        const before = { ...state.current };
        picker.handleMouse(mouse("click", x, y));
        if (state.current.eagerness !== before.eagerness || state.current.mode !== before.mode) {
          assert.match(
            lines[y][x],
            /[‹›○●]|[A-Za-z]/,
            `width ${width}: click at ${x},${y} on ${JSON.stringify(lines[y][x])} changed the mode`,
          );
          if (lines[y][x] !== "‹" && lines[y][x] !== "›")
            assert(/[○●]/.test(lines[y]), `only slider nodes act without an arrow: ${lines[y]}`);
        }
        if (state.sets.length) {
          state.current = { mode: "co-worker", eagerness: "balanced" };
          state.sets.length = 0;
          picker.render(width);
        }
      }
  }
});

test("through pi-tui's dispatcher, a key during a held slider press cancels it: the release applies nothing", () => {
  const terminal = { columns: 100, rows: 40, hideCursor() {} };
  const tui = new TuiAltScreen(terminal, false, undefined, {});
  tui.requestRender = () => {};
  const state = delegationState();
  const picker = new PresetPicker({
    tui,
    theme,
    keybindings: keys,
    presets: [preset("alpha"), preset("beta")],
    activeName: "beta",
    done() {},
    delegation: state.option,
    pointer: true,
  });
  tui.showOverlay(picker, { anchor: "top-left", row: 0, col: 0, width: 80 });
  tui.compositeOverlays(Array(terminal.rows).fill(""), terminal.columns, terminal.rows);
  const lines = picker.render(80).map(stripTerminalSequences);
  const x = nodeColumn(lines[1], "○ Supervisor") + 1,
    y = 1;
  const sgr = (release) =>
    tui.handleMouseEvent(
      tui.parseSgrMouseEvent(`\u001b[<0;${x + 1};${y + 1}${release ? "m" : "M"}`),
    );

  sgr(false);
  picker.handleInput("\u001b[D");
  sgr(true); // press Supervisor, Left (→ Manual), release unmoved
  assert.deepEqual(
    state.current,
    { mode: "manual", eagerness: "balanced" },
    "the keyboard choice stands",
  );
  assert.equal(state.sets.length, 1);

  sgr(false);
  sgr(true); // a later plain click still works
  assert.equal(state.current.mode, "supervisor");
});
