import {
  fixture,
  mouse,
  effortPreset,
  effortCaps,
  painted,
  delegationState,
  managementOption,
  savingOption,
  invisibleKeys,
  hidePicker,
  restoreViewport,
} from "../support/preset-picker-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { strengths } from "../../dist/routing.js";

test("tiny slot windows follow the selection and resize without overflow or hidden mouse effects", () => {
  for (const room of [7, 8, 9, 10, 12, 13, 16, 19])
    for (const width of [8, 18, 34, 76, 120]) {
      const h = fixture({
        rows: 40,
        pointer: true,
        presets: [effortPreset()],
        efforts: effortCaps,
      });
      // The actual row allowance can shrink independently of the terminal share.
      h.picker.options.rows = () => room;
      h.picker.handleInput("e");
      for (let index = 0; index < strengths.length; index++) {
        h.picker.handleInput(String(index + 1));
        const lines = painted(h.picker, width);
        assert(lines.length <= room, `${room}x${width}: ${lines.length}`);
        assert(lines.every((line) => visibleWidth(line) <= width));
        assert(
          lines.some((line) => line.includes(`›‹${strengths[index]}`)),
          lines.join("\n"),
        );
      }
      const lines = painted(h.picker, width),
        y = lines.findIndex((line) => line.includes("›‹d5"));
      h.picker.handleMouse(mouse("click", width + 1, y));
      assert.deepEqual(h.applied, [], "unpainted arrow columns never publish");
      if (width >= 18) {
        const next = lines[y].indexOf("›", lines[y].indexOf("‹") + 1);
        assert(next > 0, lines[y]);
        h.picker.handleMouse(mouse("click", next, y));
        assert.deepEqual(h.applied.at(-1).effort_overrides, { d1: "high", d5: "inherit" });
      }
      h.picker.options.rows = () => 7;
      assert(
        painted(h.picker, 18).some((line) => line.includes("›‹d5")),
        "shrinking keeps the fifth selected slot visible",
      );
      h.picker.handleMouse(mouse("wheel", 4, 3, { wheelDelta: 1 }));
      assert(
        painted(h.picker, 18).some((line) => line.includes("›‹d4")),
        "the editor wheel selects, not edits",
      );
      h.picker.handleInput("\u001b");
      h.picker.handleInput("\u001b[Z");
      assert(
        painted(h.picker, 34).some((line) => line.includes("›d5")),
        "Shift+Tab moves up to d5 after resize",
      );
      assert(painted(h.picker, 76).some((line) => line.includes("provider/alpha-strong")));
    }
});

test("a subminimum viewport paints nothing and cannot edit or reset unseen effort", () => {
  for (const room of [0, 1, 3, 6]) {
    const h = fixture({ pointer: true, presets: [effortPreset()], efforts: effortCaps, rows: 40 });
    h.picker.handleInput("e");
    h.picker.options.rows = () => room;
    assert.deepEqual(painted(h.picker), []);
    h.picker.handleInput("5");
    h.picker.handleInput("\u001b[C");
    h.picker.handleInput("r");
    assert.deepEqual(h.applied, []);
    h.picker.handleInput("\u001bs");
    assert.deepEqual(h.result, [null], "cancellation always remains available");
  }
});

test("terminal/width minima refuse invisible selection and effort but keep cancellation", () => {
  for (const [rows, width] of [
    [4, 76],
    [6, 76],
    [24, 7],
  ]) {
    const selecting = fixture({ rows, management: managementOption({ models: true }) });
    assert.deepEqual(painted(selecting.picker, width), []);
    selecting.picker.handleInput("\r");
    selecting.picker.handleInput("5");
    assert.deepEqual(selecting.result, []);
    selecting.picker.handleInput("\u001b");
    assert.deepEqual(selecting.result, [null]);
    const editing = fixture({ rows, presets: [effortPreset()], efforts: effortCaps });
    editing.picker.handleInput("e");
    assert.deepEqual(painted(editing.picker, width), []);
    editing.picker.handleInput("5");
    editing.picker.handleInput("\u001b[C");
    editing.picker.handleInput("r");
    assert.deepEqual(editing.applied, []);
    editing.picker.handleInput("\u001bs");
    assert.deepEqual(editing.result, [null]);
  }
});

