import {
  preset,
  offPreset,
  fixture,
  mouse,
  effortPreset,
  effortCaps,
  painted,
  clickText,
  descendingSlots,
  paintedSlots,
  delegationState,
  managementOption,
  savingOption,
} from "../support/preset-picker-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { strengths } from "../../dist/orchestration/routing.js";
import { workerSlotDisplayOrder } from "../../dist/orchestration/ui/preset-picker.js";

test("routing and effort rows paint hardest first without changing canonical or numeric slot identity", () => {
  assert.deepEqual(strengths, ["d1", "d2", "d3", "d4", "d5"]);
  assert.deepEqual(workerSlotDisplayOrder, descendingSlots);
  assert.notEqual(workerSlotDisplayOrder, strengths, "the view owns a detached order");
  for (const width of [18, 34, 76, 120]) {
    const h = fixture({ rows: 40, presets: [effortPreset()], efforts: effortCaps });
    assert.deepEqual(paintedSlots(painted(h.picker, width)), descendingSlots);
    h.picker.handleInput("e");
    assert.deepEqual(paintedSlots(painted(h.picker, width)), descendingSlots);
    assert(
      painted(h.picker, width).some((line) => line.includes("›‹d5:default")),
      "effort starts at d5",
    );
    h.picker.handleInput("\u001b[C");
    assert.deepEqual(h.applied.at(-1).effort_overrides, { d1: "high", d5: "inherit" });
    for (const slot of descendingSlots) {
      h.picker.handleInput(slot.slice(1));
      assert(
        painted(h.picker, width).some((line) => line.includes(`›‹${slot}:`)),
        `${slot} key selects its identity`,
      );
    }
  }
  for (const slot of descendingSlots) {
    const h = fixture({ rows: 40, pointer: true, management: managementOption({ models: true }) });
    const lines = painted(h.picker);
    assert.deepEqual(paintedSlots(lines), descendingSlots);
    const y = lines.findIndex((line) => new RegExp(`^│ ${slot}\\s`).test(line));
    assert(y > 0, lines.join("\n"));
    h.picker.handleMouse(mouse("click", lines[y].indexOf("provider/"), y));
    assert.deepEqual(
      h.result,
      [{ action: "edit-model", name: "beta", slot }],
      "mouse keeps painted slot identity",
    );
  }
  assert.deepEqual(
    strengths,
    ["d1", "d2", "d3", "d4", "d5"],
    "painting/editing never reverses the core tuple",
  );
});

test("seven-row slot windows follow descending Tab/arrows/wheel order and retain both endpoints on resize", () => {
  for (const width of [18, 34, 76]) {
    const h = fixture({ rows: 40, pointer: true, presets: [effortPreset()], efforts: effortCaps });
    // Row allowance is separate from the terminal's row count.
    h.picker.options.rows = () => 7;
    assert.deepEqual(paintedSlots(painted(h.picker, width)), ["d5", "d4", "d3"]);
    for (const [index, slot] of descendingSlots.entries()) {
      assert(painted(h.picker, width).some((line) => line.includes(`›${slot}`)));
      if (index < 4) h.picker.handleInput("\t");
    }
    assert.deepEqual(paintedSlots(painted(h.picker, width)), ["d3", "d2", "d1"]);
    h.picker.handleInput("\t");
    assert(
      painted(h.picker, width).some((line) => line.includes("›d5")),
      "Tab wraps to hardest",
    );
    h.picker.handleInput("\u001b[Z");
    assert(
      painted(h.picker, width).some((line) => line.includes("›d1")),
      "Shift+Tab wraps to easiest",
    );
    h.picker.handleInput("e");
    assert.deepEqual(paintedSlots(painted(h.picker, width)), ["d5", "d4", "d3"]);
    for (const slot of descendingSlots) {
      assert(painted(h.picker, width).some((line) => line.includes(`›‹${slot}:`)));
      h.picker.handleInput("\u001b[B");
    }
    assert(
      painted(h.picker, width).some((line) => line.includes("›‹d1:")),
      "Down clamps at the bottom",
    );
    assert.deepEqual(paintedSlots(painted(h.picker, width)), ["d3", "d2", "d1"]);
    h.picker.options.rows = () => 19;
    assert.deepEqual(paintedSlots(painted(h.picker, width)), descendingSlots);
    h.picker.options.rows = () => 7;
    h.picker.handleInput("\u001b[A");
    assert(painted(h.picker, width).some((line) => line.includes("›‹d2:")));
    h.picker.handleMouse(mouse("wheel", 4, 2, { wheelDelta: -1 }));
    assert(painted(h.picker, width).some((line) => line.includes("›‹d3:")));
    h.picker.handleInput("\t");
    assert(painted(h.picker, width).some((line) => line.includes("›‹d2:")));
    h.picker.handleInput("\u001b[Z");
    assert(painted(h.picker, width).some((line) => line.includes("›‹d3:")));
    h.picker.handleInput("5");
    h.picker.handleInput("\u001b[A");
    assert(
      painted(h.picker, width).some((line) => line.includes("›‹d5:")),
      "Up clamps at the top",
    );
    assert.deepEqual(h.applied, [], "selection and scrolling never edit effort");
  }
});

