import type { PersistentScope } from "../../shared/settings-store.mjs";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { OverlayRequest } from "./overlay-request.ts";
import { isPopoverCloseClick } from "./popover.ts";
import type { DelegationSetting } from "../delegation.ts";
import {
  isOffPreset,
  strengths,
  type EffortCapabilities,
  type EffortOverrides,
  type PresetSelection,
  type PresetSnapshot,
  type Strength,
} from "../routing.ts";
import { PresetDelegation } from "./preset-delegation.ts";
import { PresetEffortEditor } from "./preset-effort-editor.ts";
import {
  EMPTY_PAINT,
  pickerPaint,
  PresetPage,
  renderPresetList,
  workerSlotDisplayOrder,
  PRESET_PICKER_MIN_ROWS,
  type PickerAction,
} from "./preset-list-page.ts";

export { workerSlotDisplayOrder, PRESET_PICKER_MIN_ROWS } from "./preset-list-page.ts";
export type { EffortCapabilities } from "../routing.ts";

export type PresetChoice =
  | string
  /** Host-owned management dialogs open only after the picker settles. */
  | { action: "settings" | "create-preset" | "edit-preset"; name?: string }
  /** Confirm switching to an inactive preset before entering its live editor. */
  | { action: "edit-effort"; name: string }
  /** Save live worker settings, never the highlight/slider preview. */
  | { action: "save-default"; scope: PersistentScope }
  | { action: "edit-model"; name: string; slot: Strength; position?: ModelPickerPosition };

/** Absolute terminal coordinates for a near-click model selector. */
export type ModelPickerPosition = { row: number; col: number };

export interface PresetPickerOptions {
  tui: Pick<TUI, "terminal" | "requestRender">;
  theme: Theme;
  keybindings: Pick<KeybindingsManager, "matches">;
  presets: readonly PresetSelection[];
  activeName: string;
  done: (choice: PresetChoice | null) => void;
  /** Optional live capabilities for editable effort controls. */
  efforts?: (preset: PresetSnapshot, slot: Strength) => EffortCapabilities;
  /** Only the host's validated, audited committed snapshot may paint. */
  setEffort?: (name: string, overrides: EffortOverrides) => PresetSelection | undefined;
  startInEffort?: boolean;
  /** Floating presentation enables close control and pointer input. */
  pointer?: boolean;
  rows?: () => number;
  onRender?: (height: number) => void;
  /** Applies immediately without settling the picker; set reports failures. */
  delegation?: {
    current(): DelegationSetting;
    set(next: DelegationSetting): void;
    guideline(setting: DelegationSetting): string;
  };
  /** UI routes only, never authorization; the host owns the ensuing dialogs. */
  management?: {
    summary(): string;
    settings: boolean;
    presets: boolean;
    models?: boolean;
    saveDefaults?: boolean;
    canSaveWorkspace?(): boolean;
  };
}

export interface PickerMouseEvent {
  type: string;
  button?: string;
  x: number;
  y: number;
  wheelDelta?: number;
  screenX?: number;
  screenY?: number;
}
export interface PickerMouseResult {
  handled: boolean;
  capture?: boolean;
  render?: boolean;
}

/** One picker attempt; OverlayRequest owns settlement/overlay coordination. */
export class PresetPickerRequest extends OverlayRequest<PresetChoice | null> {
  constructor(beforeSettle: () => void = () => {}) {
    super(beforeSettle, null);
  }
  readonly choose = (value: PresetChoice | null): void => {
    this.settle(value);
  };
  mount(done: (value: PresetChoice | null) => void, blocked: boolean): boolean {
    return this.attach(done, blocked);
  }
}

/** The sole Component/input/capture owner. Pages are projections, while the
 * host retains every validated, audited routing/settings publication. */
export class PresetPicker implements Component {
  private selected: number;
  private visibleRows = 1;
  private closed = false;
  private paint = EMPTY_PAINT;
  private paintedWidth: number | undefined;
  private editing = false;
  private slotIndex = 0;
  private readonly delegation: PresetDelegation;
  private readonly effort: PresetEffortEditor;

