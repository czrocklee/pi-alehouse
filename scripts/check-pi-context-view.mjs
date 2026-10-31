#!/usr/bin/env node
// Focused pure-view regressions; pinned development SDK, synthetic metadata,
// no sessions, provider requests, runtime generation or filesystem fixtures.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { colorToRgb, matchesKey, mixColors, setKeybindings, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "../lib/token-format.mjs";

const root = join(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { ContextView } = await jiti.import(join(root, "extensions/lib/context-view.ts"));
const { collectContextSnapshot } = await jiti.import(join(root, "extensions/lib/context-stats.ts"));
const { buildSessionProjection } = await import("@earendil-works/pi-coding-agent");
// Import just the public Theme implementation, not an SDK session/runtime.
const { Theme } = await import(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "modes/interactive/theme/theme.js"));
const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { CustomEditor } = await import(join(sdk, "modes/interactive/components/custom-editor.js"));
const { KeybindingsManager } = await import(join(sdk, "core/keybindings.js"));
const theme = { fg: (_tone, text) => text, bold: (text) => text };
const ids = ["system", "summary", "messages", "tools", "other"];
const labels = ["System", "Summary", "Messages", "Tools", "Other"];

function snapshot(overrides = {}) {
  const categories = ids.map((id, index) => ({ id, label: labels[index], rawTokens: 2000, tokens: 1000, count: 1 }));
  return {
    usage: { tokens: 5000, contextWindow: 10000, percent: 50 }, rawTokens: 10000, categories,
    items: categories.map((category) => ({ ...category, id: `item:${category.id}`, category: category.id,
      label: `${category.label} source`, kind: "metadata", rawState: category.id === "other" ? "not-applicable" : "estimate",
      detail: ["Safe metadata", "No prompt text"] })),
    updatedAt: 0, calibrated: true, allocation: "proportional", attribution: "complete", replay: "selected",
    note: "proportional estimates", ...overrides,
  };
}
function mount({ data = snapshot(), rows = 30, paintTheme = theme, compaction, failSnapshot = false, focused = false, isFocused } = {}) {
  let renders = 0, closes = 0, measured = -1;
  const view = new ContextView({ theme: paintTheme, snapshot: () => { if (failSnapshot) throw Error("SECRET ERROR"); return data; }, availableRows: () => rows,
    requestRender: () => { renders++; }, close: () => { closes++; }, onRender: (height) => { measured = height; }, compaction,
    isFocused: isFocused ?? (() => focused) });
  return { view, get data() { return data; }, set data(value) { data = value; },
    get rows() { return rows; }, set rows(value) { rows = value; },
    get focused() { return focused; }, set focused(value) { focused = value; },
    get renders() { return renders; }, get closes() { return closes; }, get measured() { return measured; } };
}
function paint(mounted, width = 96) {
  const lines = mounted.view.render(width);
  for (const line of lines) assert.equal(visibleWidth(line), Math.max(0, Math.floor(width)), plain(line));
  assert(lines.length <= Math.min(9, Math.max(0, mounted.rows)));
  assert.equal(mounted.measured, lines.length);
  return lines.map(plain);
}
const text = (mounted, width = 96) => paint(mounted, width).join("\n");
const click = (mounted, x, y, width = 96) => mounted.view.handleMouse({ type: "click", button: "left", x, y, width, height: 9 });
function tab(mounted, label, width = 96) {
  const top = paint(mounted, width)[0];
  const x = top.indexOf(label);
  assert(x >= 0, top);
  assert.deepEqual(click(mounted, x, 0, width), { handled: true });
}
function many(category = "system", amount = 20) {
  return snapshot({ items: Array.from({ length: amount }, (_, index) => ({
    id: `row-${index}`, category, label: `source-${String(index).padStart(2, "0")}`, kind: "file", rawTokens: amount - index, rawState: "estimate",
    tokens: amount - index, count: 1, detail: ["Metadata-only path: 界/é/🦊.ts", ...Array.from({ length: 12 }, (_, i) => `safe detail ${i}`)],
  })) });
}
function realTheme(appearance, mode = "truecolor") {
  const fg = { accent: appearance === "dark" ? "#70c0ff" : "#004060", text: appearance === "dark" ? "#ffffff" : "#101010",
    muted: "#888888", dim: "#777777", borderAccent: "#777777", borderMuted: "#777777", thinkingXhigh: "#888888" };
  const bg = { userMessageBg: appearance === "dark" ? "#101010" : "#ffffff", selectedBg: "#888888" };
  return new Theme(fg, bg, mode, { appearance });
}

test("compact fixed-height frame, title/tabs in top edge; width preference never follows long paths", () => {
  const m = mount();
  const lines = paint(m);
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^╭─ Context  System  Summary  Messages  Tools /);
  assert.doesNotMatch(lines[0], /All|Other/);
  assert.match(lines.at(-1), /≈ proportional estimates/);
  assert.match(lines[2], /Source +Kind +≈tok +%used/);
  assert.match(lines[1], /5\.0k\/10k · 50\.0%/);
  assert.match(lines.join("\n"), /Other \(unattributed\)/);
  assert.equal(m.view.preferredWidth(500), 96);
  m.data = snapshot({ items: [{ ...snapshot().items[0], label: "path/".repeat(1000) }] });
  assert.equal(m.view.preferredWidth(500), 96);
  assert.equal(m.view.preferredWidth(37), 37);
});

test("bar cells use the remaining width and fixed SDK figures take priority", () => {
  const m = mount();
  const counts = [64, 80, 96, 125].map((width) => {
    const line = paint(m, width)[1];
    assert.match(line, /5\.0k\/10k · 50\.0%/);
    return (line.match(/[█░]/g) ?? []).length;
  });
  assert.deepEqual(counts.slice(1).map((value, index) => value - counts[index]), [16, 16, 29]);
  const compact = mount({ compaction: () => "auto compact" });
  assert.match(paint(compact)[1], /auto compact/);
  assert.equal(paint(compact).length, 9);
  tab(compact, "Tools");
  assert.match(paint(compact)[1], /auto compact/, "global compaction status remains visible on every category");
});

