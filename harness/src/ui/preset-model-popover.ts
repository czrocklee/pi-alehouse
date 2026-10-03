import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Container, type Component, type Focusable,
  type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ModelPickerPosition } from "./preset-picker.js";
import { isPopoverCloseClick, popoverInlay, popoverRow, popoverTitle, type PopoverTheme } from "./popover.js";

type Model = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];
type NativeSelector = Component & Focusable & { dispose(): void; children: Component[] };
type Group = { size: number; target?: { provider: string; id: string } };
type Row = { text: string; plain: string; model: boolean; selected: boolean; group?: Group; first?: boolean };
type Target = { start: number; end: number; provider: string; id: string };

/** Only public terminal geometry. The host clamps row/col to the visible area
 * again after measuring the component, including on terminal resize. */
export function modelPopoverOptions(tui: TUI | undefined, position?: ModelPickerPosition): OverlayOptions {
  const columns = tui?.terminal.columns ?? 80, rows = tui?.terminal.rows ?? 24;
  const margin = columns > 4 && rows > 4 ? 1 : 0;
  const width = Math.max(1, Math.min(80, columns - 2 * margin));
  const point = position && Number.isFinite(position.row) && Number.isFinite(position.col) &&
    position.row >= 0 && position.row < rows && position.col >= 0 && position.col < columns;
  return { anchor: point ? "top-left" : "center", width, minWidth: Math.min(32, width),
    maxHeight: Math.max(1, rows - 2 * margin), margin,
    ...(point ? { row: Math.floor(position.row) + 1, col: Math.floor(position.col) } : {}) };
}

/** A presentation adapter, not another model selector. Search, scope/Tab,
 * keybindings, catalog refresh and IME focus remain the native component's.
 * Its public component tree has no mouse API. Register only complete,
 * unambiguous painted model items, never lookalike text in catalog errors or
 * model-name details. Unknown tree formats remain keyboard-only. No private
 * selection/list fields or duplicated search/selection logic. */
export class PresetModelPopover implements Component, Focusable {
  private width = 0;
  private closed = false;
  private targets = new Map<number, Target>();
  private selectedVisible = false;

  constructor(private readonly options: {
    native: NativeSelector;
    theme: PopoverTheme;
    title: string;
    height(): number;
    models(): readonly Model[];
    select(model: Model): void;
    cancel(): void;
  }) {}

  get focused(): boolean { return this.options.native.focused; }
  set focused(value: boolean) { this.options.native.focused = value; }
  /** In an unusably small viewport, do not accept an unseen native choice. */
  canSelect(): boolean { return !this.closed && this.selectedVisible; }
  handleInput(data: string): void { if (!this.closed) this.options.native.handleInput?.(data); }
  invalidate(): void { this.options.native.invalidate(); }
  dispose(): void {
    this.closed = true;
    this.targets.clear();
    this.selectedVisible = false;
    this.options.native.dispose();
  }

  render(width: number): string[] {
    this.width = width;
    this.targets.clear();
    this.selectedVisible = false;
    if (this.closed) return [];
    const height = Math.max(1, this.options.height());
    if (width < 12 || height < 5) return [truncateToWidth("Too small · Esc to cancel", width)];
    const inner = width - 2;
    const models = this.options.models().filter((model) => model.api !== "pi-virtual");
    const rows = this.nativeRows(inner, models).filter(({ plain }) => plain.trim() && !/^─+$/u.test(plain));
    // Spacers and the native borders are redundant inside rounded chrome.
    // On short screens, reduce its ten-item window around the painted arrow.
    const context = height >= 10 ? [this.options.theme.fg("muted", "New Agents only; main unchanged")] : [];
    const budget = height - 2 - context.length;
    const body = this.fit(rows, budget);
    const complete = (group: Group): boolean => body.filter((row) => row.group === group).length === group.size;
    const result = [popoverTitle(this.options.theme, width, this.options.title, true),
      ...context.map((text) => popoverRow(this.options.theme, text, inner))];
    for (const row of body) {
      const painted = popoverRow(this.options.theme, row.text, inner);
      if (row.selected && (!row.group || complete(row.group)) && stripTerminalSequences(painted).startsWith("│→ ")) this.selectedVisible = true;
      if (row.group?.target && complete(row.group) && visibleWidth(row.plain) <= inner) {
        this.targets.set(result.length, { start: row.first ? 5 : 1, end: 1 + visibleWidth(row.plain), ...row.group.target });
      }
      result.push(painted);
    }
    result.push(popoverInlay(this.options.theme, width, this.options.theme.fg("muted", "↑↓ choose · Enter apply · Esc cancel"), "bottom"));
    return result;
  }

