import type { EventBus } from "@earendil-works/pi-coding-agent";
import { OverlayRequest } from "./overlay-request.js";

/**
 * Watches the permission system's public broadcasts so the detail pane can get
 * out of the way of a permission dialog. Why a pane in the way is a denial and
 * not merely a hidden dialog: README, "Approvals and the prompt queue".
 *
 * Two facts this file depends on and cannot check:
 * - `permissions:ui_prompt` is emitted SYNCHRONOUSLY by `LocalUserAuthorizer`
 *   before it calls the dialog, so a pane that closes here leaves an empty
 *   queue for the ask rather than a slot it must wait out.
 * - These channels carry no protocol version and consumers are told to tolerate
 *   shape drift, so payloads are read defensively -- and a watcher that
 *   threw inside a bus handler would break the dialog it exists to protect.
 */
export const PERMISSION_UI_PROMPT = "permissions:ui_prompt";
export const PERMISSION_DECISION = "permissions:decision";

/** One ask that is on screen now, as much of it as the broadcast carried. */
export interface PendingApproval {
  readonly requestId: string;
  /** Requesting worker's session id; absent when the parent asked for itself. */
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly surface?: string;
  readonly value?: string;
}
export interface ApprovalHandlers {
  /** A dialog is about to be shown: release anything holding the prompt queue. */
  onPrompt(pending: PendingApproval): void;
  /** Every shown ask has been decided or its UI operation has settled. */
  onIdle(): void;
}
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * How the detail pane stepped out of an approval dialog's way, kept across the
 * step itself.
 *
 * Floating, the pane only hides: it stays mounted, so the intent and the
 * component die together and there is nothing to remember. Docked, it is torn
 * down outright -- and `done()` settles `ui.custom` on a microtask, so the
 * mount's own cleanup runs long before the user answers the dialog. An intent
 * that cleanup clears is therefore always gone by the time the decision
 * arrives, and the pane never comes back. Keeping it here, where only `end()`
 * and an unmount of a merely HIDDEN pane can clear it, is what survives that
 * race.
 */
export class PaneYield {
  private state: "hidden" | "closed" | undefined;
  /** True while the pane is out of the way, however it got there. */
  get active(): boolean { return this.state !== undefined; }
  get closing(): boolean { return this.state === "closed"; }
  /** Claim the yield. False when the pane has already stepped aside, so the
   * second ask of a batch does not hide or close anything twice. */
  begin(how: "hidden" | "closed"): boolean {
    if (this.state) return false;
    this.state = how;
    return true;
  }
  /** Consume it: how the pane stepped aside, or undefined if it had not. */
  end(): "hidden" | "closed" | undefined {
    const was = this.state;
    this.state = undefined;
    return was;
  }
  /** The mount is gone. A pane that hid in place has nothing left to restore --
   * including one the user closed while it was hidden -- but a pane that closed
   * IN ORDER to yield keeps its intent, which is this type's whole reason to be. */
  unmounted(): void { if (this.state === "hidden") this.state = undefined; }
}

/**
 * Everything the yield protocol touches, so the protocol itself can live in one
 * function instead of being spelled out at the call site and then again, from
 * memory, in a test. Every member is read at handler time, never captured.
 */
export interface YieldHost {
  /** The overlay handle while the pane floats; undefined when it is docked. */
  overlay(): { setHidden(hidden: boolean): void } | undefined;
  /** Includes an opening request still waiting in the prompt queue. */
  open(): boolean;
  /** Cancels an opening request or settles a mounted pane's `ui.custom`. */
  close(): (() => void) | undefined;
  /** How many asks are on screen right now. */
  pending(): number;
  /** Build the docked pane again. */
  reopen(): void;
  /** Run this past the closing mount's own teardown -- `setTimeout(_, 0)` in
   * production, whatever a test can drive by hand. */
  defer(task: () => void): void;
}
/**
 * May the pane mount right now?
 *
 * `showExtensionCustom` clears the editor container without settling what was
 * in it, so mounting over a live permission dialog abandons that ask -- which
 * the forwarding path turns into a denial written back to the child. `pending`
 * is an ask on screen; an active yield is the window after a docked pane has
 * closed to step aside but before the decision lands, where nothing is on
 * screen yet and the dialog is still coming.
 */
export const mountable = (yielding: PaneYield, pending: number): boolean => !yielding.active && !pending;

/** One ui.custom attempt for the detail pane. See `OverlayRequest` for the
 * settlement and overlay-coordination contract both harness panels share. */
