import {
  theme,
  owner,
  run,
  render,
  viewOf,
  mounted,
  headingClick,
  pageClick,
  refreshFixture,
} from "../support/widget-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget, renderWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { ChildActivityRegistry } from "../../dist/orchestration/runtime/activity-observer.js";
import { DetailPane, renderDetailFields } from "../../dist/orchestration/ui/agent-detail.js";
import { addToLedger } from "../../dist/orchestration/core/usage-ledger.js";
import { SessionUnavailableError } from "../../dist/orchestration/core/ports.js";
import { ended, fixture, task, until } from "../support/controller-fixture.mjs";

for (const [waiting_for, label] of [
  ["sdk_idle", "SDK idle"],
  ["deliveries", "tracked inputs/abort"],
]) {
  test(`widget and detail show live drain waits instead of stale activity (${waiting_for})`, (t) => {
    const view = viewOf("a", "cancelling");
    view.drain = { waiting_for, elapsed_ms: 5000 };
    view.runtime = { activity: "retrying" };
    const h = mounted([view]);
    t.after(() => h.widget.dispose());
    h.widget.wake();
    assert(h.lines().join("\n").includes(`draining 5.0s · awaiting ${label}`));
    assert.doesNotMatch(h.lines().join("\n"), /retrying provider request|thinking…/);
    const live = { active_tools: [], tool_uses: 0, preview: "" };
    assert(
      renderDetailFields({ view, live }, theme, 120)
        .join("\n")
        .includes(`draining 5.0s · awaiting ${label}`),
    );
    view.drain.elapsed_ms = 8000;
    assert(
      h.lines().join("\n").includes(`draining 5.0s · awaiting ${label}`),
      "render uses the detached tick snapshot",
    );
    h.widget.wake();
    assert(h.lines().join("\n").includes(`draining 8.0s · awaiting ${label}`));
    for (const width of [20, 40, 80])
      assert(h.lines(width).every((line) => visibleWidth(line) <= width));
    view.execution_exited = true;
    assert.doesNotMatch(renderDetailFields({ view, live }, theme, 120).join("\n"), /draining/);
  });
}

test("resident summaries keep disclosure stable and retain released diagnostic clicks", (t) => {
  const idle = viewOf("idle", "completed");
  const failed = { ...viewOf("released", "failed"), resident: false };
  const h = mounted([idle, failed]),
    opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => opened.push(id));
  h.widget.wake();
  assert.equal(h.lines()[0], "▸ Subagents · ✓1");
  assert.match(h.lines()[2], /✗ worker/);
  assert.deepEqual(h.component().handleMouse({ ...headingClick, y: 2 }), { handled: true });
  assert.deepEqual(opened, ["released"]);
  h.widget.onTurnStart();
  assert.equal(h.lines()[0], "▸ Subagents · ✓1");
  assert.match(
    h.lines()[1],
    /✗ worker/,
    "released failure still lingers after resident completion ages out",
  );
  h.component().handleMouse(headingClick);
  assert.equal(h.lines()[0], "▾ Subagents · ✓1");
  assert.deepEqual(h.component().handleMouse({ ...headingClick, y: 2 }), { handled: true });
  assert.deepEqual(opened, ["released", "released"]);

  assert.equal(
    render([run("diagnostic", { status: "failed", resident: false })], {
      owner: { ...owner, resident: 0 },
    })[0],
    "▸ Subagents",
    "released-only diagnostics do not create summary counts or a redundant total",
  );
  const rows = [run("a", { status: "completed" }), run("b", { status: "failed" })];
  const first = render(rows)[0],
    changed = render(rows.map((row) => ({ ...row, status: "running" })))[0];
  assert.equal(first.indexOf("▸"), 0);
  assert.equal(first.indexOf("▸"), changed.indexOf("▸"));
  const full = render(rows, { owner: { ...owner, resident_limit: 2 } })[0];
  assert.match(full, /^▸ Subagents \(full\) · ✓1 ✗1$/);
  for (const width of [25, 29, 40]) {
    const frame = renderWidget({
      runs: rows,
      owner: { ...owner, resident_limit: 2 },
      width,
      theme,
      spinnerFrame: 0,
      maxLines: 13,
      shouldShowFinished: () => false,
    });
    assert(frame.headingWidth > 0);
    assert.equal(frame.lines[0].indexOf("▸"), full.indexOf("▸"));
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
  }
  const compact = render(rows, {
    owner: { ...owner, resident: 12, resident_limit: 12 },
    width: 19,
  })[0];
  assert.equal(compact, "▸ Subagents (full)");
});

test("explicit opt-in heading clicks toggle only the leading mug with equal geometry and unchanged Agent rows", (t) => {
  const h = mounted([viewOf("idle", "completed")]);
  t.after(() => h.widget.dispose());
  h.widget.setBeerMugs(true);
  h.widget.wake();
  const collapsed = h.lines();
  assert.equal(collapsed[0], "🍺 Subagents · ✓1");
  const columns = visibleWidth(collapsed[0]);
  for (const mug of ["🍺", "🍻"])
    assert.equal(visibleWidth(mug), 2, "both mugs occupy two terminal columns");
  assert.equal(columns, 17);
  assert.equal([...collapsed[0]].length, columns - 1, "code points are not terminal columns");
  assert.equal(
    h.component().handleMouse({ ...headingClick, x: columns }),
    undefined,
    "the first column outside the heading is not clickable",
  );
  assert.deepEqual(
    h.component().handleMouse({ ...headingClick, x: columns - 1 }),
    { handled: true, render: true },
    "the right edge of the heading is still a disclosure target",
  );
  const expanded = h.lines();
  assert.equal(expanded[0], "🍻 Subagents · ✓1");
  assert.equal(visibleWidth(expanded[0]), columns, "expansion preserves the heading width");
  assert.deepEqual(expanded.slice(1), collapsed.slice(1));
  assert.equal(
    h.component().handleMouse({ ...headingClick, x: columns }),
    undefined,
    "the expanded heading has the same exclusive right edge",
  );
  for (const x of [0, 1]) {
    assert.deepEqual(
      h.component().handleMouse({ ...headingClick, x }),
      { handled: true, render: true },
      "both columns of the expanded mug collapse the roster",
    );
    assert.deepEqual(h.lines(), collapsed);
    assert.deepEqual(
      h.component().handleMouse({ ...headingClick, x }),
      { handled: true, render: true },
      "both columns of the collapsed mug expand the roster",
    );
    assert.deepEqual(h.lines(), expanded);
  }
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.deepEqual(h.lines(), collapsed);
});

