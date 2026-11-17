import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  detailEntry,
  detailView as view,
  fgCall,
  plainTheme as theme,
  recordingTheme as recording,
  sgrTheme,
} from "../support/detail-fixture.mjs";

// Direct source tests for the selected agent tab's style: selection is the
// nickname's own accent+bold+underline -- never a background fill -- while
// the lifecycle glyph and the attention markers keep their semantic colours.
// Pane integration and clipped-warning regressions live in their own lanes;
// these hold the style contract at the helper seam, without a build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderDetailAgentStrip, renderDetailFooter } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);

const entry = (id, extra) => detailEntry(view(id, extra));
const strip = (overrides = {}) =>
  renderDetailAgentStrip({
    entries: [entry("aspen"), entry("birch")],
    selected: "aspen",
    width: 40,
    spinnerFrame: 0,
    theme,
    ...overrides,
  });

const styledTexts = (calls, kind) =>
  calls.filter((call) => call[0] === kind).map((call) => call.at(-1));
const noBg = (calls, where) =>
  assert.deepEqual(
    calls.filter(([kind]) => kind === "bg"),
    [],
    `${where}: the render never asks for a background fill`,
  );

test("the selected tab never asks the theme for a background, even one it has", () => {
  const rec = recording();
  strip({ theme: rec.theme });
  const frame = renderDetailFooter({
    width: 60,
    entries: [entry("aspen"), entry("birch")],
    selected: "aspen",
    below: 0,
    view: view("aspen"),
    available: true,
    confirming: false,
    messaging: true,
    spinnerFrame: 0,
    theme: rec.theme,
    framed: false,
  });
  assert.ok(frame.text.includes("aspen"), frame.text);
  noBg(rec.calls, "strip and footer");
  // A host theme whose bg throws: the render must survive it untouched.
  const throwing = {
    fg: (_color, text) => text,
    bold: (text) => text,
    underline: (text) => `~${text}~`,
    bg: () => {
      throw new Error("theme.bg must never be called");
    },
  };
  assert.match(strip({ theme: throwing }).text, /~aspen~/);
  renderDetailFooter({
    width: 60,
    entries: [entry("aspen"), entry("birch")],
    selected: "aspen",
    below: 0,
    view: view("aspen"),
    available: true,
    confirming: false,
    messaging: true,
    spinnerFrame: 0,
    theme: throwing,
    framed: true,
  });
});

test("selection underlines the nickname alone, closed inside the tab's own columns", () => {
  const styled = strip({ theme: sgrTheme });
  const plain = strip({ theme });
  // Styling adds zero columns: the tabs keep their exact padding and width,
  // and a theme without the helpers stays pure text with no ANSI at all.
  assert.ok(!plain.text.includes("\u001b["), plain.text);
  assert.equal(visibleWidth(styled.text), visibleWidth(plain.text));
  assert.equal(stripTerminalSequences(styled.text), stripTerminalSequences(plain.text));
  // Exactly one underline, opened on the nickname and closed again before the
  // padding: the wrapped span is the name alone, never the glyph or a peer.
  assert.equal(styled.text.split("\u001b[4m").length - 1, 1, styled.text);
  const open = styled.text.indexOf("\u001b[4m");
  const close = styled.text.indexOf("\u001b[24m", open);
  assert.ok(close > open, "the underline is closed");
  assert.equal(
    stripTerminalSequences(styled.text.slice(open, close + "\u001b[24m".length)),
    "aspen",
    "only the nickname is underlined",
  );
  assert.ok(styled.text.includes("\u001b[1m"), "the nickname is bold");
  // The same paint through a recording theme: accent+bold+underline reach the
  // selected nickname only, the peer keeps its muted name.
  const rec = recording();
  strip({ theme: rec.theme });
  assert.deepEqual(styledTexts(rec.calls, "underline"), ["aspen"]);
  assert.deepEqual(styledTexts(rec.calls, "bold"), ["aspen"]);
  assert.ok(fgCall(rec.calls, "accent", "aspen"), JSON.stringify(rec.calls));
  assert.ok(fgCall(rec.calls, "muted", "birch"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "accent", "birch"), "the peer is not accented");
  noBg(rec.calls, "strip");
});

