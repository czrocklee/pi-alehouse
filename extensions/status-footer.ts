import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { OverlayHandle, TuiMouseEvent } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "../lib/token-format.mjs";
import { APPROVAL_INDICATOR, FOOTER_INDICATOR_CLICK_EVENT, HEALTH_INDICATOR, HIDE_TRANSIENT_OVERLAYS_EVENT, PINNED_INDICATORS,
  WORKER_PRESET_INDICATOR, type FooterIndicatorClick } from "../lib/overlay-protocol.mjs";
import { POPOVER as BOX, POPOVER_CLOSE_COLUMNS, isPopoverCloseClick, popoverCloseHit, popoverCloseTail,
  popoverRule, popoverSide } from "../lib/popover-frame.mjs";
// render() returns one clipped line, never a wrapping component: exactly the
// POPOVER_DOCK_ROWS the bottom-right popover column rests on.
import { POPOVER_DOCK_ROWS, joinPopoverStack, stackedOverlayOptions, type StackMember } from "../lib/popover-stack.mjs";
import { SPEND_FIELDS, usageTotals, readUsageAttribution as attribution,
  type UsageTotals, type HostModelSpend as SpendAttribution } from "../lib/usage-attribution.mjs";

const FOOTER_MARKER = "\u0000pi-status-footer\u0000";
// Optional integrations are explicitly configured, never ambient network work.
const DASHBOARD_BASE_URL = (process.env.AGENT_DASHBOARD_URL ?? "").replace(/\/+$/, "");
const GROK_BILLING_ENABLED = process.env.PI_ALEHOUSE_GROK_BILLING === "1";
const DASHBOARD_URL = `${DASHBOARD_BASE_URL}/api/usage/codex`;
const GROK_DASHBOARD_URL = `${DASHBOARD_BASE_URL}/api/usage/grok`;
const GROK_BILLING_URL = `${(process.env.GROK_CLI_CHAT_PROXY_BASE_URL ?? "https://cli-chat-proxy.grok.com/v1").replace(/\/+$/, "")}/billing?format=credits`;
const REQUEST_TIMEOUT_MS = 1_000;
const GROK_REQUEST_TIMEOUT_MS = 5_000;
const GROK_BILLING_MIN_INTERVAL_MS = 60_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const RESET_TIME_TOLERANCE_SECONDS = 5;
const QUOTA_BUCKET_NAMES = ["primary", "secondary"] as const;
const QUOTA_HEADER_NAMES = new Set(
  QUOTA_BUCKET_NAMES.flatMap((bucket) => [
    `x-codex-${bucket}-used-percent`,
    `x-codex-${bucket}-window-minutes`,
    `x-codex-${bucket}-reset-at`,
    `x-codex-${bucket}-reset-after-seconds`,
  ]),
);

/** One row of the breakdown: what a single model, or one of the buckets below,
 * spent across the whole session. */
type ModelSpend = UsageTotals & { key: string };

/** Spend no assistant message of this session claims. `tools` is what an
 * extension put on a tool result -- Pi fills that for no built-in tool, so it
 * means a delegated run billing its parent through a bare Usage with no model
 * on it; a backend that names its models (see `attribution`) gets rows instead
 * and only the remainder lands here. Pi's `/session` lumps these two together
 * as "Tools/summaries"; they answer different questions, so they stay apart. */
const TOOL_SPEND_KEY = "tools";
const SUMMARY_SPEND_KEY = "main · compact/summaries";
const WORKER_COMPACTION_PREFIX = "compaction/";

type CodexQuotaBucket = {
  usedPercent: number;
  resetsAt: number;
  windowMinutes: number;
};

type CodexQuotaSnapshot = Partial<Record<(typeof QUOTA_BUCKET_NAMES)[number], CodexQuotaBucket>>;

type CodexWeeklyQuota = {
  remainingPercent: number;
  resetsAt: number;
};

type GrokWeeklyQuota = {
  remainingPercent: number;
  resetsAt: number;
};

function numberHeader(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function quotaSnapshot(headers: Record<string, string>): CodexQuotaSnapshot {
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
      resetsAt,
      windowMinutes: Math.floor(windowMinutes),
    };
  }
  return snapshot;
}

