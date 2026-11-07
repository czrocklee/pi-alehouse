import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  collectContextSnapshot,
  type ContextModelIdentity,
  type ContextSnapshot,
} from "./lib/context-stats.ts";
import { CompactionProgress } from "./lib/compaction-progress.ts";
import {
  FOOTER_INDICATOR_CLICK_EVENT,
  type FooterIndicatorClick,
} from "../lib/overlay-protocol.mjs";
import type { UsageTotals } from "../lib/usage-attribution.mjs";
import {
  QUOTA_BUCKET_NAMES,
  codexCredits,
  codexCreditsEqual,
  codexCreditsFromHeaders,
  codexQuota,
  codexQuotasEqual,
  isCodexQuotaSource,
  publishQuota,
  quotaHeaders,
  quotaSnapshot,
  quotaSnapshotFromStream,
  quotaSnapshotsEqual,
  type CodexCredits,
  type CodexQuota,
  type CodexQuotaSnapshot,
} from "./lib/codex-quota.ts";
import { createGrokBilling } from "./lib/grok-billing.ts";
import {
  presentationMemo,
  sessionSource,
  spendReader,
  sumSpend,
  type ContextSource,
} from "./lib/session-spend.ts";
import { contextSummary, paintFooter, type FooterHit } from "./lib/footer-layout.ts";
import { createFooterPanels } from "./lib/footer-panels.ts";

// Pi assigns this API id to virtual catalog entries. It is not a package export;
// any other API is a physical model, and a missing API is not treated as virtual.
const VIRTUAL_MODEL_API = "pi-virtual";
// A settled assistant turn. error/aborted are failures, pending/deferred are not
// a completed route, and a virtual API means routing itself failed.
const SETTLED_ROUTE_STOPS = new Set(["stop", "length", "toolUse"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function activeBranch(ctx: ExtensionContext): readonly SessionEntry[] | undefined {
  const getBranch = ctx.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return undefined;
  try {
    const branch = getBranch.call(ctx.sessionManager);
    return Array.isArray(branch) ? branch : undefined;
  } catch {
    return undefined;
  }
}

function assistantMessage(entry: SessionEntry): AssistantMessage | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  return entry.message;
}

/** The latest context edit on this branch wins. Null drops the target from the live route. */
function branchOmits(branch: readonly SessionEntry[], id: string): boolean {
  let omitted = false;
  for (const entry of branch) {
    if (entry.type === "context_edit" && entry.targetId === id)
      omitted = entry.replacement === null;
  }
  return omitted;
}

/** Only a settled physical response after this virtual selection, on the active
 * branch, is the current route. Failed/omitted calls never revive older routes. */
function physicalRoute(ctx: ExtensionContext): { id: string; thinkingLevel?: string } | undefined {
  const selected = ctx.model;
  if (!selected || selected.api !== VIRTUAL_MODEL_API) return undefined;
  const branch = activeBranch(ctx);
  if (!branch) return undefined;

  let boundary = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || entry.type !== "model_change") continue;
    if (entry.provider === selected.provider && entry.modelId === selected.id) boundary = index;
    break;
  }
  if (boundary < 0) return undefined;

  for (let index = branch.length - 1; index > boundary; index -= 1) {
    const entry = branch[index];
    if (!entry) continue;
    const message = assistantMessage(entry);
    if (!message) continue;
    if (branchOmits(branch, entry.id)) return undefined;
    if (
      message.api === VIRTUAL_MODEL_API ||
      !SETTLED_ROUTE_STOPS.has(message.stopReason) ||
      !message.model
    ) {
      return undefined;
    }
    return {
      id: message.model,
      ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
    };
  }
  return undefined;
}

/** Public in-memory auth/catalog metadata only; never resolves a provider key.
 * Kimi Coding stays subscription-backed even with an API-key credential. */