test("selection changes only bar styling and item list, not segment lengths or total denominator", () => {
  const styles = [];
  const t = realTheme("dark");
  const original = t.style.bind(t);
  t.style = (value, options) => { if (/^█+$/.test(value)) styles.push({ value, ...options }); return original(value, options); };
  const m = mount({ paintTheme: t });
  const before = m.view.render(96)[1];
  const segments = styles.splice(0).map(({ value }) => value.length);
  tab(m, "System"); styles.length = 0;
  const after = m.view.render(96)[1];
  assert.equal(plain(after), plain(before));
  assert.notEqual(after.replace(/\x1b\[(?:1|22)m/g, ""), before.replace(/\x1b\[(?:1|22)m/g, ""),
    "System selection must emphasize its segment via relative foreground contrast, not bold alone");
  assert.deepEqual(styles.map(({ value }) => value.length), segments);
  assert(styles[0].bold && !styles[1].bold);
  assert.match(text(m), /System source +metadata +1\.0k +20\.0%/);
  assert.doesNotMatch(text(m), /Tools source/);
});

test("category alpha tiers are identity-stable, adapt to dark/light and never use the free tier", () => {
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const t = realTheme(appearance, mode);
    const seen = [], free = [];
    const style = t.style.bind(t), fg = t.fg.bind(t);
    t.style = (value, options) => { if (/^█+$/.test(value)) seen.push(options.fg); return style(value, options); };
    t.fg = (tone, value) => { if (/^░+$/.test(value)) free.push(tone); return fg(tone, value); };
    const m = mount({ paintTheme: t });
    const lines = m.view.render(96);
    const colors = seen.slice(0, 5).map(colorToRgb);
    assert.equal(new Set(colors.map(JSON.stringify)).size, 5);
    assert.deepEqual(free, ["dim"]);
    const brightness = colors.map(({ r, g, b }) => r + g + b);
    for (let i = 1; i < 5; i++) assert(appearance === "dark" ? brightness[i] < brightness[i - 1] : brightness[i] > brightness[i - 1]);
    const bar = lines[1];
    const coloredSegments = [...bar.matchAll(/\x1b\[([^m]+)m([█░]+)/g)];
    assert.equal(coloredSegments.length, 6, bar);
    assert(coloredSegments.slice(0, 5).every((match) => match[1] !== coloredSegments[5][1]), "used is visibly separate from free even after quantization");
    const before = colors[3];
    m.data = snapshot({ categories: snapshot().categories.map((c) => c.id === "summary" ? { ...c, rawTokens: 0, tokens: 0, count: 0 } : c) });
    seen.length = 0; m.view.render(96);
    assert.deepEqual(colorToRgb(seen[2]), before, "Tools tier must not shift when Summary is hidden");
  }
});

test("every selected category reaches full alpha, System selection dims peers above the free tier", () => {
  const alpha = [1, 0.86, 0.72, 0.58, 0.44];
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const t = realTheme(appearance, mode), seen = [];
    const style = t.style.bind(t);
    t.style = (value, options) => {
      const rendered = style(value, options);
      if (/^█+$/.test(value)) seen.push({ value, fg: options.fg, rendered });
      return rendered;
    };
    const m = mount({ paintTheme: t });
    const baseline = m.view.render(96)[1];
    const baselineColors = seen.splice(0).map(({ fg }) => colorToRgb(fg));
    const freeColor = t.fg("dim", "░").match(/\x1b\[(38;[^m]+)m/)[1];
    for (let selected = 0; selected < 4; selected++) {
      tab(m, labels[selected]); seen.length = 0;
      const bar = m.view.render(96)[1];
      assert.equal(plain(bar), plain(baseline));
      for (let index = 0; index < 5; index++) {
        const expected = index === selected ? 1 : Math.max(0.44, alpha[index] * 0.75);
        assert.deepEqual(colorToRgb(seen[index].fg), colorToRgb(mixColors(t.colors.userMessageBg, t.colors.accent, expected, "srgb")));
        assert.notEqual(seen[index].rendered.match(/\x1b\[(38;[^m]+)m/)[1], freeColor,
          `${appearance}/${mode}/${ids[selected]}: every occupied segment remains distinct from free`);
      }
      if (selected === 0) {
        assert.deepEqual(colorToRgb(seen[0].fg), baselineColors[0]);
        assert.notDeepEqual(colorToRgb(seen[1].fg), baselineColors[1], "System emphasis changes peer colors, not just bold");
      }
    }
    tab(m, "Context"); seen.length = 0; m.view.render(96);
    assert.deepEqual(seen.map(({ fg }) => colorToRgb(fg)), baselineColors, "overview restores identity-fixed alpha tiers");
  }
});

test("overview compares raw estimates with SDK-scaled totals without a new row or clipped figures", () => {
  const data = snapshot({ rawTokens: 185000, usage: { tokens: 202000, contextWindow: 404000, percent: 50 } });
  const m = mount({ data });
  let lines = paint(m);
  assert.equal(lines.length, 9);
  assert.match(lines.at(-1), /≈ proportional estimates · raw 185k → SDK 202k/);
  const paged = mount({ data: { ...data, items: many().items } });
  lines = paint(paged);
  click(paged, lines.at(-1).indexOf("Next"), 8);
  lines = paint(paged);
  assert.match(lines.at(-1), /Prev.*Next.*≈ proportional estimates · raw 185k → SDK 202k/);
  for (const width of [28, 32, 48, 64, 80]) {
    const footer = paint(paged, width).at(-1);
    assert.match(footer, /≈(?:scaled| scaled estimates| proportional estimates)/);
    if (footer.includes("raw")) assert.match(footer, /raw 185k → SDK 202k/, "the numeric comparison is included whole or omitted whole");
    else assert.doesNotMatch(footer, /185|202/);
  }
  const narrowFooter = paint(paged, 28).at(-1);
  assert.match(narrowFooter, /‹.*›.*≈scaled/);
  click(paged, narrowFooter.indexOf("›"), 8, 28);
  assert.match(paint(paged, 28).at(-1), /11-15\/21.*≈scaled/);
  tab(m, "System"); assert.doesNotMatch(paint(m).at(-1), /raw 185k/);
});

test("missing concrete theme colors fall back to semantic used colors, never dim free", () => {
  const calls = [];
  const m = mount({ paintTheme: { ...theme, fg: (tone, value) => { calls.push({ tone, value }); return value; } } });
  paint(m);
  assert.equal(calls.filter(({ value }) => /^█+$/.test(value)).length, 5);
  assert(calls.filter(({ value }) => /^█+$/.test(value)).every(({ tone }) => tone !== "dim"));
  assert(calls.some(({ tone, value }) => tone === "dim" && /^░+$/.test(value)));
});

test("zero tabs hide; System first; selected category becoming zero returns to overview", () => {
  const m = mount();
  tab(m, "Summary");
  assert.match(paint(m)[0], /›Summary‹/);
  m.data = snapshot({ categories: [...snapshot().categories].reverse().map((c) => c.id === "summary" ? { ...c, rawTokens: 0, tokens: 0, count: 0 } : c) });
  const lines = paint(m);
  assert.match(lines[0], /Context  System  Messages  Tools/);
  assert.doesNotMatch(lines[0], /Summary|›|All|Other/);
  // Counted metadata is not hidden merely because its raw text is zero.
  m.data = snapshot({ categories: snapshot().categories.map((c) => c.id === "summary" ? { ...c, rawTokens: 0 } : c) });
  assert.match(paint(m)[0], /Summary/);
});

test("whole padded tabs click; hover does not select; title returns to overview", () => {
  for (const padding of [-1, "Tools".length]) {
    const m = mount();
    const top = paint(m)[0], at = top.indexOf("Tools");
    assert.equal(m.view.handleMouse({ type: "move", x: at, y: 0, width: 96, height: 9 }), undefined);
    assert.doesNotMatch(paint(m)[0], /›/);
    click(m, at + padding, 0);
    assert.match(paint(m)[0], /›Tools‹/);
    click(m, paint(m)[0].indexOf("Context"), 0);
    assert.doesNotMatch(paint(m)[0], /›/);
    assert.match(text(m), /Other \(unattributed\)/);
  }
});

test("initial token sorting, stable numeric refresh order/scroll anchor, tab changes may re-sort", () => {
  const m = mount({ data: many() }); tab(m, "System");
  let lines = paint(m);
  assert(lines[3].includes("source-00") && lines[4].includes("source-01"));
  let bottom = lines.at(-1);
  click(m, bottom.indexOf("Next"), lines.length - 1);
  lines = paint(m);
  assert.match(lines[3], /source-05/);
  m.data = { ...m.data, items: m.data.items.map((row, i) => ({ ...row, tokens: i * 10000 })) };
  assert.match(paint(m)[3], /source-05/, "numeric refresh does not reorder");
  m.data = { ...m.data, items: m.data.items.filter((row) => row.id !== "row-0") };
  assert.match(paint(m)[3], /source-05/, "removal above the viewport preserves its row identity");
  tab(m, "Tools"); tab(m, "System");
  assert.match(paint(m)[3], /source-19/, "changing category allows fresh descending token order");
  bottom = paint(m).at(-1);
  assert.match(bottom, /1-5\/19/);
});

test("Prev/Next page only visible ranges; keyboard/wheel navigate and clamp", () => {
  const m = mount({ data: many() }); tab(m, "System");
  let lines = paint(m);
  assert.match(lines.at(-1), /1-5\/20.*Next/);
  assert.doesNotMatch(lines.at(-1), /Prev/);
  click(m, lines.at(-1).indexOf("Next") - 1, lines.length - 1);
  lines = paint(m); assert.match(lines.at(-1), /6-10\/20.*Prev.*Next/);
  click(m, lines.at(-1).indexOf("Prev") + 4, lines.length - 1);
  assert.match(paint(m).at(-1), /1-5\/20/);
  m.view.handleInput("\x1b[6~"); assert.match(paint(m).at(-1), /6-10\/20/);
  m.view.handleInput("\x1b[5~"); assert.match(paint(m).at(-1), /1-5\/20/);
  m.view.handleMouse({ type: "wheel", wheelDelta: 999, x: 3, y: 4, width: 96, height: 9 });
  lines = paint(m); assert.match(lines.at(-1), /16-20\/20.*Prev/); assert.doesNotMatch(lines.at(-1), /Next/);
  m.view.handleInput("\x1b[A"); assert.match(paint(m).at(-1), /16-20\/20/);
});

test("item metadata details replace the body without growing height, Esc returns then closes", () => {
  const m = mount({ data: many(), focused: true }); tab(m, "System");
  const before = paint(m); click(m, 10, 3);
  let lines = paint(m);
  assert.equal(lines.length, before.length);
  assert.match(lines[2], /source-00/);
  assert.match(lines.join("\n"), /not provider token accounting/);
  assert.match(lines.at(-1), /Next.*Esc back/);
  click(m, lines.at(-1).indexOf("Next"), lines.length - 1);
  lines = paint(m); assert.equal(lines.length, before.length); assert.match(lines.join("\n"), /safe detail/);
  m.view.handleInput("\x1b"); assert.match(paint(m)[2], /Source +Kind/); assert.equal(m.closes, 0);
  m.view.handleInput("\x1b"); assert.equal(m.closes, 1);
});

test("focused keyboard categories/selection/details and printable input never dismiss", () => {
  const m = mount({ data: many(), focused: true }); paint(m);
  m.view.handleInput("\t"); assert.match(paint(m)[0], /›System‹/);
  m.view.handleInput("\x1b[C"); assert.match(paint(m)[0], /›Summary‹/);
  m.view.handleInput("\x1b[D"); assert.match(paint(m)[0], /›System‹/);
  m.view.handleInput("\x1b[B"); paint(m); m.view.handleInput("\r");
  assert.match(paint(m)[2], /source-01/);
  m.view.handleInput("ordinary typing"); assert.equal(m.closes, 0);
  m.view.handleInput("\x1b"); paint(m); m.view.handleInput("\x1b[Z");
  assert.doesNotMatch(paint(m)[0], /›/);
});

test("tab changes retire unpainted row activation until repaint; Esc and painted navigation still work", () => {
  for (const pointer of [false, true]) {
    const m = mount(); tab(m, "System");
    const system = paint(m);
    if (pointer) click(m, system[0].indexOf("Summary"), 0);
    else m.view.handleInput("\x1b[C");
    const renders = m.renders;
    m.view.handleInput("\r");
    assert.equal(m.renders, renders, "Enter must not open the previous tab's stale row before repaint");
    assert.equal(click(m, 5, 3), undefined, "previously painted row targets are retired too");
    const summary = paint(m);
    assert.match(summary[0], /›Summary‹/);
    assert.match(summary[2], /Source +Kind/);
    m.view.handleInput("\r");
    assert.match(paint(m)[2], /Summary source/, "a fresh paint restores row activation");
    m.view.handleInput("\x1b"); paint(m);
    m.view.handleInput("\x1b[D");
    m.view.handleInput("\r");
    m.view.handleInput("\x1b");
    assert.equal(m.closes, 1, "Esc still closes immediately while waiting for the next paint");
  }
  const m = mount({ data: many() }); tab(m, "System"); paint(m);
  for (let index = 1; index <= 3; index++) {
    m.view.handleInput("\x1b[B"); paint(m);
  }
  m.view.handleInput("\r");
  assert.match(paint(m)[2], /source-03/, "successive native paints preserve ordinary keyboard navigation");
});

test("pinned Enter parsing accepts raw carriage return and opens the painted row's details", () => {
  assert.equal(matchesKey("\r", "enter"), true);
  assert.equal(matchesKey("\r", "return"), true, "the pinned SDK also supports the old alias");
  const m = mount(); tab(m, "System");
  const before = paint(m);
  assert.match(before[2], /Source +Kind/);
  m.view.handleInput("\r");
  const after = paint(m);
  assert.equal(after.length, before.length);
  assert.match(after[2], /System source/);
  assert.match(after.join("\n"), /Safe metadata/);
  m.view.handleInput("\x1b");
  assert.match(paint(m)[2], /Source +Kind/);
  assert.equal(m.closes, 0);
});

test("overview lists safe source items, filters the same table by tab and opens item details directly", () => {
  const m = mount();
  assert.match(text(m), /System source/);
  assert.match(text(m), /Messages source/);
  const lines = paint(m), y = lines.findIndex((line) => line.includes("System source"));
  click(m, 5, y);
  assert.match(paint(m)[2], /System source/);
  assert.match(text(m), /Safe metadata/);
  m.view.handleInput("\x1b");
  tab(m, "Messages");
  assert.match(text(m), /Messages source/);
  assert.doesNotMatch(text(m), /System source|Other \(unattributed\)/);
});

test("narrow tab labels retain every live category and every padding cell stays clickable", () => {
  const m = mount();
  const top = paint(m, 28)[0];
  assert.match(top, / S  Σ  M  T /);
  click(m, top.indexOf(" T ") + 2, 0, 28);
  assert.match(paint(m, 28)[0], /›T‹/);
  assert.match(text(m, 28), /Tools source/);
});

test("resize, invalidation, empty paint and tiny readonly modes retire every old target", () => {
  const m = mount({ data: many() }); tab(m, "System");
  const before = paint(m), oldNext = before.at(-1).indexOf("Next");
  m.rows = 3; paint(m);
  const renders = m.renders;
  assert.equal(click(m, oldNext, 8), undefined);
  assert.equal(click(m, 91, 0), undefined);
  assert.equal(click(m, before[0].indexOf("Tools"), 0), undefined);
  assert.equal(m.renders, renders);
  m.rows = 30; paint(m); m.view.invalidate();
  assert.equal(click(m, 10, 3), undefined);
  paint(m); paint(m, 0); assert.equal(click(m, 10, 3), undefined);
  paint(m); const oldTools = paint(m)[0].indexOf("Tools"); paint(m, 32);
  assert.equal(click(m, oldTools, 0, 32), undefined);
  assert.equal(click(m, 29, 0, 96), undefined, "mismatching stale bounds cannot hit the new close tail");
  m.rows = 2;
  assert.equal(click(m, 29, 0, 32), undefined, "unpainted shrink cannot activate old controls");
});

test("a 9-to-6-row terminal or stack-budget shrink keeps the cursor painted and Enter actionable", () => {
  for (const page of [0, 1]) {
    const paintTheme = realTheme("dark");
    const m = mount({ rows: 9, data: many(), paintTheme });
    tab(m, "System"); paint(m);
    if (page) { m.view.handleInput("\x1b[6~"); paint(m); }
    for (let index = 0; index < 4; index++) { m.view.handleInput("\x1b[B"); paint(m); }
    const selected = `source-${String(page * 5 + 4).padStart(2, "0")}`;
    assert.match(paint(m)[7], new RegExp(selected), "cursor initially occupies the fifth body row");
    m.rows = 6; // availableRows also changes when another stack member takes space.
    let lines = paint(m);
    assert.equal(lines.length, 6);
    assert.match(lines[4], new RegExp(selected), "the reduced viewport must still paint the selected row");
    assert(m.view.render(96)[4].includes(paintTheme.getFgAnsi("accent") + selected), "the visible row retains its selection emphasis");
    const anchor = lines[3];
    m.data = { ...m.data, items: m.data.items.map((item, index) => ({ ...item, tokens: index * 1000 })) };
    lines = paint(m);
    assert.equal(lines[3].match(/source-\d+/)[0], anchor.match(/source-\d+/)[0], "numeric refresh preserves the new scroll anchor");
    m.rows = 9;
    assert.equal(paint(m)[3].match(/source-\d+/)[0], anchor.match(/source-\d+/)[0], "growing the viewport does not reset a still-valid anchor");
    m.rows = 6; paint(m); m.view.handleInput("\r");
    assert.match(paint(m)[2], new RegExp(selected), "raw Enter opens the selected item's details after resize");
  }
});

test("all narrow/short sizes are bounded, meaningful readonly fallback has no phantom actions", () => {
  const m = mount({ paintTheme: realTheme("dark"), data: many() });
  for (const width of [0, 1, 2, 3, 4, 8, 9, 12, 20, 27, 28, 32, 50, 96]) for (const rows of [0, 1, 2, 3, 4, 5, 6, 8, 9, 20]) {
    m.rows = rows;
    const lines = paint(m, width);
    if ((rows < 6 || width < 28) && lines.length) {
      assert.equal(click(m, Math.max(0, width - 3), 0, width), undefined);
      if (width > 20) assert.match(lines.join("\n"), /Context/);
    }
  }
});

test("five available rows are readonly; six rows restore visible interactive body and controls", () => {
  const m = mount({ rows: 5 });
  const fallback = paint(m);
  assert.equal(fallback.length, 3);
  assert.match(fallback.join("\n"), /readonly/);
  assert.equal(click(m, 15, 0), undefined);
  m.rows = 6;
  const full = paint(m);
  assert.equal(full.length, 6);
  assert.doesNotMatch(full.join("\n"), /readonly/);
  tab(m, "System"); paint(m); m.view.handleInput("\r");
  assert.match(paint(m)[2], /System source/);
});

test("optional table columns yield before digits; labels and metadata are terminal-safe", () => {
  const malicious = snapshot();
  malicious.items = [{ ...malicious.items[0], tokens: 123456789, label: "path\x1b[31m-界/é/🦊\nfile", kind: "meta\rdata",
    body: "SECRET BODY", detail: ["safe\x1b]8;;https://invalid\x07-meta\nnext"] }];
  const m = mount({ data: malicious }); tab(m, "System");
  assert.match(text(m), /path-界\/é\/🦊 file/);
  assert.doesNotMatch(text(m), /SECRET BODY|\x1b|https:\/\//);
  const tight = text(m, 28);
  assert.doesNotMatch(tight, /Kind|%used/);
  assert.match(tight, /123M/);
  click(m, 4, 3, 28); assert.match(text(m, 96), /safe-meta next/);
});

test("unknown totals remain unknown, with no fabricated 0% or free-window bar", () => {
  const data = snapshot({ usage: { tokens: null, contextWindow: 10000, percent: null }, calibrated: false, allocation: "raw" });
  data.categories = data.categories.map((c) => ({ ...c, tokens: null }));
  data.items = data.items.map((item) => ({ ...item, tokens: null }));
  const m = mount({ data });
  const lines = paint(m);
  assert.match(lines[1], /Usage unknown.*\?\/10k · \?/);
  assert.doesNotMatch(lines.join("\n"), /0\.0%|░|█/);
  assert.match(lines[2], /≈raw/); assert.doesNotMatch(lines[2], /%used|SDK tok/);
  tab(m, "System"); assert.match(paint(m)[3], /2\.0k/);
});

test("zero context window is unknown, never a displayed zero capacity or fabricated occupancy", () => {
  for (const tokens of [null, 5000]) for (const rows of [5, 30]) {
    const m = mount({ rows, data: snapshot({ usage: { tokens, contextWindow: 0, percent: 0 }, allocation: tokens === null ? "raw" : "proportional" }) });
    const lines = paint(m), rendered = lines.join("\n");
    assert.match(rendered, tokens === null ? /\?\/\? · \?/ : /5\.0k\/\? · \?/);
    assert.doesNotMatch(rendered, /\/0(?:\D|$)|(?:^|[^\d])0\.0%|█|░/);
    if (rows >= 6) {
      assert.match(lines[1], /Usage unknown/);
      tab(m, "Tools");
      assert.match(paint(m)[1], tokens === null ? /\?\/\? · \?/ : /5\.0k\/\? · \?/);
    }
  }
});

test("unattributed occupied usage remains used when all raw weights are absent", () => {
  const m = mount({ data: snapshot({ categories: [], items: [], allocation: "unattributed", attribution: "partial" }) });
  const lines = paint(m);
  assert.match(lines[1], /█+░+/);
  assert.match(lines[3], /No attributed context metadata/);
  assert.doesNotMatch(lines.at(-1), /Enter|↑↓|Tab/);
});

// Real compositor/input routing with an unstarted terminal. Explicit paints
// model the interval before the SDK's scheduled nextTick/animation frame.
function nativeTui() {
  const tui = new TuiAltScreen({ rows: 30, columns: 120, write() {}, hideCursor() {} }, false);
  tui.stopped = true;
  return tui;
}
function overlays(tui) {
  return tui.compositeOverlays(Array(tui.terminal.rows).fill(" ".repeat(tui.terminal.columns)), tui.terminal.columns, tui.terminal.rows);
}

test("passive native overlay never steals focus or advertises keys, including detail and focus transfer", () => {
  const tui = nativeTui();
  const keys = new KeybindingsManager(); // Defaults only, no user configuration.
  setKeybindings(keys);
  const editor = new CustomEditor(tui, { borderColor: (value) => value, selectList: {} }, keys);
  let escapes = 0, submits = 0;
  editor.onEscape = () => { escapes++; };
  editor.onSubmit = () => { submits++; };
  tui.setFocus(editor);
  let handle;
  const m = mount({ isFocused: () => handle?.isFocused() ?? false });
  handle = tui.showOverlay(m.view, { width: 96, nonCapturing: true });
  overlays(tui);
  assert.equal(tui.getFocusedComponent(), editor);
  assert.doesNotMatch(text(m), /↑↓|Enter|Tab|Esc|N note/);
  tui.handleTerminalInput("\x1b");
  editor.setText("synthetic draft"); tui.handleTerminalInput("\r");
  assert.equal(escapes, 1); assert.equal(submits, 1); assert.equal(m.closes, 0);
  click(m, 5, 3); paint(m);
  assert(m.view.detail);
  assert.doesNotMatch(text(m), /Esc back/);
  handle.focus(); overlays(tui);
  assert.match(text(m), /Esc back/);
  handle.unfocus(); overlays(tui);
  assert.equal(tui.getFocusedComponent(), editor);
  assert.doesNotMatch(text(m), /Esc|Enter|Tab|↑↓/);
  tui.handleTerminalInput("\x1b"); assert.equal(escapes, 2); assert(m.view.detail);
  handle.setHidden(true); m.view.invalidate();
  assert.equal(click(m, 5, 3), undefined);
  handle.setHidden(false); overlays(tui);
  assert.equal(tui.getFocusedComponent(), editor);
  assert.doesNotMatch(text(m), /Esc/);
  handle.focus(); overlays(tui); tui.handleTerminalInput("\x1b"); overlays(tui);
  assert.equal(m.view.detail, undefined);
  assert.match(text(m), /↑↓.*Enter.*Tab.*N note.*Esc/);
  handle.hide(); m.view.dispose();
});

test("boundary pages preserve the painted cursor and prepaint Enter at both ends", () => {
  for (const boundary of ["top", "bottom"]) {
    const m = mount({ data: many("system", 12) }); tab(m, "System"); paint(m);
    if (boundary === "bottom") {
      m.view.handleInput("\x1b[6~"); paint(m);
      m.view.handleInput("\x1b[6~"); paint(m);
    }
    m.view.handleInput("\x1b[B"); paint(m);
    const { cursor, offset } = m.view, renders = m.renders;
    m.view.handleInput(boundary === "top" ? "\x1b[5~" : "\x1b[6~");
    assert.equal(m.view.cursor, cursor); assert.equal(m.view.offset, offset);
    assert.equal(m.renders, renders);
    m.view.handleInput("\r");
    assert.equal(m.view.detail.id, `row-${cursor}`);
  }
});

test("native wheel and Down bursts accumulate without scrolling the primary transcript or stale activation", () => {
  for (const input of ["wheel", "down"]) {
    const tui = nativeTui();
    const m = mount({ data: many() }); tab(m, "System");
    const handle = tui.showOverlay(m.view, { width: 96, anchor: "bottom-right", nonCapturing: true });
    handle.focus(); overlays(tui);
    const primary = tui.getPrimaryScrollView();
    primary.updateLayout(200, 30, () => {}); primary.scrollTo(50);
    let routed = 0;
    const route = tui.routeWheel.bind(tui);
    tui.routeWheel = (...args) => { routed++; return route(...args); };
    const bounds = tui.renderedOverlayLayouts[0];
    const wheel = `\x1b[<65;${bounds.col + 6};${bounds.row + 5}M`;
    for (let i = 0; i < 3; i++) {
      tui.handleTerminalInput(input === "wheel" ? wheel : "\x1b[B");
      assert.equal(m.view.cursor, i + 1);
      tui.handleTerminalInput("\r"); assert.equal(m.view.detail, undefined);
      assert.equal(click(m, 5, 3), undefined);
    }
    assert.equal(primary.scrollTop, 50); assert.equal(routed, 0);
    tui.handleTerminalInput("\x1b[A"); assert.equal(m.view.cursor, 2, "direction reversal also accumulates");
    overlays(tui); tui.handleTerminalInput("\r");
    assert.equal(m.view.detail.id, "row-2");
    overlays(tui);
    for (let i = 0; i < 3; i++) tui.handleTerminalInput(wheel);
    assert.equal(m.view.detailOffset, 3, "detail scrolling can burst too");
    assert.equal(primary.scrollTop, 50); assert.equal(routed, 0);
    handle.hide(); m.view.dispose();
  }
});

test("pending tab/detail transitions consume in-panel wheels but cannot use old activation targets", () => {
  for (const change of ["tab", "detail", "invalidate", "snapshot", "shrink"]) {
    const m = mount({ data: many() }); tab(m, "System"); paint(m);
    if (change === "tab") m.view.handleInput("\t");
    if (change === "detail") m.view.handleInput("\r");
    if (change === "invalidate") m.view.invalidate();
    if (change === "snapshot") m.data = { ...m.data };
    if (change === "shrink") m.rows = 6;
    const cursor = m.view.cursor, detail = m.view.detail;
    m.view.handleInput("\x1b[B"); m.view.handleInput("\r");
    assert.equal(m.view.cursor, cursor); assert.equal(m.view.detail, detail);
    assert.equal(click(m, 5, 3), undefined);
    const result = m.view.handleMouse({ type: "wheel", wheelDelta: 1, x: 5, y: 3, width: 96, height: 9 });
    assert.deepEqual(result, ["tab", "detail", "snapshot"].includes(change) ? { handled: true } : undefined);
    assert.equal(m.view.cursor, cursor);
  }
  const m = mount({ data: many() }); tab(m, "System"); paint(m);
  m.view.handleInput("\x1b[6~"); m.view.handleInput("\x1b[6~"); m.view.handleInput("\x1b[5~");
  assert.equal(m.view.offset, 5); assert.equal(m.view.cursor, 5);
  m.view.handleInput("\r"); assert.equal(m.view.detail, undefined);
  paint(m); m.view.handleInput("\r"); assert.equal(m.view.detail.id, "row-5");
});

function stateSnapshot(allocation, attribution, replay) {
  const data = snapshot({ allocation, attribution, replay,
    calibrated: allocation !== "raw", note: `Full synthetic note: ${"heuristic provider caveat 界/é ".repeat(18)}END-NOTE` });
  if (allocation === "raw") data.usage = { tokens: null, contextWindow: 10000, percent: null };
  if (allocation !== "proportional") {
    data.items = data.items.map((row) => ({ ...row, tokens: null }));
    data.categories = data.categories.map((row) => ({ ...row, tokens: row.id === "other" && allocation === "unattributed" ? 5000 : null }));
  }
  return data;
}

test("structured allocation/completeness and full sanitized notes remain accessible at fixed height, including 28 columns", () => {
  for (const allocation of ["proportional", "unattributed", "raw"]) for (const attribution of ["complete", "partial"]) {
    for (const replay of ["selected", "observed", "unknown"]) for (const width of [28, 48, 96]) for (const rows of [6, 9]) {
      const m = mount({ data: stateSnapshot(allocation, attribution, replay), rows });
      const qualifier = allocation === "proportional" ? /scaled|proportional/ : allocation === "raw" ? /raw/ : /unattr/;
      for (const surface of ["overview", "category", "detail"]) {
        if (surface === "category") {
          const top = paint(m, width)[0]; click(m, top.indexOf(width === 28 ? " S " : width === 48 ? "Sys" : "System") + 1, 0, width);
        }
        if (surface === "detail") { paint(m, width); click(m, 5, 3, width); }
        const lines = paint(m, width), body = lines.join("\n");
        assert.match(lines.at(-1), qualifier);
        if (attribution === "partial") assert.match(lines.at(-1), /partial/);
        if (allocation !== "proportional") assert.doesNotMatch(body, /scaled|proportional|→ SDK/);
        assert.doesNotMatch(lines.at(-1), /Esc|Enter|Tab|↑↓/);
      }
      const overview = paint(m, width), bottom = overview.at(-1);
      click(m, bottom.indexOf("≈"), overview.length - 1, width);
      let lines = paint(m, width);
      assert.match(lines[2], /Estimation note/);
      const collected = new Map();
      for (let page = 0; page < 100; page++) {
        lines.slice(3, -1).forEach((line, index) => collected.set(m.view.detailOffset + index, line.slice(2, -2).trim()));
        const old = m.view.detailOffset;
        m.view.handleInput("\x1b[6~"); lines = paint(m, width);
        if (old === m.view.detailOffset) break;
        assert(page < 99, "bounded note paging reaches its end");
      }
      const all = [...collected].sort(([a], [b]) => a - b).map(([, line]) => line).join(" ");
      const comparison = allocation === "proportional" ? "" : `Available raw subtotal 10k | SDK total ${allocation === "raw" ? "?" : "5.0k"} (not normalized) `;
      const expected = `Allocation: ${allocation} · attribution: ${attribution} · replay: ${replay} ${comparison}${m.data.note}`;
      assert.equal(all.replace(/\s+/gu, ""), expected.replace(/\s+/gu, ""), "the entire note, not just its first/last fragments, is accessible");
      assert.match(all, new RegExp(`Allocation: ${allocation}`));
      assert.match(all, new RegExp(`attribution: ${attribution}`));
      assert.match(all, new RegExp(`replay: ${replay}`));
      assert.match(all, /Full synthetic note:/); assert.match(all, /END-NOTE/);
      assert.doesNotMatch(text(m, width), /Esc back/);
      const title = paint(m, width)[0]; click(m, title.indexOf("Context"), 0, width);
      assert.equal(m.view.showingNote, false); assert.equal(m.view.selected, undefined);
      assert.match(paint(m, width)[2], /Source/);
      m.rows = 5;
      for (const readonlyWidth of [27, width]) {
        const readonly = text(m, readonlyWidth);
        assert.match(readonly, qualifier);
        if (attribution === "partial") assert.match(readonly, /partial/);
        if (allocation !== "proportional") assert.doesNotMatch(readonly, /scaled|proportional/);
      }
    }
  }
});

test("unattributed known raw sources remain visible, while only Other paints the occupied SDK total", () => {
  const seen = [], t = realTheme("dark"), style = t.style.bind(t);
  t.style = (value, options) => { if (/^█+$/.test(value)) seen.push(options.fg); return style(value, options); };
  const m = mount({ data: stateSnapshot("unattributed", "partial", "unknown"), paintTheme: t });
  const lines = paint(m);
  assert.match(lines[2], /≈raw +SDK tok/);
  assert.match(lines[3], /Other \(unattributed\).*— +5\.0k/);
  assert.equal(seen.length, 1);
  assert.deepEqual(colorToRgb(seen[0]), colorToRgb(mixColors(t.colors.userMessageBg, t.colors.accent, 0.44, "srgb")));
  tab(m, "System"); assert.match(paint(m)[3], /System source.*2\.0k +\?/);
  click(m, 5, 3); assert.match(text(m), /Raw estimate 2\.0k/);
  assert.match(text(m), /SDK allocation \? tokens/); assert.doesNotMatch(text(m), /(?:^|[^\d])0\.0%|proportional|scaled/);
});

test("note state is structured, not guessed from prose; note controls are safe and focused hints track focus", () => {
  const m = mount({ data: snapshot({ allocation: "raw", attribution: "partial", replay: "unknown",
    note: "scaled proportional complete \x1b[31mUNTRUSTED\x1b[0m\nlast\x07word" }), focused: true });
  assert.match(paint(m).at(-1), /raw estimates · partial/);
  m.view.handleInput("n"); m.view.handleInput("\r"); assert.equal(m.view.detail, undefined);
  paint(m); assert.match(text(m), /UNTRUSTED last word/); assert.doesNotMatch(text(m), /\x1b/);
  assert.match(paint(m).at(-1), /Esc back/);
  m.focused = false; assert.doesNotMatch(paint(m).at(-1), /Esc back/);
  m.view.handleInput("\x1b"); paint(m); m.view.handleInput("\r");
  assert(m.view.detail); paint(m); m.view.handleInput("n"); paint(m);
  assert(m.view.showingNote);
});

test("5040 and null share the footer's compact formatter and unknown token/percent/window sentinels", () => {
  for (const tokens of [5040, null]) for (const contextWindow of [10000, 0]) {
    const usage = { tokens, contextWindow, percent: tokens === null ? null : 50.4 };
    const m = mount({ data: snapshot({ usage, allocation: tokens === null ? "raw" : "proportional" }) });
    // Footer uses precision:compact with no trimKZero. Compare the same sample,
    // not independently sampled SDK usage or a separate accounting calculation.
    const expected = `${formatTokenCount(tokens, { precision: "compact" })}/${contextWindow ? formatTokenCount(contextWindow, { precision: "compact" }) : "?"} · ${contextWindow && tokens !== null ? "50.4%" : "?"}`;
    assert(paint(m)[1].includes(expected));
    m.rows = 5; assert(text(m).includes(expected));
  }
});

test("stable 4000-row animation frames order/measure once and format only viewport cells; refreshed metrics and anchors stay correct", () => {
  const data = many("system", 4000);
  data.categories = data.categories.map((row) => row.id === "other" ? { ...row, rawTokens: 0, tokens: 0, count: 0 } : row);
  const m = mount({ data, paintTheme: realTheme("dark") });
  let orders = 0, cells = 0, labelsRead = 0;
  const order = m.view.orderedRows.bind(m.view), cell = m.view.cell.bind(m.view);
  m.view.orderedRows = (...args) => { orders++; return order(...args); };
  m.view.cell = (...args) => { cells++; return cell(...args); };
  for (const row of data.items) {
    const label = row.label;
    Object.defineProperty(row, "label", { enumerable: true, get() { labelsRead++; return label; } });
  }
  paint(m);
  assert.equal(orders, 1); assert.equal(cells, 5);
  const metrics = m.view.metrics, rows = m.view.rows;
  cells = labelsRead = 0;
  for (let frame = 0; frame < 10; frame++) paint(m);
  assert.equal(orders, 1); assert.equal(cells, 50); assert.equal(labelsRead, 50);
  assert.equal(m.view.metrics, metrics); assert.equal(m.view.rows, rows);
  m.view.handleInput("\x1b[B");
  const highlighted = m.view.render(96)[4];
  assert(highlighted.includes(m.view.options.theme.getFgAnsi("accent") + "source-01"));
  assert.equal(m.view.metrics, metrics); assert.equal(orders, 1);
  paint(m, 28); assert.equal(m.view.metrics, metrics); assert.equal(orders, 1);
  m.view.handleInput("\x1b[6~"); paint(m);
  const anchor = m.view.rows[m.view.offset].id;
  m.data = { ...m.data, items: m.data.items.filter((row) => row.id !== "row-0").map((row) => ({ ...row, tokens: 123456789 })) };
  assert.match(paint(m)[3], /123M/);
  assert.equal(m.view.rows[m.view.offset].id, anchor); assert.notEqual(m.view.metrics, metrics); assert.equal(orders, 2);
  m.view.handleInput("\r"); assert.equal(m.view.detail.id, anchor);
});

// Public collector + public SDK projection, entirely synthetic Anthropic-style
// history. No session, history file, provider runtime or model call is created.
function anthropicFixture() {
  const physical = { provider: "anthropic-fixture", api: "anthropic-messages", id: "claude-synthetic", contextWindow: 200000 };
  const virtual = { provider: "synthetic-route", api: "pi-virtual", id: "virtual-synthetic", contextWindow: 200000 };
  const usage = { tokens: 52000, contextWindow: 200000, percent: 26 };
  const rawUsage = { tokens: null, contextWindow: 200000, percent: null };
  const block = (text) => ({ type: "text", text });
  const assistant = (content) => ({ role: "assistant", provider: physical.provider, api: physical.api,
    model: physical.id, content, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
    stopReason: "stop", timestamp: 0 });
  const messages = [{ role: "system", content: "", toolsAdded: [{ name: "read", description: "Synthetic declaration",
    parameters: { type: "object", properties: { path: { type: "string" } } } }], timestamp: 0 }];
  for (let i = 0; i < 41; i++) messages.push(
    { role: "user", content: `Synthetic user ${i}: ${"u".repeat(400 + i * 4)}`, timestamp: 0 },
    assistant([{ type: "thinking", thinking: "r".repeat(80 + i * 4), thinkingSignature: `synthetic-${i}` },
      block("a".repeat(120 + i * 4)), { type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `synthetic/src/file-${i}.ts` } }]),
    { role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [block("t".repeat(800 + i * 4))], isError: false, timestamp: 0 },
  );
  const opaque = assistant([{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "SYNTHETIC_OPAQUE" }]);
  const chain = (values) => values.map((message, index) => ({ type: "message", id: `synthetic-entry-${index}`,
    parentId: index ? `synthetic-entry-${index - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z", message }));
  const entries = chain([...messages, opaque]);
  const collect = (values, options = {}, model = physical) => collectContextSnapshot({ model,
    sessionManager: { buildSessionProjection: () => buildSessionProjection(values),
      getBranch() { throw Error("No raw history"); } },
    getSystemPrompt: () => "Synthetic effective system prompt. ".repeat(60),
    getContextUsage() { throw Error("Do not resample supplied usage"); },
  }, { usage, now: 0, ...options });
  return { entries, messages, chain, collect, usage, rawUsage, physical, virtual,
    baseline: collect(chain(messages)), main: collect(entries), raw: collect(entries, { usage: rawUsage }),
    unknown: collect(entries, { replayModel: null }, virtual),
    observed: collect(entries, { replayModel: physical, replaySource: "active-request" }, virtual) };
}

function allTextPages(m, width) {
  const collected = new Map();
  for (;;) {
    const lines = paint(m, width);
    lines.slice(3, -1).forEach((line, index) => collected.set(m.view.detailOffset + index, line.slice(2, -2).trim()));
    const before = m.view.detailOffset;
    m.view.handleInput("\x1b[6~");
    if (m.view.detailOffset === before) break;
  }
  return [...collected].sort(([a], [b]) => a - b).map(([, value]) => value).join(" ");
}

function assertVisibleBasis(m, width) {
  const lines = paint(m, width), header = lines[2];
  const proportional = m.data.allocation === "proportional";
  assert.match(header, proportional ? /≈tok/ : /≈raw/);
  if (!proportional) assert.doesNotMatch(header, /%used/);
  for (let index = m.view.offset; index < Math.min(m.view.rows.length, m.view.offset + m.view.viewport); index++) {
    const row = m.view.rows[index], line = lines[3 + index - m.view.offset];
    const raw = row.rawState === "estimate" ? formatTokenCount(row.rawTokens, { precision: "compact" })
      : row.rawState === "not-applicable" ? "—" : "?";
    const sdk = formatTokenCount(row.tokens, { precision: "compact" });
    const primary = proportional ? sdk : raw;
    const secondary = proportional ? row.tokens !== null && m.data.usage.tokens
      ? `${(row.tokens / m.data.usage.tokens * 100).toFixed(1)}%` : "?" : sdk;
    const tail = (header.includes("%used") || header.includes("SDK tok")) ? `${primary} ${secondary}` : primary;
    assert(line.slice(2, -2).trimEnd().replace(/ +/g, " ").endsWith(tail), `${m.data.allocation}/${width}: ${line} expected ${tail}`);
    if (width === 28 && !proportional) assert.doesNotMatch(header, /SDK tok/);
  }
  return lines;
}

test("41-round signed Anthropic + opaque collector snapshots retain known raw and the unchanged SDK ledger", () => {
  const f = anthropicFixture(), before = JSON.stringify(f.entries);
  assert.equal(f.messages.length, 124);
  assert(f.messages.filter((message) => message.role === "assistant").every((message) => !Object.hasOwn(message.usage, "reasoning")));
  assert.equal(f.baseline.allocation, "proportional");
  assert.equal(f.main.allocation, "unattributed");
  const sources = f.main.items.filter((row) => row.category !== "other" && row.kind !== "reasoning-unknown");
  assert.equal(sources.length, 207);
  assert.deepEqual(sources, f.baseline.items.map((row) => ({ ...row, tokens: null })));
  assert(sources.every((row) => row.rawState === "estimate" && row.rawTokens > 0));
  assert.equal(f.main.rawTokens, f.baseline.rawTokens);
  assert.deepEqual(f.main.usage, f.usage);
  assert(f.main.items.filter((row) => row.category !== "other").every((row) => row.tokens === null));
  assert.equal(f.main.items.find((row) => row.kind === "reasoning-unknown").rawState, "unknown");
  assert.equal(f.main.items.find((row) => row.category === "other").rawState, "not-applicable");
  for (const ledger of [f.main.items, f.main.categories]) assert.equal(ledger.reduce((sum, row) => sum + (row.tokens ?? 0), 0), 52000);
  assert.equal(f.raw.allocation, "raw");
  assert(f.raw.items.every((row) => row.tokens === null));
  assert(!f.raw.items.some((row) => row.category === "other"));
  assert.deepEqual([f.unknown.allocation, f.observed.allocation], ["unattributed", "unattributed"], "observing identity cannot invent opaque weight");
  const withoutOpaque = [f.collect(f.chain(f.messages), { replayModel: null }, f.virtual),
    f.collect(f.chain(f.messages), { replayModel: f.physical }, f.virtual)];
  assert.deepEqual(withoutOpaque.map((data) => data.allocation), ["unattributed", "proportional"]);

  for (const data of [f.baseline, f.main, f.raw]) for (const width of [28, 48, 96]) for (const rows of [6, 9]) {
    const m = mount({ data, rows });
    // Every source's value is checked through real paged cells, including the
    // unknown placeholder and Other's raw dash after the SDK column is dropped.
    let visible = 0;
    for (;;) {
      assertVisibleBasis(m, width);
      visible += Math.min(m.view.viewport, m.view.rows.length - m.view.offset);
      const beforeOffset = m.view.offset;
      m.view.handleInput("\x1b[6~");
      if (m.view.offset === beforeOffset) break;
    }
    assert(visible >= data.items.length);
    for (const category of ["system", "messages", "tools"]) {
      m.view.select(category);
      assertVisibleBasis(m, width);
      m.view.handleInput("\r");
      assert.equal(paint(m, width).length, rows);
      const metadata = allTextPages(m, width).replace(/\s+/gu, " ");
      assert.match(metadata, /SDK allocation/);
      assert.match(metadata, /Raw estimate [\d.]+k? tokens · not provider token accounting/);
      m.view.handleInput("\x1b");
    }
  }
  assert.equal(JSON.stringify(f.entries), before, "synthetic input JSON remains identical");
});

test("successful raw zero, estimator failure, unknown reasoning and Other have distinct visible semantics", () => {
  const f = anthropicFixture();
  const makeZero = (content, usage = f.rawUsage) => collectContextSnapshot({ model: f.physical,
    sessionManager: { buildSessionProjection: () => ({ entries: [{ sourceEntry: { id: "same-zero" },
      messages: [{ role: "toolResult", toolCallId: "zero", toolName: "read", content, timestamp: 0, isError: false }] }] }) },
    getSystemPrompt() { throw Error("Unrelated prompt failure makes both snapshots partial"); },
  }, { usage, now: 0 });
  const success = makeZero([{ type: "text", text: "" }]);
  const failure = makeZero([{ type: "text", get text() { throw Error("Synthetic estimator failure"); } }]);
  assert.equal(success.attribution, "partial"); assert.equal(failure.attribution, "partial");
  assert.equal(success.items[0].id, failure.items[0].id);
  assert.equal(success.items[0].rawTokens, 0); assert.equal(failure.items[0].rawTokens, 0);
  assert.equal(success.items[0].rawState, "estimate"); assert.equal(failure.items[0].rawState, "unknown");
  for (const [data, value, detail] of [[success, "0", /Raw estimate 0 tokens/], [failure, "?", /Raw estimate \? · unknown/]]) {
    const m = mount({ data });
    assert(paint(m)[3].slice(2, -2).trimEnd().endsWith(value));
    m.view.handleInput("\r");
    assert.match(allTextPages(m, 96), detail);
  }
  const m = mount({ data: f.main }); paint(m);
  const other = m.view.rows.find((row) => row.category === "other");
  assert.equal(other.rawState, "not-applicable", "synthetic category aggregate must retain non-source semantics");
  m.view.open(other.id); paint(m);
  const otherDetail = allTextPages(m, 96);
  assert.match(otherDetail, /SDK allocation 52k tokens/); assert.match(otherDetail, /Raw estimate — · not applicable/);
  assert.doesNotMatch(otherDetail, /Raw estimate 0/);
  m.view.open(m.view.rows.find((row) => row.kind === "reasoning-unknown").id); paint(m);
  assert.match(allTextPages(m, 28), /Raw estimate \? · unknown/);
  // A missing field in a malformed JS DTO must not silently bless numeric zero.
  const missing = { ...failure, items: failure.items.map((row) => { const item = { ...row }; delete item.rawState; return item; }) };
  const malformed = mount({ data: missing });
  assert(paint(malformed)[3].slice(2, -2).trimEnd().endsWith("?"));
});

test("fresh nonproportional sorting isolates Other and puts known zero before unknown, independent of SDK magnitude", () => {
  const data = stateSnapshot("unattributed", "partial", "unknown");
  data.items = [
    { ...many().items[0], id: "unknown", rawTokens: 999999, rawState: "unknown", tokens: null },
    { ...many().items[0], id: "zero", rawTokens: 0, rawState: "estimate", tokens: null },
    { ...many().items[0], id: "positive", rawTokens: 9000, rawState: "estimate", tokens: null },
  ];
  data.categories = data.categories.map((row) => row.id === "other" ? { ...row, tokens: 1 } : row);
  const m = mount({ data }); paint(m);
  assert.deepEqual(m.view.rows.map((row) => row.id), ["category:other", "positive", "zero", "unknown"]);
});

test("4000-row basis/mode refresh rebuilds metrics once without reshuffling old sources, viewport/detail anchors survive", () => {
  const data = many("tools", 4000);
  data.categories = data.categories.filter((row) => row.id !== "other");
  const m = mount({ data }); paint(m); m.view.handleInput("\x1b[6~"); paint(m);
  const anchor = m.view.rows[m.view.offset].id, cursor = m.view.rows[m.view.cursor].id;
  let cells = 0, orders = 0, bases = 0;
  const originalCell = m.view.cell.bind(m.view), order = m.view.orderedRows.bind(m.view), basis = m.view.displayBasis.bind(m.view);
  m.view.cell = (...args) => { cells++; return originalCell(...args); };
  m.view.orderedRows = (...args) => { orders++; return order(...args); };
  m.view.displayBasis = (...args) => { bases++; return basis(...args); };
  for (const allocation of ["raw", "unattributed", "proportional", "raw"]) {
    const oldMetrics = m.view.metrics;
    m.data = { ...data, allocation,
      usage: allocation === "raw" ? { ...data.usage, tokens: null, percent: null } : data.usage,
      items: data.items.map((row, index) => ({ ...row, rawTokens: index === 5 ? 123456789 : index,
        tokens: allocation === "proportional" ? index : null })) };
    const beforeOrders = orders;
    assertVisibleBasis(m, 96);
    assert.notEqual(m.view.metrics, oldMetrics);
    assert.equal(orders, beforeOrders + 1);
    assert.equal(m.view.rows[m.view.offset].id, anchor); assert.equal(m.view.rows[m.view.cursor].id, cursor);
    const metrics = m.view.metrics, rows = m.view.rows;
    cells = bases = 0;
    for (let frame = 0; frame < 10; frame++) paint(m);
    assert.equal(cells, 50); assert.equal(bases, 60, "only headers + viewport cells use the formatter on stable frames");
    assert.equal(m.view.metrics, metrics); assert.equal(m.view.rows, rows); assert.equal(orders, beforeOrders + 1);
    assertVisibleBasis(m, 28); assert.equal(m.view.metrics, metrics);
  }
  paint(m); m.view.handleInput("\r"); paint(m);
  const oldDetail = m.view.detail.id;
  m.data = { ...m.data, allocation: "unattributed", usage: data.usage };
  paint(m); assert.equal(m.view.detail.id, oldDetail);
});

test("snapshot failures redact errors; close tail's entire five columns close exactly once; dispose is inert", () => {
  const failed = mount({ failSnapshot: true });
  assert.match(text(failed), /Context unavailable/); assert.doesNotMatch(text(failed), /SECRET ERROR/);
  for (let x = 91; x < 96; x++) {
    const m = mount(); paint(m);
    assert.deepEqual(click(m, x, 0), { handled: true });
    assert.equal(m.closes, 1);
    const renders = m.renders;
    m.view.dispose(); m.view.dispose(); m.view.invalidate(); m.view.handleInput("\t"); m.view.handleInput("\x1b"); click(m, x, 0);
    assert.equal(m.closes, 1); assert.equal(m.renders, renders); assert.deepEqual(m.view.render(96), []);
  }
});
