import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { OwnerController } from "../core/owner-controller.ts";
import { terminal, type ReturnTo, type RunView, type SubmitRequest } from "../core/contracts.ts";
import {
  AGENT_EXISTS_RESOLUTION,
  COMMUNICATION_LIMITS,
  modelTaskStatus,
} from "../core/communication-envelope.ts";
import { taskMetadata } from "../core/task-metadata.ts";
import { HarnessError } from "../core/ports.ts";
import { digest, textSnapshot } from "../runtime/context-snapshot.ts";
import { requireParentAnswerPermission } from "../runtime/parent-answer-permission.ts";
import { resolveRoute, type PresetSelection } from "../routing.ts";
import { agentRow, taskReply, utf16Prefix } from "./replies.ts";
import { bindParentToolContext, type ParentToolBinding } from "./parent-tool-context.ts";
import {
  agentAnswerDescription,
  agentInterruptDescription,
  agentKillDescription,
  agentListDescription,
  agentOnlySchema,
  agentReadDescription,
  agentRunDescription,
  agentSendDescription,
  agentSpawnDescription,
  agentWaitDescription,
  answerSchema,
  listSchema,
  readSchema,
  runSchema,
  sendSchema,
  spawnSchema,
  waitSchema,
} from "./parent-schemas.ts";
import { agentProfileNames, blockedDelegationToolNames, internalProfile } from "./tool-names.ts";

export { AGENT_NAME_PATTERN } from "./parent-schemas.ts";

/** A label the model omitted: the first nonblank line of its instructions. */
const labelOf = (label: string | undefined, instructions: string): string =>
  label ??
  utf16Prefix(
    instructions
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "task",
    COMMUNICATION_LIMITS.label_units,
  );
const KILLED_SHOWN = 32;

export interface ToolProfile {
  definition: string;
  tools: readonly string[];
}
export interface OwnerToolsOptions {
  controller: OwnerController;
  /** Actual context of the fixed parent runner, not a model-supplied identity. */
  context: ExtensionContext;
  profiles: Readonly<Record<(typeof agentProfileNames)[number], ToolProfile>>;
  /** Pass the public helper from the HOST pi-ai; do not load a second SDK. */
  getSupportedThinkingLevels: (model: NonNullable<ExtensionContext["model"]>) => readonly string[];
  /** Active trusted preset snapshot. Read only inside submitPrepared so an
   * idempotent retry never re-resolves against changed configuration. */
  getPreset: () => PresetSelection;
  /** Live public parent permission service; required only for compound return_to. */
  parentPermission?: () => unknown;
  /** Best-effort host UI seam after a Run is accepted/replayed, BEFORE observe.
   * Failure cannot erase an accepted identity or mutate its final tool reply. */
  onRunAccepted?: (view: RunView) => void;
  /** The delegation guideline is rendered only while agent_spawn is active. */
  guideline?: string;
}

interface AgentLookup {
  readonly nameOf: (run_id: string) => string;
  readonly find: (name: string, key?: string) => { agent_id: string; run_id: string };
  readonly afterRuns: (self: string, agents: string[] | undefined) => string[] | undefined;
}