test("appearance changes retire heading, Agent and page hits without Owner reads or acknowledgements", (t) => {
  const views = Array.from({ length: 13 }, (_, i) => viewOf(`idle-${i}`, "completed"));
  const before = structuredClone(views),
    h = mounted(views, 16),
    opened = [],
    counts = [];
  t.after(() => h.widget.dispose());
  h.tui.terminal.rows = 18;
  h.widget.onOpen((id) => opened.push(id));
  h.widget.onRosterUpdate((count) => counts.push(count));
  h.widget.setBeerMugs(false);
  assert.equal(h.reads(), 0, "setting appearance before a mount does not project the Owner");
  h.widget.wake();
  assert.equal(h.lines()[0], "▸ Subagents · ✓13");
  h.component().handleMouse(headingClick);
  for (const enabled of [true, false, true]) {
    const lines = h.lines(),
      y = lines.findIndex((line) => line.includes("[Next]")),
      x = lines[y].indexOf("[Next]");
    const held = {
      reads: h.reads(),
      stats: h.statsReads(),
      renders: h.renders(),
      counts: [...counts],
    };
    h.widget.setBeerMugs(enabled);
    assert.equal(h.renders(), held.renders + 1, "an appearance change requests a repaint");
    for (const event of [headingClick, { ...headingClick, y: 1 }, { ...headingClick, y, x }]) {
      assert.equal(
        h.component().handleMouse(event),
        undefined,
        "old heading, Agent and nav coordinates are retired before repaint",
      );
    }
    assert.deepEqual(
      { reads: h.reads(), stats: h.statsReads(), counts },
      { reads: held.reads, stats: held.stats, counts: held.counts },
      "appearance changes publish no fresh projection or roster update",
    );
    const heading = h.lines()[0],
      width = visibleWidth(heading);
    assert.equal(
      heading,
      `${enabled ? "🍻" : "▾"} Subagents · ✓13`,
      "expansion survives appearance changes",
    );
    assert.equal(h.component().handleMouse({ ...headingClick, x: width }), undefined);
    assert.deepEqual(
      pageClick(h),
      { handled: true, render: true },
      "newly painted navigation remains usable",
    );
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(
    views,
    before,
    "appearance never mutates lifecycle or pending model-facing facts",
  );
  h.widget.setUi({ ...h.ui });
  h.widget.wake();
  assert.equal(h.lines()[0], "🍺 Subagents · ✓13", "the chosen appearance survives a UI rebind");
});

test("a recorded Run issue does not claim that resources are still unclosed", (t) => {
  const view = {
    ...viewOf("a", "completed"),
    execution_exited: true,
    resumable: true,
    cleanup_errors: ["SOFT_BUDGET_MESSAGE_REJECTED: INPUT_CLOSED"],
  };
  const h = mounted([view]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.match(h.lines()[1], /run warning/);
  assert.doesNotMatch(h.lines().join("\n"), /cleanup uncertain|blocked/);
});

test("the main widget projects difficulty from effective settings without changing or reusing them", (t) => {
  const view = viewOf("orca-id", "running");
  view.name = "orca";
  // Deliberately unlike the slot: the UI must show the assessment, not infer it.
  view.effective_settings = {
    ...view.effective_settings,
    profile: "researcher",
    difficulty: 5,
    strength: "d3",
    thinking: "xhigh",
  };
  const before = structuredClone(view);
  const h = mounted([view]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  const line = h.lines()[1];
  assert.match(line, /orca \(scout\/d5\) \[m\/xhigh\]/);
  assert.doesNotMatch(line, /researcher/);
  assert.equal(h.lines()[1], line, "repainting the same Run reuses its admitted difficulty");
  assert.deepEqual(view, before, "projection never rewrites effective settings or the Run");
});

test("resuming keeps who stable while changing what the widget says they are doing", (t) => {
  const first = {
    ...viewOf("a", "completed", "first"),
    name: "orca",
    description: "Review Windows foundations",
  };
  const next = {
    ...viewOf("a", "running", "next"),
    name: "orca",
    description: "Review GTK direct-entry safety",
  };
  const before = structuredClone([first, next]);
  const h = mounted([first]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.match(h.lines()[1], /orca .*→ Review Windows foundations/);
  h.set([next]);
  h.widget.wake();
  assert.match(h.lines()[1], /orca .*→ Review GTK direct-entry safety/);
  assert.doesNotMatch(h.lines()[1], /Windows/);
  assert.deepEqual(
    [first, next],
    before,
    "rendering does not rename the Agent or rewrite old Run labels",
  );
});

/** The row retains actual reported cost, not an estimate from token counts. */
test("a painted row keeps cost but leaves cumulative tokens to the detail pane", (t) => {
  const spend = (input, output, cache_read, cache_write, cost) =>
    addToLedger(undefined, { input, output, cache_read, cache_write, cost }, "p/m");
  const paint = (usage) => {
    const h = mounted([{ ...viewOf("a", "running"), usage }]);
    t.after(() => h.widget.dispose());
    h.widget.wake();
    return h.lines()[1] ?? "";
  };
  const line = paint(spend(100, 20, 9000, 10, 0.0042));
  assert.match(line, /\$0\.004/, line);
  assert.doesNotMatch(line, /130|9\.1k|token/, "no cumulative token figure is painted");
  // Unknown and a reported zero are different facts, and the row says which.
  assert.ok(!paint(spend(100, 20, 0, 10, null)).includes("$"), "an unpriced Run shows no cost");
  assert.match(paint(spend(100, 20, 0, 10, 0)), /\$0\.000/, "a Run that reported zero says zero");
  assert.ok(!paint(undefined).includes("token"), "a Run that reported nothing shows no figures");
});

test("painted Agent rows show the resolved model and current context, not cumulative usage", (t) => {
  for (const status of ["running", "completed", "failed", "needs_input"]) {
    const view = viewOf("a", status);
    view.effective_settings = {
      ...view.effective_settings,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    };
    view.runtime = { activity: "generating", context: { tokens: 231000, context_window: 272000 } };
    view.usage = addToLedger(
      undefined,
      { input: 700000, output: 0, cache_read: 9000000, cache_write: 0, cost: 0.5 },
      "openai-codex/gpt-5.6-sol",
    );
    const before = structuredClone(view);
    const h = mounted([view]);
    t.after(() => h.widget.dispose());
    h.widget.wake();
    const line = h.lines()[1];
    assert.match(line, /\[gpt-5\.6-sol\/off\]/);
    assert.match(line, /ctx 84\.9% · \$0\.500/);
    assert.doesNotMatch(line, /openai-codex|231k|272k|700|token/);
    assert.deepEqual(view, before, "presentation never changes routing or billing metadata");
  }
});

test("detail projections always retain the inherited cwd with or without an activity observer", (t) => {
  const view = viewOf("copy", "completed"),
    before = structuredClone(view),
    h = mounted([view]);
  t.after(() => {
    h.widget.dispose();
    h.activities.clear();
  });
  assert.equal(h.widget.agents()[0].cwd, view.effective_settings.cwd);
  h.activities.track("copy", view.effective_settings.cwd);
  assert.equal(h.widget.agents()[0].cwd, view.effective_settings.cwd);
  h.activities.clear();
  assert.equal(h.widget.agents()[0].cwd, view.effective_settings.cwd);
  h.set([viewOf("pending", "queued")]);
  assert.equal(h.widget.agents()[0].cwd, "/w");
  assert.deepEqual(view, before, "UI projection leaves original profile and settings unchanged");
});

test("idle editor renders reuse detached projections without Owner reads or observer pruning", (t) => {
  const view = { ...viewOf("idle", "completed"), name: "before", pending_messages: 2 };
  const h = mounted([view]),
    counts = [];
  t.after(() => h.widget.dispose());
  const retain = t.mock.method(h.activities, "retain");
  h.widget.onRosterUpdate((count) => {
    counts.push(count);
  });
  h.widget.wake();
  const initial = h.lines();
  const held = { list: h.reads(), stats: h.statsReads(), retain: retain.mock.callCount() };
  view.name = "after";
  view.pending_messages = 9;
  for (let i = 0; i < 100; i++) assert.deepEqual(h.lines(), initial);
  assert.deepEqual(
    { list: h.reads(), stats: h.statsReads(), retain: retain.mock.callCount() },
    held,
  );
  assert.deepEqual(counts, [1]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.reads(), held.list + 1);
  assert.equal(h.statsReads(), held.stats + 1);
  assert.match(h.lines()[1], /after · 9 pending/);
  assert.deepEqual(
    counts,
    [1],
    "inspection cannot publish roster updates or model-facing acknowledgements",
  );
  h.set([{ ...viewOf("new", "completed"), name: "new-resident" }]);
  assert.equal(h.widget.agents()[0].agent_id, "new", "operations still read current Owner state");
  assert.match(
    h.lines()[1],
    /after/,
    "an operation's fresh projection does not silently replace the UI cache",
  );
  h.widget.wake();
  assert.match(h.lines()[1], /new-resident/);
});

test("explicit expansion sees newly admitted idle residents without a lifecycle wake", (t) => {
  const h = mounted([viewOf("old", "completed")]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  h.widget.onTurnStart();
  h.lines();
  h.set([viewOf("old", "completed"), { ...viewOf("new", "completed"), name: "new-resident" }]);
  const held = { list: h.reads(), stats: h.statsReads() };
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"]);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  h.component().handleMouse(headingClick);
  assert.match(h.lines()[0], /^▾ Subagents · ✓2$/);
  assert.match(h.lines()[2], /new-resident/);
});

test("active timer ticks refresh cached activity and stop once idle", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = { ...viewOf("busy", "running"), name: "busy" },
    h = mounted([view]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  const before = h.lines(),
    held = { list: h.reads(), stats: h.statsReads() };
  view.turns = 6;
  for (let i = 0; i < 20; i++) assert.deepEqual(h.lines(), before);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  t.mock.timers.tick(80);
  assert.equal(h.reads(), held.list + 1);
  assert.equal(h.statsReads(), held.stats + 1);
  assert.match(h.lines()[1], /↻6≤8/);
  h.set([viewOf("busy", "completed")]);
  t.mock.timers.tick(80);
  const idle = { list: h.reads(), stats: h.statsReads(), renders: h.renders() };
  t.mock.timers.tick(10000);
  h.lines();
  assert.deepEqual({ list: h.reads(), stats: h.statsReads(), renders: h.renders() }, idle);
});

for (const mode of ["regular", undefined])
  test(`nonfullscreen widgets advertise no disclosure and reject mouse input (mode=${mode})`, (t) => {
    const h = mounted([viewOf("idle", "completed")]),
      opened = [];
    t.after(() => h.widget.dispose());
    h.tui.mode = mode;
    h.widget.onOpen((id) => {
      opened.push(id);
    });
    h.widget.wake();
    assert.doesNotMatch(h.lines()[0], /[▸▾]|🍺|🍻/);
    const held = { list: h.reads(), stats: h.statsReads(), renders: h.renders() };
    assert.equal(h.component().handleMouse(headingClick), undefined);
    assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
    assert.deepEqual({ list: h.reads(), stats: h.statsReads(), renders: h.renders() }, held);
    assert.deepEqual(opened, []);
    h.widget.onTurnStart();
    assert.deepEqual(
      h.lines(),
      [],
      "ordinary idle headings have no purpose without mouse inspection",
    );
    const idleReads = { list: h.reads(), stats: h.statsReads() };
    for (let i = 0; i < 20; i++) assert.deepEqual(h.lines(), []);
    assert.deepEqual(
      { list: h.reads(), stats: h.statsReads() },
      idleReads,
      "hidden cached paints stay read-only",
    );
    assert.equal(
      h.widget.agents()[0].agent_id,
      "idle",
      "Alt+A's inspection projection remains available",
    );
  });

for (const mode of ["regular", undefined])
  test(`nonfullscreen idle still reports full capacity (mode=${mode})`, (t) => {
    const h = mounted([viewOf("idle", "completed")], 1);
    t.after(() => h.widget.dispose());
    h.tui.mode = mode;
    h.widget.wake();
    h.widget.onTurnStart();
    assert.deepEqual(
      h.lines(),
      ["○ Subagents (full) · ✓1"],
      "full is a capacity fact, not a mouse-only entry",
    );
    assert.equal(h.component().handleMouse(headingClick), undefined);
    assert.equal(h.widget.agents()[0].agent_id, "idle");
  });

for (const blocked of [false, true])
  test(`tiny readable pages reach every resident and released diagnostic (blocked=${blocked})`, () => {
    const runs = [
      ...Array.from({ length: 12 }, (_, i) =>
        run(`id-${i}`, { status: i % 2 ? "queued" : "running", name: `review-${i}` }),
      ),
      run("linger", { status: "failed", name: "failure", error: "SDK broke" }),
    ];
    const seen = new Set(),
      maxLines = blocked ? 4 : 3;
    for (let page = 0, pages = 1; page < pages; page++) {
      const frame = renderWidget({
        runs,
        owner: { ...owner, resident: 12, resident_limit: 12, blocked, error: "BROKEN" },
        spinnerFrame: 0,
        width: 20,
        theme,
        maxLines,
        page,
        expanded: true,
        shouldShowFinished: () => false,
      });
      pages = frame.pagination.pages;
      assert.equal(pages, 13, "one readable Agent per tiny page, never a hidden remainder");
      assert(frame.headingWidth > 0, "the shortened heading retains a clickable disclosure");
      assert.match(frame.lines[0], /^▾ Subagents/);
      assert.equal(frame.lines.length, maxLines);
      assert(frame.lines.every((line) => visibleWidth(line) <= 20));
      if (blocked) assert.match(frame.lines[1], /owner blocked/);
      assert.equal(frame.pagination.prev === undefined, page === 0);
      assert.equal(frame.pagination.next === undefined, page === pages - 1);
      for (const id of frame.hits.filter(Boolean)) seen.add(id);
    }
    assert.deepEqual([...seen].sort(), runs.map((run) => run.agent_id).sort());
  });

test("unreadable tiny controls refuse unseen actions, and extreme line budgets stay bounded", (t) => {
  const h = mounted(
    Array.from({ length: 12 }, (_, i) => viewOf(`id-${i}`, "completed")),
    12,
  );
  t.after(() => h.widget.dispose());
  // spacer 1 + editor 3 + footer 2 + status 1 + one queued prompt 3 + transcript 2.
  const budget = (rows) => Math.max(0, Math.min(13, Math.floor(rows / 3), rows - 12));
  h.tui.terminal.rows = 9;
  h.widget.wake();
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), [], "rows 9 reserves input chrome and does not advertise nav");
  assert.equal(
    h.widget.agents().length,
    12,
    "Alt+A inspection remains available without a painted control",
  );
  const held = { list: h.reads(), stats: h.statsReads() };
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.deepEqual({ list: h.reads(), stats: h.statsReads() }, held);
  h.tui.terminal.rows = 13;
  assert.match(h.lines()[0], /Alt\+A/);
  assert.doesNotMatch(h.lines()[0], /[▸▾]|🍺|🍻/);
  assert.equal(
    h.component().handleMouse(headingClick),
    undefined,
    "a one-line budget must not expand into clipped nav",
  );
  for (const rows of [0, 1, 3, 6, 9, 12]) {
    h.tui.terminal.rows = rows;
    assert.deepEqual(h.lines(), [], `rows ${rows} stay inside the reserved chrome`);
  }
  for (const rows of [13, 15, 16, 18, 36, 39, 300]) {
    h.tui.terminal.rows = rows;
    assert(h.lines().length <= budget(rows), `rows ${rows}`);
    assert(h.lines().length <= Math.min(13, Math.floor(rows / 3)));
  }
  h.tui.terminal.rows = 18;
  h.tui.terminal.columns = 12;
  assert(
    h.lines(12).every((line) => visibleWidth(line) <= 12),
    "narrow headings stay clipped to the viewport",
  );
  assert.doesNotMatch(h.lines(12)[0], /[▸▾]|🍺|🍻/);
  assert.equal(h.component().handleMouse(headingClick), undefined);
  delete h.tui.terminal.rows;
  assert(h.lines(120).length <= 6, "legacy hosts without rows remain bounded");
  for (const rows of [Number.NaN, Number.POSITIVE_INFINITY]) {
    h.tui.terminal.rows = rows;
    assert(h.lines(120).length <= 6, "non-finite height keeps the legacy six-line budget");
  }
});

test("page geometry is paint-local across resizing, page changes and roster shrink", (t) => {
  const idle = Array.from({ length: 12 }, (_, i) => ({
    ...viewOf(`id-${i}`, "completed"),
    name: `idle${i}`,
  }));
  const h = mounted(idle, 12),
    opened = [];
  t.after(() => h.widget.dispose());
  h.tui.terminal.rows = 18;
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  h.widget.onTurnStart();
  h.lines();
  h.component().handleMouse(headingClick);
  const first = h.lines(),
    y = first.length - 1,
    x = first[y].indexOf("[Next]");
  assert.equal(first.length, 6);
  h.tui.terminal.rows = 9;
  assert.equal(
    h.component().handleMouse({ ...headingClick, y, x }),
    undefined,
    "resize before repaint retires old controls",
  );
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.lines(), [], "rows 9 does not keep a nav the dock would clip");
  assert.equal(h.component().handleMouse(headingClick), undefined);
  h.tui.terminal.rows = 15;
  assert.equal(
    h.lines().length,
    3,
    "unblocked pages start once the reserve leaves three widget rows",
  );
  pageClick(h);
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "old page hits are gone before repaint",
  );
  assert.match(h.lines()[1], /idle1 /);
  h.tui.terminal.columns = 80;
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "column-only resizes are guarded too",
  );
  assert.equal(h.lines(80).length, 3);
  h.set(idle.slice(0, 1));
  h.widget.wake();
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "updates retire stale Agent targets",
  );
  assert.equal(h.lines().length, 2);
  h.component().handleMouse({ ...headingClick, y: 1 });
  assert.deepEqual(
    opened,
    ["id-0"],
    "the clamped replacement page opens the painted immutable Agent ID",
  );
});

