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
/** Model-facing tool-argument vocabulary only. Converted to Dispatch before
 * any core effect; records, receipts and every internal field name stay as-is.
 * Old or mixed internal keys are undeclared fields here, never aliases. */
export interface PublicDispatch {
  required_paths?: string[];
  ownership?: string[];
  build_dir?: string;
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

/** Slot ids stay internal in both vocabularies; only the model-facing field
 * names differ. One shared shape validator keeps semantics, bounds and details
 * from drifting between the internal record contract and the public args. */
interface DispatchNames {
  readonly inputs: string;
  readonly ownership: string;
  readonly checks: string;
  readonly tree: string;
  readonly keys: readonly string[];
}
const INTERNAL_DISPATCH_NAMES: DispatchNames = Object.freeze({
  inputs: "inputs",
  ownership: "ownership",
  checks: "checks",
  tree: "tree",
  keys: ["inputs", "ownership", "tree", "checks"],
});
const PUBLIC_DISPATCH_NAMES: DispatchNames = Object.freeze({
  inputs: "required_paths",
  ownership: "ownership",
  checks: "checks",
  tree: "build_dir",
  keys: ["required_paths", "ownership", "build_dir", "checks"],
});

/** Throws INVALID_DISPATCH with the vocabulary's bare field name as `key`
 * (index separate). Reads only: no input value or path text is rewritten. */
function validateDispatchShape(value: unknown, names: DispatchNames): void {
  const fail = (resolution: string, key?: string, index?: number): never => {
    throw new OrchestrationError("INVALID_DISPATCH", {
      ...(key === undefined ? {} : { key }),
      ...(index === undefined ? {} : { index }),
      resolution,
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(
      `dispatch must be an object with only ${names.inputs}, ownership, ${names.tree} and checks.`,
    );
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !names.keys.includes(key)))
    fail(
      `Remove undeclared dispatch fields; use only ${names.inputs}, ownership, ${names.tree} and checks.`,
    );
  const word = (
    item: unknown,
    slot: "inputs" | "ownership" | "checks" | "tree",
    index?: number,
  ) => {
    const key = names[slot];
    const parameter = `dispatch.${key}${index === undefined ? "" : `.${index}`}`;
    if (typeof item !== "string" || !item.trim())
      fail(`${parameter} must be a nonblank string.`, key, index);
    const text = item as string;
    if (text.length > DISPATCH_LIMITS.stringUnits)
      fail(
        `${parameter} must contain at most ${DISPATCH_LIMITS.stringUnits} characters; received ${text.length}.`,
        key,
        index,
      );
    // eslint-disable-next-line no-control-regex -- declarations must not contain ASCII control characters
    if (/[\x00-\x1f\x7f]/.test(text))
      fail(`${parameter} must not contain ASCII control characters.`, key, index);
    if (
      slot !== "checks" &&
      (text !== text.trim() || /[*?[\]{}'"`$\\]/.test(text) || /^[~@]/.test(text))
    )
      fail(
        `${parameter} must be a literal path without padding (leading/trailing whitespace), globs, shell quoting or expansion.`,
        key,
        index,
      );
  };
  for (const slot of ["inputs", "ownership", "checks"] as const) {
    const key = names[slot];
    const items = fields[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) fail(`dispatch.${key} must be an array.`, key);
    const entries = items as unknown[];
    if (!entries.length) fail(`dispatch.${key} must contain at least 1 item.`, key);
    if (entries.length > DISPATCH_LIMITS[slot])
      fail(
        `dispatch.${key} accepts at most ${DISPATCH_LIMITS[slot]} items; received ${entries.length}.`,
        key,
      );
    Array.from(entries).forEach((item, index) => word(item, slot, index));
    if (new Set(entries).size !== entries.length)
      fail(`dispatch.${key} must contain unique entries; remove duplicates.`, key);
  }
  if (fields[names.tree] !== undefined) word(fields[names.tree], "tree");
}

export function validateDispatch(value: unknown): asserts value is Dispatch {
  validateDispatchShape(value, INTERNAL_DISPATCH_NAMES);
}
/** Public tool-argument shape: strict public keys only. The model never sees
 * an internal field name in `key` or resolution text. */
export function validatePublicDispatch(value: unknown): asserts value is PublicDispatch {
  validateDispatchShape(value, PUBLIC_DISPATCH_NAMES);
}

/** Public spelling of internal dispatch error codes for newly authored live
 * diagnostic text and model-facing errors: an exact-match map, never a decoder,
 * prefix rule or text substitution. Internal machine codes, field names and
 * existing record bytes stay unchanged; this is neither a record projection nor
 * a promise that all record content is unchanged. */
const PUBLIC_DISPATCH_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  BUILD_TREE_BUSY: "BUILD_DIR_BUSY",
  DISPATCH_TREE_TYPE: "DISPATCH_BUILD_DIR_TYPE",
  DISPATCH_TREE_INSPECTION_FAILED: "DISPATCH_BUILD_DIR_INSPECTION_FAILED",
  DISPATCH_INPUT_MISSING: "DISPATCH_REQUIRED_PATH_MISSING",
  DISPATCH_INPUT_TYPE: "DISPATCH_REQUIRED_PATH_TYPE",
  DISPATCH_INPUT_INSPECTION_FAILED: "DISPATCH_REQUIRED_PATH_INSPECTION_FAILED",
});
export function publicDispatchErrorCode(code: string): string {
  const mapped = Object.hasOwn(PUBLIC_DISPATCH_ERROR_CODES, code)
    ? PUBLIC_DISPATCH_ERROR_CODES[code]
    : undefined;
  return mapped ?? code;
}

/** Public spelling of internal dispatch field names in error key/parameter
 * details: bare or dispatch-qualified inputs/tree slots, each optionally
 * carrying one numeric index suffix. These are typed error parameter slots,
 * never user pathname strings. Anchored recognition only: any other value,
 * including path text and unrecognized spellings, passes through byte-literal;
 * there is no substring substitution. */
const PUBLIC_DISPATCH_PARAMETER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  inputs: "required_paths",
  tree: "build_dir",
});
const DISPATCH_PARAMETER_SLOT = /^(dispatch\.)?(inputs|tree)(\.\d+)?$/;
export function publicDispatchParameter(parameter: string): string {
  const slot = DISPATCH_PARAMETER_SLOT.exec(parameter);
  if (!slot?.[2] || slot[0] !== parameter) return parameter;
  return `${slot[1] ?? ""}${PUBLIC_DISPATCH_PARAMETER_FIELDS[slot[2]]}${slot[3] ?? ""}`;
}

