/**
 * Approval indicator: `MODE ▴` in the footer's right corner, and the
 * bottom-right popover that changes it.
 *
 * Modes are the loaded model judge's own (jev under pi-harness, Luna under
 * plain pi) plus yolo:
 *
 * - manual     the judge only observes; every ask reaches the human
 * - JUDGE      the judge decides the main session's asks
 * - JUDGE+sub  ...and the asks subagents forward to it
 * - yolo       every ask is allowed without review, in-process subagents included
 *
 * The judge keeps sole ownership of its mode: this extension renders what the
 * judge publishes and asks it to change (lib/approval-protocol.ts). Yolo is not
 * a judge mode. It is upstream permission-system yolo, scoped to this session
 * by the managed authority (permission-system/managed-session-yolo.ts): asks
 * become allows, while explicit denies, the fail-closed floor and the static
 * safety guard still hold.
 *
 * Any change that widens what is approved without asking you -- manual to the
 * judge, the judge to judge + subagents, anything to yolo -- takes a second,
 * deliberate choice (or Pi's confirm dialog); narrowing takes one.
 *
 * The choice is recorded in the session under the session's own id, so a
 * fork or clone that copies the history inherits nothing. Resuming restores
 * the judge mode no wider than the launch default, and offers yolo back
 * behind a confirmation rather than resuming it. Every branch the session
 * moves to is made to agree with the live state.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { APPROVAL_INDICATOR, FOOTER_INDICATOR_CLICK_EVENT, HIDE_TRANSIENT_OVERLAYS_EVENT,
  type FooterIndicatorClick } from "../lib/overlay-protocol.mjs";
import { POPOVER, POPOVER_CLOSE_COLUMNS, isPopoverCloseClick, popoverCloseHit, popoverCloseTail,
  popoverRule, popoverSide } from "../lib/popover-frame.mjs";
import { focusOrigin, focusRevealed, joinPopoverStack, stackedOverlayOptions, type StackMember } from "../lib/popover-stack.mjs";
import { APPROVAL_JUDGE_STATE_EVENT, APPROVAL_SET_JUDGE_EVENT, judgeModeRank, sessionYoloSet, type JudgeMode,
  type JudgeName, type JudgeState, type SetJudgeMode } from "./lib/approval-protocol.ts";

/** Session record of each approval change; the last one on the branch wins. */
export const APPROVAL_ENTRY = "approval-mode:choice:v1";
const WIDGET_KEY = "approval-mode";
const PERMISSION_UI_PROMPT = "permissions:ui_prompt";
const POPOVER_WIDTH = 60;

export type ChoiceId = "manual" | "judge" | "judge+sub" | "yolo";
export type Choice = { id: ChoiceId; label: string; detail: string };

/** What the popover offers: the judge's three modes when one is loaded, and yolo. */
export function approvalChoices(judge: JudgeName | undefined): Choice[] {
  if (!judge) {
    return [
      { id: "manual", label: "manual", detail: "every ask comes to you" },
      { id: "yolo", label: "yolo", detail: "allow eligible asks, in-process subagents too" },
    ];
  }
  return [
    { id: "manual", label: "manual", detail: `${judge} observes; every ask comes to you` },
    { id: "judge", label: judge, detail: `${judge} decides main-session asks` },
    { id: "judge+sub", label: `${judge} + sub`, detail: "...and asks subagents forward" },
    { id: "yolo", label: "yolo", detail: "allow eligible asks, in-process subagents too" },
  ];
}

const CHOICE_RANK: Record<ChoiceId, number> = { manual: 0, judge: 1, "judge+sub": 2, yolo: 3 };
/** Rows a confirmation warning takes in the popover. */
export const CONFIRM_ROWS = 3;

/**
 * The warning a choice must be confirmed with, or undefined when it does not
 * widen what is approved without asking (narrowing, or already current).
 */
export function confirmationFor(id: ChoiceId, judge: JudgeName | undefined, current: ChoiceId): string[] | undefined {
  if (CHOICE_RANK[id] <= CHOICE_RANK[current]) return undefined;
  if (id === "yolo") {
    return [" yolo also auto-allows reader/subagent Bash asks.",
      " Denies, fail-closed floor and static guard hold.",
      " Opaque code can write files. Choose yolo again."];
  }
  const name = judge ?? "the judge";
  return [id === "judge+sub" ? ` ${name} may decide asks here and from subagents.` : ` ${name} may approve or deny this session's asks.`,
    " Static denies and hard checkpoints stay manual.",
    ` Choose ${id === "judge+sub" ? `${name} + sub` : name} again to turn it on.`];
}

