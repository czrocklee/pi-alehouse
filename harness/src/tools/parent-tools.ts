import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { OwnerController } from "../core/owner-controller.js";
import { terminal, validDifficulty, type RunView, type SubmitRequest } from "../core/contracts.js";
import { isModelAgentName, MODEL_AGENT_NAME_PATTERN } from "../core/communication-envelope.js";
import type { CommunicationToolResult } from "../core/communication-snapshot.js";
import { QUESTION_ID_PATTERN } from "../core/question-id.js";
import { HarnessError } from "../core/ports.js";
import { digest, textSnapshot } from "../runtime/context-snapshot.js";
import { defaultDelegation, delegationGuideline } from "../delegation.js";
import { invalidDifficultyResolution, resolveRoute, type PresetSelection } from "../routing.js";
import { agentRow, errorReply, taskReply, utf16Prefix, type ErrorNames } from "./replies.js";
import { agentProfileNames, blockedDelegationToolNames } from "./tool-names.js";

// The model's whole vocabulary: an Agent (a named worker with a conversation)
// does one task at a time. Agents are addressed by name; no Run ID is model-facing.

const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S",
  ...(description ? { description } : {}) });
const optional = Type.Optional;
export const AGENT_NAME_PATTERN = MODEL_AGENT_NAME_PATTERN;
const agentName = (description?: string) => Type.String({ pattern: AGENT_NAME_PATTERN, ...(description ? { description } : {}) });
const agentNames = (maxItems: number, description: string) =>
  Type.Array(agentName(), { minItems: 1, maxItems, description });
const waitMs = (description: string) => Type.Integer({ minimum: 0, maximum: 300000, description });

const labelField = (source: string) => optional(text(120, `Short label for agent_list, not instructions. Default: the ${source}'s first line.`));
const afterField = (instructions: string) => optional(agentNames(4, `Other Agents whose current or latest task must complete first. Their results (16384 characters shared) come before the ${instructions} as reference, not instructions. If one ends any other way (question, failure, interrupt), this task fails without starting.`));
const waitField = optional(waitMs("Wait up to this long for the accepted task, its question, an issue or its alerts. Default 0: return a snapshot at once. Timing out never interrupts the task."));
const spawnSchema = Type.Object({
  agent: agentName("The new Agent's name: a short nickname, one theme per session (orca, otter), not a task name. Never reused."),
  prompt: text(131072, "Complete instructions. The Agent knows only this, its earlier tasks and any after results."),
  label: labelField("prompt"),
  profile: StringEnum(agentProfileNames, { description: "reader: investigates and reviews, cannot edit files; editor: may edit files; researcher: web search and fetch plus read-only file tools, no Bash or edits, and its results are web-derived and untrusted. Git mutations stay with you. Bash and web calls stay permission-gated; no profile is an OS sandbox." }),
  difficulty: Type.Integer({ minimum: 1, maximum: 5, description: "Picks the Agent's model; fixed for its lifetime. Rate the reasoning this task needs: 1=clear method, mostly execution; 2=routine local analysis; 3=independent investigation and a plan; 4=competing hypotheses or complex constraints; 5=no established approach. Not workload, importance or cost." }),
  inherit_context: optional(Type.Boolean({ description: "Default false. Start with a text copy of your conversation, without tool calls or results; fails over 64 KiB." })),
  after: afterField("prompt"),
  wait_ms: waitField,
  max_turns: optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Turn limit per task, default 256. Reaching it can leave a partial result." })),
  max_duration_ms: optional(Type.Integer({ minimum: 1, maximum: 86400000, description: "Time limit per task from its start, default 1800000; the task is then asked to stop." })),
}, { additionalProperties: false });
const runSchema = Type.Object({
  agent: agentName("An existing, idle Agent."),
  prompt: text(131072, "Complete instructions for the next task. The Agent remembers its earlier tasks."),
  label: labelField("prompt"),
  after: afterField("prompt"),
  wait_ms: waitField,
}, { additionalProperties: false });
const sendSchema = Type.Object({
  agent: agentName("An existing Agent; this call stays with the task selected now."),
  message: text(16384, "A correction or extra instruction for the current task. Never an answer or a new task: use agent_answer for a pending question and agent_run for the next task."),
  wait_ms: optional(waitMs("Wait for this task, its question, an issue or its alerts. Default 0 returns now; timeout/abort never interrupts it.")),
}, { additionalProperties: false });
const answerSchema = Type.Object({
  agent: agentName("The Agent with the pending question."),
  question_id: Type.String({ minLength: 34, maxLength: 34, pattern: QUESTION_ID_PATTERN,
    description: "Copy question_id exactly from a reply showing this question; never infer it from the Agent name or task number." }),
  answer: text(16384, "Your answer. The next task keeps the Agent's settings/budgets and the asking task's label."),
  wait_ms: waitField,
}, { additionalProperties: false });
const agentOnly = Type.Object({ agent: agentName("An existing Agent by name.") }, { additionalProperties: false });
/** A label the model omitted: the first nonblank line of its instructions. */
const labelOf = (label: string | undefined, instructions: string): string =>
  label ?? utf16Prefix(instructions.split("\n").map((line) => line.trim()).find(Boolean) ?? "task", 120);
