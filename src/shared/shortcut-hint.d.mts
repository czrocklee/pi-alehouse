export interface ShortcutTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
export interface ShortcutHintOptions {
  color?: string;
  keyColor?: string;
}
/** A matching ASCII mnemonic is highlighted inline; other keys stay explicit.
 * Missing keys mean click-only labels, with no shortcut emphasis. No binding
 * or hit geometry is installed. Callers measure the styled result in cells. */
export function shortcutHint(
  theme: ShortcutTheme,
  label: string,
  key?: string,
  options?: ShortcutHintOptions,
): string;
