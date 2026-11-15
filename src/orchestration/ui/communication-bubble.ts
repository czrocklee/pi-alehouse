/**
 * A child-to-parent communication message drawn as an Input-style background
 * block: the label sits right-aligned above the background, and the body uses
 * the host theme's `userMessageBg`/`userMessageText` tokens with its line breaks
 * preserved. No extra frame, border or tool-card chrome; the caller renders
 * any receipt outside this component.
 *
 * The body arrives already encoded as literal tool-argument text; this component
 * never parses markdown or re-encodes it. Wrapping, CJK/emoji/ANSI display widths and
 * cell-safe truncation come from the public pi-tui primitives and helpers, so
 * user text is never split at code points. Styling is self-closing per row:
 * the foreground opens and closes around each already-clipped row and the Box
 * wraps the background last, so no SGR state stays open across a row and no
 * internal reset can clear the background under padding. A grapheme too wide
 * for the row (a double-cell character at width 1) is dropped whole rather
 * than split; every returned row fits the requested width.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, sliceByColumn, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { clipPlainText } from "./text.ts";

/** The host theme the render pipeline hands to tool renderers. */
export type HostTheme = Theme;

/**
 * Keep the 1-cell horizontal padding only while it leaves at least two content
 * cells (the smallest space that can show a double-cell grapheme whole);
 * below this width the padding is canceled so the block keeps content space.
 */
const MIN_PADDED_WIDTH = 4;

/** The label row: right-aligned above the body, truncated by cells. */
class TitleLine implements Component {
  private readonly label: string;
  private readonly theme: HostTheme;

  constructor(label: string, theme: HostTheme) {
    this.label = label;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (!this.label || !Number.isInteger(width) || width <= 0) return [];
    // The label is trusted plain text. Strip any SGR the SDK truncator emits
    // even for plain input before applying the title's self-closing foreground.
    const title = clipPlainText(this.label, width);
    const margin = Math.max(0, width - visibleWidth(title));
    return [" ".repeat(margin) + this.theme.fg("userMessageText", title)];
  }

  invalidate(): void {}
}

/**
 * Cell-clip safety net around the wrapped body, then per-row styling. The
 * body reaches this as plain text, so the cell-safe clip (the SDK wrapper
 * keeps whole graphemes; one wider than the content width is dropped whole)
 * can never cut an SGR closer, and the style callback opens and closes the
 * foreground around each already-clipped row: nothing stays open past a
 * narrow row. The Box afterwards pads the row and wraps the background last.
 */
class CellClipped implements Component {
  private readonly inner: Component;
  private readonly style: (row: string) => string;

  constructor(inner: Component, style: (row: string) => string) {
    this.inner = inner;
    this.style = style;
  }

  render(width: number): string[] {
    if (!Number.isInteger(width) || width <= 0) return [];
    return this.inner.render(width).map((line) => {
      const row = visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true);
      return this.style(row);
    });
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/** One child-to-parent communication message as an Input-style block. */
export class CommunicationBubble implements Component {
  private readonly title: TitleLine;
  private readonly box: Box;
  /** The horizontal padding currently applied to the box. */
  private paddingX = 1;

  constructor(label: string, text: string, theme: HostTheme) {
    // The Text holds the plain body; the foreground is applied per row only
    // after clipping, and the Box paints the background around the padded row.
    this.title = new TitleLine(label, theme);
    this.box = new Box(1, 1, (line) => theme.bg("userMessageBg", line));
    this.box.addChild(
      new CellClipped(new Text(text, 0, 0), (row) => theme.fg("userMessageText", row)),
    );
  }

  render(width: number): string[] {
    if (!Number.isInteger(width) || width <= 0) return [];
    // Box.render clamps its content width to at least one cell but still
    // prepends the full horizontal padding, so a 1-cell pad overflows rows
    // narrower than four cells and starves the content below two cells. Drop
    // it there so the block keeps content space at extreme narrow widths
    // instead of pushing rows too wide or hiding double-cell graphemes.
    const paddingX = width >= MIN_PADDED_WIDTH ? 1 : 0;
    if (paddingX !== this.paddingX) {
      this.paddingX = paddingX;
      this.box.setPaddingX(paddingX);
    }
    // Keep the title aligned with the body's inner edge, without extending
    // the body's background into this separate metadata row.
    const padding = " ".repeat(paddingX);
    const title = this.title.render(width - paddingX * 2).map((row) => padding + row + padding);
    return [...title, ...this.box.render(width)];
  }

  invalidate(): void {
    this.title.invalidate();
    this.box.invalidate();
  }
}
