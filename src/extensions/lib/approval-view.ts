/** Approval presentation. Live authorization, epochs and choices stay in approval-mode.ts. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { popoverRule, popoverSide } from "../../shared/popover-frame.mjs";
import {
  onBorderLabelsChange,
  popoverChromeCloseHit,
  popoverChromeLayout,
  popoverTextRect,
  popoverTitleRows,
} from "../../shared/popover-chrome.mjs";
import { createPopoverCloseControl } from "../../shared/popover-close-control.mjs";
import { createPopoverCloseHover } from "../../shared/popover-close-hover.mjs";
import { createPopoverTextSelection } from "../../shared/popover-text-selection.mjs";
import type { PersistentScope } from "../../shared/settings-store.mjs";
import { shortcutHint } from "../../shared/shortcut-hint.mjs";
import type { JudgeState } from "./approval-protocol.ts";
import { CONFIRM_ROWS, currentChoice, type Choice, type ChoiceId } from "./approval-selection.ts";

/** The indicator's text; yolo is loud on purpose. */
export function approvalStatus(
  theme: Pick<Theme, "fg" | "bold">,
  judge: JudgeState | undefined,
  yolo: boolean,
): string {
  const id = currentChoice(judge, yolo);
  const label =
    id === "yolo"
      ? theme.fg("error", theme.bold("YOLO"))
      : id === "manual"
        ? "manual"
        : `${judge!.judge}${id === "judge+sub" ? "+sub" : ""}`;
  return `approval: ${label}`;
}

type PopoverTheme = Pick<Theme, "fg" | "bold" | "bg">;

export interface ApprovalPopoverOptions {
  tui?: object;
  theme: PopoverTheme;
  choices: () => Choice[];
  current: () => ChoiceId;
  /** Lines to confirm a choice with; undefined applies it at once. */
  warning: (id: ChoiceId) => string[] | undefined;
  choose: (id: ChoiceId) => void;
  /** Alehouse-only actions: save the live mode, never an armed draft. */
  save?: (scope: PersistentScope) => void;
  canSaveWorkspace?: () => boolean;
  saveScope?: () => "session" | PersistentScope;
  close: () => void;
  requestRender: () => void;
  /** Rows this paint produced, for the bottom-right column. */
  onRender?: (height: number) => void;
  /** Reject cached SDK pointer bounds after stack/terminal movement. */
  pointerCurrent?: () => boolean;
}

/**
 * The popover body. Enter or a click applies a mode, like a menu; a choice
 * that widens approval needs the same choice twice, and the first one says
 * what it is about to allow.
 */
export class ApprovalPopover implements Component {
  private selected: number;
  private armed: number | undefined;
  private paintedWidth = 0;
  private pointerPressed = false;
  private suppressClick = false;
  private disposed = false;
  private readonly closeHover: ReturnType<typeof createPopoverCloseControl>;
  /** Body-local text selection. Registers the painted body only; the helper
   * binds the host's own selection gesture, so no mouse path here. */
  private readonly selection: ReturnType<typeof createPopoverTextSelection>;
  /** Advances when the painted rows change; never reallocated per paint. */
  private selectionVersion = 0;
  private readonly unwatchBorderLabels: () => void;
  private readonly rowTargets = new Map<number, number | PersistentScope>();

  constructor(private readonly options: ApprovalPopoverOptions) {
    this.closeHover = createPopoverCloseControl({
      createHover: createPopoverCloseHover,
      closeHit: popoverChromeCloseHit,
      host: options.tui,
      requestRender: options.requestRender,
    });
    this.selection = createPopoverTextSelection({ host: options.tui, component: this });
    this.unwatchBorderLabels = onBorderLabelsChange(() => {
      if (this.disposed) return;
      this.invalidate();
      this.options.requestRender();
    });
    const index = options.choices().findIndex((choice) => choice.id === options.current());
    this.selected = Math.max(0, index);
  }

