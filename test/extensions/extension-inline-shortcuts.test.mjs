// Inline shortcut hints on Alehouse-owned extension panels: the shared helper
// contract, and the three panels that adopt it (Approval, Context, Stats).
// Direct source via jiti: no generated runtime, build, sessions, providers or
// network. The recording theme keeps the painted plain text measurable while
// it records the exact fragment colors, so a nested reset is visible here.
import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { borderLabelsEnabled, setBorderLabelsEnabled } from "../../src/shared/popover-chrome.mjs";
import { shortcutHint } from "../../src/shared/shortcut-hint.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { ApprovalPopover } = await jiti.import("../../src/extensions/lib/approval-view.ts");
const { ContextView } = await jiti.import("../../src/extensions/lib/context-view.ts");
const { StatsView } = await jiti.import("../../src/extensions/lib/stats-view.ts");

/** Paints unstyled text but records every fragment color it was asked for. */
function recordingTheme() {
  const calls = [];
  return {
    calls,
    fg: (tone, text) => {
      calls.push(["fg", tone, text]);
      return text;
    },
    bold: (text) => {
      calls.push(["bold", text]);
      return text;
    },
    bg: (tone, text) => {
      calls.push(["bg", tone, text]);
      return text;
    },
  };
}

/** ANSI theme with separate dim/muted tones and Pi's attribute resets. */
const ansiTheme = {
  fg: (tone, text) =>
    tone === "dim"
      ? `\x1b[37;2m${text}\x1b[22;39m`
      : `\x1b[${tone === "accent" ? 36 : tone === "muted" ? 90 : 37}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  bg: (_tone, text) => `\x1b[44m${text}\x1b[49m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
};

/** Check the effective attributes of every character, not just the presence
 * of an opening SGR that could have been canceled by a nested fragment. */
function assertAnsiStyle(row, fragment, expected) {
  const start = plain(row).indexOf(fragment);
  assert.ok(start >= 0, `missing ${JSON.stringify(fragment)} in ${plain(row)}`);
  const state = new Set();
  const resets = { 22: [1, 2], 24: [4], 39: [36, 37, 90], 49: [44] };
  let index = 0;
  for (const [token, params] of row.matchAll(/\x1b\[([\d;]*)m|./g)) {
    if (params !== undefined) {
      for (const code of params.split(";").map(Number)) {
        if (code === 0) state.clear();
        else if (resets[code]) for (const removed of resets[code]) state.delete(removed);
        else {
          if ([36, 37, 90].includes(code)) for (const fg of resets[39]) state.delete(fg);
          state.add(code);
        }
      }
    } else if (index++ >= start) {
      assert.deepEqual(
        [...state].sort((a, b) => a - b),
        expected,
        `${token} in ${fragment}`,
      );
      if (index === start + fragment.length) return;
    }
  }
  assert.fail(`did not read all of ${fragment}`);
}

const colored = (theme, tone, text) =>
  theme.calls.some(([kind, value, body]) => kind === "fg" && value === tone && body === text);
const bolded = (theme, text) =>
  theme.calls.some(([kind, body]) => kind === "bold" && body === text);
/** No square keycap/button brackets in an owned label. */
const keycaps = (text) => text.match(/\[[A-Za-z0-9↑↓←→]\]/g) ?? [];

const choices = [
  { id: "manual", label: "manual", detail: "human approval" },
  { id: "yolo", label: "YOLO", detail: "session asks" },
];

function mountApproval({ theme = recordingTheme(), trusted = true } = {}) {
  const saves = [];
  const view = new ApprovalPopover({
    theme,
    choices: () => choices,
    current: () => "manual",
    warning: (id) => (id === "yolo" ? ["Confirm wider approval"] : undefined),
    choose: () => {},
    save: (scope) => saves.push(scope),
    canSaveWorkspace: () => trusted,
    saveScope: () => "session",
    close: () => {},
    requestRender: () => {},
  });
  return { view, saves, lines: (width = 72) => view.render(width).map(plain) };
}

const CATEGORIES = ["system", "summary", "messages", "tools", "other"];
const contextSnapshot = () => ({
  usage: { tokens: 5000, contextWindow: 10000, percent: 50 },
  rawTokens: 10000,
  categories: CATEGORIES.map((id) => ({
    id,
    label: id,
    rawTokens: 2000,
    tokens: 1000,
    count: 1,
  })),
  items: Array.from({ length: 12 }, (_, index) => ({
    id: `item:${index}`,
    category: "system",
    label: `source ${index}`,
    kind: "metadata",
    rawTokens: 2000,
    tokens: 1000,
    count: 1,
    rawState: "estimate",
    detail: ["Safe metadata"],
  })),
  allocation: "raw",
  attribution: "complete",
  replay: "selected",
  note: "raw estimates",
});

function mountContext({ theme = recordingTheme(), focused = true, rows = 30 } = {}) {
  // One stable snapshot identity: a fresh object per read is a new epoch, and
  // the view deliberately refuses navigation against an unpainted snapshot.
  const data = contextSnapshot();
  const view = new ContextView({
    theme,
    snapshot: () => data,
    availableRows: () => rows,
    requestRender: () => {},
    close: () => {},
    isFocused: () => focused,
  });
  return { view, lines: (width = 80) => view.render(width).map(plain) };
}

const statsSnapshot = () => ({
  health: "busy",
  elapsedMs: 60000,
  busyMs: 1000,
  models: [
    {
      model: "m0",
      provider: "p",
      requests: 2,
      errors: 0,
      outputTokens: 10,
      cost: 0.1,
      llmMs: 100,
      tps: 5,
      ttftMs: 10,
      ttftSamples: 1,
    },
  ],
  tools: [],
  recentErrors: [],
});

function mountStats({ theme = recordingTheme(), rows = 24 } = {}) {
  const view = new StatsView({
    tui: { terminal: { rows }, requestRender: () => {} },
    theme,
    snapshot: statsSnapshot,
    close: () => {},
  });
  return { view, lines: (width = 80) => view.render(width).map(plain) };
}

test("shortcutHint highlights one ASCII mnemonic in place, without repeating it", () => {
  const theme = recordingTheme();
  const label = "Save as global default";
  assert.equal(plain(shortcutHint(theme, label, "g")), label, "plain text is unchanged");
  assert.ok(colored(theme, "accent", "g"), "the mnemonic keeps the accent");
  assert.ok(bolded(theme, "g"), "and is bold");
  assert.ok(colored(theme, "muted", "Save as "), "the body keeps the muted tone");
  assert.deepEqual(keycaps(label), [], "no keycap brackets");

  // Case-insensitive match, still one occurrence: only the first is a key.
  const upper = recordingTheme();
  assert.equal(plain(shortcutHint(upper, "Note", "n")), "Note");
  assert.ok(bolded(upper, "N"));
  // The mnemonic lives inside its own word, never as a repeated prefix.
  const inline = recordingTheme();
  assert.equal(plain(shortcutHint(inline, "note", "n")), "note");
  assert.ok(bolded(inline, "n"));
  assert.ok(colored(inline, "accent", "n"));
  assert.ok(!bolded(inline, "N"), "no duplicated key letter");
  const twice = recordingTheme();
  assert.equal(plain(shortcutHint(twice, "global global", "g")), "global global");
  assert.equal(twice.calls.filter(([kind]) => kind === "bold").length, 1);
});

test("shortcutHint keeps non-mnemonic keys explicit and missing keys click-only", () => {
  for (const [label, key, expected] of [
    ["Settings", "P", "P Settings"],
    ["close", "Esc", "Esc close"],
    ["apply", "Enter", "Enter apply"],
    ["scroll", "↑↓ PgUp/PgDn", "↑↓ PgUp/PgDn scroll"],
    ["view", "1-3/Tab", "1-3/Tab view"],
    ["more", ".", ". more"],
  ]) {
    const theme = recordingTheme();
    assert.equal(plain(shortcutHint(theme, label, key)), expected);
    assert.ok(bolded(theme, key), `${key} keeps the shortcut emphasis`);
    assert.deepEqual(keycaps(expected), []);
  }
  const clickOnly = recordingTheme();
  assert.equal(plain(shortcutHint(clickOnly, "Estimation note")), "Estimation note");
  assert.equal(clickOnly.calls.filter(([kind]) => kind === "bold").length, 0, "no emphasis");
  assert.ok(colored(clickOnly, "muted", "Estimation note"));
  // A bare chord is the explicit form without a label, and adds no padding.
  const bare = recordingTheme();
  assert.equal(shortcutHint(bare, "", "Esc"), shortcutHint(bare, "", "Esc").trimEnd());
  assert.equal(plain(shortcutHint(bare, "", "Esc")), "Esc");
});

test("shortcutHint styling adds no visible columns", () => {
  for (const [label, key] of [
    ["Save as global default", "g"],
    ["workspace default", "W"],
    ["note", "n"],
    ["", "↑↓"],
  ]) {
    const hint = shortcutHint(ansiTheme, label, key);
    assert.equal(visibleWidth(hint), visibleWidth(plain(hint)));
  }
});

test("approval save rows inline `g` and `w` inside their words", () => {
  const theme = recordingTheme();
  const { lines } = mountApproval({ theme });
  const rows = lines();
  const global = rows.find((line) => line.includes("global default"));
  const workspace = rows.find((line) => line.includes("workspace default"));
  assert.ok(global?.includes("Save as global default (on exit)"), "the g sits inside `global`");
  assert.ok(
    workspace?.includes("Save as workspace default (on exit)"),
    "the w sits inside `workspace`, with no W prefix",
  );
  assert.deepEqual(keycaps(rows.join("\n")), [], "no [G]/[W] keycaps");
  assert.ok(!rows.some((line) => line.includes("[G]") || line.includes("[W]")));
  assert.ok(colored(theme, "accent", "g"), "the inlined g is the accent key");
  assert.ok(bolded(theme, "g"));
  assert.ok(bolded(theme, "w"), "the inlined w is emphasized too");
  assert.ok(colored(theme, "muted", "orkspace default (on exit)"), "the label stays muted");
});

test("approval keeps an untrusted workspace save dim, click-only and inert", () => {
  const theme = recordingTheme();
  const untrusted = mountApproval({ theme, trusted: false });
  const rows = untrusted.lines();
  const workspaceRow = rows.find((line) => line.includes("Workspace default"));
  assert.ok(workspaceRow?.includes("Workspace default (trust required)"), workspaceRow);
  assert.ok(colored(theme, "dim", "Workspace default (trust required)"), "the body stays dim");
  assert.ok(!bolded(theme, "W") && !bolded(theme, "w"), "no mnemonic emphasis");
  assert.ok(!colored(theme, "accent", "W") && !colored(theme, "accent", "w"));
  // Styling is presentation only: the painted row keeps its target, and the
  // existing trust gate still refuses the save.
  const y = rows.findIndex((line) => line.includes("Workspace default"));
  assert.ok(y > 0);
  untrusted.view.handleMouse({ type: "click", button: "left", x: 4, y, width: 72 });
  assert.deepEqual(untrusted.saves, [], "an untrusted workspace save is refused");
  untrusted.view.dispose();

  const trusted = mountApproval({ theme: recordingTheme(), trusted: true });
  const trustedRows = trusted.lines();
  const trustedY = trustedRows.findIndex((line) => line.includes("workspace default"));
  trusted.view.handleMouse({ type: "click", button: "left", x: 4, y: trustedY, width: 72 });
  assert.deepEqual(trusted.saves, ["workspace"], "a trusted workspace save still works");
  trusted.view.dispose();
});

test("approval keeps bold accent footer chords and dim label bodies", (t) => {
  const { view } = mountApproval({ theme: ansiTheme });
  t.after(() => view.dispose());
  const footer = view.render(72).find((line) => plain(line).includes("choose"));
  assert.ok(plain(footer).includes("● active · ↑↓ choose · Enter apply · Esc close"));
  for (const key of ["↑↓", "Enter", "Esc"]) assertAnsiStyle(footer, key, [1, 36]);
  for (const label of ["● active", "choose", "apply", "close"])
    assertAnsiStyle(footer, label, [2, 37]);
});

test("context footer highlights `note` in place and hides hints without focus", () => {
  const theme = recordingTheme();
  const { view, lines } = mountContext({ theme });
  const footer = lines().at(-1);
  assert.ok(footer?.includes("↑↓ · Enter · Tab · note · Esc"), footer);
  assert.ok(!footer?.includes("N note"), "the key is not repeated before its word");
  assert.ok(bolded(theme, "n"), "the mnemonic is highlighted inside `note`");
  assert.ok(colored(theme, "accent", "n"));
  assert.deepEqual(keycaps(footer), []);
  // A detail page names only the key that works there.
  view.handleInput("\r");
  assert.ok(lines().at(-1)?.includes("Esc back"));
  view.dispose();

  const passive = recordingTheme();
  const unfocused = mountContext({ theme: passive, focused: false });
  assert.doesNotMatch(unfocused.lines().at(-1), /↑↓|Enter|Tab|Esc|N note/);
  const hintBold = passive.calls.filter(
    ([kind, , body]) => kind === "bold" && ["N", "Esc", "Enter", "Tab", "↑↓"].includes(body),
  );
  assert.deepEqual(hintBold, [], "a passive pin advertises no shortcut keys");
  unfocused.view.dispose();
});

test("context footer keeps dim hint bodies without changing qualifier tones", (t) => {
  const { view } = mountContext({ theme: ansiTheme });
  t.after(() => view.dispose());
  const footer = view.render(80).at(-1);
  assertAnsiStyle(footer, "≈ raw estimates", [36]);
  assertAnsiStyle(footer, "n", [1, 36]);
  assertAnsiStyle(footer, "ote", [2, 37]);
  view.handleInput("n");
  const noteFooter = view.render(80).at(-1);
  assertAnsiStyle(noteFooter, "≈ raw estimates", [2, 37]);
  assertAnsiStyle(noteFooter, "Esc", [1, 36]);
  assertAnsiStyle(noteFooter, "back", [2, 37]);
});

test("stats tab labels keep their numeric keys inline", () => {
  const theme = recordingTheme();
  const { lines } = mountStats({ theme });
  const tabs = lines()[1];
  assert.ok(tabs?.includes("1 Overview"));
  assert.ok(tabs?.includes("2 Models"));
  assert.ok(tabs?.includes("3 Tools"));
  assert.deepEqual(keycaps(tabs), []);
  for (const digit of ["1", "2", "3"]) assert.ok(bolded(theme, digit), `${digit} is a key`);
  assert.ok(colored(theme, "accent", "1"), "the selected digit keeps its accent");
  assert.ok(colored(theme, "muted", " Models"), "an unselected label stays muted");
});

test("stats keeps selected markers and label bold, with only its digit underlined", (t) => {
  const { view } = mountStats({ theme: ansiTheme });
  t.after(() => view.dispose());
  const tabs = view.render(80)[1];
  assertAnsiStyle(tabs, "›", [1, 36, 44]);
  assertAnsiStyle(tabs, "1", [1, 4, 36, 44]);
  assertAnsiStyle(tabs, " Overview‹", [1, 36, 44]);
  assertAnsiStyle(tabs, "2", [1, 36]);
  assertAnsiStyle(tabs, " Models", [90]);
});

test("stats footer keeps dim labels with bold accent keys in both chrome modes", (t) => {
  const original = borderLabelsEnabled();
  t.after(() => setBorderLabelsEnabled(original));
  for (const enabled of [true, false]) {
    setBorderLabelsEnabled(enabled);
    const { view } = mountStats({ theme: ansiTheme });
    const footer = view.render(80).at(enabled ? -1 : -2);
    view.dispose();
    for (const key of ["1-3/Tab", "↑↓ PgUp/PgDn", "Esc"]) assertAnsiStyle(footer, key, [1, 36]);
    for (const label of ["view", "scroll", "close"]) assertAnsiStyle(footer, label, [2, 37]);
  }
});

test("stats footer keeps its explicit ladder wording at every width", () => {
  const wide = mountStats();
  const wideRows = wide.lines();
  assert.ok(
    wideRows.at(-1)?.includes("1-3/Tab view · ↑↓ PgUp/PgDn scroll · Esc close"),
    wideRows.at(-1),
  );
  wide.view.dispose();

  // Narrower terminals drop whole hint groups, never part of one.
  const narrow = mountStats();
  const narrowRows = narrow.lines(60);
  const footer = narrowRows.at(-1);
  assert.ok(footer?.includes("Tab · ↑↓ · Esc") || footer?.includes("Esc"), footer);
  assert.ok(!footer?.includes("PgUp"), "the long group is replaced, not clipped");
  assert.deepEqual(keycaps(footer), []);
  narrow.view.dispose();
});

test("styled hints keep panel rows at their exact painted width", () => {
  const context = new ContextView({
    theme: ansiTheme,
    snapshot: contextSnapshot,
    availableRows: () => 30,
    requestRender: () => {},
    close: () => {},
    isFocused: () => true,
  });
  for (const [index, row] of context.render(80).entries())
    assert.equal(visibleWidth(row), 80, `context row ${index}`);
  context.dispose();

  const stats = new StatsView({
    tui: { terminal: { rows: 24 }, requestRender: () => {} },
    theme: ansiTheme,
    snapshot: statsSnapshot,
    close: () => {},
  });
  for (const [index, row] of stats.render(80).entries())
    assert.equal(visibleWidth(row), 80, `stats row ${index}`);
  stats.dispose();

  const approval = new ApprovalPopover({
    theme: ansiTheme,
    choices: () => choices,
    current: () => "manual",
    warning: () => undefined,
    choose: () => {},
    save: () => {},
    canSaveWorkspace: () => true,
    saveScope: () => "session",
    close: () => {},
    requestRender: () => {},
  });
  for (const [index, row] of approval.render(72).entries())
    assert.equal(visibleWidth(row), 72, `approval row ${index}`);
  approval.dispose();
});