export class PaneRequest extends OverlayRequest<void> {
  constructor(beforeSettle: () => void = () => {}) { super(beforeSettle, undefined); }

  mount(done: () => void, yielding: PaneYield, pending: number): boolean {
    // An ask that landed while this attempt was queued must find the prompt
    // queue free, so re-arm the yield before settling empty-handed.
    return this.attach(done, !mountable(yielding, pending),
      () => { if (pending) yielding.begin("closed"); });
  }
}

/**
 * How the pane steps out of a permission dialog's way and comes back.
 *
 * Floating, it hides in place and is simply shown again. Docked, it holds the
 * launcher's prompt queue, so it must close outright -- and reopening is
 * deferred, because `done()` settles `ui.custom` on a microtask and the mount's
 * own teardown has to finish first. A fresh ask landing in that gap re-arms the
 * yield rather than reopening over it, which would hold the queue again.
 */
export const paneYieldHandlers = (yielding: PaneYield, host: YieldHost): ApprovalHandlers => ({
  onPrompt: () => {
    const overlay = host.overlay();
    if (overlay) { if (yielding.begin("hidden")) overlay.setHidden(true); return; }
    const close = host.close();
    if (close && yielding.begin("closed")) close();
  },
  onIdle: () => {
    // A queued attempt may outlive even the decision. Do not consume its
    // reopen intent until its own finally has run; that teardown calls us again.
    if (yielding.closing && host.open()) return;
    const how = yielding.end();
    if (!how) return;
    if (how === "hidden") { host.overlay()?.setHidden(false); return; }
    host.defer(() => {
      if (!mountable(yielding, host.pending())) { yielding.begin("closed"); return; }
      host.reopen();
    });
  },
});

export class ApprovalWatch {
  /** Asks whose dialog/decision has not settled, by request id. */
  private readonly shown = new Map<string, PendingApproval>();
  constructor(private readonly handlers: ApprovalHandlers) {}
  get pending(): number { return this.shown.size; }
  /** Ask on screen for a child session, if that child is the one being asked about. */
  forSession(sessionId: string | undefined): PendingApproval | undefined {
    if (!sessionId) return undefined;
    for (const value of this.shown.values()) if (value.sessionId === sessionId) return value;
    return undefined;
  }
  /** Subscribe to the PARENT bus, which is where a forwarded ask is adjudicated. */
  bind(bus: EventBus): () => void {
    const off = [bus.on(PERMISSION_UI_PROMPT, (data) => this.prompt(data)),
      bus.on(PERMISSION_DECISION, (data) => this.complete(data)),
      // A UI exception/timeout need not produce a matching decision. This is
      // observation only: no permission verdict is inferred from settlement.
      bus.on("managed-permissions:ui_prompt_end:v1", (data) => this.complete(data))];
    // Forgetting the asks too: unbound, no decision can ever arrive to clear
    // them, and a watch that still reports `pending` would refuse every mount
    // for the rest of the process.
    return () => { for (const unsubscribe of off) unsubscribe(); this.shown.clear(); };
  }
  private prompt(data: unknown): void {
    const event = data as Record<string, unknown> | undefined;
    const requestId = str(event?.requestId);
    if (!requestId || this.shown.has(requestId)) return;
    const forwarding = event?.forwarding as Record<string, unknown> | null | undefined;
    const pending: PendingApproval = { requestId,
      ...(str(forwarding?.requesterSessionId) ? { sessionId: str(forwarding?.requesterSessionId)! } : {}),
      ...(str(forwarding?.requesterAgentName) ?? str(event?.agentName)
        ? { agentName: (str(forwarding?.requesterAgentName) ?? str(event?.agentName))! } : {}),
      ...(str(event?.surface) ? { surface: str(event?.surface)! } : {}),
      ...(str(event?.value) ? { value: str(event?.value)! } : {}) };
    this.shown.set(requestId, pending);
    // A throwing observer must not take the dialog down with it.
    try { this.handlers.onPrompt(pending); } catch { /* the dialog still shows */ }
  }
  private complete(data: unknown): void {
    const requestId = str((data as Record<string, unknown> | undefined)?.requestId);
    // Most decisions never reach a dialog (policy allow/deny, session grants,
    // authorizer links). Only the ones we saw prompt can end a yield.
    if (!requestId || !this.shown.delete(requestId) || this.shown.size > 0) return;
    try { this.handlers.onIdle(); } catch { /* nothing left to release */ }
  }
}