export function currentChoice(judge: JudgeMode | undefined, yolo: boolean): ChoiceId {
  if (yolo) return "yolo";
  if (!judge || judge.mode === "shadow") return "manual";
  return judge.includeSubagents ? "judge+sub" : "judge";
}

const judgeModeFor = (id: Exclude<ChoiceId, "yolo">): JudgeMode =>
  id === "manual" ? { mode: "shadow", includeSubagents: false }
    : { mode: "enforce", includeSubagents: id === "judge+sub" };

/** The indicator's text; yolo is loud on purpose. */
export function approvalStatus(theme: Pick<Theme, "fg" | "bold">, judge: JudgeState | undefined, yolo: boolean): string {
  const id = currentChoice(judge, yolo);
  const label = id === "yolo" ? theme.fg("error", theme.bold("YOLO"))
    : id === "manual" ? "manual"
      : `${judge!.judge}${id === "judge+sub" ? "+sub" : ""}`;
  return `approval: ${label}`;
}

type PopoverTheme = Pick<Theme, "fg" | "bold" | "bg">;

export interface ApprovalPopoverOptions {
  theme: PopoverTheme;
  choices: () => Choice[];
  current: () => ChoiceId;
  /** Lines to confirm a choice with; undefined applies it at once. */
  warning: (id: ChoiceId) => string[] | undefined;
  choose: (id: ChoiceId) => void;
  close: () => void;
  requestRender: () => void;
  /** Rows this paint produced, for the bottom-right column. */
  onRender?: (height: number) => void;
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
  private readonly rowTargets = new Map<number, number>();

  constructor(private readonly options: ApprovalPopoverOptions) {
    const index = options.choices().findIndex((choice) => choice.id === options.current());
    this.selected = Math.max(0, index);
  }

  isArmed(): boolean { return this.armed !== undefined; }

