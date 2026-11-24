import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  onBorderLabelsChange,
  popoverChromeLayout,
  popoverTextRect,
} from "../../shared/popover-chrome.mjs";
import { createPopoverCloseControl } from "../../shared/popover-close-control.mjs";
import { createPopoverTextSelection } from "../../shared/popover-text-selection.mjs";
import type { OwnerChangesSnapshot } from "../runtime/owner-changes.ts";
import { OverlayRequest } from "./overlay-request.ts";
import { popoverBottom, popoverChromeCloseHit, popoverRow, popoverTitleRows } from "./popover.ts";
import { clipPlainText, graphemes, wrapPlainText } from "./text.ts";

type FileChange = OwnerChangesSnapshot["groups"][number];
type Row = {
  text: string;
  color: "accent" | "text" | "muted" | "toolDiffAdded" | "toolDiffRemoved";
  prefix?: string;
};
type View = "list" | "file" | "all";
type Mode = "net" | "history";
type Button = Mode | "toggle" | "reset";
type ResetKey = "r" | "y";
type PointerAction = "back" | Button | number;
type Line = { file: number; row: number; offset: number };
const MAX_HEIGHT = 32;
const MAX_WRAPPED_ROWS = 2 * MAX_HEIGHT;
const BACK = "‹ Files";
const EXPAND = "Expand all";
const COLLAPSE = "Collapse all";
const UPDATED = " · Updated";
const EMPTY: OwnerChangesSnapshot = { groups: [], truncated: false, workspaceHints: 0 };
const MISSING = {
  incomplete: "The retained observations are incomplete.",
  ambiguous: "The observed edits could not be composed reliably.",
  overlapping: "Overlapping edits could not be ordered reliably.",
  "write-no-before": "A write has no captured before text.",
  sensitive: "Some content was withheld for this target.",
  "missing-or-unverified": "No verified tool-result diff was captured.",
  oversized: "The tool-result diff exceeded preview limits.",
  truncated: "The captured edit content was incomplete.",
};

/** Keep a title, scope/path, body row, key hints and lower edge visible. */
export const changesMinRows = (): number => popoverChromeLayout({ framed: true }).top.rows + 4;

