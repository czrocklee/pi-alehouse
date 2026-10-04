import type { PersistentScope } from "../../../lib/settings-store.mjs";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { OverlayRequest } from "./overlay-request.js";
import { isPopoverCloseClick, popoverBottom, popoverDivider, popoverRow, popoverTitle } from "./popover.js";
import { delegationModes, eagernessLevels, modeLabels, usesEagerness, type DelegationMode, type DelegationSetting } from "../delegation.js";
import { isOffPreset, strengths, thinkingLevels, type Effort, type EffortOverrides, type PresetSelection, type PresetSnapshot, type Strength, type ThinkingLevel } from "../routing.js";

export type PresetChoice
  = string
  /** A settings/preset management route: the picker closes and the host
   * opens its own dialog; no preset is published. */
  | { action: "settings" | "create-preset" | "edit-preset"; name?: string }
  /** Confirm switching to an inactive preset before entering its live editor. */
  | { action: "edit-effort"; name: string }
  /** Save the host's live worker settings, not this picker's highlight/preview. */
  | { action: "save-default"; scope: PersistentScope }
  /** A single-slot model route: the picker closes and the host opens its own
   * model selector, ideally near the click; no preset is published. */
  | { action: "edit-model"; name: string; slot: Strength; position?: ModelPickerPosition };

/** Where a click happened in absolute terminal coordinates, so the host can
 * open its own selector near the model text the operator clicked. */
export type ModelPickerPosition = { row: number; col: number };

export interface EffortCapabilities {
  levels: readonly ThinkingLevel[];
  inherited?: ThinkingLevel;
  inheritError?: string;
  error?: string;
}

export interface PresetPickerOptions {
  tui: Pick<TUI, "terminal" | "requestRender">;
  theme: Theme;
  keybindings: Pick<KeybindingsManager, "matches">;
  presets: readonly PresetSelection[];
  activeName: string;
  done: (choice: PresetChoice | null) => void;
  /** Live capabilities for each worker model; absent on legacy read-only hosts. */
  efforts?: (preset: PresetSnapshot, slot: Strength) => EffortCapabilities;
  /** Host-owned validated audit/publication. Only its committed snapshot paints;
   * absent on read-only hosts. Rejection leaves the previous values unchanged. */
  setEffort?: (name: string, overrides: EffortOverrides) => PresetSelection | undefined;
  /** A confirmed inactive-preset continuation starts on the live effort page. */
  startInEffort?: boolean;
  /** Floating under the pointer: paint the close control and take clicks. */
  pointer?: boolean;
  /** Rows the picker may use, when something else below it already took some. */
  rows?: () => number;
  /** Rows this paint produced, for whoever lays out popovers around it. */
  onRender?: (height: number) => void;
  /** Delegation mode and eagerness. Unlike a preset, a change applies at once
   * and leaves the panel open; `set` reports its own failures. */
  delegation?: {
    current(): DelegationSetting;
    set(next: DelegationSetting): void;
    guideline(setting: DelegationSetting): string;
  };
  /** Settings/preset management entry points. The picker only routes to
   * them and paints its status line; the host implements the dialogs after
   * the picker closes. Absent on read-only hosts. `models` gates the
   * single-slot model routes in this UI only; it is not authorization. */
  management?: {
    summary(): string;
    settings: boolean;
    presets: boolean;
    models?: boolean;
    saveDefaults?: boolean;
    canSaveWorkspace?(): boolean;
  };
}

/** The pointer event as the picker reads it; a structural subset of pi-tui's. */
export interface PickerMouseEvent {
  type: string;
  button?: string;
  x: number;
  y: number;
  wheelDelta?: number;
  /** Absolute screen coordinates, when the host reports them; the model route
   * forwards them so its own selector can open near the click. */
  screenX?: number;
  screenY?: number;
}

/** What the picker asks of pi-tui after a pointer event. */
export interface PickerMouseResult { handled: boolean; capture?: boolean; render?: boolean }

/** UI-only hardest-first order. Never reverse the canonical routing tuple in place;
 * numeric keys still address slot identity, not a position in this view. */
export const workerSlotDisplayOrder: readonly Strength[] = Object.freeze([...strengths].reverse());

/** Full chrome/detail overhead plus one preset row; never assume three slots. */
const MIN_FULL_LINES = strengths.length + 8;
/** Every clickable control on the picker's two pages. */
type PickerAction = "edit" | "reset" | "back" | "settings" | "create" | "editPreset" | "saveGlobal" | "saveWorkspace";
/** Compact chrome plus a selected-slot window, controls and bottom edge. */
export const PRESET_PICKER_MIN_ROWS = 7;
/** Slider, eagerness and divider rows above the preset list. */
const MODE_ROWS = 3;
const GUIDELINE_ROWS = 3;
const MODE_PREFIX = " Mode   ";
const SLOT_LABEL: Record<Strength, string> = { d1: "d1", d2: "d2", d3: "d3", d4: "d4", d5: "d5" };
const marked = (preset: PresetSnapshot): boolean => Object.keys(preset.effort_overrides ?? {}).length > 0;
const defaultEffort = (preset: PresetSnapshot, slot: Strength): Effort => preset.effort_defaults?.[slot] ?? "inherit";
const effectiveEffort = (preset: PresetSnapshot, slot: Strength): Effort =>
  preset.effort?.[slot] ?? preset.effort_overrides?.[slot] ?? defaultEffort(preset, slot);

/** One picker attempt. See `OverlayRequest` for the settlement and
 * overlay-coordination contract both harness panels share. */
export class PresetPickerRequest extends OverlayRequest<PresetChoice | null> {
  constructor(beforeSettle: () => void = () => {}) { super(beforeSettle, null); }

  /** The mounted picker's own settlement handle. */
  readonly choose = (value: PresetChoice | null): void => { this.settle(value); };

  mount(done: (value: PresetChoice | null) => void, blocked: boolean): boolean {
    return this.attach(done, blocked);
  }
}

/** A picker with a live effort editor. The host still owns every validated,
 * audited publication; UI only proposes changes and paints committed values. */
export class PresetPicker implements Component {
  private selected: number;
  private visibleRows = 1;
  private closed = false;
  /** Which preset each painted row shows, so a click hits what is on screen. */
  private rowTargets = new Map<number, number>();
  private paintedWidth: number | undefined;
  private editing = false;
  private slotIndex = 0;
  private effortError: string | undefined;
  private slotTargets = new Map<number, { slot: Strength; prev?: number; next?: number }>();
  private actionTargets = new Map<number, { kind: PickerAction; start: number; end: number }[]>();
  /** Painted slider nodes by row, in terminal columns (border is column zero). */
  private modeTargets = new Map<number, { mode: DelegationMode; start: number; end: number }[]>();
  /** Painted ‹ › arrows that step the mode or eagerness, by row. */
  private stepTargets = new Map<number, { kind: "mode" | "eagerness"; direction: -1 | 1; x: number }[]>();
  /** The node under a drag, previewed until the release applies it. */
  private previewMode: DelegationMode | undefined;
  /** Painted model-text spans by row, in terminal columns, refreshed every
   * render; only actually painted model text is a target. */
  private modelTargets = new Map<number, { preset: string; slot: Strength; start: number; end: number }[]>();
  private dragging = false;
  /** A key ended a held slider press: pi-tui still owns that press and turns
   * an unmoved release into a click, which must not apply the cancelled node. */
  private cancelledPress = false;

