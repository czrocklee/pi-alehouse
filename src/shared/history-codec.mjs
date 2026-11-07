/** Current orchestration history routing/outcome codec predicates, shared by the live
 * writer (src/orchestration/history/run-journal.ts) and the offline journal
 * analyzer (scripts/analyze-alehouse-journal.mjs). Pure source only: no SDK, no
 * generated runtime, no third-party imports, so the standalone analyzer keeps
 * its source-only boundary while writer and strict reader cannot drift apart.
 *
 * Current legal shapes only. Retired slot names, missing ratings, removed
 * resolution values and unknown or retired outcome fields are unsupported
 * data, never reinterpreted, converted or silently accepted. */

/** Narrow structural record of the current routing codec; kept exactly aligned
 * with the paired declaration's RoutingRecord interface.
 * @typedef {object} RoutingRecord
 * @property {string} preset
 * @property {string} preset_version
 * @property {string} selection_digest
 * @property {"d1" | "d2" | "d3" | "d4" | "d5"} strength
 * @property {string} thinking
 * @property {string} provider
 * @property {string} model
 * @property {string} profile
 * @property {1 | 2 | 3 | 4 | 5} difficulty
 * @property {string} [parent_thinking]
 * @property {"identity" | "automatic_mapping" | "preset_fixed"} thinking_resolution
 * @property {"preset" | "user_override"} [effort_source]
 */

/** Narrow structural record of the current outcome codec; kept exactly aligned
 * with the paired declaration's OutcomeRecord interface.
 * @typedef {object} OutcomeRecord
 * @property {"completed" | "needs_input" | "failed" | "cancelled"} status
 * @property {string} [model_stop_reason]
 * @property {string} [reason]
 * @property {"human"} [cancellation_source]
 * @property {string} [error]
 * @property {string} [question]
 * @property {boolean} limit_reached
 */

/** @param {unknown} value @returns {boolean} */
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {boolean} */
const word = (value) => typeof value === "string" && value.length > 0;

/** Final provider/SDK assistant stop reason: bounded and never empty.
 * @param {unknown} value
 * @returns {value is string | undefined} */
export function validModelStopReason(value) {
  return (
    value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 128)
  );
}

/** Current routing codec: fixed effort may omit the parent route, inherited
 * effort requires one, effort_source stays optional, a rating must match its
 * current slot and the selection digest is exactly 64 lowercase hex chars.
 * @param {unknown} value
 * @returns {value is RoutingRecord} */
export function validRouting(value) {
  if (!object(value)) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  const fixed =
    r.thinking_resolution === "preset_fixed" &&
    (!Object.hasOwn(r, "parent_thinking") ||
      (typeof r.parent_thinking === "string" && !!r.parent_thinking));
  const inherited =
    (r.thinking_resolution === "identity" || r.thinking_resolution === "automatic_mapping") &&
    typeof r.parent_thinking === "string" &&
    !!r.parent_thinking;
  return (
    [r.preset, r.preset_version, r.thinking, r.provider, r.model, r.profile].every(word) &&
    (fixed || inherited) &&
    (!Object.hasOwn(r, "effort_source") ||
      r.effort_source === "preset" ||
      r.effort_source === "user_override") &&
    typeof r.difficulty === "number" &&
    Number.isInteger(r.difficulty) &&
    r.difficulty >= 1 &&
    r.difficulty <= 5 &&
    (r.strength === "d1" ||
      r.strength === "d2" ||
      r.strength === "d3" ||
      r.strength === "d4" ||
      r.strength === "d5") &&
    /** @type {readonly unknown[]} */ (["d1", "d2", "d3", "d4", "d5"])[r.difficulty - 1] ===
      r.strength &&
    typeof r.selection_digest === "string" &&
    /^[0-9a-f]{64}$/.test(r.selection_digest)
  );
}

/** Current outcome codec: a closed field set with current optionality.
 * limit_reached is a required boolean, reason/error/question and the final
 * stop reason are optional, and only human cancellation is current data.
 * @param {unknown} value
 * @returns {value is OutcomeRecord} */
export function validOutcome(value) {
  if (!object(value)) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return (
    Object.keys(r).every((key) =>
      /** @type {readonly unknown[]} */ ([
        "status",
        "model_stop_reason",
        "reason",
        "cancellation_source",
        "error",
        "question",
        "limit_reached",
      ]).includes(key),
    ) &&
    (r.status === "completed" ||
      r.status === "needs_input" ||
      r.status === "failed" ||
      r.status === "cancelled") &&
    typeof r.limit_reached === "boolean" &&
    validModelStopReason(r.model_stop_reason) &&
    (r.cancellation_source === undefined || r.cancellation_source === "human") &&
    [r.reason, r.error, r.question].every((item) => item === undefined || typeof item === "string")
  );
}
