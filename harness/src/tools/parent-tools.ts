import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TObject, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { OwnerController } from "../core/owner-controller.js";
import { terminal, validDifficulty, type RunView, type SubmitRequest } from "../core/contracts.js";
import { HarnessError } from "../core/ports.js";
import { digest, textSnapshot } from "../runtime/context-snapshot.js";
import { invalidDifficultyResolution, resolveRoute, type PresetSelection } from "../routing.js";
import { changeReply, compactRunReply, errorReply, listRunReply, resultReply, runReply, waitEnvelopeBytes, waitReply,
  WAIT_SERIALIZED_REPLY_LIMIT, type WaitProjectionHeader } from "./replies.js";
import { agentProfileNames, blockedDelegationToolNames } from "./tool-names.js";

const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, pattern: "\\S",
  ...(description ? { description } : {}) });
const optional = Type.Optional;
const description = text(4096, "Short current-task Run label for the Agent panel and list_agents, not execution instructions. Supply a fresh description on every Run, including resume.");
const fields = { prompt: text(131072, "Execution instructions for this Run."), max_turns: optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Turn budget; default 256. Reaching it can leave a partial result." })),
  max_duration_ms: optional(Type.Integer({ minimum: 1, maximum: 86400000, description: "Execution deadline from initialization, excluding queue time. Default 1800000. Requests a stop, not proof of exit." })),
  wait_ms: optional(Type.Integer({ minimum: 0, maximum: 300000, description: "Wait milliseconds after acceptance; omit/0 for a background receipt. Interrupted waiting does not cancel the Run. Use it when your next step needs this Run's result." })),
  after: optional(Type.Array(text(128), { minItems: 1, maxItems: 4, description: "Run IDs that must settle before this Run starts. It stays queued without a slot or deadline; if any of them ends other than completed, this Run fails with dependency_not_completed and never starts." })),
  handoff_from: optional(Type.Array(text(128), { minItems: 1, maxItems: 4, description: "Run IDs whose retained final output (16384 chars shared) is placed before prompt, labelled as reference, not instructions. Implies after. Use it to chain author → reviewer without reading and re-pasting the result yourself." })) };