test("legacy hosts remain read-only, while arrows immediately publish immutable effort snapshots", () => {
  const selected = effortPreset();
  for (const extra of [{}, { efforts: effortCaps, setEffort: undefined }]) {
    const legacy = fixture({ presets: [selected], ...extra });
    legacy.picker.handleInput("e");
    assert.doesNotMatch(painted(legacy.picker).join("\n"), /Effort ·|R reset/);
    legacy.picker.handleInput("\r");
    assert.deepEqual(legacy.result, ["alpha"]);
  }
  const original = structuredClone(selected),
    edit = fixture({ presets: [selected], efforts: effortCaps });
  edit.picker.handleInput("e");
  edit.picker.handleInput("1");
  const text = painted(edit.picker).join("\n");
  assert.match(text, /New Agents only; main unchanged/);
  assert.match(text, /source: preset defaults \+ session overrides/);
  assert.match(text, /changes apply immediately/);
  assert.doesNotMatch(text, /Apply|unsaved|draft/);
  edit.picker.handleInput("\u001b[C"); // upper bound is a no-op
  assert.deepEqual(edit.applied, []);
  edit.picker.handleInput("\u001b[D");
  assert.deepEqual(edit.applied.at(-1).effort_overrides, { d1: "medium" });
  assert.match(painted(edit.picker).join("\n"), /d1:medium/);
  edit.picker.handleInput("\u001b"); // return, never undo
  assert.match(painted(edit.picker).join("\n"), /d1.*medium\*/);
  edit.picker.handleInput("e");
  edit.picker.handleInput("1");
  edit.picker.handleInput("\u001b[D");
  assert.deepEqual(edit.applied.at(-1).effort_overrides, { d1: "low" });
  edit.picker.handleInput("\r"); // Enter also returns, no extra publication
  assert.equal(edit.applied.length, 2);
  assert.deepEqual(edit.result, []);
  assert.match(painted(edit.picker).join("\n"), /Delegation/);
  assert.deepEqual(selected, original, "the supplied snapshot is never mutated");
});

