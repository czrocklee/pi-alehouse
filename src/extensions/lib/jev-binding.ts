/**
 * Delegation evidence binding. A trusted delegation runtime publishes admission and
 * actual SDK Run facts; never infer a Run from model-authored delegation calls.
 * Helpers operate on the entrypoint's state, not a second authority or cache.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import {
  asRecord,
  buildObservedAction,
  buildUserContext,
  digest,
  type ChildToolObservations,
  type InputProvenance,
  type UserAuthorizationContext,
} from "./jev-review-packet.ts";

const CHILD_RUNTIME_FACTS_KEY = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
const MAX_TRACKED_CHILDREN = 256;
const MAX_DELEGATION_PROMPT_CHARS = 8_192;

type DelegationCallFact = {
  profile: string;
  description: string | null;
  prompt: string;
  promptDigest: string;
  promptTruncated: boolean;
};

export type ChildDelegationContext = {
  parentSessionId: string;
  expectedCwd: string;
  generation: number;
  userAuthorization: UserAuthorizationContext;
  authorizationDigest: string;
  calls: DelegationCallFact[];
  delegationDigest: string;
  runId: string;
  childSystemPrompt: string;
};

type DelegationRunIdentity = {
  owner_id: string;
  generation: string;
  agent_id: string;
  run_id: string;
};
type DelegationWitness = DelegationRunIdentity & {
  protocol: 1;
  profile: string;
  definitionDigest: string;
  task_prompt: string;
  prompt: string;
  systemPrompt?: string;
};
export type DelegationAdmission = DelegationRunIdentity & {
  parentGeneration: number;
  inputRevision: number;
  authorization: UserAuthorizationContext;
  authorizationDigest: string;
  instructionsDigest: string;
};
export type ChildRuntimeFacts = ChildToolObservations & {
  parentSessionId: string;
  cwd: string;
  initialPromptDigest?: string;
  contextChanged?: boolean;
  delegation?: DelegationWitness;
};

/** Borrowed fields from the sole RuntimeState; no instance is allocated here. */
type BindingState = {
  ctx: ExtensionContext | undefined;
  sessionId: string | undefined;
  hasParentSession: boolean;
  generation: number;
  provenance: InputProvenance;
  childDelegations: Map<string, ChildDelegationContext>;
  delegationAdmissions: Map<string, DelegationAdmission>;
};
export type BindingPolicy = {
  agentDir: string;
  workerPolicy: Readonly<Record<string, { digest: string; bashDenies: string[] }>>;
};

export function forwardedIdentity(
  details: PromptPermissionDetails,
): { sessionId: string; agentName: string } | undefined {
  const forwarding = asRecord(details.forwarding);
  const requester = asRecord(details.payload?.request?.requester);
  const accessIntent = asRecord(details.accessIntent);
  if (
    details.payload?.kind === "forwarded" ||
    requester?.forwarded !== true ||
    typeof forwarding?.requesterSessionId !== "string" ||
    forwarding.requesterSessionId.trim() === "" ||
    typeof forwarding.requesterAgentName !== "string" ||
    forwarding.requesterAgentName.trim() === "" ||
    requester.sessionId !== forwarding.requesterSessionId ||
    requester.agentName !== forwarding.requesterAgentName ||
    details.agentName !== forwarding.requesterAgentName ||
    typeof accessIntent?.surface !== "string" ||
    !Array.isArray(accessIntent.matchValues) ||
    accessIntent.matchValues.length === 0 ||
    !accessIntent.matchValues.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return { sessionId: forwarding.requesterSessionId, agentName: forwarding.requesterAgentName };
}

export function boundedProfileIsValid(
  cwd: string,
  profile: string,
  policy: BindingPolicy,
): boolean {
  const expected = policy.workerPolicy[profile]?.digest;
  if (!expected) return false;
  // A project file takes precedence over the managed global definition and can
  // change after discovery, so reject the name outright rather than guess.
  if (existsSync(join(cwd, ".pi", "agents", `${profile}.md`))) return false;
  try {
    const source = readFileSync(join(policy.agentDir, "agents", `${profile}.md`));
    return createHash("sha256").update(source).digest("hex") === expected;
  } catch {
    return false;
  }
}

export function childRuntimeFactsRegistry(): Map<string, ChildRuntimeFacts> {
  const globalRecord = globalThis as Record<symbol, unknown>;
  const published = globalRecord[CHILD_RUNTIME_FACTS_KEY];
  if (published instanceof Map) return published as Map<string, ChildRuntimeFacts>;
  const registry = new Map<string, ChildRuntimeFacts>();
  globalRecord[CHILD_RUNTIME_FACTS_KEY] = registry;
  return registry;
}

/** Join at the same managed edge as binding validation; packet shaping owns no registry. */
export function buildAction(
  details: PromptPermissionDetails,
  branch: readonly unknown[],
): ReturnType<typeof buildObservedAction> {
  const request = details.payload?.request;
  if (!request || typeof request.surface !== "string") {
    return { ok: false, failureCode: "context_incomplete" };
  }
  const forwarding = forwardedIdentity(details);
  const runtime = forwarding ? childRuntimeFactsRegistry().get(forwarding.sessionId) : undefined;
  return buildObservedAction(details, branch, request, forwarding, runtime);
}

export function delegationIdentity(value: unknown): DelegationRunIdentity | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !["owner_id", "generation", "agent_id", "run_id"].every(
      (key) => typeof record[key] === "string" && (record[key] as string).trim() !== "",
    )
  )
    return undefined;
  return {
    owner_id: record.owner_id as string,
    generation: record.generation as string,
    agent_id: record.agent_id as string,
    run_id: record.run_id as string,
  };
}

