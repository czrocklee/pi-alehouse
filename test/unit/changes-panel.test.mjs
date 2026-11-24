import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  stripTerminalSequences,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

// Cover the current source and keep the mounted panels and chrome in one module graph.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { changesMinRows, ChangesPanel } = await jiti.import(
  "../../src/orchestration/ui/changes-panel.ts",
);
const { PanelCoordinator } = await jiti.import("../../src/orchestration/ui/panel-coordinator.ts");
const { ChildActivityRegistry } = await jiti.import(
  "../../src/orchestration/runtime/activity-observer.ts",
);
const { joinPopoverStack, stackedOverlayOptions } = await jiti.import(
  "../../src/shared/popover-stack.mjs",
);
const { popoverChromeCloseHit } = await jiti.import("../../src/shared/popover-chrome.mjs");

const theme = { fg: (_color, text) => text, bold: (text) => text };
const keybindings = getKeybindings();
const empty = { groups: [], truncated: false, workspaceHints: 0 };
const ESC = "\x1b",
  ENTER = "\r",
  DOWN = "\x1b[B",
  PAGE_DOWN = "\x1b[6~",
  PAGE_UP = "\x1b[5~";
const add = (text, line = 1) => ({ kind: "add", line, text });
const remove = (text, line = 1) => ({ kind: "remove", line, text });
const edit = (lines, extra = {}) => ({
  kind: "edit",
  lines,
  added: lines.filter((line) => line.kind === "add").length,
  removed: lines.filter((line) => line.kind === "remove").length,
  truncated: false,
  redacted: false,
  ...extra,
});
const unavailable = (reason) => ({ kind: "unavailable", reason });
const report = (patch, fields = {}) => ({
  attempt: {
    agentId: "alpha",
    agentLabel: "otter",
    tool: "edit",
    outcome: patch ? "reported-success" : "unknown",
    ...fields,
  },
  ...(patch ? { patch } : {}),
});
const netOf = (patch) => {
  if (patch?.kind !== "edit") return patch ?? unavailable("incomplete");
  const { kind, lines, added, removed } = patch;
  return { kind, lines, added, removed };
};
const file = (path, patch) => ({
  path,
  net: netOf(patch),
  reports: [report(patch, { tool: patch?.reason === "write-no-before" ? "write" : "edit" })],
});
const reverted = {
  path: "src/reverted.ts",
  net: { kind: "unchanged" },
  reports: [
    report(edit([remove("before"), add("temporary")])),
    report(edit([remove("temporary"), add("before")]), { agentId: "beta", agentLabel: "hare" }),
  ],
};
const reports = {
  groups: [
    {
      path: "src/common.ts",
      net: netOf(
        edit([remove("const greeting = 'hello';", 7), add("const greeting = 'bonjour';", 7)]),
      ),
      reports: [
        report(edit([remove("const greeting = 'hello';", 7), add("intermediate", 7)])),
        report(edit([remove("intermediate", 7), add("const greeting = 'bonjour';", 7)])),
      ],
    },
    reverted,
    file("src/second.ts", unavailable("write-no-before")),
  ],
  truncated: false,
  workspaceHints: 0,
};
const renderText = (component, width = 100) =>
  stripTerminalSequences(component.render(width).join("\n"));
const terminal = (rows = 40) => ({ terminal: { rows, columns: 100 }, requestRender() {} });
const mouse = (type, x, y, extra = {}) => ({ type, button: "left", x, y, ...extra });

function panel(
  t,
  snapshot,
  { tui = terminal(), floating = false, paintTheme = theme, reset } = {},
) {
  let position = 0,
    closed = 0;
  const component = new ChangesPanel({
    tui,
    theme: paintTheme,
    keybindings,
    snapshot,
    reset,
    placement: floating
      ? { rows: () => tui.terminal.rows, position: () => `${position}`, measure() {} }
      : undefined,
    close() {
      closed++;
    },
  });
  t.after(() => component.dispose());
  return { component, translate: () => position++, closes: () => closed };
}

test("Changes defaults to the net file list and Escape unwinds one level", (t) => {
  const styled = [];
  const h = panel(t, reports, {
    paintTheme: {
      ...theme,
      fg: (color, text) => {
        styled.push([color, text]);
        return text;
      },
    },
  });
  const { component } = h;
  assert.match(
    renderText(component),
    /\[Net\] History \[H\][^\n]*2 files · Observed edits, not disk/,
  );
  assert.match(renderText(component), /› src\/common\.ts {2}\+1 −1/);
  assert.match(renderText(component), /src\/second\.ts {2}Unknown/);
  assert.doesNotMatch(renderText(component), /greeting|otter|reverted/);
  component.handleInput(ENTER);
  const diff = renderText(component);
  assert.match(diff, /Net since first observed edit · \+1 −1 · not a disk diff/);
  assert.match(diff, /− 7 │ const greeting = 'hello';\n\+ 7 │ const greeting = 'bonjour';/);
  assert.doesNotMatch(diff, /otter|intermediate/);
  assert(styled.some(([color, text]) => color === "toolDiffAdded" && text.includes("bonjour")));
  assert(styled.some(([color, text]) => color === "toolDiffRemoved" && text.includes("hello")));
  component.handleInput(ESC);
  assert.equal(h.closes(), 0);
  assert.match(renderText(component), /› src\/common\.ts/);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  assert.match(renderText(component), /Net diff unknown\.\nA write has no captured before text\./);
  component.handleInput(ESC);
  assert.match(renderText(component), /› src\/second\.ts/);
  component.handleInput(ESC);
  assert.equal(h.closes(), 1);
});