test("pointer arrows and reset publish immediately; inactive editing is a confirm-only route", () => {
  const selected = effortPreset(),
    h = fixture({ pointer: true, presets: [selected], efforts: effortCaps });
  clickText(h.picker, "Edit effort");
  let lines = painted(h.picker),
    y = lines.findIndex((line) => line.includes("‹d1:high›"));
  h.picker.handleMouse(mouse("click", lines[y].indexOf("‹"), y));
  assert.deepEqual(h.applied.at(-1).effort_overrides, { d1: "medium" });
  clickText(h.picker, "R reset");
  assert.deepEqual(h.applied.at(-1).effort_overrides, {});
  lines = painted(h.picker);
  y = lines.findIndex((line) => line.includes("‹d1:default›"));
  h.picker.handleMouse(mouse("click", lines[y].indexOf("default"), y));
  assert.equal(h.applied.length, 2, "value/label clicks only select the slot");
  h.picker.handleMouse(mouse("click", lines[y].indexOf("›", lines[y].indexOf("‹")), y));
  assert.deepEqual(h.applied.at(-1).effort_overrides, { d1: "inherit" });
  clickText(h.picker, "R reset");
  assert.deepEqual(h.applied.at(-1).effort_overrides, {});
  clickText(h.picker, "Esc back");
  assert.deepEqual(h.result, []);
  assert.match(painted(h.picker).join("\n"), /Delegation/);
  clickText(h.picker, "Edit effort");
  const top = painted(h.picker)[0];
  h.picker.handleMouse(mouse("click", top.indexOf("×"), 0));
  assert.deepEqual(h.result, [null]);
  assert.equal(h.applied.length, 4, "closing never rolls back or republishes");
  for (const pointer of [false, true]) {
    const inactive = fixture({
      pointer,
      presets: [selected],
      activeName: "off",
      efforts: effortCaps,
    });
    if (pointer) clickText(inactive.picker, "Edit effort");
    else inactive.picker.handleInput("e");
    assert.deepEqual(inactive.result, [{ action: "edit-effort", name: "alpha" }]);
    assert.deepEqual(
      inactive.applied,
      [],
      "neither enable nor effort publication occurs before host consent",
    );
  }
});

test("effort row label, value, model and blank clicks select only; the painted arrows alone adjust", () => {
  const { picker, result, applied } = fixture({
    pointer: true,
    presets: [effortPreset()],
    activeName: "alpha",
    efforts: effortCaps,
  });
  picker.handleInput("e");
  picker.handleInput("3"); // select d3, then select d1 by mouse
  for (const target of ["d1", "high", "provider/alpha-light"]) {
    const lines = painted(picker);
    const y = lines.findIndex((line) => line.includes("‹d1:high›"));
    assert(y >= 0, lines.join("\n"));
    picker.handleMouse(mouse("click", lines[y].indexOf(target), y));
    assert.match(painted(picker)[y], /›‹d1:high›/, `${target} selects d1 without editing it`);
  }
  let lines = painted(picker);
  let y = lines.findIndex((line) => line.includes("‹d1:high›"));
  picker.handleMouse(mouse("click", 74, y)); // padding beyond the model
  assert.match(painted(picker)[y], /d1:high/);
  lines = painted(picker);
  y = lines.findIndex((line) => line.includes("‹d1:high›"));
  picker.handleMouse(mouse("click", lines[y].indexOf("‹"), y));
  assert.match(painted(picker)[y], /d1:medium/);
  lines = painted(picker);
  y = lines.findIndex((line) => line.includes("‹d1:medium›"));
  picker.handleMouse(mouse("click", lines[y].indexOf("›", lines[y].indexOf("‹")), y));
  assert.match(painted(picker)[y], /d1:high/);
  picker.handleInput("\r");
  assert.deepEqual(result, []);
  assert.deepEqual(
    applied.map((item) => item.effort_overrides),
    [{ d1: "medium" }, { d1: "high" }],
  );
});

test("clipped effort arrows never create invisible pointer controls at narrow widths", () => {
  for (const width of [8, 10, 12, 14, 18, 34]) {
    const { picker } = fixture({
      pointer: true,
      rows: 8,
      presets: [effortPreset()],
      efforts: effortCaps,
    });
    picker.handleInput("e");
    picker.handleInput("1");
    picker.handleInput("\u001b[D"); // medium; next arrow should return to high if visible
    const lines = painted(picker, width);
    const y = lines.findIndex((line) => line.includes("›‹d1"));
    assert(y > 0, lines.join("\n"));
    const prev = lines[y].indexOf("‹"),
      next = lines[y].indexOf("›", prev + 1);
    picker.handleMouse(mouse("click", width + 3, y)); // theoretical offscreen next arrow
    assert.match(painted(picker, 76).join("\n"), /‹d1:medium›/, `offscreen click at ${width}`);
    const narrow = painted(picker, width);
    picker.handleMouse(mouse("click", width - 1, y)); // right border, not an arrow
    assert.match(painted(picker, 76).join("\n"), /‹d1:medium›/, `border click at ${width}`);
    if (next < 0) {
      assert(!narrow[y].includes("›", prev + 1), `next is clipped at ${width}`);
    } else {
      painted(picker, width); // restore narrow pointer targets after wider inspection
      picker.handleMouse(mouse("click", next, y));
      assert.match(painted(picker, 76).join("\n"), /‹d1:high›/, `visible next arrow at ${width}`);
    }
  }
});

