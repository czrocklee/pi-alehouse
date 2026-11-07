import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PersistentScope } from "../../shared/settings-store.mjs";
import {
  isOffPreset,
  strengths,
  type PresetSelection,
  type PresetSnapshot,
  type Strength,
} from "../routing.ts";
import type { DelegationMode } from "../delegation.ts";
import type { PresetPickerOptions } from "./preset-picker.ts";
import type { PresetDelegation } from "./preset-delegation.ts";
import { popoverBottom, popoverDivider, popoverRow, popoverTitle } from "./popover.ts";

/** Detached UI order: numeric keys always retain canonical slot identity. */
export const workerSlotDisplayOrder: readonly Strength[] = Object.freeze([...strengths].reverse());
export const PRESET_PICKER_MIN_ROWS = 7;
const MIN_FULL_LINES = strengths.length + 8;
const MODE_ROWS = 3;
const GUIDELINE_ROWS = 3;

export type PickerAction =
  "edit" | "reset" | "back" | "settings" | "create" | "editPreset" | "saveGlobal" | "saveWorkspace";
export type ActionLabel = { kind: PickerAction; label: string };
export type ModeTarget = { mode: DelegationMode; start: number; end: number };
export type StepTarget = { kind: "mode" | "eagerness"; direction: -1 | 1; x: number };

/** One paint only. Helpers populate this detached map; only PresetPicker
 * publishes it, including an empty map when no usable page can be painted. */
export function pickerPaint() {
  return {
    rows: new Map<number, number>(),
    modes: new Map<number, ModeTarget[]>(),
    steps: new Map<number, StepTarget[]>(),
    slots: new Map<number, { slot: Strength; prev?: number; next?: number }>(),
    actions: new Map<number, { kind: PickerAction; start: number; end: number }[]>(),
    models: new Map<number, { preset: string; slot: Strength; start: number; end: number }[]>(),
  };
}
export type PickerPaint = ReturnType<typeof pickerPaint>;
/** Published while a paint is in progress. Never written: render-time pages
 * fill only their own fresh pickerPaint(). */
export const EMPTY_PAINT: PickerPaint = pickerPaint();

export interface PresetPageState {
  selected: number;
  slotIndex: number;
  canEdit: boolean;
  canEditPreset: boolean;
  canPickModels: boolean;
  canSave(scope: PersistentScope): boolean;
  effort(preset: PresetSnapshot, slot: Strength): string;
}

/** Per-paint presentation helpers, not a Component or a second input owner.
 * No lifecycle, publication or settings mutations belong here. */
export class PresetPage {
  constructor(
    readonly options: PresetPickerOptions,
    readonly state: PresetPageState,
    readonly paint: PickerPaint,
  ) {}

  slotWindow(count: number): readonly Strength[] {
    const size = Math.max(1, Math.min(strengths.length, count));
    const start = Math.max(
      0,
      Math.min(this.state.slotIndex - Math.floor(size / 2), strengths.length - size),
    );
    return workerSlotDisplayOrder.slice(start, start + size);
  }

  addAction(lines: string[], inner: number, text: string, actions: ActionLabel[]): void {
    // Only whole surviving labels may be hit, never a clipped edge label.
    const painted = truncateToWidth(text, inner, "…");
    this.paint.actions.set(
      lines.length,
      actions
        .map(({ kind, label }) => {
          const start = painted.indexOf(label) + 1;
          return { kind, start, end: start + label.length };
        })
        .filter(({ start, end }) => start > 0 && end <= inner + 1),
    );
    lines.push(this.row(this.options.theme.fg("dim", text), inner));
  }

