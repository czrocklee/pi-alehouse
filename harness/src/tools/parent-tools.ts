import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { OwnerController } from "../core/owner-controller.js";
import { terminal, validDifficulty, type RunView, type SubmitRequest } from "../core/contracts.js";
import { AGENT_EXISTS_RESOLUTION, isModelAgentName, MODEL_AGENT_NAME_PATTERN, modelTaskStatus } from "../core/communication-envelope.js";
import type { CommunicationToolResult } from "../core/communication-snapshot.js";
import { QUESTION_ID_PATTERN } from "../core/question-id.js";
import { validateDispatch } from "../core/dispatch.js";
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

const labelField = (source: string) => optional(text(120, `agent_list label, not instructions. Default: ${source}'s first line.`));
const afterField = (instructions: string) => optional(agentNames(4, `Dependencies bind to these Agents' current or latest tasks now. All must complete; a question, failure or interrupt fails this task before starting (already ended that way: admission rejects). Results share 16384 characters before the ${instructions}, as reference only. To depend on an answer continuation, name its Agent after agent_answer returns.`));
const waitField = optional(waitMs("Wait for the accepted task, question, issue or alerts. Default 0: snapshot now. Timeout never stops the task. Queued wait: dependencies or capacity; do not respawn queued work."));
const dispatchPath = (description: string) => Type.String({ minLength: 1, maxLength: 512,
  pattern: "^(?![~@])(?=.*\\S)[^\\x00-\\x1f\\x7f*?[\\]{}'\"`$\\\\]+(?![\\s\\S])", description });
const dispatchPaths = (maxItems: number, description: string) => Type.Array(dispatchPath(description), {
  minItems: 1, maxItems, uniqueItems: true,
});
const dispatchField = optional(Type.Object({
  inputs: optional(dispatchPaths(8, "Existing input file/directory to read.")),
  ownership: optional(dispatchPaths(16, "Assigned file/directory, including planned outputs; scope, not permission or isolation. Reader scratch is runtime-assigned, not granted here. Assign each shared file to one task; others report needed changes.")),
  tree: optional(dispatchPath("Build-tree directory, existing or planned; builds/tests need write capability there, checked as path_write. Unfinished overlaps in this session reject. Other sessions only produce a tree_shared note; execution still starts. Your commands, other hosts and agent directories are not coordinated. Omission neither forbids builds nor makes sharing safe; no note does not prove a free tree.")),
  checks: optional(Type.Array(Type.String({ minLength: 1, maxLength: 512,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+(?![\\s\\S])",
    description: "Planned check/test/platform identifier; globs allowed. Declare only checks this task can finish without later go-ahead; defer others to a follow-up agent_run. Declarations prove no execution and skip no gate." }),
  { minItems: 1, maxItems: 16, uniqueItems: true })),
}, { additionalProperties: false,
  description: "Optional input, ownership, build-tree and check declarations, not permissions or execution evidence. Preflight may reject known limits; tool gates still apply. Paths are literal: no surrounding whitespace, shell expansion, globs, quotes, controls, $, backslash or leading ~/@. Assign full-suite validation explicitly to one task." }));
