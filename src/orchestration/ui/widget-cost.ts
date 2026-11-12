/** Whether telemetry contains an observed, nonnegative finite price. */
export function isObservedCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Widget-only decimal display, not a billing ledger. Treat each finite
 * observation's shortest decimal spelling as its value. This avoids creating
 * a cent of error by multiplying a binary float, without rounding genuine
 * sub-cent observations up to a false lower bound. */
function decimal(value: number): { coefficient: bigint; scale: number } {
  if (!isObservedCost(value)) throw new RangeError("Invalid observed cost");
  const [mantissa = "0", exponent = "0"] = value.toExponential().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}

/** Rounded cents, or a truncated lower bound when the observation is partial.
 * Finite doubles bound decimal terms to at most 17 significant digits and
 * exponents -324..308. Already-aggregated upstream error cannot be
 * distinguished from an intentional just-below-cent observation and is not
 * guessed away with an epsilon. A measured price that rounds to no cents is
 * not a free Run: it reads "<$0.01", and only a genuine zero reads "$0.00". */
export function widgetCost(cost: number, partial = false): string {
  const term = decimal(cost);
  const scale = Math.max(2, term.scale);
  const total = term.coefficient * 10n ** BigInt(scale - term.scale);
  const unit = 10n ** BigInt(scale - 2);
  const cents = (partial ? total : total + unit / 2n) / unit;
  if (!partial && cents === 0n && total > 0n) return "<$0.01";
  return `${partial ? "≥" : ""}$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
