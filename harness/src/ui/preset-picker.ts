import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { OverlayRequest } from "./overlay-request.js";
import { isPopoverCloseClick, popoverBottom, popoverDivider, popoverRow, popoverTitle } from "./popover.js";
import { delegationModes, eagernessLevels, modeLabels, usesEagerness, type DelegationMode, type DelegationSetting } from "../delegation.js";
import { isOffPreset, strengths, thinkingLevels, type Effort, type EffortOverrides, type PresetSelection, type PresetSnapshot, type Strength, type ThinkingLevel } from "../routing.js";

export type PresetChoice = string | { name: string; effort_overrides: EffortOverrides };

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
}

/** The pointer event as the picker reads it; a structural subset of pi-tui's. */
export interface PickerMouseEvent {
  type: string;
  button?: string;
  x: number;
  y: number;
  wheelDelta?: number;
}

/** What the picker asks of pi-tui after a pointer event. */
export interface PickerMouseResult { handled: boolean; capture?: boolean; render?: boolean }

const MIN_FULL_LINES = 11;
/** The compact layout: title, selected detail, controls, bottom edge. */
export const PRESET_PICKER_MIN_ROWS = 7;
/** Slider, eagerness and divider rows above the preset list. */
const MODE_ROWS = 3;
const GUIDELINE_ROWS = 3;
const MODE_PREFIX = " Mode   ";
const SLOT_LABEL: Record<Strength, string> = { light: "light", standard: "standard", strong: "strong" };
const DIFFICULTY: Record<Strength, string> = { light: "d1–2", standard: "d3", strong: "d4–5" };
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

/** A picker with a staged effort editor. Publishing either choice remains the
 * caller's separate, validated transaction. */
export class PresetPicker implements Component {
  private selected: number;
  private visibleRows = 1;
  private closed = false;
  /** Which preset each painted row shows, so a click hits what is on screen. */
  private rowTargets = new Map<number, number>();
  private paintedWidth = 0;
  private editing = false;
  private slotIndex = 0;
  private draft: EffortOverrides = {};
  private slotTargets = new Map<number, { slot: Strength; prev?: number; next?: number }>();
  private actionTargets = new Map<number, { kind: "edit" | "apply" | "reset" | "back"; start: number; end: number }[]>();
  /** Painted slider nodes by row, in terminal columns (border is column zero). */
  private modeTargets = new Map<number, { mode: DelegationMode; start: number; end: number }[]>();
  /** Painted ‹ › arrows that step the mode or eagerness, by row. */
  private stepTargets = new Map<number, { kind: "mode" | "eagerness"; direction: -1 | 1; x: number }[]>();
  /** The node under a drag, previewed until the release applies it. */
  private previewMode: DelegationMode | undefined;
  private dragging = false;
  /** A key ended a held slider press: pi-tui still owns that press and turns
   * an unmoved release into a click, which must not apply the cancelled node. */
  private cancelledPress = false;

  constructor(private readonly options: PresetPickerOptions) {
    const active = options.presets.findIndex((preset) => preset.name === options.activeName);
    this.selected = active < 0 ? 0 : active;
  }

