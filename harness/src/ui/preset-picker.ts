import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { OverlayRequest } from "./overlay-request.js";
import { isPopoverCloseClick, popoverBottom, popoverDivider, popoverRow, popoverTitle } from "./popover.js";
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
}

/** The pointer event as the picker reads it; a structural subset of pi-tui's. */
export interface PickerMouseEvent {
  type: string;
  button?: string;
  x: number;
  y: number;
  wheelDelta?: number;
}

const MIN_FULL_LINES = 11;
/** The compact layout: title, selected detail, controls, bottom edge. */
export const PRESET_PICKER_MIN_ROWS = 7;
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

  constructor(private readonly options: PresetPickerOptions) {
    const active = options.presets.findIndex((preset) => preset.name === options.activeName);
    this.selected = active < 0 ? 0 : active;
  }

  selection(): string | undefined { return this.options.presets[this.selected]?.name; }

  handleInput(data: string): void {
    if (this.closed) return;
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
  handleMouse(event: PickerMouseEvent): { handled: boolean } | undefined {
    if (this.closed || !this.options.pointer) return undefined;
    if (isPopoverCloseClick(event, this.paintedWidth)) {
      this.finish(null);
      return { handled: true };
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

  render(width: number): string[] {
    this.rowTargets.clear();
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
    return maxLines < MIN_FULL_LINES ? this.renderCompact(width, inner) : this.renderFull(width, inner, maxLines);
  }

  private finish(value: PresetChoice | null): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(value);
  }

  private renderFull(width: number, inner: number, maxLines: number): string[] {
    const { presets, activeName, theme } = this.options;
    this.visibleRows = Math.max(1, Math.min(presets.length, maxLines - 10));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.visibleRows / 2), presets.length - this.visibleRows));
    const end = Math.min(presets.length, start + this.visibleRows);
    const range = presets.length ? `${start + 1}–${end}/${presets.length}` : "0/0";
    const scope = inner >= 65 ? " New Agents only; main unchanged · * effort override" :
      " routing or off; main model unchanged";
    const lines = [this.title(width, "Worker routing"),
      this.row(this.twoSides(theme.fg("muted", scope),
        theme.fg("dim", range), inner), inner),
      this.divider(width)];
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

  private renderCompact(width: number, inner: number): string[] {
    this.visibleRows = 1;
    const { presets, theme } = this.options;
    const current = presets[this.selected];
    const position = current ? `${this.selected + 1}/${presets.length}` : "0/0";
    const lines = [this.title(width, "Worker routing")];
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
    this.slotIndex = 0;
    this.draft = { ...(selected.effort_overrides ?? {}) };
    this.options.tui.requestRender();
  }

  private back(): void {
    this.editing = false;
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
    if (!preset || isOffPreset(preset)) { this.back(); return this.renderCompact(width, inner); }
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
