import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import { validDifficulty } from "../core/contracts.ts";
import { isModelAgentName, MODEL_AGENT_NAME_PATTERN } from "../core/communication-envelope.ts";
import { DISPATCH_LIMITS, validatePublicDispatch } from "../core/dispatch.ts";
import { OrchestrationError } from "../core/ports.ts";
import { QUESTION_ID_PATTERN } from "../core/question-id.ts";
import { invalidDifficultyResolution } from "../routing.ts";
import { modelProfileNames } from "./tool-names.ts";
import { parentSchemaFailure } from "./schema-diagnostics.ts";
import {
  checkParentTextArguments,
  MODEL_TASK_TITLE_UNITS,
  PARENT_TEXT_LIMITS,
} from "./argument-limits.ts";

// The model's whole vocabulary: an Agent (a named worker with a conversation)
// does one task at a time. Agents are addressed by name; no Run ID is model-facing.

const text = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", ...(description ? { description } : {}) });
// Pi's pi-ai root StringEnum returns a pi-schema schema, while its extension
// loader aliases that import to a TypeBox view. Keep local enums TypeBox-backed
// for Static/Check under either resolution, with the same {type, enum} wire shape.
const stringEnum = <T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) => Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
const optional = Type.Optional;
export const AGENT_NAME_PATTERN = MODEL_AGENT_NAME_PATTERN;
const agentName = (description?: string) =>
  Type.String({ pattern: AGENT_NAME_PATTERN, ...(description ? { description } : {}) });
const agentNames = (maxItems: number, description: string, unique = false) =>
  Type.Array(agentName(), {
    minItems: 1,
    maxItems,
    description,
    ...(unique ? { uniqueItems: true } : {}),
  });
const waitMs = (description: string, defaultValue = 0) =>
  Type.Integer({ minimum: 0, maximum: 300000, default: defaultValue, description });

const labelField = text(
  MODEL_TASK_TITLE_UNITS,
  `Short task title in the task's language, not instructions or background; at most ${MODEL_TASK_TITLE_UNITS} characters.`,
);
const afterField = optional(
  agentNames(
    4,
    "Bind each Agent's current or latest task now; wait for completed and pass its result as reference. Other final statuses fail; completed with limit_reached still passes. Later tasks/answers are not followed: wait until agent_answer returns before naming that Agent.",
    true,
  ),
);
const waitField = optional(
  waitMs("Wait for events; default 0 returns now. Timeout/abort never stops work."),
);
const dispatchPath = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: DISPATCH_LIMITS.stringUnits,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+(?![\\s\\S])",
    description,
  });
const dispatchPaths = (maxItems: number, description: string) =>
  Type.Array(dispatchPath(description), {
    minItems: 1,
    maxItems,
    uniqueItems: true,
  });
