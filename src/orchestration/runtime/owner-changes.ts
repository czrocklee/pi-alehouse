import { isAbsolute, resolve } from "node:path";
import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { singleLineText } from "../presentation/plain-text.ts";
import { composeNet, type NetEvidence } from "./owner-change-net.ts";
import {
  finishEditPatch,
  observeEditPatch,
  type OwnerChangePatch,
  ownData,
  WRITE_NO_BEFORE,
} from "./owner-change-patch.ts";
export type { OwnerChangePatch } from "./owner-change-patch.ts";

export type OwnerChangeAttempt = Readonly<{
  agentId: string;
  agentLabel: string;
  tool: "edit" | "write";
  outcome: "unknown" | "failed" | "reported-success";
}>;
export type OwnerChangeReport = Readonly<{
  attempt: OwnerChangeAttempt;
  /** Present only for a matched successful completion, including unavailable previews. */
  patch?: OwnerChangePatch;
}>;
export type OwnerNetChange = Readonly<
  | Pick<Extract<OwnerChangePatch, { kind: "edit" }>, "kind" | "added" | "removed" | "lines">
  | { kind: "unchanged" }
  | {
      kind: "unavailable";
      reason:
        | Extract<OwnerChangePatch, { kind: "unavailable" }>["reason"]
        | "incomplete"
        | "ambiguous"
        | "overlapping"
        | "truncated";
    }
>;
export type OwnerChangeGroup = Readonly<{
  path: string;
  /** Oldest report first, in observed completion order (start order for unsettled attempts). */
  reports: readonly OwnerChangeReport[];
  net: OwnerNetChange;
}>;
export type OwnerChangeReportsSnapshot = Readonly<{
  groups: readonly OwnerChangeGroup[];
  truncated: boolean;
}>;
/** The full human Reset scope. Workspace hint paths stay in Agent Info only. */
export type OwnerChangesSnapshot = OwnerChangeReportsSnapshot &
  Readonly<{ workspaceHints: number }>;
export type OwnerChangeCounts = Readonly<{
  paths: number;
  attempts: number;
  reported: number;
  /** Sums over paths with a provable net of the observed SDK reports, not a disk diff. */
  added: number;
  removed: number;
  unknownPaths: number;
  partial: boolean;
}>;

// Only retained path rows own bounded previews, result seals and Net evidence;
// the per-Run ID fences never keep those payloads after eviction or clear.
const MAX_ATTEMPTS = 512;
const MAX_LOST_PATHS = MAX_ATTEMPTS;
const MAX_RUN_IDS = 256;
const MAX_PENDING = 32;
const MAX_PATH = 1024;
const MAX_ID = 256;
const MAX_LABEL = 96;
const EMPTY: OwnerChangeReportsSnapshot = Object.freeze({
  groups: Object.freeze([]),
  truncated: false,
});
const EMPTY_COUNTS: OwnerChangeCounts = Object.freeze({
  paths: 0,
  attempts: 0,
  reported: 0,
  added: 0,
  removed: 0,
  unknownPaths: 0,
  partial: false,
});

// Don't keep a short substring backed by a provider's much larger string.
const copy = (value: string): string => Buffer.from(value, "utf16le").toString("utf16le");

function targetPath(raw: unknown, cwd: string): string | undefined {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > MAX_PATH ||
    /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(raw)
  )
    return undefined;
  // Mirror the pinned built-in path tools' lexical input forms on Linux. No
  // stat, realpath, user database lookup, or second resolution of a filename.
  let path = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (!path || /^file:/i.test(path)) return undefined; // Child path guard excludes file: URLs.
  if (path === "~" || path.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home || home.length > MAX_PATH || !isAbsolute(home)) return undefined;
    path = home + path.slice(1);
  }
  if (!isAbsolute(path)) {
    if (cwd.length > MAX_PATH || !isAbsolute(cwd)) return undefined;
    path = resolve(cwd, path);
  } else path = resolve(path);
  // Don't clip target identities or approximate control-bearing filenames.
  if (path.length > MAX_PATH || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(path)) return undefined;
  return copy(path);
}

function confirmsPreExecutionFailure(event: ToolExecutionEndEvent): boolean {
  if (ownData(event, "isError") !== true) return false;
  const timing = Object.getOwnPropertyDescriptor(event, "durationMs");
  return timing ? "value" in timing && timing.value === undefined : !("durationMs" in event);
}

