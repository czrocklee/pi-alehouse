import { isAbsolute, relative } from "node:path";
import { HarnessError } from "./ports.js";

/** Parent declarations, not permissions or evidence that checks were executed. */
export interface Dispatch {
  inputs?: string[];
  ownership?: string[];
  tree?: string;
  checks?: string[];
}
export interface DispatchPath { path: string; canonical: string }
export interface PreparedDispatch {
  declaration: Dispatch;
  inputs: DispatchPath[];
  ownership: DispatchPath[];
  tree?: DispatchPath;
}
export type SourceState = {
  state: "observed";
  scope: "superproject_only";
  submodules: "ignored";
  head: string;
  dirty: boolean;
  status_digest: string;
  observed_at: number;
} | { state: "unknown"; reason: string };
export interface ValidationReceipt {
  version: 1;
  checks: string[];
  cwd: string;
  tree?: string;
  source_state: SourceState;
  outcome: { status: "completed" | "needs_input" | "failed" | "cancelled"; reason?: string; time_wrapped?: true };
}
export interface DispatchLease { assertHeld(): void; close(): void }
export interface DispatchObservation { source_state?: SourceState; notes?: string[]; lease?: DispatchLease }
export interface DispatchContext { cwd: string; profile: string }
/** Host adaptation owns filesystem/permission/subprocess details, never lifecycle. */
export interface DispatchPort {
  prepare(dispatch: Dispatch, context: DispatchContext & { deferInputs: boolean }): PreparedDispatch;
  start?(dispatch: PreparedDispatch, context: DispatchContext & { acquireTree: boolean }): Promise<DispatchObservation>;
}

export function validateDispatch(value: unknown): asserts value is Dispatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("INVALID_DISPATCH");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["inputs", "ownership", "tree", "checks"].includes(key))) throw new HarnessError("INVALID_DISPATCH");
  const word = (item: unknown, path: boolean): item is string => typeof item === "string" && !!item.trim() && item.length <= 512 &&
    // eslint-disable-next-line no-control-regex -- declarations must not contain ASCII control characters
    !/[\x00-\x1f\x7f]/.test(item) && (!path || (item === item.trim() && !/[*?[\]{}'"`$\\]/.test(item) && !/^[~@]/.test(item)));
  for (const key of ["inputs", "ownership", "checks"] as const) {
    const items = fields[key];
    if (items !== undefined && (!Array.isArray(items) || !items.length || items.length > (key === "inputs" ? 8 : 16) ||
        Array.from(items).some(item => !word(item, key !== "checks")) || new Set(items).size !== items.length))
      throw new HarnessError("INVALID_DISPATCH", { key });
  }
  if (fields.tree !== undefined && !word(fields.tree, true)) throw new HarnessError("INVALID_DISPATCH", { key: "tree" });
}
export function pathsOverlap(left: DispatchPath, right: DispatchPath): boolean {
  const within = (base: string, path: string): boolean => {
    const tail = relative(base, path);
    return !tail || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith("../") && !tail.startsWith("..\\"));
  };
  return [left.path, left.canonical].some(a => [right.path, right.canonical].some(b => within(a, b) || within(b, a)));
}
export function dispatchText(dispatch: Dispatch | undefined): string {
  return dispatch === undefined ? "" : `Parent dispatch declarations (scope and planned checks, not permission grants or completed validation):\n${JSON.stringify(dispatch)}\n--- End of dispatch declarations ---`;
}
export function validSourceState(value: unknown): value is SourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as SourceState;
  if (s.state === "unknown") return typeof s.reason === "string" && !!s.reason && s.reason.length <= 120;
  return s.state === "observed" && s.scope === "superproject_only" && s.submodules === "ignored" &&
    typeof s.head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.head) && typeof s.dirty === "boolean" &&
    typeof s.status_digest === "string" && /^[0-9a-f]{64}$/.test(s.status_digest) &&
    Number.isSafeInteger(s.observed_at) && s.observed_at >= 0;
}
export function validValidationReceipt(value: unknown): value is ValidationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as ValidationReceipt;
  try { validateDispatch({ checks: r.checks }); } catch { return false; }
  return r.version === 1 && Array.isArray(r.checks) && r.checks.length > 0 &&
    typeof r.cwd === "string" && r.cwd.length <= 4096 && isAbsolute(r.cwd) &&
    (r.tree === undefined || (typeof r.tree === "string" && r.tree.length <= 4096 && isAbsolute(r.tree))) &&
    validSourceState(r.source_state) && !!r.outcome && ["completed", "needs_input", "failed", "cancelled"].includes(r.outcome.status) &&
    (r.outcome.reason === undefined || (typeof r.outcome.reason === "string" && r.outcome.reason.length <= 120)) &&
    (r.outcome.time_wrapped === undefined || r.outcome.time_wrapped === true);
}