test("twelve idle residents have a compact heading and a bounded complete static roster", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const interval = t.mock.method(globalThis, "setInterval"),
    timeout = t.mock.method(globalThis, "setTimeout");
  const idle = Array.from({ length: 12 }, (_, i) => ({
    ...viewOf(`id-${i}`, "completed"),
    name: `idle${i}`,
  }));
  const h = mounted(idle, 12);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 5; turn++) h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents (full) · ✓12"]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.lines().length, 13);
  assert.match(h.lines()[0], /^▾ Subagents/);
  for (let i = 0; i < idle.length; i++) assert(h.lines()[i + 1].includes(`✓ idle${i} `));
  assert.doesNotMatch(h.lines().join("\n"), /\[Prev\]|\[Next\]/);
  const held = { renders: h.renders(), reads: h.reads() };
  t.mock.timers.tick(10000);
  assert.deepEqual(
    { renders: h.renders(), reads: h.reads() },
    held,
    "expanded idle rows never start a paint loop",
  );
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0, "a disclosure click schedules no idle work");
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.deepEqual(h.lines(), ["▸ Subagents (full) · ✓12"]);
});

test("nonfull idle rosters expand and every painted Agent row opens its immutable id", (t) => {
  const idle = Array.from({ length: 7 }, (_, i) => ({
    ...viewOf(`id-${i}`, "completed"),
    name: `idle${i}`,
  }));
  const h = mounted(idle, 12),
    opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓7"]);
  assert.deepEqual(h.component().handleMouse(headingClick), { handled: true, render: true });
  assert.equal(h.lines().length, 8);
  for (let y = 1; y <= idle.length; y++) {
    assert.deepEqual(h.component().handleMouse({ ...headingClick, y }), { handled: true });
  }
  assert.deepEqual(
    opened,
    idle.map((view) => view.agent_id),
  );
});

