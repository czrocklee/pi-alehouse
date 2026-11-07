/**
 * Approval indicator: `MODE` in the footer's right corner, and the
 * bottom-right popover that changes it.
 *
 * Modes are the loaded model judge's own (jev, under pi-alehouse) plus yolo;
 * plain pi loads no judge and offers only manual and yolo:
 *
 * - manual     the judge only observes; every ask reaches the human
 * - JUDGE      the judge decides the main session's asks
 * - JUDGE+sub  ...and the asks subagents forward to it
 * - yolo       every ask is allowed without review, in-process subagents included
 *
 * The judge keeps sole ownership of its mode: this extension renders what the
 * judge publishes and asks it to change (lib/approval-protocol.ts). Yolo is not
 * a judge mode. It is upstream permission-system yolo, scoped to this session
 * by the managed authority (src/authority/managed-session-yolo.ts): asks
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
 * moves to is made to agree with the live state. Alehouse's shared settings
 * store may supply a preference when there is no same-session branch choice;
 * it never supplies a live grant. User choices can be staged there until exit.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
  APPROVAL_INDICATOR,
  FOOTER_INDICATOR_CLICK_EVENT,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  type FooterIndicatorClick,
} from "../shared/overlay-protocol.mjs";
import {
  focusOrigin,
  focusRevealed,
  joinPopoverStack,
  stackedOverlayOptions,
  type StackMember,
} from "../shared/popover-stack.mjs";
import {
  settingsStoreForSession,
  type PersistentScope,
  type SettingsStore,
} from "../shared/settings-store.mjs";
import {
  APPROVAL_JUDGE_STATE_EVENT,
  APPROVAL_SET_JUDGE_EVENT,
  judgeModeRank,
  sessionYoloSet,
  type JudgeMode,
  type JudgeName,
  type JudgeState,
  type SetJudgeMode,
} from "./lib/approval-protocol.ts";

import {
  APPROVAL_ENTRY,
  CHOICE_RANK,
  CONFIRM_ROWS,
  YOLO_WARNING,
  approvalChoices,
  confirmationFor,
  confirmDialog,
  currentChoice,
  judgeModeFor,
  narrowerJudge,
  restoredChoice,
  sameJudge,
  type ChoiceId,
  type RecordedChoice,
} from "./lib/approval-selection.ts";
import { ApprovalPopover, approvalStatus } from "./lib/approval-view.ts";

export {
  APPROVAL_ENTRY,
  CONFIRM_ROWS,
  approvalChoices,
  confirmationFor,
  currentChoice,
  narrowerJudge,
  restoredChoice,
  type Choice,
  type ChoiceId,
  type RecordedChoice,
} from "./lib/approval-selection.ts";
export {
  ApprovalPopover,
  approvalStatus,
  type ApprovalPopoverOptions,
} from "./lib/approval-view.ts";

const WIDGET_KEY = "approval-mode";
const PERMISSION_UI_PROMPT = "permissions:ui_prompt";
const POPOVER_WIDTH = 60;

export default function approvalMode(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let judge: JudgeState | undefined;
  /** The judge's launch mode for this session: its first publish for it. */
  let baseline: JudgeMode | undefined;
  /** Advances per session, so deferred restore work for an old one is dropped. */
  let epoch = 0;
  /** A newer deliberate choice also retires deferred startup work/dialogs. */
  let choiceRevision = 0;
  let requestingJudge = false;
  let startup:
    | {
        at: number;
        revision: number;
        context: ExtensionContext;
        recorded?: RecordedChoice;
        preference?: ChoiceId;
        judgeDone: boolean;
        bindingPending: boolean;
      }
    | undefined;
  let yolo = false;
  let tui: TUI | undefined;
  let theme: Theme | undefined;
  let open: { component: ApprovalPopover; member: StackMember; handle?: OverlayHandle } | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let savingDefault: { at: number } | undefined;

  /** Retire authority and awaited confirmations before touching any UI. */
  const retireSession = (): void => {
    epoch++;
    choiceRevision++;
    startup = undefined;
    savingDefault = undefined;
    if (sessionId) sessionYoloSet().delete(sessionId);
    sessionId = undefined;
    yolo = false;
    baseline = undefined;
    ctx = undefined;
  };

  const paint = (): void => {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setStatus(
        APPROVAL_INDICATOR,
        approvalStatus(ctx.ui.theme, liveJudge() ? judge : undefined, yolo),
      );
    } catch {
      /* The indicator is presentation; approval state is unaffected. */
    }
    try {
      tui?.requestRender();
    } catch {
      /* Rendering cannot interrupt a live state change. */
    }
  };

  const liveJudge = (): JudgeMode | undefined =>
    judge && judge.sessionId === sessionId
      ? { mode: judge.mode, includeSubagents: judge.includeSubagents }
      : undefined;
  const actualChoice = (): ChoiceId => currentChoice(liveJudge(), yolo);
  const boundJudgeName = (): JudgeName | undefined => (liveJudge() ? judge?.judge : undefined);
  const currentContext = (at: number, context: ExtensionContext): boolean =>
    at === epoch && !!sessionId && context.sessionManager.getSessionId() === sessionId;
  const notify = (
    context: ExtensionContext | undefined,
    message: string,
    level: "info" | "warning" | "error",
  ): void => {
    try {
      context?.ui.notify(message, level);
    } catch {
      /* Presentation cannot interrupt authorization or staging. */
    }
  };
  const sharedStore = (): SettingsStore | undefined =>
    sessionId ? settingsStoreForSession(sessionId) : undefined;

  /** Stage only an explicit user choice, independently of live authorization. */
  const stageChoice = (store: SettingsStore, scope: PersistentScope, choice: ChoiceId): void => {
    try {
      store.stage(scope, ["approval"], choice);
      notify(
        ctx,
        `Approval: ${choice} will be the ${scope === "global" ? "global" : "project"} default after normal exit.`,
        "info",
      );
    } catch (error) {
      notify(
        ctx,
        `Approval: the live mode is unchanged by this save failure; the preference could not be staged (${String(error)}).`,
        "warning",
      );
    }
  };

  /**
   * Make the current branch's record say what is live. The branch, not the
   * last thing written, is the comparison: after /tree the two can disagree.
   * Observers treat no record as launch state. Explicit choices still create
   * evidence when equal to launch, so later preferences cannot replace them.
   * A failed write is said out loud; it cannot fail open, because a stale
   * yolo record is only ever offered back behind a confirmation.
   */
  const record = (explicit = false): void => {
    if (!ctx || !sessionId) return;
    const live: RecordedChoice = { yolo, ...(liveJudge() ? { judge: liveJudge() } : {}) };
    try {
      const existing = restoredChoice(ctx.sessionManager.getBranch(), sessionId);
      const recorded = existing ?? { yolo: false, judge: baseline };
      if (
        (!explicit || existing) &&
        recorded.yolo === live.yolo &&
        sameJudge(recorded.judge, live.judge)
      )
        return;
      pi.appendEntry(APPROVAL_ENTRY, { sessionId, ...live });
    } catch (error) {
      try {
        ctx.ui.notify(
          `Approval: this change is live but could not be recorded in the session (${String(error)}).`,
          "warning",
        );
      } catch {
        /* best effort */
      }
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
    requestingJudge = true;
    try {
      pi.events.emit(APPROVAL_SET_JUDGE_EVENT, request);
    } finally {
      requestingJudge = false;
    }
    return request.applied;
  };

  /** Apply a choice the user has already confirmed if it widens anything. */
  const choose = (id: ChoiceId, keepOpen = false): void => {
    if (!ctx || !sessionId) return;
    choiceRevision++;
    if (id === "yolo") {
      if (!yolo && setYolo(true)) notify(ctx, YOLO_WARNING, "warning");
    } else {
      const wasYolo = yolo;
      setYolo(false);
      if (liveJudge()) {
        if (!requestJudge(judgeModeFor(id)))
          notify(ctx, `The ${judge!.judge} judge did not take the change.`, "warning");
      }
      if (wasYolo) notify(ctx, `Approval: yolo is off; ${actualChoice()}.`, "info");
    }
    // Always, not only when something changed: this also revokes a stale
    // record left on the branch. Only this user-origin path stages a preference.
    record(true);
    // Alehouse keeps the menu open so saving a default is a visible next action.
    // Commands and ordinary Pi retain their apply-and-close behavior.
    if (!keepOpen) close();
    try {
      const store = sharedStore();
      if (store && store.scope !== "session") stageChoice(store, store.scope, actualChoice());
    } catch (error) {
      notify(
        ctx,
        `Approval is live, but its preference could not be staged (${String(error)}).`,
        "warning",
      );
    }
  };

  const close = (): void => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = undefined;
    const closing = open,
      host = tui;
    open = undefined; // Retained components/callbacks lose ownership even if hide fails.
    if (!closing) return;
    for (const cleanup of [
      () => closing.handle?.hide(),
      () => closing.member.leave(),
      () => host?.requestRender(),
    ]) {
      try {
        cleanup();
      } catch {
        /* Attempt every presentation cleanup independently. */
      }
    }
  };

  const mount = (): void => {
    if (!open || !tui) return;
    const host = tui;
    const mounted = open;
    const openedFrom = focusOrigin(host);
    mounted.handle = host.showOverlay(
      mounted.component,
      stackedOverlayOptions(mounted.member, {
        width: POPOVER_WIDTH,
        minWidth: 36,
        // Every choice plus the frame and a confirmation warning: the popover
        // waits off screen rather than be clipped with an armed row clickable.
        minRows:
          approvalChoices(boundJudgeName()).length + 3 + CONFIRM_ROWS + (sharedStore() ? 4 : 0),
        onReveal: () => {
          if (open === mounted && mounted.handle) focusRevealed(host, mounted.handle, openedFrom);
        },
      }),
    );
    host.requestRender();
  };

  const openPopover = (): void => {
    if (open || savingDefault?.at === epoch || !tui || !theme || tui.mode !== "fullscreen") return;
    const member = joinPopoverStack(tui);
    const host = tui,
      at = epoch;
    const live = (): boolean => at === epoch && open?.member === member;
    const component = new ApprovalPopover({
      theme,
      choices: () => approvalChoices(boundJudgeName()),
      current: actualChoice,
      warning: (id) => confirmationFor(id, boundJudgeName(), actualChoice()),
      // A failed hide can leave an armed old component on the renderer. It
      // must neither approve for a new session nor close that session's UI.
      choose: (id) => {
        if (live()) choose(id, !!sharedStore());
      },
      ...(sharedStore()
        ? {
            save: (scope: PersistentScope) => {
              if (!live() || !ctx) return;
              const context = ctx;
              close(); // Hide this raw overlay before the standard Pi confirmation.
              void saveDefault(context, scope).catch((error: unknown) => {
                if (currentContext(at, context))
                  notify(
                    context,
                    `Approval preference could not be saved (${String(error)}).`,
                    "warning",
                  );
              });
            },
            canSaveWorkspace: () => sharedStore()?.canWriteWorkspace() === true,
            saveScope: () => sharedStore()?.scope ?? "session",
          }
        : {}),
      close: () => {
        if (live()) close();
      },
      requestRender: () => {
        if (live()) host.requestRender();
      },
      onRender: (height) => {
        if (live()) member.measure(height);
      },
    });
    open = { component, member };
    mount();
  };

  /** Pi's confirm dialog for a widening change; narrowing needs none. */
  const confirmed = async (context: ExtensionContext, id: ChoiceId): Promise<boolean> => {
    if (!confirmationFor(id, boundJudgeName(), actualChoice())) return true;
    if (!context.hasUI) return false;
    const dialog = confirmDialog(id, boundJudgeName());
    return (await context.ui.confirm(dialog.title, dialog.text)) === true;
  };

  /**
   * Apply a choice once its dialogs are answered -- only if the session they
   * were opened for is still the live one. An answer that outlives a session
   * switch or shutdown must not grant anything to either session.
   */
  const chooseAfter = async (
    at: number,
    context: ExtensionContext,
    id: ChoiceId,
  ): Promise<void> => {
    const revision = choiceRevision;
    if (!currentContext(at, context)) return;
    const neededConfirmation = !!confirmationFor(id, boundJudgeName(), actualChoice());
    if (
      !(await confirmed(context, id)) ||
      !currentContext(at, context) ||
      revision !== choiceRevision
    )
      return;
    // A queued startup narrowing may have run during the await, turning an
    // initially equal/narrowing pick into a widening one. It now needs consent.
    if (!neededConfirmation && confirmationFor(id, boundJudgeName(), actualChoice())) {
      if (
        !(await confirmed(context, id)) ||
        !currentContext(at, context) ||
        revision !== choiceRevision
      )
        return;
    }
    choose(id);
  };

  /** Regular renderer, or the command without the popover: Pi's own dialogs. */
  const chooseWithDialogs = async (context: ExtensionContext): Promise<void> => {
    const at = epoch,
      revision = choiceRevision;
    if (!context.hasUI || !currentContext(at, context)) return;
    const choices = approvalChoices(boundJudgeName());
    const current = actualChoice();
    const picked = await context.ui.select(
      `Approval (now ${current})`,
      choices.map((choice) => `${choice.label} — ${choice.detail}`),
    );
    if (!currentContext(at, context) || revision !== choiceRevision) return;
    const choice = choices.find((candidate) => picked?.startsWith(`${candidate.label} — `));
    if (choice) await chooseAfter(at, context, choice.id);
  };

  const toggle = (): void => {
    if (savingDefault?.at === epoch) return;
    if (open) return close();
    if (tui?.mode === "fullscreen") return openPopover();
    if (ctx?.hasUI) {
      const context = ctx;
      chooseWithDialogs(context).catch((error: unknown) => {
        try {
          context.ui.notify(`Approval selection failed: ${String(error)}`, "error");
        } catch {
          /* best effort */
        }
      });
    }
  };

  const startupIsCurrent = (restore: NonNullable<typeof startup>): boolean =>
    startup === restore &&
    currentContext(restore.at, restore.context) &&
    restore.revision === choiceRevision;

  /** Branch records retain the launch cap. A shared preference wider than the
   * launch is only a request for a deliberate, session-local confirmation. */
  const restoreJudge = async (
    restore: NonNullable<typeof startup>,
    allowDialog = true,
  ): Promise<void> => {
    if (
      !startupIsCurrent(restore) ||
      restore.bindingPending ||
      restore.judgeDone ||
      !baseline ||
      !liveJudge()
    )
      return;
    // Binding may narrow synchronously, but consent dialogs wait until startup
    // has finished mounting the UI. Do not consume their one-shot intent yet.
    const preference = restore.preference;
    if (
      !restore.recorded?.judge &&
      preference &&
      preference !== "yolo" &&
      judgeModeRank(judgeModeFor(preference)) > judgeModeRank(baseline) &&
      !allowDialog
    )
      return;
    restore.judgeDone = true; // Repeated publications cannot open another dialog.
    if (restore.recorded?.judge) {
      const target = narrowerJudge(restore.recorded.judge, baseline);
      if (!sameJudge(target, liveJudge())) requestJudge(target);
      return;
    }
    if (!preference || preference === "yolo") return;
    const target = judgeModeFor(preference);
    if (judgeModeRank(target) > judgeModeRank(baseline)) {
      if (!(await confirmed(restore.context, preference)) || !startupIsCurrent(restore)) return;
    }
    if (startupIsCurrent(restore) && !sameJudge(target, liveJudge()) && !requestJudge(target)) {
      notify(
        restore.context,
        `Approval: the ${boundJudgeName()} judge did not take the saved preference.`,
        "warning",
      );
    }
  };

  /** Yolo is never inherited, even from a preference: every session asks anew. */
  const offerYolo = async (restore: NonNullable<typeof startup>): Promise<void> => {
    const context = restore.context;
    if (!startupIsCurrent(restore) || !context.hasUI) return;
    const resumed = restore.recorded?.yolo === true;
    const accepted = await context.ui.confirm(
      resumed ? "Resume yolo for this session?" : "Turn on yolo for this session?",
      `${resumed ? "Yolo was on when this session was last used." : "Your saved preference requests yolo; a new session needs your explicit confirmation."} ${YOLO_WARNING}`,
    );
    if (!startupIsCurrent(restore) || yolo) return;
    if (accepted === true && setYolo(true)) notify(context, YOLO_WARNING, "warning");
    record();
  };

  /** Saving a default changes neither the live mode nor the Owner-managed
   * shared scope. The exact displayed choice/path must still be current. */
  const saveCurrentDefault = async (context: ExtensionContext, wanted: string): Promise<void> => {
    const at = epoch;
    if (!currentContext(at, context)) return;
    if (!context.hasUI) {
      notify(context, "Saving approval defaults requires a UI confirmation.", "warning");
      return;
    }
    const store = sharedStore();
    if (!store) {
      notify(context, "Approval preferences are available only in an Alehouse session.", "warning");
      return;
    }
    let scope = wanted;
    if (!scope) {
      const selected = await context.ui.select("Save approval default for", [
        "All projects",
        "This project",
      ]);
      scope =
        selected === "All projects"
          ? "global"
          : selected === "This project"
            ? "workspace"
            : (selected ?? "");
      if (!currentContext(at, context) || sharedStore() !== store) return;
      if (!scope) return;
    }
    if (scope !== "global" && scope !== "workspace") {
      notify(context, "Use /approval save global|workspace.", "error");
      return;
    }
    if (scope === "workspace" && !store.canWriteWorkspace()) {
      notify(context, "Approval preferences cannot be saved to an untrusted workspace.", "warning");
      return;
    }
    const path = store.paths[scope],
      choice = actualChoice(),
      revision = choiceRevision;
    const accepted = await context.ui.confirm(
      `Save ${choice} as ${scope === "global" ? "global" : "project"} approval default?`,
      `approval: ${choice}\nFile: ${path}\nSaved on normal exit.\n\n` +
        "New sessions use this default; existing sessions keep their recorded choices. Other settings stay unchanged.\n" +
        "This saves a preference, not permission. Wider judge modes need confirmation at startup; " +
        "yolo always needs a new explicit confirmation in every session.\n" +
        (scope === "workspace"
          ? "Saving may create a project config file visible to Git and cause a project-trust prompt in a future Pi session. " +
            "Saving a preference does not grant project trust."
          : "Project defaults can still override this here."),
    );
    if (!currentContext(at, context) || sharedStore() !== store || accepted !== true) return;
    if (
      revision !== choiceRevision ||
      choice !== actualChoice() ||
      path !== store.paths[scope] ||
      (scope === "workspace" && !store.canWriteWorkspace())
    ) {
      notify(
        context,
        "Approval or its save destination changed while confirming; nothing was staged. Try again.",
        "warning",
      );
      return;
    }
    stageChoice(store, scope, actualChoice());
  };

  const saveDefault = async (context: ExtensionContext, wanted: string): Promise<void> => {
    if (!currentContext(epoch, context)) return;
    if (savingDefault?.at === epoch) {
      notify(context, "Finish the current save dialog first.", "info");
      return;
    }
    close(); // The command and menu paths both yield before opening a dialog.
    const pending = { at: epoch };
    savingDefault = pending;
    try {
      await saveCurrentDefault(context, wanted);
    } finally {
      if (savingDefault === pending) savingDefault = undefined;
    }
  };

  pi.events.on(APPROVAL_JUDGE_STATE_EVENT, (data) => {
    const state = data as JudgeState | undefined;
    if (!state || state.judge !== "jev" || (state.mode !== "shadow" && state.mode !== "enforce"))
      return;
    state.shown = true;
    const previous = liveJudge(),
      previousName = boundJudgeName();
    judge = {
      judge: state.judge,
      mode: state.mode,
      includeSubagents: state.mode === "enforce" && state.includeSubagents === true,
      ...(typeof state.sessionId === "string" ? { sessionId: state.sessionId } : {}),
      shown: true,
    };
    if (sessionId && judge.sessionId === sessionId) {
      const restore = startup;
      if (!baseline || (restore?.bindingPending && !requestingJudge)) {
        // A fresh publication during startup supersedes cached same-ID state,
        // even when SDK dispatch yields before a judge loaded second publishes.
        // Only this first publication is launch; later changes retire dialogs.
        if (restore) restore.bindingPending = false;
        baseline = liveJudge();
        if (restore)
          void restoreJudge(restore, false).catch((error: unknown) => {
            if (startupIsCurrent(restore))
              notify(restore.context, `Approval restore failed: ${String(error)}`, "warning");
          });
      } else {
        // External user changes also invalidate a pending preference dialog.
        if (
          !requestingJudge &&
          (!sameJudge(previous, liveJudge()) || previousName !== boundJudgeName())
        )
          choiceRevision++;
        // A provisional startup clamp is not session evidence. The final
        // restoration/user change is recorded, but never stages preferences.
        if (!requestingJudge || !restore?.bindingPending) record();
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

  // Cooperatively step aside during agent panel settlement, keep the column place,
  // then return. Current Pi's ui.custom completion removes its own overlay entry.
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
    description:
      "Choose approval; /approval save global|workspace saves the current default on normal exit",
    handler: async (args, context) => {
      const wanted = args.trim().toLowerCase();
      const action = wanted.split(/\s+/, 1)[0];
      if (action === "save") {
        try {
          await saveDefault(context, wanted.slice(action.length).trim());
        } catch (error) {
          notify(context, `Approval default could not be saved (${String(error)}).`, "warning");
        }
        return;
      }
      if (!wanted) {
        if (tui?.mode === "fullscreen") {
          toggle();
          return;
        }
        await chooseWithDialogs(context);
        return;
      }
      const choices = approvalChoices(boundJudgeName());
      const choice = choices.find(
        (candidate) =>
          candidate.id === wanted || candidate.label.replace(/ /g, "") === wanted.replace(/ /g, ""),
      );
      if (!choice) {
        context.ui.notify(
          `Unknown approval mode "${wanted}". Choose one of: ${choices.map((c) => c.label.replace(/ /g, "")).join(", ")}.`,
          "error",
        );
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
    let recorded: RecordedChoice | undefined, preference: ChoiceId | undefined;
    try {
      recorded = restoredChoice(context.sessionManager.getBranch(), sessionId);
      // A valid same-session branch record always wins, even one without a judge.
      if (!recorded) {
        const saved = sharedStore()?.effective().approval;
        if (saved && Object.hasOwn(CHOICE_RANK, saved)) preference = saved;
      }
    } catch (error) {
      // A failed branch read must not fall through to a potentially wider preference.
      notify(context, `Approval preference could not be restored (${String(error)}).`, "warning");
    }
    const restore = {
      at,
      revision: choiceRevision,
      context,
      recorded,
      preference,
      judgeDone: false,
      bindingPending: true,
    };
    startup = restore;
    // A cached same-ID state may be either the fresh launch of a judge loaded
    // first or stale state from the previous start. Do not restore from it in
    // a microtask: SDK startup dispatch can yield before judge-second publishes.
    // Use the first fresh publication, or this cache after the startup window.
    if (sessionId && judge?.sessionId === sessionId) {
      baseline = liveJudge();
      const desired =
        recorded?.judge ??
        (preference && preference !== "yolo" ? judgeModeFor(preference) : undefined);
      // Cache may be a fresh judge-first launch or stale same-ID state. Clamp
      // to manual before exposing the session, without treating this cache as
      // the final launch cap. A fresh judge-second publication still binds it.
      if (desired && baseline && judgeModeRank(desired) < judgeModeRank(baseline)) {
        requestJudge({ mode: "shadow", includeSubagents: false });
      }
    }
    // After the startup dispatch, so dialogs have a screen and a normally
    // loaded judge has bound. Missing judges must not resurrect a preference
    // (or its dialog) on an unrelated later publication.
    setTimeout(() => {
      restore.bindingPending = false;
      if (!startupIsCurrent(restore)) return;
      if (baseline) {
        // Judge-first has no later publication. Its cached launch is now usable;
        // branch restoration is synchronous before any yolo confirmation opens.
        restoreJudge(restore).catch((error: unknown) => {
          if (startupIsCurrent(restore))
            notify(context, `Approval restore failed: ${String(error)}`, "warning");
        });
      }
      if (preference && preference !== "yolo" && !baseline) {
        restore.judgeDone = true;
        if (preference !== "manual")
          notify(
            context,
            `Approval preference ${preference} was not applied: no judge is available.`,
            "warning",
          );
      }
      if (recorded?.yolo || preference === "yolo") {
        offerYolo(restore).catch(() => {
          /* declined by failure: yolo stays off */
        });
      }
    }, 0);
    if (context.mode === "tui" && context.hasUI) {
      // A zero-row widget is how an extension without a footer reaches the
      // TUI, to mount its popover as a plain overlay it can remove exactly.
      try {
        context.ui.setWidget(WIDGET_KEY, (host, hostTheme) => {
          if (at === epoch && ctx === context) {
            tui = host;
            theme = hostTheme;
          }
          return { render: () => [], invalidate() {} };
        });
      } catch {
        /* A missing widget must not prevent authority initialization. */
      }
    }
    paint();
  });

  // Moving within the tree keeps the live state (the indicator shows it) and
  // rewrites the new branch's record to match, so it neither silently changes
  // approval nor leaves a record behind for the next resume.
  pi.on("session_tree", () => {
    choiceRevision++; // Navigation keeps live approval, not a pending startup request.
    record();
  });

  pi.on("session_shutdown", (_event, context) => {
    retireSession();
    close();
    tui = undefined;
    theme = undefined;
    try {
      context.ui.setStatus(APPROVAL_INDICATOR, undefined);
    } catch {
      /* The TUI may already be gone. */
    }
    try {
      if (context.mode === "tui") context.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* Independent best effort. */
    }
  });
}