  private nativeRows(width: number, models: readonly Model[]): Row[] {
    const painted = this.options.native.render(width);
    const row = (text: string): Row => ({ text, plain: stripTerminalSequences(text).trimEnd(), model: false, selected: false });
    const tree: Row[] = [];
    for (const child of this.options.native.children) {
      // The SDK may bundle TUI classes separately from its public TUI package.
      // Public structural capabilities, not instanceof, cross that module seam.
      const children = (child as Partial<Container>).children;
      if (!Array.isArray(children)) { tree.push(...child.render(width).map(row)); continue; }
      // Native items are leading Text children of the list Container. A
      // spacer/indicator terminates that region, before name/error/status text.
      let items = true;
      for (const leaf of children) {
        const lines = leaf.render(width).map(row);
        // Keep the native prefix even when wrapping leaves only the arrow
        // and spaces on this line; trimEnd() is only for label comparisons.
        const first = lines[0] ? stripTerminalSequences(lines[0].text) : "";
        const item = items && typeof (leaf as Partial<Text>).setText === "function" && /^(?:→ | {2})(?:✓ | {2})/u.test(first);
        if (!item) items = false;
        if (item) {
          const prefix = first.slice(0, 4), labelStart = first.slice(4).trimEnd();
          // Render candidate labels with the same public Text wrapper. This
          // disambiguates spaces/wrapping without reading Text's private value.
          const matches = models.filter((model) => {
            const label = `${model.id} [${model.provider}]`;
            if (!label.startsWith(labelStart)) return false;
            const expected = new Text(prefix + label, 0, 0).render(width).map((text) => stripTerminalSequences(text).trimEnd());
            return expected.length === lines.length && expected.every((text, index) => text === lines[index]!.plain);
          });
          const model = matches.length === 1 ? matches[0] : undefined;
          const group: Group = { size: lines.length, ...(model ? { target: { provider: model.provider, id: model.id } } : {}) };
          for (const [index, line] of lines.entries()) Object.assign(line, { model: true, selected: index === 0 && first.startsWith("→ "), group, first: index === 0 });
        }
        tree.push(...lines);
      }
    }
    // Do not assume a future SDK's render override still matches this tree.
    // In that case preserve native keyboard presentation, with no mouse hits.
    const modelRow = (text: string): boolean => /^(?:→ | {2})(?:✓ | {2})\S/u.test(stripTerminalSequences(text));
    if (tree.length === painted.length && tree.every((line, index) => line.text === painted[index]) &&
        (tree.some((line) => line.model) || !painted.some(modelRow))) return tree;
    return painted.map((text) => ({ ...row(text), model: /^(?:→ | {2})(?:✓ | {2})\S/u.test(stripTerminalSequences(text)),
      selected: stripTerminalSequences(text).startsWith("→ ") }));
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
    const selected = Math.max(0, list.findIndex((row) => row.selected));
    const start = Math.max(0, Math.min(list.length - count, selected - Math.floor(count / 2)));
    return [...head, ...list.slice(start, start + count), ...tail];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (this.closed) return { handled: true };
    if (isPopoverCloseClick(event, this.width)) { this.options.cancel(); return { handled: true }; }
    if (event.type === "click" && event.button === "left") {
      const target = this.targets.get(event.y);
      if (target && event.x >= target.start && event.x < target.end) {
        // Recheck freshness and uniqueness at click time as well as paint time.
        const models = this.options.models().filter((model) => model.api !== "pi-virtual" &&
          model.provider === target.provider && model.id === target.id);
        if (models.length === 1) this.options.select(models[0]!);
      }
    }
    return { handled: true, ...(event.type === "click" ? { focus: true } : {}) };
  }
}
