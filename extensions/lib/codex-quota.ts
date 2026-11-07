// Publishing remains opt-in; parsing quota headers never reads credentials.
const DASHBOARD_BASE_URL = (process.env.AGENT_DASHBOARD_URL ?? "").replace(/\/+$/, "");
const DASHBOARD_URL = `${DASHBOARD_BASE_URL}/api/usage/codex`;
const REQUEST_TIMEOUT_MS = 1_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const RESET_TIME_TOLERANCE_SECONDS = 5;
export const QUOTA_BUCKET_NAMES = ["primary", "secondary"] as const;
const QUOTA_HEADER_NAMES = new Set(
  QUOTA_BUCKET_NAMES.flatMap((bucket) => [
    `x-codex-${bucket}-used-percent`,
    `x-codex-${bucket}-window-minutes`,
    `x-codex-${bucket}-reset-at`,
    `x-codex-${bucket}-reset-after-seconds`,
  ]),
);

type CodexQuotaBucket = {
  usedPercent: number;
  exhausted: boolean;
  resetsAt: number;
  windowMinutes: number;
};

export type CodexQuotaSnapshot = Partial<
  Record<(typeof QUOTA_BUCKET_NAMES)[number], CodexQuotaBucket>
>;

type CodexWindowQuota = {
  remainingPercent: number;
  exhausted: boolean;
  resetsAt: number;
  windowMinutes: number;
};

/** One Codex account's footer quota: the weekly window, and a shorter one
 * (a 5h limit) only when that account's plan reports it. */
export type CodexQuota = {
  short?: CodexWindowQuota;
  weekly?: CodexWindowQuota;
};

/** Purchased credits are separate from subscription windows and have no reset.
 * The cache keeps the reported decimal text: these are credits, not a dollar
 * amount; the footer renders whole credits. */
export type CodexCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

function numberHeader(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function quotaSnapshot(headers: Record<string, string>): CodexQuotaSnapshot {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const snapshot: CodexQuotaSnapshot = {};
  for (const bucket of QUOTA_BUCKET_NAMES) {
    const prefix = `x-codex-${bucket}-`;
    const usedPercent = numberHeader(headers, `${prefix}used-percent`);
    const windowMinutes = numberHeader(headers, `${prefix}window-minutes`);
    if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) continue;

    const absoluteReset = numberHeader(headers, `${prefix}reset-at`);
    const resetAfter = numberHeader(headers, `${prefix}reset-after-seconds`);
    const resetsAt =
      absoluteReset !== undefined
        ? Math.max(0, Math.floor(absoluteReset))
        : resetAfter !== undefined
          ? nowSeconds + Math.max(0, Math.floor(resetAfter))
          : 0;
    snapshot[bucket] = {
      usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
      // Rounding the displayed percentage to zero is not actual exhaustion.
      exhausted: usedPercent >= 100,
      resetsAt,
      windowMinutes: Math.floor(windowMinutes),
    };
  }
  return snapshot;
}

export function quotaSnapshotFromStream(
  value: unknown,
  previous: CodexQuotaSnapshot | undefined,
): CodexQuotaSnapshot | undefined {
  const limits = asRecord(value);
  if (!limits) return undefined;
  const snapshot = { ...previous };
  for (const bucket of QUOTA_BUCKET_NAMES) {
    if (!Object.hasOwn(limits, bucket)) continue;
    const data = asRecord(limits[bucket]);
    const prior = previous?.[bucket];
    const resetAt = data?.reset_at;
    if (
      resetAt != null &&
      (typeof resetAt !== "number" || !Number.isInteger(resetAt) || resetAt < 0)
    ) {
      // Bad supplied metadata must not turn an expired window into reset=0.
      delete snapshot[bucket];
      continue;
    }
    const headers: Record<string, string> = {};
    // Optional metadata can be omitted on recovery updates. Retain its known
    // reset rather than making an old exhausted window current indefinitely.
    for (const [number, suffix] of [
      [data?.used_percent, "used-percent"],
      [data?.window_minutes ?? prior?.windowMinutes, "window-minutes"],
      [data?.reset_at ?? prior?.resetsAt, "reset-at"],
    ] as const) {
      if (typeof number === "number" && Number.isFinite(number))
        headers[`x-codex-${bucket}-${suffix}`] = String(number);
    }
    const next = quotaSnapshot(headers)[bucket];
    if (next) snapshot[bucket] = next;
    else delete snapshot[bucket];
  }
  return snapshot;
}

