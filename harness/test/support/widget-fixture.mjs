import assert from "node:assert/strict";
import { HarnessWidget, renderWidgetLines } from "../../dist/ui/agent-widget.js";
import { ChildActivityRegistry } from "../../dist/runtime/activity-observer.js";

export const ROW_BREAK = new RegExp("[\\t\\n\\v\\f\\r\\u0085\\u2028\\u2029]");

// Plain text keeps the assertions about layout, not about escape sequences.
export const theme = { fg: (_color, text) => text, bold: (text) => text };

export const owner = { blocked: false, resident: 2, resident_limit: 8 };

export const base = {
  resident: true,
  turns: 3,
  max_turns: 256,
  elapsed_ms: 12400,
  tool_uses: 2,
  active_tools: [],
  preview: "",
  question: false,
  limit_reached: false,
  pending_messages: 0,
  has_run_warnings: false,
  finishing: false,
  name: "",
  profile: "editor",
  difficulty: 3,
  model: "m",
  effort: "high",
  description: "Task",
};

export const run = (id, overrides) => ({
  ...base,
  agent_id: id,
  run_id: `${id}-run`,
  ...overrides,
});

export const render = (runs, options = {}) =>
  renderWidgetLines({
    runs,
    owner,
    spinnerFrame: 0,
    width: 120,
    theme,
    maxLines: 12,
    shouldShowFinished: () => true,
    ...options,
  });

export const tool = (name, detail) => ({ name, detail });

/** A RunView as the controller projects one, with only the fields the widget reads. */
export const viewOf = (agent_id, status, run_id = `${agent_id}-1`) => ({
  run_id,
  agent_id,
  name: "",
  description: "Task",
  status,
  phase: status === "running" ? "streaming" : "settled",
  execution_exited: false,
  finalization_pending: false,
  resident: true,
  resumable: false,
  owner_blocked: false,
  pending_messages: 0,
  isolation: "shared",
  elapsed_ms: 1000,
  turns: 1,
  max_turns: 8,
  cleanup_errors: [],
  discarded_inputs: [],
  effective_settings: {
    provider: "p",
    model: "m",
    thinking: "off",
    parent_thinking: "off",
    thinking_resolution: "identity",
    profile: "editor",
    difficulty: 3,
    strength: "d3",
    preset: "fixture",
    preset_version: "v1",
    selection_digest: "1".repeat(64),
    cwd: "/w",
    tools: [],
    definition_digest: "0".repeat(64),
    context_mode: "none",
  },
});

/** A widget wired to a host that mounts its component, as the TUI does. */
export const mounted = (initial = [], residentLimit = 8) => {
  let views = initial,
    renders = 0,
    reads = 0,
    statsReads = 0,
    content;
  const tui = {
    terminal: { columns: 120, rows: 48 },
    mode: "fullscreen",
    requestRender: () => {
      renders++;
    },
  };
  const activities = new ChildActivityRegistry();
  const widget = new HarnessWidget(
    {
      list: (options) => {
        reads++;
        return views.filter((view) => options.include_released !== false || view.resident);
      },
      stats: () => {
        statsReads++;
        return { resident: views.filter((view) => view.resident).length, cleanup_uncertain: false };
      },
    },
    residentLimit,
    activities.observations,
    (ids) => activities.retain(ids),
  );
  const ui = {
    setWidget: (_key, factory) => {
      content = factory ? factory(tui, theme) : undefined;
    },
  };
  widget.setUi(ui);
  return {
    widget,
    activities,
    ui,
    tui,
    component: () => content,
    set: (next) => {
      views = next;
    },
    renders: () => renders,
    reads: () => reads,
    statsReads: () => statsReads,
    showing: () => !!content,
    lines: (width = 120) => (content ? content.render(width) : []),
  };
};

export const headingClick = { type: "click", button: "left", x: 0, y: 0 };

export const pageClick = (h, direction = "Next") => {
  const lines = h.lines(),
    y = lines.findIndex((line) => line.includes("[Next]"));
  assert(y >= 0, "page controls must be painted");
  return h.component().handleMouse({ ...headingClick, y, x: lines[y].indexOf(`[${direction}]`) });
};

export function refreshFixture(t, status = "running") {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let views = [viewOf("a", status)],
    component,
    failure,
    removalFails = false,
    projectionFails = false;
  let mounts = 0,
    removals = 0,
    renders = 0,
    reads = 0,
    opens = 0;
  const widget = new HarnessWidget(
    {
      list: () => {
        reads++;
        if (projectionFails) throw new Error("PROJECTION_FAILED");
        return views;
      },
      stats: () => ({ resident: views.length, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = {
    terminal: { columns: 120 },
    mode: "fullscreen",
    requestRender() {
      renders++;
    },
  };
  widget.onOpen(() => {
    opens++;
  });
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) {
        removals++;
        if (removalFails) throw new Error("WIDGET_CLEAR_FAILED");
        component = undefined;
        return;
      }
      mounts++;
      const fault = failure;
      failure = undefined;
      if (fault === "retained") throw new Error("WIDGET_REFRESH_FAILED");
      component = undefined;
      if (fault === "removed") throw new Error("WIDGET_REFRESH_FAILED");
      component = factory(tui, theme);
      if (fault === "installed" || fault === "invalidated") {
        component.render(120);
        if (fault === "invalidated") component.invalidate();
        throw new Error("WIDGET_REFRESH_FAILED");
      }
    },
  });
  t.after(() => {
    removalFails = false;
    widget.dispose();
  });
  return {
    widget,
    component: () => component,
    fail: (phase) => {
      failure = phase;
    },
    failProjection: (fail) => {
      projectionFails = fail;
    },
    failRemoval: () => {
      removalFails = true;
    },
    set: (next) => {
      views = next;
    },
    counts: () => ({ mounts, removals, renders, reads, opens }),
  };
}

export function reentryHost(t, views) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component,
    mounts = 0,
    removals = 0,
    renders = 0,
    opens = 0,
    mode = "apply";
  const widget = new HarnessWidget(
    { list: () => views, stats: () => ({ resident: views.length, cleanup_uncertain: false }) },
    8,
  );
  const tui = {
    terminal: { columns: 120, rows: 36 },
    mode: "fullscreen",
    requestRender() {
      renders++;
    },
  };
  widget.onOpen(() => {
    opens++;
  });
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) {
        removals++;
        component = undefined;
        return;
      }
      mounts++;
      if (mode === "before") widget.wake();
      if (mode === "refresh") widget.update(true);
      const installed = factory(tui, theme);
      if (mode === "after") widget.wake();
      component = installed;
    },
  });
  t.after(() => widget.dispose());
  return {
    widget,
    tui,
    component: () => component,
    setMode: (next) => {
      mode = next;
    },
    counts: () => ({ mounts, removals, renders, opens }),
  };
}