test("Off has no effort editor; Alt+S closes without undoing live changes", () => {
  const off = fixture({ presets: [offPreset()], activeName: "off", efforts: effortCaps });
  off.picker.handleInput("e");
  assert.doesNotMatch(painted(off.picker).join("\n"), /Apply & enable|R reset/);
  off.picker.handleInput("\r");
  assert.deepEqual(off.result, ["off"]);

  const cancelled = fixture({ presets: [effortPreset()], efforts: effortCaps });
  cancelled.picker.handleInput("e");
  cancelled.picker.handleInput("1");
  cancelled.picker.handleInput("\u001b[D");
  cancelled.picker.handleInput("\u001bs");
  assert.deepEqual(cancelled.result, [null]);
  assert.deepEqual(cancelled.applied.at(-1).effort_overrides, { d1: "medium" });
});

test("a stale editor paints as the list without mutating picker state; the next input settles it", () => {
  const f = fixture({ presets: [effortPreset()], efforts: effortCaps });
  f.picker.handleInput("e");
  assert.match(painted(f.picker).join("\n"), /R reset/);
  // Host rebase between paints: the edited selection becomes Off.
  f.picker.options.presets = [offPreset()];
  const renders = f.tui.renders;
  for (let paint = 0; paint < 2; paint++) {
    assert.doesNotMatch(painted(f.picker).join("\n"), /R reset/);
    assert.equal(f.picker.editing, true, "render never closes the editor");
    assert.equal(f.tui.renders, renders, "render never requests another render");
  }
  f.picker.handleInput("\u001b[B");
  assert.equal(f.picker.editing, false, "input settles the stale editor");
  assert.doesNotMatch(painted(f.picker).join("\n"), /R reset/);
});

test("default and explicit inherit remain distinct even when default is literal inherit", () => {
  const selected = effortPreset();
  const { picker, result, applied } = fixture({
    presets: [selected],
    activeName: "alpha",
    efforts: effortCaps,
  });
  picker.handleInput("e");
  picker.handleInput("3"); // d3 configured default inherit
  assert.match(painted(picker).join("\n"), /default: inherit · inherit → medium/);
  picker.handleInput("\u001b[C"); // publish explicit inherit, not deletion
  assert.match(painted(picker).join("\n"), /d3:inherit/);
  picker.handleInput("\r");
  assert.deepEqual(result, []);
  assert.deepEqual(applied.at(-1).effort_overrides, { d1: "high", d3: "inherit" });
});

test("fixed validation rejects live proposals while inheritance warnings remain advisory", () => {
  const selected = { ...effortPreset(), effort_overrides: { d1: "max", d3: "inherit" } };
  let unavailable = false;
  const caps = (_preset, slot) =>
    slot === "d1"
      ? { levels: ["low", "high"], inherited: "low" }
      : slot === "d3"
        ? { levels: ["off", "low", "high"], inheritError: "Parent thinking unavailable" }
        : unavailable
          ? { levels: [], error: "Missing model" }
          : { levels: ["low", "high"], inherited: "low" };
  const { picker, result, applied } = fixture({ presets: [selected], efforts: caps });
  picker.handleInput("e");
  assert.match(painted(picker).join("\n"), /Unsupported effort: max/);
  picker.handleInput("1");
  picker.handleInput("\u001b[D"); // invalid -> preset default high, immediately validated
  assert.deepEqual(applied.at(-1).effort_overrides, { d3: "inherit" });
  picker.handleInput("3");
  assert.match(painted(picker).join("\n"), /Parent thinking unavailable/);
  unavailable = true;
  picker.handleInput("\u001b[C"); // proposed fixed off is blocked by missing fixed d5 model
  assert.equal(applied.length, 1);
  assert.match(painted(picker).join("\n"), /Change not applied/);
  assert.match(painted(picker).join("\n"), /d3:inherit/);
  unavailable = false;
  picker.handleInput("\u001b[C");
  assert.deepEqual(applied.at(-1).effort_overrides, { d3: "off" });
  assert.deepEqual(result, []);
});