  constructor(private readonly options: PresetPickerOptions) {
    this.options = { ...options, presets: [...options.presets] };
    const active = options.presets.findIndex((preset) => preset.name === options.activeName);
    this.selected = active < 0 ? 0 : active;
    if (options.startInEffort) this.openEditor();
  }

  selection(): string | undefined { return this.options.presets[this.selected]?.name; }
  isOpen(): boolean { return !this.closed; }

  handleInput(data: string): void {
    if (this.closed) return;
    // Any key cancels a drag: its preview is dropped and the release ignored.
    if (this.dragging) {
      this.cancelledPress = true;
      this.previewMode = undefined;
      this.dragging = false;
      this.options.tui.requestRender();
    }
    const { keybindings, presets } = this.options;
    // Registered shortcuts belong to the default editor; while this custom
    // component is focused it must implement its own half of the toggle.
    if (matchesKey(data, "alt+s") || matchesKey(data, "ctrl+c")) return this.finish(null);
    // Back/cancel remains available without a viewport, but nothing else may
    // navigate, edit or route an invisible picker (including before first paint).
    if (this.editing && (matchesKey(data, "escape") || keybindings.matches(data, "tui.select.confirm"))) return this.back();
    if (!this.editing && keybindings.matches(data, "tui.select.cancel")) return this.finish(null);
    if (!this.usable()) return;
    const management = this.options.management;
    if (management?.saveDefaults) {
      if (matchesKey(data, "g") || matchesKey(data, "shift+g")) return this.saveDefault("global");
      if (matchesKey(data, "w") || matchesKey(data, "shift+w")) return this.saveDefault("workspace");
    }
    if (this.editing) return this.editInput(data);
    const current = this.selection();
    if (this.canEdit() && (matchesKey(data, "e") || matchesKey(data, "shift+e"))) {
      this.openEditor();
      return;
    }
    // Settings/model routes remain list-page keys; saving is available on
    // either page and always uses the host's already-applied choices.
    if (management?.settings && (matchesKey(data, "p") || matchesKey(data, "shift+p")))
      return this.finish({ action: "settings" });
    if (management?.presets) {
      if (matchesKey(data, "n") || matchesKey(data, "shift+n"))
        return this.finish({ action: "create-preset" });
      if (matchesKey(data, "c") || matchesKey(data, "shift+c")) {
        const highlighted = presets[this.selected];
        if (highlighted && !isOffPreset(highlighted))
          return this.finish({ action: "edit-preset", name: highlighted.name });
      }
    }
    // 1–5 route the highlighted preset's slot model, list page only, and
    // never for off (a control state with no models to pick).
    if (this.canPickModels()) {
      for (let index = 0; index < strengths.length; index++) {
        if (data === String(index + 1)) { this.pickModel(strengths[index]!); return; }
      }
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.slotIndex = (this.slotIndex + (matchesKey(data, "shift+tab") ? strengths.length - 1 : 1)) % strengths.length;
      this.options.tui.requestRender();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      if (current && this.usable()) this.finish(current);
      return;
    }
    if (this.options.delegation) {
      const direction = matchesKey(data, "left") || matchesKey(data, "shift+left") ? -1
        : matchesKey(data, "right") || matchesKey(data, "shift+right") ? 1 : 0;
      if (direction) {
        this.stepDelegation(matchesKey(data, "shift+left") || matchesKey(data, "shift+right") ? "eagerness" : "mode", direction);
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

  /**
   * The close control cancels; a click on a preset applies it, as a menu
   * would; the wheel moves the highlight so its slots can be read first.
   * In the editor a slot row selects it; only visible arrows propose live changes.
   */
  handleMouse(event: PickerMouseEvent): PickerMouseResult | undefined {
    if (this.closed || !this.options.pointer) return undefined;
    if (this.cancelledPress) {
      // The release, and the click pi-tui synthesizes from it, end the
      // cancelled gesture; a new press starts afresh.
      if (event.type === "release" || event.type === "drag") return { handled: true };
      this.cancelledPress = false;
      if (event.type === "click") return { handled: true };
    }
    if (isPopoverCloseClick(event, this.paintedWidth ?? 0)) {
      this.finish(null);
      return { handled: true };
    }
    if (!this.usable()) return { handled: true };
    if (!this.editing) {
      const delegation = this.delegationMouse(event);
      if (delegation) return delegation;
    }
    const { presets } = this.options;
    if (this.editing) {
      if (event.type === "wheel" && event.wheelDelta) {
        this.slotIndex = Math.max(0, Math.min(strengths.length - 1, this.slotIndex + Math.sign(event.wheelDelta)));
        this.options.tui.requestRender();
        return { handled: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      const slot = this.slotTargets.get(event.y);
      if (slot) {
        this.slotIndex = workerSlotDisplayOrder.indexOf(slot.slot);
        if (slot.prev !== undefined && event.x === slot.prev) this.step(slot.slot, -1);
        else if (slot.next !== undefined && event.x === slot.next) this.step(slot.slot, 1);
        else this.options.tui.requestRender();
      } else this.clickAction(event);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && this.clickAction(event)) return { handled: true };
    // A click on painted model text routes the slot's model, not a selection;
    // padding, effort values, labels and a pure ellipsis are never targets.
    if (event.type === "click" && event.button === "left") {
      const model = this.modelTargets.get(event.y)?.find(({ start, end }) => event.x >= start && event.x < end);
      if (model) { this.pickModel(model.slot, event, model.preset); return { handled: true }; }
    }
    if (event.type === "wheel" && event.wheelDelta && presets.length) {
      this.selected = Math.max(0, Math.min(presets.length - 1, this.selected + Math.sign(event.wheelDelta)));
      this.options.tui.requestRender();
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.rowTargets.get(event.y);
    const preset = target === undefined ? undefined : presets[target];
    if (preset) {
      this.selected = target!;
      this.finish(preset.name);
    }
    return { handled: true };
  }

  /** A click applies a node; a drag previews the nearest and its release
   * applies it. Hover does nothing: pi-tui has no pointer-leave event, so a
   * hover preview could outlive the pointer and read as the current mode. */
  private delegationMouse(event: PickerMouseEvent): PickerMouseResult | undefined {
    if (!this.options.delegation) return undefined;
    const nodes = this.modeTargets.get(event.y);
    const hit = nodes?.find(({ start, end }) => event.x >= start && event.x < end)?.mode;
    if (this.dragging) {
      if (event.type === "drag") {
        const nearest = this.nearestMode(event.x);
        this.previewMode = nearest ?? this.previewMode;
        return { handled: true, render: true, capture: true };
      }
      if (event.type === "release") {
        this.dragging = false;
        const target = this.previewMode;
        this.previewMode = undefined;
        if (target) this.setDelegation({ mode: target });
        return { handled: true, render: true };
      }
    }
    if (event.button !== "left") return undefined;
    if (event.type === "press" && nodes) {
      this.dragging = true;
      this.previewMode = hit;
      return { handled: true, capture: true, render: true };
    }
    if (event.type !== "click") return undefined;
    if (hit) {
      this.previewMode = undefined;
      this.setDelegation({ mode: hit });
      return { handled: true };
    }
    const step = this.stepTargets.get(event.y)?.find(({ x }) => x === event.x);
    if (step) {
      this.stepDelegation(step.kind, step.direction);
      return { handled: true };
    }
    return nodes ? { handled: true } : undefined;
  }

  private nearestMode(x: number): DelegationMode | undefined {
    let best: { mode: DelegationMode; distance: number } | undefined;
    for (const nodes of this.modeTargets.values()) for (const { mode, start, end } of nodes) {
      const distance = x < start ? start - x : x >= end ? x - end + 1 : 0;
      if (!best || distance < best.distance) best = { mode, distance };
    }
    return best?.mode;
  }

  private stepDelegation(kind: "mode" | "eagerness", direction: -1 | 1): void {
    const current = this.options.delegation?.current();
    if (!current) return;
    if (kind === "mode") {
      const index = delegationModes.indexOf(current.mode) + direction;
      if (index >= 0 && index < delegationModes.length) this.setDelegation({ mode: delegationModes[index]! });
    } else if (usesEagerness(current.mode)) {
      const index = eagernessLevels.indexOf(current.eagerness) + direction;
      if (index >= 0 && index < eagernessLevels.length) this.setDelegation({ eagerness: eagernessLevels[index]! });
    }
  }

  private setDelegation(change: Partial<DelegationSetting>): void {
    const delegation = this.options.delegation;
    if (!delegation || !this.usable()) return;
    const current = delegation.current();
    const next = { ...current, ...change };
    if (next.mode !== current.mode || next.eagerness !== current.eagerness) delegation.set(next);
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    this.rowTargets.clear();
    this.modeTargets.clear();
    this.stepTargets.clear();
    this.slotTargets.clear();
    this.actionTargets.clear();
    this.modelTargets.clear();
    this.paintedWidth = width;
    const lines = this.layout(width);
    this.options.onRender?.(lines.length);
    return lines;
  }

  invalidate(): void {}
  dispose(): void { this.closed = true; }

  private layout(width: number): string[] {
    if (width < 8) return [];
    const inner = width - 2;
    const maxLines = this.rowBudget();
    // No usable selection can be painted; do not overflow the actual viewport.
    if (maxLines < PRESET_PICKER_MIN_ROWS) return [];
    if (this.editing) return this.renderEditor(width, inner, maxLines);
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    return maxLines < MIN_FULL_LINES + modeRows ? this.renderCompact(width, inner, maxLines) : this.renderFull(width, inner, maxLines);
  }

  private rowBudget(): number {
    const rows = this.options.tui.terminal.rows;
    const share = Math.max(PRESET_PICKER_MIN_ROWS, Math.floor(rows * 0.8));
    return Math.min(rows, share, this.options.rows?.() ?? share);
  }

  private usable(): boolean {
    return this.rowBudget() >= PRESET_PICKER_MIN_ROWS && this.options.tui.terminal.columns >= 8 &&
      (this.paintedWidth === undefined || this.paintedWidth >= 8);
  }

  /** A centered window always includes the keyboard-selected slot, including
   * after a resize. The title/status supplies the navigation hint, not an extra
   * row that could displace the selected control. */
  private slotWindow(count: number): readonly Strength[] {
    const size = Math.max(1, Math.min(strengths.length, count));
    const start = Math.max(0, Math.min(this.slotIndex - Math.floor(size / 2), strengths.length - size));
    return workerSlotDisplayOrder.slice(start, start + size);
  }

  private finish(value: PresetChoice | null): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(value);
  }

  private renderFull(width: number, inner: number, maxLines: number): string[] {
    const { presets, activeName, theme } = this.options;
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    // Saving the live defaults takes a spare row before summary/guideline;
    // neither management control raises the minimum or hides the last preset.
    const saveRows = this.canSaveDefault("global") && maxLines >= MIN_FULL_LINES + modeRows + 1 ? 1 : 0;
    const summary = this.managementSummary();
    const summaryRows = summary !== undefined && maxLines >= MIN_FULL_LINES + modeRows + saveRows + 1 ? 1 : 0;
    // The mode's guideline takes up to three rows; the list keeps at least one.
    const guidelineRows = this.options.delegation ? Math.max(0, Math.min(GUIDELINE_ROWS, maxLines - MIN_FULL_LINES - modeRows - saveRows - summaryRows)) : 0;
    this.visibleRows = Math.max(1, Math.min(presets.length, maxLines - (MIN_FULL_LINES - 1) - modeRows - guidelineRows - saveRows - summaryRows));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.visibleRows / 2), presets.length - this.visibleRows));
    const end = Math.min(presets.length, start + this.visibleRows);
    const range = presets.length ? `${start + 1}–${end}/${presets.length}` : "0/0";
    const scope = [" Model preset · new Agents only; main unchanged · * effort", " Model preset · new Agents only",
      " Model preset"].find((text) => visibleWidth(text) + visibleWidth(range) + 1 <= inner) ?? " Model preset";
    const lines = [this.title(width, "Delegation")];
    if (this.options.delegation) this.modeSection(lines, width, inner, guidelineRows);
    lines.push(this.row(this.twoSides(theme.fg("muted", scope),
        theme.fg("dim", range), inner), inner));
    if (summaryRows) lines.push(this.row(theme.fg("dim", ` ${summary}`), inner));
    lines.push(this.divider(width));
    for (let index = start; index < end; index++) {
      const preset = presets[index]!;
      const selected = index === this.selected;
      const active = preset.name === activeName;
      const marker = selected ? theme.fg("accent", "›") : " ";
      const live = active ? theme.fg("success", "●") : theme.fg("dim", "○");
      const right = theme.fg("dim", this.version(preset));
      const label = isOffPreset(preset) ? preset.name : preset.name + (marked(preset) ? "*" : "");
      const left = `${marker} ${live} ${selected ? theme.bold(label) : label}`;
      const content = this.twoSides(left, right, inner);
      this.rowTargets.set(lines.length, index);
      lines.push(this.row(selected ? theme.bg("selectedBg", content) : content, inner));
    }
    lines.push(this.divider(width));
    lines.push(...this.detailRows(inner, lines.length));
    const saveShown = saveRows > 0 && this.saveControls(lines, inner);
    this.listControls(lines, inner, false, saveShown);
    lines.push(this.bottom(width));
    return lines;
  }

  private renderCompact(width: number, inner: number, maxLines: number): string[] {
    this.visibleRows = 1;
    const { presets, theme } = this.options;
    const current = presets[this.selected];
    const position = current ? `${this.selected + 1}/${presets.length}` : "0/0";
    const lines = [this.title(width, "Delegation")];
    // One row for the mode when the popover has room beyond its minimum.
    if (this.options.delegation && maxLines > PRESET_PICKER_MIN_ROWS) lines.push(this.compactModeRow(lines.length, inner, true));
    if (!current) lines.push(this.row(theme.fg("warning", " No presets available"), inner));
    else {
      const badge = current.name === this.options.activeName ? theme.fg("success", " ● active") : theme.fg("muted", " ○ inactive");
      this.rowTargets.set(lines.length, this.selected);
      const label = current.name + (!isOffPreset(current) && marked(current) ? "*" : "");
      lines.push(this.row(this.twoSides(` › ${theme.bold(label)}${badge}`,
        theme.fg("dim", [this.version(current), position].filter(Boolean).join(" · ")), inner), inner));
      if (isOffPreset(current)) lines.push(...this.offNoticeRows(inner));
      else {
        // Reserve controls/bottom first. A tiny viewport scrolls the slot window
        // with Tab/Shift+Tab without changing the highlighted preset.
        const slots = this.slotWindow(maxLines - lines.length - 2);
        for (const strength of slots)
          lines.push(this.slotRow(strength, current.models[strength], current, inner, lines.length,
            slots.length < strengths.length && strength === workerSlotDisplayOrder[this.slotIndex]));
      }
    }
    // Save controls and summary use spare rows only; the minimum is unchanged.
    const saveShown = this.canSaveDefault("global") && lines.length + 3 <= maxLines && this.saveControls(lines, inner);
    const summary = this.managementSummary();
    if (summary !== undefined && lines.length + 3 <= maxLines)
      lines.push(this.row(theme.fg("dim", ` ${summary}`), inner));
    this.listControls(lines, inner, true, saveShown);
    lines.push(this.bottom(width));
    return lines;
  }

  /** Mode slider, eagerness box, then the guideline the model would receive. */
  private modeSection(lines: string[], width: number, inner: number, guidelineRows: number): void {
    const { theme } = this.options;
    const delegation = this.options.delegation!;
    const current = delegation.current();
    const off = this.options.activeName === "off";
    const tone = (text: string): string => off ? theme.fg("dim", text) : text;
    const slider = this.sliderRow(lines.length, inner, current.mode, off);
    lines.push(slider ?? this.compactModeRow(lines.length, inner, false));
    const eagerY = lines.length, used = usesEagerness(current.mode);
    const box = `‹ ${current.eagerness} ›`;
    const left = ` Eagerness  ${box}`;
    const shown = this.previewMode ?? current.mode;
    const note = this.previewMode && this.previewMode !== current.mode ? `preview · ${modeLabels[this.previewMode]}`
      : used ? "" : "not used in Manual";
    const painted = this.twoSides(used ? tone(left) : theme.fg("dim", left), theme.fg("dim", note), inner);
    if (used) {
      const at = 1 + visibleWidth(" Eagerness  ");
      this.stepTargets.set(eagerY, visibleArrows(painted, [{ kind: "eagerness", direction: -1, x: at },
        { kind: "eagerness", direction: 1, x: at + visibleWidth(box) - 1 }]));
    }
    lines.push(this.row(painted, inner));
    if (guidelineRows > 0) {
      const text = delegation.guideline({ mode: shown, eagerness: current.eagerness });
      const wrapped = [...(off ? [theme.fg("warning", " Off: no Agent work. The mode applies when a model preset is active.")] : []),
        ...wrapWords(text, inner - 2).map((line) => theme.fg("dim", ` ${line}`))];
      const shownRows = wrapped.slice(0, guidelineRows);
      if (wrapped.length > guidelineRows) shownRows[guidelineRows - 1] = truncateToWidth(shownRows[guidelineRows - 1]! + " …", inner, "…");
      for (const line of shownRows) lines.push(this.row(truncateToWidth(line, inner, "…"), inner));
    }
    lines.push(this.divider(width));
  }

  /** `○ Manual ─── ● Co-worker ─── ○ Lead ─── ○ Supervisor`, or undefined if it cannot fit. */
  private sliderRow(y: number, inner: number, mode: DelegationMode, off: boolean): string | undefined {
    const { theme } = this.options;
    const nodes = delegationModes.map((each) => `${each === mode ? "●" : "○"} ${modeLabels[each]}`);
    const room = inner - visibleWidth(MODE_PREFIX) - nodes.reduce((sum, node) => sum + visibleWidth(node), 0) - 1;
    const gap = Math.floor(room / (nodes.length - 1));
    if (gap < 3) return undefined;
    const connector = ` ${"─".repeat(gap - 2)} `;
    let text = MODE_PREFIX, plain = MODE_PREFIX;
    const targets: { mode: DelegationMode; start: number; end: number }[] = [];
    delegationModes.forEach((each, index) => {
      if (index) { text += theme.fg("dim", connector); plain += connector; }
      const start = 1 + visibleWidth(plain);
      targets.push({ mode: each, start, end: start + visibleWidth(nodes[index]!) });
      const label = each === mode ? theme.bold(nodes[index]!) : nodes[index]!;
      text += each === mode ? theme.fg(off ? "dim" : "accent", label)
        : each === this.previewMode ? theme.fg("accent", label) : theme.fg(off ? "dim" : "muted", label);
      plain += nodes[index];
    });
    this.modeTargets.set(y, targets);
    return this.row(text, inner);
  }

  /** `Mode ‹ Co-worker ›`, plus `‹ balanced ›` when no eagerness row follows,
   * with clickable arrows, for panels too narrow or short for the slider. */
  private compactModeRow(y: number, inner: number, withEagerness: boolean): string {
    const { theme } = this.options;
    const current = this.options.delegation!.current();
    const modeBox = `‹ ${modeLabels[current.mode]} ›`;
    const eagerBox = withEagerness && usesEagerness(current.mode) ? ` ‹ ${current.eagerness} ›` : "";
    const prefix = " Mode ";
    const text = truncateToWidth(prefix + modeBox + eagerBox, inner, "…");
    const at = 1 + visibleWidth(prefix);
    const targets: { kind: "mode" | "eagerness"; direction: -1 | 1; x: number }[] = [
      { kind: "mode", direction: -1, x: at }, { kind: "mode", direction: 1, x: at + visibleWidth(modeBox) - 1 }];
    if (eagerBox) {
      const eagerAt = at + visibleWidth(modeBox) + 1;
      targets.push({ kind: "eagerness", direction: -1, x: eagerAt }, { kind: "eagerness", direction: 1, x: eagerAt + visibleWidth(eagerBox) - 2 });
    }
    this.stepTargets.set(y, visibleArrows(text, targets));
    return this.row(this.options.activeName === "off" ? theme.fg("dim", text) : text, inner);
  }

  private detailRows(inner: number, offset: number): string[] {
    const { presets, activeName, theme } = this.options;
    const current = presets[this.selected];
    if (!current) return [this.row(theme.fg("warning", " No presets available"), inner)];
    const badge = current.name === activeName ? theme.fg("success", "● active") : theme.fg("muted", "○ inactive");
    const label = current.name + (!isOffPreset(current) && marked(current) ? "*" : "");
    const heading = this.twoSides(` ${theme.bold(label)}  ${badge}`, theme.fg("dim", this.version(current)), inner);
    if (isOffPreset(current)) return [this.row(heading, inner), ...this.offNoticeRows(inner)];
    const rows = [this.row(heading, inner)];
    for (const strength of workerSlotDisplayOrder)
      rows.push(this.slotRow(strength, current.models[strength], current, inner, offset + rows.length));
    return rows;
  }

  private offNoticeRows(inner: number): string[] {
    const { theme } = this.options;
    return [this.row(theme.fg("warning", " No new, resumed, or steered work."), inner),
      this.row(theme.fg("muted", " Accepted work continues."), inner)];
  }

  /** The slot's current effective level plus the session-override star.
   * Fixed policies show their raw value
   * (marked when live metadata says the model does not support it); inherit
   * resolves through the host's capabilities or says unavailable. Legacy
   * read-only hosts keep their configured policy instead of inventing a
   * resolution at spawn time. */
  private slotEffort(preset: PresetSnapshot, strength: Strength): string {
    const policy = effectiveEffort(preset, strength);
    const star = preset.effort_overrides?.[strength] !== undefined ? "*" : "";
    if (!this.options.efforts) return policy + star;
    const caps = this.caps(preset, strength); // one metadata snapshot per row
    const supported = this.levels(caps);
    if (policy === "inherit") {
      const inherited = caps.inherited;
      return inherited !== undefined && supported.includes(inherited) ? inherited + star : `unavailable${star}`;
    }
    return policy + (supported.includes(policy) ? "" : "!") + star;
  }

  private slotRow(strength: Strength, model: string, preset: PresetSnapshot, inner: number, y: number, selected = false): string {
    const { theme } = this.options;
    const label = SLOT_LABEL[strength].padEnd(8);
    const effort = this.slotEffort(preset, strength);
    // Preserve the slot and effective effort at narrow widths; the long model
    // gives way first, and model text that no longer fits paints no target.
    if (inner < 26) return this.row(`${selected ? "›" : " "}${SLOT_LABEL[strength]}:${theme.fg("dim", effort)}`, inner);
    const left = `${selected ? "›" : " "}${theme.fg(selected ? "accent" : "muted", label)} ${model}`;
    const right = theme.fg("dim", effort);
    const row = this.row(this.twoSides(left, right, inner), inner);
    if (this.options.management?.models) {
      // The model starts after the border, space, the 8-column label and one
      // separating space. A clipped row measures the REAL fitted width
      // (truncateToWidth drops a wide character that cannot fit), so the
      // target covers only painted model columns — never the ellipsis, and
      // never the padding a shorter fitted row leaves behind.
      const room = Math.max(1, inner - visibleWidth(right) - 1);
      const start = visibleWidth(` ${label} `) + 1; // border is column zero
      const truncated = visibleWidth(left) > room; // a model id ending in … is not “truncated”
      const fitted = truncated ? visibleWidth(truncateToWidth(left, room, "…")) : visibleWidth(left);
      const painted = truncated ? fitted - (start - 1) - 1 : visibleWidth(model);
      if (painted > 0 && start + painted <= inner + 1)
        this.modelTargets.set(y, [{ preset: preset.name, slot: strength, start, end: start + painted }]);
    }
    return row;
  }

  private canEdit(): boolean {
    const selected = this.options.presets[this.selected];
    return !!this.options.efforts && !!this.options.setEffort && !!selected && !isOffPreset(selected);
  }

  private openEditor(): void {
    const selected = this.options.presets[this.selected];
    if (!this.canEdit() || !selected) return;
    if (selected.name !== this.options.activeName) {
      // A startup continuation may initialize the active effort page before
      // paint, but may not route an invisible inactive preset to confirmation.
      if (this.usable()) this.finish({ action: "edit-effort", name: selected.name });
      return;
    }
    this.editing = true;
    this.dragging = false;
    this.previewMode = undefined;
    this.slotIndex = 0;
    this.effortError = undefined;
    this.options.tui.requestRender();
  }

  private back(): void {
    this.editing = false;
    this.dragging = false;
    this.previewMode = undefined;
    this.effortError = undefined;
    this.options.tui.requestRender();
  }

  private caps(preset: PresetSnapshot, slot: Strength): EffortCapabilities {
    try { return this.options.efforts?.(preset, slot) ?? { levels: [], error: "Effort capabilities unavailable" }; }
    catch (error) { return { levels: [], error: String(error) }; }
  }

  private levels(caps: EffortCapabilities): ThinkingLevel[] {
    return thinkingLevels.filter((level) => caps.levels.includes(level));
  }

  private chosen(preset: PresetSnapshot, slot: Strength): Effort {
    return preset.effort_overrides?.[slot] ?? defaultEffort(preset, slot);
  }

  private fixedIssue(preset: PresetSnapshot, slot: Strength, caps: EffortCapabilities,
    overrides: EffortOverrides = preset.effort_overrides ?? {}): string | undefined {
    const value = overrides[slot] ?? defaultEffort(preset, slot);
    if (value === "inherit") return undefined;
    if (caps.error) return caps.error;
    return this.levels(caps).includes(value) ? undefined : `Unsupported effort: ${value}`;
  }

  private inheritWarning(preset: PresetSnapshot, slot: Strength, caps: EffortCapabilities): string | undefined {
    if (this.chosen(preset, slot) !== "inherit") return undefined;
    return caps.error ?? caps.inheritError ??
      (!caps.inherited || !this.levels(caps).includes(caps.inherited) ? "Inherited effort unavailable" : undefined);
  }

  private step(slot: Strength, direction: -1 | 1): void {
    const preset = this.options.presets[this.selected];
    if (!preset || isOffPreset(preset) || !this.usable()) return;
    const values: (Effort | "default")[] = ["default", "inherit", ...this.levels(this.caps(preset, slot))];
    const current = preset.effort_overrides?.[slot] ?? "default";
    const index = values.indexOf(current);
    // An obsolete/unsupported policy is shown as invalid, never silently
    // accepted. One adjustment starts from the explicit default choice.
    const next = values[Math.max(0, Math.min(values.length - 1, (index < 0 ? 0 : index) + (index < 0 ? 0 : direction)))];
    const overrides = { ...preset.effort_overrides };
    if (next === "default") delete overrides[slot];
    else overrides[slot] = next;
    this.setEffort(overrides);
  }

  private setEffort(overrides: EffortOverrides): void {
    const preset = this.options.presets[this.selected];
    if (!this.editing || !preset || isOffPreset(preset) || !this.options.setEffort || !this.usable()) return;
    if (strengths.every((slot) => overrides[slot] === preset.effort_overrides?.[slot])) return;
    const issues = strengths.flatMap((slot) => {
      const issue = this.fixedIssue(preset, slot, this.caps(preset, slot), overrides);
      return issue ? [`${SLOT_LABEL[slot]}: ${issue}`] : [];
    });
    this.effortError = issues.length ? `Change not applied: ${issues.join("; ")}` : undefined;
    if (!issues.length) {
      try {
        const applied = this.options.setEffort(preset.name, { ...overrides });
        if (applied && !isOffPreset(applied) && applied.name === preset.name) {
          this.options.presets = this.options.presets.map((each) => each.name === applied.name ? applied : each);
        } else this.effortError = "Change not applied; previous settings kept.";
      } catch { this.effortError = "Change not applied; previous settings kept."; }
    }
    this.options.tui.requestRender();
  }

  private editInput(data: string): void {
    const { keybindings } = this.options;
    if (matchesKey(data, "escape") || keybindings.matches(data, "tui.select.confirm")) return this.back();
    if (matchesKey(data, "r") || matchesKey(data, "shift+r")) return this.setEffort({});
    if (matchesKey(data, "left")) return this.step(workerSlotDisplayOrder[this.slotIndex]!, -1);
    if (matchesKey(data, "right")) return this.step(workerSlotDisplayOrder[this.slotIndex]!, 1);
    if (/^[1-5]$/.test(data)) this.slotIndex = workerSlotDisplayOrder.indexOf(strengths[Number(data) - 1]!);
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
      this.slotIndex = (this.slotIndex + (matchesKey(data, "shift+tab") ? strengths.length - 1 : 1)) % strengths.length;
    else if (keybindings.matches(data, "tui.select.up")) this.slotIndex = Math.max(0, this.slotIndex - 1);
    else if (keybindings.matches(data, "tui.select.down")) this.slotIndex = Math.min(strengths.length - 1, this.slotIndex + 1);
    else return;
    this.options.tui.requestRender();
  }

  private addAction(lines: string[], inner: number, text: string,
    actions: { kind: PickerAction; label: string }[]): void {
    const y = lines.length;
    // An edge label may be replaced by the truncation ellipsis even when its
    // original span fits. Only the exact surviving label is a click target.
    const painted = truncateToWidth(text, inner, "…");
    this.actionTargets.set(y, actions.map(({ kind, label }) => {
      const start = painted.indexOf(label) + 1; // border is column zero
      return { kind, start, end: start + label.length };
    }).filter(({ start, end }) => start > 0 && end <= inner + 1));
    lines.push(this.row(this.options.theme.fg("dim", text), inner));
  }

  private clickAction(event: PickerMouseEvent): boolean {
    const action = this.actionTargets.get(event.y)?.find(({ start, end }) => event.x >= start && event.x < end);
    if (!action) return false;
    switch (action.kind) {
      case "edit": this.openEditor(); break;
      case "reset": this.setEffort({}); break;
      case "back": this.back(); break;
      case "settings": this.managementChoice("settings"); break;
      case "create": this.managementChoice("create-preset"); break;
      case "editPreset": this.managementChoice("edit-preset"); break;
      case "saveGlobal": this.saveDefault("global"); break;
      case "saveWorkspace": this.saveDefault("workspace"); break;
    }
    return true;
  }

  private canSaveDefault(scope: PersistentScope): boolean {
    if (!this.options.management?.saveDefaults) return false;
    if (scope === "global") return true;
    try { return this.options.management.canSaveWorkspace?.() === true; }
    catch { return false; }
  }

  private saveDefault(scope: PersistentScope): void {
    if (this.canSaveDefault(scope)) this.finish({ action: "save-default", scope });
  }

  /** Only whole painted labels are targets. Project saving stays inert without
   * trust, including when it changed since the last paint. */
  private saveLabels(inner: number, reserve = 0): { text: string; actions: { kind: PickerAction; label: string }[] } | undefined {
    const workspace = this.canSaveDefault("workspace");
    const variants = [
      { global: "[G] Save as global default", workspace: workspace ? "[W] Save as project default" : "[W] Project default (trust required)", suffix: " (on exit)" },
      { global: "[G] Global default", workspace: workspace ? "[W] Project default" : "[W] Project (trust required)", suffix: " (on exit)" },
      { global: "G global", workspace: workspace ? "W project" : "W trust required", suffix: " · on exit" },
      { global: "G global", workspace: workspace ? "W project" : "W trust", suffix: "" },
      { global: "G", workspace: workspace ? "W" : "W trust", suffix: "", prefix: " " },
      { global: "G", workspace: "W", suffix: "", prefix: " " },
    ];
    for (const variant of variants) {
      const text = `${variant.prefix ?? " Save: "}${variant.global} · ${variant.workspace}${variant.suffix}`;
      if (visibleWidth(text) + reserve > inner) continue;
      return { text, actions: [{ kind: "saveGlobal", label: variant.global },
        ...(workspace ? [{ kind: "saveWorkspace" as const, label: variant.workspace }] : [])] };
    }
    return undefined;
  }

  private saveControls(lines: string[], inner: number): boolean {
    const saving = this.saveLabels(inner);
    if (!saving) return false;
    this.addAction(lines, inner, saving.text, saving.actions);
    return true;
  }

  /** A management label was clicked. The same gating as its key applies:
   * only routes the host enabled, and edit-preset needs a highlighted
   * non-off preset. */
  private managementChoice(kind: "settings" | "create-preset" | "edit-preset"): void {
    const management = this.options.management;
    if (!management) return;
    if (kind === "settings") {
      if (management.settings) this.finish({ action: "settings" });
      return;
    }
    if (!management.presets) return;
    if (kind === "create-preset") return this.finish({ action: "create-preset" });
    const highlighted = this.options.presets[this.selected];
    if (highlighted && !isOffPreset(highlighted))
      this.finish({ action: "edit-preset", name: highlighted.name });
  }

  /** Edit-preset routes to the host's own preset dialog, not the effort
   * editor; off is a control state, not an editable preset. */
  private canEditPreset(): boolean {
    const highlighted = this.options.presets[this.selected];
    return !!this.options.management?.presets && !!highlighted && !isOffPreset(highlighted);
  }

  /** Whether the highlighted preset's slot models can be routed to the host's
   * own selector: a UI gate only, never authorization. */
  private canPickModels(): boolean {
    const highlighted = this.options.presets[this.selected];
    return !!this.options.management?.models && !!highlighted && !isOffPreset(highlighted);
  }

  /** Route one slot's model to the host's own selector. A click carries its
   * absolute screen position so that selector can open nearby; a keyboard
   * route has none. */
  private pickModel(slot: Strength, event?: PickerMouseEvent, paintedPreset?: string): void {
    // A wheel/key can move the highlight before the scheduled repaint. Mouse
    // routes belong to what was painted, while keyboard routes use highlight.
    const highlighted = paintedPreset === undefined ? this.options.presets[this.selected]
      : this.options.presets.find((preset) => preset.name === paintedPreset);
    if (!highlighted || isOffPreset(highlighted) || !this.usable()) return;
    const position = event && typeof event.screenX === "number" && typeof event.screenY === "number"
      ? { row: event.screenY, col: event.screenX } : undefined;
    this.finish({ action: "edit-model", name: highlighted.name, slot, ...(position ? { position } : {}) });
  }

  /** Management hint labels in paint order; empty without the option. */
  private managementLabels(): { kind: PickerAction; label: string }[] {
    const management = this.options.management;
    if (!management) return [];
    const labels: { kind: PickerAction; label: string }[] = [];
    if (management.settings) labels.push({ kind: "settings", label: "P Settings" });
    if (management.presets) {
      labels.push({ kind: "create", label: "N New" });
      if (this.canEditPreset()) labels.push({ kind: "editPreset", label: "C Edit" });
    }
    return labels;
  }

  /** The host's one-line management scope/pending status, when it supplies a
   * nonempty one. Rendering must never fail on a status callback. */
  private managementSummary(): string | undefined {
    try {
      const summary = this.options.management?.summary?.();
      return typeof summary === "string" && summary.trim() ? summary : undefined;
    } catch { return undefined; }
  }

  private listControls(lines: string[], inner: number, compact: boolean, saveShown = false): void {
    // At the minimum height use the existing controls row for saving instead
    // of silently dropping it. Verbose navigation hints yield first.
    if (!saveShown && this.canSaveDefault("global")) {
      // Six inner columns must retain both save letters and slot navigation.
      // A locked W may paint, but gets no action; saving rechecks live trust.
      if (compact && inner < 12) {
        this.addAction(lines, inner, "GW Tab", [
          { kind: "saveGlobal", label: "G" },
          ...(this.canSaveDefault("workspace") ? [{ kind: "saveWorkspace" as const, label: "W" }] : []),
        ]);
        return;
      }
      const edit = this.canEdit();
      // Prefer shorter save prose when it can also fit the mode keys. If even
      // bare save letters cannot share that hint, retain the mandatory Tab.
      const minimumHint = compact && this.options.delegation ? ` · Tab · ←→ ⇧←→${edit ? " · E" : ""}` : " · Tab";
      const saving = this.saveLabels(inner, compact ? visibleWidth(minimumHint) : 0)
        ?? this.saveLabels(inner, compact ? visibleWidth(" · Tab") : 0);
      if (saving) {
        let text = saving.text;
        const hints = compact
          ? [...this.delegationControlHints().map((hint) => ` · Tab${hint}${edit ? " · E" : ""}`),
            ...(edit ? [" · Tab slots · E effort · ↑↓↵ Esc", " · Tab · E ↑↓↵ Esc", " · Tab · E", " · Tab"]
              : [" · Tab slots · ↑↓↵ Esc", " · Tab · ↵ Esc", " · Tab"])]
          : edit ? [" · E effort · ↑↓↵ Esc", " · E ↑↓↵ Esc", " · E"] : [" · ↑↓↵ Esc", " · ↵ Esc"];
        const hint = hints.find((each) => visibleWidth(text) + visibleWidth(each) <= inner);
        if (hint) text += hint;
        this.addAction(lines, inner, text, [...saving.actions, ...(edit && hint?.includes(" · E") ? [{ kind: "edit" as const, label: "E" }] : [])]);
        return;
      }
    }
    const base = this.controls(inner, compact);
    const labels = this.managementLabels();
    let text = base;
    if (compact) {
      const hint = this.delegationControlHints().find((each) => visibleWidth(text) + visibleWidth(each) <= inner);
      if (hint) text += hint;
    }
    if (labels.length) {
      // The hint appears only when its labels fit whole; when even they do
      // not, the keys remain reachable without painted targets.
      const full = labels.map(({ label }) => ` · ${label}`).join("");
      if (visibleWidth(text) + visibleWidth(full) <= inner) text += full;
      else {
        const min = ` · ${labels.map(({ label }) => label.slice(0, 1)).join(" ")}`;
        if (visibleWidth(text) + visibleWidth(min) <= inner) {
          text += min;
          for (const label of labels) label.label = label.label.slice(0, 1);
        }
      }
    }
    // The model route's hint rides along when it fits; the digits stay
    // reachable even without it, and it is never a click target.
    if (this.canPickModels()) {
      for (const hint of [" · 1/2/3/4/5 model", " · 12345"]) {
        if (visibleWidth(text) + visibleWidth(hint) <= inner) { text += hint; break; }
      }
    }
    this.addAction(lines, inner, text, [
      ...(this.canEdit() ? [{ kind: "edit" as const, label: this.effortControlLabel(inner, compact) }] : []),
      ...labels,
    ]);
  }

  private renderEditor(width: number, inner: number, maxLines: number): string[] {
    const preset = this.options.presets[this.selected];
    if (!preset || isOffPreset(preset)) { this.back(); return this.renderCompact(width, inner, maxLines); }
    const { theme } = this.options;
    const selectedSlot = workerSlotDisplayOrder[this.slotIndex]!;
    const caps = Object.fromEntries(strengths.map((slot) => [slot, this.caps(preset, slot)])) as Record<Strength, EffortCapabilities>;
    const errors = strengths.flatMap((slot) => {
      const issue = this.fixedIssue(preset, slot, caps[slot]);
      return issue ? [`${SLOT_LABEL[slot]}: ${issue}`] : [];
    });
    const warnings = strengths.flatMap((slot) => {
      const warning = this.inheritWarning(preset, slot, caps[slot]);
      return warning ? [`${SLOT_LABEL[slot]}: ${warning}`] : [];
    });
    // Base: title + five slots + status + controls + bottom. Spare chrome/save
    // rows cannot steal space from the five slots; smaller viewports scroll.
    const baseRows = strengths.length + 4;
    const saveRows = this.canSaveDefault("global") && maxLines >= baseRows + 1 ? 1 : 0;
    const lines = [this.title(width, `Effort · ${preset.name}`)];
    if (maxLines >= baseRows + 1 + saveRows) lines.push(this.row(theme.fg("muted", " New Agents only; main unchanged"), inner));
    if (maxLines >= baseRows + 2 + saveRows) lines.push(this.row(theme.fg("dim", " source: preset defaults + session overrides · changes apply immediately"), inner));
    if (maxLines >= baseRows + 3 + saveRows) lines.push(this.divider(width));
    const slots = this.slotWindow(maxLines - lines.length - 3 - saveRows);
    for (const slot of slots) {
      const selected = slot === selectedSlot;
      const value = preset.effort_overrides?.[slot] ?? "default";
      const short = inner < 27;
      const label = SLOT_LABEL[slot];
      const problem = this.fixedIssue(preset, slot, caps[slot]) ?? this.inheritWarning(preset, slot, caps[slot]);
      const base = ` ${selected ? "›" : " "}‹${label}:${value}›${problem ? " !" : ""}`;
      const suffix = short ? "" : ` · ${preset.models[slot]}`;
      const text = truncateToWidth(base + suffix, inner, "…");
      // Hit-test only arrows that survived clipping, in visible terminal
      // columns (not UTF-16 offsets). The leading selection marker is not a
      // next arrow, and the row's label/model/blank area selects only.
      const prevIndex = text.indexOf("‹");
      const nextIndex = prevIndex < 0 ? -1 : text.indexOf("›", prevIndex + 1);
      const hit = (index: number): number | undefined => index < 0 ? undefined :
        1 + visibleWidth(text.slice(0, index)); // left popover border
      this.slotTargets.set(lines.length, { slot, prev: hit(prevIndex), next: hit(nextIndex) });
      // For narrow rows the value and arrows take precedence over model IDs.
      lines.push(this.row(selected ? theme.bg("selectedBg", text) : text, inner));
    }
    const inherited = caps[selectedSlot].error ?? caps[selectedSlot].inheritError ?? caps[selectedSlot].inherited ?? "unavailable";
    if (maxLines >= baseRows + 4 + saveRows) lines.push(this.row(theme.fg("dim", ` default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited} · model: ${preset.models[selectedSlot]}`), inner));
    const info = this.effortError ? ` ! ${this.effortError}` : errors.length ? ` ! Current policy unavailable: ${errors.join("; ")}` : warnings.length
      ? ` Inherit checked at spawn: ${warnings.join("; ")}`
      : ` Changes apply immediately · default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited}`;
    const scope = maxLines < baseRows + 1 + saveRows ? " New Agents only; main unchanged ·" : "";
    lines.push(this.row(theme.fg(this.effortError || errors.length || warnings.length ? "warning" : "muted", scope + info), inner));
    const saveShown = saveRows > 0 && this.saveControls(lines, inner);
    this.editorControls(lines, inner, saveShown, slots.length < strengths.length);
    lines.push(this.bottom(width));
    return lines;
  }

  private editorControls(lines: string[], inner: number, saveShown: boolean, windowed: boolean): void {
    // Hidden slots need a visible navigation hint before optional reset/back
    // prose. Reserve it even when saving shares the minimum-height control row.
    const navigation = !windowed ? "" : inner >= 27 ? " · ↑↓/1–5 slot" : inner >= 14 ? " · ↑↓/1–5" : " ↑↓";
    if (!saveShown && this.canSaveDefault("global")) {
      const saving = this.saveLabels(inner, visibleWidth(navigation));
      if (saving) {
        const hints = [navigation + " · R reset · Esc back", navigation + " · R Esc", navigation];
        const hint = hints.find((each) => visibleWidth(saving.text) + visibleWidth(each) <= inner);
        this.addAction(lines, inner, saving.text + (hint ?? ""), [...saving.actions,
          ...(hint?.includes("R") ? [{ kind: "reset" as const, label: "R" }] : []),
          ...(hint?.includes("Esc") ? [{ kind: "back" as const, label: "Esc" }] : [])]);
        return;
      }
      // `G · W` cannot share six columns with a navigation hint. Keep both
      // letters and the hint, without a separator that would hide one of them.
      const tight = `GW${navigation.trim()}`;
      if (navigation && this.canSaveDefault("workspace") && visibleWidth(tight) <= inner) {
        this.addAction(lines, inner, tight, [
          { kind: "saveGlobal", label: "G" }, { kind: "saveWorkspace", label: "W" },
        ]);
        return;
      }
    }
    const controls = windowed ? inner < 14 ? " ↑↓ R Esc" : inner < 23 ? " ↑↓/1–5 · R Esc" : " ↑↓/1–5 slot · ←→ · R Esc"
      : inner < 14 ? " R Esc" : inner < 23 ? " R reset · Esc" : " R reset · Enter/Esc back · Alt+S close · ←→ adjust · ↑↓/1–5 slot";
    this.addAction(lines, inner, controls, [
      { kind: "reset", label: windowed || inner < 14 ? "R" : "R reset" },
      { kind: "back", label: windowed || inner < 23 ? "Esc" : "Esc back" },
    ]);
  }

  private effortControlLabel(inner: number, compact: boolean): string {
    return inner < (compact ? 46 : 22) ? "E" : "Edit effort";
  }

  private delegationControlHints(): readonly string[] {
    return this.options.delegation ? [" · ←→ mode · ⇧←→ eagerness", " · ←→ mode · ⇧←→ eager", " · ←→ ⇧←→"] : [];
  }

  private controls(inner: number, compact: boolean): string {
    const effortLabel = this.effortControlLabel(inner, compact);
    // Slot-window navigation stays discoverable even with delegation or saving.
    if (compact) {
      // Below 12 columns the surviving prefix is the only hint, so slot
      // navigation leads. Wider compact rows keep Alt+S and that hint.
      if (inner < 12) return " Tab↑↓";
      if (inner < 22) return ` Alt+S Tab ↑↓${this.canEdit() ? ` ${effortLabel}` : ""}↵`;
      if (inner < 46) return ` Alt+S · Tab slots · ↑↓${this.canEdit() ? ` ${effortLabel}` : ""} ↵ Esc`;
      return ` Alt+S · Tab slots · ↑↓ preset${this.canEdit() ? ` · E ${effortLabel}` : ""} · Enter Esc`;
    }
    if (this.options.delegation) {
      const edit = this.canEdit();
      if (inner >= 70) return ` ←→ mode · ⇧←→ eagerness · ↑↓ preset${edit ? " · Edit effort" : ""} · Enter · Esc`;
      if (inner >= 46) return ` ←→ mode · ⇧←→ eager · ↑↓${edit ? " · Edit effort" : ""} · ↵ · Esc`;
      if (inner >= 22) return edit ? " ←→ ⇧←→ ↑↓ E Edit effort ↵" : " ←→ ⇧←→ ↑↓ ↵ Esc";
    }
    if (inner < 22) return this.canEdit() ? "Alt+S E ↑↓↵ Esc" : " Alt+S ↑↓ ↵ Esc";
    if (inner < 46) return this.canEdit() ? " Alt+S ↑↓ E Edit effort ↵ Esc" : " Alt+S close · ↑↓ Enter Esc";
    if (this.canEdit()) return " Alt+S close · E Edit effort · ↑↓ navigate · Enter apply · Esc";
    return " Alt+S close · ↑↓ navigate · Enter apply · Esc cancel";
  }

  /** Off is a control state; every configured model preset has a version. */
  private version(preset: PresetSelection): string {
    return isOffPreset(preset) ? "" : preset.version;
  }

  private twoSides(left: string, right: string, width: number): string {
    const room = Math.max(1, width - visibleWidth(right) - 1);
    const fittedLeft = truncateToWidth(left, room, "…");
    return fittedLeft + " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right))) + right;
  }

  private title(width: number, title: string): string {
    return popoverTitle(this.options.theme, width, title, this.options.pointer);
  }

  private divider(width: number): string {
    return popoverDivider(this.options.theme, width);
  }

  private bottom(width: number): string {
    return popoverBottom(this.options.theme, width);
  }

  private row(content: string, inner: number): string {
    return popoverRow(this.options.theme, content, inner);
  }
}

/** Greedy word wrap by terminal columns; an overlong word is left to the row's truncation. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && visibleWidth(next) > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Keep only arrow targets whose column still paints `‹` or `›` after clipping
 * (a row's border is column zero). */
function visibleArrows<T extends { x: number }>(row: string, targets: T[]): T[] {
  return targets.filter(({ x }) => {
    const cell = stripTerminalSequences(sliceByColumn(row, x - 1, 1, true));
    return cell === "‹" || cell === "›";
  });
}