  constructor(private readonly options: PresetPickerOptions) {
    this.options = { ...options, presets: [...options.presets] };
    const active = options.presets.findIndex((preset) => preset.name === options.activeName);
    this.selected = active < 0 ? 0 : active;
    this.delegation = new PresetDelegation(this.options, () => this.usable());
    this.effort = new PresetEffortEditor(
      this.options,
      () => this.options.presets[this.selected],
      () => this.editing && this.usable(),
      (applied) => {
        this.options.presets = this.options.presets.map((each) =>
          each.name === applied.name ? applied : each,
        );
      },
    );
    if (options.startInEffort) this.openEditor();
  }

  selection(): string | undefined {
    return this.options.presets[this.selected]?.name;
  }
  isOpen(): boolean {
    return !this.closed;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.settleStaleEditor();
    this.delegation.interrupt();
    const { keybindings, presets } = this.options;
    if (matchesKey(data, "alt+s") || matchesKey(data, "ctrl+c")) return this.finish(null);
    // Back/cancel remain usable without a viewport; every other action is gated.
    if (
      this.editing &&
      (matchesKey(data, "escape") || keybindings.matches(data, "tui.select.confirm"))
    )
      return this.action("back");
    if (!this.editing && keybindings.matches(data, "tui.select.cancel")) return this.finish(null);
    if (!this.usable()) return;
    const management = this.options.management;
    if (management?.saveDefaults) {
      if (matchesKey(data, "g") || matchesKey(data, "shift+g")) return this.action("saveGlobal");
      if (matchesKey(data, "w") || matchesKey(data, "shift+w")) return this.action("saveWorkspace");
    }
    if (this.editing) return this.editInput(data);
    if (this.canEdit() && (matchesKey(data, "e") || matchesKey(data, "shift+e")))
      return this.action("edit");
    if (management?.settings && (matchesKey(data, "p") || matchesKey(data, "shift+p")))
      return this.action("settings");
    if (management?.presets) {
      if (matchesKey(data, "n") || matchesKey(data, "shift+n")) return this.action("create");
      if (this.canEditPreset() && (matchesKey(data, "c") || matchesKey(data, "shift+c")))
        return this.action("editPreset");
    }
    if (this.canPickModels()) {
      for (let index = 0; index < strengths.length; index++)
        if (data === String(index + 1)) return this.pickModel(strengths[index]!);
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.slotIndex =
        (this.slotIndex + (matchesKey(data, "shift+tab") ? strengths.length - 1 : 1)) %
        strengths.length;
      this.options.tui.requestRender();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const current = this.selection();
      if (current && this.usable()) this.finish(current);
      return;
    }
    if (this.options.delegation) {
      const direction =
        matchesKey(data, "left") || matchesKey(data, "shift+left")
          ? -1
          : matchesKey(data, "right") || matchesKey(data, "shift+right")
            ? 1
            : 0;
      if (direction) {
        this.delegation.step(
          matchesKey(data, "shift+left") || matchesKey(data, "shift+right") ? "eagerness" : "mode",
          direction,
        );
        return;
      }
    }
    if (!presets.length) return;
    let next = this.selected;
    if (keybindings.matches(data, "tui.select.up")) next--;
    else if (keybindings.matches(data, "tui.select.down")) next++;
    else if (keybindings.matches(data, "tui.select.pageUp")) next -= this.visibleRows;
    else if (keybindings.matches(data, "tui.select.pageDown")) next += this.visibleRows;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = presets.length - 1;
    else return;
    this.selected = Math.max(0, Math.min(presets.length - 1, next));
    this.options.tui.requestRender();
  }