const KILLED_SHOWN = 32;

export interface ToolProfile { definition: string; tools: readonly string[] }
export interface OwnerToolsOptions {
  controller: OwnerController;
  /** Actual context of the fixed parent runner, not a model-supplied identity. */
  context: ExtensionContext;
  profiles: Readonly<Record<typeof agentProfileNames[number], ToolProfile>>;
  /** Pass the public helper from the HOST pi-ai; do not load a second SDK. */
  getSupportedThinkingLevels: (model: NonNullable<ExtensionContext["model"]>) => readonly string[];
  /** Active trusted preset snapshot. Read only inside submitPrepared so an
   * idempotent retry never re-resolves against changed configuration. */
  getPreset: () => PresetSelection;
  /** Best-effort host UI seam after a Run is accepted/replayed, BEFORE observe.
   * Failure cannot erase an accepted identity or mutate its final tool reply. */
  onRunAccepted?: (view: RunView) => void;
  /** The delegation guideline is rendered only while agent_spawn is active. */
  guideline?: string;
}

/** Explicit host assembly; the general-purpose core may have a larger resident
 * cap, but the model adapter must preserve every bound row within sixteen. */
export function createOwnerTools(options: OwnerToolsOptions): ToolDefinition<TSchema, undefined, unknown>[] {
  const { controller, context: boundContext, getSupportedThinkingLevels } = options;
  controller.assertEffectAllowed();
  const { identity, manager, cwd, registry } = controller.validateObservationEntry(() => {
    const identity = controller.identity, manager = boundContext.sessionManager, cwd = boundContext.cwd;
    const registry = boundContext.modelRegistry;
    if (manager.getSessionId() !== identity.owner_id) throw new HarnessError("OWNER_CONTEXT_MISMATCH");
    return { identity, manager, cwd, registry };
  });
  const profiles = new Map(agentProfileNames.map((name) => {
    const profile = structuredClone(options.profiles[name]);
    if (!profile || typeof profile.definition !== "string" || !profile.definition || !Array.isArray(profile.tools) ||
        profile.tools.some((tool) => typeof tool !== "string" || blockedDelegationToolNames.includes(tool))) throw new HarnessError("INVALID_PROFILE_DEFINITION", { key: name });
    // Array.isArray widens a readonly array to any[]; keep the element contract.
    return [name, { tools: [...profile.tools as readonly string[]], definition_digest: digest(profile.definition) }] as const;
  }));
  const nameOf = (run_id: string) => controller.view(run_id).name;
  const names: ErrorNames = { agent: (id) => controller.agentName(id), run: nameOf };
  const toolError = (error: unknown) => new Error(JSON.stringify(errorReply(error instanceof HarnessError ? error :
    new HarnessError("TOOL_ERROR", { error: String(error) }), names)), { cause: error });
  const knownNames = () => controller.list().map((view) => view.name).filter(Boolean);
  const find = (name: string, key = "agent") => {
    const found = controller.findAgent(name);
    if (!found) throw new HarnessError("AGENT_NOT_FOUND", { agent: name, key, allowed: knownNames(),
      resolution: key === "agent" ? "Use a listed name; agent_spawn creates an Agent." : "Use listed Agent names." });
    return found;
  };
  const accepted = (view: RunView): void => {
    try { options.onRunAccepted?.(view); } catch { /* UI failure cannot undo admission. */ }
  };
  const assertCurrent = (ctx: ExtensionContext) => {
    try {
      // Read BOTH contexts through SDK guarded getters. Equal session IDs alone
      // do not detect reload of the same session or a captured stale closure.
      if (boundContext.sessionManager !== manager || ctx.sessionManager !== manager ||
          manager.getSessionId() !== identity.owner_id || boundContext.cwd !== cwd || ctx.cwd !== cwd ||
          boundContext.modelRegistry !== registry || ctx.modelRegistry !== registry ||
          controller.identity.owner_id !== identity.owner_id || controller.identity.generation !== identity.generation) throw new Error();
    } catch { throw new HarnessError("STALE_OWNER_CONTEXT", { resolution: "The harness session changed underneath this call; it may or may not have been accepted. Check agent_list before repeating it." }); }
  };
  const assertPrepared = (ctx: ExtensionContext, signal?: AbortSignal) => {
    assertCurrent(ctx);
    if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
  };
  const observe = (request: Parameters<OwnerController["observe"]>[0], ctx: ExtensionContext, signal?: AbortSignal) =>
    controller.observe(request, { validate: () => assertCurrent(ctx), signal });
  /** Only non-observation tools use this serializer, inside their own guarded
   * projection. No communication state or presentation references are touched. */
  const independent = (ctx: ExtensionContext, read: () => object): CommunicationToolResult =>
    controller.validateObservationEntry(() => {
      assertCurrent(ctx);
      return { content: [{ type: "text", text: JSON.stringify(read()) }], details: undefined };
    });

  const make = <S extends TObject>(name: string, description: string, schema: S,
    action: (args: Static<S>, ctx: ExtensionContext, id: string, signal?: AbortSignal) => CommunicationToolResult | Promise<CommunicationToolResult>): ToolDefinition<TSchema, undefined, unknown> => {
    const checked = (raw: unknown): Static<S> => {
      if (raw && typeof raw === "object" && name === "agent_spawn") {
        const { profile, difficulty } = raw as Record<string, unknown>;
        if (profile !== undefined && !(agentProfileNames as readonly unknown[]).includes(profile)) {
          throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...agentProfileNames] });
        }
        if (difficulty !== undefined && !validDifficulty(difficulty)) {
          throw new HarnessError("INVALID_DIFFICULTY", { key: "difficulty", resolution: invalidDifficultyResolution });
        }
      }
      const valid = Check(schema, raw);
      const fields = valid ? raw as Record<string, unknown> : {};
      const addressedNames: unknown[] = [
        ...(fields.agent === undefined ? [] : [fields.agent]),
        ...(Array.isArray(fields.agents) ? fields.agents as unknown[] : []),
        ...(Array.isArray(fields.after) ? fields.after as unknown[] : []),
      ];
      // Preserve the published pattern, but reject JS `$`'s final-newline
      // exception before admission can create an undeliverable Agent name.
      if (!valid || addressedNames.some((value) => !isModelAgentName(value))) throw new HarnessError("INVALID_PARAMETERS", {
        allowed: Object.keys(schema.properties),
        resolution: "The arguments do not match this tool's schema; check the required fields, their types and bounds." });
      return structuredClone(raw);
    };
    return { name, label: name, description, parameters: schema,
      ...(name === "agent_spawn" ? { promptGuidelines: [options.guideline ?? delegationGuideline(defaultDelegation)] } : {}),
      prepareArguments(raw) {
        controller.assertEffectAllowed();
        try { return checked(raw); } catch (error) { throw toolError(error); }
      },
      // The synchronous facade rejects nested work before any Promise/queue or
      // callback begins. A swallowed rejection still taints the source frame.
      execute(id, raw, signal, _update, ctx) {
        controller.assertEffectAllowed();
        try {
          const args = controller.validateObservationEntry(() => { assertCurrent(ctx); return checked(raw); });
          if (typeof id !== "string" || !id) throw new HarnessError("INVALID_REQUEST_ID");
          if (name !== "agent_wait" && name !== "agent_read" && signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
          // Observe's value is already serialized and committed. Only rejection
          // conversion is allowed here: no success-side check, UI, or wrapper.
          return Promise.resolve(action(args, ctx, id, signal)).catch((error: unknown) => { throw toolError(error); });
        } catch (error) { return Promise.reject(toolError(error)); }
      } };
  };
  const afterRuns = (self: string, agents: string[] | undefined) => agents?.map((name) => {
    if (name === self) throw new HarnessError("INVALID_PARAMETER", { key: "after", resolution: "An Agent cannot wait for itself." });
    return find(name, "after").run_id;
  });

  const tools = [
    make("agent_spawn", "Create a named Agent and give it its first task. Agents run in the background, share your checkout without isolation, and cannot delegate. Only researcher Agents can use the web. A settled needs_input task may offer a question_id; answer it with agent_answer, never agent_send. Give an idle Agent its next task with agent_run; spawn for unrelated work, an independent review or a different difficulty. Capacity is limited: kill idle Agents to make room. The reply uses action, reason, agents and alerts; an alert does not mean the task ended. If unsure a call was accepted, check agent_list before repeating it.", spawnSchema,
      async (args, ctx, id, signal) => {
        // Capture mutable SDK inputs before admission can await an earlier call.
        // Route/context resolution still happens only on first acceptance.
        const { parentThinking, messages } = controller.validateObservationEntry(() => {
          assertCurrent(ctx);
          return { parentThinking: ctx.thinkingLevel,
            messages: args.inherit_context ? structuredClone(ctx.sessionManager.buildSessionProjection().messages) : undefined };
        });
        const { wait_ms, ...submission } = args;
        const view = await controller.submitPrepared(`tool:agent_spawn:${digest(id)}`, submission, (input): SubmitRequest =>
          controller.validateObservationEntry(() => {
            assertPrepared(ctx, signal);
            if (controller.findAgent(input.agent)) throw new HarnessError("AGENT_EXISTS", { agent: input.agent, key: "agent",
              resolution: "Give an existing Agent its next task with agent_run. A killed Agent's name stays taken; choose another." });
            const after = afterRuns(input.agent, input.after);
            const profile = profiles.get(input.profile)!;
            const route = resolveRoute({ preset: options.getPreset(), difficulty: input.difficulty,
              parentThinking, models: ctx.modelRegistry.getAll(), supportedThinking: getSupportedThinkingLevels });
            let context_snapshot: string | undefined;
            if (messages) {
              try { context_snapshot = textSnapshot(messages); }
              catch { throw new HarnessError("CONTEXT_SNAPSHOT_TOO_LARGE"); }
            }
            return { prompt: input.prompt, description: labelOf(input.label, input.prompt), name: input.agent,
              ...(input.max_turns === undefined ? {} : { max_turns: input.max_turns }),
              ...(input.max_duration_ms === undefined ? {} : { max_duration_ms: input.max_duration_ms }),
              ...(after ? { after } : {}),
              settings: { ...route, profile: input.profile, cwd, tools: [...profile.tools], definition_digest: profile.definition_digest,
                ...(context_snapshot === undefined ? {} : { context_snapshot }) } };
          }));
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_spawn" }, wait_ms }, ctx, signal);
      }),
    make("agent_run", "Give an existing, idle Agent its next task. It keeps its conversation, profile, difficulty and budgets. A task that is ending is waited out (up to 30 s). A running Agent is busy: add to its task with agent_send, or agent_wait first. agent_run cannot bypass an unanswered question; use agent_answer with its question_id. Returns the shared action/reason/agents/alerts envelope.",
      runSchema, async (args, ctx, id, signal) => {
        const target = find(args.agent);
        const { wait_ms, ...submission } = args;
        const view = await controller.submitPrepared(`tool:agent_run:${digest(id)}`, submission, (input): SubmitRequest =>
          controller.validateObservationEntry(() => {
            assertPrepared(ctx, signal);
            const latest = controller.view(controller.findAgent(input.agent)!.run_id);
            if (!terminal(latest.status)) throw new HarnessError("AGENT_BUSY", { agent: input.agent,
              resolution: "Add to its running task with agent_send, or agent_wait for it first." });
            if (latest.has_question) throw new HarnessError("PENDING_QUESTION", { agent: input.agent,
              resolution: "Read its question_id with agent_wait or agent_read, then answer with agent_answer. If delegation is off, ask the user to enable it first." });
            const after = afterRuns(input.agent, input.after);
            return { resume: target.agent_id, prompt: input.prompt, description: labelOf(input.label, input.prompt), ...(after ? { after } : {}) };
          }), { settle: { agent_id: target.agent_id, signal } });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_run" }, wait_ms }, ctx, signal);
      }),
    make("agent_send", "Add a message to the task selected when you call; its target never drifts. action.delivery is joined (added to its prompt), steered (sent while running), or not_delivered (nothing sent; that task is shown). Never answers a question or creates a continuation: use agent_answer for questions, agent_run for new assignments. Waiting checks only this task and its alerts. Returns the shared envelope.",
      sendSchema, async ({ agent, message, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const { delivery, view } = await controller.send(`tool:agent_send:${digest(id)}`, target.agent_id, message, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_send", delivery }, wait_ms }, ctx, signal);
      }),
    make("agent_answer", "Answer a pending question by its exact question_id and start the next task on that Agent. Its question task must have finished needs_input and the Agent must be idle and reusable. Stale or reserved questions fail, never redirect. If workers_disabled, ask the user to enable delegation first, not retry this hidden tool.",
      answerSchema, async ({ agent, question_id, answer, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const view = await controller.answer(`tool:agent_answer:${digest(id)}`, target.agent_id, question_id, answer, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_answer" }, wait_ms }, ctx, signal);
      }),
    make("agent_wait", "Wait for tasks selected when called; selection stays fixed. Returns for completion, a question, a task issue, a harness fault or an alert. Completion may leave alerts pending. Reading a question does not answer it. Unanswered questions return again: to defer, set agents to other Agents, which also limits alerts to those Agents. Nothing pending returns immediately. Timeout/abort never interrupts workers. workers_disabled allows inspection, not starting, steering or answering; ask the user to enable delegation.",
      Type.Object({ agents: optional(agentNames(16, "Select these Agents' current, pending-question or latest tasks, and alerts from any of their tasks. Omit for unfinished tasks, answerable questions when delegation is enabled, and all Agents' alerts (even old/killed tasks).")),
        mode: optional(StringEnum(["all", "any"] as const, { default: "all",
          description: "all (default): every selected task must end; any: one, even if already ended. Questions, issues, faults or alerts may return sooner." })),
        wait_ms: optional(waitMs("Milliseconds, default/maximum 300000. 0 checks once.")) }, { additionalProperties: false }),
      ({ agents, mode = "all", wait_ms = 300000 }, ctx, _id, signal) => {
        const agent_ids = agents ? [...new Set(agents)].map((name) => find(name, "agents").agent_id) : undefined;
        return observe({ kind: "wait", ...(agent_ids ? { agent_ids } : {}), mode, wait_ms }, ctx, signal);
      }),
    make("agent_read", "Read a task's question/result page now; the full question takes priority over alerts. Alerts can be from any task of this Agent, even older ones, and are separate from result pages. Keep next_cursor for more of the original result after reuse. If workers_disabled, ask the user to enable delegation before answering with agent_answer.",
      Type.Object({ agent: agentName("Current task, else pending-question task, else latest. A cursor selects its original task; read can recover question_truncated text."),
        cursor: optional(text(1024, "Copy next_cursor for this Agent to continue that result after reuse; an omitted page keeps its starting offset.")),
        max_chars: optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Result page size in UTF-16 units, default/max 16384. Reply limits may set result_omitted/result_truncated; omitted_chars is text never retained." })) }, { additionalProperties: false }),
      ({ agent, cursor, max_chars = 16384 }, ctx, _id, signal) =>
        observe({ kind: "read", agent_id: find(agent).agent_id, cursor, max_chars }, ctx, signal)),
    make("agent_interrupt", "Request that the current task stop; this is not exit evidence. The Agent keeps its conversation, so agent_run can redirect it after settlement. Returns an independent task projection; consumes no alerts or finished reminders.",
      agentOnly, ({ agent }, ctx) => {
        const snapshot = controller.cancel(find(agent).run_id).snapshot;
        return independent(ctx, () => taskReply(snapshot, nameOf));
      }),
    make("agent_kill", "End an Agent permanently, interrupting any task. Its name is never reused; results stay readable and old alerts stay pending. status: killed; exiting (still stopping, cleanup continues); or cleanup_uncertain (could not be confirmed, no retry). Returns independently without consuming alerts or finished reminders.",
      agentOnly, async ({ agent }, ctx) => {
        const { state } = await controller.kill(find(agent).agent_id);
        return independent(ctx, () => ({ agent, status: state === "released" ? "killed" : state }));
      }),
    make("agent_list", "Read-only roster with current or latest tasks and history (earlier labels, context use, cost, edited files). has_question is current pending-question state, not a historical outcome: obtain question_id with agent_wait or agent_read, then use agent_answer if delegation is enabled. unavailable is a boolean; unavailable_reason is its diagnostic. List/interrupt/kill never consume alerts or finished reminders. Use agent_wait or agent_read to receive pending alerts; no automatic parent turn starts.",
      Type.Object({}, { additionalProperties: false }), (_args, ctx) => independent(ctx, () => {
        const views = controller.list(), live = views.filter((view) => view.resident);
        const killed = views.filter((view) => !view.resident).map((view) => view.name);
        const addressed = (view: RunView) => controller.view(controller.findAgent(view.name)?.run_id ?? view.run_id);
        return { agents: live.map((view) => agentRow(addressed(view), controller.agentSummary(view.agent_id), nameOf)),
          ...(killed.length ? { killed: killed.slice(-KILLED_SHOWN) } : {}),
          ...(killed.length > KILLED_SHOWN ? { killed_omitted: killed.length - KILLED_SHOWN } : {}) };
      })),
  ];
  // Last assembly step, before any tool is exposed. This lifetime opt-in also
  // protects against incompatible work admitted through other core callers.
  controller.bindModelCommunication();
  return tools;
}
