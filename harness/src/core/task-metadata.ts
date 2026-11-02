import type { RunStatus, WorkspaceInfo, WorkspaceMode } from "./contracts.ts";
import { boundedOutput } from "./result-text.ts";
import { COMMUNICATION_LIMITS } from "./communication-envelope.ts";
import type { WorkspaceDetails, WorkspaceRecovery } from "./workspace-metadata.ts";

/** Small task summary, not a metadata transport or a recovery state machine. */
export interface TaskMetadata {
  readonly label: string;
  /** Bounded query control: this original worktree task has not bound a location yet. */
  readonly workspace_pending?: true;
  readonly workspace?: Readonly<WorkspaceInfo> & { readonly checkout_root?: string };
  /** Observed retained locations after failure, not intended/nonexistent targets. */
  readonly retained_paths?: readonly string[];
}
export interface TaskMetadataSource {
  readonly description: string;
  readonly isolation: WorkspaceMode;
  readonly status?: RunStatus;
  readonly execution_exited?: boolean;
  readonly workspace?: WorkspaceInfo;
  readonly workspace_details?: WorkspaceDetails;
  readonly recovery?: WorkspaceRecovery;
}
/** Locations stay task-local. Inspectors request a confirmed working location;
 * failure locations appear only when the adapter actually retained something. */
export function taskMetadata(source: TaskMetadataSource, inspectWorkspace = false): TaskMetadata {
  const recovery = source.recovery;
  const retained = recovery ? [recovery.allocated_path ?? recovery.checkout_root, recovery.recovery_manifest]
    .filter((path): path is string => path !== undefined) : [];
  return { label: boundedOutput(source.description, COMMUNICATION_LIMITS.label_units).text,
    ...(inspectWorkspace && source.isolation === "worktree" && !source.workspace && !recovery && source.execution_exited !== true &&
      (source.status === "queued" || source.status === "running") ? { workspace_pending: true as const } : {}),
    ...(inspectWorkspace && source.isolation === "worktree" && source.workspace ? {
      workspace: { ...source.workspace,
        ...(source.workspace_details ? { checkout_root: source.workspace_details.checkout_root } : {}) },
    } : {}),
    ...(retained.length ? { retained_paths: [...new Set(retained)] } : {}) };
}
