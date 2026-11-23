import { createBackdropDismiss } from "../../shared/centered-dismiss.mjs";
import {
  centeredPanelTitleWidth,
  createCenteredPanel,
} from "../../extensions/lib/centered-panel.ts";
import { createPopoverCloseControl } from "../../shared/popover-close-control.mjs";
import { shortcutHint } from "../../shared/shortcut-hint.mjs";
import {
  onBorderLabelsChange,
  popoverChromeLayout,
  popoverTextRect,
} from "../../shared/popover-chrome.mjs";
import { createPopoverTextSelection } from "../../shared/popover-text-selection.mjs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Text,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Container,
  type Component,
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { OverlayCloseReason } from "./overlay-request.ts";
import type { ModelPickerPosition } from "./preset-picker.ts";
import {
  popoverChromeCloseHit,
  popoverLabelRows,
  popoverRow,
  popoverTitleRows,
  type PopoverTheme,
} from "./popover.ts";

type Model = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];
type NativeSelector = Component & Focusable & { dispose(): void; children: Component[] };
type Group = { size: number; target?: { provider: string; id: string } };
type Row = {
  text: string;
  plain: string;
  model: boolean;
  selected: boolean;
  group?: Group;
  first?: boolean;
};
type Target = { start: number; end: number; provider: string; id: string };
type TerminalSize = Pick<TUI["terminal"], "columns" | "rows">;
type SelectionProjection = {
  targets: Map<number, Target>;
  selectedVisible: boolean;
  /** False when the public tree could not be identified; keyboard then remains
   * available only while the native paint has a single, visible arrow. */
  structured: boolean;
  /** An unidentified paint with several arrows: one may be lookalike text (a
   * model name or error) standing in for a native selection cropped from view. */
  ambiguousArrow: boolean;
  visibleModel?: Group["target"];
};
const selectionProjection = (): SelectionProjection => ({
  targets: new Map(),
  selectedVisible: false,
  structured: false,
  ambiguousArrow: false,
});
type SelectionIssue = "closed" | "not_visible" | "identity_unverified";
// eslint-disable-next-line no-control-regex -- model metadata must not manufacture terminal rows
const hasTerminalControls = (value: string): boolean => /[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Only public terminal geometry. The host clamps row/col to the visible area
 * again after measuring the component, including on terminal resize. */
export function modelPopoverOptions(
  tui: TUI | undefined,
  position?: ModelPickerPosition,
): OverlayOptions {
  const columns = tui?.terminal.columns ?? 80,
    rows = tui?.terminal.rows ?? 24;
  const margin = columns > 4 && rows > 4 ? 1 : 0;
  const width = Math.max(1, Math.min(80, columns - 2 * margin));
  const point =
    position &&
    Number.isFinite(position.row) &&
    Number.isFinite(position.col) &&
    position.row >= 0 &&
    position.row < rows &&
    position.col >= 0 &&
    position.col < columns;
  return {
    anchor: point ? "top-left" : "center",
    width,
    minWidth: Math.min(32, width),
    maxHeight: Math.max(1, rows - 2 * margin),
    margin,
    ...(point ? { row: Math.floor(position.row) + 1, col: Math.floor(position.col) } : {}),
  };
}

/** A presentation adapter, not another model selector. Search, scope/Tab,
 * keybindings, catalog refresh and IME focus remain the native component's.
 * Its public component tree has no mouse API. Register only complete,
 * unambiguous painted model items, never lookalike text in catalog errors or
 * model-name details. Unknown tree formats remain keyboard-only. No private
 * selection/list fields or duplicated search/selection logic. */
export class PresetModelPopover implements Component, Focusable {
  private width = 0;
  private paintedViewport?: TerminalSize;
  private closePainted = false;
  private closed = false;
  private readonly backdrop = createBackdropDismiss();
  private unwatchBackdrop: (() => void) | undefined;
  private readonly closeHover: ReturnType<typeof createPopoverCloseControl>;
  private readonly selection: ReturnType<typeof createPopoverTextSelection>;
  private readonly unsubscribeChrome: () => void;
  readonly resize?: ReturnType<typeof createCenteredPanel>;
  private modelPress?: { target: Target; x: number; y: number };
  private targets = new Map<number, Target>();

  constructor(
    private readonly options: {
      native: NativeSelector;
      /** Actual TUI host; structural test callers may omit it. */
      tui?: Pick<TUI, "requestRender">;
      theme: PopoverTheme;
      title: string;
      height(): number;
      /** Current automatic width. Absent callers use the last rendered width. */
      currentWidth?(): number;
      /** Only provided for a centered fullscreen picker. */
      resizeTerminal?: () => TerminalSize;
      confirm?: { matches(data: string): boolean; warnHidden(): void };
      models(): readonly Model[];
      select(model: Model): void;
      cancel(reason?: OverlayCloseReason): void;
    },
  ) {
    this.selection = createPopoverTextSelection({ host: options.tui, component: this });
    this.closeHover = createPopoverCloseControl({
      closeHit: popoverChromeCloseHit,
      host: options.tui,
      requestRender: () => options.tui?.requestRender(),
    });
    if (options.resizeTerminal) {
      this.resize = createCenteredPanel({
        terminal: options.resizeTerminal,
        host: options.tui,
        theme: options.theme,
        requestRender: () => options.tui?.requestRender(),
        minWidth: 32,
        get minHeight() {
          return popoverChromeLayout({ framed: true }).rows + 3;
        },
        changed: () => {
          this.retireResizeHits();
          options.tui?.requestRender();
        },
      });
    }
    // One process-wide appearance switch: close-hit row and body budget move
    // together, so retire stale hits/selection/capture and request one repaint.
    this.unsubscribeChrome = onBorderLabelsChange(() => {
      this.resize?.reset();
      this.retireResizeHits();
      this.options.tui?.requestRender();
    });
  }

  private retireResizeHits(): void {
    if (this.resize) {
      this.paintedViewport = undefined;
      this.targets.clear();
      this.modelPress = undefined;
    }
    this.selection.reset();
    this.closeHover.reset(false);
  }

  private get height(): number {
    return Math.max(1, this.resize?.height ?? this.options.height());
  }
  private viewportStillPainted(): boolean {
    const viewport = this.options.resizeTerminal?.();
    return (
      !viewport ||
      (viewport.columns === this.paintedViewport?.columns &&
        viewport.rows === this.paintedViewport?.rows)
    );
  }

  get focused(): boolean {
    return this.options.native.focused;
  }
  set focused(value: boolean) {
    this.backdrop.focused = value;
    this.options.native.focused = value;
    if (!value && this.resize) {
      this.resize.reset();
      this.retireResizeHits();
    }
  }
  get capturesViewportInput(): boolean {
    return this.options.native.capturesViewportInput === true;
  }
  /** Never expand a hit map before the host paints that wider layout. A wider
   * dry layout could unwrap prose and move a click to another row. */
  private selectionWidth(): number {
    return Math.min(this.width, this.resize?.width ?? this.options.currentWidth?.() ?? this.width);
  }
  /** A dry layout validates current eligibility, but must not replace the
   * host's last-painted hit map. Otherwise a rejected stale click could grant
   * a second click on an item the host has never painted. */
  private recheck(): SelectionProjection {
    const projected = selectionProjection();
    this.layout(this.selectionWidth(), projected, false);
    return projected;
  }
  /** Recheck the current viewport and, when the tree is identified, the exact
   * submitted model. A caller can explain a rejection instead of silently
   * leaving a native selector waiting after it has disposed itself. */
  selectionIssue(model?: { provider: string; id: string }): SelectionIssue | undefined {
    if (this.closed) return "closed";
    // After a resize, a dry layout cannot establish what Pi has painted.
    if (this.resize?.modal || !this.viewportStillPainted()) return "not_visible";
    const current = this.recheck();
    if (current.ambiguousArrow) return "identity_unverified";
    if (!current.selectedVisible) return "not_visible";
    // An unidentified tree defers to the native selection its lone arrow paints.
    if (!model || !current.structured) return undefined;
    return current.visibleModel?.provider === model.provider && current.visibleModel.id === model.id
      ? undefined
      : "identity_unverified";
  }
  canSelect(model?: { provider: string; id: string }): boolean {
    return this.selectionIssue(model) === undefined;
  }
  handleInput(data: string): void {
    if (this.closed || this.resize?.input(data)) return;
    if (this.resize && !this.viewportStillPainted() && this.options.confirm?.matches(data)) {
      // Native confirmation disposes the selector (including a pending
      // refresh) before calling back. Let it keep running during repaint.
      this.options.confirm.warnHidden();
      return;
    }
    // Native input can scroll or refilter the list: a bound selection must
    // not outlive the rows it was anchored to.
    this.selection.reset();
    this.options.native.handleInput?.(data);
  }
  invalidate(): void {
    this.selection.reset();
    this.closeHover.reset();
    this.options.native.invalidate();
  }
  /** Pi retargets a captured click against the original press bounds. A
   * mounted centered picker must match that press, not just the current paint.
   * The backdrop disposer records handle attachment even when the hook is a
   * no-op; anchored pickers and unmounted callers keep click-only admission. */
  private get requiresModelPress(): boolean {
    return this.resize !== undefined && this.unwatchBackdrop !== undefined;
  }
  attachBackdrop(handle: OverlayHandle): void {
    const { tui } = this.options;
    if (!this.closed && tui && !this.unwatchBackdrop)
      this.unwatchBackdrop = this.backdrop.attach(tui, handle, () =>
        this.options.cancel("backdrop"),
      );
  }

  dispose(): void {
    if (this.closed) return;
    this.unsubscribeChrome();
    this.closed = true;
    this.resize?.reset();
    this.modelPress = undefined;
    this.unwatchBackdrop?.();
    this.unwatchBackdrop = undefined;
    this.closeHover.dispose();
    this.selection.dispose();
    this.targets.clear();
    this.options.native.dispose();
  }

  render(width: number): string[] {
    return this.layout(width, selectionProjection(), true);
  }

  private layout(width: number, projected: SelectionProjection, publishPaint: boolean): string[] {
    if (publishPaint) {
      this.width = width;
      this.targets = projected.targets;
    }
    if (this.closed) return [];
    const height = this.height;
    if (publishPaint && this.resize) {
      if (!this.viewportStillPainted()) this.modelPress = undefined;
      const viewport = this.options.resizeTerminal?.();
      this.paintedViewport = viewport && { columns: viewport.columns, rows: viewport.rows };
    }
    const inner = width - 2;
    const edges = this.resize?.edges;
    const bottomLabel =
      shortcutHint(this.options.theme, "choose", "↑↓", { color: "muted" }) +
      this.options.theme.fg("muted", " · ") +
      shortcutHint(this.options.theme, "apply", "Enter", { color: "muted" }) +
      this.options.theme.fg("muted", " · ") +
      shortcutHint(this.options.theme, "cancel", "Esc", { color: "muted" });
    const bottomRows = popoverLabelRows(
      this.options.theme,
      width,
      bottomLabel,
      "bottom",
      false,
      false,
      undefined,
      edges,
    );
    const { rows: frameRows } = popoverChromeLayout({ framed: true });
    const closable = Number.isFinite(width) && width >= 12 && height >= Math.max(5, frameRows + 1);
    if (publishPaint) {
      this.closePainted = closable;
      this.closeHover.paint(width, closable);
    }
    if (!closable) {
      // Degenerate paints retire admission; the dry recheck layout never
      // disturbs the host's painted registration.
      if (publishPaint) {
        this.selection.reset();
        this.resize?.paint([], width);
      }
      return [
        truncateToWidth(
          this.options.theme.fg("muted", "Too small · ") +
            shortcutHint(this.options.theme, "to cancel", "Esc", { color: "muted" }),
          width,
        ),
      ];
    }
    const models = this.options.models().filter((model) => model.api !== "pi-virtual");
    const rows = this.nativeRows(inner, models, projected).filter(
      ({ plain }) => plain.trim() && !/^─+$/u.test(plain),
    );
    // Spacers and the native borders are redundant inside rounded chrome.
    // On short screens, reduce its ten-item window around the painted arrow.
    const context =
      height >= 10 ? [this.options.theme.fg("muted", "New Agents only; main unchanged")] : [];
    const budget = height - frameRows - context.length;
    const body = this.fit(rows, budget);
    const padding = this.resize?.height === undefined ? 0 : Math.max(0, budget - body.length);
    if (publishPaint)
      this.closeHover.paint(width, true, body.length + padding + context.length + frameRows);
    const complete = (group: Group): boolean =>
      body.filter((row) => row.group === group).length === group.size;
    // Leave room before composing the chrome; inserting maximize must not
    // cut off the label's ellipsis or split a wide glyph.
    const title = this.resize
      ? truncateToWidth(this.options.title, centeredPanelTitleWidth(width), "…")
      : this.options.title;
    const titleRows = popoverTitleRows(
      this.options.theme,
      width,
      title,
      true,
      this.closeHover.hovered,
      edges,
    );
    const result = [
      ...titleRows,
      ...context.map((text) => popoverRow(this.options.theme, text, inner, edges)),
    ];
    for (const row of body) {
      const painted = popoverRow(this.options.theme, row.text, inner, edges);
      if (
        row.selected &&
        (!row.group || complete(row.group)) &&
        sliceByColumn(stripTerminalSequences(painted), 1, 2, true) === "→ "
      ) {
        projected.selectedVisible = true;
        if (row.group?.target) projected.visibleModel = row.group.target;
      }
      if (row.group?.target && complete(row.group) && visibleWidth(row.plain) <= inner) {
        projected.targets.set(result.length, {
          start: row.first ? 5 : 1,
          end: 1 + visibleWidth(row.plain),
          ...row.group.target,
        });
      }
      result.push(painted);
    }
    if (padding > 0)
      result.push(...Array<string>(padding).fill(popoverRow(this.options.theme, "", inner, edges)));
    result.push(...bottomRows);
    // Only painted content admits text selection, not the padding added to
    // reach a user height, the chrome or the modal resize preview.
    if (!publishPaint) return result;
    const lines = this.resize?.paint(result, width, visibleWidth(title)) ?? result;
    this.selection.paint(
      this.resize?.modal
        ? undefined
        : popoverTextRect(width, result.length, {
            top: titleRows.length,
            bottom: bottomRows.length + padding,
          }),
    );
    return lines;
  }

  private nativeRows(
    width: number,
    models: readonly Model[],
    projected: SelectionProjection,
  ): Row[] {
    const painted = this.options.native.render(width);
    const row = (text: string): Row => ({
      text,
      plain: stripTerminalSequences(text).trimEnd(),
      model: false,
      selected: false,
    });
    const tree: Row[] = [];
    const identityCounts = new Map<string, number>();
    for (const model of models) {
      const key = `${model.provider}\0${model.id}`;
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    }
    for (const child of this.options.native.children) {
      // The SDK may bundle TUI classes separately from its public TUI package.
      // Public structural capabilities, not instanceof, cross that module seam.
      const children = (child as Partial<Container>).children;
      if (!Array.isArray(children)) {
        tree.push(...child.render(width).map(row));
        continue;
      }
      // Native items are leading Text children of the list Container. A
      // spacer/indicator terminates that region, before name/error/status text.
      let items = true;
      for (const leaf of children) {
        const lines = leaf.render(width).map(row);
        // Keep the native prefix even when wrapping leaves only the arrow
        // and spaces on this line; trimEnd() is only for label comparisons.
        const first = lines[0] ? stripTerminalSequences(lines[0].text) : "";
        const item =
          items &&
          typeof (leaf as Partial<Text>).setText === "function" &&
          /^(?:→ | {2})(?:✓ | {2})/u.test(first);
        if (!item) items = false;
        if (item) {
          const prefix = first.slice(0, 4),
            labelStart = first.slice(4).trimEnd();
          // Render candidate labels with the same public Text wrapper. This
          // disambiguates spaces/wrapping without reading Text's private value.
          const matches = models.filter((model) => {
            const identity = `${model.provider}\0${model.id}`;
            if (
              hasTerminalControls(model.id) ||
              hasTerminalControls(model.provider) ||
              identityCounts.get(identity) !== 1
            )
              return false;
            const labels = [`${model.id} [${model.provider}]`];
            // Pi appends a distinct model name before the provider. Names
            // with controls can manufacture lookalike rows, so they cannot
            // authorize click or Enter through the model identity map.
            const name = model.name?.trim();
            if (name && !hasTerminalControls(name)) {
              labels.push(`${model.id} (${name}) [${model.provider}]`);
            }
            return labels.some((label) => {
              if (!label.startsWith(labelStart)) return false;
              const expected = new Text(prefix + label, 0, 0)
                .render(width)
                .map((text) => stripTerminalSequences(text).trimEnd());
              return (
                expected.length === lines.length &&
                expected.every((text, index) => text === lines[index]!.plain)
              );
            });
          });
          const model = matches.length === 1 ? matches[0] : undefined;
          const group: Group = {
            size: lines.length,
            ...(model ? { target: { provider: model.provider, id: model.id } } : {}),
          };
          for (const [index, line] of lines.entries())
            Object.assign(line, {
              model: true,
              selected: index === 0 && first.startsWith("→ "),
              group,
              first: index === 0,
            });
        }
        tree.push(...lines);
      }
    }
    // Do not assume a future SDK's render override still matches this tree.
    // In that case preserve native keyboard presentation, with no mouse hits.
    // Count arrows over the whole native paint, before any fitting crops it:
    // only a lone arrow is known to be the native selection Enter submits.
    const modelRow = (text: string): boolean =>
      /^(?:→ | {2})(?:✓ | {2})\S/u.test(stripTerminalSequences(text));
    if (
      tree.length === painted.length &&
      tree.every((line, index) => line.text === painted[index]) &&
      (tree.some((line) => line.model) || !painted.some(modelRow))
    ) {
      projected.structured = true;
      return tree;
    }
    const rows = painted.map((text) => ({
      ...row(text),
      model: modelRow(text),
      selected: stripTerminalSequences(text).startsWith("→ "),
    }));
    projected.ambiguousArrow = rows.filter((line) => line.selected).length > 1;
    return rows;
  }

  private fit(rows: Row[], budget: number): Row[] {
    if (rows.length <= budget) return rows;
    const first = rows.findIndex((row) => row.model);
    const last = rows.findLastIndex((row) => row.model);
    if (first < 0) return rows.slice(0, budget);
    let head = rows.slice(0, first);
    // The input is essential; scope hints are next. Reserve one visible model.
    if (head.length >= budget) {
      head = head.filter((row) => row.plain.startsWith(">") || row.plain.startsWith("Scope:"));
      head = budget > 1 ? head.slice(-(budget - 1)) : [];
    }
    const list = rows.slice(first, last + 1);
    const remaining = Math.max(1, budget - head.length);
    const tail = rows.slice(last + 1, last + 1 + Math.min(2, Math.max(0, remaining - 3)));
    const count = Math.max(1, remaining - tail.length);
    const selected = Math.max(
      0,
      list.findIndex((row) => row.selected),
    );
    const start = Math.max(0, Math.min(list.length - count, selected - Math.floor(count / 2)));
    return [...head, ...list.slice(start, start + count), ...tail];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return { handled: true };
    const resize = this.resize?.mouse(event);
    if (resize) return resize;
    const viewportStillPainted = this.viewportStillPainted();
    const close = this.closeHover.mouse(
      event,
      this.closePainted &&
        viewportStillPainted &&
        this.height >= 5 &&
        this.selectionWidth() === this.width,
    );
    if (close?.handled) {
      if (close.close) this.options.cancel();
      return { handled: true };
    }
    // The wrapper has no native wheel API; keep a wheel over this overlay out
    // of the transcript behind it.
    if (event.type === "wheel") return { handled: true };
    // Middle/right events stay consumed exactly as before: a fall-through
    // right-click could invoke the parent's paste behind the chooser.
    if (event.button === "middle" || event.button === "right") return { handled: true };
    if (event.button === "left" && (event.type === "press" || event.type === "click")) {
      const target = viewportStillPainted ? this.targets.get(event.y) : undefined,
        hit = target && event.x >= target.start && event.x < target.end ? target : undefined;
      const requirePress = this.requiresModelPress;
      if (event.type === "press") {
        if (requirePress)
          this.modelPress = hit ? { target: hit, x: event.screenX, y: event.screenY } : undefined;
        return hit ? { handled: true } : undefined;
      }
      const press = this.modelPress;
      this.modelPress = undefined;
      if (
        hit &&
        (!requirePress ||
          (press?.target.provider === hit.provider &&
            press.target.id === hit.id &&
            press.x === event.screenX &&
            press.y === event.screenY))
      ) {
        // A pointer may choose any complete visible item, not just the native
        // keyboard arrow. Repaint at the current viewport and require the
        // same item under this click; stale rows must not choose replacements.
        const current = this.recheck().targets.get(event.y);
        if (
          current?.provider === hit.provider &&
          current.id === hit.id &&
          event.x >= current.start &&
          event.x < current.end
        ) {
          const models = this.options
            .models()
            .filter(
              (model) =>
                model.api !== "pi-virtual" &&
                model.provider === hit.provider &&
                model.id === hit.id,
            );
          if (models.length === 1) this.options.select(models[0]!);
        }
      }
      // Pi sets false then true even when refocusing the same pane. Avoid
      // retiring a fresh centered paint because a stale click landed on it.
      return { handled: true, focus: !this.resize || !this.focused };
    }
    // Some native releases synthesize a buttonless click. It may focus the
    // chooser, as before, but must not apply a model without a left click.
    if (event.type === "click") return { handled: true, focus: !this.resize || !this.focused };
    // Primary drags and releases (including buttonless ones) stay unhandled
    // so they can complete native text selection.
    return undefined;
  }
}
