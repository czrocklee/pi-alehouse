import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { matchesKey, mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { POPOVER, isPopoverCloseClick, popoverCloseHit, popoverCloseTail, popoverRule, popoverSide }
  from "../../lib/popover-frame.mjs";
import { formatTokenCount } from "../../lib/token-format.mjs";
import type { ContextCategory, ContextItem, ContextSnapshot } from "./context-stats.ts";

export interface ContextViewOptions {
  theme: Theme;
  snapshot: () => ContextSnapshot;
  availableRows: () => number;
  requestRender: () => void;
  close: () => void;
  onRender?: (height: number) => void;
  compaction?: () => string | undefined;
  isFocused?: () => boolean;
}

type Tone = Parameters<Theme["fg"]>[0];
type Row = ContextItem;
type Target = { x: number; end: number; y: number; action: () => void };
const CATEGORIES: readonly ContextCategory[] = ["system", "summary", "messages", "tools", "other"];
const LABELS: Record<ContextCategory, string> = {
  system: "System", summary: "Summary", messages: "Messages", tools: "Tools", other: "Other (unattributed)",
};
// Identity-based, never renumbered when an empty category disappears.
const ALPHA: Record<ContextCategory, number> = { system: 1, summary: 0.86, messages: 0.72, tools: 0.58, other: 0.44 };
const HEIGHT = 9;
const MIN_ROWS = 6;
const MIN_WIDTH = 28;
type Metrics = { primary: number; secondary: number; kind: number };
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const size = (value: unknown): number => Math.floor(number(value) ?? 0);
const safe = (value: unknown): string => typeof value === "string"
  ? stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/ +/g, " ").trim() : "";
const count = (value: unknown): string => {
  const n = number(value);
  return formatTokenCount(n, { precision: "compact" });
};
const percent = (value: unknown): string => {
  const n = number(value);
  return n === undefined ? "?" : `${n.toFixed(1)}%`;
};
const pad = (text: string, width: number, right = false): string => {
  const spaces = " ".repeat(Math.max(0, width - visibleWidth(text)));
  return right ? spaces + text : text + spaces;
};

/** Presentation only: reads detached metadata, owns no SDK session, timers or focus. */
export class ContextView {
  private disposed = false;
  private selected: ContextCategory | undefined;
  private detail: Row | undefined;
  private offset = 0;
  private detailOffset = 0;
  private cursor = 0;
  private order: string[] = [];
  private targets: Target[] = [];
  private paintedWidth = 0;
  private paintedHeight = 0;
  // Navigation can accumulate against the last painted layout. Activation may
  // only use targets committed by a paint of the current epoch.
  private navigationReady = false;
  private epoch = 0;
  private paintedEpoch = -1;
  private paintedSnapshot: ContextSnapshot | undefined;
  private cachedSnapshot: ContextSnapshot | undefined;
  private metrics: Metrics | undefined;
  private showingNote = false;
  private viewport = 0;
  private rows: Row[] = [];
  private detailLines: string[] = [];
  private tabs: ContextCategory[] = [];

  constructor(private readonly options: ContextViewOptions) {}

  preferredWidth(max: number): number { return Math.min(96, Math.max(1, size(max))); }