test("the lifecycle glyph and attention markers keep their own colours", () => {
  const rec = recording();
  const { text } = renderDetailAgentStrip({
    entries: [
      entry("aspen", {
        history_error: "history unavailable",
        outcome: { status: "needs_input", question: "Which branch?", limit_reached: false },
      }),
      entry("birch"),
    ],
    selected: "aspen",
    width: 40,
    spinnerFrame: 0,
    theme: rec.theme,
  });
  assert.match(text, /✓ aspen \?!/, text);
  // The glyph keeps its lifecycle colour; a question is warning-coloured and
  // an ordinary warning `!` is warning-coloured too.
  assert.ok(fgCall(rec.calls, "success", "✓"), JSON.stringify(rec.calls));
  assert.ok(fgCall(rec.calls, "warning", "?"), JSON.stringify(rec.calls));
  assert.ok(fgCall(rec.calls, "warning", "!"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "error", "!"), "a warning is not painted as an error");
  // Selection styling touches the nickname alone: the markers are neither
  // underlined, bolded nor repainted with the selection's accent.
  assert.deepEqual(styledTexts(rec.calls, "underline"), ["aspen"]);
  assert.deepEqual(styledTexts(rec.calls, "bold"), ["aspen"]);
  assert.ok(!fgCall(rec.calls, "accent", "?"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "accent", "!"), JSON.stringify(rec.calls));
  assert.ok(!fgCall(rec.calls, "success", "aspen"), "the name is not repainted as success");
  noBg(rec.calls, "strip");
});

test("an actual error `!` is error-coloured, a warning `!` is warning-coloured", () => {
  const error = recording();
  renderDetailAgentStrip({
    entries: [entry("aspen", { cleanup_errors: ["boom"] }), entry("birch")],
    selected: "aspen",
    width: 40,
    spinnerFrame: 0,
    theme: error.theme,
  });
  assert.ok(fgCall(error.calls, "error", "!"), JSON.stringify(error.calls));
  const warning = recording();
  renderDetailAgentStrip({
    entries: [entry("aspen", { history_error: "x" }), entry("birch")],
    selected: "aspen",
    width: 40,
    spinnerFrame: 0,
    theme: warning.theme,
  });
  assert.ok(fgCall(warning.calls, "warning", "!"), JSON.stringify(warning.calls));
  assert.ok(!fgCall(warning.calls, "error", "!"), JSON.stringify(warning.calls));
});

test("an unselected completed tab dims its glyph unless it has attention", () => {
  const clean = recording();
  renderDetailAgentStrip({
    entries: [entry("aspen"), entry("birch")],
    selected: "birch",
    width: 40,
    spinnerFrame: 0,
    theme: clean.theme,
  });
  // `aspen` is completed, unselected and unmarked: its glyph is background,
  // while the selected `birch` keeps the lifecycle colour.
  assert.ok(fgCall(clean.calls, "dim", "✓"), JSON.stringify(clean.calls));
  assert.ok(fgCall(clean.calls, "success", "✓"), JSON.stringify(clean.calls));
  // Attention keeps the lifecycle colour even when unselected.
  const marked = recording();
  renderDetailAgentStrip({
    entries: [entry("aspen", { history_error: "x" }), entry("birch")],
    selected: "birch",
    width: 40,
    spinnerFrame: 0,
    theme: marked.theme,
  });
  assert.ok(fgCall(marked.calls, "success", "✓"), JSON.stringify(marked.calls));
  assert.ok(!fgCall(marked.calls, "dim", "✓"), JSON.stringify(marked.calls));
});

