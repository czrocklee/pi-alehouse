/**
 * jev (TypeSafe System One) permission reviewer for the pi-alehouse authorizer chain.
 *
 * jev returns typed answers with calibrated probabilities and no prose, so the
 * verdict is composed in lib/jev-policy.ts from independent factual questions rather
 * than delegated to a model's free-text reasoning: the policy is reviewable
 * TypeScript, and the model only supplies evidence.
 *
 * PI_JEV_APPROVAL_MODE sets each session's initial mode. This extension defaults
 * to shadow when the variable is absent. The pi-alehouse launcher explicitly
 * defaults to enforce-subagents, covering the parent and managed subagents.
 * Shadow returns the ask to the terminal authorizer immediately and records the
 * verdict out of band, so it adds no prompt latency and decides nothing.
 * `PI_JEV_APPROVAL_MODE=shadow pi-alehouse` is the per-process way back; the
 * footer's approval indicator (approval-mode.ts) changes the current session's
 * mode at runtime, after confirming any change that widens it, and resuming a
 * session restores the mode picked there -- never wider than this launch's.
 *
 * The policy thresholds came from an 8-case probe, not a calibration. Watch the
 * failureCode AND confidence distribution in
 * ~/.pi/agent/logs/jev-auto-approval.jsonl: a judge that only ever times out or
 * only ever lands under threshold looks identical to one that safely defers.
 * Because allow is a conjunction of every gate, an under-calibrated threshold
 * shows up as over-deferring long before it could over-allow; the failure that
 * would not announce itself is a hazard this probe never exercised being read
 * systematically low on some class of action.
 *
 * Deliberately narrow where evidence is missing rather than wrong: every
 * question jev cannot be given complete, trustworthy input for resolves to
 * defer. The static checkpoints (lib/hard-checkpoint.ts) run before any model
 * call, so an unparseable or high-impact action costs nothing and stays human.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionDecisionEvent,
  PermissionQuery,
  PermissionsReadyEvent,
  PermissionsService,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
  APPROVAL_SET_JUDGE_EVENT,
  publishJudgeState,
  readSetJudgeMode,
} from "./lib/approval-protocol.ts";
import { hardCheckpointReason } from "./lib/hard-checkpoint.ts";
import { JEV_MODEL_ID as MODEL_ID, reviewWithNativeJev } from "./lib/jev-classifier.ts";
import {
  appendJevAuditDetailed,
  type JevAuditFailureReason,
  type JevAuditResult,
} from "./lib/jev-audit-log.ts";

import {
  DENIAL_REASONS,
  QUESTIONS,
  combineVerdict,
  type Decision,
  type FailureCode,
  type JevAnswers,
  type Verdict,
} from "./lib/jev-policy.ts";
import {
  CREDENTIAL_LITERAL,
  InputProvenance,
  asRecord,
  buildProjectRestrictions,
  buildUserContext,
  canonicalJson,
  digest,
  estimateTokens,
  hasSensitiveKeyValue,
  invokedScriptFact,
  latestCompactionSummary,
  recentToolCallFacts,
  textDigest,
  type UserAuthorizationContext,
} from "./lib/jev-review-packet.ts";
import {
  boundedProfileIsValid,
  buildAction,
  captureDelegationAdmission,
  captureDelegationRun,
  childRuntimeFactsRegistry,
  delegationBindingFailure,
  delegationIdentity,
  delegationReviewDigest,
  forwardedIdentity,
  type ChildDelegationContext,
  type DelegationAdmission,
} from "./lib/jev-binding.ts";

export { QUESTIONS, combineVerdict } from "./lib/jev-policy.ts";
export {
  buildProjectRestrictions,
  buildUserContext,
  invokedScriptFact,
  recentToolCallFacts,
} from "./lib/jev-review-packet.ts";
export { buildAction, delegationBindingFailure } from "./lib/jev-binding.ts";

const AUTHORIZER_NAME = "jev-model-judge";
const POLICY_VERSION = "jev-auto-approval-v1";
const AUDIT_EVENT = "jev_model_judge.decision";
const MODE_STATUS_KEY = "jev-auto-approval";
const SESSION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");
const API_KEY_FILE_KEY = Symbol.for("@rocklee/jev-auto-approval:api-key-file");
const AGENT_DIR = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
const AUDIT_LOG_PATH = join(AGENT_DIR, "logs", "jev-auto-approval.jsonl");
const RESOURCE_PROTECTION_KEY = Symbol.for("pi-alehouse:managed-resource-protection:v1");

/** Pin even an absent logs directory at first module load; never rebind a
 * symlink after startup. Only missing suffixes use lexical names. */