test("inherit warnings never block editing another slot, explicit inherit, or resetting to inherited defaults", () => {
  const inherited = Object.fromEntries(strengths.map((slot) => [slot, "inherit"]));
  for (const warning of [
    { levels: ["high"], inheritError: "Parent off is unsupported" },
    { levels: ["high"], inheritError: "Parent thinking unavailable" },
    { levels: [], error: "Missing model" },
    { levels: [], error: "Ambiguous model" },
  ]) {
    const selected = {
      ...preset("alpha"),
      effort: { ...inherited },
      effort_defaults: { ...inherited },
      effort_overrides: {},
    };
    const caps = (_preset, slot) =>
      slot === "d1" ? { levels: ["high"], inherited: "high" } : warning;
    const { picker, result, applied } = fixture({ presets: [selected], efforts: caps });
    picker.handleInput("e");
    picker.handleInput("1");
    picker.handleInput("\u001b[C"); // default -> explicit inherit
    picker.handleInput("\u001b[C"); // -> high
    const text = painted(picker, 120).join("\n");
    assert.match(text, /Inherit checked at spawn/);
    assert.doesNotMatch(text, /Change not applied/);
    assert.deepEqual(applied.at(-1).effort_overrides, { d1: "high" });
    picker.handleInput("\r");
    assert.deepEqual(result, []);

    const reset = fixture({
      presets: [{ ...selected, effort_overrides: { d3: "max" } }],
      efforts: caps,
    });
    reset.picker.handleInput("e");
    reset.picker.handleInput("r");
    assert.deepEqual(reset.applied.at(-1).effort_overrides, {});
    reset.picker.handleInput("\r");
    assert.deepEqual(reset.result, []);

    const explicit = fixture({ presets: [selected], efforts: caps });
    explicit.picker.handleInput("e");
    explicit.picker.handleInput("3");
    explicit.picker.handleInput("\u001b[C");
    assert.deepEqual(explicit.applied.at(-1).effort_overrides, { d3: "inherit" });
    explicit.picker.handleInput("\r");
    assert.deepEqual(explicit.result, []);
  }
});

for (const rejection of ["throw", "undefined"])
  test(`a ${rejection} host rejection never paints an uncommitted effort`, () => {
    const h = fixture({
      presets: [effortPreset()],
      efforts: effortCaps,
      setEffort: () => {
        if (rejection === "throw") throw new Error("AUDIT_REJECTED");
        return undefined;
      },
    });
    h.picker.handleInput("e");
    h.picker.handleInput("1");
    assert.doesNotThrow(() => h.picker.handleInput("\u001b[D"));
    const text = painted(h.picker).join("\n");
    assert.match(text, /d1:high/);
    assert.match(text, /Change not applied/);
    h.picker.handleInput("\u001b");
    assert.match(painted(h.picker).join("\n"), /d1.*high\*/);
    assert.deepEqual(h.applied, []);
  });