test("Reset is available only when painted and drops the expanded History snapshot in place", (t) => {
  let resets = 0;
  let availabilityReads = 0;
  const { component, closes } = panel(
    t,
    { ...reports, truncated: true },
    {
      reset: {
        available() {
          availabilityReads++;
          return true;
        },
        run() {
          resets++;
          return true;
        },
      },
    },
  );
  component.handleInput("R");
  const narrow = component.render(11);
  assert.match(narrow[0], /Enlarge/);
  assert.equal(component.render(11), narrow);
  const compact = component.render(14);
  assert.doesNotMatch(compact.join("\n"), /Reset/);
  assert.equal(component.render(14), compact);
  component.handleInput("R");
  assert.equal(resets, 0);
  assert.equal(availabilityReads, 0, "a frame too narrow for Reset never asks about availability");
  assert.match(renderText(component), /Reset \[R\]/);
  component.handleInput(DOWN);
  component.handleInput("h");
  component.handleInput("a");
  const expanded = renderText(component);
  assert.match(expanded, /All files[\s\S]*Partial list[\s\S]*intermediate/);
  component.handleInput("R");
  const cleared = renderText(component);
  assert.match(cleared, /\[Net\] History[\s\S]*No retained net changes/);
  assert.doesNotMatch(cleared, /All files|Partial list|common\.ts|intermediate|Reset/);
  component.handleInput("r");
  assert.equal(resets, 1);
  component.handleInput("h");
  assert.match(renderText(component), /No retained edit\/write reports/);
  component.handleInput(ESC);
  assert.equal(closes(), 1, "the reset left the popup open at its empty list");
});

test("Reset is available for a coverage gap without any file rows", (t) => {
  const { component } = panel(
    t,
    { ...empty, truncated: true },
    { reset: { available: () => true, run: () => true } },
  );
  assert.match(renderText(component), /Partial list[\s\S]*Reset \[R\]/);
  component.handleInput("r");
  assert.doesNotMatch(renderText(component), /Partial list|Reset/);
});

test("a painted Reset click is inert if availability changes before release", (t) => {
  let available = true;
  const { component } = panel(t, reports, {
    floating: true,
    reset: {
      available: () => available,
      run: () => assert.fail("stale Reset click reached the command"),
    },
  });
  const lines = renderText(component, 76).split("\n");
  const y = lines.findIndex((line) => /Reset \[R\]/.test(line));
  assert(y >= 0);
  const x = visibleWidth(lines[y].split("Reset")[0]);
  assert.equal(component.handleMouse(mouse("press", x, y))?.handled, true);
  available = false;
  component.handleMouse(mouse("click", x, y));
  const inspection = renderText(component, 76);
  assert.doesNotMatch(inspection, /Reset/);
  assert.match(inspection, /src\/common\.ts/);
  available = true;
  assert.match(renderText(component, 76), /Reset \[R\]/);
  component.handleMouse(mouse("press", x - 1, y)); // Separator, not Reset.
  component.handleMouse(mouse("click", x, y));
  assert.match(renderText(component, 76), /src\/common\.ts/);
});

test("a stale Reset refreshes even an identical projection and requires a distinct next key", (t) => {
  const expectedSnapshots = [];
  let live = { ...reports };
  const { component } = panel(t, reports, {
    reset: {
      available: () => true,
      run(expected) {
        expectedSnapshots.push(expected);
        return expected === live ? true : live;
      },
    },
  });
  const width = 34;
  const first = live;
  component.render(width);
  component.handleInput(DOWN);
  component.handleInput("h");
  component.handleInput(ENTER);
  const old = component.render(width);
  assert.match(old.join("\n"), /Reset \[R\]/);
  component.handleInput("r");
  component.handleInput("Y"); // A new snapshot must paint before it can be reset.
  const refreshed = component.render(width);
  assert.match(refreshed.join("\n"), /\[History\].*Updated/);
  assert.match(refreshed.join("\n"), /› src\/second\.ts/);
  assert.match(refreshed.join("\n"), /Esc close · Reset \[Y\]/);
  assert.match(old.join("\n"), /Reset \[R\]/, "the old render array is not mutated");
  assert.equal(component.render(width), refreshed);
  for (const input of ["r", "R", "\x1b[121;1:2u", "\x1b[121;1:3u"]) {
    component.handleInput(input);
  }
  assert.equal(expectedSnapshots.length, 1, "held R and tagged repeat/release cannot clear");
  assert.equal(expectedSnapshots[0], reports);

  live = { ...reports, groups: [...reports.groups, file("new.txt")] };
  component.handleInput("y");
  assert.equal(expectedSnapshots[1], first);
  assert.match(renderText(component, width), /new\.txt[\s\S]*Reset \[R\]/);
  component.handleInput("y");
  assert.equal(expectedSnapshots.length, 2, "a held retry key cannot clear a second refresh");
  component.handleInput("R");
  assert.equal(expectedSnapshots[2], live);
  assert.match(renderText(component, width), /No retained net changes/);
  assert.doesNotMatch(renderText(component, width), /Updated|Reset/);
});

