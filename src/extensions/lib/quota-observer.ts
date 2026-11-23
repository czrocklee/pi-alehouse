import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  codexCredits,
  codexCreditsFromHeaders,
  codexDisplayFromHeaders,
  codexDisplayFromStream,
  codexRateLimitsEvent,
  isCodexQuotaSource,
  quotaReadingsFromHeaders,
  quotaReadingsFromStream,
  type CodexCredits,
  type CodexDisplayUpdate,
  type CodexReading,
} from "./codex-quota.ts";

type Display = (
  provider: string,
  update: CodexDisplayUpdate | undefined,
  credits?: CodexCredits,
) => void;
type Listener = { display?: Display };
type Subscription = { listener: Listener; activation?: symbol };
type Binding = { sessions: Map<string, Subscription[]>; detach: () => boolean };
export type QuotaReading = {
  provider: string;
  /** Only for HTTP responses that name a different provider than the dispatch. */
  responseProvider?: string;
  observedAt: number;
  windows: CodexReading[];
};

// The parent loads the generated footer; child assembly imports source. Both
// copies must share one wrapper per host runtime.
const sharedKey = Symbol.for("pi-alehouse:quota-observer:v1");
const readingKey = Symbol.for("pi-alehouse:quota-reading:v1");
const globals = globalThis as {
  [sharedKey]?: { runtimes: WeakMap<ModelRuntime, Binding> };
  [readingKey]?: (reading: QuotaReading) => void;
};

function publishReading(
  provider: string,
  observedAt: number,
  read: () => CodexReading[],
  responseProvider?: string,
) {
  try {
    // Resolve on receipt: a trusted consumer can register after session start.
    const sink = globals[readingKey];
    if (typeof sink !== "function" || !(observedAt > 0 && Number.isFinite(observedAt))) return;
    const windows = read();
    if (windows.length === 0) return;
    const result: unknown = sink({
      provider,
      observedAt,
      windows,
      ...(responseProvider !== undefined && { responseProvider }),
    });
    // The ABI is synchronous. Even an accidental async rejection is isolated
    // without delaying the provider or inspecting arbitrary thenables.
    if (result instanceof Promise) void result.catch(() => {});
  } catch {
    /* A consumer failure must not affect the request or the local display. */
  }
}

function validProvider(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\p{Cc}]/u.test(value);
}

function runtimeOf(ctx: ExtensionContext): ModelRuntime | undefined {
  // Same SDK boundary as the orchestration model bridge. `ctx.model` isn’t the
  // dispatch and after_provider_response intentionally omits the actual model.
  return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime } | undefined)?.runtime;
}

/** A request-scoped observer: an unrelated session or delayed callback cannot
 * borrow the currently selected model, or another session's subscription. */