/** Pure vocabulary conversion of a validatePublicDispatch-checked value:
 * copies arrays, mutates nothing, validates nothing, and keeps every path
 * string byte-literal. */
export function publicDispatchToInternal(value: PublicDispatch): Dispatch {
  return {
    ...(value.required_paths === undefined ? {} : { inputs: [...value.required_paths] }),
    ...(value.ownership === undefined ? {} : { ownership: [...value.ownership] }),
    ...(value.build_dir === undefined ? {} : { tree: value.build_dir }),
    ...(value.checks === undefined ? {} : { checks: [...value.checks] }),
  };
}
/** Fresh model-facing projection for dispatchText only; never a record shape. */
function publicDispatchOf(dispatch: Dispatch): PublicDispatch {
  return {
    ...(dispatch.inputs === undefined ? {} : { required_paths: [...dispatch.inputs] }),
    ...(dispatch.ownership === undefined ? {} : { ownership: [...dispatch.ownership] }),
    ...(dispatch.tree === undefined ? {} : { build_dir: dispatch.tree }),
    ...(dispatch.checks === undefined ? {} : { checks: [...dispatch.checks] }),
  };
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
    : `Parent dispatch (coordination scope and planned checks, not permissions or execution evidence):\nExecution cwd: ${JSON.stringify(cwd)}\nRelative required_paths, ownership, and build_dir paths resolve from this cwd; declarations grant no permissions.\n${JSON.stringify(publicDispatchOf(dispatch))}\n--- End of dispatch declarations ---`;
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
