// Pure helpers for the isolated P1 fixture; no SDK or production lifecycle changes.
import { renameSync, rmdirSync } from "node:fs";

// Return the original setImmediate promise: no extra async hop in polling loops.
export function pollStep(phase, snapshot, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  return () => {
    if (performance.now() >= deadline) {
      throw new Error(`P1_POLL_TIMEOUT: ${phase}; last state: ${JSON.stringify(snapshot())}`);
    }
    return new Promise((resolve) => setImmediate(resolve));
  };
}

// Only fixture-created faults, and only after confirmed drain. Attempt every
// restoration independently so one failure cannot hide the other damaged log.
export function restoreFaultedLogs(files, closed) {
  return files.filter(Boolean).map((file) => {
    if (closed !== true) return { file, restored: false, skipped: "OWNER_NOT_CLOSED" };
    try {
      rmdirSync(file);
      renameSync(file + ".before-fault", file);
      return { file, restored: true };
    } catch (error) { return { file, restored: false, error: String(error) }; }
  });
}