  handleInput(data: string): void {
    const count = this.options.choices().length;
    if (matchesKey(data, "escape")) return this.options.close();
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
    if (isPopoverCloseClick(event, this.paintedWidth)) {
      this.options.close();
      return { handled: true };
    }
    if (event.type === "wheel" && event.wheelDelta) {
      this.move(this.selected + Math.sign(event.wheelDelta));
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.rowTargets.get(event.y);
    if (target !== undefined) this.activate(target);
    return { handled: true };
  }

  render(width: number): string[] {
    this.rowTargets.clear();
    this.paintedWidth = width;
    const lines = width < 12 ? [] : this.layout(width);
    this.options.onRender?.(lines.length);
    return lines;
  }

  invalidate(): void {}

  private move(index: number): void {
    const count = this.options.choices().length;
    const next = Math.max(0, Math.min(count - 1, index));
    if (next === this.selected) return;
    this.selected = next;
    // Arming is for the row it was given on; moving away disarms.
    this.armed = undefined;
    this.options.requestRender();
  }

  private activate(index: number): void {
    const choice = this.options.choices()[index];
    if (!choice) return;
    this.selected = index;
    if (this.options.warning(choice.id) && this.armed !== index) {
      this.armed = index;
      this.options.requestRender();
      return;
    }
    this.armed = undefined;
    this.options.choose(choice.id);
  }

  private layout(width: number): string[] {
    const { theme } = this.options;
    const inner = width - 2;
    const row = (content: string): string =>
      popoverSide(theme) + padTo(truncateToWidth(content, inner, "…"), inner) + popoverSide(theme);
    const choices = this.options.choices();
    const current = this.options.current();
    const labelWidth = Math.max(...choices.map((choice) => visibleWidth(choice.label)));
    const lines = [titleEdge(theme, width, "Approval")];
    choices.forEach((choice, index) => {
      const selected = index === this.selected;
      const marker = selected ? theme.fg("accent", "›") : " ";
      const live = choice.id === current ? theme.fg(choice.id === "yolo" ? "error" : "success", "●") : theme.fg("dim", "○");
      const name = padTo(choice.label, labelWidth);
      const label = choice.id === "yolo" ? theme.fg("error", name) : selected ? theme.bold(name) : name;
      const content = padTo(`${marker} ${live} ${label}  ${theme.fg("dim", choice.detail)}`, inner);
      this.rowTargets.set(lines.length, index);
      lines.push(row(selected ? theme.bg("selectedBg", content) : content));
    });
    lines.push(popoverRule(theme, width, "divider"));
    const warning = this.armed === undefined ? undefined : this.options.warning(choices[this.armed]!.id);
    if (warning) {
      for (const line of warning.slice(0, CONFIRM_ROWS)) lines.push(row(theme.fg("warning", line)));
    } else {
      lines.push(row(theme.fg("dim", " ↑↓ choose · Enter apply · Esc close")));
    }
    lines.push(popoverRule(theme, width, "bottom"));
    return lines;
  }
}

const padTo = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** `╭─ Title ───── × ─╮`, the close control at the right end like every popover. */
function titleEdge(theme: PopoverTheme, width: number, title: string): string {
  const closable = !!popoverCloseHit(width);
  const tailWidth = closable ? POPOVER_CLOSE_COLUMNS : 1;
  const label = ` ${title} `;
  const room = width - 2 - tailWidth - visibleWidth(label);
  if (room < 0) return popoverRule(theme, width, "top");
  return theme.fg("borderAccent", POPOVER.tl + POPOVER.h) + theme.fg("accent", theme.bold(label)) +
    theme.fg("borderAccent", POPOVER.h.repeat(room)) + (closable ? popoverCloseTail(theme) : theme.fg("borderAccent", POPOVER.tr));
}

/** What a session records about its approval choice. */
export interface RecordedChoice {
  yolo: boolean;
  /** The judge's mode, when a judge was loaded. */
  judge?: JudgeMode;
}

const sameJudge = (a: JudgeMode | undefined, b: JudgeMode | undefined): boolean =>
  a === b || (!!a && !!b && a.mode === b.mode && a.includeSubagents === b.includeSubagents);

const readJudge = (value: unknown): JudgeMode | undefined => {
  const mode = value as Partial<JudgeMode> | undefined;
  if (!mode || typeof mode !== "object" || typeof mode.includeSubagents !== "boolean") return undefined;
  if (mode.mode === "shadow") return { mode: "shadow", includeSubagents: false };
  return mode.mode === "enforce" ? { mode: "enforce", includeSubagents: mode.includeSubagents } : undefined;
};

/**
 * The last choice this session recorded on this branch. Only a record naming
 * this very session counts: one copied by a fork or clone from another
 * session id, or a malformed one, means nothing was recorded.
 *
 * A record is a request, never authority: resuming offers yolo back behind a
 * confirmation and restores a judge mode no wider than the launch default,
 * so a record planted in the session file can at most ask or narrow.
 */
export function restoredChoice(entries: readonly { type: string; customType?: string; data?: unknown }[],
  sessionId: string | undefined): RecordedChoice | undefined {
  if (!sessionId) return undefined;
  const last = entries.filter((entry) => entry.type === "custom" && entry.customType === APPROVAL_ENTRY).at(-1);
  const record = last?.data as { sessionId?: unknown; yolo?: unknown; judge?: unknown } | undefined;
  if (!record || record.sessionId !== sessionId || typeof record.yolo !== "boolean") return undefined;
  const judge = readJudge(record.judge);
  return judge ? { yolo: record.yolo, judge } : { yolo: record.yolo };
}

/** The narrower of two judge modes. */
export function narrowerJudge(a: JudgeMode, b: JudgeMode): JudgeMode {
  return judgeModeRank(a) <= judgeModeRank(b) ? a : b;
}

const YOLO_WARNING = "Approval: YOLO. Eligible permission asks in this session and its in-process subagents are allowed " +
  "without review, a reader's Bash commands included; explicit denies (including detected reader path writes), the " +
  "fail-closed floor and the static safety guard still apply. Opaque programs can still write files internally. " +
  "Subagents outside this process keep asking.";

/** The confirmation Pi's dialog shows before a widening change. */
function confirmDialog(id: ChoiceId, judge: JudgeName | undefined): { title: string; text: string } {
  if (id === "yolo") return { title: "Turn on yolo for this session?", text: YOLO_WARNING };
  const name = judge ?? "the judge";
  return id === "judge+sub"
    ? { title: `Let ${name} approve asks here and from subagents?`,
      text: `${name} may allow or deny eligible permission asks from this session and its registered in-process ` +
        "subagents without asking you. Static denies and hard checkpoints stay manual. This lasts for the current session." }
    : { title: `Let ${name} approve this session's asks?`,
      text: `${name} may allow or deny eligible permission asks from this session without asking you; subagent asks ` +
        "stay manual. Static denies and hard checkpoints stay manual. This lasts for the current session." };
}

export default function approvalMode(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let judge: JudgeState | undefined;
  /** The judge's launch mode for this session: its first publish for it. */
  let baseline: JudgeMode | undefined;
  /** Advances per session, so deferred restore work for an old one is dropped. */
  let epoch = 0;
  let yolo = false;
  let tui: TUI | undefined;
  let theme: Theme | undefined;
  let open: { component: ApprovalPopover; member: StackMember; handle?: OverlayHandle } | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;

  /** Retire authority and awaited confirmations before touching any UI. */
  const retireSession = (): void => {
    epoch++;
    if (sessionId) sessionYoloSet().delete(sessionId);
    sessionId = undefined;
    yolo = false;
    baseline = undefined;
    ctx = undefined;
  };

  const paint = (): void => {
    if (!ctx?.hasUI) return;
    try { ctx.ui.setStatus(APPROVAL_INDICATOR, approvalStatus(ctx.ui.theme, judge, yolo)); }
    catch { /* The indicator is presentation; approval state is unaffected. */ }
    try { tui?.requestRender(); } catch { /* Rendering cannot interrupt a live state change. */ }
  };

  const liveJudge = (): JudgeMode | undefined => judge && judge.sessionId === sessionId
    ? { mode: judge.mode, includeSubagents: judge.includeSubagents } : undefined;

  /**
   * Make the current branch's record say what is live. The branch, not the
   * last thing written, is the comparison: after /tree the two can disagree.
   * No record reads as the launch state, so an unchanged session writes none.
   * A failed write is said out loud; it cannot fail open, because a stale
   * yolo record is only ever offered back behind a confirmation.
   */
  const record = (): void => {
    if (!ctx || !sessionId) return;
    const live: RecordedChoice = { yolo, ...(liveJudge() ? { judge: liveJudge() } : {}) };
    try {
      const recorded = restoredChoice(ctx.sessionManager.getBranch(), sessionId) ?? { yolo: false, judge: baseline };
      if (recorded.yolo === live.yolo && sameJudge(recorded.judge, live.judge)) return;
      pi.appendEntry(APPROVAL_ENTRY, { sessionId, ...live });
    } catch (error) {
      try { ctx.ui.notify(`Approval: this change is live but could not be recorded in the session (${String(error)}).`, "warning"); }
      catch { /* best effort */ }
    }
  };

  /** Live grant only; callers record once the whole change is made. */
  const setYolo = (on: boolean): boolean => {
    if (!sessionId) return false;
    const granted = sessionYoloSet();
    if (on) granted.add(sessionId);
    else granted.delete(sessionId);
    yolo = on;
    paint();
    return true;
  };

  const requestJudge = (mode: JudgeMode): boolean => {
    const request: SetJudgeMode = { ...mode, applied: false };
    pi.events.emit(APPROVAL_SET_JUDGE_EVENT, request);
    return request.applied;
  };

  /** Apply a choice the user has already confirmed if it widens anything. */
  const choose = (id: ChoiceId): void => {
    if (id === "yolo") {
      if (!yolo && setYolo(true)) ctx?.ui.notify(YOLO_WARNING, "warning");
    } else {
      const wasYolo = yolo;
      setYolo(false);
      if (judge) {
        if (!requestJudge(judgeModeFor(id))) ctx?.ui.notify(`The ${judge.judge} judge did not take the change.`, "warning");
      }
      if (wasYolo) ctx?.ui.notify(`Approval: yolo is off; ${currentChoice(judge, false)}.`, "info");
    }
    // Always, not only when something changed: this also revokes a stale
    // record left on the branch.
    record();
    close();
  };

  const close = (): void => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = undefined;
    const closing = open, host = tui;
    open = undefined; // Retained components/callbacks lose ownership even if hide fails.
    if (!closing) return;
    for (const cleanup of [() => closing.handle?.hide(), () => closing.member.leave(), () => host?.requestRender()]) {
      try { cleanup(); } catch { /* Attempt every presentation cleanup independently. */ }
    }
  };

