/** Presentation-only shortcut hints shared by independently bundled panels.
 * Callers supply trusted labels and the key their own input handler accepts;
 * this helper never installs a binding, chooses a key or measures a hit target.
 */

/** @typedef {{ fg(color: string, text: string): string, bold(text: string): string }} ShortcutTheme */
/** @typedef {{ color?: string, keyColor?: string }} ShortcutHintOptions */

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Highlight a single ASCII mnemonic inside its label, without repeating it.
 * Non-mnemonic keys (Esc, Enter, chords, arrows, punctuation) and letters absent
 * from the label remain explicit: `Esc close`, `P Settings`, `. more`.
 * With no key the label is click-only and receives no shortcut emphasis.
 * Labels preserve their spelling/case; styling adds no visible columns.
 *
 * @param {ShortcutTheme} theme
 * @param {string} label
 * @param {string} [key]
 * @param {ShortcutHintOptions} [options]
 * @returns {string}
 */
export function shortcutHint(theme, label, key, options = {}) {
  const color = options.color ?? "muted";
  /** @param {string} text */
  const paint = (text) => (text ? theme.fg(color, text) : "");
  /** @param {string} text */
  const hotkey = (text) => theme.fg(options.keyColor ?? "accent", theme.bold(text));
  if (!key) return paint(label);
  if (/^[A-Za-z0-9]$/.test(key)) {
    // Original grapheme offsets avoid case-fold expansion shifting a match;
    // keep any combining marks with their base letter inside the emphasis.
    for (const { segment, index } of graphemes.segment(label)) {
      const char = segment[0];
      if (char && /^[A-Za-z0-9]$/.test(char) && char.toLowerCase() === key.toLowerCase())
        return (
          paint(label.slice(0, index)) +
          hotkey(segment) +
          paint(label.slice(index + segment.length))
        );
    }
  }
  return hotkey(key) + (label ? " " + paint(label) : "");
}
