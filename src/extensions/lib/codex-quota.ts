const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const RESET_TIME_TOLERANCE_SECONDS = 5;
export const QUOTA_BUCKET_NAMES = ["primary", "secondary"] as const;
const MAX_PERIOD_S = 366 * 86_400;
type CodexWindowName = (typeof QUOTA_BUCKET_NAMES)[number];
/** Only numeric quota fields from one provider response, never cached display state. */
export type CodexReading = {
  pool: "codex";
  window: CodexWindowName;
  used_pct: number;
  duration_s?: number;
  resets_at?: number;
};

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
  // Pi normalizes names to lowercase. Inspect only named quota fields; never
  // copy/filter the complete provider header set into an observation.
  const raw = headers[name];
  if (typeof raw !== "string" || raw.length > 64 || !/^\d+(?:\.\d+)?$/.test(raw.trim()))
    return undefined;
  return Number(raw);
}

function reading(
  window: CodexWindowName,
  used: unknown,
  minutes: unknown,
  reset: unknown,
  observedAt: number,
): CodexReading[] {
  if (typeof used !== "number" || !(used >= 0 && used <= 100)) return [];
  const duration_s = minutes == null ? undefined : typeof minutes === "number" ? minutes * 60 : NaN;
  if (duration_s !== undefined && !(duration_s > 0 && duration_s <= MAX_PERIOD_S)) return [];
  if (
    reset != null &&
    (typeof reset !== "number" ||
      !Number.isSafeInteger(reset) ||
      reset <= 0 ||
      Math.abs(reset - observedAt) > MAX_PERIOD_S)
  )
    return [];
  const resets_at = reset ?? undefined;
  return [
    {
      pool: "codex",
      window,
      used_pct: used,
      ...(duration_s && { duration_s }),
      ...(resets_at && { resets_at }),
    },
  ];
}

export function quotaReadingsFromHeaders(
  headers: Record<string, string>,
  observedAt: number,
): CodexReading[] {
  return QUOTA_BUCKET_NAMES.flatMap((window) => {
    const prefix = `x-codex-${window}-`;
    const supplied = (suffix: string) => {
      const name = `${prefix}${suffix}`;
      return headers[name] === undefined ? undefined : (numberHeader(headers, name) ?? NaN);
    };
    const reset = supplied("reset-at");
    const after = supplied("reset-after-seconds");
    return reading(
      window,
      supplied("used-percent"),
      supplied("window-minutes"),
      reset ?? (after === undefined ? undefined : Math.floor(observedAt + after)),
      observedAt,
    );
  });
}

export function codexRateLimitsEvent(value: unknown): Record<string, unknown> | undefined {
  const data = asRecord(value);
  if (data?.type !== "codex.rate_limits") return undefined;
  const limit = data.metered_limit_name ?? data.limit_name ?? "codex";
  return typeof limit === "string" && limit.trim().toLowerCase() === "codex" ? data : undefined;
}

export function quotaReadingsFromStream(value: unknown, observedAt: number): CodexReading[] {
  const limits = asRecord(value);
  return QUOTA_BUCKET_NAMES.flatMap((window) => {
    const data = asRecord(limits?.[window]);
    return reading(window, data?.used_percent, data?.window_minutes, data?.reset_at, observedAt);
  });
}

type DisplayFields = { usedPercent: number; windowMinutes?: number; resetsAt?: number };
export type CodexDisplayUpdate = {
  replace: boolean;
  buckets: Partial<Record<CodexWindowName, DisplayFields | null>>;
};

/** Local display retains the standalone footer's expiry and invalidation rules.
 * Its cached metadata never becomes a new observation. */
