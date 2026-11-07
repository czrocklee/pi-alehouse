import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  isOffPreset,
  strengths,
  thinkingLevels,
  type Effort,
  type EffortCapabilities,
  type EffortOverrides,
  type PresetSelection,
  type PresetSnapshot,
  type Strength,
  type ThinkingLevel,
} from "../routing.ts";
import type { PresetPickerOptions } from "./preset-picker.ts";
import { workerSlotDisplayOrder, type PresetPage } from "./preset-list-page.ts";

const defaultEffort = (preset: PresetSnapshot, slot: Strength): Effort =>
  preset.effort_defaults?.[slot] ?? "inherit";

/** Effort proposals and their presentation. No draft is authoritative: only
 * the host's returned committed snapshot replaces what the picker paints. */
export class PresetEffortEditor {
  private error: string | undefined;

  constructor(
    private readonly options: PresetPickerOptions,
    private readonly current: () => PresetSelection | undefined,
    private readonly editable: () => boolean,
    private readonly committed: (selection: PresetSelection) => void,
  ) {}

  clear(): void {
    this.error = undefined;
  }

  label(preset: PresetSnapshot, slot: Strength): string {
    const policy =
      preset.effort?.[slot] ?? preset.effort_overrides?.[slot] ?? defaultEffort(preset, slot);
    const star = preset.effort_overrides?.[slot] !== undefined ? "*" : "";
    if (!this.options.efforts) return policy + star;
    const caps = this.caps(preset, slot),
      supported = this.levels(caps);
    if (policy === "inherit") {
      const inherited = caps.inherited;
      return inherited !== undefined && supported.includes(inherited)
        ? inherited + star
        : `unavailable${star}`;
    }
    return policy + (supported.includes(policy) ? "" : "!") + star;
  }

  private caps(preset: PresetSnapshot, slot: Strength): EffortCapabilities {
    try {
      return (
        this.options.efforts?.(preset, slot) ?? {
          levels: [],
          error: "Effort capabilities unavailable",
        }
      );
    } catch (error) {
      return { levels: [], error: String(error) };
    }
  }
  private levels(caps: EffortCapabilities): ThinkingLevel[] {
    return thinkingLevels.filter((level) => caps.levels.includes(level));
  }
  private fixedIssue(
    preset: PresetSnapshot,
    slot: Strength,
    caps: EffortCapabilities,
    overrides: EffortOverrides = preset.effort_overrides ?? {},
  ): string | undefined {
    const value = overrides[slot] ?? defaultEffort(preset, slot);
    if (value === "inherit") return undefined;
    if (caps.error) return caps.error;
    return this.levels(caps).includes(value) ? undefined : `Unsupported effort: ${value}`;
  }
  private inheritWarning(
    preset: PresetSnapshot,
    slot: Strength,
    caps: EffortCapabilities,
  ): string | undefined {
    if ((preset.effort_overrides?.[slot] ?? defaultEffort(preset, slot)) !== "inherit")
      return undefined;
    return (
      caps.error ??
      caps.inheritError ??
      (!caps.inherited || !this.levels(caps).includes(caps.inherited)
        ? "Inherited effort unavailable"
        : undefined)
    );
  }

  step(slot: Strength, direction: -1 | 1): void {
    const preset = this.current();
    if (!preset || isOffPreset(preset) || !this.editable()) return;
    const values: (Effort | "default")[] = [
      "default",
      "inherit",
      ...this.levels(this.caps(preset, slot)),
    ];
    const current = preset.effort_overrides?.[slot] ?? "default",
      index = values.indexOf(current);
    // An obsolete policy starts at explicit default, never a silently clamped level.
    const next =
      values[
        Math.max(
          0,
          Math.min(values.length - 1, (index < 0 ? 0 : index) + (index < 0 ? 0 : direction)),
        )
      ];
    const overrides = { ...preset.effort_overrides };
    if (next === "default") delete overrides[slot];
    else overrides[slot] = next;
    this.set(overrides);
  }

  set(overrides: EffortOverrides): void {
    const preset = this.current();
    if (!preset || isOffPreset(preset) || !this.options.setEffort || !this.editable()) return;
    if (strengths.every((slot) => overrides[slot] === preset.effort_overrides?.[slot])) return;
    const issues = strengths.flatMap((slot) => {
      const issue = this.fixedIssue(preset, slot, this.caps(preset, slot), overrides);
      return issue ? [`${slot}: ${issue}`] : [];
    });
    this.error = issues.length ? `Change not applied: ${issues.join("; ")}` : undefined;
    if (!issues.length) {
      try {
        const applied = this.options.setEffort(preset.name, { ...overrides });
        if (applied && !isOffPreset(applied) && applied.name === preset.name)
          this.committed(applied);
        else this.error = "Change not applied; previous settings kept.";
      } catch {
        this.error = "Change not applied; previous settings kept.";
      }
    }
    this.options.tui.requestRender();
  }

