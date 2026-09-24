// Never discover a lock executable through a project's PATH.
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
export const trustedFlockPaths = ["/usr/bin/flock", "/bin/flock", "/run/current-system/sw/bin/flock"];
export function resolveTestFlock(env, executable = (path) => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}) {
  const override = env.HARNESS_FLOCK ?? env.P0_FLOCK;
  if (override !== undefined) {
    assert(isAbsolute(override), "FLOCK_ABSOLUTE_PATH_REQUIRED");
    return override;
  }
  const path = trustedFlockPaths.find(executable);
  assert(path, "Install util-linux flock or set HARNESS_FLOCK to a trusted absolute executable");
  return path;
}
export const flock = resolveTestFlock(process.env);
