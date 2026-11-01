import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** Untrusted display text, never a row that already contains trusted theme ANSI.
 * Strip SDK-recognized protocols first, then neutralize every remaining control
 * introducer (including unsupported/incomplete sequences). Paragraphs stay
 * readable; bidi controls are explicit without destroying script/emoji joiners. */
export function plainText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replace(/[\t\v\f\p{Zs}]/gu, " ")
    .replace(/\p{Cc}/gu, (char) => char === "\n" ? char :
      `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/\p{Bidi_Control}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A raw field on a single-line surface, before measuring or applying styling. */
export const singleLineText = (text: string): string => plainText(text).replace(/\s+/g, " ").trim();

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap plain paragraphs without splitting emoji, combining marks or joiners.
 * Measure the whole candidate: VS/ZWJ clusters cannot be measured by adding
 * code-point widths. An indivisible cluster wider than the budget becomes one
 * visible ellipsis, rather than an oversized row or a broken cluster. */
export function wrapPlainText(text: string, columns: number): string[] {
  if (!(columns >= 1)) return [];
  const width = Math.floor(columns);
  const paragraphs = plainText(text).split("\n");
  if (width === Infinity) return paragraphs;
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const start = out.length;
    let line: string[] = [];
    const emit = (parts: string[]): void => {
      let end = parts.length;
      while (end && parts[end - 1] === " ") end--;
      const row = parts.slice(0, end).join("");
      if (row) out.push(row);
    };
    for (const { segment } of graphemes.segment(paragraph)) {
      const cluster = visibleWidth(segment) > width ? "…" : segment;
      let separator = false;
      while (visibleWidth(line.join("") + cluster) > width) {
        // A full word already fits: an overflowing separator ends that row,
        // rather than moving its last word back to the following row.
        if (cluster === " ") {
          emit(line);
          line = [];
          separator = true;
          break;
        }
        // Only a whole space grapheme is a word break. A space carrying a
        // combining mark must not be cut away from that mark.
        const space = line.findLastIndex((part) => part === " ");
        const head = line.slice(0, space);
        if (space > 0 && head.some((part) => part !== " ")) {
          emit(head);
          line = line.slice(space + 1);
          while (line[0] === " ") line.shift();
        } else {
          emit(line);
          line = [];
        }
      }
      if (!separator) line.push(cluster);
    }
    if (line.length || out.length === start) out.push(line.join(""));
  }
  return out;
}