test("compact effort click targets use the exact visible short or long label, including saving", () => {
  for (const width of [28, 30, 34, 40, 47, 76, 120]) {
    const h = fixture({ pointer: true, rows: 8, presets: [effortPreset()], efforts: effortCaps });
    const lines = painted(h.picker, width),
      y = lines.length - 2;
    const label = width - 2 < 46 ? "E" : "Edit effort";
    const x = label === "E" ? lines[y].indexOf(" E") + 1 : lines[y].indexOf(label);
    assert(x > 0 && lines[y].slice(x, x + label.length) === label, lines.join("\n"));
    h.picker.handleMouse(mouse("click", x, y));
    assert.match(
      painted(h.picker, width).join("\n"),
      /Effort/,
      `${width}: painted ${label} opens the editor`,
    );
    assert.deepEqual(h.result, []);
    assert.deepEqual(h.applied, []);
  }
  for (const width of [24, 26, 27]) {
    const h = fixture({ pointer: true, rows: 8, presets: [effortPreset()], efforts: effortCaps });
    const lines = painted(h.picker, width),
      y = lines.length - 2;
    assert(!lines[y].includes(" E"), "the short E is wholly clipped");
    h.picker.handleMouse(mouse("click", 25, y)); // theoretical E column, not painted
    assert.match(painted(h.picker, width)[0], /Delegation/);
    assert.deepEqual(h.result, []);
  }
  for (const width of [18, 76, 120]) {
    const h = fixture({
      pointer: true,
      rows: 8,
      presets: [effortPreset()],
      efforts: effortCaps,
      management: savingOption(),
    });
    const lines = painted(h.picker, width),
      y = lines.length - 2,
      x = lines[y].indexOf(" · E") + 3;
    assert(x > 0 && lines[y][x] === "E", lines.join("\n"));
    h.picker.handleMouse(mouse("click", x, y));
    assert.match(painted(h.picker, width).join("\n"), /Effort/);
    assert.deepEqual(h.result, [], "effort entry is not a save route");
  }
});

test("compact controls restore mode and eagerness hints where they fit without displacing Tab", () => {
  for (const saving of [false, true])
    for (const edit of [false, true])
      for (const width of [76, 120]) {
        const h = fixture({
          rows: 8,
          presets: [effortPreset()],
          delegation: delegationState().option,
          ...(edit ? { efforts: effortCaps } : {}),
          ...(saving ? { management: savingOption() } : {}),
        });
        const lines = painted(h.picker, width),
          controls = lines.at(-2);
        assert.equal(lines.length, 7);
        assert(lines.every((line) => visibleWidth(line) <= width));
        assert.match(controls, /Tab/);
        assert.match(controls, /←→.*⇧←→/, `${width}, save=${saving}, edit=${edit}: ${controls}`);
        if (width === 120) assert.match(controls, /mode.*eagerness/);
        if (saving) assert(controls.includes("G") && controls.includes("W"));
      }
});

test("minimum-height effort editor keeps hidden-slot navigation visible with and without saving", () => {
  for (const save of [false, true])
    for (const width of [18, 34]) {
      const h = fixture({
        rows: 7,
        presets: [effortPreset()],
        efforts: effortCaps,
        ...(save ? { management: savingOption() } : {}),
      });
      h.picker.handleInput("e");
      for (const key of ["1", "5"]) {
        h.picker.handleInput(key);
        const lines = painted(h.picker, width),
          text = lines.join("\n");
        assert.equal(lines.length, 7);
        assert(lines.every((line) => visibleWidth(line) <= width));
        assert.match(text, /↑↓\/1–5/, `saving=${save}, width=${width}: ${text}`);
        assert.match(text, new RegExp(`‹d${key}:`));
        assert.equal(lines.filter((line) => /‹d[1-5]:/.test(line)).length, 3);
        if (save) assert(lines.some((line) => line.includes("G") && line.includes("W")));
      }
    }
});

test("compact/narrow editor keeps the selected slot editable, bounded paint and live controls", () => {
  for (const rows of [8, 10, 12, 24])
    for (const width of [18, 34, 76, 120]) {
      const { picker, result, applied } = fixture({
        pointer: true,
        rows,
        presets: [effortPreset()],
        activeName: "alpha",
        efforts: effortCaps,
      });
      picker.handleInput("e");
      picker.handleInput("1");
      let lines = painted(picker, width);
      assert(lines.length <= Math.max(7, Math.floor(rows * 0.8)), `${rows}x${width}`);
      assert(
        lines.every((line) => visibleWidth(line) <= width),
        `${rows}x${width}: ${lines.join("\n")}`,
      );
      assert.match(lines.join("\n"), /d1:high/);
      assert.doesNotMatch(lines.join("\n"), /Apply|unsaved/);
      const value = lines.findIndex((line) => line.includes("‹d1:high›"));
      assert(value > 0, lines.join("\n"));
      picker.handleMouse(mouse("click", lines[value].indexOf("‹"), value));
      lines = painted(picker, width);
      assert.match(lines.join("\n"), /d1:medium/);
      assert.deepEqual(applied.at(-1).effort_overrides, { d1: "medium" });
      picker.handleInput("\u001b");
      assert.deepEqual(result, []);
    }
});