  render(width: number): string[] {
    this.clearGeometry();
    if (this.disposed) return [];
    const columns = size(width);
    const height = Math.min(HEIGHT, size(this.options.availableRows()));
    const snapshot = this.read();
    if (!columns || !height) return this.finishPaint([], columns);
    if (!snapshot || columns < MIN_WIDTH || height < MIN_ROWS) {
      const text = snapshot ? `Context ${this.estimates(snapshot, true)} · readonly · ${this.usage(snapshot)}` : "Context unavailable · readonly";
      const compact = height >= 3 && columns >= 4
        ? [popoverRule(this.options.theme, columns, "top"), this.row(text, columns), popoverRule(this.options.theme, columns, "bottom")]
        : [this.fit(text, columns)];
      // No close/tab/row/footer hit areas in a readonly fallback, even if a
      // previous paint had them. Esc remains the keyboard escape hatch.
      return this.finishPaint(compact, columns);
    }

    this.tabs = CATEGORIES.filter((id) => id !== "other" && this.present(snapshot, id));
    if (this.selected && !this.tabs.includes(this.selected)) this.reset(undefined);
    if (this.cachedSnapshot !== snapshot) {
      this.rows = this.orderedRows(snapshot);
      this.cachedSnapshot = snapshot;
      this.metrics = undefined;
      if (this.detail) this.detail = this.rows.find((row) => row.id === this.detail!.id);
    }
    this.viewport = height - 4;
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - this.viewport)));
    // Keep the retained scroll anchor whenever the cursor still fits. A
    // smaller terminal/stack budget moves it only far enough to keep the
    // selected row painted and therefore eligible for Enter.
    if (this.cursor < this.offset) this.offset = this.cursor;
    else if (this.cursor >= this.offset + this.viewport) this.offset = this.cursor - this.viewport + 1;
    this.navigationReady = true;
    this.paintedSnapshot = snapshot;
    const lines = [this.top(columns), this.row(this.bar(snapshot, columns - 4), columns)];
    if (this.textPage()) {
      lines.push(this.row(this.fg("accent", this.showingNote ? "Estimation note" : safe(this.detail!.label)), columns));
      const content = this.showingNote ? [
        `Allocation: ${snapshot.allocation} · attribution: ${snapshot.attribution} · replay: ${snapshot.replay}`,
        ...(snapshot.allocation !== "proportional" ? [this.rawComparison(snapshot)] : []),
        safe(snapshot.note),
      ] : this.metadata(this.detail!, snapshot);
      this.detailLines = content.flatMap((line) => wrapTextWithAnsi(line, columns - 4));
      this.detailOffset = Math.min(this.detailOffset, Math.max(0, this.detailLines.length - this.viewport));
      for (const line of this.detailLines.slice(this.detailOffset, this.detailOffset + this.viewport)) lines.push(this.row(line, columns));
    } else {
      const table = this.table(snapshot, columns - 4);
      lines.push(this.row(this.fg("muted", table.header), columns));
      for (let index = this.offset; index < Math.min(this.rows.length, this.offset + this.viewport); index++) {
        const item = this.rows[index]!;
        const y = lines.length;
        lines.push(this.row(table.cell(item, index), columns));
        this.target(1, columns - 1, y, () => this.open(item.id));
      }
      if (!this.rows.length) lines.push(this.row(this.fg("dim", "No attributed context metadata"), columns));
    }
    while (lines.length < height - 1) lines.push(this.row("", columns));
    lines.push(this.bottom(columns, height - 1, snapshot));
    return this.finishPaint(lines, columns);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.clearGeometry();
    this.options.requestRender();
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (this.disposed || event.width !== this.paintedWidth ||
      size(this.options.availableRows()) < this.paintedHeight || event.x < 0 || event.x >= this.paintedWidth ||
      event.y < 0 || event.y >= this.paintedHeight) return undefined;
    if (event.type === "wheel") {
      const delta = event.wheelDelta;
      if (this.ready() && typeof delta === "number" && Number.isFinite(delta)) this.move(Math.trunc(delta));
      // A pending paint retires row activation, not the panel's wheel shield.
      return { handled: true };
    }
    if (!this.ready() || this.paintedEpoch !== this.epoch) return undefined;
    if (isPopoverCloseClick(event, this.paintedWidth)) {
      this.close();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.targets.find(({ x, end, y }) => event.y === y && event.x >= x && event.x < end);
    if (!target) return undefined;
    target.action();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape")) {
      if (this.textPage()) { this.detail = undefined; this.showingNote = false; this.changed(); } else this.close();
      return;
    }
    if (!this.ready()) return;
    if (matchesKey(data, "tab") || matchesKey(data, "right")) return this.cycle(1);
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return this.cycle(-1);
    if (matchesKey(data, "up")) return this.move(-1);
    if (matchesKey(data, "down")) return this.move(1);
    if (matchesKey(data, "pageUp")) return this.page(-1);
    if (matchesKey(data, "pageDown")) return this.page(1);
    if (matchesKey(data, "n") && this.paintedEpoch === this.epoch) return this.openNote();
    if (matchesKey(data, "enter") && !this.textPage() && this.paintedEpoch === this.epoch) {
      const item = this.rows[this.cursor];
      if (item && this.cursor >= this.offset && this.cursor < this.offset + this.viewport) this.open(item.id);
    }
  }

  dispose(): void { this.disposed = true; this.clearGeometry(); }

  private read(): ContextSnapshot | undefined {
    try { return this.options.snapshot(); } catch { return undefined; }
  }

  private present(snapshot: ContextSnapshot, id: ContextCategory): boolean {
    const category = snapshot.categories.find((entry) => entry.id === id);
    return !!category && (category.rawTokens > 0 || category.count > 0);
  }

  private orderedRows(snapshot: ContextSnapshot): Row[] {
    const rows: Row[] = snapshot.items.filter((item) =>
      (this.selected ? item.category === this.selected : item.category !== "other") && (item.rawTokens > 0 || item.count > 0));
    if (!this.selected) {
      const other = snapshot.categories.find((category) => category.id === "other");
      if (other && (other.rawTokens > 0 || other.count > 0)) rows.push({
        ...other, id: "category:other", category: "other", label: LABELS.other, kind: "unattributed", rawState: "not-applicable",
      });
    }
    const rank = new Map(this.order.map((id, index) => [id, index]));
    rows.sort((a, b) => {
      const ar = rank.get(a.id), br = rank.get(b.id);
      if (ar !== undefined || br !== undefined) return (ar ?? Infinity) - (br ?? Infinity);
      // Other is an independent SDK ledger, never a raw-vs-SDK competitor.
      if (a.category === "other" || b.category === "other") return a.category === b.category ? 0 : a.category === "other" ? -1 : 1;
      const weight = (row: Row): number => snapshot.allocation === "proportional"
        ? number(row.tokens) ?? -1 : row.rawState === "estimate" ? number(row.rawTokens) ?? -1 : -1;
      return weight(b) - weight(a) || a.id.localeCompare(b.id);
    });
    // Preserve the first visible row, not merely its numeric offset, if earlier
    // items disappear. New items append; changing tabs intentionally re-sorts.
    const anchor = this.order[this.offset];
    const cursorAnchor = this.order[this.cursor];
    this.order = rows.map((row) => row.id);
    if (anchor && this.order.includes(anchor)) this.offset = this.order.indexOf(anchor);
    if (cursorAnchor && this.order.includes(cursorAnchor)) this.cursor = this.order.indexOf(cursorAnchor);
    return rows;
  }

  private usage(snapshot: ContextSnapshot): string {
    const window = number(snapshot.usage.contextWindow);
    // The collector uses zero as an unknown-window sentinel, not zero capacity.
    return `${count(snapshot.usage.tokens)}/${window ? count(window) : "?"} · ${percent(window ? snapshot.usage.percent : undefined)}`;
  }

  /** Always full-window occupancy. Selection only affects paint, never allocation. */
  private bar(snapshot: ContextSnapshot, width: number): string {
    let figures = this.usage(snapshot);
    const compact = safe(this.options.compaction?.());
    if (compact && visibleWidth(figures) + visibleWidth(compact) + 10 <= width) figures += ` · ${truncateToWidth(compact, 20, "…")}`;
    const cells = Math.max(0, width - visibleWidth(figures) - 1);
    if (!cells) return pad(figures, width, true);
    const total = number(snapshot.usage.tokens);
    const window = number(snapshot.usage.contextWindow);
    if (total === undefined || !window) return pad(this.fg("dim", truncateToWidth("Usage unknown", cells, "")), cells) + " " + figures;
    const used = Math.min(cells, Math.round(cells * Math.min(1, total / window)));
    const weights = CATEGORIES.map((id) => {
      const category = snapshot.categories.find((entry) => entry.id === id);
      return category ? number(category.tokens) ?? 0 : 0;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    // Cumulative rounding is deterministic and sums to exactly the occupied
    // cells. If no attribution is known, all occupied cells are Other.
    let previous = 0, cumulative = 0;
    const pieces = CATEGORIES.map((id, index) => {
      cumulative += sum ? weights[index]! / sum : id === "other" ? 1 : 0;
      const end = Math.min(used, Math.round(used * cumulative));
      const text = "█".repeat(Math.max(0, end - previous));
      previous = end;
      return text ? this.segment(id, text) : "";
    });
    return pieces.join("") + this.fg("dim", "░".repeat(cells - used)) + " " + figures;
  }

  private segment(id: ContextCategory, text: string): string {
    const theme = this.options.theme;
    const selected = this.selected === id;
    // Alpha is simulated against the current theme's panel background, not a
    // fixed light/dark RGB palette. No used segment is dimmed to the free tier.
    try {
      const colors = theme.colors;
      if (colors?.accent && colors.userMessageBg && typeof theme.style === "function") {
        const alpha = selected ? 1 : this.selected ? Math.max(0.44, ALPHA[id] * 0.75) : ALPHA[id];
        return theme.style(text, { fg: mixColors(colors.userMessageBg, colors.accent, alpha, "srgb"), bold: selected });
      }
    } catch { /* Older/minimal test themes still have semantic foregrounds. */ }
    const tones: Record<ContextCategory, Tone> = { system: "accent", summary: "text", messages: "muted", tools: "accent", other: "muted" };
    const result = this.fg(selected ? "accent" : this.selected ? "muted" : tones[id], text);
    return selected || (!this.selected && id === "system") ? theme.bold(result) : result;
  }

  private share(tokens: unknown, total: number | undefined): string {
    const value = number(tokens);
    return total && value !== undefined ? percent(value / total * 100) : "?";
  }

  /** One basis for headers, measured columns, visible cells and details. Numeric
   * raw placeholders are never evidence that a source estimate is available. */
  private displayBasis(snapshot: ContextSnapshot, row?: Row) {
    const proportional = snapshot.allocation === "proportional";
    const raw = row?.rawState === "not-applicable" ? "—"
      : row?.rawState === "estimate" ? count(row.rawTokens) : "?";
    const sdk = count(row?.tokens);
    return {
      primaryHeader: proportional ? "≈tok" : "≈raw",
      secondaryHeader: proportional ? "%used" : snapshot.allocation === "unattributed" ? "SDK tok" : "",
      primary: proportional ? sdk : raw,
      secondary: proportional ? this.share(row?.tokens, number(snapshot.usage.tokens)) : sdk,
      raw, sdk,
    };
  }

  private table(snapshot: ContextSnapshot, width: number): { header: string; cell: (row: Row, index: number) => string } {
    const basis = this.displayBasis(snapshot);
    if (!this.metrics) {
      const metrics = { primary: visibleWidth(basis.primaryHeader), secondary: visibleWidth(basis.secondaryHeader), kind: 4 };
      for (const row of this.rows) {
        const value = this.displayBasis(snapshot, row);
        metrics.primary = Math.max(metrics.primary, visibleWidth(value.primary));
        metrics.secondary = Math.max(metrics.secondary, visibleWidth(value.secondary));
        metrics.kind = Math.min(14, Math.max(metrics.kind, visibleWidth(safe(row.kind))));
      }
      this.metrics = metrics;
    }
    const { primary: primaryWidth, secondary: secondaryWidth, kind: kindWidth } = this.metrics;
    let kind = true, secondary = !!basis.secondaryHeader;
    const fixed = (): number => 2 + primaryWidth + (kind ? 2 + kindWidth : 0) + (secondary ? 2 + secondaryWidth : 0);
    if (width - fixed() < 12) kind = false;
    if (width - fixed() < 12) secondary = false;
    const sourceWidth = Math.max(0, width - fixed());
    const line = (source: string, k: string, primary: string, other: string): string =>
      pad(truncateToWidth(source, sourceWidth, "…"), sourceWidth) +
      (kind ? "  " + pad(truncateToWidth(k, kindWidth, "…"), kindWidth) : "") +
      "  " + pad(primary, primaryWidth, true) + (secondary ? "  " + pad(other, secondaryWidth, true) : "");
    return {
      header: line("Source", "Kind", basis.primaryHeader, basis.secondaryHeader),
      cell: (row, index) => this.cell(row, index, snapshot, line),
    };
  }

  private cell(row: Row, index: number, snapshot: ContextSnapshot,
    line: (source: string, kind: string, primary: string, secondary: string) => string): string {
    const value = this.displayBasis(snapshot, row);
    const text = line(safe(row.label), safe(row.kind), value.primary, value.secondary);
    return index === this.cursor ? this.fg("accent", this.options.theme.bold(text)) : this.fg("text", text);
  }

  private estimates(snapshot: ContextSnapshot, compact = false): string {
    const label = snapshot.allocation === "proportional" ? (compact ? "≈scaled" : "≈ proportional estimates")
      : snapshot.allocation === "unattributed" ? (compact ? "≈unattr" : "≈ unattributed estimates")
        : (compact ? "≈raw" : "≈ raw estimates");
    return label + (snapshot.attribution === "partial" ? (compact ? " partial" : " · partial") : "");
  }

  private rawComparison(snapshot: ContextSnapshot): string {
    return `Available raw subtotal ${count(snapshot.rawTokens)} | SDK total ${count(snapshot.usage.tokens)} (not normalized)`;
  }

  private metadata(item: Row, snapshot: ContextSnapshot): string[] {
    const value = this.displayBasis(snapshot, item);
    const rawQualifier = item.rawState === "not-applicable" ? "not applicable"
      : item.rawState === "estimate" ? "not provider token accounting" : "unknown";
    return [
      `Source ${safe(item.label)}`,
      `${LABELS[item.category]} · ${safe(item.kind)} · count ${count(item.count)}`,
      `SDK allocation ${value.sdk} tokens · ${this.estimates(snapshot)}`,
      `Raw estimate ${value.raw}${item.rawState === "estimate" ? " tokens" : ""} · ${rawQualifier}`,
      ...(item.detail ?? []).map((line) => safe(line)),
    ];
  }

  private top(width: number): string {
    const theme = this.options.theme;
    const close = !!popoverCloseHit(width);
    const limit = width - (close ? 5 : 1);
    let x = 2;
    let result = this.fg("borderAccent", POPOVER.tl + POPOVER.h);
    const title = " Context ";
    result += this.fg(this.selected === undefined ? "accent" : "muted", theme.bold(title));
    this.target(x, x + visibleWidth(title), 0, () => { this.reset(undefined); this.changed(); });
    x += visibleWidth(title);
    const full = this.tabs.reduce((sum, id) => sum + visibleWidth(LABELS[id]) + 2, 0);
    const short: Record<ContextCategory, string> = { system: "Sys", summary: "Sum", messages: "Msg", tools: "Tool", other: "" };
    const tiny: Record<ContextCategory, string> = { system: "S", summary: "Σ", messages: "M", tools: "T", other: "" };
    const shortWidth = this.tabs.reduce((sum, id) => sum + visibleWidth(short[id]) + 2, 0);
    const room = limit - x;
    for (const id of this.tabs) {
      const label = full <= room ? LABELS[id] : shortWidth <= room ? short[id] : tiny[id];
      const raw = this.selected === id ? `›${label}‹` : ` ${label} `;
      if (x + visibleWidth(raw) > limit) break;
      result += this.fg(this.selected === id ? "accent" : "muted", this.selected === id ? theme.bold(raw) : raw);
      const start = x;
      x += visibleWidth(raw);
      this.target(start, x, 0, () => this.select(id));
    }
    result += this.fg("borderAccent", POPOVER.h.repeat(Math.max(0, limit - x)));
    return result + (close ? popoverCloseTail(theme) : this.fg("borderAccent", POPOVER.tr));
  }

  private bottom(width: number, y: number, snapshot: ContextSnapshot): string {
    const total = this.textPage() ? this.detailLines.length : this.rows.length;
    const offset = this.textPage() ? this.detailOffset : this.offset;
    const range = total ? `${offset + 1}-${Math.min(total, offset + this.viewport)}/${total}` : "0/0";
    const canPrev = offset > 0, canNext = offset + this.viewport < total;
    let x = 2;
    let result = this.fg("borderAccent", POPOVER.bl + POPOVER.h);
    const add = (text: string, action?: () => void, reserve = 0): void => {
      if (x + visibleWidth(text) > width - 2 - reserve) return;
      const start = x;
      result += this.fg(action ? "accent" : "dim", text);
      x += visibleWidth(text);
      if (action) this.target(start, x, y, action);
    };
    const compact = ` ${this.estimates(snapshot, true)}`;
    const reserve = visibleWidth(compact);
    const prev = width < 48 ? " ‹ " : " Prev ", next = width < 48 ? " › " : " Next ";
    // State and working pagers take priority over range text at tiny widths.
    add(` ${range} `, undefined, reserve + (canPrev ? visibleWidth(prev) : 0) + (canNext ? visibleWidth(next) : 0));
    if (canPrev) add(prev, () => this.page(-1), reserve + (canNext ? visibleWidth(next) : 0));
    if (canNext) add(next, () => this.page(1), reserve);
    const hint = this.options.isFocused?.() ? (this.textPage() ? "Esc back"
      : `${this.rows.length > 1 ? "↑↓ · " : ""}${this.rows.length ? "Enter · " : ""}${this.tabs.length ? "Tab · " : ""}N note · Esc`) : "";
    const scaling = `raw ${count(snapshot.rawTokens)} → SDK ${count(snapshot.usage.tokens)}`;
    const estimate = !this.textPage() && !this.selected && snapshot.allocation === "proportional"
      ? `${this.estimates(snapshot)} · ${scaling}` : this.estimates(snapshot);
    // The entire qualifier is a note-page target, including in narrow layouts.
    // Never truncate figures or infer allocation/completeness from English note.
    const caveats = [
      ...(hint ? [` · ${estimate} · ${hint} `] : []), ` · ${estimate} `,
      ...(hint ? [` · ${this.estimates(snapshot)} · ${hint} `] : []),
      ` · ${this.estimates(snapshot)} `, compact,
    ];
    add(caveats.find((text) => visibleWidth(text) <= width - 2 - x) ?? "", this.showingNote ? undefined : () => this.openNote());
    result += this.fg("borderAccent", POPOVER.h.repeat(Math.max(0, width - 1 - x)) + POPOVER.br);
    return result;
  }

  private open(id: string): void {
    const item = this.rows.find((row) => row.id === id);
    if (!item) return;
    // The overview includes sources from every category and one aggregate
    // unattributed row. Details always replace, never expand, this viewport.
    this.detail = item;
    this.showingNote = false;
    this.detailOffset = 0;
    this.changed();
  }

  private openNote(): void {
    this.showingNote = true;
    this.detail = undefined;
    this.detailOffset = 0;
    this.changed();
  }

  private textPage(): boolean { return this.showingNote || !!this.detail; }

  private select(id: ContextCategory): void {
    const snapshot = this.read();
    if (!snapshot || id === "other" || !this.present(snapshot, id)) return;
    this.reset(id);
    this.changed();
  }

  private cycle(direction: number): void {
    const choices: (ContextCategory | undefined)[] = [undefined, ...this.tabs];
    const at = choices.indexOf(this.selected);
    this.reset(choices[(at + direction + choices.length) % choices.length]);
    this.changed();
  }

  private reset(id: ContextCategory | undefined): void {
    this.selected = id;
    this.detail = undefined;
    this.showingNote = false;
    this.cachedSnapshot = undefined;
    this.order = [];
    this.offset = this.detailOffset = this.cursor = 0;
  }

  private page(direction: number): void {
    const total = this.textPage() ? this.detailLines.length : this.rows.length;
    const max = Math.max(0, total - this.viewport);
    const offset = this.textPage() ? this.detailOffset : this.offset;
    const next = Math.max(0, Math.min(max, offset + direction * this.viewport));
    if (next === offset) return;
    if (this.textPage()) this.detailOffset = next;
    else { this.offset = next; this.cursor = next; }
    this.changed(true);
  }

  private move(delta: number): void {
    const before = this.textPage() ? this.detailOffset : this.cursor;
    if (this.textPage()) {
      this.detailOffset = Math.max(0, Math.min(Math.max(0, this.detailLines.length - this.viewport), this.detailOffset + delta));
    } else {
      this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
      if (this.cursor < this.offset) this.offset = this.cursor;
      if (this.cursor >= this.offset + this.viewport) this.offset = this.cursor - this.viewport + 1;
    }
    if ((this.textPage() ? this.detailOffset : this.cursor) !== before) this.changed(true);
  }

  private ready(): boolean {
    return this.navigationReady && size(this.options.availableRows()) >= this.paintedHeight && this.read() === this.paintedSnapshot;
  }

  private changed(keepNavigation = false): void {
    this.epoch++;
    this.targets = [];
    if (!keepNavigation) this.navigationReady = false;
    this.options.requestRender();
  }
  private close(): void { if (!this.disposed) { this.dispose(); this.options.close(); } }
  private clearGeometry(): void {
    this.targets = [];
    this.navigationReady = false;
    this.paintedEpoch = -1;
    this.paintedSnapshot = undefined;
    this.paintedWidth = this.paintedHeight = 0;
  }
  private target(x: number, end: number, y: number, action: () => void): void { this.targets.push({ x, end, y, action }); }
  private fg(tone: Tone, text: string): string { return this.options.theme.fg(tone, text); }
  private fit(line: string, width: number): string { return pad(truncateToWidth(line, width, ""), width); }
  private row(content: string, width: number): string {
    if (width < 4) return this.fit(content, width);
    return `${popoverSide(this.options.theme)} ${this.fit(content, width - 4)} ${popoverSide(this.options.theme)}`;
  }
  private finishPaint(lines: string[], width: number): string[] {
    this.paintedWidth = width;
    this.paintedHeight = lines.length;
    this.paintedEpoch = this.epoch;
    this.options.onRender?.(lines.length);
    return lines.map((line) => this.fit(line, width));
  }
}
