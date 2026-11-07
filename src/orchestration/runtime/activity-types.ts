/** Plain identifying metadata for a tool that has actually started execution. */
export interface ActiveTool {
  name: string;
  detail?: string;
}

/** Ephemeral, provider-public output for human activity projections only. */
export interface GenerationPreview {
  /** Ordinary assistant prose, never thinking. */
  preview: string;
  thinking?: string;
  channel?: "thinking" | "text";
  /** Draft tool arguments, not execution. An empty name means not yet known. */
  preparing_tool?: string;
}
