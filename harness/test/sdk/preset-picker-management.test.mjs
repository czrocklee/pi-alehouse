import {
  InteractiveMode,
  tick,
  keys,
  preset,
  offPreset,
  fixture,
  mouse,
  emptyOwnerPanels,
  effortPreset,
  effortCaps,
  painted,
  clickText,
  delegationState,
  managementOption,
  savingOption,
} from "../support/preset-picker-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PreferencesControls } from "../../dist/ui/preferences-controls.js";
import { createPresetModelSelector } from "../../dist/runtime/preset-model-selector.js";
import { strengths } from "../../dist/routing.js";
import { HIDE_TRANSIENT_OVERLAYS_EVENT } from "../../../lib/overlay-protocol.mjs";

test("editor save controls preserve seven-row budgeting and hit only visible G/W labels", () => {
  for (const rows of [8, 10, 12, 24])
    for (const width of [8, 18, 34, 76, 120]) {
      for (const [key, scope] of [
        ["G", "global"],
        ["W", "workspace"],
      ]) {
        const h = fixture({
          pointer: true,
          rows,
          presets: [effortPreset()],
          efforts: effortCaps,
          management: savingOption(),
        });
        h.picker.handleInput("e");
        const lines = painted(h.picker, width),
          y = lines.findIndex((line) => line.includes("G") && line.includes("W"));
        assert(lines.length <= Math.max(7, Math.floor(rows * 0.8)));
        assert(lines.every((line) => visibleWidth(line) <= width));
        assert(y >= 0);
        h.picker.handleMouse(mouse("click", lines[y].indexOf(key), y));
        assert.deepEqual(h.result, [{ action: "save-default", scope }]);
      }
    }
});

test("management keys route on the list page only and never without the option", () => {
  const settings = fixture({ management: managementOption() });
  settings.picker.render(76);
  settings.picker.handleInput("p");
  assert.deepEqual(settings.result, [{ action: "settings" }]);

  const created = fixture({ management: managementOption() });
  created.picker.render(76);
  created.picker.handleInput("N"); // shift+n
  assert.deepEqual(created.result, [{ action: "create-preset" }]);

  const edited = fixture({ management: managementOption() });
  edited.picker.render(76);
  edited.picker.handleInput("C"); // shift+c
  assert.deepEqual(edited.result, [{ action: "edit-preset", name: "beta" }]);

  // The effort editor keeps its own page and its own keys.
  const editing = fixture({ management: managementOption(), efforts: effortCaps });
  editing.picker.handleInput("e");
  editing.picker.handleInput("p");
  editing.picker.handleInput("n");
  editing.picker.handleInput("c");
  assert.deepEqual(editing.result, []);
  assert.match(painted(editing.picker).join("\n"), /Effort · beta/);

  // Without the option the keys are inert, exactly as before it existed.
  const legacy = fixture();
  legacy.picker.render(76);
  legacy.picker.handleInput("p");
  legacy.picker.handleInput("n");
  legacy.picker.handleInput("c");
  assert.deepEqual(legacy.result, []);
  legacy.picker.handleInput("\r");
  assert.deepEqual(legacy.result, ["beta"]);

  // Only the routes the host actually enabled fire.
  const partial = fixture({ management: managementOption({ presets: false }) });
  partial.picker.render(76);
  partial.picker.handleInput("n");
  partial.picker.handleInput("c");
  assert.deepEqual(partial.result, []);
  partial.picker.handleInput("p");
  assert.deepEqual(partial.result, [{ action: "settings" }]);
});

