import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Serialize extension-owned inline prompts.
 *
 * Pi currently lets a second inline UI call replace the first component
 * without settling its promise (earendil-works/pi#7007). Permission prompts
 * can arrive concurrently from the main agent and forwarded subagents, so an
 * orphaned prompt otherwise blocks the forwarding inbox indefinitely.
 *
 * Overlays bypass the queue because Pi supports stacking them and persistent
 * overlays must not block ordinary dialogs. Bypassing is safe for the invariant
 * this file defends: Pi's overlay path never touches the editor container that
 * inline components live in, so an overlay can neither orphan nor be orphaned
 * by an inline prompt. It does not repair Pi's overlay focus handling — an
 * inline prompt shown underneath an open overlay still steals focus, and
 * closing one hands focus back to the editor — which an extension cannot reach.
 *
 * Known gaps, all bounded by STALL_TIMEOUT_MS:
 * - Pi builds a separate, unwrapped UI context for extension *shortcut*
 *   handlers, so a shortcut-triggered prompt still bypasses this queue.
 * - Pi tracks nested prompt lifetimes for ui_prompt events, but its TUI does
 *   not stack and restore inline components. A prompt opened from inside a live
 *   prompt's callback therefore waits behind it until the stall bound rather
 *   than bypassing the queue and orphaning the outer prompt.
 * - ExtensionUIDialogOptions.timeout counts down from display, which is now
 *   dequeue time rather than call time. Queued asks cannot be withdrawn once
 *   their requester gives up. Active inline custom UIs are closed before a
 *   stalled/failed slot is handed on; their creators still own component resources
 *   until Pi has received the factory's result (including late async results).
 */

/**
 * How long one prompt may hold the queue before it is abandoned.
 *
 * Serializing makes this queue the single gate for every inline prompt in the
 * session, so one promise that never settles — through any gap above — would
 * otherwise stall every later prompt forever, which is worse than the bug being
 * fixed. On expiry the queue moves on *and* the caller's promise rejects: the
 * whole point of #7007 is that an unsettled prompt leaves its caller wedged, so
 * releasing the queue alone would still leave a forwarded ask holding
 * ForwardingManager.processing and its subagent inbox dead. Both consumers fail
 * closed on a throw — the forwarded path turns it into a denial written back to
 * the child, the local gate into a blocked tool call — so a rejection is the
 * signal that actually unwedges them.
 *
 * The bound matches the permission system's 10 minute forwarding timeout: past
 * that point a queued forwarded ask has already been abandoned anyway.
 */
const STALL_TIMEOUT_MS = 10 * 60 * 1000;

function stallError(): Error {
  const error = new Error(
    `Inline prompt did not settle within ${STALL_TIMEOUT_MS}ms; the prompt queue abandoned it.`,
  );
  error.name = "PromptQueueStallError";
  return error;
}

/** Structural view of the queue, so instances from separate module loads interoperate. */
interface PromptSerializer {
  enqueue<T>(operation: () => Promise<T>, cancel?: () => void): Promise<T>;
}

class PromptQueue implements PromptSerializer {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>, cancel?: () => void): Promise<T> {
    let release: () => void = () => {};
    const slot = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const previous = this.tail;
    // Claimed synchronously, so queue order is call order.
    this.tail = slot;

    const run = (): Promise<T> => new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        // Claim the outcome BEFORE cancelling: custom's done() resolves the
        // underlying operation, but a timeout must still reject its caller.
        settled = true;
        clearTimeout(timer);
        try { finish(); } finally { release(); }
      };
      const fail = (error: unknown): void => settle(() => {
        // Close the actual UI while we still own the slot. A close in the
        // caller's finally would be too late: it could clear the NEXT dialog.
        try { cancel?.(); }
        catch (cleanup) {
          error = new AggregateError([error, cleanup], `${String(error)}; prompt cleanup: ${String(cleanup)}`, { cause: error });
        }
        reject(error);
      });
      // The stall budget starts at display, never during a predecessor's wait.
      const timer = setTimeout(() => fail(stallError()), STALL_TIMEOUT_MS);
      // Never hold the process open for a prompt nobody is waiting on.
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        // Both handlers stay attached after expiry, so a late resolve/reject
        // cannot change the outcome or surface as an unhandled rejection.
        operation().then((value) => settle(() => resolve(value)), fail);
      } catch (error) { fail(error); }
    });

    // A slot resolves and never rejects; the second handler only guards against
    // a future change to that invariant.
    return previous.then(run, run);
  }
}

