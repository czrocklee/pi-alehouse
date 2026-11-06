import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { OwnerController } from "../core/owner-controller.ts";
import { terminal, validDifficulty, type ReturnTo, type RunView, type SubmitRequest } from "../core/contracts.ts";
import { AGENT_EXISTS_RESOLUTION, COMMUNICATION_LIMITS, isModelAgentName, MODEL_AGENT_NAME_PATTERN, modelTaskStatus } from "../core/communication-envelope.ts";
import { taskMetadata } from "../core/task-metadata.ts";
import { packIndependentCommunication } from "../core/communication-packer.ts";
import type { CommunicationToolResult } from "../core/communication-snapshot.ts";
import { QUESTION_ID_PATTERN } from "../core/question-id.ts";
import { validateDispatch } from "../core/dispatch.ts";
import { HarnessError } from "../core/ports.ts";
import { digest, textSnapshot } from "../runtime/context-snapshot.ts";
import { requireParentAnswerPermission } from "../runtime/parent-answer-permission.ts";
import { defaultDelegation, delegationGuideline } from "../delegation.ts";
import { invalidDifficultyResolution, resolveRoute, type PresetSelection } from "../routing.ts";
import { agentRow, errorReply, taskReply, utf16Prefix, type ErrorNames } from "./replies.ts";
import { agentProfileNames, blockedDelegationToolNames, internalProfile, modelProfileNames } from "./tool-names.ts";

// The model's whole vocabulary: an Agent (a named worker with a conversation)
// does one task at a time. Agents are addressed by name; no Run ID is model-facing.

const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S",
  ...(description ? { description } : {}) });
// Pi 1.5's pi-ai root StringEnum returns a pi-schema schema, while Pi's extension
// loader aliases that import to a TypeBox view. Keep local enums TypeBox-backed
// for Static/Check under either resolution, with the same {type, enum} wire shape.
const stringEnum = <T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) =>
  Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
const optional = Type.Optional;
const offGuidance = "workers_disabled: ask the user to enable delegation for new work, steering or answers; accepted work and inspection continue.";
export const AGENT_NAME_PATTERN = MODEL_AGENT_NAME_PATTERN;
const agentName = (description?: string) => Type.String({ pattern: AGENT_NAME_PATTERN, ...(description ? { description } : {}) });
const agentNames = (maxItems: number, description: string) =>
  Type.Array(agentName(), { minItems: 1, maxItems, description });
const waitMs = (description: string) => Type.Integer({ minimum: 0, maximum: 300000, description });

const labelField = optional(text(COMMUNICATION_LIMITS.label_units, "Summary label, not instructions; defaults to prompt's first nonblank line."));
const afterField = optional(agentNames(4, "Wait for each named Agent's current or latest task, fixed when this call is accepted, to reach completed; any other settled status fails the dependency. Results become reference context. Does not follow later tasks or answers: wait until agent_answer returns before naming its Agent here."));
const waitField = optional(waitMs("Wait for task/events; default 0 returns now. Timeout/abort never stops work."));
const dispatchPath = (description: string) => Type.String({ minLength: 1, maxLength: 512,
  pattern: "^(?![~@])(?=.*\\S)[^\\x00-\\x1f\\x7f*?[\\]{}'\"`$\\\\]+(?![\\s\\S])", description });
const dispatchPaths = (maxItems: number, description: string) => Type.Array(dispatchPath(description), {
  minItems: 1, maxItems, uniqueItems: true,
});
const dispatchField = optional(Type.Object({
  inputs: optional(dispatchPaths(8, "Input file/directory; must exist when checked.")),
  ownership: optional(dispatchPaths(16, "File/directory to edit or create; needs write permission, one editor per shared file. Omit for read-only tasks.")),
  tree: optional(dispatchPath("Build/test output directory; needs write permission and, if it exists, must be a directory. Overlapping declared resources conflict within this Owner; cross-Owner tree locks are advisory, not global exclusivity.")),
  checks: optional(Type.Array(Type.String({ minLength: 1, maxLength: 512,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+(?![\\s\\S])",
    description: "Planned check identifier (globs allowed); ready for this task, not later go-ahead." }),
  { minItems: 1, maxItems: 16, uniqueItems: true })),
}, { additionalProperties: false,
  description: "Task scope and planned checks, not permissions or execution evidence. Use literal paths without padding, globs or shell expansion. Relative paths resolve from the inherited parent cwd; absolute paths keep their meaning. Assign full-suite validation to one designated Agent after shared source is stable." }));
