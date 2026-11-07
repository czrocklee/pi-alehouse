/** Narrow structural records of the current history routing/outcome codec.
 * These declarations stay independent of orchestration source types (SDK-free
 * boundary): the orchestration writer keeps its richer core types and narrows
 * through these shared predicates in its own explicitly guarded wrappers. */
export interface RoutingRecord {
  preset: string;
  preset_version: string;
  selection_digest: string;
  strength: "d1" | "d2" | "d3" | "d4" | "d5";
  thinking: string;
  provider: string;
  model: string;
  profile: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  parent_thinking?: string;
  thinking_resolution: "identity" | "automatic_mapping" | "preset_fixed";
  effort_source?: "preset" | "user_override";
}
export interface OutcomeRecord {
  status: "completed" | "needs_input" | "failed" | "cancelled";
  model_stop_reason?: string;
  reason?: string;
  /** First accepted cancellation; only human cancellation is current data. */
  cancellation_source?: "human";
  error?: string;
  question?: string;
  limit_reached: boolean;
}
export function validModelStopReason(value: unknown): value is string | undefined;
export function validRouting(value: unknown): value is RoutingRecord;
export function validOutcome(value: unknown): value is OutcomeRecord;
