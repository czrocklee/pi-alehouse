#!/usr/bin/env node
// Convert ONE captured terminal panel to an SVG. Never commit --screen or --colors.
// node scripts/render-readme.mjs --screen /tmp/capture.ansi --colors /tmp/kitty-colors.txt \
//   --title 'Worker routing' --output routing-panel.svg
// For a private Agent pane, add --redact-field run --redact-field cwd and a --caption.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const args = process.argv.slice(2);
const options = {}, redactFields = [];
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!/^--(screen|colors|title|output|caption|redact-field)$/.test(key ?? "") || !args[i + 1] ||
      (key !== "--redact-field" && options[key])) {
    throw new Error("Usage: node scripts/render-readme.mjs --screen FILE --colors FILE --title HEADER --output NAME.svg [--redact-field run|cwd] [--caption TEXT]");
  }
  if (key === "--redact-field") redactFields.push(args[i + 1]);
  else options[key] = args[i + 1];
}
const replacements = { run: "[identifiers hidden]", cwd: "[path hidden]" };
if (!["--screen", "--colors", "--title", "--output"].every((key) => options[key]) ||
    !/^[a-z0-9-]+\.svg$/.test(options["--output"]) ||
    redactFields.some((field) => !Object.hasOwn(replacements, field)) ||
    new Set(redactFields).size !== redactFields.length || (redactFields.length && !options["--caption"])) {
  throw new Error("Four required options, simple SVG filename, unique run/cwd redaction fields, and caption for redaction required");
}
const input = await readFile(options["--screen"], "utf8");
const colorSource = await readFile(options["--colors"], "utf8");
const palette = Object.fromEntries([...colorSource.matchAll(/^([a-z_]+\d*)\s+(#[0-9a-fA-F]{6})\s*$/gm)]
  .map((match) => [match[1], match[2].toLowerCase()]));
if (!palette.background || !palette.foreground || !Array.from({ length: 256 }, (_, i) => palette[`color${i}`]).every(Boolean)) {
  throw new Error("Expected a complete kitty get-colors palette (background, foreground, color0..255)");
}
const sgrColor = (n) => palette[`color${n}`];
const reset = () => ({ fg: palette.foreground, bg: palette.background, bold: false, italic: false, inverse: false });
let state = reset();
const rgb = (values) => values.length === 3 && values.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ? `#${values.map((n) => n.toString(16).padStart(2, "0")).join("")}` : undefined;
function extended(code, mode, values) {
  let color;
  if (mode === 5 && values.length === 1 && Number.isInteger(values[0]) && values[0] >= 0 && values[0] <= 255) {
    color = sgrColor(values[0]);
  } else if (mode === 2) {
    // SGR colon form may contain an optional colorspace field (usually empty or 0).
    if (values.length === 4 && (values[0] === null || values[0] === 0)) values = values.slice(1);
    color = rgb(values);
  }
  if (!color) throw new Error("Invalid or unsupported captured SGR color");
  state[code === 38 ? "fg" : "bg"] = color;
}
function applySgr(params) {
  const parts = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const fields = parts[i].split(":");
    const code = Number(fields[0] || 0);
    if (fields.length > 1) {
      if (code !== 38 && code !== 48) throw new Error("Unsupported captured colon SGR");
      extended(code, Number(fields[1]), fields.slice(2).map((v) => v === "" ? null : Number(v)));
    } else if (code === 38 || code === 48) {
      const mode = Number(parts[++i]);
      const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
      if (!count) throw new Error("Unsupported captured SGR color mode");
      extended(code, mode, parts.slice(i + 1, i + count + 1).map(Number));
      i += count;
    } else if (code === 0) state = reset();
    else if (code === 1) state.bold = true;
    else if (code === 3) state.italic = true;
    else if (code === 22) state.bold = false;
    else if (code === 23) state.italic = false;
    else if (code === 7) state.inverse = true;
    else if (code === 27) state.inverse = false;
    else if (code === 39) state.fg = palette.foreground;
    else if (code === 49) state.bg = palette.background;
    else if (code >= 30 && code <= 37) state.fg = sgrColor(code - 30);
    else if (code >= 90 && code <= 97) state.fg = sgrColor(code - 90 + 8);
    else if (code >= 40 && code <= 47) state.bg = sgrColor(code - 40);
    else if (code >= 100 && code <= 107) state.bg = sgrColor(code - 100 + 8);
    // Underline and other SGR attributes have no effect on these captured panels.
  }
}
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const control = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./gs;
function parseLine(line) {
  const cells = [];
  let position = 0;
  const append = (text) => {
    if (/[\x00-\x1f\x7f]/.test(text)) throw new Error("Unsupported control character in captured row");
    for (const { segment } of graphemes.segment(text)) {
      const width = visibleWidth(segment);
      if (!width) { if (cells.length && cells.at(-1)) cells.at(-1).text += segment; continue; }
      if (width > 2) throw new Error("Unsupported captured display width");
      cells.push({ text: segment, width, ...state });
      for (let i = 1; i < width; i++) cells.push(null);
    }
  };
  for (const match of line.matchAll(control)) {
    append(line.slice(position, match.index));
    const token = match[0];
    if (token.startsWith("\x1b[")) {
      if (token.endsWith("m")) applySgr(token.slice(2, -1));
      // Other CSI controls do not paint glyphs and cannot enter the SVG.
    } else if (!token.startsWith("\x1b]")) throw new Error("Unknown captured escape sequence");
    // OSC (including hyperlink URLs) is intentionally discarded in full.
    position = match.index + token.length;
  }
  append(line.slice(position));
  return cells;
}
const rows = input.split("\n").map(parseLine);
const charAt = (row, column) => row?.[column]?.text;
const tops = [], bottoms = [];
for (let y = 0; y < rows.length; y++) {
  const chars = rows[y].map((cell) => cell?.text ?? "");
  if (chars.includes("╭") && chars.includes("╮")) tops.push({ y, x: chars.indexOf("╭"), right: chars.indexOf("╮") });
  if (chars.includes("╰") && chars.includes("╯")) bottoms.push({ y, x: chars.indexOf("╰"), right: chars.indexOf("╯") });
}
if (tops.length !== 1 || bottoms.length !== 1) throw new Error("Expected exactly one complete, bounded panel");
const top = tops[0], bottom = bottoms[0];
if (top.y >= bottom.y || top.x !== bottom.x || top.right !== bottom.right || top.right - top.x < 20) {
  throw new Error("Top and bottom panel borders do not match");
}
const crop = rows.slice(top.y, bottom.y + 1).map((row, offset) => {
  const left = charAt(row, top.x), right = charAt(row, top.right);
  if (offset > 0 && offset < bottom.y - top.y && !["│", "├"].includes(left)) {
    throw new Error("Panel left border is interrupted");
  }
  if (offset > 0 && offset < bottom.y - top.y && !["│", "┤"].includes(right)) {
    throw new Error("Panel right border is interrupted");
  }
  if (row.length <= top.right) throw new Error("Panel row is shorter than its border");
  return row.slice(top.x, top.right + 1);
});
// Remove values at the cell level BEFORE building any SVG text or background
// rectangles. Preserve the field label, outer border and existing row geometry.
// Reject missing/duplicate labels rather than accidentally exporting an id/path.
const found = Object.fromEntries(redactFields.map((field) => [field, 0]));
let continuation;
for (const row of crop) {
  const inner = row.slice(1, -1).map((cell) => cell?.text ?? "").join("");
  let from, placeholder;
  for (const field of redactFields) {
    const match = new RegExp(`^  ${field} +`).exec(inner);
    if (!match) continue;
    found[field]++;
    from = 1 + visibleWidth(match[0]);
    placeholder = replacements[field];
    continuation = field;
    break;
  }
  if (from === undefined) {
    // A wrapped field value has a blank label column, as renderDetailFields
    // does. Redact every continuation row until another label or separator.
    if (continuation && /^ {12}\S/.test(inner)) from = 13;
    else continuation = undefined;
  }
  if (from === undefined) continue;
  const end = row.length - 1;
  if (placeholder && from + placeholder.length > end) throw new Error("Redaction label does not fit this panel");
  for (let col = from; col < end; col++) row[col] = { text: " ", width: 1, ...reset() };
  if (placeholder) for (let i = 0; i < placeholder.length; i++) row[from + i].text = placeholder[i];
}
for (const field of redactFields) if (found[field] !== 1) throw new Error(`Expected exactly one ${field} field row`);
// Only redacted crop enters serialization. No text before/after the framed
// rectangle, no OSC payloads, and no external references enter the SVG.
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const cellWidth = 10.9, lineHeight = 26, left = 40, baseline = 124;
const width = Math.ceil(left * 2 + (top.right - top.x + 1) * cellWidth);
const height = baseline + lineHeight * crop.length + 61;
let contents = "";
for (const [rowIndex, row] of crop.entries()) {
  const y = baseline + rowIndex * lineHeight;
  const runs = [];
  for (let col = 0; col < row.length;) {
    const item = row[col];
    if (!item) { col++; continue; }
    const start = col, key = `${item.fg}|${item.bg}|${item.bold}|${item.italic}|${item.inverse}`;
    let text = "";
    while (col < row.length) {
      const next = row[col];
      if (!next || `${next.fg}|${next.bg}|${next.bold}|${next.italic}|${next.inverse}` !== key) break;
      text += next.text;
      col += next.width;
    }
    const fg = item.inverse ? item.bg : item.fg;
    const bg = item.inverse ? item.fg : item.bg;
    runs.push({ start, end: col, text, fg, bg, bold: item.bold, italic: item.italic });
  }
  for (const run of runs) if (run.bg !== palette.background) {
    contents += `<rect x="${(left + run.start * cellWidth).toFixed(1)}" y="${y - 19}" width="${((run.end - run.start) * cellWidth).toFixed(1)}" height="${lineHeight}" fill="${run.bg}"/>`;
  }
  for (const run of runs) if (run.text.trim()) {
    contents += `<text x="${(left + run.start * cellWidth).toFixed(1)}" y="${y}" xml:space="preserve" fill="${run.fg}"${run.bold ? ' font-weight="700"' : ""}${run.italic ? ' font-style="italic"' : ""}>${escapeXml(run.text)}</text>`;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options["--title"])} — cropped terminal panel">
<rect width="${width}" height="${height}" fill="${palette.background}"/>
<text x="${left}" y="53" fill="${palette.color6}" font-family="sans-serif" font-size="16" font-weight="700">${escapeXml(options["--title"])}</text>
<path d="M${left} 77H${width - left}" stroke="${palette.color8}"/>
<g font-family="DejaVu Sans Mono, ui-monospace, monospace" font-size="18">${contents}</g>
<text x="${width - left}" y="${height - 25}" text-anchor="end" fill="${palette.color8}" font-family="sans-serif" font-size="12">${escapeXml(options["--caption"] ?? "Real terminal capture · panel only")}</text>
</svg>\n`;
const out = new URL(`../harness/docs/assets/${options["--output"]}`, import.meta.url);
await mkdir(fileURLToPath(new URL("../harness/docs/assets/", import.meta.url)), { recursive: true });
await writeFile(out, svg);
console.log(`Wrote ${fileURLToPath(out)} (${crop.length} rows × ${top.right - top.x + 1} columns, crop only)`);