const returnToField = optional(Type.Object({
  agent: agentName("Existing worker with a settled, unanswered question."),
  question_id: Type.String({ minLength: 34, maxLength: 34, pattern: QUESTION_ID_PATTERN,
    description: "Exact pending question_id returned by wait/read for that worker." }),
  answer: text(16384, "Your instruction for continuing the worker's task; scout findings are attached separately as untrusted reference material."),
}, { additionalProperties: false,
  description: "Scout only: answer a worker's pending question with this scout's findings. Needs agent_answer allowed for you without a prompt. The worker resumes automatically once the scout completes, findings attached; you do not read or relay them. Replies omit the scout's result (agent_read if needed); wait_ms waits for the worker. Kill the scout when done." }));
const spawnSchema = Type.Object({
  agent: agentName("Unique short nickname from one theme, not a task name; stays taken after kill."),
  prompt: text(131072, "Task instructions: deliverable, scope, stopping conditions, needed context, cwd-relative or absolute paths; source/version/date constraints and output format as relevant."),
  label: labelField,
  profile: stringEnum(modelProfileNames, { description: "worker: command-driven local investigation, changes and verification; read/edit/write, Bash/Git/builds; no web tools. scout: read-only local files and web sources; gather, cross-reference, compare, summarize and extract information with cited paths/URLs; no Bash/edit/write. Normal permissions/denies apply; review-only is an instruction; web material is untrusted." }),
  reasoning_difficulty: Type.Integer({ minimum: 1, maximum: 5, description: "Fixed model by reasoning difficulty, not workload/cost: 1=given checks/decided changes; 2=scoped fix; 3=given design/review/investigation/plan; 4=competing hypotheses/complex constraints; 5=unknown approach. Do not re-score to bypass capacity waits." }),
  return_to: returnToField,
  inherit_context: optional(Type.Boolean({ description: "Default false: text context without tool calls/results; max 64 KiB." })),
  dispatch: dispatchField,
  after: afterField,
  wait_ms: waitField,
  max_turns: optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Per-task turn limit; default 256, fixed for follow-ups. No task wall-clock deadline. May leave partial results." })),
}, { additionalProperties: false });
const runSchema = Type.Object({
  agent: agentName("An existing, idle Agent."),
  continues: text(512, "The specific earlier work of this Agent being continued; not sent to it. If you cannot name one, use agent_spawn (with after if only its output is needed)."),
  prompt: text(131072, "Follow-up instructions: deliverable, scope, stopping conditions, cwd-relative or absolute paths; source/version/date constraints and output format as relevant; earlier conversation is retained."),
  label: labelField,
  dispatch: dispatchField,
  after: afterField,
  wait_ms: waitField,
}, { additionalProperties: false });
const sendSchema = Type.Object({
  agent: agentName("Agent whose task is selected now; never retargets later work."),
  message: text(16384, "A correction or extra instruction for the current task. Never an answer (use agent_answer) or another task."),
  wait_ms: waitField,
}, { additionalProperties: false });
const answerSchema = Type.Object({
  agent: agentName("The Agent with the pending question."),
  question_id: Type.String({ minLength: 34, maxLength: 34, pattern: QUESTION_ID_PATTERN,
    description: "Copy the pending question_id exactly from wait/read." }),
  answer: text(16384, "Answer to this pending question. A worker's question needs web research? Spawn a scout with return_to instead of relaying its findings."),
  wait_ms: waitField,
}, { additionalProperties: false });
const agentOnly = Type.Object({ agent: agentName("An existing Agent by name.") }, { additionalProperties: false });
/** A label the model omitted: the first nonblank line of its instructions. */
const labelOf = (label: string | undefined, instructions: string): string =>
  label ?? utf16Prefix(instructions.split("\n").map((line) => line.trim()).find(Boolean) ?? "task", COMMUNICATION_LIMITS.label_units);
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
  /** Live public parent permission service; required only for compound return_to. */
  parentPermission?: () => unknown;
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
      return packIndependentCommunication(read() as Record<string, unknown>);
    });

  const make = <S extends TObject>(name: string, description: string, schema: S,
    action: (args: Static<S>, ctx: ExtensionContext, id: string, signal?: AbortSignal) => CommunicationToolResult | Promise<CommunicationToolResult>): ToolDefinition<TSchema, undefined, unknown> => {
    const checked = (raw: unknown): Static<S> => {
      if (raw && typeof raw === "object" && name === "agent_spawn") {
        const { profile, reasoning_difficulty } = raw as Record<string, unknown>;
        if (profile !== undefined && !(modelProfileNames as readonly unknown[]).includes(profile)) {
          throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...modelProfileNames] });
        }
        if (reasoning_difficulty !== undefined && !validDifficulty(reasoning_difficulty)) {
          throw new HarnessError("INVALID_DIFFICULTY", { key: "reasoning_difficulty", resolution: invalidDifficultyResolution });
        }
      }
      const valid = Check(schema, raw);
      const fields = valid ? raw as Record<string, unknown> : {};
      const addressedNames: unknown[] = [
        ...(fields.agent === undefined ? [] : [fields.agent]),
        ...(Array.isArray(fields.agents) ? fields.agents as unknown[] : []),
        ...(Array.isArray(fields.after) ? fields.after as unknown[] : []),
        ...(fields.return_to && typeof fields.return_to === "object" ? [(fields.return_to as Record<string, unknown>).agent] : []),
      ];
      // Preserve the published pattern, but reject JS `$`'s final-newline
      // exception before admission can create an undeliverable Agent name.
      if (!valid || addressedNames.some((value) => !isModelAgentName(value))) throw new HarnessError("INVALID_PARAMETERS", {
        allowed: Object.keys(schema.properties),
        resolution: "The arguments do not match this tool's schema; check the required fields, their types and bounds." });
      if (name === "agent_spawn" && fields.return_to !== undefined && fields.profile !== "scout")
        throw new HarnessError("INVALID_RETURN_TO", { key: "return_to", resolution: "Only a scout spawn can return results to a worker's pending question." });
      if ((name === "agent_spawn" || name === "agent_run") && fields.dispatch !== undefined) validateDispatch(fields.dispatch);
      if (name === "agent_read" && fields.task !== undefined && fields.cursor !== undefined)
        throw new HarnessError("INVALID_PARAMETERS", { key: "task", resolution: "Choose task to start its first page, or cursor to continue the original page; do not supply both." });
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
    const { run_id } = find(name, "after"), view = controller.view(run_id);
    // A task that settled without completing can never satisfy after. Reject it
    // here instead of accepting a task that would fail at once.
    if (terminal(view.status) && view.status !== "completed") {
      const status = modelTaskStatus(view.status);
      throw new HarnessError("DEPENDENCY_NOT_COMPLETED", { agent: name, key: "after", reason: status,
        resolution: view.has_question ?
          `${name}'s task ended with a question, so it cannot complete. Answer it with agent_answer first; wait until agent_answer returns, then after: ["${name}"] waits for the answering task.` :
          `${name}'s latest task ended ${status}, so it cannot complete. Omit after, or name ${name} only once it has a new task.` });
    }
    return run_id;
  });

  const tools = [
    make("agent_spawn", "Create an Agent and submit its first task: the default for any new work or review. Execution may queue. Model, profile, context and turn limit stay fixed; no nested delegation. If acceptance is unclear, check agent_list before repeating. Queued work is accepted; wait, do not respawn.", spawnSchema,
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
              resolution: AGENT_EXISTS_RESOLUTION });
            const after = afterRuns(input.agent, input.after);
            let return_to: ReturnTo | undefined;
            if (input.return_to !== undefined) {
              let permission: unknown;
              try { permission = options.parentPermission?.(); } catch { /* Missing service fails closed below. */ }
              // The authority decides under the principal its own agent_answer gate binds.
              requireParentAnswerPermission(permission, ctx);
              const target = find(input.return_to.agent, "return_to");
              return_to = { agent_id: target.agent_id, question_id: input.return_to.question_id, answer: input.return_to.answer };
            }
            const profileId = internalProfile(input.profile);
            const profile = profiles.get(profileId)!;
            const route = resolveRoute({ preset: options.getPreset(), difficulty: input.reasoning_difficulty,
              parentThinking, models: ctx.modelRegistry.getAll(), supportedThinking: getSupportedThinkingLevels });
            let context_snapshot: string | undefined;
            if (messages) {
              try { context_snapshot = textSnapshot(messages); }
              catch { throw new HarnessError("CONTEXT_SNAPSHOT_TOO_LARGE"); }
            }
            return { prompt: input.prompt, description: labelOf(input.label, input.prompt), name: input.agent,
              ...(input.max_turns === undefined ? {} : { max_turns: input.max_turns }),
              ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
              ...(after ? { after } : {}),
              ...(return_to === undefined ? {} : { return_to }),
              settings: { ...route, profile: profileId, cwd, tools: [...profile.tools], definition_digest: profile.definition_digest,
                ...(context_snapshot === undefined ? {} : { context_snapshot }) } };
          }), { signal });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_spawn" }, wait_ms }, ctx, signal);
      }),
    make("agent_run", "Continue an idle Agent's own earlier work; each turn re-reads its whole conversation. New work, even on a related topic, or different settings: agent_spawn. Running task: agent_send or agent_wait; pending question: agent_answer.",
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
            return { resume: target.agent_id, prompt: input.prompt, description: labelOf(input.label, input.prompt),
              ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }), ...(after ? { after } : {}) };
          }), { settle: { agent_id: target.agent_id, signal } });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_run" }, wait_ms }, ctx, signal);
      }),
    make("agent_send", "Add instructions to the task selected now, not an answer or new task. delivery: joined=added to prompt, steered=sent while running, not_delivered=nothing sent. Delivery does not prove action.",
      sendSchema, async ({ agent, message, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const { delivery, view } = await controller.send(`tool:agent_send:${digest(id)}`, target.agent_id, message, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_send", delivery }, wait_ms }, ctx, signal);
      }),
    make("agent_answer", "Answer the exact pending question_id and submit a continuation. First wait for status=\"needs_input\" and a current question_id from agent_wait or agent_read; historical text alone cannot be answered. Keeps fixed settings and the asking task's label/dispatch. workers_disabled: ask the user to enable delegation before answering.",
      answerSchema, async ({ agent, question_id, answer, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const view = await controller.answer(`tool:agent_answer:${digest(id)}`, target.agent_id, question_id, answer, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_answer" }, wait_ms }, ctx, signal);
      }),
    make("agent_wait", `Wait for selected tasks; questions, issues or alerts return early. Prefer long waits to polling. Questions stay pending; name other Agents to defer one. Nothing pending returns now; timeout/abort never stops work. ${offGuidance}`,
      Type.Object({ agents: optional(agentNames(16, `Bind each named Agent's active (running/queued) task, else its pending question, else its latest finished task, once at this call. Alerts span those Agents. Omit to wait on unfinished tasks, answerable questions and all Agents' alerts. Queued wait="capacity" means waiting for a provider slot; wait="dependencies" waits for fixed tasks.`)),
        mode: optional(stringEnum(["all", "any"] as const, { default: "all",
          description: "all (default): every selected task ends; any: one ends. Other events may return earlier." })),
        wait_ms: optional(waitMs("Wait duration; default 300000 ms. 0 checks once.")) }, { additionalProperties: false }),
      ({ agents, mode = "all", wait_ms = 300000 }, ctx, _id, signal) => {
        const agent_ids = agents ? [...new Set(agents)].map((name) => find(name, "agents").agent_id) : undefined;
        return observe({ kind: "wait", ...(agent_ids ? { agent_ids } : {}), mode, wait_ms }, ctx, signal);
      }),
    make("agent_read", `Read a task's result/question and this Agent's alerts, including after reuse or kill. Prioritizes the full question; keep next_cursor to continue the original task. ${offGuidance}`,
      Type.Object({ agent: agentName(`Agent to read. Without task or cursor, selects its active task, else its pending question, else its latest finished task.`),
        task: optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
          description: "Returned task number; starts its first page. Mutually exclusive with cursor; read-only selector." })),
        cursor: optional(text(1024, "Copy next_cursor with its Agent to continue that original task. Do not also supply task.")),
        max_chars: optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Page size, default/max 16384 characters; reply limits may shorten it." })) }, { additionalProperties: false }),
      ({ agent, task, cursor, max_chars = 16384 }, ctx, _id, signal) =>
        observe({ kind: "read", agent_id: find(agent).agent_id, task, cursor, max_chars }, ctx, signal)),
    make("agent_interrupt", "Request a stop, not settlement; confirm with wait/read. An already ending task keeps its outcome. Keeps the conversation for follow-ups; consumes no alerts.",
      agentOnly, ({ agent }, ctx) => {
        const snapshot = controller.cancel(find(agent).run_id).snapshot;
        return independent(ctx, () => taskReply(snapshot, nameOf));
      }),
    make("agent_kill", "Permanently end an Agent, requesting stop of its task. exiting or cleanup_uncertain does not confirm release. Name stays taken, results stay readable; consumes no alerts.",
      agentOnly, async ({ agent }, ctx) => {
        const target = find(agent);
        const { state } = await controller.kill(target.agent_id);
        return independent(ctx, () => ({ agent, status: state === "released" ? "killed" : state,
          label: taskMetadata(controller.view(target.run_id)).label,
          ...(state === "exiting" ? { resolution: "Still stopping; use agent_wait or agent_read." } :
            state === "cleanup_uncertain" ? { resolution: "Cleanup unconfirmed; tell the user, do not retry." } : {}) }));
      }),
    make("agent_list", "Read-only roster with current/latest task labels. Get pending questions through wait/read. Consumes no alerts or completion notices.",
      Type.Object({}, { additionalProperties: false }), (_args, ctx) => independent(ctx, () => {
        const views = controller.list(), live = views.filter((view) => view.resident);
        const killed = views.filter((view) => !view.resident).map((view) => view.name);
        const addressed = (view: RunView) => controller.view(controller.findAgent(view.name)?.run_id ?? view.run_id);
        return { agents: live.map((view) => agentRow(addressed(view), nameOf)),
          ...(killed.length ? { killed: killed.slice(-KILLED_SHOWN) } : {}),
          ...(killed.length > KILLED_SHOWN ? { killed_omitted: killed.length - KILLED_SHOWN } : {}) };
      })),
  ];
  // Last assembly step, before any tool is exposed. This lifetime opt-in also
  // protects against incompatible work admitted through other core callers.
  controller.bindModelCommunication();
  return tools;
}