  isArmed(): boolean {
    return this.armed !== undefined;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const count = this.options.choices().length;
    if (matchesKey(data, "escape")) return this.close();
    if (matchesKey(data, "g") || matchesKey(data, "shift+g")) return this.saveDefault("global");
    if (matchesKey(data, "w") || matchesKey(data, "shift+w")) return this.saveDefault("workspace");
    if (matchesKey(data, "enter")) return this.activate(this.selected);
    let next = this.selected;
    if (matchesKey(data, "up")) next--;
    else if (matchesKey(data, "down")) next++;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = count - 1;
    else return;
    this.move(next);
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type === "press" && event.button === "left") {
      this.pointerPressed = true;
      this.suppressClick = false;
    }
    if (this.options.pointerCurrent?.() === false) this.resetPointer();
    // Eligibility is a flag, not a gate: the control still observes the event
    // so it can cancel an in-progress gesture its panel would reject.
    const active =
      !this.disposed &&
      !!this.paintedWidth &&
      event.width === this.paintedWidth &&
      !this.suppressClick;
    const close = this.closeHover.mouse(event, active);
    if (close) {
      if (event.type === "click") this.pointerPressed = false;
      if (close.close) this.close();
      return { handled: true };
    }
    if (this.disposed || !this.paintedWidth || event.width !== this.paintedWidth) return undefined;
    if (event.type === "click") {
      this.pointerPressed = false;
      if (this.suppressClick) return undefined;
    }
    if (event.type === "wheel" && event.wheelDelta) {
      this.move(this.selected + Math.sign(event.wheelDelta));
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.rowTargets.get(event.y);
    if (typeof target === "string") this.saveDefault(target);
    else if (target !== undefined) this.activate(target);
    return { handled: true };
  }

  render(width: number): string[] {
    this.rowTargets.clear();
    if (this.disposed) return [];
    const closeVisible = width >= 12 && !!popoverChromeCloseHit(width);
    const headerRows = popoverChromeLayout({ framed: true }).top.rows;
    const lines = width < 12 ? [] : this.layout(width, headerRows);
    this.closeHover.paint(width, closeVisible, lines.length);
    this.paintedWidth = closeVisible ? width : 0;
    // Publish actual height before styling the translated title, without
    // laying out choices/warnings (and rebuilding their hit map) twice.
    if (lines.length) {
      const title = popoverTitleRows(
        this.options.theme,
        width,
        "Approval",
        { clip: (text, columns) => truncateToWidth(text, columns, "…"), width: visibleWidth },
        closeVisible,
        this.closeHover.hovered,
      );
      lines.splice(0, title.length, ...title);
    }
    // Selectable text is the choice/detail/warning prose between the top band
    // and the bottom rule, never the frame or the gutter. Row presses stay
    // with the existing controls: the helper binds only unhandled presses.
    this.selection.paint(
      lines.length
        ? popoverTextRect(width, lines.length, { inset: 1, top: headerRows, bottom: 1 })
        : undefined,
      this.selectionVersion,
    );
    this.options.onRender?.(lines.length);
    return lines;
  }

  /** Presentation-only cleanup never disarms or moves the keyboard choice. */
  resetPointer(): void {
    this.closeHover.reset(false);
    this.selection.reset();
    this.paintedWidth = 0;
    this.rowTargets.clear();
    if (this.pointerPressed) this.suppressClick = true;
  }

  invalidate(): void {
    this.resetPointer();
  }

  dispose(): void {
    this.disposed = true;
    this.unwatchBorderLabels();
    this.invalidate();
    this.closeHover.dispose();
    this.selection.dispose();
  }

  private close(): void {
    this.dispose();
    this.options.close();
  }

  private move(index: number): void {
    const count = this.options.choices().length;
    const next = Math.max(0, Math.min(count - 1, index));
    if (next === this.selected) return;
    this.selected = next;
    // Arming is for the row it was given on; moving away disarms.
    this.armed = undefined;
    this.retireSelection();
    this.options.requestRender();
  }

  /** A painted-row change retires the bound native selection immediately, not
   * only at the next paint, so a stale highlight cannot outlive the row it
   * was taken from. */
  private retireSelection(): void {
    this.selectionVersion++;
    this.selection.reset();
  }