test("unusable list pickers gate all routes and changes before first paint and after resize", () => {
  for (const kind of [
    "terminal rows",
    "terminal width",
    "allocation rows",
    "paint width",
    "zero paint width",
  ]) {
    for (const previouslyPainted of [false, true]) {
      const state = delegationState(),
        h = fixture({
          rows: 40,
          pointer: true,
          presets: [effortPreset("alpha"), effortPreset("beta")],
          activeName: "alpha",
          efforts: effortCaps,
          delegation: state.option,
          management: savingOption(),
        });
      if (previouslyPainted) painted(h.picker);
      hidePicker(h, kind);
      const selection = h.picker.selection(),
        slotIndex = h.picker.slotIndex;
      for (const key of [...invisibleKeys, "\r"]) h.picker.handleInput(key);
      assert.deepEqual(
        h.result,
        [],
        `${kind}, prior paint=${previouslyPainted}: no invisible route`,
      );
      assert.deepEqual(h.applied, []);
      assert.deepEqual(state.sets, []);
      assert.equal(h.picker.selection(), selection);
      assert.equal(h.picker.slotIndex, slotIndex, "invisible navigation is inert too");
      restoreViewport(h);
      assert.match(painted(h.picker)[0], /Delegation/, "E never opened an invisible page");
      h.picker.handleInput("g");
      assert.deepEqual(
        h.result,
        [{ action: "save-default", scope: "global" }],
        "routes recover with a usable viewport",
      );
    }
    for (const cancel of ["\u001bs", "\u0003", "\u001b"]) {
      const h = fixture({
        rows: 40,
        presets: [effortPreset()],
        efforts: effortCaps,
        management: savingOption(),
      });
      hidePicker(h, kind);
      h.picker.handleInput(cancel);
      assert.deepEqual(h.result, [null], `${kind}: cancellation is still usable`);
    }
  }
});

test("invisible effort pages retain live edits, allow back/cancel, and never save or route", () => {
  for (const kind of [
    "terminal rows",
    "terminal width",
    "allocation rows",
    "paint width",
    "zero paint width",
  ]) {
    for (const back of ["\u001b", "\r"]) {
      const state = delegationState(),
        h = fixture({
          rows: 40,
          presets: [effortPreset()],
          efforts: effortCaps,
          delegation: state.option,
          management: savingOption(),
        });
      h.picker.handleInput("e");
      h.picker.handleInput("\u001b[C");
      const applied = structuredClone(h.applied),
        slotIndex = h.picker.slotIndex;
      hidePicker(h, kind);
      for (const key of invisibleKeys) h.picker.handleInput(key);
      assert.deepEqual(h.result, []);
      assert.deepEqual(h.applied, applied);
      assert.deepEqual(state.sets, []);
      assert.equal(h.picker.slotIndex, slotIndex);
      h.picker.handleInput(back);
      assert.deepEqual(h.result, [], "Esc/Enter backs out instead of saving or cancelling");
      assert.deepEqual(h.applied, applied, "back never undoes a live effort");
      restoreViewport(h);
      assert.match(painted(h.picker)[0], /Delegation/);
    }
    for (const cancel of ["\u001bs", "\u0003"]) {
      const h = fixture({
        rows: 40,
        presets: [effortPreset()],
        efforts: effortCaps,
        management: savingOption(),
      });
      h.picker.handleInput("e");
      hidePicker(h, kind);
      h.picker.handleInput(cancel);
      assert.deepEqual(h.result, [null]);
    }
  }
  for (const back of ["\u001b", "\r"]) {
    const h = fixture({
      rows: 6,
      startInEffort: true,
      presets: [effortPreset()],
      efforts: effortCaps,
      management: savingOption(),
    });
    assert.equal(
      h.picker.editing,
      true,
      "active startup continuation may initialize its passive page before paint",
    );
    for (const key of invisibleKeys) h.picker.handleInput(key);
    assert.deepEqual(h.result, []);
    assert.deepEqual(h.applied, []);
    h.picker.handleInput(back);
    restoreViewport(h);
    assert.match(painted(h.picker)[0], /Delegation/);
  }
  const inactive = fixture({
    rows: 6,
    startInEffort: true,
    activeName: "off",
    presets: [effortPreset()],
    efforts: effortCaps,
  });
  assert.deepEqual(
    inactive.result,
    [],
    "an invisible inactive startup cannot invoke a confirmation route",
  );
});