test("expanded queued rows open each Agent and toggles invalidate old row targets until repaint", (t) => {
  const queued = Array.from({ length: 13 }, (_, i) => ({
    ...viewOf(`queued-id-${i}`, "queued"),
    name: "same-label",
  }));
  const h = mounted(queued, 16),
    opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  assert.match(h.lines()[1], /13 queued$/);
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "an aggregate is not an Agent",
  );
  h.component().handleMouse(headingClick);
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "the old compact hits are discarded",
  );
  assert.equal(h.lines().length, 13);
  for (let y = 1; y <= 11; y++) h.component().handleMouse({ ...headingClick, y });
  assert.deepEqual(pageClick(h), { handled: true, render: true });
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "page changes retire old row hits before repaint",
  );
  assert.equal(h.lines().length, 4);
  for (let y = 1; y <= 2; y++) h.component().handleMouse({ ...headingClick, y });
  assert.deepEqual(
    opened,
    queued.map((view) => view.agent_id),
    "neither duplicate labels nor the line budget lose identity",
  );
  h.component().handleMouse(headingClick);
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 13 }),
    undefined,
    "a formerly expanded Agent row is not live before the compact repaint",
  );
  assert.match(h.lines()[1], /13 queued$/);
  assert.equal(h.component().handleMouse({ ...headingClick, y: 1 }), undefined);
});