function quotaSnapshotsEqual(left: CodexQuotaSnapshot | undefined, right: CodexQuotaSnapshot): boolean {
  if (!left) return false;
  return QUOTA_BUCKET_NAMES.every((bucket) => {
    const leftBucket = left[bucket];
    const rightBucket = right[bucket];
    if (!leftBucket || !rightBucket) return leftBucket === rightBucket;
    return (
      leftBucket.usedPercent === rightBucket.usedPercent &&
      leftBucket.windowMinutes === rightBucket.windowMinutes &&
      Math.abs(leftBucket.resetsAt - rightBucket.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
    );
  });
}

function weeklyQuota(snapshot: CodexQuotaSnapshot): CodexWeeklyQuota | undefined {
  const bucket = QUOTA_BUCKET_NAMES.map((name) => snapshot[name]).find(
    (candidate) => candidate?.windowMinutes === WEEKLY_WINDOW_MINUTES,
  );
  if (!bucket) return undefined;
  return {
    remainingPercent: 100 - bucket.usedPercent,
    resetsAt: bucket.resetsAt,
  };
}

function weeklyQuotasEqual(left: CodexWeeklyQuota | undefined, right: CodexWeeklyQuota | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.remainingPercent === right.remainingPercent &&
    Math.abs(left.resetsAt - right.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
  );
}

function quotaHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => QUOTA_HEADER_NAMES.has(name)),
  );
}

async function publishQuota(headers: Record<string, string>): Promise<boolean> {
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

function grokQuotasEqual(left: GrokWeeklyQuota | undefined, right: GrokWeeklyQuota | undefined): boolean {
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

function grokWeeklyQuotaFromBilling(payload: unknown): GrokWeeklyQuota | undefined {
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
        subscriptionTier: payload.subscriptionTier ?? payload.subscription_tier ?? payload.subscription_tier_display,
      }),
      signal: controller.signal,
    });
  } catch {
    // The dashboard is optional; quota publishing must never affect a model response.
  } finally {
    clearTimeout(timeout);
  }
}

function newTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
  if (!usage) return;
  addTotals(totals, usageTotals(usage));
}

function addTotals(totals: UsageTotals, other: UsageTotals): void {
  totals.input += other.input;
  totals.output += other.output;
  totals.cacheRead += other.cacheRead;
  totals.cacheWrite += other.cacheWrite;
  totals.cost += other.cost;
}

const spendTokens = (totals: UsageTotals): number =>
  totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

/** The part of a tool result's usage no model claimed: its own work, plus any
 * delegated spend from a backend that never said whose it was. Clamped at zero
 * so a rounded claim can never turn into a negative row. */
function unclaimed(usage: Usage | undefined, claims: readonly SpendAttribution[]): UsageTotals {
  const rest = newTotals();
  if (!usage) return rest;
  addTotals(rest, usageTotals(usage));
  for (const claim of claims) {
    for (const field of SPEND_FIELDS) rest[field] = Math.max(0, rest[field] - claim[field]);
  }
  return rest;
}

/**
 * Session spend grouped by the model that actually answered, the way Pi's own
 * `/session` breakdown groups it. The footer line sums these rows rather than
 * walking the entries a second time, so the overlay can never disagree with the
 * totals the user clicked.
 */
function collectSpend(ctx: ExtensionContext): ModelSpend[] {
  const byKey = new Map<string, UsageTotals>();
  const bucket = (key: string): UsageTotals => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const totals = newTotals();
    byKey.set(key, totals);
    return totals;
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      // A router alias is not a model: bill the one that answered, when known.
      const message = entry.message;
      const model = message.responseModel ?? message.model;
      addUsage(bucket(`${message.provider}/${model}`), message.usage);
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult"
    ) {
      const usage = entry.message.usage;
      const claims = attribution(usage);
      // Whatever the workers claimed goes to their own models; whatever is left
      // is the tool's own spend, so the two together still equal what Pi counted.
      for (const claim of claims) addTotals(bucket(claim.model), claim);
      addTotals(bucket(TOOL_SPEND_KEY), unclaimed(usage, claims));
    } else if (entry.type === "usage") {
      // SDK cache warming (and future kinds) is independently billed usage,
      // not a conversation message or a second copy of tool/summary spend.
      addUsage(bucket(`${entry.provider}/${entry.model}`), entry.usage);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(bucket(SUMMARY_SPEND_KEY), entry.usage);
    }
  }

  return [...byKey]
    .map(([key, totals]) => ({ key, ...totals }))
    .filter((row) => row.cost > 0 || spendTokens(row) > 0)
    .sort((a, b) => b.cost - a.cost || spendTokens(b) - spendTokens(a) || a.key.localeCompare(b.key));
}