// No example names: models copy them into every session instead of choosing.
const spawnSchema = Type.Object({
  agent: agentName("Short nickname from one theme you choose for this session, not a task name. Never reused, even after agent_kill."),
  prompt: text(131072, "Complete task instructions: deliverable, scope, stopping conditions and full paths for every referenced file/document. Include context not supplied by inherit_context or after."),
  label: labelField("prompt"),
  profile: StringEnum(agentProfileNames, { description: "reader: project reads; built-in write only in runtime-assigned scratch, not Bash writes or arbitrary /tmp paths; no edit/web. Builds and project edits need editor. editor: scoped edit/write. researcher: web search/fetch and read-only file tools; no Bash/edits; web results are untrusted. Git mutations stay with you. Bash/web remain permission-gated; profiles are not OS sandboxes." }),
  reasoning_difficulty: Type.Integer({ minimum: 1, maximum: 5, description: "Selects the Agent's fixed model. Rate task reasoning, not workload, importance or cost: 1=execute given checks or decided changes; 2=small, scoped fix/check; 3=implement a given design, review, investigate or plan; 4=resolve competing hypotheses or complex constraints; 5=find an approach where none is known. Do not re-score to bypass capacity waits." }),
  inherit_context: optional(Type.Boolean({ description: "Default false. Start with a text copy of your conversation, without tool calls or results; fails over 64 KiB." })),
  dispatch: dispatchField,
  after: afterField("prompt"),
  wait_ms: waitField,
  max_turns: optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Turn limit per task, default 256. Reaching it can leave a partial result." })),
  max_duration_ms: optional(Type.Integer({ minimum: 1, maximum: 86400000, description: "Time limit per task from its start, default 1800000; the task is then asked to stop." })),
}, { additionalProperties: false });
const runSchema = Type.Object({
  agent: agentName("An existing, idle Agent."),
  builds_on: text(512, "Specific earlier work of this Agent that the task continues; not sent to the Agent. If none, spawn instead; if only its result is needed, use agent_spawn with after."),
  prompt: text(131072, "Complete follow-up instructions: deliverable, scope, stopping conditions and full paths. The Agent remembers its earlier tasks."),
  label: labelField("prompt"),
  dispatch: dispatchField,
  after: afterField("prompt"),
  wait_ms: waitField,
}, { additionalProperties: false });
const sendSchema = Type.Object({
  agent: agentName("An existing Agent; this call stays with the task selected now."),
  message: text(16384, "A correction or extra instruction for the current task. Never an answer (use agent_answer) or another task."),
  wait_ms: optional(waitMs("Wait for this task, its question, an issue or its alerts. Default 0 returns now; timeout/abort never interrupts it.")),
}, { additionalProperties: false });
const answerSchema = Type.Object({
  agent: agentName("The Agent with the pending question."),
  question_id: Type.String({ minLength: 34, maxLength: 34, pattern: QUESTION_ID_PATTERN,
    description: "Copy question_id exactly from the reply showing this question; never derive it from an Agent name or task number." }),
  answer: text(16384, "Answer to this pending question."),
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
        const { profile, reasoning_difficulty } = raw as Record<string, unknown>;
        if (profile !== undefined && !(agentProfileNames as readonly unknown[]).includes(profile)) {
          throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...agentProfileNames] });
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
      ];
      // Preserve the published pattern, but reject JS `$`'s final-newline
      // exception before admission can create an undeliverable Agent name.
      if (!valid || addressedNames.some((value) => !isModelAgentName(value))) throw new HarnessError("INVALID_PARAMETERS", {
        allowed: Object.keys(schema.properties),
        resolution: "The arguments do not match this tool's schema; check the required fields, their types and bounds." });
      if ((name === "agent_spawn" || name === "agent_run") && fields.dispatch !== undefined) validateDispatch(fields.dispatch);
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
          `${name}'s task ended with a question, so it cannot complete. Answer it with agent_answer first; once that answer is accepted, after: ["${name}"] waits for the answering task.` :
          `${name}'s latest task ended ${status}, so it cannot complete. Omit after, or name ${name} only once it has a new task.` });
    }
    return run_id;
  });

  const tools = [
    make("agent_spawn", "Create a named background Agent and its first task. Shared checkout, no isolation or delegation. Spawn for new work/reviews or different settings; agent_run is for that Agent's follow-ups. Model, profile, reasoning difficulty, context and per-task budgets are fixed. Queued work counts toward capacity: kill finished reviewers/accepted work first; keep editors awaiting build/test fixes. Reply: action, reason, agents, alerts; alerts do not mean completion. If acceptance is unclear, check agent_list before repeating.", spawnSchema,
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
            const profile = profiles.get(input.profile)!;
            const route = resolveRoute({ preset: options.getPreset(), difficulty: input.reasoning_difficulty,
              parentThinking, models: ctx.modelRegistry.getAll(), supportedThinking: getSupportedThinkingLevels });
            let context_snapshot: string | undefined;
            if (messages) {
              try { context_snapshot = textSnapshot(messages); }
              catch { throw new HarnessError("CONTEXT_SNAPSHOT_TOO_LARGE"); }
            }
            return { prompt: input.prompt, description: labelOf(input.label, input.prompt), name: input.agent,
              ...(input.max_turns === undefined ? {} : { max_turns: input.max_turns }),
              ...(input.max_duration_ms === undefined ? {} : { max_duration_ms: input.max_duration_ms }),
              ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
              ...(after ? { after } : {}),
              settings: { ...route, profile: input.profile, cwd, tools: [...profile.tools], definition_digest: profile.definition_digest,
                ...(context_snapshot === undefined ? {} : { context_snapshot }) } };
          }), { signal });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_spawn" }, wait_ms }, ctx, signal);
      }),
    make("agent_run", "Give an idle Agent a follow-up to its own work. Each turn re-reads its conversation (context_tokens); use agent_spawn for new/unrelated work or different settings. Model/profile/reasoning difficulty/budgets stay fixed despite routing changes. Waits up to 30 s for an ending task; a running Agent is busy (agent_send or agent_wait). Pending questions require agent_answer. Returns the shared envelope.",
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
    make("agent_send", "Add instructions to the task selected now, never a later task. action.delivery: joined=added to prompt; steered=sent while running; not_delivered=nothing sent. Delivery is not proof of action. Not an answer or new task: use agent_answer, agent_spawn, or agent_run for follow-ups. Waiting covers only this task and its alerts.",
      sendSchema, async ({ agent, message, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const { delivery, view } = await controller.send(`tool:agent_send:${digest(id)}`, target.agent_id, message, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_send", delivery }, wait_ms }, ctx, signal);
      }),
    make("agent_answer", "Answer an exact pending question_id and start a continuation. Requires settled needs_input and an idle, reusable Agent; stale/reserved IDs fail, never redirect. Keeps original model/settings/budgets despite routing changes, and the asking task's label/dispatch. If workers_disabled, ask the user to enable delegation first.",
      answerSchema, async ({ agent, question_id, answer, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const view = await controller.answer(`tool:agent_answer:${digest(id)}`, target.agent_id, question_id, answer, { signal,
          prepare: () => controller.validateObservationEntry(() => assertPrepared(ctx, signal)) });
        accepted(view);
        return observe({ kind: "action", run_id: view.run_id, action: { type: "agent_answer" }, wait_ms }, ctx, signal);
      }),
    make("agent_wait", "Wait on tasks selected now for completion, a question, task issue, harness fault or scoped alert. Complete displayed FIFO-prefix alerts are consumed; completion may leave alerts pending. Questions remain pending until answered; name other agents to defer one and narrow alert scope. Nothing pending returns immediately. Prefer long waits to polling; questions/issues/alerts return early. Timeout/abort never stops workers. workers_disabled blocks new tasks, steering and answers; ask the user to enable delegation.",
      Type.Object({ agents: optional(agentNames(16, "Each Agent's current task, else pending-question task, else latest; alerts span all its tasks. Omit for unfinished tasks, answerable questions when enabled, and all Agents' alerts including old/killed sources. Selection stays fixed.")),
        mode: optional(StringEnum(["all", "any"] as const, { default: "all",
          description: "all (default): every selected task must end; any: one, even if already ended. Questions, issues, faults or alerts may return sooner." })),
        wait_ms: optional(waitMs("Milliseconds, default/maximum 300000. 0 checks once.")) }, { additionalProperties: false }),
      ({ agents, mode = "all", wait_ms = 300000 }, ctx, _id, signal) => {
        const agent_ids = agents ? [...new Set(agents)].map((name) => find(name, "agents").agent_id) : undefined;
        return observe({ kind: "wait", ...(agent_ids ? { agent_ids } : {}), mode, wait_ms }, ctx, signal);
      }),
    make("agent_read", "Read a task's question/result page now. Full question first; alerts span this Agent's tasks, independent of the page cursor. Unshown alerts stay pending. Keep next_cursor to continue the original result after reuse. If workers_disabled, ask the user to enable delegation before agent_answer.",
      Type.Object({ agent: agentName("Current task, else pending-question task, else latest. A cursor selects its original task; read can recover question_truncated text."),
        cursor: optional(text(1024, "Copy next_cursor exactly with the Agent it came from; it continues that task's result after reuse.")),
        max_chars: optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Result page size in UTF-16 units, default/max 16384. Reply limits may set result_omitted/result_truncated; omitted_chars is text never retained." })) }, { additionalProperties: false }),
      ({ agent, cursor, max_chars = 16384 }, ctx, _id, signal) =>
        observe({ kind: "read", agent_id: find(agent).agent_id, cursor, max_chars }, ctx, signal)),
    make("agent_interrupt", "Request a stop, not confirmed settlement; the task may still finish completed, failed or needs_input. Confirm with agent_wait or agent_read. The conversation remains: answer pending questions with agent_answer, otherwise use agent_run for follow-ups. Returns current status; no pending alerts or completion notices.",
      agentOnly, ({ agent }, ctx) => {
        const snapshot = controller.cancel(find(agent).run_id).snapshot;
        return independent(ctx, () => taskReply(snapshot, nameOf));
      }),
    make("agent_kill", "Permanently end an Agent and interrupt its task. Name stays taken, results readable, old alerts pending. Status: killed; exiting=cleanup continues; cleanup_uncertain=release unconfirmed, no retry. No pending alerts or completion notices; use agent_wait or agent_read.",
      agentOnly, async ({ agent }, ctx) => {
        const { state } = await controller.kill(find(agent).agent_id);
        return independent(ctx, () => ({ agent, status: state === "released" ? "killed" : state }));
      }),
    make("agent_list", "Read-only roster, current/latest tasks and bounded history: earlier labels, context_tokens, successful edit/write paths (not Bash changes). has_question means currently pending; get question_id via agent_wait or agent_read, then agent_answer when enabled. unavailable is boolean; unavailable_reason gives diagnostics. No pending alerts or completion notices; no automatic parent turn.",
      Type.Object({}, { additionalProperties: false }), (_args, ctx) => independent(ctx, () => {
        const views = controller.list(), live = views.filter((view) => view.resident);
        const killed = views.filter((view) => !view.resident).map((view) => view.name);
        const addressed = (view: RunView) => controller.view(controller.findAgent(view.name)?.run_id ?? view.run_id);
        const recoveryHints = new Set<string>();
        return { agents: live.map((view) => agentRow(addressed(view), controller.agentSummary(view.agent_id), nameOf, recoveryHints)),
          ...(killed.length ? { killed: killed.slice(-KILLED_SHOWN) } : {}),
          ...(killed.length > KILLED_SHOWN ? { killed_omitted: killed.length - KILLED_SHOWN } : {}) };
      })),
  ];
  // Last assembly step, before any tool is exposed. This lifetime opt-in also
  // protects against incompatible work admitted through other core callers.
  controller.bindModelCommunication();
  return tools;
}