export function mergeCodexDisplay(
  previous: CodexQuotaSnapshot | undefined,
  update: CodexDisplayUpdate,
): CodexQuotaSnapshot {
  const snapshot = update.replace ? {} : { ...previous };
  for (const bucket of QUOTA_BUCKET_NAMES) {
    const next = update.buckets[bucket];
    if (next === undefined) continue;
    const prior = snapshot[bucket];
    const minutes = next?.windowMinutes ?? prior?.windowMinutes;
    if (!next || minutes === undefined) {
      delete snapshot[bucket];
      continue;
    }
    snapshot[bucket] = {
      usedPercent: Math.max(0, Math.min(100, next.usedPercent)),
      exhausted: next.usedPercent >= 100,
      windowMinutes: Math.floor(minutes),
      resetsAt: Math.floor(next.resetsAt ?? prior?.resetsAt ?? 0),
    };
  }
  return snapshot;
}

export function codexDisplayFromHeaders(
  headers: Record<string, string>,
  at: number,
): CodexDisplayUpdate | undefined {
  const buckets: CodexDisplayUpdate["buckets"] = {};
  for (const bucket of QUOTA_BUCKET_NAMES) {
    const prefix = `x-codex-${bucket}-`;
    const used = numberHeader(headers, `${prefix}used-percent`);
    const minutes = numberHeader(headers, `${prefix}window-minutes`);
    if (used === undefined || minutes === undefined || minutes < 1) continue;
    const reset = numberHeader(headers, `${prefix}reset-at`);
    const after = numberHeader(headers, `${prefix}reset-after-seconds`);
    buckets[bucket] = {
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt: reset ?? (after === undefined ? 0 : Math.floor(at) + after),
    };
  }
  return QUOTA_BUCKET_NAMES.some((bucket) => buckets[bucket])
    ? { replace: true, buckets }
    : undefined;
}

export function codexDisplayFromStream(value: unknown): CodexDisplayUpdate | undefined {
  const limits = asRecord(value);
  if (!limits) return undefined;
  const buckets: CodexDisplayUpdate["buckets"] = {};
  for (const bucket of QUOTA_BUCKET_NAMES) {
    if (!Object.hasOwn(limits, bucket)) continue;
    const row = asRecord(limits[bucket]);
    const used = row?.used_percent,
      minutes = row?.window_minutes,
      reset = row?.reset_at;
    buckets[bucket] =
      typeof used === "number" &&
      Number.isFinite(used) &&
      (minutes == null ||
        (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1)) &&
      (reset == null || (typeof reset === "number" && Number.isSafeInteger(reset) && reset >= 0))
        ? { usedPercent: used, windowMinutes: minutes ?? undefined, resetsAt: reset ?? undefined }
        : null;
  }
  return { replace: false, buckets };
}

export function codexQuota(snapshot: CodexQuotaSnapshot): CodexQuota | undefined {
  const buckets = QUOTA_BUCKET_NAMES.flatMap((name) => snapshot[name] ?? []);
  const weekly = buckets.find((bucket) => bucket.windowMinutes === WEEKLY_WINDOW_MINUTES);
  const short = buckets
    .filter((bucket) => bucket.windowMinutes < WEEKLY_WINDOW_MINUTES)
    .sort((left, right) => left.windowMinutes - right.windowMinutes)[0];
  if (!weekly && !short) return undefined;
  const window = (bucket: CodexQuotaBucket): CodexWindowQuota => ({
    remainingPercent: 100 - Math.round(bucket.usedPercent),
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
  const header = (name: string) => {
    if (typeof headers[name] === "string") return headers[name];
    // Only the local display accepts non-normalized header names. Inspect
    // names without copying other header values (including credentials).
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key];
    }
  };
  const boolean = (name: string): boolean | undefined => {
    const value = header(name)?.trim().toLowerCase();
    return value === "true" || value === "1"
      ? true
      : value === "false" || value === "0"
        ? false
        : undefined;
  };
  return codexCredits({
    has_credits: boolean("x-codex-credits-has-credits"),
    unlimited: boolean("x-codex-credits-unlimited"),
    balance: header("x-codex-credits-balance"),
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
