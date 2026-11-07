import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "../../lib/token-format.mjs";
import {
  APPROVAL_INDICATOR,
  HEALTH_INDICATOR,
  PINNED_INDICATORS,
  WORKER_PRESET_INDICATOR,
} from "../../lib/overlay-protocol.mjs";
import {
  POPOVER as BOX,
  POPOVER_CLOSE_COLUMNS,
  popoverCloseHit,
  popoverCloseTail,
  popoverRule,
  popoverSide,
  popoverTitleRow,
} from "../../lib/popover-frame.mjs";
import type { UsageTotals } from "../../lib/usage-attribution.mjs";
import type { ContextSnapshot } from "./context-stats.ts";
import {
  promptTokens,
  cacheHitRate,
  sumSpend,
  TOOL_SPEND_KEY,
  SUMMARY_SPEND_KEY,
  WORKER_COMPACTION_PREFIX,
  type ModelSpend,
} from "./session-spend.ts";
import {
  quotaWindowLabel,
  wholeCreditBalance,
  type CodexQuota,
  type CodexCredits,
} from "./codex-quota.ts";
import type { GrokBillingSnapshot } from "./grok-billing.ts";

type ThemeColorName = Parameters<Theme["fg"]>[0];

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

function formatCwd(cwd: string, home: string | undefined): string {
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

export type PhysicalRoute = { id: string; thinkingLevel?: string };
type FooterModel = { id: string; provider: string; reasoning?: boolean };

function modelLabel(
  ctx: { model?: FooterModel; thinkingLevel?: string },
  theme: Theme,
  route: PhysicalRoute | undefined,
): string {
  const selected = ctx.model?.id ?? "no-model";
  const thinking = ctx.model?.reasoning ? ` (${ctx.thinkingLevel ?? "off"})` : "";
  const selection = `${theme.fg("accent", selected)}${thinking ? theme.fg("muted", thinking) : ""}`;
  if (!route) return selection;
  const level = route.thinkingLevel ? theme.fg("muted", ` (${route.thinkingLevel})`) : "";
  return `${selection}${theme.fg("muted", " \u2192 ")}${theme.fg("accent", route.id)}${level}`;
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
export const BREAKDOWN_CHROME = 6;
const BREAKDOWN_COLUMNS: readonly BreakdownColumn[] = [
  { label: "↑", drop: 4, color: "text", value: (t) => formatTokens(promptTokens(t)) },
  { label: "R", drop: 2, color: "accent", value: (t) => formatTokens(t.cacheRead) },
  // Outlives the raw cache-read count it summarizes: the rate is what says
  // whether a model is being re-prompted at full price.
  {
    label: "CH",
    drop: 3,
    color: (t) => hitRateColor(cacheHitRate(t)),
    value: (t) => formatHitRate(cacheHitRate(t)),
  },
  { label: "↓", drop: 5, color: "text", value: (t) => formatTokens(t.output) },
  { label: "$", drop: 0, color: "warning", value: (t) => t.cost.toFixed(3) },
];

const columnColor = (column: BreakdownColumn, totals: UsageTotals): ThemeColorName =>
  typeof column.color === "function" ? column.color(totals) : column.color;

const padEnd = (text: string, size: number): string =>
  text + " ".repeat(Math.max(0, size - visibleWidth(text)));

const padStart = (text: string, size: number): string =>
  " ".repeat(Math.max(0, size - visibleWidth(text))) + text;

export function breakdownTable(rows: ModelSpend[], maxRows: number): BreakdownTable {
  const shown = rows.slice(0, Math.max(1, maxRows));
  const body: BreakdownRow[] = shown.map((row) => ({
    key: row.key.startsWith(WORKER_COMPACTION_PREFIX)
      ? `worker compact · ${spendModelName(row.key.slice(WORKER_COMPACTION_PREFIX.length))}`
      : row.key === TOOL_SPEND_KEY || row.key === SUMMARY_SPEND_KEY
        ? row.key
        : spendModelName(row.key),
    usage: row,
    kind: row.key === TOOL_SPEND_KEY || row.key === SUMMARY_SPEND_KEY ? "bucket" : "model",
  }));
  // The total covers every row, including the ones the viewport had no room for.
  if (rows.length > 1) body.push({ key: "total", usage: sumSpend(rows), kind: "total" });
  return { body, hidden: rows.length - shown.length };
}

const columnWidth = (column: BreakdownColumn, body: BreakdownRow[]): number =>
  body.reduce(
    (max, row) => Math.max(max, visibleWidth(column.value(row.usage))),
    visibleWidth(column.label),
  );

const columnsWidth = (columns: readonly BreakdownColumn[], body: BreakdownRow[]): number =>
  columns.reduce((sum, column) => sum + BREAKDOWN_GAP + columnWidth(column, body), 0);

/** The width the table wants. The caller still clamps it to the terminal. */
export function breakdownWidth(table: BreakdownTable): number {
  const key = table.body.reduce(
    (max, row) => Math.max(max, visibleWidth(row.key)),
    visibleWidth("model"),
  );
  return (
    Math.max(key + columnsWidth(BREAKDOWN_COLUMNS, table.body), visibleWidth(BREAKDOWN_TITLE) + 2) +
    4
  );
}

export function breakdownFrame(table: BreakdownTable, theme: Theme, width: number): string[] {
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
  const tail = (): string => (closable ? popoverCloseTail(theme) : outer(BOX.tr));
  const tailWidth = closable ? POPOVER_CLOSE_COLUMNS : 1;
  const titleRoom = width - 4 - tailWidth - visibleWidth(BREAKDOWN_TITLE);
  const lines: string[] = [
    titleRoom >= 0
      ? popoverTitleRow(
          theme,
          width,
          BREAKDOWN_TITLE,
          { clip: (text, columns) => truncateToWidth(text, columns, "…"), width: visibleWidth },
          closable,
        )
      : closable
        ? outer(BOX.tl + BOX.h.repeat(width - 1 - tailWidth)) + tail()
        : rule("top"),
  ];
  if (table.body.length === 0) {
    lines.push(row([theme.fg("dim", padEnd("no usage recorded yet", inner))], inner));
  } else {
    const used = keyWidth + numeric;
    lines.push(
      row(
        [
          theme.fg("dim", padEnd(truncateToWidth("model", keyWidth, "…"), keyWidth)),
          ...sized.map(({ column, size }) =>
            theme.fg("dim", " ".repeat(BREAKDOWN_GAP) + padStart(column.label, size)),
          ),
        ],
        used,
      ),
    );
    for (const entry of table.body) {
      if (entry.kind === "total") lines.push(rule("divider"));
      const emphasize = (text: string): string =>
        entry.kind === "total" ? theme.bold(text) : text;
      const key = padEnd(truncateToWidth(entry.key, keyWidth, "…"), keyWidth);
      lines.push(
        row(
          [
            emphasize(
              theme.fg(
                entry.kind === "model" ? "accent" : entry.kind === "total" ? "text" : "muted",
                key,
              ),
            ),
            ...sized.map(({ column, size }) =>
              emphasize(
                theme.fg(
                  columnColor(column, entry.usage),
                  " ".repeat(BREAKDOWN_GAP) + padStart(column.value(entry.usage), size),
                ),
              ),
            ),
          ],
          used,
        ),
      );
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
  key === APPROVAL_INDICATOR
    ? text.replace(/^approval: /, "")
    : key === WORKER_PRESET_INDICATOR
      ? text.replace(/^(?:delegation|workers): /, "")
      : text;

/** A usage figure or a status. Usage figures are told apart by their own
 * `↑`/`↓`/`$`, so a space separates them; a dot separates everything else. */
type FooterSegment = { text: string; key?: string; compact?: string; usage?: boolean };
const FOOTER_SEPARATOR = " · ";
const USAGE_SEPARATOR = " ";

/** What precedes `segments[index]` on the row. */
const joint = (segments: readonly FooterSegment[], index: number): string =>
  index === 0
    ? ""
    : segments[index - 1]!.usage && segments[index]!.usage
      ? USAGE_SEPARATOR
      : FOOTER_SEPARATOR;

const footerWidth = (segments: readonly FooterSegment[]): number =>
  segments.reduce(
    (sum, segment, index) => sum + joint(segments, index).length + visibleWidth(segment.text),
    0,
  );

/** Fit whole controls before deriving click geometry. Never clip the right edge
 * or a permission mode into a misleading fragment. Published values stay intact. */
function fitFooterSegments(segments: FooterSegment[], width: number): FooterSegment[] {
  if (width <= 0) return [];
  let selected = segments.map((segment) => ({ ...segment }));
  const used = (): number => footerWidth(selected);
  if (used() <= width) return selected;

  // Shed the hit rate first, keeping honest, complete token/cost figures.
  for (const segment of selected)
    if (segment.key === undefined && segment.compact) segment.text = segment.compact;
  if (used() <= width) return selected;
  const worker = selected.find((segment) => segment.key === WORKER_PRESET_INDICATOR);
  const full = worker?.text;
  const fitWorker = (): void => {
    if (!worker || full === undefined) return;
    // At least six value columns, ellipsis included. Refit from the full
    // value after each omission so spare space restores it.
    const columns = Math.max(6, width - used() + visibleWidth(worker.text));
    worker.text = truncateToWidth(full, columns, "…");
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
  // Extremely narrow: health keeps one cell (Stats publishes a single dot).
  // Keep the complete approval mode whenever it fits; never shorten YOLO to e.g. YO….
  const health = selected.find((segment) => segment.key === HEALTH_INDICATOR);
  if (health) health.text = truncateToWidth(health.text, 1, "");
  if (used() > width) selected = selected.filter((segment) => segment.key !== APPROVAL_INDICATOR);
  return selected.filter((segment) => visibleWidth(segment.text) > 0);
}

/** A clickable span of the footer row: the usage figures, or one status. */
export type FooterHit = { x: number; width: number; key?: string; context?: boolean };

export function contextSummary(snapshot: ContextSnapshot, reason: string): string {
  return [
    "Context · main session",
    `${formatTokens(snapshot.usage.tokens)}/${formatTokens(snapshot.usage.contextWindow || null)}`,
    ...snapshot.categories
      .filter((row) => row.rawTokens > 0 || row.count > 0)
      .map((row) => `${row.label}: ≈${formatTokens(row.tokens)}`),
    snapshot.note,
    reason,
  ].join("\n");
}

function contextControl(
  usage: ContextUsage,
  theme: Theme,
  width: number,
  progress?: string,
): string {
  const fraction = `${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow > 0 ? usage.contextWindow : null)}`;
  const percent = usage.percent == null ? "?" : `${usage.percent.toFixed(1)}%`;
  const bar = formatContextBar(usage.percent);
  const tone =
    usage.percent == null
      ? "dim"
      : usage.percent > 90
        ? "error"
        : usage.percent > 70
          ? "warning"
          : "success";
  const candidates = progress
    ? [
        `${theme.fg("muted", `${fraction} ${bar}`)} ${theme.fg("accent", progress)}`,
        `${theme.fg("muted", fraction)} ${theme.fg("accent", progress)}`,
        theme.fg("accent", progress),
      ]
    : [
        theme.fg(tone, `${fraction} ${bar} ${percent}`),
        theme.fg(tone, `${fraction} ${percent}`),
        theme.fg(tone, fraction),
      ];
  return candidates.find((text) => visibleWidth(text) <= width) ?? "";
}

export type FooterPaintInput = {
  width: number;
  theme: Theme;
  totals: UsageTotals;
  context: ContextUsage;
  cwd: string;
  home: string | undefined;
  branch: string | null | undefined;
  model: FooterModel | undefined;
  thinkingLevel: string | undefined;
  route: PhysicalRoute | undefined;
  subscription: string;
  statuses: Iterable<readonly [string, string]>;
  codex: CodexQuota | undefined;
  credits: CodexCredits | undefined;
  grok: GrokBillingSnapshot;
  progress: string | undefined;
  nowSeconds: number;
  nowMs: number;
};

/** Pure synchronous paint: fitting, text and hit spans are one result. No host
 * reads, clock sampling, accounting traversal, network or UI mutation here. */
export function paintFooter(input: FooterPaintInput): { row: string; hits: FooterHit[] } {
  const { width, theme, totals, context, branch, model, subscription, codex, credits, grok } =
    input;
  const location = `${theme.fg("accent", formatCwd(input.cwd, input.home))}${
    branch ? ` ${theme.fg("success", `(${branch})`)}` : ""
  }`;
  const provider = model?.provider;
  const totalInput = promptTokens(totals);
  const rate = cacheHitRate(totals);
  const cacheHitDisplay = theme.fg(hitRateColor(rate), formatHitRate(rate));
  const label = (text: string) => theme.fg("muted", text);
  const value = (text: string) => theme.fg("text", text);
  const cost = `${theme.fg(
    "warning",
    `$${totals.cost.toFixed(3)}`,
  )}${subscription ? theme.fg("dim", subscription) : ""}`;
  const usageInput = `${value(formatTokens(totalInput))} (${cacheHitDisplay})`;

  const modelDisplay = modelLabel(input, theme, input.route);
  const statuses = [...input.statuses]
    // Subagent status belongs in its own widget, not in this footer.
    .filter(([key]) => key !== "subagents")
    .map(([key, text]) => ({
      key,
      text: indicatorValue(key, oneLine(text).replace(/ +/g, " ").trim()),
    }))
    .filter(({ text }) => text)
    // Fixed worker → approval → health order, not attention-based sorting.
    .sort((a, b) => pinned(a.key) - pinned(b.key));
  const segments = fitFooterSegments(
    [
      {
        text: `${theme.fg("accent", "↑")}${usageInput}`,
        compact: `${theme.fg("accent", "↑")}${value(formatTokens(totalInput))}`,
        usage: true,
      },
      {
        text: `${theme.fg("accent", "↓")}${value(formatTokens(totals.output))}`,
        usage: true,
      },
      { text: cost, usage: true },
      ...statuses,
    ],
    width,
  );
  const right = segments.map((segment, index) => joint(segments, index) + segment.text).join("");
  const leftRoom = Math.max(0, rightStart(right, width) - 1);
  const contextDisplay = contextControl(context, theme, leftRoom, input.progress);
  const prefixRoom = Math.max(
    0,
    leftRoom - visibleWidth(contextDisplay) - (contextDisplay ? FOOTER_SEPARATOR.length : 0),
  );

  // A window whose reset has passed shows nothing until the next response.
  const current = <T extends { resetsAt: number }>(quota: T | undefined) =>
    quota && (quota.resetsAt === 0 || quota.resetsAt > input.nowSeconds) ? quota : undefined;
  const remaining = (window: string, remainingPercent: number) => {
    const percent = Math.round(remainingPercent);
    const quotaColor = percent <= 10 ? "error" : percent <= 25 ? "warning" : "success";
    return `${label(window)} ${theme.fg(quotaColor, `${percent}%`)}`;
  };
  const codexShort = current(codex?.short);
  const codexWeekly = current(codex?.weekly);
  const creditBalance = credits?.unlimited ? "∞" : credits?.balance;
  const wholeBalance = creditBalance === undefined ? undefined : wholeCreditBalance(creditBalance);
  const subscriptionExhausted = codexShort?.exhausted === true || codexWeekly?.exhausted === true;
  const creditDisplay =
    !subscriptionExhausted || wholeBalance === undefined
      ? undefined
      : `${label("Cr")} ${theme.fg(wholeBalance === "0" ? "error" : "text", wholeBalance)}`;
  const grokWeekly = provider === "xai" ? current(grok.quota) : undefined;
  const codexParts = [
    ...(codexShort
      ? [remaining(quotaWindowLabel(codexShort.windowMinutes), codexShort.remainingPercent)]
      : []),
    ...(codexWeekly ? [remaining("W", codexWeekly.remainingPercent)] : []),
  ];
  if (creditDisplay) {
    const throughCredits = [location, modelDisplay, [...codexParts, creditDisplay].join(" ")].join(
      " · ",
    );
    // Never clip a credit balance into a different whole-credit value.
    if (visibleWidth(oneLine(throughCredits)) <= prefixRoom) codexParts.push(creditDisplay);
  }
  const codexDisplay = codexParts.join(" ");
  let grokDisplay: string | undefined;
  if (provider === "xai" && grok.enabled) {
    const pending = grok.pending;
    const age =
      grok.lastSuccessAt === undefined
        ? undefined
        : Math.max(0, Math.floor((input.nowMs - grok.lastSuccessAt) / 1000));
    const stale =
      grok.failed || !grokWeekly || (age !== undefined && age * 1000 >= grok.minIntervalMs);
    const state = pending ? "pending" : stale ? "stale" : "";
    const freshness =
      age === undefined
        ? pending
          ? "pending"
          : grok.failed
            ? "unavailable"
            : "not checked"
        : `${state ? `${state}; ` : ""}updated ${age}s ago`;
    grokDisplay =
      `${grokWeekly ? remaining("W", grokWeekly.remainingPercent) : label("billing")} ` +
      theme.fg(state || age === undefined ? "warning" : "dim", `[${freshness}]`);
  }
  const quotaDisplay = codexDisplay || grokDisplay;

  // Quota values are atomic: never turn W 12% into W 1…. Path/model
  // chrome gives way first; right-hand approval/health stay unchanged.
  const quotaParts = codexDisplay ? codexParts : quotaDisplay ? [quotaDisplay] : [];
  const fittedQuota: string[] = [];
  for (const part of quotaParts) {
    if (visibleWidth([...fittedQuota, part].join(" ")) <= prefixRoom) fittedQuota.push(part);
  }
  const quotaText = fittedQuota.join(" ");
  const chrome = truncateToWidth(
    oneLine([location, modelDisplay].join(FOOTER_SEPARATOR)),
    Math.max(0, prefixRoom - visibleWidth(quotaText) - (quotaText ? FOOTER_SEPARATOR.length : 0)),
    "…",
  );
  const prefix =
    chrome && quotaText ? `${chrome}${FOOTER_SEPARATOR}${quotaText}` : chrome || quotaText;
  const contextX = prefix && contextDisplay ? visibleWidth(prefix) + FOOTER_SEPARATOR.length : 0;
  const left =
    prefix && contextDisplay
      ? `${prefix}${FOOTER_SEPARATOR}${contextDisplay}`
      : prefix || contextDisplay;
  // Geometry comes only from this fitted paint, including shortened worker
  // values. Hidden controls and separators have no indicator hit.
  let x = rightStart(right, width);
  const hits: FooterHit[] = contextDisplay
    ? [{ x: contextX, width: visibleWidth(contextDisplay), context: true }]
    : [];
  segments.forEach((segment, index) => {
    x += joint(segments, index).length;
    const span = visibleWidth(segment.text);
    if (span > 0) hits.push({ x, width: span, key: segment.key });
    x += span;
  });
  return { row: alignFooter(left, right, width), hits };
}
