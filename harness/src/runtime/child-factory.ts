import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager,
  type CreateAgentSessionOptions, type EventBus, type ExtensionContext, type ModelRuntime,
  type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AdmittedAgentConfig, RunIdentity } from "../core/contracts.js";
import type { DispatchWorkspacePolicy } from "../core/dispatch.js";
import { SessionInitializationError, type AgentSessionPort, type RunCallbacks } from "../core/ports.js";
import { withWorkspaceRecovery } from "../core/workspace-metadata.js";
import { PiRunJournal } from "../history/run-journal.js";
import type { ApprovalBindings } from "../permissions/approval-provenance.js";
import { requireReadiness } from "../permissions/readiness.js";
import { createChildTools } from "../tools/child-tools.js";
import { webProfileNames, type AgentProfileName } from "../tools/tool-names.js";
import { PiAgentSessionAdapter, ChildRunGate } from "./agent-session.js";
import { createAgentWorkspace, type AgentWorkspaceHandle } from "./agent-workspace.js";
import type { ChildActivityRegistry } from "./activity-observer.js";
import { assembleChildSession, disposeChildSession } from "./child-session.js";
import { childWebExtension, type ChildWebModules, type WebLease } from "./child-web.js";
import { digest } from "./context-snapshot.js";
import { orderFreeToolSchemaExtension } from "./provider-schema.js";
import { ManagedBlockObserver, type ManagedBlockSubscription } from "./permission-blocks.js";
import { WorkerStatsObserver } from "./worker-stats.js";

export interface ChildProfile {
  definition: string;
  body: string;
  tools: string[];
}

/** Authority-owned live restriction aliases, not a cwd or path-effect rewrite. */
export type WorkspacePolicyBinder = (input: { sessionId: string; cwd: string; source_cwd: string;
  checkout_root: string; source_root: string; projectTrusted: boolean }) => DispatchWorkspacePolicy & { release(): void };
interface ChildLeases {
  web?: WebLease;
  policy?: ReturnType<WorkspacePolicyBinder>;
  workspace?: AgentWorkspaceHandle;
}