test("all five effort slots edit independently and Reset removes even the fifth override", () => {
  const selected = {
    ...preset("alpha"),
    effort_defaults: Object.fromEntries(strengths.map((slot) => [slot, "inherit"])),
    effort_overrides: {},
  };
  const h = fixture({
    presets: [selected],
    efforts: () => ({ levels: ["off", "low"], inherited: "low" }),
  });
  h.picker.handleInput("e");
  for (const [index, slot] of strengths.entries()) {
    h.picker.handleInput(String(index + 1));
    assert(painted(h.picker).some((line) => line.includes(`›‹${slot}:default›`)));
    h.picker.handleInput("\u001b[C"); // explicit inherit
    h.picker.handleInput("\u001b[C"); // fixed off, independently of same-model peers
    assert.deepEqual(
      h.applied.at(-1).effort_overrides,
      Object.fromEntries(strengths.slice(0, index + 1).map((key) => [key, "off"])),
    );
  }
  assert.equal(h.applied.length, 10);
  h.picker.handleInput("r");
  assert.deepEqual(h.applied.at(-1).effort_overrides, {});
  assert.equal(h.applied.length, 11);
});

test("slot rows show the auto-preview effective level and no config map", () => {
  const resolved = fixture({
    presets: [effortPreset("alpha")],
    activeName: "alpha",
    efforts: effortCaps,
  });
  const lines = painted(resolved.picker, 76);
  const light = lines.find((line) => line.includes("provider/alpha-light"));
  const standard = lines.find((line) => line.includes("provider/alpha-standard"));
  const strong = lines.find((line) => line.includes("provider/alpha-strong"));
  assert.match(light, /high\*/, "a fixed policy keeps its raw value and session star");
  assert.match(standard, /medium/, "inherit resolves through the live capabilities");
  assert.match(strong, /[^a-z]low[^a-z]*│?/, "a supported fixed level shows as-is");
  assert.doesNotMatch(lines.join("\n"), /think |→/, "auto-preview prints no config map");
  assert(!lines.some((line) => line.includes("minimal")), "other levels never leak into the row");

  // A fixed level the live metadata does not support: raw value, marked, never clamped.
  const unsupported = fixture({
    presets: [effortPreset("alpha")],
    activeName: "alpha",
    efforts: (_preset, slot) =>
      slot === "d1"
        ? { levels: ["off", "low", "medium"], inherited: "medium" }
        : effortCaps(_preset, slot),
  });
  assert.match(
    painted(unsupported.picker, 76).find((line) => line.includes("provider/alpha-light")),
    /high!/,
  );

  // An inherit that cannot resolve says unavailable; no level is invented.
  const unavailable = fixture({
    presets: [effortPreset("alpha")],
    activeName: "alpha",
    efforts: (_preset, slot) =>
      slot === "d3"
        ? { levels: ["off", "low"], inheritError: "Parent thinking unavailable" }
        : effortCaps(_preset, slot),
  });
  assert.match(
    painted(unavailable.picker, 76).find((line) => line.includes("provider/alpha-standard")),
    /unavailable/,
  );

  // Legacy read-only hosts keep their configured policy instead of inventing a resolution.
  const legacy = fixture({ presets: [effortPreset("alpha")], activeName: "alpha" });
  const legacyLines = painted(legacy.picker, 76);
  assert.match(
    legacyLines.find((line) => line.includes("provider/alpha-standard")),
    /inherit/,
  );
  assert.doesNotMatch(
    legacyLines.find((line) => line.includes("provider/alpha-light")),
    /!|unavailable/,
  );
});
