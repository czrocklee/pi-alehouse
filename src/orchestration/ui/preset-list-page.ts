import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PersistentScope } from "../../shared/settings-store.mjs";
import { shortcutHint } from "../../shared/shortcut-hint.mjs";
import {
  isOffPreset,
  strengths,
  type PresetSelection,
  type PresetSnapshot,
  type Strength,
} from "../routing.ts";
import { usesEagerness, type DelegationMode } from "../delegation.ts";
import type { PresetPickerOptions } from "./preset-picker.ts";
import type { PresetDelegation } from "./preset-delegation.ts";
import { popoverChromeLayout } from "../../shared/popover-chrome.mjs";
import { popoverBottom, popoverDivider, popoverRow, popoverTitleRows } from "./popover.ts";

/** Detached UI order: numeric keys always retain canonical slot identity. */
export const workerSlotDisplayOrder: readonly Strength[] = Object.freeze([...strengths].reverse());
export const PRESET_PICKER_MIN_ROWS = 7;
/** Rows before the stack reveals the picker and before its waiting notice
 * clears: the paint floor plus the current title-chrome delta. The shared
 * layout owns the delta (0 with border labels on, 2 with them off); the hard
 * paint floor stays `PRESET_PICKER_MIN_ROWS` in every internal gate. */
export function presetPickerMinRows(): number {
  return PRESET_PICKER_MIN_ROWS + popoverChromeLayout({ framed: true }).top.rows - 1;
}
const MIN_FULL_LINES = strengths.length + 8;
const MODE_ROWS = 3;
const GUIDELINE_ROWS = 3;

export type PickerAction =
  "edit" | "reset" | "back" | "settings" | "create" | "editPreset" | "saveGlobal" | "saveWorkspace";
/** `label` is the exact plain text painted for the action; `at` is its plain
 * string offset when a caller composed the row itself. */