export function bindQuotaResponses(runtime: ModelRuntime, sessionId: string, listener: Listener) {
  const { runtimes } = (globals[sharedKey] ??= { runtimes: new WeakMap() });
  let binding = runtimes.get(runtime);
  if (!binding) {
    const original = runtime.streamSimple;
    if (typeof original !== "function") return;
    const sessions = new Map<string, Subscription[]>();
    const ownMethod = Object.getOwnPropertyDescriptor(runtime, "streamSimple");
    const wrapped: ModelRuntime["streamSimple"] = function (
      this: ModelRuntime,
      model,
      context,
      options,
    ) {
      // Session IDs are scoped to the bound runtime. A borrowed method keeps
      // its original receiver and options, without observation.
      const session = this === runtime ? options?.sessionId : undefined;
      const owner = session ? sessions.get(session)?.at(-1) : undefined;
      const activation = owner?.activation;
      if (!owner || !activation || !isCodexQuotaSource(model) || options?.disableContinuation)
        return original.call(this, model, context, options);
      // Capture at physical dispatch before an alias can rewrite to the native
      // transport. Never identify a sample from credentials, context or UI.
      const { provider, id, api } = model;
      if (!validProvider(provider) || typeof id !== "string" || !id)
        return original.call(this, model, context, options);
      const current = () => owner.activation === activation;
      return original.call(this, model, context, {
        ...options,
        onResponse(response, actual) {
          try {
            if (current() && actual?.api === api && actual.id === id) {
              const reported = actual.provider;
              if (validProvider(reported)) {
                const at = Date.now() / 1_000;
                const matches = reported === provider;
                // The HTTP response belongs to this request, but a relabelled
                // provider isn't proof of account identity. Preserve both labels
                // for the consumer and leave the local cache untouched.
                publishReading(
                  provider,
                  at,
                  () => quotaReadingsFromHeaders(response.headers, at),
                  matches ? undefined : reported,
                );
                if (matches && current())
                  owner.listener.display?.(
                    provider,
                    codexDisplayFromHeaders(response.headers, at),
                    codexCreditsFromHeaders(response.headers),
                  );
              }
            }
          } catch {
            /* Ignore optional observation errors; original hooks still run. */
          }
          return options?.onResponse?.(response, actual);
        },
        onProviderStreamEvent(data, actual) {
          try {
            // An alias can pass through a native stream event without
            // restoring the physical provider. Do not assign it to either.
            if (
              current() &&
              actual?.api === api &&
              actual.id === id &&
              actual.provider === provider
            ) {
              const limits = codexRateLimitsEvent(data);
              if (limits) {
                const at = Date.now() / 1_000;
                publishReading(provider, at, () => quotaReadingsFromStream(limits.rate_limits, at));
                if (current())
                  owner.listener.display?.(
                    provider,
                    codexDisplayFromStream(limits.rate_limits),
                    codexCredits(limits.credits),
                  );
              }
            }
          } catch {
            /* Ignore optional observation errors; original hooks still run. */
          }
          return options?.onProviderStreamEvent?.(data, actual);
        },
      });
    };
    runtime.streamSimple = wrapped;
    binding = {
      sessions,
      detach: () => {
        try {
          if (
            Object.getOwnPropertyDescriptor(runtime, "streamSimple")?.value !== wrapped ||
            runtime.streamSimple !== wrapped
          )
            return false;
          return ownMethod
            ? Reflect.defineProperty(runtime, "streamSimple", ownMethod)
            : Reflect.deleteProperty(runtime, "streamSimple");
        } catch {
          return false;
        }
      },
    };
    runtimes.set(runtime, binding);
  }
  const { sessions, detach } = binding;
  const subscriptions = sessions.get(sessionId) ?? [];
  const covered = subscriptions.at(-1);
  if (covered) covered.activation = undefined;
  const subscription: Subscription = { listener, activation: Symbol() };
  subscriptions.push(subscription);
  sessions.set(sessionId, subscriptions);
  return () => {
    const index = subscriptions.indexOf(subscription);
    if (index === -1) return;
    subscriptions.splice(index, 1);
    if (!subscription.activation) return; // A covered subscription was released out of order.
    subscription.activation = undefined;
    const next = subscriptions.at(-1);
    if (next) {
      // Restore the listener only for new dispatches; old hooks keep their token.
      next.activation = Symbol();
      return;
    }
    sessions.delete(sessionId);
    // If an outer wrapper or property change blocks detach, reuse the dormant
    // wrapper on rebind instead of inserting another layer.
    if (sessions.size === 0 && detach()) runtimes.delete(runtime);
  };
}

export function installQuotaObserver(pi: ExtensionAPI, display?: Display) {
  let release: (() => void) | undefined;
  const retire = () => {
    try {
      release?.();
    } catch {
      /* Not a session failure. */
    }
    release = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    retire();
    try {
      const runtime = runtimeOf(ctx);
      if (!runtime) return;
      const sessionId = ctx.sessionManager.getSessionId();
      if (sessionId) release = bindQuotaResponses(runtime, sessionId, { display });
    } catch {
      // Unavailable host internals must not latch parent/child assembly closed.
    }
  });
  pi.on("session_shutdown", retire);
  return retire;
}

export function childQuotaObserver(
  pi: ExtensionAPI,
  captureRetirement?: (retire: () => void) => void,
) {
  const retire = installQuotaObserver(pi);
  captureRetirement?.(retire);
}