const runId = { run_id: text(128) };
const CHANGES_SHOWN = 8;
const SETTLED_UNSHOWN_LIMIT = 256;
/** Run and Agent IDs a reply already reports, so changes does not repeat them. */
const reportedIds = (value: unknown, out = new Set<string>(), depth = 0): Set<string> => {
  if (!value || typeof value !== "object" || depth > 3) return out;
  if (Array.isArray(value)) { for (const item of value) reportedIds(item, out, depth + 1); return out; }
  const record = value as Record<string, unknown>;
  for (const key of ["run_id", "agent_id"]) if (typeof record[key] === "string") out.add(record[key]);
  for (const key of ["runs", "wait", "targets", "agents"]) reportedIds(record[key], out, depth + 1);
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
const createSchema = Type.Object({ ...fields, description,
  name: optional(text(256, "Short, playful, task-independent nickname: one theme per session, a distinct name per Agent, kept on reuse. Use orca, not orca-windows-foundations; no project, platform or task suffixes (put them in description).")),
  profile: StringEnum(agentProfileNames, { description: "reader: read/review, no edit/write or project writes; editor: authorized file edits. Git mutations stay with the parent. Bash remains permission-gated; profiles are not OS sandboxes." }),
  difficulty: Type.Integer({ minimum: 1, maximum: 5, description: "Rate this assignment's reasoning difficulty against the requirements in prompt: 1=clear method, mostly execution; 2=routine local analysis; 3=independent investigation and a plan; 4=competing hypotheses or complex constraints requiring indirect reasoning; 5=exceptional problem with no established approach. Do not adjust the score for workload, importance, cost, reassurance, or routing/configuration errors. Creation-time assessment, unchanged on resume; independent of permissions." }),
  inherit_context: optional(Type.Boolean({ description: "Default false. Copy at most 64 KiB of parent text/compaction context, not tools, routing settings or a full history fork." })) }, { additionalProperties: false });
const resumeSchema = Type.Object({ ...fields, agent_id: text(128), description: optional(description),
  answer_to_run_id: optional(text(128, "Finished Run whose question is being answered. Put the answer in prompt; agent_id must identify that Run's Agent.")) }, { additionalProperties: false });
const immutable = ["settings", "model", "provider", "thinking", "effort", "effort_source", "effort_overrides", "difficulty", "strength", "preset", "profile", "subagent_type", "inherit_context", "cwd", "tools", "name"];

const toolError = (error: unknown) => new Error(JSON.stringify(errorReply(error instanceof HarnessError ? error :
  new HarnessError("TOOL_ERROR", { error: String(error) }))), { cause: error });

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
  const accepted = (view: RunView): void => {
    try { options.onRunAccepted?.(view); } catch { /* UI failure cannot undo admission. */ }
  };
  const waitAfterAcceptance = async (view: RunView, wait_ms: number | undefined, signal?: AbortSignal) => {
    accepted(view);
    if (!wait_ms) return runReply(view, true);
    // The budget starts only after controller admission has returned. This wait
    // is outside submitTail; Esc interrupts it without cancelling the worker.
    const waited = await controller.wait([view.run_id], { mode: "all", timeout_ms: wait_ms, signal, include_results: false });
    const snapshot = waited.snapshots[0]!, latest = runReply(snapshot, true);
    const wrap = <T extends WaitProjectionHeader>(wait: T) => ({
      ...(wait.metadata_compacted ? compactRunReply(snapshot) : latest), wait });
    return wrap(waitReply(waited, (run_id, limit) => controller.getResult(run_id, { limit }), wrap));
  };
  const assertCurrent = (ctx: ExtensionContext) => {
    try {
      // Read BOTH contexts through SDK guarded getters. Equal session IDs alone
      // do not detect reload of the same session or a captured stale closure.
      if (boundContext.sessionManager !== manager || ctx.sessionManager !== manager ||
          manager.getSessionId() !== identity.owner_id || boundContext.cwd !== cwd || ctx.cwd !== cwd ||
          boundContext.modelRegistry !== registry || ctx.modelRegistry !== registry ||
          controller.identity.owner_id !== identity.owner_id || controller.identity.generation !== identity.generation) throw new Error();
    } catch { throw new HarnessError("STALE_OWNER_CONTEXT"); }
  };
  // Harness replies say which other Runs settled since they were last shown,
  // once each. Part of these tools' own results, never a context injection.
  // A settlement is consumed only by a reply that actually shows its Run or
  // Agent (a list page, a wait, a target) or lists it under changes.
  let changesCursor = controller.settledSince(0).cursor, changesMissed = 0;
  const unshown: string[] = [];
  const withChanges = (value: object): object => {
    const since = controller.settledSince(changesCursor);
    changesCursor = since.cursor; changesMissed += since.missed;
    unshown.push(...since.run_ids);
    if (unshown.length > SETTLED_UNSHOWN_LIMIT) changesMissed += unshown.splice(0, unshown.length - SETTLED_UNSHOWN_LIMIT).length;
    const seen = reportedIds(value);
    for (let index = unshown.length - 1; index >= 0; index--) {
      const id = unshown[index]!;
      if (seen.has(id) || seen.has(controller.view(id).agent_id)) unshown.splice(index, 1);
    }
    if (!unshown.length && !changesMissed) return value;
    const shown = unshown.slice(0, CHANGES_SHOWN), omitted = unshown.length - shown.length + changesMissed;
    const next = { ...value, changes: shown.map((id) => changeReply(controller.view(id))), ...(omitted ? { changes_omitted: omitted } : {}) };
    // Keep them for a later, smaller reply rather than exceed the envelope.
    if (waitEnvelopeBytes(next) > WAIT_SERIALIZED_REPLY_LIMIT) return value;
    unshown.splice(0, shown.length); changesMissed = 0;
    return next;
  };
  const make = <S extends TObject>(name: string, description: string, schema: S,
    action: (args: Static<S>, ctx: ExtensionContext, id: string, signal?: AbortSignal) => object | Promise<object>): ToolDefinition<TSchema, undefined, unknown> => {
    const checked = (raw: unknown): Static<S> => {
      if (raw && typeof raw === "object") {
        if ((name === "spawn_agent" || name === "resume_agent") && Object.hasOwn(raw, "role")) {
          throw new HarnessError("OBSOLETE_PARAMETER", { key: "role",
            resolution: "Put execution instructions in prompt and a short task label in description; name labels the Agent." });
        }
        if (name === "spawn_agent") {
          const obsolete = ["strength", "model", "thinking", "effort", "effort_source", "effort_overrides"].find((key) => Object.hasOwn(raw, key));
          if (obsolete) throw new HarnessError("OBSOLETE_PARAMETER", { key: obsolete,
            resolution: "Rate the task with difficulty (1-5); the harness handles resource routing." });
          // Keep actionable validation errors, including after mutable tool_call hooks.
          const { profile, difficulty } = raw as Record<string, unknown>;
          if (typeof profile === "string" && !(agentProfileNames as readonly string[]).includes(profile)) {
            throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...agentProfileNames] });
          }
          if (Object.hasOwn(raw, "difficulty") && !validDifficulty(difficulty)) {
            throw new HarnessError("INVALID_DIFFICULTY", { key: "difficulty",
              resolution: invalidDifficultyResolution });
          }
        }
        if (name === "resume_agent") {
          const key = Object.keys(raw).find((key) => immutable.includes(key));
          if (key) throw new HarnessError("IMMUTABLE_SETTING", { key, allowed: Object.keys(schema.properties) });
        }
      }
      if (!Check(schema, raw)) throw new HarnessError("INVALID_PARAMETERS", { allowed: Object.keys(schema.properties) });
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
          if (name !== "wait_runs" && signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
          const value = await action(args, ctx, id, signal);
          assertCurrent(ctx); // No result from an old handle is routed to a replacement parent.
          return { content: [{ type: "text", text: JSON.stringify(withChanges(value)) }], details: undefined };
        } catch (error) { throw toolError(error); }
      } };
  };
  return [
    make("spawn_agent", "Create an Agent and its first queued Run; the harness allocates resources from difficulty. Agents share the parent's cwd and checkout without isolation; children have local tools only, no web or nested delegation. Positive wait_ms adds a wait envelope: inspect wait.reason, wait.runs and wait.pending_run_ids. after/handoff_from queue a follow-up (for example a reviewer) in the same turn as the work it depends on. Before spawning, check list_agents: an idle Agent whose earlier_tasks and touched files match may be cheaper to resume; spawn fresh for unrelated work, an independent review of files an Agent touched, or a different difficulty. Host retries of the same tool-call ID with unchanged task fields reuse accepted work; a fresh call can duplicate the task. If acceptance is unclear, query list_agents before retrying.", createSchema, (args, ctx, id, signal) => {
      // Capture every mutable parent input before submitPrepared can await an
      // earlier admission. Retries hit Controller identity before preparation,
      // so they retain the first accepted route even if these values changed.
      const parentThinking = ctx.thinkingLevel;
      // Inherit model-visible context, including SDK retry omissions/replacements,
      // rather than reintroducing raw failed attempts from the append-only log.
      const messages = args.inherit_context ? structuredClone(ctx.sessionManager.buildSessionProjection().messages) : undefined;
      const { wait_ms, ...submission } = args;
      return controller.submitPrepared(`tool:spawn_agent:${digest(id)}`, submission, (input): SubmitRequest => {
        assertCurrent(ctx);
        if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
        const profile = profiles.get(input.profile);
        if (!profile) throw new HarnessError("INVALID_PROFILE", { key: "profile", allowed: [...agentProfileNames] });
        const route = resolveRoute({ preset: options.getPreset(), difficulty: input.difficulty,
          parentThinking, models: ctx.modelRegistry.getAll(), supportedThinking: getSupportedThinkingLevels });
        let context_snapshot: string | undefined;
        if (messages) {
          try { context_snapshot = textSnapshot(messages); }
          catch { throw new HarnessError("CONTEXT_SNAPSHOT_TOO_LARGE"); }
        }
        const { profile: _profile, difficulty: _difficulty, inherit_context: _context, ...run } = input;
        return { ...run, settings: { ...route, profile: input.profile, cwd,
          tools: [...profile.tools], definition_digest: profile.definition_digest,
          ...(context_snapshot === undefined ? {} : { context_snapshot }) } };
      }).then((view) => waitAfterAcceptance(view, wait_ms, signal));
    }),
    make("resume_agent", "Start another Run on an idle Agent ID, not a Run ID. Retains conversation and keeps settings fixed, including creation-time difficulty; only task fields may change. New resource allocation requires a new Agent. Keep the nickname and supply a fresh current-task description on every resume. Omitted description becomes 'Follow-up task'. Answer a finished Run's question with answer_to_run_id, not steer_run. Updates queued with post_update are placed before prompt. Wait, retry, after and handoff_from semantics match spawn_agent.", resumeSchema,
      (args, ctx, id, signal) => {
        const { wait_ms, ...submission } = args;
        return controller.submitPrepared(`tool:resume_agent:${digest(id)}`, submission, (input) => {
          assertCurrent(ctx);
          if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
          // Public identity is agent_id; the Controller's internal request and
          // lifecycle contract stay unchanged.
          const { agent_id, ...task } = input;
          return { ...task, resume: agent_id };
        }).then((view) => waitAfterAcceptance(view, wait_ms, signal));
      }),
    make("read_run", "Read a Run's full recorded question, if any, and retained last assistant output. Use for question_complete:false, result_requires_get or next_cursor. Follow next_cursor for more retained text; omitted_chars cannot be recovered. complete refers to output coverage, not task success. Owner-local only, no cold-history fallback.",
      Type.Object({ ...runId, cursor: optional(text(1024)), max_chars: optional(Type.Integer({ minimum: 1, maximum: 16384,
        description: "Output budget in UTF-16 units, default 4096; may exceed by one for a surrogate pair. Question text is separate." })) }, { additionalProperties: false }),
      ({ run_id, cursor, max_chars }) => resultReply(controller.getResult(run_id, { cursor, limit: max_chars }))),
    make("wait_runs", "Wait for Run IDs. all (default) returns early for needs_input, failed, cancelled or completed+limit_reached; any also matches already-terminal Runs. Re-wait only pending_run_ids. timeout/interrupted neither means completion nor cancels work. Progress is coalesced, not a wake-up; timeout/interruption claims none. Background completion does not start a parent turn. The wait returns as soon as its condition or attention holds, so a short timeout_ms only adds polling turns; when you have nothing else to do, wait for the whole batch in one call.",
      Type.Object({ run_ids: Type.Array(text(128), { minItems: 1, maxItems: 16 }), mode: optional(StringEnum(["any", "all"] as const, { default: "all" })),
        timeout_ms: optional(Type.Integer({ minimum: 0, maximum: 300000, description: "Wait milliseconds; default 300000. Zero returns without waiting." })),
        include_results: optional(Type.Boolean({ description: "Default true. Include bounded terminal questions and output." })) }, { additionalProperties: false }),
      ({ run_ids, mode = "all", ...rest }, _ctx, _id, signal) => controller.wait(run_ids, { ...rest, mode, timeout_ms: rest.timeout_ms ?? 300000, signal,
        include_results: false }).then((value) => waitReply(value, rest.include_results === false ? undefined :
          (run_id, limit) => controller.getResult(run_id, { limit })))),
    make("list_agents", "List resident Agents and their latest Runs, including busy or uncertain reservations. Route by IDs, not labels. No roster is automatically injected after compaction. Descriptions are bounded task labels, not full assignments. Each Agent also shows runs, earlier_tasks, last observed context use, observed_cost and touched files, to choose between resume and a fresh Agent. include_released:true adds released Agents; has_question directs you to read_run. Follow next_offset; this live view can shift between pages.",
      Type.Object({ offset: optional(Type.Integer({ minimum: 0 })), limit: optional(Type.Integer({ minimum: 1, maximum: 16, description: "Page size; default 8." })), include_released: optional(Type.Boolean()) }, { additionalProperties: false }),
      ({ offset = 0, limit = 8, include_released = false }) => {
        const all = controller.list({ include_released }), end = offset + limit;
        return { agents: all.slice(offset, end).map((view) => listRunReply(view, controller.agentSummary(view.agent_id))),
          ...(end < all.length ? { next_offset: end } : {}) };
      }),
    make("steer_run", "Send input to a running Run ID. accepted:true is not delivery confirmation. A terminal Run returns accepted:false, RUN_INPUT_CLOSED and a bounded result page; use resume_agent for further work. When the Run may already have finished, or several Agents need the same news, use post_update instead.",
      Type.Object({ ...runId, message: text(16384) }, { additionalProperties: false }),
      ({ run_id, message }) => {
        try { return { accepted: controller.steer(run_id, message).accepted }; }
        catch (error) {
          if (!(error instanceof HarnessError) || error.code !== "RUN_INPUT_CLOSED") throw error;
          const view = controller.view(run_id);
          // Cancelling and execution-exited-but-finalizing Runs remain errors:
          // neither is a terminal result or evidence that input was delivered.
          if (!terminal(view.status) || view.finalization_pending) throw error;
          const { reason: run_reason, ...result } = resultReply(controller.getResult(run_id));
          return { accepted: false, reason: error.code, ...result,
            ...(run_reason ? { run_reason } : {}) };
        }
      }),
    make("post_update", "Send one parent update to Agents by agent_id. Per target, delivery is steered (its running Run gets it now, like steer_run), queued (placed before the prompt of that Agent's next Run: a queued Run, or your next resume_agent) or rejected with an error code. Never starts work. At most 8 queued updates per Agent.",
      Type.Object({ agent_ids: Type.Array(text(128), { minItems: 1, maxItems: 16 }), message: text(16384) }, { additionalProperties: false }),
      ({ agent_ids, message }) => ({ targets: [...new Set(agent_ids)].map((agent_id) => {
        try {
          const result = controller.postUpdate(agent_id, message);
          return result.delivery === "steered" ? { agent_id, delivery: result.delivery, run_id: result.run_id } : { agent_id, ...result };
        } catch (error) {
          if (!(error instanceof HarnessError)) throw error;
          return { agent_id, delivery: "rejected", ...errorReply(error) };
        }
      }) })),
    make("cancel_run", "Request cancellation of a Run ID. Cancellation is not execution exit or Agent release; wait for the Run to settle.",
      Type.Object(runId, { additionalProperties: false }), ({ run_id }) => {
        const value = controller.cancel(run_id); return { ...runReply(value.snapshot), cancel: value.result };
      }),
    make("release_agent", "Release an idle Agent ID permanently to free capacity; retained results remain readable. For busy Agents, await completion or cancel and await settlement first. released:false means cleanup is uncertain; no force release or cleanup retry. Releasing all Agents does not close the Owner; parent-session replacement requires confirmed Owner closure, and reload with an open Owner is unsupported.",
      Type.Object({ agent_id: text(128) }, { additionalProperties: false }), ({ agent_id }) => controller.release(agent_id)),
  ];
}
