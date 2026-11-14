/** Display-only encoding for code and tool arguments, never a rewrite of the
 * actual execution parameters. Unlike ordinary metadata/generated previews'
 * plainText treatment, no terminal protocol or whitespace payload is removed.
 * Escape original backslashes first so literal escape spellings cannot collide
 * with encoded controls. Other UTF-16 text (including joiners) stays literal. */
export function toolArgumentText(text: string): string {
  return visibleControls(text.replace(/\\/g, "\\\\"));
}

function visibleControls(text: string): string {
  return text
    .replace(/\p{Cc}/gu, (char) =>
      char === "\n" ? char : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    )
    .replace(
      /\p{Bidi_Control}/gu,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

/** Keep single-line argument displays faithful: only LF becomes visible \\n;
 * do not trim or normalize Unicode whitespace as metadata surfaces do. */
export function singleLineToolArgumentText(text: string): string {
  return toolArgumentText(text).replace(/\n/g, "\\n");
}

/** Defensively paint an already-encoded activity argument without re-encoding
 * backslashes or normalizing parameter whitespace. Raw arguments must enter
 * through singleLineToolArgumentText; this idempotent guard is for consumers. */
export function singleLineToolArgumentDisplay(text: string): string {
  return visibleControls(text).replace(/\n/g, "\\n");
}