/** Builds the controller's session port without moving adapter execution state. */
export function createChildSessionFactory(options: {
  ctx: ExtensionContext;
  parentBus: EventBus;
  agentDir: string;
  permissionRoot: string;
  policyRoot: string;
  parentId: string;
  runtime: ModelRuntime;
  profiles: Readonly<Record<string, ChildProfile>>;
  settings(): SettingsManager;
  parentHistory: ConstructorParameters<typeof PiRunJournal>[0]["parent"];
  approvalBindings: ApprovalBindings;
  activities: ChildActivityRegistry;
  parentPermission(): unknown;
  getPermissionsService: (id: string) => unknown;
  /** Trusted, metadata-only managed authority observations; never approval. */
  subscribeManagedBlocks?: ManagedBlockSubscription;
  /** Isolated pi-web-access instances; required only by web profiles. */
  web?: ChildWebModules;
  /** Launcher-verified Git for optional actual-assembly worktree creation. */
  git?: string;
  /** Mandatory authority bridge for worktree sessions; never copy .pi files. */
  bindWorkspacePolicy?: WorkspacePolicyBinder;
}): (agent: { agent_id: string; name: string; settings: AdmittedAgentConfig }) => Promise<AgentSessionPort> {
  // Agent lifetime, not Run lifetime. Successful workspaces and failed creation
  // diagnostics survive assembly failure; no blind retry or automatic removal.
  const workspaces = new Map<string, Promise<AgentWorkspaceHandle>>();
  return async (agent): Promise<AgentSessionPort> => {
    assert(options.parentPermission(), "Parent permission service is missing");
    const profile = options.profiles[agent.settings.profile];
    assert(profile && digest(profile.definition) === agent.settings.definition_digest, "Agent profile changed");
    assert.deepEqual(agent.settings.tools, profile.tools);
    const listed = options.runtime.getModel(agent.settings.provider, agent.settings.model);
    assert(listed, "Agent model is no longer available");
    // Admission pinned a concrete id. A later virtual catalogue entry hides the
    // physical model; do not construct a child on a per-request router.
    const model = options.runtime.getPhysicalModel(agent.settings.provider, agent.settings.model);
    assert(model, "Agent model is no longer physical");
    const leases: ChildLeases = {};
    try {
      if (agent.settings.workspace === "worktree") {
        assert(typeof options.bindWorkspacePolicy === "function", "Worktree policy inheritance is unavailable; start through the pi-alehouse launcher");
        assert(typeof options.ctx.isProjectTrusted === "function", "Source project trust is unavailable");
        let pending = workspaces.get(agent.agent_id);
        if (!pending) {
          pending = createAgentWorkspace({ agentDir: options.agentDir, agentId: agent.agent_id, sourceCwd: agent.settings.cwd, git: options.git });
          workspaces.set(agent.agent_id, pending);
        }
        leases.workspace = await pending;
        assert.equal(leases.workspace.workspace.source_cwd, agent.settings.cwd, "Agent workspace source changed");
      }
      if (webProfileNames.includes(agent.settings.profile as AgentProfileName)) {
        assert(options.web, "Researcher web access is unavailable; start through the pi-alehouse launcher");
        leases.web = await options.web.acquire();
      }
      return await assemble(agent, profile, model, leases);
    } catch (error) {
      // No execution was created, or assembly confirmed cleanup. Uncertain
      // shutdown retains both workspace policy and isolated web authority.
      if (!(error instanceof SessionInitializationError)) {
        leases.policy?.release();
        leases.web?.release();
      }
      if (leases.workspace) {
        const handle = leases.workspace;
        throw withWorkspaceRecovery(error, { ...handle.workspace, state: "checkout_ready",
          checkout_root: handle.checkout_root, recovery_manifest: handle.manifest });
      }
      // Workspace failures already carry observed facts through the private
      // recovery attachment; constructor fields alone are not observations.
      throw error;
    }
  };
  async function assemble(agent: { agent_id: string; name: string; settings: AdmittedAgentConfig }, profile: ChildProfile,
    model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
    leases: ChildLeases): Promise<AgentSessionPort> {
    const { web, workspace: handle } = leases;
    const workspace = handle?.workspace, cwd = workspace?.cwd ?? agent.settings.cwd;
    const bus = createEventBus(), gate = new ChildRunGate(), childSettings = options.settings();
    // Held, not re-fetched: this is the observer instance bound to the child.
    const activity = options.activities.track(agent.agent_id, cwd);
    // Attachment is lazy at first Run: failed assembly creates no parent-side
    // telemetry registration, even if loading failed before SDK shutdown bound.
    const stats = new WorkerStatsObserver(options.parentBus, options.parentId, agent.agent_id);
    const blocks = new ManagedBlockObserver(options.subscribeManagedBlocks);
    let callbacks: RunCallbacks | undefined;
    const customTools = createChildTools(() => callbacks, gate);
    // Pi reserves an ID/path here but does not create the journal until its
    // first assistant response, so a failed reload leaves no JSONL.
    const manager = SessionManager.create(cwd, options.ctx.sessionManager.getSessionDir(), {
      parentSession: options.ctx.sessionManager.getSessionFile(),
    });
    // Bind before permission extensions load. Discovery stays source-scoped,
    // while SDK paths, permission effects and approval facts use actual cwd.
    if (workspace) {
      const projectTrusted = options.ctx.isProjectTrusted();
      assert.equal(typeof projectTrusted, "boolean", "Source project trust is unavailable");
      leases.policy = options.bindWorkspacePolicy!({ sessionId: manager.getSessionId(), cwd,
        source_cwd: agent.settings.cwd, checkout_root: handle.checkout_root, source_root: handle.source_root, projectTrusted });
      assert(leases.policy && typeof leases.policy.release === "function" && typeof leases.policy.aliases === "function",
        "Worktree policy binding is unavailable; restart with a matched pi-alehouse runtime");
      assert.deepEqual(leases.policy.aliases([]), [], "Worktree policy binding is unavailable");
    }
    const loader = new DefaultResourceLoader({ cwd: agent.settings.cwd, agentDir: options.agentDir,
      settingsManager: childSettings, eventBus: bus,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [join(options.permissionRoot, "index.ts"),
        join(options.policyRoot, "static-safety-guard.ts"), join(options.policyRoot, "policy-grep.ts")],
      appendSystemPromptOverride: () => [profile.body, `<active_agent name="${agent.settings.profile}"/>`,
        ...(workspace ? [`Workspace: ${JSON.stringify(workspace)}\nRecovery manifest: ${handle.manifest}\nOnly the committed baseline is present; source dirty/untracked files are not copied. This worktree is retained; no automatic merge, commit or removal.`] : [])],
      // The gate must stay LAST. Inline factories load after every path above,
      // and cache_warming_decision is last-writer-wins in the runner, so only
      // the final handler's stop is authoritative. The activity observer has no
      // decision handler today; preserve this order so the veto remains final
      // for any handlers added beside it later.
      extensionFactories: [orderFreeToolSchemaExtension, ...(web ? [childWebExtension(web.factory)] : []), activity.extension,
        options.approvalBindings.childExtension(manager.getSessionId()), stats.extension, gate.extension] });
    await loader.reload();
    manager.appendCustomEntry("active_agent", { name: agent.settings.profile, ...(workspace ? { workspace } : {}), routing: {
      preset: agent.settings.preset, preset_version: agent.settings.preset_version,
      selection_digest: agent.settings.selection_digest, difficulty: agent.settings.difficulty, strength: agent.settings.strength,
      provider: agent.settings.provider, model: agent.settings.model, thinking: agent.settings.thinking,
      ...(agent.settings.parent_thinking !== undefined ? { parent_thinking: agent.settings.parent_thinking } : {}),
      thinking_resolution: agent.settings.thinking_resolution,
      ...(agent.settings.effort_source !== undefined ? { effort_source: agent.settings.effort_source } : {}),
    } });
    const child = await assembleChildSession({ createSession: createAgentSession,
      options: { cwd, agentDir: options.agentDir, resourceLoader: loader,
        settingsManager: childSettings, sessionManager: manager,
        modelRuntime: options.runtime, model,
        thinkingLevel: agent.settings.thinking as CreateAgentSessionOptions["thinkingLevel"],
        tools: profile.tools, customTools },
      parentBus: options.parentBus, childBus: bus, parentSessionId: options.parentId,
      profile: agent.settings.profile, definitionDigest: agent.settings.definition_digest,
      getPermissionsService: options.getPermissionsService });
    try {
      assert.equal(child.session.sessionId, manager.getSessionId(), "Child session identity changed");
      assert.equal(child.session.thinkingLevel, agent.settings.thinking);
      assert.deepEqual(child.session.getActiveToolNames().sort(), [...profile.tools].sort());
      let approvalRun: RunIdentity | undefined;
      const port = new PiAgentSessionAdapter({ session: child.session, parentBus: options.parentBus, gate,
        invalidateApproval: () => {
          if (approvalRun) options.approvalBindings.end(child.session.sessionId, approvalRun);
        },
        history: new PiRunJournal({ parent: options.parentHistory, session: manager }),
        readiness: () => requireReadiness(bus, options.getPermissionsService, child.session.sessionId,
          agent.settings.profile, agent.settings.definition_digest) });
      return { session_id: port.session_id, history: port.history,
        ...(workspace ? { workspace, workspace_details: Object.freeze({ checkout_root: handle.checkout_root, recovery_manifest: handle.manifest }),
          // The authority retains roots and validates liveness on every query.
          // Core receives only the deny-alias seam, never release authority.
          workspace_policy: Object.freeze({ aliases: (paths: readonly string[]) => leases.policy!.aliases(paths) }) } : {}),
        // Reset at submission, before the child can report this Run's activity.
        run: async (prompt, cb, identity) => {
          options.approvalBindings.begin(identity, { sessionId: port.session_id, cwd,
            profile: agent.settings.profile, definitionDigest: agent.settings.definition_digest, prompt });
          approvalRun = identity;
          activity.begin();
          callbacks = cb;
          // A rejected accepted Run (including port readiness/admission) is
          // attention-worthy even before SDK work starts. This marks health,
          // not a fabricated model/tool request or execution-start claim.
          let kind: "success" | "error" | "aborted" = "error";
          stats.beginRun();
          blocks.begin(port.session_id, cb, () => gate.accepting && !gate.stopped);
          let unsubscribeBlocks: (() => void) | undefined;
          try {
            // A block fact only latches counters in the permission stack. This
            // SDK observation flushes after the real tool boundary returned.
            try { unsubscribeBlocks = child.session.subscribe((event) => {
              if (event.type === "tool_execution_end") blocks.flush();
            }); } catch { blocks.end(); /* Optional feedback may be unavailable. */ }
            const facts = await port.run(prompt, cb);
            kind = facts.kind;
            return facts;
          } finally {
            blocks.end();
            try { unsubscribeBlocks?.(); } catch { /* Optional telemetry is sealed. */ }
            stats.endRun(kind);
            callbacks = undefined;
            options.approvalBindings.end(port.session_id, identity);
            approvalRun = undefined;
          }
        },
        canInput: () => port.canInput(), steer: (text, valid) => port.steer(text, valid), stop: () => {
          blocks.end();
          return port.stop();
        },
        clearInputs: () => port.clearInputs(), dispose: async () => {
          blocks.end();
          const report = await port.dispose();
          stats.dispose();
          if (report.shutdownExited) {
            // Match core's confirmed-cleanup boundary for the workspace alias;
            // an exited shutdown with reported errors is still uncertain.
            if (!report.errors.length) leases.policy?.release();
            web?.release();
          }
          return report;
        } };
    } catch (error) {
      stats.dispose();
      // No prompt has started before handoff; disposal itself checks idle.
      try {
        const cleanup = await disposeChildSession(child.session, options.parentBus);
        assert(cleanup.shutdownExited && !cleanup.errors.length && !options.getPermissionsService(child.session.sessionId),
          "Child cleanup incomplete");
      } catch (cleanup) { throw new SessionInitializationError(error, cleanup); }
      throw error;
    }
  }
}