type ChangeEvent = ToolExecutionStartEvent | ToolResultEvent | ToolExecutionEndEvent;
export const isOwnerChangeTool = (name: string): name is OwnerChangeAttempt["tool"] =>
  name === "edit" || name === "write";

export interface OwnerChangeRun {
  observe(event: ChangeEvent): void;
  clear(): void;
}
type ResettableRun = OwnerChangeRun & { reset(): void };
const INACTIVE_RUN: OwnerChangeRun = Object.freeze({ observe() {}, clear() {} });
const BEFORE_RESET = Symbol("Changes observation reset");
// Run-local fences point to a sequence number, not retained payloads. Eviction
// can drop a row even while its call still has to be paired or fenced.
type Call = {
  started: number;
  tool: OwnerChangeAttempt["tool"];
  result: "unseen" | "successful" | "other";
};
type AttemptRow = {
  call: Call;
  path?: string;
  finished?: number;
  preExecutionFailure?: boolean;
  evidence?: ReturnType<typeof observeEditPatch>;
  netEvidence?: NetEvidence;
  report: OwnerChangeReport;
};
type NetUnavailable = Extract<OwnerNetChange, { kind: "unavailable" }>;
const unavailable = (reason: NetUnavailable["reason"]): NetUnavailable =>
  Object.freeze({ kind: "unavailable", reason });
const INCOMPLETE = unavailable("incomplete");
const UNVERIFIED = unavailable("missing-or-unverified");
const SENSITIVE = unavailable("sensitive");
const AMBIGUOUS = unavailable("ambiguous");
const OVERLAPPING = unavailable("overlapping");
const TRUNCATED = unavailable("truncated");
const UNCHANGED = Object.freeze({ kind: "unchanged" });

/** Non-overlapping execution windows make start order also completion order,
 * the only order safe to compose here. */
function netFor(rows: readonly AttemptRow[]): OwnerNetChange {
  let evidence: NetEvidence[] | undefined;
  let previousEnd = 0;
  for (const row of rows) {
    if (row.preExecutionFailure) continue;
    if (row.finished === undefined || !row.report.patch) return INCOMPLETE;
    if (row.call.started < previousEnd) return OVERLAPPING;
    previousEnd = row.finished;
    const { patch } = row.report;
    if (patch.kind !== "edit") return patch;
    if (patch.redacted) return SENSITIVE;
    if (patch.truncated) return TRUNCATED;
    if (!row.netEvidence) return UNVERIFIED;
    (evidence ??= []).push(row.netEvidence);
  }
  // All retained rows were verified pre-execution denials/aborts.
  if (!evidence) return UNCHANGED;
  try {
    const net = composeNet(evidence);
    if (net.kind !== "edit") return net;
    if (net.redacted) return SENSITIVE;
    if (net.truncated) return TRUNCATED;
    if (net.added === 0 && net.removed === 0) return UNCHANGED;
    return Object.freeze({
      kind: "edit",
      added: net.added,
      removed: net.removed,
      lines: net.lines,
    });
  } catch {
    // A broken composition must not break the underlying observation or tool.
    return UNVERIFIED;
  }
}

/** Session-local human observation, independent of the widget's live roster.
 * Neither an authority decision nor proof of a filesystem change. */
export class OwnerChangeMonitor {
  private readonly recent = new Map<number, AttemptRow>();
  private readonly runs = new Set<ResettableRun>();
  private readonly listeners = new Set<() => void>();
  // Each bucket is oldest-start-first. Display ordering is paid only on read.
  private readonly grouped = new Map<string, AttemptRow[]>();
  private readonly netByPath = new Map<string, OwnerNetChange>();
  private readonly lostPaths = new Set<string>();
  private readonly dirtyPaths = new Set<string>();
  private coverageFailure?: NetUnavailable;
  private epoch = 0;
  private order = 0;
  private dirty = false;
  // Pathless starts are bounded by the live Runs' pending budgets. They
  // temporarily make coverage partial but don't displace retained reports.
  private pathless = 0;
  // Unsettled starts without an effective path may have targeted any file.
  private provisional = 0;
  private reported = 0;
  // Unmasked totals, updated only for affected path buckets.
  private added = 0;
  private removed = 0;
  private unknownPaths = 0;
  private cached: OwnerChangeReportsSnapshot | undefined = EMPTY;
  private counts: OwnerChangeCounts = EMPTY_COUNTS;

  private netMask(): NetUnavailable | undefined {
    return this.coverageFailure ?? (this.provisional || this.pathless ? INCOMPLETE : undefined);
  }

