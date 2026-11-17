import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { shortcutHint } from "../../src/shared/shortcut-hint.mjs";

const theme = {
  fg: (color, text) =>
    `\x1b[${color === "accent" ? 36 : color === "warning" ? 33 : 90}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const hotkey = (text) => theme.fg("accent", theme.bold(text));

test("mnemonics highlight one existing letter without duplication or width changes", () => {
  for (const [label, key, letter] of [
    ["message", "M", "m"],
    ["stop", "s", "s"],
    ["workspace default", "W", "w"],
    ["Info", "i", "I"],
    ["Expand tools", "t", "t"],
    ["1 Overview", "1", "1"],
    ["İ · message", "m", "m"],
    ["代理 👩‍💻 message", "m", "m"],
  ]) {
    const painted = shortcutHint(theme, label, key);
    assert.equal(stripTerminalSequences(painted), label);
    assert.equal(visibleWidth(painted), visibleWidth(label));
    assert.ok(painted.includes(hotkey(letter)), painted);
    assert.equal(painted.split("\x1b[1m").length - 1, 1);
  }
});

test("a mnemonic inside a grapheme cluster is highlighted atomically", () => {
  // `e` + combining acute is one grapheme: the emphasis must wrap the whole
  // cluster, never split the combining mark into its own ANSI span.
  const label = "e\u0301mail";
  const painted = shortcutHint(theme, label, "e");
  assert.equal(stripTerminalSequences(painted), label);
  assert.equal(visibleWidth(painted), visibleWidth(label));
  assert.ok(painted.includes(hotkey("e\u0301")), JSON.stringify(painted));
  assert.ok(
    !painted.includes(theme.bold("e") + "\u0301"),
    "the combining mark stays inside the bold span",
  );
  assert.equal(painted.split("\x1b[1m").length - 1, 1);
});

test("chords, punctuation and unmatched letters stay explicit, without keycaps", () => {
  for (const [label, key] of [
    ["close", "Esc"],
    ["send", "Enter"],
    ["confirm stop", "Ctrl+S"],
    ["view", "Tab"],
    ["scroll", "↑↓"],
    ["more", "."],
    ["Settings", "P"],
  ]) {
    const painted = shortcutHint(theme, label, key);
    assert.equal(stripTerminalSequences(painted), `${key} ${label}`);
    assert.ok(painted.startsWith(hotkey(key)), painted);
    assert.equal(visibleWidth(painted), visibleWidth(`${key} ${label}`));
  }
  assert.equal(shortcutHint(theme, "", "Esc"), hotkey("Esc"));
});

test("click-only labels never advertise a swallowed or unavailable key", () => {
  for (const key of [undefined, ""]) {
    const painted = shortcutHint(theme, "stop", key);
    assert.equal(painted, theme.fg("muted", "stop"));
    assert.ok(!painted.includes("\x1b[1m"));
  }
});

test("semantic body and shortcut colors remain independently selectable", () => {
  const painted = shortcutHint(theme, "stop", "s", { color: "warning", keyColor: "warning" });
  assert.equal(painted, theme.fg("warning", theme.bold("s")) + theme.fg("warning", "top"));
});