  const mount = (): void => {
    if (!open || !tui) return;
    const host = tui;
    const mounted = open;
    const openedFrom = focusOrigin(host);
    mounted.handle = host.showOverlay(mounted.component, stackedOverlayOptions(mounted.member, {
      width: POPOVER_WIDTH, minWidth: 36,
      // Every choice plus the frame and a confirmation warning: the popover
      // waits off screen rather than be clipped with an armed row clickable.
      minRows: approvalChoices(judge?.judge).length + 3 + CONFIRM_ROWS,
      onReveal: () => { if (open === mounted && mounted.handle) focusRevealed(host, mounted.handle, openedFrom); },
    }));
    host.requestRender();
  };

  const openPopover = (): void => {
    if (open || !tui || !theme || tui.mode !== "fullscreen") return;
    const member = joinPopoverStack(tui);
    const host = tui, at = epoch;
    const live = (): boolean => at === epoch && open?.member === member;
    const component = new ApprovalPopover({
      theme, choices: () => approvalChoices(judge?.judge), current: () => currentChoice(judge, yolo),
      warning: (id) => confirmationFor(id, judge?.judge, currentChoice(judge, yolo)),
      // A failed hide can leave an armed old component on the renderer. It
      // must neither approve for a new session nor close that session's UI.
      choose: (id) => { if (live()) choose(id); },
      close: () => { if (live()) close(); },
      requestRender: () => { if (live()) host.requestRender(); },
      onRender: (height) => { if (live()) member.measure(height); },
    });
    open = { component, member };
    mount();
  };

