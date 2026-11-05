import { boundedOutput } from "./result-text.ts";
import { COMMUNICATION_LIMITS } from "./communication-envelope.ts";

export interface TaskMetadata {
  readonly label: string;
}
export function taskMetadata(source: { readonly description: string }): TaskMetadata {
  return { label: boundedOutput(source.description, COMMUNICATION_LIMITS.label_units).text };
}
