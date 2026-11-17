import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { graphemes, plainText } from "../presentation/plain-text.ts";

// Keep existing UI imports stable; observations use the presentation leaf directly.
export { graphemes, plainText, previewText, singleLineText } from "../presentation/plain-text.ts";

/** Clip already-sanitized plain text before styling. Pi's truncator can emit
 * resets even for plain input; do not let them reset the ellipsis's own color. */
export const clipPlainText = (text: string, columns: number): string =>
  stripTerminalSequences(truncateToWidth(text, columns, "…"));

/** Wrap plain paragraphs without splitting emoji, combining marks or joiners.
 * Keep spaces that fit, but consume the whole separator run at a soft wrap.
 * Sum grapheme (not code-point) widths, verifying whole rows at boundaries.
 * If concatenation ever changes the SDK's width semantics, use the exact
 * whole-candidate path for that paragraph. Overwide clusters become ellipses. */
export function wrapPlainText(text: string, columns: number): string[] {
  if (!(columns >= 1)) return [];
  const width = Math.floor(columns);
  const paragraphs = plainText(text).split("\n");
  if (width === Infinity) return paragraphs;
  return paragraphs.flatMap((paragraph) =>
    /[^ -~]/.test(paragraph) ? wrapParagraph(paragraph, width) : wrapAscii(paragraph, width),
  );
}

// After sanitization, every printable ASCII code unit is exactly one cell and
// its own grapheme. Work a row at a time without segmenting or measuring it.
function wrapAscii(paragraph: string, width: number): string[] {
  const rows: string[] = [];
  let start = 0;
  while (paragraph.length - start > width) {
    const line = paragraph.slice(start, start + width);
    // An overflowing separator after text belongs to this break, not to the
    // next row. Indentation alone is not a word boundary.
    const space = paragraph[start + width] === " " ? width : line.lastIndexOf(" ");
    const head = space > 0 ? line.slice(0, space).trimEnd() : "";
    const split = space === width || !!head;
    const row = split ? head : line.trimEnd();
    if (row) rows.push(row);
    start += split ? space + 1 : width;
    if (space === width && head) while (paragraph[start] === " ") start++;
  }
  if (start < paragraph.length || !rows.length) rows.push(paragraph.slice(start));
  return rows;
}

function wrapParagraph(paragraph: string, width: number, wholeCandidate = false): string[] {
  const out: string[] = [],
    widths = new Map<string, number>();
  const measure = (cluster: string): number => {
    let value = widths.get(cluster);
    if (value === undefined) {
      value = visibleWidth(cluster);
      widths.set(cluster, value);
    }
    return value;
  };
  const sum = (parts: string[]): number => parts.reduce((total, part) => total + measure(part), 0);
  let line: string[] = [],
    lineWidth = 0,
    mismatch = false,
    skipSpaces = false;
  const emit = (parts: string[], trim = true): boolean => {
    let end = parts.length;
    while (trim && end && parts[end - 1] === " ") end--;
    const kept = parts.slice(0, end),
      row = kept.join("");
    if (!wholeCandidate && visibleWidth(row) !== sum(kept)) mismatch = true;
    if (!row && trim) return false;
    out.push(row);
    return true;
  };
  for (const { segment } of graphemes.segment(paragraph)) {
    if (skipSpaces) {
      if (segment === " ") continue;
      skipSpaces = false;
    }
    const cluster = measure(segment) > width ? "…" : segment,
      clusterWidth = measure(cluster);
    let separator = false;
    while (
      (wholeCandidate ? visibleWidth(line.join("") + cluster) : lineWidth + clusterWidth) > width
    ) {
      // Check concatenation only at a boundary, not for every growing prefix.
      if (!wholeCandidate && visibleWidth(line.join("") + cluster) !== lineWidth + clusterWidth)
        return wrapParagraph(paragraph, width, true);
      if (cluster === " ") {
        // Only a row with content can end at a separator run, not indentation.
        skipSpaces = emit(line);
        line = [];
        lineWidth = 0;
        separator = true;
        break;
      }
      // A marked space belongs to its grapheme, never to the word-break path.
      const space = line.findLastIndex((part) => part === " "),
        head = line.slice(0, space);
      if (space > 0 && head.some((part) => part !== " ")) {
        emit(head);
        line = line.slice(space + 1);
        while (line[0] === " ") line.shift();
        lineWidth = sum(line);
      } else {
        emit(line);
        line = [];
        lineWidth = 0;
      }
    }
    if (!separator) {
      line.push(cluster);
      lineWidth += clusterWidth;
    }
  }
  if (line.length || !out.length) emit(line, false);
  return mismatch ? wrapParagraph(paragraph, width, true) : out;
}