  /** Pi's confirm dialog for a widening change; narrowing needs none. */
  const confirmed = async (context: ExtensionContext, id: ChoiceId): Promise<boolean> => {
    if (!confirmationFor(id, judge?.judge, currentChoice(judge, yolo))) return true;
    if (!context.hasUI) return false;
    const dialog = confirmDialog(id, judge?.judge);
    return await context.ui.confirm(dialog.title, dialog.text);
  };

  /**
   * Apply a choice once its dialogs are answered -- only if the session they
   * were opened for is still the live one. An answer that outlives a session
   * switch or shutdown must not grant anything to either session.
   */
  const chooseAfter = async (at: number, context: ExtensionContext, id: ChoiceId): Promise<void> => {
    if (at !== epoch || !await confirmed(context, id) || at !== epoch) return;
    choose(id);
  };

  /** Regular renderer, or the command without the popover: Pi's own dialogs. */
  const chooseWithDialogs = async (context: ExtensionContext): Promise<void> => {
    const at = epoch;
    const choices = approvalChoices(judge?.judge);
    const current = currentChoice(judge, yolo);
    const picked = await context.ui.select(`Approval (now ${current})`,
      choices.map((choice) => `${choice.label} — ${choice.detail}`));
    const choice = choices.find((candidate) => picked?.startsWith(`${candidate.label} — `));
    if (choice) await chooseAfter(at, context, choice.id);
  };

  const toggle = (): void => {
    if (open) return close();
    if (tui?.mode === "fullscreen") return openPopover();
    if (ctx?.hasUI) {
      const context = ctx;
      chooseWithDialogs(context).catch((error: unknown) => {
        try { context.ui.notify(`Approval selection failed: ${String(error)}`, "error"); } catch { /* best effort */ }
      });
    }
  };

  /**
   * Resume the judge mode this session picked, once the judge has published
   * its launch mode -- but never wider than that launch mode. A manual pick
   * survives; an explicit narrower launch (`PI_JEV_APPROVAL_MODE=shadow`)
   * still wins over a wider pick recorded earlier.
   */
  const restoreJudge = (at: number): void => {
    if (at !== epoch || !ctx || !baseline) return;
    const recorded = restoredChoice(ctx.sessionManager.getBranch(), sessionId)?.judge;
    if (!recorded) return;
    const target = narrowerJudge(recorded, baseline);
    if (!sameJudge(target, liveJudge())) requestJudge(target);
  };

  /** Yolo is never resumed silently: the session asks, and until it is
   * answered every ask goes through the judge or the human as usual. */
  const offerYolo = async (at: number, context: ExtensionContext): Promise<void> => {
    if (at !== epoch || !context.hasUI) return;
    const accepted = await context.ui.confirm("Resume yolo for this session?",
      `Yolo was on when this session was last used. ${YOLO_WARNING}`);
    if (at !== epoch || yolo) return;
    if (accepted && setYolo(true)) context.ui.notify(YOLO_WARNING, "warning");
    record();
  };