export function captureDelegationAdmission(state: BindingState, raw: unknown): void {
  const identity = delegationIdentity(raw);
  const ctx = state.ctx;
  if (!identity || !ctx || state.hasParentSession || identity.owner_id !== state.sessionId) return;
  // Missing/overflowed admission never falls back to the parent transcript.
  if (state.delegationAdmissions.size >= MAX_TRACKED_CHILDREN) return;
  try {
    const authorization = buildUserContext(ctx.sessionManager.getBranch(), state.provenance);
    if (!authorization.ok) return;
    state.delegationAdmissions.set(identity.run_id, {
      ...identity,
      parentGeneration: state.generation,
      inputRevision: state.provenance.revision,
      authorization: authorization.context,
      authorizationDigest: digest(authorization.context),
      instructionsDigest: digest(ctx.getSystemPrompt()),
    });
  } catch {
    /* Missing context leaves the Run unbound. */
  }
}

export function delegationBindingFailure(
  bound: ChildDelegationContext | undefined,
  runtime: ChildRuntimeFacts | undefined,
  current: {
    sessionId: string | undefined;
    cwd: string;
    generation: number;
    authorizationDigest: string;
    agentName: string;
  },
): "delegation_unbound" | "delegation_context_changed" | undefined {
  if (
    !bound ||
    !runtime ||
    bound.parentSessionId !== current.sessionId ||
    runtime.parentSessionId !== current.sessionId ||
    bound.expectedCwd !== current.cwd ||
    runtime.cwd !== current.cwd ||
    bound.generation !== current.generation ||
    !runtime.initialPromptDigest ||
    !runtime.delegation ||
    runtime.delegation.protocol !== 1 ||
    !bound.delegationDigest ||
    bound.delegationDigest !== digest(runtime.delegation) ||
    bound.runId !== runtime.delegation.run_id ||
    runtime.delegation.owner_id !== current.sessionId ||
    runtime.delegation.profile !== current.agentName ||
    runtime.initialPromptDigest !== digest(runtime.delegation.prompt) ||
    !bound.calls.some(
      (call) =>
        call.profile === current.agentName && call.promptDigest === runtime.initialPromptDigest,
    )
  ) {
    return "delegation_unbound";
  }
  if (runtime.contextChanged || bound.authorizationDigest !== current.authorizationDigest) {
    return "delegation_context_changed";
  }
  return undefined;
}

/** Stable Run authority plus only this ask's observed call. Other tool starts,
 * endings and forwarded asks may mutate the registry while review is pending. */
export function delegationReviewDigest(
  bound: ChildDelegationContext | undefined,
  runtime: ChildRuntimeFacts | undefined,
  requestId: string,
): string {
  const toolCallId = runtime?.requestTools?.[requestId];
  return digest({
    bound,
    runtime: runtime && {
      parentSessionId: runtime.parentSessionId,
      cwd: runtime.cwd,
      initialPromptDigest: runtime.initialPromptDigest,
      contextChanged: runtime.contextChanged,
      delegation: runtime.delegation,
    },
    toolCallId,
    toolCall: toolCallId ? runtime?.toolCalls?.[toolCallId] : undefined,
  });
}

export function captureDelegationRun(
  state: BindingState,
  sessionId: string,
  policy: BindingPolicy,
): void {
  const ctx = state.ctx;
  const runtime = childRuntimeFactsRegistry().get(sessionId);
  const witness = runtime?.delegation;
  const identity = delegationIdentity(witness);
  if (!ctx || state.hasParentSession || !runtime || !witness || !identity) return;
  const admitted = state.delegationAdmissions.get(identity.run_id);
  if (
    !admitted ||
    witness.protocol !== 1 ||
    admitted.owner_id !== state.sessionId ||
    identity.owner_id !== admitted.owner_id ||
    identity.generation !== admitted.generation ||
    identity.agent_id !== admitted.agent_id ||
    admitted.parentGeneration !== state.generation ||
    admitted.inputRevision !== state.provenance.revision ||
    runtime.parentSessionId !== state.sessionId ||
    runtime.cwd !== ctx.cwd ||
    runtime.contextChanged ||
    typeof witness.systemPrompt !== "string" ||
    typeof witness.task_prompt !== "string" ||
    !witness.task_prompt.trim() ||
    witness.task_prompt.length > MAX_DELEGATION_PROMPT_CHARS ||
    typeof witness.prompt !== "string" ||
    runtime.initialPromptDigest !== digest(witness.prompt) ||
    policy.workerPolicy[witness.profile]?.digest !== witness.definitionDigest ||
    !boundedProfileIsValid(ctx.cwd, witness.profile, policy)
  )
    return;
  try {
    const current = buildUserContext(ctx.sessionManager.getBranch(), state.provenance);
    if (
      !current.ok ||
      digest(current.context) !== admitted.authorizationDigest ||
      digest(ctx.getSystemPrompt()) !== admitted.instructionsDigest
    )
      return;
    if (
      !state.childDelegations.has(sessionId) &&
      state.childDelegations.size >= MAX_TRACKED_CHILDREN
    )
      return;
    state.childDelegations.set(sessionId, {
      parentSessionId: admitted.owner_id,
      expectedCwd: ctx.cwd,
      generation: state.generation,
      userAuthorization: admitted.authorization,
      authorizationDigest: admitted.authorizationDigest,
      calls: [
        {
          profile: witness.profile,
          description: null,
          prompt: witness.task_prompt,
          promptDigest: runtime.initialPromptDigest!,
          promptTruncated: false,
        },
      ],
      delegationDigest: digest(witness),
      runId: identity.run_id,
      childSystemPrompt: witness.systemPrompt,
    });
  } catch {
    /* Fail closed if loaded parent authorization cannot be re-read. */
  }
}