function agentLookup(controller: OwnerController): AgentLookup {
  const nameOf = (run_id: string) => controller.view(run_id).name;
  const knownNames = () =>
    controller
      .list()
      .map((view) => view.name)
      .filter(Boolean);
  const find = (name: string, key = "agent") => {
    const found = controller.findAgent(name);
    if (!found)
      throw new HarnessError("AGENT_NOT_FOUND", {
        agent: name,
        key,
        allowed: knownNames(),
        resolution:
          key === "agent"
            ? "Use a listed name; agent_spawn creates an Agent."
            : "Use listed Agent names.",
      });
    return found;
  };
  const afterRuns = (self: string, agents: string[] | undefined) =>
    agents?.map((name) => {
      if (name === self)
        throw new HarnessError("INVALID_PARAMETER", {
          key: "after",
          resolution: "An Agent cannot wait for itself.",
        });
      const { run_id } = find(name, "after"),
        view = controller.view(run_id);
      // A task that settled without completing can never satisfy after. Reject it
      // here instead of accepting a task that would fail at once.
      if (terminal(view.status) && view.status !== "completed") {
        const status = modelTaskStatus(view.status);
        throw new HarnessError("DEPENDENCY_NOT_COMPLETED", {
          agent: name,
          key: "after",
          reason: status,
          resolution: view.has_question
            ? `${name}'s task ended with a question, so it cannot complete. Answer it with agent_answer first; wait until agent_answer returns, then after: ["${name}"] waits for the answering task.`
            : `${name}'s latest task ended ${status}, so it cannot complete. Omit after, or name ${name} only once it has a new task.`,
        });
      }
      return run_id;
    });
  return { nameOf, find, afterRuns };
}

function admitProfiles(
  profiles: OwnerToolsOptions["profiles"],
): Map<
  (typeof agentProfileNames)[number],
  { readonly tools: readonly string[]; readonly definition_digest: string }
> {
  return new Map(
    agentProfileNames.map((name) => {
      const profile = structuredClone(profiles[name]);
      if (
        !profile ||
        typeof profile.definition !== "string" ||
        !profile.definition ||
        !Array.isArray(profile.tools) ||
        profile.tools.some(
          (tool) => typeof tool !== "string" || blockedDelegationToolNames.includes(tool),
        )
      )
        throw new HarnessError("INVALID_PROFILE_DEFINITION", { key: name });
      // Array.isArray widens a readonly array to any[]; keep the element contract.
      return [
        name,
        {
          tools: [...(profile.tools as readonly string[])],
          definition_digest: digest(profile.definition),
        },
      ] as const;
    }),
  );
}