  selection(): string | undefined { return this.options.presets[this.selected]?.name; }

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
    if (matchesKey(data, "alt+s") || (this.editing && matchesKey(data, "ctrl+c"))) return this.finish(null);
    if (this.editing) return this.editInput(data);
    if (keybindings.matches(data, "tui.select.cancel")) return this.finish(null);
    const current = this.selection();
    if (this.options.efforts && (matchesKey(data, "e") || matchesKey(data, "shift+e"))) {
      this.openEditor();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      if (current) this.finish(current);
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
   * In the editor a slot row selects it; only visible arrows change its draft.
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
    if (isPopoverCloseClick(event, this.paintedWidth)) {
      this.finish(null);
      return { handled: true };
    }
    if (!this.editing) {
      const delegation = this.delegationMouse(event);
      if (delegation) return delegation;
    }
    const { presets } = this.options;
    if (this.editing) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const slot = this.slotTargets.get(event.y);
      if (slot) {
        this.slotIndex = strengths.indexOf(slot.slot);
        if (slot.prev !== undefined && event.x === slot.prev) this.step(slot.slot, -1);
        else if (slot.next !== undefined && event.x === slot.next) this.step(slot.slot, 1);
        else this.options.tui.requestRender();
      } else this.clickAction(event);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && this.clickAction(event)) return { handled: true };
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
    if (!delegation) return;
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
    const share = Math.floor(this.options.tui.terminal.rows * 0.8);
    const maxLines = Math.max(PRESET_PICKER_MIN_ROWS, Math.min(share, this.options.rows?.() ?? share));
    if (this.editing) return this.renderEditor(width, inner, maxLines);
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    return maxLines < MIN_FULL_LINES + modeRows ? this.renderCompact(width, inner, maxLines) : this.renderFull(width, inner, maxLines);
  }

  private finish(value: PresetChoice | null): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(value);
  }

  private renderFull(width: number, inner: number, maxLines: number): string[] {
    const { presets, activeName, theme } = this.options;
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    // The mode's guideline takes up to three rows; the list keeps at least one.
    const guidelineRows = this.options.delegation ? Math.max(0, Math.min(GUIDELINE_ROWS, maxLines - MIN_FULL_LINES - modeRows)) : 0;
    this.visibleRows = Math.max(1, Math.min(presets.length, maxLines - 10 - modeRows - guidelineRows));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.visibleRows / 2), presets.length - this.visibleRows));
    const end = Math.min(presets.length, start + this.visibleRows);
    const range = presets.length ? `${start + 1}–${end}/${presets.length}` : "0/0";
    const scope = [" Model preset · new Agents only; main unchanged · * effort", " Model preset · new Agents only",
      " Model preset"].find((text) => visibleWidth(text) + visibleWidth(range) + 1 <= inner) ?? " Model preset";
    const lines = [this.title(width, "Delegation")];
    if (this.options.delegation) this.modeSection(lines, width, inner, guidelineRows);
    lines.push(this.row(this.twoSides(theme.fg("muted", scope),
        theme.fg("dim", range), inner), inner),
      this.divider(width));
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
    lines.push(...this.detailRows(inner));
    this.listControls(lines, inner, false);
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
      else for (const strength of strengths) lines.push(this.slotRow(strength, current.models[strength], current, inner));
    }
    this.listControls(lines, inner, true);
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

  private detailRows(inner: number): string[] {
    const { presets, activeName, theme } = this.options;
    const current = presets[this.selected];
    if (!current) return [this.row(theme.fg("warning", " No presets available"), inner)];
    const badge = current.name === activeName ? theme.fg("success", "● active") : theme.fg("muted", "○ inactive");
    const label = current.name + (!isOffPreset(current) && marked(current) ? "*" : "");
    const heading = this.twoSides(` ${theme.bold(label)}  ${badge}`, theme.fg("dim", this.version(current)), inner);
    if (isOffPreset(current)) return [this.row(heading, inner), ...this.offNoticeRows(inner)];
    return [this.row(heading, inner), ...strengths.map((strength) => this.slotRow(strength, current.models[strength], current, inner))];
  }

  private offNoticeRows(inner: number): string[] {
    const { theme } = this.options;
    return [this.row(theme.fg("warning", " No new, resumed, or steered work."), inner),
      this.row(theme.fg("muted", " Accepted work continues."), inner)];
  }

  private slotRow(strength: Strength, model: string, preset: PresetSnapshot, inner: number): string {
    const { theme } = this.options;
    const label = SLOT_LABEL[strength].padEnd(8);
    const mappings = Object.entries(preset.thinking[strength]).map(([from, to]) => `${from}→${to}`).join(",");
    const policy = mappings ? ` · think ${mappings}` : "";
    const effort = effectiveEffort(preset, strength) + (preset.effort_overrides?.[strength] !== undefined ? "*" : "");
    // Preserve the slot and effective effort at narrow widths; the long model
    // (and then compatibility map) gives way first.
    if (inner < 26) return this.row(`${SLOT_LABEL[strength]}:${theme.fg("dim", effort)}`, inner);
    const right = inner < 36 ? effort : `${effort}${policy}`;
    return this.row(this.twoSides(` ${theme.fg(strength === "strong" ? "accent" : "muted", label)} ${model}`,
      theme.fg("dim", right), inner), inner);
  }

  private canEdit(): boolean {
    const selected = this.options.presets[this.selected];
    return !!this.options.efforts && !!selected && !isOffPreset(selected);
  }

  private openEditor(): void {
    const selected = this.options.presets[this.selected];
    if (!this.options.efforts || !selected || isOffPreset(selected)) return;
    this.editing = true;
    this.dragging = false;
    this.previewMode = undefined;
    this.slotIndex = 0;
    this.draft = { ...(selected.effort_overrides ?? {}) };
    this.options.tui.requestRender();
  }

  private back(): void {
    this.editing = false;
    this.dragging = false;
    this.previewMode = undefined;
    this.draft = {};
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
    return this.draft[slot] ?? defaultEffort(preset, slot);
  }

  private fixedIssue(preset: PresetSnapshot, slot: Strength, caps: EffortCapabilities): string | undefined {
    const value = this.chosen(preset, slot);
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
    if (!preset || isOffPreset(preset)) return;
    const values: (Effort | "default")[] = ["default", "inherit", ...this.levels(this.caps(preset, slot))];
    const current = this.draft[slot] ?? "default";
    const index = values.indexOf(current);
    // An obsolete/unsupported policy is shown as invalid, never silently
    // accepted. One adjustment starts from the explicit default choice.
    const next = values[Math.max(0, Math.min(values.length - 1, (index < 0 ? 0 : index) + (index < 0 ? 0 : direction)))];
    if (next === "default") delete this.draft[slot];
    else this.draft[slot] = next;
    this.options.tui.requestRender();
  }

  private applyDraft(): void {
    const preset = this.options.presets[this.selected];
    if (!preset || isOffPreset(preset)) return;
    if (strengths.some((slot) => this.fixedIssue(preset, slot, this.caps(preset, slot)))) {
      this.options.tui.requestRender();
      return;
    }
    this.finish({ name: preset.name, effort_overrides: { ...this.draft } });
  }

  private editInput(data: string): void {
    const { keybindings } = this.options;
    if (matchesKey(data, "escape")) return this.back();
    if (keybindings.matches(data, "tui.select.confirm")) return this.applyDraft();
    if (matchesKey(data, "r") || matchesKey(data, "shift+r")) {
      this.draft = {};
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, "left")) return this.step(strengths[this.slotIndex]!, -1);
    if (matchesKey(data, "right")) return this.step(strengths[this.slotIndex]!, 1);
    if (keybindings.matches(data, "tui.select.up")) this.slotIndex = Math.max(0, this.slotIndex - 1);
    else if (keybindings.matches(data, "tui.select.down")) this.slotIndex = Math.min(strengths.length - 1, this.slotIndex + 1);
    else return;
    this.options.tui.requestRender();
  }

  private addAction(lines: string[], inner: number, text: string,
    actions: { kind: "edit" | "apply" | "reset" | "back"; label: string }[]): void {
    const y = lines.length;
    this.actionTargets.set(y, actions.map(({ kind, label }) => {
      const start = text.indexOf(label) + 1; // border is column zero
      return { kind, start, end: start + label.length };
    }).filter(({ start, end }) => start > 0 && end <= inner + 1));
    lines.push(this.row(this.options.theme.fg("dim", text), inner));
  }

  private clickAction(event: PickerMouseEvent): boolean {
    const action = this.actionTargets.get(event.y)?.find(({ start, end }) => event.x >= start && event.x < end);
    if (!action) return false;
    switch (action.kind) {
      case "edit": this.openEditor(); break;
      case "apply": this.applyDraft(); break;
      case "reset": this.draft = {}; this.options.tui.requestRender(); break;
      case "back": this.back(); break;
    }
    return true;
  }

  private listControls(lines: string[], inner: number, compact: boolean): void {
    const text = this.controls(inner, compact);
    this.addAction(lines, inner, text, this.canEdit() ? [{ kind: "edit", label: inner < 22 ? "E" : "Edit effort" }] : []);
  }

  private renderEditor(width: number, inner: number, maxLines: number): string[] {
    const preset = this.options.presets[this.selected];
    if (!preset || isOffPreset(preset)) { this.back(); return this.renderCompact(width, inner, maxLines); }
    const { theme } = this.options;
    const selectedSlot = strengths[this.slotIndex]!;
    const caps = Object.fromEntries(strengths.map((slot) => [slot, this.caps(preset, slot)])) as Record<Strength, EffortCapabilities>;
    const errors = strengths.flatMap((slot) => {
      const issue = this.fixedIssue(preset, slot, caps[slot]);
      return issue ? [`${SLOT_LABEL[slot]}: ${issue}`] : [];
    });
    const warnings = strengths.flatMap((slot) => {
      const warning = this.inheritWarning(preset, slot, caps[slot]);
      return warning ? [`${SLOT_LABEL[slot]}: ${warning}`] : [];
    });
    const changed = strengths.some((slot) => this.draft[slot] !== preset.effort_overrides?.[slot]);
    const lines = [this.title(width, `Effort · ${preset.name}`)];
    if (maxLines >= 8) lines.push(this.row(theme.fg("muted", " New Agents only; main unchanged"), inner));
    if (maxLines >= 9) lines.push(this.row(theme.fg("dim", ` source: preset defaults + session overrides · ${changed ? "unsaved" : "unchanged"}`), inner));
    if (maxLines >= 10) lines.push(this.divider(width));
    for (const slot of strengths) {
      const selected = slot === selectedSlot;
      const value = this.draft[slot] === undefined ? "default" : this.draft[slot];
      const short = inner < 27;
      const label = short ? ({ light: "light", standard: "std", strong: "str" } as const)[slot] : SLOT_LABEL[slot];
      const problem = this.fixedIssue(preset, slot, caps[slot]) ?? this.inheritWarning(preset, slot, caps[slot]);
      const base = ` ${selected ? "›" : " "}‹${label}:${value}›${problem ? " !" : ""}`;
      const suffix = short ? "" : ` ${DIFFICULTY[slot]} · ${preset.models[slot]}`;
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
    if (maxLines >= 11) lines.push(this.row(theme.fg("dim", ` default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited} · model: ${preset.models[selectedSlot]}`), inner));
    const info = errors.length ? ` ! Cannot apply: ${errors.join("; ")}` : warnings.length
      ? ` Preview only; checked at spawn: ${warnings.join("; ")}`
      : ` ${changed ? "unsaved · " : ""}default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited}`;
    lines.push(this.row(theme.fg(errors.length || warnings.length ? "warning" : "muted", info), inner));
    const apply = preset.name === this.options.activeName ? "Apply" : "Apply & enable";
    const controls = inner < 23 ? " Apply R Esc" : ` ${apply} · R reset · Esc back · Alt+S close · ←→ adjust · ↑↓ slot`;
    this.addAction(lines, inner, controls, [
      { kind: "apply", label: inner < 23 ? "Apply" : apply },
      { kind: "reset", label: inner < 23 ? "R" : "R reset" },
      { kind: "back", label: inner < 23 ? "Esc" : "Esc back" },
    ]);
    lines.push(this.bottom(width));
    return lines;
  }

  private controls(inner: number, compact: boolean): string {
    if (this.options.delegation) {
      const edit = this.canEdit();
      if (inner >= 70) return ` ←→ mode · ⇧←→ eagerness · ↑↓ preset${edit ? " · Edit effort" : ""} · Enter · Esc`;
      if (inner >= 46) return ` ←→ mode · ⇧←→ eager · ↑↓${edit ? " · Edit effort" : ""} · ↵ · Esc`;
      if (inner >= 22) return edit ? " ←→ ⇧←→ ↑↓ E Edit effort ↵" : " ←→ ⇧←→ ↑↓ ↵ Esc";
    }
    if (inner < 22) return this.canEdit() ? "Alt+S E ↑↓↵ Esc" : " Alt+S ↑↓ ↵ Esc";
    if (inner < 46) return this.canEdit() ? " Alt+S ↑↓ E Edit effort ↵ Esc" : " Alt+S close · ↑↓ Enter Esc";
    if (this.canEdit()) return ` Alt+S close · E Edit effort · ↑↓ ${compact ? "choose" : "navigate"} · Enter apply · Esc`;
    return compact ? " Alt+S close · ↑↓ choose · Enter apply · Esc cancel" :
      " Alt+S close · ↑↓ navigate · Enter apply · Esc cancel";
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
