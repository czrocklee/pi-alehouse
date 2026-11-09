import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  delegationModes,
  eagernessLevels,
  modeLabels,
  usesEagerness,
  type DelegationMode,
  type DelegationSetting,
} from "../delegation.ts";
import type { PickerMouseEvent, PickerMouseResult, PresetPickerOptions } from "./preset-picker.ts";
import {
  twoSides,
  type ModeTarget,
  type PickerPaint,
  type PresetPage,
  type StepTarget,
} from "./preset-list-page.ts";

const MODE_PREFIX = " Mode   ";

/** Slider gesture state only. PresetPicker remains the sole Component so a
 * held press keeps the same pi-tui capture owner across every page/paint. */
export class PresetDelegation {
  private previewMode: DelegationMode | undefined;
  private dragging = false;
  private cancelledPress = false;

  constructor(
    private readonly options: PresetPickerOptions,
    private readonly usable: () => boolean,
  ) {}

  interrupt(render = true): void {
    if (!this.dragging) return;
    this.cancelledPress = true;
    this.reset();
    if (render) this.options.tui.requestRender();
  }

  reset(): void {
    this.dragging = false;
    this.previewMode = undefined;
  }

  /** The dispatcher may synthesize a click after an unmoved release. Retire
   * both after a key interrupted capture, even if that key switched pages. */
  swallowCancelledPress(event: PickerMouseEvent): boolean {
    if (!this.cancelledPress) return false;
    if (event.type === "release" || event.type === "drag") return true;
    this.cancelledPress = false;
    return event.type === "click";
  }