test("a blocked but empty painted heading cannot toggle", (t) => {
  let component,
    renders = 0;
  const widget = new AgentWidget(
    {
      list: () => [],
      stats: () => ({ resident: 0, parent_error: "BROKEN", cleanup_uncertain: false }),
    },
    12,
  );
  t.after(() => widget.dispose());
  widget.setUi({
    setWidget: (_key, factory) => {
      component = factory?.(
        {
          terminal: { columns: 120 },
          requestRender: () => {
            renders++;
          },
        },
        theme,
      );
    },
  });
  widget.wake();
  assert.deepEqual(component.render(120), ["○ Subagents", "└─ ✗ owner blocked: BROKEN"]);
  assert.equal(component.handleMouse(headingClick), undefined);
  assert.equal(component.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.equal(renders, 0);
});

test("heading inspection refreshes explicitly; unseen controls and other events never project or notify", (t) => {
  const view = { ...viewOf("immutable-id", "completed"), name: "otter", pending_messages: 2 };
  const before = structuredClone(view),
    h = mounted([view]),
    counts = [],
    opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onRosterUpdate((count) => {
    counts.push(count);
  });
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  const component = h.component(),
    unpainted = { reads: h.reads(), renders: h.renders() };
  assert.equal(component.handleMouse(headingClick), undefined, "registration is not a paint");
  assert.equal(component.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual({ reads: h.reads(), renders: h.renders() }, unpainted);
  const heading = h.lines()[0],
    width = visibleWidth(heading);
  const held = { reads: h.reads(), renders: h.renders(), counts: [...counts] };
  for (const event of [
    { x: -1 },
    { x: width },
    { x: 119 },
    { x: NaN },
    { x: Infinity },
    { y: -1 },
    { y: 99 },
    { button: "right" },
    { button: "middle" },
    { type: "release" },
    { type: "move" },
    { type: "scroll" },
  ])
    assert.equal(component.handleMouse({ ...headingClick, ...event }), undefined);
  assert.deepEqual({ reads: h.reads(), renders: h.renders(), counts }, held);
  assert.deepEqual(component.handleMouse({ ...headingClick, x: width - 1 }), {
    handled: true,
    render: true,
  });
  assert.equal(h.renders(), held.renders + 1, "the toggle requests one immediate render");
  assert.equal(h.reads(), held.reads + 1, "explicit inspection refreshes the projection once");
  assert.deepEqual(counts, held.counts, "a local disclosure is not a roster update");
  assert.deepEqual(opened, [], "the heading is never an Agent hit");
  assert.deepEqual(view, before, "pending model-facing facts remain untouched");
  assert.match(h.lines()[0], /^▾ Subagents/);
  assert.deepEqual(component.handleMouse({ ...headingClick, y: 1 }), { handled: true });
  assert.deepEqual(opened, ["immutable-id"]);

  const narrow = h.lines(10)[0],
    narrowRenders = h.renders();
  assert.equal(
    component.handleMouse({ ...headingClick, x: visibleWidth(narrow) }),
    undefined,
    "resizing replaces the old heading's wider hit box",
  );
  assert.equal(h.renders(), narrowRenders);
  assert.equal(
    component.handleMouse({ ...headingClick, x: visibleWidth(narrow) - 1 }),
    undefined,
    "a clipped disclosure is not an unseen action; Alt+A remains the inspection fallback",
  );
  assert.match(h.lines()[0], /^▾ Subagents/);
});

test("collapse restores automatic lingering and attention rows instead of hiding active work", (t) => {
  const h = mounted([
    viewOf("idle", "completed"),
    viewOf("busy", "running"),
    viewOf("question", "needs_input"),
    viewOf("queue", "queued"),
  ]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  h.widget.onTurnStart();
  const compact = h.lines();
  assert.doesNotMatch(compact.join("\n"), /✓ worker/);
  assert.match(compact.join("\n"), /needs input/);
  assert.match(compact.at(-1), /1 queued$/);
  h.component().handleMouse(headingClick);
  assert(h.lines().some((line) => line.includes("✓ worker")));
  h.widget.onTurnStart();
  h.widget.wake();
  assert.match(h.lines()[0], /^▾ Subagents/, "turn starts and activity wakes preserve expansion");
  h.component().handleMouse(headingClick);
  const collapsed = h.lines();
  assert.match(collapsed[0], /^▸ Subagents/);
  assert.doesNotMatch(collapsed.join("\n"), /✓ worker/);
  assert.match(collapsed.join("\n"), /needs input/);
  assert.match(collapsed.join("\n"), /thinking…/);
  assert.match(collapsed.at(-1), /1 queued$/);
  // A new result still gets the normal linger after collapsing.
  h.set([viewOf("fresh", "completed")]);
  h.widget.wake();
  assert.match(h.lines()[1], /✓ worker/);
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"]);
});

test("multiple host instances from one factory never share hit or heading authority", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeout = t.mock.method(globalThis, "setTimeout");
  let factory,
    renders = 0;
  const opened = [],
    widget = new AgentWidget(
      {
        list: () => [viewOf("id", "completed")],
        stats: () => ({ resident: 1, cleanup_uncertain: false }),
      },
      12,
    );
  t.after(() => widget.dispose());
  widget.onOpen((id) => {
    opened.push(id);
  });
  widget.setUi({
    setWidget: (_key, content) => {
      factory = content;
    },
  });
  widget.wake();
  const tui = {
    terminal: { columns: 120, rows: 18 },
    mode: "fullscreen",
    requestRender() {
      renders++;
    },
  };
  const old = factory(tui, theme);
  old.render(120);
  const current = factory(tui, theme);
  current.render(120);
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  old.invalidate();
  assert.equal(
    timeout.mock.callCount(),
    0,
    "an already retired sibling cannot schedule a replacement",
  );
  assert.deepEqual(old.render(120), []);
  assert.equal(renders, 0);
  assert.deepEqual(opened, []);
  assert.deepEqual(current.handleMouse(headingClick), { handled: true, render: true });
  assert.match(current.render(120)[0], /^▾ Subagents/);
});

test("expansion is binding-local and stale components cannot toggle or open after a rebind", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => h.widget.dispose());
  const opened = [];
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  h.lines();
  const old = h.component();
  old.handleMouse(headingClick);
  assert.match(h.lines()[0], /^▾ Subagents/);
  h.widget.setUi(h.ui);
  h.widget.wake();
  assert.match(h.lines()[0], /^▾ Subagents/, "the identical binding is not a reset");
  h.widget.setUi({ ...h.ui });
  h.widget.wake();
  const current = h.component();
  assert.notEqual(current, old);
  assert.equal(
    current.handleMouse(headingClick),
    undefined,
    "a new binding must paint its own heading",
  );
  assert.match(h.lines()[0], /^▸ Subagents/);
  const held = h.renders();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.equal(h.renders(), held);
  assert.deepEqual(opened, []);
  assert.match(h.lines()[0], /^▸ Subagents/);
});