test("eight-column compact save controls keep Tab and exact G/W click targets with live trust gating", () => {
  for (const rows of [7, 8, 10])
    for (const trusted of [false, true])
      for (const withMode of [false, true]) {
        const make = (management = savingOption(trusted)) =>
          fixture({
            rows,
            pointer: true,
            presets: [effortPreset()],
            efforts: effortCaps,
            management,
            ...(withMode ? { delegation: delegationState().option } : {}),
          });
        const h = make();
        let lines = painted(h.picker, 8),
          y = lines.findIndex((line) => line === "│GW Tab│");
        assert(y > 0, `${rows}, trusted=${trusted}, mode=${withMode}: ${lines.join("\n")}`);
        assert(lines.every((line) => visibleWidth(line) <= 8));
        assert(lines.length <= Math.max(7, Math.floor(rows * 0.8)));
        assert(lines.some((line) => line.includes("›d5")));
        for (let index = 0; index < 4; index++) h.picker.handleInput("\t");
        lines = painted(h.picker, 8);
        y = lines.findIndex((line) => line === "│GW Tab│");
        assert(
          lines.some((line) => line.includes("›d1")),
          "Tab still reaches the easiest slot",
        );
        h.picker.handleMouse(mouse("click", lines[y].indexOf("Tab"), y));
        h.picker.handleMouse(mouse("click", 0, y));
        h.picker.handleMouse(mouse("click", 7, y));
        assert.deepEqual(h.result, [], "navigation text and borders are not save targets");
        h.picker.handleMouse(mouse("click", lines[y].indexOf("G"), y));
        assert.deepEqual(h.result, [{ action: "save-default", scope: "global" }]);

        const project = make(),
          projectLines = painted(project.picker, 8);
        const projectY = projectLines.findIndex((line) => line === "│GW Tab│");
        project.picker.handleMouse(mouse("click", projectLines[projectY].indexOf("W"), projectY));
        assert.deepEqual(
          project.result,
          trusted ? [{ action: "save-default", scope: "workspace" }] : [],
          "a painted locked W remains inert",
        );
        if (!trusted) {
          project.picker.handleInput("w");
          assert.deepEqual(project.result, []);
          assert.equal(project.picker.isOpen(), true);
        }

        let liveTrust = true;
        const stale = make(
          managementOption({ saveDefaults: true, canSaveWorkspace: () => liveTrust }),
        );
        const staleLines = painted(stale.picker, 8),
          staleY = staleLines.findIndex((line) => line === "│GW Tab│");
        liveTrust = false;
        stale.picker.handleMouse(mouse("click", staleLines[staleY].indexOf("W"), staleY));
        assert.deepEqual(stale.result, [], "tight targets cannot reuse trust from the last paint");
      }
});

test("tiny compact and effort rows keep a visible slot-navigation hint", () => {
  const list = fixture({
    rows: 8,
    pointer: true,
    presets: [effortPreset()],
    efforts: effortCaps,
    delegation: delegationState().option,
    management: savingOption(),
  });
  assert(
    painted(list.picker, 8).some((line) => line.includes("Tab")),
    painted(list.picker, 8).join("\n"),
  );
  const effort = fixture({
    rows: 7,
    pointer: true,
    activeName: "alpha",
    presets: [effortPreset()],
    efforts: effortCaps,
    management: savingOption(),
  });
  effort.picker.handleInput("e");
  const effortLines = painted(effort.picker, 8).join("\n");
  assert(effortLines.includes("↑"), effortLines);
  assert(effortLines.includes("G") && effortLines.includes("W"), effortLines);
});

test("compact delegation/save layouts start at d5 and Tab reaches d1 through their slot window", () => {
  for (const saving of [false, true])
    for (const width of [18, 34, 76, 120]) {
      const h = fixture({
        rows: 8,
        pointer: true,
        presets: [effortPreset()],
        efforts: effortCaps,
        delegation: delegationState().option,
        management: saving ? savingOption() : managementOption({ models: true }),
      });
      let lines = painted(h.picker, width);
      assert(
        lines.some((line) => line.includes("Tab")),
        `${width}: ${lines.join("\n")}`,
      );
      assert(lines.length <= 7);
      assert(
        lines.some((line) => line.includes("›d5")),
        "hardest slot is selected first",
      );
      for (let index = 0; index < 4; index++) h.picker.handleInput("\t");
      lines = painted(h.picker, width);
      assert(
        lines.some((line) => line.includes("›d1")),
        "easiest slot is reachable without changing preset",
      );
      assert.equal(h.picker.selection(), "alpha");
      if (!saving && width >= 34) {
        const y = lines.findIndex((line) => line.includes("›d1") && line.includes("provider/"));
        assert(y >= 0, lines.join("\n"));
        h.picker.handleMouse(mouse("click", lines[y].indexOf("provider/"), y));
        assert.deepEqual(h.result, [{ action: "edit-model", name: "alpha", slot: "d1" }]);
      }
    }
});
