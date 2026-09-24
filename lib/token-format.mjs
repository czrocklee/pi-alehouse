/**
 * Display-only token counts, shared by the standalone footer and harness.
 * Compact surfaces use whole k above 10k; detailed usage keeps one decimal.
 * Unit promotion is based on the rounded display, never on the raw threshold.
 * @param {number | null | undefined} value
 * @param {{ precision: "compact" | "detailed", trimKZero?: boolean }} options
 * @returns {string}
 */
export function formatTokenCount(value, { precision, trimKZero = false }) {
  if (value == null || !Number.isFinite(value) || value < 0) return "?";
  const count = Math.round(value);
  if (count < 1_000) return String(count);

  const kDigits = precision === "detailed" || count < 10_000 ? 1 : 0;
  const thousands = (count / 1_000).toFixed(kDigits);
  if (Number(thousands) < 1_000) {
    return `${trimKZero ? thousands.replace(/\.0$/, "") : thousands}k`;
  }
  const mDigits = precision === "detailed" || count < 10_000_000 ? 1 : 0;
  return `${(count / 1_000_000).toFixed(mDigits)}M`;
}