function registerAdmissionTools(
  bound: ParentToolBinding,
  options: OwnerToolsOptions,
  profiles: ReturnType<typeof admitProfiles>,
  lookup: AgentLookup,
): ToolDefinition<TSchema, undefined, unknown>[] {
  const { controller, getSupportedThinkingLevels } = options;
  const { find, afterRuns } = lookup;
  const accepted = (view: RunView): void => {
    try {
      options.onRunAccepted?.(view);
    } catch {
      /* UI failure cannot undo admission. */
    }
  };
  return [
    bound.define(
      "agent_spawn",
      agentSpawnDescription,
      spawnSchema,
      async (args, ctx, id, signal) => {
        // Capture mutable SDK inputs before admission can await an earlier call.
        // Route/context resolution still happens only on first acceptance.
        const { parentThinking, messages } = controller.validateObservationEntry(() => {
          bound.assertCurrent(ctx);
          return {
            parentThinking: ctx.thinkingLevel,
            messages: args.inherit_context
              ? structuredClone(ctx.sessionManager.buildSessionProjection().messages)
              : undefined,
          };
        });
        const { wait_ms, ...submission } = args;
        const view = await controller.submitPrepared(
          `tool:agent_spawn:${digest(id)}`,
          submission,
          (input): SubmitRequest =>
            controller.validateObservationEntry(() => {
              bound.assertPrepared(ctx, signal);
              if (controller.findAgent(input.agent))
                throw new HarnessError("AGENT_EXISTS", {
                  agent: input.agent,
                  key: "agent",
                  resolution: AGENT_EXISTS_RESOLUTION,
                });
              const after = afterRuns(input.agent, input.after);
              let return_to: ReturnTo | undefined;
              if (input.return_to !== undefined) {
                let permission: unknown;
                try {
                  permission = options.parentPermission?.();
                } catch {
                  /* Missing service fails closed below. */
                }
                // The authority decides under the principal its own agent_answer gate binds.
                requireParentAnswerPermission(permission, ctx);
                const target = find(input.return_to.agent, "return_to");
                return_to = {
                  agent_id: target.agent_id,
                  question_id: input.return_to.question_id,
                  answer: input.return_to.answer,
                };
              }
              const profileId = internalProfile(input.profile);
              const profile = profiles.get(profileId)!;
              const route = resolveRoute({
                preset: options.getPreset(),
                difficulty: input.reasoning_difficulty,
                parentThinking,
                models: ctx.modelRegistry.getAll(),
                supportedThinking: getSupportedThinkingLevels,
              });
              let context_snapshot: string | undefined;
              if (messages) {
                try {
                  context_snapshot = textSnapshot(messages);
                } catch {
                  throw new HarnessError("CONTEXT_SNAPSHOT_TOO_LARGE");
                }
              }
              return {
                prompt: input.prompt,
                description: labelOf(input.label, input.prompt),
                name: input.agent,
                ...(input.max_turns === undefined ? {} : { max_turns: input.max_turns }),
                ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
                ...(after ? { after } : {}),
                ...(return_to === undefined ? {} : { return_to }),
                settings: {
                  ...route,
                  profile: profileId,
                  cwd: bound.cwd,
                  tools: [...profile.tools],
                  definition_digest: profile.definition_digest,
                  ...(context_snapshot === undefined ? {} : { context_snapshot }),
                },
              };
            }),
          { signal },
        );
        accepted(view);
        return bound.observe(
          { kind: "action", run_id: view.run_id, action: { type: "agent_spawn" }, wait_ms },
          ctx,
          signal,
        );
      },
    ),
    bound.define("agent_run", agentRunDescription, runSchema, async (args, ctx, id, signal) => {
      const target = find(args.agent);
      const { wait_ms, ...submission } = args;
      const view = await controller.submitPrepared(
        `tool:agent_run:${digest(id)}`,
        submission,
        (input): SubmitRequest =>
          controller.validateObservationEntry(() => {
            bound.assertPrepared(ctx, signal);
            const latest = controller.view(controller.findAgent(input.agent)!.run_id);
            if (!terminal(latest.status))
              throw new HarnessError("AGENT_BUSY", {
                agent: input.agent,
                resolution: "Add to its running task with agent_send, or agent_wait for it first.",
              });
            if (latest.has_question)
              throw new HarnessError("PENDING_QUESTION", {
                agent: input.agent,
                resolution:
                  "Read its question_id with agent_wait or agent_read, then answer with agent_answer. If delegation is off, ask the user to enable it first.",
              });
            const after = afterRuns(input.agent, input.after);
            return {
              resume: target.agent_id,
              prompt: input.prompt,
              description: labelOf(input.label, input.prompt),
              ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
              ...(after ? { after } : {}),
            };
          }),
        { settle: { agent_id: target.agent_id, signal } },
      );
      accepted(view);
      return bound.observe(
        { kind: "action", run_id: view.run_id, action: { type: "agent_run" }, wait_ms },
        ctx,
        signal,
      );
    }),
    bound.define(
      "agent_send",
      agentSendDescription,
      sendSchema,
      async ({ agent, message, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const { delivery, view } = await controller.send(
          `tool:agent_send:${digest(id)}`,
          target.agent_id,
          message,
          {
            signal,
            prepare: () =>
              controller.validateObservationEntry(() => bound.assertPrepared(ctx, signal)),
          },
        );
        return bound.observe(
          {
            kind: "action",
            run_id: view.run_id,
            action: { type: "agent_send", delivery },
            wait_ms,
          },
          ctx,
          signal,
        );
      },
    ),
    bound.define(
      "agent_answer",
      agentAnswerDescription,
      answerSchema,
      async ({ agent, question_id, answer, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const view = await controller.answer(
          `tool:agent_answer:${digest(id)}`,
          target.agent_id,
          question_id,
          answer,
          {
            signal,
            prepare: () =>
              controller.validateObservationEntry(() => bound.assertPrepared(ctx, signal)),
          },
        );
        accepted(view);
        return bound.observe(
          { kind: "action", run_id: view.run_id, action: { type: "agent_answer" }, wait_ms },
          ctx,
          signal,
        );
      },
    ),
  ];
}

function registerObservationTools(
  bound: ParentToolBinding,
  lookup: AgentLookup,
): ToolDefinition<TSchema, undefined, unknown>[] {
  const { find } = lookup;
  return [
    bound.define(
      "agent_wait",
      agentWaitDescription,
      waitSchema,
      ({ agents, mode = "all", wait_ms = 300000 }, ctx, _id, signal) => {
        const agent_ids = agents
          ? [...new Set(agents)].map((name) => find(name, "agents").agent_id)
          : undefined;
        return bound.observe(
          { kind: "wait", ...(agent_ids ? { agent_ids } : {}), mode, wait_ms },
          ctx,
          signal,
        );
      },
    ),
    bound.define(
      "agent_read",
      agentReadDescription,
      readSchema,
      ({ agent, task, cursor, max_chars = 16384 }, ctx, _id, signal) =>
        bound.observe(
          { kind: "read", agent_id: find(agent).agent_id, task, cursor, max_chars },
          ctx,
          signal,
        ),
    ),
  ];
}

function registerLifecycleTools(
  bound: ParentToolBinding,
  controller: OwnerController,
  lookup: AgentLookup,
): ToolDefinition<TSchema, undefined, unknown>[] {
  const { find, nameOf } = lookup;
  return [
    bound.define(
      "agent_interrupt",
      agentInterruptDescription,
      agentOnlySchema,
      ({ agent }, ctx) => {
        const snapshot = controller.cancel(find(agent).run_id).snapshot;
        return bound.independent(ctx, () => taskReply(snapshot, nameOf));
      },
    ),
    bound.define("agent_kill", agentKillDescription, agentOnlySchema, async ({ agent }, ctx) => {
      const target = find(agent);
      const { state } = await controller.kill(target.agent_id);
      return bound.independent(ctx, () => ({
        agent,
        status: state === "released" ? "killed" : state,
        label: taskMetadata(controller.view(target.run_id)).label,
        ...(state === "exiting"
          ? { resolution: "Still stopping; use agent_wait or agent_read." }
          : state === "cleanup_uncertain"
            ? { resolution: "Cleanup unconfirmed; tell the user, do not retry." }
            : {}),
      }));
    }),
    bound.define("agent_list", agentListDescription, listSchema, (_args, ctx) =>
      bound.independent(ctx, () => {
        const views = controller.list(),
          live = views.filter((view) => view.resident);
        const killed = views.filter((view) => !view.resident).map((view) => view.name);
        const addressed = (view: RunView) =>
          controller.view(controller.findAgent(view.name)?.run_id ?? view.run_id);
        return {
          agents: live.map((view) => agentRow(addressed(view), nameOf)),
          ...(killed.length ? { killed: killed.slice(-KILLED_SHOWN) } : {}),
          ...(killed.length > KILLED_SHOWN ? { killed_omitted: killed.length - KILLED_SHOWN } : {}),
        };
      }),
    ),
  ];
}

/** Explicit host assembly; the general-purpose core may have a larger resident
 * cap, but the model adapter must preserve every bound row within sixteen. */
export function createOwnerTools(
  options: OwnerToolsOptions,
): ToolDefinition<TSchema, undefined, unknown>[] {
  const bound = bindParentToolContext({
    controller: options.controller,
    boundContext: options.context,
    guideline: options.guideline,
  });
  const profiles = admitProfiles(options.profiles);
  const lookup = agentLookup(options.controller);
  const tools = [
    ...registerAdmissionTools(bound, options, profiles, lookup),
    ...registerObservationTools(bound, lookup),
    ...registerLifecycleTools(bound, options.controller, lookup),
  ];
  // Last assembly step, before any tool is exposed. This lifetime opt-in also
  // protects against incompatible work admitted through other core callers.
  options.controller.bindModelCommunication();
  return tools;
}
