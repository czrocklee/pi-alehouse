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
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { clipPlainText, graphemes, wrapPlainText } from "./text.ts";

/** The host theme the render pipeline hands to tool renderers. */
export type HostTheme = Theme;

/** Relax the two-cell insets on tiny cards to leave room for a wide grapheme. */
const MAX_PADDING = 2;
export const communicationPadding = (width: number): number =>
  Math.max(0, Math.min(MAX_PADDING, Math.floor((width - 2) / 2)));

/** Reserve at least a tenth of the pane and two columns, unless even a
 * four-column card would not fit beside that gutter. */
function communicationCardWidth(available: number): number {
  if (!Number.isInteger(available) || available <= 0) return 0;
  const gutter = Math.max(2, Math.ceil(available / 10));
  return Math.min(available, Math.max(4, available - gutter));
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

/** Natural content width in terminal cells, before adding the insets. */
function communicationLineWidth(text: string): number {
  return text.split("\n").reduce((longest, line) => Math.max(longest, visibleWidth(line)), 0);
}

/** Pi wraps at spaces and treats each CJK grapheme as its own token. Test the
 * whole cluster, not individual code points: a spacing mark can add a cell. */
const cjkBreak = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
function widestWrapToken(text: string): number {
  if (!/[^\n -~]/.test(text))
    return text.split(/[ \n]+/).reduce((max, word) => Math.max(max, word.length), 0);
  let widest = 0;
  let word = "";
  for (const { segment } of graphemes.segment(text)) {
    if (segment === " " || segment === "\n" || cjkBreak.test(segment)) {
      widest = Math.max(widest, visibleWidth(word), visibleWidth(segment));
      word = "";
    } else word += segment;
  }
  return Math.max(widest, visibleWidth(word));
}

/** A call and its separately rendered receipt share immutable text geometry.
 * Measure with the same SDK wrapper as Text, not the styled/padded Box rows. */
export class CommunicationLayout {
  private readonly natural: number;
  private readonly minContent: number;
  private lastCap = -1;
  private fitted = 0;

  private readonly text: string;

  constructor(label: string, text: string) {
    // Production tool arguments already escape controls. For plain input match
    // Text's tab expansion and wrapTextWithAnsi's paragraph boundaries as well.
    this.text = text.replace(/\t/g, "   ").replace(/\r\n?/g, "\n");
    const labelWidth = visibleWidth(label);
    this.natural = Math.max(labelWidth, communicationLineWidth(this.text));
    this.minContent = Math.max(labelWidth, widestWrapToken(this.text));
  }

  width(available: number): number {
    const cap = communicationCardWidth(available);
    if (cap === this.lastCap) return this.fitted;
    const inset = communicationPadding(cap);
    const room = cap - 2 * inset;
    // Even a one-cell message must leave the resulting card in the inset
    // tier used to measure it (six columns for two-cell padding).
    let inner = Math.min(room, Math.max(inset ? 2 : 1, this.natural));
    if (this.natural > room && this.minContent < room && inset === MAX_PADDING) {
      // Among wraps as short as the widest allowed one, prefer the narrowest.
      // Search content widths only where the two-cell padding stays constant.
      const height = wrapTextWithAnsi(this.text, room).length;
      let low = Math.max(2, this.minContent);
      while (low < inner) {
        const mid = Math.floor((low + inner) / 2);
        if (wrapTextWithAnsi(this.text, mid).length <= height) inner = mid;
        else low = mid + 1;
      }
    }
    this.lastCap = cap;
    return (this.fitted = inner + 2 * inset);
  }
}

/** Right-anchor the complete literal-text card, including its background. */
export class CommunicationCard implements Component {
  constructor(
    private readonly layout: CommunicationLayout,
    private readonly content: Component,
  ) {}

  render(width: number): string[] {
    const cardWidth = this.layout.width(width);
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

  constructor(private readonly layout: CommunicationLayout) {}

  setText(text: string, style: (row: string) => string): void {
    if (text !== this.text) {
      this.text = text;
      this.lineWidth = communicationLineWidth(text);
    }
    this.style = style;
  }

  render(width: number): string[] {
    if (!this.text) return [];
    const cap = communicationCardWidth(width);
    if (!cap) return [];
    const column = Math.max(
      this.layout.width(width),
      Math.min(cap, this.lineWidth + 2 * communicationPadding(cap)),
    );
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
  private paddingX = MAX_PADDING;

  constructor(label: string, text: string, theme: HostTheme) {
    // The Text holds the plain body; the foreground is applied per row only
    // after clipping, and the Box paints the background around the padded row.
    this.title = new TitleLine(label, theme);
    this.box = new Box(this.paddingX, 1, (line) => theme.bg("userMessageBg", line));
    this.box.addChild(
      new CellClipped(new Text(text, 0, 0), (row) => theme.fg("customMessageLabel", row)),
    );
  }

  render(width: number): string[] {
    if (!Number.isInteger(width) || width <= 0) return [];
    // Box always applies the full configured padding, even on tiny cards.
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