for (const reset of ["empty", "dispose"])
  test(`a ${reset} reset drops disclosure state and stale hit targets`, (t) => {
    const h = mounted([viewOf("a", "completed")]),
      opened = [];
    t.after(() => h.widget.dispose());
    h.widget.onOpen((id) => {
      opened.push(id);
    });
    h.widget.wake();
    h.lines();
    const old = h.component();
    old.handleMouse(headingClick);
    h.lines();
    if (reset === "empty") {
      h.set([]);
      h.widget.wake();
    } else h.widget.dispose();
    assert.equal(h.showing(), false);
    const held = h.renders();
    assert.equal(old.handleMouse(headingClick), undefined);
    assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
    assert.equal(h.renders(), held);
    if (reset === "dispose") h.widget.setUi({ ...h.ui });
    h.set([viewOf("b", "completed")]);
    h.widget.wake();
    assert.equal(h.component().handleMouse(headingClick), undefined);
    assert.match(h.lines()[0], /^▸ Subagents/);
    assert.equal(
      old.handleMouse(headingClick),
      undefined,
      "even a newly painted replacement cannot revive the old component",
    );
    assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
    assert.deepEqual(opened, []);
  });

for (const hidden of [false, true])
  test(`wake notifies release to empty without a paint (hidden=${hidden})`, (t) => {
    const view = viewOf("a", "completed");
    const h = mounted([view]);
    t.after(() => h.widget.dispose());
    const counts = [],
      showingAtEmpty = [];
    h.widget.onRosterUpdate((count) => {
      counts.push(count);
      if (count === 0) showingAtEmpty.push(h.showing());
    });
    h.widget.wake();
    if (hidden) h.widget.onTurnStart();
    assert.equal(h.showing(), true, "idle residents retain their heading after their rows age out");
    h.set([{ ...view, resident: false }]);
    h.widget.wake();
    assert.deepEqual(counts, hidden ? [1, 1, 0] : [1, 0]);
    assert.deepEqual(showingAtEmpty, [true], "notification precedes widget removal");
    assert.equal(h.showing(), false);
    assert.equal(
      h.renders(),
      hidden ? 1 : 0,
      "only the retained heading's turn update requests a render",
    );
  });

test("roster notifications count released failure linger and expire it on turn start", (t) => {
  const h = mounted([
    viewOf("idle", "completed"),
    { ...viewOf("failed", "failed"), resident: false },
    { ...viewOf("released", "completed"), resident: false },
  ]);
  t.after(() => h.widget.dispose());
  const counts = [];
  h.widget.onRosterUpdate((count) => {
    counts.push(count);
  });
  h.widget.wake();
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.deepEqual(
    counts,
    [2, 2, 2, 1],
    "inspectable includes diagnostics, not just residents or painted rows",
  );
  assert.equal(h.showing(), true, "the idle resident keeps the heading mounted");
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"]);
});

test("every explicit empty update notifies even when the count is unchanged", (t) => {
  const h = mounted();
  t.after(() => h.widget.dispose());
  const counts = [];
  h.widget.onRosterUpdate((count) => {
    counts.push(count);
  });
  h.widget.update();
  h.widget.wake();
  h.widget.update(true);
  assert.deepEqual(counts, [0, 0, 0], "a pane may have opened since the previous empty update");
});

test("roster notifications use one successful update projection, never render or inspection reads", (t) => {
  let reads = 0,
    fail = false,
    component;
  const counts = [],
    setterCounts = [];
  const widget = new AgentWidget(
    {
      list: () => {
        reads++;
        if (fail) throw new Error("PROJECTION_FAILED");
        return [viewOf("a", "completed")];
      },
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  t.after(() => widget.dispose());
  widget.onRosterUpdate((count) => {
    counts.push(count);
  });
  widget.update();
  assert.equal(reads, 0, "an update before UI binding remains a no-op");
  widget.setUi({
    setWidget: (_key, factory) => {
      setterCounts.push([...counts]);
      component = factory?.({ terminal: { columns: 120 }, requestRender() {} }, theme);
    },
  });
  widget.agents();
  assert.deepEqual(counts, []);
  widget.wake();
  assert.equal(reads, 2, "the update scans the controller only once");
  assert.deepEqual(setterCounts, [[1]], "notification precedes widget registration");
  component.render(120);
  component.render(120);
  widget.agents();
  widget.tuiMode();
  assert.deepEqual(counts, [1], "projection reads do not notify");
  fail = true;
  widget.wake();
  assert.deepEqual(counts, [1], "failed projection does not notify an invented empty roster");
  assert.equal(component, undefined);
});

test("roster subscriber failures cannot block showing or clearing and can be detached", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => h.widget.dispose());
  let calls = 0;
  h.widget.onRosterUpdate(() => {
    calls++;
    throw new Error("SUBSCRIBER_FAILED");
  });
  assert.doesNotThrow(() => h.widget.wake());
  assert.equal(h.showing(), true);
  h.set([]);
  assert.doesNotThrow(() => h.widget.wake());
  assert.equal(h.showing(), false);
  assert.equal(calls, 2);
  h.widget.onRosterUpdate(undefined);
  h.widget.update();
  assert.equal(calls, 2);
});

for (const clearThrows of [false, true])
  test(`dispose detaches the roster subscriber (clearThrows=${clearThrows})`, (t) => {
    const h = refreshFixture(t, "completed");
    const counts = [];
    h.widget.onRosterUpdate((count) => {
      counts.push(count);
    });
    h.widget.wake();
    if (clearThrows) {
      h.failRemoval();
      assert.throws(() => h.widget.dispose(), /WIDGET_CLEAR_FAILED/);
    } else h.widget.dispose();
    // Rebinding ensures this proves subscriber detachment, not just the no-UI guard.
    h.widget.setUi({});
    h.widget.wake();
    assert.deepEqual(counts, [1]);
  });

test("the paint loop starts when a Run is there, not when delegation is only about to happen", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = mounted();
  t.after(() => h.widget.dispose());
  // A delegation tool_call fires BEFORE the tool runs, so this wake sees no Run.
  h.widget.wake();
  assert.equal(h.showing(), false);
  t.mock.timers.tick(1000);
  assert.equal(h.renders(), 0, "an empty wake leaves no loop running behind it");
  // The worker is admitted inside the tool, and the wake that follows the tool
  // paints it. No parent turn is involved: an interrupt here, or a slow sibling
  // tool, must not be what decides whether a running worker is visible.
  h.set([viewOf("a", "running")]);
  h.widget.wake();
  assert.match(
    h.lines()[1],
    /^└─ \S worker \(d3\) \[m\/off\] → Task/,
    "the Run is on screen as soon as it exists",
  );
  t.mock.timers.tick(240);
  assert.ok(h.renders() >= 3, `the spinner keeps animating (${h.renders()} frames)`);
  h.set([viewOf("a", "completed")]);
  t.mock.timers.tick(80);
  const settled = h.renders();
  t.mock.timers.tick(800);
  assert.equal(h.renders(), settled, "a finished Run animates nothing");
  assert.match(h.lines()[1], /✓ worker/, "but its result stays on screen for its linger");
});

test("a reused Agent lingers again for every Run, not only its first", (t) => {
  const h = mounted([viewOf("a", "completed", "a-1")]);
  t.after(() => h.widget.dispose());
  h.widget.update();
  assert.match(h.lines()[1], /✓ worker/);
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"], "one turn is the whole normal row linger");
  // delegate to an existing Agent: a new Run on the Agent that already spent a linger.
  h.set([viewOf("a", "running", "a-2")]);
  h.widget.update();
  h.set([viewOf("a", "completed", "a-2")]);
  h.widget.update();
  assert.match(h.lines()[1] ?? "", /✓ worker/, "the second result gets its own linger");
});