function fixedAuditDirectory(directory: string): string | undefined {
  const missing: string[] = [];
  let ancestor = directory;
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
const AUDIT_DIRECTORY = fixedAuditDirectory(dirname(AUDIT_LOG_PATH));

/**
 * Path to the sops-rendered key, never the key itself. An exported
 * TYPESAFE_API_KEY would be inherited by every Bash tool call this very
 * extension is gating, which is precisely the exfiltration path it exists to
 * refuse. The file is read lazily, cached in memory, and never logged.
 */
export function captureApiKeyFile(
  environment: Record<string, string | undefined>,
  globalRecord: Record<symbol, unknown>,
): string | undefined {
  const retained = globalRecord[API_KEY_FILE_KEY];
  const configured = environment.PI_JEV_API_KEY_FILE;
  if (
    (typeof retained !== "string" || retained === "") &&
    typeof configured === "string" &&
    configured !== ""
  ) {
    globalRecord[API_KEY_FILE_KEY] = configured;
  }
  // Captured, then removed from the environment every Bash tool call inherits.
  // Keep only the path in a process-global slot: /reload evaluates a fresh
  // module after the environment has already been scrubbed.
  delete environment.PI_JEV_API_KEY_FILE;
  const captured = globalRecord[API_KEY_FILE_KEY];
  return typeof captured === "string" && captured !== "" ? captured : undefined;
}

const API_KEY_FILE = captureApiKeyFile(process.env, globalThis as Record<symbol, unknown>);

// This budget detects a stalled review; it is not a promised response latency.
const REVIEW_TIMEOUT_MS = 2_000;
// Model ceiling is 64k per request and 32k for state; this packet budget is
// well inside both.
const MAX_PACKET_TOKENS = 16_384;
const MAX_CONCURRENT_REVIEWS: Readonly<Record<RequestScope, number>> = { root: 4, subagent: 8 };
const REVIEW_FAILURE_LIMIT = 3;
const REVIEW_CIRCUIT_COOLDOWN_MS = 30_000;
const DENIAL_FUSE_LIMIT = 3;
const MAX_TRACKED_REQUESTS = 256;
/** Fixed diagnostic vocabulary for unsupported before_agent_start shapes. An
 * unknown reason string is ignored outright: never logged, toasted, or allowed
 * to consume the one-time diagnostic, so no event payload reaches the audit
 * or the user. */
const UNSUPPORTED_START_REASONS: ReadonlySet<string> = new Set([
  "missing_message_type",
  "unknown_message_type",
  "malformed_user_start",
  "unreadable_start_event",
]);

/**
 * The build embeds hashes of the complete generated definitions. An unrendered source
 * has no trusted workers and safely defers every forwarded automatic approval.
 */
const WORKER_POLICY: Record<string, { digest: string; bashDenies: string[] }> =
  /* @worker-policy@ */ {};
const BINDING_POLICY = { workerPolicy: WORKER_POLICY, agentDir: AGENT_DIR };

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type RolloutMode = "shadow" | "enforce";
type RequestScope = "root" | "subagent";

type ApprovalAttempt = {
  key: string;
  authorizationRevision: number;
  mode: RolloutMode;
  includeSubagents: boolean;
  requestScope: RequestScope;
  requestDigest: string;
};

type PausedAction = {
  authorizationRevision: number;
  originalRequestDigest: string;
};

type ReviewResult = {
  answers?: JevAnswers;
  failureCode?: FailureCode;
  latencyMs: number;
  inputTokens?: number;
};

type PendingOutcome = {
  requestDigest: string;
  authorizationRevision: number;
  actionDigest?: string;
  mode: RolloutMode;
  requestScope: RequestScope;
  startedAt: number;
  surface?: string | null;
  failureStage?: FailureCode;
  suggestedVerdict?: Verdict;
  decision?: { result: "allow" | "deny"; resolution: string | null; decidedAt: number };
  deferredAt?: number;
};

/** Sole session authority. Extracted binding helpers borrow these same maps;
 * provenance is one owned instance, and no packet/policy module grants access. */
type RuntimeState = {
  ctx: ExtensionContext | undefined;
  sessionId: string | undefined;
  mode: RolloutMode;
  includeSubagents: boolean;
  /** Advances on every mode change, so a round trip back to the same mode
   * still invalidates reviews that started before it. */
  modeRevision: number;
  hasParentSession: boolean;
  generation: number;
  provenance: InputProvenance;
  denialCount: number;
  activeReviews: Record<RequestScope, number>;
  consecutiveReviewFailures: number;
  circuitOpenUntil: number;
  inFlight: Map<string, Promise<ReviewResult>>;
  pendingOutcomes: Map<string, PendingOutcome>;
  childDelegations: Map<string, ChildDelegationContext>;
  delegationAdmissions: Map<string, DelegationAdmission>;
  approvalAttempts: Map<string, ApprovalAttempt>;
  pausedActions: Map<string, PausedAction>;
  approvalStateOverflow: boolean;
  /** One clear diagnostic per session for an unsupported before_agent_start
   * shape: once for this session's own event, once for child witnesses. */
  unsupportedStartDiagnosed: boolean;
  childWitnessDiagnosed: boolean;
  auditNotices?: { lastAt: number; reasons: Map<JevAuditFailureReason, number> };
};

/* ------------------------------------------------------------------ *
 * jev client
 * ------------------------------------------------------------------ */

let cachedApiKey: string | null | undefined;

/**
 * Read the key from its sops-rendered file, once. `null` means "configured but
 * unusable" and `undefined` means "not configured"; both defer, and neither is
 * ever logged or placed in the environment.
 */
function apiKey(): string | undefined {
  if (cachedApiKey !== undefined) return cachedApiKey ?? undefined;
  if (!API_KEY_FILE) {
    cachedApiKey = null;
    return undefined;
  }
  try {
    const key = readFileSync(API_KEY_FILE, "utf8").trim();
    // An empty file is a configuration error and stays cached; a read error is
    // not, and caching it would turn one unlucky moment -- sops re-rendering
    // the secret during activation -- into a judge that defers for the rest of
    // the process and looks identical to one that is working safely.
    cachedApiKey = key === "" ? null : key;
  } catch {
    return undefined;
  }
  return cachedApiKey ?? undefined;
}

async function callJev(packet: unknown, signal: AbortSignal | undefined): Promise<ReviewResult> {
  const startedAt = Date.now();
  const key = apiKey();
  // No credential, no request. This is the canary the offline checks rely on to prove
  // an unconfigured runtime cannot make an unexpected model call.
  if (!key) return { failureCode: "api_key_unavailable", latencyMs: 0 };

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    const review = await reviewWithNativeJev(
      packet as Record<string, unknown>,
      QUESTIONS,
      key,
      controller.signal,
    );
    return {
      ...review,
      failureCode: signal?.aborted ? "cancelled" : review.failureCode,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      failureCode: signal?.aborted
        ? "cancelled"
        : controller.signal.aborted
          ? "timeout"
          : "network_error",
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

function auditProtection():
  { protectedWriteRoots: readonly string[]; protectedWriteFiles: readonly string[] } | undefined {
  const value = (globalThis as Record<symbol, unknown>)[RESOURCE_PROTECTION_KEY];
  if (value === undefined) return undefined; // Ordinary non-symlink offline fixtures.
  const floor = asRecord(value);
  if (!floor || !Object.isFrozen(floor) || floor.version !== 1)
    throw new Error("Invalid resource floor");
  for (const paths of [floor.writeRoots, floor.readFiles, floor.writeFiles]) {
    if (
      !Array.isArray(paths) ||
      !Object.isFrozen(paths) ||
      !paths.every(
        (path: unknown) =>
          typeof path === "string" &&
          isAbsolute(path) &&
          !path.includes("\0") &&
          resolve(path) === path,
      )
    ) {
      throw new Error("Invalid resource floor paths");
    }
  }
  return {
    protectedWriteRoots: floor.writeRoots as readonly string[],
    protectedWriteFiles: floor.writeFiles as readonly string[],
  };
}

/** Fixed messages only: never include a packet, key, action or raw exception.
 * This channel deliberately does not depend on the failing audit sink. */
function reportAuditFailure(state: RuntimeState, reason: JevAuditFailureReason): void {
  const now = Date.now();
  const notices = (state.auditNotices ??= { lastAt: -Infinity, reasons: new Map() });
  if (now - (notices.reasons.get(reason) ?? -Infinity) < 30_000 || now - notices.lastAt < 1_000)
    return;
  notices.lastAt = now;
  notices.reasons.set(reason, now);
  const recovery =
    reason === "legacy_lock_requires_offline_recovery" ||
    reason === "legacy_hardlinks_require_offline_recovery" ||
    reason === "incomplete_tail_requires_offline_recovery"
      ? " Stop every Pi sharing this agent directory, including old unlocked writers, before offline audit recovery; do not remove an Owner lease lock."
      : reason === "untrusted_directory_owner"
        ? " A log directory ancestor's owner is not trusted in the current namespace. Unmapped root may appear as an overflow UID/nobody; check UID/GID mappings. The UID value alone does not establish a namespace cause. This is not a bad lockfile; offline audit recovery or retry cannot fix the ownership/mapping boundary."
        : reason === "symlink_target_unprotected" || reason === "directory_changed"
          ? " Start a fresh process with fixed, startup-protected audit active/lock/archive targets; do not retarget a live logs symlink."
          : reason === "validation_failed"
            ? " Review context changed before audit commit; no allow was written."
            : reason === "lock_busy"
              ? " The bounded audit-lock wait expired; later requests may recover normally."
              : " Check the private audit files and trusted lock executable; stop all shared-agentDir writers before any manual repair.";
  const message = `Jev audit unavailable (${reason}); automatic approval defers to normal permission handling.${recovery}`;
  if (state.ctx?.hasUI) {
    try {
      state.ctx.ui.notify(message, "warning");
      return;
    } catch {
      /* Fall through to an independent visible log. */
    }
  }
  try {
    console.warn(message);
  } catch {
    /* Diagnostic IO cannot change the permission outcome. */
  }
}

function appendAudit(
  state: RuntimeState,
  details: Record<string, unknown>,
  beforeWrite?: () => boolean,
): JevAuditResult {
  let result: JevAuditResult;
  try {
    const protection = auditProtection();
    result =
      AUDIT_DIRECTORY === undefined
        ? { ok: false, reason: "unsafe_directory" }
        : appendJevAuditDetailed(
            AUDIT_LOG_PATH,
            { timestamp: new Date().toISOString(), ...details },
            {
              expectedDirectory: AUDIT_DIRECTORY,
              ...protection,
              beforeWrite,
            },
          );
  } catch {
    result = { ok: false, reason: "invalid_input" };
  }
  if (!result.ok) reportAuditFailure(state, result.reason);
  return result;
}

/** One clear diagnostic per session for an unsupported before_agent_start
 * shape -- this session's own event, or a managed child's witness report. The
 * shape stays fail-closed: no live input is bound, nothing re-opens, and this
 * diagnostic grants no permission. Fixed text and reason vocabulary only;
 * never the event, its prompt or a raw exception. */
function reportUnsupportedStartEvent(
  state: RuntimeState,
  scope: "session" | "child_witness",
  reason: string,
): void {
  if (!UNSUPPORTED_START_REASONS.has(reason)) return;
  if (scope === "session" ? state.unsupportedStartDiagnosed : state.childWitnessDiagnosed) return;
  if (scope === "session") state.unsupportedStartDiagnosed = true;
  else state.childWitnessDiagnosed = true;
  const tail =
    "This host's event shape is not the supported one; no compatibility fallback is provided.";
  const message =
    scope === "session"
      ? `Jev auto-approval: this session received an unsupported before_agent_start event (${reason}). No live input is bound and previous refusals stay in force; automatic review stays unavailable and permission asks defer to normal handling. ${tail}`
      : `Jev auto-approval: a managed child session received an unsupported before_agent_start event (${reason}). Its approval witness is invalid and that Run stays manual; permission asks defer to normal handling. ${tail}`;
  appendAudit(state, {
    event: "jev_model_judge.unsupported_start_event",
    modelId: MODEL_ID,
    scope,
    reason,
  });
  if (state.ctx?.hasUI) {
    try {
      state.ctx.ui.notify(message, "warning");
      return;
    } catch {
      /* Fall through to an independent visible log. */
    }
  }
  try {
    console.warn(message);
  } catch {
    /* Diagnostic IO cannot change the permission outcome. */
  }
}

function writeDecisionAudit(
  log: AuthorizerLog,
  state: RuntimeState,
  data: {
    requestDigest: string;
    actionDigest?: string;
    mode: RolloutMode;
    requestScope: RequestScope;
    modelCalled: boolean;
    latencyMs: number | null;
    suggestedVerdict: Verdict;
    effectiveVerdict: Verdict;
    reasonCode: string;
    failureCode?: FailureCode;
    risk?: number | null;
    riskConfidence?: number | null;
    taskScope?: number | null;
    readOnly?: number | null;
    lane?: "read" | "write";
    packetTokens?: number;
    inputTokens?: number;
    checkpointReason?: string;
  },
  beforeWrite?: () => boolean,
): JevAuditResult {
  const details = {
    event: AUDIT_EVENT,
    policyVersion: POLICY_VERSION,
    modelId: MODEL_ID,
    requestDigest: data.requestDigest,
    actionDigest: data.actionDigest ?? null,
    mode: data.mode,
    requestScope: data.requestScope,
    modelCalled: data.modelCalled,
    latencyMs: data.latencyMs,
    suggestedVerdict: data.suggestedVerdict,
    effectiveVerdict: data.effectiveVerdict,
    reasonCode: data.reasonCode,
    failureCode: data.failureCode ?? null,
    risk: data.risk ?? null,
    riskConfidence: data.riskConfidence ?? null,
    taskScope: data.taskScope ?? null,
    readOnly: data.readOnly ?? null,
    lane: data.lane ?? null,
    packetTokens: data.packetTokens ?? null,
    inputTokens: data.inputTokens ?? null,
    checkpointReason: data.checkpointReason ?? null,
  };
  const result = appendAudit(state, details, beforeWrite);
  // An independently observed suggestion must not masquerade as an audited
  // allow when the write/close failed or lock-wait revalidation rejected it.
  const failure =
    !result.ok && result.reason === "validation_failed"
      ? "review_context_changed"
      : "audit_unavailable";
  const observed = !result.ok
    ? {
        ...details,
        auditFailureReason: result.reason,
        ...(details.effectiveVerdict === "allow"
          ? { effectiveVerdict: "defer", reasonCode: failure, failureCode: failure }
          : {}),
      }
    : details;
  try {
    log.review(AUDIT_EVENT, observed);
  } catch {
    /* The private JSONL remains the authoritative audit sink. */
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

function modeForScope(state: RuntimeState, scope: RequestScope): RolloutMode {
  return scope === "subagent" && !state.includeSubagents ? "shadow" : state.mode;
}

function openOutcome(state: RuntimeState, requestId: string, pending: PendingOutcome): boolean {
  // An unresolved human decision is security state, not evictable telemetry.
  if (state.pendingOutcomes.has(requestId) || state.pendingOutcomes.size >= MAX_TRACKED_REQUESTS)
    return false;
  state.pendingOutcomes.set(requestId, pending);
  return true;
}

function retryActionKey(cwd: string, action: Record<string, unknown>): string {
  return digest({
    cwd,
    // Bind the complete operation, not its gate or temporary executor identity.
    // A new child/session must not be a way to retry a refused operation.
    action: action.currentToolCall ?? action,
  });
}

/** Remembered in every mode: a No given while Jev only observes must still
 * hold if the user widens the mode before retrying. Only enforce refuses on
 * overflow; shadow decides nothing, so it only marks the state. */
function rememberApprovalAttempt(
  state: RuntimeState,
  details: PromptPermissionDetails,
  key: string,
  requestDigest: string,
  mode: RolloutMode,
  requestScope: RequestScope,
): boolean {
  if (
    state.approvalAttempts.has(details.requestId) ||
    state.approvalAttempts.size >= MAX_TRACKED_REQUESTS
  ) {
    state.approvalStateOverflow = true;
    return mode !== "enforce";
  }
  state.approvalAttempts.set(details.requestId, {
    key,
    authorizationRevision: state.provenance.authorizationRevision,
    mode,
    includeSubagents: state.includeSubagents,
    requestScope,
    requestDigest,
  });
  return true;
}

/** A refusal is bound to the action and the user's authorization revision,
 * never to the mode or coverage current when it lands: widening while the
 * dialog is open must not forget the No. */
function recordApprovalDecision(state: RuntimeState, event: PermissionDecisionEvent): void {
  const attempt = state.approvalAttempts.get(event.requestId);
  state.approvalAttempts.delete(event.requestId);
  if (!attempt && event.result === "deny" && event.resolution === "user_denied") {
    const pending = state.pendingOutcomes.get(event.requestId);
    if (pending && pending.authorizationRevision === state.provenance.authorizationRevision) {
      // We cannot prove a later operation differs from an unidentified refused
      // action (e.g. a missing child witness). Do not silently forget that No.
      if (state.pausedActions.size >= MAX_TRACKED_REQUESTS) state.approvalStateOverflow = true;
      else
        state.pausedActions.set("*", {
          authorizationRevision: pending.authorizationRevision,
          originalRequestDigest: pending.requestDigest,
        });
    }
  }
  if (
    !attempt ||
    event.result !== "deny" ||
    event.resolution !== "user_denied" ||
    attempt.authorizationRevision !== state.provenance.authorizationRevision
  )
    return;
  if (state.pausedActions.has(attempt.key)) return;
  if (state.pausedActions.size >= MAX_TRACKED_REQUESTS) {
    state.approvalStateOverflow = true;
    return;
  }
  state.pausedActions.set(attempt.key, {
    authorizationRevision: attempt.authorizationRevision,
    originalRequestDigest: attempt.requestDigest,
  });
}

async function trackedReview(
  state: RuntimeState,
  packet: unknown,
  packetDigest: string,
  scope: RequestScope,
  signal: AbortSignal | undefined,
): Promise<ReviewResult> {
  const existing = state.inFlight.get(packetDigest);
  if (existing) return existing;
  const generation = state.generation;
  state.activeReviews[scope] += 1;
  const promise = callJev(packet, signal)
    .then((result) => {
      if (state.generation === generation) {
        if (result.answers) {
          state.consecutiveReviewFailures = 0;
          state.circuitOpenUntil = 0;
        } else if (
          result.failureCode !== "cancelled" &&
          ++state.consecutiveReviewFailures >= REVIEW_FAILURE_LIMIT
        ) {
          state.circuitOpenUntil = Date.now() + REVIEW_CIRCUIT_COOLDOWN_MS;
        }
      }
      return result;
    })
    .finally(() => {
      if (state.generation === generation) state.activeReviews[scope] -= 1;
      if (state.inFlight.get(packetDigest) === promise) state.inFlight.delete(packetDigest);
    });
  state.inFlight.set(packetDigest, promise);
  return promise;
}

async function authorize(
  details: PromptPermissionDetails,
  query: PermissionQuery,
  log: AuthorizerLog,
  state: RuntimeState,
): Promise<AuthorizerVerdict> {
  const writeAudit = (
    log: AuthorizerLog,
    data: Parameters<typeof writeDecisionAudit>[2],
    beforeWrite?: () => boolean,
  ) => writeDecisionAudit(log, state, data, beforeWrite);
  const generation = state.generation;
  const inputRevision = state.provenance.revision;
  const includeSubagents = state.includeSubagents;
  const modeRevision = state.modeRevision;
  const ctx = state.ctx;
  const sessionId = state.sessionId;
  const reviewSignal = ctx?.signal;
  const requestDigest = digest({
    policyVersion: POLICY_VERSION,
    cwd: ctx?.cwd ?? null,
    source: details.source,
    toolCallId: details.toolCallId ?? null,
    payload: details.payload ?? null,
    accessIntent: details.accessIntent ?? null,
  });

  const forwardedRequested = Boolean(
    details.forwarding || details.payload?.request?.requester?.forwarded,
  );
  const scope: RequestScope = forwardedRequested ? "subagent" : "root";
  const mode = modeForScope(state, scope);
  const outcomeOpened = openOutcome(state, details.requestId, {
    requestDigest,
    authorizationRevision: state.provenance.authorizationRevision,
    mode,
    requestScope: scope,
    startedAt: Date.now(),
    surface:
      typeof details.payload?.request?.surface === "string"
        ? details.payload.request.surface
        : null,
  });

  const pending = outcomeOpened ? state.pendingOutcomes.get(details.requestId) : undefined;
  const defer = (failureCode: FailureCode, actionDigest?: string): AuthorizerVerdict => {
    if (pending) {
      pending.suggestedVerdict = "defer";
      pending.failureStage = failureCode;
      if (actionDigest) pending.actionDigest = actionDigest;
      if (pending.deferredAt === undefined) pending.deferredAt = Date.now();
    }
    writeAudit(log, {
      requestDigest,
      actionDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "defer",
      effectiveVerdict: "defer",
      reasonCode: failureCode,
      failureCode,
    });
    return { kind: "defer" };
  };

  if (!ctx || !sessionId) return defer("context_incomplete");
  // The headless terminal is a deny-only sink; piped stdin is not verified
  // direct authorization. Preserve defer even when outcome tracking is full.
  if (!ctx.hasUI) return defer("headless_session");
  if (!outcomeOpened) {
    writeAudit(log, {
      requestDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: mode === "enforce" ? "deny" : "defer",
      effectiveVerdict: mode === "enforce" ? "deny" : "defer",
      reasonCode: "approval_state_overflow",
      failureCode: "approval_state_overflow",
    });
    return mode === "enforce"
      ? { kind: "deny", reason: "Approval state is full; wait for pending requests." }
      : { kind: "defer" };
  }
  if (forwardedRequested && !forwardedIdentity(details)) return defer("delegation_unbound");
  // A local parentSession header means a child or a user fork. Only a complete
  // ask served by its registered root arrives as forwardedRequested.
  if (!forwardedRequested && state.hasParentSession) return defer("subagent_session");

  const request = details.payload?.request;
  if (!request || typeof request.surface !== "string") return defer("context_incomplete");
  let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  try {
    branch = ctx.sessionManager.getBranch();
  } catch {
    return defer("context_incomplete");
  }
  const actionResult = buildAction(details, branch);
  if (!actionResult.ok) return defer(actionResult.failureCode);
  const actionRetryKey = retryActionKey(ctx.cwd, actionResult.action);
  if (
    mode === "enforce" &&
    (state.pausedActions.has(actionRetryKey) ||
      state.pausedActions.has("*") ||
      state.approvalStateOverflow)
  ) {
    const reason = state.approvalStateOverflow
      ? "approval_state_overflow"
      : "approval_retry_paused";
    writeAudit(log, {
      requestDigest,
      actionDigest: actionResult.actionDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "deny",
      effectiveVerdict: "deny",
      reasonCode: reason,
      failureCode: reason,
    });
    return {
      kind: "deny",
      reason: state.approvalStateOverflow
        ? "Refusal tracking overflowed. All enforce-mode approval requests are paused until a new direct user instruction."
        : state.pausedActions.has("*")
          ? "A declined action could not be identified. All enforce-mode approval requests are paused until a new direct user instruction."
          : "This action was declined. Wait for a new direct user instruction before retrying.",
    };
  }
  if (!rememberApprovalAttempt(state, details, actionRetryKey, requestDigest, mode, scope)) {
    if (pending) {
      pending.suggestedVerdict = "deny";
      pending.failureStage = "approval_state_overflow";
    }
    writeAudit(log, {
      requestDigest,
      actionDigest: actionResult.actionDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "deny",
      effectiveVerdict: "deny",
      reasonCode: "approval_state_overflow",
      failureCode: "approval_state_overflow",
    });
    return {
      kind: "deny",
      reason: "Approval state is full; wait for pending requests or a new direct instruction.",
    };
  }

  if (mode === "enforce" && state.denialCount >= DENIAL_FUSE_LIMIT) {
    writeAudit(log, {
      requestDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "deny",
      effectiveVerdict: "deny",
      reasonCode: "refusal_fuse",
      failureCode: "refusal_fuse",
    });
    return { kind: "deny", reason: DENIAL_REASONS.refusal_fuse };
  }

  const policySurface = details.accessIntent?.surface ?? request.surface;
  // Upstream caps every authorizer allow on these families to defer anyway.
  if (/^(?:path|external_directory)(?:_read|_write)?$/.test(policySurface)) {
    return defer("bounded_path_family");
  }

  let deterministicPolicy: ReturnType<PermissionQuery["checkPermission"]>;
  try {
    deterministicPolicy = query.checkPermission(
      policySurface,
      details.accessIntent?.boundaryValue ?? request.value ?? undefined,
      details.agentName ?? undefined,
    );
  } catch {
    return defer("policy_query_failed");
  }
  if (deterministicPolicy.state === "deny") {
    // The gate already resolved this to `ask`, so a deny here is a divergence,
    // not a second opinion. Enforcing it is fail-safe; shadow only records it.
    if (mode === "shadow") return defer("policy_divergence");
    writeAudit(log, {
      requestDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "deny",
      effectiveVerdict: "deny",
      reasonCode: "policy_denied",
      failureCode: "policy_denied",
    });
    return { kind: "deny", reason: "The deterministic permission policy denies this action." };
  }

  let delegationContext: Record<string, unknown> | null = null;
  let delegationBindingSnapshot: string | null = null;
  let userContext: UserAuthorizationContext;
  if (forwardedRequested) {
    const identity = forwardedIdentity(details)!;
    const bound = state.childDelegations.get(identity.sessionId);
    const runtime = childRuntimeFactsRegistry().get(identity.sessionId);
    const currentAuthorization = buildUserContext(branch, state.provenance);
    if (!currentAuthorization.ok)
      return defer(currentAuthorization.failureCode, actionResult.actionDigest);
    const bindingFailure = delegationBindingFailure(bound, runtime, {
      sessionId: state.sessionId,
      cwd: ctx.cwd,
      generation: state.generation,
      authorizationDigest: digest(currentAuthorization.context),
      agentName: identity.agentName,
    });
    if (bindingFailure || !boundedProfileIsValid(ctx.cwd, identity.agentName, BINDING_POLICY)) {
      return defer(bindingFailure ?? "delegation_unbound", actionResult.actionDigest);
    }
    const call = bound!.calls.find(
      (entry) =>
        entry.profile === identity.agentName && entry.promptDigest === runtime!.initialPromptDigest,
    );
    if (!call) return defer("delegation_unbound", actionResult.actionDigest);
    delegationBindingSnapshot = delegationReviewDigest(bound, runtime, details.requestId);
    // delegationBindingFailure returns delegation_unbound when either is
    // absent, so the early return above has already established both.
    userContext = bound!.userAuthorization;
    const childRestrictions = buildProjectRestrictions(ctx, bound!.childSystemPrompt);
    if (!childRestrictions.ok)
      return defer(childRestrictions.failureCode, actionResult.actionDigest);
    delegationContext = {
      agentName: identity.agentName,
      calls: [call],
      // Child-loaded instructions can only restrict the parent's authorization.
      projectInstructionExcerpts: childRestrictions.restrictions,
      authorizationEffect: "restriction_and_task_evidence_only",
    };
  } else {
    const built = buildUserContext(branch, state.provenance);
    if (!built.ok) return defer(built.failureCode, actionResult.actionDigest);
    userContext = built.context;
  }

  const projectRestrictionsResult = buildProjectRestrictions(ctx);
  if (!projectRestrictionsResult.ok)
    return defer(projectRestrictionsResult.failureCode, actionResult.actionDigest);
  const projectInstructionExcerpts = projectRestrictionsResult.restrictions;
  const untrustedBackground = {
    compactionSummary: forwardedRequested ? null : latestCompactionSummary(branch),
    recentToolCalls: forwardedRequested ? [] : recentToolCallFacts(branch, details.toolCallId),
    assistantTextIncluded: false,
    childTranscriptIncluded: false,
    toolOutputIncluded: false,
  };

  // A script body is the likeliest place in the whole packet to find a
  // hardcoded token, so it is read BEFORE the gate below and screened with
  // everything else. Assembling it inline in the packet literal instead put it
  // past the one check whose entire purpose is that these contents leave the
  // machine.
  const invokedScript = invokedScriptFact(ctx.cwd, request.value);

  // Built before the sensitive-context gate because these contents leave the
  // machine, and the literal redaction only catches secrets that announce
  // themselves.
  if (
    hasSensitiveKeyValue(actionResult.action) ||
    userContext.messages.some((message) => CREDENTIAL_LITERAL.test(message.text)) ||
    hasSensitiveKeyValue(projectInstructionExcerpts) ||
    hasSensitiveKeyValue(delegationContext) ||
    hasSensitiveKeyValue(untrustedBackground) ||
    (invokedScript !== null &&
      (hasSensitiveKeyValue(invokedScript) || CREDENTIAL_LITERAL.test(invokedScript.body)))
  ) {
    return defer("sensitive_context", actionResult.actionDigest);
  }

  const checkpointReason = hardCheckpointReason(details, actionResult.currentToolCall);
  if (checkpointReason) {
    if (pending) {
      pending.suggestedVerdict = "defer";
      pending.failureStage = "hard_checkpoint";
    }
    writeAudit(log, {
      requestDigest,
      actionDigest: actionResult.actionDigest,
      mode,
      requestScope: scope,
      modelCalled: false,
      latencyMs: null,
      suggestedVerdict: "defer",
      effectiveVerdict: "defer",
      reasonCode: "hard_checkpoint",
      failureCode: "hard_checkpoint",
      checkpointReason,
    });
    return { kind: "defer" };
  }

  const packet = {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    actionBinding: {
      actionDigest: actionResult.actionDigest,
      cwd: ctx.cwd,
      scope: forwardedRequested ? "delegated_child_exact_action" : "single_turn_exact_action",
    },
    deterministicPolicy: {
      state: deterministicPolicy.state,
      source: deterministicPolicy.source,
      origin: deterministicPolicy.origin,
      matchedPattern: deterministicPolicy.matchedPattern ?? null,
    },
    exactAction: actionResult.action,
    invokedScript,
    userAuthorization: userContext,
    delegationContext,
    projectInstructionExcerpts,
    untrustedBackground,
  };

  const serializedPacket = canonicalJson(packet);
  const packetTokens = estimateTokens(serializedPacket);
  if (packetTokens > MAX_PACKET_TOKENS) return defer("context_oversize", actionResult.actionDigest);

  const now = Date.now();
  if (state.circuitOpenUntil > now) return defer("circuit_open", actionResult.actionDigest);
  if (state.circuitOpenUntil !== 0) {
    state.circuitOpenUntil = 0;
    state.consecutiveReviewFailures = 0;
  }
  const packetDigest = textDigest(serializedPacket);
  if (
    state.activeReviews[scope] >= MAX_CONCURRENT_REVIEWS[scope] &&
    !state.inFlight.has(packetDigest)
  ) {
    // jev answers in well under a second, so an overloaded reviewer is a real
    // fault rather than a queue to wait out.
    return defer("review_overloaded", actionResult.actionDigest);
  }

  // Capture baseline VALUES before starting asynchronous work. Never re-digest
  // these mutable objects after the wait (a query may reuse its result object).
  // The current side below is deliberately rebuilt in full, with no leaf/count
  // shortcuts, cached approvals or filesystem/policy samples carried over the wait.
  let baseline: { policy: string; authorization: string; restrictions: string; script: string };
  try {
    baseline = {
      policy: digest(deterministicPolicy),
      authorization: digest(userContext),
      restrictions: digest(projectInstructionExcerpts),
      script: digest(invokedScript),
    };
  } catch {
    return defer("review_context_changed", actionResult.actionDigest);
  }
  const reviewPromise = trackedReview(state, packet, packetDigest, scope, reviewSignal);

  /** Audit one completed review and report whether the line was persisted. */
  const record = (
    review: ReviewResult,
    effective: Verdict,
    decision?: Decision,
    failureOverride?: FailureCode,
  ): JevAuditResult => {
    if (pending) {
      pending.suggestedVerdict = decision?.verdict ?? "defer";
      if (failureOverride || !decision)
        pending.failureStage = failureOverride ?? review.failureCode ?? "network_error";
    }
    return writeAudit(
      log,
      {
        requestDigest,
        actionDigest: actionResult.actionDigest,
        mode,
        requestScope: scope,
        modelCalled: review.failureCode !== "api_key_unavailable",
        latencyMs: review.latencyMs,
        suggestedVerdict: decision?.verdict ?? "defer",
        effectiveVerdict: effective,
        reasonCode:
          failureOverride ?? decision?.reasonCode ?? review.failureCode ?? "network_error",
        failureCode:
          failureOverride ?? (decision ? undefined : (review.failureCode ?? "network_error")),
        risk: decision?.risk,
        riskConfidence: decision?.riskConfidence,
        taskScope: decision?.taskScope,
        readOnly: decision?.readOnly,
        lane: decision?.lane,
        packetTokens,
        inputTokens: review.inputTokens,
      },
      effective === "allow" ? reviewIsCurrent : undefined,
    );
  };

  // No async work: the final validation and returned verdict are one turn.
  const reviewIsCurrent = (): boolean => {
    try {
      if (
        state.generation !== generation ||
        state.ctx !== ctx ||
        state.sessionId !== sessionId ||
        state.provenance.revision !== inputRevision ||
        state.includeSubagents !== includeSubagents ||
        state.modeRevision !== modeRevision ||
        modeForScope(state, scope) !== mode ||
        ctx.signal !== reviewSignal ||
        reviewSignal?.aborted ||
        ctx.signal?.aborted ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        (mode === "enforce" &&
          (state.pausedActions.has(actionRetryKey) ||
            state.pausedActions.has("*") ||
            state.approvalStateOverflow))
      )
        return false;
      const currentPolicy = query.checkPermission(
        policySurface,
        details.accessIntent?.boundaryValue ?? request.value ?? undefined,
        details.agentName ?? undefined,
      );
      if (digest(currentPolicy) !== baseline.policy) return false;
      const currentBranch = ctx.sessionManager.getBranch();
      const currentAction = buildAction(details, currentBranch);
      if (!currentAction.ok || currentAction.actionDigest !== actionResult.actionDigest)
        return false;
      const authorization = buildUserContext(currentBranch, state.provenance);
      if (!authorization.ok) return false;
      const authorizationDigest = digest(authorization.context);
      if (authorizationDigest !== baseline.authorization) return false;
      if (forwardedRequested) {
        const identity = forwardedIdentity(details);
        if (!identity) return false;
        const bound = state.childDelegations.get(identity.sessionId);
        const runtime = childRuntimeFactsRegistry().get(identity.sessionId);
        if (
          delegationBindingFailure(bound, runtime, {
            sessionId: state.sessionId,
            cwd: ctx.cwd,
            generation: state.generation,
            authorizationDigest,
            agentName: identity.agentName,
          }) ||
          !boundedProfileIsValid(ctx.cwd, identity.agentName, BINDING_POLICY) ||
          delegationReviewDigest(bound, runtime, details.requestId) !== delegationBindingSnapshot
        )
          return false;
      }
      const restrictions = buildProjectRestrictions(ctx);
      if (!restrictions.ok || digest(restrictions.restrictions) !== baseline.restrictions)
        return false;
      // Script contents are review evidence too: a changed body invalidates approval.
      if (digest(invokedScriptFact(ctx.cwd, request.value)) !== baseline.script) return false;
      return true;
    } catch {
      return false;
    }
  };

  // Shadow must not charge review latency to the human prompt. The ask returns
  // to the terminal authorizer now; the verdict is recorded when it lands, and
  // the permissions:decision join pairs it with what the person actually chose.
  if (mode === "shadow") {
    void reviewPromise.then(
      (review) => {
        record(
          review,
          "defer",
          review.answers ? combineVerdict(review.answers, policySurface) : undefined,
          reviewIsCurrent() ? undefined : "review_context_changed",
        );
      },
      () => {
        // trackedReview resolves its own failures; a rejection here is a bug in
        // the tracking wrapper and must not take the session down.
      },
    );
    if (pending) pending.deferredAt = Date.now();
    return { kind: "defer" };
  }

  const review = await reviewPromise;
  const decision = review.answers ? combineVerdict(review.answers, policySurface) : undefined;
  if (!reviewIsCurrent()) {
    record(review, "defer", decision, "review_context_changed");
    if (pending && pending.deferredAt === undefined) pending.deferredAt = Date.now();
    return { kind: "defer" };
  }
  if (!review.answers || !decision) {
    record(review, "defer");
    if (pending && pending.deferredAt === undefined) pending.deferredAt = Date.now();
    return { kind: "defer" };
  }

  const audited = record(review, decision.verdict, decision);

  // An allow whose audit line did not land is an unlogged grant. Downgrade it
  // rather than ship one.
  if (decision.verdict === "allow" && !audited.ok) {
    if (audited.reason === "validation_failed") {
      if (pending) {
        pending.failureStage = "review_context_changed";
        if (pending.deferredAt === undefined) pending.deferredAt = Date.now();
      }
      return { kind: "defer" };
    }
    return defer("audit_unavailable", actionResult.actionDigest);
  }
  if (decision.verdict === "allow") return { kind: "allow" };
  if (decision.verdict === "deny") {
    state.denialCount += 1;
    return {
      kind: "deny",
      reason:
        (decision.denyKey && DENIAL_REASONS[decision.denyKey]) ??
        "Auto-review denied this action. Use a safer plan or ask the user.",
    };
  }
  if (pending && pending.deferredAt === undefined) pending.deferredAt = Date.now();
  return { kind: "defer" };
}

/* ------------------------------------------------------------------ *
 * Extension
 * ------------------------------------------------------------------ */

function configuredMode(value: string | undefined): {
  mode: RolloutMode;
  includeSubagents: boolean;
} {
  // An absent variable means shadow. Enforcement for this judge is opt-in
  // until its calibration has been checked on real traffic.
  if (value === "enforce-subagents") return { mode: "enforce", includeSubagents: true };
  if (value === "enforce") return { mode: "enforce", includeSubagents: false };
  return { mode: "shadow", includeSubagents: false };
}

function updateModeStatus(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): void {
  try {
    // The approval indicator renders the mode when it is loaded; otherwise
    // this status is the only place the mode is visible.
    const shown = publishJudgeState(
      pi.events,
      "jev",
      state,
      ctx.sessionManager.getSessionId() || undefined,
    );
    const status =
      state.mode === "shadow"
        ? "jev: shadow"
        : state.includeSubagents
          ? "jev: ENFORCE+SUB"
          : "jev: ENFORCE";
    ctx.ui.setStatus(MODE_STATUS_KEY, shown ? undefined : status);
  } catch {
    // Status rendering is optional; authorization remains valid without it.
  }
}

function resolvePermissionsService(sessionId: string): PermissionsService | undefined {
  // pi-permission-system publishes this map immediately before permissions:ready.
  // A bare global .ts extension cannot reliably resolve packages under
  // ~/.pi/agent/npm, so use the documented process-global rendezvous. If it ever
  // disappears, registration fails safe and asks reach the terminal authorizer.
  const published = (globalThis as Record<symbol, unknown>)[SESSION_SERVICES_KEY];
  return published instanceof Map
    ? (published.get(sessionId) as PermissionsService | undefined)
    : undefined;
}

export default function jevAutoApproval(pi: ExtensionAPI): void {
  const configured = configuredMode(process.env.PI_JEV_APPROVAL_MODE);
  const state: RuntimeState = {
    ctx: undefined,
    sessionId: undefined,
    mode: configured.mode,
    includeSubagents: configured.includeSubagents,
    modeRevision: 0,
    hasParentSession: false,
    generation: 0,
    provenance: new InputProvenance(),
    denialCount: 0,
    activeReviews: { root: 0, subagent: 0 },
    consecutiveReviewFailures: 0,
    circuitOpenUntil: 0,
    inFlight: new Map(),
    pendingOutcomes: new Map(),
    childDelegations: new Map(),
    delegationAdmissions: new Map(),
    approvalAttempts: new Map(),
    pausedActions: new Map(),
    approvalStateOverflow: false,
    unsupportedStartDiagnosed: false,
    childWitnessDiagnosed: false,
  };
  let disposeAuthorizer: (() => void) | undefined;
  let registeredSessionId: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    disposeAuthorizer?.();
    disposeAuthorizer = undefined;
    registeredSessionId = undefined;
    state.ctx = ctx;
    state.auditNotices = undefined;
    state.sessionId = ctx.sessionManager.getSessionId();
    Object.assign(state, configuredMode(process.env.PI_JEV_APPROVAL_MODE));
    updateModeStatus(pi, ctx, state);
    try {
      const parentSession = ctx.sessionManager.getHeader()?.parentSession;
      state.hasParentSession = typeof parentSession === "string" && parentSession !== "";
    } catch {
      // If provenance cannot be established, disable auto-approval for this
      // session rather than treating it as a fresh root conversation.
      state.hasParentSession = true;
    }
    state.generation += 1;
    // A fresh session must not inherit the previous one's observed inputs.
    state.provenance = new InputProvenance();
    state.denialCount = 0;
    state.unsupportedStartDiagnosed = false;
    state.childWitnessDiagnosed = false;
    state.activeReviews = { root: 0, subagent: 0 };
    state.consecutiveReviewFailures = 0;
    state.circuitOpenUntil = 0;
    state.inFlight.clear();
    state.pendingOutcomes.clear();
    state.childDelegations.clear();
    state.approvalAttempts.clear();
    state.pausedActions.clear();
    state.approvalStateOverflow = false;
    state.delegationAdmissions.clear();
  });

  // The approval indicator's popover is the only runtime way to change this
  // judge's mode; the launch default still comes from PI_JEV_APPROVAL_MODE.
  // In-flight reviews recheck mode and subagent scope before any verdict
  // lands, so a change mid-review cannot commit under the old mode.
  pi.events.on(APPROVAL_SET_JUDGE_EVENT, (data) => {
    const request = readSetJudgeMode(data);
    const ctx = state.ctx;
    if (!request || !ctx || ctx.sessionManager.getSessionId() !== state.sessionId) return;
    request.applied = true;
    const changed =
      request.mode !== state.mode || request.includeSubagents !== state.includeSubagents;
    if (changed) {
      const previous = { mode: state.mode, includeSubagents: state.includeSubagents };
      state.mode = request.mode;
      state.includeSubagents = request.includeSubagents;
      // Retires every in-flight review. Human denials, pauses and the denial
      // fuse deliberately survive: a No is bound to the action and the user's
      // instruction, not to a mode, and only new direct input reopens it.
      state.modeRevision += 1;
      appendAudit(state, {
        event: "jev_model_judge.mode_changed",
        modelId: MODEL_ID,
        previousMode: previous.mode,
        previousIncludeSubagents: previous.includeSubagents,
        mode: state.mode,
        includeSubagents: state.includeSubagents,
        scope: "current_session",
        source: "indicator",
      });
    }
    // Publish the committed mode before the optional toast: a failed notify
    // must not leave the indicator (or its session record) on the old mode.
    updateModeStatus(pi, ctx, state);
    if (changed) {
      try {
        ctx.ui.notify(
          `Jev approval: ${state.mode === "shadow" ? "shadow" : state.includeSubagents ? "enforce + subagents" : "enforce root only"}` +
            " (current session only)",
          state.mode === "enforce" ? "warning" : "info",
        );
      } catch {
        // The request was applied and published; presentation is best-effort.
      }
    }
  });

  pi.on("input", (event) => state.provenance.input(event));
  pi.on("message_start", (event) => {
    if (state.provenance.message(event.message)) {
      // Only provenance-bound direct input reopens declined actions and the
      // denial fuse: the actual live message object, never a user-tagged
      // before_agent_start event or its label alone.
      state.approvalAttempts.clear();
      state.pausedActions.clear();
      state.approvalStateOverflow = false;
      state.denialCount = 0;
    }
  });
  // The turn boundary: before_agent_start binds the pending live input to the
  // run that will carry it; the provenance-bound actual message (message_start
  // above) is what re-opens the denial fuse and declined actions. A run started
  // by a custom message (sendMessage with triggerTurn) is not direct input: it
  // keeps the fuse and discards any pending input. The pinned SDK's
  // discriminated event makes `messageType` required: only a well-formed user
  // start (messageType "user" with a string prompt) can carry direct input, and
  // a user tag alone is never human origin. A missing, unknown or malformed
  // start fails closed -- it discards any pending input without binding
  // provenance or re-opening anything -- and draws one clear per-session
  // diagnostic, so an unrecognized event shape can never re-authorize what a
  // previous refusal, pause or in-flight review closed.
  pi.on("before_agent_start", (event) => {
    let prompt: string | undefined;
    let unsupportedShape: string | undefined;
    try {
      const messageType: unknown = event.messageType;
      if (messageType === "user") {
        const candidate: unknown = (event as { prompt?: unknown }).prompt;
        if (typeof candidate === "string") prompt = candidate;
        else unsupportedShape = "malformed_user_start";
      } else if (messageType !== "custom") {
        // A custom-message run is a legitimate non-human start, not a fault.
        unsupportedShape =
          typeof messageType === "string" ? "unknown_message_type" : "missing_message_type";
      }
    } catch {
      unsupportedShape = "unreadable_start_event";
    }
    state.provenance.beforeStart(prompt);
    if (unsupportedShape !== undefined)
      reportUnsupportedStartEvent(state, "session", unsupportedShape);
  });

  pi.events.on("pi-alehouse:approval:admitted", (event) =>
    captureDelegationAdmission(state, event),
  );
  pi.events.on("pi-alehouse:approval:started", (rawEvent) => {
    const sessionId = asRecord(rawEvent)?.sessionId;
    if (typeof sessionId === "string") captureDelegationRun(state, sessionId, BINDING_POLICY);
  });
  pi.events.on("pi-alehouse:approval:invalidated", (event) => {
    const identity = delegationIdentity(event);
    if (!identity || identity.owner_id !== state.sessionId) return;
    const admission = state.delegationAdmissions.get(identity.run_id);
    if (admission?.generation !== identity.generation || admission.agent_id !== identity.agent_id)
      return;
    state.delegationAdmissions.delete(identity.run_id);
    for (const [sessionId, bound] of state.childDelegations) {
      if (bound.runId === identity.run_id) state.childDelegations.delete(sessionId);
    }
  });
  pi.events.on("pi-alehouse:approval:finished", (rawEvent) => {
    const event = asRecord(rawEvent);
    const identity = delegationIdentity(event);
    if (
      !identity ||
      !event ||
      identity.owner_id !== state.sessionId ||
      typeof event.sessionId !== "string"
    )
      return;
    const admission = state.delegationAdmissions.get(identity.run_id);
    if (admission?.generation !== identity.generation || admission.agent_id !== identity.agent_id)
      return;
    state.delegationAdmissions.delete(identity.run_id);
    if (state.childDelegations.get(event.sessionId)?.runId === identity.run_id)
      state.childDelegations.delete(event.sessionId);
  });
  pi.events.on("pi-alehouse:approval:witness-invalidated", (rawEvent) => {
    // A trusted delegated child reports an unrecognized host event shape. The
    // report is bound to this session's live runtime facts -- both the
    // recorded parentSessionId and the delegation Run owner must be this
    // session -- so another owner or a stale session cannot consume this
    // session's one-time child warning. Runtime facts ownership is preferred
    // over an admission record: a real unsupported host without a human
    // admission still gets its diagnostic. The witness is already invalid and
    // nothing widens here; the reason passes a fixed-vocabulary gate before
    // any log, toast or quota is spent.
    const event = asRecord(rawEvent);
    const sessionId = event?.sessionId;
    const reason = event?.reason;
    if (typeof sessionId !== "string" || typeof reason !== "string") return;
    const runtime = childRuntimeFactsRegistry().get(sessionId);
    if (
      !runtime ||
      runtime.parentSessionId !== state.sessionId ||
      runtime.delegation?.owner_id !== state.sessionId
    )
      return;
    reportUnsupportedStartEvent(state, "child_witness", reason);
  });

  pi.events.on("permissions:ready", (rawEvent) => {
    const event = rawEvent as PermissionsReadyEvent;
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (!sessionId || sessionId !== state.sessionId || registeredSessionId === sessionId) return;
    try {
      const permissions = resolvePermissionsService(sessionId);
      if (state.sessionId !== sessionId) return;
      if (!permissions) throw new Error("permission service unavailable");
      disposeAuthorizer?.();
      disposeAuthorizer = permissions.registerAuthorizer(AUTHORIZER_NAME, (details, query, log) =>
        authorize(details, query, log, state),
      );
      registeredSessionId = sessionId;
    } catch {
      const message = `[${AUTHORIZER_NAME}] failed to register; permission asks will continue to the terminal authorizer`;
      appendAudit(state, { event: "jev_model_judge.registration_failed", modelId: MODEL_ID });
      // Console output would land in the middle of a fullscreen TUI frame.
      if (state.ctx?.hasUI) {
        try {
          state.ctx.ui.notify(message, "warning");
        } catch {
          console.warn(message);
        }
      } else {
        console.warn(message);
      }
    }
  });

  pi.events.on("permissions:decision", (rawEvent) => {
    const event = rawEvent as PermissionDecisionEvent;
    if (typeof event.requestId !== "string") return;
    recordApprovalDecision(state, event);
    const outcome = state.pendingOutcomes.get(event.requestId);
    if (!outcome || (event.result !== "allow" && event.result !== "deny")) return;
    outcome.decision = {
      result: event.result,
      resolution: typeof event.resolution === "string" ? event.resolution : null,
      decidedAt: Date.now(),
    };
    // The join is what makes shadow measurable: it pairs the recorded suggestion
    // with what the human actually chose.
    appendAudit(state, {
      event: "jev_model_judge.outcome",
      policyVersion: POLICY_VERSION,
      requestDigest: outcome.requestDigest,
      actionDigest: outcome.actionDigest ?? null,
      mode: outcome.mode,
      requestScope: outcome.requestScope,
      suggestedVerdict: outcome.suggestedVerdict ?? null,
      failureStage: outcome.failureStage ?? null,
      humanResult: event.result,
      resolution: outcome.decision.resolution,
      waitedMs: outcome.deferredAt ? outcome.decision.decidedAt - outcome.deferredAt : null,
      totalMs: outcome.decision.decidedAt - outcome.startedAt,
    });
    state.pendingOutcomes.delete(event.requestId);
  });

  pi.on("session_shutdown", () => {
    try {
      state.ctx?.ui.setStatus(MODE_STATUS_KEY, undefined);
    } catch {
      // The TUI may already be gone during shutdown.
    }
    disposeAuthorizer?.();
    disposeAuthorizer = undefined;
    registeredSessionId = undefined;
    state.ctx = undefined;
    state.sessionId = undefined;
    state.hasParentSession = false;
    state.generation += 1;
    state.activeReviews = { root: 0, subagent: 0 };
    state.consecutiveReviewFailures = 0;
    state.circuitOpenUntil = 0;
    state.inFlight.clear();
    state.pendingOutcomes.clear();
    state.childDelegations.clear();
    state.approvalAttempts.clear();
    state.pausedActions.clear();
    state.approvalStateOverflow = false;
    state.delegationAdmissions.clear();
  });
}
