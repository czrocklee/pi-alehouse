import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { PresetPicker } = await jiti.import("../../src/orchestration/ui/preset-picker.ts");

/** Direct-source coverage for the btop-like inline shortcut hints on the
 * delegation picker and effort editor. The shared helper owns the styling
 * rule; these tests pin the painted labels, their ANSI emphasis and the
 * click geometry derived from the stripped plain row. */

const theme = {
  fg: (color, text) =>
    `\x1b[${color === "muted" ? 90 : color === "dim" ? 2 : color === "accent" ? 36 : 39}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  bg: (_color, text) => text,
};
const hot = (char) => `\x1b[36m\x1b[1m${char}\x1b[22m\x1b[39m`;
const plain = (lines) => lines.map(stripTerminalSequences);

const models = {
  d1: "fixture/d1",
  d2: "fixture/d2",
  d3: "fixture/d3",
  d4: "fixture/d4",
  d5: "fixture/d5",
};
const team = (effort_overrides = {}) => ({
  name: "team",
  version: "v1",
  models,
  ...(Object.keys(effort_overrides).length ? { effort_overrides } : {}),
});

function pickerView(t, extra = {}) {
  const result = [];
  const presets = extra.presets ?? [team()];
  const tui = {
    terminal: { columns: 100, rows: 40 },
    requestRender: () => {},
  };
  const view = new PresetPicker({
    tui,
    theme,
    presets,
    activeName: "team",
    pointer: true,
    keybindings: { matches: () => false },
    done: (value) => result.push(value),
    management: {
      summary: () => "presets: fixture",
      settings: true,
      presets: true,
      models: true,
      saveDefaults: true,
      canSaveWorkspace: () => true,
    },
    ...extra,
  });
  t.after(() => view.dispose());
  return { view, result, tui };
}

function clickLine(view, line, label, width = 100) {
  const at = line.indexOf(label);
  assert.ok(at >= 0, `missing ${label} in ${JSON.stringify(line)}`);
  const x = visibleWidth(line.slice(0, at));
  const y = plain(view.render(width)).indexOf(line);
  assert.ok(y >= 0, `missing painted row ${JSON.stringify(line)}`);
  view.handleMouse({ type: "click", button: "left", x, y });
}

test("save controls inline both scope mnemonics, never brackets", (t) => {
  const { view } = pickerView(t);
  const lines = view.render(100);
  const rows = plain(lines);
  const save = rows.find((line) => line.includes("Save as global default"));
  assert.ok(save, rows.join("\n"));
  assert.ok(
    save.includes("Save: Save as global default · Save as workspace default (on exit)"),
    "both mnemonics sit inside their own words, with no W prefix",
  );
  assert.ok(!rows.join("\n").includes("[G]"), "no bracket keycap");
  assert.ok(!rows.join("\n").includes("[W]"), "no bracket keycap");
  const styled = lines[rows.indexOf(save)];
  assert.ok(styled.includes(`\x1b[2mSave as \x1b[39m${hot("g")}`), "body dim, mnemonic accented");
  assert.ok(
    styled.includes(`${hot("w")}\x1b[2morkspace default\x1b[39m`),
    "workspace's own w is the inline key",
  );
});

test("an untrusted workspace save label omits the disabled w mnemonic", (t) => {
  const { view } = pickerView(t, {
    management: {
      summary: () => "presets: fixture",
      settings: true,
      presets: true,
      models: true,
      saveDefaults: true,
      canSaveWorkspace: () => false,
    },
  });
  const lines = view.render(100);
  const rows = plain(lines);
  const save = rows.find((line) => line.includes("Save as global default"));
  assert.ok(save, rows.join("\n"));
  assert.ok(save.includes("Workspace default (trust required)"), "trust text stays");
  assert.ok(!save.includes("W Workspace"), "no W prefix for a disabled action");
  assert.ok(!lines[rows.indexOf(save)].includes(hot("w")), "no accented w key");
});

test("explicit key legends are accented while their labels stay dim", (t) => {
  const { view } = pickerView(t);
  const lines = view.render(100);
  const rows = plain(lines);
  const control = rows.find((line) => line.includes("Alt+S close"));
  assert.ok(control, rows.join("\n"));
  const styled = lines[rows.indexOf(control)];
  for (const token of ["Alt+S", "↑↓", "Enter", "Esc"])
    assert.ok(styled.includes(hot(token)), token);
  assert.ok(styled.includes("\x1b[2mclose\x1b[39m"), "label body stays dim");
  assert.ok(styled.includes("\x1b[2mnavigate\x1b[39m"), "arrow label stays dim");
});

test("management labels highlight the mnemonic and keep explicit unmatched keys", (t) => {
  const { view } = pickerView(t);
  const lines = view.render(100);
  const rows = plain(lines);
  const control = rows.find((line) => line.includes("P Settings"));
  assert.ok(control, rows.join("\n"));
  assert.match(control, /P Settings · New · C Edit/);
  assert.ok(!control.includes("N New"), "the inline N is not repeated as a prefix");
  const styled = lines[rows.indexOf(control)];
  assert.ok(styled.includes(`${hot("P")} \x1b[2mSettings\x1b[39m`), "explicit P");
  assert.ok(styled.includes(`${hot("N")}\x1b[2mew\x1b[39m`), "inline N");
  assert.ok(styled.includes(`${hot("C")} \x1b[2mEdit\x1b[39m`), "explicit C");
});

test("painted management labels are the click targets", (t) => {
  for (const [label, expected] of [
    ["P Settings", { action: "settings" }],
    ["New", { action: "create-preset" }],
    ["C Edit", { action: "edit-preset", name: "team" }],
  ]) {
    const { view, result } = pickerView(t);
    const line = plain(view.render(100)).find((row) => row.includes(label));
    assert.ok(line, `missing ${label}`);
    clickLine(view, line, label);
    assert.deepEqual(result, [expected], label);
  }
});

test("painted save labels and their explicit keys are the click targets", (t) => {
  for (const [label, expected] of [
    ["Save as global default", { action: "save-default", scope: "global" }],
    ["Save as workspace default", { action: "save-default", scope: "workspace" }],
  ]) {
    const { view, result } = pickerView(t);
    const line = plain(view.render(100)).find((row) => row.includes(label));
    assert.ok(line, `missing ${label}`);
    clickLine(view, line, label);
    assert.deepEqual(result, [expected], label);
  }
});

test("narrow save rows keep whole G/W targets and never paint a partial keycap", (t) => {
  for (const width of [12, 16, 22]) {
    for (const [key, scope] of [
      ["G", "global"],
      ["W", "workspace"],
    ]) {
      const { view, result } = pickerView(t);
      const lines = view.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
      assert.ok(!plain(lines).join("\n").includes("["), `width ${width} has no brackets`);
      const line = plain(lines).find((row) => row.includes("G") && row.includes("W"));
      assert.ok(line, `width ${width} keeps G/W painted`);
      clickLine(view, line, key, width);
      assert.deepEqual(result, [{ action: "save-default", scope }], `${width}: ${key}`);
    }
  }
});

test("short delegation pickers budget the save row for the painted effort and mode hints", (t) => {
  for (const rows of [10, 12]) {
    for (const width of [47, 48, 56, 72, 76, 90]) {
      const { view, tui } = pickerView(t, {
        delegation: {
          current: () => ({ mode: "co-worker", eagerness: "balanced" }),
          guideline: () => "",
          set() {},
        },
        efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
        setEffort: (_name, next) => team(next),
      });
      Object.assign(tui.terminal, { columns: width, rows });
      const painted = view.render(width);
      const save = plain(painted).find((line) => /(?:\bglobal\b|\bG\b).*\bTab\b/i.test(line));
      const label = width < 48 ? "E" : "Edit effort";
      const where = `${width}×${rows}: ${plain(painted).join("\n")}`;
      assert.ok(save, where);
      assert.match(save, /Tab · ←→(?: mode ·)? ⇧←→/, where);
      assert.ok(save.includes(` · ${label}`), where);
      assert.ok(
        painted.every((line) => visibleWidth(line) <= width),
        where,
      );
      assert.ok(painted.length <= Math.floor(rows * 0.8), where);
      clickLine(view, save, label, width);
      assert.ok(
        plain(view.render(width)).some((line) => line.includes("Effort · team")),
        where,
      );
    }
  }
});

test("a very narrow untrusted picker keeps the global save key without advertising W", (t) => {
  for (const width of [8, 10]) {
    const { view, result, tui } = pickerView(t, {
      management: { saveDefaults: true, canSaveWorkspace: () => false },
    });
    tui.terminal.columns = width;
    const lines = view.render(width);
    const save = plain(lines).find((line) => /^│ G +│$/.test(line));
    assert.ok(save, `${width}: ${plain(lines).join("\n")}`);
    const styled = lines[plain(lines).indexOf(save)];
    assert.ok(styled.includes(hot("G")));
    assert.ok(!styled.includes(hot("W")));
    clickLine(view, save, "G", width);
    assert.deepEqual(result, [{ action: "save-default", scope: "global" }]);
  }
});

test("effort editor paints reset inline and keeps Esc explicit", (t) => {
  const overrides = { d5: "high" };
  const calls = [];
  const { view } = pickerView(t, {
    presets: [team(overrides)],
    efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
    setEffort: (_name, next) => {
      calls.push(next);
      return team(next);
    },
    startInEffort: true,
  });
  const lines = view.render(100);
  const rows = plain(lines);
  const control = rows.find((line) => line.includes("reset · Enter/Esc back"));
  assert.ok(control, rows.join("\n"));
  assert.ok(!control.includes("R reset"), "the R is not repeated as a prefix");
  const styled = lines[rows.indexOf(control)];
  assert.ok(styled.includes(`${hot("r")}\x1b[2meset\x1b[39m`), "inline reset mnemonic");
  assert.ok(styled.includes(`${hot("Esc")} \x1b[2mback\x1b[39m`), "explicit Esc stays shown");
  clickLine(view, control, "reset");
  assert.deepEqual(calls, [{}], "clicking the painted reset word clears overrides");
});

test("effort editor keeps Esc back clickable at the wide and narrow layouts", (t) => {
  for (const width of [100, 60, 22, 12]) {
    const { view } = pickerView(t, {
      efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
      setEffort: (_name, next) => team(next),
      startInEffort: true,
    });
    const lines = view.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}`,
    );
    const rows = plain(lines);
    const control = rows.find((line) => line.includes("Esc"));
    assert.ok(control, `width ${width} keeps an Esc hint`);
    clickLine(view, control, "Esc", width);
    assert.ok(
      !plain(view.render(width)).some((line) => line.includes("‹d5")),
      `width ${width} returns to the list`,
    );
  }
});

test("a no-management effort editor keeps key-only R and Esc at the width floor", (t) => {
  // Without save controls the compact footer keeps both controls: the full
  // `reset` word would crowd out `Esc`, so each stays a helper-styled key.
  for (const width of [8, 10]) {
    const calls = [];
    const { view } = pickerView(t, {
      management: undefined,
      presets: [team({ d5: "high" })],
      efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
      setEffort: (_name, next) => {
        calls.push(next);
        return team(next);
      },
      startInEffort: true,
    });
    const lines = view.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}: ${lines.join("\n")}`,
    );
    const rows = plain(lines);
    const control = rows.find((line) => /\bR\b/.test(line) && line.includes("Esc"));
    assert.ok(control, `width ${width}: ${rows.join("\n")}`);
    assert.match(control, / R Esc/, `width ${width}: key-only R and Esc`);
    assert.ok(!control.includes("reset"), `width ${width}: no crowded full word`);
    const styled = lines[rows.indexOf(control)];
    // Both keys are helper-styled: accented and bold, never raw dim text.
    assert.ok(styled.includes(hot("R")), `width ${width}: R keeps helper styling`);
    assert.ok(styled.includes(hot("Esc")), `width ${width}: Esc keeps helper styling`);
    // The painted cells remain real targets.
    clickLine(view, control, "R", width);
    assert.deepEqual(calls, [{}], `width ${width}: clicking R clears overrides`);
    const back = plain(view.render(width)).find((line) => line.includes("Esc"));
    assert.ok(back, `width ${width}: Esc stays painted after reset`);
    clickLine(view, back, "Esc", width);
    assert.ok(
      !plain(view.render(width)).some((line) => line.includes("‹d5")),
      `width ${width}: clicking Esc returns to the list`,
    );
  }
});

test("every painted row stays inside the viewport at the floor and around it", (t) => {
  for (const width of [8, 12, 16, 22, 30, 46, 60, 80, 100]) {
    const { view } = pickerView(t);
    const lines = view.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `list width ${width}`,
    );
    assert.ok(!plain(lines).join("\n").includes("[G]"), `list width ${width} brackets`);
    const effort = pickerView(t, {
      efforts: () => ({ levels: ["off", "high"], inherited: "off" }),
      setEffort: (_name, next) => team(next),
      startInEffort: true,
    });
    const effortLines = effort.view.render(width);
    assert.ok(
      effortLines.every((line) => visibleWidth(line) <= width),
      `effort width ${width}`,
    );
    assert.ok(!plain(effortLines).join("\n").includes("[G]"), `effort width ${width} brackets`);
  }
});