  saveLabels(inner: number, reserve = 0): { text: string; actions: ActionLabel[] } | undefined {
    const workspace = this.state.canSave("workspace");
    const variants = [
      {
        global: "[G] Save as global default",
        workspace: workspace
          ? "[W] Save as project default"
          : "[W] Project default (trust required)",
        suffix: " (on exit)",
      },
      {
        global: "[G] Global default",
        workspace: workspace ? "[W] Project default" : "[W] Project (trust required)",
        suffix: " (on exit)",
      },
      {
        global: "G global",
        workspace: workspace ? "W project" : "W trust required",
        suffix: " · on exit",
      },
      { global: "G global", workspace: workspace ? "W project" : "W trust", suffix: "" },
      { global: "G", workspace: workspace ? "W" : "W trust", suffix: "", prefix: " " },
      { global: "G", workspace: "W", suffix: "", prefix: " " },
    ];
    for (const variant of variants) {
      const text = `${variant.prefix ?? " Save: "}${variant.global} · ${variant.workspace}${variant.suffix}`;
      if (visibleWidth(text) + reserve > inner) continue;
      return {
        text,
        actions: [
          { kind: "saveGlobal", label: variant.global },
          ...(workspace ? [{ kind: "saveWorkspace" as const, label: variant.workspace }] : []),
        ],
      };
    }
    return undefined;
  }

  saveControls(lines: string[], inner: number): boolean {
    const saving = this.saveLabels(inner);
    if (!saving) return false;
    this.addAction(lines, inner, saving.text, saving.actions);
    return true;
  }

  title(width: number, title: string): string {
    return popoverTitle(this.options.theme, width, title, this.options.pointer);
  }
  divider(width: number): string {
    return popoverDivider(this.options.theme, width);
  }
  bottom(width: number): string {
    return popoverBottom(this.options.theme, width);
  }
  row(content: string, inner: number): string {
    return popoverRow(this.options.theme, content, inner);
  }
}

export function twoSides(left: string, right: string, width: number): string {
  const room = Math.max(1, width - visibleWidth(right) - 1);
  const fittedLeft = truncateToWidth(left, room, "…");
  return (
    fittedLeft +
    " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right))) +
    right
  );
}

const marked = (preset: PresetSnapshot): boolean =>
  Object.keys(preset.effort_overrides ?? {}).length > 0;
const version = (preset: PresetSelection): string => (isOffPreset(preset) ? "" : preset.version);

/** Full/compact list pages are detached projections of one picker state. */
export function renderPresetList(
  page: PresetPage,
  width: number,
  maxLines: number,
  delegation: PresetDelegation,
  compact = false,
): { lines: string[]; visibleRows: number } {
  const list = new PresetListPage(page.options, page.state, page.paint, delegation);
  const modeRows = page.options.delegation ? MODE_ROWS : 0;
  return compact || maxLines < MIN_FULL_LINES + modeRows
    ? { lines: list.compact(width, width - 2, maxLines), visibleRows: 1 }
    : list.full(width, width - 2, maxLines);
}

class PresetListPage extends PresetPage {
  constructor(
    options: PresetPickerOptions,
    state: PresetPageState,
    paint: PickerPaint,
    private readonly delegation: PresetDelegation,
  ) {
    super(options, state, paint);
  }

