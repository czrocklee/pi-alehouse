import { isAbsolute } from "node:path";

/** Location observations only, never execution/policy binding or permission. */
export interface WorkspaceDetails {
  readonly checkout_root: string;
  readonly recovery_manifest: string;
}
export interface WorkspaceRecovery {
  readonly mode: "worktree";
  readonly state: "partial" | "checkout_ready";
  readonly source_cwd: string;
  /** Confirmed allocated private directory. */
  readonly allocated_path?: string;
  /** Present only after the manifest was opened/created, not a durability promise. */
  readonly recovery_manifest?: string;
  /** Only a verified checkout can supply these ready facts. */
  readonly checkout_root?: string;
  readonly cwd?: string;
  readonly base_commit?: string;
}

const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
export function validWorkspaceDetails(value: unknown): value is WorkspaceDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as WorkspaceDetails;
  return absolute(v.checkout_root) && absolute(v.recovery_manifest) &&
    Object.keys(v).every(key => ["checkout_root", "recovery_manifest"].includes(key));
}
export function validWorkspaceRecovery(value: unknown): value is WorkspaceRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as WorkspaceRecovery;
  if (v.mode !== "worktree" || !["partial", "checkout_ready"].includes(v.state) || !absolute(v.source_cwd) ||
      Object.keys(v).some(key => !["mode", "state", "source_cwd", "allocated_path", "recovery_manifest", "checkout_root", "cwd", "base_commit"].includes(key))) return false;
  for (const path of [v.allocated_path, v.recovery_manifest, v.checkout_root, v.cwd])
    if (path !== undefined && !absolute(path)) return false;
  if (v.state === "partial") return v.checkout_root === undefined && v.cwd === undefined && v.base_commit === undefined;
  return absolute(v.checkout_root) && absolute(v.cwd) && typeof v.base_commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.base_commit);
}

// Preserve typed/frozen initialization errors, aggregate causes and cleanup
// semantics. This adapter-to-core attachment is not serialized or hydrated.
const recoveries = new WeakMap<object, WorkspaceRecovery>();
export function withWorkspaceRecovery(error: unknown, recovery: WorkspaceRecovery): unknown {
  const target = error !== null && (typeof error === "object" || typeof error === "function") ? error :
    new Error(String(error), { cause: error });
  if (validWorkspaceRecovery(recovery)) recoveries.set(target, structuredClone(recovery));
  return target;
}
export function workspaceRecoveryOf(error: unknown): WorkspaceRecovery | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const recovery = recoveries.get(error);
  return recovery === undefined ? undefined : structuredClone(recovery);
}