test("a stale pointer Reset refreshes on click and requires a fresh single gesture", (t) => {
  const expectedSnapshots = [];
  let live = reports;
  const { component } = panel(t, reports, {
    floating: true,
    reset: {
      available: () => true,
      run(expected) {
        expectedSnapshots.push(expected);
        return expected === live ? true : live;
      },
    },
  });
  const findReset = () => {
    const lines = renderText(component, 76).split("\n");
    const y = lines.findIndex((line) => line.includes("Reset ["));
    assert(y >= 0);
    return [visibleWidth(lines[y].split("Reset")[0]), y];
  };
  const start = findReset();
  const painted = component.render(76);
  component.handleMouse(mouse("press", ...start));
  live = { ...reports, groups: [file("new.txt")] };
  assert.equal(component.render(76), painted, "painting never rereads the live snapshot");
  component.handleMouse(mouse("release", ...start));
  assert.equal(expectedSnapshots.length, 0, "the release alone does not activate Reset");
  component.handleMouse(mouse("click", ...start));
  assert.equal(expectedSnapshots[0], reports);
  assert.match(renderText(component, 76), /Updated[\s\S]*new\.txt[\s\S]*Reset \[Y\]/);
  const next = findReset();
  component.handleMouse(mouse("click", ...next));
  component.handleMouse(mouse("press", ...next));
  component.handleMouse(mouse("click", ...next, { clickCount: 2 }));
  assert.equal(expectedSnapshots.length, 1, "no bare or multi-click can clear the new snapshot");
  const refreshed = component.render(76);
  component.handleMouse(mouse("press", ...next));
  assert.equal(component.render(76), refreshed, "no-op paints do not retire a valid press");
  component.handleMouse(mouse("release", ...next));
  component.handleMouse(mouse("click", ...next));
  assert.equal(expectedSnapshots[1], live);
  assert.match(renderText(component, 76), /No retained net changes/);
});

test("a refreshed floating Changes list prioritizes the exact hint count over header controls", (t) => {
  const prior = {
    groups: Array.from({ length: 12 }, (_, i) => file(`edited-${i}.txt`)),
    truncated: true,
    workspaceHints: 1,
  };
  const live = { ...prior, workspaceHints: 2 };
  const { component } = panel(t, prior, {
    floating: true,
    reset: {
      available: () => true,
      run(expected) {
        assert.equal(expected, prior);
        return live;
      },
    },
  });
  assert.match(renderText(component, 76), /Reset \[R\]/u);
  component.handleInput("r");
  const refreshed = renderText(component, 76);
  assert.match(refreshed, /\b2 hints\b/u);
  assert.match(refreshed, /Updated[^\n]*Expand all[^\n]*Partial list/u);
  assert.match(refreshed, /Reset \[Y\]/u);
  assert.doesNotMatch(refreshed, /\b1 hint\b/u);
  for (const width of [34, 24, 18, 14]) {
    const rows = renderText(component, width).split("\n");
    assert(
      rows.some((row) => /\b2 hints\b/u.test(row)),
      `show the full count at width ${width}`,
    );
    assert(rows.every((row) => visibleWidth(row) <= width));
  }
  assert.match(renderText(component, 24), /2 hints[\s\S]*Reset \[Y\]/u);
  assert.doesNotMatch(renderText(component, 14), /Reset/u);
  assert.match(renderText(component, 13), /Enlarge/u);
  assert.doesNotMatch(renderText(component, 13), /hints|Reset/u);
});

test("Net and History mark final-newline-only changes on the affected side", (t) => {
  const marker = "\\ No newline at end of file";
  for (const side of ["remove", "add"]) {
    const patch = edit(
      [remove("same text"), add("same text")].map((line) =>
        line.kind === side ? { ...line, noLf: true } : line,
      ),
    );
    const { component } = panel(t, { ...empty, groups: [file("newline.txt", patch)] });
    assert.doesNotMatch(renderText(component), /same text|No newline/);
    component.handleInput(ENTER);
    const expectedRows = ["− 1 │ same text", "+ 1 │ same text"];
    expectedRows.splice(side === "remove" ? 1 : 2, 0, marker);
    for (const mode of [/\[Net\]/, /\[History\]/]) {
      const detail = renderText(component);
      assert.match(detail, mode);
      assert.match(detail, /\+1 −1/);
      assert(detail.includes(expectedRows.join("\n")), detail);
      assert.equal(detail.split(marker).length, 2);
      component.handleInput("h");
    }
  }
});

test("empty, missing, withheld and limited reports are not presented as a clean workspace", (t) => {
  const noFiles = panel(t, empty).component;
  const emptyList = renderText(noFiles);
  assert.match(emptyList, /No retained net changes/);
  assert.doesNotMatch(emptyList, /Expand all/);
  noFiles.handleInput("a");
  assert.equal(renderText(noFiles), emptyList);
  noFiles.handleInput("h");
  assert.match(renderText(noFiles), /No retained edit\/write reports/);
  assert.match(renderText(panel(t, { ...empty, truncated: true }).component), /Partial list/);
  for (const [reason, hint] of [
    ["incomplete", /retained observations are incomplete/],
    ["ambiguous", /could not be composed reliably/],
    ["overlapping", /could not be ordered reliably/],
    ["sensitive", /content was withheld/],
    ["missing-or-unverified", /No verified tool-result diff/],
    ["oversized", /diff exceeded preview limits/],
    ["truncated", /captured edit content was incomplete/],
  ]) {
    const { component } = panel(t, {
      ...empty,
      groups: [file("src/fallback", unavailable(reason))],
    });
    assert.match(renderText(component), /Unknown/);
    component.handleInput(ENTER);
    assert.match(renderText(component), /Net diff unknown/);
    assert.match(renderText(component), hint);
    assert.doesNotMatch(renderText(component), /otter|\+0 −0/);
  }
  const { component } = panel(t, {
    truncated: true,
    groups: [
      {
        path: "src/limited",
        net: unavailable("truncated"),
        reports: [report(edit([add("safe")], { added: 10, redacted: true, truncated: true }))],
      },
    ],
  });
  renderText(component);
  component.handleInput(ENTER);
  assert.match(renderText(component), /Partial list/);
  assert.doesNotMatch(renderText(component), /\+10|safe/);
  component.handleInput("h");
  assert.match(renderText(component), /Agent otter · edit · \+10 −0/);
  assert.match(renderText(component), /content is omitted/);
  assert.match(renderText(component), /content has been redacted/);
  assert.match(renderText(component), /\+ 1 │ safe/);
});