  render(page: PresetPage, preset: PresetSnapshot, width: number, maxLines: number): string[] {
    const inner = width - 2,
      { theme } = this.options;
    const selectedSlot = workerSlotDisplayOrder[page.state.slotIndex]!;
    const caps = Object.fromEntries(
      strengths.map((slot) => [slot, this.caps(preset, slot)]),
    ) as Record<Strength, EffortCapabilities>;
    const errors = strengths.flatMap((slot) => {
      const issue = this.fixedIssue(preset, slot, caps[slot]);
      return issue ? [`${slot}: ${issue}`] : [];
    });
    const warnings = strengths.flatMap((slot) => {
      const warning = this.inheritWarning(preset, slot, caps[slot]);
      return warning ? [`${slot}: ${warning}`] : [];
    });
    const baseRows = strengths.length + 4;
    const saveRows = page.state.canSave("global") && maxLines >= baseRows + 1 ? 1 : 0;
    const lines = [page.title(width, `Effort · ${preset.name}`)];
    if (maxLines >= baseRows + 1 + saveRows)
      lines.push(page.row(theme.fg("muted", " New Agents only; main unchanged"), inner));
    if (maxLines >= baseRows + 2 + saveRows)
      lines.push(
        page.row(
          theme.fg(
            "dim",
            " source: preset defaults + session overrides · changes apply immediately",
          ),
          inner,
        ),
      );
    if (maxLines >= baseRows + 3 + saveRows) lines.push(page.divider(width));
    const slots = page.slotWindow(maxLines - lines.length - 3 - saveRows);
    for (const slot of slots) {
      const selected = slot === selectedSlot,
        value = preset.effort_overrides?.[slot] ?? "default";
      const problem =
        this.fixedIssue(preset, slot, caps[slot]) ?? this.inheritWarning(preset, slot, caps[slot]);
      const base = ` ${selected ? "›" : " "}‹${slot}:${value}›${problem ? " !" : ""}`;
      const text = truncateToWidth(
        base + (inner < 27 ? "" : ` · ${preset.models[slot]}`),
        inner,
        "…",
      );
      const prevIndex = text.indexOf("‹"),
        nextIndex = prevIndex < 0 ? -1 : text.indexOf("›", prevIndex + 1);
      const hit = (index: number): number | undefined =>
        index < 0 ? undefined : 1 + visibleWidth(text.slice(0, index));
      page.paint.slots.set(lines.length, { slot, prev: hit(prevIndex), next: hit(nextIndex) });
      lines.push(page.row(selected ? theme.bg("selectedBg", text) : text, inner));
    }
    const inherited =
      caps[selectedSlot].error ??
      caps[selectedSlot].inheritError ??
      caps[selectedSlot].inherited ??
      "unavailable";
    if (maxLines >= baseRows + 4 + saveRows)
      lines.push(
        page.row(
          theme.fg(
            "dim",
            ` default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited} · model: ${preset.models[selectedSlot]}`,
          ),
          inner,
        ),
      );
    const info = this.error
      ? ` ! ${this.error}`
      : errors.length
        ? ` ! Current policy unavailable: ${errors.join("; ")}`
        : warnings.length
          ? ` Inherit checked at spawn: ${warnings.join("; ")}`
          : ` Changes apply immediately · default: ${defaultEffort(preset, selectedSlot)} · inherit → ${inherited}`;
    const scope = maxLines < baseRows + 1 + saveRows ? " New Agents only; main unchanged ·" : "";
    lines.push(
      page.row(
        theme.fg(
          this.error || errors.length || warnings.length ? "warning" : "muted",
          scope + info,
        ),
        inner,
      ),
    );
    const saveShown = saveRows > 0 && page.saveControls(lines, inner);
    editorControls(page, lines, inner, saveShown, slots.length < strengths.length);
    lines.push(page.bottom(width));
    return lines;
  }
}

function editorControls(
  page: PresetPage,
  lines: string[],
  inner: number,
  saveShown: boolean,
  windowed: boolean,
): void {
  const navigation = !windowed
    ? ""
    : inner >= 27
      ? " · ↑↓/1–5 slot"
      : inner >= 14
        ? " · ↑↓/1–5"
        : " ↑↓";
  if (!saveShown && page.state.canSave("global")) {
    const saving = page.saveLabels(inner, visibleWidth(navigation));
    if (saving) {
      const hints = [navigation + " · R reset · Esc back", navigation + " · R Esc", navigation];
      const hint = hints.find((each) => visibleWidth(saving.text) + visibleWidth(each) <= inner);
      page.addAction(lines, inner, saving.text + (hint ?? ""), [
        ...saving.actions,
        ...(hint?.includes("R") ? [{ kind: "reset" as const, label: "R" }] : []),
        ...(hint?.includes("Esc") ? [{ kind: "back" as const, label: "Esc" }] : []),
      ]);
      return;
    }
    const tight = `GW${navigation.trim()}`;
    if (navigation && page.state.canSave("workspace") && visibleWidth(tight) <= inner) {
      page.addAction(lines, inner, tight, [
        { kind: "saveGlobal", label: "G" },
        { kind: "saveWorkspace", label: "W" },
      ]);
      return;
    }
  }
  const controls = windowed
    ? inner < 14
      ? " ↑↓ R Esc"
      : inner < 23
        ? " ↑↓/1–5 · R Esc"
        : " ↑↓/1–5 slot · ←→ · R Esc"
    : inner < 14
      ? " R Esc"
      : inner < 23
        ? " R reset · Esc"
        : " R reset · Enter/Esc back · Alt+S close · ←→ adjust · ↑↓/1–5 slot";
  page.addAction(lines, inner, controls, [
    { kind: "reset", label: windowed || inner < 14 ? "R" : "R reset" },
    { kind: "back", label: windowed || inner < 23 ? "Esc" : "Esc back" },
  ]);
}
