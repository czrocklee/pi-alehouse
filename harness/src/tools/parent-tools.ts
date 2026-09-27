import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { resultCursorRun, type OwnerController } from "../core/owner-controller.js";
import { terminal, validDifficulty, type RunView, type SubmitRequest } from "../core/contracts.js";
import { HarnessError } from "../core/ports.js";
import { digest, textSnapshot } from "../runtime/context-snapshot.js";
import { invalidDifficultyResolution, resolveRoute, type PresetSelection } from "../routing.js";
import { agentRow, errorReply, finishedReply, resultReply, taskReply, utf16Prefix, waitEnvelopeBytes, waitReply,
  WAIT_SERIALIZED_REPLY_LIMIT, type ErrorNames } from "./replies.js";
import { agentProfileNames, blockedDelegationToolNames } from "./tool-names.js";

// The model's whole vocabulary: an Agent (a named worker with a conversation)
// does one task at a time. Agents are addressed by name; no ID is model-facing.

const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S",
  ...(description ? { description } : {}) });
const optional = Type.Optional;
export const AGENT_NAME_PATTERN = "^[a-z][a-z0-9-]{0,23}$";
const agentName = (description?: string) => Type.String({ pattern: AGENT_NAME_PATTERN, ...(description ? { description } : {}) });
const agentNames = (maxItems: number, description: string) =>
  Type.Array(agentName(), { minItems: 1, maxItems, description });
const waitMs = (description: string) => Type.Integer({ minimum: 0, maximum: 300000, description });

const labelField = (source: string) => optional(text(120, `Short label for agent_list, not instructions. Default: the ${source}'s first line.`));
const afterField = (instructions: string) => optional(agentNames(4, `Other Agents whose current or latest task must complete first. Their results (16384 characters shared) come before the ${instructions} as reference, not instructions. If one ends any other way (question, failure, interrupt), this task fails without starting.`));
const waitField = optional(waitMs("Wait up to this long for the task to finish or ask. Default 0: return at once. Timing out never interrupts the task."));
const spawnSchema = Type.Object({
  agent: agentName("The new Agent's name: a short nickname, one theme per session (orca, otter), not a task name. Never reused."),
  prompt: text(131072, "Complete instructions. The Agent knows only this, its earlier tasks and any after results."),
  label: labelField("prompt"),
  profile: StringEnum(agentProfileNames, { description: "reader: investigates and reviews, cannot edit files; editor: may edit files. Git mutations stay with you. Bash stays permission-gated; neither profile is an OS sandbox." }),
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
  agent: agentName("An existing Agent; the task it is running (or asking about) when you call receives the message."),
  message: text(16384, "Your message: a correction or extra instruction for the running task, or an answer to its question. Never a new task; use agent_run for that."),
  wait_ms: optional(waitMs("Wait up to this long for the task that received the message to finish or ask. Default 0.")),
}, { additionalProperties: false });
const agentOnly = Type.Object({ agent: agentName("An existing Agent by name.") }, { additionalProperties: false });
/** A label the model omitted: the first nonblank line of its instructions. */
const labelOf = (label: string | undefined, instructions: string): string =>
  label ?? utf16Prefix(instructions.split("\n").map((line) => line.trim()).find(Boolean) ?? "task", 120);

const FINISHED_SHOWN = 8;
const UNSHOWN_LIMIT = 256;
const KILLED_SHOWN = 32;
/** Agent names a reply already reports, so finished does not repeat them. */
const reportedNames = (value: unknown, out = new Set<string>(), depth = 0): Set<string> => {
  if (!value || typeof value !== "object" || depth > 3) return out;
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string") out.add(item); else reportedNames(item, out, depth + 1);
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.agent === "string") out.add(record.agent);
  for (const key of ["agents", "killed"]) reportedNames(record[key], out, depth + 1);
  return out;
};

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
  /** Best-effort host UI seam, invoked after a Run ID exists and before an
   * optional accepted wait. Failure cannot erase an accepted identity. */
  onRunAccepted?: (view: RunView) => void;
}

/** Explicit opt-in for an isolated host. No discovery, public service, registry,
 * lifecycle takeover, auth lookup or production admission is installed here. */