test("History shows per-file reports oldest first and maps selection by path", (t) => {
  const write = {
    path: "src/second.ts",
    net: unavailable("write-no-before"),
    reports: [
      report(edit([remove("original"), add("draft")]), { agentLabel: "hare" }),
      report(undefined, { outcome: "failed", agentLabel: "elk\x1b\u202e" }),
      report(unavailable("write-no-before"), { tool: "write" }),
      report(undefined, { outcome: "unknown", agentLabel: "fox" }),
    ],
  };
  const { component } = panel(t, {
    groups: [...reports.groups.slice(0, 2), write],
    truncated: false,
  });
  renderText(component);
  component.handleInput(DOWN);
  component.handleInput("H");
  const history = renderText(component);
  assert.match(history, /Net \[History\] \[H\]/);
  assert.match(history, /src\/reverted\.ts {2}2 reports/);
  assert.match(history, /› src\/second\.ts {2}4 reports/);
  assert.doesNotMatch(history, /draft|hare|elk|otter|fox/);
  component.handleInput(ENTER);
  const detail = renderText(component);
  assert.match(detail, /Oldest first per file/);
  assert.match(
    detail,
    /Agent hare · edit · \+1 −1[\s\S]*draft[\s\S]*Agent elk\\u001b\\u202e · edit · failed[\s\S]*Agent otter · write · no diff[\s\S]*captured before text[\s\S]*Agent fox · edit · unconfirmed/,
  );
  component.handleInput("h");
  assert.match(
    renderText(component),
    /Alehouse Changes › File[\s\S]*src\/second\.ts[\s\S]*Net diff unknown/,
  );
  assert.doesNotMatch(renderText(component), /draft|hare|elk|otter|fox/);
  component.handleInput(ESC);
  assert.match(renderText(component), /› src\/second\.ts/);
});

test("the empty Net list can reveal reverted paths and preserve History selection and expansion", (t) => {
  const { component } = panel(t, { ...empty, groups: [reverted] });
  assert.match(renderText(component), /No retained net changes/);
  assert.doesNotMatch(renderText(component), /reverted|Unknown|temporary/);
  component.handleInput("h");
  assert.match(renderText(component), /› src\/reverted\.ts {2}2 reports/);
  assert.doesNotMatch(renderText(component), /temporary/);
  component.handleInput(ENTER);
  assert.match(
    renderText(component),
    /Agent otter[^\n]*\n[^\n]*before[^\n]*\n[^\n]*temporary[\s\S]*Agent hare/,
  );
  component.handleInput("h");
  assert.match(renderText(component), /No retained net changes/);
  component.handleInput("h");
  assert.match(renderText(component), /› src\/reverted\.ts/);
  component.handleInput("a");
  assert.match(renderText(component), /Collapse all[^\n]*\n[\s\S]*temporary/);
  component.handleInput("h");
  assert.match(renderText(component), /No retained net changes/);
  assert.doesNotMatch(renderText(component), /temporary/);
  component.handleInput("h");
  assert.match(renderText(component), /Collapse all[^\n]*\n[\s\S]*temporary/);
  component.handleInput(ESC);
  assert.match(renderText(component), /› src\/reverted\.ts/);
});

test("Changes scrolls through bounded wrapped content and escapes controls and path lookalikes", (t) => {
  const tui = terminal(15);
  const suffix = "TAIL_✌️";
  const displayedSource = String.raw`path\\name\tactual-tab`; // Runtime display form.
  const snapshot = {
    ...empty,
    groups: [
      file(
        "src/界👩‍💻 a\u1680b\x1b\n\u202e.ts",
        edit([
          remove(displayedSource),
          add("  a    b    c\t\x1b]8;;url\x07\n\u202e" + "界".repeat(40) + suffix),
        ]),
      ),
      file("src/a\\u1680b"),
    ],
  };
  const { component } = panel(t, snapshot, { tui, floating: true });
  const list = renderText(component);
  assert.match(list, /src\/界👩‍💻\\u0020a\\u1680b\\u001b\\u000a\\u202e\.ts/u);
  assert.match(list, /src\/a\\\\u1680b/);
  component.handleInput(ENTER);
  const diff = renderText(component);
  assert(diff.includes(`− 1 │ ${displayedSource}`), "runtime source escapes are not escaped again");
  assert.match(diff, /\+ 1 │ {3}a {4}b {4}c\\u0009\\u001b\]8;;url\\u0007\\u000a\\u202e/);
  assert(!diff.includes("\x1b") && !diff.includes("\u202e"));
  const width = 27;
  let lines = component.render(width);
  assert.equal(component.render(width), lines, "immutable unchanged frame is reused");
  const visited = [...lines];
  for (let i = 0; i < 6; i++) {
    assert.equal(
      component.handleMouse(mouse("wheel", 2, 2, { wheelDelta: 10_000 }))?.handled,
      true,
    );
    lines = component.render(width);
    assert(lines.length <= 10);
    assert(lines.every((line) => visibleWidth(line) <= width));
    visited.push(...lines);
  }
  assert(
    visited.some((line) => line.includes(suffix)),
    "long Unicode line remains scrollable",
  );
  component.handleInput(PAGE_UP);
  assert.notEqual(component.render(width), lines);
  for (const narrow of [1, 12, 25]) {
    tui.terminal.rows = 9;
    const resized = component.render(narrow);
    assert(resized.length <= 6);
    assert(resized.every((line) => visibleWidth(line) <= narrow));
  }
});