  private saveDefault(scope: PersistentScope): void {
    if (!this.options.save || (scope === "workspace" && this.options.canSaveWorkspace?.() !== true))
      return;
    this.armed = undefined;
    this.options.save(scope);
  }

  private activate(index: number): void {
    const choice = this.options.choices()[index];
    if (!choice) return;
    this.selected = index;
    if (this.options.warning(choice.id) && this.armed !== index) {
      this.armed = index;
      this.retireSelection();
      this.options.requestRender();
      return;
    }
    this.armed = undefined;
    this.options.choose(choice.id);
  }

  private layout(width: number, headerRows: number): string[] {
    const { theme } = this.options;
    const inner = width - 2;
    const row = (content: string): string =>
      popoverSide(theme) + padTo(truncateToWidth(content, inner, "…"), inner) + popoverSide(theme);
    const choices = this.options.choices();
    const current = this.options.current();
    const labelWidth = Math.max(...choices.map((choice) => visibleWidth(choice.label)));
    // The shared chrome owns the top band: one inlaid title row, or an outer
    // rule, an interior label/close row and a separator when labels are off.
    const lines = Array.from({ length: headerRows }, () => "");
    choices.forEach((choice, index) => {
      const selected = index === this.selected;
      const marker = selected ? theme.fg("accent", "›") : " ";
      const live =
        choice.id === current
          ? theme.fg(choice.id === "yolo" ? "error" : "success", "●")
          : theme.fg("dim", "○");
      const name = padTo(choice.label, labelWidth);
      const label =
        choice.id === "yolo" ? theme.fg("error", name) : selected ? theme.bold(name) : name;
      const content = padTo(`${marker} ${live} ${label}  ${theme.fg("dim", choice.detail)}`, inner);
      this.rowTargets.set(lines.length, index);
      lines.push(row(selected ? theme.bg("selectedBg", content) : content));
    });
    lines.push(popoverRule(theme, width, "divider"));
    if (this.options.save) {
      const scope = this.options.saveScope?.() ?? "session";
      lines.push(
        row(
          theme.fg(
            "dim",
            scope === "session"
              ? " Mode changes: this session only"
              : ` Mode changes: saved for ${scope} on exit`,
          ),
        ),
      );
      this.rowTargets.set(lines.length, "global");
      // Inline key letter, no keycap brackets: `g` inside "global".
      lines.push(row(" " + shortcutHint(theme, "Save as global default (on exit)", "g")));
      this.rowTargets.set(lines.length, "workspace");
      const trusted = this.options.canSaveWorkspace?.() === true;
      // Both scope names contain their mnemonic. An unavailable workspace
      // save has no keyboard emphasis.
      lines.push(
        row(
          " " +
            (trusted
              ? shortcutHint(theme, "Save as workspace default (on exit)", "W")
              : shortcutHint(theme, "Workspace default (trust required)", undefined, {
                  color: "dim",
                })),
        ),
      );
      lines.push(popoverRule(theme, width, "divider"));
    }
    const warning =
      this.armed === undefined ? undefined : this.options.warning(choices[this.armed]!.id);
    if (warning) {
      for (const line of warning.slice(0, CONFIRM_ROWS)) lines.push(row(theme.fg("warning", line)));
    } else {
      // Explicit chords keep their wording; only the styling is the helper's.
      const dim = (text: string): string => theme.fg("dim", text);
      lines.push(
        row(
          dim(" ") +
            (this.options.save ? dim("● active · ") : "") +
            shortcutHint(theme, "choose", "↑↓", { color: "dim" }) +
            dim(" · ") +
            shortcutHint(theme, "apply", "Enter", { color: "dim" }) +
            dim(" · ") +
            shortcutHint(theme, "close", "Esc", { color: "dim" }) +
            dim(" "),
        ),
      );
    }
    lines.push(popoverRule(theme, width, "bottom"));
    return lines;
  }
}

const padTo = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - visibleWidth(text)));