  mouse(event: PickerMouseEvent, paint: PickerPaint): PickerMouseResult | undefined {
    if (!this.options.delegation) return undefined;
    const nodes = paint.modes.get(event.y);
    const hit = nodes?.find(({ start, end }) => event.x >= start && event.x < end)?.mode;
    if (this.dragging) {
      if (event.type === "drag") {
        this.previewMode = this.nearestMode(event.x, paint) ?? this.previewMode;
        return { handled: true, render: true, capture: true };
      }
      if (event.type === "release") {
        const target = this.previewMode;
        this.reset();
        if (target) this.set({ mode: target });
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
      this.set({ mode: hit });
      return { handled: true };
    }
    const step = paint.steps.get(event.y)?.find(({ x }) => x === event.x);
    if (step) {
      this.step(step.kind, step.direction);
      return { handled: true };
    }
    return nodes ? { handled: true } : undefined;
  }

  private nearestMode(x: number, paint: PickerPaint): DelegationMode | undefined {
    let best: { mode: DelegationMode; distance: number } | undefined;
    for (const nodes of paint.modes.values())
      for (const { mode, start, end } of nodes) {
        const distance = x < start ? start - x : x >= end ? x - end + 1 : 0;
        if (!best || distance < best.distance) best = { mode, distance };
      }
    return best?.mode;
  }

  step(kind: "mode" | "eagerness", direction: -1 | 1): void {
    const current = this.options.delegation?.current();
    if (!current) return;
    if (kind === "mode") {
      const index = delegationModes.indexOf(current.mode) + direction;
      if (index >= 0 && index < delegationModes.length) this.set({ mode: delegationModes[index]! });
    } else if (usesEagerness(current.mode)) {
      const index = eagernessLevels.indexOf(current.eagerness) + direction;
      if (index >= 0 && index < eagernessLevels.length)
        this.set({ eagerness: eagernessLevels[index]! });
    }
  }

  private set(change: Partial<DelegationSetting>): void {
    const delegation = this.options.delegation;
    if (!delegation || !this.usable()) return;
    const current = delegation.current(),
      next = { ...current, ...change };
    if (next.mode !== current.mode || next.eagerness !== current.eagerness) delegation.set(next);
    this.options.tui.requestRender();
  }

  section(
    page: PresetPage,
    lines: string[],
    width: number,
    inner: number,
    guidelineRows: number,
  ): void {
    const { theme } = this.options,
      delegation = this.options.delegation!;
    const current = delegation.current(),
      off = this.options.activeName === "off";
    const tone = (text: string): string => (off ? theme.fg("dim", text) : text);
    lines.push(
      this.sliderRow(page, lines.length, inner, current.mode, off) ??
        this.compactRow(page, lines.length, inner, false),
    );
    const eagerY = lines.length,
      used = usesEagerness(current.mode);
    const box = `‹ ${current.eagerness} ›`,
      left = ` Eagerness  ${box}`;
    const shown = this.previewMode ?? current.mode;
    const note =
      this.previewMode && this.previewMode !== current.mode
        ? `preview · ${modeLabels[this.previewMode]}`
        : used
          ? ""
          : "not used in Manual";
    const painted = twoSides(
      used ? tone(left) : theme.fg("dim", left),
      theme.fg("dim", note),
      inner,
    );
    if (used) {
      const at = 1 + visibleWidth(" Eagerness  ");
      page.paint.steps.set(
        eagerY,
        visibleArrows(painted, [
          { kind: "eagerness", direction: -1, x: at },
          { kind: "eagerness", direction: 1, x: at + visibleWidth(box) - 1 },
        ]),
      );
    }
    lines.push(page.row(painted, inner));
    if (guidelineRows > 0) {
      const text = delegation.guideline({ mode: shown, eagerness: current.eagerness });
      const wrapped = [
        ...(off
          ? [
              theme.fg(
                "warning",
                " Off: no Agent work. The mode applies when a model preset is active.",
              ),
            ]
          : []),
        ...wrapWords(text, inner - 2).map((line) => theme.fg("dim", ` ${line}`)),
      ];
      const shownRows = wrapped.slice(0, guidelineRows);
      if (wrapped.length > guidelineRows)
        shownRows[guidelineRows - 1] = truncateToWidth(
          shownRows[guidelineRows - 1]! + " …",
          inner,
          "…",
        );
      for (const line of shownRows) lines.push(page.row(truncateToWidth(line, inner, "…"), inner));
    }
    lines.push(page.divider(width));
  }

  private sliderRow(
    page: PresetPage,
    y: number,
    inner: number,
    mode: DelegationMode,
    off: boolean,
  ): string | undefined {
    const { theme } = this.options;
    const nodes = delegationModes.map((each) => `${each === mode ? "●" : "○"} ${modeLabels[each]}`);
    const room =
      inner -
      visibleWidth(MODE_PREFIX) -
      nodes.reduce((sum, node) => sum + visibleWidth(node), 0) -
      1;
    const gap = Math.floor(room / (nodes.length - 1));
    if (gap < 3) return undefined;
    const connector = ` ${"─".repeat(gap - 2)} `;
    let text = MODE_PREFIX,
      plain = MODE_PREFIX;
    const targets: ModeTarget[] = [];
    delegationModes.forEach((each, index) => {
      if (index) {
        text += theme.fg("dim", connector);
        plain += connector;
      }
      const start = 1 + visibleWidth(plain);
      targets.push({ mode: each, start, end: start + visibleWidth(nodes[index]!) });
      const label = each === mode ? theme.bold(nodes[index]!) : nodes[index]!;
      text +=
        each === mode
          ? theme.fg(off ? "dim" : "accent", label)
          : each === this.previewMode
            ? theme.fg("accent", label)
            : theme.fg(off ? "dim" : "muted", label);
      plain += nodes[index];
    });
    page.paint.modes.set(y, targets);
    return page.row(text, inner);
  }

  compactRow(page: PresetPage, y: number, inner: number, withEagerness: boolean): string {
    const { theme } = this.options,
      current = this.options.delegation!.current();
    const modeBox = `‹ ${modeLabels[current.mode]} ›`;
    const eagerBox =
      withEagerness && usesEagerness(current.mode) ? ` ‹ ${current.eagerness} ›` : "";
    const prefix = " Mode ",
      text = truncateToWidth(prefix + modeBox + eagerBox, inner, "…");
    const at = 1 + visibleWidth(prefix);
    const targets: StepTarget[] = [
      { kind: "mode", direction: -1, x: at },
      { kind: "mode", direction: 1, x: at + visibleWidth(modeBox) - 1 },
    ];
    if (eagerBox) {
      const eagerAt = at + visibleWidth(modeBox) + 1;
      targets.push(
        { kind: "eagerness", direction: -1, x: eagerAt },
        { kind: "eagerness", direction: 1, x: eagerAt + visibleWidth(eagerBox) - 2 },
      );
    }
    page.paint.steps.set(y, visibleArrows(text, targets));
    return page.row(this.options.activeName === "off" ? theme.fg("dim", text) : text, inner);
  }
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function visibleArrows(row: string, targets: StepTarget[]): StepTarget[] {
  return targets.filter(({ x }) => {
    const cell = stripTerminalSequences(sliceByColumn(row, x - 1, 1, true));
    return cell === "‹" || cell === "›";
  });
}