/**
 * Pi hands out a fresh UI context object on every extension rebind (reload,
 * session switch) and may re-import this module alongside it. Anchoring the
 * queue on a well-known symbol keeps one queue per process, so a rebind cannot
 * give a fresh, empty queue the right to replace a prompt the previous one
 * still has on screen.
 */
const QUEUE_KEY = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");

/**
 * Marks a function as already queued.
 *
 * The mark lives on the wrapper rather than on the UI context, because Pi
 * copies contexts by spread. A spread carries the wrapper functions themselves
 * but not a non-enumerable property on the container, so a context-level mark
 * would let a copy be wrapped a second time — and the outer wrapper would then
 * enqueue the inner one behind its own slot, deadlocking until the stall bound.
 * Marking the functions makes idempotence follow what was actually wrapped, and
 * makes a partly failed install retry only its remainder.
 */
const WRAPPED_KEY = Symbol.for("nixos-config.pi.ui-prompt-queue.wrapped.v1");

const globals = globalThis as unknown as Record<symbol, unknown>;

function sharedQueue(): PromptSerializer {
  const existing = globals[QUEUE_KEY] as PromptSerializer | undefined;
  if (existing) return existing;
  const queue = new PromptQueue();
  globals[QUEUE_KEY] = queue;
  return queue;
}

function isWrapped(value: unknown): boolean {
  if (typeof value !== "function") return false;
  return (value as unknown as Record<symbol, unknown>)[WRAPPED_KEY] === true;
}

function markWrapped<F extends object>(wrapper: F): F {
  Object.defineProperty(wrapper, WRAPPED_KEY, { value: true });
  return wrapper;
}

function queued<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
  queue: PromptSerializer,
): (...args: A) => Promise<R> {
  return markWrapped((...args: A) => queue.enqueue(() => call(...args)));
}

function installPromptQueue(ui: ExtensionUIContext): void {
  const queue = sharedQueue();

  // Bound in case Pi ever moves these off object literals onto a prototype.
  if (!isWrapped(ui.select)) ui.select = queued(ui.select.bind(ui), queue);
  if (!isWrapped(ui.confirm)) ui.confirm = queued(ui.confirm.bind(ui), queue);
  if (!isWrapped(ui.input)) ui.input = queued(ui.input.bind(ui), queue);
  if (!isWrapped(ui.editor)) ui.editor = queued(ui.editor.bind(ui), queue);

  if (!isWrapped(ui.custom)) {
    // `bind` erases the generic, so restore the declared signature.
    const custom = ui.custom.bind(ui) as ExtensionUIContext["custom"];
    const queuedCustom: ExtensionUIContext["custom"] = (factory, options) => {
      if (options?.overlay) return custom(factory, options);
      let cancel: (() => void) | undefined;
      const guardedFactory: typeof factory = (tui, theme, keybindings, done) => {
        let closed = false;
        const finish: typeof done = (value) => {
          if (closed) return;
          closed = true;
          done(value);
        };
        // No cancellation result escapes: the queue has already claimed the
        // rejection before invoking this. Invalidate all late done callbacks.
        cancel = () => finish(undefined as never);
        return factory(tui, theme, keybindings, finish);
      };
      return queue.enqueue(() => custom(guardedFactory, options), () => cancel?.());
    };
    ui.custom = markWrapped(queuedCustom);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // `hasUI` is not redundant with the mode check: it keeps the patch off
    // Pi's no-op UI context, a process-wide singleton shared by every session
    // that has no dialog surface.
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    installPromptQueue(ctx.ui);
  });
}