test("wrapping long ASCII patch lines preserves spaces after control escaping", (t) => {
  const text = "    first             ".repeat(3) + "\tlast";
  const { component } = panel(t, { ...empty, groups: [file("space.txt", edit([add(text)]))] });
  const width = 24;
  component.render(width);
  component.handleInput(ENTER);
  const prefix = "+ 1 │ ";
  const available = width - visibleWidth(prefix);
  const escaped = text.replace("\t", String.raw`\u0009`);
  const expected = [];
  for (let i = 0; i < escaped.length; i += available)
    expected.push((i ? " ".repeat(prefix.length) : prefix) + escaped.slice(i, i + available));
  assert(renderText(component, width).includes(expected.join("\n")));
});

test("expand all is explicit, keeps per-file notices and returns to the same selection", (t) => {
  const { component, closes } = panel(t, {
    truncated: true,
    groups: [
      ...reports.groups,
      {
        path: "src/limited.ts",
        net: unavailable("truncated"),
        reports: [report(edit([add("safe preview")], { truncated: true, redacted: true }))],
      },
    ],
  });
  assert.match(renderText(component), /Expand all \[A\]/);
  assert.doesNotMatch(renderText(component), /bonjour|safe preview/);
  component.handleInput(DOWN);
  component.handleInput("A");
  const all = renderText(component);
  assert.match(all, /Collapse all \[A\] · Partial list/);
  assert.match(all, /src\/common\.ts[\s\S]*bonjour[\s\S]*src\/second\.ts[\s\S]*Net diff unknown/);
  assert.match(all, /A write has no captured before text/);
  assert.doesNotMatch(all, /src\/reverted\.ts|safe preview/);
  component.handleInput("h");
  const history = renderText(component);
  assert.match(history, /Collapse all \[A\]/);
  assert.match(history, /src\/reverted\.ts[\s\S]*temporary/);
  assert.match(
    history,
    /src\/limited\.ts[\s\S]*some changed content is omitted[\s\S]*content has been redacted[\s\S]*safe preview/,
  );
  component.handleInput("h");
  assert.match(renderText(component), /Collapse all \[A\]/);
  assert.doesNotMatch(renderText(component), /src\/reverted\.ts|safe preview/);
  component.handleInput(ESC);
  assert.equal(closes(), 0, "Escape collapses before closing");
  assert.match(renderText(component), /› src\/second\.ts/);
  assert.doesNotMatch(renderText(component), /bonjour|safe preview/);
  component.handleInput("a");
  assert.match(renderText(component), /Collapse all/);
  component.handleInput("a");
  assert.match(renderText(component), /Expand all/);
  component.handleInput(ENTER);
  assert.match(renderText(component), /Net diff unknown/);
  assert.doesNotMatch(renderText(component), /bonjour|safe preview/);
  component.handleInput(ESC);
  component.handleInput(ESC);
  assert.equal(closes(), 1);
});

test("expanded previews project only nearby files and scroll in both directions across file boundaries", (t) => {
  const accessed = new Set();
  const groups = Array.from({ length: 512 }, (_, index) =>
    file(
      `/f-${index}`,
      edit([
        {
          kind: "add",
          line: 1,
          get text() {
            accessed.add(index);
            return `BODY-${index}`;
          },
        },
      ]),
    ),
  );
  const { component } = panel(t, { ...empty, groups }, { tui: terminal(20), floating: true });
  assert.match(renderText(component), /Expand all/);
  assert.equal(accessed.size, 0, "opening and painting the list doesn't project any patch rows");
  component.handleInput("a");
  assert.equal(accessed.size, 0, "expanding does not build all preview rows");
  assert.match(renderText(component), /BODY-0/);
  assert(accessed.size > 0 && accessed.size <= 5);
  component.handleMouse(mouse("wheel", 2, 3, { wheelDelta: 10_000 }));
  assert.match(renderText(component), /BODY-5/);
  assert(accessed.size <= 8, "a large wheel event projects at most the next page of previews");
  component.handleInput(PAGE_UP);
  assert.match(renderText(component), /BODY-0/);
  for (let i = 0; i < 160; i++) {
    component.handleInput(PAGE_DOWN);
    component.render(76);
  }
  assert.equal(accessed.size, groups.length);
  assert.match(renderText(component), /BODY-511/);
  assert.match(renderText(component, 14), /Net\/History/);
  assert(component.render(14).every((line) => visibleWidth(line) <= 14));
  component.handleInput("a");
  assert.doesNotMatch(renderText(component, 14), /BODY-511/, "keyboard collapse still works");
});

test("a long one-file History projects only the reports reached by the viewport", (t) => {
  const accessed = new Set();
  const groups = [
    {
      path: "/large-history.ts",
      net: unavailable("truncated"),
      reports: Array.from({ length: 512 }, (_, index) =>
        report(
          edit([
            {
              kind: "add",
              line: 1,
              get text() {
                accessed.add(index);
                return `REPORT-${index}`;
              },
            },
          ]),
        ),
      ),
    },
  ];
  const { component } = panel(t, { ...empty, groups }, { tui: terminal(20) });
  component.render(76);
  component.handleInput("h");
  component.handleInput(ENTER);
  assert.equal(accessed.size, 0);
  assert.match(renderText(component, 76), /REPORT-0/);
  assert(accessed.size <= 6, `only one viewport was projected: ${accessed.size}`);
  component.handleInput(PAGE_DOWN);
  assert.match(renderText(component, 76), /REPORT-8/);
  assert(accessed.size <= 12, `only two viewports were projected: ${accessed.size}`);
  component.handleInput(PAGE_UP);
  assert.match(renderText(component, 76), /REPORT-0/);
});