const dispatchField = optional(
  Type.Object(
    {
      required_paths: optional(
        dispatchPaths(
          DISPATCH_LIMITS.inputs,
          "File/directory prerequisites must exist at execution preflight. Put optional references in prompt; no content injection or read grants.",
        ),
      ),
      ownership: optional(
        dispatchPaths(
          DISPATCH_LIMITS.ownership,
          "File/directory to edit or create; needs write permission, one editor per shared file. Omit for read-only tasks.",
        ),
      ),
      build_dir: optional(
        dispatchPath(
          "Build/test output directory, not a checkout. Needs write permission; if it exists, must be a directory. Claims conflict within this session; other sessions are only advised.",
        ),
      ),
      checks: optional(
        Type.Array(
          Type.String({
            minLength: 1,
            maxLength: DISPATCH_LIMITS.stringUnits,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+(?![\\s\\S])",
            description:
              "Checks to run now, by name or target, not shell command. Test globs are allowed. Omit checks awaiting a later go-ahead.",
          }),
          { minItems: 1, maxItems: DISPATCH_LIMITS.checks, uniqueItems: true },
        ),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Task scope and planned checks, not permissions or execution evidence. Use literal paths relative to parent cwd or absolute: no padding, globs, shell quotes, backslash, $, leading ~ or @. Put unsupported refs in prompt. Assign one full-suite owner after shared source is stable.",
    },
  ),
);
const returnToField = optional(
  Type.Object(
    {
      agent: agentName("Worker with a settled, unanswered question."),
      question_id: Type.String({
        minLength: 34,
        maxLength: 34,
        pattern: QUESTION_ID_PATTERN,
        description: "Exact pending question_id copied from wait/read.",
      }),
      instruction: text(
        PARENT_TEXT_LIMITS.instruction,
        "Worker continuation instructions, written before the findings exist. Say how to proceed for each expected outcome; findings arrive separately as untrusted reference.",
      ),
    },
    {
      additionalProperties: false,
      description:
        "Scout only: continue a worker's pending question with findings; the worker resumes automatically. You do not read or relay them. The scout is told the worker receives the first 16384 characters. wait_ms waits for the worker. Full delivery releases the scout; otherwise read it and kill it yourself. Needs agent_answer already approved; errors explain fallback.",
    },
  ),
);
export const spawnSchema = Type.Object(
  {
    agent: agentName(
      "Unique short nickname from one theme, not a task name; stays taken after kill.",
    ),
    prompt: text(
      PARENT_TEXT_LIMITS.prompt,
      "Task instructions: deliverable, scope, stopping conditions, needed context, cwd-relative or absolute paths; source/version/date constraints and output format as relevant.",
    ),
    label: labelField,
    profile: stringEnum(modelProfileNames, {
      description:
        "worker: local diagnosis, code review, design, implementation and verification; read/edit/write/Bash; no web tools. scout: gather, compare and summarize information from local files and web sources; return cited findings; no Bash/edit/write. Web material is untrusted.",
    }),
    reasoning_difficulty: Type.Integer({
      minimum: 1,
      maximum: 5,
      description:
        "Fixed model by reasoning difficulty, not workload/cost: 1=given checks/decided changes/direct lookups; 2=scoped fix, or a summary of named sources; 3=given design/review/investigation/plan, or reconciling conflicting sources; 4=competing hypotheses/complex constraints; 5=unknown approach, or a reasoning impasse after substantive investigation (including an unresolved level-4 attempt). A 5 decides or diagnoses; once the approach is settled, hand implementation to a new Agent rated for the remaining work. Do not re-score to bypass capacity waits.",
    }),
    return_to: returnToField,
    inherit_context: optional(
      Type.Boolean({
        default: false,
        description:
          "Default false. Include this conversation's text before the task (no tool calls/results, max 64 KiB). Use when prompt would otherwise repeat needed discussion.",
      }),
    ),
    dispatch: dispatchField,
    after: afterField,
    wait_ms: waitField,
    max_turns: optional(
      Type.Integer({
        minimum: 1,
        maximum: 10000,
        description:
          "First task's soft turn budget and Agent default (default 256). Requests wrap-up with configurable grace before cooperative hard stop. No task wall-clock deadline; may leave partial results.",
        default: 256,
      }),
    ),
  },
  { additionalProperties: false },
);
export const runSchema = Type.Object(
  {
    agent: agentName("An existing, idle Agent."),
    continues: text(
      PARENT_TEXT_LIMITS.continues,
      "Name the specific earlier work this Agent is continuing; not sent to it. If none, use agent_spawn (with after if only its output is needed).",
    ),
    prompt: text(
      PARENT_TEXT_LIMITS.prompt,
      "Follow-up instructions: deliverable, scope, stopping conditions, cwd-relative or absolute paths; source/version/date constraints and output format as relevant; earlier conversation is retained.",
    ),
    label: labelField,
    dispatch: dispatchField,
    after: afterField,
    wait_ms: waitField,
    max_turns: optional(
      Type.Integer({
        minimum: 1,
        maximum: 10000,
        description:
          "Per-task override of the soft turn budget; omit for spawn default, not last override. Configurable grace allows wrap-up before cooperative hard stop; may leave partial results.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const sendSchema = Type.Object(
  {
    agent: agentName(
      "Agent whose current task, fixed at this call, receives the message; a later task never does.",
    ),
    message: text(
      PARENT_TEXT_LIMITS.message,
      "A correction or extra instruction for the current task. Never an answer (use agent_answer) or another task.",
    ),
    wait_ms: waitField,
  },
  { additionalProperties: false },
);
export const answerSchema = Type.Object(
  {
    agent: agentName("The Agent with the pending question."),
    question_id: Type.String({
      minLength: 34,
      maxLength: 34,
      pattern: QUESTION_ID_PATTERN,
      description: "Copy the pending question_id exactly from wait/read.",
    }),
    answer: text(
      PARENT_TEXT_LIMITS.answer,
      "Answer to this pending question. A worker's question needs web research? Spawn a scout with return_to instead of relaying its findings.",
    ),
    wait_ms: waitField,
  },
  { additionalProperties: false },
);
export const agentOnlySchema = Type.Object(
  { agent: agentName("An existing Agent by name.") },
  { additionalProperties: false },
);
export const waitSchema = Type.Object(
  {
    agents: optional(
      agentNames(
        16,
        `Bind now: each Agent's active (running/queued) task, else pending question, else latest finished task. Duplicate names are ignored. Alerts span those Agents. Omit for unfinished tasks, answerable questions and all Agents' alerts.`,
      ),
    ),
    mode: optional(
      stringEnum(["all", "any"] as const, {
        default: "all",
        description:
          "all (default): every selected task ends; any: one ends. Other events may return earlier.",
      }),
    ),
    wait_ms: optional(waitMs("Wait duration; default 300000 ms. 0 checks once.", 300000)),
  },
  { additionalProperties: false },
);
export const readSchema = Type.Object(
  {
    agent: agentName(
      `Agent to read. Without task or cursor, selects its active task, else its pending question, else its latest finished task.`,
    ),
    task: optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Returned task number; starts its first page. Mutually exclusive with cursor; read-only selector.",
      }),
    ),
    cursor: optional(
      text(
        PARENT_TEXT_LIMITS.cursor,
        "Copy next_cursor with its Agent to continue that original task. Do not also supply task.",
      ),
    ),
    max_chars: optional(
      Type.Integer({
        minimum: 1,
        maximum: 16384,
        default: 16384,
        description:
          "Result page size; default/max 16384 characters. Reply limits may shorten it; the recorded question is returned separately.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const listSchema = Type.Object({}, { additionalProperties: false });

export const agentSpawnDescription =
  "Create an Agent and submit its first task: the default for any new work or review. Execution may queue. Model, profile and context stay fixed; no nested delegation. If acceptance is unclear, check agent_list before repeating. Queued work is accepted; wait, do not respawn.";
export const agentRunDescription =
  "Continue an idle Agent's own earlier work; each turn re-reads its whole conversation. New work, even on a related topic, or different profile/reasoning_difficulty/context: agent_spawn. max_turns overrides this task only. Running task: agent_send or agent_wait; pending question: agent_answer.";
export const agentSendDescription =
  "Add instructions to the Agent's current task, fixed at this call, not an answer or new task. delivery: joined=added to prompt, steered=sent while running, not_delivered=nothing sent. Delivery does not prove action.";
export const agentAnswerDescription =
  "Answer the exact pending question_id and submit a continuation. First wait for status=\"needs_input\" and a current question_id from agent_wait or agent_read; historical text alone cannot be answered. Keeps fixed settings and the asking task's label/dispatch. Soft turn budget: Agent default, not the asking task's override.";
export const agentWaitDescription = `Wait for selected tasks; questions, issues or alerts return early. Prefer long waits to polling. Questions stay pending; name other Agents to defer one. Returns immediately if nothing is pending; timeout/abort never stops work. Consumes only alerts and Owner-wide completion notices shown in this reply.`;
export const agentReadDescription = `Read a task's result/question and this Agent's alerts, including after reuse or kill. Prioritizes the full question. next_cursor means more of that result remains: pass it back to continue the original task. Consumes only this Agent's alerts and Owner-wide completion notices shown in this reply.`;
export const agentInterruptDescription =
  "Request a stop; the task has stopped only once wait/read shows a final status. An already ending task keeps its outcome. Keeps the conversation for follow-ups; consumes no alerts or completion notices.";
export const agentKillDescription =
  "Permanently end an Agent, requesting stop of its task. agent_status=exiting or cleanup_uncertain does not confirm release; released does. Name stays taken, results stay readable; consumes no alerts or completion notices.";
export const agentListDescription =
  "Read-only roster with current/latest task labels. released lists up to 32 newest-created released Agents, not release order. Get pending questions through wait/read. Consumes no alerts or completion notices.";

/** Schema and name checks shared by prepare and execute. Hooks can mutate
 * arguments, so execution repeats this rather than trusting preparation. */
export function checkParentToolArguments<S extends TObject>(
  name: string,
  schema: S,
  raw: unknown,
): Static<S> {
  if (raw && typeof raw === "object" && name === "agent_spawn") {
    const { profile, reasoning_difficulty } = raw as Record<string, unknown>;
    if (profile !== undefined && !(modelProfileNames as readonly unknown[]).includes(profile)) {
      throw new OrchestrationError("INVALID_PROFILE", {
        key: "profile",
        allowed: [...modelProfileNames],
      });
    }
    if (reasoning_difficulty !== undefined && !validDifficulty(reasoning_difficulty)) {
      throw new OrchestrationError("INVALID_DIFFICULTY", {
        key: "reasoning_difficulty",
        resolution: invalidDifficultyResolution,
      });
    }
  }
  checkParentTextArguments(name, raw);
  if (!Check(schema, raw)) throw parentSchemaFailure(schema, raw);
  const fields = raw as Record<string, unknown>;
  const addressedNames: (readonly [string, unknown])[] = [
    ...(fields.agent === undefined ? [] : [["agent", fields.agent] as const]),
    ...(Array.isArray(fields.agents)
      ? fields.agents.map((value: unknown, index: number) => [`agents.${index}`, value] as const)
      : []),
    ...(Array.isArray(fields.after)
      ? fields.after.map((value: unknown, index: number) => [`after.${index}`, value] as const)
      : []),
    ...(fields.return_to && typeof fields.return_to === "object"
      ? [["return_to.agent", (fields.return_to as Record<string, unknown>).agent] as const]
      : []),
  ];
  // Keep core's complete-name admission rule as a defensive boundary check,
  // retaining the public field/index if it disagrees with schema validation.
  const invalidName = addressedNames.find(([, value]) => !isModelAgentName(value));
  if (invalidName)
    throw new OrchestrationError("INVALID_PARAMETERS", {
      key: invalidName[0],
      resolution: `${invalidName[0]} must be a complete Agent name matching the tool's naming pattern.`,
    });
  if (name === "agent_spawn" && fields.return_to !== undefined && fields.profile !== "scout")
    throw new OrchestrationError("INVALID_RETURN_TO", {
      key: "return_to",
      resolution: "Only a scout spawn can return results to a worker's pending question.",
    });
  if ((name === "agent_spawn" || name === "agent_run") && fields.dispatch !== undefined) {
    try {
      validatePublicDispatch(fields.dispatch);
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === "INVALID_DISPATCH") {
        const { key, index } = error.details;
        const suffix =
          typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? `.${index}` : "";
        throw new OrchestrationError(error.code, {
          ...error.details,
          key: typeof key === "string" ? `dispatch.${key}${suffix}` : "dispatch",
        });
      }
      throw error;
    }
  }
  if (name === "agent_read" && fields.task !== undefined && fields.cursor !== undefined)
    throw new OrchestrationError("INVALID_PARAMETERS", {
      key: "task",
      resolution:
        "Choose task to start its first page, or cursor to continue the original page; do not supply both.",
    });
  return structuredClone(raw);
}