test("narrow clipped tabs stay safe: bounded widths, semantic markers, no fill", () => {
  const warned = (id) => entry(id, { history_error: "x" });
  for (const width of [12, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const rec = recording();
    const painted = renderDetailAgentStrip({
      entries: [warned("aspen"), warned("birch")],
      selected: "aspen",
      width,
      spinnerFrame: 0,
      theme: rec.theme,
      framed: true,
    });
    const at = `${width}: ${painted.text}`;
    assert.equal(painted.clipped, true, `${width}: the clipped fallback`);
    assert.ok(visibleWidth(painted.text) <= width, at);
    noBg(rec.calls, `${width}`);
    // Whatever survives clipping keeps its semantics: the glyph its lifecycle
    // colour, a painted marker its warning/error colour.
    assert.ok(fgCall(rec.calls, "success", "✓"), `${width}: ${JSON.stringify(rec.calls)}`);
    assert.ok(!fgCall(rec.calls, "accent", "✓"), `${width}: the glyph keeps its colour`);
    if (painted.markerVisible) {
      assert.ok(fgCall(rec.calls, "warning", "!"), `${width}: ${JSON.stringify(rec.calls)}`);
      assert.ok(!fgCall(rec.calls, "error", "!"), `${width}: a warning is not an error`);
      assert.ok(!fgCall(rec.calls, "accent", "!"), `${width}: the marker keeps its colour`);
    }
    // Selection styling wraps only what is painted of the name -- a prefix,
    // possibly ellipsized by clipping -- or, at glyph-only widths, the glyph
    // alone. It never reaches the padding, the marker or the peer.
    for (const styled of styledTexts(rec.calls, "underline")) {
      const core = styled.endsWith("…") ? styled.slice(0, -1) : styled;
      assert.ok(
        styled === "✓" || "aspen".startsWith(core),
        `${width}: unexpected underline target ${JSON.stringify(styled)}`,
      );
    }
  }
});

test("hidden peers keep their +N, ?q and !w counts, unstyled and exact", () => {
  const rec = recording();
  const question = {
    status: "needs_input",
    question: "Q?",
    limit_reached: false,
  };
  const entries = [
    entry("q1", { outcome: question }),
    entry("w1", { history_error: "x" }),
    entry("q2", { outcome: question }),
    entry("w2", { history_error: "x" }),
    entry("w3", { history_error: "x" }),
    entry("sel"),
  ];
  const { text } = renderDetailAgentStrip({
    entries,
    selected: "sel",
    width: 20,
    spinnerFrame: 0,
    theme: rec.theme,
  });
  assert.ok(visibleWidth(text) <= 20, text);
  assert.match(text, /sel/, "the selected tab is always painted");
  // Every hidden peer is counted once, with its own attention counts: two
  // questions and three warnings behind one summary.
  const summaries = text.match(/\+\d+(?: \?\d+)?(?: !\d+)?/g) ?? [];
  assert.ok(summaries.length > 0, text);
  const count = (pattern) =>
    summaries.reduce((sum, s) => {
      const matched = s.match(pattern);
      return sum + (matched ? Number(matched[1]) : 0);
    }, 0);
  assert.equal(count(/\+(\d+)/), 5, text);
  assert.equal(count(/\?(\d+)/), 2, text);
  assert.equal(count(/!(\d+)/), 3, text);
  // The summary is dim chrome: no selection styling or fill reaches it.
  assert.ok(fgCall(rec.calls, "dim", " +5 ?2 !3 "), JSON.stringify(rec.calls));
  assert.deepEqual(styledTexts(rec.calls, "underline"), ["sel"]);
  noBg(rec.calls, "strip");
});

test("neither edge paints a divider between the tabs' own padding", () => {
  for (const framed of [true, false]) {
    const rec = recording();
    const { text } = strip({ framed, theme: rec.theme });
    assert.ok(!text.includes("|"), `${framed}: ${text}`);
    assert.ok(!text.includes("\u2502") && !text.includes("\u2500"), text);
    assert.deepEqual(
      rec.calls.filter(([, , t]) => t === "|"),
      [],
      `${framed}: ${JSON.stringify(rec.calls)}`,
    );
    noBg(rec.calls, `${framed}`);
  }
});

test("a theme without an underline helper degrades to accent+bold", () => {
  const degraded = {
    fg: (color, text) => (color === "accent" ? `<${text}>` : text),
    bold: (text) => `*${text}*`,
  };
  const { text } = strip({ theme: degraded });
  assert.ok(!text.includes("\u001b["), "no ANSI is invented without helpers");
  assert.doesNotMatch(text, /~/, "no underline is invented without the helper");
  // The selected nickname is still accented and bold.
  assert.match(text, /\*<aspen>\*/, text);
  assert.ok(text.includes("birch"), text);
  assert.doesNotMatch(text, /<birch>/, "the peer keeps its plain muted name");
});
