/**
 * A child-to-parent communication message drawn as an Input-style background
 * block: the label sits right-aligned above the background, and the body uses
 * the host theme's `userMessageBg`/`customMessageLabel` tokens with its line breaks
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
import {
  Box,
  Container,
  sliceByColumn,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { clipPlainText, wrapPlainText } from "./text.ts";

/** The host theme the render pipeline hands to tool renderers. */
export type HostTheme = Theme;

/**
 * Keep the 1-cell horizontal padding only while it leaves at least two content
 * cells (the smallest space that can show a double-cell grapheme whole);
 * below this width the padding is canceled so the block keeps content space.
 */
const MIN_PADDED_WIDTH = 4;

export const communicationPadding = (width: number): number => (width >= MIN_PADDED_WIDTH ? 1 : 0);

/** Normally reserve a fifth of the pane; in narrow panes keep a smaller gap. */
function communicationCardWidth(available: number, natural = Infinity): number {
  if (!Number.isInteger(available) || available <= 0) return 0;
  const narrow = Math.min(24, available - 3);
  const limit = Math.max(MIN_PADDED_WIDTH, narrow, Math.floor(available * 0.8));
  return Math.min(available, limit, natural);
}

/** A native child may overshoot its budget (e.g. a table or very wide grapheme). */
function fitRow(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** Markdown can add indentation, table borders or link text not present in
 * the source. Measure its actual rows at the allowed width, then shrink-wrap
 * at the painted right edge. Stay a Container so layout invalidation can walk
 * native children without invoking e.g. SkillInvocationMessageComponent.invalidate(). */
export class ParentCommunicationCard extends Container {
  override render(width: number): string[] {
    const cap = communicationCardWidth(width);
    if (!cap) return [];
    const rows = super.render(cap);
    let fitted = 1;
    for (const line of rows) {
      const ink = stripTerminalSequences(line).trimEnd();
      fitted = Math.max(fitted, visibleWidth(ink) + communicationPadding(cap));
      if (fitted >= cap) return rows.map((row) => fitRow(row, cap));
    }
    // Re-render to let each native child close its own styles and hyperlinks
    // at the narrower boundary, rather than slicing ANSI off its right edge.
    return super.render(fitted).map((row) => fitRow(row, fitted));
  }
}

/** Natural content width in terminal cells, before adding the one-cell insets. */
export function communicationLineWidth(text: string): number {
  return text.split("\n").reduce((longest, line) => Math.max(longest, visibleWidth(line)), 0);
}

/** Right-anchor the complete literal-text card, including its background. */
export class CommunicationCard implements Component {
  constructor(
    private readonly lineWidth: number,
    private readonly content: Component,
  ) {}

  render(width: number): string[] {
    const cardWidth = communicationCardWidth(width, this.lineWidth + 2);
    if (!cardWidth) return [];
    const margin = " ".repeat(width - cardWidth);
    return this.content.render(cardWidth).map((line) => margin + fitRow(line, cardWidth));
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

/** Unbackgrounded metadata on the same side as the call. A longer receipt
 * may widen leftward so it isn't squeezed into a short question's width. */
export class CommunicationReceipt implements Component {
  private text = "";
  private lineWidth = 0;
  private style = (row: string): string => row;

  constructor(private readonly cardLineWidth: number) {}

  setText(text: string, style: (row: string) => string): void {
    if (text !== this.text) {
      this.text = text;
      this.lineWidth = communicationLineWidth(text);
    }
    this.style = style;
  }

  render(width: number): string[] {
    const column = communicationCardWidth(width, Math.max(this.cardLineWidth, this.lineWidth) + 2);
    if (!this.text || !column) return [];
    const inset = communicationPadding(column);
    const indent = " ".repeat(width - column + inset);
    return wrapPlainText(this.text, column - inset * 2).map((row) => indent + this.style(row));
  }

  invalidate(): void {}
}

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
      new CellClipped(new Text(text, 0, 0), (row) => theme.fg("customMessageLabel", row)),
    );
  }

  render(width: number): string[] {
    if (!Number.isInteger(width) || width <= 0) return [];
    // Box.render clamps its content width to at least one cell but still
    // prepends the full horizontal padding, so a 1-cell pad overflows rows
    // narrower than four cells and starves the content below two cells. Drop
    // it there so the block keeps content space at extreme narrow widths
    // instead of pushing rows too wide or hiding double-cell graphemes.
    const paddingX = communicationPadding(width);
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