  full(width: number, inner: number, maxLines: number): { lines: string[]; visibleRows: number } {
    const { presets, activeName, theme } = this.options;
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    const saveRows =
      this.state.canSave("global") && maxLines >= MIN_FULL_LINES + modeRows + 1 ? 1 : 0;
    const summary = this.managementSummary();
    const summaryRows =
      summary !== undefined && maxLines >= MIN_FULL_LINES + modeRows + saveRows + 1 ? 1 : 0;
    const guidelineRows = this.options.delegation
      ? Math.max(
          0,
          Math.min(GUIDELINE_ROWS, maxLines - MIN_FULL_LINES - modeRows - saveRows - summaryRows),
        )
      : 0;
    const visibleRows = Math.max(
      1,
      Math.min(
        presets.length,
        maxLines - (MIN_FULL_LINES - 1) - modeRows - guidelineRows - saveRows - summaryRows,
      ),
    );
    const start = Math.max(
      0,
      Math.min(this.state.selected - Math.floor(visibleRows / 2), presets.length - visibleRows),
    );
    const end = Math.min(presets.length, start + visibleRows);
    const range = presets.length ? `${start + 1}–${end}/${presets.length}` : "0/0";
    const scope =
      [
        " Model preset · new Agents only; main unchanged · * effort",
        " Model preset · new Agents only",
        " Model preset",
      ].find((text) => visibleWidth(text) + visibleWidth(range) + 1 <= inner) ?? " Model preset";
    const lines = [this.title(width, "Delegation")];
    if (this.options.delegation) this.delegation.section(this, lines, width, inner, guidelineRows);
    lines.push(this.row(twoSides(theme.fg("muted", scope), theme.fg("dim", range), inner), inner));
    if (summaryRows) lines.push(this.row(theme.fg("dim", ` ${summary}`), inner));
    lines.push(this.divider(width));
    for (let index = start; index < end; index++) {
      const preset = presets[index]!;
      const selected = index === this.state.selected;
      const marker = selected ? theme.fg("accent", "›") : " ";
      const live = preset.name === activeName ? theme.fg("success", "●") : theme.fg("dim", "○");
      const label = isOffPreset(preset) ? preset.name : preset.name + (marked(preset) ? "*" : "");
      const left = `${marker} ${live} ${selected ? theme.bold(label) : label}`;
      const content = twoSides(left, theme.fg("dim", version(preset)), inner);
      this.paint.rows.set(lines.length, index);
      lines.push(this.row(selected ? theme.bg("selectedBg", content) : content, inner));
    }
    lines.push(this.divider(width));
    lines.push(...this.detailRows(inner, lines.length));
    const saveShown = saveRows > 0 && this.saveControls(lines, inner);
    this.controls(lines, inner, false, saveShown);
    lines.push(this.bottom(width));
    return { lines, visibleRows };
  }

  compact(width: number, inner: number, maxLines: number): string[] {
    const { presets, theme } = this.options;
    const current = presets[this.state.selected];
    const position = current ? `${this.state.selected + 1}/${presets.length}` : "0/0";
    const lines = [this.title(width, "Delegation")];
    if (this.options.delegation && maxLines > PRESET_PICKER_MIN_ROWS)
      lines.push(this.delegation.compactRow(this, lines.length, inner, true));
    if (!current) lines.push(this.row(theme.fg("warning", " No presets available"), inner));
    else {
      const badge =
        current.name === this.options.activeName
          ? theme.fg("success", " ● active")
          : theme.fg("muted", " ○ inactive");
      this.paint.rows.set(lines.length, this.state.selected);
      const label = current.name + (!isOffPreset(current) && marked(current) ? "*" : "");
      lines.push(
        this.row(
          twoSides(
            ` › ${theme.bold(label)}${badge}`,
            theme.fg("dim", [version(current), position].filter(Boolean).join(" · ")),
            inner,
          ),
          inner,
        ),
      );
      if (isOffPreset(current)) lines.push(...this.offNoticeRows(inner));
      else {
        const slots = this.slotWindow(maxLines - lines.length - 2);
        for (const slot of slots)
          lines.push(
            this.slotRow(
              current,
              slot,
              inner,
              lines.length,
              slots.length < strengths.length &&
                slot === workerSlotDisplayOrder[this.state.slotIndex],
            ),
          );
      }
    }
    const saveShown =
      this.state.canSave("global") &&
      lines.length + 3 <= maxLines &&
      this.saveControls(lines, inner);
    const summary = this.managementSummary();
    if (summary !== undefined && lines.length + 3 <= maxLines)
      lines.push(this.row(theme.fg("dim", ` ${summary}`), inner));
    this.controls(lines, inner, true, saveShown);
    lines.push(this.bottom(width));
    return lines;
  }

