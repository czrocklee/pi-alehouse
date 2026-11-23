import type { RunView } from "../core/contracts.ts";

/** Whether telemetry contains an observed, nonnegative finite price. */
export function isObservedCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Decimal display, not a billing ledger. Treat each finite
 * observation's shortest decimal spelling as its value. This avoids creating
 * a cent of error by multiplying a binary float, without rounding genuine
 * sub-cent observations up to a false lower bound. */
function decimal(value: number): { coefficient: bigint; scale: number } {
  if (!isObservedCost(value)) throw new RangeError("Invalid observed cost");
  const [mantissa = "0", exponent = "0"] = value.toExponential().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}

/** Round to the display precision; truncate partial amounts so a floor
 * never rounds up. Positive observations below display resolution aren't free.
 * Already-aggregated upstream error is not guessed away with an epsilon. */
function price(cost: number, partial: boolean, digits: 2 | 3): string {
  const term = decimal(cost);
  const scale = Math.max(digits, term.scale);
  const total = term.coefficient * 10n ** BigInt(scale - term.scale);
  const unit = 10n ** BigInt(scale - digits);
  const rounded = (partial ? total : total + unit / 2n) / unit;
  if (!partial && rounded === 0n && total > 0n) return digits === 2 ? "<$0.01" : "<$0.001";
  const base = 10n ** BigInt(digits);
  return `${partial ? "≥" : ""}$${rounded / base}.${String(rounded % base).padStart(digits, "0")}`;
}

export const widgetCost = (cost: number, partial = false): string => price(cost, partial, 2);
export const formatCost = (cost: number, partial = false): string => price(cost, partial, 3);

/** Keep the Run and its Agent total together as one layout metric. */
export function widgetCostPair(
  cost: number | undefined,
  partial: boolean | undefined,
  total: RunView["agent_cost"],
  format = widgetCost,
): string {
  const knownRun = isObservedCost(cost);
  const runPartial = knownRun && partial === true;
  const run = knownRun ? format(cost, partial) : "?";
  const agent = isObservedCost(total?.amount)
    ? format(total.amount, runPartial || total.partial)
    : "?";
  if (!knownRun) return agent === "?" ? "" : `?/${agent}`;
  // A floor on this Run already implies a floor on its Agent total. Don't
  // repeat the mark (or currency), but still truncate both partial amounts.
  return `${run}/${agent.replace(runPartial ? "≥$" : "$", "")}`;
}