function sumSpend(rows: ModelSpend[]): UsageTotals {
  const totals = newTotals();
  for (const row of rows) addTotals(totals, row);
  return totals;
}

type ThemeColorName = Parameters<Theme["fg"]>[0];

/** Everything sent as prompt, cached or not. Output is not part of the rate. */
const promptTokens = (totals: UsageTotals): number =>
  totals.input + totals.cacheRead + totals.cacheWrite;

/** Share of the prompt the provider served from cache, or null when nothing
 * was sent yet -- which is not the same as a zero hit rate. */
const cacheHitRate = (totals: UsageTotals): number | null => {
  const prompt = promptTokens(totals);
  return prompt > 0 ? (totals.cacheRead / prompt) * 100 : null;
};

const formatHitRate = (rate: number | null): string => (rate == null ? "?" : `${rate.toFixed(1)}%`);

const hitRateColor = (rate: number | null): ThemeColorName =>
  rate == null ? "dim" : rate > 90 ? "success" : rate > 70 ? "warning" : "error";

const formatTokens = (value: number | null | undefined): string =>
  formatTokenCount(value, { precision: "compact" });

/** Hide only the provider in the display; preserve model ids and billing keys. */
const spendModelName = (key: string): string => key.slice(key.indexOf("/") + 1);

function formatContextBar(percent: number | null): string {
  const cells = 6;
  if (percent == null) return "░".repeat(cells);

  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** Labels and paths must not turn the one-row dock into a multi-line footer. */
const oneLine = (text: string): string => text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, " ");

/** The fitted right group may occupy the entire row on a narrow terminal. */
const rightStart = (right: string, width: number): number =>
  Math.max(0, width - visibleWidth(right));

function alignFooter(left: string, right: string, width: number): string {
  const start = rightStart(right, width);
  const shortenedLeft = truncateToWidth(oneLine(left), Math.max(0, start - 1), "");
  return `${shortenedLeft}${" ".repeat(Math.max(0, start - visibleWidth(shortenedLeft)))}${right}`;
}

type BreakdownColumn = {
  label: string;
  /** Order in which a column is given up when the overlay will not fit; the
   * cost column is 0 and is never dropped, because it is the point. */
  drop: number;
  color: ThemeColorName | ((totals: UsageTotals) => ThemeColorName);
  value: (totals: UsageTotals) => string;
};

type BreakdownRow = { key: string; usage: UsageTotals; kind: "model" | "bucket" | "total" };
type BreakdownTable = { body: BreakdownRow[]; hidden: number };

const BREAKDOWN_TITLE = "usage by model";
const BREAKDOWN_MIN_KEY = 6;
const BREAKDOWN_GAP = 2;
/** Non-model rows: frame, headings, total/separator and overflow. */
const BREAKDOWN_CHROME = 6;
const BREAKDOWN_COLUMNS: readonly BreakdownColumn[] = [
  { label: "↑", drop: 4, color: "text", value: (t) => formatTokens(promptTokens(t)) },
  { label: "R", drop: 2, color: "accent", value: (t) => formatTokens(t.cacheRead) },
  // Outlives the raw cache-read count it summarizes: the rate is what says
  // whether a model is being re-prompted at full price.
  { label: "CH", drop: 3, color: (t) => hitRateColor(cacheHitRate(t)), value: (t) => formatHitRate(cacheHitRate(t)) },
  { label: "↓", drop: 5, color: "text", value: (t) => formatTokens(t.output) },
  { label: "$", drop: 0, color: "warning", value: (t) => t.cost.toFixed(3) },
];

const columnColor = (column: BreakdownColumn, totals: UsageTotals): ThemeColorName =>
  typeof column.color === "function" ? column.color(totals) : column.color;

const padEnd = (text: string, size: number): string =>
  text + " ".repeat(Math.max(0, size - visibleWidth(text)));

const padStart = (text: string, size: number): string =>
  " ".repeat(Math.max(0, size - visibleWidth(text))) + text;

function breakdownTable(rows: ModelSpend[], maxRows: number): BreakdownTable {
  const shown = rows.slice(0, Math.max(1, maxRows));
  const body: BreakdownRow[] = shown.map((row) => ({
    key: row.key.startsWith(WORKER_COMPACTION_PREFIX)
      ? `worker compact · ${spendModelName(row.key.slice(WORKER_COMPACTION_PREFIX.length))}`
      : row.key === TOOL_SPEND_KEY || row.key === SUMMARY_SPEND_KEY ? row.key : spendModelName(row.key),
    usage: row,
    kind: row.key === TOOL_SPEND_KEY || row.key === SUMMARY_SPEND_KEY ? "bucket" : "model",
  }));
  // The total covers every row, including the ones the viewport had no room for.
  if (rows.length > 1) body.push({ key: "total", usage: sumSpend(rows), kind: "total" });
  return { body, hidden: rows.length - shown.length };
}

