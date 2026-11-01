import type { RunView } from "../core/contracts.js";
import { GLYPHS, SPINNER } from "./format.js";

interface RunPresentation { glyph: string; color: string; label: string; compact: string }
type State = RunView["status"] | "finishing";
/** Shared lifecycle defaults; surfaces may choose different wording/tints, but
 * an Agent's glyph must not change merely because a different pane shows it. */
const STATES: Record<State, Omit<RunPresentation, "glyph"> & { glyph?: string }> = {
  queued: { glyph: GLYPHS.queued, color: "muted", label: "queued", compact: "queued" },
  running: { color: "accent", label: "running", compact: "run" },
  cancelling: { color: "warning", label: "cancelling", compact: "cancel" },
  completed: { glyph: GLYPHS.success, color: "success", label: "completed", compact: "done" },
  needs_input: { glyph: GLYPHS.question, color: "warning", label: "needs_input", compact: "input" },
  failed: { glyph: GLYPHS.failure, color: "error", label: "failed", compact: "failed" },
  cancelled: { glyph: GLYPHS.stopped, color: "dim", label: "cancelled", compact: "cancel" },
  finishing: { color: "dim", label: "finishing", compact: "finish" },
};

export function runPresentation(status: RunView["status"], spinnerFrame = 0, finishing = false): RunPresentation {
  const state = STATES[status === "running" && finishing ? "finishing" : status];
  const frame = Number.isFinite(spinnerFrame) ? Math.max(0, Math.floor(spinnerFrame)) % SPINNER.length : 0;
  return { ...state, glyph: state.glyph ?? SPINNER[frame]! };
}