  snapshot(): OwnerChangeReportsSnapshot {
    if (this.cached) return this.cached;
    const mask = this.netMask();
    return (this.cached = Object.freeze({
      groups: Object.freeze(
        [...this.grouped]
          .sort(([, a], [, b]) => b.at(-1)!.call.started - a.at(-1)!.call.started)
          .map(([path, rows]) =>
            Object.freeze({
              path,
              reports: Object.freeze(
                [...rows]
                  .sort((a, b) => (a.finished ?? a.call.started) - (b.finished ?? b.call.started))
                  .map((row) => row.report),
              ),
              net: mask ?? this.netByPath.get(path)!,
            }),
          ),
      ),
      truncated: this.counts.partial,
    }));
  }

  getCounts(): OwnerChangeCounts {
    return this.counts;
  }

  subscribeCounts(listener: () => void): () => void {
    const registration = () => listener();
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  /** Forget displayed observations, not the live Run bindings. */
  reset(): void {
    for (const run of this.runs) run.reset();
    this.clearRows();
  }

  /** Owner teardown permanently invalidates its existing bindings. */
  clear(): void {
    this.epoch++;
    for (const run of this.runs) run.clear();
    this.clearRows();
  }

  private clearRows(): void {
    this.recent.clear();
    this.grouped.clear();
    this.netByPath.clear();
    this.lostPaths.clear();
    this.dirtyPaths.clear();
    this.coverageFailure = undefined;
    this.order = this.pathless = this.provisional = this.reported = 0;
    this.added = this.removed = this.unknownPaths = 0;
    this.dirty = false;
    this.cached = EMPTY;
    this.publishCounts(EMPTY_COUNTS);
  }

  private publishCounts(next: OwnerChangeCounts): void {
    const old = this.counts;
    if (
      old.paths === next.paths &&
      old.attempts === next.attempts &&
      old.reported === next.reported &&
      old.added === next.added &&
      old.removed === next.removed &&
      old.unknownPaths === next.unknownPaths &&
      old.partial === next.partial
    )
      return;
    this.counts = Object.freeze(next);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Human display failure cannot affect the SDK tool call or result.
      }
    }
  }

  private commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.cached = undefined;
    // Keep path-local totals current under temporary masking so resolving one
    // provisional target does not trigger work for all the unrelated paths.
    for (const path of this.dirtyPaths) {
      this.adjustNet(this.netByPath.get(path), -1);
      const rows = this.grouped.get(path);
      if (rows) {
        const net = this.lostPaths.has(path) ? TRUNCATED : netFor(rows);
        this.netByPath.set(path, net);
        this.adjustNet(net, 1);
      } else this.netByPath.delete(path);
    }
    this.dirtyPaths.clear();
    const mask = this.netMask();
    this.publishCounts({
      paths: this.grouped.size,
      attempts: this.recent.size - this.pathless,
      reported: this.reported,
      added: mask ? 0 : this.added,
      removed: mask ? 0 : this.removed,
      unknownPaths: mask ? this.grouped.size : this.unknownPaths,
      partial: !!this.coverageFailure || this.pathless > 0 || this.lostPaths.size > 0,
    });
  }

  private adjustNet(net: OwnerNetChange | undefined, delta: 1 | -1): void {
    if (net?.kind === "unavailable") this.unknownPaths += delta;
    else if (net?.kind === "edit") {
      this.added += delta * net.added;
      this.removed += delta * net.removed;
    }
  }

  private changed(path: string | undefined): void {
    if (path !== undefined && !this.coverageFailure) this.dirtyPaths.add(path);
    this.dirty = true;
  }

  private addToPath(row: AttemptRow): void {
    const path = row.path;
    if (path === undefined) this.pathless++;
    else {
      const rows = this.grouped.get(path);
      if (!rows) this.grouped.set(path, [row]);
      else {
        // Most starts append. A rewritten older start can join a bucket late.
        let i = rows.length;
        while (i > 0 && rows[i - 1]!.call.started > row.call.started) i--;
        rows.splice(i, 0, row);
      }
    }
    this.changed(path);
  }

  private removeFromPath(row: AttemptRow): void {
    const path = row.path;
    if (path === undefined) this.pathless--;
    else {
      const rows = this.grouped.get(path)!;
      if (rows.length === 1) this.grouped.delete(path);
      else rows.splice(rows.indexOf(row), 1);
    }
    this.changed(path);
  }

  private omit(reason = INCOMPLETE): void {
    if (this.coverageFailure) return;
    this.coverageFailure = reason;
    this.lostPaths.clear();
    this.netByPath.clear();
    this.dirtyPaths.clear();
    this.added = this.removed = this.unknownPaths = 0;
    this.dirty = true;
  }

  private forgetRow(row: AttemptRow): void {
    this.recent.delete(row.call.started);
    this.removeFromPath(row);
    if (row.report.patch) this.reported--;
    if (row.call.result === "unseen" && row.finished === undefined) this.provisional--;
  }

  private evictOldestPathRow(): AttemptRow | undefined {
    if (this.recent.size - this.pathless <= MAX_ATTEMPTS) return;
    for (const row of this.recent.values()) {
      const { call, path } = row;
      if (path === undefined) continue;
      this.forgetRow(row);
      // A settled effective path can be fenced across future Runs without
      // retaining its old reports. An unsettled call still loses coverage.
      if (!this.coverageFailure) {
        if (row.finished === undefined || (call.result === "unseen" && !row.preExecutionFailure))
          this.omit();
        else if (this.lostPaths.size < MAX_LOST_PATHS || this.lostPaths.has(path))
          this.lostPaths.add(path);
        else this.omit(TRUNCATED);
      }
      return row;
    }
  }

  private outcome(
    row: AttemptRow,
    outcome: OwnerChangeAttempt["outcome"],
    patch?: OwnerChangePatch,
    net?: NetEvidence,
  ): void {
    this.reported += Number(!!patch) - Number(!!row.report.patch);
    row.report = Object.freeze({
      attempt: Object.freeze({ ...row.report.attempt, outcome }),
      ...(patch ? { patch } : {}),
    });
    row.netEvidence = this.coverageFailure ? undefined : net;
    this.changed(row.path);
  }

  bind(agentId: string, agentLabel: string, cwd: string): () => OwnerChangeRun {
    const epoch = this.epoch;
    const agent =
      agentId &&
      agentId.length <= MAX_ID &&
      !/[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(agentId)
        ? {
            agentId: copy(agentId),
            agentLabel: copy(
              (singleLineText((agentLabel || agentId).slice(0, MAX_LABEL)) || agentId)
                .slice(0, MAX_LABEL)
                .replace(/\p{Cs}/gu, "�"),
            ),
          }
        : undefined;
    return () => {
      if (this.epoch !== epoch) return INACTIVE_RUN;
      // Fence completed and outcome-first IDs as well as pending starts, even
      // across tool names. Only one unambiguous pairing can certify a target.
      const seen = new Map<string, Call | typeof BEFORE_RESET | undefined>();
      const pending = new Set<Call>();
      let active = true;
      let acceptNewIds = true;
      let resetSinceStart = false;
      const invalidate = (id: string) => {
        const call = seen.get(id);
        if (call && call !== BEFORE_RESET) {
          pending.delete(call);
          const row = this.recent.get(call.started);
          if (row) {
            if (row.path === undefined) this.forgetRow(row);
            else {
              row.evidence = undefined;
              row.preExecutionFailure = false;
              this.outcome(row, "unknown");
            }
          }
        }
        this.omit(AMBIGUOUS);
      };
      const run: ResettableRun = {
        observe: (event) => {
          if (!active) return;
          const tool = event.toolName;
          if (!isOwnerChangeTool(tool) || event.parentToolCallId !== undefined) return;
          const id = event.toolCallId;
          const start = event.type === "tool_execution_start";
          try {
            const resetTail = !start && resetSinceStart;
            if (!agent || typeof id !== "string" || !id || id.length > MAX_ID) {
              if (!resetTail) this.omit();
              return;
            }
            const call = seen.get(id);
            if (resetTail && call === BEFORE_RESET) return;
            if (call === undefined && !seen.has(id)) {
              // An outcome without a start in the new window may belong to
              // an old call. Keep its ID fence but do not add a coverage gap.
              // At the cap no unseen ID can ever be admitted in this Run.
              if (seen.size >= MAX_RUN_IDS) {
                if (!resetTail) this.omit();
                return;
              }
              const retainedId = copy(id);
              seen.set(retainedId, resetTail ? BEFORE_RESET : undefined);
              if (resetTail) return;
              // Fence IDs even when the attempt budget was exceeded, so Reset
              // can clear that budget without allowing unsafe reuse.
              if (start && pending.size >= MAX_PENDING) acceptNewIds = false;
              if (!start || !acceptNewIds) {
                this.omit();
                return;
              }
              const path = targetPath(ownData(event.args, "path"), cwd);
              const started = ++this.order;
              const admitted: Call = { started, tool, result: "unseen" };
              const row: AttemptRow = {
                call: admitted,
                path,
                report: Object.freeze({
                  attempt: Object.freeze({ ...agent, tool, outcome: "unknown" }),
                }),
              };
              seen.set(retainedId, admitted);
              pending.add(admitted);
              this.recent.set(started, row);
              this.provisional++;
              this.addToPath(row);
              if (path !== undefined) this.evictOldestPathRow();
              return;
            }
            if (
              start ||
              !call ||
              call === BEFORE_RESET ||
              tool !== call.tool ||
              !pending.has(call)
            ) {
              invalidate(id);
              return;
            }
            const row = this.recent.get(call.started);
            if (event.type === "tool_result") {
              if (call.result !== "unseen") {
                invalidate(id);
                return;
              }
              if (!row) {
                // An evicted pending call already caused a coverage gap. Keep
                // only pairing state, without looking at its path or result.
                call.result = "other";
                return;
              }
              // Start arguments precede validation/coercion and tool_call
              // mutations. This hook reports the effective path and SDK details.
              const rawPath = ownData(event.input, "path");
              const path = targetPath(rawPath, cwd);
              call.result = event.isError === false ? "successful" : "other";
              this.provisional--;
              this.dirty = true;
              if (path === undefined) {
                this.forgetRow(row);
                this.omit();
                return;
              }
              if (path !== row.path) {
                const wasPathless = row.path === undefined;
                this.removeFromPath(row);
                row.path = path;
                this.addToPath(row);
                if (wasPathless && this.evictOldestPathRow() === row) return;
              }
              if (tool === "edit" && call.result === "successful" && typeof rawPath === "string")
                row.evidence = observeEditPatch(ownData(event, "details"), rawPath, path);
              return;
            }
            if (event.type !== "tool_execution_end") {
              invalidate(id);
              return;
            }
            pending.delete(call);
            if (!row) return;
            const evidence = row.evidence;
            row.evidence = undefined;
            row.finished = ++this.order;
            if (call.result === "unseen") this.provisional--;
            // Pinned SDK pre-execution aborts/denials have neither a result
            // hook nor execution timing. A timed failure may have mutated.
            const preExecutionFailure =
              call.result === "unseen" && confirmsPreExecutionFailure(event);
            if (row.path === undefined) {
              // There is nothing to display or fence by path. The matched ID
              // stays fenced, including after Reset, in case it reappears.
              this.forgetRow(row);
              if (!preExecutionFailure) this.omit();
              return;
            }
            const failed = event.isError;
            if (call.result === "unseen" && !preExecutionFailure) this.omit();
            if (failed === true) {
              row.preExecutionFailure = preExecutionFailure;
              this.outcome(row, "failed");
              return;
            }
            const duration = failed === false && call.result === "successful" && event.durationMs;
            if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
              // The pinned write tool provides no before-state; never read its
              // input content or the target file to guess at a change.
              if (tool === "write") this.outcome(row, "reported-success", WRITE_NO_BEFORE);
              else {
                const { patch, net } = finishEditPatch(evidence, ownData(event, "result"));
                this.outcome(row, "reported-success", patch, net);
              }
            } else this.outcome(row, "unknown");
          } catch {
            // An untrackable observation is not an execution or permission
            // fault. If a start failed, its ID is now unsafe to admit again.
            if (event.type === "tool_execution_start") acceptNewIds = false;
            invalidate(id);
          } finally {
            this.commit();
          }
        },
        reset: () => {
          // Pi correlates by ID, not execution instance. Keep only bounded
          // identity fences until Run exit; late events must not add gaps.
          for (const id of seen.keys()) seen.set(id, BEFORE_RESET);
          pending.clear();
          resetSinceStart = true;
          acceptNewIds = true;
        },
        clear: () => {
          if (!active) return;
          active = false;
          this.runs.delete(run);
          const current = this.epoch === epoch;
          if (current) {
            for (const call of pending) {
              const row = this.recent.get(call.started);
              if (!row) continue;
              row.evidence = undefined;
              if (row.path === undefined) this.forgetRow(row);
              if (call.result === "unseen") this.omit();
            }
          }
          seen.clear();
          pending.clear();
          if (current) this.commit();
        },
      };
      this.runs.add(run);
      return run;
    };
  }
}