  private detailRows(inner: number, offset: number): string[] {
    const { presets, activeName, theme } = this.options;
    const current = presets[this.state.selected];
    if (!current) return [this.row(theme.fg("warning", " No presets available"), inner)];
    const badge =
      current.name === activeName
        ? theme.fg("success", "● active")
        : theme.fg("muted", "○ inactive");
    const label = current.name + (!isOffPreset(current) && marked(current) ? "*" : "");
    const heading = twoSides(
      ` ${theme.bold(label)}  ${badge}`,
      theme.fg("dim", version(current)),
      inner,
    );
    if (isOffPreset(current)) return [this.row(heading, inner), ...this.offNoticeRows(inner)];
    const rows = [this.row(heading, inner)];
    for (const slot of workerSlotDisplayOrder)
      rows.push(this.slotRow(current, slot, inner, offset + rows.length));
    return rows;
  }

  private offNoticeRows(inner: number): string[] {
    const { theme } = this.options;
    return [
      this.row(theme.fg("warning", " No new, resumed, or steered work."), inner),
      this.row(theme.fg("muted", " Accepted work continues."), inner),
    ];
  }

  private slotRow(
    preset: PresetSnapshot,
    slot: Strength,
    inner: number,
    y: number,
    selected = false,
  ): string {
    const { theme } = this.options;
    const label = slot.padEnd(8),
      model = preset.models[slot];
    const effort = this.state.effort(preset, slot);
    if (inner < 26)
      return this.row(`${selected ? "›" : " "}${slot}:${theme.fg("dim", effort)}`, inner);
    const left = `${selected ? "›" : " "}${theme.fg(selected ? "accent" : "muted", label)} ${model}`;
    const right = theme.fg("dim", effort);
    const row = this.row(twoSides(left, right, inner), inner);
    if (this.options.management?.models) {
      // Measure the fitted terminal columns, not UTF-16 length: a dropped
      // wide character leaves padding that must not become a model target.
      const room = Math.max(1, inner - visibleWidth(right) - 1);
      const start = visibleWidth(` ${label} `) + 1;
      const truncated = visibleWidth(left) > room;
      const fitted = truncated
        ? visibleWidth(truncateToWidth(left, room, "…"))
        : visibleWidth(left);
      const painted = truncated ? fitted - (start - 1) - 1 : visibleWidth(model);
      if (painted > 0 && start + painted <= inner + 1)
        this.paint.models.set(y, [{ preset: preset.name, slot, start, end: start + painted }]);
    }
    return row;
  }

  private managementLabels(): ActionLabel[] {
    const management = this.options.management;
    if (!management) return [];
    const labels: ActionLabel[] = [];
    if (management.settings) labels.push({ kind: "settings", label: "P Settings" });
    if (management.presets) {
      labels.push({ kind: "create", label: "N New" });
      if (this.state.canEditPreset) labels.push({ kind: "editPreset", label: "C Edit" });
    }
    return labels;
  }

  private managementSummary(): string | undefined {
    try {
      const summary = this.options.management?.summary?.();
      return typeof summary === "string" && summary.trim() ? summary : undefined;
    } catch {
      return undefined;
    }
  }