test("paging the file list and closing a detail keep the same selection and list neighborhood", (t) => {
  const tui = terminal(12);
  const groups = Array.from({ length: 512 }, (_, i) => file(`/path-${i}`));
  const { component } = panel(t, { ...empty, groups }, { tui });
  for (let i = 0; i < 130; i++) {
    component.render(60);
    component.handleInput(PAGE_DOWN);
  }
  assert.match(renderText(component), /› \/path-511/);
  component.handleInput(ENTER);
  assert.match(renderText(component), /\/path-511/);
  component.handleInput(ESC);
  tui.terminal.rows = 20;
  assert.match(renderText(component), /› \/path-511/);
  component.handleInput(PAGE_UP);
  assert.doesNotMatch(renderText(component), /› \/path-511/);
});

test("fullscreen file row and Back clicks work, stale geometry is rejected, and X closes directly", (t) => {
  const h = panel(t, reports, { floating: true });
  const { component } = h;
  const locate = (text) => component.render(76).findIndex((line) => line.includes(text));
  let row = locate("src/second.ts");
  component.handleMouse(mouse("press", 10, row));
  h.translate();
  row = locate("src/second.ts");
  component.handleMouse(mouse("click", 10, row));
  assert.doesNotMatch(renderText(component, 76), /Net diff unknown/);
  row = locate("src/second.ts");
  component.handleMouse(mouse("press", 10, row));
  assert.equal(component.handleMouse(mouse("click", 10, row))?.focus, true);
  assert.match(renderText(component, 76), /Net diff unknown/);
  const back = locate("‹ Files");
  component.handleMouse(mouse("click", 1, back));
  assert.match(renderText(component, 76), /› src\/second\.ts/);
  component.handleInput(ENTER);
  component.render(76);
  const { x, y } = popoverChromeCloseHit(76);
  component.handleMouse(mouse("press", x, y));
  assert.equal(h.closes(), 0);
  component.handleMouse(mouse("release", x, y));
  assert.equal(h.closes(), 1);
});

test("fullscreen diff text remains natively selectable without capturing the footer", async (t) => {
  const copied = [];
  const tui = new TuiAltScreen(
    { rows: 40, columns: 100, write() {}, hideCursor() {} },
    false,
    undefined,
    {
      copyOnSelect: true,
      async copySelection(text) {
        copied.push(text);
        return true;
      },
    },
  );
  tui.requestRender = tui.requestImmediateRender = () => {};
  tui.setLayoutRoot({ render: () => [], invalidate() {} });
  tui.beforeTerminalStart();
  const { component } = panel(t, reports, { tui, floating: true });
  const handle = tui.showOverlay(component, { row: 2, col: 2, width: 76 });
  t.after(() => {
    handle.hide();
    tui.beforeTerminalStop({});
    tui.afterTerminalStop({ preserveScreen: true });
  });
  tui.doRender();
  component.handleInput(ENTER);
  tui.doRender();
  const bounds = handle.getBounds();
  const rows = component.render(bounds.width).map(stripTerminalSequences);
  const y = rows.findIndex((line) => line.includes("bonjour"));
  const x = visibleWidth(rows[y].split("const")[0]);
  const send = (button, x, y, release = false) =>
    tui.handleTerminalInput(
      `\x1b[<${button};${bounds.col + x + 1};${bounds.row + y + 1}${release ? "m" : "M"}`,
    );
  send(0, x, y);
  send(32, bounds.width - 1, bounds.height - 1);
  send(0, bounds.width - 1, bounds.height - 1, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    copied.map((text) => text.trimEnd()),
    ["const greeting = 'bonjour';"],
  );
});

function host(t, mode, { deferred = false, rows = 40, resetChanges } = {}) {
  const events = createEventBus(),
    notices = [],
    mounted = [],
    prompts = new Map();
  const screen = { rows, columns: 100, hideCursor() {} };
  const tui = mode === "fullscreen" ? new TuiAltScreen(screen, false, undefined, {}) : terminal();
  tui.requestRender = () => {};
  const editor = { render: () => [], invalidate() {} };
  if (mode === "fullscreen") {
    tui.setFocus(editor);
    const showOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = (component, options) => {
      const handle = showOverlay(component, options);
      if (component instanceof ChangesPanel) mounted.push({ component, handle, options });
      return handle;
    };
  }
  let queued;
  const coordinator = new PanelCoordinator({
    pi: {
      events,
      registerShortcut() {},
      on(name, fn) {
        prompts.set(name, fn);
        return () => prompts.delete(name);
      },
    },
    widget: {
      onOpen() {},
      agents() {
        assert.fail("Changes must not inspect an Agent roster");
      },
      tuiMode: () => undefined,
    },
    ready: () => true,
    resetChanges,
    router() {
      assert.fail("Opening Changes must not require a preset");
    },
  });
  const ctx = {
    mode: "tui",
    ui: {
      theme,
      setWidget(_key, factory) {
        factory?.(tui);
      },
      custom(factory, options) {
        assert.equal(mode, "regular", "fullscreen Changes must not occupy the SDK custom queue");
        return new Promise((done) => {
          queued = () =>
            mounted.push({ component: factory(tui, theme, keybindings, done), options });
          if (!deferred) queued();
        });
      },
      notify: (message) => notices.push(message),
    },
  };
  coordinator.attachHost(ctx, events);
  t.after(() => coordinator.dispose());
  const paint = () => {
    for (let i = 0; i < 2; i++)
      tui.compositeOverlays(Array(screen.rows).fill(""), screen.columns, screen.rows);
  };
  return {
    ctx,
    coordinator,
    mounted,
    notices,
    events,
    prompts,
    editor,
    tui,
    paint,
    mount: () => queued(),
  };
}

