import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import { validDifficulty } from "../core/contracts.ts";
import {
  COMMUNICATION_LIMITS,
  isModelAgentName,
  MODEL_AGENT_NAME_PATTERN,
} from "../core/communication-envelope.ts";
import { validateDispatch } from "../core/dispatch.ts";
import { OrchestrationError } from "../core/ports.ts";
import { QUESTION_ID_PATTERN } from "../core/question-id.ts";
import { invalidDifficultyResolution } from "../routing.ts";
import { modelProfileNames } from "./tool-names.ts";

// The model's whole vocabulary: an Agent (a named worker with a conversation)
// does one task at a time. Agents are addressed by name; no Run ID is model-facing.

const text = (maxLength: number, description?: string) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", ...(description ? { description } : {}) });
// Pi 1.5's pi-ai root StringEnum returns a pi-schema schema, while Pi's extension
// loader aliases that import to a TypeBox view. Keep local enums TypeBox-backed
// for Static/Check under either resolution, with the same {type, enum} wire shape.
const stringEnum = <T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) => Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
const optional = Type.Optional;
const offGuidance =
  "workers_disabled: ask the user to enable delegation for new work, steering or answers; accepted work and inspection continue.";
export const AGENT_NAME_PATTERN = MODEL_AGENT_NAME_PATTERN;
const agentName = (description?: string) =>
  Type.String({ pattern: AGENT_NAME_PATTERN, ...(description ? { description } : {}) });
const agentNames = (maxItems: number, description: string) =>
  Type.Array(agentName(), { minItems: 1, maxItems, description });
const waitMs = (description: string) => Type.Integer({ minimum: 0, maximum: 300000, description });