  private controls(lines: string[], inner: number, compact: boolean, saveShown: boolean): void {
    if (!saveShown && this.state.canSave("global")) {
      if (compact && inner < 12) {
        this.addAction(lines, inner, "GW Tab", [
          { kind: "saveGlobal", label: "G" },
          ...(this.state.canSave("workspace")
            ? [{ kind: "saveWorkspace" as const, label: "W" }]
            : []),
        ]);
        return;
      }
      const edit = this.state.canEdit;
      const minimumHint =
        compact && this.options.delegation ? ` · Tab · ←→ ⇧←→${edit ? " · E" : ""}` : " · Tab";
      const saving =
        this.saveLabels(inner, compact ? visibleWidth(minimumHint) : 0) ??
        this.saveLabels(inner, compact ? visibleWidth(" · Tab") : 0);
      if (saving) {
        let text = saving.text;
        const hints = compact
          ? [
              ...this.delegationHints().map((hint) => ` · Tab${hint}${edit ? " · E" : ""}`),
              ...(edit
                ? [
                    " · Tab slots · E effort · ↑↓↵ Esc",
                    " · Tab · E ↑↓↵ Esc",
                    " · Tab · E",
                    " · Tab",
                  ]
                : [" · Tab slots · ↑↓↵ Esc", " · Tab · ↵ Esc", " · Tab"]),
            ]
          : edit
            ? [" · E effort · ↑↓↵ Esc", " · E ↑↓↵ Esc", " · E"]
            : [" · ↑↓↵ Esc", " · ↵ Esc"];
        const hint = hints.find((each) => visibleWidth(text) + visibleWidth(each) <= inner);
        if (hint) text += hint;
        this.addAction(lines, inner, text, [
          ...saving.actions,
          ...(edit && hint?.includes(" · E") ? [{ kind: "edit" as const, label: "E" }] : []),
        ]);
        return;
      }
    }
    const labels = this.managementLabels();
    let text = this.controlText(inner, compact);
    if (compact) {
      const hint = this.delegationHints().find(
        (each) => visibleWidth(text) + visibleWidth(each) <= inner,
      );
      if (hint) text += hint;
    }
    if (labels.length) {
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
    if (this.state.canPickModels) {
      for (const hint of [" · 1/2/3/4/5 model", " · 12345"])
        if (visibleWidth(text) + visibleWidth(hint) <= inner) {
          text += hint;
          break;
        }
    }
    this.addAction(lines, inner, text, [
      ...(this.state.canEdit
        ? [{ kind: "edit" as const, label: this.effortLabel(inner, compact) }]
        : []),
      ...labels,
    ]);
  }

  private effortLabel(inner: number, compact: boolean): string {
    return inner < (compact ? 46 : 22) ? "E" : "Edit effort";
  }
  private delegationHints(): readonly string[] {
    return this.options.delegation
      ? [" · ←→ mode · ⇧←→ eagerness", " · ←→ mode · ⇧←→ eager", " · ←→ ⇧←→"]
      : [];
  }
  private controlText(inner: number, compact: boolean): string {
    const effortLabel = this.effortLabel(inner, compact),
      edit = this.state.canEdit;
    if (compact) {
      if (inner < 12) return " Tab↑↓";
      if (inner < 22) return ` Alt+S Tab ↑↓${edit ? ` ${effortLabel}` : ""}↵`;
      if (inner < 46) return ` Alt+S · Tab slots · ↑↓${edit ? ` ${effortLabel}` : ""} ↵ Esc`;
      return ` Alt+S · Tab slots · ↑↓ preset${edit ? ` · E ${effortLabel}` : ""} · Enter Esc`;
    }
    if (this.options.delegation) {
      if (inner >= 70)
        return ` ←→ mode · ⇧←→ eagerness · ↑↓ preset${edit ? " · Edit effort" : ""} · Enter · Esc`;
      if (inner >= 46) return ` ←→ mode · ⇧←→ eager · ↑↓${edit ? " · Edit effort" : ""} · ↵ · Esc`;
      if (inner >= 22) return edit ? " ←→ ⇧←→ ↑↓ E Edit effort ↵" : " ←→ ⇧←→ ↑↓ ↵ Esc";
    }
    if (inner < 22) return edit ? "Alt+S E ↑↓↵ Esc" : " Alt+S ↑↓ ↵ Esc";
    if (inner < 46) return edit ? " Alt+S ↑↓ E Edit effort ↵ Esc" : " Alt+S close · ↑↓ Enter Esc";
    return edit
      ? " Alt+S close · E Edit effort · ↑↓ navigate · Enter apply · Esc"
      : " Alt+S close · ↑↓ navigate · Enter apply · Esc cancel";
  }
}