for (const mode of ["regular", "fullscreen"]) {
  test(`Changes opens without an Agent, reads once per opening and closes on Escape (${mode})`, async (t) => {
    const h = host(t, mode);
    let reads = 0;
    const read = () => (++reads === 1 ? empty : reports);
    let opening = h.coordinator.openChanges(h.ctx, read);
    const [first] = h.mounted;
    assert.equal(first.options.anchor, mode === "fullscreen" ? "bottom-right" : undefined);
    assert.match(renderText(first.component), /No retained net changes/);
    first.component.handleInput("h");
    assert.match(renderText(first.component, 82), /No retained edit\/write reports/);
    assert.equal(reads, 1);
    if (mode === "regular") {
      await h.coordinator.openChanges(h.ctx, read);
      assert.match(h.notices.at(-1), /another panel/);
      assert.equal(reads, 1);
    }
    first.component.handleInput(ESC);
    await opening;
    opening = h.coordinator.openChanges(h.ctx, read);
    const second = h.mounted.at(-1).component;
    assert.match(renderText(second), /\[Net\] History[\s\S]*src\/common\.ts/);
    assert.equal(reads, 2);
    h.coordinator.dispose();
    await opening;
    assert.deepEqual(second.render(100), []);
  });
}

test("docked Reset refreshes stale observations during its own SDK custom prompt span", async (t) => {
  let resets = 0;
  const h = host(t, "regular", {
    deferred: true,
    resetChanges: { available: () => true, run: () => (++resets, true) },
  });
  let reads = 0;
  let live = reports;
  const opening = h.coordinator.openChanges(h.ctx, () => {
    reads++;
    return live;
  });
  h.prompts.get("ui_prompt_start")({ kind: "custom" });
  h.mount();
  const { component } = h.mounted[0];
  assert.match(renderText(component), /Reset \[R\]/);
  live = { ...reports, groups: [...reports.groups, file("new.txt")] };
  assert.doesNotMatch(renderText(component), /new\.txt/);
  assert.equal(reads, 1);
  component.handleInput("r");
  assert.equal(resets, 0, "the stale observation was refreshed but not reset");
  assert.equal(reads, 2);
  assert.match(renderText(component), /Updated[\s\S]*new\.txt[\s\S]*Reset \[Y\]/);
  component.handleInput("y");
  assert.equal(resets, 1);
  assert.equal(reads, 3);
  assert.match(renderText(component), /No retained net changes/);
  component.handleInput(ESC);
  h.prompts.get("ui_prompt_end")({ kind: "custom" });
  await opening;
});

test("mouse Reset refreshes new workspace hints from another Agent before clearing edit and hint observations", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const editor = registry.track("editor", "/project", "Writer", ["write"]);
  const hooks = new Map();
  editor.extension({ on: (name, fn) => hooks.set(name, fn) });
  t.after(editor.begin());
  hooks.get("tool_execution_start")({
    type: "tool_execution_start",
    toolName: "write",
    toolCallId: "write",
    args: { path: "edited.txt" },
  });
  const activity = registry.track("other", "/project", "Bash worker", ["bash"]);
  const workspace = activity.workspaceMonitor.watchRun();
  t.after(workspace.clear);
  const h = host(t, "fullscreen", {
    resetChanges: {
      available: () => true,
      hasObservations: () => registry.hasOwnerChangeObservations(),
      run: (_ctx, expected) => registry.resetChanges(expected),
    },
  });
  let reads = 0;
  const opening = h.coordinator.openChanges(h.ctx, () => {
    reads++;
    return registry.listOwnerChanges();
  });
  h.paint();
  const { component, handle } = h.mounted[0];
  const resetPoint = () => {
    const bounds = handle.getBounds();
    const lines = renderText(component, bounds.width).split("\n");
    const y = lines.findIndex((line) => line.includes("Reset ["));
    assert(y >= 0);
    return {
      button: 0,
      x: bounds.col + visibleWidth(lines[y].split("Reset")[0]),
      y: bounds.row + y,
    };
  };
  const old = resetPoint();
  h.tui.handleMouseEvent({ ...old, release: false });
  workspace.observe({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "cd",
    args: { command: "cd ./private-hint" },
  });
  workspace.observe({
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "cd",
    durationMs: 1,
  });
  h.paint();
  assert.equal(reads, 1, "paint does not reread or enumerate live observations");
  h.tui.handleMouseEvent({ ...old, release: true });
  assert.equal(reads, 2);
  assert.equal(activity.workspaceSnapshot().length, 1, "the stale click must not clear hints");
  h.paint();
  const refreshed = renderText(component, 76);
  assert.match(refreshed, /\b1 hint\b[^\n]*Updated[\s\S]*edited\.txt[\s\S]*Reset \[Y\]/u);
  assert.doesNotMatch(refreshed, /private-hint/u);
  const next = resetPoint();
  h.tui.handleMouseEvent({ ...next, release: false });
  h.tui.handleMouseEvent({ ...next, release: true });
  assert.equal(activity.workspaceSnapshot().length, 1, "a native double-click cannot clear");
  now += 1_000;
  h.tui.handleMouseEvent({ ...next, release: false });
  h.tui.handleMouseEvent({ ...next, release: true });
  assert.deepEqual(activity.workspaceSnapshot(), []);
  assert.match(renderText(component, 76), /No retained net changes/u);
  assert.doesNotMatch(renderText(component, 76), /edited\.txt|Reset/u);
  component.handleInput(ESC);
  await opening;
});