test("a Run that starts and finishes between paints gets its own linger", (t) => {
  const h = mounted([viewOf("a", "failed", "a-1")]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let i = 0; i < 3; i++) h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✗1"]);
  h.set([viewOf("a", "failed", "a-2")]);
  h.widget.wake();
  assert.match(
    h.lines()[1],
    /✗ worker/,
    "the second failure gets a new row linger, not just a retained heading",
  );
});

test("released failures expire in both UI entry points without resurrecting", (t) => {
  const failed = {
    ...viewOf("a", "failed"),
    resident: false,
    unavailable_reason: "sdk_error",
    outcome: { status: "failed", error: "SDK broke" },
  };
  const h = mounted([failed, { ...viewOf("b", "completed"), resident: false }]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  assert.equal(h.widget.agents().length, 1, "released successes do not reappear");
  assert.match(h.lines().join("\n"), /SDK broke/);
  for (let i = 0; i < 2; i++) {
    h.widget.onTurnStart();
    assert.equal(h.widget.agents().length, 1);
  }
  h.widget.onTurnStart();
  assert.equal(h.showing(), false);
  for (let i = 0; i < 5; i++) {
    h.widget.wake();
    h.widget.onTurnStart();
    assert.deepEqual(h.widget.agents(), []);
    assert.equal(h.showing(), false);
  }
});

test("expansion does not resurrect released successes or extend released failure linger", (t) => {
  const idle = viewOf("idle", "completed"),
    failed = {
      ...viewOf("failed", "failed"),
      resident: false,
      outcome: { status: "failed", error: "expired diagnostic" },
    };
  const h = mounted([idle, failed, { ...viewOf("success", "completed"), resident: false }]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  h.lines();
  h.component().handleMouse(headingClick);
  assert.match(h.lines().join("\n"), /expired diagnostic/);
  assert.deepEqual(
    h.widget.agents().map((agent) => agent.agent_id),
    ["idle", "failed"],
  );
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.match(h.lines()[0], /^▾ Subagents/);
  assert.equal(
    h.lines().length,
    2,
    "the idle resident remains expanded but the released diagnostic expires",
  );
  assert.doesNotMatch(h.lines().join("\n"), /expired diagnostic/);
  for (let cycle = 0; cycle < 3; cycle++) {
    h.component().handleMouse(headingClick);
    assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"], "ages continued advancing while expanded");
    h.widget.wake();
    h.widget.onTurnStart();
    assert.deepEqual(
      h.lines(),
      ["▸ Subagents · ✓1"],
      "explicit updates require freshly painted heading geometry",
    );
    h.component().handleMouse(headingClick);
    assert.equal(h.lines().length, 2);
    assert.deepEqual(
      h.widget.agents().map((agent) => agent.agent_id),
      ["idle"],
    );
  }
  h.set([failed, { ...viewOf("success", "completed"), resident: false }]);
  h.widget.wake();
  assert.equal(h.showing(), false, "expired released history alone cannot retain a heading");
  assert.deepEqual(h.widget.agents(), []);
});

test("a released failure expiring on a later page retires its old hit without extending linger", (t) => {
  const idle = Array.from({ length: 12 }, (_, i) => ({
    ...viewOf(`id-${i}`, "completed"),
    name: `idle${i}`,
  }));
  const h = mounted(
      [
        ...idle,
        {
          ...viewOf("failed", "failed"),
          resident: false,
          outcome: { status: "failed", error: "expired diagnostic" },
        },
      ],
      12,
    ),
    opened = [];
  h.tui.terminal.rows = 36; // Keep this stale-page test on a smaller, paginated budget.
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => {
    opened.push(id);
  });
  h.widget.wake();
  h.lines();
  h.component().handleMouse(headingClick);
  pageClick(h);
  assert.match(h.lines()[3], /expired diagnostic/);
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  assert.equal(h.component().handleMouse({ ...headingClick, y: 3, x: 7 }), undefined);
  assert.doesNotMatch(h.lines().join("\n"), /expired diagnostic/);
  assert.equal(h.lines().length, 4, "later pages shrink but the idle roster remains expanded");
  assert.equal(
    h.component().handleMouse({ ...headingClick, y: 3, x: 7 }),
    undefined,
    "the old failure row is now inert page-chrome whitespace",
  );
  assert.deepEqual(opened, []);
  assert.deepEqual(
    h.widget.agents().map((agent) => agent.agent_id),
    idle.map((view) => view.agent_id),
  );
});

test("a real Controller's automatic release frees capacity but retains clickable failure diagnostics", async (t) => {
  const { controller, ports } = await fixture(t);
  const activities = new ChildActivityRegistry();
  const widget = new AgentWidget(controller, 8, activities.observations, (ids) =>
    activities.retain(ids),
  );
  t.after(() => {
    widget.dispose();
    activities.clear();
  });
  let content, selected;
  widget.setUi({
    setWidget: (_key, factory) => {
      content = factory?.(
        { terminal: { columns: 120 }, mode: "fullscreen", requestRender() {} },
        theme,
      );
    },
  });
  widget.onOpen((id) => {
    selected = id;
  });
  const run = await controller.submit("failure-ui", task("Check diagnostics"));
  await until(() => ports[0]?.streaming);
  const child = activities.track(run.agent_id, "/tmp");
  const entries = [{ type: "custom", customType: "test-transcript" }],
    handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  handlers.get("session_start")({}, { sessionManager: { getEntries: () => entries } });
  const dispose = ports[0].dispose.bind(ports[0]);
  let shutdowns = 0;
  t.mock.method(ports[0], "dispose", async () => {
    shutdowns++;
    handlers.get("session_shutdown")({ reason: "quit" });
    return dispose();
  });
  widget.wake();
  const pane = new DetailPane({
    tui: { terminal: { columns: 120, rows: 60 }, requestRender() {} },
    theme,
    initial: run.agent_id,
    done() {},
    snapshot: () =>
      widget.agents().map((agent) => ({
        agent_id: agent.agent_id,
        input: { view: agent.view, live: agent.live },
      })),
    transcript: () => undefined,
  });
  t.after(() => pane.dispose());
  const runningPane = pane.render(120);
  assert.match(runningPane.at(-1), /running/);
  assert.doesNotMatch(runningPane[0], /running/);
  ports[0].calls[0].done.reject(new SessionUnavailableError("sdk_error", new Error("SDK broke")));
  await ended(controller, run);
  widget.update();
  assert.equal(ports[0].disposed, 1);
  assert.equal(shutdowns, 1, "release exercises the observer's actual session_shutdown boundary");
  assert.equal(controller.stats().resident, 0);
  assert.deepEqual(controller.list({ include_released: false }), []);
  assert.equal(controller.stats().parent_error, undefined);
  const lines = content.render(120);
  assert.match(lines.join("\n"), /SDK broke/);
  assert.doesNotMatch(lines.join("\n"), /owner blocked/);
  content.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
  assert.equal(selected, run.agent_id);
  const agent = widget.agents()[0];
  assert.equal(agent.view.resident, false);
  assert.equal(agent.view.resumable, false);
  assert.deepEqual(agent.entries(), entries, "the existing transcript remains inspectable");
  assert.equal(
    activities.observations.get(run.agent_id),
    child,
    "release retains failure diagnostics through linger",
  );
  assert.match(
    renderDetailFields({ view: agent.view, live: agent.live }, theme, 120).join("\n"),
    /SDK broke/,
  );
  const failedPane = pane.render(120);
  assert.match(
    failedPane.at(-1),
    /failed/,
    "the already-open pane retains the retired agent in its lower-left status",
  );
  assert.doesNotMatch(failedPane[0], /failed/);
  assert.match(pane.render(120).join("\n"), /SDK broke/);
  for (let turn = 1; turn < 3; turn++) {
    widget.onTurnStart();
    assert.deepEqual(
      widget.agents()[0].entries(),
      entries,
      `failed transcript survives parent turn ${turn}`,
    );
    assert.match(pane.render(120).join("\n"), /SDK broke/);
  }
  widget.onTurnStart();
  assert.deepEqual(widget.agents(), []);
  assert.equal(content, undefined);
  assert.match(pane.render(120).join("\n"), /No agents are available to inspect/);
  assert.equal(
    activities.observations.get(run.agent_id),
    undefined,
    "expired diagnostics release the transcript-bearing observer",
  );
});

test("runtime retains idle resident observations but prunes released successes", (t) => {
  const h = mounted([viewOf("a", "completed")]);
  t.after(() => {
    h.widget.dispose();
    h.activities.clear();
  });
  const child = h.activities.track("a", "/w");
  h.widget.wake();
  for (let i = 0; i < 4; i++) h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"]);
  assert.equal(
    h.activities.observations.get("a"),
    child,
    "a hidden idle Agent can still resume with its observer",
  );
  h.set([{ ...viewOf("a", "completed"), resident: false }]);
  h.widget.wake();
  assert.equal(
    h.activities.observations.get("a"),
    undefined,
    "successful release needs no diagnostic linger",
  );
});

test("disposing presentation alone does not dispose runtime observations", (t) => {
  const h = mounted([viewOf("a", "running")]);
  t.after(() => {
    h.widget.dispose();
    h.activities.clear();
  });
  const child = h.activities.track("a", "/w");
  h.widget.wake();
  h.widget.dispose();
  assert.equal(h.activities.observations.get("a"), child);
  h.activities.clear();
  assert.equal(h.activities.observations.get("a"), undefined);
});

test("painting reads a child's activity and never resets it", (t) => {
  const h = mounted([viewOf("a", "running")]);
  t.after(() => h.widget.dispose());
  const child = h.activities.track("a", "/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event, payload) => handlers.get(event)(payload);
  emit("tool_execution_start", {
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  emit("tool_execution_start", {
    toolCallId: "t2",
    toolName: "read",
    args: { path: "/w/src/a.ts" },
  });
  emit("tool_execution_end", { toolCallId: "t2" });
  // Through the widget, not around it: project()/rows() is the tempting place to
  // reset a Run's activity, so the pin has to be a real frame.
  h.widget.wake();
  const painted = h.lines();
  assert.match(painted.join("\n"), /⎿ {2}running npm test/, painted.join("\n"));
  assert.match(painted[1], /▸1/, painted[1]);
  // A tool already running at that first paint still counts when it ends, and a
  // second frame reports it -- the paint read the activity, it did not clear it.
  emit("tool_execution_end", { toolCallId: "t1" });
  h.widget.wake();
  assert.match(h.lines()[1], /▸2/, h.lines()[1]);
  // Repainting is a read: the same numbers however many times they are asked for.
  assert.match(h.lines()[1], /▸2/);
  assert.equal(child.snapshot().tool_uses, 2);
});

/**
 * Runs share one session, so a resumed Agent has to start from zero -- but at
 * the submission, not at the next paint. A tool that starts before the first
 * paint of the new Run would otherwise be cleared out from under itself, and
 * its `tool_execution_end` would find nothing to delete and never count it.
 */
test("a resumed Agent starts its Run clean without losing what that Run already did", (t) => {
  const h = mounted();
  t.after(() => h.widget.dispose());
  const child = h.activities.track("a", "/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event, payload) => handlers.get(event)(payload);
  emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/w/a.ts" } });
  emit("tool_execution_end", { toolCallId: "t1" });
  assert.equal(child.snapshot().tool_uses, 1);

  child.begin();
  assert.deepEqual(
    child.snapshot(),
    { active_tools: [], tool_uses: 0, preview: "" },
    "the previous Run is not this Run",
  );
  // The resumed worker reports before anything paints, as it always does.
  emit("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: { command: "make" } });
  assert.deepEqual(
    child.snapshot().active_tools,
    [{ name: "bash", detail: "make" }],
    "work started before the first paint is still on screen",
  );
  emit("tool_execution_end", { toolCallId: "t2" });
  assert.equal(child.snapshot().tool_uses, 1, "and still counts when it finishes");
});

/**
 * A row is one array element and one terminal line. Model-supplied names and
 * descriptions, tool arguments and `String(cause)` error text all reach these
 * rows, and any of them can carry a break: then the array and the screen
 * disagree about how many rows there are, and every hit index below the
 * offender names the wrong Agent.
 */
/**
 * `needs_input` is terminal but not finished: the Run is blocked on an answer
 * only the parent can give. Ageing it out of the widget hides the one row whose
 * absence stalls everything, and the parent has no other standing readout.
 */
test("an Agent waiting on an answer never ages out, however long the parent takes", (t) => {
  const h = mounted([viewOf("a", "needs_input")]);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 12; turn++) h.widget.onTurnStart();
  assert.equal(h.showing(), true, "the blocked Agent is still on screen");
  assert.match(h.lines()[1] ?? "", /worker/, h.lines().join("\n"));
  // A finished row still goes; its resident heading remains available to expand.
  h.set([viewOf("b", "completed")]);
  h.widget.onTurnStart();
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓1"]);
});

/**
 * A full roster refuses the next delegation. A widget that vanished because
 * every Agent went idle leaves no visible reason for that refusal.
 */
test("a saturated roster stays on screen even when every Agent is idle", (t) => {
  const idle = Array.from({ length: 8 }, (_, i) => viewOf(`a${i}`, "completed"));
  const h = mounted(idle);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  for (let turn = 0; turn < 5; turn++) h.widget.onTurnStart();
  assert.equal(h.showing(), true, "capacity is still reported after the rows aged out");
  assert.match(h.lines()[0], /^▸ Subagents \(full\) · ✓8/);
  // A nonfull idle roster remains discoverable too, without claiming saturation.
  h.set(idle.slice(0, 7));
  h.widget.onTurnStart();
  assert.deepEqual(h.lines(), ["▸ Subagents · ✓7"]);
});