export function createOwnerTools(options: OwnerToolsOptions): ToolDefinition<TSchema, undefined, unknown>[] {
  const { controller, context: boundContext, getSupportedThinkingLevels } = options;
  const identity = controller.identity, manager = boundContext.sessionManager, cwd = boundContext.cwd;
  const registry = boundContext.modelRegistry;
  if (manager.getSessionId() !== identity.owner_id) throw new HarnessError("OWNER_CONTEXT_MISMATCH");
  const profiles = new Map(agentProfileNames.map((name) => {
    const profile = structuredClone(options.profiles[name]);
    if (!profile || typeof profile.definition !== "string" || !profile.definition || !Array.isArray(profile.tools) ||
        profile.tools.some((tool) => typeof tool !== "string" || blockedDelegationToolNames.includes(tool))) throw new HarnessError("INVALID_PROFILE_DEFINITION", { key: name });
    // Array.isArray widens a readonly array to any[]; preserve the element
    // contract after the runtime validation above, before taking our copy.
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
  const readPage = (run_id: string, limit: number) => controller.getResult(run_id, { limit });
  const respond = async (view: RunView, wait_ms: number | undefined, signal?: AbortSignal) => {
    if (!wait_ms) return taskReply(view, nameOf);
    // The budget starts only after controller admission has returned. This wait
    // is outside submitTail; Esc interrupts it without cancelling the worker.
    const waited = await controller.wait([view.run_id], { mode: "all", timeout_ms: wait_ms, signal, include_results: false });
    // One task: flatten to its entry, which is smaller than the measured reply.
    const { agents: [entry], reason: _reason, pending: _pending, ...rest } = waitReply(waited, readPage, nameOf) as
      { agents: object[]; reason: string; pending?: string[] };
    return { ...entry, ...rest };
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
  // Replies name Agents whose tasks finished since they were last shown, once
  // each. Part of these tools' own results, never a context injection. A
  // settlement is consumed only by a reply that shows that Agent or lists it.
  let changesCursor = controller.settledSince(0).cursor, changesMissed = 0;
  const unshown: string[] = [];
  const withChanges = (value: object): object => {
    const since = controller.settledSince(changesCursor);
    changesCursor = since.cursor; changesMissed += since.missed;
    unshown.push(...since.run_ids);
    if (unshown.length > UNSHOWN_LIMIT) changesMissed += unshown.splice(0, unshown.length - UNSHOWN_LIMIT).length;
    const seen = reportedNames(value);
    for (let index = unshown.length - 1; index >= 0; index--) if (seen.has(nameOf(unshown[index]!))) unshown.splice(index, 1);
    if (!unshown.length && !changesMissed) return value;
    const shown = unshown.slice(0, FINISHED_SHOWN), omitted = unshown.length - shown.length + changesMissed;
    const next = { ...value, finished: shown.map((id) => finishedReply(controller.view(id))), ...(omitted ? { finished_omitted: omitted } : {}) };
    // Keep them for a later, smaller reply rather than exceed the envelope.
    if (waitEnvelopeBytes(next) > WAIT_SERIALIZED_REPLY_LIMIT) return value;
    unshown.splice(0, shown.length); changesMissed = 0;
    return next;
  };
  const make = <S extends TObject>(name: string, description: string, schema: S,
    action: (args: Static<S>, ctx: ExtensionContext, id: string, signal?: AbortSignal) => object | Promise<object>): ToolDefinition<TSchema, undefined, unknown> => {
    const checked = (raw: unknown): Static<S> => {
      if (raw && typeof raw === "object" && name === "agent_spawn") {
        // Keep actionable validation errors, including after mutable tool_call hooks.
        const { profile, difficulty } = raw as Record<string, unknown>;
        if (profile !== undefined && !(agentProfileNames as readonly unknown[]).includes(profile)) {
          throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...agentProfileNames] });
        }
        if (difficulty !== undefined && !validDifficulty(difficulty)) {
          throw new HarnessError("INVALID_DIFFICULTY", { key: "difficulty", resolution: invalidDifficultyResolution });
        }
      }
      if (!Check(schema, raw)) throw new HarnessError("INVALID_PARAMETERS", { allowed: Object.keys(schema.properties),
        resolution: "The arguments do not match this tool's schema; check the required fields, their types and bounds." });
      return structuredClone(raw);
    };
    return { name, label: name, description, parameters: schema,
      // This is strict validation, not a legacy argument-conversion shim. Pi can
      // mutate arguments in tool_call AFTER its validation, so execute rechecks.
      prepareArguments(raw) { try { return checked(raw); } catch (error) { throw toolError(error); } },
      async execute(id, raw, signal, _update, ctx) {
        try {
          assertCurrent(ctx);
          const args = checked(raw);
          if (typeof id !== "string" || !id) throw new HarnessError("INVALID_REQUEST_ID");
          if (name !== "agent_wait" && signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
          const value = await action(args, ctx, id, signal);
          assertCurrent(ctx); // No result from an old handle is routed to a replacement parent.
          return { content: [{ type: "text", text: JSON.stringify(withChanges(value)) }], details: undefined };
        } catch (error) { throw toolError(error); }
      } };
  };
  const afterRuns = (self: string, names: string[] | undefined) => names?.map((name) => {
    if (name === self) throw new HarnessError("INVALID_PARAMETER", { key: "after", resolution: "An Agent cannot wait for itself." });
    return find(name, "after").run_id;
  });
  return [
    make("agent_spawn", "Create a named Agent and give it its first task. Agents run in the background, share your checkout without isolation, and have local tools only: no web, no delegation. An Agent that needs input ends its task with a question (needs_input); answer it with agent_send. Give an existing Agent its next task with agent_run; spawn for unrelated work, an independent review or a different difficulty. Capacity is limited: kill idle Agents to make room. If unsure a call was accepted, check agent_list before repeating it.", spawnSchema, (args, ctx, id, signal) => {
      // Capture every mutable parent input before submitPrepared can await an
      // earlier admission. Retries hit Controller identity before preparation,
      // so they retain the first accepted route even if these values changed.
      const parentThinking = ctx.thinkingLevel;
      // Inherit model-visible context, including SDK retry omissions/replacements,
      // rather than reintroducing raw failed attempts from the append-only log.
      const messages = args.inherit_context ? structuredClone(ctx.sessionManager.buildSessionProjection().messages) : undefined;
      const { wait_ms, ...submission } = args;
      return controller.submitPrepared(`tool:agent_spawn:${digest(id)}`, submission, (input): SubmitRequest => {
        assertCurrent(ctx);
        if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
        if (controller.findAgent(input.agent)) {
          throw new HarnessError("AGENT_EXISTS", { agent: input.agent, key: "agent",
            resolution: "Give an existing Agent its next task with agent_run. A killed Agent's name stays taken; choose another." });
        }
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
      }).then((view) => { accepted(view); return respond(view, wait_ms, signal); });
    }),
    make("agent_run", "Give an existing, idle Agent its next task. It keeps its conversation, profile, difficulty and budgets. A task that is ending is waited out (up to 30 s). A running Agent is busy: add to its task with agent_send, or agent_wait first. An Agent with an unanswered question must be answered with agent_send.",
      runSchema, (args, ctx, id, signal) => {
        const target = find(args.agent);
        const { wait_ms, ...submission } = args;
        return controller.submitPrepared(`tool:agent_run:${digest(id)}`, submission, (input): SubmitRequest => {
          assertCurrent(ctx);
          if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
          const latest = controller.view(controller.findAgent(input.agent)!.run_id);
          if (!terminal(latest.status)) throw new HarnessError("AGENT_BUSY", { agent: input.agent,
            resolution: "Add to its running task with agent_send, or agent_wait for it first." });
          if (latest.status === "needs_input" && latest.resumable) throw new HarnessError("PENDING_QUESTION", { agent: input.agent,
            resolution: "Answer its question with agent_send." });
          const after = afterRuns(input.agent, input.after); // Bound once, at first acceptance.
          return { resume: target.agent_id, prompt: input.prompt, description: labelOf(input.label, input.prompt), ...(after ? { after } : {}) };
        }, { settle: { agent_id: target.agent_id, signal } }).then((view) => { accepted(view); return respond(view, wait_ms, signal); });
      }),
    make("agent_send", "Send a message to the Agent's current task, as it is when you call. delivery: steered, the running task receives it now; joined, the task has not started and gets it with its prompt; answered, the task had ended with a question and a new task on the same conversation starts with your answer; not_delivered, the task had ended, so nothing was sent and its outcome is returned instead. Never starts other work: use agent_run for that.",
      sendSchema, async ({ agent, message, wait_ms }, ctx, id, signal) => {
        const target = find(agent);
        const { delivery, view } = await controller.send(`tool:agent_send:${digest(id)}`, target.agent_id, message, { signal,
          prepare: () => { assertCurrent(ctx); if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED"); } });
        if (delivery === "answered") accepted(view);
        if (delivery !== "not_delivered") return { delivery, ...await respond(view, wait_ms, signal) };
        // Nothing was sent: return the ended task's outcome and result, as a wait would.
        return { delivery, ...terminal(view.status) ? await respond(view, 1, signal) : taskReply(view, nameOf) };
      }),
    make("agent_wait", "Wait for tasks and return their results and questions. all (default): when every task has ended, or early when one asks, fails, is interrupted or hits its turn limit. any: when the first one ends, including one that already has. Omit agents to wait for every task not yet ended, queued or running. Returns as soon as the condition holds, so one long wait beats many short ones. Timing out never interrupts tasks. Results never arrive on their own; wait for them.",
      Type.Object({ agents: optional(agentNames(16, "Default: every Agent with a task not yet ended, queued or running.")),
        mode: optional(StringEnum(["all", "any"] as const, { default: "all",
          description: "all: return when every named task has ended, early on a question, failure, interrupt or turn limit. any: return as soon as one named task has ended, including one that already has." })),
        wait_ms: optional(waitMs("Default and maximum 300000. 0 checks without waiting.")) }, { additionalProperties: false }),
      async ({ agents, mode = "all", wait_ms = 300000 }, _ctx, _id, signal) => {
        const ids = agents ? [...new Set(agents)].map((name) => find(name, "agents").run_id) :
          controller.list().filter((view) => !terminal(view.status)).map((view) => view.run_id);
        if (!ids.length) return { reason: "nothing_running", agents: [] };
        const waited = await controller.wait(ids, { mode, timeout_ms: wait_ms, signal, include_results: false });
        return waitReply(waited, readPage, nameOf);
      }),
    make("agent_read", "Read an Agent's latest task: its full question and one page of output. Use it when a reply has question_truncated, result_omitted or next_cursor; pass next_cursor to continue. omitted_chars were too long to keep and cannot be read.",
      Type.Object({ agent: agentName("An existing Agent; its latest task is read."),
        cursor: optional(text(1024, "A next_cursor from an earlier reply or agent_read of this Agent's task; it pages only that task.")),
        max_chars: optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Page size in UTF-16 units, default 16384." })) }, { additionalProperties: false }),
      ({ agent, cursor, max_chars = 16384 }) => {
        const found = find(agent);
        const run_id = cursor ? resultCursorRun(cursor) : found.run_id;
        if (cursor && controller.view(run_id).agent_id !== found.agent_id) {
          throw new HarnessError("INVALID_CURSOR", { agent,
            resolution: "A cursor belongs to one Agent's task and cannot be used for another. Read that Agent with agent_read, without a cursor." });
        }
        return resultReply(controller.getResult(run_id, { cursor, limit: max_chars }), nameOf);
      }),
    make("agent_interrupt", "Stop an Agent's current task. The Agent keeps its conversation, so agent_run can redirect it. status becomes interrupted once stopped.",
      agentOnly, ({ agent }) => taskReply(controller.cancel(find(agent).run_id).snapshot, nameOf)),
    make("agent_kill", "End an Agent permanently, interrupting any task. Its name is never reused; its last result stays readable. status: killed; exiting (still stopping, ends once stopped); or cleanup_uncertain (could not be confirmed, no retry).",
      agentOnly, async ({ agent }) => {
        const { state } = await controller.kill(find(agent).agent_id);
        return { agent, status: state === "released" ? "killed" : state };
      }),
    make("agent_list", "List Agents with their current or latest task and history (earlier labels, context use, cost, edited files), to choose between agent_run and agent_spawn. has_question marks a task still awaiting an answer; answer it with agent_send. A question on a stopped task is readable with agent_read, but its next task is agent_run — agent_send cannot deliver to it. unavailable, when present, overrides an otherwise healthy status: the task facts stand, but the Agent cannot take another task; report it to the user. Nothing is pushed to you: check it after compaction or when unsure.",
      Type.Object({}, { additionalProperties: false }), () => {
        const views = controller.list(), live = views.filter((view) => view.resident);
        const killed = views.filter((view) => !view.resident).map((view) => view.name);
        // Each row shows the task the Agent is addressed by, e.g. a question
        // that is still unanswered after an interrupted answer.
        const addressed = (view: RunView) => controller.view(controller.findAgent(view.name)?.run_id ?? view.run_id);
        return { agents: live.map((view) => agentRow(addressed(view), controller.agentSummary(view.agent_id), nameOf)),
          ...(killed.length ? { killed: killed.slice(-KILLED_SHOWN) } : {}),
          ...(killed.length > KILLED_SHOWN ? { killed_omitted: killed.length - KILLED_SHOWN } : {}) };
      }),
  ];
}