  handleMouse(event: PickerMouseEvent): PickerMouseResult | undefined {
    if (this.closed || !this.options.pointer) return undefined;
    this.settleStaleEditor();
    if (this.delegation.swallowCancelledPress(event)) return { handled: true };
    if (isPopoverCloseClick(event, this.paintedWidth ?? 0)) {
      this.finish(null);
      return { handled: true };
    }
    if (!this.usable()) return { handled: true };
    if (!this.editing) {
      const delegation = this.delegation.mouse(event, this.paint);
      if (delegation) return delegation;
    }
    const { presets } = this.options;
    if (this.editing) {
      if (event.type === "wheel" && event.wheelDelta) {
        this.slotIndex = Math.max(
          0,
          Math.min(strengths.length - 1, this.slotIndex + Math.sign(event.wheelDelta)),
        );
        this.options.tui.requestRender();
        return { handled: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      const slot = this.paint.slots.get(event.y);
      if (slot) {
        this.slotIndex = workerSlotDisplayOrder.indexOf(slot.slot);
        if (slot.prev !== undefined && event.x === slot.prev) this.effort.step(slot.slot, -1);
        else if (slot.next !== undefined && event.x === slot.next) this.effort.step(slot.slot, 1);
        else this.options.tui.requestRender();
      } else this.clickAction(event);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && this.clickAction(event))
      return { handled: true };
    if (event.type === "click" && event.button === "left") {
      const model = this.paint.models
        .get(event.y)
        ?.find(({ start, end }) => event.x >= start && event.x < end);
      if (model) {
        this.pickModel(model.slot, event, model.preset);
        return { handled: true };
      }
    }
    if (event.type === "wheel" && event.wheelDelta && presets.length) {
      this.selected = Math.max(
        0,
        Math.min(presets.length - 1, this.selected + Math.sign(event.wheelDelta)),
      );
      this.options.tui.requestRender();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.paint.rows.get(event.y),
      preset = target === undefined ? undefined : presets[target];
    if (preset) {
      this.selected = target!;
      this.finish(preset.name);
    }
    return { handled: true };
  }

  render(width: number): string[] {
    // Retire the previous paint before any callbacks (the shared empty paint is
    // never written); publish one complete map after layout, never retaining
    // helpers' maps across pages or empty paints.
    this.paint = EMPTY_PAINT;
    this.paintedWidth = width;
    const paint = pickerPaint();
    let lines: string[] = [];
    const maxLines = width < 8 ? 0 : this.rowBudget();
    if (maxLines >= PRESET_PICKER_MIN_ROWS) {
      const page = new PresetPage(
        this.options,
        {
          selected: this.selected,
          slotIndex: this.slotIndex,
          canEdit: this.canEdit(),
          canEditPreset: this.canEditPreset(),
          canPickModels: this.canPickModels(),
          canSave: (scope) => this.canSaveDefault(scope),
          effort: (preset, slot) => this.effort.label(preset, slot),
        },
        paint,
      );
      const preset = this.options.presets[this.selected];
      if (this.editing && preset && !isOffPreset(preset)) {
        lines = this.effort.render(page, preset, width, maxLines);
      } else {
        // Painting never mutates picker state: a stale editor (its selection
        // rebased to Off or removed) paints as the list and settles on input.
        const list = renderPresetList(page, width, maxLines, this.delegation);
        lines = list.lines;
        this.visibleRows = list.visibleRows;
      }
    }
    this.paint = paint;
    this.options.onRender?.(lines.length);
    return lines;
  }

  invalidate(): void {}
  dispose(): void {
    this.closed = true;
  }

  private rowBudget(): number {
    const rows = this.options.tui.terminal.rows;
    const share = Math.max(PRESET_PICKER_MIN_ROWS, Math.floor(rows * 0.8));
    return Math.min(rows, share, this.options.rows?.() ?? share);
  }
  private usable(): boolean {
    return (
      this.rowBudget() >= PRESET_PICKER_MIN_ROWS &&
      this.options.tui.terminal.columns >= 8 &&
      (this.paintedWidth === undefined || this.paintedWidth >= 8)
    );
  }
  private finish(value: PresetChoice | null): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(value);
  }
  private canEdit(): boolean {
    const selected = this.options.presets[this.selected];
    return (
      !!this.options.efforts && !!this.options.setEffort && !!selected && !isOffPreset(selected)
    );
  }
  private openEditor(): void {
    const selected = this.options.presets[this.selected];
    if (!this.canEdit() || !selected) return;
    if (selected.name !== this.options.activeName) {
      if (this.usable()) this.finish({ action: "edit-effort", name: selected.name });
      return;
    }
    this.editing = true;
    this.delegation.reset();
    this.slotIndex = 0;
    this.effort.clear();
    this.options.tui.requestRender();
  }
  /** The editor needs a real, non-Off selection; a host rebase can remove it
   * between paints. Settled from input handlers only, never from render. */
  private settleStaleEditor(): void {
    const preset = this.options.presets[this.selected];
    if (this.editing && (!preset || isOffPreset(preset))) this.back();
  }
  private back(): void {
    this.editing = false;
    this.delegation.reset();
    this.effort.clear();
    this.options.tui.requestRender();
  }
  private editInput(data: string): void {
    const { keybindings } = this.options;
    if (matchesKey(data, "r") || matchesKey(data, "shift+r")) return this.action("reset");
    if (matchesKey(data, "left"))
      return this.effort.step(workerSlotDisplayOrder[this.slotIndex]!, -1);
    if (matchesKey(data, "right"))
      return this.effort.step(workerSlotDisplayOrder[this.slotIndex]!, 1);
    if (/^[1-5]$/.test(data))
      this.slotIndex = workerSlotDisplayOrder.indexOf(strengths[Number(data) - 1]!);
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
      this.slotIndex =
        (this.slotIndex + (matchesKey(data, "shift+tab") ? strengths.length - 1 : 1)) %
        strengths.length;
    else if (keybindings.matches(data, "tui.select.up"))
      this.slotIndex = Math.max(0, this.slotIndex - 1);
    else if (keybindings.matches(data, "tui.select.down"))
      this.slotIndex = Math.min(strengths.length - 1, this.slotIndex + 1);
    else return;
    this.options.tui.requestRender();
  }

  private clickAction(event: PickerMouseEvent): boolean {
    const action = this.paint.actions
      .get(event.y)
      ?.find(({ start, end }) => event.x >= start && event.x < end);
    if (!action) return false;
    this.action(action.kind);
    return true;
  }
  /** Keyboard and painted labels share one action/gating path. */
  private action(kind: PickerAction): void {
    switch (kind) {
      case "edit":
        return this.openEditor();
      case "reset":
        return this.effort.set({});
      case "back":
        return this.back();
      case "saveGlobal":
        return this.saveDefault("global");
      case "saveWorkspace":
        return this.saveDefault("workspace");
      case "settings":
        if (this.options.management?.settings) this.finish({ action: "settings" });
        return;
      case "create":
        if (this.options.management?.presets) this.finish({ action: "create-preset" });
        return;
      case "editPreset":
        if (this.canEditPreset()) this.finish({ action: "edit-preset", name: this.selection()! });
    }
  }
  private canSaveDefault(scope: PersistentScope): boolean {
    if (!this.options.management?.saveDefaults) return false;
    if (scope === "global") return true;
    try {
      return this.options.management.canSaveWorkspace?.() === true;
    } catch {
      return false;
    }
  }
  private saveDefault(scope: PersistentScope): void {
    if (this.canSaveDefault(scope)) this.finish({ action: "save-default", scope });
  }
  private canEditPreset(): boolean {
    const highlighted = this.options.presets[this.selected];
    return !!this.options.management?.presets && !!highlighted && !isOffPreset(highlighted);
  }
  private canPickModels(): boolean {
    const highlighted = this.options.presets[this.selected];
    return !!this.options.management?.models && !!highlighted && !isOffPreset(highlighted);
  }
  private pickModel(slot: Strength, event?: PickerMouseEvent, paintedPreset?: string): void {
    // A wheel/key can change highlight before repaint: pointer routes must
    // keep the painted identity, while keys use the current highlight.
    const highlighted =
      paintedPreset === undefined
        ? this.options.presets[this.selected]
        : this.options.presets.find((preset) => preset.name === paintedPreset);
    if (!highlighted || isOffPreset(highlighted) || !this.usable()) return;
    const position =
      event && typeof event.screenX === "number" && typeof event.screenY === "number"
        ? { row: event.screenY, col: event.screenX }
        : undefined;
    this.finish({
      action: "edit-model",
      name: highlighted.name,
      slot,
      ...(position ? { position } : {}),
    });
  }
}