  pi.events.on(APPROVAL_JUDGE_STATE_EVENT, (data) => {
    const state = data as JudgeState | undefined;
    if (!state || (state.judge !== "jev" && state.judge !== "luna") ||
        (state.mode !== "shadow" && state.mode !== "enforce")) return;
    state.shown = true;
    judge = { judge: state.judge, mode: state.mode, includeSubagents: state.mode === "enforce" && state.includeSubagents === true,
      ...(typeof state.sessionId === "string" ? { sessionId: state.sessionId } : {}), shown: true };
    if (sessionId && judge.sessionId === sessionId) {
      if (!baseline) {
        // The launch mode. Restore after the judge's own emit has returned.
        baseline = liveJudge();
        const at = epoch;
        void Promise.resolve().then(() => restoreJudge(at));
      } else {
        // Any later change -- the popover, /auto-approval -- is recorded.
        record();
      }
    }
    paint();
  });

  pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (data) => {
    const click = data as FooterIndicatorClick | undefined;
    if (click?.key !== APPROVAL_INDICATOR) return;
    click.handled = true;
    toggle();
  });

  // A permission dialog must not open under a popover that holds the keyboard.
  pi.events.on(PERMISSION_UI_PROMPT, () => close());

  // A harness panel closing through ui.custom pops the TOP overlay, which may
  // be this one. Step off the overlay stack, keep the column place, come back.
  pi.events.on(HIDE_TRANSIENT_OVERLAYS_EVENT, () => {
    if (!open?.handle) return;
    open.handle.hide();
    open.handle = undefined;
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined;
      if (open && !open.handle) mount();
    }, 0);
  });

  pi.registerCommand("approval", {
    description: "Choose how permission asks are approved: manual, the model judge, or yolo",
    handler: async (args, context) => {
      const wanted = args.trim().toLowerCase();
      if (!wanted) {
        if (tui?.mode === "fullscreen") { toggle(); return; }
        await chooseWithDialogs(context);
        return;
      }
      const choices = approvalChoices(judge?.judge);
      const choice = choices.find((candidate) => candidate.id === wanted ||
        candidate.label.replace(/ /g, "") === wanted.replace(/ /g, ""));
      if (!choice) {
        context.ui.notify(`Unknown approval mode "${wanted}". Choose one of: ${choices.map((c) => c.label.replace(/ /g, "")).join(", ")}.`, "error");
        return;
      }
      await chooseAfter(epoch, context, choice.id);
    },
  });

  pi.on("session_start", (_event, context) => {
    retireSession();
    const incoming = context.sessionManager.getSessionId() || undefined;
    // A fresh extension has no previous identity. Still revoke any grant an
    // older failed disposer left for this incoming session before showing UI.
    if (incoming) sessionYoloSet().delete(incoming);
    close();
    tui = undefined;
    theme = undefined;
    const at = epoch;
    ctx = context;
    sessionId = incoming;
    // A judge loaded before this extension has already published this
    // session's launch mode; one loaded after publishes it shortly.
    if (sessionId && judge?.sessionId === sessionId) {
      baseline = liveJudge();
      void Promise.resolve().then(() => restoreJudge(at));
    }
    if (restoredChoice(context.sessionManager.getBranch(), sessionId)?.yolo) {
      // After startup, so the dialog has a screen to open on.
      setTimeout(() => {
        offerYolo(at, context).catch(() => { /* declined by failure: yolo stays off */ });
      }, 0);
    }
    if (context.mode === "tui" && context.hasUI) {
      // A zero-row widget is how an extension without a footer reaches the
      // TUI, to mount its popover as a plain overlay it can remove exactly.
      try {
        context.ui.setWidget(WIDGET_KEY, (host, hostTheme) => {
          if (at === epoch && ctx === context) { tui = host; theme = hostTheme; }
          return { render: () => [], invalidate() {} };
        });
      } catch { /* A missing widget must not prevent authority initialization. */ }
    }
    paint();
  });

  // Moving within the tree keeps the live state (the indicator shows it) and
  // rewrites the new branch's record to match, so it neither silently changes
  // approval nor leaves a record behind for the next resume.
  pi.on("session_tree", () => {
    record();
  });

  pi.on("session_shutdown", (_event, context) => {
    retireSession();
    close();
    tui = undefined;
    theme = undefined;
    try { context.ui.setStatus(APPROVAL_INDICATOR, undefined); } catch { /* The TUI may already be gone. */ }
    try { if (context.mode === "tui") context.ui.setWidget(WIDGET_KEY, undefined); } catch { /* Independent best effort. */ }
  });
}
