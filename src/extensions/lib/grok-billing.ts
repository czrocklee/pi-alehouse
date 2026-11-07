import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Auth reads and requests remain behind the existing explicit billing opt-in.
const GROK_BILLING_ENABLED = process.env.PI_ALEHOUSE_GROK_BILLING === "1";
const DASHBOARD_BASE_URL = (process.env.AGENT_DASHBOARD_URL ?? "").replace(/\/+$/, "");
const GROK_DASHBOARD_URL = `${DASHBOARD_BASE_URL}/api/usage/grok`;
const GROK_BILLING_URL = `${(process.env.GROK_CLI_CHAT_PROXY_BASE_URL ?? "https://cli-chat-proxy.grok.com/v1").replace(/\/+$/, "")}/billing?format=credits`;
const REQUEST_TIMEOUT_MS = 1_000;
const GROK_REQUEST_TIMEOUT_MS = 5_000;
const GROK_BILLING_MIN_INTERVAL_MS = 60_000;
const GROK_BILLING_FORCE_MIN_INTERVAL_MS = 10_000;
const RESET_TIME_TOLERANCE_SECONDS = 5;

export type GrokWeeklyQuota = {
  remainingPercent: number;
  resetsAt: number;
};

function grokQuotasEqual(
  left: GrokWeeklyQuota | undefined,
  right: GrokWeeklyQuota | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.remainingPercent === right.remainingPercent &&
    Math.abs(left.resetsAt - right.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function grokHomeDir(): string {
  const override = process.env.GROK_HOME?.trim();
  if (override) return override;
  return join(process.env.HOME ?? homedir(), ".grok");
}

function grokClientVersion(): string {
  const data = asRecord(readJsonFile(join(grokHomeDir(), "version.json")));
  const version = data?.version ?? data?.stable_version;
  return typeof version === "string" && version.trim() ? version.trim() : "1.0.5";
}

function readGrokAccessToken(): { token: string; userId?: string } | undefined {
  const piXai = asRecord(asRecord(readJsonFile(join(getAgentDir(), "auth.json")))?.xai);
  if (piXai?.type === "oauth" && typeof piXai.access === "string" && piXai.access.trim()) {
    return { token: piXai.access.trim() };
  }

  const grokAuth = asRecord(readJsonFile(join(grokHomeDir(), "auth.json")));
  if (!grokAuth) return undefined;

  let fallback: { token: string; userId?: string } | undefined;
  for (const [key, value] of Object.entries(grokAuth)) {
    const entry = asRecord(value);
    if (!entry || typeof entry.key !== "string" || !entry.key.trim()) continue;
    const mode = String(entry.auth_mode ?? "").toLowerCase();
    if (mode === "api_key" || mode === "web_login") continue;
    const issuer = String(entry.oidc_issuer ?? "").replace(/\/+$/, "");
    const userId =
      typeof entry.user_id === "string"
        ? entry.user_id
        : typeof entry.principal_id === "string"
          ? entry.principal_id
          : undefined;
    const candidate = { token: entry.key.trim(), userId };
    if (key.includes("auth.x.ai") || issuer === "https://auth.x.ai") return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

function grokPercent(value: unknown): number | undefined {
  if (value == null || typeof value === "boolean") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
}

function grokMoney(value: unknown): number | undefined {
  const nested = asRecord(value);
  if (nested && "val" in nested) {
    const n = Number(nested.val);
    return Number.isFinite(n) ? n : undefined;
  }
  if (value == null || typeof value === "boolean") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function grokIsoSeconds(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

export function grokWeeklyQuotaFromBilling(payload: unknown): GrokWeeklyQuota | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const config = asRecord(root.config) ?? root;
  const period = asRecord(config.currentPeriod) ?? asRecord(config.current_period) ?? {};
  const periodType = String(period.type ?? "");
  const end = grokIsoSeconds(period.end ?? config.billingPeriodEnd ?? config.billing_period_end);

  let percent = grokPercent(config.creditUsagePercent ?? config.credit_usage_percent);
  if (percent === undefined) {
    const used = grokMoney(config.used);
    const limit = grokMoney(config.monthlyLimit ?? config.monthly_limit);
    if (used !== undefined && limit && limit > 0) percent = grokPercent((used / limit) * 100);
  }
  if (percent === undefined && (periodType || end > 0)) percent = 0;
  if (percent === undefined) return undefined;

  return {
    remainingPercent: 100 - percent,
    resetsAt: end,
  };
}

async function fetchGrokBilling(): Promise<Record<string, unknown> | undefined> {
  if (!GROK_BILLING_ENABLED) return undefined;
  const creds = readGrokAccessToken();
  if (!creds) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROK_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
      "x-grok-client-version": grokClientVersion(),
      "x-grok-client-mode": "interactive",
    };
    if (creds.userId) headers["x-userid"] = creds.userId;

    const response = await fetch(GROK_BILLING_URL, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return asRecord(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function injectGrokQuota(payload: Record<string, unknown>): Promise<void> {
  if (!DASHBOARD_BASE_URL) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await fetch(GROK_DASHBOARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: asRecord(payload.config) ?? payload,
        subscriptionTier:
          payload.subscriptionTier ??
          payload.subscription_tier ??
          payload.subscription_tier_display,
      }),
      signal: controller.signal,
    });
  } catch {
    // The dashboard is optional; quota publishing must never affect a model response.
  } finally {
    clearTimeout(timeout);
  }
}

export type GrokBillingSnapshot = {
  enabled: boolean;
  quota: GrokWeeklyQuota | undefined;
  pending: boolean;
  lastSuccessAt: number | undefined;
  failed: boolean;
  minIntervalMs: number;
};

/** Footer-local billing observer. No polling, auth lookup or request is started
 * by construction, session start, or a paint. Dirty activity is coalesced and
 * generation-checked exactly at the existing response/settlement boundaries. */
export function createGrokBilling(requestRender: () => void) {
  let grokWeeklyQuota: GrokWeeklyQuota | undefined;
  let grokPublishInFlight = false;
  let grokForcePending = false;
  let grokActivity = 0,
    grokAttempted = 0;
  let grokRunActive = false;
  let grokContext: ExtensionContext | undefined;
  let lastGrokFetchAt: number | undefined;
  let lastGrokSuccessAt: number | undefined;
  let grokFetchFailed = false;
  let grokPublishTimer: ReturnType<typeof setTimeout> | undefined;
  let grokPublishGeneration = 0;
  let grokPublishStopped = false;

  const clearGrokTimer = () => {
    if (grokPublishTimer) clearTimeout(grokPublishTimer);
    grokPublishTimer = undefined;
  };
  const grokApplicable = () => {
    try {
      return !grokPublishStopped && grokContext?.model?.provider === "xai";
    } catch {
      return false;
    } // A retired SDK context cannot authorize a refresh.
  };
  const repaintBilling = () => {
    try {
      requestRender();
    } catch {
      /* Display failure cannot strand an in-flight billing request. */
    }
  };
  const scheduleGrokPublish = () => {
    if (
      !GROK_BILLING_ENABLED ||
      !grokApplicable() ||
      grokActivity <= grokAttempted ||
      grokPublishInFlight
    )
      return;
    clearGrokTimer();
    const interval = grokForcePending
      ? GROK_BILLING_FORCE_MIN_INTERVAL_MS
      : GROK_BILLING_MIN_INTERVAL_MS;
    const now = performance.now();
    const delay =
      lastGrokFetchAt === undefined ? 0 : Math.max(0, interval - (now - lastGrokFetchAt));
    if (delay > 0) {
      grokPublishTimer = setTimeout(() => {
        grokPublishTimer = undefined;
        // A model can leave xai without another billing event. Never read auth
        // or issue a delayed request for a no-longer-applicable selection.
        scheduleGrokPublish();
      }, delay);
      grokPublishTimer.unref?.();
      repaintBilling();
      return;
    }
    grokPublishInFlight = true;
    grokForcePending = false;
    // Cover only activity known at dispatch. Responses/settlement that arrive
    // DURING this request remain dirty and coalesce into one trailing refresh.
    // Failed/no-auth attempts are not retried autonomously at every interval.
    grokAttempted = grokActivity;
    lastGrokFetchAt = now;
    const generation = grokPublishGeneration;
    repaintBilling();
    void (async () => {
      try {
        const billing = await fetchGrokBilling();
        if (!grokApplicable() || generation !== grokPublishGeneration) return;
        const quota = grokWeeklyQuotaFromBilling(billing);
        grokFetchFailed = !quota;
        if (quota) {
          if (!grokQuotasEqual(grokWeeklyQuota, quota)) grokWeeklyQuota = quota;
          lastGrokSuccessAt = performance.now();
          if (billing) void injectGrokQuota(billing);
        }
      } finally {
        grokPublishInFlight = false;
        repaintBilling();
        if (grokActivity > grokAttempted) scheduleGrokPublish();
      }
    })();
  };

  return {
    snapshot(): GrokBillingSnapshot {
      return {
        enabled: GROK_BILLING_ENABLED,
        quota: grokWeeklyQuota,
        pending: grokPublishInFlight || grokActivity > grokAttempted,
        lastSuccessAt: lastGrokSuccessAt,
        failed: grokFetchFailed,
        minIntervalMs: GROK_BILLING_MIN_INTERVAL_MS,
      };
    },
    beforeAgentStart(ctx: ExtensionContext) {
      if (!GROK_BILLING_ENABLED || ctx.model?.provider !== "xai") return;
      grokContext = ctx;
      grokRunActive = true;
    },
    modelSelect(ctx: ExtensionContext) {
      if (!GROK_BILLING_ENABLED) return;
      grokContext = ctx;
      if (!grokApplicable()) {
        clearGrokTimer();
        grokPublishGeneration++;
        if (grokRunActive) grokActivity++;
        grokRunActive = false;
        // Preserve dirty final usage across leaving/returning to xai, but retire
        // any old in-flight snapshot and never publish it after a round trip.
        if (grokPublishInFlight) grokAttempted = 0;
      } else if (grokActivity > grokAttempted) {
        grokForcePending = true;
        scheduleGrokPublish();
      }
    },
    afterProviderResponse(ctx: ExtensionContext) {
      if (!GROK_BILLING_ENABLED || grokPublishStopped || ctx.model?.provider !== "xai") return;
      grokContext = ctx;
      grokRunActive = true;
      grokActivity++;
      scheduleGrokPublish();
    },
    agentSettled(ctx: ExtensionContext) {
      if (
        !GROK_BILLING_ENABLED ||
        grokPublishStopped ||
        ctx.model?.provider !== "xai" ||
        !grokRunActive
      )
        return;
      grokContext = ctx;
      grokRunActive = false;
      grokActivity++;
      // Headers can precede the stream's final billable work. One final dirty
      // revision must be sampled, but duplicate idle notifications add no work.
      grokForcePending = true;
      scheduleGrokPublish();
    },
    sessionStart(ctx: ExtensionContext) {
      grokPublishGeneration++;
      grokPublishStopped = false;
      clearGrokTimer();
      grokContext = ctx;
      grokRunActive = false;
      grokActivity = grokAttempted = 0;
      grokForcePending = false;
    },
    shutdown() {
      grokPublishStopped = true;
      grokPublishGeneration++;
      clearGrokTimer();
      grokContext = undefined;
      grokRunActive = false;
      grokActivity = grokAttempted = 0;
      grokForcePending = false;
    },
  };
}
