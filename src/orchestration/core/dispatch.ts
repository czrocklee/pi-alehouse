import { isAbsolute, relative } from "node:path";
import { OrchestrationError } from "./ports.ts";

/** Shared declaration bounds, not a filesystem-time or encoded-byte budget. */
export const DISPATCH_LIMITS = Object.freeze({
  inputs: 32,
  ownership: 16,
  checks: 16,
  stringUnits: 512,
});

/** Parent declarations, not permissions or evidence that checks were executed. */
export interface Dispatch {
  /** Required file/directory prerequisites to preflight, not an access allowlist. */
  inputs?: string[];
  ownership?: string[];
  tree?: string;
  checks?: string[];
}
export interface DispatchPath {
  path: string;
  canonical: string;
}
export interface PreparedDispatch {
  declaration: Dispatch;
  inputs: DispatchPath[];
  ownership: DispatchPath[];
  tree?: DispatchPath;
}
export type SourceState =
  | {
      state: "observed";
      scope: "superproject_only";
      submodules: "ignored";
      head: string;
      dirty: boolean;
      status_digest: string;
      observed_at: number;
    }
  | { state: "unknown"; reason: string };
export interface ValidationReceipt {
  version: 1;
  checks: string[];
  cwd: string;
  tree?: string;
  source_state: SourceState;
  outcome: {
    status: "completed" | "needs_input" | "failed" | "cancelled";
    reason?: string;
  };
}
export interface DispatchLease {
  assertHeld(): void;
  close(): void;
}
export interface DispatchObservation {
  source_state?: SourceState;
  notes?: string[];
  lease?: DispatchLease;
}
export interface DispatchContext {
  cwd: string;
  profile: string;
}
/** Host adaptation owns filesystem/permission/subprocess details, never lifecycle. */
export interface DispatchPort {
  prepare(
    dispatch: Dispatch,
    context: DispatchContext & { deferInputs: boolean },
  ): PreparedDispatch;
  start?(
    dispatch: PreparedDispatch,
    context: DispatchContext & { acquireTree: boolean },
  ): Promise<DispatchObservation>;
}

export function validateDispatch(value: unknown): asserts value is Dispatch {
  const fail = (resolution: string, key?: string, index?: number): never => {
    throw new OrchestrationError("INVALID_DISPATCH", {
      ...(key === undefined ? {} : { key }),
      ...(index === undefined ? {} : { index }),
      resolution,
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("dispatch must be an object with only inputs, ownership, tree and checks.");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["inputs", "ownership", "tree", "checks"].includes(key)))
    fail("Remove undeclared dispatch fields; use only inputs, ownership, tree and checks.");
  const word = (item: unknown, key: "inputs" | "ownership" | "checks" | "tree", index?: number) => {
    const parameter = `dispatch.${key}${index === undefined ? "" : `.${index}`}`;
    if (typeof item !== "string" || !item.trim())
      fail(`${parameter} must be a nonblank string.`, key, index);
    const text = item as string;
    if (text.length > DISPATCH_LIMITS.stringUnits)
      fail(
        `${parameter} must contain at most ${DISPATCH_LIMITS.stringUnits} UTF-16 units; received ${text.length}.`,
        key,
        index,
      );
    // eslint-disable-next-line no-control-regex -- declarations must not contain ASCII control characters
    if (/[\x00-\x1f\x7f]/.test(text))
      fail(`${parameter} must not contain ASCII control characters.`, key, index);
    if (
      key !== "checks" &&
      (text !== text.trim() || /[*?[\]{}'"`$\\]/.test(text) || /^[~@]/.test(text))
    )
      fail(
        `${parameter} must be a literal path without padding (leading/trailing whitespace), globs, shell quoting or expansion.`,
        key,
        index,
      );
  };
  for (const key of ["inputs", "ownership", "checks"] as const) {
    const items = fields[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) fail(`dispatch.${key} must be an array.`, key);
    const entries = items as unknown[];
    if (!entries.length) fail(`dispatch.${key} must contain at least 1 item.`, key);
    if (entries.length > DISPATCH_LIMITS[key])
      fail(
        `dispatch.${key} accepts at most ${DISPATCH_LIMITS[key]} items; received ${entries.length}.`,
        key,
      );
    Array.from(entries).forEach((item, index) => word(item, key, index));
    if (new Set(entries).size !== entries.length)
      fail(`dispatch.${key} must contain unique entries; remove duplicates.`, key);
  }
  if (fields.tree !== undefined) word(fields.tree, "tree");
}
export function pathsOverlap(left: DispatchPath, right: DispatchPath): boolean {
  const within = (base: string, path: string): boolean => {
    const tail = relative(base, path);
    return (
      !tail ||
      (!isAbsolute(tail) && tail !== ".." && !tail.startsWith("../") && !tail.startsWith("..\\"))
    );
  };
  return [left.path, left.canonical].some((a) =>
    [right.path, right.canonical].some((b) => within(a, b) || within(b, a)),
  );
}
export function dispatchText(dispatch: Dispatch | undefined, cwd: string): string {
  return dispatch === undefined
    ? ""
    : `Parent dispatch (coordination scope and planned checks, not permissions or execution evidence):\nExecution cwd: ${JSON.stringify(cwd)}\nRelative inputs, ownership, and tree paths resolve from this cwd; declarations grant no permissions.\n${JSON.stringify(dispatch)}\n--- End of dispatch declarations ---`;
}
export function validSourceState(value: unknown): value is SourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as SourceState;
  if (s.state === "unknown")
    return typeof s.reason === "string" && !!s.reason && s.reason.length <= 120;
  return (
    s.state === "observed" &&
    s.scope === "superproject_only" &&
    s.submodules === "ignored" &&
    typeof s.head === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.head) &&
    typeof s.dirty === "boolean" &&
    typeof s.status_digest === "string" &&
    /^[0-9a-f]{64}$/.test(s.status_digest) &&
    Number.isSafeInteger(s.observed_at) &&
    s.observed_at >= 0
  );
}
export function validValidationReceipt(value: unknown): value is ValidationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as ValidationReceipt;
  try {
    validateDispatch({ checks: r.checks });
  } catch {
    return false;
  }
  return (
    r.version === 1 &&
    Array.isArray(r.checks) &&
    r.checks.length > 0 &&
    typeof r.cwd === "string" &&
    r.cwd.length <= 4096 &&
    isAbsolute(r.cwd) &&
    (r.tree === undefined ||
      (typeof r.tree === "string" && r.tree.length <= 4096 && isAbsolute(r.tree))) &&
    validSourceState(r.source_state) &&
    !!r.outcome &&
    typeof r.outcome === "object" &&
    !Array.isArray(r.outcome) &&
    // Current receipt outcomes are closed: status/reason only. Retired and
    // unknown fields are unsupported declarations, not tolerated history.
    Object.keys(r.outcome).every((key) => key === "status" || key === "reason") &&
    ["completed", "needs_input", "failed", "cancelled"].includes(r.outcome.status) &&
    (r.outcome.reason === undefined ||
      (typeof r.outcome.reason === "string" && r.outcome.reason.length <= 120))
  );
}
