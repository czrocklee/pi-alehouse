/** Stable keys in the existing harness usage annotations. */
export type PartialUsageComponent = "input" | "output" | "cache_read" | "cache_write" | "cost";
export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
}
/** Shares divide the flat usage; partial flags are conservative bill-wide
 * markers, not evidence locating the unknown amount to a particular model. */
export interface HostModelSpend extends UsageTotals {
  model: string;
  partial?: PartialUsageComponent[];
}
export interface HostUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  harnessModels?: HostModelSpend[];
  harnessPartial?: PartialUsageComponent[];
}
export const SPEND_FIELDS: readonly ["input", "output", "cacheRead", "cacheWrite", "cost"];
export function usageTotals(usage: unknown): UsageTotals;
export function readUsageAttribution(usage: unknown): Array<UsageTotals & { model: string }>;