export type ActionLabel = { kind: PickerAction; label: string; at?: number };
/** One painted row segment: styled text plus the action it advertises. */
export type ActionPart = { text: string; action?: { kind: PickerAction; label: string } };
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
  closeHovered: boolean;
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

  /** Highlight one mnemonic inline when the label contains it; otherwise the
   * key stays an explicit prefix. An omitted key is click-only. `label` is the
   * painted plain text, which is what hit geometry must match. */
  hint(label: string, key?: string, color = "dim"): { text: string; label: string } {
    const text = shortcutHint(this.options.theme, label, key, { color });
    return { text, label: stripTerminalSequences(text) };
  }

  /** A key-only legend such as `Tab` or `↑↓`; the helper accents and bolds it
   * without inventing a label. */
  key(key: string, color = "dim"): { text: string; label: string } {
    return this.hint("", key, color);
  }

  /** Compose styled segments while recording each action's plain offset, so a
   * later clip can never turn a partial label into a click target. */
  compose(parts: ActionPart[]): { text: string; actions: ActionLabel[] } {
    let text = "",
      plain = "";
    const actions: ActionLabel[] = [];
    for (const part of parts) {
      if (part.action) actions.push({ ...part.action, at: plain.length });
      text += part.text;
      plain += stripTerminalSequences(part.text);
    }
    return { text, actions };
  }

  addAction(lines: string[], inner: number, text: string, actions: ActionLabel[]): void {
    // Only whole surviving labels may be hit, never a clipped edge label.
    const painted = truncateToWidth(text, inner, "…");
    const plain = stripTerminalSequences(painted);
    let cursor = 0;
    this.paint.actions.set(
      lines.length,
      actions
        .map(({ kind, label, at }) => {
          const index = at ?? plain.indexOf(label, cursor);
          if (index < 0 || plain.slice(index, index + label.length) !== label) return undefined;
          cursor = index + label.length;
          const start = 1 + visibleWidth(plain.slice(0, index));
          return { kind, start, end: start + visibleWidth(label) };
        })
        .filter(
          (range): range is { kind: PickerAction; start: number; end: number } =>
            range !== undefined && range.start > 0 && range.end <= inner + 1,
        ),
    );
    lines.push(this.row(painted, inner));
  }

  saveLabels(inner: number, reserve = 0): { text: string; actions: ActionLabel[] } | undefined {
    const workspace = this.state.canSave("workspace");
    const theme = this.options.theme;
    const variants = [
      {
        global: "Save as global default",
        workspace: workspace ? "Save as workspace default" : "Workspace default (trust required)",
        suffix: " (on exit)",
      },
      {
        global: "Global default",
        workspace: workspace ? "Workspace default" : "Workspace (trust required)",
        suffix: " (on exit)",
      },
      {
        global: "global",
        workspace: workspace ? "workspace" : "trust required",
        suffix: " · on exit",
      },
      { global: "global", workspace: workspace ? "workspace" : "trust", suffix: "" },
      { global: "G", workspace: workspace ? "W" : "trust", suffix: "", prefix: " " },
      ...(!workspace ? [{ global: "G", workspace: "", suffix: "", prefix: " " }] : []),
    ];
    for (const variant of variants) {
      const global = this.hint(variant.global, "G");
      // An untrusted workspace label is not a working save target, so it must
      // not advertise a key that the input handler would ignore.
      const ws = this.hint(variant.workspace, workspace ? "W" : undefined);
      const text =
        theme.fg("dim", variant.prefix ?? " Save: ") +
        global.text +
        (ws.text ? theme.fg("dim", " · ") + ws.text : "") +
        theme.fg("dim", variant.suffix);
      if (visibleWidth(text) + reserve > inner) continue;
      return {
        text,
        actions: [
          { kind: "saveGlobal", label: global.label },
          ...(workspace ? [{ kind: "saveWorkspace" as const, label: ws.label }] : []),
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

  /** Title chrome rows for the current border-label switch; row budgets
   * count the same paint they emit, so a live switch cannot overflow. */
  titleRows(width: number, title: string): string[] {
    return popoverTitleRows(
      this.options.theme,
      width,
      title,
      this.options.pointer,
      this.state.closeHovered,
    );
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
  // The border-label switch moves the title between one and three rows;
  // the full/compact gate and every row budget follow the same paint.
  const title = list.titleRows(width, "Delegation");
  const extra = title.length - 1;
  return compact || maxLines < MIN_FULL_LINES + modeRows + extra
    ? { lines: list.compact(width, width - 2, maxLines, title), visibleRows: 1 }
    : list.full(width, width - 2, maxLines, title);
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

  full(
    width: number,
    inner: number,
    maxLines: number,
    title: string[],
  ): { lines: string[]; visibleRows: number } {
    const { presets, activeName, theme } = this.options;
    const extra = title.length - 1;
    const modeRows = this.options.delegation ? MODE_ROWS : 0;
    const saveRows =
      this.state.canSave("global") && maxLines >= MIN_FULL_LINES + modeRows + extra + 1 ? 1 : 0;
    const summary = this.managementSummary();
    const summaryRows =
      summary !== undefined && maxLines >= MIN_FULL_LINES + modeRows + extra + saveRows + 1 ? 1 : 0;
    const guidelineRows = this.options.delegation
      ? Math.max(
          0,
          Math.min(
            GUIDELINE_ROWS,
            maxLines - MIN_FULL_LINES - extra - modeRows - saveRows - summaryRows,
          ),
        )
      : 0;
    const visibleRows = Math.max(
      1,
      Math.min(
        presets.length,
        maxLines - (MIN_FULL_LINES - 1) - extra - modeRows - guidelineRows - saveRows - summaryRows,
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
    const lines = [...title];
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

  compact(width: number, inner: number, maxLines: number, title: string[]): string[] {
    const { presets, theme } = this.options;
    const current = presets[this.state.selected];
    const position = current ? `${this.state.selected + 1}/${presets.length}` : "0/0";
    const lines = [...title];
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
      if (isOffPreset(current)) {
        // The Off notice is the one optional compact chrome: a labels-off
        // title can consume its rows on the smallest budgets.
        const notice = this.offNoticeRows(inner);
        if (lines.length + notice.length + 2 <= maxLines) lines.push(...notice);
      } else {
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

  private managementLabels(): {
    kind: PickerAction;
    key: string;
    text: string;
    label: string;
  }[] {
    const management = this.options.management;
    if (!management) return [];
    const labels: { kind: PickerAction; key: string; text: string; label: string }[] = [];
    if (management.settings)
      labels.push({ kind: "settings", key: "P", ...this.hint("Settings", "P") });
    if (management.presets) {
      labels.push({ kind: "create", key: "N", ...this.hint("New", "N") });
      if (this.state.canEditPreset)
        labels.push({ kind: "editPreset", key: "C", ...this.hint("Edit", "C") });
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
    const theme = this.options.theme;
    const dim = (text: string) => theme.fg("dim", text);
    const key = (value: string): ActionPart => ({ text: this.key(value).text });
    const legend = (label: string, value: string): ActionPart => ({
      text: this.hint(label, value).text,
    });
    if (!saveShown && this.state.canSave("global")) {
      if (compact && inner < 12) {
        const global = this.hint("G", "G"),
          workspace = this.hint("W", "W");
        const parts: ActionPart[] = [
          { text: global.text, action: { kind: "saveGlobal", label: global.label } },
          ...(this.state.canSave("workspace")
            ? [
                {
                  text: workspace.text,
                  action: { kind: "saveWorkspace" as const, label: workspace.label },
                },
              ]
            : []),
          { text: dim(" ") },
          key("Tab"),
        ];
        const composed = this.compose(parts);
        this.addAction(lines, inner, composed.text, composed.actions);
        return;
      }
      const edit = this.state.canEdit;
      const effort = this.effortHint(inner, compact);
      const effortPart = edit
        ? { text: effort.text, action: { kind: "edit" as const, label: effort.label } }
        : undefined;
      const tab = [{ text: dim(" · ") }, key("Tab")];
      const delegationHints = compact
        ? this.delegationHintParts().map((parts) => [
            ...tab,
            ...parts,
            ...(effortPart ? [{ text: dim(" · ") }, effortPart] : []),
          ])
        : [];
      // Reserve the shortest actual delegation variant, including the effort
      // label when present. Its width changes from `E` to `Edit effort`.
      const hintWidth = (parts: ActionPart[]): number =>
        visibleWidth(parts.map(({ text }) => text).join(""));
      const tabWidth = hintWidth(tab);
      const reserve = delegationHints.length
        ? Math.min(...delegationHints.map(hintWidth))
        : tabWidth;
      const saving =
        this.saveLabels(inner, compact ? reserve : 0) ??
        (compact && reserve > tabWidth ? this.saveLabels(inner, tabWidth) : undefined);
      if (saving) {
        const hints: ActionPart[][] = compact
          ? [
              ...delegationHints,
              ...(edit
                ? [
                    [
                      { text: dim(" · ") },
                      legend("slots", "Tab"),
                      { text: dim(" · ") },
                      effortPart!,
                      { text: dim(" · ") },
                      key("↑↓"),
                      key("↵"),
                      { text: dim(" ") },
                      key("Esc"),
                    ],
                    [
                      { text: dim(" · ") },
                      key("Tab"),
                      { text: dim(" · ") },
                      effortPart!,
                      { text: dim(" ") },
                      key("↑↓"),
                      key("↵"),
                      { text: dim(" ") },
                      key("Esc"),
                    ],
                    [...tab, { text: dim(" · ") }, effortPart!],
                    tab,
                  ]
                : [
                    [
                      { text: dim(" · ") },
                      legend("slots", "Tab"),
                      { text: dim(" · ") },
                      key("↑↓"),
                      key("↵"),
                      { text: dim(" ") },
                      key("Esc"),
                    ],
                    [
                      { text: dim(" · ") },
                      key("Tab"),
                      { text: dim(" · ") },
                      key("↵"),
                      { text: dim(" ") },
                      key("Esc"),
                    ],
                    tab,
                  ]),
            ]
          : edit
            ? [
                [
                  { text: dim(" · ") },
                  effortPart!,
                  { text: dim(" · ") },
                  key("↑↓"),
                  key("↵"),
                  { text: dim(" ") },
                  key("Esc"),
                ],
                [
                  { text: dim(" · ") },
                  effortPart!,
                  { text: dim(" ") },
                  key("↑↓"),
                  key("↵"),
                  { text: dim(" ") },
                  key("Esc"),
                ],
                [{ text: dim(" · ") }, effortPart!],
              ]
            : [
                [{ text: dim(" · ") }, key("↑↓"), key("↵"), { text: dim(" ") }, key("Esc")],
                [{ text: dim(" · ") }, key("↵"), { text: dim(" ") }, key("Esc")],
              ];
        for (const hintParts of hints) {
          const composed = this.compose([{ text: saving.text }, ...hintParts]);
          if (visibleWidth(composed.text) <= inner) {
            this.addAction(lines, inner, composed.text, [...saving.actions, ...composed.actions]);
            return;
          }
        }
        this.addAction(lines, inner, saving.text, saving.actions);
        return;
      }
    }
    const labels = this.managementLabels();
    const parts = this.controlText(inner, compact);
    if (compact) {
      const hintParts = this.delegationHintParts().find(
        (each) => visibleWidth(this.compose([...parts, ...each]).text) <= inner,
      );
      if (hintParts) parts.push(...hintParts);
    }
    if (labels.length) {
      const fullParts: ActionPart[] = [];
      for (const entry of labels)
        fullParts.push(
          { text: dim(" · ") },
          { text: entry.text, action: { kind: entry.kind, label: entry.label } },
        );
      if (visibleWidth(this.compose([...parts, ...fullParts]).text) <= inner) {
        parts.push(...fullParts);
      } else {
        const minParts: ActionPart[] = [{ text: dim(" · ") }];
        labels.forEach((entry, index) => {
          if (index) minParts.push({ text: dim(" ") });
          const keyOnly = this.key(entry.key);
          minParts.push({ text: keyOnly.text, action: { kind: entry.kind, label: entry.key } });
        });
        if (visibleWidth(this.compose([...parts, ...minParts]).text) <= inner)
          parts.push(...minParts);
      }
    }
    if (this.state.canPickModels) {
      const modelHints: ActionPart[][] = [
        [{ text: dim(" · ") }, { text: this.hint("model", "1/2/3/4/5").text }],
        [{ text: dim(" · ") }, { text: this.key("12345").text }],
      ];
      for (const hintParts of modelHints)
        if (visibleWidth(this.compose([...parts, ...hintParts]).text) <= inner) {
          parts.push(...hintParts);
          break;
        }
    }
    const composed = this.compose(parts);
    this.addAction(lines, inner, composed.text, composed.actions);
  }

  private effortLabel(inner: number, compact: boolean): string {
    return inner < (compact ? 46 : 22) ? "E" : "Edit effort";
  }
  private effortHint(inner: number, compact: boolean): { text: string; label: string } {
    return this.hint(this.effortLabel(inner, compact), "E");
  }
  private delegationHintParts(): ActionPart[][] {
    const dim = (text: string) => this.options.theme.fg("dim", text);
    if (!this.options.delegation) return [];
    const mode = this.hint("mode", "←→");
    if (!usesEagerness(this.options.delegation.current().mode))
      return [
        [{ text: dim(" · ") }, { text: mode.text }],
        [{ text: dim(" · ") }, { text: this.key("←→").text }],
      ];
    return [
      [
        { text: dim(" · ") },
        { text: mode.text },
        { text: dim(" · ") },
        { text: this.hint("eagerness", "⇧←→").text },
      ],
      [
        { text: dim(" · ") },
        { text: mode.text },
        { text: dim(" · ") },
        { text: this.hint("eager", "⇧←→").text },
      ],
      [
        { text: dim(" · ") },
        { text: this.key("←→").text },
        { text: dim(" ") },
        { text: this.key("⇧←→").text },
      ],
    ];
  }
  private controlText(inner: number, compact: boolean): ActionPart[] {
    const dim = (text: string) => this.options.theme.fg("dim", text);
    const key = (value: string): ActionPart => ({ text: this.key(value).text });
    const legend = (label: string, value: string): ActionPart => ({
      text: this.hint(label, value).text,
    });
    const effort = this.effortHint(inner, compact),
      edit = this.state.canEdit;
    const effortPart = edit
      ? { text: effort.text, action: { kind: "edit" as const, label: effort.label } }
      : undefined;
    if (compact) {
      if (inner < 12) return [{ text: dim(" ") }, key("Tab"), key("↑↓")];
      if (inner < 22)
        return [
          { text: dim(" ") },
          key("Alt+S"),
          { text: dim(" ") },
          key("Tab"),
          { text: dim(" ") },
          key("↑↓"),
          ...(effortPart ? [{ text: dim(" ") }, effortPart] : []),
          key("↵"),
        ];
      if (inner < 46)
        return [
          { text: dim(" ") },
          key("Alt+S"),
          { text: dim(" · ") },
          legend("slots", "Tab"),
          { text: dim(" · ") },
          key("↑↓"),
          ...(effortPart ? [{ text: dim(" ") }, effortPart] : []),
          { text: dim(" ") },
          key("↵"),
          { text: dim(" ") },
          key("Esc"),
        ];
      return [
        { text: dim(" ") },
        key("Alt+S"),
        { text: dim(" · ") },
        legend("slots", "Tab"),
        { text: dim(" · ") },
        key("↑↓"),
        { text: dim(" preset") },
        ...(effortPart ? [{ text: dim(" · ") }, effortPart] : []),
        { text: dim(" · ") },
        key("Enter"),
        { text: dim(" ") },
        key("Esc"),
      ];
    }
    if (this.options.delegation) {
      const eager = usesEagerness(this.options.delegation.current().mode);
      if (inner >= 70)
        return [
          { text: dim(" ") },
          legend("mode", "←→"),
          ...(eager ? [{ text: dim(" · ") }, legend("eagerness", "⇧←→")] : []),
          { text: dim(" · ") },
          key("↑↓"),
          { text: dim(" preset") },
          ...(effortPart ? [{ text: dim(" · ") }, effortPart] : []),
          { text: dim(" · ") },
          key("Enter"),
          { text: dim(" · ") },
          key("Esc"),
        ];
      if (inner >= 46)
        return [
          { text: dim(" ") },
          legend("mode", "←→"),
          ...(eager ? [{ text: dim(" · ") }, legend("eager", "⇧←→")] : []),
          { text: dim(" · ") },
          key("↑↓"),
          ...(effortPart ? [{ text: dim(" · ") }, effortPart] : []),
          { text: dim(" · ") },
          key("↵"),
          { text: dim(" · ") },
          key("Esc"),
        ];
      if (inner >= 22)
        return edit
          ? [
              { text: dim(" ") },
              key("←→"),
              ...(eager ? [{ text: dim(" ") }, key("⇧←→")] : []),
              { text: dim(" ") },
              key("↑↓"),
              { text: dim(" ") },
              effortPart!,
              { text: dim(" ") },
              key("↵"),
            ]
          : [
              { text: dim(" ") },
              key("←→"),
              ...(eager ? [{ text: dim(" ") }, key("⇧←→")] : []),
              { text: dim(" ") },
              key("↑↓"),
              { text: dim(" ") },
              key("↵"),
              { text: dim(" ") },
              key("Esc"),
            ];
    }
    if (inner < 22)
      return edit
        ? [
            key("Alt+S"),
            { text: dim(" ") },
            effortPart!,
            { text: dim(" ") },
            key("↑↓"),
            key("↵"),
            { text: dim(" ") },
            key("Esc"),
          ]
        : [
            { text: dim(" ") },
            key("Alt+S"),
            { text: dim(" ") },
            key("↑↓"),
            { text: dim(" ") },
            key("↵"),
            { text: dim(" ") },
            key("Esc"),
          ];
    if (inner < 46)
      return edit
        ? [
            { text: dim(" ") },
            key("Alt+S"),
            { text: dim(" ") },
            key("↑↓"),
            { text: dim(" ") },
            effortPart!,
            { text: dim(" ") },
            key("↵"),
            { text: dim(" ") },
            key("Esc"),
          ]
        : [
            { text: dim(" ") },
            legend("close", "Alt+S"),
            { text: dim(" · ") },
            key("↑↓"),
            { text: dim(" ") },
            key("Enter"),
            { text: dim(" ") },
            key("Esc"),
          ];
    return edit
      ? [
          { text: dim(" ") },
          legend("close", "Alt+S"),
          { text: dim(" · ") },
          effortPart!,
          { text: dim(" · ") },
          legend("navigate", "↑↓"),
          { text: dim(" · ") },
          legend("apply", "Enter"),
          { text: dim(" · ") },
          key("Esc"),
        ]
      : [
          { text: dim(" ") },
          legend("close", "Alt+S"),
          { text: dim(" · ") },
          legend("navigate", "↑↓"),
          { text: dim(" · ") },
          legend("apply", "Enter"),
          { text: dim(" · ") },
          legend("cancel", "Esc"),
        ];
  }
}
