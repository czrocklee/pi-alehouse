/** Existing session-file attribution contract, not an additional charge.
 * Unknown/foreign records must still be validated even when writer and reader
 * share these helpers. No wire-format/version change is made by extraction. */
export const SPEND_FIELDS = Object.freeze(/** @type {const} */ (["input", "output", "cacheRead", "cacheWrite", "cost"]));
const COST_EPSILON = 1e-9;
const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
/** @param {unknown} value */
const figure = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Unknown components contribute no invented amount; this is display data,
 * not evidence that a missing cost is free or that billing is complete.
 * @param {unknown} usage
 */
export function usageTotals(usage) {
  // A permissive property-read view, not a claim that foreign values are valid.
  // Every scalar still goes through figure(), including missing/malformed ones.
  const raw = /** @type {{ input?: unknown, output?: unknown, cacheRead?: unknown,
    cacheWrite?: unknown, cost?: { total?: unknown } | null } | null | undefined} */ (usage);
  return { input: figure(raw?.input), output: figure(raw?.output),
    cacheRead: figure(raw?.cacheRead), cacheWrite: figure(raw?.cacheWrite),
    cost: figure(raw?.cost?.total) };
}

/** Honour only finite, nonnegative shares bounded by the usage they ride on.
 * Shares may cover only part of the flat totals; the remainder is tool spend.
 * This reader intentionally leaves completeness annotations to consumers that
 * display them. It does not turn partial flags into complete billing evidence.
 * @param {unknown} usage
 */
export function readUsageAttribution(usage) {
  const raw = (/** @type {{ harnessModels?: unknown } | null | undefined} */ (usage))?.harnessModels;
  if (!usage || !Array.isArray(raw) || raw.length === 0) return [];
  const rows = [], claimed = empty();
  for (const row of /** @type {Record<string, unknown>[]} */ (raw)) {
    if (!row || typeof row !== "object" || typeof row.model !== "string" || row.model === "") return [];
    const totals = empty();
    for (const field of SPEND_FIELDS) {
      const value = row[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return [];
      totals[field] = value;
      claimed[field] += value;
    }
    rows.push({ model: row.model, ...totals });
  }
  // Compare usable figures, not raw ones: `claimed > undefined` is false and
  // would otherwise accept arbitrary shares for a missing parent component.
  const reported = usageTotals(usage);
  for (const field of SPEND_FIELDS) {
    if (claimed[field] > reported[field] + COST_EPSILON) return [];
  }
  return rows;
}
