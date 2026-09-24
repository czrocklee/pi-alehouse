import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager,
  type CreateAgentSessionOptions, type EventBus, type ExtensionContext, type ModelRuntime,
  type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AdmittedAgentConfig, RunIdentity } from "../core/contracts.js";
import { SessionInitializationError, type AgentSessionPort, type RunCallbacks } from "../core/ports.js";
import { PiRunJournal } from "../history/run-journal.js";
import type { ApprovalBindings } from "../permissions/approval-provenance.js";
import { requireReadiness } from "../permissions/readiness.js";
import { createChildTools } from "../tools/child-tools.js";
import { PiAgentSessionAdapter, ChildRunGate } from "./agent-session.js";
import type { ChildActivityRegistry } from "./activity-observer.js";
import { assembleChildSession, disposeChildSession } from "./child-session.js";
import { digest } from "./context-snapshot.js";
import { WorkerStatsObserver } from "./worker-stats.js";

export interface ChildProfile {
  definition: string;
  body: string;
  tools: string[];
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
}): (agent: { agent_id: string; name: string; settings: AdmittedAgentConfig }) => Promise<AgentSessionPort> {
  return async (agent): Promise<AgentSessionPort> => {
    assert(options.parentPermission(), "Parent permission service is missing");
    const profile = options.profiles[agent.settings.profile];
    assert(profile && digest(profile.definition) === agent.settings.definition_digest, "Agent profile changed");
    assert.deepEqual(agent.settings.tools, profile.tools);
    const model = options.runtime.getModel(agent.settings.provider, agent.settings.model);
    assert(model, "Agent model is no longer available");
    const bus = createEventBus(), gate = new ChildRunGate(), childSettings = options.settings();
    // Held, not re-fetched: this is the observer instance bound to the child.
    const activity = options.activities.track(agent.agent_id, agent.settings.cwd);
    // Attachment is lazy at first Run: failed assembly creates no parent-side
    // telemetry registration, even if loading failed before SDK shutdown bound.
    const stats = new WorkerStatsObserver(options.parentBus, options.parentId, agent.agent_id);
    let callbacks: RunCallbacks | undefined;
    const customTools = createChildTools(() => callbacks, gate);
    // Pi reserves an ID/path here but does not create the journal until its
    // first assistant response, so a failed reload leaves no JSONL.
    const manager = SessionManager.create(options.ctx.cwd, options.ctx.sessionManager.getSessionDir(), {
      parentSession: options.ctx.sessionManager.getSessionFile(),
    });
    const loader = new DefaultResourceLoader({ cwd: options.ctx.cwd, agentDir: options.agentDir,
      settingsManager: childSettings, eventBus: bus,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [join(options.permissionRoot, "index.ts"),
        join(options.policyRoot, "static-safety-guard.ts"), join(options.policyRoot, "policy-grep.ts")],
      appendSystemPromptOverride: () => [profile.body, `<active_agent name="${agent.settings.profile}"/>`],
      // The gate must stay LAST. Inline factories load after every path above,
      // and cache_warming_decision is last-writer-wins in the runner, so only
      // the final handler's stop is authoritative. The activity observer has no
      // decision handler today; preserve this order so the veto remains final
      // for any handlers added beside it later.
      extensionFactories: [activity.extension,
        options.approvalBindings.childExtension(manager.getSessionId()), stats.extension, gate.extension] });
    await loader.reload();
    manager.appendCustomEntry("active_agent", { name: agent.settings.profile, routing: {
      preset: agent.settings.preset, preset_version: agent.settings.preset_version,
      selection_digest: agent.settings.selection_digest, difficulty: agent.settings.difficulty, strength: agent.settings.strength,
      provider: agent.settings.provider, model: agent.settings.model, thinking: agent.settings.thinking,
      ...(agent.settings.parent_thinking !== undefined ? { parent_thinking: agent.settings.parent_thinking } : {}),
      thinking_resolution: agent.settings.thinking_resolution,
      ...(agent.settings.effort_source !== undefined ? { effort_source: agent.settings.effort_source } : {}),
    } });
    const child = await assembleChildSession({ createSession: createAgentSession,
      options: { cwd: options.ctx.cwd, agentDir: options.agentDir, resourceLoader: loader,
        settingsManager: childSettings, sessionManager: manager,
        modelRuntime: options.runtime, model,
        thinkingLevel: agent.settings.thinking as CreateAgentSessionOptions["thinkingLevel"],
        tools: profile.tools, customTools },
      parentBus: options.parentBus, childBus: bus, parentSessionId: options.parentId,
      profile: agent.settings.profile, definitionDigest: agent.settings.definition_digest,
      getPermissionsService: options.getPermissionsService });
    try {
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
        // Reset at submission, before the child can report this Run's activity.
        run: async (prompt, cb, identity) => {
          options.approvalBindings.begin(identity, { sessionId: port.session_id, cwd: agent.settings.cwd,
            profile: agent.settings.profile, definitionDigest: agent.settings.definition_digest, prompt });
          approvalRun = identity;
          activity.begin();
          callbacks = cb;
          // A rejected accepted Run (including port readiness/admission) is
          // attention-worthy even before SDK work starts. This marks health,
          // not a fabricated model/tool request or execution-start claim.
          let kind: "success" | "error" | "aborted" = "error";
          stats.beginRun();
          try {
            const facts = await port.run(prompt, cb);
            kind = facts.kind;
            return facts;
          } finally {
            stats.endRun(kind);
            callbacks = undefined;
            options.approvalBindings.end(port.session_id, identity);
            approvalRun = undefined;
          }
        },
        canInput: () => port.canInput(), steer: (text, valid) => port.steer(text, valid), stop: () => port.stop(),
        clearInputs: () => port.clearInputs(), dispose: async () => {
          const report = await port.dispose();
          stats.dispose();
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
  };
}
