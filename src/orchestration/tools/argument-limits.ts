import { OrchestrationError } from "../core/ports.ts";

/** Model task titles are narrower than the communication projection's label bound. */
export const MODEL_TASK_TITLE_UNITS = 72;
export const PARENT_TEXT_LIMITS = Object.freeze({
  label: MODEL_TASK_TITLE_UNITS,
  prompt: 131072,
  continues: 512,
  message: 16384,
  answer: 16384,
  cursor: 1024,
});

type TextField = keyof typeof PARENT_TEXT_LIMITS;
const fieldsByTool: Readonly<Record<string, readonly TextField[]>> = {
  agent_spawn: ["label", "prompt"],
  agent_run: ["label", "prompt", "continues"],
  agent_send: ["message"],
  agent_answer: ["answer"],
  agent_read: ["cursor"],
};

function checkText(value: unknown, field: TextField, path: string = field): void {
  const limit = PARENT_TEXT_LIMITS[field];
  // JSON Schema validators disagree about astral maxLength. The public contract
  // is JavaScript UTF-16 units, not code points, graphemes or encoded bytes.
  if (typeof value === "string" && value.length <= limit && /\S/.test(value)) return;
  throw new OrchestrationError("INVALID_PARAMETERS", {
    key: path,
    resolution:
      field === "label"
        ? `${value === undefined ? "label is required: supply a" : "label must be a"} nonblank task title of at most ${limit} UTF-16 units (JavaScript .length), not instructions or background.`
        : `${path} must be a nonblank string of at most ${limit} UTF-16 units (JavaScript .length).`,
  });
}

/** Raw, SDK-free checks shared by preparation and execution, before cloning or
 * action. Leave unidentifiable structural failures to the closed schema. */
export function checkParentTextArguments(name: string, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const fields = raw as Record<string, unknown>;
  for (const field of fieldsByTool[name] ?? []) {
    if (name === "agent_read" && fields[field] === undefined) continue;
    checkText(fields[field], field);
  }
  if (
    name === "agent_spawn" &&
    fields.return_to &&
    typeof fields.return_to === "object" &&
    !Array.isArray(fields.return_to)
  )
    checkText((fields.return_to as Record<string, unknown>).answer, "answer", "return_to.answer");
}