const labelField = optional(
  text(
    COMMUNICATION_LIMITS.label_units,
    "Summary label, not instructions; defaults to prompt's first nonblank line.",
  ),
);
const afterField = optional(
  agentNames(
    4,
    "Wait for each named Agent's current or latest task, fixed when this call is accepted, to reach completed; any other settled status fails the dependency. Results become reference context. Does not follow later tasks or answers: wait until agent_answer returns before naming its Agent here.",
  ),
);
const waitField = optional(
  waitMs("Wait for task/events; default 0 returns now. Timeout/abort never stops work."),
);
const dispatchPath = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: 512,
    pattern: "^(?![~@])(?=.*\\S)[^\\x00-\\x1f\\x7f*?[\\]{}'\"`$\\\\]+(?![\\s\\S])",
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
      inputs: optional(dispatchPaths(8, "Input file/directory; must exist when checked.")),
      ownership: optional(
        dispatchPaths(
          16,
          "File/directory to edit or create; needs write permission, one editor per shared file. Omit for read-only tasks.",
        ),
      ),
      tree: optional(
        dispatchPath(
          "Build/test output directory; needs write permission and, if it exists, must be a directory. Overlapping declared resources conflict within this Owner; cross-Owner tree locks are advisory, not global exclusivity.",
        ),
      ),
      checks: optional(
        Type.Array(
          Type.String({
            minLength: 1,
            maxLength: 512,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+(?![\\s\\S])",
            description:
              "Planned check identifier (globs allowed); ready for this task, not later go-ahead.",
          }),
          { minItems: 1, maxItems: 16, uniqueItems: true },
        ),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Task scope and planned checks, not permissions or execution evidence. Use literal paths without padding, globs or shell expansion. Relative paths resolve from the inherited parent cwd; absolute paths keep their meaning. Assign full-suite validation to one designated Agent after shared source is stable.",
    },
  ),
);
const returnToField = optional(
  Type.Object(
    {
      agent: agentName("Existing worker with a settled, unanswered question."),
      question_id: Type.String({
        minLength: 34,
        maxLength: 34,
        pattern: QUESTION_ID_PATTERN,
        description: "Exact pending question_id returned by wait/read for that worker.",
      }),
      answer: text(
        16384,
        "Your instruction for continuing the worker's task; scout findings are attached separately as untrusted reference material.",
      ),
    },
    {
      additionalProperties: false,
      description:
        "Scout only: answer a worker's pending question with this scout's findings. Needs agent_answer allowed for you without a prompt. The worker resumes automatically once the scout completes, findings attached; you do not read or relay them. wait_ms waits for the worker. Kill the scout when done.",
    },
  ),
);
export const spawnSchema = Type.Object(
  {
    agent: agentName(
      "Unique short nickname from one theme, not a task name; stays taken after kill.",
    ),
    prompt: text(
      131072,
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
        description: "Default false: text context without tool calls/results; max 64 KiB.",
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
          "Per-task turn limit; default 256, fixed for follow-ups. No task wall-clock deadline. May leave partial results.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const runSchema = Type.Object(
  {
    agent: agentName("An existing, idle Agent."),
    continues: text(
      512,
      "The specific earlier work of this Agent being continued; not sent to it. If you cannot name one, use agent_spawn (with after if only its output is needed).",
    ),
    prompt: text(
      131072,
      "Follow-up instructions: deliverable, scope, stopping conditions, cwd-relative or absolute paths; source/version/date constraints and output format as relevant; earlier conversation is retained.",
    ),
    label: labelField,
    dispatch: dispatchField,
    after: afterField,
    wait_ms: waitField,
  },
  { additionalProperties: false },
);
export const sendSchema = Type.Object(
  {
    agent: agentName("Agent whose task is selected now; never retargets later work."),
    message: text(
      16384,
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
      16384,
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
        `Bind each named Agent's active (running/queued) task, else its pending question, else its latest finished task, once at this call. Alerts span those Agents. Omit to wait on unfinished tasks, answerable questions and all Agents' alerts. Queued wait="capacity" means waiting for a provider slot; wait="dependencies" waits for fixed tasks.`,
      ),
    ),
    mode: optional(
      stringEnum(["all", "any"] as const, {
        default: "all",
        description:
          "all (default): every selected task ends; any: one ends. Other events may return earlier.",
      }),
    ),
    wait_ms: optional(waitMs("Wait duration; default 300000 ms. 0 checks once.")),
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
        1024,
        "Copy next_cursor with its Agent to continue that original task. Do not also supply task.",
      ),
    ),
    max_chars: optional(
      Type.Integer({
        minimum: 1,
        maximum: 16384,
        description: "Page size, default/max 16384 characters; reply limits may shorten it.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const listSchema = Type.Object({}, { additionalProperties: false });

export const agentSpawnDescription =
  "Create an Agent and submit its first task: the default for any new work or review. Execution may queue. Model, profile, context and turn limit stay fixed; no nested delegation. If acceptance is unclear, check agent_list before repeating. Queued work is accepted; wait, do not respawn.";
export const agentRunDescription =
  "Continue an idle Agent's own earlier work; each turn re-reads its whole conversation. New work, even on a related topic, or different settings: agent_spawn. Running task: agent_send or agent_wait; pending question: agent_answer.";
export const agentSendDescription =
  "Add instructions to the task selected now, not an answer or new task. delivery: joined=added to prompt, steered=sent while running, not_delivered=nothing sent. Delivery does not prove action.";
export const agentAnswerDescription =
  'Answer the exact pending question_id and submit a continuation. First wait for status="needs_input" and a current question_id from agent_wait or agent_read; historical text alone cannot be answered. Keeps fixed settings and the asking task\'s label/dispatch. workers_disabled: ask the user to enable delegation before answering.';
export const agentWaitDescription = `Wait for selected tasks; questions, issues or alerts return early. Prefer long waits to polling. Questions stay pending; name other Agents to defer one. Nothing pending returns now; timeout/abort never stops work. ${offGuidance}`;
export const agentReadDescription = `Read a task's result/question and this Agent's alerts, including after reuse or kill. Prioritizes the full question; keep next_cursor to continue the original task. ${offGuidance}`;
export const agentInterruptDescription =
  "Request a stop, not settlement; confirm with wait/read. An already ending task keeps its outcome. Keeps the conversation for follow-ups; consumes no alerts.";
export const agentKillDescription =
  "Permanently end an Agent, requesting stop of its task. exiting or cleanup_uncertain does not confirm release. Name stays taken, results stay readable; consumes no alerts.";
export const agentListDescription =
  "Read-only roster with current/latest task labels. Get pending questions through wait/read. Consumes no alerts or completion notices.";

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
  const valid = Check(schema, raw);
  const fields = valid ? (raw as Record<string, unknown>) : {};
  const addressedNames: unknown[] = [
    ...(fields.agent === undefined ? [] : [fields.agent]),
    ...(Array.isArray(fields.agents) ? (fields.agents as unknown[]) : []),
    ...(Array.isArray(fields.after) ? (fields.after as unknown[]) : []),
    ...(fields.return_to && typeof fields.return_to === "object"
      ? [(fields.return_to as Record<string, unknown>).agent]
      : []),
  ];
  // Preserve the published pattern, but reject JS `$`'s final-newline
  // exception before admission can create an undeliverable Agent name.
  if (!valid || addressedNames.some((value) => !isModelAgentName(value)))
    throw new OrchestrationError("INVALID_PARAMETERS", {
      allowed: Object.keys(schema.properties),
      resolution:
        "The arguments do not match this tool's schema; check the required fields, their types and bounds.",
    });
  if (name === "agent_spawn" && fields.return_to !== undefined && fields.profile !== "scout")
    throw new OrchestrationError("INVALID_RETURN_TO", {
      key: "return_to",
      resolution: "Only a scout spawn can return results to a worker's pending question.",
    });
  if ((name === "agent_spawn" || name === "agent_run") && fields.dispatch !== undefined)
    validateDispatch(fields.dispatch);
  if (name === "agent_read" && fields.task !== undefined && fields.cursor !== undefined)
    throw new OrchestrationError("INVALID_PARAMETERS", {
      key: "task",
      resolution:
        "Choose task to start its first page, or cursor to continue the original page; do not supply both.",
    });
  return structuredClone(raw);
}