// Keep lexical paths unambiguous, including whitespace and literal escapes.
// Patch text is already a display projection: preserve its escape spellings,
// but never let unexpected control characters reach the terminal.
function literal(text: string, path = false): string {
  const unsafe = path
    ? /[\\\p{Cc}\p{Bidi_Control}\p{Z}\u200b\u2060\ufeff]/gu
    : /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu;
  return text.replace(unsafe, (char) =>
    char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function counts(patch: { added: number; removed: number }): string {
  return `+${patch.added} −${patch.removed}`;
}

function* patchRows(
  patch: Extract<FileChange["net"], { kind: "edit" }> & { truncated?: boolean; redacted?: boolean },
): Generator<Row, void> {
  if (patch.truncated)
    yield { color: "muted", text: "Preview limited: some changed content is omitted." };
  if (patch.redacted) yield { color: "muted", text: "Some content has been redacted." };
  for (const line of patch.lines) {
    yield {
      color: line.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved",
      prefix: `${line.kind === "add" ? "+" : "−"} ${line.line} │ `,
      text: line.text,
    };
    if (line.noLf) yield { color: "muted", text: "\\ No newline at end of file" };
  }
  if (!patch.lines.length && !patch.truncated && !patch.redacted)
    yield { color: "text", text: "No changed lines were reported." };
}

function* detailRows(file: FileChange, mode: Mode): Generator<Row, void> {
  yield { color: "accent", text: literal(file.path, true) };
  if (mode === "net") {
    const net = file.net;
    if (net.kind === "edit") {
      yield {
        color: "muted",
        text: `Net since first observed edit · ${counts(net)} · not a disk diff`,
      };
      yield* patchRows(net);
    } else if (net.kind === "unavailable") {
      yield { color: "text", text: "Net diff unknown." };
      yield { color: "muted", text: MISSING[net.reason] };
    }
    return;
  }
  for (const { attempt, patch } of file.reports) {
    const status =
      patch?.kind === "edit"
        ? counts(patch)
        : attempt.outcome === "failed"
          ? "failed"
          : attempt.outcome === "unknown"
            ? "unconfirmed"
            : "no diff";
    yield {
      color: "muted",
      text: `Agent ${literal(attempt.agentLabel || attempt.agentId)} · ${attempt.tool} · ${status}`,
    };
    if (patch?.kind === "edit") yield* patchRows(patch);
    else if (patch) yield { color: "text", text: MISSING[patch.reason] };
  }
}

/** Unlike prose wrapping, don't drop ASCII indentation or runs of spaces in code. */
function codeRows(prefix: string, text: string, width: number): string[] {
  if (prefix.length >= width - 1) prefix = `${prefix[0]} `;
  const available = width - prefix.length;
  const continuation = " ".repeat(prefix.length);
  text = literal(text);
  // Plain ASCII after sanitization is one column per code unit. Wrap by
  // slices, not graphemes, while keeping every indentation/space column.
  if (!/[^ -~]/.test(text)) {
    const lines = [prefix + text.slice(0, available)];
    for (let i = available; i < text.length; i += available)
      lines.push(continuation + text.slice(i, i + available));
    return lines;
  }
  if (visibleWidth(text) <= available) return [prefix + text];
  const lines: string[] = [];
  let line = "",
    columns = 0;
  const add = () => lines.push((lines.length ? continuation : prefix) + line);
  for (const { segment } of graphemes.segment(text)) {
    const size = visibleWidth(segment);
    if (columns + size > available && columns > 0) {
      add();
      line = "";
      columns = 0;
    }
    line += size > available ? "…" : segment;
    columns += size > available ? 1 : size;
  }
  add();
  return lines;
}

/** Cancels a queued or mounted Changes view without touching another panel. */
export class ChangesPanelRequest extends OverlayRequest<void> {
  constructor() {
    super(() => {}, undefined);
  }
  mount(done: () => void, blocked: boolean): boolean {
    return this.attach(done, blocked);
  }
}

export type ChangesPlacement = {
  rows(): number;
  position(): string;
  measure(height: number): void;
};
type FileRows = { rows: Row[]; pending?: Generator<Row, void> };
type WrappedRow = { color: Row["color"]; lines: string[] };
type Frame = {
  width: number;
  height: number;
  lines: string[];
  position?: string;
  closeHovered: boolean;
  /** Undefined when this frame cannot show Reset even if the Owner allows it. */
  resetAvailable?: boolean;
  fileY?: number;
  fileCount?: number;
  backY?: number;
  controls: { action: Button; y: number; left: number; right: number }[];
};

export type ChangesReset = {
  available(): boolean;
  /** Cheap live presence, so an initially empty panel can offer a refresh via Reset. */
  hasObservations?(): boolean;
  /** Reset only the expected snapshot; return a newer one without clearing it. */
  run(expected: OwnerChangesSnapshot): boolean | OwnerChangesSnapshot;
};

type ChangesPanelOptions = {
  tui: Pick<TUI, "terminal" | "requestRender">;
  theme: Pick<Theme, "fg" | "bold">;
  keybindings: Pick<KeybindingsManager, "matches">;
  snapshot: OwnerChangesSnapshot;
  placement?: ChangesPlacement;
  close: () => void;
  reset?: ChangesReset;
  switchPanel?: (data: string) => boolean;
};

/** Snapshot on opening; Reset refreshes a stale view or clears a current one. */
export class ChangesPanel implements Component {
  private readonly options: Omit<ChangesPanelOptions, "snapshot">;
  private readonly unsubscribeChrome?: () => void;
  private readonly closeControl;
  private readonly textSelection;
  private readonly fileRowsCache = new Map<number, FileRows>();
  private readonly wrapped = new Map<string, WrappedRow>();
  private wrapWidth = 0;
  private frame?: Frame;
  private mode: Mode = "net";
  private reveal: View = "list";
  private snapshot: OwnerChangesSnapshot;
  private retryReset?: ResetKey;
  private netFiles: readonly FileChange[];
  private top: Line = { file: 0, row: 0, offset: 0 };
  private listTop = 0;
  private selected = 0;
  private selectedPath?: string;
  private page = 0;
  private atEnd = false;
  private press?: { frame: Frame; action?: PointerAction };
  private closed = false;

  constructor({ snapshot, ...options }: ChangesPanelOptions) {
    this.options = options;
    this.snapshot = snapshot;
    this.netFiles = snapshot.groups.filter(({ net }) => net.kind !== "unchanged");
    this.selectedPath = this.netFiles[0]?.path;
    this.closeControl = createPopoverCloseControl({
      closeHit: popoverChromeCloseHit,
      host: options.tui,
      requestRender: () => options.tui.requestRender(),
    });
    this.textSelection = createPopoverTextSelection({ host: options.tui, component: this });
    if (options.placement)
      this.unsubscribeChrome = onBorderLabelsChange(() => {
        this.invalidate();
        options.tui.requestRender();
      });
  }

  invalidate(): void {
    this.frame = undefined;
    this.textSelection.reset();
    this.closeControl.reset(false);
  }

  private refresh(): void {
    this.frame = undefined;
    this.options.tui.requestRender();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.snapshot = EMPTY;
    this.netFiles = EMPTY.groups;
    this.frame = undefined;
    this.press = undefined;
    this.fileRowsCache.clear();
    this.wrapped.clear();
    this.closeControl.dispose();
    this.textSelection.dispose();
    this.unsubscribeChrome?.();
  }

  private get files(): readonly FileChange[] {
    return this.mode === "net" ? this.netFiles : this.snapshot.groups;
  }

  private get view(): View {
    // An empty Net list can keep the all-files choice for a return to History.
    return this.files.length ? this.reveal : "list";
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return;
    const topPath = this.view === "all" ? this.files[this.top.file]?.path : undefined;
    this.mode = mode;
    const selected = this.files.findIndex(({ path }) => path === this.selectedPath);
    // If Net hides this path, display a fallback without losing the History selection.
    this.selected = Math.max(0, selected);
    const anchor = topPath ? this.files.findIndex(({ path }) => path === topPath) : -1;
    const reveal = this.reveal === "file" && selected < 0 ? "list" : this.reveal;
    this.show(reveal, anchor < 0 ? this.selected : anchor);
  }

  private show(view: View, file = 0): void {
    this.reveal = view;
    this.top = { file, row: 0, offset: 0 };
    this.atEnd = false;
    this.fileRowsCache.clear();
    this.wrapped.clear();
    this.invalidate();
    this.options.tui.requestRender();
  }

  private open(index: number): void {
    if (!this.files[index]) return;
    this.select(index);
    this.show("file", index);
  }

  private select(index: number): void {
    this.selected = index;
    this.selectedPath = this.files[index]?.path;
  }

  private back(): void {
    if (this.view === "list") this.options.close();
    else this.show("list");
  }

  private toggleAll(): void {
    if (this.reveal === "all") this.show("list");
    else if (this.view === "list" && this.files.length) this.show("all");
  }

  private resetAvailable(): boolean {
    const { reset } = this.options;
    const { groups, truncated, workspaceHints } = this.snapshot;
    return (
      !!reset &&
      (groups.length > 0 ||
        truncated ||
        workspaceHints > 0 ||
        reset.hasObservations?.() === true) &&
      reset.available()
    );
  }

  private reset(key?: ResetKey): void {
    const { placement, reset } = this.options;
    const frame = this.frame;
    if (!frame?.controls.some(({ action }) => action === "reset")) return;
    if (placement?.position() !== frame.position || !reset) return;
    if (!this.resetAvailable()) return this.refresh();
    const result = reset.run(this.snapshot);
    if (!result || this.closed) return;
    const selectedPath = this.selectedPath;
    if (result === true) {
      this.snapshot = EMPTY;
      this.netFiles = EMPTY.groups;
      this.mode = "net";
      this.retryReset = undefined;
      this.select(0);
    } else {
      this.snapshot = result;
      this.netFiles = result.groups.filter(({ net }) => net.kind !== "unchanged");
      // Legacy terminals send identical bytes for held keys and fresh presses.
      // After a refresh, require a different key from the one that caused it.
      this.retryReset = key ? (key === "r" ? "y" : "r") : (this.retryReset ?? "y");
      const selected = this.files.findIndex(({ path }) => path === selectedPath);
      this.select(Math.max(0, selected));
    }
    // Release the old projection's selection and caches before any new action.
    this.listTop = 0;
    this.press = undefined;
    this.show("list");
  }

  // Project only the prefix the viewport has reached, even when hundreds of
  // reports belong to one file. Walking back across a file boundary needs its
  // last logical row, so that case may explicitly request the whole file.
  private fileRows(file: number, through: number): Row[] {
    const cache = this.fileRowsCache;
    let entry = cache.get(file);
    if (!entry) {
      entry = { rows: [], pending: detailRows(this.files[file]!, this.mode) };
      if (cache.size >= MAX_HEIGHT) cache.delete(cache.keys().next().value!);
      cache.set(file, entry);
    }
    while (entry.pending && entry.rows.length <= through) {
      const next = entry.pending.next();
      if (next.done) entry.pending = undefined;
      else entry.rows.push(next.value);
    }
    return entry.rows;
  }

  private wrappedRow(file: number, index: number): WrappedRow {
    const key = `${file}:${index}`;
    const cached = this.wrapped.get(key);
    if (cached) return cached;
    const { prefix, text, color } = this.fileRows(file, index)[index]!;
    const lines = prefix
      ? codeRows(prefix, text, this.wrapWidth)
      : wrapPlainText(text, this.wrapWidth);
    const row = { color, lines };
    if (this.wrapped.size >= MAX_WRAPPED_ROWS)
      this.wrapped.delete(this.wrapped.keys().next().value!);
    this.wrapped.set(key, row);
    return row;
  }

  private step({ file, row, offset }: Line, direction: -1 | 1): Line | undefined {
    if (direction < 0) {
      if (offset > 0) return { file, row, offset: offset - 1 };
      if (row > 0)
        return { file, row: row - 1, offset: this.wrappedRow(file, row - 1).lines.length - 1 };
      if (this.view === "all" && file > 0) {
        const last = this.fileRows(file - 1, Infinity).length - 1;
        return {
          file: file - 1,
          row: last,
          offset: this.wrappedRow(file - 1, last).lines.length - 1,
        };
      }
    } else {
      if (offset + 1 < this.wrappedRow(file, row).lines.length)
        return { file, row, offset: offset + 1 };
      if (this.fileRows(file, row + 1)[row + 1]) return { file, row: row + 1, offset: 0 };
      if (this.view === "all" && file + 1 < this.files.length)
        return { file: file + 1, row: 0, offset: 0 };
    }
  }

  private move(delta: number): void {
    if (!this.page || !Number.isFinite(delta)) return;
    const size = Math.min(this.page, Math.abs(Math.trunc(delta)));
    if (this.view !== "list") {
      if (delta > 0 && this.atEnd) return;
      let next = this.top;
      for (let i = 0; i < size; i++) {
        const step = this.step(next, delta < 0 ? -1 : 1);
        if (!step) break;
        next = step;
      }
      if (next === this.top) return;
      this.top = next;
      this.atEnd = false;
    } else {
      const next = Math.max(
        0,
        Math.min(this.files.length - 1, this.selected + Math.sign(delta) * size),
      );
      if (next === this.selected) return;
      this.select(next);
    }
    this.textSelection.reset();
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (isKeyRelease(data) || this.options.switchPanel?.(data)) return;
    const { keybindings: keys, placement } = this.options;
    if (matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel")) return this.back();
    if (!this.page || (placement && placement.rows() < changesMinRows())) return;
    const resetKey = this.retryReset ?? "r";
    if (matchesKey(data, resetKey) || matchesKey(data, `shift+${resetKey}`)) {
      if (!isKeyRepeat(data)) this.reset(resetKey);
    } else if (matchesKey(data, "h") || matchesKey(data, "shift+h"))
      this.setMode(this.mode === "net" ? "history" : "net");
    else if (this.view !== "file" && (matchesKey(data, "a") || matchesKey(data, "shift+a")))
      this.toggleAll();
    else if (keys.matches(data, "tui.select.confirm") && this.view === "list")
      this.open(this.selected);
    else if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (keys.matches(data, "tui.select.pageUp")) this.move(-this.page);
    else if (keys.matches(data, "tui.select.pageDown")) this.move(this.page);
  }

  private pointerAction(frame: Frame, { x, y }: TuiMouseEvent): PointerAction | undefined {
    const control = frame.controls.find((hit) => y === hit.y && x >= hit.left && x <= hit.right);
    if (control) return control.action;
    if (y === frame.backY && x >= 1 && x <= BACK.length) return "back";
    const index = y - (frame.fileY ?? Infinity);
    if (x > 0 && x < frame.width - 1 && index >= 0 && index < (frame.fileCount ?? 0))
      return this.listTop + index;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const placement = this.options.placement;
    if (this.closed || !placement) return;
    if (event.type === "press") this.press = undefined;
    const frame = this.frame;
    const current = !!frame && placement.position() === frame.position && !!this.page;
    const close = this.closeControl.mouse(event, current);
    if (close?.handled) {
      if (close.close) this.options.close();
      return { handled: true };
    }
    if (event.type === "wheel") {
      if (current) this.move(event.wheelDelta ?? 0);
      return { handled: true };
    }
    if (event.button !== "left" || event.shift || event.alt || event.ctrl) return;
    if (event.type === "press") {
      // Pi can route a plain press to text selection. Claim buttons/rows,
      // but leave the diff body free for native selection and copy.
      const action = current ? this.pointerAction(frame, event) : undefined;
      this.press = frame && { frame, action };
      return action === undefined ? undefined : { handled: true };
    }
    if (event.type !== "click") return;
    const press = this.press;
    this.press = undefined;
    if (!current || (press && press.frame !== frame)) return { handled: true };
    const action = this.pointerAction(frame, event);
    if (action === undefined) return;
    if (action === "back") this.back();
    else if (action === "toggle") this.toggleAll();
    else if (action === "reset") {
      if (press?.action === "reset" && (event.clickCount ?? 1) === 1) this.reset();
    } else if (typeof action === "number") this.open(action);
    else this.setMode(action);
    return { handled: true, focus: true };
  }

  private visibleDiff(page: number): Line[] {
    const visible: Line[] = [];
    let next: Line | undefined = this.top;
    while (next && visible.length < page) {
      visible.push(next);
      next = this.step(next, 1);
    }
    this.atEnd = !next;
    // Clamp the last page without scanning any offscreen prefixes.
    if (visible.length < page) {
      const before: Line[] = [];
      while (before.length + visible.length < page) {
        const prev = this.step(this.top, -1);
        if (!prev) break;
        before.push(prev);
        this.top = prev;
      }
      return [...before.reverse(), ...visible];
    }
    return visible;
  }

  render(width: number): string[] {
    if (this.closed) return [];
    const { tui, theme, placement, reset } = this.options;
    const snapshot = this.snapshot;
    const minRows = placement ? changesMinRows() : 4;
    const terminalRows = tui.terminal.rows;
    const height = Math.min(
      terminalRows,
      MAX_HEIGHT,
      Math.max(minRows, Math.floor(terminalRows * 0.7)),
      placement?.rows() ?? Infinity,
    );
    const position = placement?.position();
    let resetAvailable: boolean | undefined;
    const painted = this.frame;
    if (
      painted?.width === width &&
      painted.height === height &&
      painted.position === position &&
      painted.closeHovered === this.closeControl.hovered
    ) {
      if (painted.resetAvailable === undefined) return painted.lines;
      resetAvailable = this.resetAvailable();
      if (painted.resetAvailable === resetAvailable) return painted.lines;
    }
    if (width < (placement ? COLLAPSE.length + 2 : COLLAPSE.length) || height < minRows) {
      this.invalidate();
      this.page = 0;
      const lines =
        width < 1 || height < 1
          ? []
          : [theme.fg("accent", clipPlainText("Enlarge terminal · Esc", width))];
      placement?.measure(lines.length);
      this.frame = { width, height, position, closeHovered: false, lines, controls: [] };
      return lines;
    }
    const framed = !!placement;
    const bodyWidth = framed ? width - 2 : width;
    if (this.wrapWidth !== bodyWidth) {
      this.wrapWidth = bodyWidth;
      this.wrapped.clear();
      // The collapsed paint sets the width too, so arrows can follow an
      // explicit reveal without waiting for its first full repaint.
      const { file, row, offset } = this.top;
      if (this.view !== "list" && offset > 0)
        this.top = {
          file,
          row,
          offset: Math.min(offset, this.wrappedRow(file, row).lines.length - 1),
        };
    }
    const titleText =
      this.view === "all"
        ? "Alehouse Changes › All files"
        : this.view === "file"
          ? "Alehouse Changes › File"
          : "Alehouse Changes";
    const title = () =>
      framed
        ? popoverTitleRows(theme, width, titleText, true, this.closeControl.hovered)
        : [theme.fg("accent", clipPlainText(titleText, width))];
    const titleRows = title();
    const hovered = this.closeControl.hovered;
    const frameRow = (styled: string) => (framed ? popoverRow(theme, styled, bodyWidth) : styled);
    const row = (color: Row["color"], text: string) =>
      frameRow(theme.fg(color, clipPlainText(text, bodyWidth)));
    const page = (this.page = height - titleRows.length - (framed ? 3 : 2));
    let body: string[];
    let footer: string;
    let fileCount: number | undefined;
    const n = this.files.length;
    const scope =
      (snapshot.truncated ? "Partial list · " : "") +
      (this.view === "list" ? `${n} ${n === 1 ? "file" : "files"} · ` : "") +
      (this.mode === "net" ? "Observed edits, not disk" : "Oldest first per file");
    const controls: Frame["controls"] = [];
    let header = "";
    let columns = 0;
    const append = (text: string, action?: Button, active = false) => {
      if (action)
        controls.push({
          action,
          y: titleRows.length,
          left: columns + 1,
          right: columns + text.length,
        });
      columns += text.length;
      header += theme.fg(action ? "accent" : "muted", active ? theme.bold(text) : text);
    };
    const separator = " · ";
    const { workspaceHints } = snapshot;
    if (workspaceHints) {
      // Show the full Reset scope before lower-priority controls, even after refresh.
      const hints = `${workspaceHints} ${workspaceHints === 1 ? "hint" : "hints"}`;
      if (hints.length <= bodyWidth) append(hints);
    }
    const modeRoom = bodyWidth - columns - (columns ? separator.length : 0);
    const showModes = modeRoom >= "Net/History".length;
    if (showModes) {
      if (columns) append(separator);
      const compact = modeRoom < 13;
      append(this.mode === "net" && !compact ? "[Net]" : "Net", "net", this.mode === "net");
      append(compact ? "/" : " ");
      append(
        this.mode === "history" && !compact ? "[History]" : "History",
        "history",
        this.mode === "history",
      );
    }
    const updated = this.retryReset && bodyWidth >= columns + UPDATED.length ? UPDATED : "";
    if (showModes && bodyWidth >= columns + 4 + updated.length) append(" [H]");
    if (updated) append(updated);
    const label = this.view === "all" ? COLLAPSE : this.view === "list" && n ? EXPAND : undefined;
    if (label && bodyWidth >= columns + separator.length + label.length) {
      append(separator);
      append(bodyWidth >= columns + label.length + 4 ? `${label} [A]` : label, "toggle");
    }
    header += theme.fg("muted", clipPlainText(separator + scope, bodyWidth - columns));
    if (this.view !== "list") {
      body = this.visibleDiff(page).map(({ file, row: index, offset }) => {
        const { color, lines } = this.wrappedRow(file, index);
        return row(color, lines[offset]!);
      });
      const { file, row: index, offset } = this.top;
      const scroll =
        this.atEnd && index === 0 && offset === 0 && (this.view === "file" || file === 0)
          ? ""
          : " · ↑↓ PgUp/PgDn";
      footer = (this.view === "all" ? "Esc collapse" : `${BACK} · Esc back`) + scroll;
    } else {
      this.listTop = Math.max(
        0,
        Math.min(
          Math.max(0, n - page),
          this.selected,
          Math.max(this.listTop, this.selected - page + 1),
        ),
      );
      const files = this.files.slice(this.listTop, this.listTop + page);
      fileCount = files.length;
      body = files.map((file, index) => {
        const selected = this.listTop + index === this.selected;
        const badge =
          this.mode === "history"
            ? `${file.reports.length} ${file.reports.length === 1 ? "report" : "reports"}`
            : file.net.kind === "edit"
              ? counts(file.net)
              : "Unknown";
        const room = bodyWidth - badge.length - 4;
        const path = literal(file.path, true);
        return row(
          selected ? "accent" : "text",
          `${selected ? "›" : " "} ${room >= 6 ? `${clipPlainText(path, room)}  ${badge}` : path}`,
        );
      });
      if (!files.length)
        body.push(
          row(
            "text",
            this.mode === "net" ? "No retained net changes." : "No retained edit/write reports.",
          ),
        );
      footer = n ? "Enter open · Esc close · ↑↓ PgUp/PgDn" : "Esc close";
    }
    let footerRow = row("muted", footer);
    const footerY = titleRows.length + 1 + body.length;
    const resetLabel = this.retryReset === "y" ? "Reset [Y]" : "Reset [R]";
    let resetColumn = visibleWidth(footer) + separator.length;
    // A narrow diff can offer Reset even if the normal file-list hints don't
    // fit beside it. Keep the retry visible without adding a line.
    if (this.retryReset && this.view === "list" && bodyWidth < resetColumn + resetLabel.length) {
      footer = "Esc close";
      resetColumn = footer.length + separator.length;
    }
    if (reset && bodyWidth >= resetColumn + resetLabel.length) {
      resetAvailable ??= this.resetAvailable();
      if (resetAvailable) {
        controls.push({
          action: "reset",
          y: footerY,
          left: resetColumn + 1,
          right: resetColumn + resetLabel.length,
        });
        footerRow = frameRow(
          theme.fg("muted", footer + separator) + theme.fg("accent", resetLabel),
        );
      }
    }
    const frame: Frame = {
      width,
      height,
      position,
      closeHovered: hovered,
      resetAvailable,
      lines: [
        ...titleRows,
        frameRow(header),
        ...body,
        footerRow,
        ...(framed ? [popoverBottom(theme, width)] : []),
      ],
      fileY: titleRows.length + 1,
      fileCount,
      backY: this.view === "file" ? footerY : undefined,
      controls,
    };
    this.closeControl.paint(width, framed, frame.lines.length);
    if (framed && hovered !== this.closeControl.hovered) {
      frame.closeHovered = this.closeControl.hovered;
      frame.lines.splice(0, titleRows.length, ...title());
    }
    if (framed && this.view !== "list") {
      this.textSelection.paint(
        popoverTextRect(width, frame.lines.length, { top: titleRows.length + 1, bottom: 2 }),
        `${this.mode}:${this.view}:${this.top.file}:${this.top.row}:${this.top.offset}`,
      );
    } else this.textSelection.reset();
    placement?.measure(frame.lines.length);
    this.frame = frame;
    return frame.lines;
  }
}
