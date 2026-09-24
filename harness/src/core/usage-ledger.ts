export interface Usage {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Provider-reported spend in USD. Null is "nobody said", not zero. */
  cost: number | null;
}

export const USAGE_COMPONENTS = ["input", "output", "cache_read", "cache_write", "cost"] as const;
export type UsageComponent = (typeof USAGE_COMPONENTS)[number];

/** Spend accrued across responses and Runs, partitioned by responding model. */
export interface UsageLedger {
  /** Derived from `byModel`, never accumulated beside it. */
  total: Record<UsageComponent, number>;
  /** Components at least one contributing response did not report. */
  partial: UsageComponent[];
  /** The same money split by `provider/model`. */
  byModel: Record<string, Record<UsageComponent, number>>;
}

const zeroComponents = (): Record<UsageComponent, number> =>
  ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 });
const usable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Missing/invalid telemetry is unknown, never an invented zero. */
export const normalizeUsage = (value: unknown): Usage | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<keyof Usage, unknown>;
  const metric = (v: unknown): number | null => usable(v) ? v : null;
  return { input: metric(raw.input), output: metric(raw.output), cache_read: metric(raw.cache_read),
    cache_write: metric(raw.cache_write), cost: metric(raw.cost) };
};

export const totalOf = (byModel: UsageLedger["byModel"]): Record<UsageComponent, number> => {
  const total = zeroComponents();
  for (const share of Object.values(byModel)) for (const key of USAGE_COMPONENTS) total[key] += share[key];
  return total;
};
const ledgerOf = (byModel: UsageLedger["byModel"], partial: Set<UsageComponent>): UsageLedger =>
  ({ total: totalOf(byModel), partial: USAGE_COMPONENTS.filter((key) => partial.has(key)), byModel });

export const emptyLedger = (): UsageLedger => ({ total: zeroComponents(), partial: [], byModel: {} });

/** Accrues one response's reported usage against the model that produced it. */
export const addToLedger = (ledger: UsageLedger | undefined, usage: Usage | undefined, model: string): UsageLedger | undefined => {
  if (!usage) return ledger;
  const base = ledger ?? emptyLedger();
  const share = { ...(base.byModel[model] ?? zeroComponents()) };
  const partial = new Set(base.partial);
  for (const key of USAGE_COMPONENTS) {
    if (usable(usage[key])) share[key] += usage[key];
    else partial.add(key);
  }
  return ledgerOf({ ...base.byModel, [model]: share }, partial);
};

/** Rolls one settled Run's ledger into the running one. */
export const mergeLedgers = (left: UsageLedger | undefined, right: UsageLedger | undefined): UsageLedger | undefined => {
  if (!left) return right;
  if (!right) return left;
  const byModel = { ...left.byModel };
  for (const [model, share] of Object.entries(right.byModel)) {
    const seen = byModel[model];
    if (!seen) { byModel[model] = { ...share }; continue; }
    const sum = zeroComponents();
    for (const key of USAGE_COMPONENTS) sum[key] = seen[key] + share[key];
    byModel[model] = sum;
  }
  return ledgerOf(byModel, new Set([...left.partial, ...right.partial]));
};

/** Normalizes an untrusted Run ledger without trusting its declared total. */
export const normalizeLedger = (value: unknown): UsageLedger | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Partial<UsageLedger>).byModel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const declared = (value as Partial<UsageLedger>).partial;
  const partial = new Set<UsageComponent>(Array.isArray(declared)
    ? declared.filter((key): key is UsageComponent => USAGE_COMPONENTS.includes(key)) : []);
  const byModel: UsageLedger["byModel"] = {};
  for (const [model, share] of Object.entries(raw as Record<string, unknown>)) {
    if (!model || !share || typeof share !== "object" || Array.isArray(share)) return undefined;
    const components = zeroComponents();
    for (const key of USAGE_COMPONENTS) {
      const metric = (share as Record<string, unknown>)[key];
      if (usable(metric)) components[key] = metric;
      else partial.add(key);
    }
    byModel[model] = components;
  }
  return Object.keys(byModel).length ? ledgerOf(byModel, partial) : undefined;
};

/** A component's figure, or undefined when nothing anywhere reported it. */
export const reported = (ledger: UsageLedger | undefined, key: UsageComponent): number | undefined =>
  !ledger || (ledger.total[key] === 0 && ledger.partial.includes(key)) ? undefined : ledger.total[key];