test("off highlights keep Enter, but create works and edit-preset does not", () => {
  const off = fixture({
    management: managementOption(),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  off.picker.render(76);
  off.picker.handleInput("\u001b[A"); // highlight off
  assert.equal(off.picker.selection(), "off");
  off.picker.handleInput("c");
  assert.deepEqual(off.result, [], "off is a control state with no preset to edit");
  off.picker.handleInput("n");
  assert.deepEqual(off.result, [{ action: "create-preset" }]);

  const applying = fixture({
    management: managementOption(),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  applying.picker.render(76);
  applying.picker.handleInput("\u001b[A");
  applying.picker.handleInput("\r");
  assert.deepEqual(applying.result, ["off"], "Enter keeps its meaning beside the new keys");

  const cancelled = fixture({
    management: managementOption(),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  cancelled.picker.render(76);
  cancelled.picker.handleInput("\u001bs");
  assert.deepEqual(cancelled.result, [null], "Esc still cancels without routing");
});

test("management labels are clickable and scoped to the labels actually painted", () => {
  const wide = fixture({ pointer: true, management: managementOption() });
  let lines = painted(wide.picker, 100);
  assert.match(
    lines.join("\n"),
    /P Settings · N New · C Edit/,
    "full labels when the row has room",
  );
  clickText(wide.picker, "P Settings", 100);
  assert.deepEqual(wide.result, [{ action: "settings" }]);

  const created = fixture({ pointer: true, management: managementOption() });
  clickText(created.picker, "N New", 100);
  assert.deepEqual(created.result, [{ action: "create-preset" }]);

  const edited = fixture({ pointer: true, management: managementOption() });
  clickText(edited.picker, "C Edit", 100);
  assert.deepEqual(edited.result, [{ action: "edit-preset", name: "beta" }]);

  // Narrower rows fall back to single letters; those stay real targets.
  const letters = fixture({ pointer: true, management: managementOption() });
  lines = painted(letters.picker, 76);
  const hint = lines.find((line) => line.includes("P N C"));
  assert(hint, lines.join("\n"));
  assert(
    !lines.some((line) => line.includes("P Settings")),
    "clipped labels leave no partial paint",
  );
  clickText(letters.picker, "P", 76);
  assert.deepEqual(letters.result, [{ action: "settings" }]);
  const letterCreate = fixture({ pointer: true, management: managementOption() });
  clickText(letterCreate.picker, "N", 76);
  assert.deepEqual(letterCreate.result, [{ action: "create-preset" }]);
  const letterEdit = fixture({ pointer: true, management: managementOption() });
  clickText(letterEdit.picker, "C", 76);
  assert.deepEqual(letterEdit.result, [{ action: "edit-preset", name: "beta" }]);

  // With off highlighted the edit route is neither hinted nor clickable.
  const offLabels = fixture({
    pointer: true,
    management: managementOption(),
    presets: [offPreset(), preset("alpha")],
    activeName: "alpha",
  });
  offLabels.picker.handleInput("\u001b[A");
  lines = painted(offLabels.picker, 100);
  assert(!lines.some((line) => line.includes("C Edit")), lines.join("\n"));
  clickText(offLabels.picker, "N New", 100);
  assert.deepEqual(offLabels.result, [{ action: "create-preset" }]);
});

test("management keeps keyboard routes and bounded paint at every size without new minimum rows", () => {
  for (const rows of [8, 10, 12, 14, 15, 24]) {
    for (const width of [18, 34, 56, 76, 100, 120]) {
      const { picker, result } = fixture({ pointer: true, rows, management: managementOption() });
      const lines = picker.render(width);
      const budget = Math.max(7, Math.floor(rows * 0.8));
      assert.ok(lines.length <= budget, `${rows}x${width}: ${lines.length} rows exceeds ${budget}`);
      for (const line of lines)
        assert.ok(visibleWidth(line) <= width, `${rows}x${width}: ${JSON.stringify(line)}`);
      assert.match(stripTerminalSequences(lines.join("\n")), /Alt\+S/, `${rows}x${width}`);
      picker.handleInput("p");
      assert.deepEqual(
        result,
        [{ action: "settings" }],
        `the key still routes at ${rows}x${width}`,
      );
    }
  }
});

test("the management summary paints where it fits and never raises the height", () => {
  const many = Array.from({ length: 12 }, (_, index) => preset(`team-${index}`));
  // When the list is the constraint, the summary costs a list row, not a new row.
  const capped = fixture({ rows: 24, presets: many, management: managementOption() });
  const uncapped = fixture({ rows: 24, presets: many });
  const cappedText = painted(capped.picker, 76).join("\n");
  assert.match(cappedText, /controlled fixture · pending: none/);
  assert.equal(
    cappedText.split("\n").length,
    painted(uncapped.picker, 76).length,
    "a capped list spends a row on the summary instead of growing",
  );

  // At the full layout's minimum the summary is dropped, not squeezed in.
  const boundary = fixture({ rows: 17, management: managementOption() });
  const boundaryPlain = fixture({ rows: 17 });
  assert.equal(painted(boundary.picker, 76).length, painted(boundaryPlain.picker, 76).length);
  assert.doesNotMatch(painted(boundary.picker, 76).join("\n"), /controlled fixture/);
  assert.doesNotMatch(painted(boundary.picker, 76).join("\n"), /No presets available/);

  // One row past the boundary the summary fits, and it follows the callback's text.
  const fitted = fixture({
    rows: 18,
    management: managementOption({ summary: () => " presets: scope session · pending: 2 edits" }),
  });
  assert.match(painted(fitted.picker, 76).join("\n"), /scope session · pending: 2 edits/);

  // Compact layouts show it only in a spare row, never above their minimum.
  const spare = fixture({ rows: 14, management: managementOption() });
  assert.match(painted(spare.picker, 76).join("\n"), /controlled fixture · pending: none/);
  assert.ok(painted(spare.picker, 76).length <= Math.floor(14 * 0.8));
  const minimum = fixture({ rows: 8, management: managementOption() });
  const minimumPlain = fixture({ rows: 8 });
  assert.equal(painted(minimum.picker, 34).length, painted(minimumPlain.picker, 34).length);
  assert.doesNotMatch(painted(minimum.picker, 34).join("\n"), /controlled fixture/);

  // Empty or failing summaries cost nothing and never break a render.
  const empty = fixture({
    rows: 24,
    presets: many,
    management: managementOption({ summary: () => "  " }),
  });
  assert.equal(painted(empty.picker, 76).length, painted(uncapped.picker, 76).length);
  const broken = fixture({
    rows: 24,
    management: managementOption({
      summary() {
        throw new Error("SUMMARY_FAILED");
      },
    }),
  });
  assert.doesNotThrow(() => painted(broken.picker, 76));
  assert.doesNotMatch(painted(broken.picker, 76).join("\n"), /SUMMARY_FAILED/);
});

test("G/W save routes from either page carry only scope, never a highlighted preset", () => {
  for (const [key, scope] of [
    ["g", "global"],
    ["G", "global"],
    ["w", "workspace"],
    ["W", "workspace"],
  ]) {
    const h = fixture({ management: savingOption() });
    h.picker.handleInput("\u001b[B"); // inactive gamma is highlighted but never applied
    h.picker.handleInput(key);
    h.picker.handleInput("\r");
    assert.deepEqual(h.result, [{ action: "save-default", scope }]);
  }
  const off = fixture({ management: savingOption(), presets: [offPreset()], activeName: "off" });
  off.picker.handleInput("g");
  assert.deepEqual(
    off.result,
    [{ action: "save-default", scope: "global" }],
    "Off is also a savable live choice",
  );
  for (const [key, scope] of [
    ["g", "global"],
    ["w", "workspace"],
  ]) {
    const editing = fixture({ management: savingOption(), efforts: effortCaps });
    editing.picker.handleInput("e");
    editing.picker.handleInput("\u001b[C");
    assert.deepEqual(editing.applied.at(-1).effort_overrides, { d5: "inherit" });
    assert.match(painted(editing.picker).join("\n"), /Save as .* default/);
    editing.picker.handleInput(key);
    assert.deepEqual(editing.result, [{ action: "save-default", scope }]);
    assert.equal(editing.applied.length, 1, "saving never republishes the live choice");
  }
});

test("saving during a slider press cancels its preview without applying it", () => {
  const state = delegationState(),
    h = fixture({ delegation: state.option, pointer: true, rows: 40, management: savingOption() });
  const lines = painted(h.picker),
    y = lines.findIndex((line) => line.includes("Supervisor")),
    x = lines[y].indexOf("Supervisor");
  h.picker.handleMouse(mouse("press", x, y));
  assert.match(painted(h.picker).join("\n"), /preview/);
  h.picker.handleInput("g");
  h.picker.handleMouse(mouse("release", x, y));
  assert.deepEqual(state.sets, []);
  assert.deepEqual(h.result, [{ action: "save-default", scope: "global" }]);
});

test("global/project save labels remain painted, clickable and bounded at full, compact and minimum sizes", () => {
  for (const rows of [8, 10, 12, 14, 15, 24, 40])
    for (const width of [7, 8, 18, 34, 56, 76, 120]) {
      for (const withMode of [false, true])
        for (const trusted of [false, true]) {
          const measured = [],
            h = fixture({
              rows,
              pointer: true,
              management: savingOption(trusted),
              ...(withMode ? { delegation: delegationState().option } : {}),
              onRender: (height) => measured.push(height),
            });
          const lines = painted(h.picker, width);
          assert.equal(measured.at(-1), lines.length);
          assert(
            lines.length <= Math.max(7, Math.floor(rows * 0.8)),
            `${rows}x${width}: ${lines.length}`,
          );
          assert(lines.every((line) => visibleWidth(line) <= width));
          if (width < 8) {
            assert.deepEqual(lines, []);
            continue;
          }
          const y = lines.findIndex((line) => line.includes("G"));
          assert(y >= 0, `${rows}x${width}: global save remains discoverable\n${lines.join("\n")}`);
          h.picker.handleMouse(mouse("click", lines[y].indexOf("G"), y));
          assert.deepEqual(
            h.result,
            [{ action: "save-default", scope: "global" }],
            `${rows}x${width}: painted G routes`,
          );
          const project = fixture({
            rows,
            pointer: true,
            management: savingOption(trusted),
            ...(withMode ? { delegation: delegationState().option } : {}),
          });
          const projectLines = painted(project.picker, width),
            projectY = projectLines.findIndex((line) => line.includes("G") && line.includes("W"));
          assert(projectY >= 0);
          project.picker.handleMouse(mouse("click", projectLines[projectY].indexOf("W"), projectY));
          assert.deepEqual(
            project.result,
            trusted ? [{ action: "save-default", scope: "workspace" }] : [],
            `${rows}x${width}: painted W (mode=${withMode}, trusted=${trusted})`,
          );
          if (width >= 18 && Math.floor(rows * 0.8) >= 9 + (withMode ? 1 : 0))
            for (const slot of strengths) assert(lines.some((line) => line.includes(slot)));
        }
    }
  const normal = fixture({
    rows: 24,
    management: savingOption(),
    delegation: delegationState().option,
  });
  assert.match(
    painted(normal.picker).join("\n"),
    /\[G\] Save as global default · \[W\] Save as project default \(on exit\)/,
  );
});

test("workspace save is inert without trust or its host capability, including a changed trust projection", () => {
  const denied = fixture({ pointer: true, rows: 40, management: savingOption(false) });
  assert.match(painted(denied.picker).join("\n"), /trust required/);
  denied.picker.handleInput("w");
  denied.picker.handleInput("W");
  assert.deepEqual(denied.result, []);
  let trusted = true;
  const stale = fixture({
    pointer: true,
    management: managementOption({ saveDefaults: true, canSaveWorkspace: () => trusted }),
  });
  const lines = painted(stale.picker),
    y = lines.findIndex((line) => line.includes("[W]"));
  trusted = false;
  stale.picker.handleMouse(mouse("click", lines[y].indexOf("[W]"), y));
  stale.picker.handleInput("w");
  assert.deepEqual(stale.result, [], "a painted button cannot reuse stale trust");
  const legacy = fixture({ management: managementOption() }),
    plain = fixture({ management: managementOption() });
  legacy.picker.handleInput("g");
  legacy.picker.handleInput("w");
  assert.deepEqual(legacy.result, []);
  assert.deepEqual(
    painted(legacy.picker),
    painted(plain.picker),
    "hosts without save capability keep their layout",
  );
  const unknown = fixture({ management: managementOption({ saveDefaults: true }) });
  unknown.picker.handleInput("w");
  assert.deepEqual(unknown.result, [], "workspace needs an explicit true projection");
});

test("hosts without saving keep customized G/W navigation and confirmation bindings", () => {
  const customKeys = {
    matches(data, binding) {
      if (binding === "tui.select.down" && data === "g") return true;
      if (binding === "tui.select.confirm" && data === "w") return true;
      return keys.matches(data, binding);
    },
  };
  for (const management of [
    undefined,
    managementOption(),
    managementOption({ saveDefaults: false }),
  ]) {
    const h = fixture({ keybindings: customKeys, management });
    h.picker.handleInput("g");
    assert.equal(h.picker.selection(), "gamma");
    h.picker.handleInput("w");
    assert.deepEqual(h.result, ["gamma"]);
  }
});

for (const mode of ["fullscreen", "regular"])
  for (const accepted of [false, true]) {
    test(`inactive effort enable settles custom before native confirm and reopens cleanly (${mode}, ${accepted})`, async (t) => {
      const h = emptyOwnerPanels(t, mode, undefined, true);
      h.ctx.ui.confirm = (title, text) => {
        assert.equal(h.mounts[0].component.isOpen(), false);
        assert.equal(h.mounts[0].handle?.getBounds(), undefined);
        assert.equal(h.host.editorContainer.children[0], h.host.editor);
        return InteractiveMode.prototype.showExtensionConfirm.call(h.host, title, text);
      };
      h.panels.attachHost(h.ctx, h.bus);
      const opening = h.shortcuts.get("alt+s").handler();
      await tick();
      h.paint();
      h.tui.getFocusedComponent().handleInput("\u001b[B");
      h.tui.getFocusedComponent().handleInput("e");
      await tick();
      assert.equal(
        h.host.extensionDialogs.length,
        1,
        "the real native confirmation is the only inline dialog",
      );
      assert.equal(
        h.tui.getFocusedComponent(),
        h.host.extensionDialogs[0].component,
        "the real native confirmation owns focus",
      );
      assert.equal(h.router.current().name, "off");
      h.tui.getFocusedComponent().handleInput(accepted ? "\r" : "\u001b");
      await tick();
      if (!accepted) {
        await opening;
        assert.deepEqual(h.published, []);
        assert.equal(h.mounts.length, 1);
      } else {
        assert.equal(h.mounts.length, 2);
        assert.equal(
          h.host.extensionDialogs.length,
          mode === "regular" ? 1 : 0,
          "the confirmation is gone; only a reopened docked picker can remain",
        );
        assert.equal(h.tui.getFocusedComponent(), h.mounts[1].component);
        assert.match(
          h.mounts[1].component.render(76).map(stripTerminalSequences).join("\n"),
          /Effort · fixture-balanced/,
        );
        h.tui.getFocusedComponent().handleInput("\u001b[C");
        assert.deepEqual(h.router.current().effort_overrides, { d5: "inherit" });
        h.tui.getFocusedComponent().handleInput("\u001b"); // back, same component/focus
        assert.equal(h.tui.getFocusedComponent(), h.mounts[1].component);
        h.tui.getFocusedComponent().handleInput("\u001b");
        await opening;
        assert.deepEqual(h.published, ["fixture-balanced", "fixture-balanced"]);
      }
      assert.equal(h.tui.getFocusedComponent(), h.host.editor);
      assert.equal(h.tui.hasOverlay(), false);
    });
  }

for (const mode of ["fullscreen", "regular"])
  test(`G saving from the live effort page settles the actual SDK custom picker (${mode})`, async (t) => {
    let h;
    const saved = [];
    const management = {
      ...savingOption(),
      saveDefault: async (scope) => {
        assert.equal(h.mounts[0].handle?.getBounds(), undefined);
        assert.equal(h.host.editorContainer.children[0], h.host.editor);
        saved.push({ scope, selection: h.router.current() });
      },
    };
    h = emptyOwnerPanels(t, mode, management, true);
    h.router.select("fixture-balanced");
    h.panels.attachHost(h.ctx, h.bus);
    const opening = h.shortcuts.get("alt+s").handler();
    await tick();
    h.tui.getFocusedComponent().handleInput("e");
    h.tui.getFocusedComponent().handleInput("\u001b[C");
    assert.deepEqual(h.router.current().effort_overrides, { d5: "inherit" });
    h.tui.getFocusedComponent().handleInput("g");
    await opening;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].scope, "global");
    assert.deepEqual(saved[0].selection.effort_overrides, { d5: "inherit" });
    assert.deepEqual(h.published, ["fixture-balanced"], "saving is not a second live publication");
    assert.equal(h.tui.getFocusedComponent(), h.host.editor);
  });

test("real SDK G/W routes close the picker before saving, with no preset publication or automatic reopen", async (t) => {
  for (const mode of ["fullscreen", "regular"])
    for (const [key, scope] of [
      ["g", "global"],
      ["w", "workspace"],
    ]) {
      const calls = [],
        h = emptyOwnerPanels(t, mode, {
          summary: () => "Save: session",
          settings: async () => {},
          editPreset: async () => {},
          canSaveWorkspace: () => true,
          saveDefault: async (target) => {
            if (mode === "fullscreen")
              assert.equal(
                h.mounts[0].handle.getBounds(),
                undefined,
                "the overlay is already closed",
              );
            else
              assert.equal(
                h.host.editorContainer.children[0],
                h.host.editor,
                "the native editor is restored",
              );
            calls.push(target);
          },
        });
      h.panels.attachHost(h.ctx, h.bus);
      const opening = h.shortcuts.get("alt+s").handler();
      await tick();
      h.paint();
      h.mounts[0].component.handleInput("\u001b[B"); // highlight an inactive model; live remains Off
      h.mounts[0].component.handleInput(key);
      await opening;
      assert.deepEqual(calls, [scope]);
      assert.equal(h.router.current().name, "off");
      assert.deepEqual(h.published, []);
      assert.equal(h.mounts.length, 1);
      h.panels.dispose();
    }
});

test("through the real SDK the management routes settle the picker before the host dialog runs", async (t) => {
  for (const mode of ["fullscreen", "regular"]) {
    const calls = [],
      order = [];
    const h = emptyOwnerPanels(t, mode, {
      summary: () => " presets: controlled fixture · pending: none",
      settings: async () => {
        order.push(`settings:${h.mounts.length}`);
        calls.push("settings");
      },
      editPreset: async (name) => {
        order.push(`edit:${name ?? "new"}:${h.mounts.length}`);
        calls.push(name);
      },
      editModel: async (name, slot, position) => {
        order.push(
          `model:${name}:${slot}:${position === undefined ? "center" : JSON.stringify(position)}:${h.mounts.length}`,
        );
        calls.push(`model:${name}:${slot}`);
      },
    });
    h.panels.attachHost(h.ctx, h.bus);
    const opening = h.shortcuts.get("alt+s").handler();
    await tick();
    const mount = h.mounts[0];
    assert.equal(
      mount.options.overlay,
      mode === "fullscreen",
      `${mode}: the renderer rule is unchanged`,
    );
    assert.match(
      mount.component.render(76).map(stripTerminalSequences).join("\n"),
      /controlled fixture · pending: none/,
      `${mode}: the summary reaches the real picker`,
    );

    mount.component.handleInput("c"); // off is highlighted: no preset to edit
    assert.deepEqual(calls, [], `${mode}: off has no edit-preset route`);
    mount.component.handleInput("n");
    await opening;
    assert.deepEqual(calls, [undefined], `${mode}: create reaches editPreset(undefined)`);
    assert.equal(
      order[0],
      "edit:new:1",
      `${mode}: the dialog runs after the custom component settled, with no reopen`,
    );
    assert.deepEqual(h.published, [], `${mode}: a management route never publishes`);

    const cancel = h.shortcuts.get("alt+s").handler();
    await tick();
    h.mounts[1].component.handleInput("\u001bs");
    await cancel;
    assert.deepEqual(calls, [undefined], `${mode}: Esc still cancels without routing`);
    assert.equal(h.mounts.length, 2, `${mode}: no automatic reopen after cancel`);

    // A digit routes the highlighted preset's light slot through the real
    // SDK, with no position (the popover centers) and no panel reopen.
    const routed = h.shortcuts.get("alt+s").handler();
    await tick();
    h.mounts[2].component.handleInput("\u001b[B"); // highlight a model preset
    h.mounts[2].component.handleInput("1");
    await routed;
    assert.equal(
      calls.filter((entry) => typeof entry === "string" && entry.startsWith("model:")).length,
      1,
    );
    assert.match(
      order.at(-1),
      /^model:fixture-[a-z]+:d1:center:3$/,
      `${mode}: the slot route settled before its dialog`,
    );
    assert.equal(
      h.mounts.length,
      3,
      `${mode}: the model dialog is an independent route, no panel reopen`,
    );
    assert.deepEqual(h.published, []);
    h.panels.dispose();
  }
});

test(
  "direct preset editing owns the shared UI latch so a footer click cannot strand a newer picker",
  { timeout: 5000 },
  async (t) => {
    let controls;
    const h = emptyOwnerPanels(t, "fullscreen", {
      summary: () => "Save: session",
      settings: async () => controls.open(),
      editPreset: async (name) => controls.editPreset(name),
      cancelModelSelection: () => controls.cancelModelSelection(),
    });
    h.panels.attachHost(h.ctx, h.bus);
    const model = {
      provider: "fixture",
      id: "worker",
      name: "Worker",
      api: "fixture",
      reasoning: false,
    };
    Object.assign(h.ctx, {
      hasUI: true,
      scopedModels: [],
      modelRegistry: { getAll: () => [model] },
    });
    const runtime = {
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      getError: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
    };
    controls = new PreferencesControls({
      ctx: h.ctx,
      store: { scope: "session" },
      ready: () => true,
      beerMugs: { current: () => false, set() {} },
      router: () => h.router,
      delegation: () => ({}),
      createModelSelector: (options) => createPresetModelSelector({ ...options, runtime }),
      modelPopover: () => h.panels.isFullscreen(),
      modelSelectionAllowed: () => h.panels.modelSelectionAllowed(),
      beforeModelClose: () => h.bus.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {}),
      publishDefinition() {
        assert.fail("cancelled editor must not publish");
      },
    });
    t.after(() => controls.dispose());
    const editing = h.panels.withManagement(() => controls.editPreset("fixture-balanced"));
    await tick();
    h.paint();
    assert.equal(h.mounts.length, 1);
    const native = h.mounts[0];
    h.click();
    await tick();
    await h.shortcuts.get("alt+a").handler();
    assert.equal(
      h.mounts.length,
      1,
      "neither preset nor detail panels can mount over the direct editor",
    );
    const bounds = native.handle.getBounds();
    assert(bounds);
    const x = bounds.col + bounds.width - 4,
      y = bounds.row;
    for (const suffix of ["M", "m"])
      h.tui.handleMouseEvent(h.tui.parseSgrMouseEvent(`\u001b[<0;${x + 1};${y + 1}${suffix}`));
    await editing;
    await tick();
    h.paint();
    assert.equal(
      native.handle.getBounds(),
      undefined,
      "SDK done removes its own overlay, not a newer picker",
    );
    h.click();
    await tick();
    h.paint();
    assert.equal(h.mounts.length, 2, "the latch and picker state released after cancellation");
    let entered = false;
    await h.panels.withManagement(async () => {
      entered = true;
    });
    assert.equal(
      entered,
      false,
      "direct management cannot open over the already mounted picker either",
    );
    h.mounts[1].component.handleInput("\u001b");
    await tick();
    assert.deepEqual(h.published, []);
  },
);