const columnWidth = (column: BreakdownColumn, body: BreakdownRow[]): number =>
  body.reduce((max, row) => Math.max(max, visibleWidth(column.value(row.usage))), visibleWidth(column.label));

const columnsWidth = (columns: readonly BreakdownColumn[], body: BreakdownRow[]): number =>
  columns.reduce((sum, column) => sum + BREAKDOWN_GAP + columnWidth(column, body), 0);

/** The width the table wants. The caller still clamps it to the terminal. */
function breakdownWidth(table: BreakdownTable): number {
  const key = table.body.reduce((max, row) => Math.max(max, visibleWidth(row.key)), visibleWidth("model"));
  return Math.max(key + columnsWidth(BREAKDOWN_COLUMNS, table.body), visibleWidth(BREAKDOWN_TITLE) + 2) + 4;
}

function breakdownFrame(table: BreakdownTable, theme: Theme, width: number): string[] {
  const inner = Math.max(1, width - 4);
  // A narrow terminal gives up the least interesting columns before it starts
  // eating model names, which are what the breakdown is for.
  let columns = [...BREAKDOWN_COLUMNS];
  while (BREAKDOWN_MIN_KEY + columnsWidth(columns, table.body) > inner) {
    const victim = columns.filter((column) => column.drop > 0).sort((a, b) => a.drop - b.drop)[0];
    if (!victim) break;
    columns = columns.filter((column) => column !== victim);
  }
  const sized = columns.map((column) => ({ column, size: columnWidth(column, table.body) }));
  const numeric = sized.reduce((sum, { size }) => sum + BREAKDOWN_GAP + size, 0);
  // With no column left to give up, the names take whatever remains: a name is
  // recoverable from a prefix, a frame missing its closing edge just looks broken.
  const keyWidth = Math.max(1, inner - numeric);
  const outer = (text: string): string => theme.fg("borderAccent", text);
  const rule = (kind: "top" | "bottom" | "divider"): string => popoverRule(theme, width, kind);
  // `used` is the plain width of the cells, which is known before they are
  // colored; measuring the escaped string instead would pad by the wrong amount.
  const row = (cells: string[], used: number): string =>
    `${popoverSide(theme)} ${cells.join("")}${" ".repeat(Math.max(0, inner - used))} ${popoverSide(theme)}`;

  // The close control takes the top edge's right end, as on every popover;
  // too narrow for it, the edge is a plain rule and only the footer closes.
  const closable = !!popoverCloseHit(width);
  // Painted after the edge it ends, like every other part of the frame.
  const tail = (): string => closable ? popoverCloseTail(theme) : outer(BOX.tr);
  const tailWidth = closable ? POPOVER_CLOSE_COLUMNS : 1;
  const titleRoom = width - 4 - tailWidth - visibleWidth(BREAKDOWN_TITLE);
  const lines: string[] = [
    titleRoom >= 0
      ? outer(BOX.tl + BOX.h) + theme.fg("accent", theme.bold(` ${BREAKDOWN_TITLE} `)) +
        outer(BOX.h.repeat(titleRoom)) + tail()
      : closable ? outer(BOX.tl + BOX.h.repeat(width - 1 - tailWidth)) + tail() : rule("top"),
  ];
  if (table.body.length === 0) {
    lines.push(row([theme.fg("dim", padEnd("no usage recorded yet", inner))], inner));
  } else {
    const used = keyWidth + numeric;
    lines.push(row([
      theme.fg("dim", padEnd(truncateToWidth("model", keyWidth, "…"), keyWidth)),
      ...sized.map(({ column, size }) =>
        theme.fg("dim", " ".repeat(BREAKDOWN_GAP) + padStart(column.label, size))),
    ], used));
    for (const entry of table.body) {
      if (entry.kind === "total") lines.push(rule("divider"));
      const emphasize = (text: string): string => (entry.kind === "total" ? theme.bold(text) : text);
      const key = padEnd(truncateToWidth(entry.key, keyWidth, "…"), keyWidth);
      lines.push(row([
        emphasize(theme.fg(entry.kind === "model" ? "accent" : entry.kind === "total" ? "text" : "muted", key)),
        ...sized.map(({ column, size }) => emphasize(theme.fg(
          columnColor(column, entry.usage),
          " ".repeat(BREAKDOWN_GAP) + padStart(column.value(entry.usage), size),
        ))),
      ], used));
    }
    if (table.hidden > 0) {
      lines.push(row([theme.fg("dim", padEnd(`+${table.hidden} more`, used))], used));
    }
  }
  lines.push(rule("bottom"));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

/** Corner position of a pinned indicator, or -1 for an ordinary status. */
const pinned = (key: string): number => (PINNED_INDICATORS as readonly string[]).indexOf(key);

/** The popover titles provide the labels; the dock only needs their values.
 * Keep status keys and value styling intact, including YOLO's red/bold warning. */
const indicatorValue = (key: string, text: string): string =>
  key === APPROVAL_INDICATOR ? text.replace(/^approval: /, "") :
    key === WORKER_PRESET_INDICATOR ? text.replace(/^workers: /, "") : text;

type FooterSegment = { text: string; key?: string; compact?: string };
const FOOTER_SEPARATOR = " · ";

/** Fit whole controls before deriving click geometry. Never clip the right edge
 * or a permission mode into a misleading fragment. Published values stay intact. */
function fitFooterSegments(segments: FooterSegment[], width: number, caret: string): FooterSegment[] {
  if (width <= 0) return [];
  let selected = segments.map((segment) => ({ ...segment }));
  const used = (): number => selected.reduce((sum, segment) => sum + visibleWidth(segment.text),
    Math.max(0, selected.length - 1) * FOOTER_SEPARATOR.length);
  if (used() <= width) return selected;

  // Shed cache detail first, keeping honest, complete token/cost figures.
  for (const segment of selected) if (segment.key === undefined && segment.compact) segment.text = segment.compact;
  if (used() <= width) return selected;
  const worker = selected.find((segment) => segment.key === WORKER_PRESET_INDICATOR);
  const fitWorker = (): void => {
    if (!worker?.compact) return;
    // At least six value columns (including ellipsis) and the two-column caret.
    // Refit from the full value after each omission so spare space restores it.
    const columns = Math.max(8, width - used() + visibleWidth(worker.text));
    worker.text = truncateToWidth(worker.compact, columns - visibleWidth(caret), "…") + caret;
  };
  fitWorker();
  for (const segment of [...selected]) {
    if (used() <= width) break;
    if (segment.key === undefined || pinned(segment.key) < 0) {
      selected.splice(selected.indexOf(segment), 1);
      fitWorker();
    }
  }
  if (used() <= width) return selected;

  selected = selected.filter((segment) => segment.key !== WORKER_PRESET_INDICATOR);
  if (used() <= width) return selected;
  // Extremely narrow: drop carets, then use the health glyph alone. Keep the
  // complete approval mode whenever it fits; never shorten YOLO to e.g. YO….
  for (const segment of selected) if (segment.compact) segment.text = segment.compact;
  if (used() <= width) return selected;
  const health = selected.find((segment) => segment.key === HEALTH_INDICATOR);
  if (health) health.text = truncateToWidth(health.text, 1, "");
  if (used() > width) selected = selected.filter((segment) => segment.key !== APPROVAL_INDICATOR);
  return selected.filter((segment) => visibleWidth(segment.text) > 0);
}

/** A clickable span of the footer row: the usage figures, or one status. */
type FooterHit = { x: number; width: number; key?: string };

export default function (pi: ExtensionAPI) {
  let codexWeeklyQuota: CodexWeeklyQuota | undefined;
  let grokWeeklyQuota: GrokWeeklyQuota | undefined;
  let lastPublishedQuota: CodexQuotaSnapshot | undefined;
  let requestFooterRender: (() => void) | undefined;
  let grokPublishInFlight = false;
  let grokPublishQueued = false;
  let grokPublishForceQueued = false;
  let lastGrokFetchAt = 0;
  // The stack asks every member for its preferred width during each overlay
  // layout. Keep the session walk local to this footer, but let lifecycle
  // boundaries clear it before a width getter can be the first reader.
  let invalidateSpend = () => {};
  const invalidateSpendCache = () => invalidateSpend();
  pi.on("message_end", invalidateSpendCache);
  pi.on("tool_execution_end", invalidateSpendCache);
  pi.on("session_compact", invalidateSpendCache);
  pi.on("session_tree", invalidateSpendCache);
  pi.on("agent_settled", invalidateSpendCache);

  const scheduleGrokPublish = (force = false) => {
    if (!GROK_BILLING_ENABLED) return;
    if (force) grokPublishForceQueued = true;
    if (grokPublishInFlight) {
      grokPublishQueued = true;
      return;
    }
    grokPublishInFlight = true;
    // Fetch billing in Pi, update the footer locally, then inject into the dashboard.
    void (async () => {
      try {
        const shouldForce = grokPublishForceQueued;
        grokPublishForceQueued = false;
        grokPublishQueued = false;
        if (
          !shouldForce &&
          lastGrokFetchAt > 0 &&
          Date.now() - lastGrokFetchAt < GROK_BILLING_MIN_INTERVAL_MS
        ) {
          return;
        }
        const billing = await fetchGrokBilling();
        lastGrokFetchAt = Date.now();
        const quota = grokWeeklyQuotaFromBilling(billing);
        if (quota && !grokQuotasEqual(grokWeeklyQuota, quota)) {
          grokWeeklyQuota = quota;
          requestFooterRender?.();
        }
        if (billing) void injectGrokQuota(billing);
      } finally {
        grokPublishInFlight = false;
        if (grokPublishQueued || grokPublishForceQueued) {
          grokPublishQueued = false;
          scheduleGrokPublish();
        }
      }
    })();
  };

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;

    const headers = quotaHeaders(event.headers);
    const snapshot = quotaSnapshot(headers);
    if (!QUOTA_BUCKET_NAMES.some((bucket) => snapshot[bucket])) return;

    const nextWeeklyQuota = weeklyQuota(snapshot);
    if (!weeklyQuotasEqual(codexWeeklyQuota, nextWeeklyQuota)) {
      codexWeeklyQuota = nextWeeklyQuota;
      requestFooterRender?.();
    }

    if (quotaSnapshotsEqual(lastPublishedQuota, snapshot)) return;

    // Do not delay consumption of the model stream on a best-effort localhost update.
    void publishQuota(headers).then((published) => {
      if (published) lastPublishedQuota = snapshot;
    });
  });

  pi.on("after_provider_response", (_event, ctx) => {
    if (ctx.model?.provider !== "xai") return;
    scheduleGrokPublish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.model?.provider !== "xai") return;
    scheduleGrokPublish(true);
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      // Pi's component tree is top-aligned and has no flex spacer before the
      // footer. Add one at the render boundary so the footer stays on the
      // last terminal row instead of leaving unused rows below it.
      const originalRender = tui.render.bind(tui);
      const renderWithBottomFooter = (width: number): string[] => {
        const rendered = originalRender(width);
        const footerIndex = rendered.findIndex((line) =>
          line.includes(FOOTER_MARKER),
        );
        const lines = rendered.map((line) => line.replace(FOOTER_MARKER, ""));

        if (footerIndex < 0 || footerIndex !== lines.length - 1) {
          return lines;
        }

        const padding = Math.max(0, tui.terminal.rows - lines.length);
        if (padding === 0) return lines;

        return [
          ...lines.slice(0, footerIndex),
          ...Array(padding).fill(" ".repeat(width)),
          ...lines.slice(footerIndex),
        ];
      };
      tui.render = renderWithBottomFooter;

      const renderFooter = () => tui.requestRender();
      requestFooterRender = renderFooter;
      const unsubscribeBranch = footerData.onBranchChange(renderFooter);

      // The per-model breakdown is a fullscreen-only affordance, and for two
      // reasons that happen to coincide: Pi reports mouse events only on the
      // alternate screen, and only its compositor repaints by absolute address.
      // The regular renderer draws into the array that backs scrollback, where
      // one append can commit a row of overlay chrome to terminal history.
      // Held while the panel is pinned, including while it briefly steps aside,
      // so it keeps its place in the bottom-right popover column.
      let member: StackMember | undefined;
      let overlay: OverlayHandle | undefined;
      let cachedSpend: ModelSpend[] | undefined;
      const resetSpend = () => { cachedSpend = undefined; };
      // `getEntries()` returns a new array, so identity cannot identify a
      // stable snapshot. One native footer render or explicit invalidation
      // starts the next snapshot; every width getter and overlay paint in that
      // frame shares its already grouped rows.
      const spend = () => cachedSpend ??= collectSpend(ctx);
      invalidateSpend = resetSpend;
      let restoreTimer: ReturnType<typeof setTimeout> | undefined;
      /** Close-control geometry follows the latest paint, not event bounds. */
      let paintedWidth = 0;
      /** Clickable spans of the footer row as last painted. */
      let footerHits: FooterHit[] = [];
      const maxBreakdownRows = () =>
        (member?.available() ?? tui.terminal.rows - POPOVER_DOCK_ROWS) - BREAKDOWN_CHROME;
      const hideBreakdown = () => {
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = undefined;
        const pinned = member !== undefined || overlay !== undefined;
        overlay?.hide();
        overlay = undefined;
        member?.leave();
        member = undefined;
        paintedWidth = 0;
        if (pinned) tui.requestRender();
      };
      const breakdown = {
        invalidate: resetSpend,
        // The footer begins each native frame with a fresh snapshot. This
        // shares it with every stacked width getter even when focus changes
        // their layout order, while lifecycle invalidation covers a width read
        // that happens before the footer paints.
        render: (width: number): string[] => {
          const lines = breakdownFrame(breakdownTable(spend(), maxBreakdownRows()), theme, width);
          paintedWidth = width;
          member?.measure(lines.length);
          return lines;
        },
        handleMouse(event: TuiMouseEvent) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          // Only the close control closes; clicks on the table leave it pinned.
          if (isPopoverCloseClick(event, paintedWidth)) hideBreakdown();
          return { handled: true };
        },
      };
      const mountBreakdown = (place: StackMember) => {
        overlay = tui.showOverlay(breakdown, stackedOverlayOptions(place, {
          // Grows with new usage and follows resizes without remounting.
          width: () => breakdownWidth(breakdownTable(spend(), maxBreakdownRows())),
          // The editor keeps the keyboard: this is a lightweight panel, not a dialog.
          nonCapturing: true,
        }));
        tui.requestRender();
      };
      const showBreakdown = () => {
        if (member || tui.mode !== "fullscreen") return;
        member = joinPopoverStack(tui);
        mountBreakdown(member);
      };
      // Pi's ui.custom overlay close pops the top of a global stack rather than
      // its own handle. Step aside before a harness panel closes so that the
      // SDK cannot pop this newer overlay and strand the older one, then come
      // back in the same place once that close has run.
      const stepAside = () => {
        if (!overlay) return;
        overlay.hide();
        overlay = undefined;
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoreTimer = undefined;
          if (member && !overlay && tui.mode === "fullscreen") mountBreakdown(member);
        }, 0);
      };
      const unsubscribeTransientOverlayHide = pi.events.on(HIDE_TRANSIENT_OVERLAYS_EVENT, stepAside);
      // Click-to-pin: pointer motion, typing and pasting leave the panel alone.
      // Only its close control, another click on the usage figures or host
      // teardown closes it.

      return {
        dispose() {
          hideBreakdown();
          unsubscribeTransientOverlayHide();
          unsubscribeBranch();
          if (requestFooterRender === renderFooter) requestFooterRender = undefined;
          if (invalidateSpend === resetSpend) invalidateSpend = () => {};
          if (tui.render === renderWithBottomFooter) {
            tui.render = originalRender;
          }
        },
        invalidate: resetSpend,

        handleMouse(event: TuiMouseEvent) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          const hit = footerHits.find((span) => event.x >= span.x && event.x < span.x + span.width);
          if (hit?.key !== undefined) {
            // A status belongs to its extension; offer it the click first.
            const click: FooterIndicatorClick = { key: hit.key, handled: false };
            pi.events.emit(FOOTER_INDICATOR_CLICK_EVENT, click);
            if (click.handled) return { handled: true };
          }
          if (member) hideBreakdown();
          else showBreakdown();
          return { handled: true };
        },

        render(width: number): string[] {
          // The root footer paints once before Pi composites overlays. Reset at
          // that render boundary rather than in the shared stack, whose width
          // getter is intentionally evaluated for every open popover.
          resetSpend();
          const totals = sumSpend(spend());
          const context = ctx.getContextUsage();
          const contextPercent = context?.percent ?? null;
          const contextText = `${formatTokens(context?.tokens)}/${formatTokens(
            context?.contextWindow,
          )} ${formatContextBar(contextPercent)} ${
            contextPercent == null ? "?" : `${contextPercent.toFixed(1)}%`
          }`;

          const contextDisplay =
            contextPercent != null && contextPercent > 90
              ? theme.fg("error", contextText)
              : contextPercent != null && contextPercent > 70
                ? theme.fg("warning", contextText)
                : theme.fg("success", contextText);

          const branch = footerData.getGitBranch();
          const location = `${theme.fg("accent", formatCwd(ctx.cwd))}${
            branch ? ` ${theme.fg("success", `(${branch})`)}` : ""
          }`;
          const provider = ctx.model?.provider;
          const model = ctx.model?.id ?? "no-model";
          const thinking = ctx.model?.reasoning
            ? ` (${ctx.thinkingLevel ?? "off"})`
            : "";
          const subscription =
            provider === "openai-codex" || provider === "kimi-coding"
              ? " sub"
              : "";
          const totalInput = promptTokens(totals);
          const rate = cacheHitRate(totals);
          const cacheWrite =
            totals.cacheWrite > 0
              ? ` +${formatTokens(totals.cacheWrite)}`
              : "";
          const cacheHitDisplay = theme.fg(hitRateColor(rate), formatHitRate(rate));
          const label = (text: string) => theme.fg("muted", text);
          const value = (text: string) => theme.fg("text", text);
          const cost = `${theme.fg(
            "warning",
            `$${totals.cost.toFixed(3)}`,
          )}${subscription ? theme.fg("dim", subscription) : ""}`;
          const input = `${value(formatTokens(totalInput))} (${theme.fg(
            "accent",
            `${formatTokens(totals.cacheRead)}${cacheWrite}`,
          )}, ${cacheHitDisplay})`;

          const modelDisplay = `${theme.fg("accent", model)}${
            thinking ? theme.fg("muted", thinking) : ""
          }`;
          const caret = ` ${theme.fg("dim", "▴")}`;
          const statuses = [...footerData.getExtensionStatuses()]
            // Subagent status belongs in its own widget, not in this footer.
            .filter(([key]) => key !== "subagents")
            .map(([key, text]) => ({ key, text: indicatorValue(key, oneLine(text).replace(/ +/g, " ").trim()) }))
            .filter(({ text }) => text)
            // Fixed worker → approval → health order, not attention-based sorting.
            .sort((a, b) => pinned(a.key) - pinned(b.key))
            .map(({ key, text }) => ({ key, text: pinned(key) >= 0 ? text + caret : text,
              ...(pinned(key) >= 0 ? { compact: text } : {}) }));
          const segments = fitFooterSegments([
            { text: `${theme.fg("accent", "↑")} ${input}`,
              compact: `${theme.fg("accent", "↑")} ${value(formatTokens(totalInput))}` },
            { text: `${theme.fg("accent", "↓")} ${value(formatTokens(totals.output))}` },
            { text: cost },
            ...statuses,
          ], width, caret);
          const right = segments.map((segment) => segment.text).join(FOOTER_SEPARATOR);

          let quotaDisplay: string | undefined;
          const quotaIsCurrent =
            provider === "openai-codex" &&
            codexWeeklyQuota &&
            (codexWeeklyQuota.resetsAt === 0 || codexWeeklyQuota.resetsAt > Date.now() / 1_000);
          if (quotaIsCurrent && codexWeeklyQuota) {
            const remaining = Math.round(codexWeeklyQuota.remainingPercent);
            const quotaColor = remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "success";
            quotaDisplay = `${label("W")} ${theme.fg(quotaColor, `${remaining}%`)}`;
          } else if (
            provider === "xai" &&
            grokWeeklyQuota &&
            (grokWeeklyQuota.resetsAt === 0 || grokWeeklyQuota.resetsAt > Date.now() / 1_000)
          ) {
            const remaining = Math.round(grokWeeklyQuota.remainingPercent);
            const quotaColor = remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "success";
            quotaDisplay = `${label("W")} ${theme.fg(quotaColor, `${remaining}%`)}`;
          }

          const left = [
            location,
            modelDisplay,
            ...(quotaDisplay ? [quotaDisplay] : []),
            contextDisplay,
          ].join(" · ");
          // The shim that reads this marker wraps the regular renderer's own
          // render(); the alternate screen lays the dock out from its layout
          // root instead, never calls it, and would print the marker verbatim.
          const marker = tui.mode === "fullscreen" ? "" : FOOTER_MARKER;
          // Geometry comes only from this fitted paint, including shortened
          // worker values. Hidden controls and separators have no indicator hit.
          let x = rightStart(right, width);
          footerHits = [];
          for (const segment of segments) {
            const span = visibleWidth(segment.text);
            if (span > 0) footerHits.push({ x, width: span, key: segment.key });
            x += span + FOOTER_SEPARATOR.length;
          }
          return [`${alignFooter(left, right, width)}${marker}`];
        },
      };
    });
  });
}