export function quotaSnapshotsEqual(
  left: CodexQuotaSnapshot | undefined,
  right: CodexQuotaSnapshot,
): boolean {
  if (!left) return false;
  return QUOTA_BUCKET_NAMES.every((bucket) => {
    const leftBucket = left[bucket];
    const rightBucket = right[bucket];
    if (!leftBucket || !rightBucket) return leftBucket === rightBucket;
    return (
      leftBucket.usedPercent === rightBucket.usedPercent &&
      leftBucket.exhausted === rightBucket.exhausted &&
      leftBucket.windowMinutes === rightBucket.windowMinutes &&
      Math.abs(leftBucket.resetsAt - rightBucket.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
    );
  });
}

export function codexQuota(snapshot: CodexQuotaSnapshot): CodexQuota | undefined {
  const buckets = QUOTA_BUCKET_NAMES.flatMap((name) => snapshot[name] ?? []);
  const weekly = buckets.find((bucket) => bucket.windowMinutes === WEEKLY_WINDOW_MINUTES);
  const short = buckets
    .filter((bucket) => bucket.windowMinutes < WEEKLY_WINDOW_MINUTES)
    .sort((left, right) => left.windowMinutes - right.windowMinutes)[0];
  if (!weekly && !short) return undefined;
  const window = (bucket: CodexQuotaBucket): CodexWindowQuota => ({
    remainingPercent: 100 - bucket.usedPercent,
    exhausted: bucket.exhausted,
    resetsAt: bucket.resetsAt,
    windowMinutes: bucket.windowMinutes,
  });
  return {
    ...(short ? { short: window(short) } : {}),
    ...(weekly ? { weekly: window(weekly) } : {}),
  };
}

/** `5h` for a 300-minute window; minutes when it is not whole hours. */
export function quotaWindowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** The Codex backend answers with `x-codex-*` quota headers. That includes a
 * provider alias cloning openai-codex for another account; OpenAI ChatGPT auth
 * uses another API and never does. */
export function isCodexQuotaSource(model: { api?: string } | undefined): boolean {
  return model?.api === "openai-codex-responses";
}

function windowQuotasEqual(
  left: CodexWindowQuota | undefined,
  right: CodexWindowQuota | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.remainingPercent === right.remainingPercent &&
    left.exhausted === right.exhausted &&
    left.windowMinutes === right.windowMinutes &&
    Math.abs(left.resetsAt - right.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
  );
}

export function codexQuotasEqual(
  left: CodexQuota | undefined,
  right: CodexQuota | undefined,
): boolean {
  if (!left || !right) return left === right;
  return windowQuotasEqual(left.short, right.short) && windowQuotasEqual(left.weekly, right.weekly);
}

export function quotaHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => QUOTA_HEADER_NAMES.has(name)),
  );
}

export function codexCredits(value: unknown): CodexCredits | undefined {
  const data = asRecord(value);
  if (typeof data?.has_credits !== "boolean" || typeof data.unlimited !== "boolean")
    return undefined;
  const raw = typeof data.balance === "string" ? data.balance.trim() : "";
  // Validate before putting untrusted provider text on the terminal. Preserve
  // decimals (including tiny balances) without Number's rounding/precision loss.
  const balance =
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) && Number.isFinite(Number(raw))
      ? raw
      : undefined;
  return {
    hasCredits: data.has_credits,
    unlimited: data.unlimited,
    ...(balance !== undefined ? { balance } : {}),
  };
}

export function codexCreditsFromHeaders(headers: Record<string, string>): CodexCredits | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const boolean = (name: string): boolean | undefined => {
    const value = normalized[name]?.trim().toLowerCase();
    return value === "true" || value === "1"
      ? true
      : value === "false" || value === "0"
        ? false
        : undefined;
  };
  return codexCredits({
    has_credits: boolean("x-codex-credits-has-credits"),
    unlimited: boolean("x-codex-credits-unlimited"),
    balance: normalized["x-codex-credits-balance"],
  });
}

export function codexCreditsEqual(left: CodexCredits | undefined, right: CodexCredits): boolean {
  return (
    left?.hasCredits === right.hasCredits &&
    left.unlimited === right.unlimited &&
    left.balance === right.balance
  );
}

/** Render whole credits for the footer; the exact reported balance stays cached.
 * BigInt string rounding keeps huge balances exact (Number would lose
 * precision); exotic exponent text displays verbatim. */
export function wholeCreditBalance(balance: string): string {
  if (/e/i.test(balance)) return balance;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(balance);
  if (!match) return balance;
  const whole = match[1] || "0";
  return match[2] && Number(match[2][0]) >= 5 ? (BigInt(whole) + 1n).toString() : whole;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function publishQuota(headers: Record<string, string>): Promise<boolean> {
  if (!DASHBOARD_BASE_URL) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(DASHBOARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // The dashboard is optional; quota publishing must never affect a model response.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