function subscriptionSuffix(ctx: ExtensionContext): string {
  const provider = ctx.model?.provider;
  if (!provider) return "";
  if (provider === "kimi-coding") return " sub";
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  if (
    !model ||
    typeof registry?.isUsingOAuth !== "function" ||
    typeof registry.getProvider !== "function"
  ) {
    return "";
  }
  try {
    if (!registry.isUsingOAuth(model)) return "";
    return registry.getProvider(provider)?.auth.oauth?.isSubscription === true ? " sub" : "";
  } catch {
    return "";
  }
}

/** Read at a context boundary; the context panel receives this same SDK total. */
function contextUsage(ctx: ExtensionContext): ContextUsage {
  try {
    const usage = ctx.getContextUsage();
    if (usage) return { ...usage };
  } catch {
    /* A presentation failure must not affect the session. */
  }
  return { tokens: null, contextWindow: 0, percent: null };
}

export default function (pi: ExtensionAPI) {
  /** Keyed by provider: each Codex provider is its own account. */
  const codexQuotas = new Map<string, CodexQuota>();
  const codexQuotaSnapshots = new Map<string, CodexQuotaSnapshot>();
  const codexCreditsByProvider = new Map<string, CodexCredits>();
  let lastPublishedQuota: CodexQuotaSnapshot | undefined;
  let requestFooterRender: (() => void) | undefined;
  const billing = createGrokBilling(() => requestFooterRender?.());
  const compaction = new CompactionProgress();
  let compactionTimer: ReturnType<typeof setInterval> | undefined;
  let compactionUsage: ContextUsage | undefined;
  let frozenContext: ContextSnapshot | undefined;
  let effectivePrompt: string | undefined;
  // Foreground assistant events observe a dispatch; they never predict a route.
  let observedReplayModel: ContextModelIdentity | undefined;
  let replaySource: "active-request" | "last-observed-request" = "last-observed-request";
  let contextRevision = 0;
  const usageMemo = presentationMemo<ContextUsage>();
  const routeMemo = presentationMemo<ReturnType<typeof physicalRoute>>();
  const snapshotMemo = presentationMemo<ContextSnapshot>();
  // Capture once per synchronous footer paint. Independently painted panels
  // capture their own current source, never a stale previous footer frame.
  const captureSource = (ctx: ExtensionContext): ContextSource => {
    const source = sessionSource(ctx),
      model = ctx.model;
    return {
      ...source,
      key:
        source.stamp &&
        JSON.stringify([
          source.stamp,
          contextRevision,
          model?.provider,
          model?.id,
          model?.api,
          model?.contextWindow,
          ctx.thinkingLevel,
          observedReplayModel,
          replaySource,
        ]),
    };
  };
  const currentUsage = (ctx: ExtensionContext, source: ContextSource): ContextUsage =>
    usageMemo.read(source, () => contextUsage(ctx));
  const currentRoute = (
    ctx: ExtensionContext,
    source: ContextSource,
  ): ReturnType<typeof physicalRoute> => routeMemo.read(source, () => physicalRoute(ctx));
  let inspectContext: ((focus: boolean) => void) | undefined;
  let retireContextUI: (() => void) | undefined;
  const clearContext = () => {
    contextRevision++;
    usageMemo.clear();
    routeMemo.clear();
    snapshotMemo.clear();
  };
  const stopCompactionTimer = () => {
    if (compactionTimer) clearInterval(compactionTimer);
    compactionTimer = undefined;
  };
  const resetContext = () => {
    stopCompactionTimer();
    compaction.reset();
    compactionUsage = undefined;
    frozenContext = undefined;
    effectivePrompt = undefined;
    observedReplayModel = undefined;
    clearContext();
    retireContextUI?.();
    retireContextUI = undefined;
    inspectContext = undefined;
  };
  const rememberPrompt = (ctx: ExtensionContext) => {
    try {
      effectivePrompt = ctx.getSystemPrompt();
    } catch {
      /* A failed new-run capture remains unknown. */
    }
    clearContext();
  };
  const contextSnapshot = (
    ctx: ExtensionContext,
    usage?: ContextUsage,
    source = captureSource(ctx),
  ): ContextSnapshot => {
    if (compactionUsage && frozenContext) return frozenContext;
    const total = usage ?? compactionUsage ?? currentUsage(ctx, source);
    const key =
      source.key && JSON.stringify([source.key, total.tokens, total.contextWindow, total.percent]);
    return snapshotMemo.read(
      source,
      () =>
        collectContextSnapshot(ctx, {
          usage: total,
          effectiveSystemPrompt: effectivePrompt,
          replayModel:
            observedReplayModel ?? (ctx.model?.api === VIRTUAL_MODEL_API ? null : undefined),
          replaySource,
        }),
      key,
    );
  };
  const invalidateContext = () => {
    clearContext();
    requestFooterRender?.();
  };
  const observeReplay = (value: unknown, completed: boolean) => {
    const message = asRecord(value);
    if (message?.role !== "assistant") return;
    observedReplayModel =
      typeof message.provider === "string" &&
      typeof message.api === "string" &&
      typeof message.model === "string" &&
      message.api !== VIRTUAL_MODEL_API &&
      (!completed || SETTLED_ROUTE_STOPS.has(String(message.stopReason)))
        ? { provider: message.provider, api: message.api, id: message.model }
        : undefined;
    replaySource = completed ? "last-observed-request" : "active-request";
  };
  pi.on("before_agent_start", (_event, ctx) => {
    effectivePrompt = undefined;
    observedReplayModel = undefined;
    rememberPrompt(ctx);
  });
  pi.on("turn_start", () => {
    observedReplayModel = undefined;
    invalidateContext();
  });
  pi.on("turn_end", invalidateContext);
  // Virtual routing can change the limits model before an assistant is stored.
  // Observe the public dispatch boundary, never resolve model credentials.
  pi.on("before_provider_request", () => {
    invalidateContext();
  });
  pi.on("context_with_system", (_event, ctx) => {
    rememberPrompt(ctx);
  });
  pi.on("message_start", (event) => {
    observeReplay(event.message, false);
    invalidateContext();
  });
  pi.on("message_end", (event) => {
    observeReplay(event.message, true);
    invalidateContext();
  });
  pi.on("tool_execution_end", invalidateContext);
  pi.on("agent_settled", () => {
    if (replaySource === "active-request") observedReplayModel = undefined;
    invalidateContext();
  });
  const resetContextSource = () => {
    effectivePrompt = undefined;
    observedReplayModel = undefined;
    invalidateContext();
  };
  pi.on("session_tree", resetContextSource);
  pi.on("model_select", resetContextSource);
  pi.on("session_before_compact", (event, ctx) => {
    clearContext();
    const source = captureSource(ctx);
    compactionUsage = currentUsage(ctx, source);
    frozenContext = undefined;
    // Capture the complete pre-compaction composition now, not on a later paint.
    frozenContext = contextSnapshot(ctx, compactionUsage, source);
    compaction.start({
      modelKey:
        ctx.model && ctx.model.api !== VIRTUAL_MODEL_API
          ? `${ctx.model.provider}/${ctx.model.id}`
          : undefined,
      tokensBefore: event.preparation.tokensBefore,
    });
    stopCompactionTimer();
    if (ctx.mode === "tui" && requestFooterRender) {
      compactionTimer = setInterval(() => requestFooterRender?.(), 100);
      compactionTimer.unref?.();
    }
    requestFooterRender?.();
  });
  const finishCompaction = (success: boolean) => {
    compaction.finish(success);
    stopCompactionTimer();
    compactionUsage = undefined;
    frozenContext = undefined;
    observedReplayModel = undefined;
    clearContext();
    requestFooterRender?.();
  };
  pi.on("session_compact", (event) => finishCompaction(!event.fromExtension));
  pi.on("session_compact_failed", () => finishCompaction(false));
  pi.on("session_shutdown", resetContext);
  pi.registerCommand?.("context", {
    description:
      "Inspect current context composition (estimated); fullscreen panels can stay pinned",
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui" && inspectContext) {
        inspectContext(true);
        return;
      }
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        contextSummary(contextSnapshot(ctx), "The pinned context panel requires fullscreen Pi."),
        "info",
      );
    },
  });
  pi.on("before_agent_start", (_event, ctx) => billing.beforeAgentStart(ctx));
  pi.on("model_select", (_event, ctx) => billing.modelSelect(ctx));
  pi.on("session_shutdown", () => billing.shutdown());

  const rememberCodexQuota = (provider: string, snapshot: CodexQuotaSnapshot) => {
    codexQuotaSnapshots.set(provider, snapshot);
    const nextQuota = codexQuota(snapshot);
    if (codexQuotasEqual(codexQuotas.get(provider), nextQuota)) return;
    if (nextQuota) codexQuotas.set(provider, nextQuota);
    else codexQuotas.delete(provider);
    requestFooterRender?.();
  };
  const rememberCodexCredits = (provider: string, credits: CodexCredits | undefined) => {
    if (!credits || codexCreditsEqual(codexCreditsByProvider.get(provider), credits)) return;
    codexCreditsByProvider.set(provider, credits);
    requestFooterRender?.();
  };
  pi.on("after_provider_response", (event, ctx) => {
    // Codex quota headers belong to the Codex backend only, not ChatGPT auth.
    const provider = ctx.model?.provider;
    if (!provider || !isCodexQuotaSource(ctx.model)) return;
    // Credit-only updates stay local; the dashboard payload remains quota-only.
    rememberCodexCredits(provider, codexCreditsFromHeaders(event.headers));
    const headers = quotaHeaders(event.headers);
    const snapshot = quotaSnapshot(headers);
    if (!QUOTA_BUCKET_NAMES.some((bucket) => snapshot[bucket])) return;
    rememberCodexQuota(provider, snapshot);
    // The dashboard names no account: aliases must not overwrite openai-codex.
    if (provider !== "openai-codex" || quotaSnapshotsEqual(lastPublishedQuota, snapshot)) return;
    void publishQuota(headers).then((published) => {
      if (published) lastPublishedQuota = snapshot;
    });
  });
  pi.on("provider_stream_event", (event) => {
    if (!isCodexQuotaSource(event)) return;
    const data = asRecord(event.data);
    if (data?.type !== "codex.rate_limits") return;
    const limit = data.metered_limit_name ?? data.limit_name ?? "codex";
    if (typeof limit !== "string" || limit.trim().toLowerCase().replace(/-/g, "_") !== "codex")
      return;
    // WebSocket windows and credits stay local, keyed by physical provider.
    const snapshot = quotaSnapshotFromStream(
      data.rate_limits,
      codexQuotaSnapshots.get(event.provider),
    );
    if (snapshot) rememberCodexQuota(event.provider, snapshot);
    rememberCodexCredits(event.provider, codexCredits(data.credits));
  });
  pi.on("after_provider_response", (_event, ctx) => billing.afterProviderResponse(ctx));
  pi.on("agent_settled", (_event, ctx) => billing.agentSettled(ctx));

  pi.on("session_start", (_event, ctx) => {
    billing.sessionStart(ctx);
    resetContext();
    ctx.ui.setFooter((tui, theme, footerData) => {
      // Pi's component tree has no flex spacer. Pad only when this render's
      // footer was its last row; nested renders cannot borrow a previous paint.
      let renderFrame: { row?: string } | undefined;
      const originalRender = tui.render.bind(tui);
      const renderWithBottomFooter = (width: number): string[] => {
        const previous = renderFrame;
        const frame: { row?: string } = {};
        renderFrame = frame;
        let rendered: string[];
        try {
          rendered = originalRender(width);
        } finally {
          renderFrame = previous;
        }
        if (tui.mode === "fullscreen" || frame.row === undefined || rendered.at(-1) !== frame.row)
          return rendered;
        const padding = Math.max(0, tui.terminal.rows - rendered.length);
        if (padding === 0) return rendered;
        // Detach only the short viewport; never mutate a host-owned/shared array.
        const lines = rendered.slice();
        const footerIndex = lines.length - 1;
        lines.length += padding;
        lines.fill(" ".repeat(width), footerIndex, footerIndex + padding);
        lines[footerIndex + padding] = frame.row;
        return lines;
      };
      tui.render = renderWithBottomFooter;
      const renderFooter = () => tui.requestRender();
      requestFooterRender = renderFooter;
      const unsubscribeBranch = footerData.onBranchChange(renderFooter);
      // One independent full-journal ledger shared by the line and usage panel.
      const readSpend = spendReader();
      const spend = (source = sessionSource(ctx)) => readSpend(source);
      let footerHits: FooterHit[] = [];
      const panels = createFooterPanels({
        pi,
        ctx,
        tui,
        theme,
        spend,
        contextSnapshot: () => contextSnapshot(ctx),
        compaction: () => compaction.snapshot()?.text,
        currentFooter: () => requestFooterRender === renderFooter,
      });
      inspectContext = panels.inspectContext;
      retireContextUI = panels.hideContext;

      return {
        dispose() {
          panels.dispose(() => {
            if (inspectContext === panels.inspectContext) inspectContext = undefined;
            if (retireContextUI === panels.hideContext) retireContextUI = undefined;
            if (requestFooterRender === renderFooter) stopCompactionTimer();
          });
          unsubscribeBranch();
          if (requestFooterRender === renderFooter) requestFooterRender = undefined;
          if (tui.render === renderWithBottomFooter) tui.render = originalRender;
        },
        invalidate() {},
        handleMouse(event: TuiMouseEvent) {
          if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
          const hit = footerHits.find((span) => event.x >= span.x && event.x < span.x + span.width);
          if (hit?.context) {
            panels.toggleContext();
            return { handled: true };
          }
          if (hit?.key !== undefined) {
            const click: FooterIndicatorClick = { key: hit.key, handled: false };
            pi.events.emit(FOOTER_INDICATOR_CLICK_EVENT, click);
            if (click.handled) return { handled: true };
          }
          panels.toggleBreakdown();
          return { handled: true };
        },
        render(width: number): string[] {
          const source = captureSource(ctx);
          const totals: UsageTotals = sumSpend(spend(source));
          const context = compactionUsage ?? currentUsage(ctx, source);
          // A context panel paint shares this frame's SDK total with the footer.
          if (panels.hasContext()) contextSnapshot(ctx, context, source);
          const provider = ctx.model?.provider;
          const codexSource = isCodexQuotaSource(ctx.model);
          const paint = paintFooter({
            width,
            theme,
            totals,
            context,
            cwd: ctx.cwd,
            home: process.env.HOME ?? process.env.USERPROFILE,
            branch: footerData.getGitBranch(),
            model: ctx.model,
            thinkingLevel: ctx.thinkingLevel,
            route: currentRoute(ctx, source),
            subscription: subscriptionSuffix(ctx),
            statuses: footerData.getExtensionStatuses(),
            codex: provider && codexSource ? codexQuotas.get(provider) : undefined,
            credits: provider && codexSource ? codexCreditsByProvider.get(provider) : undefined,
            grok: billing.snapshot(),
            progress: compaction.snapshot()?.text,
            nowSeconds: Date.now() / 1_000,
            nowMs: performance.now(),
          });
          // Commit geometry and row from the same fitted synchronous paint.
          footerHits = paint.hits;
          if (renderFrame) renderFrame.row = paint.row;
          return [paint.row];
        },
      };
    });
  });
}