test("floating Changes stacks above pins, waits for room, toggles, and yields to prompts without closing sibling pins", async (t) => {
  let resets = 0;
  const h = host(t, "fullscreen", {
    rows: 16,
    resetChanges: { available: () => true, run: () => (++resets, true) },
  });
  const pin = joinPopoverStack(h.tui);
  let pinHeight = 15 - changesMinRows() + 1;
  const sibling = h.tui.showOverlay(
    {
      render(width) {
        pin.measure(pinHeight);
        return Array(pinHeight).fill("·".repeat(width));
      },
      invalidate() {},
    },
    stackedOverlayOptions(pin, { width: 40, nonCapturing: true }),
  );
  t.after(() => {
    sibling.hide();
    pin.leave();
  });
  h.paint();
  let opening = h.coordinator.openChanges(h.ctx, () => reports, true);
  h.paint();
  const waiting = h.mounted[0];
  assert.match(h.notices.at(-1), /waiting for .* free rows/);
  assert.equal(waiting.handle.getBounds(), undefined);
  assert.equal(h.tui.getFocusedComponent(), h.editor);
  await h.coordinator.openChanges(h.ctx, () =>
    assert.fail("slash must cancel even without a footer count"),
  );
  await opening;
  assert.equal(waiting.component.render(76).length, 0);
  assert(sibling.getBounds());

  opening = h.coordinator.openChanges(h.ctx, () => reports, true);
  pinHeight = 4;
  h.paint();
  await Promise.resolve();
  h.paint();
  const { component, handle } = h.mounted.at(-1);
  const upper = handle.getBounds(),
    lower = sibling.getBounds();
  assert.equal(upper.row + upper.height, lower.row);
  assert.equal(upper.col, lower.col);
  assert.equal(upper.width, lower.width);
  assert.equal(h.tui.getFocusedComponent(), component);
  const click = (label, offset = 0) => {
    const bounds = handle.getBounds();
    const lines = component.render(bounds.width).map(stripTerminalSequences);
    const row = lines.findIndex((line) => line.includes(label));
    assert(row >= 0, label);
    const x = visibleWidth(lines[row].slice(0, lines[row].indexOf(label))) + offset;
    const point = { button: 0, x: bounds.col + x, y: bounds.row + row };
    h.tui.handleMouseEvent({ ...point, release: false });
    h.tui.handleMouseEvent({ ...point, release: true });
    h.paint();
  };
  click("Expand all", -1); // Separator, not the action.
  assert.doesNotMatch(renderText(component, upper.width), /bonjour/);
  click("Expand all");
  assert.match(renderText(component, upper.width), /Collapse all/);
  assert.match(renderText(component, upper.width), /bonjour/);
  click("History");
  assert.match(renderText(component, upper.width), /\[History\][^\n]*Collapse all/);
  assert.match(renderText(component, upper.width), /Agent otter[\s\S]*intermediate[\s\S]*bonjour/);
  click("Net");
  assert.match(renderText(component, upper.width), /\[Net\][^\n]*Collapse all/);
  assert.doesNotMatch(renderText(component, upper.width), /Agent otter/);
  const expanded = handle.getBounds();
  assert.equal(expanded.row + expanded.height, lower.row);
  assert.equal(expanded.col, lower.col);
  click("Collapse all");
  assert.doesNotMatch(renderText(component, upper.width), /bonjour/);
  click("src/second.ts");
  click("History");
  assert.match(
    renderText(component, upper.width),
    /src\/second\.ts[\s\S]*Agent otter · write · no diff/,
  );
  click("‹ Files");
  assert.match(renderText(component, upper.width), /› src\/second\.ts {2}1 report/);
  click("Net");
  assert.match(renderText(component, upper.width), /› src\/second\.ts {2}Unknown/);
  click("src/common.ts");
  assert.match(renderText(component, upper.width), /bonjour/);
  click("Reset", -1); // Separator, not the action.
  assert.equal(resets, 0);
  click("Reset");
  assert.equal(resets, 1);
  assert.match(renderText(component, upper.width), /No retained net changes/);
  assert.doesNotMatch(renderText(component, upper.width), /bonjour|Reset/);
  assert.equal(h.tui.getFocusedComponent(), component, "reset keeps fullscreen Changes open");
  assert.deepEqual(sibling.getBounds(), lower, "reset leaves sibling panels alone");
  h.prompts.get("ui_prompt_start")();
  await opening;
  assert.equal(handle.getBounds(), undefined);
  assert.equal(h.tui.getFocusedComponent(), h.editor);
  assert(sibling.getBounds());
  await h.coordinator.openChanges(h.ctx, () => assert.fail("a prompt blocks raw mount"));
  h.prompts.get("ui_prompt_end")();
  opening = h.coordinator.openChanges(h.ctx, () => reports, true);
  await h.coordinator.openChanges(h.ctx, () => assert.fail("footer toggle must not reread"), true);
  await opening;
  assert.equal(h.mounted.at(-1).component.render(76).length, 0);
});

test("Changes cannot sit in front of an approval, mount after cancellation, or read on RPC", async (t) => {
  const h = host(t, "regular", { deferred: true });
  const unexpectedRead = () => assert.fail("must not read an unmounted Changes snapshot");
  await h.coordinator.openChanges({ ...h.ctx, mode: "rpc" }, unexpectedRead);
  assert.match(h.notices.at(-1), /requires the interactive TUI/);
  const opening = h.coordinator.openChanges(h.ctx, unexpectedRead);
  h.events.emit("permissions:ui_prompt", { requestId: "ask" });
  h.mount();
  await opening;
  assert.deepEqual(h.mounted.at(-1).component.render(100), []);
  await h.coordinator.openChanges(h.ctx, unexpectedRead);
  assert.match(h.notices.at(-1), /another panel, dialog or approval/);
  h.events.emit("permissions:decision", { requestId: "ask" });
  const reopened = h.coordinator.openChanges(h.ctx, () => empty);
  h.mount();
  const component = h.mounted.at(-1).component;
  assert.match(renderText(component), /Alehouse Changes/);
  h.events.emit("permissions:ui_prompt", { requestId: "later" });
  await reopened;
  assert.deepEqual(component.render(100), []);
  h.events.emit("permissions:decision", { requestId: "later" });
  assert.equal(h.mounted.length, 2, "Changes is not reopened after a permission dialog");
});
