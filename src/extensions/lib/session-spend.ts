import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
  SPEND_FIELDS,
  usageTotals,
  readUsageAttribution as attribution,
  type UsageTotals,
  type HostModelSpend as SpendAttribution,
} from "../../shared/usage-attribution.mjs";

/** One row of the breakdown: what a single model, or one of the buckets below,
 * spent across the whole session. */
export type ModelSpend = UsageTotals & { key: string };

/** Spend no assistant message of this session claims. `tools` is what an
 * extension put on a tool result -- Pi fills that for no built-in tool, so it
 * means a delegated run billing its parent through a bare Usage with no model
 * on it; a backend that names its models (see `attribution`) gets rows instead
 * and only the remainder lands here. Pi's `/session` lumps these two together
 * as "Tools/summaries"; they answer different questions, so they stay apart. */
export const TOOL_SPEND_KEY = "tools";
export const SUMMARY_SPEND_KEY = "main · compact/summaries";
export const WORKER_COMPACTION_PREFIX = "compaction/";

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
function addSpend(byKey: Map<string, UsageTotals>, entries: readonly SessionEntry[]): void {
  const bucket = (key: string): UsageTotals => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const totals = newTotals();
    byKey.set(key, totals);
    return totals;
  };

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      // A router alias is not a model: bill the one that answered, when known.
      const message = entry.message;
      const model = message.responseModel ?? message.model;
      addUsage(bucket(`${message.provider}/${model}`), message.usage);
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
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
}

function spendRows(byKey: Map<string, UsageTotals>): ModelSpend[] {
  return [...byKey]
    .map(([key, totals]) => ({ key, ...totals }))
    .filter((row) => row.cost > 0 || spendTokens(row) > 0)
    .sort(
      (a, b) => b.cost - a.cost || spendTokens(b) - spendTokens(a) || a.key.localeCompare(b.key),
    );
}

type SessionStamp = { id: string; leaf: string | null; count?: number };
export type SessionSource = { manager: ExtensionContext["sessionManager"]; stamp?: SessionStamp };
export type ContextSource = SessionSource & { key?: string };

/** Public branch identity; count is an optional FULL journal revision. A leaf
 * identifies immutable branch context, not all billed/abandoned entries. */
function sessionStamp(manager: ExtensionContext["sessionManager"]): SessionStamp | undefined {
  try {
    const id = manager.getSessionId?.();
    const leaf = manager.getLeafId?.();
    // Public on SessionManager, but optional/not in every host's read-only
    // extension view. Never reach into fileEntries/byId to synthesize it.
    const count = (manager as typeof manager & { getEntryCount?: () => number }).getEntryCount?.();
    if (typeof id !== "string" || !id || !(leaf === null || typeof leaf === "string"))
      return undefined;
    return {
      id,
      leaf,
      ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? { count } : {}),
    };
  } catch {
    return undefined;
  }
}

export function sessionSource(ctx: ExtensionContext): SessionSource {
  const manager = ctx.sessionManager;
  return { manager, stamp: sessionStamp(manager) };
}

/** Presentation-only memo, including valid undefined results (no route). An
 * unavailable public key NEVER reuses data. Each consumer owns its own memo. */
export function presentationMemo<T>() {
  let cached: { manager: SessionSource["manager"]; key: string; value: T } | undefined;
  return {
    read(source: ContextSource, collect: () => T, key = source.key): T {
      if (key === undefined) return collect();
      if (cached?.manager === source.manager && cached.key === key) return cached.value;
      const value = collect();
      cached = { manager: source.manager, key, value };
      return value;
    },
    clear() {
      cached = undefined;
    },
  };
}

/** Full-session accounting, not a branch projection. A parent walk is usable
 * only when it accounts for EVERY newly appended entry; otherwise rebuild from
 * all entries, including abandoned branches. No SDK-owned arrays are retained. */
export function spendReader(): (source: SessionSource) => ModelSpend[] {
  let manager: ExtensionContext["sessionManager"] | undefined;
  let identity: string | undefined;
  let count: number | undefined;
  let leaf: string | null | undefined;
  let rows: ModelSpend[] = [];
  const seen = new Set<string>();
  const byKey = new Map<string, UsageTotals>();
  return (source) => {
    const { stamp } = source;
    const sameSession = manager === source.manager && identity === stamp?.id;
    // Without a reliable full-journal revision, A → unobserved paid B → A
    // cannot be detected from the leaf. Read all spend freshly in that case.
    if (sameSession && stamp?.count !== undefined && stamp.count === count && stamp.leaf === leaf)
      return rows;
    let added: SessionEntry[] | undefined;
    if (sameSession && stamp?.count !== undefined && count !== undefined && stamp.count >= count) {
      const delta = stamp.count - count;
      if (delta === 0) {
        leaf = stamp.leaf;
        return rows; // Tree navigation never subtracts session spend.
      }
      if (typeof source.manager.getEntry === "function") {
        try {
          const pending: SessionEntry[] = [];
          let id = stamp.leaf;
          while (id && !seen.has(id) && pending.length < delta) {
            const entry = source.manager.getEntry(id);
            if (!entry || entry.id !== id) break;
            pending.push(entry);
            id = entry.parentId;
          }
          if (pending.length === delta && (id === null || (id !== undefined && seen.has(id)))) {
            added = pending.reverse();
          }
        } catch {
          /* Unknown traversal: use the complete public entry list. */
        }
      }
    }
    if (!added) {
      added = source.manager.getEntries();
      byKey.clear();
      seen.clear();
    }
    addSpend(byKey, added);
    for (const entry of added) seen.add(entry.id);
    rows = spendRows(byKey);
    manager = source.manager;
    identity = stamp?.id;
    count = stamp?.count;
    leaf = stamp?.leaf;
    return rows;
  };
}

export function sumSpend(rows: ModelSpend[]): UsageTotals {
  const totals = newTotals();
  for (const row of rows) addTotals(totals, row);
  return totals;
}

/** Everything sent as prompt, cached or not. Output is not part of the rate. */
export const promptTokens = (totals: UsageTotals): number =>
  totals.input + totals.cacheRead + totals.cacheWrite;

/** Share of the prompt the provider served from cache, or null when nothing
 * was sent yet -- which is not the same as a zero hit rate. */
export const cacheHitRate = (totals: UsageTotals): number | null => {
  const prompt = promptTokens(totals);
  return prompt > 0 ? (totals.cacheRead / prompt) * 100 : null;
};
