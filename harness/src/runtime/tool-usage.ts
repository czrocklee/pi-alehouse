import { USAGE_COMPONENTS, type UsageComponent, type UsageLedger } from "../core/usage-ledger.js";

import { readUsageAttribution, type HostModelSpend, type HostUsage } from "../../../lib/usage-attribution.mjs";
export type { HostModelSpend, HostUsage } from "../../../lib/usage-attribution.mjs";
const spendOf = (child: UsageLedger): HostModelSpend[] =>
  Object.entries(child.byModel).map(([model, t]) => ({ model, input: t.input, output: t.output,
    cacheRead: t.cache_read, cacheWrite: t.cache_write, cost: t.cost }));

/**
 * Projects settled child spend onto a tool result, so Pi's footer and cost
 * breakdown account for work done in sessions it cannot see.
 *
 * Takes a ledger rather than a Usage: only the ledger separates what was
 * reported from what nobody reported, so what a Run DID bill survives a
 * sibling that billed nothing. `prior` is the usage the tool reported for
 * itself, which must survive: this adds to it, never replaces it. Harness-owned
 * metadata preserves incomplete components, but Pi's footer ignores it and
 * displays observed lower bounds without a marker. Never discard known spend,
 * unknown marker rows, or genuinely free rows to hide this SDK limitation.
 */
export function hostUsage(child: UsageLedger, prior?: HostUsage): HostUsage {
  const { input, output, cache_read: cacheRead, cache_write: cacheWrite } = child.total;
  const totalTokens = input + output + cacheRead + cacheWrite;
  // Only the total is ours to report; a per-component split nobody measured
  // would be an invented number, so the components stay the caller's own.
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: child.total.cost };
  // The split has to be merged the same way the totals are, or a second drain
  // onto the same result would leave rows that no longer add up to them.
  // Foreign rows are claims against prior flat totals, not additional spend.
  // Invalid claims stay unattributed; the tool's own flat usage still survives.
  const priorRows = readUsageAttribution(prior);
  // The reader intentionally strips completeness metadata for display. Preserve
  // conservative markers separately, even when a malformed share is rejected.
  const rawRows = Array.isArray(prior?.harnessModels) ? prior.harnessModels : [];
  const has = (value: unknown, key: UsageComponent): boolean => Array.isArray(value) && value.includes(key);
  const partial = USAGE_COMPONENTS.filter((key) => child.partial.includes(key) || has(prior?.harnessPartial, key) ||
    rawRows.some((row) => has(row?.partial, key)));
  const merged = new Map<string, HostModelSpend>();
  for (const row of [...priorRows, ...spendOf(child)]) {
    const seen = merged.get(row.model);
    if (!seen) { merged.set(row.model, { ...row }); continue; }
    seen.input += row.input; seen.output += row.output;
    seen.cacheRead += row.cacheRead; seen.cacheWrite += row.cacheWrite; seen.cost += row.cost;
  }
  // Biggest bill first, ties by name: the same ledger always serializes the same.
  const rows = [...merged.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))
    .map(({ partial: _old, ...row }) => ({ ...row, ...(partial.length ? { partial: [...partial] } : {}) }));
  const metadata = { ...(rows.length ? { harnessModels: rows } : {}), ...(partial.length ? { harnessPartial: partial } : {}) };
  if (!prior) return { input, output, cacheRead, cacheWrite, totalTokens, cost, ...metadata };
  // Pi's own tool usage is always complete, but this merges onto whatever the
  // handlers before us left on the event. A throw here would be swallowed by
  // the runner, so read `prior` as the foreign object it may be.
  const was = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return { input: was(prior.input) + input, output: was(prior.output) + output,
    cacheRead: was(prior.cacheRead) + cacheRead, cacheWrite: was(prior.cacheWrite) + cacheWrite,
    totalTokens: was(prior.totalTokens) + totalTokens,
    cost: { ...cost, ...prior.cost, total: was(prior.cost?.total) + cost.total }, ...metadata };
}
