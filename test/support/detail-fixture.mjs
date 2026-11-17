// Inert inputs for the source-level detail pane and tab rendering tests.
export const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
export const sgrTheme = {
  ...plainTheme,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  underline: (text) => `\u001b[4m${text}\u001b[24m`,
};

export const detailView = (id, extra = {}) => ({
  owner_id: "owner",
  generation: "generation",
  agent_id: id,
  run_id: `run-${id}`,
  name: id,
  task: 1,
  description: "Current task",
  status: "completed",
  phase: "settled",
  execution_exited: true,
  finalization_pending: false,
  resident: true,
  resumable: false,
  pending_messages: 0,
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 80,
  cleanup_errors: [],
  discarded_inputs: [],
  effective_settings: {
    profile: "editor",
    model: "model",
    thinking: "high",
    parent_thinking: "high",
    thinking_resolution: "identity",
    preset: "default",
    preset_version: "v1",
    strength: "d3",
    difficulty: 3,
    tools: ["read"],
    cwd: "/workspace",
    context_mode: "none",
  },
  ...extra,
});

export const detailEntry = (view) => ({
  agent_id: view.agent_id,
  input: { view, live: { active_tools: [], tool_uses: 0, preview: "" } },
});

export function recordingTheme({ tabStyles = true } = {}) {
  const calls = [];
  const theme = {
    fg: (color, text) => (calls.push(["fg", color, text]), text),
    bold: (text) => (calls.push(["bold", text]), text),
  };
  if (tabStyles) {
    theme.underline = (text) => (calls.push(["underline", text]), text);
    theme.bg = (color, text) => (calls.push(["bg", color, text]), text);
  }
  return { calls, theme };
}

export const fgCall = (calls, color, text) =>
  calls.some(([kind, c, t]) => kind === "fg" && c === color && t === text);
